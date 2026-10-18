"""Step 3 of 3 of the dataset-300b selection (ported from new_dataset/climb/build-balanced.py).

Builds the 300-item set with a balanced expert half: the 150 medium items of
dataset-300 (select-300.py) unchanged, and 150 expert items picked from every passed preset of
the expert runs so that, per shape,

  - tracked groups face the camera more than their twin group about half the
    time (dataset-300's expert half: 70%, so dot roundness told dots from
    twins),
  - the real final pose is the smaller turn about half the time, and
  - the tracked dot is its group's middle dot at chance,

with at most three presets per panel combination and picks spread over
camera views (the assembly rules of generate-expert-dataset.py). A shape
gives at most as many presets as stay balanced; front-only boat, open sink
and square fill only slots the three main shapes cannot.

Every candidate passed its job's 800 ms validation replay; its final dot
positions and viewing ratios come from that report.

Usage: select-300b.py OUT.json [--per-tier 150] [--work-dir DIR] [--medium-bank dataset-300-bank.json]
"""
import argparse
import glob
import importlib.util
import json
import os
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
CLIMB = ROOT / "new_dataset/climb"


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, TOOLS / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


shortcut = load("shortcut", "shortcut-baselines.py")
expert = load("expert", "generate-expert-dataset.py")
expert.TIER = 5

# Expert runs with the dataset's settings (bird and pinwheel 22 dots; waterbomb
# 16-18 dots with 1-2 random dots). Not the first waterbomb pass (3-5 random
# dots) or the symmetric-twin runs.
EXPERT_BANKS = ["r5-d5-bank", "r5-d5-bird2-bank", "r5-d5-waterbomb2-bank", "s300-d5-bank", "s300-d5b-bank",
                "s300-d5-waterbomb-bank", "bal-d5-bank", "bal-d5-waterbomb-bank"]
FILLER_BANKS = ["r5-d5-front180-bank", "s300-d5-front180-bank"]
MAIN, FILLER = ["bird", "pinwheel", "waterbomb"], ["boat", "opensink", "square"]
# A balanced prefix keeps each rate within 5 points of its target (half, or
# chance for the middle dot), and never needs to be tighter than these counts.
RATE_SLACK = 0.05
TOLERANCE = {"facing": 1.0, "turn": 1.5, "middle": 1.5}


def candidates(banks):
    """Passed presets by shape: (signature, (source, preset)), with middle-dot
    and twin-facing records by signature."""
    pool, middle, facing, seen = defaultdict(list), {}, {}, set()
    for bank in banks:
        for done in sorted(glob.glob(f"{CLIMB}/{bank}/jobs/*.done.json")):
            record = json.load(open(done))
            names = record.get("passed") or []
            report = done.replace(".done.json", ".validation.json")
            if not names or not os.path.exists(report):
                continue
            presets = json.load(open(done.replace(".done.json", ".json")))
            rows = {r["name"]: r for r in json.load(open(report)).get("results", [])}
            for name in names:
                preset = presets.get(name)
                quality = (rows.get(name) or {}).get("quality") or {}
                if not preset or not quality.get("finalScreens") or not quality.get("finalViewQuality"):
                    continue
                signature = expert.preset_signature(preset)
                if signature in seen:
                    continue
                seen.add(signature)
                middle[signature] = shortcut.anchor_middle_stats(preset["facePoints"], quality["finalScreens"])
                facing[signature] = list(shortcut.twin_facing_rate({0: preset}, {0: quality["finalViewQuality"]}))
                source = f"{bank}/jobs/{Path(done).name[:-len('.done.json')]}::{name}"
                pool[record["model"]].append((signature, (source, preset)))
    return pool, middle, facing


def balanced_order(items, middle, facing):
    """The greedy balance order and how long a prefix of it stays balanced."""
    ordered = expert.spread_by_view([pair for _, pair in items], len(items))
    by_pair = {id(pair[1]): signature for signature, pair in items}
    capped = expert.cap_face_sets([(by_pair[id(preset)], (source, preset)) for source, preset in ordered])
    picked, _, _ = expert.balance_middle(capped, middle, len(capped), facing)
    hits = expected = turn = face = 0.0
    groups = middle_groups = twinned = 0
    capacity = 0
    for k, (signature, (_, preset)) in enumerate(picked, start=1):
        h, g, chance = expert.middle_stats(middle[signature], preset)
        hits, expected, middle_groups = hits + h, expected + chance, middle_groups + g
        turn += expert.least_turn_lean(preset)
        twinned += shortcut.least_turn_rate({0: preset})[1]
        face += facing[signature][0] - facing[signature][1] / 2
        groups += facing[signature][1]
        if (abs(face) <= max(TOLERANCE["facing"], RATE_SLACK * groups)
                and abs(turn) <= max(TOLERANCE["turn"], RATE_SLACK * twinned)
                and abs(hits - expected) <= max(TOLERANCE["middle"], RATE_SLACK * middle_groups)):
            capacity = k
    return picked, capacity


def quotas(available, total):
    take = {s: 0 for s in available}
    for _ in range(total):
        open_shapes = [s for s in available if take[s] < available[s]]
        if not open_shapes:
            break
        pick = min(open_shapes, key=lambda s: (take[s], -(available[s] - take[s]), s))
        take[pick] += 1
    return take


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out")
    parser.add_argument("--per-tier", type=int, default=150)
    parser.add_argument("--work-dir", default="new_dataset/climb", help="Directory holding the generated source banks (default: new_dataset/climb).")
    parser.add_argument("--medium-bank", help="Output of select-300.py (default: <work-dir>/dataset-300-bank.json); its .provenance.json must sit beside it.")
    args = parser.parse_args()
    global CLIMB
    CLIMB = ROOT / args.work_dir

    medium_path = Path(args.medium_bank) if args.medium_bank else CLIMB / "dataset-300-bank.json"
    medium_bank = json.loads(medium_path.read_text())
    medium_prov = json.loads(medium_path.with_suffix(".provenance.json").read_text())
    bank = {name: p for name, p in medium_bank.items() if int(p["difficulty"]) == 3}
    provenance = {name: medium_prov[name] for name in bank}
    print(f"medium: {len(bank)} items kept from dataset-300")

    pool, middle, facing = candidates(EXPERT_BANKS)
    fpool, fmiddle, ffacing = candidates(FILLER_BANKS)
    middle.update(fmiddle)
    facing.update(ffacing)
    orders, capacity = {}, {}
    for shape in MAIN + FILLER:
        items = (pool if shape in MAIN else fpool).get(shape, [])
        orders[shape], capacity[shape] = balanced_order(items, middle, facing) if items else ([], 0)
        print(f"expert {shape:9s} passed {len(items):3d}  balanced capacity {capacity[shape]:3d}")
    take = quotas({s: capacity[s] for s in MAIN}, args.per_tier)
    short = args.per_tier - sum(take.values())
    if short:
        take.update(quotas({s: capacity[s] for s in FILLER}, short))
        print(f"expert: {short} short; filling {dict((s, take[s]) for s in FILLER)} from front-only 180-degree bases")
    totals = defaultdict(float)
    for shape, n in take.items():
        for k, (signature, (source, preset)) in enumerate(orders[shape][:n], start=1):
            name = f"{shape}-d5-{k:03d}"
            bank[name] = preset
            provenance[name] = {"source": source}
            h, g = facing[signature]
            totals["facing_hits"] += h
            totals["facing_groups"] += g
            t, m = shortcut.least_turn_rate({0: preset})
            totals["turn_hits"] += t
            totals["twinned"] += m
    print(f"expert: taking {dict((s, n) for s, n in take.items() if n)} = {sum(take.values())}")
    print(f"expert: twin facing {totals['facing_hits'] / max(1, totals['facing_groups']):.2f} of {int(totals['facing_groups'])} groups; "
          f"least turn {int(totals['turn_hits'])}/{int(totals['twinned'])}")
    Path(args.out).write_text(json.dumps(bank, indent=1))
    Path(args.out).with_suffix(".provenance.json").write_text(json.dumps(provenance, indent=1))
    print(f"wrote {len(bank)} presets to {args.out}")


if __name__ == "__main__":
    main()
