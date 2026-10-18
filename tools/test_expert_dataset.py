import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


def load_tool(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


expert = load_tool("generate-expert-dataset")


def preset(pov, fold=70, points=14, model="/Bases/birdBase.svg", radius=.014):
    return {
        "model": model,
        "difficulty": 5,
        "pointRadius": radius,
        "steps": [{"fold": 0, "pov": pov}] * 13 + [{"fold": fold, "pov": pov}],
        "facePoints": [{"faceId": i, "u": .3, "v": .3, "w": .4, "hidden": i > 1} for i in range(points)],
        "clusterPlacement": {"alpha": .7, "symmetry": "rotate180"},
    }


def state(valid=0, jobs=0, yielded=0, inflight=0, retired=False):
    return {"valid": {str(i): (str(i), {}) for i in range(valid)}, "jobs_done": jobs,
            "yielded": yielded, "inflight": inflight, "dry_streak": 0, "retired": retired}


class AllocationTests(unittest.TestCase):
    def test_even_split_gives_remainders_in_model_order(self):
        quota = expert.allocate({"a": 100, "b": 100, "c": 100}, 10)
        self.assertEqual(quota, {"a": 4, "b": 3, "c": 3})

    def test_short_model_share_moves_to_others(self):
        quota = expert.allocate({"a": 5, "b": 100, "c": 100, "d": 100}, 300)
        self.assertEqual(quota["a"], 5)
        self.assertEqual(sum(quota.values()), 300)
        self.assertLessEqual(max(quota[k] for k in "bcd") - min(quota[k] for k in "bcd"), 1)

    def test_total_is_capped_by_capacity(self):
        self.assertEqual(expert.allocate({"a": 2, "b": 3}, 300), {"a": 2, "b": 3})


class SelectionTests(unittest.TestCase):
    def test_selection_rotates_across_camera_views(self):
        items = [(f"x{i}", preset([1, 1, 1], fold=60 + i)) for i in range(5)]
        items += [("y", preset([0, 1, 0])), ("z", preset([1, 0, 0]))]
        picked = [name for name, _ in expert.spread_by_view(items, 4)]
        self.assertEqual(picked, ["x0", "y", "z", "x1"])

    def test_contract_takes_twelve_to_twenty_dots_with_sampled_placement(self):
        for points in (12, 16, 20):
            self.assertTrue(expert.meets_tier_contract(preset([1, 1, 1], points=points)))
        for points in (10, 21):
            self.assertFalse(expert.meets_tier_contract(preset([1, 1, 1], points=points)))
        # Fixed-placement banks (no clusterPlacement) and banks without twins are excluded.
        fixed = {k: v for k, v in preset([1, 1, 1]).items() if k != "clusterPlacement"}
        self.assertFalse(expert.meets_tier_contract(fixed))
        untwinned = dict(preset([1, 1, 1]), clusterPlacement={"alpha": .7})
        self.assertFalse(expert.meets_tier_contract(untwinned))

    def test_cluster_points_override_sets_the_contract_range(self):
        expert.CLUSTER_POINTS = (20, 20)
        try:
            self.assertTrue(expert.meets_tier_contract(preset([1, 1, 1], points=20)))
            self.assertFalse(expert.meets_tier_contract(preset([1, 1, 1], points=18)))
        finally:
            expert.CLUSTER_POINTS = None
        self.assertTrue(expert.meets_tier_contract(preset([1, 1, 1], points=18)))

    def test_layout_overrides_reach_generation_and_validation(self):
        expert.CLUSTER_POINTS, expert.CLUSTER_SCATTER, expert.CLUSTER_GROUP_SIZE = (20, 20), (3, 5), (2, 4)
        expert.CLUSTER_BACK_GROUPS = (0, 0)
        try:
            self.assertEqual(expert.cluster_flags(), ["--cluster-points", "20,20", "--cluster-scatter", "3,5",
                                                      "--cluster-group-size", "2,4", "--cluster-back-groups", "0,0"])
        finally:
            expert.CLUSTER_POINTS = expert.CLUSTER_SCATTER = expert.CLUSTER_GROUP_SIZE = expert.CLUSTER_BACK_GROUPS = None
        self.assertEqual(expert.cluster_flags(), [])

    def test_contract_rejects_full_size_markers(self):
        self.assertFalse(expert.meets_tier_contract(preset([1, 1, 1], radius=.025)))
        self.assertFalse(expert.meets_tier_contract({k: v for k, v in preset([1, 1, 1]).items() if k != "pointRadius"}))

    def test_jobs_rotate_through_every_motion_style(self):
        styles = [expert.motion_style(job) for job in range(1, 9)]
        self.assertEqual(set(styles), set(expert.MOTION_STYLES))

    def test_contract_rejects_historical_six_and_ten_frame_banks(self):
        six_frames = dict(preset([1, 1, 1]), steps=[{"fold": 14 * i, "pov": [1, 1, 1]} for i in range(6)])
        self.assertFalse(expert.meets_tier_contract(six_frames))
        ten_frames = dict(preset([1, 1, 1]), steps=[{"fold": 7 * i, "pov": [1, 1, 1]} for i in range(10)])
        self.assertFalse(expert.meets_tier_contract(ten_frames))

    def test_signature_ignores_seed_and_private_fields(self):
        base = preset([1, 1, 1])
        self.assertEqual(expert.preset_signature(base),
                         expert.preset_signature(dict(base, seed=9, rngSeed=4, _source="job")))
        self.assertNotEqual(expert.preset_signature(base), expert.preset_signature(preset([1, 1, 1], fold=50)))


class SchedulingTests(unittest.TestCase):
    def test_zero_yield_model_is_held_to_its_share(self):
        states = {"fast": state(jobs=4, yielded=20, inflight=1), "slow": state(jobs=4, inflight=2)}
        self.assertEqual(expert.pick_model(states, {"fast": 38, "slow": 38}, workers=4), "fast")

    def test_model_furthest_behind_its_goal_goes_first(self):
        states = {"ahead": state(valid=30), "behind": state(valid=5)}
        self.assertEqual(expert.pick_model(states, {"ahead": 38, "behind": 38}, workers=8), "behind")

    def test_spare_workers_exceed_the_share_instead_of_idling(self):
        # "near" needs one preset and already has a job; only "slow" can use the slot.
        states = {"near": state(valid=37, jobs=2, yielded=4, inflight=1), "slow": state(inflight=2)}
        self.assertEqual(expert.pick_model(states, {"near": 38, "slow": 38}, workers=4), "slow")

    def test_models_at_goal_or_retired_get_no_jobs(self):
        states = {"done": state(valid=38), "retired": state(retired=True)}
        self.assertIsNone(expert.pick_model(states, {"done": 38, "retired": 38}, workers=4))

    def test_goals_shift_from_retired_models(self):
        states = {"a": state(valid=10, retired=True), "b": state(valid=3), "c": state()}
        self.assertEqual(expert.goals_for(states, 100), {"a": 10, "b": 45, "c": 45})

    def test_dry_jobs_retire_a_model(self):
        s = state()
        for _ in range(3):
            expert.record_job(s, new_valid=0, max_dry_jobs=3)
        self.assertTrue(s["retired"])
        productive = state()
        expert.record_job(productive, new_valid=0, max_dry_jobs=2)
        expert.record_job(productive, new_valid=1, max_dry_jobs=2)
        expert.record_job(productive, new_valid=0, max_dry_jobs=2)
        self.assertFalse(productive["retired"])


class AssemblyTests(unittest.TestCase):
    def test_assembled_names_are_sequential_per_model(self):
        states = {key: state() for key, _ in expert.MODELS}
        states["bird"]["valid"] = {str(i): (f"j{i}", preset([i, 1, 0])) for i in range(3)}
        states["boat"]["valid"] = {"b": ("b", preset([1, 1, 1], model="/Bases/boatBase.svg"))}
        assembled, summary = expert.assemble(states, total=4)
        self.assertEqual(list(assembled), ["bird-d5-01", "bird-d5-02", "bird-d5-03", "boat-d5-01"])
        self.assertEqual(summary["bird"]["kept"], 3)
        self.assertEqual(summary["bird"]["views"], 3)

    def test_assembly_balances_how_often_the_anchor_is_the_middle_dot(self):
        # Anchor-centred groups survive validation more often, so the pool
        # over-represents them. Assembly keeps the kept rate near chance (1/4).
        states = {key: state() for key, _ in expert.MODELS}
        grouped = [{"faceId": f, "u": .3, "v": .3, "w": .4, "hidden": k >= 2}
                   for k, f in enumerate([0, 1, 0, 1, 0, 1, 0, 1, 14, 15])]
        pool = {str(i): (f"j{i}", dict(preset([i, 1, 0]), facePoints=[dict(p, faceId=p["faceId"] + 20 * i) if p["faceId"] < 8 else p
                                                                         for p in grouped])) for i in range(8)}
        states["bird"]["valid"] = pool
        states["bird"]["middle"] = {str(i): ((2 if i < 5 else 0), 2) for i in range(8)}
        assembled, summary = expert.assemble(states, total=4)
        self.assertEqual(len(assembled), 4)
        self.assertEqual(summary["bird"]["anchor_middle"], [2, 8])
        self.assertEqual(sum(1 for s in summary["bird"]["sources"] if int(s[1:]) < 5), 1)

    def test_middle_balancing_uses_each_groups_own_chance(self):
        # Pairs are the middle dot half the time, groups of four a quarter.
        p = preset([1, 1, 1])
        self.assertEqual(expert.middle_stats((1, 2, .75), p), (1, 2, .75))
        legacy = dict(p, facePoints=[{"faceId": f, "u": .3, "v": .3, "w": .4, "hidden": k >= 2}
                                     for k, f in enumerate([0, 1, 0, 1, 0, 1, 0, 1, 14, 15])])
        self.assertEqual(expert.middle_stats((1, 2), legacy), (1, 2, .5))
        candidates = [("pair", ("a", p)), ("quad", ("b", p))]
        picked, counts, chance = expert.balance_middle(candidates, {"pair": (1, 1, .5), "quad": (0, 1, .25)}, 1)
        self.assertEqual(([name for name, _ in picked], counts, chance), (["quad"], [0, 1], .25))
        # The pair's hit is 0.5 over chance; the quad's miss offsets only 0.25.
        self.assertEqual(expert.balanced_capacity(candidates, {"pair": (1, 1, .5), "quad": (0, 1, .25)}), 1)
        self.assertEqual(expert.balanced_capacity(candidates, {"pair": (1, 1, .5), "quad": (0, 2, .5)}), 2)

    def test_balance_keeps_the_least_turn_guess_at_half(self):
        def twinned(yaw):
            return {"clusterPlacement": {"symmetry": "rotate180"}, "facePoints": [],
                    "steps": [{"rotation": [0, 0, 0]}, {"rotation": [0, yaw, 0]}]}
        # Three small turns (the least-turn guess is right), then two large ones.
        candidates = [(f"s{i}", (f"j{i}", twinned(.3))) for i in range(3)] + [(f"l{i}", (f"k{i}", twinned(2.8))) for i in range(2)]
        picked, _, _ = expert.balance_middle(candidates, {}, 4)
        self.assertEqual([name for name, _ in picked], ["s0", "l0", "s1", "l1"])

    def test_balance_keeps_tracked_groups_facing_more_than_twins_half_the_time(self):
        flat = {"facePoints": [], "steps": [{"rotation": [0, 0, 0]}]}
        # Four presets whose tracked group faces the camera more than its twin,
        # then two whose twin faces it more.
        facing = {**{f"r{i}": [1, 1] for i in range(4)}, **{f"t{i}": [0, 1] for i in range(2)}}
        candidates = [(sig, (sig, flat)) for sig in facing]
        picked, _, _ = expert.balance_middle(candidates, {}, 4, facing)
        self.assertEqual([name for name, _ in picked], ["r0", "t0", "r1", "t1"])
        # The counts come from a validation report's final viewing ratios.
        seed = {"faceId": 0, "u": .3, "v": .3, "w": .4, "pair": 0}
        twin = {"faceId": 4, "u": .3, "v": .3, "w": .4, "pair": 0, "twin": True, "hidden": True}
        self.assertEqual(expert.twin_facing({"facePoints": [seed, twin]}, [.9, .5]), [1, 1])
        self.assertEqual(expert.twin_facing({"facePoints": [seed, twin]}, [.5, .9]), [0, 1])

    def test_assembly_treats_unmeasured_presets_as_neutral(self):
        states = {key: state() for key, _ in expert.MODELS}
        states["bird"]["valid"] = {str(i): (f"j{i}", preset([i, 1, 0])) for i in range(3)}
        assembled, summary = expert.assemble(states, total=3)
        self.assertEqual(len(assembled), 3)
        self.assertEqual(summary["bird"]["anchor_middle"], [0, 0])

    def test_ledger_reads_anchor_positions_from_validation_reports(self):
        with tempfile.TemporaryDirectory() as temp:
            jobs = Path(temp)
            points = [{"faceId": f, "u": .3, "v": .3, "w": .4, "hidden": k >= 2}
                      for k, f in enumerate([0, 1, 0, 1, 0, 1, 0, 1, 14, 15, 16, 17])]
            p = dict(preset([1, 1, 1]), facePoints=points)
            (jobs / "bird-d5-j0001.json").write_text(json.dumps({"bird-d5-101": p}))
            (jobs / "bird-d5-j0001.done.json").write_text(json.dumps(
                {"model": "bird", "job": 1, "imported": False, "passed": ["bird-d5-101"]}))
            # Anchor 0 sits inside its diamond; anchor 1 is at the end of its row.
            screens = [[100, 100], [500, 100], [40, 100], [560, 100], [160, 100], [620, 100],
                       [100, 160], [680, 100], [300, 600], [900, 600], [300, 800], [900, 800]]
            (jobs / "bird-d5-j0001.validation.json").write_text(json.dumps({"results": [
                {"name": "bird-d5-101", "quality": {"finalScreens": screens}}]}))
            states, _, _ = expert.load_ledger(jobs, max_dry_jobs=5)
        self.assertEqual(list(states["bird"]["middle"].values()), [(1, 2, 0.5)])

    def test_assembly_keeps_only_a_balanced_subset_when_the_pool_is_skewed(self):
        # A model whose pool is mostly anchor-centred cannot be kept whole:
        # its quota shrinks to the largest subset at chance.
        states = {key: state() for key, _ in expert.MODELS}
        grouped = [{"faceId": f, "u": .3, "v": .3, "w": .4, "hidden": k >= 2}
                   for k, f in enumerate([0, 1, 0, 1, 0, 1, 0, 1, 14, 15])]
        states["mapfold"]["valid"] = {str(i): (f"m{i}", dict(preset([i, 1, 0]), facePoints=[dict(p, faceId=p["faceId"] + i * 20 if p["faceId"] < 8 else p["faceId"]) for p in grouped]))
                                      for i in range(6)}
        states["mapfold"]["middle"] = {str(i): ((2 if i < 4 else 0), 2) for i in range(6)}
        assembled, summary = expert.assemble(states, total=150)
        self.assertEqual(summary["mapfold"]["kept"], 2)
        self.assertEqual(summary["mapfold"]["anchor_middle"], [0, 4])

    def test_assembly_caps_repeated_panel_combinations(self):
        states = {key: state() for key, _ in expert.MODELS}
        grouped = [{"faceId": f, "u": .3, "v": .3, "w": .4, "hidden": k >= 2}
                   for k, f in enumerate([0, 1, 0, 1, 0, 1, 0, 1, 14, 15])]
        states["bird"]["valid"] = {str(i): (f"b{i}", dict(preset([i, 1, 0]), facePoints=grouped)) for i in range(5)}
        assembled, summary = expert.assemble(states, total=150)
        self.assertEqual(summary["bird"]["kept"], expert.MAX_PER_FACE_SET)

    def test_scheduler_gives_zero_yield_models_one_probe_slot(self):
        states = {key: state() for key, _ in expert.MODELS}
        for key in states:
            states[key]["retired"] = key not in ("bird", "pinwheel")
        states["bird"].update(jobs_done=2, yielded=6, valid={str(i): (str(i), {}) for i in range(6)})
        states["pinwheel"].update(jobs_done=3, yielded=0, inflight=1)
        goals = {key: 25 for key in states}
        self.assertEqual(expert.pick_model(states, goals, workers=8), "bird")
        states["pinwheel"]["inflight"] = 0
        self.assertEqual(expert.pick_model(states, goals, workers=8), "pinwheel")

    def test_job_settings_record_the_search_version(self):
        args = expert.build_parser().parse_args([])
        self.assertEqual(expert.job_settings(args, "bird")["search"], expert.SEARCH_VERSION)

    def test_resume_rebuilds_counts_from_job_records(self):
        with tempfile.TemporaryDirectory() as temp:
            jobs = Path(temp)
            first, repeat = preset([1, 1, 1]), preset([1, 1, 1])
            (jobs / "bird-d5-j0001.json").write_text(json.dumps({"bird-d5-101": first}))
            (jobs / "bird-d5-j0001.done.json").write_text(json.dumps(
                {"model": "bird", "job": 1, "imported": False, "passed": ["bird-d5-101"]}))
            (jobs / "bird-d5-j0002.json").write_text(json.dumps({"bird-d5-201": repeat}))
            (jobs / "bird-d5-j0002.done.json").write_text(json.dumps(
                {"model": "bird", "job": 2, "imported": False, "passed": ["bird-d5-201"]}))
            states, next_job, _ = expert.load_ledger(jobs, max_dry_jobs=5)
        self.assertEqual(len(states["bird"]["valid"]), 1)
        self.assertEqual(states["bird"]["jobs_done"], 2)
        self.assertEqual(states["bird"]["dry_streak"], 1)
        self.assertEqual(next_job, 3)

    def test_changed_settings_keep_presets_but_reset_job_statistics(self):
        with tempfile.TemporaryDirectory() as temp:
            jobs = Path(temp)
            (jobs / "boat-d5-j0001.json").write_text(json.dumps({"boat-d5-101": preset([1, 1, 1])}))
            (jobs / "boat-d5-j0001.done.json").write_text(json.dumps(
                {"model": "boat", "job": 1, "imported": False, "passed": ["boat-d5-101"]}))
            for job in (2, 3):
                (jobs / f"boat-d5-j000{job}.done.json").write_text(json.dumps(
                    {"model": "boat", "job": job, "imported": False, "passed": []}))
            states, next_job, _ = expert.load_ledger(jobs, max_dry_jobs=2,
                                                     settings_for=lambda key: {"rotation_profile_count": 60})
        self.assertEqual(len(states["boat"]["valid"]), 1)
        self.assertEqual(states["boat"]["jobs_done"], 0)
        self.assertFalse(states["boat"]["retired"])
        self.assertEqual(next_job, 4)

    def test_failed_jobs_do_not_count_as_dry(self):
        with tempfile.TemporaryDirectory() as temp:
            jobs = Path(temp)
            for job in (1, 2):
                (jobs / f"mapfold-d5-j000{job}.done.json").write_text(json.dumps(
                    {"model": "mapfold", "job": job, "passed": [], "error": "protocol timeout"}))
            states, _, _ = expert.load_ledger(jobs, max_dry_jobs=1)
        self.assertEqual(states["mapfold"]["jobs_done"], 0)
        self.assertFalse(states["mapfold"]["retired"])

    def test_per_model_profile_override_changes_job_settings(self):
        args = expert.build_parser().parse_args(["--profile-override", "mapfold=30"])
        self.assertEqual(expert.job_settings(args, "mapfold")["rotation_profile_count"], 30)
        self.assertEqual(expert.job_settings(args, "bird")["rotation_profile_count"], 180)


class MediumTierTests(unittest.TestCase):
    def setUp(self):
        expert.TIER = 3

    def tearDown(self):
        expert.TIER = 5

    def medium(self, points=10, frames=10, radius=.018):
        return dict(preset([1, 1, 1], points=points, radius=radius), difficulty=3,
                    steps=[{"fold": 7 * i, "pov": [1, 1, 1]} for i in range(frames)])

    def test_contract_accepts_clustered_medium_only(self):
        self.assertTrue(expert.meets_tier_contract(self.medium()))
        self.assertFalse(expert.meets_tier_contract(preset([1, 1, 1])))  # expert preset
        self.assertFalse(expert.meets_tier_contract(self.medium(points=5)))  # pre-cluster medium
        self.assertFalse(expert.meets_tier_contract(self.medium(points=15)))
        self.assertFalse(expert.meets_tier_contract(self.medium(radius=.025)))

    def test_jobs_request_medium_without_a_motion_style(self):
        seen = []

        def fake_run(cmd, log_fh, _timeout):
            seen.append(cmd)
            return 0

        real_run = expert.run_logged
        expert.run_logged = fake_run
        try:
            with tempfile.TemporaryDirectory() as temp:
                jobs, logs = Path(temp) / "jobs", Path(temp) / "logs"
                jobs.mkdir()
                logs.mkdir()
                args = expert.build_parser().parse_args(["--difficulty", "3"])
                args.rotation_profile_count = None
                stem, record, _ = expert.run_job("bird", 5, args, jobs, logs)
        finally:
            expert.run_logged = real_run
        cmd = seen[0]
        self.assertEqual(stem, "bird-d3-j0005")
        self.assertEqual(cmd[cmd.index("--difficulty") + 1], "3")
        self.assertEqual(cmd[cmd.index("--rotation-profile-count") + 1], "60")
        self.assertNotIn("--expert-motion-style", cmd)
        self.assertIsNone(record["style"])

    def test_orphan_scan_ignores_other_tiers(self):
        with tempfile.TemporaryDirectory() as temp:
            jobs, logs = Path(temp) / "jobs", Path(temp) / "logs"
            jobs.mkdir()
            logs.mkdir()
            for stem in ("bird-d5-j0003", "bird-d3-j0004"):
                (logs / f"{stem}.log").write_text("")
                (jobs / f"{stem}.json").write_text("{}")
            orphans = expert.find_orphans(jobs, logs, lambda stem: [])
        self.assertEqual([o["stem"] for o in orphans], ["bird-d3-j0004"])


class SettleOverrideTests(unittest.TestCase):
    def test_settle_override_reaches_only_its_model(self):
        args = expert.build_parser().parse_args(["--settle-override", "mapfold=800"])
        self.assertEqual(expert.job_settings(args, "mapfold")["scan_settle_ms"], 800)
        self.assertNotIn("scan_settle_ms", expert.job_settings(args, "bird"))

    def test_settle_override_is_passed_to_the_generator(self):
        seen = []
        real_run = expert.run_logged
        expert.run_logged = lambda cmd, log_fh, _t: seen.append(cmd) or 0
        try:
            with tempfile.TemporaryDirectory() as temp:
                jobs, logs = Path(temp) / "jobs", Path(temp) / "logs"
                jobs.mkdir()
                logs.mkdir()
                args = expert.build_parser().parse_args(["--settle-override", "mapfold=800"])
                expert.run_job("mapfold", 1, args, jobs, logs)
                expert.run_job("bird", 2, args, jobs, logs)
        finally:
            expert.run_logged = real_run
        mapfold_cmd, bird_cmd = seen[0], seen[1]
        self.assertEqual(mapfold_cmd[mapfold_cmd.index("--scan-settle-ms") + 1], "800")
        self.assertNotIn("--scan-settle-ms", bird_cmd)


class AdoptionTests(unittest.TestCase):
    def test_orphaned_jobs_are_adopted_and_numbering_skips_them(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp)
            jobs, logs = out / "jobs", out / "logs"
            jobs.mkdir()
            logs.mkdir()
            for stem in ("bird-d5-j0003", "boat-d5-j0007", "square-d5-j0009", "mapfold-d5-j0011"):
                (logs / f"{stem}.log").write_text("")
            (jobs / "bird-d5-j0003.done.json").write_text(json.dumps({"model": "bird", "job": 3, "passed": []}))
            (jobs / "square-d5-j0009.json").write_text("{}")  # finished while no driver was running
            running = {"boat-d5-j0007": ["bun", "tools/generate-presets.js", "--count", "10",
                                         "--rotation-profile-count", "60", "--output", str(jobs / "boat-d5-j0007.json")]}
            orphans = expert.find_orphans(jobs, logs, lambda stem: running.get(stem, []))
            self.assertEqual([(o["key"], o["job"], o["settings"]) for o in orphans], [
                ("boat", 7, {"count_per_job": 10, "rotation_profile_count": 60}),
                ("square", 9, None),
            ])
            self.assertEqual(expert.next_job_number(jobs, logs), 12)

    def test_refused_validation_leaves_the_job_for_adoption(self):
        def fake_run(cmd, log_fh, _timeout):
            if "tools/generate-presets.js" in cmd:
                Path(cmd[cmd.index("--output") + 1]).write_text(json.dumps({"bird-d5-101": preset([1, 1, 1])}))
                return 0
            log_fh.write("error: net::ERR_CONNECTION_REFUSED at http://localhost:3001/\n")
            return 1

        real_run = expert.run_logged
        expert.run_logged = fake_run
        try:
            with tempfile.TemporaryDirectory() as temp:
                jobs, logs = Path(temp) / "jobs", Path(temp) / "logs"
                jobs.mkdir()
                logs.mkdir()
                args = expert.build_parser().parse_args([])
                with self.assertRaises(expert.ServerUnreachable):
                    expert.run_job("bird", 5, args, jobs, logs)
                self.assertFalse((jobs / "bird-d5-j0005.done.json").exists())
                orphans = expert.find_orphans(jobs, logs, lambda stem: [])
                self.assertEqual([o["stem"] for o in orphans], ["bird-d5-j0005"])
        finally:
            expert.run_logged = real_run


if __name__ == "__main__":
    unittest.main()
