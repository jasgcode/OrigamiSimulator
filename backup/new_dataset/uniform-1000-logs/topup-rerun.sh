#!/bin/bash
# Top-up run for new_dataset/uniform-1000.
# Re-runnable as-is. Output written to new_dataset/uniform-1000/<cell>-topup.json
# alongside the main run's <cell>.json / <cell>-s*.json files.
#
# Provenance: see MANIFEST.json in this directory.
# Main run yielded 770 / 1008. Deficits per cell drove the per-cell oversampling
# below — counts include an attrition buffer so that the expected yield matches
# or slightly exceeds the deficit.
#
# Seed 67890 (vs main run's 12345) prevents trajectory collisions with already-
# generated presets.
set -euo pipefail

cd "$(dirname "$0")/../.."  # repo root
OUT=new_dataset/uniform-1000
LOGS=new_dataset/uniform-1000-logs
mkdir -p "$OUT" "$LOGS"

# Verify dev server is up
if ! curl -fs -o /dev/null http://localhost:3000/; then
    echo "ERROR: dev server not running. Start with 'bun run dev' first." >&2
    exit 1
fi

run_topup() {
    local model_path=$1
    local difficulty=$2
    local cell=$3
    local count=$4
    local build=$5
    local maxtraj=$6
    bun tools/generate-presets.js \
        --model "$model_path" --difficulty "$difficulty" \
        --count "$count" --base-name "${cell}-topup" --start-index 1 \
        --seed 67890 \
        --build-progressions "$build" \
        --max-trajectory-candidates "$maxtraj" \
        --max-scan-candidates 30 \
        --output "$OUT/${cell}-topup.json" \
        > "$LOGS/${cell}-topup.log" 2>&1
}

# All seven cells in parallel. Each holds one Puppeteer Chrome (~1 core under
# SwiftShader). 7 in parallel is well under the 28-core concurrency budget.
run_topup /Bases/pinwheelBase.svg  1 pinwheel-d1   100 150 200 &
run_topup /Bases/birdBase.svg      1 bird-d1        60  90 200 &
run_topup /Bases/openSinkBase.svg  1 opensink-d1    50  75 200 &
run_topup /Bases/openSinkBase.svg  3 opensink-d3    20  30 200 &
run_topup /Bases/waterbombBase.svg 4 waterbomb-d4  100 150 200 &
run_topup /Bases/pinwheelBase.svg  4 pinwheel-d4   250 300 400 &
run_topup /Bases/openSinkBase.svg  4 opensink-d4   200 250 300 &
wait

echo "Top-up complete. Per-cell counts:"
for cell in bird-d1 opensink-d1 opensink-d3 pinwheel-d1 waterbomb-d4 pinwheel-d4 opensink-d4; do
    if [[ -f "$OUT/${cell}-topup.json" ]]; then
        n=$(python3 -c "import json; print(len(json.load(open('$OUT/${cell}-topup.json'))))" 2>/dev/null || echo ERR)
        echo "  ${cell}-topup: ${n}"
    fi
done
