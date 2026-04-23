"""
TopoBench Origami Tracking – VLM API Evaluation

Loads metadata.json (or legacy dataset.json) from ../screenshots/<benchmark>/,
sends images + questions to an OpenAI-compatible VLM API, compares responses,
reports accuracy with optional per-color-mode breakdown.

Config loaded from .env file (BASE_URL, API_KEY, MODEL).

Usage:
    uv run eval.py                          # all benchmarks
    uv run eval.py --benchmarks bird-track-7 bird-track-8
    uv run eval.py --dry-run                # print questions, skip API calls
    uv run eval.py --concurrency 4          # parallel API requests
    uv run eval.py --wandb off              # disable wandb logging
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import importlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, cast

from dotenv import load_dotenv
from hydra import compose, initialize_config_dir
from omegaconf import DictConfig
from openai import AsyncOpenAI
from tqdm import tqdm

load_dotenv(Path(__file__).resolve().parent / ".env")

SCREENSHOTS_DIR = Path(__file__).resolve().parent.parent / "screenshots"
RESULTS_DIR = Path(__file__).resolve().parent / "results"


def load_hydra_config(overrides: list[str]) -> DictConfig:
    config_dir = str((Path(__file__).resolve().parent / "configs").resolve())
    with initialize_config_dir(version_base=None, config_dir=config_dir):
        return compose(config_name="config", overrides=overrides)


# ---------------------------------------------------------------------------
# Image encoding
# ---------------------------------------------------------------------------


def image_to_content(path: Path) -> dict:
    """Build an OpenAI-compatible image_url content block."""
    b64 = base64.b64encode(path.read_bytes()).decode("utf-8")
    suffix = path.suffix.lstrip(".").lower()
    mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg"}.get(
        suffix, "image/png"
    )
    return {
        "type": "image_url",
        "image_url": {"url": f"data:{mime};base64,{b64}"},
    }


# ---------------------------------------------------------------------------
# API call
# ---------------------------------------------------------------------------


async def query_vlm(
    client: AsyncOpenAI,
    images: list[Path],
    question: str,
    semaphore: asyncio.Semaphore,
    model_name: str,
    max_tokens: int,
    temperature: float,
) -> tuple[str, str]:
    """Send images + question to the VLM API and return (response, reasoning)."""
    content: list[dict] = [image_to_content(p) for p in images]
    content.append({"type": "text", "text": question + "\nAnswer concisely."})

    async with semaphore:
        resp = await client.chat.completions.create(
            model=model_name,
            messages=cast(Any, [{"role": "user", "content": content}]),
            max_tokens=max_tokens,
            temperature=temperature,
        )
        choice = resp.choices[0]
        msg = choice.message
        text = msg.content or ""
        reasoning = getattr(msg, "reasoning_content", None) or ""
        if not text:
            print(
                f"  DEBUG: empty content. finish_reason={choice.finish_reason}, "
                f"usage={resp.usage}, raw_message={msg}",
                file=sys.stderr,
            )
        return text.strip(), reasoning.strip()


# ---------------------------------------------------------------------------
# Answer comparison
# ---------------------------------------------------------------------------


def normalize_answer(text: str) -> str:
    return text.strip().lower().rstrip(".!,")


def compare_answer(predicted: str, expected: str, answer_type: str) -> bool:
    pred = normalize_answer(predicted)
    exp = normalize_answer(str(expected))

    if answer_type == "yes_no":
        pred_yes = "yes" in pred
        pred_no = "no" in pred
        if pred_yes and not pred_no:
            return exp == "yes"
        if pred_no and not pred_yes:
            return exp == "no"
        first_word = pred.split()[0] if pred.split() else ""
        return first_word == exp

    if answer_type in ("integer", "float"):
        try:
            return float(pred) == float(exp)
        except ValueError:
            nums = re.findall(r"-?\d+\.?\d*", pred)
            return float(nums[0]) == float(exp) if nums else False

    if answer_type == "multiple_choice":
        return exp in pred

    if answer_type == "list":
        def parse_letters(text: str) -> set[str]:
            candidates: list = []
            try:
                parsed = json.loads(text)
                candidates.append(parsed)
                if isinstance(parsed, dict) and "answer" in parsed:
                    candidates.append(parsed["answer"])
            except (json.JSONDecodeError, TypeError):
                m = re.search(r'"answer"\s*:\s*(\[[^\]]*\]|"[^"]*")', text)
                if m:
                    try:
                        candidates.append(json.loads(m.group(1)))
                    except (json.JSONDecodeError, TypeError):
                        pass
            for cand in candidates:
                if isinstance(cand, list):
                    return {str(x).strip().upper() for x in cand}
                if isinstance(cand, str):
                    text = cand
                    break
            cleaned = text.upper().replace(" AND ", ",").replace("AND", ",")
            return set(re.findall(r"[A-Z]", cleaned))

        return parse_letters(predicted) == parse_letters(str(expected))

    if answer_type == "lists":
        # Two-group comparison: "Front: A, B | Back: C, D"
        # Parse both predicted and expected into {group_name: set_of_letters}
        def parse_groups(text: str) -> dict[str, set[str]]:
            groups: dict[str, set[str]] = {}
            text = text.strip()
            try:
                parsed = json.loads(text)
                if isinstance(parsed, dict) and isinstance(parsed.get("answer"), str):
                    text = parsed["answer"]
                elif isinstance(parsed, dict) and isinstance(parsed.get("answer"), dict):
                    inner = parsed["answer"]
                    for k, v in inner.items():
                        if isinstance(v, list):
                            groups[str(k).strip().lower()] = {str(x).strip().upper() for x in v}
                    if groups:
                        return groups
            except (json.JSONDecodeError, TypeError):
                pass
            # Try "Front: A, B | Back: C, D" format
            for segment in re.split(r"\|", text):
                segment = segment.strip()
                if ":" in segment:
                    label, rest = segment.split(":", 1)
                    key = label.strip().lower()
                    letters = set(re.findall(r"\b([A-Z])\b", rest.upper()))
                    if not letters:
                        letters = set(re.findall(r"[A-Z]", rest.upper()))
                    groups[key] = letters
            if groups:
                return groups
            # Fallback: try to find "front" and "back" sections in free text
            upper = text.upper()
            front_match = re.search(r"FRONT[:\s]*((?:[A-Z][\s,]*)+)", upper)
            back_match = re.search(r"BACK[:\s]*((?:[A-Z][\s,]*)+)", upper)
            if front_match:
                groups["front"] = set(re.findall(r"[A-Z]", front_match.group(1)))
            if back_match:
                groups["back"] = set(re.findall(r"[A-Z]", back_match.group(1)))
            return groups

        pred_groups = parse_groups(predicted)
        exp_groups = parse_groups(expected)
        if not pred_groups or not exp_groups:
            return False
        # Both must have same groups with same letters
        return pred_groups == exp_groups

    return pred == exp


# ---------------------------------------------------------------------------
# Color mode helpers
# ---------------------------------------------------------------------------


def get_color_mode(record: dict) -> str | None:
    """Extract color mode from a sample/metadata record."""
    for key in ("colorMode", "color_mode"):
        val = record.get(key)
        if val:
            return str(val).strip()
    meta = record.get("metadata")
    if isinstance(meta, dict):
        for key in ("colorMode", "color_mode"):
            val = meta.get(key)
            if val:
                return str(val).strip()
    return None


def load_color_mode_lookup(json_paths: list[str]) -> dict[str, str]:
    """Build benchmark_name -> colorMode lookup from JSON preset files."""
    root = Path(__file__).resolve().parent.parent
    lookup: dict[str, str] = {}
    for raw in json_paths:
        path = Path(raw) if Path(raw).is_absolute() else root / raw
        if not path.exists():
            print(f"warning: color mode source not found: {raw}", file=sys.stderr)
            continue
        try:
            data = json.loads(path.read_text())
        except Exception as exc:
            print(f"warning: failed to read {path}: {exc}", file=sys.stderr)
            continue
        if isinstance(data, dict):
            for name, cfg in data.items():
                if isinstance(cfg, dict):
                    mode = get_color_mode(cfg)
                    if mode:
                        lookup[name] = mode
    return lookup


def compute_color_mode_stats(
    results: list[dict],
    modes: list[str],
    lookup: dict[str, str],
) -> dict:
    """Per-mode and cumulative accuracy for selected color modes."""
    per_mode: dict[str, dict] = {m: {"correct": 0, "total": 0} for m in modes}
    unknown = 0

    for r in results:
        mode = get_color_mode(r) or lookup.get(r.get("benchmark", ""))
        if not mode or mode not in per_mode:
            if not mode:
                unknown += 1
            continue
        per_mode[mode]["total"] += 1
        if r.get("correct"):
            per_mode[mode]["correct"] += 1

    # Build cumulative stats in mode order
    cum_correct, cum_total = 0, 0
    cumulative = []
    per_mode_out = []
    for m in modes:
        s = per_mode[m]
        acc = s["correct"] / s["total"] * 100 if s["total"] else 0.0
        per_mode_out.append({"mode": m, **s, "accuracy": acc})
        cum_correct += s["correct"]
        cum_total += s["total"]
        cumulative.append({
            "mode": m,
            "correct": cum_correct,
            "total": cum_total,
            "accuracy": cum_correct / cum_total * 100 if cum_total else 0.0,
        })

    overall = cum_correct / cum_total * 100 if cum_total else 0.0
    return {
        "selected_modes": modes,
        "per_mode": per_mode_out,
        "cumulative_by_mode": cumulative,
        "selected_correct": cum_correct,
        "selected_total": cum_total,
        "selected_accuracy": overall,
        "unknown_color_mode_count": unknown,
    }


def print_color_mode_stats(stats: dict) -> None:
    print(f"\n{'=' * 60}")
    print("COLOR MODE SUCCESS")
    print(f"{'=' * 60}")
    for row in stats["per_mode"]:
        print(f"  {row['mode']}: {row['correct']}/{row['total']} = {row['accuracy']:.1f}%")
    print(f"\n  cumulative: {stats['selected_correct']}/{stats['selected_total']} = {stats['selected_accuracy']:.1f}%")
    if stats["unknown_color_mode_count"]:
        print(f"  note: {stats['unknown_color_mode_count']} sample(s) had no color mode metadata")


# ---------------------------------------------------------------------------
# Dataset loading
# ---------------------------------------------------------------------------


def discover_benchmarks(
    benchmarks: list[str] | None = None,
    prefix: str | None = None,
) -> list[Path]:
    if benchmarks:
        dirs = [SCREENSHOTS_DIR / b for b in benchmarks]
    elif prefix:
        dirs = sorted(
            d for d in SCREENSHOTS_DIR.iterdir()
            if d.is_dir() and d.name.startswith(prefix)
        ) if SCREENSHOTS_DIR.exists() else []
    else:
        dirs = sorted(SCREENSHOTS_DIR.iterdir()) if SCREENSHOTS_DIR.exists() else []
    return [
        d for d in dirs
        if d.is_dir()
        and ((d / "metadata.json").exists() or (d / "dataset.json").exists())
    ]


def build_sample_from_metadata(meta: dict, task_cfg: DictConfig) -> dict:
    """Construct a complete eval sample from metadata + Hydra task config."""
    template = str(task_cfg.question_template)
    all_labels = meta.get("allLabels", [])
    initial_points = meta.get("initialPoints", [])
    front_points = meta.get("frontPoints", [])
    back_points = meta.get("backPoints", [])

    question = template.format(
        num_initial=len(initial_points),
        all_labels=", ".join(all_labels),
        total_points=meta.get("totalPoints", 0),
        difficulty=meta.get("difficulty", 0),
        front_count=len(front_points),
        back_count=len(back_points),
    )

    answer_key = str(task_cfg.answer_key)
    answer_type = str(task_cfg.answer_type)

    # "sides" is a composite key: front/back point lists
    if answer_key == "sides":
        answer = f"Front: {', '.join(sorted(front_points))} | Back: {', '.join(sorted(back_points))}"
    else:
        answer_raw = meta.get(answer_key, [])
        answer = ", ".join(sorted(str(x) for x in answer_raw)) if isinstance(answer_raw, list) else str(answer_raw)

    return {
        **meta,
        "question": question,
        "answer": answer,
        "answer_type": answer_type,
        "color_mode": get_color_mode(meta),
    }


def load_samples(benchmark_dir: Path, task_cfg: DictConfig | None = None) -> list[dict]:
    meta_path = benchmark_dir / "metadata.json"
    legacy_path = benchmark_dir / "dataset.json"

    if meta_path.exists():
        entries = json.loads(meta_path.read_text())
        valid = [e for e in entries if "id" in e and "images" in e]
        if task_cfg:
            return [build_sample_from_metadata(e, task_cfg) for e in valid]
        return valid

    # Legacy dataset.json — question/answer already embedded
    samples = json.loads(legacy_path.read_text())
    return [s for s in samples if all(k in s for k in ("id", "question", "answer", "images"))]


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------


async def evaluate_sample(
    client: AsyncOpenAI,
    sample: dict,
    semaphore: asyncio.Semaphore,
    dry_run: bool,
    model_name: str,
    max_tokens: int,
    temperature: float,
) -> dict:
    sid = sample["id"]
    question = sample["question"]
    expected = sample["answer"]
    answer_type = sample.get("answer_type", "free_text")
    color_mode = get_color_mode(sample)

    image_paths = [
        SCREENSHOTS_DIR / ip for ip in sample["images"]
        if (SCREENSHOTS_DIR / ip).exists()
    ]

    reasoning = ""
    if dry_run:
        predicted, correct, elapsed = "", False, 0.0
    else:
        t0 = time.time()
        try:
            predicted, reasoning = await query_vlm(
                client, image_paths, question, semaphore,
                model_name, max_tokens, temperature,
            )
        except Exception as e:
            predicted = f"[ERROR] {type(e).__name__}: {e}"
            print(f"  API error for sample {sid}: {e}", file=sys.stderr)
        elapsed = time.time() - t0
        correct = compare_answer(predicted, str(expected), answer_type)

    return {
        "benchmark": sample.get("_benchmark", ""),
        "id": sid,
        "question": question,
        "expected": expected,
        "predicted": predicted,
        "reasoning": reasoning,
        "correct": correct,
        "answer_type": answer_type,
        "elapsed": round(elapsed, 2),
        "color_mode": color_mode,
        "difficulty": sample.get("difficulty"),
        "image_paths": [str(p) for p in image_paths],
        "metadata": sample.get("metadata", {}),
    }


async def run_evaluation(
    benchmark_dirs: list[Path],
    dry_run: bool,
    concurrency: int,
    base_url: str,
    api_key: str,
    model_name: str,
    max_tokens: int,
    temperature: float,
    task_cfg: DictConfig | None = None,
) -> dict:
    semaphore = asyncio.Semaphore(concurrency)
    client = AsyncOpenAI(base_url=base_url, api_key=api_key)

    # Load all samples and tag with benchmark name
    benchmark_order = [d.name for d in benchmark_dirs]
    benchmark_samples: dict[str, list[dict]] = {}
    tasks: list[asyncio.Task] = []

    for bdir in benchmark_dirs:
        name = bdir.name
        samples = load_samples(bdir, task_cfg=task_cfg)
        benchmark_samples[name] = samples
        for s in samples:
            s["_benchmark"] = name
            tasks.append(asyncio.create_task(
                evaluate_sample(client, s, semaphore, dry_run, model_name, max_tokens, temperature)
            ))

    # Run all concurrently with progress bar
    task_results: list[dict] = []
    correct_so_far = 0
    pbar = tqdm(total=len(tasks), desc="Evaluating", unit="sample")
    for coro in asyncio.as_completed(tasks):
        result = await coro
        task_results.append(result)
        if result["correct"]:
            correct_so_far += 1
        pbar.set_postfix(acc=f"{correct_so_far}/{len(task_results)}")
        pbar.update(1)
    pbar.close()
    await client.close()

    # Group results back by benchmark for ordered output
    results_by_bench: dict[str, list[dict]] = {n: [] for n in benchmark_order}
    for r in task_results:
        results_by_bench.setdefault(r["benchmark"], []).append(r)

    all_results: list[dict] = []
    for name in benchmark_order:
        samples = benchmark_samples.get(name, [])
        bench_results = results_by_bench.get(name, [])

        print(f"\n{'=' * 60}")
        print(f"Benchmark: {name}  ({len(samples)} samples)")
        print(f"{'=' * 60}")

        bench_correct = 0
        for r in bench_results:
            tag = "OK" if r["correct"] else "WRONG"
            print(f"  [{r['id']}] {tag}  Q: {r['question']}")
            if not dry_run:
                print(f"         Expected: {r['expected']}  Predicted: {r['predicted']}")
            if r["correct"]:
                bench_correct += 1
            all_results.append(r)

        acc = bench_correct / len(samples) * 100 if samples else 0
        print(f"\n  {name}: {bench_correct}/{len(samples)} = {acc:.1f}%")

    total_correct = sum(1 for r in all_results if r["correct"])
    total_count = len(all_results)
    overall_acc = total_correct / total_count * 100 if total_count else 0

    print(f"\n{'=' * 60}")
    print(f"OVERALL: {total_correct}/{total_count} = {overall_acc:.1f}%")
    print(f"{'=' * 60}")

    return {
        "model": model_name,
        "base_url": base_url,
        "total_correct": total_correct,
        "total_count": total_count,
        "accuracy": overall_acc,
        "results": all_results,
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def get_git_commit() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=Path(__file__).resolve().parent.parent,
            stderr=subprocess.DEVNULL,
        ).decode().strip()
    except Exception:
        return "unknown"


def normalize_wandb_mode(value: Any) -> str:
    if isinstance(value, bool):
        return "on" if value else "off"
    text = str(value).strip().lower()
    if text in ("off", "false", "0", "no"):
        return "off"
    if text in ("on", "true", "1", "yes"):
        return "on"
    return "auto"


def main():
    parser = argparse.ArgumentParser(description="TopoBench Origami Tracking Eval")
    parser.add_argument("--benchmarks", nargs="*", help="Benchmark folder names (default: all)")
    parser.add_argument("--prefix", type=str, default=None, help="Benchmark name prefix (e.g. bird-frontback)")
    parser.add_argument("--dry-run", action="store_true", help="Print questions, skip API calls")
    parser.add_argument("--concurrency", type=int, default=None, help="Max parallel API requests")
    parser.add_argument("--output", type=str, default=None, help="Output JSON path")
    parser.add_argument("--wandb", choices=["auto", "on", "off"], default=None)
    parser.add_argument("--no-wandb", action="store_true", help="Disable wandb logging")
    parser.add_argument("--wandb-project", type=str, default=None)
    args, hydra_overrides = parser.parse_known_args()

    # Separate benchmark names from hydra key=value overrides
    bench_names = []
    extra_hydra = []
    for v in (args.benchmarks or []):
        (extra_hydra if "=" in v else bench_names).append(v)
    args.benchmarks = bench_names or None
    hydra_overrides += extra_hydra

    cfg = load_hydra_config(hydra_overrides)
    model_cfg = cfg.model
    eval_cfg = cfg.eval
    wandb_cfg = cfg.wandb
    task_cfg = cfg.get("task", None)

    model_name = os.environ.get("MODEL", str(model_cfg.name))
    base_url = os.environ.get("BASE_URL", str(model_cfg.base_url))
    api_key_env = str(model_cfg.get("api_key_env", "API_KEY"))
    api_key = os.environ.get(api_key_env, "")
    if not api_key:
        print(f"Missing required API key env var: {api_key_env}", file=sys.stderr)
        sys.exit(2)

    max_tokens = int(eval_cfg.get("max_tokens", model_cfg.get("max_output_tokens", 32768)))
    temperature = float(eval_cfg.get("temperature", 0.0))
    concurrency = args.concurrency or int(eval_cfg.get("max_concurrency", 4))

    benchmark_dirs = discover_benchmarks(args.benchmarks, prefix=args.prefix)
    if not benchmark_dirs:
        print("No benchmarks found with metadata.json/dataset.json in screenshots/")
        sys.exit(1)

    benchmark_names = [d.name for d in benchmark_dirs]

    # Wandb setup
    wandb_mode = "off" if args.no_wandb else normalize_wandb_mode(args.wandb or wandb_cfg.get("mode", "auto"))
    wandb_project = args.wandb_project or str(wandb_cfg.get("project", "origami-eval"))
    use_wandb = False
    wandb: Any = None

    if wandb_mode != "off" and not args.dry_run:
        try:
            wandb = importlib.import_module("wandb")
            use_wandb = True
        except Exception:
            if wandb_mode == "on":
                print("wandb requested but not available.", file=sys.stderr)
                sys.exit(2)
            print("wandb not available; continuing without.", file=sys.stderr)

    task_name = str(task_cfg.name) if task_cfg else "unknown"

    if use_wandb:
        wandb.init(
            project=wandb_project,
            entity=wandb_cfg.get("entity", None),
            name=wandb_cfg.get("name", None),
            tags=list(wandb_cfg.get("tags", [])),
            group=wandb_cfg.get("group", None),
            job_type=wandb_cfg.get("job_type", "eval"),
            config={
                "task": task_name,
                "model": model_name, "base_url": base_url,
                "max_tokens": max_tokens, "temperature": temperature,
                "benchmarks": benchmark_names, "concurrency": concurrency,
                "git_commit": get_git_commit(), "hydra_overrides": hydra_overrides,
            },
        )

    print(f"Task: {task_name}  |  Found {len(benchmark_dirs)} benchmark(s): {benchmark_names}")
    if not args.dry_run:
        print(f"Model: {model_name}  Base URL: {base_url}  Concurrency: {concurrency}")

    results = asyncio.run(run_evaluation(
        benchmark_dirs, args.dry_run, concurrency,
        base_url, api_key, model_name, max_tokens, temperature,
        task_cfg=task_cfg,
    ))

    # Color mode breakdown
    cm_cfg = eval_cfg.get("color_mode_success", {})
    cm_modes = list(cm_cfg.get("modes", []))
    if cm_cfg.get("enabled") and cm_modes:
        sources = list(cm_cfg.get("benchmark_json_paths", []))
        lookup = load_color_mode_lookup(sources)
        cm_stats = compute_color_mode_stats(results["results"], cm_modes, lookup)
        print_color_mode_stats(cm_stats)
        results["color_mode_success"] = cm_stats
    else:
        results["color_mode_success"] = None

    # Save results
    RESULTS_DIR.mkdir(exist_ok=True)
    out_path = Path(args.output) if args.output else RESULTS_DIR / f"eval_{time.strftime('%Y%m%d_%H%M%S')}.json"
    out_path.write_text(json.dumps(results, indent=2))
    print(f"\nResults saved to: {out_path}")

    # Wandb logging
    if use_wandb:
        all_r = results["results"]

        # ── Per-benchmark accuracy ──
        per_bench: dict[str, dict] = {}
        for r in all_r:
            b = r["benchmark"]
            per_bench.setdefault(b, {"correct": 0, "total": 0})
            per_bench[b]["total"] += 1
            if r["correct"]:
                per_bench[b]["correct"] += 1

        # ── Per-difficulty accuracy ──
        per_diff: dict[int, dict] = {}
        for r in all_r:
            d = r.get("difficulty")
            if d is not None:
                per_diff.setdefault(d, {"correct": 0, "total": 0})
                per_diff[d]["total"] += 1
                if r["correct"]:
                    per_diff[d]["correct"] += 1

        # ── Per-color-mode accuracy ──
        per_cm: dict[str, dict] = {}
        for r in all_r:
            cm = r.get("color_mode")
            if cm:
                per_cm.setdefault(cm, {"correct": 0, "total": 0})
                per_cm[cm]["total"] += 1
                if r["correct"]:
                    per_cm[cm]["correct"] += 1

        # ── Summary metrics ──
        wandb.summary["task"] = task_name
        log_data: dict[str, Any] = {
            "task": task_name,
            "accuracy": results["accuracy"],
            "total_correct": results["total_correct"],
            "total_count": results["total_count"],
        }
        if all_r:
            log_data["avg_elapsed"] = sum(r["elapsed"] for r in all_r) / len(all_r)
        for b, v in per_bench.items():
            log_data[f"accuracy/benchmark/{b}"] = v["correct"] / v["total"] * 100
        for d, v in sorted(per_diff.items()):
            log_data[f"accuracy/difficulty/{d}"] = v["correct"] / v["total"] * 100
        for cm, v in per_cm.items():
            log_data[f"accuracy/color_mode/{cm}"] = v["correct"] / v["total"] * 100

        # Cumulative color mode stats if computed
        cm_stats = results.get("color_mode_success")
        if cm_stats:
            log_data["accuracy/color_mode_cumulative"] = cm_stats["selected_accuracy"]

        wandb.log(log_data)

        # ── Results table with images ──
        columns = [
            "benchmark", "id", "images", "color_mode", "difficulty",
            "question", "expected", "predicted", "correct",
            "reasoning", "elapsed", "answer_type",
        ]
        table = wandb.Table(columns=columns)
        for r in all_r:
            # Build a list of wandb.Image objects from the captured screenshots
            img_list = []
            for p in r.get("image_paths", []):
                img_path = Path(p)
                if img_path.exists():
                    try:
                        img_list.append(wandb.Image(str(img_path)))
                    except Exception:
                        pass

            table.add_data(
                r["benchmark"],
                r["id"],
                img_list if img_list else None,
                r.get("color_mode", ""),
                r.get("difficulty", ""),
                r["question"],
                str(r["expected"]),
                r["predicted"],
                r["correct"],
                r.get("reasoning", ""),
                r["elapsed"],
                r["answer_type"],
            )
        wandb.log({"results_table": table})
        wandb.finish()


if __name__ == "__main__":
    main()
