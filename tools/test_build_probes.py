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


probes = load_tool("build-probes")
IMAGES = [f"q0/step_{i:04d}_current.png" for i in range(14)]
LABELS = list("ABCDEFGHIJ")
# Rendered the way buildJsonlEntry in js/benchmark.js renders a forward expert question.
QUESTION = "\n".join([
    "[Task]",
    "You are solving origami point tracking.",
    "In this task, you must identify which labeled points on a folded piece of paper correspond to the unmarked dots placed on the original flat (unfolded) paper. "
    + probes.FORWARD_TASK.format(n=2, labels=", ".join(LABELS), dots_shown=probes.DOTS_SHOWN, dot_sizes=""),
    "{images}",
    "[Question]",
    probes.FORWARD_QUESTION,
    "Replace {json_answer_value} with a JSON array of uppercase letters chosen from [A, B, C, D, E, F, G, H, I, J].",
])
ROW = {"id": "q0", "question": QUESTION, "images": IMAGES, "gt_answer": "[\"B\", \"D\"]",
       "meta_info": {"difficulty": "expert", "object": "birdBase", "initial_points": ["B", "D"], "all_labels": LABELS}}


class ProbeTests(unittest.TestCase):
    def test_final_only_keeps_the_last_image(self):
        row = probes.probe(ROW, "final_only")
        self.assertEqual(row["images"], IMAGES[-1:])

    def test_first_last_keeps_the_flat_and_final_images(self):
        row = probes.probe(ROW, "first_last")
        self.assertEqual(row["images"], [IMAGES[0], IMAGES[-1]])

    def test_everything_but_images_is_unchanged_and_the_probe_is_recorded(self):
        row = probes.probe(ROW, "final_only")
        for key in ("id", "question", "gt_answer"):
            self.assertEqual(row[key], ROW[key])
        self.assertEqual(row["meta_info"], {**ROW["meta_info"], "probe": "final_only"})
        self.assertEqual(len(ROW["images"]), 14)
        self.assertNotIn("probe", ROW["meta_info"])

    def test_reworded_final_only_describes_one_folded_image(self):
        row = probes.probe(ROW, "final_only_reworded")
        self.assertEqual(row["images"], IMAGES[-1:])
        self.assertNotIn("first image", row["question"])
        self.assertNotIn("step by step", row["question"])
        self.assertIn("2 unmarked dot(s)", row["question"])
        self.assertIn("A, B, C, D, E, F, G, H, I, J", row["question"])
        for kept in ("[Task]", "{images}", "{json_answer_value}"):
            self.assertIn(kept, row["question"])

    def test_reworded_first_last_describes_two_images(self):
        row = probes.probe(ROW, "first_last_reworded")
        self.assertEqual(row["images"], [IMAGES[0], IMAGES[-1]])
        self.assertNotIn("in between show", row["question"])
        self.assertIn("second image", row["question"])
        self.assertIn("2 unmarked dot(s)", row["question"])

    def test_reworded_question_also_matches_without_the_dots_shown_sentence(self):
        question = QUESTION.replace(probes.DOTS_SHOWN, "")
        row = probes.probe({**ROW, "question": question}, "first_last_reworded")
        self.assertIn("second image", row["question"])

    def test_dot_size_sentence_is_reworded_for_each_probe(self):
        sized = QUESTION.replace(probes.DOTS_SHOWN, probes.DOTS_SHOWN + probes.DOT_SIZES)
        for kind in ("first_last", "final_only"):
            question = probes.probe({**ROW, "question": sized}, kind + "_reworded")["question"]
            self.assertIn(probes.PROBE_DOT_SIZES[kind], question)
            self.assertNotIn(probes.DOT_SIZES, question)
            # Questions without end sizes get no size sentence.
            self.assertNotIn("different sizes", probes.probe(ROW, kind + "_reworded")["question"])

    def test_unrecognised_question_text_fails_loudly(self):
        with self.assertRaises(ValueError):
            probes.probe({**ROW, "question": "[Task] something else {images}"}, "final_only_reworded")

    def test_main_writes_one_file_per_probe_next_to_the_dataset(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "dataset.jsonl").write_text(json.dumps(ROW) + "\n" + json.dumps({**ROW, "id": "q1"}) + "\n")
            self.assertEqual(probes.main([tmp]), 0)
            for kind, count in (("final_only", 1), ("first_last", 2), ("final_only_reworded", 1), ("first_last_reworded", 2)):
                rows = [json.loads(line) for line in (root / f"probe_{kind}.jsonl").read_text().splitlines()]
                self.assertEqual([r["id"] for r in rows], ["q0", "q1"])
                self.assertTrue(all(len(r["images"]) == count for r in rows))


if __name__ == "__main__":
    unittest.main()
