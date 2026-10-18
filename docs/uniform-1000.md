# The uniform-1000 set (earlier release)

uniform-1000 is the first dataset built with this code: 1008 items over eight bases and three tiers. It predates the clustered tiers described in [design.md](design.md) and is not part of the current release. This page records how it was built.

## Composition

24 cells × 42 items = **1008 items**:

- **Bases (8):** simplevertex, bird, waterbomb, pinwheel, boat, mapfold, open sink, square.
- **Tiers (3):** 1 (`easy`), 3 (`medium`, in its earlier form) and 4 (`hard`).

| | Tier 1 `easy` | Tier 3 `medium` (earlier rules) | Tier 4 `hard` |
|---|---|---|---|
| Images | 5 | 10 | 10 |
| Tracked front dots (answer) | 2 | 2 | 2 |
| Hidden front decoys | 1–3 | 1–3 | 1–2 |
| Hidden back decoys | none | none | 1–2 |
| Motion | Constant tilted pose, no motion between images | Rotation ramping to a crest near the last image | Rotation ramping monotonically to its peak at the last image |
| Rotation bounds (yaw, pitch, roll) | 0.5, 0.15, 0.08 rad | 0.8, 0.5, 0.2 rad | 1.4, 1.3, 0.4 rad |

In all three tiers:

- The two sides of the paper have different colors.
- Dots use the default radius of 0.025, with at least 70 px between them.
- The first image of tiers 3 and 4 shows the flat sheet at zero rotation. Tier 1 keeps its tilt in the first image too.

## Regenerating it

The set was generated with the code at commit `89f3dee` (2026-05-15). Tier 3 has since become the clustered medium tier, which cannot use mapfold. Running the current orchestrator therefore does two things: it generates new-style tier 3 items, and it skips the mapfold tier 3 cell, which the clustered tier cannot use. To regenerate the original set, check out that commit:

```bash
git checkout 89f3dee
DATASET_DIR=new_dataset/uniform-1000-render bun run dev     # terminal 1
python3 tools/generate-uniform-1000.py                      # terminal 2
```

The orchestrator ([`tools/generate-uniform-1000.py`](../tools/generate-uniform-1000.py)) runs three stages:

1. **Generation.** A first pass, then continuation passes that top up short cells.
2. **Assembly.** [`tools/assemble-uniform-1000.py`](../tools/assemble-uniform-1000.py) dedups by preset content and caps each cell at 42.
3. **Rendering.** Rendering into the server's `DATASET_DIR`.

It refuses to start if the server's `DATASET_DIR` does not match `new_dataset/uniform-1000-render`. It resumes from existing shards; `--fresh` discards generated presets and renders but keeps the trajectory cache.

| Path | Contents |
|---|---|
| `new_dataset/uniform-1000/` | Shard banks and `assembled.json` |
| `new_dataset/uniform-1000-logs/` | Generator logs |
| `new_dataset/uniform-1000-render/` | `dataset.jsonl`, images, `metadata/`, `.scan-cache/` |

**Seeds and top-ups.** The canonical seed is 12345. Some cells (mapfold tiers 3 and 4, pinwheel tier 4) do not reach 42 items from one seed. Re-running with the same seed adds nothing, because continuation passes are deterministic. `--resume --base-seed <N>` with any other seed adds a **top-up** batch, which:

- seeds every shard from N, so it explores fresh trajectories;
- offsets preset numbers by 1000, so names never collide with the canonical batch;
- tags shard files `-seed<N>`.

The assembler sorts preset names before capping, so canonical presets fill each cell first.

**Determinism.** With the same seed, a warm trajectory cache and the same source tree, the run produces an identical `assembled.json`. Images come from software WebGL. They are deterministic on one machine but can differ slightly across platforms.

## Known issues in the rendered set

**Thin back pools.** Open sink and pinwheel at tier 4 have few back faces that stay readable, so presets within those cells often share their hidden back faces.

The renderer once appended a second row when a preset was re-rendered under the same id. In `uniform-1000-render`, 49 ids had repeated rows, and for 40 of them the earlier row's answer no longer matched the images. `dataset.jsonl` now keeps the last row per id and only the 1008 assembled presets; the original is saved as `dataset.jsonl.pre-dedup`. The server now replaces rows by id.
