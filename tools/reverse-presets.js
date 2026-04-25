#!/usr/bin/env bun
/**
 * Reverse-preset transformer.
 *
 * Reads a forward-direction preset bundle (e.g. new_dataset/matrix-gen/_combined.json)
 * and emits a reversed bundle where each preset's `steps` array is reversed
 * and `direction: "reverse"` is set. Forward step[N-1] (folded with rotation)
 * becomes reversed step[0] (state 1 — folded). Forward step[0] (flat hero
 * shot, no rotation) becomes reversed step[N-1] (state N — flat).
 *
 * Usage:
 *   bun tools/reverse-presets.js \
 *     --input new_dataset/matrix-gen/_combined.json \
 *     --output new_dataset/matrix-gen/_combined_reverse.json
 *
 * The reversed bundle is then rendered into reverse_dataset/ via:
 *   DATASET_DIR=reverse_dataset python3 tools/render_dataset_parallel.py \
 *     --dataset new_dataset/matrix-gen/_combined_reverse.json
 */

import { parseArgs } from "util";
import { readFile, writeFile } from "fs/promises";

const { values: args } = parseArgs({
    options: {
        input:  { type: "string", default: "new_dataset/matrix-gen/_combined.json" },
        output: { type: "string", default: "new_dataset/matrix-gen/_combined_reverse.json" },
    },
    strict: false,
});

const inputPath = String(args.input);
const outputPath = String(args.output);

const raw = await readFile(inputPath, "utf8");
const presets = JSON.parse(raw);
if (!presets || typeof presets !== "object" || Array.isArray(presets)) {
    throw new Error("Expected top-level JSON object keyed by preset name");
}

const reversed = {};
let count = 0;
for (const [name, preset] of Object.entries(presets)) {
    if (!preset || !Array.isArray(preset.steps)) continue;
    const out = JSON.parse(JSON.stringify(preset));  // deep copy
    out.steps = out.steps.slice().reverse();
    out.direction = "reverse";
    reversed[name] = out;
    count++;
}

await writeFile(outputPath, JSON.stringify(reversed, null, 2), "utf8");
console.log(`reversed ${count} presets → ${outputPath}`);
