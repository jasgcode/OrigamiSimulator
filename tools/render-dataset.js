#!/usr/bin/env bun
/**
 * Headless screenshot renderer.
 *
 * Loads a dataset JSON in a headless browser and runs every preset through
 * the benchmark pipeline. The server writes <DATASET_DIR>/<id>/step_NNNN_*.png,
 * metadata/<base>_metadata.json and a dataset.jsonl row per preset.
 *
 * Usage:
 *   bun tools/render-dataset.js --dataset datasets/bird-base.json \
 *     [--server-url http://localhost:3000] \
 *     [--skip-existing]
 *
 *   --skip-existing  Skip presets already rendered into DATASET_DIR (default dataset/;
 *                    set it to the server's): matching metadata presetConfig, a
 *                    dataset.jsonl row with the same images, and every image on disk.
 *                    Same rule as render_dataset_parallel.py. Useful for resuming.
 */

import puppeteer from "puppeteer";
import { parseArgs } from "util";
import { join, relative, resolve, isAbsolute } from "path";
import { readdirSync, readFileSync, statSync } from "fs";

const ROOT = join(import.meta.dir, "..");

const { values: args } = parseArgs({
    options: {
        dataset:        { type: "string" },
        "server-url":   { type: "string", default: "http://localhost:3000" },
        "skip-existing": { type: "boolean", default: false },
    },
    strict: false,
});

if (!args.dataset) {
    console.error("Error: --dataset required");
    process.exit(1);
}

const DATASET_PATH = args.dataset;
const SERVER_URL = args["server-url"];
const SKIP_EXISTING = args["skip-existing"];

const datasetAbs = DATASET_PATH.startsWith("/") ? DATASET_PATH : join(ROOT, DATASET_PATH);
const dataset = await Bun.file(datasetAbs).json();
const allNames = Object.keys(dataset).filter((k) => {
    const v = dataset[k];
    return v && typeof v === "object" && !Array.isArray(v) && v.model && v.steps;
});

// Mirrors completed_presets in render_dataset_parallel.py.
function completedPresets(presets, outDir) {
    const rows = new Map();
    let manifest;
    try { manifest = readFileSync(join(outDir, "dataset.jsonl"), "utf8"); } catch { return new Set(); }
    for (const line of manifest.split("\n")) {
        try {
            const row = JSON.parse(line);
            if (typeof row.meta_info.benchmark === "string") rows.set(row.meta_info.benchmark, row);
        } catch {}
    }
    const isImage = (image) => {
        if (typeof image !== "string") return false;
        const path = resolve(outDir, image);
        const rel = relative(outDir, path);
        if (rel.startsWith("..") || isAbsolute(rel)) return false;
        try { const st = statSync(path); return st.isFile() && st.size > 0; } catch { return false; }
    };
    const complete = new Set();
    let metadataFiles = [];
    try { metadataFiles = readdirSync(join(outDir, "metadata")).filter((f) => f.endsWith("_metadata.json")); } catch {}
    for (const file of metadataFiles) {
        let metadata;
        try { metadata = JSON.parse(readFileSync(join(outDir, "metadata", file), "utf8")); } catch { continue; }
        for (const [name, record] of Object.entries(metadata || {})) {
            if (!(name in presets) || !record || typeof record !== "object") continue;
            if (!Bun.deepEquals(record.presetConfig, presets[name])) continue;
            const images = Array.isArray(record.images) ? record.images : [];
            const row = rows.get(name) || {};
            if (!images.length || !Bun.deepEquals(row.images, images)) continue;
            if (images.length < (presets[name].steps || []).length) continue;
            if (images.every(isImage)) complete.add(name);
        }
    }
    return complete;
}

const OUT_DIR = resolve(ROOT, process.env.DATASET_DIR || "dataset");
const done = SKIP_EXISTING ? completedPresets(dataset, OUT_DIR) : new Set();
const names = allNames.filter((n) => !done.has(n));

// If skipping, write a temp dataset containing only the pending presets and
// point runAll at it instead of the full manifest.
let effectivePath = DATASET_PATH;
if (SKIP_EXISTING && names.length < allNames.length) {
    const filtered = {};
    for (const n of names) filtered[n] = dataset[n];
    // Write beside the dataset file; the page fetches it relative to the server root.
    const pendingAbs = datasetAbs.replace(/\.json$/, ".pending.json");
    effectivePath = relative(ROOT, pendingAbs);
    await Bun.write(
        pendingAbs,
        JSON.stringify(filtered, null, 4) + "\n"
    );
    console.log(`Wrote filtered manifest: ${effectivePath}`);
}

console.log(`Dataset: ${DATASET_PATH}`);
console.log(`Total presets: ${allNames.length}`);
console.log(`To render:     ${names.length}${SKIP_EXISTING ? ` (skip-existing on, checked ${OUT_DIR})` : ""}`);

if (names.length === 0) {
    console.log("Nothing to render.");
    process.exit(0);
}

// Long protocolTimeout — 100 presets at ~15-25s each is 30+ minutes
const browser = await puppeteer.launch({
    headless: "new",
    protocolTimeout: 4 * 60 * 60 * 1000,  // 4 hours
    args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--enable-webgl",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--window-size=1280,960",
    ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 960 });

page.on("console", (msg) => {
    const text = msg.text();
    if (
        text.includes("benchmark:") ||
        text.includes("Run-all") ||
        text.includes("saved screenshots/") ||
        text.toLowerCase().includes("error")
    ) {
        console.log("[browser]", text);
    }
});

page.on("pageerror", (err) => {
    console.error("[browser error]", err.message);
});

// Use an arbitrary first preset to bootstrap model loading
const firstName = names[0];
const firstModel = dataset[firstName].model.replace(/^\//, "");
const bootUrl = `${SERVER_URL}/?model=${encodeURIComponent(firstModel)}&benchmarks=${encodeURIComponent(DATASET_PATH)}`;
console.log("Loading:", bootUrl);
await page.goto(bootUrl, { waitUntil: "networkidle2", timeout: 30000 });

console.log("Waiting for globals + benchmark module...");
await page.waitForFunction(
    () => window.globals && window.globals.benchmark && window.globals.model,
    { timeout: 15000 }
);

// Trigger model import if not already loaded
const faceCountBefore = await page.evaluate(() => {
    try { return (globals.model.getFaces() || []).length; } catch (e) { return 0; }
});
if (faceCountBefore === 0) {
    console.log("Importing model...");
    await page.evaluate((m) => globals.importer.importDemoFile(m.replace(/^\//, "")), dataset[firstName].model);
}

await page.waitForFunction(
    () => {
        try {
            const f = window.globals.model.getFaces();
            return f && f.length > 0;
        } catch (e) { return false; }
    },
    { timeout: 45000, polling: 500 }
);
console.log("Model loaded. Starting render...");

await new Promise((r) => setTimeout(r, 1500));

// Drive runAll in the browser. Re-rendering is idempotent at the file-system
// level (PNGs and metadata.json get overwritten), so a re-run with
// --skip-existing is handled purely in Node by filtering the dataset file
// in-memory and passing the filtered set as a temporary manifest.
const result = await page.evaluate(
    (jsonPath) => {
        return new Promise((resolve) => {
            globals.benchmark.runAll(jsonPath, function () {
                resolve({ ok: true });
            });
        });
    },
    effectivePath
);

console.log("runAll returned:", result);

await new Promise((r) => setTimeout(r, 2000));
await browser.close();
console.log("Done.");
