"""Step 2 of 3 of the dataset-300b selection (ported from new_dataset/climb/build-dataset.py).
Only its medium half reaches dataset-300b.

Builds a point-tracking set of --per-tier medium and --per-tier expert
items: medium with r11's settings, expert with r5's (waterbomb from its 1-2
random-dot passes). Items of an earlier build (--keep, its provenance file)
stay in; the rest of each tier is split as evenly over its shapes as the
banks allow, spreading picks over camera views and panel combinations.
Front-only expert items on the 180-degree bases (boat, open sink, square)
fill only expert slots that bird, pinwheel and waterbomb cannot. Every source
is an assembled bank from generate-expert-dataset.py, so its presets passed
the 800 ms validation replay. Missing banks are skipped.

Writes the bank with fresh names (<model>-d<tier>-<NNN>) and a provenance
file mapping each name to its source preset.

Usage: select-300.py OUT.json --per-tier 150 [--keep dataset-100-bank.provenance.json] [--work-dir DIR]
"""
import argparse
import json
import random
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "new_dataset/climb"
SOURCES = {
    3: ["r11-d3-bank", "r11-d3-topup-bank", "r11-d3-topup2-bank", "s300-d3-bank", "s300-d3b-bank"],
    5: ["r5-d5-bank", "r5-d5-bird2-bank", "r5-d5-waterbomb2-bank", "s300-d5-bank", "s300-d5b-bank", "s300-d5-waterbomb-bank"],
}
SHAPES = {3: ["bird", "waterbomb", "pinwheel", "boat", "opensink", "square"], 5: ["bird", "pinwheel", "waterbomb"]}
# Used only for slots the tier's own shapes cannot fill.
FILLER = {5: (["r5-d5-front180-bank", "s300-d5-front180-bank"], ["boat", "opensink", "square"])}
ALL_SHAPES = ("bird", "waterbomb", "pinwheel", "boat", "opensink", "square")


def shape_of(preset):
    stem = Path(preset["model"]).stem.lower()
    return next(shape for shape in ALL_SHAPES if stem.startswith(shape))


def quotas(available, total):
    """Even split of `total` over shapes, capped by what each has; the
    shortfall moves to the shapes with the most left."""
    take = {s: 0 for s in available}
    for _ in range(total):
        open_shapes = [s for s in available if take[s] < available[s]]
        if not open_shapes:
            break
        pick = min(open_shapes, key=lambda s: (take[s], -(available[s] - take[s]), s))
        take[pick] += 1
    return take


def view_key(preset):
    """Camera view and panel combination: items sharing both look alike."""
    pov = json.dumps(preset["steps"][0].get("pov"))
    faces = tuple(sorted({p["faceId"] for p in preset["facePoints"]}))
    return pov, faces


def spread_pick(items, n, rng, used):
    """n items, round-robin over view keys, least-used keys first."""
    groups = defaultdict(list)
    for item in rng.sample(items, len(items)):
        groups[view_key(item[2])].append(item)
    picked = []
    while len(picked) < n and any(groups.values()):
        key = min((k for k in groups if groups[k]), key=lambda k: (used[k], rng.random()))
        picked.append(groups[key].pop())
        used[key] += 1
    return picked


def load_pool(tier, banks):
    pool = defaultdict(list)
    for bank in banks:
        path = WORK / bank / "assembled.json"
        if not path.exists():
            print(f"missing {path}; skipped")
            continue
        for name, preset in json.loads(path.read_text()).items():
            if int(preset.get("difficulty", 0)) == tier:
                pool[shape_of(preset)].append((f"{bank}/assembled.json", name, preset))
    return pool


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out")
    parser.add_argument("--per-tier", type=int, required=True)
    parser.add_argument("--keep", help="Provenance file of an earlier build whose items stay in.")
    parser.add_argument("--seed", type=int, default=20261007)
    parser.add_argument("--work-dir", default="new_dataset/climb", help="Directory holding the generated source banks (default: new_dataset/climb).")
    args = parser.parse_args()
    global WORK
    WORK = ROOT / args.work_dir
    rng = random.Random(args.seed)
    keep = json.loads(Path(args.keep).read_text()) if args.keep else {}
    keep_ids = {(v["source"], v["name"]) for v in keep.values()}
    bank, provenance = {}, {}

    for tier, sources in SOURCES.items():
        pool = load_pool(tier, sources)
        filler = load_pool(tier, FILLER[tier][0]) if tier in FILLER else {}
        shapes = list(SHAPES[tier])
        # Items already in the earlier build count toward their shape first.
        kept = defaultdict(list)
        for shape in list(pool) + list(filler):
            for source_pool in (pool, filler):
                rest = []
                for item in source_pool.get(shape, []):
                    (kept[shape] if (item[0], item[1]) in keep_ids else rest).append(item)
                if shape in source_pool:
                    source_pool[shape] = rest
        available = {s: len(kept[s]) + len(pool[s]) for s in shapes}
        take = quotas(available, args.per_tier)
        short = args.per_tier - sum(take.values())
        if short and tier in FILLER:
            filler_shapes = FILLER[tier][1]
            filler_take = quotas({s: len(kept[s]) + len(filler.get(s, [])) for s in filler_shapes}, short)
            print(f"d{tier}: {short} short; filling {filler_take} from front-only 180-degree bases")
            for s in filler_shapes:
                pool[s] = filler.get(s, [])
            take.update(filler_take)
            shapes += filler_shapes
        print(f"d{tier}: available {available} -> taking {take} = {sum(take.values())}")
        used = defaultdict(int)
        for shape in shapes:
            chosen = kept[shape][:take[shape]]
            for item in chosen:
                used[view_key(item[2])] += 1
            chosen += spread_pick(pool[shape], take[shape] - len(chosen), rng, used)
            for k, (source, name, preset) in enumerate(chosen, start=1):
                new = f"{shape}-d{tier}-{k:03d}"
                bank[new] = preset
                provenance[new] = {"source": source, "name": name}
        print(f"d{tier}: kept {sum(min(len(kept[s]), take[s]) for s in shapes)} items from the earlier build")
    Path(args.out).write_text(json.dumps(bank, indent=1))
    Path(args.out).with_suffix(".provenance.json").write_text(json.dumps(provenance, indent=1))
    print(f"wrote {len(bank)} presets to {args.out}")


if __name__ == "__main__":
    main()
