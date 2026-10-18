#!/usr/bin/env python3
"""Check that expert answers cannot be read from final-image dot positions alone.

A tracked dot and its decoys share a panel. If the tracked dot is placed in a
recognisable spot within its group (for example, always the middle dot), a
solver can skip the tracking task. This tool replays nothing; it reads the
final-frame screen positions that validate-presets.js records and compares
position-only baselines with chance.

  bun tools/validate-presets.js --inputs bank.json --settle-ms 800 --report report.json
  python3 tools/shortcut-baselines.py --bank bank.json --report report.json

Exits 1 when the central-dots baseline beats chance, or the tracked dot's
middle-dot rate differs from chance, by more than --max-z standard errors.
"""
import argparse
import json
import math
import sys
from pathlib import Path


def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def load_bank(paths):
    bank = {}
    for path in paths:
        data = json.loads(Path(path).read_text())
        if isinstance(data, list):
            data = {p.get("name") or p.get("benchmark"): p for p in data}
        bank.update(data)
    return bank


def load_cases(bank_paths, report_paths):
    """Returns (name, points, final screen positions) for every replayed preset."""
    bank = load_bank(bank_paths)
    cases = []
    for path in report_paths:
        for row in json.loads(Path(path).read_text())["results"]:
            screens = (row.get("quality") or {}).get("finalScreens")
            if not screens and row.get("trace"):
                screens = row["trace"][-1].get("screens")  # validate-presets.js --trace
            if screens and row["name"] in bank:
                cases.append((row["name"], bank[row["name"]]["facePoints"], screens))
    return cases


def tracked_groups(points):
    """Index groups for each tracked panel: the anchor first, then its decoys.

    Scatter dots sit around groups, not in them: a scatter dot on an
    anchor's panel is not one of its decoys, and a scatter anchor is a group
    of one."""
    anchors = [i for i, p in enumerate(points) if not p.get("hidden")]
    return [[a] + ([] if points[a].get("scatter") else
                   [i for i, p in enumerate(points)
                    if p.get("hidden") and not p.get("scatter") and p["faceId"] == points[a]["faceId"]])
            for a in anchors]


def anchor_middle_stats(points, screens):
    """Returns (groups whose anchor is their middle dot, groups counted,
    expected hits at chance).

    The middle dot has the smallest summed distance to the rest of its group.
    Dots tied for it share the credit: in a pair both dots tie, and breaking
    the tie by list order would always credit the anchor, which is listed
    first. Groups whose anchor has no recorded position, or with fewer than
    two dots shown, are not counted. Group sizes vary, so chance is summed
    per group.
    """
    hits = 0.0
    groups = 0
    expected = 0.0
    for group in tracked_groups(points):
        shown = [i for i in group if screens[i]]
        if not screens[group[0]] or len(shown) < 2:
            continue
        spread = {i: sum(dist(screens[i], screens[j]) for j in shown) for i in shown}
        tied = [i for i in shown if spread[i] <= min(spread.values()) + 1e-6]
        hits += 1 / len(tied) if group[0] in tied else 0.0
        groups += 1
        expected += 1 / len(shown)
    return hits, groups, expected


def anchor_middle_count(points, screens):
    """Returns (groups whose anchor is their middle dot, groups counted)."""
    return anchor_middle_stats(points, screens)[:2]


def central_pick(screens, k, neighbours=3, exclusion_px=160):
    """Blind heuristic: the k dots nearest their neighbours, one per group."""
    shown = [i for i, s in enumerate(screens) if s]
    def spread(i):
        gaps = sorted(dist(screens[i], screens[j]) for j in shown if j != i)[:neighbours]
        return sum(gaps) / max(1, len(gaps))
    chosen = []
    for i in sorted(shown, key=spread):
        if all(dist(screens[i], screens[c]) > exclusion_px for c in chosen):
            chosen.append(i)
        if len(chosen) == k:
            break
    return set(chosen)


def evaluate(cases, isolated_px=100):
    """Position-only baselines against chance, with z-scores.

    Uniform chance picks any k of the shown dots. Group chance assumes the
    solver can see the tracked groups and picks one dot per group at random;
    that is the reference for the central-dots baseline, since grouping
    alone is not a placement leak. Drawn layouts hide the tracked groups, so
    for them compare the central-dots rate with uniform chance as well.
    """
    n = len(cases)
    chance_sum = group_exact_sum = central_hits = 0.0
    middle_hits = groups = 0
    group_chance = 0.0
    back_dots = back_isolated = 0
    answer_dots = answer_isolated = 0
    for _, points, screens in cases:
        answer = {i for i, p in enumerate(points) if not p.get("hidden")}
        shown = [i for i, s in enumerate(screens) if s]
        tracked_faces = {points[a]["faceId"] for a in answer}
        chance_sum += 1 / math.comb(len(shown), len(answer))
        central_hits += central_pick(screens, len(answer)) == answer
        hits, counted, expected = anchor_middle_stats(points, screens)
        middle_hits += hits
        groups += counted
        group_chance += expected
        case_group_exact = 1.0
        for group in tracked_groups(points):
            case_group_exact /= max(1, len([i for i in group if screens[i]]))
        group_exact_sum += case_group_exact
        for i in shown:
            isolated = all(dist(screens[i], screens[j]) > isolated_px for j in shown if j != i)
            if i in answer:
                answer_dots += 1
                answer_isolated += isolated
            if points[i]["faceId"] in tracked_faces:
                continue
            back_dots += 1
            back_isolated += isolated

    def z(hits, trials, p):
        return (hits - trials * p) / math.sqrt(max(trials * p * (1 - p), 1e-9)) if trials else 0.0

    chance = chance_sum / n if n else 0.0
    group_exact = group_exact_sum / n if n else 0.0
    middle_chance = group_chance / groups if groups else 0.0
    return {
        "cases": n,
        "chance_exact": chance,
        "group_chance_exact": group_exact,
        "central_exact": central_hits / n if n else 0.0,
        "central_z": z(central_hits, n, group_exact),
        "back_dots": back_dots,
        "back_isolated_rate": back_isolated / back_dots if back_dots else 0.0,
        "answer_isolated_rate": answer_isolated / answer_dots if answer_dots else 0.0,
        "groups": groups,
        "anchor_middle_rate": middle_hits / groups if groups else 0.0,
        "anchor_middle_chance": middle_chance,
        "anchor_middle_z": z(middle_hits, groups, middle_chance),
    }


# Twin rotations by the name presets record in clusterPlacement.symmetry
# (sheet rotations about the paper normal, the model's y axis).
TWIN_TURNS = {"rotate90": math.pi / 2, "rotate180": math.pi, "rotate270": -math.pi / 2}


def _quat_mul(a, b):
    w1, x1, y1, z1 = a
    w2, x2, y2, z2 = b
    return (w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2, w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
            w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2, w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2)


def _quat_axis(axis, angle):
    s = math.sin(angle / 2)
    return (math.cos(angle / 2), s * (axis == "x"), s * (axis == "y"), s * (axis == "z"))


def least_turn_rate(bank):
    """(presets whose real final pose turns less than its twin pose, presets).

    A solver comparing only the flat and final images can choose between the
    real pose and the pose turned onto the twins by assuming the paper turned
    as little as possible. Twins hide the dot only if that guess is right
    about half the time. Rotations are Euler XYZ, as THREE.js applies them.
    """
    hits = n = 0
    for preset in bank.values():
        turn = TWIN_TURNS.get((preset.get("clusterPlacement") or {}).get("symmetry"))
        if turn is None or not preset.get("steps"):
            continue
        x, y, z = (preset["steps"][-1].get("rotation") or [0, 0, 0])[:3]
        real = _quat_mul(_quat_mul(_quat_axis("x", x), _quat_axis("y", y)), _quat_axis("z", z))
        twin = _quat_mul(real, _quat_axis("y", turn))
        hits += 2 * math.acos(min(1, abs(real[0]))) < 2 * math.acos(min(1, abs(twin[0])))
        n += 1
    return hits, n


def final_view_quality(report_paths):
    """Final-frame viewing ratio per dot, by preset name, from validation
    reports (quality.finalViewQuality) or --trace reports (the last step)."""
    found = {}
    for path in report_paths:
        for row in json.loads(Path(path).read_text())["results"]:
            ratios = (row.get("quality") or {}).get("finalViewQuality")
            if not ratios and row.get("trace"):
                ratios = row["trace"][-1].get("viewQuality")
            if ratios:
                found[row["name"]] = ratios
    return found


def twin_facing_rate(bank, view_quality, tie=0.02):
    """(tracked groups facing the camera more than their twin group, groups compared).

    Anchors must stay readable at every step, twins only in the final frame,
    so tracked panels can end up facing the camera more than their twins. A
    solver comparing how round the dots look in the final image could then
    tell a tracked group from its twin group. Groups are compared by mean
    viewing ratio; differences within `tie` count half.
    """
    hits = n = 0.0
    for name, preset in bank.items():
        ratios = view_quality.get(name)
        points = preset.get("facePoints") or []
        if not ratios or len(ratios) != len(points):
            continue
        def facing(face):
            group = [ratios[i] for i, p in enumerate(points) if p["faceId"] == face]
            return sum(group) / len(group)
        for p in points:
            if p.get("hidden") or p.get("pair") is None:
                continue
            twin = next((q for q in points if q.get("twin") and q.get("pair") == p["pair"]), None)
            if twin is None:
                continue
            gap = facing(p["faceId"]) - facing(twin["faceId"])
            hits += 0.5 if abs(gap) <= tie else gap > 0
            n += 1
    return hits, int(n)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bank", action="append", required=True, help="Preset bank JSON. Repeatable.")
    parser.add_argument("--report", action="append", required=True,
                        help="validate-presets.js report with finalScreens. Repeatable.")
    parser.add_argument("--max-z", type=float, default=3.0,
                        help="Fail when a baseline beats chance by more than this many standard errors.")
    args = parser.parse_args(argv)
    cases = load_cases(args.bank, args.report)
    if not cases:
        print("No replayed presets with final screen positions; rerun validate-presets.js.", file=sys.stderr)
        return 2
    r = evaluate(cases)
    print(f"cases {r['cases']}: chance exact {r['chance_exact']:.3f} (uniform), "
          f"{r['group_chance_exact']:.3f} (one random dot per tracked group)")
    print(f"central-dots baseline exact {r['central_exact']:.3f} (z {r['central_z']:+.1f} vs group chance)")
    print(f"tracked groups {r['groups']}: anchor is the middle dot {r['anchor_middle_rate']:.3f}, "
          f"chance {r['anchor_middle_chance']:.3f} (z {r['anchor_middle_z']:+.1f})")
    print(f"dots off the tracked panels isolated from every other dot: {r['back_isolated_rate']:.3f} of {r['back_dots']}; "
          f"tracked dots isolated: {r['answer_isolated_rate']:.3f} "
          "(if only one of these is high, isolation answers without tracking)")
    # Central dots only help when they beat chance. The middle-dot rate leaks
    # either way: too low means the tracked dot sits at the edge of its group.
    leaks = [name for name, value in (("central-dots", r["central_z"]), ("middle-dot", abs(r["anchor_middle_z"])))
             if value > args.max_z]
    turn_hits, turn_n = least_turn_rate(load_bank(args.bank))
    if turn_n:
        turn_z = (turn_hits - turn_n / 2) / math.sqrt(turn_n / 4)
        print(f"twinned presets {turn_n}: real pose is the least turn {turn_hits / turn_n:.3f}, chance 0.5 (z {turn_z:+.1f}); "
              "above chance lets first+last frame matching tell dots from twins")
        if turn_z > args.max_z:
            leaks.append("least-turn")
    facing_hits, facing_n = twin_facing_rate(load_bank(args.bank), final_view_quality(args.report))
    if facing_n:
        facing_z = (facing_hits - facing_n / 2) / math.sqrt(facing_n / 4)
        print(f"tracked groups {facing_n}: more face-on than their twin group {facing_hits / facing_n:.3f}, chance 0.5 "
              f"(z {facing_z:+.1f}); either way, how round the dots look tells dots from twins")
        if abs(facing_z) > args.max_z:
            leaks.append("twin-facing")
    if leaks:
        print("FAIL: position-only baselines beat chance: " + ", ".join(leaks))
        return 1
    print("OK: no position-only baseline beats chance")
    return 0


if __name__ == "__main__":
    sys.exit(main())
