#!/usr/bin/env bun
/**
 * Headless preset generator for Origami Simulator.
 *
 * Launches headless Chrome via Puppeteer, loads the simulator,
 * and uses the browser-side presetGenerator module to produce
 * validated benchmark presets.
 *
 * Requires:
 *   - Dev server running: bun run dev
 *   - Puppeteer installed: bun add -d puppeteer
 *
 * Usage:
 *   bun tools/generate-presets.js \
 *     --model /Bases/birdBase.svg \
 *     --difficulty 5 \
 *     --count 7 \
 *     --base-name bird-frontback \
 *     --start-index 9 \
 *     --templates "bird-frontback-0*" \
 *     --seed 42 \
 *     --output generated-presets.json \
 *     [--merge <existing-presets.json>] \
 *     [--no-validate] \
 *     [--settle-ms 300] \
 *     [--server-url http://localhost:3000]
 */

import puppeteer from "puppeteer";
import { join } from "path";
import { parseArgs } from "util";

const ROOT = join(import.meta.dir, "..");

// ── Parse CLI arguments ──────────────────────────────────────────────

const { values: args } = parseArgs({
    options: {
        model:         { type: "string", default: "/Bases/birdBase.svg" },
        difficulty:    { type: "string", default: "4" },
        count:         { type: "string", default: "7" },
        "base-name":   { type: "string", default: "bird-frontback" },
        "start-index": { type: "string", default: "9" },
        templates:     { type: "string", default: "bird-frontback-0*" },
        seed:          { type: "string", default: "42" },
        output:        { type: "string", default: "" },
        merge:         { type: "string", default: "" },
        "no-validate": { type: "boolean", default: false },
        "settle-ms":   { type: "string", default: "300" },
        "server-url":  { type: "string", default: "http://localhost:3000" },
        "trajectory-mode": { type: "string", default: "hybrid" },
        "tracking-eval-mode": { type: "string", default: "strictAllSteps" },
        "target-selection-mode": { type: "string", default: "all" },
        "include-initial-visible-tracked-point": { type: "boolean", default: false },
        "initial-visible-tracked-point-count": { type: "string", default: "1" },
        "min-point-separation-px": { type: "string", default: "70" },
        "min-face-quality": { type: "string", default: "0.6" },
        "build-progressions": { type: "string", default: "0" },
        "rotation-profile-count": { type: "string", default: "0" },
        "pov-grid-size": { type: "string", default: "0" },
        "scan-settle-ms": { type: "string", default: "300" },
        "enforce-separation-all-steps": { type: "boolean", default: false },
        "max-scan-candidates": { type: "string", default: "0" },
        "max-trajectory-candidates": { type: "string", default: "0" },
        "phase2-log-every-ms": { type: "string", default: "5000" },
        "phase2-stall-warn-ms": { type: "string", default: "30000" },
        "protocol-timeout-ms": { type: "string", default: "7200000" },
        "heartbeat-ms": { type: "string", default: "15000" },
        "max-attempts": { type: "string", default: "2" },
        "retry-delay-ms": { type: "string", default: "2000" },
        "auto-degrade-on-retry": { type: "boolean", default: true },
        "dumpio": { type: "boolean", default: false },
    },
    strict: false,
});

const MODEL = args.model;
const DIFFICULTY = parseInt(args.difficulty);
const COUNT = parseInt(args.count);
const BASE_NAME = args["base-name"];
const START_INDEX = parseInt(args["start-index"]);
const TEMPLATES = args.templates;
const SEED = parseInt(args.seed);
const OUTPUT = args.output;
const MERGE = args.merge;
const VALIDATE = !args["no-validate"];
const SETTLE_MS = parseInt(args["settle-ms"]);
const SERVER_URL = args["server-url"];
const TRAJECTORY_MODE = args["trajectory-mode"] || "hybrid";
const TRACKING_EVAL_MODE = args["tracking-eval-mode"] || "strictAllSteps";
const TARGET_SELECTION_MODE = args["target-selection-mode"] || "all";
const INCLUDE_INITIAL_VISIBLE_TRACKED_POINT = !!args["include-initial-visible-tracked-point"];
const INITIAL_VISIBLE_TRACKED_POINT_COUNT = parseInt(args["initial-visible-tracked-point-count"]);
const MIN_POINT_SEPARATION_PX = parseFloat(args["min-point-separation-px"]);
const MIN_FACE_QUALITY = parseFloat(args["min-face-quality"]);
const BUILD_PROGRESSIONS = parseInt(args["build-progressions"]);
const ROTATION_PROFILE_COUNT = parseInt(args["rotation-profile-count"]);
const FINAL_FOLD = parseFloat(args["final-fold"]);
const POV_GRID_SIZE = parseInt(args["pov-grid-size"]);
const SCAN_SETTLE_MS = parseInt(args["scan-settle-ms"]);
const ENFORCE_SEPARATION_ALL_STEPS = !!args["enforce-separation-all-steps"];
const MAX_SCAN_CANDIDATES = parseInt(args["max-scan-candidates"]);
const MAX_TRAJECTORY_CANDIDATES = parseInt(args["max-trajectory-candidates"]);
const PHASE2_LOG_EVERY_MS = parseInt(args["phase2-log-every-ms"]);
const PHASE2_STALL_WARN_MS = parseInt(args["phase2-stall-warn-ms"]);
const PROTOCOL_TIMEOUT_MS = parseInt(args["protocol-timeout-ms"]);
const HEARTBEAT_MS = parseInt(args["heartbeat-ms"]);
const MAX_ATTEMPTS = parseInt(args["max-attempts"]);
const RETRY_DELAY_MS = parseInt(args["retry-delay-ms"]);
const AUTO_DEGRADE_ON_RETRY = args["auto-degrade-on-retry"] !== false;
const DUMPIO = !!args.dumpio;

console.log("Preset Generator (headless)");
console.log("  Model:", MODEL);
console.log("  Difficulty:", DIFFICULTY);
console.log("  Count:", COUNT);
console.log("  Base name:", BASE_NAME);
console.log("  Start index:", START_INDEX);
console.log("  Templates:", TEMPLATES);
console.log("  Seed:", SEED);
console.log("  Validate:", VALIDATE);
console.log("  Settle ms:", SETTLE_MS);
console.log("  Trajectory mode:", TRAJECTORY_MODE);
console.log("  Tracking eval mode:", TRACKING_EVAL_MODE);
console.log("  Include initial visible tracked point:", INCLUDE_INITIAL_VISIBLE_TRACKED_POINT);
console.log("  Initial visible tracked point count:", isNaN(INITIAL_VISIBLE_TRACKED_POINT_COUNT) ? 1 : INITIAL_VISIBLE_TRACKED_POINT_COUNT);
console.log("  Max trajectory candidates:", isNaN(MAX_TRAJECTORY_CANDIDATES) || MAX_TRAJECTORY_CANDIDATES <= 0 ? "auto" : MAX_TRAJECTORY_CANDIDATES);
console.log("  Phase2 heartbeat ms:", isNaN(PHASE2_LOG_EVERY_MS) ? 5000 : PHASE2_LOG_EVERY_MS);
console.log("  Phase2 stall warn ms:", isNaN(PHASE2_STALL_WARN_MS) ? 30000 : PHASE2_STALL_WARN_MS);
console.log("  Protocol timeout ms:", isNaN(PROTOCOL_TIMEOUT_MS) ? 7200000 : PROTOCOL_TIMEOUT_MS);
console.log("  Host heartbeat ms:", isNaN(HEARTBEAT_MS) ? 15000 : HEARTBEAT_MS);
console.log("  Max attempts:", isNaN(MAX_ATTEMPTS) ? 2 : MAX_ATTEMPTS);
console.log("  Retry delay ms:", isNaN(RETRY_DELAY_MS) ? 2000 : RETRY_DELAY_MS);
console.log("  Auto-degrade retry:", AUTO_DEGRADE_ON_RETRY);
console.log("  Dumpio:", DUMPIO);
console.log("");

// ── Helpers ───────────────────────────────────────────────────────────

let hostHeartbeat = null;
const hostHeartbeatMs = isNaN(HEARTBEAT_MS) ? 15000 : Math.max(1000, HEARTBEAT_MS);
const hostStartTs = Date.now();
function formatElapsed(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m${String(s).padStart(2, "0")}s`;
}
function startHostHeartbeat(label = "running") {
    if (hostHeartbeat) clearInterval(hostHeartbeat);
    hostHeartbeat = setInterval(() => {
        console.log(`[host] heartbeat: ${label}, elapsed=${formatElapsed(Date.now() - hostStartTs)}`);
    }, hostHeartbeatMs);
}
function stopHostHeartbeat() {
    if (hostHeartbeat) {
        clearInterval(hostHeartbeat);
        hostHeartbeat = null;
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildEvalOptions(attemptIndex) {
    const base = {
        model: MODEL,
        difficulty: DIFFICULTY,
        count: COUNT,
        baseName: BASE_NAME,
        startIndex: START_INDEX,
        templatePattern: TEMPLATES,
        seed: SEED,
        validate: VALIDATE,
        settleMs: SETTLE_MS,
        trajectoryMode: TRAJECTORY_MODE,
        trackingEvalMode: TRACKING_EVAL_MODE,
        targetSelectionMode: TARGET_SELECTION_MODE,
        includeInitialVisibleTrackedPoint: INCLUDE_INITIAL_VISIBLE_TRACKED_POINT,
        initialVisibleTrackedPointCount: isNaN(INITIAL_VISIBLE_TRACKED_POINT_COUNT) ? 1 : INITIAL_VISIBLE_TRACKED_POINT_COUNT,
        minPointSeparationPx: isNaN(MIN_POINT_SEPARATION_PX) ? 70 : MIN_POINT_SEPARATION_PX,
        minFaceQuality: isNaN(MIN_FACE_QUALITY) ? 0.6 : MIN_FACE_QUALITY,
        buildProgressions: isNaN(BUILD_PROGRESSIONS) || BUILD_PROGRESSIONS <= 0 ? undefined : BUILD_PROGRESSIONS,
        rotationProfileCount: isNaN(ROTATION_PROFILE_COUNT) || ROTATION_PROFILE_COUNT <= 0 ? undefined : ROTATION_PROFILE_COUNT,
        finalFold: isNaN(FINAL_FOLD) || FINAL_FOLD <= 0 ? undefined : FINAL_FOLD,
        povGridSize: isNaN(POV_GRID_SIZE) || POV_GRID_SIZE <= 0 ? undefined : POV_GRID_SIZE,
        scanSettleMs: isNaN(SCAN_SETTLE_MS) ? 300 : SCAN_SETTLE_MS,
        enforceSeparationAllSteps: ENFORCE_SEPARATION_ALL_STEPS,
        maxScanCandidates: isNaN(MAX_SCAN_CANDIDATES) || MAX_SCAN_CANDIDATES <= 0 ? undefined : MAX_SCAN_CANDIDATES,
        maxTrajectoryCandidates: isNaN(MAX_TRAJECTORY_CANDIDATES) || MAX_TRAJECTORY_CANDIDATES <= 0 ? undefined : MAX_TRAJECTORY_CANDIDATES,
        phase2LogEveryMs: isNaN(PHASE2_LOG_EVERY_MS) ? 5000 : PHASE2_LOG_EVERY_MS,
        phase2StallWarnMs: isNaN(PHASE2_STALL_WARN_MS) ? 30000 : PHASE2_STALL_WARN_MS,
    };

    if (!AUTO_DEGRADE_ON_RETRY || attemptIndex <= 1) return base;

    // Difficulty-tiered floors. Higher difficulty presets need wider POV grids
    // and more progression candidates to find trajectories with both front and
    // back points visible, so their floors are higher than lower tiers.
    const diff = isNaN(DIFFICULTY) ? 3 : DIFFICULTY;
    // Tiers: d1-d4 only (d5 dropped per user spec).
    const FLOORS = {
        1: { build: 12, grid: 32,  scan: 6,  traj: 20 },
        2: { build: 16, grid: 48,  scan: 8,  traj: 28 },
        3: { build: 20, grid: 64,  scan: 10, traj: 36 },
        4: { build: 28, grid: 80,  scan: 12, traj: 48 },
    };
    const floor = FLOORS[diff] || FLOORS[3];

    const degradeLevel = attemptIndex - 1;
    const currentBuild = base.buildProgressions || 20;
    const currentGrid = base.povGridSize || 80;
    const currentScanCandidates = base.maxScanCandidates || Math.max(COUNT * 3, 12);
    const currentTrajCandidates = base.maxTrajectoryCandidates || Math.max(COUNT * 12, 40);

    const newBuild = Math.floor(currentBuild / Math.pow(2, degradeLevel));
    const newGrid  = Math.floor(currentGrid  / Math.pow(2, degradeLevel));
    const newScan  = Math.floor(currentScanCandidates / Math.pow(2, degradeLevel));
    const newTraj  = Math.floor(currentTrajCandidates / Math.pow(2, degradeLevel));

    const hitFloor = newBuild < floor.build || newGrid < floor.grid ||
                     newScan < floor.scan  || newTraj < floor.traj;

    base.buildProgressions       = Math.max(floor.build, newBuild);
    base.povGridSize             = Math.max(floor.grid,  newGrid);
    base.maxScanCandidates       = Math.max(floor.scan,  newScan);
    base.maxTrajectoryCandidates = Math.max(floor.traj,  newTraj);
    base.phase2LogEveryMs  = Math.min(base.phase2LogEveryMs  || 5000,  3000);
    base.phase2StallWarnMs = Math.min(base.phase2StallWarnMs || 30000, 15000);

    if (hitFloor) {
        console.warn("!!! [host] AUTO-DEGRADE HIT DIFFICULTY FLOOR (d=" + diff + ") !!!");
        console.warn("    Further retries will not reduce quality below this floor.");
        console.warn("    If this attempt also fails, inspect the preset config — the");
        console.warn("    search space is likely infeasible (bad face pool, too-strict");
        console.warn("    separation, or unreachable target visibility).");
    }
    console.log("[host] retry degrade settings (attempt " + attemptIndex + ", d=" + diff + "):", {
        buildProgressions: base.buildProgressions,
        povGridSize: base.povGridSize,
        maxScanCandidates: base.maxScanCandidates,
        maxTrajectoryCandidates: base.maxTrajectoryCandidates,
        floorHit: hitFloor,
    });
    return base;
}

function attachPageLogging(page) {
    page.on("console", (msg) => {
        const text = msg.text();
        if (
            text.includes("presetGenerator:") ||
            text.includes("benchmark: Scan:") ||
            text.includes("benchmark: Phase 2:") ||
            text.includes("benchmark: evaluateTrajectoriesLive:") ||
            text.includes("Generated") ||
            text.includes("Error") ||
            text.includes("error")
        ) {
            console.log("[browser]", text);
        }
    });

    page.on("pageerror", (err) => {
        console.error("[browser error]", err.message);
    });

    page.on("error", (err) => {
        console.error("[page error]", err.message || String(err));
    });
}

async function runSingleAttempt(attemptIndex) {
    const browser = await puppeteer.launch({
        headless: "new",
        protocolTimeout: isNaN(PROTOCOL_TIMEOUT_MS) ? 7200000 : Math.max(120000, PROTOCOL_TIMEOUT_MS),
        dumpio: DUMPIO,
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

    let page = null;
    try {
        page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 960 });
        attachPageLogging(page);

        // Navigate to simulator with the model loaded
        const modelParam = MODEL.replace(/^\//, "");
        const url = `${SERVER_URL}/?model=${encodeURIComponent(modelParam)}`;
        console.log("Loading:", url);
        await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

        // Wait for the app to fully initialize
        console.log("Waiting for model to load...");
        await page.waitForFunction(
            () => window.globals && window.globals.model && window.globals.presetGenerator,
            { timeout: 15000 }
        );
        console.log("Modules initialized, waiting for model geometry...");

        const faceCountBefore = await page.evaluate(() => {
            try { return (globals.model.getFaces() || []).length; } catch(e) { return 0; }
        });
        if (faceCountBefore === 0) {
            console.log("Model not loaded via URL, triggering import...");
            await page.evaluate((modelPath) => {
                var path = modelPath.replace(/^\//, '');
                globals.importer.importDemoFile(path);
            }, MODEL);
        }

        await page.waitForFunction(
            () => {
                try {
                    var f = window.globals.model.getFaces();
                    return f && f.length > 0;
                } catch(e) { return false; }
            },
            { timeout: 45000, polling: 500 }
        );

        const faceCount = await page.evaluate(() => globals.model.getFaces().length);
        console.log("Model loaded. Face count:", faceCount);
        await sleep(2000);

        const evalOpts = buildEvalOptions(attemptIndex);
        console.log("Starting generation...");
        startHostHeartbeat(`attempt ${attemptIndex} generation in progress`);
        const result = await page.evaluate(
            (opts) => {
                return new Promise((resolve) => {
                    globals.presetGenerator.generate(opts, resolve);
                });
            },
            evalOpts
        );
        stopHostHeartbeat();
        return result;
    } finally {
        stopHostHeartbeat();
        try {
            await browser.close();
        } catch (e) {
            console.warn("[host] browser close warning:", e && e.message ? e.message : String(e));
        }
    }
}

const maxAttempts = isNaN(MAX_ATTEMPTS) ? 2 : Math.max(1, MAX_ATTEMPTS);
const retryDelayMs = isNaN(RETRY_DELAY_MS) ? 2000 : Math.max(0, RETRY_DELAY_MS);

let result = null;
let lastError = null;
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
        console.log(`[host] starting attempt ${attempt}/${maxAttempts}`);
        result = await runSingleAttempt(attempt);
        lastError = null;
        console.log(`[host] attempt ${attempt} succeeded`);
        break;
    } catch (err) {
        lastError = err;
        const message = err && err.message ? err.message : String(err);
        console.error(`[host] attempt ${attempt} failed: ${message}`);
        if (attempt < maxAttempts) {
            if (retryDelayMs > 0) {
                console.log(`[host] retrying in ${retryDelayMs}ms...`);
                await sleep(retryDelayMs);
            } else {
                console.log("[host] retrying immediately...");
            }
        }
    }
}

if (!result) {
    const message = lastError && lastError.message ? lastError.message : String(lastError || "Unknown generation failure");
    console.error(`Generation failed after ${maxAttempts} attempt(s): ${message}`);
    process.exit(1);
}

// ── Output ───────────────────────────────────────────────────────────

if (result.error) {
    console.error("Generation failed:", result.error);
    process.exit(1);
}

const generated = result.generated;
const names = Object.keys(generated);
console.log("\nGenerated " + names.length + " presets:");
for (const name of names) {
    const p = generated[name];
    const faceIds = Object.keys(p.facePoints).join(",");
    console.log(`  ${name}: ${p.steps.length} steps, faces=[${faceIds}], ${p.colorMode}`);
}

// Write to output file
if (OUTPUT) {
    const outputPath = OUTPUT.startsWith("/") ? OUTPUT : join(ROOT, OUTPUT);
    await Bun.write(outputPath, JSON.stringify(generated, null, 4));
    console.log("\nWritten to:", outputPath);
}

// Merge into an existing presets JSON
if (MERGE) {
    const mergePath = MERGE.startsWith("/") ? MERGE : join(ROOT, MERGE);
    const existing = await Bun.file(mergePath).json();
    const bakPath = mergePath + ".bak";
    await Bun.write(bakPath, JSON.stringify(existing, null, 4));
    console.log("Backed up:", bakPath);

    for (const key of names) {
        existing[key] = generated[key];
    }
    await Bun.write(mergePath, JSON.stringify(existing, null, 4));
    console.log("Merged " + names.length + " presets into:", mergePath);
}

// If no output specified, print JSON to stdout
if (!OUTPUT && !MERGE) {
    console.log("\n" + JSON.stringify(generated, null, 2));
}

console.log("\nDone!");
