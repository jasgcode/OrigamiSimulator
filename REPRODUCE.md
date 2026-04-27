# Reproducing the uniform-1000 Dataset

End-to-end runbook for regenerating the 1008-preset Origami Simulator dataset
(12 cells x 84 presets each) plus rendered PNGs from a fresh clone.

## Quick start

```bash
# Terminal 1 — dev server (must stay running)
bun run dev

# Terminal 2 — one-command pipeline
python3 tools/generate-uniform-1000.py
```

Output lands in `dataset/` (PNGs + `dataset.jsonl`) and
`new_dataset/uniform-1000/assembled.json` (preset configs).

## Prerequisites

- Linux or macOS host with ~32 GB RAM. The pipeline launches up to 28
  parallel Puppeteer-Chromium workers (~600-800 MB each under SwiftShader).
- [`bun`](https://bun.sh) on `$PATH`.
- `python3` (stdlib only — no `pip install` step).
- Dev server reachable at `http://localhost:3000`. The orchestrator probes
  it on startup and aborts with an explicit error if it is not up.

No `npm install`. All JS deps are vendored in `dependencies/` (see
[CLAUDE.md](CLAUDE.md)).

## What you get

```
dataset/
  dataset.jsonl                       # 1008 lines, one per preset
  <preset_id>/
    step_0000_current.png             # PNGs, 4-digit zero-padded, 0-based
    step_0001_current.png
    ...
  metadata/
    <object>_metadata.json            # consolidated per-object (e.g. birdBase)
    <object>_summary.json
  .scan-cache/                        # Phase 2 trajectory cache (preserved across runs)

new_dataset/uniform-1000/
  assembled.json                      # 1008-preset manifest (input to the renderer)
  <cell>-s<shard>{,-p<N>}.json        # raw per-shard preset files

new_dataset/uniform-1000-logs/
  <cell>-s<shard>{,-p<N>}.log         # one log per shard invocation
```

The 12 cells are 4 models x 3 difficulty tiers:

| Model      | d1 (easy) | d3 (medium) | d4 (hard) |
|------------|-----------|-------------|-----------|
| bird       | 84        | 84          | 84        |
| waterbomb  | 84        | 84          | 84        |
| pinwheel   | 84        | 84          | 84        |
| opensink   | 84        | 84          | 84        |

Difficulty mapping is enforced in JSONL `meta_info.difficulty`: d1 -> `easy`,
d3 -> `medium`, d4 -> `hard`.

## How it works

The orchestrator (`tools/generate-uniform-1000.py`) runs three stages with a
single deterministic seed (`BASE_SEED = 12345`):

1. **Pass 1 — full matrix.** Invokes `bun tools/generate-matrix.js` with
   `--count 120 --shards-per-slot 4 --seed 12345`. Per-shard seed is
   `BASE_SEED + shard*1009`. Each (model, tier) cell oversamples to up to
   120 presets so the assembler has slack to cap at 84.

2. **Continuation passes (Pass 2+).** For any cell still short of 84, the
   orchestrator walks four adaptive stages, each loosening a different knob:
   - `profile-bump` — raises `rotationProfileCount` (more Phase 2 (traj,
     profile) pairs).
   - `loosen-separation` — drops `minPointSeparationPx` 70 -> 50.
   - `loosen-face-quality` — drops `minFaceQuality` 0.05 -> 0.02 (cold cache
     for affected cells; see below).
   - `max-fallback` — last-resort combination.

   Continuation files are SUPERSETS: same shard filename, no overwrites,
   indices offset by `PER_CELL_TOTAL` so names never collide. Bails after
   two consecutive zero-progress stages.

3. **Assemble + render.** `tools/assemble-uniform-1000.py` globs all cell
   files, merges by preset name, sorts alphabetically, caps at 84 per cell,
   and writes `assembled.json`. Then `tools/render_dataset_parallel.py`
   shards across 12 workers, each driving headless Chromium against the dev
   server to write PNGs and append JSONL lines.

## Wall time

| Run type                   | Wall time     |
|----------------------------|---------------|
| Cold (no `.scan-cache/`)   | ~3-4 hours    |
| Cache-warm (subsequent)    | ~75-95 min    |

The Phase 2 evaluation cache at `dataset/.scan-cache/eval_*.json` survives
the orchestrator's wipe step (it is the only entry under `dataset/` that is
preserved). Cache key v4 is keyed on `(model, difficulty, seed,
povGridSize, minFaceQuality)` — Stage A and B share the Pass 1 cache file;
Stage C (`min_face_q=0.05`) and Stage D invalidate the cache for the cells
they touch and pay a cold-restart cost on those cells only.

If you change `DATASET_DIR`, manually copy `dataset/.scan-cache/*.json` to
`<new>/.scan-cache/` to avoid a full cold start.

## Troubleshooting

**`[error] dev server at http://localhost:3000 unreachable`** — start
`bun run dev` in another terminal and retry. The orchestrator probes the
server before doing anything destructive.

**Partial output from a previous run.** Re-running the orchestrator wipes
`dataset/` (preserving `.scan-cache/`) and `new_dataset/uniform-1000{,-logs}/`
before Pass 1, so a re-run is safe and deterministic. PNGs are recomputed
from scratch; preset generation reuses the trajectory cache.

**`[warn] all N passes exhausted; final deficits: {...}`** — one or more
cells could not reach 84 even at the most permissive stage. The assembler
still produces `assembled.json` with whatever it has. Inspect
`new_dataset/uniform-1000-logs/<cell>-s<shard>-p<N>.log` for the offending
cell to diagnose. Typical cause: model-specific thin back pools (see
[CLAUDE.md](CLAUDE.md) "Key trade-offs").

**Renderer skips presets you wanted re-rendered.** The renderer is
launched with `--skip-existing`, which checks for `step_0000_current.png`.
Delete the per-preset directory under `dataset/` to force a re-render.

**OOM or thrashing.** Lower the worker count: edit `WORKERS` in
`tools/generate-uniform-1000.py` (Pass 2+ continuations) and the
`--workers 12` flag near the bottom (renderer). Each worker is one
Puppeteer Chromium process.

**Determinism check.** Same seed (`BASE_SEED = 12345`) + same source state
+ warm cache = byte-identical `assembled.json`. PNGs are GPU-rendered via
SwiftShader and are deterministic per-machine but may differ across
GPU/driver combinations.

## Reference

- Pipeline source: `tools/generate-uniform-1000.py`
- Assembler: `tools/assemble-uniform-1000.py`
- Matrix runner: `tools/generate-matrix.js`
- Per-shard generator: `tools/generate-presets.js`
- Parallel renderer: `tools/render_dataset_parallel.py`
- Project background, benchmark schema, JSONL format: [CLAUDE.md](CLAUDE.md)
