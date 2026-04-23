# Test Suite

## Setup

```bash
cd test_suite
uv sync
```

Add your API credentials to `.env`:

```
API_KEY=your-key
BASE_URL=https://chat.intern-ai.org.cn/api/v1
MODEL=internvl3.5-latest
```

Notes:
- `API_KEY` is required. By default, the model config reads from `API_KEY`.
- `BASE_URL` and `MODEL` env vars override Hydra model config values.

## Usage

```bash
uv run eval.py                                        # run all benchmarks
uv run eval.py --benchmarks bird-track-7 bird-track-8 # specific benchmarks
uv run eval.py --dry-run                              # print questions only
uv run eval.py --concurrency 8                        # parallel requests
uv run eval.py --output results/my_run.json           # custom output path
uv run eval.py --wandb on --wandb-project origami-eval # CLI wandb override
uv run eval.py eval.max_tokens=32768                  # Hydra override
uv run eval.py model=internvl_baseline                # choose model config group
```

Results are saved to `results/` as JSON.

## Hydra config

Hydra is wired into `eval.py` for scalable model/runtime configuration.

```
configs/
  config.yaml                       # root config (defaults + eval settings)
  model/
    internvl_baseline.yaml          # VLM endpoint config
  wandb/
    default.yaml                    # W&B logging config
  task/
    origami_tracking.yaml           # point tracking question template
    origami_separation.yaml         # side separation question template
```

Override values at runtime via Hydra-style CLI args:

```bash
uv run eval.py eval.max_tokens=32768 eval.temperature=0.0 eval.max_concurrency=8
uv run eval.py wandb.mode=on wandb.project=origami-eval wandb.tags='[baseline,internvl]'
uv run eval.py task=origami_separation                    # switch task type
uv run eval.py task.question_template="Custom question: {num_initial} dots, labels: {all_labels}"
```

### Task configs

Task configs define how eval questions are constructed from benchmark metadata. The simulator outputs `metadata.json` (images + point info + difficulty), and the task config specifies the question template and answer derivation.

| Field | Description |
|-------|-------------|
| `name` | Task identifier |
| `answer_type` | Comparison mode: `list`, `yes_no`, `integer`, `float`, `multiple_choice`, `free_text` |
| `answer_key` | Metadata field to derive the answer from (e.g. `initialPoints`) |
| `question_template` | Python format string interpolated with metadata fields |

Available template variables: `{num_initial}`, `{all_labels}`, `{total_points}`, `{difficulty}`.

To add a new task type, create `configs/task/<name>.yaml` and run with `task=<name>`.

### Config precedence

Model endpoint settings:
1. Environment variables (`MODEL`, `BASE_URL`)
2. Hydra model config (`configs/model/*.yaml`)

Wandb settings:
1. CLI flags (`--wandb`, `--wandb-project`, `--no-wandb`)
2. Hydra wandb config (`configs/wandb/*.yaml`)

### Metadata format

The simulator outputs `metadata.json` per benchmark (replaces the old `dataset.json`). Legacy `dataset.json` files are still supported for backwards compatibility.

```json
[{
  "id": 1,
  "images": ["benchmark-name/step01.png", ...],
  "benchmark": "benchmark-name",
  "difficulty": 5,
  "totalPoints": 5,
  "initialPoints": ["B", "C"],
  "hiddenPoints": [0, 3, 4],
  "allLabels": ["A", "B", "C", "D", "E"],
  "hiddenPointLabels": {"0": "A", "3": "B", "4": "C"}
}]
```

### Difficulty tiers

`difficulty` in metadata reflects the benchmark preset's difficulty field (1–5):

| Tier | POV / rotation | Sides visible in final state |
|------|----------------|------------------------------|
| 1 | Static POV, no rotation | One side only |
| 2 | Static POV, no rotation | Both sides |
| 3 | Small POV change / rotation across progression | One side only |
| 4 | Small POV change / rotation across progression | Both sides |
| 5 | Major POV change / rotation across progression | Both sides |

Current baseline model config values:
- `name: internvl3.5-latest`
- `base_url: https://chat.intern-ai.org.cn/api/v1`
- `context_window: 32768`
- `max_output_tokens: 32768`
