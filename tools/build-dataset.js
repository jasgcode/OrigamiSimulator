#!/usr/bin/env bun
/**
 * Dataset manifest builder.
 *
 * Seeds a per-model dataset JSON from existing presets, then lets you
 * merge generated batches in under a normalized naming scheme.
 *
 * Usage:
 *   # seed datasets/bird-base.json with existing bird-base d3/d5 from benchmarks.json
 *   bun tools/build-dataset.js seed \
 *     --dataset datasets/bird-base.json \
 *     --source benchmarks.json \
 *     --model-prefix /Bases/birdBase.svg \
 *     --name-prefix bird-base
 *
 *   # merge a generated batch (e.g. a d1 batch) into an existing dataset file,
 *   # renaming keys to bird-base-d1-01..NN in insertion order
 *   bun tools/build-dataset.js merge \
 *     --dataset datasets/bird-base.json \
 *     --batch datasets/bird-base-d1.json \
 *     --difficulty 1 \
 *     --name-prefix bird-base
 *
 *   # summary of a dataset manifest
 *   bun tools/build-dataset.js summary --dataset datasets/bird-base.json
 */

import { parseArgs } from "util";
import { mkdir } from "fs/promises";
import { dirname, join } from "path";

const ROOT = join(import.meta.dir, "..");

function resolvePath(p) {
    return p.startsWith("/") ? p : join(ROOT, p);
}

async function readJson(path) {
    return await Bun.file(resolvePath(path)).json();
}

async function writeJson(path, data) {
    const abs = resolvePath(path);
    await mkdir(dirname(abs), { recursive: true });
    await Bun.write(abs, JSON.stringify(data, null, 4) + "\n");
}

function pad2(n) {
    return n < 10 ? "0" + n : "" + n;
}

function isPresetObject(v) {
    return v && typeof v === "object" && !Array.isArray(v) && typeof v.model === "string";
}

// Return sorted [key, value] pairs from obj, filtered to valid preset objects.
function presetEntries(obj) {
    return Object.entries(obj)
        .filter(([_, v]) => isPresetObject(v))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// ── Commands ─────────────────────────────────────────────────────────

async function cmdSeed(args) {
    const datasetPath = args.dataset;
    const sourcePath = args.source;
    const modelPrefix = args["model-prefix"];
    const namePrefix = args["name-prefix"];

    if (!datasetPath || !sourcePath || !modelPrefix || !namePrefix) {
        console.error("seed requires --dataset, --source, --model-prefix, --name-prefix");
        process.exit(1);
    }

    const source = await readJson(sourcePath);
    const entries = presetEntries(source).filter(
        ([_, v]) => v.model === modelPrefix && typeof v.difficulty === "number"
    );

    // Group by difficulty (ascending)
    const byDiff = {};
    for (const [key, preset] of entries) {
        const d = preset.difficulty;
        if (!byDiff[d]) byDiff[d] = [];
        byDiff[d].push({ key, preset });
    }

    const dataset = {};
    const diffs = Object.keys(byDiff).map(Number).sort((a, b) => a - b);
    for (const d of diffs) {
        const group = byDiff[d];
        group.forEach((entry, i) => {
            const newKey = `${namePrefix}-d${d}-${pad2(i + 1)}`;
            const { preset } = entry;
            const cloned = JSON.parse(JSON.stringify(preset));
            cloned.difficulty = d;
            dataset[newKey] = cloned;
            console.log(`  ${entry.key}  →  ${newKey}`);
        });
    }

    await writeJson(datasetPath, dataset);
    console.log(`\nSeeded ${Object.keys(dataset).length} presets into ${datasetPath}`);
    printSummary(dataset);
}

async function cmdMerge(args) {
    const datasetPath = args.dataset;
    const batchPath = args.batch;
    const difficulty = parseInt(args.difficulty);
    const namePrefix = args["name-prefix"];

    if (!datasetPath || !batchPath || isNaN(difficulty) || !namePrefix) {
        console.error("merge requires --dataset, --batch, --difficulty, --name-prefix");
        process.exit(1);
    }

    const existing = await readJson(datasetPath).catch(() => ({}));
    const batch = await readJson(batchPath);
    const batchEntries = presetEntries(batch);

    // Find next available index for this difficulty in the existing dataset
    const prefix = `${namePrefix}-d${difficulty}-`;
    const existingIdxs = Object.keys(existing)
        .filter((k) => k.startsWith(prefix))
        .map((k) => parseInt(k.slice(prefix.length)))
        .filter((n) => !isNaN(n));
    let nextIdx = existingIdxs.length > 0 ? Math.max(...existingIdxs) + 1 : 1;

    let added = 0;
    for (const [oldKey, preset] of batchEntries) {
        const newKey = `${prefix}${pad2(nextIdx++)}`;
        const cloned = JSON.parse(JSON.stringify(preset));
        cloned.difficulty = difficulty;
        // Normalize: strip internal metadata from presetGenerator output
        delete cloned._rotCurve;
        delete cloned._povCurve;
        existing[newKey] = cloned;
        console.log(`  ${oldKey}  →  ${newKey}`);
        added++;
    }

    await writeJson(datasetPath, existing);
    console.log(`\nMerged ${added} d${difficulty} presets into ${datasetPath}`);
    printSummary(existing);
}

async function cmdSummary(args) {
    const datasetPath = args.dataset;
    if (!datasetPath) {
        console.error("summary requires --dataset");
        process.exit(1);
    }
    const dataset = await readJson(datasetPath);
    printSummary(dataset);
}

function printSummary(dataset) {
    const entries = presetEntries(dataset);
    const byDiff = {};
    for (const [key, preset] of entries) {
        const d = preset.difficulty ?? "null";
        byDiff[d] = (byDiff[d] || 0) + 1;
    }
    console.log(`\nTotal: ${entries.length} presets`);
    const diffs = Object.keys(byDiff).sort();
    for (const d of diffs) {
        console.log(`  d${d}: ${byDiff[d]}`);
    }
}

// ── Main ─────────────────────────────────────────────────────────────

const [cmd] = process.argv.slice(2);
const { values: args } = parseArgs({
    options: {
        dataset:        { type: "string" },
        source:         { type: "string" },
        batch:          { type: "string" },
        "model-prefix": { type: "string" },
        "name-prefix":  { type: "string" },
        difficulty:     { type: "string" },
    },
    strict: false,
    allowPositionals: true,
});

switch (cmd) {
    case "seed":    await cmdSeed(args);    break;
    case "merge":   await cmdMerge(args);   break;
    case "summary": await cmdSummary(args); break;
    default:
        console.error("Usage: bun tools/build-dataset.js <seed|merge|summary> [options]");
        console.error("See top-of-file doc comment for examples.");
        process.exit(1);
}
