#!/bin/bash
# Top-up pass 2: closes the remaining d4 deficit after main + d4-rerun + topup1.
#
# Why: pinwheel-d4 and opensink-d4 each stuck at 48 (24 main + 24 topup1)
# because Phase 2's earlyStopCount = ceil(count_per_shard * 1.5) caps
# acceptance. With count_per_shard=21, earlyStopCount=32 — Phase 2 stops at
# 32 valid progressions/shard, regardless of how many trajectories
# max-trajectory-candidates allows. This pass uses count_per_shard=42 →
# earlyStopCount=63, doubling Phase 2's acceptance ceiling.
#
# waterbomb-d4 only needs +19 to hit 84 — count=21/shard with seed=11111
# (different from prior passes' 12345/67890) yields enough.
#
# All output: <cell>-topup2-s<shard>.json — distinct from prior passes
# so the dataset assembly step combines everything cleanly.

set -e
cd /home/johnnyas/Coding/OrigamiSimulator
OUT=new_dataset/uniform-1000
LOG=new_dataset/uniform-1000-logs
SEED=11111

if ! curl -fs -o /dev/null http://localhost:3000/; then
    echo "ERROR: dev server not running. Start with 'bun run dev' first." >&2
    exit 1
fi

run_topup2_d4() {
    local model_path=$1 model_key=$2 count_per_shard=$3 shard=$4
    local start=$((shard * count_per_shard + 1))
    local seed=$((SEED + shard * 1009))
    bun tools/generate-presets.js \
        --model "$model_path" --difficulty 4 \
        --count "$count_per_shard" --base-name "${model_key}-d4-topup2" --start-index $start \
        --seed $seed \
        --build-progressions 600 \
        --max-trajectory-candidates 500 --max-scan-candidates 30 \
        --templates "no-match-pattern-*" \
        --output "$OUT/${model_key}-d4-topup2-s${shard}.json" \
        > "$LOG/${model_key}-d4-topup2-s${shard}.log" 2>&1
}

echo "[topup2] 3 d4 cells × 4 shards = 12 workers parallel"
for shard in 0 1 2 3; do
    # waterbomb only needs +19; count_per_shard=21 (× 4 shards = 84 attempts) is plenty
    run_topup2_d4 /Bases/waterbombBase.svg waterbomb 21 "$shard" &
    # pinwheel/opensink need +36 each; bump count_per_shard=42 to lift Phase 2 acceptance ceiling
    run_topup2_d4 /Bases/pinwheelBase.svg  pinwheel  42 "$shard" &
    run_topup2_d4 /Bases/openSinkBase.svg  opensink  42 "$shard" &
done
wait
echo "[topup2] all done. Per-cell yields:"
for cell in waterbomb-d4 pinwheel-d4 opensink-d4; do
    total=0
    for s in 0 1 2 3; do
        f="$OUT/${cell}-topup2-s${s}.json"
        [ -f "$f" ] && total=$((total + $(python3 -c "import json; print(len(json.load(open('$f'))))" 2>/dev/null || echo 0)))
    done
    printf "  %-15s topup2=%d\n" "$cell" "$total"
done
