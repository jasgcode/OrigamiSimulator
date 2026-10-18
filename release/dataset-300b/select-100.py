"""Step 1 of 3 of the dataset-300b selection (ported from new_dataset/climb/build-100.py).

Builds the 100-item point-tracking set: 50 medium items with r11's settings
and 50 expert items with r5's (waterbomb from its 1-2 random-dot pass), each
tier split as evenly over its shapes as the banks allow. Front-only expert
items on the 180-degree bases (boat, open sink, square) fill only the expert
slots that bird, pinwheel and waterbomb cannot. Every source bank is
an assembled bank from generate-expert-dataset.py, so its presets passed the
800 ms validation replay.

Writes the bank with fresh names (<model>-d<tier>-<NN>, unique ids after
rendering) and a provenance file mapping each name to its source preset.
Source banks are read from --work-dir, where release/dataset-300b/generate.sh
writes them.

Usage: select-100.py OUT.json [--work-dir DIR] [--seed N]
"""
import argparse
import json
import random
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCES = {
    3: ["r11-d3-bank/assembled.json", "r11-d3-topup-bank/assembled.json", "r11-d3-topup2-bank/assembled.json"],
    5: ["r5-d5-bank/assembled.json", "r5-d5-bird2-bank/assembled.json", "r5-d5-waterbomb2-bank/assembled.json"],
}
SHAPES = {3: ["bird", "waterbomb", "pinwheel", "boat", "opensink", "square"], 5: ["bird", "pinwheel", "waterbomb"]}
# Used only for slots the tier's own shapes cannot fill.
FILLER = {5: (["r5-d5-front180-bank/assembled.json"], ["boat", "opensink", "square"])}
PER_TIER = 50


def shape_of(preset):
    stem = Path(preset["model"]).stem.lower()
    return next(shape for shape in ("bird", "waterbomb", "pinwheel", "boat", "opensink", "square") if stem.startswith(shape))


def quotas(available, total):
    """Even split of `total` over shapes, capped by what each has; the
    shortfall moves to the shapes with the most left."""
    shapes = sorted(available)
    take = {s: 0 for s in shapes}
    for _ in range(total):
        open_shapes = [s for s in shapes if take[s] < available[s]]
        if not open_shapes:
            break
        # Fewest taken first, then most remaining.
        pick = min(open_shapes, key=lambda s: (take[s], -(available[s] - take[s]), s))
        take[pick] += 1
    return take


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out")
    parser.add_argument("--seed", type=int, default=20261006)
    parser.add_argument("--work-dir", default="new_dataset/climb", help="Directory holding the generated source banks (default: new_dataset/climb).")
    args = parser.parse_args()
    work = ROOT / args.work_dir
    rng = random.Random(args.seed)
    bank, provenance = {}, {}

    def load_pool(tier, sources):
        pool = defaultdict(list)
        for source in sources:
            path = work / source
            if not path.exists():
                print(f"missing {path}; skipped")
                continue
            for name, preset in json.loads(path.read_text()).items():
                if int(preset.get("difficulty", 0)) == tier:
                    pool[shape_of(preset)].append((source, name, preset))
        return pool

    for tier, sources in SOURCES.items():
        pool = load_pool(tier, sources)
        shapes = list(SHAPES[tier])
        available = {shape: len(pool[shape]) for shape in shapes}
        take = quotas(available, PER_TIER)
        print(f"d{tier}: available {available} -> taking {take} = {sum(take.values())}")
        short = PER_TIER - sum(take.values())
        if short and tier in FILLER:
            filler_sources, filler_shapes = FILLER[tier]
            filler = load_pool(tier, filler_sources)
            filler_take = quotas({shape: len(filler[shape]) for shape in filler_shapes}, short)
            print(f"d{tier}: {short} short; filling {filler_take} from front-only 180-degree bases")
            for shape in filler_shapes:
                pool[shape] = filler[shape]
            take.update(filler_take)
            shapes += filler_shapes
        for shape in shapes:
            for k, (source, name, preset) in enumerate(rng.sample(pool[shape], take[shape]), start=1):
                new = f"{shape}-d{tier}-{k:02d}"
                bank[new] = preset
                provenance[new] = {"source": source, "name": name}
    Path(args.out).write_text(json.dumps(bank, indent=1))
    Path(args.out).with_suffix(".provenance.json").write_text(json.dumps(provenance, indent=1))
    print(f"wrote {len(bank)} presets to {args.out}")


if __name__ == "__main__":
    main()
