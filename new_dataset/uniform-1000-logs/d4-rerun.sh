#!/bin/bash
# d4 rerun (front anchor, no probing). Runs only models that need it —
# waterbomb-d4 already produced 25 presets; bird/pinwheel/opensink-d4 are 0.
#
# Front anchor produces:
#   bird-d4: ~100% Phase 2 yield (compact 3D structure resists d4 rotation)
#   pinwheel/opensink: ~25-45% yield (matches original main-run pattern)
#
# To break the per-shard --max-trajectory-candidates=40 cap that limited
# yield in earlier runs, this run uses --max-trajectory-candidates 200 with
# matching --build-progressions 250. Per-shard count=21 stays the same.
#
# Parallelism: 8 workers at a time (vs 16 last time). 8 × ~30 chrome
# subprocess each = ~240 processes, load ~200 — at the edge of the
# 32-core machine's headroom. More workers = more context-switch
# overhead, less throughput per worker.
set -e
cd /home/johnnyas/Coding/OrigamiSimulator
OUT=new_dataset/uniform-1000
LOG=new_dataset/uniform-1000-logs

run_shard() {
    local model_path=$1 model_key=$2 shard=$3
    local count_per_shard=21
    local start_idx=$((shard * count_per_shard + 1))
    local seed=$((12345 + shard * 1009))
    bun tools/generate-presets.js \
        --model "$model_path" --difficulty 4 \
        --count "$count_per_shard" --base-name "${model_key}-d4" --start-index "$start_idx" \
        --seed "$seed" \
        --build-progressions 250 \
        --max-trajectory-candidates 200 --max-scan-candidates 30 \
        --templates "no-match-pattern-*" \
        --output "$OUT/${model_key}-d4-s${shard}.json" \
        > "$LOG/${model_key}-d4-s${shard}.log" 2>&1
}

# Batch 1: bird + pinwheel (8 workers — bird×4 + pinwheel×4)
for shard in 0 1 2 3; do
    run_shard /Bases/birdBase.svg     bird     "$shard" &
    run_shard /Bases/pinwheelBase.svg pinwheel "$shard" &
done
wait
echo "batch 1 done (bird + pinwheel)"

# Batch 2: opensink (4 workers — opensink×4). waterbomb is already at 25 from
# the earlier rerun, skipped here. Could add waterbomb later if we want fresh
# numbers, but keeping the 25 to save time.
for shard in 0 1 2 3; do
    run_shard /Bases/openSinkBase.svg opensink "$shard" &
done
wait
echo "batch 2 done (opensink)"
echo "all d4 reruns complete"
