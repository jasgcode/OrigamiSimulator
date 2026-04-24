#!/usr/bin/env bun
/**
 * Headless preset validator.
 *
 * Loads one or more preset JSON files, groups presets by model, and for each
 * group launches a headless browser, loads the simulator with that model, and
 * runs globals.presetGenerator.validatePreset() against each preset. Prints a
 * pass/fail summary. Exit code 0 on all-pass, 1 on any failure.
 *
 * Requires:
 *   - Dev server running: bun run dev
 *   - Puppeteer installed
 *
 * Usage:
 *   bun tools/validate-presets.js \
 *     --inputs new_dataset/waterbomb-d1.json,new_dataset/boat-d3.json \
 *     [--settle-ms 300] \
 *     [--server-url http://localhost:3000]
 *
 *   # Or use --glob to expand a pattern:
 *   bun tools/validate-presets.js --glob "new_dataset/*.json"
 */

import puppeteer from "puppeteer";
import { parseArgs } from "util";
import { readFileSync, readdirSync } from "fs";
import { join, basename, isAbsolute } from "path";

const ROOT = join(import.meta.dir, "..");

const { values: args } = parseArgs({
    options: {
        inputs:       { type: "string", default: "" },
        glob:         { type: "string", default: "" },
        "settle-ms":  { type: "string", default: "300" },
        "server-url": { type: "string", default: "http://localhost:3000" },
        "max-per-slot": { type: "string", default: "0" },
    },
    strict: false,
});

const SETTLE_MS = parseInt(args["settle-ms"]) || 300;
const SERVER_URL = args["server-url"];
const MAX_PER_SLOT = parseInt(args["max-per-slot"]) || 0;

function expandGlob(pattern) {
    if (!pattern) return [];
    const slashIdx = pattern.lastIndexOf("/");
    const dir = slashIdx >= 0 ? pattern.slice(0, slashIdx) : ".";
    const filePattern = slashIdx >= 0 ? pattern.slice(slashIdx + 1) : pattern;
    const rx = new RegExp("^" + filePattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
    const absDir = isAbsolute(dir) ? dir : join(ROOT, dir);
    try {
        return readdirSync(absDir)
            .filter((f) => rx.test(f))
            .map((f) => join(dir, f));
    } catch (e) {
        return [];
    }
}

const files = [];
if (args.inputs) {
    for (const f of String(args.inputs).split(",").map((s) => s.trim()).filter(Boolean)) {
        files.push(f);
    }
}
if (args.glob) {
    for (const f of expandGlob(args.glob)) {
        files.push(f);
    }
}
if (files.length === 0) {
    console.error("Error: supply --inputs <csv> or --glob <pattern>");
    process.exit(1);
}

// ── Load all presets, group by model ──────────────────────────────
const presetsByModel = new Map();
for (const f of files) {
    const abs = isAbsolute(f) ? f : join(ROOT, f);
    let data;
    try { data = JSON.parse(readFileSync(abs, "utf8")); } catch (e) {
        console.error(`Skip ${f}: parse error — ${e.message}`);
        continue;
    }
    let keys = Object.keys(data).filter((k) => {
        const v = data[k];
        return v && typeof v === "object" && !Array.isArray(v) && v.model && v.steps;
    });
    if (MAX_PER_SLOT > 0) keys = keys.slice(0, MAX_PER_SLOT);
    for (const k of keys) {
        const p = data[k];
        const model = p.model;
        if (!presetsByModel.has(model)) presetsByModel.set(model, []);
        presetsByModel.get(model).push({ sourceFile: basename(f), name: k, preset: p });
    }
}

console.log("Preset Validator (headless)");
console.log("  Files:", files.length);
console.log("  Models:", presetsByModel.size);
console.log("  Total presets:", [...presetsByModel.values()].reduce((a, b) => a + b.length, 0));
console.log("  Settle ms:", SETTLE_MS);
console.log("");

// ── Per-model browser session: load model, validate each preset ───

async function validateModelGroup(modelPath, presets) {
    const browser = await puppeteer.launch({
        headless: "new",
        protocolTimeout: 600000,
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
    const results = [];
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 960 });
        page.on("console", (msg) => {
            const t = msg.text();
            if (t.startsWith("presetGenerator") || t.includes("Error") || t.includes("error")) {
                // Silenced by default — uncomment if needed
                // console.log("[browser]", t);
            }
        });
        const modelParam = modelPath.replace(/^\//, "");
        const url = `${SERVER_URL}/?model=${encodeURIComponent(modelParam)}`;
        console.log(`[${modelPath}] loading ${url}`);
        await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
        await page.waitForFunction(
            () => window.globals && window.globals.model && window.globals.presetGenerator,
            { timeout: 15000 },
        );
        // Mirror bootstrap from tools/generate-presets.js: URL param may not
        // trigger import, so fall back to explicit importDemoFile if no faces.
        const faceCountBefore = await page.evaluate(() => {
            try { return (globals.model.getFaces() || []).length; } catch (e) { return 0; }
        });
        if (faceCountBefore === 0) {
            await page.evaluate((p) => {
                var path = p.replace(/^\//, "");
                globals.importer.importDemoFile(path);
            }, modelPath);
        }
        await page.waitForFunction(
            () => {
                try { return (globals.model.getFaces() || []).length > 0; } catch (e) { return false; }
            },
            { timeout: 45000, polling: 500 },
        );
        await page.waitForFunction(
            () => {
                try {
                    var p = window.globals.benchmark.getPresets();
                    return p && Object.keys(p).length > 0;
                } catch (e) { return false; }
            },
            { timeout: 15000, polling: 500 },
        );
        // Warm-up: cycle the model through a full fold and back so the
        // physics simulation is "trained" before validation. This matches
        // generator state where Phase 2 has been cycling for some time.
        await page.evaluate(() => {
            globals.setCreasePercent(0.5);
            globals.shouldChangeCreasePercent = true;
        });
        await new Promise((r) => setTimeout(r, 1500));
        await page.evaluate(() => {
            globals.setCreasePercent(0);
            globals.shouldChangeCreasePercent = true;
            if (globals.threeView && globals.threeView.resetModel) globals.threeView.resetModel();
        });
        await new Promise((r) => setTimeout(r, 1500));

        for (const { sourceFile, name, preset } of presets) {
            const r = await page.evaluate(
                ({ preset, settleMs }) => {
                    return new Promise((resolve) => {
                        globals.presetGenerator.validatePreset(preset, settleMs, resolve);
                    });
                },
                { preset, settleMs: SETTLE_MS },
            );
            const ok = r && r.valid === true;
            console.log(
                `  [${ok ? "PASS" : "FAIL"}] ${sourceFile}::${name}${ok ? "" : " — failures=" + (r.failures ? r.failures.length : "?")}`,
            );
            if (!ok && r && r.failures && r.failures.length) {
                const show = r.failures.slice(0, 3);
                for (const f of show) {
                    console.log("        ", JSON.stringify(f));
                }
                if (r.failures.length > show.length) console.log(`         … (${r.failures.length - show.length} more)`);
            }
            results.push({ sourceFile, name, valid: ok, failures: r && r.failures ? r.failures.length : null });
        }
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    return results;
}

// ── Main ─────────────────────────────────────────────────────────

let allResults = [];
for (const [model, group] of presetsByModel.entries()) {
    console.log(`\n=== Validating ${group.length} preset(s) for model ${model} ===`);
    const rs = await validateModelGroup(model, group);
    allResults = allResults.concat(rs);
}

const passed = allResults.filter((r) => r.valid).length;
const failed = allResults.filter((r) => !r.valid).length;
console.log("\n────────────────── SUMMARY ──────────────────");
console.log(`  Total: ${allResults.length}`);
console.log(`  Pass:  ${passed}`);
console.log(`  Fail:  ${failed}`);
if (failed > 0) {
    console.log("\n  Failing presets:");
    for (const r of allResults.filter((r) => !r.valid)) {
        console.log(`    - ${r.sourceFile}::${r.name} (failures=${r.failures})`);
    }
}
process.exit(failed > 0 ? 1 : 0);
