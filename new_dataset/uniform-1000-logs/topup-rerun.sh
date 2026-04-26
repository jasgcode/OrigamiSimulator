#!/bin/bash
# Top-up after main matrix run + d4 rerun.
# Brings deficit cells closer to target=84 by oversampling with seed=67890
# (different from main run's 12345, so trajectories don't collide).
#
# Two batches to stay under the 16-worker thrash threshold on this 32-core
# machine (load=224 was observed with 16 workers — adding more dropped
# per-worker throughput more than parallelism helped).
#
# All output files use naming pattern: <cell>-topup-s<shard>.json — distinct
# from main run files (<cell>-d{1,3,4}.json or -s{0..3}.json) so they can be
# combined by the dataset assembly step without collision.

set -e
cd /home/johnnyas/Coding/OrigamiSimulator
OUT=new_dataset/uniform-1000
LOG=new_dataset/uniform-1000-logs
SEED=67890

# Verify dev server
if ! curl -fs -o /dev/null http://localhost:3000/; then
    echo "ERROR: dev server not running. Start with 'bun run dev' first." >&2
    exit 1
fi

run_topup_d4() {
    local model_path=$1 model_key=$2 shard=$3
    local count=21
    local start=$((shard * count + 1))
    local seed=$((SEED + shard * 1009))
    bun tools/generate-presets.js \
        --model "$model_path" --difficulty 4 \
        --count $count --base-name "${model_key}-d4-topup" --start-index $start \
        --seed $seed \
        --build-progressions 600 \
        --max-trajectory-candidates 500 --max-scan-candidates 30 \
        --templates "no-match-pattern-*" \
        --output "$OUT/${model_key}-d4-topup-s${shard}.json" \
        > "$LOG/${model_key}-d4-topup-s${shard}.log" 2>&1
}

run_topup_d1d3() {
    local model_path=$1 model_key=$2 difficulty=$3 count=$4 shard=$5
    local start=$((shard * count + 1))
    local seed=$((SEED + shard * 1009))
    bun tools/generate-presets.js \
        --model "$model_path" --difficulty "$difficulty" \
        --count $count --base-name "${model_key}-d${difficulty}-topup" --start-index $start \
        --seed $seed \
        --build-progressions 125 \
        --max-trajectory-candidates 100 --max-scan-candidates 30 \
        --templates "no-match-pattern-*" \
        --output "$OUT/${model_key}-d${difficulty}-topup-s${shard}.json" \
        > "$LOG/${model_key}-d${difficulty}-topup-s${shard}.log" 2>&1
}

# Batch 1: d4 cells (12 workers parallel)
echo "[topup] batch 1: d4 cells (waterbomb, pinwheel, opensink) × 4 shards"
for shard in 0 1 2 3; do
    run_topup_d4 /Bases/waterbombBase.svg waterbomb "$shard" &
    run_topup_d4 /Bases/pinwheelBase.svg  pinwheel  "$shard" &
    run_topup_d4 /Bases/openSinkBase.svg  opensink  "$shard" &
done
wait
echo "[topup] batch 1 done"

# Batch 2: d1/d3 cells (12 workers parallel). pinwheel-d1 (-2) skipped —
# close enough that one extra preset isn't worth a worker.
echo "[topup] batch 2: bird-d1, opensink-d1, opensink-d3 × 4 shards"
for shard in 0 1 2 3; do
    run_topup_d1d3 /Bases/birdBase.svg     bird     1 12 "$shard" &
    run_topup_d1d3 /Bases/openSinkBase.svg opensink 1 10 "$shard" &
    run_topup_d1d3 /Bases/openSinkBase.svg opensink 3  5 "$shard" &
done
wait
echo "[topup] batch 2 done"

echo "[topup] all top-ups complete. Per-cell yields:"
for cell_diff in waterbomb-d4 pinwheel-d4 opensink-d4 bird-d1 opensink-d1 opensink-d3; do
    total=0
    for s in 0 1 2 3; do
        f="$OUT/${cell_diff}-topup-s${s}.json"
        [ -f "$f" ] && total=$((total + $(python3 -c "import json; print(len(json.load(open('$f'))))" 2>/dev/null || echo 0)))
    done
    printf "  %-15s topup=%d\n" "$cell_diff" "$total"
done
