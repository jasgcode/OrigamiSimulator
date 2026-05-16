# Origami Point-Tracking Dataset

A perception benchmark for vision-language models built on top of a real-time
GPU origami simulator. Each item asks the model to identify which **labeled
points on a folded piece of paper** correspond to **unmarked dots on the
original flat sheet**, given a step-by-step folding sequence rendered from a
deterministic camera trajectory.

This repository contains the **dataset generator** (a headless Puppeteer
pipeline driving an in-browser physics simulator) and the **benchmark
runtime** (preset loader, JSONL emitter, point-visibility validator). The
canonical 1008-preset release sits under [`dataset/`](dataset/).

## Quick start

```bash
# One-liner — launches dev server in background then runs the full pipeline.
DATASET_DIR=new_dataset/uniform-1000-render bun run dev &
python3 tools/generate-uniform-1000.py
```

The dev server must run with `DATASET_DIR=new_dataset/uniform-1000-render`
so its `/api/jsonl-append`, `/api/metadata-merge`, and `/api/scan-cache`
endpoints write to the same tree the orchestrator wipes and the renderer
populates. The orchestrator probes this at startup and fails loudly if
the env doesn't match.

Outputs:

| Path | Contents |
|---|---|
| `new_dataset/uniform-1000/` | Per-shard preset JSONs + `assembled.json` |
| `new_dataset/uniform-1000-logs/` | Per-shard generator logs |
| `new_dataset/uniform-1000-render/` | PNGs (`<id>/step_*.png`), `dataset.jsonl`, `metadata/`, `.scan-cache/` |

### Prerequisites

- Linux or macOS host with ~32 GB RAM. The pipeline launches up to 28
  parallel Puppeteer-Chromium workers (~600–800 MB each under SwiftShader).
- [`bun`](https://bun.sh) on `$PATH`.
- `python3` (stdlib only — no `pip install` step).
- Dev server reachable at `http://localhost:3000`.

No `npm install` — all JS dependencies are vendored under `dependencies/`.

## Repository layout

| Path | Contents |
|---|---|
| [`tools/`](tools/) | Generator and renderer scripts. See [`tools/README.md`](tools/README.md) for the pipeline diagram and per-script reference. |
| [`dataset/`](dataset/) | Final rendered output (1008 presets × N PNGs + `dataset.jsonl`). See [`dataset/README.md`](dataset/README.md) for the JSONL schema. |
| [`new_dataset/`](new_dataset/) | Intermediate per-shard preset JSONs and run logs. See [`new_dataset/README.md`](new_dataset/README.md). |
| `js/` | In-page benchmark runtime, preset generator, and the upstream simulator. Module pattern; no bundler. |
| `assets/` | SVG/FOLD crease patterns and the Phase 1 facepool cache. |
| `tools/generate-uniform-1000.py` | Top-level pipeline orchestrator (Pass 1 + continuation passes + assembler + renderer). |
| `CLAUDE.md` | Architecture notes, file conventions, benchmark schema. Helpful for navigating the JS codebase. |

## Composition

24 cells × 42 presets = **1008 presets**:

| Model           | d1 (easy) | d3 (medium) | d4 (hard) |
|-----------------|-----------|-------------|-----------|
| `simplevertex`  | 42        | 42          | 42        |
| `bird`          | 42        | 42          | 42        |
| `waterbomb`     | 42        | 42          | 42        |
| `pinwheel`      | 42        | 42          | 42        |
| `boat`          | 42        | 42          | 42        |
| `mapfold`       | 42        | 42          | 42        |
| `opensink`      | 42        | 42          | 42        |
| `square`        | 42        | 42          | 42        |

Three difficulty tiers (d1/d3/d4) differ in **point set composition** and
**camera motion**: d1 has a static tilted pose with all-visible front
points, d3 adds ramping rotation, d4 introduces hidden front and hidden
back points that reveal only at the final step. Full tier semantics in
`CLAUDE.md`.

## How a preset is produced

The pipeline is **trajectory-first**: instead of fixing a face-point set
and searching for a camera trajectory that keeps it visible, the generator
discovers visibility-preserving fold/rotation trajectories first, then
selects barycentric points on faces that the trajectory's visibility
timeline supports. This avoids the death-spiral of trying to "rescue" a
pre-chosen point that the geometry doesn't expose.

Per (model, difficulty) slot:

1. **Face-pool discovery** — cached at `assets/facepools/<model>.json`.
2. **Phase 2 trajectory search** — evaluate candidate (POV, rotation)
   trajectories live in the simulator; accept those whose per-step
   visibility timeline supports the tier's point-set plan.
3. **Per-tier point selection** — emit up to `K` distinct face-point
   configs per accepted trajectory.
4. **Barycentric refinement** — sweep a 5×5 grid per face for each
   accepted preset; pick the placement with maximum edge-/neighbor-pixel
   margin and forward clearance.
5. **Step normalization + hero-shot** — freeze POV across steps; render
   step 0 from an iso POV with no rotation as the "before" reference frame.
6. **Validation** — replay the preset; reject if any tracked point fails
   visibility under the tier's evaluation semantics.

Full pipeline details in `CLAUDE.md` § "Preset Generation Pipeline".

## Determinism

Same seed (`CANONICAL_SEED = 12345`) + warm `new_dataset/uniform-1000-render/.scan-cache/`
+ same source tree produces byte-identical `assembled.json`. PNGs are
GPU-rendered via SwiftShader and are deterministic per-machine but may
differ across GPU/driver combinations.

## Second-seed top-up

The canonical run uses seed `12345`. Some geometrically hard cells
(`mapfold-d3`, `mapfold-d4`, `pinwheel-d4`) don't reach the 42-preset
target from a single seed — the continuation passes are deterministic,
so re-running `--resume` with the same seed reproduces identical output
and adds nothing.

To add more presets to deficit cells, run a **second-seed top-up**:

```bash
# After the canonical run, with the dev server still up:
python3 tools/generate-uniform-1000.py --resume --base-seed 12346
```

`--base-seed <N>` (any value ≠ 12345) makes the continuation passes:

- seed every shard from `N` instead of `12345` → fresh trajectories;
- offset preset start-indices by `+1000` → new preset names never
  collide with the canonical batch;
- tag shard files `-seed<N>` (e.g. `mapfold-d3-s0-p2-seed12346.json`) →
  the assembler's `{cell}-s*.json` glob still picks them up, merging the
  top-up batch alongside the canonical one.

The assembler sorts preset names and caps each cell at 42, so canonical
presets (names `…-001`…`…-NNN`) fill first and the top-up batch
(names `…-1xxx`) backfills any remaining slots. Top-ups are repeatable
with further distinct seeds (`12347`, `12348`, …); each is fully
documented by its `--base-seed` value, so any run is replicable.

## License

Released under the same license as the upstream simulator (see below).

---

## Acknowledgements

The interactive origami physics simulator at the heart of this project is
**Origami Simulator** by **Amanda Ghassaei, Erik Demaine, and Neil
Gershenfeld**:

- Upstream repository: <https://github.com/amandaghassaei/OrigamiSimulator>
- Live demo: <https://origamisimulator.org>
- Paper: [Fast, Interactive Origami Simulation using GPU Computation](http://erikdemaine.org/papers/OrigamiSimulator_Origami7/) (7OSME)

The simulator extends prior work on origami folding mechanics by Mark
Schenk & Simon D. Guest ([5OSME](http://www3.eng.cam.ac.uk/~sdg/preprint/5OSME.pdf))
and Tomohiro Tachi ([Freeform Variations of Origami](http://www.tsg.ne.jp/TT/cg/TachiFreeformOrigami2010.pdf)),
and uses ruling-aware curved-fold preprocessing from
[Sasaki & Mitani](http://www.cgg.cs.tsukuba.ac.jp/projects/2020/RulingAwareTriangulation/index.html).

Code in `js/dynamic/`, `js/curvedFolding.js`, `js/pattern.js`, `js/importer.js`,
and the SVG/FOLD demo patterns under `assets/` are derived from or unchanged
from the upstream project. The dataset-generation pipeline (`tools/`,
`js/presetGenerator.js`, `js/benchmark.js`, `js/facePoints.js`,
`js/pointAnnotations.js`) and the perception-benchmark framing are
contributed on top.
