# dataset-300b release files

Everything needed to rebuild the released 300-item dataset (150 medium + 150 expert) from this repository. [docs/reproduce.md](../../docs/reproduce.md) walks through the steps. [docs/dataset.md](../../docs/dataset.md) describes the rendered dataset.

| File | What it is |
|---|---|
| `presets.json` | The 300 exact presets, keyed by preset name (`bird-d3-001` …). Each item's `meta_info.benchmark` names its preset. Rendering this bank reproduces the dataset. |
| `provenance.json` | For each preset, the source run, job and preset name it was selected from. |
| `generate.sh` | The fifteen generation runs (`tools/generate-expert-dataset.py`) that produced the source banks, with their seeds and settings. |
| `select-100.py`, `select-300.py`, `select-300b.py` | The three selection steps, in order. Against the original source banks they rebuild `presets.json` and `provenance.json` byte for byte. |
| `audit.py` | Runs `tools/shortcut-baselines.py` on exactly the selected presets, each matched to its own validation row. |
| `build.sh` | Selection, audit and rendering in one command. |
| `render.sh` | Renders a bank into a dataset directory, checks it, and writes the probe files. |
| `score.sh`, `score-by-base.py` | Answers the dataset with Claude through the Claude Code CLI and scores it by tier and base (the reference results). |

The scripts were first written for the original build and are kept as they ran, except that their paths are now arguments: `--work-dir` (default `new_dataset/climb`) for the source banks. Output names (`dataset-100-bank.json`, `r11-d3-bank`, …) are the run names from that build.
