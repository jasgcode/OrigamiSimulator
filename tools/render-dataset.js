#!/usr/bin/env bun
/**
 * Headless screenshot renderer.
 *
 * Loads a dataset JSON in a headless browser and runs every preset through
 * the benchmark pipeline, writing step PNGs + metadata.json + summary.json
 * into screenshots/<preset-name>/ via the existing /api/screenshot endpoint.
 *
 * Usage:
 *   bun tools/render-dataset.js --dataset datasets/bird-base.json \
 *     [--server-url http://localhost:3000] \
 *     [--skip-existing]
 *
 *   --skip-existing  Skip presets whose screenshots/<name>/metadata.json already exists.
 *                    Useful for resuming an interrupted run.
 */

import puppeteer from "puppeteer";
import { parseArgs } from "util";
import { join } from "path";
import { existsSync } from "fs";

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

const names = SKIP_EXISTING
    ? allNames.filter((n) => !existsSync(join(ROOT, "screenshots", n, "metadata.json")))
    : allNames;

// If skipping, write a temp dataset containing only the pending presets and
// point runAll at it instead of the full manifest.
let effectivePath = DATASET_PATH;
if (SKIP_EXISTING && names.length < allNames.length) {
    const filtered = {};
    for (const n of names) filtered[n] = dataset[n];
    effectivePath = DATASET_PATH.replace(/\.json$/, ".pending.json");
    await Bun.write(
        join(ROOT, effectivePath),
        JSON.stringify(filtered, null, 4) + "\n"
    );
    console.log(`Wrote filtered manifest: ${effectivePath}`);
}

console.log(`Dataset: ${DATASET_PATH}`);
console.log(`Total presets: ${allNames.length}`);
console.log(`To render:     ${names.length}${SKIP_EXISTING ? " (skip-existing on)" : ""}`);

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
