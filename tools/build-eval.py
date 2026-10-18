#!/usr/bin/env python3
"""Build eval/: a model-balanced, diverse medium (d3) and expert (d5) dataset.

Every (tier, model) cell gets --per-model presets unless --cell-size sets
its own count (300 over 7 models needs cells of 21 and 22). Within a cell,
presets are chosen greedily for spread: each pick favours tracked-panel
pairs, full panel sets, camera views, expert motion styles and source jobs
that the cell has used least, and final viewing directions (camera direction
in the paper's frame) far from those already chosen. Two presets never share
a trajectory. The tracked dot is its group's middle dot within one group of
chance in every cell.

Stages, sharing --work (default new_dataset/eval-work):

  select    Pick --candidates presets per (tier, model) from the pools of
            generate-expert-dataset.py (--pool TIER=OUT_DIR). Writes
            candidates-d<tier>.json and candidates-d<tier>.meta.json, in pick
            order, so the first --per-model are the preferred ones.
  plan      Make the final pick (as assemble below) and spread answer
            letters evenly over every pair per tier. --keep-previous grows
            the cells of an earlier plan without changing its presets.
  assemble  Keep candidates that passed validation (--report), rendered from
            the same preset (--render-dir) with every required point visible,
            and whose answer matches the preset. Pick --per-model per cell and
            write --out. Images are hard links; nothing is re-rendered.

  replay    Run validate-presets.js (optionally --trace) over a bank in
            parallel chunks, restarting chunks that hang at startup.

Between select and assemble, trace and rebalance anchors, validate, and
render the candidates; tools/README.md ("Build the eval set") has the commands.
"""
import argparse
import importlib.util
import json
import math
import random
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_tool(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runner = load_tool("generate-expert-dataset")
shortcut = load_tool("shortcut-baselines")
rebalance = load_tool("rebalance-anchors")
checker = load_tool("check-dataset")

MODELS = [key for key, _ in runner.MODELS if key != "simplevertex"]
MODEL_BY_PATH = {path: key for key, path in runner.MODELS}
TIER_NAMES = {3: "medium", 5: "expert"}
# Relative weight of each spread feature in a pick. A feature value's term is
# weight / (1 + times the cell already uses it).
WEIGHTS = {"tracked": 3.0, "faces": 2.0, "view": 1.5, "style": 1.0, "job": 1.0}
# Weight of the final viewing direction's angle to the nearest chosen one, over pi.
POSE_WEIGHT = 3.0
# Keeps the running middle-dot count near chance while picking.
BALANCE_WEIGHT = 2.0


# ── Features ──────────────────────────────────────────────────────────

def quaternion_xyz(rx, ry, rz):
    """three.js Euler 'XYZ' to quaternion (x, y, z, w)."""
    c1, c2, c3 = math.cos(rx / 2), math.cos(ry / 2), math.cos(rz / 2)
    s1, s2, s3 = math.sin(rx / 2), math.sin(ry / 2), math.sin(rz / 2)
    return (s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3,
            c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3)


def rotate_inverse(q, v):
    """Rotates v by the inverse of unit quaternion q."""
    x, y, z, w = -q[0], -q[1], -q[2], q[3]
    tx = 2 * (y * v[2] - z * v[1])
    ty = 2 * (z * v[0] - x * v[2])
    tz = 2 * (x * v[1] - y * v[0])
    return (v[0] + w * tx + y * tz - z * ty, v[1] + w * ty + z * tx - x * tz, v[2] + w * tz + x * ty - y * tx)


def final_view_direction(preset):
    """Camera direction in the paper's frame at the final step: which side of
    the folded model the last image shows, and from what angle."""
    step = preset["steps"][-1]
    pov = step.get("pov")
    if not isinstance(pov, list):
        pov = [1, 1, 1]
    norm = math.sqrt(sum(c * c for c in pov)) or 1
    rot = step.get("rotation") or [0, 0, 0]
    if isinstance(rot, dict):
        rot = [rot.get("x", 0), rot.get("y", 0), rot.get("z", 0)]
    return rotate_inverse(quaternion_xyz(*rot), [c / norm for c in pov])


def angle(a, b):
    return math.acos(max(-1.0, min(1.0, sum(x * y for x, y in zip(a, b)))))


def features(preset, style=None, source=""):
    points = preset["facePoints"]
    return {
        "trajectory": json.dumps(preset["steps"], sort_keys=True),
        "tracked": tuple(sorted({p["faceId"] for p in points if not p.get("hidden")})),
        "faces": tuple(sorted({p["faceId"] for p in points})),
        "view": json.dumps(preset["steps"][0].get("pov")),
        "style": style,
        "job": source.split("::")[0],
        "direction": final_view_direction(preset),
    }


# ── Selection ─────────────────────────────────────────────────────────

class Cell:
    """Running feature counts of the presets chosen for one (tier, model)."""

    def __init__(self):
        self.counts = {f: Counter() for f in WEIGHTS}
        self.trajectories = set()
        self.directions = []
        self.credits = Counter()  # role -> tracked-dot credit, see role_balance
        self.expected = 0.0
        self.chosen = []

    def spread(self, feat):
        s = sum(w / (1 + self.counts[f][feat[f]]) for f, w in WEIGHTS.items())
        near = min((angle(feat["direction"], d) for d in self.directions), default=math.pi)
        return s + POSE_WEIGHT * near / math.pi

    def deviation(self, extra=None):
        credits, expected = extra or ({}, 0.0)
        roles = set(self.credits) | set(credits)
        return sum(abs(self.credits[r] + credits.get(r, 0.0) - self.expected - expected) for r in roles)

    def add(self, name, feat, balance=None):
        for f in WEIGHTS:
            self.counts[f][feat[f]] += 1
        self.trajectories.add(feat["trajectory"])
        self.directions.append(feat["direction"])
        if balance:
            self.credits.update(balance[0])
            self.expected += balance[1]
        self.chosen.append(name)


def role_balance(preset, final_screens):
    """({role: credit}, expected) for one preset: how often its tracked dots
    are their groups' middle, most isolated and outermost dots, ties split
    (rebalance-anchors.py ROLES), and the chance expectation."""
    roles = rebalance.role_dots(preset, final_screens)
    credits = Counter()
    expected = 0.0
    for group in shortcut.tracked_groups(preset["facePoints"]):
        face = preset["facePoints"][group[0]]["faceId"]
        if face not in roles:
            continue
        expected += 1 / roles[face]["size"]
        for role, tied in roles[face]["roles"].items():
            credits[role] += 1 / len(tied) if group[0] in tied else 0.0
    return dict(credits), expected


def pick(cands, n, rng, balance=None, keep=()):
    """Greedy spread pick of n names from cands {name: feat}, one per trajectory.

    balance {name: ({role: credit}, expected)} also steers the running role
    credits toward chance. Names in keep are chosen first, in order. Ties
    break at random. Returns the Cell.
    """
    cell = Cell()
    for name in keep:
        if name in cands and cands[name]["trajectory"] not in cell.trajectories:
            cell.add(name, cands[name], balance[name] if balance is not None else None)
    remaining = [name for name in cands if name not in cell.chosen]
    rng.shuffle(remaining)
    while len(cell.chosen) < n:
        best, best_score = None, None
        for name in remaining:
            feat = cands[name]
            if feat["trajectory"] in cell.trajectories:
                continue
            score = cell.spread(feat)
            if balance is not None:
                score -= BALANCE_WEIGHT * cell.deviation(balance[name])
            if best_score is None or score > best_score + 1e-9:
                best, best_score = name, score
        if best is None:
            break
        remaining.remove(best)
        cell.add(best, cands[best], balance[best] if balance is not None else None)
    return cell


def repair_balance(cell, cands, balance, slack=1.0, fixed=()):
    """Swaps chosen presets for spares until every role's credit is within
    slack of chance, keeping as much spread as possible. Names in fixed are
    never swapped out. Returns the Cell."""
    def build(names):
        c = Cell()
        for name in names:
            c.add(name, cands[name], balance[name])
        return c

    def worst(c):
        return max((abs(c.credits[r] - c.expected) for r in c.credits), default=0.0)

    names = list(cell.chosen)
    current = build(names)
    for _ in range(len(cands)):
        if worst(current) <= slack:
            break
        best = None
        spares = [s for s in cands if s not in names]
        for out in names:
            if out in fixed:
                continue
            kept_trajs = {cands[n]["trajectory"] for n in names if n != out}
            for spare in spares:
                if cands[spare]["trajectory"] in kept_trajs:
                    continue
                trial = [spare if n == out else n for n in names]
                c = build(trial)
                if c.deviation() >= current.deviation() - 1e-9:
                    continue
                score = sum(c.spread(cands[n]) for n in trial) / len(trial)
                key = (round(c.deviation(), 6), -score)
                if best is None or key < best[0]:
                    best = (key, trial, c)
        if best is None:
            break
        names, current = best[1], best[2]
    return current


# ── Pools ─────────────────────────────────────────────────────────────

def load_pool(tier, out_dir):
    """Valid presets per model from a generate-expert-dataset.py ledger:
    {model: {source: (preset, style)}}."""
    runner.TIER = tier
    states, _, records = runner.load_ledger(Path(out_dir) / "jobs", max_dry_jobs=10 ** 9)
    style_of = {stem: rec.get("style") for stem, rec in records}
    pool = {}
    for key, s in states.items():
        pool[key] = {source: (preset, style_of.get(source.split("::")[0]))
                     for source, preset in s["valid"].values()}
    return pool


def cmd_select(args):
    work = Path(args.work)
    work.mkdir(parents=True, exist_ok=True)
    rng = random.Random(args.seed)
    taken = {}  # sources already chosen, and the trajectories they use
    for path in args.exclude_meta:
        taken.update({m["source"]: n for n, m in json.loads(Path(path).read_text()).items()})
    for spec in args.pool:
        tier_s, _, out_dir = spec.partition("=")
        tier = int(tier_s)
        pool = load_pool(tier, ROOT / out_dir)
        bank, meta = {}, {}
        print(f"\n{TIER_NAMES[tier]} (d{tier}) from {out_dir}")
        print(f"{'model':<11}{'pool':>6}{'trajs':>7}{'picked':>8}{'tracked':>9}{'faces':>7}{'views':>7}")
        for key in args.models:
            items = pool.get(key, {})
            used = {features(p)["trajectory"] for src, (p, _) in items.items() if src in taken}
            cands = {src: features(p, style, src) for src, (p, style) in items.items()
                     if src not in taken and features(p)["trajectory"] not in used}
            cell = pick(cands, args.candidates, rng)
            for i, src in enumerate(cell.chosen, start=args.start_index):
                name = f"{key}-d{tier}-{i:02d}"
                bank[name] = items[src][0]
                meta[name] = {"source": src, "style": items[src][1]}
            print(f"{key:<11}{len(items):>6}{len({f['trajectory'] for f in cands.values()}):>7}"
                  f"{len(cell.chosen):>8}{len(cell.counts['tracked']):>9}{len(cell.counts['faces']):>7}"
                  f"{len(cell.counts['view']):>7}")
            if len(cell.chosen) < args.per_model and args.start_index == 1:
                print(f"  [short] {key} d{tier}: {len(cell.chosen)} candidates < {args.per_model}")
        stem = f"candidates-d{tier}{args.suffix}"
        (work / f"{stem}.json").write_text(json.dumps(bank, indent=2) + "\n")
        (work / f"{stem}.meta.json").write_text(json.dumps(meta, indent=2) + "\n")
        print(f"Written: {work / f'{stem}.json'} ({len(bank)} presets)")
    return 0


# ── Replay ────────────────────────────────────────────────────────────

def cmd_replay(args):
    """Runs validate-presets.js over a bank in parallel chunks and merges the
    reports. bun occasionally hangs at startup before printing anything, so a
    chunk whose log stays empty for --startup-timeout seconds is restarted."""
    import time
    bank = shortcut.load_bank([args.bank])
    names = sorted(bank)
    out = Path(args.out)
    chunks = []
    for k in range(min(args.chunks, len(names))):
        part = {n: bank[n] for n in names[k::args.chunks]}
        path = out.with_name(f"{out.stem}.part{k}.json")
        path.write_text(json.dumps(part))
        chunks.append({"bank": path, "report": out.with_name(f"{out.stem}.part{k}.report.json"),
                       "log": out.with_name(f"{out.stem}.part{k}.log"), "size": len(part), "attempts": 0})

    def start(chunk):
        chunk["report"].unlink(missing_ok=True)
        cmd = ["bun", "tools/validate-presets.js", "--inputs", str(chunk["bank"]), "--settle-ms", "800",
               "--server-url", args.server_url, "--report", str(chunk["report"])] + (["--trace"] if args.trace else [])
        chunk["proc"] = subprocess.Popen(cmd, cwd=ROOT, stdout=open(chunk["log"], "w"), stderr=subprocess.STDOUT)
        chunk["started"] = time.time()
        chunk["attempts"] += 1

    for chunk in chunks:
        start(chunk)
    while any(c["proc"].poll() is None for c in chunks):
        time.sleep(5)
        for chunk in chunks:
            proc, age = chunk["proc"], time.time() - chunk["started"]
            if proc.poll() is not None:
                continue
            stuck = age > args.startup_timeout and chunk["log"].stat().st_size == 0
            overdue = age > 300 + 60 * chunk["size"]
            if stuck or overdue:
                proc.kill()
                proc.wait()
                if chunk["attempts"] < 3:
                    print(f"[restart] {chunk['bank'].name}: {'no output' if stuck else 'overdue'}", flush=True)
                    start(chunk)
    results, missing = [], []
    for chunk in chunks:
        if not chunk["report"].exists():
            missing.append(chunk["bank"].name)
            continue
        results += json.loads(chunk["report"].read_text())["results"]
    passed = sum(1 for r in results if r.get("valid"))
    out.write_text(json.dumps({"total": len(results), "passed": passed, "failed": len(results) - passed,
                               "results": results}) + "\n")
    print(f"{'traced' if args.trace else 'validated'} {len(results)}/{len(names)}: {passed} ok, "
          f"{len(results) - passed} not ok -> {out}")
    if missing:
        print(f"[error] no report from {missing}", file=sys.stderr)
        return 1
    return 0


# ── Assembly ──────────────────────────────────────────────────────────

def load_render(render_dir):
    rows = {}
    for line in (render_dir / "dataset.jsonl").read_text().splitlines():
        if line.strip():
            row = json.loads(line)
            rows[row["meta_info"]["benchmark"]] = row  # a re-render replaces the earlier row
    meta, summaries = {}, {}
    for path in (render_dir / "metadata").glob("*_metadata.json"):
        meta.update(json.loads(path.read_text()))
    for path in (render_dir / "metadata").glob("*_summary.json"):
        summaries.update(json.loads(path.read_text()))
    return rows, meta, summaries


def renders_cleanly(summary):
    """Every point visible in the final frame and every non-hidden point in
    every frame, as recorded right after each screenshot (same rule as
    build-expert-hard-300.py)."""
    points, hidden = set(range(summary["totalPoints"])), set(summary["hiddenPoints"])
    if set(summary["states"][-1]["visiblePoints"]) != points:
        return False
    return all(points - hidden <= set(state["visiblePoints"]) for state in summary["states"])


def same_preset(a, b):
    keys = ("steps", "facePoints", "difficulty", "model", "pointRadius")
    return all(json.dumps(a.get(k), sort_keys=True) == json.dumps(b.get(k), sort_keys=True) for k in keys)


def usable(name, preset, report_row, render, render_dir):
    """Reason the candidate cannot ship, or None."""
    rows, meta, summaries = render
    if not report_row or not report_row.get("valid"):
        return "failed validation"
    if not (report_row.get("quality") or {}).get("finalScreens"):
        return "no final positions"
    row = rows.get(name)
    if row is None or name not in meta or name not in summaries:
        return "not rendered"
    if not same_preset(meta[name].get("presetConfig") or {}, preset):
        return "render is from a different preset"
    if not renders_cleanly(summaries[name]):
        return "point not visible in render"
    problems = checker.check_row(row, render_dir, {})
    if problems:
        return "dataset check: " + problems[0][1]
    return None


def letters_report(rows):
    counts = Counter()
    for row in rows:
        gold = json.loads(row["gt_answer"]) if isinstance(row["gt_answer"], str) else row["gt_answer"]
        counts.update(gold)
    return dict(sorted(counts.items()))


def rank_audit(cases):
    """How often the tracked dot is its group's extreme on simple position
    features, against chance (1 / group size). A feature far from chance
    lets a solver guess from the final image alone. Dots tied at the extreme
    share the credit, as for a solver picking among them at random; without
    that, mutual nearest neighbours (always tied as most isolated) credit
    whichever dot is listed first, and the tracked dot is listed first."""
    centre = (1280 / 2, 960 / 2)
    feats = {
        "middle (least summed distance)": lambda s, i, g: -sum(shortcut.dist(s[i], s[j]) for j in g),
        "most isolated": lambda s, i, g: min(shortcut.dist(s[i], s[j]) for j in g if j != i),
        "outermost (from group centroid)": lambda s, i, g: shortcut.dist(
            s[i], (sum(s[j][0] for j in g) / len(g), sum(s[j][1] for j in g) / len(g))),
        "leftmost": lambda s, i, g: -s[i][0],
        "topmost": lambda s, i, g: -s[i][1],
        "nearest image centre": lambda s, i, g: -shortcut.dist(s[i], centre),
    }
    out = {}
    for label, key in feats.items():
        hits = expected = var = 0.0
        groups = 0
        for points, screens in cases:
            for group in shortcut.tracked_groups(points):
                shown = [i for i in group if screens[i]]
                if len(shown) < 2 or not screens[group[0]]:
                    continue
                values = {i: key(screens, i, shown) for i in shown}
                top = max(values.values())
                tied = [i for i in shown if values[i] >= top - 1e-6]
                hits += 1 / len(tied) if group[0] in tied else 0.0
                p = 1 / len(shown)
                expected += p
                var += p * (1 - p)
                groups += 1
        z = (hits - expected) / math.sqrt(var) if var else 0.0
        out[label] = {"rate": round(hits / groups, 3) if groups else None,
                      "chance": round(expected / groups, 3) if groups else None, "z": round(z, 2)}
    return out


def load_inputs(args):
    bank = shortcut.load_bank(args.bank)
    meta = {}
    for path in args.meta:
        meta.update(json.loads(Path(path).read_text()))
    reports = {}
    for path in args.report:
        for row in json.loads(Path(path).read_text())["results"]:
            reports[row["name"]] = row
    render_dir = Path(args.render_dir)
    return bank, meta, reports, render_dir, load_render(render_dir)


def cell_size(args, tier, model):
    return args.cell_size.get(f"{TIER_NAMES[tier]}/{model}", args.per_model)


def parse_cell_sizes(items):
    """{"medium/bird": 22} from ["medium/bird=22", ...]."""
    out = {}
    for item in items:
        label, _, n = item.partition("=")
        tier, _, model = label.partition("/")
        if tier not in TIER_NAMES.values() or model not in MODELS or not n.isdigit():
            raise argparse.ArgumentTypeError(f"--cell-size expects TIER/MODEL=N, e.g. medium/bird=22; got {item!r}")
        out[label] = int(n)
    return out


def choose(args, bank, meta, reports, render_dir, render, exclude=(), keep=()):
    """Usable presets per (tier, model), then the spread pick with role
    balance. Usable names in keep stay chosen. Returns (chosen [(tier,
    model, name)], summary, short cells). Each cell draws from its own
    random stream, so adding candidates to one cell leaves the others' picks
    unchanged."""
    cells, rejected = {}, defaultdict(Counter)
    for name, preset in bank.items():
        key = (preset["difficulty"], MODEL_BY_PATH.get(preset["model"]))
        reason = "excluded" if name in exclude else usable(name, preset, reports.get(name), render, render_dir)
        if reason:
            rejected[key][reason] += 1
            continue
        cells.setdefault(key, {})[name] = preset

    chosen, summary, short = [], {}, []
    for tier in sorted({k[0] for k in cells} | {k[0] for k in rejected}):
        for model in args.models:
            key = (tier, model)
            presets = cells.get(key, {})
            cands = {n: features(p, (meta.get(n) or {}).get("style"), (meta.get(n) or {}).get("source", n))
                     for n, p in presets.items()}
            balance = {n: role_balance(p, reports[n]["quality"]["finalScreens"]) for n, p in presets.items()}
            size = cell_size(args, tier, model)
            fixed = sorted(n for n in keep if n in presets)[:size]
            cell = pick(cands, size, random.Random(f"{args.seed}:{tier}:{model}"), balance, keep=fixed)
            cell = repair_balance(cell, cands, balance, fixed=fixed)
            if len(cell.chosen) < size:
                short.append(f"{TIER_NAMES[tier]} {model}: {len(cell.chosen)}/{size}")
            chosen += [(tier, model, n) for n in sorted(cell.chosen)]
            summary[f"{TIER_NAMES[tier]}/{model}"] = {
                "presets": len(cell.chosen), "usable": len(presets), "rejected": dict(rejected[key]),
                "trajectories": len(cell.trajectories), "tracked_pairs": len(cell.counts["tracked"]),
                "panel_sets": len(cell.counts["faces"]), "views": len(cell.counts["view"]),
                "styles": dict(Counter(cands[n]["style"] for n in cell.chosen)) if tier == 5 else None,
                "jobs": len(cell.counts["job"]),
                "min_direction_gap_deg": round(math.degrees(min(
                    (angle(cands[a]["direction"], cands[b]["direction"])
                     for i, a in enumerate(cell.chosen) for b in cell.chosen[i + 1:]), default=0)), 1),
                "roles": {r: round(v, 1) for r, v in sorted(cell.credits.items())},
                "roles_chance": round(cell.expected, 1),
            }
    return chosen, summary, short


def answer_pairs(n_points, count, rng, kept=None):
    """count answer pairs over n_points letters, each pair used as evenly as
    possible, in random order. When count does not divide evenly, pairs that
    kept ({pair: presets}, from an earlier plan) already uses more than the
    even share get the extra uses first, so those presets keep their letters."""
    kept = kept or {}
    pairs = [(a, b) for a in range(n_points) for b in range(a + 1, n_points)]
    base, extra = divmod(count, len(pairs))
    over = [p for p in pairs if kept.get(p, 0) > base]
    rest = [p for p in pairs if kept.get(p, 0) <= base]
    rng.shuffle(over)
    rng.shuffle(rest)
    out = pairs * base + (over + rest)[:extra]
    rng.shuffle(out)
    return out


def relabel(preset, report_row, pair, rng):
    """Reorders preset's points so its two tracked dots take the letters of
    pair (indices), the rest in random order. Positions, hidden flags and
    validity are unchanged; report_row's finalScreens follow the new order."""
    points = preset["facePoints"]
    anchors = [i for i, p in enumerate(points) if not p.get("hidden")]
    others = [i for i in range(len(points)) if i not in anchors]
    rng.shuffle(anchors)
    rng.shuffle(others)
    order = [None] * len(points)  # new index -> old index
    order[pair[0]], order[pair[1]] = anchors
    rest = iter(others)
    order = [o if o is not None else next(rest) for o in order]
    new = dict(preset, facePoints=[points[o] for o in order])
    row = json.loads(json.dumps(report_row))
    screens = row["quality"]["finalScreens"]
    row["quality"]["finalScreens"] = [screens[o] for o in order]
    return new, row


def answer_of(preset):
    return tuple(i for i, p in enumerate(preset["facePoints"]) if not p.get("hidden"))


def cmd_plan(args):
    """Final pick, then answer letters spread evenly over every pair per tier.
    A preset kept from --previous plan keeps its letters; new picks take the
    pairs left over."""
    bank, meta, reports, render_dir, render = load_inputs(args)
    exclude = set(args.exclude)
    previous = shortcut.load_bank([args.previous]) if args.previous and Path(args.previous).exists() else {}

    def same_points(name):
        return name in previous and name in bank and \
            sorted(previous[name]["facePoints"], key=json.dumps) == sorted(bank[name]["facePoints"], key=json.dumps)

    keep = {n for n in previous if same_points(n)} if args.keep_previous else set()
    chosen, summary, short = choose(args, bank, meta, reports, render_dir, render, exclude, keep)
    if short and not args.allow_short:
        print("[error] short cells: " + "; ".join(short), file=sys.stderr)
        return 1
    rng = random.Random(args.seed + 1)
    out_bank, out_rows, out_meta = {}, [], {}
    for tier in sorted({t for t, _, _ in chosen}):
        names = [n for t, _, n in chosen if t == tier]
        n_points = len(bank[names[0]]["facePoints"])
        wanted = Counter(answer_pairs(n_points, len(names), rng,
                                      Counter(answer_of(previous[n]) for n in names if same_points(n))))
        fresh = []
        for name in names:
            kept = answer_of(previous[name]) if name in previous else None
            if kept and wanted[kept] > 0 and same_points(name):
                out_bank[name] = previous[name]
                wanted[kept] -= 1
                old_index = {json.dumps(p): i for i, p in enumerate(bank[name]["facePoints"])}
                row = json.loads(json.dumps(reports[name]))
                screens = row["quality"]["finalScreens"]
                row["quality"]["finalScreens"] = [screens[old_index[json.dumps(p)]] for p in previous[name]["facePoints"]]
                out_rows.append(row)
            else:
                fresh.append(name)
        left = [pair for pair, k in wanted.items() for _ in range(k)]
        rng.shuffle(left)
        for name, pair in zip(fresh, left):
            out_bank[name], row = relabel(bank[name], reports[name], pair, rng)
            out_rows.append(row)
        for name in names:
            out_meta[name] = meta.get(name) or {}
    work = Path(args.work)
    (work / "final-bank.json").write_text(json.dumps(out_bank, indent=2) + "\n")
    (work / "final-validation.json").write_text(json.dumps({"results": out_rows}) + "\n")
    (work / "final.meta.json").write_text(json.dumps(out_meta, indent=2) + "\n")
    kept = sum(1 for n in out_bank if n in previous and out_bank[n] is previous[n])
    print(f"planned {len(out_bank)} presets ({kept} kept from the previous plan) -> {work / 'final-bank.json'}")
    for tier in sorted({t for t, _, _ in chosen}):
        answers = Counter(answer_of(out_bank[n]) for t, _, n in chosen if t == tier)
        print(f"  {TIER_NAMES[tier]}: {len(answers)} distinct answer pairs, {min(answers.values())}-"
              f"{max(answers.values())} presets each")
    return 0


def readme(manifest):
    """Human summary of an assembled eval set, from its manifest."""
    cells, audits = manifest["cells"], manifest["audits"]
    tiers = [t for t in TIER_NAMES.values() if t in audits]
    per_tier = Counter()
    for label, n in manifest["cell_sizes"].items():
        per_tier[label.split("/")[0]] += n
    sizes = sorted(set(manifest["cell_sizes"].values()))
    per_cell = str(sizes[0]) if len(sizes) == 1 else f"{sizes[0]}–{sizes[-1]}"
    lines = [
        "# Origami point-tracking eval set",
        "",
        f"{manifest['total']} presets: " + ", ".join(f"{per_tier[t]} {t}" for t in tiers)
        + f", {per_cell} per origami model per tier, "
        f"over {len(manifest['models'])} models ({', '.join(manifest['models'])}). Built by `tools/build-eval.py`; "
        "tools/README.md (\"Build the eval set\") has the pipeline. Nothing here has been run against a model.",
        "",
        "Each row of `dataset.jsonl` is one question: the images in order, from the flat paper with its "
        "unmarked dots to the folded result with every dot lettered. `gt_answer` holds the letters of the "
        "initially shown dots. Score predictions with `tools/score-predictions.py --dataset eval/dataset.jsonl`.",
        "",
        "| tier | frames | dots | tracked dots | decoys |",
        "|---|---|---|---|---|",
    ]
    for t in tiers:
        a = audits[t]
        decoys = "6 on the tracked panels" + (", 2 on back panels" if t == "expert" else "")
        lines.append(f"| {t} | {'/'.join(map(str, a['frames']))} | {'/'.join(map(str, a['dots']))} | 2 | {decoys} |")
    lines += ["", "## Spread per cell", "",
              "Trajectories are distinct within a cell. Pairs and sets count distinct tracked-panel pairs and "
              "full panel sets; views count static camera directions; jobs count generation seeds. The gap is "
              "the smallest angle between two presets' final viewing directions in the paper's frame.", "",
              "| cell | presets | pairs | sets | views | jobs | min gap (deg) | styles |",
              "|---|---|---|---|---|---|---|---|"]
    for label, c in cells.items():
        styles = ", ".join(f"{k} {v}" for k, v in (c["styles"] or {}).items()) or "-"
        lines.append(f"| {label} | {c['presets']} | {c['tracked_pairs']} | {c['panel_sets']} | {c['views']} | "
                     f"{c['jobs']} | {c['min_direction_gap_deg']} | {styles} |")
    lines += ["", "## Shortcut audits", "",
              "Each tracked dot shares its panel with three decoys. The tracked dot was re-chosen within its "
              "group (`tools/rebalance-anchors.py`) so that, per model, it is the group's middle, most isolated "
              "and outermost dot at the chance rate. Ties split the credit. The table shows how often the "
              "tracked dot is its group's extreme on each position feature (chance 0.25).", "",
              "| feature | " + " | ".join(tiers) + " |", "|---|" + "---|" * len(tiers)]
    for feature in next(iter(audits.values()))["rank_features"]:
        cols = [f"{audits[t]['rank_features'][feature]['rate']:.3f} (z {audits[t]['rank_features'][feature]['z']:+.1f})"
                for t in tiers]
        lines.append(f"| {feature} | " + " | ".join(cols) + " |")
    lines += ["", "Answer letters: point order was set so every letter pair is the answer equally often per tier, "
              "so no fixed answer beats chance.", ""]
    for t in tiers:
        a, sc = audits[t], audits[t]["shortcuts"]
        counts = a["answer_pair_counts"]
        lines.append(f"- {t}: {a['answers_distinct']} distinct answer pairs, {counts[0]}-{counts[-1]} presets each; "
                     f"exact-match chance {sc['chance_exact']:.3f} (uniform over shown dots), "
                     f"{sc['group_chance_exact']:.3f} if the solver picks one dot per tracked group at random.")
    lines += ["", "Rows (`dataset.jsonl`), metadata (`metadata/`), images, the exact presets (`presets.json`) "
              "and their 800 ms replay report (`validation.json`) are all here; `manifest.json` has the numbers "
              "above and each preset's source job.", ""]
    return "\n".join(lines)


def cmd_assemble(args):
    out = Path(args.out)
    if out.exists():
        print(f"[error] {out} exists; remove it to rebuild", file=sys.stderr)
        return 1
    bank, meta, reports, render_dir, render = load_inputs(args)
    chosen, summary, short = choose(args, bank, meta, reports, render_dir, render)
    if short and not args.allow_short:
        print("[error] short cells: " + "; ".join(short) + " (pass --allow-short to write anyway)", file=sys.stderr)
        return 1

    rows, render_meta, summaries = render
    (out / "metadata").mkdir(parents=True)
    by_file = defaultdict(dict)
    jsonl = []
    for tier, model, name in chosen:
        row = rows[name]
        obj = row["meta_info"]["object"]
        by_file[f"{obj}_metadata.json"][name] = render_meta[name]
        by_file[f"{obj}_summary.json"][name] = summaries[name]
        subprocess.run(["cp", "-al", str(render_dir / row["id"]), str(out / row["id"])], check=True)
        jsonl.append(row)
    for filename, entries in by_file.items():
        (out / "metadata" / filename).write_text(json.dumps(entries, indent=1) + "\n")
    (out / "dataset.jsonl").write_text("".join(json.dumps(r) + "\n" for r in jsonl))
    (out / "presets.json").write_text(json.dumps({n: bank[n] for _, _, n in chosen}, indent=2) + "\n")
    (out / "validation.json").write_text(json.dumps({"results": [reports[n] for _, _, n in chosen]}) + "\n")

    audits = {}
    for tier in sorted({t for t, _, _ in chosen}):
        names = [n for t, _, n in chosen if t == tier]
        cases = [(bank[n]["facePoints"], reports[n]["quality"]["finalScreens"]) for n in names]
        tier_rows = [rows[n] for n in names]
        audits[TIER_NAMES[tier]] = {
            "shortcuts": shortcut.evaluate([(n, bank[n]["facePoints"], reports[n]["quality"]["finalScreens"])
                                            for n in names]),
            "rank_features": rank_audit(cases),
            "answer_letters": letters_report(tier_rows),
            "answers_distinct": len({r["gt_answer"] for r in tier_rows}),
            "answer_pair_counts": sorted(Counter(r["gt_answer"] for r in tier_rows).values()),
            "frames": sorted({len(r["images"]) for r in tier_rows}),
            "dots": sorted({len(r["meta_info"]["all_labels"]) for r in tier_rows}),
        }
    manifest = {"total": len(chosen), "models": args.models,
                "cell_sizes": {label: s["presets"] for label, s in summary.items()},
                "cells": summary, "audits": audits,
                "sources": {n: (meta.get(n) or {}).get("source") for _, _, n in chosen}}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (out / "README.md").write_text(readme(manifest))

    print(f"{'cell':<20}{'n':>4}{'usable':>7}{'trajs':>6}{'pairs':>6}{'sets':>5}{'views':>6}{'jobs':>5}"
          f"  mid/iso/out (chance)  rejected")
    for label, s in summary.items():
        roles = "/".join(f"{s['roles'].get(r, 0):g}" for r in ("middle", "isolated", "outermost"))
        print(f"{label:<20}{s['presets']:>4}{s['usable']:>7}{s['trajectories']:>6}{s['tracked_pairs']:>6}"
              f"{s['panel_sets']:>5}{s['views']:>6}{s['jobs']:>5}  {roles} ({s['roles_chance']:g})  "
              f"{s['rejected'] or ''}")
    for tier_name, a in audits.items():
        sc = a["shortcuts"]
        worst = max(a["rank_features"].items(), key=lambda kv: abs(kv[1]["z"]))
        print(f"{tier_name}: middle-dot {sc['anchor_middle_rate']:.3f} vs {sc['anchor_middle_chance']:.3f} "
              f"(z {sc['anchor_middle_z']:+.1f}); central-dots exact {sc['central_exact']:.3f} "
              f"(z {sc['central_z']:+.1f}); largest position-feature z {worst[1]['z']:+.1f} ({worst[0]}); "
              f"{a['answers_distinct']} distinct answers")
    print(f"Written: {out} ({len(chosen)} presets)")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    rep = sub.add_parser("replay")
    rep.add_argument("--bank", required=True)
    rep.add_argument("--out", required=True, help="Merged report path.")
    rep.add_argument("--trace", action="store_true", help="Record per-step dot traces instead of validating.")
    rep.add_argument("--chunks", type=int, default=4)
    rep.add_argument("--server-url", default="http://localhost:3021")
    rep.add_argument("--startup-timeout", type=int, default=90)
    for name in ("select", "plan", "assemble"):
        p = sub.add_parser(name)
        p.add_argument("--models", default=",".join(MODELS), type=lambda s: [m for m in s.split(",") if m])
        p.add_argument("--per-model", type=int, default=20)
        p.add_argument("--seed", type=int, default=20260929)
        p.add_argument("--work", default="new_dataset/eval-work")
        if name != "select":
            p.add_argument("--cell-size", action="append", default=[], metavar="TIER/MODEL=N",
                           help="Size of one cell instead of --per-model, e.g. medium/bird=22. Repeatable.")
    sel = sub.choices["select"]
    sel.add_argument("--pool", action="append", required=True, metavar="TIER=OUT_DIR",
                     help="Runner output directory per tier, e.g. 3=new_dataset/medium-v2. Repeatable.")
    sel.add_argument("--candidates", type=int, default=26, help="Candidates per (tier, model).")
    sel.add_argument("--suffix", default="", help="Appended to output names, to select some models early.")
    sel.add_argument("--exclude-meta", action="append", default=[],
                     help="Earlier candidates-*.meta.json; their presets and trajectories are skipped. Repeatable.")
    sel.add_argument("--start-index", type=int, default=1, help="First candidate number, for spares.")
    for name in ("plan", "assemble"):
        asm = sub.choices[name]
        asm.add_argument("--bank", action="append", required=True, help="Preset bank. Repeatable.")
        asm.add_argument("--meta", action="append", default=[], help="Candidate meta file. Repeatable.")
        asm.add_argument("--report", action="append", required=True, help="validate-presets.js report. Repeatable.")
        asm.add_argument("--render-dir", required=True)
        asm.add_argument("--allow-short", action="store_true")
    sub.choices["assemble"].add_argument("--out", default="eval")
    sub.choices["plan"].add_argument("--previous", default="new_dataset/eval-work/final-bank.json",
                                     help="Earlier final-bank.json; presets still chosen keep their letters.")
    sub.choices["plan"].add_argument("--exclude", action="append", default=[],
                                     help="Candidate to leave out, e.g. one whose final render failed. Repeatable.")
    sub.choices["plan"].add_argument("--keep-previous", action="store_true",
                                     help="Keep every still-usable preset of --previous and pick only the rest, "
                                          "to grow cells without changing presets already chosen.")
    args = parser.parse_args(argv)
    if hasattr(args, "cell_size"):
        try:
            args.cell_size = parse_cell_sizes(args.cell_size)
        except argparse.ArgumentTypeError as e:
            parser.error(str(e))
    return {"select": cmd_select, "replay": cmd_replay, "plan": cmd_plan, "assemble": cmd_assemble}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
