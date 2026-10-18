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


scorer = load_tool("score-predictions")
LABELS = list("ABCDEFGHIJ")


def item(i, gold):
    return {"id": f"q{i}", "gt_answer": json.dumps(gold),
            "meta_info": {"all_labels": LABELS, "difficulty": "expert", "object": "birdBase"}}


DATASET = [item(0, ["B", "D"]), item(1, ["A", "J"]), item(2, ["C", "E"])]


def responses(*texts):
    return [{"id": f"q{i}", "response": t} for i, t in enumerate(texts)]


class ScorerTests(unittest.TestCase):
    def test_oracle_scores_one(self):
        preds = [{"id": d["id"], "response": json.dumps({"answer": json.loads(d["gt_answer"])})} for d in DATASET]
        s = scorer.summarize(scorer.score(DATASET, preds))
        self.assertEqual((s["exact"], s["f1"], s["format_ok"]), (1.0, 1.0, 1.0))

    def test_empty_responses_score_zero_and_are_unparsed_not_wrong(self):
        s = scorer.summarize(scorer.score(DATASET, responses("", "", "")))
        self.assertEqual(s["exact"], 0.0)
        self.assertEqual(s["status"], {"unparsed": 3})

    def test_order_does_not_matter_and_gold_may_be_a_list(self):
        rows = scorer.score([{**DATASET[0], "gt_answer": ["B", "D"]}], [{"id": "q0", "response": '{"answer": ["D", "B"]}'}])
        self.assertEqual(rows[0]["exact"], 1.0)

    def test_wrapped_answer_is_scored_but_flagged_as_bad_format(self):
        rows = scorer.score(DATASET[:1], [{"id": "q0", "response": 'Tracking...\n```json\n{"answer": ["B", "D"]}\n```'}])
        self.assertEqual((rows[0]["exact"], rows[0]["format_ok"], rows[0]["status"]), (1.0, False, "ok"))

    def test_partial_credit_and_invalid_answers(self):
        rows = scorer.score(DATASET, responses('{"answer": ["B", "C"]}', '{"answer": ["A", "A"]}', '{"answer": ["Z", "C"]}'))
        self.assertEqual([r["status"] for r in rows], ["ok", "invalid", "invalid"])
        self.assertEqual(rows[0]["exact"], 0.0)
        self.assertAlmostEqual(rows[0]["f1"], 0.5)

    def test_missing_predictions_are_counted_not_dropped(self):
        s = scorer.summarize(scorer.score(DATASET, responses('{"answer": ["B", "D"]}')))
        self.assertEqual(s["n"], 3)
        self.assertEqual(s["status"], {"ok": 1, "missing": 2})
        self.assertAlmostEqual(s["exact"], 1 / 3)

    def test_chance_is_one_over_label_combinations(self):
        rows = scorer.score(DATASET[:1], [])
        self.assertAlmostEqual(rows[0]["chance"], 1 / 45)

    def test_rejects_duplicate_and_unknown_ids(self):
        with self.assertRaises(ValueError):
            scorer.score(DATASET, responses("{}") + responses("{}"))
        with self.assertRaises(ValueError):
            scorer.score(DATASET, [{"id": "nope", "response": "{}"}])

    def test_cli_writes_per_item_scores(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / "d.jsonl").write_text("".join(json.dumps(d) + "\n" for d in DATASET))
            (tmp / "p.jsonl").write_text("".join(json.dumps(p) + "\n" for p in responses('{"answer": ["B", "D"]}')))
            self.assertEqual(scorer.main(["--dataset", str(tmp / "d.jsonl"), "--predictions", str(tmp / "p.jsonl"),
                                          "--out", str(tmp / "s.jsonl")]), 0)
            self.assertEqual(len((tmp / "s.jsonl").read_text().splitlines()), 3)


if __name__ == "__main__":
    unittest.main()
