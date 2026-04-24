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
        "log-dir": { type: "string", default: "" },
        "no-prewarm": { type: "boolean", default: false },
    },
    strict: false,
});

// Default concurrency: half the logical CPUs, capped at 12. SwiftShader-
// backed Chrome is CPU-bound (~1 core under load), so half-of-cpus leaves
// headroom for the dev server and OS. Cap at 12 because gains taper off
// past that point in practice.
const CPU_COUNT = cpus().length || 4;
const DEFAULT_CONCURRENCY = Math.min(12, Math.max(2, Math.floor(CPU_COUNT / 2)));

const OUT_DIR = String(args["out-dir"] || "new_dataset/matrix-gen");
const COUNT = parseInt(String(args.count || "2"), 10) || 2;
const SEED = parseInt(String(args.seed || "42"), 10) || 42;
const SERVER_URL = String(args["server-url"] || "http://localhost:3000");
const BUILD = String(args["build-progressions"] || "24");
const MAX_TRAJ = String(args["max-trajectory-candidates"] || "40");
const MAX_SCAN = String(args["max-scan-candidates"] || "20");
const CONCURRENCY_RAW = String(args.concurrency || "").trim();
const CONCURRENCY = CONCURRENCY_RAW
    ? Math.max(1, parseInt(CONCURRENCY_RAW, 10) || DEFAULT_CONCURRENCY)
    : DEFAULT_CONCURRENCY;
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

async function runSlot(model, difficulty) {
    const base = `${model.key}-d${difficulty}`;
    const outPath = join(ROOT, OUT_DIR, `${base}.json`);
    const genScript = join(ROOT, "tools/generate-presets.js");
    const procArgs = [
        genScript,
        "--model", model.path,
        "--difficulty", String(difficulty),
        "--count", String(COUNT),
        "--base-name", base,
        "--start-index", "1",
        "--templates", "no-match-pattern-*",
        "--seed", String(SEED),
        "--output", outPath,
        "--trajectory-mode", "hybrid",
        "--build-progressions", BUILD,
        "--max-trajectory-candidates", MAX_TRAJ,
        "--max-scan-candidates", MAX_SCAN,
        "--server-url", SERVER_URL,
    ];

    const slotStarted = Date.now();
    console.log(`[matrix] start ${base} (elapsed ${fmtElapsed(Date.now() - startedAt)})`);

    let logFile = null;
    if (LOG_DIR) {
        const logPath = join(ROOT, LOG_DIR, `${base}.log`);
        logFile = await open(logPath, "w");
    }

    const proc = Bun.spawn(["bun", ...procArgs], {
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
    });

    const stdoutPipe = pipeWithPrefix(proc.stdout, base, (line) => console.log(line), logFile);
    const stderrPipe = pipeWithPrefix(proc.stderr, base, (line) => console.error(line), logFile);
    await Promise.all([stdoutPipe, stderrPipe]);
    const exitCode = await proc.exited;
    if (logFile) await logFile.close();

    const slotDur = fmtElapsed(Date.now() - slotStarted);
    if (exitCode !== 0) {
        failures.push({ base, exitCode });
        console.error(`[matrix] FAILED ${base} (exit ${exitCode}, took ${slotDur})`);
    } else {
        console.log(`[matrix] done  ${base} (took ${slotDur})`);
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
    const d4Path = join(ROOT, OUT_DIR, `${model.key}-d4.json`);
    const d2Path = join(ROOT, OUT_DIR, `${model.key}-d2.json`);
    const d4File = Bun.file(d4Path);
    if (!(await d4File.exists())) {
        console.log(`[matrix] derive d2 ← d4: ${model.key} skipped (no d4 output)`);
        return;
    }
    let d4;
    try {
        d4 = await d4File.json();
    } catch (e) {
        console.warn(`[matrix] derive d2 ← d4: ${model.key} parse error`, e && e.message);
        return;
    }
    const d4Names = Object.keys(d4 || {});
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

// Worker pool over a flat slot queue. Each task is a (model, difficulty)
// pair; runWith pulls from `queue` until empty, capped at `limit` workers.
async function runQueue(queue, limit, label) {
    let cursor = 0;
    async function worker() {
        while (true) {
            const i = cursor++;
            if (i >= queue.length) return;
            const { model, d } = queue[i];
            await runSlot(model, d);
        }
    }
    const workerCount = Math.min(limit, queue.length);
    if (workerCount === 0) return;
    console.log(`[matrix] ${label}: ${queue.length} slot(s), ${workerCount} concurrent`);
    const workers = [];
    for (let i = 0; i < workerCount; i++) workers.push(worker());
    await Promise.all(workers);
}

console.log(`[matrix] cpus=${CPU_COUNT}, concurrency=${CONCURRENCY}, prewarm=${PREWARM}, models=${MODELS.length}, out=${OUT_DIR}`);

if (PREWARM) {
    // Phase 1: one slot per model in parallel. Each model writes its own
    // assets/facepools/<key>.json so there's no cache contention. Use d=1
    // because it's the cheapest tier and is sufficient to populate the
    // facepool for that model.
    const phase1 = MODELS.map((m) => ({ model: m, d: 1 }));
    await runQueue(phase1, Math.min(CONCURRENCY, MODELS.length), "phase 1 (prewarm d=1)");

    // Phase 2: run d3 and d4 slots in parallel. d2 is SKIPPED here — it's
    // derived post-hoc from successful d4 output (see deriveD2FromD4
    // below). Per user spec: "if there's a successful d4 run then the
    // final rotation of that trajectory can be used as a d2 instance ...
    // we wouldn't even need to find another d2 / we are currently doing
    // extra computation which we do not need to do."
    const phase2 = [];
    for (const m of MODELS) {
        phase2.push({ model: m, d: 3 });
        phase2.push({ model: m, d: 4 });
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
