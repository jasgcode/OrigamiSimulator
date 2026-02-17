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

## File Structure

```
index.html                — Entry point. Contains HTML, inline GLSL shaders, and all <script> tags
js/
  main.js                 — Initialization and startup sequence
  globals.js              — Shared state and simulation parameters
  model.js                — 3D mesh geometry and materials (Three.js)
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
css/
  main.css, nav.css       — App styles
dependencies/             — Vendored third-party libs (do NOT npm install these)
assets/                   — Demo origami patterns (SVG/FOLD) and doc images
```

## Important Conventions

- **Do not add npm dependencies** for things already vendored in `dependencies/`.
- **Shader code lives in `index.html`** as inline `<script>` tags, not in separate `.glsl` files.
- **No ES modules** — do not use `import`/`export`. All inter-file communication goes through `globals` or global function scope.
- **camelCase** for variables and functions. Init functions use the `init` prefix (e.g. `initModel`).
- `index.html` is the single entry point. The app is deployed as a static site via GitHub Pages.
- The simulation loop runs in `requestAnimationFrame`. GPU state is managed via WebGL textures in `GPUMath.js`.
