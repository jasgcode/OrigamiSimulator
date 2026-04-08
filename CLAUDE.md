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
- Visibility uses `facePoints.isPointVisible()` (facing + occlusion)
- Labels are text-only and grouped by side (front/back lanes)
- PNG capture includes this overlay so benchmark outputs match what you see

## File Structure

```
index.html                — Entry point. Contains HTML, inline GLSL shaders, and all <script> tags
js/
  main.js                 — Initialization and startup sequence
  globals.js              — Shared state and simulation parameters
  model.js                — 3D mesh geometry and materials (Three.js)
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
benchmarks.json           — Benchmark preset definitions
css/
  main.css, nav.css       — App styles
dependencies/             — Vendored third-party libs (do NOT npm install these)
assets/                   — Demo origami patterns (SVG/FOLD) and doc images
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
| `difficulty` | number | Difficulty tier 1–5 (1 = easiest, 5 = hardest). Metadata for dataset labeling. |
| `scanMode` | boolean | Run scan/evaluation mode to discover high-visibility sequences (no direct step playback). |
| `targetPointLabels` | array \| string | Prioritize visibility for specific point labels (e.g. `["A","C"]` or `"A,C"`) when building progressions. |
| `targetPointIndices` | array \| string | Same as above using zero-based indices (e.g. `[0,2]` or `"0,2"`). |
| `minPointSeparationPx` | number | Minimum required screen-space separation (px) between tracked points at final step when evaluating candidate progressions. |
| `rotationYawMax` | number | Max yaw (radians) for auto rotation profiles used during progression evaluation. |
| `rotationPitchMax` | number | Max pitch (radians) for auto rotation profiles used during progression evaluation. |
| `rotationRollMax` | number | Max roll (radians) for auto rotation profiles used during progression evaluation. |
| `rotationProfileCount` | number | Number of built-in rotation profile variants to test per candidate trajectory (1–6). |
| `steps` | array | Step-by-step sequence: `[{ fold, pov, rotation }, ...]`. See [Steps](#steps). |
| `previewRotation` | object | Rotate view at fixed fold before fold animation. See [Preview rotation](#preview-rotation). |
| `foldAnimation` | object | Animate fold over time. See [Fold animation](#fold-animation). |

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

## Important Conventions

- **Do not add npm dependencies** for things already vendored in `dependencies/`.
- **Shader code lives in `index.html`** as inline `<script>` tags, not in separate `.glsl` files.
- **No ES modules** — do not use `import`/`export`. All inter-file communication goes through `globals` or global function scope.
- **camelCase** for variables and functions. Init functions use the `init` prefix (e.g. `initModel`).
- `index.html` is the single entry point. The app is deployed as a static site via GitHub Pages.
- The simulation loop runs in `requestAnimationFrame`. GPU state is managed via WebGL textures in `GPUMath.js`.
