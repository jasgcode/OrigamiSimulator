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


check = load_tool("check-dataset")
QUESTION = ("The first image shows the flat paper with 2 unmarked dot(s) printed on it ... letters A, B, C, D ... "
            "{images} ... chosen from [A, B, C, D] ... {json_answer_value}")


def write_dataset(root, gold='["B", "D"]', hidden=(0, 2), extra_rows=(), preset_extra=None):
    points = [{"faceId": i, "u": .3, "v": .3, "w": .4, "hidden": i in hidden} for i in range(4)]
    (root / "metadata").mkdir(parents=True)
    (root / "metadata" / "birdBase_metadata.json").write_text(json.dumps(
        {"bird-d5-01": {"presetConfig": {"facePoints": points, "steps": [{}, {}], **(preset_extra or {})}}}))
    (root / "case").mkdir()
    for i in range(2):
        (root / "case" / f"step_{i:04d}_current.png").write_bytes(b"png")
    row = {"id": "case", "gt_answer": gold, "question": QUESTION,
           "images": ["case/step_0000_current.png", "case/step_0001_current.png"],
           "meta_info": {"config": "metadata/birdBase_metadata.json", "benchmark": "bird-d5-01", "total_steps": 2,
                         "initial_points": json.loads(gold), "all_labels": ["A", "B", "C", "D"]}}
    rows = [row, *extra_rows]
    (root / "dataset.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    return row


class CheckDatasetTests(unittest.TestCase):
    def test_consistent_dataset_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_dataset(Path(tmp))
            self.assertEqual(check.main([tmp]), 0)

    def test_answer_that_disagrees_with_the_preset_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_dataset(Path(tmp), gold='["A", "D"]')
            self.assertEqual(check.main([tmp]), 1)

    def test_stale_duplicate_row_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            row = write_dataset(root)
            stale = dict(row, gt_answer='["A", "C"]', meta_info=dict(row["meta_info"], initial_points=["A", "C"]))
            (root / "dataset.jsonl").write_text(json.dumps(stale) + "\n" + json.dumps(row) + "\n")
            problems = check.check_row(stale, root, {})
            self.assertIn("gold", [c for c, _ in problems])
            self.assertEqual(check.main([tmp]), 1)

    def test_missing_image_and_old_template_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            row = write_dataset(root)
            (root / "case" / "step_0001_current.png").unlink()
            row = dict(row, question=QUESTION + " If there's rotating in the process, it's rotating slowly.")
            checks = {c for c, _ in check.check_row(row, root, {})}
            self.assertEqual(checks, {"images", "template"})

    def test_dot_size_sentence_must_match_the_preset(self):
        sized = QUESTION + " In the last image the dots are drawn at different sizes than before."
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            row = write_dataset(root, preset_extra={"endDotSizes": [.75, 1.25]})
            self.assertIn("question", {c for c, _ in check.check_row(row, root, {})})
            self.assertEqual(check.check_row(dict(row, question=sized), root, {}), [])
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            row = write_dataset(root)
            self.assertIn("question", {c for c, _ in check.check_row(dict(row, question=sized), root, {})})


if __name__ == "__main__":
    unittest.main()
