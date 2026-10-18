"""Score predictions and slice exact match by tier and base (ported from
new_dataset/climb/slice.py).

Usage: score-by-base.py DATASET.jsonl PREDICTIONS.jsonl [LABEL] [-v]

Writes PREDICTIONS.scored.jsonl with tools/score-predictions.py, then prints
exact match and chance per tier (and per base with -v).
"""
import collections, json, subprocess, sys
from pathlib import Path

SCORER = Path(__file__).resolve().parents[2] / "tools" / "score-predictions.py"
dataset, preds = sys.argv[1], sys.argv[2]
label = sys.argv[3] if len(sys.argv) > 3 else preds
scored = preds.replace(".jsonl", ".scored.jsonl")
subprocess.run([sys.executable, str(SCORER), "--dataset", dataset, "--predictions", preds, "--out", scored],
               check=True, capture_output=True)
data = {json.loads(l)["id"]: json.loads(l) for l in open(dataset)}
agg = collections.defaultdict(lambda: [0.0, 0, 0.0])
for line in open(scored):
    r = json.loads(line); m = data[r["id"]]["meta_info"]
    for key in ((m["difficulty"], "ALL"), (m["difficulty"], m["object"])):
        a = agg[key]; a[0] += r["exact"]; a[1] += 1; a[2] += r["chance"]
for k in sorted(agg):
    e, n, c = agg[k]
    if k[1] == "ALL" or "-v" in sys.argv:
        print(f"{label:22s} {k[0]:7s} {k[1]:15s} n={n:2d} exact {e/n:.2f}  chance {c/n:.3f}")
