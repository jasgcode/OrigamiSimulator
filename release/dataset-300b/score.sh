#!/usr/bin/env bash
# Reproduces the reference scores: answers a rendered dataset and its reworded
# first+last probe with Claude through the Claude Code CLI (`claude -p`, logged
# in, tools off), then scores both by tier and base.
#
# Usage, from the repository root:
#   bash release/dataset-300b/score.sh DATASET_DIR [MODEL]   (default claude-opus-5-5)
#
# Predictions go to DATASET_DIR/predictions-<MODEL>-{full,first-last}.jsonl.
# eval-claude.py resumes from an existing predictions file, so delete it to
# re-ask every row. Scores from one sampled run vary by a few points.
set -euo pipefail
cd "$(dirname "$0")/../.."
DIR="$1"; MODEL="${2:-claude-opus-5-5}"
FULL="$DIR/predictions-$MODEL-full.jsonl"
FIRST_LAST="$DIR/predictions-$MODEL-first-last.jsonl"
python3 tools/eval-claude.py --dataset "$DIR/dataset.jsonl" --out "$FULL" --model "$MODEL" --workers 4
python3 tools/eval-claude.py --dataset "$DIR/probe_first_last_reworded.jsonl" --out "$FIRST_LAST" --model "$MODEL" --workers 4
python3 release/dataset-300b/score-by-base.py "$DIR/dataset.jsonl" "$FULL" "full" -v
python3 release/dataset-300b/score-by-base.py "$DIR/probe_first_last_reworded.jsonl" "$FIRST_LAST" "first+last" -v
