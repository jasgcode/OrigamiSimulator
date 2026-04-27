#!/usr/bin/env python3
"""One-shot migration: bump eval cache key from v3 (`..._g<N>.json`)
to v4 (`..._g<N>_q<minFaceQ*1000>.json`).

Pass 1 of the orchestrator (matrix runner) writes with `minFaceQuality=0.6`
(generate-presets.js CLI default), so safe v3 caches map to `_q600`.

Continuation passes that explicitly set `--min-face-quality 0.05` or
0.02 wrote to the SAME v3 file, contaminating it with mixed accept
decisions. Those files can't be migrated cleanly — delete them so the
next run rebuilds them.

Contaminated cells are determined by which seeds had continuation runs.
For the most recent orchestrator run:
  - opensink-d1 (seed 12345 only) — Pass 2 contaminated
  - pinwheel-d4 (seeds 12345, 13354, 14363, 15372) — Pass 2-4 contaminated
"""
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "dataset" / ".scan-cache"

CONTAMINATED = {
    # filename substring patterns; matched against file names
    "openSinkBase_svg_d1_s12345_g90",
    "pinwheelBase_svg_d4_s12345_g110",
    "pinwheelBase_svg_d4_s13354_g110",
    "pinwheelBase_svg_d4_s14363_g110",
    "pinwheelBase_svg_d4_s15372_g110",
}


def main() -> int:
    if not CACHE_DIR.is_dir():
        print(f"no cache dir at {CACHE_DIR}", file=sys.stderr)
        return 1

    migrated = 0
    contaminated = 0
    skipped = 0
    for f in sorted(CACHE_DIR.glob("eval_*_g*.json")):
        name = f.name
        # Already has _q (v4): skip.
        if "_q" in name.split("_g")[-1]:
            skipped += 1
            continue

        # Has _p in name (very old v2 key): skip — orphaned anyway.
        if "_p" in name.split("_d")[-1].split("_g")[0]:
            skipped += 1
            continue

        # Contaminated by continuation passes with different minFaceQuality?
        is_contaminated = any(c in name for c in CONTAMINATED)
        if is_contaminated:
            f.unlink()
            print(f"  deleted (contaminated): {name}")
            contaminated += 1
            continue

        # Migrate: add _q600 and bump version.
        new_name = name.replace(".json", "_q600.json")
        new_path = f.with_name(new_name)
        try:
            with f.open() as fh:
                data = json.load(fh)
            data["version"] = 4  # bump to v4
            with new_path.open("w") as fh:
                json.dump(data, fh, indent=2)
            f.unlink()
            migrated += 1
        except Exception as e:
            print(f"  failed {name}: {e}", file=sys.stderr)

    print(f"\n[summary] migrated={migrated}, contaminated={contaminated}, skipped={skipped}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
