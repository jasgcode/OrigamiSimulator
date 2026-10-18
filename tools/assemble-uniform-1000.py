#!/usr/bin/env python3
"""Assemble distinct examples from all uniform-1000 shards, cap each cell,
and assign sequential output names. Presets with identical content count
once even if continuation passes change their names or seeds.
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "new_dataset" / "uniform-1000"
OUT_PATH = SRC_DIR / "assembled.json"

CELLS = [
    "simplevertex-d1", "simplevertex-d3", "simplevertex-d4",
    "bird-d1",         "bird-d3",         "bird-d4",
    "waterbomb-d1",    "waterbomb-d3",    "waterbomb-d4",
    "pinwheel-d1",     "pinwheel-d3",     "pinwheel-d4",
    "boat-d1",         "boat-d3",         "boat-d4",
    "mapfold-d1",      "mapfold-d3",      "mapfold-d4",
    "opensink-d1",     "opensink-d3",     "opensink-d4",
    "square-d1",       "square-d3",       "square-d4",
]
TARGET_PER_CELL = 42


def generator_expert_frame_count() -> int:
    """Read EXPERT_FRAME_COUNT from js/presetGenerator.js. A copied constant
    went stale when expert sequences grew from 10 to 14 frames."""
    source = (ROOT / "js" / "presetGenerator.js").read_text()
    match = re.search(r"\bvar EXPERT_FRAME_COUNT = (\d+);", source)
    if not match:
        raise RuntimeError("EXPERT_FRAME_COUNT not found in js/presetGenerator.js")
    return int(match.group(1))


EXPERT_FRAME_COUNT = generator_expert_frame_count()


def collect_for_cell(cell: str) -> dict:
    merged = {}
    seen = set()
    patterns = [
        f"{cell}.json",
        f"{cell}-s*.json",          # also matches `{cell}-s<shard>-p<N>.json`
        f"{cell}-p*.json",          # unsharded continuation passes
        f"{cell}-topup*-s*.json",
        f"{cell}-topup*.json",
        f"{cell}-pov*-s*.json",
        f"{cell}-pov*.json",
    ]
    files = []
    for pat in patterns:
        files.extend(sorted(SRC_DIR.glob(pat)))
    for f in sorted(set(files)):
        try:
            with f.open() as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                for name, preset in sorted(data.items()):
                    # Resume must not count banks from earlier expert contracts: other dot
                    # counts, six frames, or fixed placement (no clusterPlacement).
                    if cell.endswith("-d5") and (not isinstance(preset.get("facePoints"), list)
                                                or not 12 <= len(preset["facePoints"]) <= 20
                                                or not (preset.get("clusterPlacement") or {}).get("symmetry")):
                        print(f"[skip] {f.name}::{name}: expert requires 12-20 ordered points with sampled placement",
                              file=sys.stderr)
                        continue
                    if cell.endswith("-d5") and len(preset.get("steps") or []) != EXPERT_FRAME_COUNT:
                        print(f"[skip] {f.name}::{name}: expert requires {EXPERT_FRAME_COUNT} frames", file=sys.stderr)
                        continue
                    # Count cached replays once, even under different names.
                    content = {k: v for k, v in preset.items()
                               if not k.startswith("_") and k not in ("seed", "rngSeed")}
                    signature = json.dumps(content, sort_keys=True, separators=(",", ":"))
                    if signature in seen:
                        continue
                    seen.add(signature)
                    # Keep distinct inputs whose names collide across passes.
                    key = name if name not in merged else f"{name}@{f.stem}"
                    merged[key] = preset
        except Exception as e:
            print(f"[error] {f.name}: {e}", file=sys.stderr)
    return merged


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--include-expert", action="store_true", help="Include tier 5 shards in the assembled bank.")
    args = parser.parse_args()
    cells = CELLS + ([cell.replace("-d4", "-d5") for cell in CELLS if cell.endswith("-d4")] if args.include_expert else [])
    if not SRC_DIR.is_dir():
        print(f"missing {SRC_DIR}", file=sys.stderr)
        return 1

    assembled = {}
    summary = []
    for cell in cells:
        cell_presets = collect_for_cell(cell)
        ordered = dict(sorted(cell_presets.items()))
        capped = list(ordered.items())[:TARGET_PER_CELL]
        for i, (_, preset) in enumerate(capped, start=1):
            assembled[f"{cell}-{i:02d}"] = preset
        summary.append((cell, len(cell_presets), len(capped)))

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp_path = OUT_PATH.with_suffix(".json.tmp")
    with temp_path.open("w") as fh:
        json.dump(assembled, fh, indent=2)
        fh.write("\n")
    temp_path.replace(OUT_PATH)

    print("\n=== assembly summary ===")
    print(f"{'cell':<16} {'available':>10} {'kept':>6}")
    for cell, avail, kept in summary:
        print(f"{cell:<16} {avail:>10} {kept:>6}")
    total_avail = sum(a for _, a, _ in summary)
    total_kept = sum(k for _, _, k in summary)
    print(f"{'TOTAL':<16} {total_avail:>10} {total_kept:>6}")
    print(f"\nWritten: {OUT_PATH.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
