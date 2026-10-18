#!/usr/bin/env bash
# Regenerates the source banks of dataset-300b: the five medium and ten expert
# runs of tools/generate-expert-dataset.py, with the settings and seeds used for
# the release. Each run writes <WORK>/<name>-bank/ (job banks, validation
# reports and assembled.json) and logs to <WORK>/gen-<name>.log.
#
# Generation is not bit-reproducible (GPU settle timing, --max-hours caps and
# worker scheduling vary), so a rerun yields comparable banks, not the same
# ones. The released presets are in presets.json; render.sh reproduces the
# images exactly.
#
# Start a dev server whose DATASET_DIR matches RENDER_DIR first:
#   DATASET_DIR=new_dataset/climb/render PORT=3001 bun run dev
# Then, from the repository root:
#   bash release/dataset-300b/generate.sh                 # all fifteen runs, in order
#   bash release/dataset-300b/generate.sh r11-d3 r5-d5    # selected runs
#
# Environment: WORK (default new_dataset/climb), RENDER_DIR (default
# $WORK/render), SERVER_URL (default http://localhost:3001), DRY_RUN=1 to print
# the commands without running them. Each run stops launching jobs after its
# --max-hours cap (2-10 hours).
set -euo pipefail
cd "$(dirname "$0")/../.."
WORK="${WORK:-new_dataset/climb}"
RENDER_DIR="${RENDER_DIR:-$WORK/render}"
SERVER_URL="${SERVER_URL:-http://localhost:3001}"

# Medium: 20 dots, 3-5 scatter dots, groups of 2-4, last-image sizes 0.6-1.4x,
# spin up to +-0.75 turn.
MEDIUM="--cluster-points 20,20 --cluster-scatter 3,5 --cluster-group-size 2,4 --cluster-end-sizes 0.6,1.4 --cluster-spin-turns 0.75"
# Expert bird and pinwheel: 22 dots, 3-5 scatter dots, groups of 2-4, sizes 0.75-1.25x.
EXPERT="--cluster-points 22,22 --cluster-scatter 3,5 --cluster-group-size 2,4 --cluster-end-sizes 0.75,1.25"
# Expert waterbomb: its cramped poses fail legibility checks with more dots.
WATERBOMB="--cluster-points 16,18 --cluster-scatter 1,2 --cluster-end-sizes 0.75,1.25"
# Expert filler on the bases with only a 180-degree twin (boat, open sink,
# square): no back groups, since their twins and back panels never show together.
FRONT180="$EXPERT --cluster-back-groups 0,0"

# name|tier|total|models|count-per-job|workers|max-hours|job-timeout-min|max-dry-jobs|base-seed|settings
RUNS=(
    "r11-d3|3|60|bird,waterbomb,pinwheel,boat,opensink,square|5|8|3|60|3|111001|MEDIUM"
    "r11-d3-topup|3|28|bird,pinwheel,opensink,square|5|8|3|60|4|112001|MEDIUM"
    "r11-d3-topup2|3|8|opensink,square|5|4|2|60|4|113001|MEDIUM"
    "s300-d3|3|100|bird,waterbomb,pinwheel,boat,opensink,square|5|8|5|60|6|130001|MEDIUM"
    "s300-d3b|3|30|bird,waterbomb,pinwheel,boat,opensink|5|8|2|60|6|134001|MEDIUM"
    "r5-d5|5|45|bird,pinwheel,waterbomb|6|10|4|180|3|95001|EXPERT"
    "r5-d5-bird2|5|10|bird|6|6|3|180|4|99501|EXPERT"
    "r5-d5-waterbomb2|5|15|waterbomb|6|6|4|180|4|98101|WATERBOMB"
    "s300-d5|5|64|bird,pinwheel|6|12|10|180|6|131001|EXPERT"
    "s300-d5b|5|30|bird,pinwheel|6|8|8|180|6|135001|EXPERT"
    "s300-d5-waterbomb|5|40|waterbomb|6|6|10|180|8|132001|WATERBOMB"
    "bal-d5|5|60|bird,pinwheel|6|22|6|180|8|150001|EXPERT"
    "bal-d5-waterbomb|5|12|waterbomb|6|6|6|180|8|151001|WATERBOMB"
    "r5-d5-front180|5|6|boat,opensink,square|5|3|2|150|3|99701|FRONT180"
    "s300-d5-front180|5|30|boat,opensink,square|5|2|10|150|6|133001|FRONT180"
)

wanted=" $* "
for run in "${RUNS[@]}"; do
    IFS='|' read -r name tier total models per_job workers hours timeout dry seed settings <<< "$run"
    if [ $# -gt 0 ] && [[ "$wanted" != *" $name "* ]]; then continue; fi
    # shellcheck disable=SC2086  # the settings string holds several flags
    cmd=(python3 tools/generate-expert-dataset.py --difficulty "$tier" --total "$total" --models "$models"
        --count-per-job "$per_job" --workers "$workers" --max-hours "$hours" --job-timeout-min "$timeout"
        --max-dry-jobs "$dry" --base-seed "$seed" ${!settings}
        --out-dir "$WORK/$name-bank" --render-dir "$RENDER_DIR" --server-url "$SERVER_URL" --skip-render)
    if [ -n "${DRY_RUN:-}" ]; then echo "${cmd[*]}"; continue; fi
    echo "$(date +%H:%M) $name: generating (log: $WORK/gen-$name.log)"
    "${cmd[@]}" > "$WORK/gen-$name.log" 2>&1
    echo "$(date +%H:%M) $name: done"
done
