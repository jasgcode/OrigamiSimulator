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

- Root config: `configs/config.yaml`
- Current baseline model: `configs/model/internvl_baseline.yaml`
- Wandb defaults: `configs/wandb/default.yaml`

You can override values at runtime via Hydra-style CLI args (passed as unknown args to argparse), for example:

```bash
uv run eval.py eval.max_tokens=32768 eval.temperature=0.0 eval.max_concurrency=8
uv run eval.py wandb.mode=on wandb.project=origami-eval wandb.tags='[baseline,internvl]'
```

Config precedence for model endpoint settings:
1. Environment variables (`MODEL`, `BASE_URL`)
2. Hydra model config (`configs/model/*.yaml`)

Config precedence for wandb settings:
1. CLI flags (`--wandb`, `--wandb-project`, `--no-wandb`)
2. Hydra wandb config (`configs/wandb/*.yaml`)

Current baseline config values are:
- `name: internvl3.5-latest`
- `base_url: https://chat.intern-ai.org.cn/api/v1`
- `context_window: 32768`
- `max_output_tokens: 32768`
