#!/usr/bin/env bash
# Renders a preset bank into a dataset directory, checks every row against its
# preset, and writes the probe files. Starts and stops its own dev server.
#
# Usage, from the repository root:
#   bash release/dataset-300b/render.sh release/dataset-300b/presets.json new_dataset/dataset-300b [PORT]
#
# Environment: RENDER_WORKERS (default 6; each is one headless Chromium,
# ~1 CPU core and ~700 MB of RAM).
set -euo pipefail
cd "$(dirname "$0")/../.."
BANK="$1"; OUT="$2"; PORT="${3:-3050}"
if [ -e "$OUT/dataset.jsonl" ]; then
    echo "$OUT already holds a dataset.jsonl; remove it or choose another directory" >&2
    exit 1
fi
mkdir -p "$OUT"
DATASET_DIR="$OUT" PORT="$PORT" bun server.js > "$OUT.server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 30); do
    curl -sf "http://localhost:$PORT/" > /dev/null && break
    sleep 1
done
DATASET_DIR="$OUT" python3 tools/render_dataset_parallel.py --dataset "$BANK" \
    --server-url "http://localhost:$PORT" --workers "${RENDER_WORKERS:-6}"
python3 tools/check-dataset.py "$OUT"
python3 tools/build-probes.py "$OUT"
