# tools/

Command-line tools for generating, rendering, auditing and scoring the dataset. Run every command from the repository root.

- **Puppeteer drivers** (`*.js`, run with `bun`) open the app in headless Chromium and call into it.
- **Orchestrators, audits and scorers** (`*.py`) need Python ≥ 3.10 and the standard library only.

Most commands need a dev server (`bun run dev`). A tool that writes outputs requires the server's `DATASET_DIR` to match its output directory, and checks this before it starts.

[docs/pipeline.md](../docs/pipeline.md) explains how the pieces fit together. [docs/reproduce.md](../docs/reproduce.md) gives the end-to-end commands for the release. [docs/design.md](../docs/design.md) explains the rules these tools enforce.

| Script | Stage | Purpose |
|---|---|---|
| [`generate-expert-dataset.py`](#generate-expert-datasetpy) | Generate | Model-balanced runner for the clustered tiers (medium, expert). Used for the release. |
| [`generate-presets.js`](#generate-presetsjs) | Generate | One generation job: a bank of validated presets for one base and tier |
| [`validate-presets.js`](#validate-presetsjs) | Validate | Independent replay of a bank; pass/fail report, final dot positions, per-step traces |
| [`rebalance-anchors.py`](#rebalance-anchorspy) | Select | Re-chooses which dot in each group is tracked, so position roles sit at chance |
| [`render_dataset_parallel.py`](#render_dataset_parallelpy) | Render | Renders a bank into `dataset.jsonl`, images and metadata with parallel workers |
| `render-dataset.js` | Render | One render worker (called by `render_dataset_parallel.py`) |
| [`check-dataset.py`](#check-datasetpy) | Check | Re-derives every answer from its preset; checks ids, images, metadata and question text |
| [`shortcut-baselines.py`](#shortcut-baselinespy) | Audit | Position-only baselines, least-turn rate and twin facing against chance |
| [`build-probes.py`](#build-probespy) | Audit | Final-only and first+last image variants of a `dataset.jsonl` |
| [`score-predictions.py`](#score-predictionspy) | Score | Reference scorer: exact set match, F1, format adherence, chance |
| [`eval-claude.py`](#eval-claudepy) | Score | Answers a dataset with Claude through the Claude Code CLI |
| [`build-eval.py`](#build-evalpy-earlier-eval-set) | Earlier sets | Builds the earlier `eval/` set (select, replay, plan, assemble) |
| [`generate-uniform-1000.py`](#uniform-1000-tools) | Earlier sets | Orchestrates the uniform-1000 set |
| `assemble-uniform-1000.py` | Earlier sets | Assembles uniform-1000 shards into one bank |
| `generate-matrix.js` | Earlier sets | Runs (base, tier) generation slots in parallel |
| `reverse-presets.js` | Earlier sets | Reverses a bank's steps for folded → flat variants |
| [One-off scripts](#one-off-scripts) | — | Subset and merge builders from earlier experiments |

The build scripts of the released dataset live in [`release/dataset-300b/`](../release/dataset-300b/).

## Generate

### generate-expert-dataset.py

Generates a model-balanced bank for a clustered tier: medium (`--difficulty 3`) or expert (`--difficulty 5`, the default).

```bash
DATASET_DIR=new_dataset/expert-render PORT=3001 bun run dev
python3 tools/generate-expert-dataset.py --difficulty 5 --total 60 --models bird,pinwheel \
  --out-dir new_dataset/expert --render-dir new_dataset/expert-render --skip-render
```

**How it runs.** The runner schedules **jobs**. Each job is one `generate-presets.js` call for one base, with seed `base_seed + 7919·job`. Its bank is then replayed with `validate-presets.js` at `--settle-ms`. Only presets that pass the replay count.

- **Worker allocation.** Bases below their goal share the workers, and the base furthest behind goes first.
- **Dry bases.** A base stops receiving jobs after `--max-dry-jobs` consecutive jobs without a new valid preset.
- **Time cap.** No new jobs start after `--max-hours`.
- **Resuming.** Rerunning the command resumes from `<out-dir>/jobs/`.

**Assembly** keeps presets that meet the tier contract and dedups them by content. It then splits `--total` over bases as yields allow. Within each base, it:

- spreads picks over camera views;
- keeps at most three presets per set of dotted panels;
- picks so that the middle-dot, least-turn and twin-facing rates stay near chance (`balance_middle`).

It writes `<out-dir>/assembled.json` and `summary.json`, then renders into `--render-dir` unless `--skip-render` is set. Mapfold is refused, because it carries no rotation for twins.

| Option | Default | Meaning |
|---|---|---|
| `--difficulty` | 5 | 3 (medium) or 5 (expert) |
| `--total` | 300 | Presets in the assembled bank |
| `--models` | all but mapfold | Comma-separated base keys (`bird,waterbomb,pinwheel,boat,opensink,square,simplevertex`) |
| `--out-dir`, `--render-dir` | `new_dataset/expert-300`, `…-render` | Job records and bank; render output (must equal the server's `DATASET_DIR`) |
| `--server-url` | `http://localhost:3001` | Dev server |
| `--workers` | CPUs − 6, at most 26 | Concurrent jobs |
| `--count-per-job` | 10 | Presets requested per job |
| `--base-seed` | 50021 | Seed of job 0 |
| `--max-hours`, `--max-dry-jobs`, `--job-timeout-min` | 12, 10, 480 | Run limits |
| `--settle-ms` | 800 | Validation replay settle per step |
| `--rotation-profile-count` | 180 expert, 60 medium | Rotation profiles tried per camera view |
| `--profile-override`, `--settle-override` | — | Per-base profile count or search settle, e.g. `square=800` |
| `--cluster-points LO,HI` | tier default | Dots in the final image, twins included |
| `--cluster-group-size LO,HI` | 1,4 | Dots per group, before twins |
| `--cluster-scatter LO,HI` | none | Scatter dots per preset, before twins |
| `--cluster-back-groups LO,HI` | tier default | Expert back groups; `0,0` gives front-only expert items |
| `--cluster-end-sizes LO,HI` | none | Range of last-image size multiples |
| `--cluster-spin-turns T` | 0.5 | Medium spin range in turns (±T) |
| `--symmetric-twins` | off | Twins of tracked dots must meet the tracked dots' rules; costs most of the yield |
| `--import GLOB` | — | Validate and include existing banks |
| `--assemble-only`, `--skip-render`, `--render-workers` | — | Skip stages, or set render parallelism |

The cluster options reach generation, the validation replay and the assembly contract, so concurrent runs with different settings can share one server.

### generate-presets.js

One generation job: loads a base in headless Chromium, runs the in-page generator for a tier, and writes a bank of presets that passed in-page validation.

```bash
bun tools/generate-presets.js --model /Bases/birdBase.svg --difficulty 3 \
  --count 2 --base-name smoke-bird-d3 --seed 42 --output /tmp/smoke-bird-d3.json
```

**Main options:**

| Group | Options |
|---|---|
| Job | `--model`, `--difficulty` (1–5), `--count`, `--base-name`, `--start-index`, `--seed`, `--output`, `--merge`, `--server-url` (default `http://localhost:3000`) |
| Search | `--build-progressions`, `--max-trajectory-candidates`, `--max-scan-candidates`, `--rotation-profile-count`, `--scan-settle-ms` (default 300), `--expert-motion-style` (`detour`, `pendulum`, `tumble`, `spin`), `--templates` |
| Legibility | `--min-point-view-quality` (default 0.3), `--min-point-separation-px` (default 70; clustered tiers use their own floor when unset), `--enforce-separation-all-steps`, `--final-fold` |
| Clustered layout | the `--cluster-*` options above, `--symmetric-twins` |
| Validation | `--settle-ms`, `--no-validate` |

Options are parsed leniently, so a misspelled option is ignored rather than reported.

### validate-presets.js

Replays every preset of one or more banks in a fresh page and applies the tier's validation rules. It exits 1 if any preset fails.

```bash
bun tools/validate-presets.js --inputs bank.json --settle-ms 800 --report validation.json
bun tools/validate-presets.js --inputs bank.json --settle-ms 800 --trace --report trace.json
```

- **`--report`** writes per-preset results, including each dot's final screen position and viewing ratio (`quality.finalScreens`, `quality.finalViewQuality`) and the label-crossing count. These feed the audits and selection.
- **`--trace`** records every dot's visibility, viewing ratio and screen position at every step, instead of validating. It also records how each symmetry of the folded model acts (`symmetryReport`).
- **Other options:** `--glob`, `--server-url`, `--min-point-view-quality` (to audit an older bank against a new threshold), the `--cluster-*` options, and `--max-per-slot`.

## Select

### rebalance-anchors.py

Keeps every preset and re-chooses which dot in each group is tracked, instead of dropping presets until position roles reach chance. Dots do not move; only the `hidden` flags change.

A dot is eligible when two conditions hold: it is visible and readable at every step in a `--trace` report, and it keeps the spacing floor from the other tracked dot before the last step. The tool draws tracked dots uniformly from the eligible ones. It then switches single groups while that brings three per-base counts closer to chance: how often the tracked dot is its group's **middle**, **most isolated** and **outermost** dot. A tracked dot tied with k others for a role scores 1/k.

```bash
bun tools/validate-presets.js --inputs bank.json --settle-ms 800 --trace --report trace.json
python3 tools/rebalance-anchors.py --bank bank.json --trace trace.json --out rebalanced.json
bun tools/validate-presets.js --inputs rebalanced.json --settle-ms 800 --report validation.json
```

The earlier `eval/` set used it. The release balances by selection instead ([design.md § 2](../docs/design.md#2-position-within-a-group--sampled-placement-and-balancing)).

## Render

### render_dataset_parallel.py

Splits a bank into shards and runs one `render-dataset.js` worker per shard. Failed shards are retried and split. The output (`dataset.jsonl`, `<id>/step_NNNN_current.png`, `metadata/`) goes to the server's `DATASET_DIR`, and the renderer must be given the same `DATASET_DIR` in its environment.

```bash
DATASET_DIR=new_dataset/my-render PORT=3022 bun run dev
DATASET_DIR=new_dataset/my-render python3 tools/render_dataset_parallel.py \
  --dataset bank.json --server-url http://localhost:3022 --workers 6
```

| Option | Meaning |
|---|---|
| `--workers` | Default about 7/8 of the CPUs, at most 28 |
| `--skip-existing` | Skip a preset only when its configuration, metadata, JSONL row and every image already match |
| `--chunk-size`, `--max-retries`, `--timeout-sec`, `--no-split-on-fail` | Job control |
| `--run-id`, `--runs-dir`, `--keep-shards` | Logs and the run report (default `tools/.render-parallel-runs/<run-id>/`) |

Start runs at least a second apart, or pass distinct `--run-id`s.

Each replay resets the solver to the flat sheet before applying the preset, even when a worker reuses a loaded base. Re-rendering a preset replaces its JSONL row.

`render-dataset.js --skip-existing`, run on its own, applies the same check against `DATASET_DIR` in its environment.

## Check and audit

### check-dataset.py

```bash
python3 tools/check-dataset.py new_dataset/dataset-300b
```

Re-derives every answer from the preset stored in the metadata. It fails on any of these:

- answers that disagree with their preset;
- duplicate ids;
- missing images or metadata;
- unsubstituted placeholders;
- question text from an old template;
- a dot-size sentence in the question that does not match whether the preset has `endDotSizes`.

### shortcut-baselines.py

```bash
python3 tools/shortcut-baselines.py --bank bank.json --report validation.json
```

Checks whether a bank can be answered from the final image's layout, or by first-and-last-frame matching. It reads final dot positions and viewing ratios from a validation report or a `--trace` report. It exits 1 when a baseline beats chance by more than `--max-z` standard errors (default 3).

**What it reports:**

- how often the tracked dot is its group's middle dot (ties share credit);
- a most-central-dots baseline;
- how often dots stand apart from every other dot, for tracked and other dots;
- how often the real final pose is the smaller of the two turns a first-and-last solver must choose between;
- how often tracked groups face the camera more than their twin groups.

[design.md § Audits](../docs/design.md#audits) explains each check.

### build-probes.py

```bash
python3 tools/build-probes.py new_dataset/dataset-300b
```

Writes four files next to `dataset.jsonl`, keeping each row's id and answer:

| File | Images | Question text |
|---|---|---|
| `probe_final_only.jsonl` | last image only | unchanged |
| `probe_first_last.jsonl` | first and last images | unchanged |
| `probe_final_only_reworded.jsonl` | last image only | task paragraph rewritten for the image actually sent |
| `probe_first_last_reworded.jsonl` | first and last images | task paragraph rewritten for the images actually sent |

Rewording needs forward-template questions. The tool stops on reverse datasets.

## Score

### score-predictions.py

```bash
python3 tools/score-predictions.py --dataset DIR/dataset.jsonl --predictions preds.jsonl --out scored.jsonl
```

Predictions are JSONL lines of `{"id", "response"}` (raw model text) or `{"id", "answer"}`. Probe files share ids with `dataset.jsonl`, so either can be the `--dataset`.

| Metric | Meaning |
|---|---|
| Exact match (headline) | Predicted letter set equals `gt_answer`, order ignored; reported with a 95% Wilson interval |
| Chance | Expected exact score from guessing the right number of letters at random |
| F1 | Letter-level partial credit |
| `format_ok` | The response was exactly one `{"answer": [...]}` object. A correct answer wrapped in prose still scores. |

Unparsed, invalid and missing predictions score zero and are counted separately. Duplicate prediction ids are an error.

### eval-claude.py

```bash
python3 tools/eval-claude.py --dataset DIR/dataset.jsonl --out preds.jsonl [--model claude-opus-5-5] [--workers 4]
```

Sends each row to Claude through the Claude Code CLI (`claude -p`, using the CLI's login) with tools disabled:

- the system prompt is "You are a helpful assistant.";
- the images come before the question;
- the question ends with a JSON-only suffix.

The tool appends to `--out` and resumes from it, and it retries overloaded responses with backoff. `release/dataset-300b/score.sh` uses it for the reference results.

## Earlier sets

### build-eval.py (earlier `eval/` set)

Built `eval/` (2026-10-01): 150 medium and 150 expert presets over seven bases, 21–22 per (tier, base), from the pools `new_dataset/medium-v2` and `new_dataset/expert-v3-150`. It predates twin decoys. Its subcommands, in order:

| Step | Subcommand | What it does |
|---|---|---|
| 1 | `select` | Picks `--candidates` presets per cell (default 26), favoring unused tracked-panel pairs, panel sets, camera views, motion styles, source jobs and distant final viewing directions. No two presets in a cell share a trajectory. |
| 2 | `replay` | Runs `validate-presets.js` (optionally `--trace`) in parallel chunks (`--chunks`, default 4). A chunk silent for 90 s is restarted, up to three attempts. |
| 3 | — | Run `rebalance-anchors.py` on the traces, then replay again. |
| 4 | `plan` | Makes the final pick and reorders each preset's points, so every answer letter pair is used equally often per tier. `--keep-previous` grows an earlier set while keeping its picks and letters. |
| 5 | `assemble` | Keeps candidates that passed validation and rendered correctly, then writes `eval/` with `presets.json`, `validation.json` and a `manifest.json` of per-cell spread and audits. |

Its `MODELS` list includes mapfold, as the 2026-10-01 pools did. `generate-expert-dataset.py` no longer produces mapfold, so with new pools `select` reports the mapfold cells as short, and `plan` and `assemble` stop on them. Pass `--models` without mapfold, or `--allow-short`.

### uniform-1000 tools

`generate-uniform-1000.py` runs generation passes, assembly (`assemble-uniform-1000.py`) and rendering for the 1008-item set of tiers 1, 3 and 4. It uses `generate-matrix.js` to run (base, tier) slots in parallel:

- one prewarm pass at the first tier, then the rest;
- `--no-prewarm` to disable it;
- `--shards-per-slot` to split later tiers' slots.

Both scripts skip mapfold at tiers 3 and 5 with a log line, since those tiers cannot twin it. `assemble-uniform-1000.py --include-expert` reads the expert frame count from `js/presetGenerator.js`.

[docs/uniform-1000.md](../docs/uniform-1000.md) has the commands. Tier 3 is now the clustered medium tier, so regenerating that set needs commit `eaadafe`.

`reverse-presets.js --input bank.json --output reversed.json` reverses every preset's steps and sets `direction: "reverse"`, giving folded → flat variants. Rows rendered from reversed presets use the reverse question template.

## One-off scripts

These scripts built subsets and merges for earlier experiments. They are kept so that those artifacts can be traced, but they are not part of the release pipeline:

- `build-combined-1000.py`, `build-expert-hard-300.py`
- `build-mini-1.py`, `build-mini-3.py`, `build-mini-48.py`, `merge-mini-1.py`
- `shuffle-point-labels.py`, `expert_trial.py`

Several read directories that no longer exist.

## Tests

```bash
bun run test:dataset
```

| File | Covers |
|---|---|
| `generation.test.js` | Generator and validator logic: viewpoint coverage, rotation precision, cache identity, marker clearance, cluster layouts, twins, spin. Also the matrix's mapfold skip, `render-dataset.js --skip-existing` and `reverse-presets.js` |
| `output.test.js` | The server's output endpoints, against a temporary server and directory |
| `test_*.py` | Assembly and balancing, selection, audits, probes, scoring, dataset checks, rebalancing |

None of the tests needs a running server or WebGL; use `validate-presets.js` and a render for those.
