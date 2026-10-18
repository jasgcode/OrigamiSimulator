import importlib.util
import json
import random
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


shortcut = load_tool("shortcut-baselines")

# One tracked group: four dots in a diamond around a middle dot's position.
DIAMOND = [(0, 0), (60, 0), (-60, 0), (0, 60)]


def make_case(rng, anchor_slot):
    """Two tracked groups of four and two back dots; the anchor sits in anchor_slot."""
    points, screens = [], []
    for face, origin in ((0, (300, 300)), (1, (800, 600))):
        slots = [DIAMOND[0], DIAMOND[1], DIAMOND[2], DIAMOND[3]]
        anchor = slots.pop(anchor_slot(rng))
        for k, (dx, dy) in enumerate([anchor] + slots):
            points.append({"faceId": face, "hidden": k > 0})
            screens.append([origin[0] + dx, origin[1] + dy])
    for face, at in ((9, (150, 800)), (10, (1000, 150))):
        points.append({"faceId": face, "hidden": True})
        screens.append(list(at))
    return points, screens


def cases(anchor_slot, n=120, seed=3):
    rng = random.Random(seed)
    return [(f"c{i}", *make_case(rng, anchor_slot)) for i in range(n)]


class ShortcutBaselineTests(unittest.TestCase):
    def test_anchor_always_in_the_middle_fails(self):
        r = shortcut.evaluate(cases(lambda rng: 0))
        self.assertEqual(r["anchor_middle_rate"], 1.0)
        self.assertGreater(r["central_z"], 3)
        self.assertGreater(r["anchor_middle_z"], 3)

    def test_exchangeable_anchor_passes(self):
        r = shortcut.evaluate(cases(lambda rng: rng.randrange(4)))
        self.assertAlmostEqual(r["anchor_middle_chance"], 0.25)
        self.assertLess(r["anchor_middle_z"], 3)
        self.assertLess(r["central_z"], 3)

    def test_anchor_never_in_the_middle_also_fails(self):
        r = shortcut.evaluate(cases(lambda rng: rng.randrange(1, 4)))
        self.assertEqual(r["anchor_middle_rate"], 0.0)
        self.assertLess(r["anchor_middle_z"], -3)
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            rows = cases(lambda rng: rng.randrange(1, 4))
            (tmp / "b.json").write_text(json.dumps({n: {"facePoints": p} for n, p, _ in rows}))
            (tmp / "r.json").write_text(json.dumps({"results": [{"name": n, "quality": {"finalScreens": s}} for n, _, s in rows]}))
            self.assertEqual(shortcut.main(["--bank", str(tmp / "b.json"), "--report", str(tmp / "r.json")]), 1)

    def test_cli_reads_bank_and_report_and_sets_exit_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            for label, slot, expected in (("leaky", lambda rng: 0, 1), ("fair", lambda rng: rng.randrange(4), 0)):
                rows = cases(slot)
                bank = {name: {"facePoints": points} for name, points, _ in rows}
                report = {"results": [{"name": name, "quality": {"finalScreens": screens}} for name, _, screens in rows]}
                (tmp / f"{label}-bank.json").write_text(json.dumps(bank))
                (tmp / f"{label}-report.json").write_text(json.dumps(report))
                code = shortcut.main(["--bank", str(tmp / f"{label}-bank.json"), "--report", str(tmp / f"{label}-report.json")])
                self.assertEqual(code, expected, label)

    def test_pairs_split_the_middle_dot_credit(self):
        # In a pair both dots tie as the middle; the anchor, listed first, must
        # not take the whole credit. Lone tracked dots are not counted.
        points = [{"faceId": 0, "hidden": False}, {"faceId": 0, "hidden": True},
                  {"faceId": 1, "hidden": False}, {"faceId": 2, "hidden": True}]
        screens = [[100, 100], [160, 100], [400, 400], [700, 700]]
        self.assertEqual(shortcut.anchor_middle_stats(points, screens), (0.5, 1, 0.5))

    def test_least_turn_counts_presets_whose_real_pose_turns_less_than_its_twin(self):
        def preset(yaw):
            return {"clusterPlacement": {"symmetry": "rotate180"}, "steps": [{"rotation": [0, 0, 0]}, {"rotation": [0, yaw, 0]}]}
        bank = {"small": preset(0.3), "large": preset(2.8), "untwinned": {"steps": [{"rotation": [0, 0, 0]}]}}
        self.assertEqual(shortcut.least_turn_rate(bank), (1, 2))

    def test_twin_facing_compares_each_tracked_group_with_its_twin_group(self):
        points = [
            {"faceId": 0, "pair": 0}, {"faceId": 0, "pair": 1, "hidden": True},
            {"faceId": 4, "pair": 0, "twin": True, "hidden": True}, {"faceId": 4, "pair": 1, "twin": True, "hidden": True},
            {"faceId": 1, "pair": 2}, {"faceId": 5, "pair": 2, "twin": True, "hidden": True},
            {"faceId": 9, "hidden": True},
        ]
        ratios = [0.9, 0.8, 0.4, 0.5, 0.6, 0.61, 0.95]
        # Group 0 faces the camera more than its twin; group 1 ties within 0.02.
        self.assertEqual(shortcut.twin_facing_rate({"a": {"facePoints": points}}, {"a": ratios}), (1.5, 2))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "trace.json"
            path.write_text(json.dumps({"results": [{"name": "a", "trace": [{"viewQuality": [0] * 7}, {"viewQuality": ratios}]}]}))
            self.assertEqual(shortcut.final_view_quality([path]), {"a": ratios})

    def test_missing_positions_is_an_error_not_a_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / "bank.json").write_text(json.dumps({"a": {"facePoints": []}}))
            (tmp / "report.json").write_text(json.dumps({"results": [{"name": "a", "quality": {}}]}))
            self.assertEqual(shortcut.main(["--bank", str(tmp / "bank.json"), "--report", str(tmp / "report.json")]), 2)


if __name__ == "__main__":
    unittest.main()
