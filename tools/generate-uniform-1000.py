#!/usr/bin/env python3
"""
One-command orchestrator for the uniform-1000 (1008-preset) dataset.

Pipeline:
  1. Wipe `dataset/` (preserving `.scan-cache/`) and `new_dataset/uniform-1000{,-logs}/`.
  2. Pass 1: full matrix via `generate-matrix.js` with the tier-default
     rotation profile counts (d1=20, d3=12, d4=50). Handles prewarm +
     parallelism + per-shard seed derivation. Targets 84 per cell.
  3. Pass 2+ (continuation): for cells short of 84, re-run those cells
     with progressively higher `--rotation-profile-count`. The (traj,
     profile) pair count is the binding knob on Phase 2 acceptance for
     low-yield cells (opensink, pinwheel-d4) — bumping it gives Phase 2
     more chances to fill the earlyStop cap. Per-shard seed identical to
     Pass 1, so files are SUPERSETS (cache hits replay; new accepts only
     come from the additional profiles). Same filename = atomic rewrite
     with strictly more presets.
  4. Final assemble (`assemble-uniform-1000.py`) and parallel render.

Usage:
  bun run dev            # in another terminal
  python3 tools/generate-uniform-1000.py
"""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = 84
BASE_SEED = 12345
DEV_SERVER = "http://localhost:3000"

# Worker concurrency for continuation passes (Pass 2+). Leaves 4 threads
# for OS + dev server + renderer; SwiftShader-backed Chrome is ~1 core
# per Puppeteer instance.
CPU_COUNT = os.cpu_count() or 4
WORKERS = max(2, min(28, CPU_COUNT - 4))

# Per-cell metadata. (cell_name, model_path, difficulty, sharded, count).
# Oversample: count exceeds TARGET=84 so the assembler can cap at 84.
# Slack lets cells with attrition (validation drops, refinement drops)
# still reach 84 even when some shards underperform.
#   d1 unsharded: count=120 (vs 84). Phase 2 earlyStop = max(3, count) = 120.
#   d3/d4 sharded: count=30 per shard (vs 21). 4×30 = 120 max per cell.
CELLS = [
    ("bird-d1",      "/Bases/birdBase.svg",      1, False, 120),
    ("waterbomb-d1", "/Bases/waterbombBase.svg", 1, False, 120),
    ("pinwheel-d1",  "/Bases/pinwheelBase.svg",  1, False, 120),
    ("opensink-d1",  "/Bases/openSinkBase.svg",  1, False, 120),
    ("bird-d3",      "/Bases/birdBase.svg",      3, True,  30),
    ("waterbomb-d3", "/Bases/waterbombBase.svg", 3, True,  30),
    ("pinwheel-d3",  "/Bases/pinwheelBase.svg",  3, True,  30),
    ("opensink-d3",  "/Bases/openSinkBase.svg",  3, True,  30),
    ("bird-d4",      "/Bases/birdBase.svg",      4, True,  30),
    ("waterbomb-d4", "/Bases/waterbombBase.svg", 4, True,  30),
    ("pinwheel-d4",  "/Bases/pinwheelBase.svg",  4, True,  30),
    ("opensink-d4",  "/Bases/openSinkBase.svg",  4, True,  30),
]
SHARDS_PER_SLOT = 4
PER_CELL_TOTAL = 120  # oversample target (assembler caps at 84)
BUILD = 300
MAX_TRAJ = 1200

# Pass 1 is `generate-matrix.js` with these baseline profile counts.
PROFILE_INITIAL = {"d1": 20, "d3": 6, "d4": 30}
PROFILE_CEILING = {"d1": 200, "d3": 6, "d4": 200}

# Multi-stage adaptive continuation. Each stage targets a DIFFERENT
# failure mode and increases knob aggressiveness based on remaining
# deficit. The orchestrator iterates stages; each runs ONLY on cells
# still short after the previous, and skips (rather than terminates)
# stages that produced no progress.
#
#   Stage A — Phase 2 acceptance count (low-yield d1/d4 cells).
#     Knob: rotationProfileCount. More (traj, profile) pairs evaluated.
#     Cache key v3 excludes profileCount → prior indices replay, only
#     new indices run live (cache-warm).
#   Stage B — Validation per-step visibility too strict (geometry-dense
#     models like opensink/pinwheel fail per-step gates).
#     Knob: lower minPointSeparationPx (70 → 50). Validation-only,
#     doesn't touch Phase 2 acceptance → cache stays valid.
#   Stage C — Phase 2 acceptance gate too strict (trajectories rejected
#     mid-fold for marginal anchor quality).
#     Knob: lower minFaceQuality (0.05 → 0.02). Affects Phase 2 accept
#     decision → invalidates cache for the run; cold restart on deficit
#     cells.
#   Stage D — All loosened + max profile multiplier. Last-resort.
#
# Adaptive scaling: each stage's profile multiplier scales with the
# WORST deficit going in (deficit > 30 → 4×, deficit > 10 → 2×, else
# 1.5×), capped at PROFILE_CEILING. Smaller deficits don't waste
# wall-time on wide profile sweeps.
#
# d3 profile count is NEVER bumped (sampled random profiles fail
# strictAllSteps validation, regressing yield).
STAGES = [
    {"name": "profile-bump",
     "min_sep_px": 70, "min_face_q": 0.05},
    {"name": "loosen-separation",
     "min_sep_px": 50, "min_face_q": 0.05},
    {"name": "loosen-face-quality",
     "min_sep_px": 50, "min_face_q": 0.02},
    {"name": "max-fallback",
     "min_sep_px": 40, "min_face_q": 0.02},
]


def adaptive_profile_mult(max_deficit):
    """Bigger deficit → more aggressive profile bump."""
    if max_deficit > 30:
        return 4
    if max_deficit > 10:
        return 2
    return 1  # minor deficit; gate loosening alone may suffice


def stage_profiles(stage_idx, max_deficit):
    """Compute per-tier rotationProfileCount for this stage. Profile
    bumps stack across stages: stage 0 = base mult, stage 1+ keeps
    momentum (so loosening stages still get the prior bump)."""
    base_mult = adaptive_profile_mult(max_deficit)
    # Stage A doubles. Subsequent stages keep at least 2× to stay above
    # baseline; stage D goes to 4×.
    if stage_idx >= 3:
        mult = max(4, base_mult)
    elif stage_idx >= 1:
        mult = max(2, base_mult)
    else:
        mult = base_mult
    return {
        "d1": min(PROFILE_INITIAL["d1"] * mult, PROFILE_CEILING["d1"]),
        "d3": PROFILE_INITIAL["d3"],  # never bumped
        "d4": min(PROFILE_INITIAL["d4"] * mult, PROFILE_CEILING["d4"]),
    }


def fail(msg):
    print(f"[error] {msg}", file=sys.stderr)
    sys.exit(1)


def check_dev_server():
    try:
        with urllib.request.urlopen(DEV_SERVER, timeout=3) as r:
            if r.status != 200:
                fail(f"dev server at {DEV_SERVER} returned {r.status}; start with 'bun run dev'")
    except Exception as e:
        fail(f"dev server at {DEV_SERVER} unreachable ({e}); start with 'bun run dev'")


def wipe_outputs():
    """Clear render output and matrix output, but preserve `.scan-cache/`
    (the Phase 2 evaluation cache survives wipes by design)."""
    dataset_dir = ROOT / "dataset"
    if dataset_dir.exists():
        for entry in dataset_dir.iterdir():
            if entry.name == ".scan-cache":
                continue
            if entry.is_dir():
                shutil.rmtree(entry)
            else:
                entry.unlink()
    else:
        dataset_dir.mkdir(parents=True, exist_ok=True)
    for p in ["new_dataset/uniform-1000", "new_dataset/uniform-1000-logs"]:
        path = ROOT / p
        if path.exists():
            shutil.rmtree(path)
        path.mkdir(parents=True, exist_ok=True)


def run_matrix_pass1():
    """Pass 1: full matrix via generate-matrix.js. Uses presetGenerator's
    tier-default rotationProfileCount (d1=20, d3=6, d4=30)."""
    cmd = [
        "bun", "tools/generate-matrix.js",
        "--count", str(PER_CELL_TOTAL),
        "--shards-per-slot", str(SHARDS_PER_SLOT),
        "--seed", str(BASE_SEED),
        "--build-progressions", str(BUILD),
        "--max-trajectory-candidates", str(MAX_TRAJ),
        "--max-scan-candidates", "30",
        "--out-dir", "new_dataset/uniform-1000",
        "--log-dir", "new_dataset/uniform-1000-logs",
    ]
    print(f"[pass 1] {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, cwd=ROOT, check=True)


def run_one_shard(cell, shard, profile_count, min_sep_px, min_face_q, pass_idx):
    """Invoke generate-presets.js for a single (cell, shard) combination.
    Returns (cell_name, shard_or_None, returncode)."""
    cell_name, model_path, difficulty, sharded, count = cell
    out_dir = ROOT / "new_dataset/uniform-1000"
    log_dir = ROOT / "new_dataset/uniform-1000-logs"
    if sharded:
        start = shard * count + 1
        seed = BASE_SEED + shard * 1009
        out_path = out_dir / f"{cell_name}-s{shard}.json"
        log_path = log_dir / f"{cell_name}-s{shard}-p{pass_idx}.log"
        shard_label = shard
    else:
        start = 1
        seed = BASE_SEED
        out_path = out_dir / f"{cell_name}.json"
        log_path = log_dir / f"{cell_name}-p{pass_idx}.log"
        shard_label = None
    args = [
        "bun", "tools/generate-presets.js",
        "--model", model_path,
        "--difficulty", str(difficulty),
        "--count", str(count),
        "--base-name", cell_name,
        "--start-index", str(start),
        "--seed", str(seed),
        "--build-progressions", str(BUILD),
        "--max-trajectory-candidates", str(MAX_TRAJ),
        "--max-scan-candidates", "30",
        "--rotation-profile-count", str(profile_count),
        "--min-point-separation-px", str(min_sep_px),
        "--min-face-quality", str(min_face_q),
        "--templates", "no-match-pattern-*",
        "--output", str(out_path),
    ]
    with open(log_path, "w") as fh:
        rc = subprocess.run(args, cwd=ROOT, stdout=fh, stderr=subprocess.STDOUT).returncode
    return cell_name, shard_label, rc


def run_continuation(deficit_cells, stage, stage_idx, max_deficit, pass_idx):
    """Continuation pass: re-run deficit cells with stage's knob overrides.
    Same seed → cache hits replay (when cache is valid for the stage);
    same shard filename → output is a superset (or replacement)."""
    profiles = stage_profiles(stage_idx, max_deficit)
    jobs = []
    for cell in deficit_cells:
        _, _, difficulty, sharded, _ = cell
        profile_count = profiles[f"d{difficulty}"]
        if sharded:
            for shard in range(SHARDS_PER_SLOT):
                jobs.append((cell, shard, profile_count))
        else:
            jobs.append((cell, 0, profile_count))

    print(f"[pass {pass_idx}] stage={stage['name']} profiles={profiles} "
          f"min_sep_px={stage['min_sep_px']} min_face_q={stage['min_face_q']}", flush=True)
    print(f"[pass {pass_idx}] launching {len(jobs)} jobs ({WORKERS} workers)", flush=True)
    started = time.time()
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futures = [ex.submit(run_one_shard, c, s, p,
                             stage["min_sep_px"], stage["min_face_q"], pass_idx) for (c, s, p) in jobs]
        for fut in as_completed(futures):
            cell_name, shard, rc = fut.result()
            sk = f"-s{shard}" if shard is not None else ""
            tag = "ok" if rc == 0 else f"FAIL rc={rc}"
            print(f"[pass {pass_idx}] {cell_name}{sk} {tag}", flush=True)
    print(f"[pass {pass_idx}] done in {time.time() - started:.0f}s", flush=True)


def assemble_and_count():
    res = subprocess.run(
        ["python3", "tools/assemble-uniform-1000.py"],
        cwd=ROOT, check=True, capture_output=True, text=True,
    )
    counts = {}
    cell_names = {c[0] for c in CELLS}
    for line in res.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] in cell_names:
            try:
                counts[parts[0]] = int(parts[1])
            except ValueError:
                continue
    return counts


def deficit_cells_from(counts):
    return [c for c in CELLS if counts.get(c[0], 0) < TARGET]


def main():
    check_dev_server()
    wipe_outputs()

    started = time.time()

    # Pass 1: full matrix run with tier-default rotationProfileCount.
    print("\n[pass 1] full matrix run with defaults", flush=True)
    pass_started = time.time()
    run_matrix_pass1()
    print(f"[pass 1] matrix took {time.time() - pass_started:.0f}s", flush=True)

    final_counts = assemble_and_count()
    print(f"[pass 1] yields: {final_counts}", flush=True)

    # Continuation: walk through STAGES, each addressing a different
    # bottleneck. Skip a stage that produces no progress (rather than
    # terminating) — the next stage's different knob may help. Adaptive
    # scaling: profile multiplier scales with worst remaining deficit.
    pass_idx = 1
    no_progress_streak = 0
    NO_PROGRESS_LIMIT = 2  # bail after 2 consecutive zero-progress stages
    for stage_idx, stage in enumerate(STAGES):
        deficits = {c: TARGET - n for c, n in final_counts.items() if n < TARGET}
        if not deficits:
            print(f"[ok] hit target after {pass_idx} pass(es) — total {time.time() - started:.0f}s", flush=True)
            break

        prior_total = sum(final_counts.values())
        max_deficit = max(deficits.values())
        last_yields = dict(final_counts)
        pass_idx += 1
        cells_to_run = deficit_cells_from(final_counts)
        print(f"\n[pass {pass_idx}/{len(STAGES) + 1}] stage={stage['name']} on {len(cells_to_run)} deficit cell(s)", flush=True)
        print(f"[pass {pass_idx}] deficits going in: {deficits} (max={max_deficit})", flush=True)
        pass_started = time.time()
        run_continuation(cells_to_run, stage, stage_idx, max_deficit, pass_idx)
        print(f"[pass {pass_idx}] took {time.time() - pass_started:.0f}s", flush=True)

        final_counts = assemble_and_count()
        new_total = sum(final_counts.values())
        delta = new_total - prior_total
        print(f"[pass {pass_idx}] yields: {final_counts} (Δ={delta:+d})", flush=True)
        if delta <= 0:
            no_progress_streak += 1
            print(f"[pass {pass_idx}] no progress (streak={no_progress_streak}/{NO_PROGRESS_LIMIT})", flush=True)
            if no_progress_streak >= NO_PROGRESS_LIMIT:
                print(f"[warn] {NO_PROGRESS_LIMIT} consecutive zero-progress stages; bailing.", flush=True)
                break
        else:
            no_progress_streak = 0
    else:
        # for/else: ran every stage without break.
        deficits = {c: TARGET - n for c, n in final_counts.items() if n < TARGET}
        if deficits:
            print(f"[warn] all {len(STAGES) + 1} passes exhausted; final deficits: {deficits}", flush=True)

    # Final assemble (idempotent) and render.
    print("\n[final] re-assemble", flush=True)
    subprocess.run(
        ["python3", "tools/assemble-uniform-1000.py"],
        cwd=ROOT, check=True,
    )
    print("\n[render] launching parallel render of assembled.json", flush=True)
    subprocess.run([
        "python3", "tools/render_dataset_parallel.py",
        "--dataset", "new_dataset/uniform-1000/assembled.json",
        "--workers", "12",
        "--server-url", DEV_SERVER,
        "--skip-existing",
    ], cwd=ROOT, check=True)

    total = time.time() - started
    print(f"\n[done] total wall time: {total:.0f}s ({total/60:.1f} min)", flush=True)
    print("Final per-cell counts:", flush=True)
    for cell in CELLS:
        print(f"  {cell[0]:<16} {final_counts.get(cell[0], 0)}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
