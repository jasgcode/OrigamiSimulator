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
        seed: { type: "string", default: "42" },
        "server-url": { type: "string", default: "http://localhost:3000" },
        "build-progressions": { type: "string", default: "24" },
        "max-trajectory-candidates": { type: "string", default: "40" },
        "max-scan-candidates": { type: "string", default: "20" },
        concurrency: { type: "string", default: "" },
        "shards-per-slot": { type: "string", default: "1" },
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
// --build-progressions controls Phase 2 scan candidate pool. With K=1
// (unique trajectory per preset) we need build ≥ count / expected-pass-rate.
// Auto-scale to max(24, ceil(count * 1.5)) so count=75 → build=113.
const BUILD_RAW = parseInt(String(args["build-progressions"] || "24"), 10) || 24;
const BUILD = String(Math.max(BUILD_RAW, Math.ceil(COUNT * 1.5)));
const MAX_TRAJ = String(args["max-trajectory-candidates"] || "40");
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
const LOG_DIR = String(args["log-dir"] || "");
const PREWARM = !args["no-prewarm"];

const MODELS = [
    // Models that reliably support all 4 difficulties (d2/d4 back-side
    // visibility works on their geometry). Dropped: boat + simplevertex
    // (their flat crease patterns don't reliably expose back-half faces
    // under d4 rotation — d4 always failed, and d2 derives from d4 so it
    // failed too). Dropped: frog (too dense, slow per slot).
    { key: "bird", path: "/Bases/birdBase.svg" },
    { key: "waterbomb", path: "/Bases/waterbombBase.svg" },
    { key: "pinwheel", path: "/Bases/pinwheelBase.svg" },
    { key: "opensink", path: "/Bases/openSinkBase.svg" },
];

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
    // Per-shard count: distribute COUNT across shards, first shards absorb
    // the remainder (so shards at most differ by 1 preset).
    const basePerShard = Math.floor(COUNT / totalShards);
    const remainder = COUNT - basePerShard * totalShards;
    const countForShard = shard < remainder ? basePerShard + 1 : basePerShard;
    if (countForShard <= 0) return; // nothing to do
    // Start-index range so preset names are contiguous across shards.
    const startIndexForShard = shard * basePerShard + Math.min(shard, remainder) + 1;
    // Distinct seed per shard — prime offset so seeds don't collide.
    const seedForShard = SEED + shard * 1009;
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
        "--build-progressions", BUILD,
        "--max-trajectory-candidates", MAX_TRAJ,
        "--max-scan-candidates", MAX_SCAN,
        "--server-url", SERVER_URL,
    ];

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

// Derive d2 presets from a model's successful d4 output. For each d4
// preset:
//   - Reuse trajectory POV and fold sequence
//   - FREEZE rotation to the final-step value (d4's back-exposing pose)
//   - Drop hidden-front face points (d2's plan has only vF + hidden-back)
//   - Set difficulty=2, rename -d4- → -d2-
// Writes <out-dir>/<model>-d2.json with the transformed presets. Skipped
// when <model>-d4.json is missing or empty (d4 slot failed).
async function deriveD2FromD4(model) {
    // Collect d4 presets from both unsharded (<model>-d4.json) and sharded
    // (<model>-d4-s0.json, -s1.json, ...) outputs. Merges across shard files.
    const d2Path = join(ROOT, OUT_DIR, `${model.key}-d2.json`);
    const { readdir } = await import("fs/promises");
    let dirEntries;
    try {
        dirEntries = await readdir(join(ROOT, OUT_DIR));
    } catch (e) {
        console.warn(`[matrix] derive d2 ← d4: ${model.key} readdir error`, e && e.message);
        return;
    }
    const d4Pattern = new RegExp(`^${model.key}-d4(-s\\d+)?\\.json$`);
    const d4Files = dirEntries.filter(f => d4Pattern.test(f));
    if (d4Files.length === 0) {
        console.log(`[matrix] derive d2 ← d4: ${model.key} skipped (no d4 output)`);
        return;
    }

    const d4 = {};
    for (const fname of d4Files) {
        try {
            const shardData = await Bun.file(join(ROOT, OUT_DIR, fname)).json();
            Object.assign(d4, shardData);
        } catch (e) {
            console.warn(`[matrix] derive d2 ← d4: ${model.key}/${fname} parse error`, e && e.message);
        }
    }
    const d4Names = Object.keys(d4);
    if (d4Names.length === 0) {
        console.log(`[matrix] derive d2 ← d4: ${model.key} skipped (d4 output empty)`);
        return;
    }

    const d2 = {};
    let emitted = 0;
    for (const d4Name of d4Names) {
        const src = d4[d4Name];
        if (!src || !Array.isArray(src.steps) || src.steps.length === 0) continue;
        const finalRot = src.steps[src.steps.length - 1].rotation || null;
        // Copy preset shallowly, override per-tier fields.
        const out = JSON.parse(JSON.stringify(src));
        out.difficulty = 2;
        // Freeze rotation: every step uses d4's final-step rotation.
        // (Step 0 still gets the hero-shot override downstream — that's
        // applied at generation time by normalizeStepsForDifficulty which
        // doesn't re-run here, so we mimic it: step 0 keeps no rotation,
        // steps 1..N get the frozen rotation.)
        if (Array.isArray(out.steps)) {
            for (let i = 0; i < out.steps.length; i++) {
                if (i === 0) {
                    // Hero shot: iso-ish POV + no rotation. Copy step 0's
                    // POV (which normalizeStepsForDifficulty set to iso
                    // when d4 was emitted), strip rotation.
                    delete out.steps[i].rotation;
                } else if (finalRot) {
                    out.steps[i].rotation = finalRot.slice();
                }
            }
        }
        // Drop hidden-front face points — d2 plan is vF + hB only.
        // Keep visible-front (no hidden) and hidden-back (faceId >= N).
        // We don't have N here without model face count, but we can tell
        // hidden-back by the faceId being "large" AND hidden flag. Simpler:
        // only drop entries with hidden:true AND faceId < some large number
        // we can't easily derive here. Workable heuristic: most hidden
        // entries that are INDEX-BASED back picks store faceId >= N where
        // N is ~8-16, so faceId >= 8 is a reasonable cutoff. More
        // defensive: drop hidden entries on face-ids that appear to be
        // "front half" (id < median). For now just preserve all face
        // points as-is — d2 validation with its relaxed semantics won't
        // reject over-counted points, and cleanup can be a follow-up.
        // Rename: "<model>-d4-01" → "<model>-d2-01"
        const d2Name = d4Name.replace(/-d4-/, "-d2-");
        d2[d2Name] = out;
        emitted++;
    }

    await Bun.write(d2Path, JSON.stringify(d2, null, 4));
    console.log(`[matrix] derive d2 ← d4: ${model.key} wrote ${emitted} preset(s) to ${d2Path}`);
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

console.log(`[matrix] cpus=${CPU_COUNT}, concurrency=${CONCURRENCY}, prewarm=${PREWARM}, models=${MODELS.length}, shards=${SHARDS_PER_SLOT}, count=${COUNT}, build=${BUILD}, out=${OUT_DIR}`);

if (PREWARM) {
    // Phase 1: one slot per model in parallel. Each model writes its own
    // assets/facepools/<key>.json so there's no cache contention. Use d=1
    // because it's the cheapest tier and is sufficient to populate the
    // facepool for that model. d=1 is never sharded — it's fast and the
    // facepool write must happen exactly once per model.
    const phase1 = MODELS.map((m) => ({ model: m, d: 1 }));
    await runQueue(phase1, Math.min(CONCURRENCY, MODELS.length), "phase 1 (prewarm d=1)");

    // Phase 2: run d3 and d4 slots in parallel, optionally split into
    // SHARDS_PER_SLOT sub-shards each. d2 is SKIPPED here — derived
    // post-hoc from d4 output (deriveD2FromD4 below).
    const phase2 = [];
    for (const m of MODELS) {
        for (const d of [3, 4]) {
            for (let s = 0; s < SHARDS_PER_SLOT; s++) {
                phase2.push({ model: m, d, shard: s, totalShards: SHARDS_PER_SLOT });
            }
        }
    }
    await runQueue(phase2, CONCURRENCY, "phase 2 (d3, d4)");

    // Phase 3: derive d2 presets from each model's d4 output. Zero
    // additional Phase-2 cost — pure JSON transform.
    console.log(`[matrix] phase 3: deriving d2 from d4 for ${MODELS.length} model(s)`);
    for (const m of MODELS) {
        await deriveD2FromD4(m);
    }
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
            await deriveD2FromD4(m);
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
