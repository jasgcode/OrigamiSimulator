#!/bin/bash
# Top-up pass 3: closes the last 26-preset deficit.
#
# Remaining gaps after main + d4_rerun + topup1 + topup2:
#   pinwheel-d1: -2  (close enough that any small run covers it)
#   pinwheel-d4: -12 (Phase 2 yield ~6/shard with front anchor + count=21)
#   opensink-d4: -12 (same as pinwheel-d4)
#
# All output: <cell>-topup3-s<shard>.json — distinct from prior passes
# so the dataset assembly step combines them all without collision.
# Seed 22222 (different from main 12345, topup 67890, topup2 11111) so
# trajectories don't repeat.

set -e
cd /home/johnnyas/Coding/OrigamiSimulator
OUT=new_dataset/uniform-1000
LOG=new_dataset/uniform-1000-logs
SEED=22222

if ! curl -fs -o /dev/null http://localhost:3000/; then
    echo "ERROR: dev server not running. Start with 'bun run dev' first." >&2
    exit 1
fi

run_topup3() {
    local model_path=$1 model_key=$2 difficulty=$3 count_per_shard=$4 build=$5 max_traj=$6 shard=$7
    local start=$((shard * count_per_shard + 1))
    local seed=$((SEED + shard * 1009))
    bun tools/generate-presets.js \
        --model "$model_path" --difficulty "$difficulty" \
        --count "$count_per_shard" --base-name "${model_key}-d${difficulty}-topup3" --start-index $start \
        --seed $seed \
        --build-progressions $build \
        --max-trajectory-candidates $max_traj --max-scan-candidates 30 \
        --templates "no-match-pattern-*" \
        --output "$OUT/${model_key}-d${difficulty}-topup3-s${shard}.json" \
        > "$LOG/${model_key}-d${difficulty}-topup3-s${shard}.log" 2>&1
}

echo "[topup3] 3 short cells × 4 shards = 12 workers parallel"
for shard in 0 1 2 3; do
    # pinwheel-d1: high-yield (~80%); count=4/shard × 4 shards = 16 attempts ≈ 13 valid (covers -2)
    run_topup3 /Bases/pinwheelBase.svg pinwheel 1  4 100 100 "$shard" &
    # pinwheel-d4 / opensink-d4: front-anchor yield ~6/shard. count=21/shard with new seed
    # expects ~24 valid total per cell — comfortably covers the -12 deficit each
    run_topup3 /Bases/pinwheelBase.svg pinwheel 4 21 600 500 "$shard" &
    run_topup3 /Bases/openSinkBase.svg opensink 4 21 600 500 "$shard" &
done
wait
echo "[topup3] all done. Per-cell yields:"
for cell_diff in pinwheel-d1 pinwheel-d4 opensink-d4; do
    total=0
    for s in 0 1 2 3; do
        f="$OUT/${cell_diff}-topup3-s${s}.json"
        [ -f "$f" ] && total=$((total + $(python3 -c "import json; print(len(json.load(open('$f'))))" 2>/dev/null || echo 0)))
    done
    printf "  %-15s topup3=%d\n" "$cell_diff" "$total"
done
