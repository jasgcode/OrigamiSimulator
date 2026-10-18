import importlib.util
import random
import sys
import unittest
from pathlib import Path


def load_tool(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


rebalance = load_tool("rebalance-anchors")

# Two tracked panels (faces 0 and 1), four dots each in a row, plus two back
# dots. Index 0 and 4 are the current anchors. Each row's second and third
# dots tie as its middle (summed distance 225 px); its last dot is both the
# most isolated and the outermost.
ROW = [0, 60, 110, 175]


def preset(difficulty=5, model="/Bases/birdBase.svg"):
    faces = [0, 0, 0, 0, 1, 1, 1, 1, 20, 21]
    points = [{"faceId": f, "u": .3, "v": .3, "w": .4, "hidden": i not in (0, 4)} for i, f in enumerate(faces)]
    return {"model": model, "difficulty": difficulty, "minPointViewQuality": 0.3, "minPointSeparationPx": 50,
            "enforceSeparationAllSteps": True, "facePoints": points,
            "steps": [{"fold": 0}, {"fold": 30}, {"fold": 60}]}


def screens(offset_y=400):
    return [[x, 100] for x in ROW] + [[x, offset_y] for x in ROW] + [[600, 600], [700, 700]]


def trace(steps=3, invisible=(), low_quality=(), screen_rows=None):
    rows = []
    for s in range(steps):
        rows.append({"visible": [(s, i) not in invisible for i in range(10)],
                     "viewQuality": [0.1 if (s, i) in low_quality else 0.9 for i in range(10)],
                     "screens": (screen_rows or {}).get(s, screens())})
    return rows


class EligibilityTests(unittest.TestCase):
    def test_dots_must_be_visible_and_face_on_at_every_step(self):
        eligible = rebalance.eligible_dots(preset(), trace(invisible={(1, 2)}, low_quality={(0, 7)}))
        self.assertEqual(eligible, {0: [0, 1, 3], 1: [4, 5, 6]})

    def test_medium_mapfold_skips_mid_step_visibility_like_the_validator(self):
        hidden_mid = trace(invisible={(1, 2)})
        self.assertIn(2, rebalance.eligible_dots(preset(3, "/SimpleFolds/mapfold.svg"), hidden_mid)[0])
        self.assertNotIn(2, rebalance.eligible_dots(preset(5, "/SimpleFolds/mapfold.svg"), hidden_mid)[0])

    def test_anchor_spacing_is_checked_before_the_final_step_only(self):
        close = {1: screens(offset_y=120)}  # rows 20 px apart at step 1
        self.assertFalse(rebalance.anchors_separated(preset(), trace(screen_rows=close), [0, 4]))
        close_final = {2: screens(offset_y=120)}
        self.assertTrue(rebalance.anchors_separated(preset(), trace(screen_rows=close_final), [0, 4]))

    def test_roles_keep_tied_dots(self):
        self.assertEqual(rebalance.middle_dots(preset(), screens()), {0: [1, 2], 1: [5, 6]})
        roles = rebalance.role_dots(preset(), screens())[0]["roles"]
        self.assertEqual(roles, {"middle": [1, 2], "isolated": [3], "outermost": [3]})

    def test_mutual_nearest_neighbours_tie_as_most_isolated(self):
        # Two tight pairs 100 px apart: every dot's nearest gap is 20 px or 30 px.
        rows = [[0, 0], [20, 0], [120, 0], [150, 0]] + [[x, 400] for x in ROW] + [[600, 600], [700, 700]]
        roles = rebalance.role_dots(preset(), rows)[0]["roles"]
        self.assertEqual(roles["isolated"], [2, 3])


class AssignmentTests(unittest.TestCase):
    def test_apply_moves_hidden_flags_within_each_group_only(self):
        out = rebalance.apply_anchors(preset(), {0: 2, 1: 7})
        self.assertEqual([i for i, p in enumerate(out["facePoints"]) if not p["hidden"]], [2, 7])
        self.assertTrue(out["facePoints"][8]["hidden"] and out["facePoints"][9]["hidden"])
        self.assertEqual([p["faceId"] for p in out["facePoints"]], [p["faceId"] for p in preset()["facePoints"]])
        self.assertFalse(preset()["facePoints"][0]["hidden"])  # input untouched

    def test_skewed_pool_is_rebalanced_to_chance_without_dropping_presets(self):
        options = {}
        for n in range(20):
            p = preset()
            for g in (0, 4):  # make every current anchor the middle dot
                p["facePoints"][g]["hidden"], p["facePoints"][g + 1]["hidden"] = True, False
            options[f"p{n}"] = rebalance.options_for(p, trace())
        before = sum(rebalance.hits_of(o, o["current"]) for o in options.values())
        anchors, hits, groups = rebalance.assign(options, random.Random(1))
        self.assertEqual((before, groups), (20, 40))  # each middle is a two-way tie: half credit
        self.assertLessEqual(abs(hits - 10), 0.5)
        self.assertEqual(len(anchors), 20)
        self.assertAlmostEqual(hits, sum(rebalance.hits_of(options[n], a) for n, a in anchors.items()))

    def test_every_position_role_is_balanced_not_only_the_middle(self):
        # Each row's last dot (3 and 7) is both its most isolated and its
        # outermost dot. Start with every anchor there.
        options = {}
        for n in range(20):
            p = preset()
            for anchor in (3, 7):
                for i in range(anchor - 3, anchor + 1):
                    p["facePoints"][i]["hidden"] = i != anchor
            options[f"p{n}"] = rebalance.options_for(p, trace())
        anchors, _, groups = rebalance.assign(options, random.Random(4))
        for role in rebalance.ROLES:
            hits = sum(rebalance.hits_of(options[n], a, role) for n, a in anchors.items())
            self.assertLessEqual(abs(hits - groups / 4), 0.5, role)

    def test_only_eligible_dots_become_anchors(self):
        # Only the middle dots are eligible, so the rate cannot reach chance.
        blocked = {(1, i) for i in (0, 2, 3, 4, 6, 7)}
        options = {f"p{n}": rebalance.options_for(preset(), trace(invisible=blocked)) for n in range(8)}
        anchors, hits, groups = rebalance.assign(options, random.Random(2))
        self.assertTrue(all(a == {0: 1, 1: 5} for a in anchors.values()))
        self.assertEqual((hits, groups), (8, 16))

    def test_assignment_keeps_anchor_spacing(self):
        # Dots 3 and 7 sit 20 px apart at step 1, so they are never anchors together.
        rows = screens()
        rows[7] = [175, 120]
        opts = {f"p{n}": rebalance.options_for(preset(), trace(screen_rows={1: rows})) for n in range(30)}
        anchors, _, _ = rebalance.assign(opts, random.Random(3))
        self.assertFalse(any(a == {0: 3, 1: 7} for a in anchors.values()))


if __name__ == "__main__":
    unittest.main()
