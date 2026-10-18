#!/usr/bin/env python3
"""Check that a rendered point-tracking dataset is internally consistent.

  python3 tools/check-dataset.py new_dataset/expert-v2-150-render

For every dataset.jsonl row this re-derives the answer from the preset that
produced it (metadata presetConfig: non-hidden points, lettered in array
order) and checks it against gt_answer, then checks labels, images, and the
question text. Exits 1 on any problem, listing the first few per check.
"""
import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path


def letter(i):
    return chr(65 + i % 26)


def facepoint_list(face_points):
    """Presets store points as an ordered list or as {faceId: [points]}."""
    if isinstance(face_points, list):
        return face_points
    return [dict(p, faceId=int(face)) for face, pts in face_points.items() for p in pts]


def check_row(row, root, metadata_cache):
    problems = []
    meta = row["meta_info"]
    gold = json.loads(row["gt_answer"]) if isinstance(row["gt_answer"], str) else row["gt_answer"]
    config_path = root / meta["config"]
    if config_path not in metadata_cache:
        metadata_cache[config_path] = json.loads(config_path.read_text()) if config_path.exists() else {}
    entry = metadata_cache[config_path].get(meta["benchmark"])
    if entry is None:
        return [("metadata", f"no metadata entry {meta['benchmark']} in {meta['config']}")]
    preset = entry.get("presetConfig")
    if preset:
        points = facepoint_list(preset["facePoints"])
        derived = [letter(i) for i, p in enumerate(points) if not p.get("hidden")]
    else:
        # Older metadata has no preset copy; fall back to its point indices.
        points = [None] * entry["totalPoints"]
        hidden = set(entry["hiddenPoints"])
        derived = [letter(i) for i in range(entry["totalPoints"]) if i not in hidden]
    if sorted(gold) != sorted(derived):
        problems.append(("gold", f"gt_answer {gold} but the preset's visible points are {derived}"))
    if sorted(gold) != sorted(meta["initial_points"]):
        problems.append(("gold", f"gt_answer {gold} differs from meta_info.initial_points {meta['initial_points']}"))
    labels = [letter(i) for i in range(len(points))]
    if meta["all_labels"] != labels:
        problems.append(("labels", f"all_labels {meta['all_labels']} but the preset has {len(points)} points"))
    if len(set(gold)) != len(gold) or not set(gold) <= set(labels):
        problems.append(("gold", f"gt_answer {gold} has duplicates or letters outside {labels}"))
    steps = len(preset.get("steps") or []) if preset else meta["total_steps"]
    if not (len(row["images"]) == meta["total_steps"] == steps):
        problems.append(("images", f"{len(row['images'])} images, total_steps {meta['total_steps']}, preset steps {steps}"))
    missing = [p for p in row["images"] if not (root / p).exists()]
    if missing:
        problems.append(("images", f"{len(missing)} image files missing, e.g. {missing[0]}"))
    question = row["question"]
    for placeholder in ("{num_initial}", "{all_labels}", "{dots_shown}", "{dot_sizes}"):
        if placeholder in question:
            problems.append(("question", f"unsubstituted {placeholder}"))
    for placeholder in ("{images}", "{json_answer_value}"):
        if placeholder not in question:
            problems.append(("question", f"missing literal {placeholder}"))
    if f"with {len(gold)} unmarked dot" not in question:
        problems.append(("question", f"question does not state {len(gold)} unmarked dot(s)"))
    # Presets with end sizes must say the last image changes dot sizes; others must not.
    if preset and bool(preset.get("endDotSizes")) != ("drawn at different sizes" in question):
        problems.append(("question", "dot-size sentence does not match the preset's endDotSizes"))
    if "rotating slowly" in question:
        problems.append(("template", "old template: claims the paper rotates slowly"))
    if ", ".join(labels) not in question:
        problems.append(("question", "question does not list the labels"))
    return problems


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("dataset_dir", help="Directory holding dataset.jsonl, metadata/, and image folders")
    parser.add_argument("--show", type=int, default=3, help="Problems to list per check")
    args = parser.parse_args(argv)
    root = Path(args.dataset_dir)
    rows = [json.loads(line) for line in (root / "dataset.jsonl").read_text().splitlines() if line.strip()]
    ids = [r["id"] for r in rows]
    by_check = defaultdict(list)
    if len(set(ids)) != len(ids):
        by_check["ids"].append(("-", f"{len(ids) - len(set(ids))} duplicate ids"))
    cache = {}
    for row in rows:
        for check, message in check_row(row, root, cache):
            by_check[check].append((row["id"], message))
    print(f"{len(rows)} rows checked")
    if not by_check:
        print("OK: answers match their presets; labels, images, and question text are consistent")
        return 0
    for check, found in sorted(by_check.items()):
        print(f"FAIL {check}: {len(found)} problem(s)")
        for row_id, message in found[:args.show]:
            print(f"  {row_id}: {message}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
