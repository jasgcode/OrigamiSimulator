#!/usr/bin/env python3
"""Reference scorer for point-tracking datasets.

  python3 tools/score-predictions.py --dataset DATASET_DIR/dataset.jsonl \\
      --predictions predictions.jsonl [--out scored.jsonl]

Each prediction line is {"id": ..., "response": "<raw model text>"}; a line
may give "answer": ["A", "C"] instead of a raw response.

Scoring policy:
  - exact: the predicted letter set equals gt_answer (order ignored). This is
    the headline metric.
  - f1: letter-level F1 against gt_answer, for partial credit.
  - format_ok: the response is exactly one {"answer": [...]} object, as the
    question requires (surrounding whitespace allowed). Scored separately so a
    wrapped but correct answer is not a wrong answer.
  - Responses with no {"answer": ...} object are "unparsed"; answers with
    unknown letters, duplicates, or a non-list value are "invalid". Both score
    0 but are counted apart from wrong answers, and so are missing
    predictions.
  - chance: expected exact score from guessing the right number of letters
    uniformly from the labels shown.
"""
import argparse
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path


def as_letters(value):
    """gt_answer is stored as a JSON string ('["B","D"]'); accept a list too."""
    return json.loads(value) if isinstance(value, str) else list(value)


def extract_answer(response):
    """Returns (answer or None, format_ok). Uses the last {"answer": ...} object."""
    text = response.strip()
    try:
        whole = json.loads(text)
        if isinstance(whole, dict) and set(whole) == {"answer"}:
            return whole["answer"], True
    except (json.JSONDecodeError, TypeError):
        pass
    decoder = json.JSONDecoder()
    found = None
    for match in re.finditer(r"\{", text):
        try:
            obj, _ = decoder.raw_decode(text, match.start())
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and "answer" in obj:
            found = obj["answer"]
    return found, False


def score_item(item, prediction):
    gold = as_letters(item["gt_answer"])
    labels = item["meta_info"]["all_labels"]
    row = {"id": item["id"], "gold": gold,
           "chance": 1 / math.comb(len(labels), len(gold)),
           "difficulty": item["meta_info"].get("difficulty"), "object": item["meta_info"].get("object")}
    if prediction is None:
        return {**row, "status": "missing", "exact": 0.0, "f1": 0.0, "format_ok": False, "answer": None}
    if "response" in prediction:
        answer, format_ok = extract_answer(prediction["response"])
    else:
        answer, format_ok = prediction.get("answer"), True
    if answer is None:
        return {**row, "status": "unparsed", "exact": 0.0, "f1": 0.0, "format_ok": False, "answer": None}
    valid = (isinstance(answer, list) and all(isinstance(a, str) for a in answer)
             and len(set(answer)) == len(answer) and set(answer) <= set(labels))
    if not valid:
        return {**row, "status": "invalid", "exact": 0.0, "f1": 0.0, "format_ok": format_ok, "answer": answer}
    hit = len(set(answer) & set(gold))
    f1 = 2 * hit / (len(answer) + len(gold)) if answer or gold else 1.0
    return {**row, "status": "ok", "exact": float(set(answer) == set(gold)), "f1": f1,
            "format_ok": format_ok, "answer": answer}


def wilson(successes, n, z=1.96):
    if not n:
        return 0.0, 0.0
    p = successes / n
    centre = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return centre - half, centre + half


def summarize(rows):
    n = len(rows)
    exact = sum(r["exact"] for r in rows)
    low, high = wilson(exact, n)
    counts = defaultdict(int)
    for r in rows:
        counts[r["status"]] += 1
    return {
        "n": n,
        "exact": exact / n if n else 0.0,
        "exact_ci95": [low, high],
        "f1": sum(r["f1"] for r in rows) / n if n else 0.0,
        "chance": sum(r["chance"] for r in rows) / n if n else 0.0,
        "format_ok": sum(r["format_ok"] for r in rows) / n if n else 0.0,
        "status": dict(counts),
    }


def score(dataset_rows, predictions):
    by_id = {}
    for p in predictions:
        if p["id"] in by_id:
            raise ValueError(f"duplicate prediction for {p['id']}")
        by_id[p["id"]] = p
    known = {item["id"] for item in dataset_rows}
    unknown = sorted(set(by_id) - known)
    if unknown:
        raise ValueError(f"predictions for ids not in the dataset: {unknown[:5]}")
    return [score_item(item, by_id.get(item["id"])) for item in dataset_rows]


def read_jsonl(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dataset", required=True, help="dataset.jsonl")
    parser.add_argument("--predictions", required=True, help="JSONL of {id, response} or {id, answer}")
    parser.add_argument("--out", help="Write per-item scores as JSONL")
    args = parser.parse_args(argv)
    rows = score(read_jsonl(args.dataset), read_jsonl(args.predictions))
    if args.out:
        Path(args.out).write_text("".join(json.dumps(r) + "\n" for r in rows))
    overall = summarize(rows)
    groups = defaultdict(list)
    for r in rows:
        groups[(r["difficulty"], r["object"])].append(r)
    print(json.dumps({"overall": overall,
                      "by_difficulty_object": {f"{d}/{o}": summarize(g) for (d, o), g in sorted(groups.items())}},
                     indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
