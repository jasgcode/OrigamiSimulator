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

## Usage

```bash
uv run eval.py                                        # run all benchmarks
uv run eval.py --benchmarks bird-track-7 bird-track-8 # specific benchmarks
uv run eval.py --dry-run                              # print questions only
uv run eval.py --concurrency 8                        # parallel requests
uv run eval.py --output results/my_run.json           # custom output path
```

Results are saved to `results/` as JSON.
