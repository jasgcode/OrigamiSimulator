#!/usr/bin/env bash
# Builds dataset-300b from the source banks that generate.sh wrote: the three
# selection steps, the shortcut audit, then rendering, checks and probes.
#
# Usage, from the repository root:
#   bash release/dataset-300b/build.sh [OUT_DIR]     (default new_dataset/dataset-300b)
#
# Selection writes to <WORK>/selection/. Against the original banks it rebuilds
# presets.json and provenance.json byte for byte.
# Environment: WORK (default new_dataset/climb), PORT (render server, default 3050).
set -euo pipefail
cd "$(dirname "$0")/../.."
WORK="${WORK:-new_dataset/climb}"
OUT="${1:-new_dataset/dataset-300b}"
SEL="$WORK/selection"
HERE=release/dataset-300b
mkdir -p "$SEL"

# 1. 50 medium + 50 expert, split evenly over bases.
python3 $HERE/select-100.py "$SEL/dataset-100-bank.json" --work-dir "$WORK"
# 2. 150 medium + 150 expert, keeping the first 100. Only the medium half is used.
python3 $HERE/select-300.py "$SEL/dataset-300-bank.json" --per-tier 150 \
    --keep "$SEL/dataset-100-bank.provenance.json" --work-dir "$WORK"
# 3. The medium half of step 2, plus 150 expert items chosen so twin facing,
#    the least-turn rate and the middle-dot rate stay at chance.
python3 $HERE/select-300b.py "$SEL/dataset-300b-bank.json" --per-tier 150 \
    --medium-bank "$SEL/dataset-300-bank.json" --work-dir "$WORK"
cmp -s "$SEL/dataset-300b-bank.json" $HERE/presets.json \
    && echo "selection matches release/dataset-300b/presets.json" \
    || echo "selection differs from release/dataset-300b/presets.json (expected after regenerating banks)"

# Position-shortcut audit of exactly the selected presets.
python3 $HERE/audit.py "$SEL/dataset-300b-bank.json" --work-dir "$WORK"

bash $HERE/render.sh "$SEL/dataset-300b-bank.json" "$OUT" "${PORT:-3050}"
