#!/usr/bin/env python3
"""
Generate a uniform bank of 1008 presets across 24 model/difficulty cells.
Mapfold cells at the clustered tiers (3 and 5) are skipped, so a run with
the current code fills 23 cells (see docs/uniform-1000.md).

Existing shards resume automatically. Use --fresh to clear generated
outputs while preserving the trajectory scan cache. Continuation passes
fill short cells, assembly removes duplicate examples, and rendering
skips only complete outputs matching the current preset configuration.

Start the server with DATASET_DIR=new_dataset/uniform-1000-render bun run dev,
then run python3 tools/generate-uniform-1000.py. See tools/README.md.
"""
import argparse
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
TARGET = 42  # 24 cells × 42 = 1008 (closest uniform distribution to 1000)
CANONICAL_SEED = 12345  # the canonical first-pass seed (do not change)
# BASE_SEED is overridable via --base-seed for second-seed top-up runs.
# A non-canonical seed shifts every continuation seed, offsets preset
# start-indices by +1000, and tags shard filenames with `-seed<N>` so a
# top-up run produces a FRESH batch of presets that the assembler merges
# alongside the canonical batch (rather than deterministically
# overwriting it). See README "Second-seed top-up".
BASE_SEED = 12345
DEV_SERVER = "http://localhost:3000"
MIN_POINT_VIEW_QUALITY = 0.3
# Render output + scan-cache home. The dev server's DATASET_DIR env must
# match this path or its /api/jsonl-append, /api/metadata-merge, and
# /api/scan-cache endpoints will write to the wrong filesystem location.
# Kept under new_dataset/ alongside the preset bank + logs so the entire
# run lives in one tree.
RENDER_DIR = "new_dataset/uniform-1000-render"

# Worker concurrency for continuation passes (Pass 2+). Leaves 4 threads
# for OS + dev server + renderer; SwiftShader-backed Chrome is ~1 core
# per Puppeteer instance.
CPU_COUNT = os.cpu_count() or 4
WORKERS = max(2, min(28, CPU_COUNT - 4))

# Per-cell metadata. (cell_name, model_path, difficulty, sharded, count).
# 8 models × 3 tiers = 24 cells. Oversample (~1.43×) gives the assembler
# slack to hit TARGET=42 even when cells suffer validation/refinement drops.
#   d1 unsharded: count=60 (vs TARGET=42). Phase 2 earlyStop = max(3, count) = 60.
#   d3/d4 sharded: count=15 per shard (vs ~11). 4×15 = 60 max per cell.
# Known low-yield models (boat thin-back, square fold-collapse,
# mapfold flat-sheet, simplevertex single-vertex) rely on continuation
# passes to reach TARGET.
CELLS = [
    # d1: 8 cells × 42 = 336
    ("simplevertex-d1", "/SimpleFolds/simpleVertex.svg", 1, False, 60),
    ("bird-d1",         "/Bases/birdBase.svg",           1, False, 60),
    ("waterbomb-d1",    "/Bases/waterbombBase.svg",      1, False, 60),
    ("pinwheel-d1",     "/Bases/pinwheelBase.svg",       1, False, 60),
    ("boat-d1",         "/Bases/boatBase.svg",           1, False, 60),
    ("mapfold-d1",      "/SimpleFolds/mapfold.svg",      1, False, 60),
    ("opensink-d1",     "/Bases/openSinkBase.svg",       1, False, 60),
    ("square-d1",       "/Bases/squareBase.svg",         1, False, 60),
    # d3: 8 cells × 42 = 336
    ("simplevertex-d3", "/SimpleFolds/simpleVertex.svg", 3, True,  15),
    ("bird-d3",         "/Bases/birdBase.svg",           3, True,  15),
    ("waterbomb-d3",    "/Bases/waterbombBase.svg",      3, True,  15),
    ("pinwheel-d3",     "/Bases/pinwheelBase.svg",       3, True,  15),
    ("boat-d3",         "/Bases/boatBase.svg",           3, True,  15),
    ("mapfold-d3",      "/SimpleFolds/mapfold.svg",      3, True,  15),
    ("opensink-d3",     "/Bases/openSinkBase.svg",       3, True,  15),
    ("square-d3",       "/Bases/squareBase.svg",         3, True,  15),
    # d4: 8 cells × 42 = 336
    ("simplevertex-d4", "/SimpleFolds/simpleVertex.svg", 4, True,  15),
    ("bird-d4",         "/Bases/birdBase.svg",           4, True,  15),
    ("waterbomb-d4",    "/Bases/waterbombBase.svg",      4, True,  15),
    ("pinwheel-d4",     "/Bases/pinwheelBase.svg",       4, True,  15),
    ("boat-d4",         "/Bases/boatBase.svg",           4, True,  15),
    ("mapfold-d4",      "/SimpleFolds/mapfold.svg",      4, True,  15),
    ("opensink-d4",     "/Bases/openSinkBase.svg",       4, True,  15),
    ("square-d4",       "/Bases/squareBase.svg",         4, True,  15),
]
EXPERT_CELLS = [(name.replace("-d4", "-d5"), model, 5, sharded, count)
                for name, model, difficulty, sharded, count in CELLS if difficulty == 4]
# Folded mapfold carries no rotation, so the clustered tiers, whose decoys are
# rotation twins, refuse it. generate-matrix.js skips the same slots.
CLUSTERED_TIERS = {3, 5}
UNTWINNABLE_MODELS = {"mapfold"}
SHARDS_PER_SLOT = 4
PER_CELL_TOTAL = 60  # oversample target (assembler caps at TARGET=42)
BUILD = 300
MAX_TRAJ = 1200
# Scan-candidate pool ceiling per slot. Wider pool → more raw trajectories
# enter Phase 2 acceptance, lifting yield on geometry-dense cells before
# the continuation stages have to step in. presetGenerator's in-page
# default would be max(count*3, 12) (e.g. 180 for d1 count=60, 45 for
# d3/d4 shard count=15); pinning to 60 keeps Phase 1 sweep cost bounded
# while doubling what the orchestrator previously requested (30).
MAX_SCAN = 60

# Pass 1 is `generate-matrix.js` with these baseline profile counts.
PROFILE_INITIAL = {"d1": 20, "d3": 6, "d4": 30, "d5": 30}
PROFILE_CEILING = {"d1": 200, "d3": 6, "d4": 200, "d5": 200}

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
#
# Adaptive scaling: each stage's profile multiplier scales with the
# WORST deficit going in (deficit > 30 → 4×, deficit > 10 → 2×, else
# 1.5×), capped at PROFILE_CEILING. Smaller deficits don't waste
# wall-time on wide profile sweeps.
#
# d3 profile count is NEVER bumped (sampled random profiles fail
# strictAllSteps validation, regressing yield).
STAGES = [
    # min_face_q=0.6 matches `generate-matrix.js`'s effective default
    # (CLI default for generate-presets.js is 0.6) so Stage A and B
    # share the eval cache file with Pass 1. Stage C changes
    # min_face_q → cache key changes → cold restart for those cells.
    {"name": "profile-bump",
     "min_sep_px": 70, "min_face_q": 0.6},
    {"name": "loosen-separation",
     "min_sep_px": 50, "min_face_q": 0.6},
    {"name": "loosen-face-quality",
     "min_sep_px": 50, "min_face_q": 0.05},
]


def adaptive_profile_mult(max_deficit):
    """Bigger deficit → more aggressive profile bump. Even small
    deficits get a 2× bump because that's what continuation IS — running
    Pass 1's setup with the same profiles would be a no-op."""
    if max_deficit > 30:
        return 4
    return 2


def stage_profiles(stage_idx, max_deficit):
    """Compute per-tier rotationProfileCount for this stage. Profile
    bumps stack across stages: stage 0 = base mult, stage 1+ keeps
    momentum (so loosening stages still get the prior bump)."""
    base_mult = adaptive_profile_mult(max_deficit)
    # Stage A applies the deficit-scaled mult. Stages B/C keep at least
    # 2× to stay above baseline (loosening alone won't help if Phase 2
    # is starved for trajectories).
    if stage_idx >= 1:
        mult = max(2, base_mult)
    else:
        mult = base_mult
    return {
        "d1": min(PROFILE_INITIAL["d1"] * mult, PROFILE_CEILING["d1"]),
        "d3": PROFILE_INITIAL["d3"],  # never bumped
        "d4": min(PROFILE_INITIAL["d4"] * mult, PROFILE_CEILING["d4"]),
        "d5": min(PROFILE_INITIAL["d5"] * mult, PROFILE_CEILING["d5"]),
    }


def fail(msg):
    print(f"[error] {msg}", file=sys.stderr)
    sys.exit(1)


def check_dev_server():
    """Verify the dev server is up AND that its DATASET_DIR matches
    RENDER_DIR. The match check writes a sentinel file via
    /api/jsonl-append and checks the filesystem — there's no
    introspection endpoint."""
    try:
        with urllib.request.urlopen(DEV_SERVER, timeout=3) as r:
            if r.status != 200:
                fail(f"dev server at {DEV_SERVER} returned {r.status}; "
                     f"start with 'DATASET_DIR={RENDER_DIR} bun run dev'")
    except Exception as e:
        fail(f"dev server at {DEV_SERVER} unreachable ({e}); "
             f"start with 'DATASET_DIR={RENDER_DIR} bun run dev'")

    # DATASET_DIR sanity probe: ask the server to truncate-write a
    # sentinel jsonl file under its DATASET_DIR. If we find it at
    # <ROOT>/<RENDER_DIR>/<sentinel>, the env matches. Otherwise the
    # server is writing elsewhere (likely default ./dataset).
    sentinel = ".dataset-dir-check.jsonl"
    target = ROOT / RENDER_DIR / sentinel
    # Pre-clean both the expected target and the default-dataset
    # location so we never get a stale-file false-positive across runs.
    for candidate in (target, ROOT / "dataset" / sentinel):
        try:
            candidate.unlink()
        except FileNotFoundError:
            pass
    body = json.dumps({"path": sentinel, "line": "{}", "fresh": True}).encode("utf-8")
    req = urllib.request.Request(
        f"{DEV_SERVER}/api/jsonl-append",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=5).read()
    except Exception as e:
        fail(f"dev server /api/jsonl-append probe failed ({e})")
    if not target.exists():
        wrong = ROOT / "dataset" / sentinel
        actual = "./dataset" if wrong.exists() else "(unknown)"
        fail(f"dev server DATASET_DIR mismatch — sentinel landed at {actual}, "
             f"expected {RENDER_DIR}. Restart dev server with "
             f"'DATASET_DIR={RENDER_DIR} bun run dev'.")
    target.unlink()


def wipe_outputs():
    """Clear all run output, preserving the Phase 2 scan-cache.

    Layout (all under new_dataset/):
      new_dataset/uniform-1000/         — preset JSON shards + assembled.json
      new_dataset/uniform-1000-logs/    — per-shard logs
      new_dataset/uniform-1000-render/  — PNGs, dataset.jsonl, metadata/,
                                          .scan-cache/ (preserved)
    """
    # Render dir: wipe contents but keep .scan-cache (the Phase 2 cache
    # survives runs by design).
    render_path = ROOT / RENDER_DIR
    if render_path.exists():
        for entry in render_path.iterdir():
            if entry.name == ".scan-cache":
                continue
            if entry.is_dir():
                shutil.rmtree(entry)
            else:
                entry.unlink()
    else:
        render_path.mkdir(parents=True, exist_ok=True)
    (render_path / ".scan-cache").mkdir(parents=True, exist_ok=True)
    # Preset bank + logs: full wipe.
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
        "--difficulties", ",".join(str(d) for d in sorted({c[2] for c in CELLS})),
        "--shards-per-slot", str(SHARDS_PER_SLOT),
        "--seed", str(BASE_SEED),
        "--server-url", DEV_SERVER,
        "--min-point-view-quality", str(MIN_POINT_VIEW_QUALITY),
        "--concurrency", str(WORKERS),
        "--build-progressions", str(BUILD),
        "--max-trajectory-candidates", str(MAX_TRAJ),
        "--max-scan-candidates", str(MAX_SCAN),
        "--out-dir", "new_dataset/uniform-1000",
        "--log-dir", "new_dataset/uniform-1000-logs",
    ]
    print(f"[pass 1] {' '.join(cmd)}", flush=True)
    # Tolerate partial failures: a model that returns no presets (e.g. mapfold-d4
    # under known anchor-dropout pathology) makes generate-matrix.js exit non-zero,
    # but the continuation passes are designed to backfill those exact deficits.
    # Crashing here would abandon the 100+ minutes of Phase 2 work already on disk.
    result = subprocess.run(cmd, cwd=ROOT, check=False)
    if result.returncode != 0:
        print(f"[warn] generate-matrix.js exited {result.returncode}; "
              "proceeding to continuation stages to backfill deficits.", flush=True)


def run_one_shard(cell, shard, profile_count, min_sep_px, min_face_q, pass_idx):
    """Invoke generate-presets.js for a single (cell, shard) combination.
    Returns (cell_name, shard_or_None, returncode).

    Continuation passes (pass_idx >= 2) write to a SUFFIXED filename
    (`<cell>-s<shard>-p<N>.json`) and use an offset start_index so the
    preset names don't collide with Pass 1's (`<cell>-s<shard>.json`,
    names 1..count). The assembler globs all of them and merges by
    name — no-overwrite means each pass strictly adds new presets."""
    cell_name, model_path, difficulty, sharded, count = cell
    out_dir = ROOT / "new_dataset/uniform-1000"
    log_dir = ROOT / "new_dataset/uniform-1000-logs"
    # Pass 1 (matrix) starts at 1; each subsequent pass offsets by
    # PER_CELL_TOTAL to leave room for Pass 1's full range (which can
    # be up to PER_CELL_TOTAL=60 per cell for cells without overrides,
    # or 70 for pinwheel-d4 due to its model.counts override in
    # generate-matrix.js). The 60 floor leaves a small gap above the
    # pinwheel-d4 ceiling, which is fine — pass_offset only needs to
    # exceed the within-shard names emitted by Pass 1.
    pass_offset = PER_CELL_TOTAL * (pass_idx - 1)
    # Second-seed top-up: a non-canonical BASE_SEED shifts preset
    # start-indices into a fresh range (+1000) and tags shard filenames
    # with `-seed<N>` so the assembler's `{cell}-s*.json` glob still
    # picks them up but they never collide with the canonical batch.
    seed_suffix = ""
    if BASE_SEED != CANONICAL_SEED:
        pass_offset += 1000
        seed_suffix = f"-seed{BASE_SEED}"
    if sharded:
        start = pass_offset + shard * count + 1
        seed = BASE_SEED + shard * 1009
        if pass_idx == 1:
            out_path = out_dir / f"{cell_name}-s{shard}{seed_suffix}.json"
            log_path = log_dir / f"{cell_name}-s{shard}{seed_suffix}.log"
        else:
            out_path = out_dir / f"{cell_name}-s{shard}-p{pass_idx}{seed_suffix}.json"
            log_path = log_dir / f"{cell_name}-s{shard}-p{pass_idx}{seed_suffix}.log"
        shard_label = shard
    else:
        start = pass_offset + 1
        seed = BASE_SEED
        if pass_idx == 1:
            out_path = out_dir / f"{cell_name}{seed_suffix}.json"
            log_path = log_dir / f"{cell_name}{seed_suffix}.log"
        else:
            out_path = out_dir / f"{cell_name}-p{pass_idx}{seed_suffix}.json"
            log_path = log_dir / f"{cell_name}-p{pass_idx}{seed_suffix}.log"
        shard_label = None
    args = [
        "bun", "tools/generate-presets.js",
        "--model", model_path,
        "--server-url", DEV_SERVER,
        "--min-point-view-quality", str(MIN_POINT_VIEW_QUALITY),
        "--difficulty", str(difficulty),
        "--count", str(count),
        "--base-name", cell_name,
        "--start-index", str(start),
        "--seed", str(seed),
        "--build-progressions", str(BUILD),
        "--max-trajectory-candidates", str(MAX_TRAJ),
        "--max-scan-candidates", str(MAX_SCAN),
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
        ["python3", "tools/assemble-uniform-1000.py"] + (["--include-expert"] if any(c[2] == 5 for c in CELLS) else []),
        cwd=ROOT, check=True, capture_output=True, text=True,
    )
    counts = {}
    cell_names = {c[0] for c in CELLS}
    for line in res.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 3 and parts[0] in cell_names:
            try:
                counts[parts[0]] = int(parts[2])
            except ValueError:
                continue
    return counts


def drop_untwinnable_cells(cells):
    skipped = [c[0] for c in cells if c[2] in CLUSTERED_TIERS and c[0].split("-")[0] in UNTWINNABLE_MODELS]
    if skipped:
        print(f"[cells] skipping {', '.join(skipped)}: mapfold carries no rotation symmetry, "
              "so the clustered tiers cannot twin it", flush=True)
    return [c for c in cells if c[0] not in skipped]


def deficit_cells_from(counts):
    return [c for c in CELLS if counts.get(c[0], 0) < TARGET]


def main():
    global BASE_SEED, WORKERS, DEV_SERVER, MIN_POINT_VIEW_QUALITY, CELLS
    parser = argparse.ArgumentParser(description="Uniform-1000 dataset orchestrator.")
    run_mode = parser.add_mutually_exclusive_group()
    run_mode.add_argument(
        "--resume", action="store_true",
        help="Skip wipe_outputs() and run_matrix_pass1(); start from the "
             "current contents of new_dataset/uniform-1000/ and go straight "
             "to continuation passes + assemble + render. Use when Pass 1 "
             "completed (or partially completed) and you want to backfill "
             "deficits without redoing the matrix run.",
    )
    parser.add_argument(
        "--base-seed", type=int, default=CANONICAL_SEED,
        help=f"Generation seed (default {CANONICAL_SEED}, the canonical "
             "first run). Pass a different value (e.g. 12346) together "
             "with --resume to do a SECOND-SEED TOP-UP: continuation "
             "passes run with fresh trajectories, write to `-seed<N>`-"
             "tagged shard files, and use preset start-indices offset by "
             "+1000 so the new presets MERGE with — never overwrite — the "
             "canonical-seed batch. Repeatable with further distinct seeds.",
    )
    run_mode.add_argument("--fresh", action="store_true",
                         help="Delete preset and render outputs before generating; preserve the scan cache.")
    parser.add_argument("--skip-render", action="store_true", help="Generate and assemble without rendering PNGs.")
    parser.add_argument("--workers", type=int, default=WORKERS, help="Generation worker limit.")
    parser.add_argument("--render-workers", type=int, default=12, help="Render worker limit.")
    parser.add_argument("--server-url", default=DEV_SERVER)
    parser.add_argument("--min-point-view-quality", type=float, default=0.3,
                        help="Minimum projected marker viewing ratio for new presets, between 0 and 1.")
    parser.add_argument("--include-expert", action="store_true",
                        help="Include tier 5: 30 cells and 1260 examples at 42 per cell (mapfold is skipped at tiers 3 and 5).")
    args = parser.parse_args()
    CELLS = drop_untwinnable_cells([cell for cell in CELLS if cell[2] != 5] + (EXPERT_CELLS if args.include_expert else []))
    if args.workers < 1 or args.render_workers < 1:
        parser.error("worker counts must be positive")
    if not 0 <= args.min_point_view_quality <= 1:
        parser.error("--min-point-view-quality must be between 0 and 1")
    MIN_POINT_VIEW_QUALITY = args.min_point_view_quality
    WORKERS = args.workers
    DEV_SERVER = args.server_url.rstrip("/")

    BASE_SEED = args.base_seed
    if BASE_SEED != CANONICAL_SEED:
        print(f"[seed] second-seed top-up: BASE_SEED={BASE_SEED} "
              f"(canonical={CANONICAL_SEED}); shard files tagged -seed{BASE_SEED}",
              flush=True)

    check_dev_server()

    started = time.time()

    bank_dir = ROOT / "new_dataset/uniform-1000"
    existing_shards = [p for p in bank_dir.glob("*.json") if p.name != "assembled.json"]
    args.resume = args.resume or (bool(existing_shards) and not args.fresh)
    for folder in (bank_dir, ROOT / "new_dataset/uniform-1000-logs"):
        folder.mkdir(parents=True, exist_ok=True)
    if args.fresh:
        wipe_outputs()
    if args.resume:
        existing = sorted((ROOT / "new_dataset/uniform-1000").glob("*.json"))
        print(f"[resume] skipping wipe + Pass 1; found {len(existing)} existing "
              f"shard JSONs in new_dataset/uniform-1000/", flush=True)
    else:
        # Pass 1: full matrix run with tier-default rotationProfileCount.
        print("\n[pass 1] full matrix run with defaults", flush=True)
        pass_started = time.time()
        run_matrix_pass1()
        print(f"[pass 1] matrix took {time.time() - pass_started:.0f}s", flush=True)

    final_counts = assemble_and_count()
    print(f"[{'resume' if args.resume else 'pass 1'}] yields: {final_counts}", flush=True)

    # Continuation: walk through STAGES, each addressing a different
    # bottleneck. Skip a stage that produces no progress (rather than
    # terminating) — the next stage's different knob may help. Adaptive
    # scaling: profile multiplier scales with worst remaining deficit.
    pass_idx = 1
    no_progress_streak = 0
    NO_PROGRESS_LIMIT = 2  # bail after 2 consecutive zero-progress stages
    for stage_idx, stage in enumerate(STAGES):
        deficits = {c[0]: TARGET - final_counts.get(c[0], 0)
                    for c in deficit_cells_from(final_counts)}
        if not deficits:
            print(f"[ok] hit target after {pass_idx} pass(es) — total {time.time() - started:.0f}s", flush=True)
            break

        prior_total = sum(final_counts.values())
        max_deficit = max(deficits.values())
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
        deficits = {c[0]: TARGET - final_counts.get(c[0], 0)
                    for c in deficit_cells_from(final_counts)}
        if deficits:
            print(f"[warn] all {len(STAGES) + 1} passes exhausted; final deficits: {deficits}", flush=True)

    # Final assemble (idempotent) and render.
    print("\n[final] re-assemble", flush=True)
    subprocess.run(
        ["python3", "tools/assemble-uniform-1000.py"] + (["--include-expert"] if any(c[2] == 5 for c in CELLS) else []),
        cwd=ROOT, check=True,
    )
    if not args.skip_render:
        print(f"\n[render] launching parallel render of assembled.json into {RENDER_DIR}/", flush=True)
        render_env = dict(os.environ)
        render_env["DATASET_DIR"] = RENDER_DIR
        subprocess.run([
            "python3", "tools/render_dataset_parallel.py",
            "--dataset", "new_dataset/uniform-1000/assembled.json",
            "--workers", str(args.render_workers),
            "--server-url", DEV_SERVER,
            "--skip-existing",
        ], cwd=ROOT, env=render_env, check=True)

    total = time.time() - started
    print(f"\n[done] total wall time: {total:.0f}s ({total/60:.1f} min)", flush=True)
    print("Final per-cell counts:", flush=True)
    for cell in CELLS:
        print(f"  {cell[0]:<16} {final_counts.get(cell[0], 0)}", flush=True)
    if deficit_cells_from(final_counts):
        print("[incomplete] Some cells remain below target. Outputs are preserved; resume with a new --base-seed.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
