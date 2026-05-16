#!/usr/bin/env bun
/**
 * Run tools/generate-presets.js for each (model, difficulty) slot.
 *
 * Default: 3 models × difficulties 1–5 × --count presets per slot.
 * Requires: bun run dev (localhost:3000)
 *
 *   bun tools/generate-matrix.js --out-dir new_dataset/matrix-gen-0423
 *   bun tools/generate-matrix.js --out-dir new_dataset/matrix-gen-0423 --concurrency 12
 *
 * Tiers: d1-d4 (d5 dropped per user spec).
 *
 * Parallelism model:
 *   Phase 1 (pre-warm): for each model, run d=1 in parallel. Each model
 *     writes its own assets/facepools/<key>.json so there's no cache
 *     contention.
 *   Phase 2 (fan-out): run all remaining (model, d∈{2..5}) slots in
 *     parallel up to --concurrency. Cache is warm so no model-group
 *     serialization is needed.
 *
 * --no-prewarm falls back to the simpler "model groups in parallel,
 * difficulties within a model serial" design (caps at modelCount slots
 * concurrent regardless of --concurrency).
 */

import { mkdir, open } from "fs/promises";
import { cpus } from "os";
import { join } from "path";
import { parseArgs } from "util";

const ROOT = join(import.meta.dir, "..");

const { values: args } = parseArgs({
    options: {
        "out-dir": { type: "string", default: "new_dataset/matrix-gen" },
        count: { type: "string", default: "2" },
        seed: { type: "string", default: "12345" },
        "server-url": { type: "string", default: "http://localhost:3000" },
        "build-progressions": { type: "string", default: "24" },
        "max-trajectory-candidates": { type: "string", default: "40" },
        "pov-grid-size": { type: "string", default: "" },
        "max-scan-candidates": { type: "string", default: "20" },
        concurrency: { type: "string", default: "" },
        "shards-per-slot": { type: "string", default: "1" },
        "models": { type: "string", default: "" },
        "log-dir": { type: "string", default: "" },
        "no-prewarm": { type: "boolean", default: false },
    },
    strict: false,
});

// Default concurrency: (CPU_COUNT - 4), capped at 28. Leaves 4 threads for
// OS + dev server + renderer. SwiftShader-backed Chrome is CPU-bound (~1
// core per Puppeteer instance under load) so this maps ~1:1 to worker
// slots. High cap lets sub-sharded workloads saturate a 32-thread box.
const CPU_COUNT = cpus().length || 4;
const DEFAULT_CONCURRENCY = Math.min(28, Math.max(2, CPU_COUNT - 4));

const OUT_DIR = String(args["out-dir"] || "new_dataset/matrix-gen");
const COUNT = parseInt(String(args.count || "2"), 10) || 2;
const SEED = parseInt(String(args.seed || "42"), 10) || 42;
const SERVER_URL = String(args["server-url"] || "http://localhost:3000");
// Brute-force defaults: bumped for the eval-cache-driven continuation
// orchestrator. Bigger trajectory pool → more chances of accepting back-
// exposing trajectories for hard d4 cells. Phase 2 evaluation cache makes
// continuation passes cheap (already-evaluated trajectories don't re-run).
const BUILD_RAW = parseInt(String(args["build-progressions"] || "150"), 10) || 150;
const MAX_TRAJ = String(args["max-trajectory-candidates"] || "600");
const POV_GRID_SIZE = String(args["pov-grid-size"] || "");  // empty = use slot-config default (110 for d4)
const MAX_SCAN = String(args["max-scan-candidates"] || "20");
const CONCURRENCY_RAW = String(args.concurrency || "").trim();
const CONCURRENCY = CONCURRENCY_RAW
    ? Math.max(1, parseInt(CONCURRENCY_RAW, 10) || DEFAULT_CONCURRENCY)
    : DEFAULT_CONCURRENCY;
// Sub-sharding: split a (model, tier) slot into S sub-shards. Each shard
// is a separate generate-presets.js process with its own seed + start-index
// range, so trajectories across shards stay distinct (probabilistically).
// The worker pool naturally work-steals across slots: when a shard finishes,
// its worker picks up the next item in the queue, regardless of origin.
// Pass --shards-per-slot 3 at CLI to enable.
const SHARDS_PER_SLOT = Math.max(1, parseInt(String(args["shards-per-slot"] || "1"), 10) || 1);
// --models filter: comma-separated keys (e.g. "boat" or "boat,bird") to
// run only a subset of MODELS. Useful for top-up runs without re-doing
// already-generated models. Empty/unset = all models.
const MODELS_FILTER = String(args["models"] || "").trim();
const LOG_DIR = String(args["log-dir"] || "");
const PREWARM = !args["no-prewarm"];

const ALL_MODELS = [
    // 8-model matrix. The four previously-dropped models (boat, square,
    // mapfold, simplevertex) are back in — frog stays out (too dense).
    // Known d4-yield caveats from prior runs (may want per-model count
    // overrides on the `counts` map below if they undershoot target):
    //   boat:         2 back faces — thin hidden-back pool
    //   square:       8-face collapse around fold=65–70
    //   mapfold:      flat sheet; anchor drops out under d3/d4 rotation
    //   simplevertex: single-vertex pattern; low geometric diversity
    //
    // Per-(model,difficulty) count override via `counts` map. Used for
    // pinwheel-d4 where smoke showed ~60% yield — oversample to land
    // the uniform target.
    { key: "simplevertex", path: "/SimpleFolds/simpleVertex.svg" },
    { key: "bird",         path: "/Bases/birdBase.svg" },
    { key: "waterbomb",    path: "/Bases/waterbombBase.svg" },
    { key: "pinwheel",     path: "/Bases/pinwheelBase.svg", counts: { 4: 70 } },
    { key: "boat",         path: "/Bases/boatBase.svg" },
    { key: "mapfold",      path: "/SimpleFolds/mapfold.svg" },
    { key: "opensink",     path: "/Bases/openSinkBase.svg" },
    { key: "square",       path: "/Bases/squareBase.svg" },
];

const MODELS = MODELS_FILTER
    ? (() => {
        const wanted = new Set(MODELS_FILTER.split(",").map((s) => s.trim()).filter(Boolean));
        const filtered = ALL_MODELS.filter((m) => wanted.has(m.key));
        if (filtered.length === 0) {
            console.error(`[matrix] --models filter "${MODELS_FILTER}" matched zero models. Valid keys: ${ALL_MODELS.map((m) => m.key).join(", ")}`);
            process.exit(1);
        }
        return filtered;
    })()
    : ALL_MODELS;

await mkdir(join(ROOT, OUT_DIR), { recursive: true });
if (LOG_DIR) await mkdir(join(ROOT, LOG_DIR), { recursive: true });

const failures = [];
const startedAt = Date.now();

function fmtElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

// Stream a child's stdout/stderr line-by-line with a [tag] prefix so
// output from parallel slots stays readable. Optionally also tee to a
// per-slot log file when --log-dir is set.
async function pipeWithPrefix(stream, tag, sink, fileHandle) {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = buf.indexOf("\n")) !== -1) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                sink(`[${tag}] ${line}`);
                if (fileHandle) await fileHandle.write(line + "\n");
            }
        }
        if (buf.length > 0) {
            sink(`[${tag}] ${buf}`);
            if (fileHandle) await fileHandle.write(buf + "\n");
        }
    } catch (err) {
        sink(`[${tag}] (stream error: ${err && err.message ? err.message : String(err)})`);
    }
}

async function runSlot(model, difficulty, shard = 0, totalShards = 1) {
    const isSharded = totalShards > 1;
    // Per-(model,difficulty) count override via model.counts map. Falls back
    // to the global --count for cells without an override.
    const slotCount = (model.counts && model.counts[difficulty] != null)
        ? model.counts[difficulty]
        : COUNT;
    // Per-shard count: distribute slotCount across shards, first shards
    // absorb the remainder (so shards at most differ by 1 preset).
    const basePerShard = Math.floor(slotCount / totalShards);
    const remainder = slotCount - basePerShard * totalShards;
    const countForShard = shard < remainder ? basePerShard + 1 : basePerShard;
    if (countForShard <= 0) return; // nothing to do
    // Start-index range so preset names are contiguous across shards.
    const startIndexForShard = shard * basePerShard + Math.min(shard, remainder) + 1;
    // Distinct seed per shard — prime offset so seeds don't collide.
    const seedForShard = SEED + shard * 1009;
    // --build-progressions: scan candidate pool must be big enough that
    // count-for-shard passing trajectories are likely. With K=1 (unique
    // trajectory per preset), need build ≥ count / expected-pass-rate.
    // Scale per-shard count (not total COUNT) so sharding doesn't
    // over-provision validation work.
    const buildForShard = String(Math.max(BUILD_RAW, Math.ceil(countForShard * 1.5)));
    // Output file names: unsharded → bird-d3.json; sharded → bird-d3-s0.json.
    // base-name keeps the non-sharded form so preset ids remain consistent.
    const base = `${model.key}-d${difficulty}`;
    const fileStem = isSharded ? `${base}-s${shard}` : base;
    const outPath = join(ROOT, OUT_DIR, `${fileStem}.json`);
    const tag = isSharded ? `${base}/${shard + 1}-of-${totalShards}` : base;
    const genScript = join(ROOT, "tools/generate-presets.js");
    const procArgs = [
        genScript,
        "--model", model.path,
        "--difficulty", String(difficulty),
        "--count", String(countForShard),
        "--base-name", base,
        "--start-index", String(startIndexForShard),
        "--templates", "no-match-pattern-*",
        "--seed", String(seedForShard),
        "--output", outPath,
        "--trajectory-mode", "hybrid",
        "--build-progressions", buildForShard,
        "--max-trajectory-candidates", MAX_TRAJ,
        "--max-scan-candidates", MAX_SCAN,
        "--server-url", SERVER_URL,
    ];
    if (POV_GRID_SIZE) {
        procArgs.push("--pov-grid-size", POV_GRID_SIZE);
    }
    if (model.finalFold != null) {
        procArgs.push("--final-fold", String(model.finalFold));
    }

    const slotStarted = Date.now();
    console.log(`[matrix] start ${tag} (elapsed ${fmtElapsed(Date.now() - startedAt)})`);

    let logFile = null;
    if (LOG_DIR) {
        const logPath = join(ROOT, LOG_DIR, `${fileStem}.log`);
        logFile = await open(logPath, "w");
    }

    const proc = Bun.spawn(["bun", ...procArgs], {
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
    });

    const stdoutPipe = pipeWithPrefix(proc.stdout, tag, (line) => console.log(line), logFile);
    const stderrPipe = pipeWithPrefix(proc.stderr, tag, (line) => console.error(line), logFile);
    await Promise.all([stdoutPipe, stderrPipe]);
    const exitCode = await proc.exited;
    if (logFile) await logFile.close();

    const slotDur = fmtElapsed(Date.now() - slotStarted);
    if (exitCode !== 0) {
        failures.push({ base: fileStem, exitCode });
        console.error(`[matrix] FAILED ${tag} (exit ${exitCode}, took ${slotDur})`);
    } else {
        console.log(`[matrix] done  ${tag} (took ${slotDur})`);
    }
}

// Worker pool over a flat slot queue. Each task is a {model, d, shard?,
// totalShards?} item; workers pull from `queue` until empty, capped at
// `limit`. Natural work-stealing: an idle worker grabs the next queue item
// regardless of origin slot, so sub-shards from different (model, tier)
// slots get interleaved if some finish faster than others.
async function runQueue(queue, limit, label) {
    let cursor = 0;
    async function worker() {
        while (true) {
            const i = cursor++;
            if (i >= queue.length) return;
            const { model, d, shard = 0, totalShards = 1 } = queue[i];
            await runSlot(model, d, shard, totalShards);
        }
    }
    const workerCount = Math.min(limit, queue.length);
    if (workerCount === 0) return;
    console.log(`[matrix] ${label}: ${queue.length} slot(s), ${workerCount} concurrent`);
    const workers = [];
    for (let i = 0; i < workerCount; i++) workers.push(worker());
    await Promise.all(workers);
}

console.log(`[matrix] cpus=${CPU_COUNT}, concurrency=${CONCURRENCY}, prewarm=${PREWARM}, models=${MODELS.length}, shards=${SHARDS_PER_SLOT}, count=${COUNT} (per-shard ${Math.ceil(COUNT/SHARDS_PER_SLOT)}), build-floor=${BUILD_RAW}, out=${OUT_DIR}`);

if (PREWARM) {
    // Phase 1: one slot per model in parallel. Each model writes its own
    // assets/facepools/<key>.json so there's no cache contention. Use d=1
    // because it's the cheapest tier and is sufficient to populate the
    // facepool for that model. d=1 is never sharded — it's fast and the
    // facepool write must happen exactly once per model.
    const phase1 = MODELS.map((m) => ({ model: m, d: 1 }));
    await runQueue(phase1, Math.min(CONCURRENCY, MODELS.length), "phase 1 (prewarm d=1)");

    // Phase 2: run d3 and d4 slots in parallel, optionally split into
    // SHARDS_PER_SLOT sub-shards each.
    const phase2 = [];
    for (const m of MODELS) {
        for (const d of [3, 4]) {
            for (let s = 0; s < SHARDS_PER_SLOT; s++) {
                phase2.push({ model: m, d, shard: s, totalShards: SHARDS_PER_SLOT });
            }
        }
    }
    await runQueue(phase2, CONCURRENCY, "phase 2 (d3, d4)");
} else {
    // Legacy: model groups in parallel, difficulties within a model
    // serial. Caps at modelCount slots concurrent regardless of
    // --concurrency; safe for cold caches without a pre-warm.
    let cursor = 0;
    async function modelGroupWorker() {
        while (true) {
            const i = cursor++;
            if (i >= MODELS.length) return;
            const m = MODELS[i];
            await runSlot(m, 1);
            await runSlot(m, 3);
            await runSlot(m, 4);
        }
    }
    const limit = Math.min(CONCURRENCY, MODELS.length);
    console.log(`[matrix] legacy mode: ${MODELS.length} model groups, ${limit} concurrent`);
    const workers = [];
    for (let i = 0; i < limit; i++) workers.push(modelGroupWorker());
    await Promise.all(workers);
}

console.log(`[matrix] total elapsed ${fmtElapsed(Date.now() - startedAt)}`);

if (failures.length) {
    console.error("\n[matrix] Completed with failures:", failures);
    process.exit(1);
}

console.log("\n[matrix] All slots succeeded.\n");
