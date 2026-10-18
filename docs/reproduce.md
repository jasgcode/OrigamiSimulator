# Reproducing the dataset and results

There are three levels of reproduction, from cheapest to most expensive:

1. **Evaluate a model** on the released dataset.
2. **Re-render** the released presets. This produces the same 300 items with the same answers.
3. **Regenerate** from scratch. This produces a comparable dataset, not the same one.

All commands run from the repository root. The files for levels 2 and 3 are in [`release/dataset-300b/`](../release/dataset-300b/).

## Prerequisites

| Needed for | Requirement |
|---|---|
| Everything | Linux or macOS, [Bun](https://bun.sh) ≥ 1.3 (1.3.8 was used), Python ≥ 3.10 (3.12 was used; the tools use only the standard library) |
| Rendering, generation | `bun install` (installs Puppeteer), then `bunx puppeteer browsers install chrome` |
| Reference scores | The [Claude Code](https://claude.com/claude-code) CLI, logged in |

**The simulator itself needs no install.** Its JavaScript dependencies are vendored in `dependencies/`.

**Hardware.** Rendering and generation drive headless Chromium with software WebGL (SwiftShader). Each worker uses about one CPU core and 600–800 MB of RAM. The release was built on a 32-thread, 128 GB Linux machine, with at most 28 workers at a time.

## 1. Evaluate a model

> **Download:** the rendered dataset is hosted on Hugging Face at `TODO: add the dataset URL`.

Unpack it to `dataset-300b/`. Give each row's `question` and `images` to the model, with the images inserted at the `{images}` marker. Collect one `{"id": …, "response": …}` line per row and score:

```bash
python3 tools/score-predictions.py --dataset dataset-300b/dataset.jsonl \
  --predictions predictions.jsonl --out scored.jsonl
```

[dataset.md](dataset.md) covers the row schema, the scorer's metrics, and the probe files that send fewer images.

## 2. Re-render the released presets

```bash
bash release/dataset-300b/render.sh release/dataset-300b/presets.json new_dataset/dataset-300b
```

`render.sh` does four things:

1. Starts its own dev server on port 3050 (pass a third argument for another port).
2. Renders every preset with `tools/render_dataset_parallel.py`. It uses 6 workers by default; set `RENDER_WORKERS` to change this. The original render took about half an hour with 6 workers.
3. Re-derives every answer from its preset with `tools/check-dataset.py`.
4. Writes the probe files with `tools/build-probes.py`.

Item ids, questions and answers depend only on the presets, so they match the release exactly. Images come from software WebGL. They are deterministic on one machine but can differ by a few pixels across platforms.

Each replay loads the base, resets the solver to the flat sheet, then steps through the preset's fold amounts and rotations. Every step waits the preset's `pauseDuration` (1 s for every released preset) for the solver to settle before capturing. Generation validated each preset with an independent 800 ms replay.

## 3. Regenerate from scratch

Regeneration repeats the whole pipeline: trajectory search, dot placement, validation, selection and rendering. Generation is not bit-reproducible, for three reasons:

- The GPU solver's settle timing varies.
- Each run stops launching jobs at a wall-clock cap (`--max-hours`).
- Worker scheduling changes which jobs finish first.

A rerun therefore yields banks with the same rules and seeds but different presets.

**Step 1. Start a dev server for generation.** Its `DATASET_DIR` holds the trajectory-search cache, and the generator checks that it matches `--render-dir`:

```bash
DATASET_DIR=new_dataset/climb/render PORT=3001 bun run dev
```

**Step 2. Generate the fifteen source banks.** In a second terminal:

```bash
bash release/dataset-300b/generate.sh
```

[`generate.sh`](../release/dataset-300b/generate.sh) lists every run with its seed and settings. `DRY_RUN=1` prints the commands without running them, and naming runs runs only those, for example `generate.sh r11-d3 r5-d5`. The runs are:

| Tier | Runs | Bases | Dots | Other settings |
|---|---|---|---|---|
| Medium | `r11-d3`, `r11-d3-topup`, `r11-d3-topup2`, `s300-d3`, `s300-d3b` | all six | 20 | scatter 3–5, groups 2–4, end sizes 0.6–1.4, spin ±0.75 turn |
| Expert | `r5-d5`, `r5-d5-bird2`, `s300-d5`, `s300-d5b`, `bal-d5` | bird, pinwheel (waterbomb in `r5-d5`) | 22 | scatter 3–5, groups 2–4, end sizes 0.75–1.25 |
| Expert | `r5-d5-waterbomb2`, `s300-d5-waterbomb`, `bal-d5-waterbomb` | waterbomb | 16–18 | scatter 1–2, groups 1–4, end sizes 0.75–1.25 |
| Expert filler | `r5-d5-front180`, `s300-d5-front180` | boat, open sink, square | 22 | as above, no back dots |

Each run writes `new_dataset/climb/<run>-bank/` and logs to `new_dataset/climb/gen-<run>.log`. Each job inside a run does three things:

1. Calls `tools/generate-presets.js`.
2. Replays the job's presets at 800 ms with `tools/validate-presets.js`.
3. Records which presets passed.

The run then assembles the passing presets into `assembled.json`.

Each run stops launching jobs after its wall-clock cap, which is 2–10 hours. The original runs ran partly in parallel between 2026-10-06 and 2026-10-09.

**Step 3. Select, audit and render:**

```bash
bash release/dataset-300b/build.sh new_dataset/dataset-300b
```

[`build.sh`](../release/dataset-300b/build.sh) runs the selection in three steps:

| Step | Script | What it does |
|---|---|---|
| 1 | `select-100.py` | Picks 50 medium and 50 expert presets, split evenly over bases. Seed 20261006. |
| 2 | `select-300.py` | Grows the medium half to 150, keeping step 1's items, and spreads picks over camera views and panel sets. Seed 20261007. |
| 3 | `select-300b.py` | Keeps step 2's medium half. Picks 150 expert presets from every preset that passed validation, balancing three cues per base (below). Deterministic. |

The three cues step 3 balances, with the target for each:

| Cue | Target |
|---|---|
| Tracked groups facing the camera more than their twin groups | About half the time |
| The real final pose being the smaller of the two turns | About half the time |
| The tracked dot being its group's middle dot | Chance |

Selection writes to `new_dataset/climb/selection/`. `build.sh` then runs the shortcut audit ([design.md § Audits](design.md#audits)) and `render.sh`.

Run against the original source banks, the selection rebuilds `presets.json` and `provenance.json` byte for byte. Against regenerated banks it reports that they differ, which is expected.

**Reference audit output.** On the release, the audit prints:

| Tier | Tracked dot is the middle dot | Real pose is the least turn | Tracked group faces camera more than its twin |
|---|---|---|---|
| Medium | 0.353 (chance 0.368) | 0.427 | 0.509 |
| Expert | 0.340 (chance 0.344) | 0.513 | 0.539 |

On both tiers, no position-only baseline beats chance.

**Code state.** The source banks were generated between 2026-10-06 and 2026-10-09. During that window the generator gained two things:

- the opt-in `--symmetric-twins` option, which the release does not use;
- twin-facing balancing at assembly.

The current tree is the one that selected and rendered the release. A regenerated `assembled.json` is therefore also balanced for twin facing, while the original medium banks were not.

## 4. Reproduce the reference scores

```bash
bash release/dataset-300b/score.sh new_dataset/dataset-300b
```

This answers every row of `dataset.jsonl` and of `probe_first_last_reworded.jsonl` with Claude Opus 5.5 through `claude -p`, with tools disabled. It then prints exact match by tier and base. Predictions resume from an existing file, so delete the `predictions-*.jsonl` files to re-ask every row. One sampled run varies by a few points: re-asking the same 150 medium items in an earlier render gave 46% against the release's 45.3%.

## Tests

```bash
bun run test:dataset
```

This runs 73 JavaScript tests (generator logic, validation, and the server's output endpoints) and 104 Python tests (assembly, selection balancing, audits, probes, scoring, dataset checks). None of them needs a running server or a browser. Use the render and validation commands above for WebGL checks.

## Earlier datasets

- **uniform-1000** (tiers 1, 3, 4) was generated with the code at commit `eaadafe`. Tier 3 has since been replaced by the clustered medium tier, so regenerating that set needs that commit. See [uniform-1000.md](uniform-1000.md).
- **`eval/`** (2026-10-01) was built with `tools/build-eval.py` from banks that included mapfold. The current clustered tiers exclude mapfold, so with new banks `build-eval.py` stops on the empty mapfold cells unless it gets `--models` without mapfold or `--allow-short`.
