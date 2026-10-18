# Origami Point Tracking

Origami Simulator (GPU origami physics, upstream by Ghassaei et al.) extended into a generator for a VLM point-tracking benchmark. The release is 150 medium (tier 3) + 150 expert (tier 5) items. Its exact presets are in `release/dataset-300b/presets.json`.

## Commands

```bash
bun run dev              # server.js on :3000; env DATASET_DIR (default dataset/), PORT
bun run test:dataset     # 73 JS + 104 Python tests; no server or WebGL needed
bun install && bunx puppeteer browsers install chrome   # once, before any tools/*.js run
```

Run tools from the repository root.

## Docs: read the one that covers your change, and update it in the same change

- **Tier rules, dot layout, twins, spin, balancing, legibility gates**: [docs/design.md](docs/design.md). Every rule there names the shortcut it closes; a rule change needs its reason updated too.
- **Generation stages, preset fields, rendering, server endpoints, visibility tests**: [docs/pipeline.md](docs/pipeline.md)
- **JSONL schema, question template, scoring, probes**: [docs/dataset.md](docs/dataset.md)
- **Script options**: [tools/README.md](tools/README.md)
- **The release build** (generation runs, selection, render, scores): [docs/reproduce.md](docs/reproduce.md), [release/dataset-300b/](release/dataset-300b/)

## Code conventions

- **No build step, no modules.** Each `js/*.js` file defines `initX(globals)` and returns a module object. `js/main.js` wires them into the shared `globals` object (`js/globals.js`). Files talk through `globals` or global functions; there is no `import`/`export`.
- **Vendored libraries.** Three.js, jQuery and numeric.js are vendored in `dependencies/`. Use them from there; `bun install` exists only for Puppeteer.
- **Shaders.** GLSL lives inline in `index.html` as `<script type="x-shader/x-fragment">` blocks.
- **Style.** UI is jQuery, jQuery UI, Bootstrap and Flat UI. Use camelCase, with an `init` prefix for module constructors.
- **Upstream code.** Simulator files (`js/dynamic/`, `pattern.js`, `importer.js`, `curvedFolding.js`, solvers) come from upstream. Benchmark work lives in `js/benchmark.js`, `js/presetGenerator.js`, `js/facePoints.js`, `js/pointAnnotations.js` and `tools/`.

## Invariants

These hold the dataset's validity. Keep them when editing.

- **Point order is the answer key.** A dot's letter is its index in `facePoints`, and clustered presets shuffle that array with the job seed. Sorting it, or regrouping it by face, leaks answers.
- **Legibility floors are fixed.** Generation yields fewer presets rather than easier ones, and never falls back to an easier tier or motion. The floors:
  - the radius-scaled spacing floor (`clusterMinSeparationPx`);
  - the per-tier group spread and radius caps (`TIER_LAYOUTS`);
  - the 0.30 viewing ratio;
  - footprint clearance (`markerClearanceRadius`);
  - tracked-dot visibility at every step.
- **`trackingEvalMode` governs hidden dots only.** Non-hidden dots must be visible at every step in every mode. `hidePointsDuringAnimation` is a rendering switch with no effect on validation.
- **Mapfold carries no rotation symmetry**, so it cannot be twinned and is refused by the clustered tiers.
- **`gt_answer` is a JSON-encoded string** (`'["A","C"]'`), not a list.
- **Refinement score terms are clamped with `min(x, cap)`.** A saturating `clamp01` makes candidates tie and collapses dots onto the first grid cell.
- **The first refinement pass checks spacing only against placed dots (`isPlaced`).** Checking against unplaced dots deadlocks four-dot groups on narrow bird panels.
- **Settle times:**

  | Stage | Settle |
  |---|---|
  | Trajectory search | 300 ms |
  | Refinement and in-page validation | ≥ 400 ms |
  | Clustered tiers, and independent replays (`--settle-ms 800`) | 800 ms |

  Shorter settles leave markers clipped or under the spacing floor on some final poses.
- **Static-POV search.** `generateCandidateTrajectories` keeps the camera fixed, so the progression filter sees zero `endAngle`/`totalAngle`. A custom `scanMode` preset using `buildProgressions` needs `minProgressionEndAngle: 0` and `minProgressionTotalAngle: 0`.

## Operational notes

- **Matching directories.** A tool that writes outputs needs the server's `DATASET_DIR` to equal its output or render directory; the Python orchestrators check this.
- **Moving `DATASET_DIR`.** Copy `.scan-cache/` from the old directory to the new one to avoid a cold trajectory cache.
- **Lenient flags.** The JS drivers parse options with `strict: false`, so a misspelled flag is silently ignored.
- **Worker load.** Each Chromium worker uses about one core and 700 MB under SwiftShader. Keep the total across concurrent runs at or below the core count minus four.
- **Concurrent renders.** Give each concurrent `render_dataset_parallel.py` run a distinct `--run-id`.
- **Resuming predictions.** `tools/eval-claude.py` resumes from its `--out` file. Delete that file before re-asking a re-rendered dataset.
