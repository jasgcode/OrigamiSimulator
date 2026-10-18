import importlib.util
import json
import math
import random
import sys
import tempfile
import unittest
from pathlib import Path


def load_tool(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name.replace("-", "_")] = module
    spec.loader.exec_module(module)
    return module


build = load_tool("build-eval")


def preset(tracked=(0, 1), pov=(1, 1, 1), rotation=(0, 0, 0), fold=70, back=()):
    points = []
    for face in tracked:
        points += [{"faceId": face, "u": .3, "v": .3, "w": .4, "hidden": k > 0} for k in range(4)]
    points += [{"faceId": face, "u": .3, "v": .3, "w": .4, "hidden": True} for face in back]
    return {"model": "/Bases/birdBase.svg", "difficulty": 5, "pointRadius": .018, "facePoints": points,
            "steps": [{"fold": 0, "pov": list(pov)}, {"fold": fold, "pov": list(pov), "rotation": list(rotation)}]}


class DirectionTests(unittest.TestCase):
    def test_identity_rotation_keeps_the_camera_direction(self):
        d = build.final_view_direction(preset(pov=(0, 0, 2)))
        for got, want in zip(d, (0, 0, 1)):
            self.assertAlmostEqual(got, want)

    def test_turning_the_paper_turns_the_view_the_other_way(self):
        # Paper yawed +90 degrees: a camera on +z now looks at the paper's -x side.
        d = build.final_view_direction(preset(pov=(0, 0, 1), rotation=(0, math.pi / 2, 0)))
        for got, want in zip(d, (-1, 0, 0)):
            self.assertAlmostEqual(got, want)


class PickTests(unittest.TestCase):
    def test_one_preset_per_trajectory(self):
        cands = {f"s{i}": build.features(preset(tracked=(i, i + 1))) for i in range(4)}  # same steps
        cands["other"] = build.features(preset(fold=60))
        cell = build.pick(cands, 5, random.Random(0))
        self.assertEqual(len(cell.chosen), 2)
        self.assertIn("other", cell.chosen)

    def test_unused_tracked_pairs_come_first(self):
        cands = {f"same{i}": build.features(preset(tracked=(0, 1), fold=50 + i)) for i in range(5)}
        cands.update({f"new{i}": build.features(preset(tracked=(2 + i, 9), fold=40 + i)) for i in range(2)})
        cell = build.pick(cands, 3, random.Random(0))
        self.assertTrue({"new0", "new1"} <= set(cell.chosen))

    def test_distant_final_views_beat_near_duplicates(self):
        cands = {
            "a": build.features(preset(pov=(0, 0, 1), fold=50)),
            "a_near": build.features(preset(pov=(0, 0.05, 1), fold=51)),
            "far": build.features(preset(pov=(0, 0, 1), rotation=(math.pi / 2, 0, 0), fold=52)),
        }
        # Equalise the categorical features so only the view direction differs.
        for f in cands.values():
            f["view"] = "v"
        cell = build.pick(cands, 2, random.Random(0))
        self.assertIn("far", cell.chosen)

    def test_repair_brings_the_middle_count_to_chance(self):
        cands = {f"p{i}": build.features(preset(tracked=(i, 40 + i), fold=i)) for i in range(12)}
        # The first six put the tracked dot in the middle of both groups; at
        # most two of them fit a pick of eight at chance (4 of 16 groups).
        balance = {f"p{i}": ({"middle": 2.0 if i < 6 else 0.0}, 0.5) for i in range(12)}
        cell = build.pick(cands, 8, random.Random(0))
        before = sum(balance[n][0]["middle"] for n in cell.chosen)
        cell = build.repair_balance(cell, cands, balance)
        hits = sum(balance[n][0]["middle"] for n in cell.chosen)
        self.assertGreater(before, 5)
        self.assertEqual(len(cell.chosen), 8)
        self.assertLessEqual(abs(hits - 4), 1)

    def test_kept_presets_stay_chosen_and_are_never_swapped_out(self):
        cands = {f"p{i}": build.features(preset(tracked=(i, 40 + i), fold=i)) for i in range(12)}
        balance = {f"p{i}": ({"middle": 2.0 if i < 6 else 0.0}, 0.5) for i in range(12)}
        keep = ["p0", "p1", "p2"]  # all off balance
        cell = build.pick(cands, 8, random.Random(0), balance, keep=keep)
        self.assertEqual(cell.chosen[:3], keep)
        cell = build.repair_balance(cell, cands, balance, fixed=keep)
        self.assertTrue(set(keep) <= set(cell.chosen))
        self.assertEqual(len(cell.chosen), 8)

    def test_cell_sizes_override_per_model(self):
        args = build.argparse.Namespace(per_model=21, cell_size=build.parse_cell_sizes(["medium/bird=22"]))
        self.assertEqual((build.cell_size(args, 3, "bird"), build.cell_size(args, 5, "bird")), (22, 21))
        with self.assertRaises(build.argparse.ArgumentTypeError):
            build.parse_cell_sizes(["hard/bird=22"])

    def test_role_balance_splits_tied_credit(self):
        p = preset(tracked=(0, 1))
        # Group on face 0 in a row (dots 1 and 2 tie as middle); face 1 in a square.
        screens = [[0, 0], [60, 0], [110, 0], [175, 0], [300, 300], [400, 300], [300, 400], [400, 400]]
        credits, expected = build.role_balance(p, screens)
        self.assertAlmostEqual(expected, 0.5)
        # Anchor 0 is the row's near end, which holds no role (dot 3 is the
        # isolated and outermost dot). Anchor 4 is a corner of the square,
        # where all four dots tie on every role: a quarter credit each.
        self.assertAlmostEqual(credits["middle"], 0.25)
        self.assertAlmostEqual(credits["isolated"], 0.25)
        self.assertAlmostEqual(credits["outermost"], 0.25)


class LetterTests(unittest.TestCase):
    def test_answer_pairs_use_every_pair_evenly(self):
        pairs = build.answer_pairs(8, 60, random.Random(0))
        counts = list(__import__("collections").Counter(pairs).values())
        self.assertEqual(len(pairs), 60)
        self.assertEqual(len(counts), 28)
        self.assertLessEqual(max(counts) - min(counts), 1)

    def test_pairs_kept_above_the_even_share_get_the_extra_uses(self):
        # 50 over 45 pairs: five pairs are used twice. Kept presets already
        # use (0, 1) and (2, 3) twice, so those two must be among the five.
        counts = __import__("collections").Counter(
            build.answer_pairs(10, 50, random.Random(0), kept={(0, 1): 2, (2, 3): 2, (4, 5): 1}))
        self.assertEqual((counts[(0, 1)], counts[(2, 3)]), (2, 2))
        self.assertEqual(sorted(counts.values()).count(2), 5)

    def test_relabel_moves_tracked_dots_to_the_pair_and_keeps_everything_else(self):
        p = preset(back=(20, 21))  # 10 points, tracked dots at 0 and 4
        screens = [[i * 10, i] for i in range(10)]
        row = {"name": "x", "valid": True, "quality": {"finalScreens": screens}}
        new, new_row = build.relabel(p, row, (3, 7), random.Random(1))
        self.assertEqual(build.answer_of(new), (3, 7))
        key = lambda q: json.dumps(q, sort_keys=True)
        self.assertEqual(sorted(map(key, new["facePoints"])), sorted(map(key, p["facePoints"])))
        # Each point keeps its own final position.
        where = {key(q): screens[i] for i, q in enumerate(p["facePoints"]) if not q.get("hidden")}
        for i in (3, 7):
            self.assertEqual(new_row["quality"]["finalScreens"][i], where[key(new["facePoints"][i])])
        self.assertEqual(row["quality"]["finalScreens"], screens)  # input untouched


class UsableTests(unittest.TestCase):
    def render(self, p, summary_ok=True):
        rows = {"n": {"id": "x"}}
        meta = {"n": {"presetConfig": p}}
        total = len(p["facePoints"])
        states = [{"visiblePoints": list(range(total))}] * 2
        if not summary_ok:
            states = [{"visiblePoints": []}, {"visiblePoints": list(range(total))}]
        summaries = {"n": {"totalPoints": total, "hiddenPoints": [1, 2, 3, 5, 6, 7], "states": states}}
        return rows, meta, summaries

    def test_rejections_name_the_first_failed_check(self):
        p = preset()
        ok_row = {"valid": True, "quality": {"finalScreens": [[0, 0]] * 8}}
        self.assertEqual(build.usable("n", p, {"valid": False}, self.render(p), Path(".")), "failed validation")
        other = preset(tracked=(0, 2))
        self.assertEqual(build.usable("n", p, ok_row, self.render(other), Path(".")),
                         "render is from a different preset")
        self.assertEqual(build.usable("n", p, ok_row, self.render(p, summary_ok=False), Path(".")),
                         "point not visible in render")


if __name__ == "__main__":
    unittest.main()
