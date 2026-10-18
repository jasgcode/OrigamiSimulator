#!/usr/bin/env python3
"""Choose which dot in each clustered group is the tracked dot.

In medium and expert presets each tracked panel carries one visible anchor
and up to three hidden decoys in a group. Generation favours anchors that end
up as the group's middle dot, because those groups survive validation more
often, and a solver can then answer from the final image alone. Dropping
presets until the rate is at chance discards up to three quarters of a
model's pool.

This tool keeps every preset and re-chooses the anchor instead. The dots do
not move; only the hidden flags change within each group. A dot can be the
anchor when the trace shows it visible, and at or above the preset's viewing
ratio, at every step the validator checks a visible anchor, and the two
anchors keep the separation floor at every step. Anchors are drawn uniformly
from those dots, then single groups are switched until, per model, the
tracked dot is the group's middle, most isolated and outermost dot each at
the chance rate.

  bun tools/validate-presets.js --inputs bank.json --settle-ms 800 --trace --report trace.json
  python3 tools/rebalance-anchors.py --bank bank.json --trace trace.json --out rebalanced.json

The output needs a normal validate-presets.js replay before rendering.
"""
import argparse
import importlib.util
import json
import math
import random
import sys
from pathlib import Path

_spec = importlib.util.spec_from_file_location("shortcut_baselines", Path(__file__).with_name("shortcut-baselines.py"))
shortcut = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(shortcut)


def is_mapfold_mid_step_exempt(preset, step_idx, steps):
    # Mirrors skipMidStepVisibility in validatePreset (js/presetGenerator.js).
    last = step_idx == len(steps) - 1
    return (preset.get("difficulty") != 5 and "mapfold" in preset.get("model", "")
            and not last and steps[step_idx]["fold"] > 0)


def groups_of(points):
    """Dot indices per tracked panel, keyed by face id, current anchor first."""
    return {points[g[0]]["faceId"]: g for g in shortcut.tracked_groups(points)}


def eligible_dots(preset, trace):
    """Per tracked panel, the dots that could be its anchor."""
    steps = preset["steps"]
    floor = preset.get("minPointViewQuality") or 0
    out = {}
    for face, group in groups_of(preset["facePoints"]).items():
        out[face] = [i for i in group if all(
            is_mapfold_mid_step_exempt(preset, s, steps)
            or (row["visible"][i] and row["viewQuality"][i] >= floor)
            for s, row in enumerate(trace))]
    return out


def anchors_separated(preset, trace, anchors):
    """Anchors are the only required dots before the final step, so only
    their spacing changes when anchors change."""
    if not preset.get("enforceSeparationAllSteps"):
        return True
    floor = preset.get("minPointSeparationPx", 70)
    for row in trace[:-1]:
        shown = [row["screens"][i] for i in anchors if row["screens"][i]]
        for a in range(len(shown)):
            for b in range(a + 1, len(shown)):
                if shortcut.dist(shown[a], shown[b]) < floor:
                    return False
    return True


# Position roles a solver could read from the final image alone. The middle
# dot is shortcut-baselines.py's definition. Balancing it alone left the
# tracked dot too often at the far end of its group on medium: the all-step
# anchor spacing rule passes dots at the far ends of two groups more often.
# Each role is the set of dots tied at its extreme. Two dots that are each
# other's nearest neighbour have exactly equal gaps, so "most isolated" is
# usually a pair; breaking the tie by list order credits the anchor, which
# is listed first. A solver picking at random among tied dots finds the
# anchor with probability 1/|set| when it is in the set, so hits count that.
ROLES = {
    "middle": lambda s, i, shown: -sum(shortcut.dist(s[i], s[j]) for j in shown),
    "isolated": lambda s, i, shown: min(shortcut.dist(s[i], s[j]) for j in shown if j != i),
    "outermost": lambda s, i, shown: shortcut.dist(
        s[i], (sum(s[j][0] for j in shown) / len(shown), sum(s[j][1] for j in shown) / len(shown))),
}
TIE = 1e-6


def role_dots(preset, final_screens):
    """{face: {role: [dots tied at the role's extreme]}} for each tracked
    group with at least two dots shown, plus the group's shown size."""
    out = {}
    for face, group in groups_of(preset["facePoints"]).items():
        shown = [i for i in group if final_screens[i]]
        if len(shown) < 2:
            continue
        roles = {}
        for role, key in ROLES.items():
            values = {i: key(final_screens, i, shown) for i in shown}
            top = max(values.values())
            roles[role] = [i for i in shown if values[i] >= top - TIE]
        out[face] = {"roles": roles, "size": len(shown)}
    return out


def middle_dots(preset, final_screens):
    """The middle dots of each tracked group (ties included), by face id."""
    return {face: r["roles"]["middle"] for face, r in role_dots(preset, final_screens).items()}


def options_for(preset, trace):
    """Everything assignment needs about one preset: eligible dots and role
    dots per panel, the current anchors, and a pair check."""
    eligible = eligible_dots(preset, trace)
    current = {face: group[0] for face, group in groups_of(preset["facePoints"]).items()}
    # A panel with no eligible dot keeps its anchor; the replay decides.
    eligible = {face: dots or [current[face]] for face, dots in eligible.items()}
    return {"eligible": eligible, "roles": role_dots(preset, trace[-1]["screens"]), "current": current,
            "separated": lambda anchors: anchors_separated(preset, trace, anchors)}


def credit(opt, face, dot, role):
    tied = opt["roles"][face]["roles"][role]
    return 1 / len(tied) if dot in tied else 0.0


def hits_of(opt, anchors, role="middle"):
    return sum(credit(opt, face, dot, role) for face, dot in anchors.items() if face in opt["roles"])


def random_anchors(opt, rng, tries=50):
    faces = sorted(opt["eligible"])
    for _ in range(tries):
        anchors = {face: rng.choice(opt["eligible"][face]) for face in faces}
        if opt["separated"](list(anchors.values())):
            return anchors
    return dict(opt["current"])


def assign(options, rng, passes=20):
    """Anchors for every preset in one balance bucket (usually one model).

    Draws each preset's anchors uniformly from its eligible dots, then
    switches single panels while that brings the per-role hit counts
    (middle, most isolated, outermost dot of the group) closer to chance,
    one over the group's size. Returns ({name: {face: dot}}, middle hits,
    groups).
    """
    anchors = {name: random_anchors(opt, rng) for name, opt in options.items()}
    groups = sum(len(opt["roles"]) for opt in options.values())
    target = sum(1 / r["size"] for opt in options.values() for r in opt["roles"].values())
    hits = {role: sum(hits_of(options[n], a, role) for n, a in anchors.items()) for role in ROLES}

    def cost(h):
        return sum(abs(v - target) for v in h.values())

    moves = [(name, face) for name, opt in options.items() for face in opt["roles"]]
    for _ in range(passes):
        improved = False
        rng.shuffle(moves)
        for name, face in moves:
            opt, current = options[name], anchors[name]
            old = current[face]
            dots = [d for d in opt["eligible"][face] if d != old]
            rng.shuffle(dots)
            for dot in dots:
                trial_hits = {role: hits[role] - credit(opt, face, old, role) + credit(opt, face, dot, role)
                              for role in ROLES}
                if cost(trial_hits) >= cost(hits) - 1e-9:
                    continue
                trial = {**current, face: dot}
                if opt["separated"](list(trial.values())):
                    anchors[name], hits, improved = trial, trial_hits, True
                    break
        if not improved:
            break
    return anchors, hits["middle"], groups


def apply_anchors(preset, anchors):
    """Copy of preset whose visible dot on each tracked panel is anchors[face]."""
    out = dict(preset, facePoints=[dict(p) for p in preset["facePoints"]])
    for face, group in groups_of(preset["facePoints"]).items():
        for i in group:
            out["facePoints"][i]["hidden"] = i != anchors[face]
    return out


def load_traces(paths):
    traces = {}
    for path in paths:
        for row in json.loads(Path(path).read_text())["results"]:
            if row.get("trace"):
                traces[row["name"]] = row["trace"]
    return traces


def bucket_key(preset, by):
    return preset.get(by) if by else None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--bank", action="append", required=True, help="Preset bank(s). Repeatable.")
    parser.add_argument("--trace", action="append", required=True,
                        help="validate-presets.js --trace report(s). Repeatable.")
    parser.add_argument("--out", required=True)
    parser.add_argument("--seed", type=int, default=20260929)
    parser.add_argument("--balance-by", default="model",
                        help="Preset field whose values are balanced separately; empty for one bucket.")
    args = parser.parse_args(argv)

    bank = shortcut.load_bank(args.bank)
    traces = load_traces(args.trace)
    missing = sorted(set(bank) - set(traces))
    if missing:
        print(f"[error] no trace for {len(missing)} preset(s), e.g. {missing[:3]}", file=sys.stderr)
        return 1
    rng = random.Random(args.seed)
    buckets = {}
    for name in sorted(bank):
        buckets.setdefault(bucket_key(bank[name], args.balance_by), {})[name] = options_for(bank[name], traces[name])
    out, report = {}, {}
    for key in sorted(buckets, key=str):
        opts = buckets[key]
        anchors, hits, groups = assign(opts, rng)
        changed = sum(anchors[n] != opts[n]["current"] for n in anchors)
        for name, chosen in anchors.items():
            out[name] = apply_anchors(bank[name], chosen)
        roles = {role: [sum(hits_of(o, o["current"], role) for o in opts.values()),
                        sum(hits_of(opts[n], anchors[n], role) for n in anchors)] for role in ROLES}
        report[str(key)] = {"presets": len(anchors), "changed": changed, "groups": groups,
                            "roles_before_after": roles,
                            "single_choice_panels": sum(len(v) == 1 for o in opts.values()
                                                        for v in o["eligible"].values())}
        chance = sum(1 / r["size"] for o in opts.values() for r in o["roles"].values())
        print(f"{str(key):32} presets {len(anchors):3}  changed {changed:3}  groups {groups}  "
              + "  ".join(f"{role} {b:.1f}->{a:.1f}" for role, (b, a) in roles.items())
              + f"  (chance {chance:.1f})")
    Path(args.out).write_text(json.dumps(out, indent=2) + "\n")
    Path(args.out).with_suffix(".report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"Written: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
