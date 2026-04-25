#!/usr/bin/env python3
"""
Parallel headless dataset renderer (multiprocessing).

This script orchestrates multiple parallel invocations of
`tools/render-dataset.js` by sharding a dataset manifest and rendering
 shards concurrently.

It is designed for long runs and resume-friendly execution:
- uses `multiprocessing` (via ProcessPoolExecutor)
- supports skip-existing by checking screenshots/<preset>/metadata.json
- retries failed shard jobs
- can split failed shards into smaller jobs to isolate problematic presets
- writes run logs and a machine-readable report

Usage:
  python3 tools/render_dataset_parallel.py \
    --dataset datasets/bird-base.json \
    --workers 6 \
    --chunk-size 8 \
    --max-retries 2 \
    --server-url http://localhost:3000 \
    --skip-existing
"""

from __future__ import annotations

import argparse
import json
import math
import multiprocessing as mp
import os
import subprocess
import sys
import time
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RUNS_DIR = ROOT / "tools" / ".render-parallel-runs"


def now_ts() -> str:
    return time.strftime("%Y%m%d_%H%M%S", time.localtime())


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError(f"Expected top-level object in {path}")
    return data


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")


def is_under_root(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def rel_to_root(path: Path) -> str:
    return path.resolve().relative_to(ROOT.resolve()).as_posix()


def is_preset_object(v: Any) -> bool:
    return (
        isinstance(v, dict)
        and isinstance(v.get("model"), str)
        and isinstance(v.get("steps"), list)
    )


def estimate_cost(preset: dict[str, Any]) -> float:
    # Rough rendering cost model used for balanced sharding.
    cost = float(len(preset.get("steps", [])) or 1)
    if preset.get("foldAnimation"):
        cost += 6.0
    if preset.get("previewRotation"):
        cost += 3.0
    if preset.get("scanMode"):
        cost += 12.0
    if preset.get("autoCapture") is False:
        cost *= 0.6
    return max(cost, 1.0)


def metadata_exists(preset_name: str) -> bool:
    # Output dir matches server.js DATASET_DIR (default: dataset/).
    # Metadata is consolidated per-object at dataset/metadata/<object>_metadata.json,
    # keyed by benchmark/preset name. PNGs live at dataset/<jsonl_id>/ (a
    # different, id-slug-based name), so the only reliable per-preset marker
    # is presence of the preset_name key inside SOME metadata file.
    out_dir = os.environ.get("DATASET_DIR", "dataset")
    metadata_dir = ROOT / out_dir / "metadata"
    if not metadata_dir.is_dir():
        return False
    for mfile in metadata_dir.glob("*_metadata.json"):
        try:
            with mfile.open("r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and preset_name in data:
                return True
        except (OSError, json.JSONDecodeError):
            continue
    return False


def check_server(server_url: str, timeout_sec: float = 5.0) -> None:
    try:
        with urlopen(server_url, timeout=timeout_sec) as res:
            if res.status >= 400:
                raise RuntimeError(f"Server responded with status {res.status}")
    except URLError as exc:
        raise RuntimeError(f"Cannot reach server at {server_url}: {exc}") from exc


def split_jobs_balanced(
    presets: dict[str, dict[str, Any]],
    names: list[str],
    workers: int,
    chunk_size: int,
) -> list[list[str]]:
    entries = sorted(names, key=lambda n: estimate_cost(presets[n]), reverse=True)
    if not entries:
        return []

    if chunk_size < 1:
        chunk_size = 1

    shard_target = max(workers * 2, math.ceil(len(entries) / chunk_size))
    shard_target = max(1, min(shard_target, len(entries)))

    bins: list[dict[str, Any]] = [
        {"cost": 0.0, "names": []} for _ in range(shard_target)
    ]
    for name in entries:
        item_cost = estimate_cost(presets[name])
        b = min(bins, key=lambda x: x["cost"])
        b["names"].append(name)
        b["cost"] += item_cost

    return [b["names"] for b in bins if b["names"]]


@dataclass
class Job:
    job_id: str
    names: list[str]
    shard_path: str
    attempt: int = 0
    parent_id: str | None = None


def render_job_worker(payload: dict[str, Any]) -> dict[str, Any]:
    cmd = [
        "bun",
        "tools/render-dataset.js",
        "--dataset",
        payload["shard_path"],
        "--server-url",
        payload["server_url"],
    ]

    start = time.time()
    ok = False
    rc = -1
    timeout_hit = False
    stdout = ""
    stderr = ""
    error_text = None

    try:
        proc = subprocess.run(
            cmd,
            cwd=payload["root"],
            capture_output=True,
            text=True,
            timeout=payload["timeout_sec"],
            check=False,
        )
        rc = proc.returncode
        stdout = proc.stdout or ""
        stderr = proc.stderr or ""
        ok = rc == 0
    except subprocess.TimeoutExpired as exc:
        timeout_hit = True
        stdout = (
            exc.stdout.decode("utf-8", errors="replace")
            if isinstance(exc.stdout, bytes)
            else (exc.stdout or "")
        )
        stderr = (
            exc.stderr.decode("utf-8", errors="replace")
            if isinstance(exc.stderr, bytes)
            else (exc.stderr or "")
        )
        error_text = f"timeout after {payload['timeout_sec']}s"
    except Exception as exc:  # noqa: BLE001
        error_text = str(exc)

    duration_sec = round(time.time() - start, 3)
    log_text = []
    log_text.append(f"job_id={payload['job_id']} attempt={payload['attempt']}\n")
    log_text.append(f"cmd={' '.join(cmd)}\n")
    log_text.append(
        f"duration_sec={duration_sec} return_code={rc} timeout={timeout_hit}\n\n"
    )
    if error_text:
        log_text.append(f"error={error_text}\n\n")
    if stdout:
        log_text.append("===== STDOUT =====\n")
        log_text.append(stdout)
        if not stdout.endswith("\n"):
            log_text.append("\n")
    if stderr:
        log_text.append("===== STDERR =====\n")
        log_text.append(stderr)
        if not stderr.endswith("\n"):
            log_text.append("\n")

    log_path = Path(payload["log_path"])
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text("".join(log_text), encoding="utf-8")

    return {
        "job_id": payload["job_id"],
        "attempt": payload["attempt"],
        "ok": ok,
        "return_code": rc,
        "timeout": timeout_hit,
        "duration_sec": duration_sec,
        "log_path": str(log_path),
        "error": error_text,
    }


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Parallel dataset renderer using multiprocessing"
    )
    p.add_argument(
        "--dataset", required=True, help="Dataset JSON path (absolute or repo-relative)"
    )
    p.add_argument(
        "--server-url", default="http://localhost:3000", help="Simulator server URL"
    )
    p.add_argument(
        "--workers",
        type=int,
        # Default ~7/8 of logical CPUs, capped at 28. Each worker is one
        # headless Chrome (~600-800MB RAM, ~1 core under SwiftShader load).
        # On a 32-thread / 128GB box this lands at 28 workers consuming
        # ~22GB and leaving 4 cores for OS + dev server. Override with
        # --workers N for smaller machines or different ratios.
        default=max(1, min(28, (mp.cpu_count() * 7) // 8)),
        help="Parallel worker count (default ~7/8 of CPUs, capped at 28)",
    )
    p.add_argument(
        "--chunk-size",
        type=int,
        default=8,
        help="Approx presets per shard before balancing",
    )
    p.add_argument(
        "--max-retries", type=int, default=2, help="Retries for single-preset jobs"
    )
    p.add_argument(
        "--timeout-sec", type=int, default=7200, help="Per job timeout in seconds"
    )
    p.add_argument("--run-id", default="", help="Optional run id (default timestamp)")
    p.add_argument(
        "--runs-dir",
        default=str(DEFAULT_RUNS_DIR),
        help="Directory for run logs/reports",
    )
    p.add_argument(
        "--skip-existing",
        action="store_true",
        help="Skip presets with existing metadata.json",
    )
    p.add_argument(
        "--keep-shards", action="store_true", help="Keep generated shard manifests"
    )
    p.add_argument(
        "--no-split-on-fail",
        action="store_true",
        help="Disable splitting failed shard jobs into smaller jobs",
    )
    return p


def resolve_path(path_str: str) -> Path:
    p = Path(path_str)
    if not p.is_absolute():
        p = ROOT / p
    return p.resolve()


def missing_outputs(names: list[str]) -> list[str]:
    return [n for n in names if not metadata_exists(n)]


def make_shard_file(
    shards_dir: Path, all_presets: dict[str, Any], names: list[str], shard_name: str
) -> Path:
    payload = {name: all_presets[name] for name in names}
    path = shards_dir / f"{shard_name}.json"
    write_json(path, payload)
    return path


def main() -> int:
    args = build_arg_parser().parse_args()

    if args.workers < 1:
        print("workers must be >= 1", file=sys.stderr)
        return 2
    if args.chunk_size < 1:
        print("chunk-size must be >= 1", file=sys.stderr)
        return 2
    if args.max_retries < 0:
        print("max-retries must be >= 0", file=sys.stderr)
        return 2
    if args.timeout_sec < 30:
        print("timeout-sec must be >= 30", file=sys.stderr)
        return 2

    dataset_path = resolve_path(args.dataset)
    if not dataset_path.exists():
        print(f"dataset not found: {dataset_path}", file=sys.stderr)
        return 2

    try:
        check_server(args.server_url)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    raw = read_json(dataset_path)
    presets = {k: v for k, v in raw.items() if is_preset_object(v)}
    all_names = sorted(presets.keys())

    if not all_names:
        print("No renderable presets found (must include model + steps).")
        return 0

    if args.skip_existing:
        pending_names = [n for n in all_names if not metadata_exists(n)]
    else:
        pending_names = list(all_names)

    skipped_count = len(all_names) - len(pending_names)

    print(f"Dataset:   {dataset_path}")
    print(f"Presets:   {len(all_names)} total")
    print(f"Pending:   {len(pending_names)}")
    print(f"Skipped:   {skipped_count}")
    print(f"Workers:   {args.workers}")
    print(f"Chunk:     {args.chunk_size}")
    print(f"Retries:   {args.max_retries}")
    print(f"SplitFail: {not args.no_split_on_fail}")

    if not pending_names:
        print("Nothing to render.")
        return 0

    run_id = args.run_id.strip() or now_ts()
    runs_dir = resolve_path(args.runs_dir)
    if not is_under_root(runs_dir, ROOT):
        print(
            f"runs-dir must be inside repo so shard manifests can be served by dev server. Received: {runs_dir}",
            file=sys.stderr,
        )
        return 2
    run_dir = runs_dir / run_id
    shards_dir = run_dir / "shards"
    logs_dir = run_dir / "logs"
    run_dir.mkdir(parents=True, exist_ok=True)
    shards_dir.mkdir(parents=True, exist_ok=True)
    logs_dir.mkdir(parents=True, exist_ok=True)

    split_on_fail = not args.no_split_on_fail

    shard_lists = split_jobs_balanced(
        presets, pending_names, args.workers, args.chunk_size
    )
    jobs: list[Job] = []
    for i, names in enumerate(shard_lists, start=1):
        job_id = f"job_{i:04d}"
        shard_path = make_shard_file(shards_dir, presets, names, job_id)
        jobs.append(Job(job_id=job_id, names=names, shard_path=str(shard_path)))

    report_path = run_dir / "report.json"
    submit_queue: list[Job] = list(jobs)
    running: dict[Any, Job] = {}
    completed_names: set[str] = set()
    failed_names: dict[str, str] = {}
    results: list[dict[str, Any]] = []

    start_time = time.time()

    print(f"Run id:    {run_id}")
    print(f"Run dir:   {run_dir}")
    print(f"Jobs:      {len(jobs)} initial shards")

    ctx = mp.get_context("spawn")
    with ProcessPoolExecutor(max_workers=args.workers, mp_context=ctx) as pool:
        while submit_queue or running:
            while submit_queue and len(running) < args.workers:
                job = submit_queue.pop(0)
                attempt_tag = f"a{job.attempt}"
                log_path = logs_dir / f"{job.job_id}_{attempt_tag}.log"
                payload = {
                    "job_id": job.job_id,
                    "attempt": job.attempt,
                    "shard_path": rel_to_root(Path(job.shard_path)),
                    "server_url": args.server_url,
                    "timeout_sec": args.timeout_sec,
                    "root": str(ROOT),
                    "log_path": str(log_path),
                }
                fut = pool.submit(render_job_worker, payload)
                running[fut] = job
                print(
                    f"[submit] {job.job_id} attempt={job.attempt} presets={len(job.names)}"
                )

            done, _ = wait(running.keys(), return_when=FIRST_COMPLETED)
            for fut in done:
                job = running.pop(fut)
                try:
                    worker_result = fut.result()
                except Exception as exc:  # noqa: BLE001
                    worker_result = {
                        "job_id": job.job_id,
                        "attempt": job.attempt,
                        "ok": False,
                        "return_code": -1,
                        "timeout": False,
                        "duration_sec": 0.0,
                        "log_path": "",
                        "error": f"worker exception: {exc}",
                    }

                render_missing = []
                if worker_result["ok"]:
                    render_missing = missing_outputs(job.names)
                    if render_missing:
                        worker_result["ok"] = False
                        worker_result["error"] = (
                            f"missing metadata for {len(render_missing)} preset(s)"
                        )

                status = "ok" if worker_result["ok"] else "fail"
                print(
                    f"[{status}] {job.job_id} attempt={job.attempt} presets={len(job.names)} "
                    f"duration={worker_result['duration_sec']}s"
                )

                result_item = {
                    "job_id": job.job_id,
                    "attempt": job.attempt,
                    "preset_count": len(job.names),
                    "presets": list(job.names),
                    "parent_id": job.parent_id,
                    **worker_result,
                }
                if render_missing:
                    result_item["missing_outputs"] = render_missing
                results.append(result_item)

                if worker_result["ok"]:
                    for n in job.names:
                        completed_names.add(n)
                    continue

                if split_on_fail and len(job.names) > 1:
                    mid = len(job.names) // 2
                    left = job.names[:mid]
                    right = job.names[mid:]
                    children = [left, right]
                    child_jobs: list[Job] = []
                    for idx, child_names in enumerate(children, start=1):
                        child_id = f"{job.job_id}s{idx}"
                        child_shard = make_shard_file(
                            shards_dir, presets, child_names, child_id
                        )
                        child_jobs.append(
                            Job(
                                job_id=child_id,
                                names=child_names,
                                shard_path=str(child_shard),
                                attempt=0,
                                parent_id=job.job_id,
                            )
                        )
                    submit_queue.extend(child_jobs)
                    print(
                        f"[split] {job.job_id} -> {child_jobs[0].job_id} ({len(left)}), {child_jobs[1].job_id} ({len(right)})"
                    )
                    continue

                if job.attempt < args.max_retries:
                    retry = Job(
                        job_id=job.job_id,
                        names=job.names,
                        shard_path=job.shard_path,
                        attempt=job.attempt + 1,
                        parent_id=job.parent_id,
                    )
                    submit_queue.append(retry)
                    print(f"[retry] {job.job_id} attempt={retry.attempt}")
                    continue

                reason = (
                    worker_result.get("error")
                    or f"return_code={worker_result.get('return_code')}"
                )
                for n in job.names:
                    failed_names[n] = reason

    elapsed_sec = round(time.time() - start_time, 3)
    final_missing = [n for n in pending_names if not metadata_exists(n)]
    for n in final_missing:
        failed_names.setdefault(n, "missing metadata after run")

    succeeded = sorted(set(pending_names) - set(failed_names.keys()))
    failed = sorted(failed_names.keys())

    report = {
        "run_id": run_id,
        "dataset": str(dataset_path),
        "server_url": args.server_url,
        "started_at": start_time,
        "elapsed_sec": elapsed_sec,
        "workers": args.workers,
        "chunk_size": args.chunk_size,
        "max_retries": args.max_retries,
        "split_on_fail": split_on_fail,
        "skip_existing": bool(args.skip_existing),
        "total_presets": len(all_names),
        "pending_presets": len(pending_names),
        "skipped_existing": skipped_count,
        "succeeded_presets": len(succeeded),
        "failed_presets": len(failed),
        "succeeded_names": succeeded,
        "failed": [{"name": n, "reason": failed_names[n]} for n in failed],
        "jobs_executed": len(results),
        "results": results,
    }
    write_json(report_path, report)

    print("\nRun complete")
    print(f"Elapsed:   {elapsed_sec}s")
    print(f"Succeeded: {len(succeeded)}")
    print(f"Failed:    {len(failed)}")
    print(f"Report:    {report_path}")

    if not args.keep_shards:
        for p in shards_dir.glob("*.json"):
            try:
                p.unlink()
            except OSError:
                pass

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
