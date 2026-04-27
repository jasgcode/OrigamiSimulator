#!/usr/bin/env python3
"""
Assemble all preset files for new_dataset/uniform-1000 into a single JSON
with exactly TARGET_PER_CELL presets per cell.

Walks every JSON file matching `<cell>{,-s*,-topup*-s*}.json` for each
cell, merges (later writes win on key collision), sorts alphabetically by
preset name, takes the first N, and renumbers them 01..N within the cell
so the renderer's per-preset directory naming gets a unique destination
per preset.

Lives in tools/ (not in new_dataset/uniform-1000-logs/) so the orchestrator
can wipe the logs dir freely without losing this script.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "new_dataset" / "uniform-1000"
OUT_PATH = SRC_DIR / "assembled.json"

CELLS = [
    "bird-d1", "bird-d3", "bird-d4",
    "waterbomb-d1", "waterbomb-d3", "waterbomb-d4",
    "pinwheel-d1", "pinwheel-d3", "pinwheel-d4",
    "opensink-d1", "opensink-d3", "opensink-d4",
]
TARGET_PER_CELL = 84


def collect_for_cell(cell: str) -> dict:
    merged = {}
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
    for f in files:
        try:
            with f.open() as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                merged.update(data)
        except Exception as e:
            print(f"[error] {f.name}: {e}", file=sys.stderr)
    return merged


def main() -> int:
    if not SRC_DIR.is_dir():
        print(f"missing {SRC_DIR}", file=sys.stderr)
        return 1

    assembled = {}
    summary = []
    for cell in CELLS:
        cell_presets = collect_for_cell(cell)
        ordered = dict(sorted(cell_presets.items()))
        capped = list(ordered.items())[:TARGET_PER_CELL]
        for i, (_, preset) in enumerate(capped, start=1):
            assembled[f"{cell}-{i:02d}"] = preset
        summary.append((cell, len(cell_presets), len(capped)))

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUT_PATH.open("w") as fh:
        json.dump(assembled, fh, indent=2)
        fh.write("\n")

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
