# Origami Simulator

Real-time GPU-accelerated origami folding simulator. Live at https://origamisimulator.org/

## Running Locally

```bash
bun run dev          # serves static files via bunx serve on localhost
```

Or open `index.html` directly in a browser (some fetch-based features require HTTP).

## Tooling

Default to Bun over Node.js for any new tooling, scripts, or server needs.

- `bun run <script>` instead of `npm run`
- `bun install` instead of `npm install`
- `bun test` for tests (uses `bun:test`)
- `Bun.serve()` if a dev server is needed (not Express/Vite)

## Architecture

**Static frontend app with no build step.** All code runs client-side in the browser.

- **No module system** — all JS uses global functions and the shared `globals` object. There are no `import`/`export` statements.
- **No bundler** — scripts are loaded via `<script>` tags in `index.html`.
- **All dependencies are vendored** in `dependencies/` (Three.js, jQuery, numeric.js, etc). They are NOT installed via npm.
- The `package.json` exists only for the `bun run dev` convenience script.

## Key Patterns

### Module pattern

Every JS file exposes an `init*` function that receives `globals` and returns a module object:

```js
function initModel(globals) {
    // private vars and functions via closure
    return { publicMethod: ... };
}
```

Wired together in `js/main.js`:

```js
globals.threeView = initThreeView(globals);
globals.model = initModel(globals);
globals.dynamicSolver = initDynamicSolver(globals);
```

### Globals object

`globals` (defined in `js/globals.js`) is the central shared state — simulation parameters, flags (`simulationRunning`, `materialHasChanged`, etc.), and references to all initialized modules. UI controls read/write `globals` directly.

### GPU compute via WebGL shaders

The physics simulation runs on the GPU via fragment shaders. GLSL shader source is embedded as `<script type="x-shader/x-fragment">` blocks in `index.html`. The GPU abstraction layer lives in `js/dynamic/GPUMath.js`.

### UI

jQuery + jQuery UI + Bootstrap + Flat UI. DOM manipulation uses `$()` selectors throughout. No templating or component framework.

### Point annotations

`labelStyle: "arrow"` uses a screen-space overlay (`#pointAnnotationCanvas`) for robust labels/arrows.

- Anchors are projected from true 3D point positions after model rotation
- Visibility uses `facePoints.isPointVisible()` (facing + occlusion + frustum)
- Labels are text-only and grouped by side (front/back lanes)
- PNG capture includes this overlay so benchmark outputs match what you see

### Point visibility tests (`js/facePoints.js`)

Two tests, both using raw ray-triangle intersection (no `material.side` culling, so folded panels are caught from either side):

- **`isPointVisible(index)`** — gate used everywhere (benchmark, validation, label overlay):
  1. Face-normal test: `dot(toCamera, normal) > 0` (front points) / `< 0` (back points).
  2. Frustum test: project point to NDC and reject if `x`, `y`, or `z` falls outside `[-1, 1]`. Without this, off-screen or behind-camera points pass the other tests and validation falsely accepts presets whose tracked points are invisible in the rendered PNG.
  3. Occlusion test: ray from the point toward the camera must not hit another mesh face before reaching it. Origin is nudged off the surface by `OCCL_EPSILON = 0.002` so the point's own face isn't hit.
- **`hasForwardClearance(index, dist)`** — stricter gate used only by the barycentric refiner. Imagines a short arrow pointing outward from the point along the face's +normal (for back-side points the inward normal is flipped) and checks both:
  1. **Along-normal path** — ray from point along +normal for `dist`; fails if a panel physically crosses the arrow body.
  2. **Tip visibility** — arrow tip at `point + normal * dist`; casts a ray from the tip back to the camera and fails if a panel sits between. This catches panels that are *above* the point but offset in the camera direction — `isPointVisible` passes for the point itself but the slightly-elevated tip's ray clips the layer.

`isPointVisible` is the correctness contract for rendering and validation; `hasForwardClearance` is a ranking signal that prefers points with breathing room around them.

## File Structure

```
index.html                — Entry point. Contains HTML, inline GLSL shaders, and all <script> tags
js/
  main.js                 — Initialization and startup sequence
  globals.js              — Shared state and simulation parameters
  model.js                — 3D mesh geometry and materials (Three.js)
  facePoints.js           — Barycentric points on faces + visibility tests (isPointVisible, hasForwardClearance)
  pointAnnotations.js     — Screen-space arrow label overlay for face points
  threeView.js            — Three.js scene, camera, renderer setup
  controls.js             — UI event handlers and DOM bindings
  pattern.js              — Crease pattern logic
  importer.js             — SVG/FOLD file import
  3dUI.js                 — 3D interaction (raycasting, selection)
  dynamic/
    dynamicSolver.js      — Dynamic simulation solver (GPU-based)
    GPUMath.js            — WebGL compute abstraction
    GLBoilerplate.js      — WebGL setup utilities
  node.js, beam.js, crease.js  — Simulation primitives
  saveFOLD.js, saveSTL.js      — Export functionality
  curvedFolding.js        — Curved crease support
  videoAnimator.js        — GIF/WebM capture
  VRInterface.js          — VR headset support (likely deprecated)
  benchmark.js            — Benchmark system (presets, run, runAll)
  presetGenerator.js      — Trajectory-first preset generation pipeline
benchmarks.json           — Benchmark preset definitions
css/
  main.css, nav.css       — App styles
dependencies/             — Vendored third-party libs (do NOT npm install these)
assets/                   — Demo origami patterns (SVG/FOLD) and doc images
tools/
  generate-presets.js     — Puppeteer driver for presetGenerator
  generate-matrix.js      — Multi-(model, difficulty) parallel runner
  render_dataset_parallel.py — Multi-worker PNG renderer
```

## Benchmark System (`benchmarks.json`)

The benchmark system runs configurable sequences: load a model, apply view/color settings, and either step through fold percentages or run animations. Presets are defined in `benchmarks.json` and can be selected via `?benchmark=<name>` or run in batch with `?runAll=true`.

### Top-level parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `model` | string | Path to demo file (e.g. `/Bases/waterbombBase.svg`). Required for run. |
| `colorMode` | string | Color mode after load: `color`, `faceTriangleID`, `labelOnly`, `faceID`, `axialStrain`, etc. |
| `color1` | string | Hex color for front side (labelOnly). E.g. `ec008b`. |
| `color2` | string | Hex color for back side (labelOnly). E.g. `dddddd`. |
| `backgroundColor` | string | Hex background color (e.g. `f5f5f5` or `#f5f5f5`). |
| `fold` | number | Initial fold % (0–100) before any animation. Applied at start. |
| `pauseDuration` | number | Seconds to wait before starting (animation flow) or at each step (steps flow). Default: 2. |
| `pointA` | number | Face ID for highlight/point A. |
| `pointB` | number | Face ID for highlight/point B. |
| `facePoints` | object \| array | Points on faces. See [Face points](#face-points) below. |
| `showPointNumbers` | boolean | Show numbers on face points. Default: true. |
| `labelStyle` | string | Point label style: `"circle"` (default), `"arrow"` (screen-space connector labels), or `"both"` (final capture saves `stepNN.png` with circle labels and `stepNN_arrow.png` with arrow labels). |
| `autoCapture` | boolean | Capture PNG at each step (steps flow only). |
| `autoRun` | boolean | Start sequence automatically after load. |
| `difficulty` | number | Difficulty tier 1–5. See [Difficulty tiers](#difficulty-tiers). Metadata for dataset labeling. |
| `trackingEvalMode` | string | Hidden-point semantic: `strictAllSteps` (default — hidden points required visible at every step) or `finalStepOnly` (hidden points only required at the final step). Non-hidden points are required visible at every step regardless of mode. See [Validation semantics](#validation-semantics). |
| `stepLabelPrefix` | string | Step overlay text prefix. Default: `"STATE"`. |
| `stepLabelFontSize` | number | Step overlay font size in px. Default: 48. |
| `stepLabelShowTotal` | boolean | If true (default) overlay shows `"STATE 1/5"`; if false shows `"STATE 1"`. |
| `scanMode` | boolean | Run scan/evaluation mode to discover high-visibility sequences (no direct step playback). |
| `targetPointLabels` | array \| string | Prioritize visibility for specific point labels (e.g. `["A","C"]` or `"A,C"`) when building progressions. |
| `targetPointIndices` | array \| string | Same as above using zero-based indices (e.g. `[0,2]` or `"0,2"`). |
| `minPointSeparationPx` | number | Minimum required screen-space separation (px) between tracked points at final step when evaluating candidate progressions. |
| `rotationYawMax` | number | Max yaw (radians) for auto rotation profiles used during progression evaluation. |
| `rotationPitchMax` | number | Max pitch (radians) for auto rotation profiles used during progression evaluation. |
| `rotationRollMax` | number | Max roll (radians) for auto rotation profiles used during progression evaluation. |
| `minProgressionEndAngle` | number | Phase 2 gate: minimum radians between the **first and last trajectory `pov`** (`getProgressionMotionMetrics`). Default **0.85** when omitted. With static-POV progressions this is **0**, so set **`0`** for `scanMode` presets that use `buildProgressions`. |
| `minProgressionTotalAngle` | number | Phase 2 gate: summed radians of **consecutive trajectory `pov` steps**. Default **1.75** when omitted; use **`0`** alongside `minProgressionEndAngle: 0` for static-POV scans. |
| `minProgressionPairDistance` | number | Diversity selector threshold (radians) when picking `diverseProgressions`. Default **0.22**. |
| `enforceInitialTrackedVisible` | boolean | Phase 2 / playback helper: require **non-hidden** tracked points to be visible on **step 0** (default **true**). Set `false` only if you intentionally start with no visible anchors. |
| `rotationProfileCount` | number | Number of built-in rotation profile variants to test per candidate trajectory (integer ≥ 1; hybrid scan defaults to **6**, or **10** when `trackingEvalMode: "finalStepOnly"`). |
| `steps` | array | Step-by-step sequence: `[{ fold, pov, rotation }, ...]`. See [Steps](#steps). |
| `previewRotation` | object | Rotate view at fixed fold before fold animation. See [Preview rotation](#preview-rotation). |
| `foldAnimation` | object | Animate fold over time. See [Fold animation](#fold-animation). |

### Difficulty tiers

These tiers describe **dataset semantics** (`difficulty` metadata). They do **not** imply the camera animates across fold steps: generated presets follow the **static camera + per-step model `rotation`** motion model described in **Preset Generation Pipeline** below.

| Tier | Motion across fold steps | Sides exposed by the end |
|------|--------------------------|--------------------------|
| 1 | Static POV, **constant** model rotation across steps (no inter-step motion) | One side only |
| 2 | Static POV, **small** rotation ramp (hidden-back reveal) | Both sides (back tracked point is hidden until the final fold step) |
| 3 | Static POV, **moderate** rotation ramp | One side only |
| 4 | Static POV, **moderate** rotation ramp | Both sides (hidden-back reveal; often plus a hidden front revealed late) |
| 5 | Static POV, **large** rotation ramp | Both sides (hidden-back reveal; denser hidden-front / late-reveal mix) |

**d1 note:** d1 has zero motion *between* fold steps, but the model still sits at any fixed (possibly non-flat) pose. `buildAutoRotationProfiles` emits multiple **constant-rotation** profiles so a d1 slot produces visually-diverse presets ("same fold sequence viewed from different fixed angles") instead of always defaulting to the flat-from-above view. The constant-rotation magnitudes use d3's bounds (yaw 0.5, pitch 0.15, roll 0.08).

Reference examples: `bird-track` (difficulty 3) in `benchmarks.json`; `bird-frontback-*` (difficulty 5) in `candidates/bird-frontback.json`.

### Face points

Define points on mesh faces (for `faceTriangleID` / `labelOnly`). Positions are deterministic.

**Counts (object):** `{ "faceId": count, ... }` — N points per face with deterministic layout.
```json
"facePoints": { "0": 3, "5": 2 }
```

**Explicit barycentric (object):** `{ "faceId": [[u,v,w], ...], ... }` — exact barycentric coords.
```json
"facePoints": {
  "0": [[0.33, 0.33, 0.34], [0.5, 0.5, 0]],
  "5": [[0.5, 0.25, 0.25]]
}
```

**Explicit (array):** `[{ faceId, u, v, w }, ...]`.
```json
"facePoints": [{ "faceId": 0, "u": 0.33, "v": 0.33, "w": 0.34 }]
```

**Hidden points:** Any point can have `"hidden": true` to make it invisible until the last step (or after fold animation completes). Hidden points keep their number in the continuous 1..N sequence but don't render until revealed. Use this to show initial points on a flat model, then reveal additional points on the folded result.
```json
"facePoints": {
  "0": [{ "u": 0.33, "v": 0.33, "w": 0.34 }],
  "3": [{ "u": 0.5, "v": 0.25, "w": 0.25, "hidden": true }]
}
```

### Steps

Step sequence when not using `foldAnimation`. Each step sets fold % and camera POV.

```json
"steps": [
  { "fold": 0,   "pov": "iso" },
  { "fold": 50,  "pov": "z", "rotation": [0, 0.5, 0] },
  { "fold": 100, "pov": "-z" }
]
```

| Field | Type | Description |
|-------|------|-------------|
| `fold` | number | Fold percentage 0–100. |
| `pov` | string \| array | Camera POV: `iso`, `x`, `-x`, `y`, `-y`, `z`, `-z`, or a continuous direction as `[x, y, z]` array or `"x,y,z"` string (e.g. `[1, 0.5, 0.3]` or `"1,0.5,0.3"`). |
| `rotation` | array \| object | Optional model rotation as Euler XYZ radians: `[x, y, z]` or `{"x": 0, "y": 1.57, "z": 0}`. Applied after POV (independent of camera). Also supported in `foldAnimation.povKeyframes` and `previewRotation.povKeyframes` for interpolated rotation. |

### Preview rotation

Rotate the view around the model at a fixed fold (no folding). Runs before `foldAnimation` when both are present.

```json
"previewRotation": {
  "duration": 5,
  "povKeyframes": [
    { "progress": 0,  "pov": "iso" },
    { "progress": 50, "pov": "z" },
    { "progress": 100, "pov": "iso" }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `duration` | number | Duration in seconds. Default: 2. |
| `povKeyframes` | array | `[{ progress, pov }, ...]` — progress 0–100. |
| `fold` | number | Optional override for fold % during preview (otherwise uses top-level `fold`). |
| `trackModel` | boolean | Rotate model (camera fixed) during preview so points stay in view. |
| `fitAllPoints` | boolean | Zoom out so entire model stays in view during camera-orbit preview. |

`previewRotation.trackModel` and `previewRotation.fitAllPoints` apply in both steps mode and fold-animation mode.

### Fold animation

Animate fold from one % to another over time, with optional POV transition.

```json
"foldAnimation": {
  "from": 0,
  "to": 90,
  "duration": 5,
  "delayAfterPreview": 1,
  "hidePointsDuringAnimation": true,
  "trackModel": true,
  "povKeyframes": [
    { "fold": 0,  "pov": "iso" },
    { "fold": 50, "pov": "z" },
    { "fold": 90, "pov": "iso" }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `from` | number | Start fold %. Default: 0 or top-level `fold`. |
| `to` | number | End fold %. Default: 90. |
| `duration` | number | Duration in seconds. Default: 4. |
| `delay` / `delayBeforeAnimation` | number | Seconds to wait before starting (uses `pauseDuration` if omitted). |
| `delayAfterPreview` | number | Seconds to pause between `previewRotation` and fold animation. |
| `povKeyframes` | array | `[{ fold, pov }, ...]` — POV at fold %. |
| `trackModel` | boolean | Rotate model (camera fixed) so points stay in view. |
| `fitAllPoints` | boolean | Zoom out so entire model stays in view. |
| `hidePointsDuringAnimation` | boolean | Hide face points during fold. |

### URL parameters

Any JSON parameter can be overridden via URL: `?benchmark=waterbomb-animate&color1=ff0000&pauseDuration=5`. See `js/benchmark.js` for the full URL parameter list.

### Render overlay defaults

Default per-step overlay text on rendered PNGs:

- Prefix: `STATE` (e.g. `STATE 1`, `STATE 2`, ...). With `stepLabelShowTotal=true` (default) the overlay reads `STATE 1/5`.
- Font size: **48 px** (scaled with canvas size).
- Position: top-left, 16 px padding, semi-opaque white pill background.

Customize per preset via `stepLabelPrefix`, `stepLabelFontSize`, `stepLabelShowTotal` config keys (also URL params). See `js/threeView.js` (PNG composition) and `js/benchmark.js` (`applyStepOverlayConfig`).

### Scaling up front/back sequences

Use scan mode to auto-discover high-visibility step sequences (POV + rotation) that keep tracked points visible.

1. Create a seed preset with model, face points, and scan options:
   - `scanMode: true`
   - `scanFoldSteps` for desired fold frames
   - `povGridSize` (e.g. 100–160)
   - `buildProgressions` target count
   - `targetPointLabels` (e.g. `["A","C"]`)
   - `minPointSeparationPx` (e.g. `70–100`)
   - rotation bounds (`rotationYawMax`, `rotationPitchMax`, `rotationRollMax`)

2. Run the preset. The benchmark system writes `screenshots/<preset-name>/scan.json` containing `diverseProgressions`.

3. Copy selected `diverseProgressions[*].steps` into new fixed presets for dataset generation.

---

## Preset Generation Pipeline (`js/presetGenerator.js` + `tools/generate-presets.js`)

Automated trajectory-first preset generator that produces validated benchmark JSON. Runs headless Chrome via Puppeteer (`tools/generate-presets.js`), drives the in-page generator, and writes validated presets to a JSON file.

### Invocation

```bash
bun tools/generate-presets.js \
  --model /Bases/boatBase.svg \
  --difficulty 4 \
  --count 10 \
  --base-name boat-d4 \
  --start-index 1 \
  --templates "no-match-pattern-*" \
  --seed 42 \
  --output new_dataset/boat-d4.json \
  --trajectory-mode hybrid \
  --build-progressions 24 \
  --max-trajectory-candidates 40 \
  --max-scan-candidates 20
```

Requires `bun run dev` running (generator hits `localhost:3000`).

### Motion model

Presets use a **static camera + object rotation** model. The camera POV is fixed for a preset; per-step `rotation` (Euler XYZ radians) on the model drives which faces come into view across fold steps.

`threeView.setModelRotation(x, y, z)` applies rotation to `modelWrapper` (in `js/threeView.js`). `benchmark.js` applies it per step during both scan evaluation and preset playback.

`generateCandidateTrajectories` in `js/benchmark.js` is **static-POV-only**: every generated progression step repeats the same endpoint `pov` (motion comes from per-step model `rotation` during Phase 2 / playback).

Because Phase 2's POV-motion gate evaluates POV direction changes, static-POV progressions produce **0** `endAngle` / `totalAngle`. Custom `scanMode` benchmarks therefore need **`minProgressionEndAngle: 0`** and **`minProgressionTotalAngle: 0`** (URL params supported) whenever `buildProgressions` is enabled — the hybrid generator does this automatically.

### Tracked point counts (generator)

`selectFacePointsFromTrajectory` in `js/presetGenerator.js` enforces **3–6** tracked points total (including planned hidden slots) and at least **2** visible (non-hidden) anchors. Per-tier slot **ranges** are picked greedily based on what the trajectory's pools support; the global cap of 6 is enforced after summing slots.

| Tier | Visible front | Hidden front | Hidden back | Total range |
|------|---------------|--------------|-------------|-------------|
| d1   | [3, 6]        | 0            | 0           | 3 to 6      |
| d2   | [2, 4]        | 0            | [1, 2]      | 3 to 6      |
| d3   | [3, 6]        | 0            | 0           | 3 to 6      |
| d4   | [2, 3]        | [1, 2]       | [1, 2]      | 4 to 6 (cap) |
| d5   | [2, 3]        | [2, 3]       | [1, 2]      | 5 to 6 (cap) |

If any slot's lower bound can't be met by the trajectory's pools, the trajectory yields no configs.

### Two-sided tier policy

**d2** is emitted as a **hidden-back reveal** preset: visible-front anchors must be visible at every step (`alwaysVisible` set from the timeline); hidden back picks come from faces visible at the **final** step. The small rotation budget (yaw/pitch ≈ 0.2 rad) is enough to surface a back face at fold ≈ 70 while the camera POV stays fixed.

**d4 / d5** extend that model with additional **hidden front** slots and a larger rotation ramp so thin back pools can still validate. Visible-front anchors are still gated on `alwaysVisible` (the user's contract: "initial points must be visible throughout all progressions and final state").

For two-sided tiers a **final-state back coverage gate** also fires: the count of `backPool ∩ finalVisible` must be ≥ **2** (d2) or ≥ **3** (d4/d5) or the trajectory is dropped (a single sliver of back peeking through is insufficient — reference d4/d5 presets ship 3–6 back-pool faces visible at final).

Rotation magnitude per tier (`rotationBoundsForTier` in `js/presetGenerator.js`):

| Tier | `rotationYawMax` | `rotationPitchMax` | `rotationRollMax` |
|------|------------------|---------------------|--------------------|
| d1   | 0.5 rad          | 0.15 rad            | 0.08 rad           |
| d2   | 0.2 rad          | 0.2 rad             | 0.05 rad           |
| d3   | 0.5 rad          | 0.15 rad            | 0.08 rad           |
| d4   | 1.0 rad          | 1.0 rad             | 0.25 rad           |
| d5   | 1.2 rad          | 1.2 rad             | 0.25 rad           |

d1's bounds describe **constant** rotation (same value at every step) for static-pose diversity, not motion. d4/d5 envelopes ramp **monotonically** to 1.0 at the final step (not bell-curve) so the hidden-back reveal lands at peak rotation. See `buildAutoRotationProfiles` in `js/benchmark.js`.

### Generation stages

Per (model, difficulty) slot:

1. **Face-pool discovery** — one-time per model, cached at `assets/facepools/<key>.json`. Sweeps `scanPovs` (8–12 POVs across the upper hemisphere) × fold ∈ {0, 70} and records visible face IDs and per-face quality at each (fold, POV).
2. **Generic anchor selection** — `buildGenericAnchorFacePoints(frontPool, modelFaceCount)` picks `frontPool[0]`'s centroid (`{u: 0.34, v: 0.33, w: 0.33}`) as a single throwaway anchor for Phase 2's gate. The anchor never appears in the final preset.
3. **Phase 2 — single trajectory search per slot** — one `evaluateTrajectoriesLive` run with the generic anchor (replaces the old per-(front,back) fan-out). Phase 2 always uses `finalStepOnly` at the slot level (per-tier visibility semantics fire downstream). Each accepted progression is annotated with a **`visibilityTimeline`** (`[{stepIndex, fold, pov, rotation, visibleFaceIds, qualities}, ...]`) and a `finalViewScore`. `selectDiverseProgressions` preserves the timeline so the next stage can read it.
4. **Per-tier point selection from timeline** — for each accepted trajectory, `selectFacePointsFromTrajectory(trajectory, tier, modelFaceCount, frontPool, backPool, rng)` emits up to **K=3** distinct face-point configs by shifting the visible-front rank window (and rotating hidden picks). Visible-front anchors are drawn from the timeline's `alwaysVisible` set (visible at *every* step) regardless of tier. Hidden-back / hidden-front picks are drawn from `finalVisible`. Two-sided tiers (d2/d4/d5) drop the trajectory if final-state back coverage is below threshold (see above).
5. **Barycentric refinement** — `refineFacePointBarycentric` runs *after* `selectDiverseProgressions` on only the final N selected presets. The refiner drives the simulation to the final pose with ≥800 ms settle per step and sweeps a 5×5 barycentric grid (`u,v ∈ [0.22, 0.52]`, `w ≥ 0.18`) per point in two passes. See [Refinement scoring](#refinement-scoring).
6. **Validation** — replays each produced preset with settle (`Math.max(settle, 800)` ms); enforces non-hidden visibility at every step and hidden-point visibility per `trackingEvalMode`. Refinement regressions are reverted to the pre-refinement barycentric (`refineAndRevalidate`).
7. **Fallback** — if no scan progression validates, generate up to 50 purely-synthetic candidates via the legacy fresh-POV path and validate.

### Refinement scoring

`scoreCandidate` in `refineFacePointBarycentric` combines hard gates and a monotonic weighted sum:

- **Hard gates** (any failure → `-Infinity`, candidate is discarded):
  - `isPointVisible` must pass (face-normal + frustum + point→camera occlusion).
  - `edgeMarginPx ≥ 30` (screen-space distance to image borders).
  - `minNeighborPx ≥ 30` (screen-space distance to every other visible tracked point).
- **Clearance tier** — `hasForwardClearance(idx, clearanceDist)` where `clearanceDist = max(0.015, 0.02 × bbox_diagonal)`:
  - Tier 1 (passes clearance): score = `2.0·min(edge, 300) + 1.0·min(minN, 250) + 600·min(baryMargin, 0.33)`.
  - Tier 2 (fails clearance but still visible): same score minus `TIER2_PENALTY = 1e6`, so any Tier-1 candidate beats any Tier-2, yet within Tier 2 ordering still matches raw score. This preserves refinement quality on geometries where *every* placement sits under a hovering layer.

Scoring uses clamped (not saturating) terms so better candidates always outscore weaker ones. An earlier saturating-`clamp01` version caused every passable candidate to tie and the first-enumerated grid cell would always win, collapsing many points to `(0.30, 0.30)`.

### Validation semantics

`validatePreset` treats `trackingEvalMode` as a **hidden-point semantic only**:

- **Hidden points** — required visible only at the final step under `finalStepOnly`; required at every step under `strictAllSteps`.
- **Non-hidden points** — required visible at **every step**, regardless of `trackingEvalMode`.

Previously, `finalStepOnly` mode also let visible-front anchors disappear mid-fold (visible anchors were checked only at the final step). The new rule matches the user's contract: "initial points must be visible throughout all progressions and final state." The `preset.hidePointsDuringAnimation` flag is a rendering toggle and has no effect on validation — the human-trackability contract means "geometry-visible at every step", independent of whether labels are drawn.

### Key trade-offs

- **Thin back pools** (e.g. boat has 2 back faces) limit d4/d5 diversity. Multiple generated presets often share the same hidden-back face.
- **d2 on extremely constrained geometry** can still fail: the hidden-back path needs *some* rotatable exposure of a back-pool face at the final step. When the fold + small rotation budget cannot surface any back-pool triangle, the slot produces **0** presets.
- **Phase 2 settle vs validation settle**: Phase 2 uses `scanSettleMs=300` for speed; validation forces ≥800 ms to match playback. Trajectories accepted by Phase 2 can still fail validation if the paper is mid-transition at 300 ms; the fallback path picks up the slack.

### Generated output

Written to the `--output` file as a flat object `{ "<base-name>-01": {...}, "<base-name>-02": {...}, ... }` (benchmark schema). Each entry includes `steps` with per-step `fold`, `pov`, and `rotation`. Presets with `difficulty ≥ 4` carry `trackingEvalMode: "finalStepOnly"`.

---

## Matrix runner concurrency (`tools/generate-matrix.js`)

Runs `tools/generate-presets.js` for each (model, difficulty) slot in parallel.

- **`--concurrency`** — default `min(12, cpus/2)`. Half the logical CPUs, capped at 12 (SwiftShader Chrome is ~1 core under load; cap leaves headroom for OS + dev server).
- **`--prewarm`** (default ON) — two-phase fan-out:
  - **Phase 1**: every model runs at d=1 in parallel. Each model writes its own `assets/facepools/<key>.json` so there's no cache contention.
  - **Phase 2**: every remaining (model, d∈{2..5}) slot runs in parallel up to `--concurrency`. Cache is warm so same-model slots no longer race.
- **`--no-prewarm`** — legacy "model groups in parallel, difficulties within a model serial" mode (caps at modelCount slots concurrent regardless of `--concurrency`; safe for cold caches without a pre-warm).

## Render parallelism (`tools/render_dataset_parallel.py`)

Default `--workers` = `min(28, cpus * 7/8)`. Each worker is one Puppeteer Chromium (~600–800 MB RAM, ~1 core under SwiftShader load). On a 32-thread / 128 GB box this lands at 28 workers (~22 GB) and leaves 4 cores for OS + dev server.

`benchmark.js:selectPresetFromConfig` skips `importDemoFile` when `globals.loadedModel` already matches the requested model AND the mesh is loaded — saves ~1–2 s per preset on shards with many same-model presets.

---

## Important Conventions

- **Do not add npm dependencies** for things already vendored in `dependencies/`.
- **Shader code lives in `index.html`** as inline `<script>` tags, not in separate `.glsl` files.
- **No ES modules** — do not use `import`/`export`. All inter-file communication goes through `globals` or global function scope.
- **camelCase** for variables and functions. Init functions use the `init` prefix (e.g. `initModel`).
- `index.html` is the single entry point. The app is deployed as a static site via GitHub Pages.
- The simulation loop runs in `requestAnimationFrame`. GPU state is managed via WebGL textures in `GPUMath.js`.
