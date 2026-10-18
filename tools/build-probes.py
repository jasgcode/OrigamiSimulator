#!/usr/bin/env python3
"""Build reduced-image probe sets from a rendered dataset.

  python3 tools/build-probes.py eval

Writes four files next to DATASET_DIR/dataset.jsonl, so image paths resolve
against the same directory:

  probe_final_only.jsonl            last image only
  probe_first_last.jsonl            flat and final images
  probe_final_only_reworded.jsonl   last image, question rewritten for it
  probe_first_last_reworded.jsonl   flat and final images, question rewritten

Ids and gt_answer are unchanged, so probe predictions score against any of
these files or dataset.jsonl with score-predictions.py. meta_info.probe names
the probe. The plain probes keep the full-sequence question, so only the
visual evidence differs from the full run, but their text still describes a
flat first image and intermediate frames. The reworded probes describe the
images actually sent. Only forward-template questions can be reworded.

  final_only: a score well above chance means the answer can be read from the
      final pose without the flat image.
  first_last: a score near the full-sequence score means the fold sequence is
      not doing the work.
"""
import argparse
import json
import sys
from pathlib import Path

# Forward-template text from JSONL_QUESTION_TEMPLATE and buildJsonlEntry in js/benchmark.js.
FORWARD_TASK = (
    "The first image shows the flat paper with {n} unmarked dot(s) printed on it. The following images show the same "
    "paper being folded step by step, ending with the fully folded result where every visible point is labeled using "
    "the letters {labels}. Paper is opaque: points on the back side may be hidden by overlying layers, and the same "
    "physical dot may appear in different positions across steps as the paper folds. The camera stays fixed, but the "
    "paper may rotate between images, sometimes by a large angle.{dots_shown}{dot_sizes} You must track each unmarked dot "
    "through the fold sequence and report the letter(s) in the final image that correspond to the original unmarked "
    "dot(s)."
)
DOTS_SHOWN = " Points are drawn only in the first and last images; the images in between show the paper without points."
DOT_SIZES = " In the last image the dots are drawn at different sizes than before; a dot's size does not show which dot it is."
FORWARD_QUESTION = ("Which lettered point(s) in the final folded image correspond to the unmarked dot(s) shown on the "
                    "flat paper in the first image? List the matching letter(s).")

REWORDED = {
    "final_only": (
        "Before folding, {n} unmarked dot(s) were printed on the flat paper; the flat paper is not shown. The image "
        "shows the fully folded result, where every visible point is labeled using the letters {labels}. Paper is "
        "opaque: points on the back side may be hidden by overlying layers.{dot_sizes} Report the letter(s) in the image "
        "that correspond to the original unmarked dot(s).",
        "Which lettered point(s) in the folded image correspond to the {n} unmarked dot(s) printed on the flat paper "
        "before folding? List the matching letter(s).",
    ),
    "first_last": (
        "The first image shows the flat paper with {n} unmarked dot(s) printed on it. The second image shows the same "
        "paper after folding, where every visible point is labeled using the letters {labels}; the folding steps in "
        "between are not shown. Paper is opaque: points on the back side may be hidden by overlying layers, and the "
        "same physical dot may appear in a different position after folding. The camera stays fixed, but the paper "
        "may rotate between the images, sometimes by a large angle.{dot_sizes} Report the letter(s) in the second image "
        "that correspond to the original unmarked dot(s).",
        "Which lettered point(s) in the folded second image correspond to the unmarked dot(s) shown on the flat paper "
        "in the first image? List the matching letter(s).",
    ),
}

# The dot-size sentence, worded for each probe's images.
PROBE_DOT_SIZES = {
    "final_only": " The dots in the image are drawn at different sizes; a dot's size does not show which dot it is.",
    "first_last": (" In the second image the dots are drawn at different sizes than in the first; a dot's size does not "
                   "show which dot it is."),
}

IMAGES = {
    "final_only": lambda images: images[-1:],
    "first_last": lambda images: [images[0], images[-1]],
}
PROBES = list(IMAGES) + [kind + "_reworded" for kind in REWORDED]


def reword(row, kind):
    """Swaps the forward task paragraph and question line for the ones written for `kind`."""
    meta = row["meta_info"]
    fields = {"n": len(meta["initial_points"]), "labels": ", ".join(meta["all_labels"])}
    question = row["question"]
    variants = [(FORWARD_TASK.format(**fields, dots_shown=shown, dot_sizes=sizes), bool(sizes))
                for shown in (DOTS_SHOWN, "") for sizes in (DOT_SIZES, "")]
    task, sized = next(((t, sized) for t, sized in variants if t in question), (None, False))
    if task is None or FORWARD_QUESTION not in question:
        raise ValueError(f"{row['id']}: question does not match the forward template")
    sizes = PROBE_DOT_SIZES[kind] if sized else ""
    new_task, new_question = (text.format(**fields, dot_sizes=sizes) for text in REWORDED[kind])
    return question.replace(task, new_task).replace(FORWARD_QUESTION, new_question)


def probe(row, kind):
    base = kind.removesuffix("_reworded")
    question = reword(row, base) if kind != base else row["question"]
    return {**row, "question": question, "images": IMAGES[base](row["images"]),
            "meta_info": {**row["meta_info"], "probe": kind}}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("dataset_dir", help="Directory holding dataset.jsonl")
    args = parser.parse_args(argv)
    root = Path(args.dataset_dir)
    rows = [json.loads(line) for line in (root / "dataset.jsonl").read_text().splitlines() if line.strip()]
    for kind in PROBES:
        out = root / f"probe_{kind}.jsonl"
        out.write_text("".join(json.dumps(probe(row, kind)) + "\n" for row in rows))
        print(f"{out}: {len(rows)} rows")
    return 0


if __name__ == "__main__":
    sys.exit(main())
