#!/usr/bin/env python3
"""
Generate a model-balanced dataset for a clustered tier: expert (5, default)
or medium (3, --difficulty 3).

Each job runs generate-presets.js for one model with a fresh seed, then
replays the job's presets with validate-presets.js at 800 ms. Only presets
that pass the replay count toward a model's goal. Each model below its goal
receives an equal share of workers, and the model furthest behind goes first;
slots that no model can use within its share go past it. A model that
finishes --max-dry-jobs consecutive jobs without a new valid preset stops
receiving jobs, and its unmet share moves to the other models. Yield rates
and dry streaks count only jobs run under the current per-job settings, so
changing the search budget gives every model a fresh start.

Assembly splits --total as evenly as the per-model yields allow and rotates
through camera views within each model. Rendering follows unless
--skip-render is set.

Start a server whose DATASET_DIR matches --render-dir, then run:

  DATASET_DIR=new_dataset/expert-300-render PORT=3001 bun run dev
  python3 tools/generate-expert-dataset.py --total 300 --server-url http://localhost:3001

Medium uses the same runner with its own directories:

  python3 tools/generate-expert-dataset.py --difficulty 3 --total 238 \
    --out-dir new_dataset/medium-v2 --render-dir new_dataset/medium-v2-render

Rerunning the command resumes from the job records in <out-dir>/jobs/.
"""
import argparse
import importlib.util
import json
import math
import os
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("shortcut_baselines", Path(__file__).with_name("shortcut-baselines.py"))
shortcut = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(shortcut)
MODELS = [
    ("simplevertex", "/SimpleFolds/simpleVertex.svg"),
    ("bird",         "/Bases/birdBase.svg"),
    ("waterbomb",    "/Bases/waterbombBase.svg"),
    ("pinwheel",     "/Bases/pinwheelBase.svg"),
    ("boat",         "/Bases/boatBase.svg"),
    ("mapfold",      "/SimpleFolds/mapfold.svg"),
    ("opensink",     "/Bases/openSinkBase.svg"),
    ("square",       "/Bases/squareBase.svg"),
]
MODEL_KEYS = {path: key for key, path in MODELS}
# Clustered presets twin every dot under a rotation the folded model carries
# (js/presetGenerator.js, Symmetric twins). Folded mapfold carries none, so
# frame matching could not be blocked on it.
UNTWINNABLE = {"mapfold"}
JOB_STEM = re.compile(r"^([a-z]+)-d(\d)-j(\d+)$")
SEED_STRIDE = 7919
# Expert motion styles in js/presetGenerator.js (EXPERT_STYLES). Jobs rotate
# through them so the dataset mixes kinds of motion. Spin is left out: its
# frames look alike on symmetric bases. Tumble is left out for yield: in the
# first 150-preset run it produced 1 valid preset in 17 jobs, against about
# one per two jobs for detour and pendulum.
MOTION_STYLES = ["detour", "pendulum"]
# Same search budget as generate-uniform-1000.py continuation passes.
# Bump when the trajectory search changes, so yield statistics restart.
# 2: clustered tiers drop the placeholder face-0 gates and probe the final
#    frame first (evaluateTrajectoriesLive in js/benchmark.js).
# 3: the final frame must show readable panel and twin-panel pairs.
SEARCH_VERSION = 3
# Assembly keeps at most this many presets per (model, tracked + back panels).
MAX_PER_FACE_SET = 3
BUILD = 300
MAX_TRAJ = 1200
MAX_SCAN = 60

LIVE_PROCS = set()
LIVE_LOCK = threading.Lock()
STOP = threading.Event()


class ServerUnreachable(RuntimeError):
    pass


def fail(msg):
    print(f"[error] {msg}", file=sys.stderr)
    sys.exit(1)


def preset_signature(preset):
    # Matches assemble-uniform-1000.py: replays under new names or seeds count once.
    content = {k: v for k, v in preset.items() if not k.startswith("_") and k not in ("seed", "rngSeed")}
    return json.dumps(content, sort_keys=True, separators=(",", ":"))


# Clustered tiers: dot-count ranges and frames from TIER_LAYOUTS and
# TIER_FRAME_COUNT in js/presetGenerator.js. Both use CLUSTER_POINT_RADIUS.
TIER_CONTRACTS = {3: {"points": (10, 14), "frames": 10}, 5: {"points": (12, 20), "frames": 14}}
CLUSTER_POINT_RADIUS = 0.018
# The tier this run generates; main() sets it from --difficulty.
TIER = 5
# Rotation profiles per camera view when --rotation-profile-count is unset.
# Medium profiles are cheap ramps; expert's detours need a wider search.
DEFAULT_PROFILE_COUNT = {3: 60, 5: 180}


# Dot totals for this run when --cluster-points overrides the tier's range,
# and scatter dots per preset (before twins) when --cluster-scatter sets them,
# and dots per group (before twins) when --cluster-group-size sets them.
# --cluster-end-sizes draws each dot in the last image at its own size; the
# sizes live in the presets, so only generation needs the flag.
CLUSTER_POINTS = None
CLUSTER_SCATTER = None
CLUSTER_GROUP_SIZE = None
CLUSTER_BACK_GROUPS = None
CLUSTER_END_SIZES = None
# --cluster-spin-turns widens medium's spin (turns either way); generation only.
CLUSTER_SPIN_TURNS = None
# --symmetric-twins: tracked dots' twins meet the tracked dots' rules in every
# frame (generation only; presets record symmetricTwins for validation).
SYMMETRIC_TWINS = False


def cluster_flags():
    """The run's layout overrides, as generate-presets.js and validate-presets.js flags."""
    flags = []
    for flag, value in (("--cluster-points", CLUSTER_POINTS), ("--cluster-scatter", CLUSTER_SCATTER),
                        ("--cluster-group-size", CLUSTER_GROUP_SIZE), ("--cluster-back-groups", CLUSTER_BACK_GROUPS)):
        if value:
            flags += [flag, ",".join(map(str, value))]
    return flags


def meets_tier_contract(preset):
    """Excludes banks from earlier contracts of the current tier (other dot
    counts or frames, full-size dots, or presets without twins, which predate
    clusterPlacement.symmetry), and presets from other tiers."""
    contract = TIER_CONTRACTS[TIER]
    points = preset.get("facePoints")
    radius = preset.get("pointRadius")
    low, high = CLUSTER_POINTS or contract["points"]
    return (preset.get("difficulty") == TIER and isinstance(points, list) and low <= len(points) <= high
            and len(preset.get("steps") or []) == contract["frames"]
            and radius is not None and radius <= CLUSTER_POINT_RADIUS
            and isinstance(preset.get("clusterPlacement"), dict) and bool(preset["clusterPlacement"].get("symmetry")))


def allocate(capacity, total):
    """Split total as evenly as capacity allows. Remainders go to the models
    with the most spare capacity, then to earlier models."""
    quota = {key: 0 for key in capacity}
    remaining = min(total, sum(capacity.values()))
    while remaining > 0:
        open_keys = [k for k in capacity if quota[k] < capacity[k]]
        if not open_keys:
            break
        share, extra = divmod(remaining, len(open_keys))
        if share == 0:
            for k in sorted(open_keys, key=lambda k: -(capacity[k] - quota[k]))[:extra]:
                quota[k] += 1
            break
        for k in open_keys:
            add = min(share, capacity[k] - quota[k])
            quota[k] += add
            remaining -= add
    return quota


def spread_by_view(items, n):
    """Take n (name, preset) pairs round-robin across static camera views."""
    groups = {}
    for name, preset in items:
        groups.setdefault(json.dumps(preset["steps"][0].get("pov")), []).append((name, preset))
    queues = list(groups.values())
    picked = []
    while len(picked) < n and any(queues):
        for queue in queues:
            if queue and len(picked) < n:
                picked.append(queue.pop(0))
    return picked


def new_state():
    # middle: signature -> (groups whose anchor is the middle dot, groups), from
    # the final positions in the job's validation report.
    return {"valid": {}, "middle": {}, "jobs_done": 0, "yielded": 0, "inflight": 0, "dry_streak": 0, "retired": False}


def goals_for(states, total):
    # Retired models keep what they found; active models share the rest.
    return allocate({k: len(s["valid"]) if s["retired"] else total for k, s in states.items()}, total)


def pick_model(states, goals, workers):
    """Pick the model furthest behind its goal among those under an equal
    share of workers. Spare slots go past the share rather than idling."""
    needing = [k for k, s in states.items() if not s["retired"] and len(s["valid"]) < goals[k]]
    if not needing:
        return None
    share = math.ceil(workers / len(needing))
    for cap in (share, workers):
        best = None
        for key in needing:
            s = states[key]
            # Prior of one preset per job until the model has a track record.
            rate = (s["yielded"] + 1) / (s["jobs_done"] + 1)
            need = goals[key] - len(s["valid"])
            # A model with nothing after two jobs keeps one probe job running
            # instead of claiming a full share as the model furthest behind.
            limit = 1 if s["yielded"] == 0 and s["jobs_done"] >= 2 else min(cap, math.ceil(need / rate))
            if s["inflight"] >= limit:
                continue
            progress = (len(s["valid"]) + s["inflight"] * rate) / goals[key]
            if best is None or progress < best[0]:
                best = (progress, key)
        if best:
            return best[1]
    return None


def record_job(s, new_valid, max_dry_jobs):
    s["jobs_done"] += 1
    s["yielded"] += new_valid
    s["dry_streak"] = 0 if new_valid else s["dry_streak"] + 1
    if s["dry_streak"] >= max_dry_jobs:
        s["retired"] = True


def absorb(s, stem, bank, passed, screens=None, views=None):
    new_valid = 0
    for name in passed:
        preset = bank.get(name)
        if not preset or not meets_tier_contract(preset):
            continue
        signature = preset_signature(preset)
        if signature in s["valid"]:
            continue
        s["valid"][signature] = (f"{stem}::{name}", preset)
        if screens and screens.get(name):
            s.setdefault("middle", {})[signature] = shortcut.anchor_middle_stats(preset["facePoints"], screens[name])
        if views and views.get(name):
            s.setdefault("facing", {})[signature] = twin_facing(preset, views[name])
        new_valid += 1
    return new_valid


def twin_facing(preset, ratios):
    """[tracked groups facing the camera more than their twin group, groups
    compared]; balanced when the first is half the second."""
    return list(shortcut.twin_facing_rate({0: preset}, {0: ratios}))


def read_views(report_path):
    """Final-frame viewing ratios per dot, by preset name, from a validate-presets.js report."""
    report = read_json(report_path, {"results": []})
    return {r["name"]: (r.get("quality") or {}).get("finalViewQuality")
            for r in report.get("results", []) if (r.get("quality") or {}).get("finalViewQuality")}


def read_screens(report_path):
    """Final-frame dot positions by preset name from a validate-presets.js report."""
    report = read_json(report_path, {"results": []})
    return {r["name"]: (r.get("quality") or {}).get("finalScreens")
            for r in report.get("results", []) if (r.get("quality") or {}).get("finalScreens")}


def read_json(path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def counts_toward_stats(record, settings_for):
    if record.get("imported") or record.get("error"):
        return False
    return settings_for is None or record.get("settings") == settings_for(record["model"])


def load_ledger(jobs_dir, max_dry_jobs, settings_for=None):
    """Rebuild model states from job records. With settings_for, only jobs run
    under the model's current settings count toward yield rates and dry
    streaks. Failed jobs never count."""
    states = {key: new_state() for key, _ in MODELS}
    records = []
    for done in jobs_dir.glob("*.done.json"):
        record = read_json(done, None)
        if record and record.get("model") in states:
            records.append((done.name[:-len(".done.json")], record))
    # Imports first, then jobs in launch order, so dry streaks replay faithfully.
    records.sort(key=lambda item: (not item[1].get("imported"), item[1].get("job", 0), item[0]))
    next_job = 1
    for stem, record in records:
        s = states[record["model"]]
        new_valid = absorb(s, stem, read_json(jobs_dir / f"{stem}.json", {}), record.get("passed", []),
                           read_screens(jobs_dir / f"{stem}.validation.json"), read_views(jobs_dir / f"{stem}.validation.json"))
        if not record.get("imported"):
            if counts_toward_stats(record, settings_for):
                record_job(s, new_valid, max_dry_jobs)
            next_job = max(next_job, record["job"] + 1)
    return states, next_job, records


def least_turn_lean(preset):
    """+0.5 when a twinned preset's real final pose turns less than its twin
    pose, -0.5 when it turns more, 0 when the preset has no twins."""
    hits, n = shortcut.least_turn_rate({0: preset})
    return hits - n / 2


def balance_middle(candidates, middle, n, facing=None):
    """Picks n of candidates, in order, keeping the anchor-middle rate near
    chance, the least-turn guess right about half the time, and tracked
    groups facing the camera more than their twins about half the time
    (`facing`: twin_facing counts by signature; unmeasured counts as balanced).

    Anchor-centred groups fit narrow panels more easily, so they survive
    validation more often and a plain pick over-represents them. Presets
    from one trajectory share a final pose, so the least-turn rate swings
    from run to run (medium: 20 of 49, then 34 of 54). Each step takes the
    earliest candidate that keeps both running counts closest to chance.
    Unmeasured candidates count as exactly at chance for the middle dot.
    """
    facing = facing or {}
    picked, hits, groups, expected, lean, face_lean = [], 0, 0, 0.0, 0.0, 0.0
    remaining = list(candidates)
    while remaining and len(picked) < n:
        def deviation(item):
            signature, (_, preset) = item
            turn = least_turn_lean(preset)
            counts = facing.get(signature)
            face = counts[0] - counts[1] / 2 if counts else 0.0
            balance = abs(lean + turn) + abs(face_lean + face)
            counted = middle.get(signature)
            if counted is None:
                return balance, 0, 0, 0.0, turn, face
            h, g, chance = middle_stats(counted, preset)
            return abs(hits + h - (expected + chance)) + balance, h, g, chance, turn, face
        # Ties go to fewer middle-dot hits: pools skew toward central anchors.
        best = min(range(len(remaining)), key=lambda i: (deviation(remaining[i])[0], deviation(remaining[i])[1]))
        _, h, g, e, turn, face = deviation(remaining[best])
        hits, groups, expected, lean, face_lean = hits + h, groups + g, expected + e, lean + turn, face_lean + face
        picked.append(remaining.pop(best))
    return picked, [hits, groups], round(expected, 3)


def face_set(preset):
    return tuple(sorted({p["faceId"] for p in preset["facePoints"]}))


def cap_face_sets(candidates, limit=MAX_PER_FACE_SET):
    """Drops candidates beyond `limit` per panel combination, keeping order."""
    seen, kept = {}, []
    for item in candidates:
        key = face_set(item[1][1])
        seen[key] = seen.get(key, 0) + 1
        if seen[key] <= limit:
            kept.append(item)
    return kept


def middle_stats(counted, preset):
    """(hits, groups, chance hits) from an anchor_middle_stats record. Records
    from before variable group sizes hold (hits, groups); their groups all
    had the size of the preset's first tracked group."""
    if len(counted) > 2:
        return counted[0], counted[1], counted[2]
    size = len(shortcut.tracked_groups(preset["facePoints"])[0]) if preset["facePoints"] else 1
    return counted[0], counted[1], counted[1] / size


def balanced_capacity(candidates, middle):
    """Largest number of candidates that keeps the anchor-middle rate at or
    below chance: all measured groups' hits within their chance expectation."""
    known, neutral = [], 0
    for signature, (_, preset) in candidates:
        counted = middle.get(signature)
        if counted is None:
            neutral += 1
            continue
        h, _, chance = middle_stats(counted, preset)
        known.append(h - chance)  # excess hits over chance
    known.sort()
    excess, kept = 0.0, 0
    for surplus in known:
        if excess + surplus > 1e-9:
            break
        excess += surplus
        kept += 1
    return kept + neutral


def assemble(states, total):
    candidates, capacity = {}, {}
    for key, _ in MODELS:
        if key not in states:
            continue
        s = states[key]
        by_source = {source: signature for signature, (source, _) in s["valid"].items()}
        ordered = spread_by_view(list(s["valid"].values()), len(s["valid"]))
        candidates[key] = cap_face_sets([(by_source[source], (source, preset)) for source, preset in ordered])
        capacity[key] = balanced_capacity(candidates[key], s.get("middle", {}))
    quota = allocate(capacity, total)
    assembled, summary = {}, {}
    for key, _ in MODELS:
        if key not in states:
            continue
        s = states[key]
        chosen, anchor_middle, middle_chance = balance_middle(candidates[key], s.get("middle", {}), quota[key],
                                                              s.get("facing", {}))
        picked = [item for _, item in chosen]
        for i, (_, preset) in enumerate(picked, start=1):
            assembled[f"{key}-d{TIER}-{i:02d}"] = preset
        summary[key] = {
            "available": len(s["valid"]), "usable": capacity[key], "kept": len(picked),
            "views": len({json.dumps(p["steps"][0].get("pov")) for _, p in picked}),
            "jobs": s["jobs_done"], "retired": s["retired"], "anchor_middle": anchor_middle,
            "anchor_middle_chance": middle_chance,
            # Twinned presets whose real final pose turns less than the twin pose.
            "least_turn": list(shortcut.least_turn_rate({i: preset for i, (_, preset) in enumerate(picked)})),
            # Tracked groups facing the camera more than their twin groups, groups compared.
            "twin_facing": [sum(c[k] for c in (s.get("facing", {}).get(sig) for sig, _ in chosen) if c) for k in (0, 1)],
            "sources": [source for source, _ in picked],
        }
    return assembled, summary


def descendants(pid):
    children = {}
    for stat in Path("/proc").glob("[0-9]*/stat"):
        try:
            # Fields after the parenthesized command: state, ppid, ...
            fields = stat.read_text().rsplit(")", 1)[1].split()
        except (OSError, IndexError):
            continue
        children.setdefault(int(fields[1]), []).append(int(stat.parent.name))
    found, stack = [], [pid]
    while stack:
        for child in children.get(stack.pop(), []):
            found.append(child)
            stack.append(child)
    return found


def kill_tree(pid):
    # Puppeteer starts Chrome in its own process group, so killing the job's
    # group would orphan a browser that keeps generating. Collect the tree
    # while the parent links still exist.
    for target in [pid] + descendants(pid):
        try:
            os.kill(target, signal.SIGKILL)
        except ProcessLookupError:
            pass


def run_logged(cmd, log_fh, timeout_s):
    with LIVE_LOCK:
        if STOP.is_set():
            return "stopped"
        proc = subprocess.Popen(cmd, cwd=ROOT, stdout=log_fh, stderr=subprocess.STDOUT)
        LIVE_PROCS.add(proc)
    try:
        return proc.wait(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        kill_tree(proc.pid)
        proc.wait()
        return "timeout"
    finally:
        with LIVE_LOCK:
            LIVE_PROCS.discard(proc)


def stop_jobs(*_):
    STOP.set()
    with LIVE_LOCK:
        for proc in LIVE_PROCS:
            kill_tree(proc.pid)


def job_processes(bank_path):
    """Generator or validator processes, alive, that read or write bank_path."""
    target, found = str(bank_path), {}
    for path in Path("/proc").glob("[0-9]*/cmdline"):
        try:
            argv = [a.decode(errors="replace") for a in path.read_bytes().split(b"\0") if a]
        except OSError:
            continue
        if argv and argv[0].endswith("bun") and target in argv:
            found[int(path.parent.name)] = argv
    return found


def generator_cmdline(bank_path):
    argvs = list(job_processes(bank_path).values())
    return next((a for a in argvs if "tools/generate-presets.js" in a), argvs[0] if argvs else [])


def arg_value(argv, flag):
    return argv[argv.index(flag) + 1] if flag in argv[:-1] else None


def find_orphans(jobs_dir, logs_dir, cmdline_for):
    """Jobs left by a driver that died: a log without a done record whose
    generator is still running or already wrote its bank."""
    orphans = []
    for log in sorted(logs_dir.glob("*.log")):
        match = JOB_STEM.match(log.stem)
        if not match or int(match.group(2)) != TIER or (jobs_dir / f"{log.stem}.done.json").exists():
            continue
        argv = cmdline_for(log.stem)
        if not argv and not (jobs_dir / f"{log.stem}.json").exists():
            continue  # Killed before writing a bank.
        count, profiles, seed = (arg_value(argv, flag) for flag in ("--count", "--rotation-profile-count", "--seed"))
        orphans.append({"key": match.group(1), "job": int(match.group(3)), "stem": log.stem,
                        "seed": int(seed) if seed else None,
                        "settings": {"count_per_job": int(count), "rotation_profile_count": int(profiles)}
                        if count and profiles else None})
    return orphans


def next_job_number(jobs_dir, logs_dir):
    # Count every job file, so running orphans and killed jobs keep their numbers.
    numbers = [int(m.group(3)) for path in [*jobs_dir.iterdir(), *logs_dir.iterdir()]
               if (m := JOB_STEM.match(path.name.split(".")[0]))]
    return max(numbers, default=0) + 1


def validate_bank(bank_path, report_path, log_fh, args):
    report_path.unlink(missing_ok=True)
    run_logged(["bun", "tools/validate-presets.js", "--inputs", str(bank_path),
                "--settle-ms", str(args.settle_ms), "--server-url", args.server_url,
                "--report", str(report_path), *cluster_flags()],
               log_fh, args.job_timeout_min * 60)
    report = read_json(report_path, {"results": []})
    return [r["name"] for r in report.get("results", []) if r.get("valid")]


def job_settings(args, key):
    overrides = dict(item.split("=", 1) for item in args.profile_override)
    settings = {"count_per_job": args.count_per_job,
                "rotation_profile_count": int(overrides.get(key, args.rotation_profile_count or DEFAULT_PROFILE_COUNT[TIER])),
                "search": SEARCH_VERSION}
    if CLUSTER_POINTS:
        settings["cluster_points"] = list(CLUSTER_POINTS)
    if CLUSTER_SCATTER:
        settings["cluster_scatter"] = list(CLUSTER_SCATTER)
    if CLUSTER_GROUP_SIZE:
        settings["cluster_group_size"] = list(CLUSTER_GROUP_SIZE)
    if CLUSTER_BACK_GROUPS:
        settings["cluster_back_groups"] = list(CLUSTER_BACK_GROUPS)
    if CLUSTER_END_SIZES:
        settings["cluster_end_sizes"] = list(CLUSTER_END_SIZES)
    if CLUSTER_SPIN_TURNS:
        settings["cluster_spin_turns"] = CLUSTER_SPIN_TURNS
    if SYMMETRIC_TWINS:
        settings["symmetric_twins"] = True
    # Only overridden models record a settle, so other models keep their
    # yield statistics.
    settles = dict(item.split("=", 1) for item in getattr(args, "settle_override", []))
    if key in settles:
        settings["scan_settle_ms"] = int(settles[key])
    return settings


def motion_style(job):
    # Kept out of job_settings: the ledger resets yield statistics whenever
    # settings change, and the style changes on every job. Medium keeps its
    # own ramp profiles, so it has no style.
    return MOTION_STYLES[job % len(MOTION_STYLES)] if TIER == 5 else None


def check_server_reached(log_path, since=0):
    # A dead server fails every page load. Recording that as a dry job would
    # retire productive models, so the job stays unrecorded for adoption.
    if b"ERR_CONNECTION_REFUSED" in log_path.read_bytes()[since:]:
        raise ServerUnreachable(f"server refused a connection during {log_path.stem}")


def job_error(returncode, log_path):
    if returncode == "timeout":
        return "job timeout"
    # generate-presets.js reports a puppeteer protocol timeout and exits 1.
    if "callFunctionOn timed out" in log_path.read_text(errors="replace"):
        return "protocol timeout"
    return None


def run_job(key, job, args, jobs_dir, logs_dir):
    stem = f"{key}-d{TIER}-j{job:04d}"
    bank_path = jobs_dir / f"{stem}.json"
    seed = args.base_seed + job * SEED_STRIDE
    started = time.time()
    settings = job_settings(args, key)
    style = motion_style(job)
    record = {"model": key, "job": job, "seed": seed, "imported": False, "settings": settings, "style": style}
    with open(logs_dir / f"{stem}.log", "w") as log_fh:
        record["returncode"] = run_logged([
            "bun", "tools/generate-presets.js",
            "--model", dict(MODELS)[key], "--difficulty", str(TIER),
            "--count", str(args.count_per_job), "--base-name", f"{key}-d{TIER}",
            "--start-index", str(job * 100 + 1), "--templates", "no-match-pattern-*",
            "--seed", str(seed), "--output", str(bank_path),
            "--server-url", args.server_url, "--min-point-view-quality", "0.3",
            "--build-progressions", str(BUILD), "--max-trajectory-candidates", str(MAX_TRAJ),
            "--max-scan-candidates", str(MAX_SCAN),
            "--rotation-profile-count", str(settings["rotation_profile_count"]),
            *(["--expert-motion-style", style] if style else []),
            *cluster_flags(),
            *(["--cluster-end-sizes", ",".join(map(str, CLUSTER_END_SIZES))] if CLUSTER_END_SIZES else []),
            *(["--cluster-spin-turns", str(CLUSTER_SPIN_TURNS)] if CLUSTER_SPIN_TURNS else []),
            *(["--symmetric-twins"] if SYMMETRIC_TWINS else []),
            *(["--scan-settle-ms", str(settings["scan_settle_ms"])] if "scan_settle_ms" in settings else []),
            # One search per job: a retry would repeat hours of Phase 2 work.
            "--protocol-timeout-ms", str(args.job_timeout_min * 60_000), "--max-attempts", "1",
        ], log_fh, args.job_timeout_min * 60)
        bank = read_json(bank_path, {})
        log_fh.flush()
        if error := job_error(record["returncode"], logs_dir / f"{stem}.log"):
            record["error"] = error
        record["generated"] = len(bank)
        record["passed"] = validate_bank(bank_path, jobs_dir / f"{stem}.validation.json", log_fh, args) if bank else []
    check_server_reached(logs_dir / f"{stem}.log")
    record["elapsed_s"] = round(time.time() - started)
    if STOP.is_set():
        return None  # Interrupted jobs rerun on resume instead of counting as dry.
    (jobs_dir / f"{stem}.done.json").write_text(json.dumps(record, indent=2) + "\n")
    return stem, record, bank


def adopt_job(orphan, args, jobs_dir, logs_dir):
    stem = orphan["stem"]
    bank_path = jobs_dir / f"{stem}.json"
    deadline = time.time() + args.job_timeout_min * 60
    while job_processes(bank_path):
        if time.time() > deadline:
            for pid in job_processes(bank_path):
                kill_tree(pid)
            break
        if STOP.wait(20):
            return None
    bank = read_json(bank_path, {})
    record = {"model": orphan["key"], "job": orphan["job"], "seed": orphan["seed"], "imported": False,
              "adopted": True, "settings": orphan["settings"], "generated": len(bank)}
    if error := job_error(None, logs_dir / f"{stem}.log"):
        record["error"] = error
    log_path = logs_dir / f"{stem}.log"
    since = log_path.stat().st_size
    with open(log_path, "a") as log_fh:
        record["passed"] = validate_bank(bank_path, jobs_dir / f"{stem}.validation.json", log_fh, args) if bank else []
    check_server_reached(log_path, since)
    if STOP.is_set():
        return None
    (jobs_dir / f"{stem}.done.json").write_text(json.dumps(record, indent=2) + "\n")
    return stem, record, bank


def run_import(key, stem, args, jobs_dir, logs_dir):
    bank_path = jobs_dir / f"{stem}.json"
    bank = read_json(bank_path, {})
    with open(logs_dir / f"{stem}.log", "w") as log_fh:
        passed = validate_bank(bank_path, jobs_dir / f"{stem}.validation.json", log_fh, args)
    check_server_reached(logs_dir / f"{stem}.log")
    if STOP.is_set():
        return None
    record = {"model": key, "job": 0, "imported": True, "generated": len(bank), "passed": passed}
    (jobs_dir / f"{stem}.done.json").write_text(json.dumps(record, indent=2) + "\n")
    return stem, record, bank


def stage_imports(patterns, jobs_dir):
    """Copy existing banks into the job ledger, one file per model."""
    staged = []
    for pattern in patterns:
        for path in sorted(ROOT.glob(pattern)):
            by_model = {}
            for name, preset in read_json(path, {}).items():
                key = MODEL_KEYS.get(preset.get("model")) if isinstance(preset, dict) else None
                if key and meets_tier_contract(preset):
                    by_model.setdefault(key, {})[name] = preset
            for key, bank in by_model.items():
                stem = f"import-{key}-{path.stem}"
                if (jobs_dir / f"{stem}.done.json").exists():
                    continue
                (jobs_dir / f"{stem}.json").write_text(json.dumps(bank, indent=2) + "\n")
                staged.append((key, stem))
    return staged


def check_dev_server(server_url, render_dir):
    # The server has no DATASET_DIR endpoint; a sentinel write reveals it.
    sentinel = ".dataset-dir-check.jsonl"
    target = ROOT / render_dir / sentinel
    target.unlink(missing_ok=True)
    body = json.dumps({"path": sentinel, "line": "{}", "fresh": True}).encode("utf-8")
    request = urllib.request.Request(f"{server_url}/api/jsonl-append", data=body, method="POST",
                                     headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(request, timeout=5).read()
    except Exception as e:
        fail(f"server at {server_url} unreachable ({e}); start it with 'DATASET_DIR={render_dir} bun run dev'")
    if not target.exists():
        fail(f"server at {server_url} writes outside {render_dir}; restart it with 'DATASET_DIR={render_dir} bun run dev'")
    target.unlink()


def write_progress(out_dir, states, goals, started):
    progress = {"elapsed_s": round(time.time() - started), "models": {
        key: {"valid": len(s["valid"]), "goal": goals[key], "jobs": s["jobs_done"], "yielded": s["yielded"],
              "inflight": s["inflight"], "dry_streak": s["dry_streak"], "retired": s["retired"]}
        for key, s in states.items()}}
    (out_dir / "progress.json").write_text(json.dumps(progress, indent=2) + "\n")


def generate(args, out_dir, jobs_dir, logs_dir):
    states, next_job, _ = load_ledger(jobs_dir, args.max_dry_jobs, lambda key: job_settings(args, key))
    states = {key: states[key] for key in args.models}
    next_job = max(next_job, next_job_number(jobs_dir, logs_dir))
    started = time.time()
    deadline = started + args.max_hours * 3600
    server_down = None
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        running = {}
        try:
            for orphan in find_orphans(jobs_dir, logs_dir, lambda stem: generator_cmdline(jobs_dir / f"{stem}.json")):
                if orphan["key"] in states:
                    states[orphan["key"]]["inflight"] += 1
                    running[pool.submit(adopt_job, orphan, args, jobs_dir, logs_dir)] = orphan["key"]
            for key, stem in stage_imports(args.import_banks, jobs_dir):
                if key not in states:
                    continue
                states[key]["inflight"] += 1
                running[pool.submit(run_import, key, stem, args, jobs_dir, logs_dir)] = key
            while True:
                goals = goals_for(states, args.total)
                while not server_down and len(running) < args.workers and time.time() < deadline:
                    key = pick_model(states, goals, args.workers)
                    if key is None:
                        break
                    states[key]["inflight"] += 1
                    running[pool.submit(run_job, key, next_job, args, jobs_dir, logs_dir)] = key
                    next_job += 1
                write_progress(out_dir, states, goals, started)
                if not running:
                    break
                done, _ = wait(running, return_when=FIRST_COMPLETED)
                for future in done:
                    key = running.pop(future)
                    s = states[key]
                    s["inflight"] -= 1
                    try:
                        stem, record, bank = future.result()
                    except ServerUnreachable as e:
                        # Running jobs keep their banks; the next run adopts them.
                        server_down = e
                        print(f"[error] {e}; waiting for {len(running)} running jobs, launching no more",
                              file=sys.stderr, flush=True)
                        continue
                    new_valid = absorb(s, stem, bank, record["passed"],
                                       read_screens(jobs_dir / f"{stem}.validation.json"),
                                       read_views(jobs_dir / f"{stem}.validation.json"))
                    if counts_toward_stats(record, lambda model: job_settings(args, model)):
                        record_job(s, new_valid, args.max_dry_jobs)
                    goal = goals_for(states, args.total)[key]
                    note = " (retired)" if s["retired"] else ""
                    print(f"[{time.time() - started:6.0f}s] {stem}: generated {record['generated']}, "
                          f"passed {len(record['passed'])}, new {new_valid} -> {key} {len(s['valid'])}/{goal}{note}",
                          flush=True)
        except BaseException:
            # Kill jobs before the executor waits on its threads.
            stop_jobs()
            raise
    if server_down:
        fail(f"{server_down}. Restart the server and rerun to validate unrecorded jobs.")
    return states


def raise_interrupt(*_):
    raise KeyboardInterrupt


def build_parser():
    parser = argparse.ArgumentParser(description="Model-balanced clustered-tier dataset generator.")
    parser.add_argument("--difficulty", type=int, choices=sorted(TIER_CONTRACTS), default=5,
                        help="Clustered tier: 5 (expert) or 3 (medium).")
    parser.add_argument("--total", type=int, default=300, help="Presets in the assembled dataset.")
    parser.add_argument("--models", default=",".join(key for key, _ in MODELS if key not in UNTWINNABLE),
                        help="Comma-separated model keys to include. Mapfold cannot be twinned, so it is left out.")
    parser.add_argument("--out-dir", default="new_dataset/expert-300")
    parser.add_argument("--render-dir", default="new_dataset/expert-300-render",
                        help="Must match the server's DATASET_DIR.")
    parser.add_argument("--server-url", default="http://localhost:3001")
    parser.add_argument("--workers", type=int, default=max(2, min(26, (os.cpu_count() or 4) - 6)))
    parser.add_argument("--render-workers", type=int, default=20)
    parser.add_argument("--count-per-job", type=int, default=10)
    parser.add_argument("--rotation-profile-count", type=int, default=None,
                        help="Rotation profiles per camera view (default 180 for expert, 60 for medium). "
                             "Profiles beyond the fixed ones are seeded per job.")
    parser.add_argument("--profile-override", action="append", default=[], metavar="MODEL=COUNT",
                        help="Rotation profile count for one model, e.g. mapfold=30. Repeatable.")
    parser.add_argument("--settle-override", action="append", default=[], metavar="MODEL=MS",
                        help="Per-step settle for one model's trajectory search, e.g. mapfold=800 to match "
                             "the 800 ms validation replay. Repeatable.")
    parser.add_argument("--max-dry-jobs", type=int, default=10,
                        help="Consecutive jobs without a new valid preset before a model stops receiving jobs.")
    parser.add_argument("--max-hours", type=float, default=12.0, help="Stop launching jobs after this long.")
    parser.add_argument("--job-timeout-min", type=int, default=480,
                        help="Hang guard per generation or validation process.")
    parser.add_argument("--settle-ms", type=int, default=800, help="Replay settle time for validation.")
    parser.add_argument("--base-seed", type=int, default=50021)
    parser.add_argument("--import", dest="import_banks", action="append", default=[],
                        help="Glob of existing expert banks to validate and include. Repeatable.")
    parser.add_argument("--assemble-only", action="store_true", help="Skip generation; assemble from job records.")
    parser.add_argument("--skip-render", action="store_true")
    parser.add_argument("--cluster-points", default="", metavar="LO,HI",
                        help="Dot totals, twins included, in place of the tier's range, e.g. 20,20.")
    parser.add_argument("--cluster-scatter", default="", metavar="LO,HI",
                        help="Scatter dots per preset, before twins, e.g. 2,3. Off by default.")
    parser.add_argument("--cluster-group-size", default="", metavar="LO,HI",
                        help="Dots per group, before twins, in place of the tier's 1-4, e.g. 2,4.")
    parser.add_argument("--cluster-back-groups", default="", metavar="LO,HI",
                        help="Expert back groups in place of 1-2; 0,0 makes front-only presets (for 180-degree bases).")
    parser.add_argument("--cluster-end-sizes", default="", metavar="LO,HI",
                        help="Last-image dot sizes relative to the tier's, drawn per dot, e.g. 0.75,1.25. Off by default.")
    parser.add_argument("--cluster-spin-turns", type=float, default=None, metavar="T",
                        help="Medium only: spin about the paper normal drawn from +-T turns (default 0.5).")
    parser.add_argument("--symmetric-twins", action="store_true",
                        help="Tracked dots' twins must meet the tracked dots' rules in every frame, so the tracked "
                             "group does not end up facing the camera more than its twin.")
    return parser


def main():
    global TIER, CLUSTER_POINTS, CLUSTER_SCATTER, CLUSTER_GROUP_SIZE, CLUSTER_BACK_GROUPS, CLUSTER_END_SIZES, CLUSTER_SPIN_TURNS
    global SYMMETRIC_TWINS
    parser = build_parser()
    args = parser.parse_args()
    TIER = args.difficulty
    for flag, value, minimum in (("--cluster-points", args.cluster_points, 1), ("--cluster-scatter", args.cluster_scatter, 0),
                                 ("--cluster-group-size", args.cluster_group_size, 1),
                                 ("--cluster-back-groups", args.cluster_back_groups, 0)):
        if not value:
            continue
        try:
            low, high = (int(v) for v in value.split(","))
        except ValueError:
            parser.error(f"{flag} takes LO,HI")
        if not minimum <= low <= high:
            parser.error(f"{flag} needs {minimum} <= LO <= HI")
        if flag == "--cluster-points":
            CLUSTER_POINTS = (low, high)
        elif flag == "--cluster-scatter":
            CLUSTER_SCATTER = (low, high)
        elif flag == "--cluster-group-size":
            CLUSTER_GROUP_SIZE = (low, high)
        else:
            CLUSTER_BACK_GROUPS = (low, high)
    if args.cluster_end_sizes:
        try:
            low, high = (float(v) for v in args.cluster_end_sizes.split(","))
        except ValueError:
            parser.error("--cluster-end-sizes takes LO,HI")
        if not 0 < low <= high:
            parser.error("--cluster-end-sizes needs 0 < LO <= HI")
        CLUSTER_END_SIZES = (low, high)
    if args.cluster_spin_turns is not None:
        if args.cluster_spin_turns <= 0 or TIER != 3:
            parser.error("--cluster-spin-turns takes a positive number, for --difficulty 3 only")
        CLUSTER_SPIN_TURNS = args.cluster_spin_turns
    SYMMETRIC_TWINS = args.symmetric_twins
    if args.rotation_profile_count is None:
        args.rotation_profile_count = DEFAULT_PROFILE_COUNT[TIER]
    if min(args.workers, args.render_workers, args.count_per_job, args.rotation_profile_count, args.total) < 1:
        parser.error("counts must be positive")
    for flag, items in (("--profile-override", args.profile_override), ("--settle-override", args.settle_override)):
        for item in items:
            key, _, count = item.partition("=")
            if key not in MODEL_KEYS.values() or not count.isdigit() or int(count) < 1:
                parser.error(f"{flag} expects MODEL=NUMBER, got {item!r}")
    args.server_url = args.server_url.rstrip("/")
    args.models = [key.strip() for key in args.models.split(",") if key.strip()]
    unknown = sorted(set(args.models) - {key for key, _ in MODELS})
    if unknown or not args.models:
        parser.error(f"unknown --models {unknown}; valid keys: {', '.join(key for key, _ in MODELS)}")
    untwinnable = sorted(set(args.models) & UNTWINNABLE)
    if untwinnable:
        parser.error(f"{untwinnable}: the folded model carries no rotation, so its dots cannot be twinned")

    out_dir = ROOT / args.out_dir
    jobs_dir, logs_dir = out_dir / "jobs", out_dir / "logs"
    for folder in (jobs_dir, logs_dir, ROOT / args.render_dir):
        folder.mkdir(parents=True, exist_ok=True)
    check_dev_server(args.server_url, args.render_dir)

    signal.signal(signal.SIGTERM, raise_interrupt)
    if args.assemble_only:
        states = load_ledger(jobs_dir, args.max_dry_jobs, lambda key: job_settings(args, key))[0]
        states = {key: states[key] for key in args.models}
    else:
        states = generate(args, out_dir, jobs_dir, logs_dir)

    assembled, summary = assemble(states, args.total)
    (out_dir / "assembled.json").write_text(json.dumps(assembled, indent=2) + "\n")
    (out_dir / "summary.json").write_text(json.dumps({"total": len(assembled), "models": summary}, indent=2) + "\n")
    print(f"\n{'model':<14} {'available':>9} {'kept':>5} {'views':>6} {'jobs':>5}  retired")
    for key, row in summary.items():
        print(f"{key:<14} {row['available']:>9} {row['kept']:>5} {row['views']:>6} {row['jobs']:>5}  {row['retired']}")
    print(f"{'TOTAL':<14} {sum(r['available'] for r in summary.values()):>9} {len(assembled):>5}")
    hits = sum(r["anchor_middle"][0] for r in summary.values())
    groups = sum(r["anchor_middle"][1] for r in summary.values())
    if groups:
        # Chance is 1 / group size, summed over groups of varying size.
        chance = sum(r["anchor_middle_chance"] for r in summary.values())
        print(f"Anchor is its group's middle dot in {hits}/{groups} measured groups ({hits / groups:.2f}); "
              f"chance is {chance / groups:.2f}. Check the bank with tools/shortcut-baselines.py.")
    turned = [sum(r["least_turn"][k] for r in summary.values()) for k in (0, 1)]
    if turned[1]:
        print(f"Real final pose is the smaller turn in {turned[0]}/{turned[1]} twinned presets ({turned[0] / turned[1]:.2f}); "
              "a first-and-last-frame solver guessing the least turn should be right about half the time.")
    facing = [sum(r.get("twin_facing", [0, 0])[k] for r in summary.values()) for k in (0, 1)]
    if facing[1]:
        print(f"Tracked groups face the camera more than their twin group in {facing[0]:g}/{facing[1]:g} ({facing[0] / facing[1]:.2f}); "
              "near 0.5, how round the dots look does not tell dots from twins.")
    print(f"Written: {out_dir / 'assembled.json'}", flush=True)

    if not args.skip_render and assembled:
        subprocess.run([
            "python3", "tools/render_dataset_parallel.py",
            "--dataset", str(out_dir / "assembled.json"), "--workers", str(args.render_workers),
            "--server-url", args.server_url, "--skip-existing",
        ], cwd=ROOT, env=dict(os.environ, DATASET_DIR=args.render_dir), check=True)
    if len(assembled) < args.total:
        print(f"[incomplete] assembled {len(assembled)} of {args.total}; rerun to resume.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
