# Modifications

## 2026-04-16

### `js/benchmark.js`
- Added a configurable tracking evaluation mode via `trackingEvalMode` with two supported modes:
  - `strictAllSteps` (default): target points must be visible at every required step.
  - `finalStepOnly`: intermediate misses are tolerated; final step remains strict.
- Added URL override parsing for `trackingEvalMode` so you can switch behavior without editing presets.
- Updated tracked-point evaluation to return richer diagnostics (`missingCount`, `reason`, `mode`) and apply mode-aware pass/fail logic.
- Added progression evaluation stats aggregation (`rejectedByQuality`, `rejectedByTrackedPoints`, etc.) and included these in `scan.json` as `progressionStats`.
- Fixed face-ID normalization for progression target faces so back-side IDs (`N..2N-1`) map to front-face IDs (`0..N-1`) before quality checks.
- Replaced hardcoded progression face-quality acceptance threshold (`0.6`) with `minQuality` from config.
- Improved trajectory endpoint generation so scan states with named POVs (e.g. `"iso"`, `"x"`) can also produce candidate endpoints.
- Extended point label support from single-letter labels (`A..Z`) to spreadsheet-style labels (`A..Z`, `AA..AZ`, ...), and updated summary/metadata label generation accordingly.

### `js/presetGenerator.js`
- Preserved hidden-point metadata when generating `facePoints` configs (`hidden: true` is now retained in emitted entries).
- Added `trackingEvalMode` and `minPointSeparationPx` fields to generated presets, with defaults:
  - `trackingEvalMode: "strictAllSteps"`
  - `minPointSeparationPx: 70`
- Aligned final-step separation validation threshold with preset config (`minPointSeparationPx`) instead of hardcoded `60` px.
- Updated validation behavior to respect `trackingEvalMode`:
  - strict mode checks visibility at all required steps.
  - final-step-only mode enforces visibility at final step only (hidden-point rule still applies).

### `benchmarks.json`
- Added `trackingEvalMode: "strictAllSteps"` to all preset objects that currently define `steps`, so the default tracking behavior is explicit and can be overridden per preset or by URL parameter.

### `tools/render_dataset_parallel.py`
- Added a new multiprocessing-based headless renderer orchestrator for dataset rendering in parallel.
- Orchestrates concurrent shard jobs that invoke the existing `tools/render-dataset.js` pipeline, so rendering behavior stays consistent with the current simulator capture path.
- Implements robust sharding and scheduling:
  - balances shards by estimated preset cost (`steps`, `foldAnimation`, `previewRotation`, `scanMode`)
  - supports configurable `--workers` and `--chunk-size`
  - checks `screenshots/<preset>/metadata.json` to support `--skip-existing` resume behavior
- Implements fault tolerance and recovery:
  - per-job timeout (`--timeout-sec`)
  - retries (`--max-retries`)
  - optional recursive split-on-failure to isolate problematic presets (`--no-split-on-fail` disables)
- Adds structured run artifacts under `tools/.render-parallel-runs/<run-id>/`:
  - shard manifests
  - per-attempt logs
  - `report.json` with success/failure breakdown and job-level telemetry
- Added server safety constraints so shard manifests are always created under repo paths that the Bun static server can serve.

### `js/benchmark.js`
- Exposed `runScan` on the benchmark public API so generation code can call scan/progression logic directly.
- Updated scan completion callback to return the computed scan result object, enabling in-memory consumers to use `diverseProgressions` without reading `scan.json` from disk.
- Added `saveScanResult` config gate for scan mode (`true` by default); generator-driven scans can set `saveScanResult: false` to avoid filesystem write overhead.
- Added optional all-step Euclidean separation enforcement in tracked-point evaluation (`enforceSeparationAllSteps`), while preserving final-step separation checks by default.
- Added Phase 2 robustness controls for progression evaluation:
  - heartbeat logging with elapsed time and ETA (`phase2LogEveryMs`)
  - stall warning logs when no progress is observed (`phase2StallWarnMs`)
  - trajectory candidate cap before live evaluation (`maxTrajectoryCandidates`)
- Added URL/config parsing for the new controls:
  - `maxTrajectoryCandidates`
  - `phase2LogEveryMs`
  - `phase2StallWarnMs`
  - `enforceSeparationAllSteps`

### `js/presetGenerator.js`
- Integrated progression-aware generation path and set generation behavior to support `trajectoryMode: "hybrid"` as a first-class mode.
  - Hybrid attempts scan/progression-based trajectory generation first.
  - Falls back to legacy template/random trajectory generation if progression generation fails or yields no valid results.
- Added progression-driven preset construction:
  - Converts selected `diverseProgressions` trajectories into preset `steps`.
  - Preserves difficulty normalization and color-mode behavior.
  - Adds internal `_rotCurve`/`_povCurve` metadata for diversity selection compatibility.
- Added target point derivation from selected `facePoints` so progression search is tracking-aware by default:
  - supports `targetSelectionMode` (`all`, `visible-only`, `hidden-only`).
- Added scan generation controls for robustness/perf tuning:
  - `buildProgressions`, `povGridSize`, `scanSettleMs`, `maxScanCandidates`
  - `trackingEvalMode`, `minFaceQuality`, `minPointSeparationPx`
  - `enforceSeparationAllSteps`
- Forwarded Phase 2 logging/capping controls into scan config:
  - `maxTrajectoryCandidates`
  - `phase2LogEveryMs`
  - `phase2StallWarnMs`
- Extended preset validation to optionally enforce Euclidean separation across all steps (not only final step) when strict tracking is enabled and `enforceSeparationAllSteps` is `true`.

### `tools/generate-presets.js`
- Added CLI flags to control new progression/hybrid generation behavior:
  - `--trajectory-mode` (defaults to `hybrid`)
  - `--tracking-eval-mode`
  - `--target-selection-mode`
  - `--min-point-separation-px`
  - `--min-face-quality`
  - `--build-progressions`
  - `--pov-grid-size`
  - `--scan-settle-ms`
  - `--enforce-separation-all-steps`
  - `--max-scan-candidates`
- Added CLI flags for Phase 2 observability and runtime capping:
  - `--max-trajectory-candidates`
  - `--phase2-log-every-ms`
  - `--phase2-stall-warn-ms`
- Hardened headless generation against `Target closed`/protocol failures:
  - added multi-attempt retry loop with configurable backoff (`--max-attempts`, `--retry-delay-ms`)
  - added automatic search-space degradation on retries (`--auto-degrade-on-retry`) to improve recovery odds
  - added host heartbeat logging (`--heartbeat-ms`) so long runs always emit progress even if browser logs go quiet
  - made Puppeteer protocol timeout configurable (`--protocol-timeout-ms`)
  - added optional Chromium process log passthrough (`--dumpio`)
- Expanded browser-console forwarding in the headless runner to include scan/progression progress logs (`benchmark: Scan`, `Phase 2`, `evaluateTrajectoriesLive`) for easier long-run observability.

### `js/controls.js`
- Updated generator UI invocation defaults to call preset generation with:
  - `trajectoryMode: "hybrid"`
  - `trackingEvalMode: "strictAllSteps"`

### `js/presetGenerator.js` (progress logging)
- Added explicit hybrid scan progress status updates during generation:
  - number of scan candidates planned
  - current candidate index (`i/N`)
  - progressions found per candidate and running total
  - final progression-derived candidate total
