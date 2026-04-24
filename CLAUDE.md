# Origami Simulator

Real-time GPU-accelerated origami folding simulator. Live at https://origamisimulator.org/

## Running Locally

```bash
bun run dev          # serves static files via bunx serve on localhost:3000
```

Or open `index.html` directly (some fetch-based features require HTTP).

## Tooling

Default to Bun over Node.js. `bun run`, `bun install`, `bun test`, `Bun.serve()`.

## Architecture

**Static frontend, no build step.** All code runs client-side.

- **No module system** — global functions + shared `globals` object. No `import`/`export`.
- **No bundler** — scripts loaded via `<script>` tags in `index.html`.
- **Dependencies vendored** in `dependencies/` (Three.js, jQuery, numeric.js). NOT installed via npm.
- `package.json` exists only for the `bun run dev` convenience script.

## Key Patterns

### Module pattern

Every JS file exposes `initX(globals)` returning a module object. Wired in `js/main.js`:

```js
globals.threeView = initThreeView(globals);
globals.model = initModel(globals);
```

### Globals object

`globals` (in `js/globals.js`) is the central shared state — simulation params, flags, module refs. UI controls read/write it directly.

### GPU compute via WebGL shaders

Physics runs on the GPU via fragment shaders. GLSL source is embedded as `<script type="x-shader/x-fragment">` blocks in `index.html`. GPU abstraction in `js/dynamic/GPUMath.js`.

### UI

jQuery + jQuery UI + Bootstrap + Flat UI. `$()` selectors throughout. No component framework.

### Point visibility tests (`js/facePoints.js`)

Two tests, both using raw ray-triangle intersection (no `material.side` culling — folded panels caught from either side):

- **`isPointVisible(index)`** — correctness contract for rendering/validation. Checks: face-normal (`dot(toCamera, normal) > 0` front / `< 0` back) → frustum (NDC in `[-1,1]`) → occlusion (ray to camera, origin nudged by `OCCL_EPSILON = 0.002`).
- **`hasForwardClearance(index, dist)`** — stricter ranking signal for the barycentric refiner. Imagines a short arrow along +normal and checks both along-path clearance and tip→camera visibility. Catches panels hovering *above* a point offset toward the camera.

### Point annotations

`labelStyle: "arrow"` uses a screen-space overlay (`#pointAnnotationCanvas`). Anchors projected from 3D positions; visibility via `isPointVisible`; PNG captures include the overlay.

## File Structure

```
index.html                — Entry point. HTML + inline GLSL + all <script> tags
js/
  main.js                 — Init sequence, URL param parsing
  globals.js              — Shared state
  model.js                — Geometry, materials, colors, labels
  facePoints.js           — Barycentric points + visibility tests
  pointAnnotations.js     — Screen-space arrow label overlay
  threeView.js            — Three.js scene, camera, renderer
  controls.js             — UI event handlers
  benchmark.js            — Benchmark runner (presets, runAll)
  presetGenerator.js      — Trajectory-first preset generation
  dynamic/
    dynamicSolver.js      — GPU simulation solver
    GPUMath.js            — WebGL compute abstraction
benchmarks.json           — Benchmark preset definitions
dependencies/             — Vendored third-party libs (do NOT npm install)
assets/                   — Demo patterns (SVG/FOLD) + facepool cache
tools/
  generate-presets.js     — Puppeteer driver for presetGenerator
  generate-matrix.js      — Multi-(model, difficulty) parallel runner
  render_dataset_parallel.py — Multi-worker PNG renderer
```

## Benchmark System (`benchmarks.json`)

Runs configurable sequences: load a model, apply view/color settings, step through fold % or animate. Select via `?benchmark=<name>` or batch with `?runAll=true`. Any JSON parameter is URL-overridable.

Core parameters: `model`, `colorMode`, `color1`/`color2`, `fold`, `facePoints`, `labelStyle`, `steps`, `foldAnimation`, `previewRotation`, `difficulty`, `trackingEvalMode`, `scanMode`. Full parameter list in `js/benchmark.js`.

### Face points

Points on mesh faces with deterministic barycentric positions. Three forms:

```json
// Counts
"facePoints": { "0": 3, "5": 2 }

// Explicit barycentric per face
"facePoints": { "0": [[0.33, 0.33, 0.34]] }

// Explicit array
"facePoints": [{ "faceId": 0, "u": 0.33, "v": 0.33, "w": 0.34 }]
```

Any point can have `"hidden": true` — numbered in the 1..N sequence but not rendered until the last step / fold animation completes.

### Steps

```json
"steps": [{ "fold": 0, "pov": "iso" }, { "fold": 100, "pov": "z", "rotation": [0, 0.5, 0] }]
```

- `pov`: `iso`, `x`/`-x`, `y`/`-y`, `z`/`-z`, or `[x,y,z]` / `"x,y,z"` for continuous directions.
- `rotation`: Euler XYZ radians. Applied after POV, independent of camera.

### Difficulty tiers

Metadata for dataset labeling. Presets use **static camera + per-step model `rotation`** — the camera never animates across fold steps; rotation on `modelWrapper` drives which faces come into view.

| Tier | Visible front | Hidden front | Hidden back | Motion |
|------|---|---|---|--------|
| d1   | 2 | 1–3 | 0   | Constant per-preset rotation (no inter-step motion; tilted fixed pose) |
| d2   | 2 | 0   | 1–2 | Constant rotation frozen to d4's final-step pose |
| d3   | 2 | 1–3 | 0   | Ramping rotation, crest near final step |
| d4   | 2 | 1–2 | 1–2 | Monotonically ramping rotation, peak at final step |

Rotation bounds per tier (radians): d1/d3 `{yaw 0.5, pitch 0.15, roll 0.08}`; d2/d4 `{yaw 1.0, pitch 1.0, roll 0.25}`.

State 1 always renders at zero rotation (hero shot — fold=0, flat paper) from the trajectory's static POV; states 2..N apply the chosen rotation.

### Validation semantics

`trackingEvalMode` is a **hidden-point semantic only**:
- Hidden points: required visible only at final step under `finalStepOnly`; every step under `strictAllSteps` (default).
- Non-hidden points: required visible at **every step**, regardless of mode.

`hidePointsDuringAnimation` is a rendering toggle — no effect on validation.

### Dataset output

`runAll` writes `screenshots/dataset.jsonl` and PNGs to `screenshots/images/<id>/step_NNNN_current.png`. JSONL paths are **relative to dataset root `screenshots/images/`** (no `images/` prefix). One line per preset:

```json
{
  "id": "origami_point_tracking_difficulty_<d>_<modelStem>_<NN>",
  "category": ["Order", "origami_static", "point_tracking"],
  "type": "point_tracking",
  "question": "Which lettered point(s) in the final folded image correspond to the unmarked dot(s) shown on the flat paper in the first image? List the matching letter(s).",
  "images": ["<id>/step_0000_current.png", "...", "<id>/step_<lastIdx>_current.png"],
  "gt_answer": ["A", "C"],
  "meta_info": {
    "task_name": "origami_static", "config": "../../metadata.json",
    "difficulty": "easy|medium|hard", "seed": <n>, "repeat_index": 0,
    "level": "<stem>_difficulty_<d>", "benchmark": "<name>", "object": "birdBase",
    "total_steps": <N>, "color_mode": "...", "all_labels": [...], "initial_points": [...],
    "hidden_point_labels": {...}, "front_points": [...], "back_points": [...]
  }
}
```

Difficulty mapping: d1→`easy`, d2/d3→`medium`, d4→`hard`. `gt_answer` is the initial (non-hidden) point labels — letters that correspond to the unmarked dots rendered at step 0. Step 0 renders points as **unmarked dots**; the final step renders them with letters (`revealHiddenPoints` flag in `js/model.js:356-370`). Server endpoint: `POST /api/jsonl-append` with `{ path, line, fresh }`. See `buildJsonlEntry` in `js/benchmark.js`.

## Preset Generation Pipeline

`js/presetGenerator.js` + `tools/generate-presets.js` — headless Chrome via Puppeteer drives the in-page generator and writes validated benchmark JSON. Requires `bun run dev` running.

```bash
bun tools/generate-presets.js --model /Bases/boatBase.svg --difficulty 4 \
  --count 10 --base-name boat-d4 --output new_dataset/boat-d4.json \
  --trajectory-mode hybrid --build-progressions 24
```

### Pipeline stages (per model/difficulty slot, d1/d3/d4 only; d2 derived post-hoc)

1. **Face-pool discovery** — cached at `assets/facepools/<key>.json`. Sweeps POVs × fold ∈ {0, 70}; records visible face IDs. Front pool = visibility-discovered; back pool = **all face indices `[0, N-1]`**, gated downstream by `getBackSideVisibleFaceIds` at the final step.
2. **Phase 2 trajectory search** — one `evaluateTrajectoriesLive` run per slot with a generic anchor. Each accepted progression carries a `visibilityTimeline` (per-step `visibleFaceIds`, `backSideVisibleFaceIds`, etc.) and a `finalViewScore`.
3. **Per-tier point selection** — `selectFacePointsFromTrajectory` emits up to K=3 configs per trajectory. Visible-front anchors drawn from `alwaysVisible` (visible every step). Hidden-front from `finalVisible`. Hidden-back from `[0,N-1] ∩ finalBackSideVisible`, stored with `faceId = idx + N` so `isPointVisible`'s `isFront = id < N` path checks the back normal. Enforces 3–6 total points, ≥2 visible non-hidden.
4. **Barycentric refinement** — `refineFacePointBarycentric` runs on final selections. Drives to final pose with ≥800 ms settle; sweeps 5×5 barycentric grid (`u,v ∈ [0.22, 0.52]`, `w ≥ 0.18`) in two passes.
5. **Step normalization + hero-shot** — `normalizeStepsForDifficulty` freezes POV across steps (tier motion model); `applyHeroShotStep0` strips `step[0].rotation`.
6. **Validation** — replay with `Math.max(settle, 800)` ms. Regressions revert to pre-refinement barycentric.
7. **Fallback** — if no scan progression validates, up to 50 synthetic candidates via legacy fresh-POV path.

**d4 back-coverage gate**: the count of back-side-exposed faces at the final step must be ≥ `ranges.hB[0]` or the trajectory is dropped.

### Static-POV gotcha

`generateCandidateTrajectories` is static-POV-only, so Phase 2's POV-motion gate sees **0** `endAngle`/`totalAngle`. Custom `scanMode` presets using `buildProgressions` need `minProgressionEndAngle: 0` + `minProgressionTotalAngle: 0`.

### Refinement scoring

Hard gates (fail → discard): `isPointVisible` passes, `edgeMarginPx ≥ 30`, `minNeighborPx ≥ 30`. Then clearance tier:
- Tier 1 (passes `hasForwardClearance`): `2.0·min(edge,300) + 1.0·min(minN,250) + 600·min(baryMargin,0.33)`
- Tier 2 (fails clearance but visible): Tier-1 score − `1e6` penalty, so any Tier-1 beats any Tier-2. Preserves quality on geometries where every placement sits under a hovering layer.

Use clamped (not saturating) terms — saturating `clamp01` causes ties and collapses points to the first grid cell.

## Matrix runner (`tools/generate-matrix.js`)

Runs slots in parallel. Models: `bird`, `waterbomb`, `pinwheel`, `opensink` (others dropped — back faces don't reliably expose under d4 rotation, or models too dense).

- `--concurrency` default `min(12, cpus/2)`. SwiftShader Chrome is ~1 core/instance.
- `--prewarm` (default ON) — three-phase:
  1. All models run at d=1 in parallel (each writes its own facepool cache, no contention).
  2. Remaining (model, d∈{3,4}) slots run parallel up to `--concurrency`. **d2 not run here.**
  3. `deriveD2FromD4` transforms each `<model>-d4.json` → `<model>-d2.json` via pure JSON (no browser): copies steps, freezes rotation to d4's final-step value across states 2..N, renames `-d4-` → `-d2-`. Skipped if d4 output is missing/empty.

d2 costs zero Phase-2 compute and inherits d4's back-exposing final pose by construction.

## Render parallelism (`tools/render_dataset_parallel.py`)

Default `--workers = min(28, cpus * 7/8)`. Each worker = one Puppeteer Chromium (~600–800 MB RAM, ~1 core under SwiftShader). `selectPresetFromConfig` skips `importDemoFile` when the requested model is already loaded — saves ~1–2 s per preset on same-model shards.

## Key trade-offs

- **Thin back pools** (boat has 2 back faces) limit d4 diversity — presets often share hidden-back faces.
- **d2 can still fail** on constrained geometry: needs *some* back-pool face exposed at the final pose.
- **Phase 2 settle (300 ms) vs validation settle (≥800 ms)** — Phase 2 accepts can fail validation if paper is mid-transition; fallback picks up slack.

## Important Conventions

- **Do not npm-install** anything already vendored in `dependencies/`.
- **Shader code lives in `index.html`** as inline `<script>` — not separate `.glsl` files.
- **No ES modules** — inter-file communication via `globals` or global functions.
- **camelCase**; init functions use `init` prefix.
- Simulation loop runs in `requestAnimationFrame`; GPU state in WebGL textures.
