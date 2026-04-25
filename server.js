/**
 * Bun dev server for Origami Simulator.
 * Serves static files and provides a /api/screenshot endpoint
 * that saves PNGs to the rendered-output directory.
 *
 * Output dir defaults to ./dataset, overridable with DATASET_DIR=<path>.
 *
 *   bun run dev                              (writes to dataset/)
 *   DATASET_DIR=screenshots bun run dev      (legacy screenshots/ location)
 *   PORT=3001 bun run dev                    (different port)
 */

import { join } from "path";
import { mkdir, readdir, appendFile, writeFile, readFile } from "fs/promises";

const ROOT = import.meta.dir;
const SCREENSHOTS_DIR = join(ROOT, process.env.DATASET_DIR || "dataset");
const SCAN_CACHE_DIR = join(SCREENSHOTS_DIR, ".scan-cache");
const PORT = (() => {
    const n = parseInt(process.env.PORT ?? "", 10);
    return Number.isFinite(n) && n > 0 && n <= 65535 ? n : 3000;
})();

// Ensure screenshots directory exists
await mkdir(SCREENSHOTS_DIR, { recursive: true });
await mkdir(SCAN_CACHE_DIR, { recursive: true });

// MIME types for common static file extensions
const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js":   "application/javascript; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".svg":  "image/svg+xml",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif":  "image/gif",
    ".json": "application/json; charset=utf-8",
    ".fold": "application/json; charset=utf-8",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf":  "font/ttf",
    ".ico":  "image/x-icon",
};

function mime(path) {
    const dot = path.lastIndexOf(".");
    return dot >= 0 ? (MIME[path.slice(dot).toLowerCase()] || "application/octet-stream") : "application/octet-stream";
}

async function listJsonFilesRecursive(baseDir, publicPrefix) {
    const files = [];

    async function walk(absDir, relDir) {
        let entries;
        try {
            entries = await readdir(absDir, { withFileTypes: true });
        } catch (err) {
            if (err && err.code === "ENOENT") return;
            throw err;
        }

        for (const entry of entries) {
            const absPath = join(absDir, entry.name);
            const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                await walk(absPath, relPath);
                continue;
            }
            if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
                files.push(`${publicPrefix}/${relPath}`.replace(/\\/g, "/"));
            }
        }
    }

    await walk(baseDir, "");
    return files;
}

Bun.serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);

        // ── Screenshot save endpoint ──────────────────────────────────────
        if (url.pathname === "/api/screenshot" && req.method === "POST") {
            try {
                const form = await req.formData();
                const file = form.get("file");
                if (!file || !(file instanceof File)) {
                    return new Response("Missing file field", { status: 400 });
                }
                // Optional ?folder= query param — creates nested
                // screenshots/{folder}/ subdirectory. Per-segment sanitiser
                // so paths like "images/<id>" preserve the slash.
                const rawFolder = url.searchParams.get("folder");
                let safeFolder = null;
                if (rawFolder) {
                    safeFolder = rawFolder
                        .split(/[\\/]/)
                        .map(s => s.replace(/[^a-zA-Z0-9_.-]/g, "_"))
                        .filter(s => s && s !== "." && s !== "..")
                        .join("/");
                    if (!safeFolder) safeFolder = null;
                }
                const dir = safeFolder ? join(SCREENSHOTS_DIR, safeFolder) : SCREENSHOTS_DIR;
                await mkdir(dir, { recursive: true });
                const safeName = file.name.replace(/[/\\]/g, "_");
                const dest = join(dir, safeName);
                await Bun.write(dest, file);
                console.log("  saved:", dest);
                return new Response(JSON.stringify({ ok: true, path: dest }), {
                    headers: { "Content-Type": "application/json" },
                });
            } catch (err) {
                console.error("screenshot save error:", err);
                return new Response("Internal error", { status: 500 });
            }
        }

        // ── JSONL append endpoint ────────────────────────────────────────
        // POST /api/jsonl-append with JSON body { path, line, fresh }
        // - path: filename within screenshots/ (e.g. "dataset.jsonl")
        // - line: the JSON-stringified entry (no trailing newline expected)
        // - fresh: when true, truncate the file before writing (start of batch)
        if (url.pathname === "/api/jsonl-append" && req.method === "POST") {
            try {
                const payload = await req.json();
                const rawPath = String(payload.path || "");
                const line = String(payload.line || "");
                const fresh = payload.fresh === true;
                if (!rawPath.endsWith(".jsonl")) {
                    return new Response("path must end with .jsonl", { status: 400 });
                }
                // Sanitise per-segment so we can't escape SCREENSHOTS_DIR.
                const safeRel = rawPath
                    .split(/[\\/]/)
                    .map(s => s.replace(/[^a-zA-Z0-9_.-]/g, "_"))
                    .filter(s => s && s !== "." && s !== "..")
                    .join("/");
                if (!safeRel) {
                    return new Response("invalid path", { status: 400 });
                }
                const filePath = join(SCREENSHOTS_DIR, safeRel);
                await mkdir(SCREENSHOTS_DIR, { recursive: true });
                const data = (line.endsWith("\n") ? line : line + "\n");
                if (fresh) {
                    await writeFile(filePath, data, "utf8");
                } else {
                    await appendFile(filePath, data, "utf8");
                }
                return new Response(JSON.stringify({ ok: true, path: filePath }), {
                    headers: { "Content-Type": "application/json" },
                });
            } catch (err) {
                console.error("jsonl-append error:", err);
                return new Response("Internal error", { status: 500 });
            }
        }

        // ── Metadata merge endpoint ──────────────────────────────────────
        // POST /api/metadata-merge with JSON body { path, key, value }
        // - path: relative path within SCREENSHOTS_DIR (e.g. "metadata/birdBase_metadata.json")
        // - key: top-level key to insert/update (e.g. the preset name)
        // - value: the JSON value to store under that key
        // File is treated as an object { key1: val1, key2: val2, ... }. Reads
        // existing content, merges in the new key/value, writes back. Creates
        // parent dirs and the file if missing.
        if (url.pathname === "/api/metadata-merge" && req.method === "POST") {
            try {
                const payload = await req.json();
                const rawPath = String(payload.path || "");
                const key = String(payload.key || "");
                const value = payload.value;
                if (!rawPath.endsWith(".json")) {
                    return new Response("path must end with .json", { status: 400 });
                }
                if (!key) {
                    return new Response("key required", { status: 400 });
                }
                const safeRel = rawPath
                    .split(/[\\/]/)
                    .map(s => s.replace(/[^a-zA-Z0-9_.-]/g, "_"))
                    .filter(s => s && s !== "." && s !== "..")
                    .join("/");
                if (!safeRel) {
                    return new Response("invalid path", { status: 400 });
                }
                const filePath = join(SCREENSHOTS_DIR, safeRel);
                const fileDir = filePath.substring(0, filePath.lastIndexOf("/"));
                await mkdir(fileDir, { recursive: true });

                let merged = {};
                try {
                    const existing = await readFile(filePath, "utf8");
                    const parsed = JSON.parse(existing);
                    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                        merged = parsed;
                    }
                } catch (_) { /* missing or invalid — start fresh */ }

                merged[key] = value;
                await writeFile(filePath, JSON.stringify(merged, null, 2), "utf8");
                return new Response(JSON.stringify({ ok: true, path: filePath, keys: Object.keys(merged).length }), {
                    headers: { "Content-Type": "application/json" },
                });
            } catch (err) {
                console.error("metadata-merge error:", err);
                return new Response("Internal error", { status: 500 });
            }
        }

        // ── Scan cache endpoint ───────────────────────────────────────────
        // GET /api/scan-cache?key=<cacheKey>
        // POST /api/scan-cache?key=<cacheKey> with JSON body
        if (url.pathname === "/api/scan-cache") {
            try {
                const rawKey = url.searchParams.get("key") || "";
                const safeKey = rawKey.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 120);
                if (!safeKey) {
                    return new Response("Missing cache key", { status: 400 });
                }
                const cachePath = join(SCAN_CACHE_DIR, `${safeKey}.json`);

                if (req.method === "GET") {
                    const file = Bun.file(cachePath);
                    if (!(await file.exists())) {
                        return new Response("Not found", { status: 404 });
                    }
                    return new Response(file, {
                        headers: { "Content-Type": "application/json; charset=utf-8" },
                    });
                }

                if (req.method === "POST") {
                    const payload = await req.json();
                    await Bun.write(cachePath, JSON.stringify(payload));
                    return new Response(JSON.stringify({ ok: true, path: cachePath }), {
                        headers: { "Content-Type": "application/json" },
                    });
                }

                return new Response("Method not allowed", { status: 405 });
            } catch (err) {
                console.error("scan cache error:", err);
                return new Response("Internal error", { status: 500 });
            }
        }

        // ── Face pool cache endpoint ─────────────────────────────────────
        // GET /api/face-pools?key=<modelKey>
        // POST /api/face-pools?key=<modelKey> with JSON body
        // Stores per-model classified face pools (front/back) under
        // assets/facepools/ so the preset generator can avoid hardcoding.
        if (url.pathname === "/api/face-pools") {
            try {
                const rawKey = url.searchParams.get("key") || "";
                const safeKey = rawKey.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 120);
                if (!safeKey) {
                    return new Response("Missing key", { status: 400 });
                }
                const poolsDir = join(ROOT, "assets", "facepools");
                await mkdir(poolsDir, { recursive: true });
                const poolPath = join(poolsDir, `${safeKey}.json`);

                if (req.method === "GET") {
                    const file = Bun.file(poolPath);
                    if (!(await file.exists())) {
                        return new Response("Not found", { status: 404 });
                    }
                    return new Response(file, {
                        headers: { "Content-Type": "application/json; charset=utf-8" },
                    });
                }

                if (req.method === "POST") {
                    const payload = await req.json();
                    await Bun.write(poolPath, JSON.stringify(payload, null, 2));
                    return new Response(JSON.stringify({ ok: true, path: poolPath }), {
                        headers: { "Content-Type": "application/json" },
                    });
                }

                return new Response("Method not allowed", { status: 405 });
            } catch (err) {
                console.error("face-pools error:", err);
                return new Response("Internal error", { status: 500 });
            }
        }

        // ── Save points to a specific preset ─────────────────────────────
        if (url.pathname === "/api/save-preset-points" && req.method === "POST") {
            try {
                const { preset, facePoints } = await req.json();
                if (!preset || !facePoints) {
                    return new Response("Missing preset or facePoints", { status: 400 });
                }
                const benchPath = join(ROOT, "benchmarks.json");
                const existing = await Bun.file(benchPath).json();
                if (!existing[preset]) {
                    return new Response(`Preset "${preset}" not found`, { status: 404 });
                }
                await Bun.write(benchPath + ".bak", JSON.stringify(existing, null, 4));
                existing[preset].facePoints = facePoints;
                await Bun.write(benchPath, JSON.stringify(existing, null, 4));
                console.log(`  saved facePoints to preset "${preset}"`);
                return new Response(JSON.stringify({ ok: true, preset }), {
                    headers: { "Content-Type": "application/json" },
                });
            } catch (err) {
                console.error("save-preset-points error:", err);
                return new Response("Internal error", { status: 500 });
            }
        }

        // ── Save candidates endpoint ─────────────────────────────────────
        if (url.pathname === "/api/save-candidates" && req.method === "POST") {
            try {
                const payload = await req.json();
                const name = payload.name || `candidates_${Date.now()}`;
                const safeName = name.replace(/[/\\]/g, "_");
                const candidatesDir = join(ROOT, "candidates");
                await mkdir(candidatesDir, { recursive: true });
                const dest = join(candidatesDir, `${safeName}.json`);
                await Bun.write(dest, JSON.stringify(payload.presets, null, 4));
                console.log("  saved candidates:", dest);
                return new Response(JSON.stringify({ ok: true, path: dest }), {
                    headers: { "Content-Type": "application/json" },
                });
            } catch (err) {
                console.error("save-candidates error:", err);
                return new Response("Internal error", { status: 500 });
            }
        }

        // ── List candidate benchmark JSON files ─────────────────────────
        if (url.pathname === "/api/candidates" && req.method === "GET") {
            try {
                const candidatesDir = join(ROOT, "candidates");
                await mkdir(candidatesDir, { recursive: true });
                const newDatasetDir = join(ROOT, "new_dataset");
                const [candidateFiles, newDatasetFiles] = await Promise.all([
                    listJsonFilesRecursive(candidatesDir, "candidates"),
                    listJsonFilesRecursive(newDatasetDir, "new_dataset"),
                ]);
                const files = candidateFiles.concat(newDatasetFiles).sort();
                return new Response(JSON.stringify({ files }), {
                    headers: { "Content-Type": "application/json; charset=utf-8" },
                });
            } catch (err) {
                console.error("list candidates error:", err);
                return new Response("Internal error", { status: 500 });
            }
        }

        // ── Save benchmarks endpoint ─────────────────────────────────────
        if (url.pathname === "/api/save-benchmarks" && req.method === "POST") {
            try {
                const newPresets = await req.json();
                const benchPath = join(ROOT, "benchmarks.json");
                const bakPath = join(ROOT, "benchmarks.json.bak");

                // Read existing
                const existing = await Bun.file(benchPath).json();

                // Backup
                await Bun.write(bakPath, JSON.stringify(existing, null, 4));
                console.log("  backed up benchmarks.json → benchmarks.json.bak");

                // Merge new presets into existing
                const keys = Object.keys(newPresets);
                for (const key of keys) {
                    existing[key] = newPresets[key];
                }

                // Write merged
                await Bun.write(benchPath, JSON.stringify(existing, null, 4));
                console.log("  merged " + keys.length + " presets into benchmarks.json");

                return new Response(JSON.stringify({ ok: true, merged: keys.length }), {
                    headers: { "Content-Type": "application/json" },
                });
            } catch (err) {
                console.error("save-benchmarks error:", err);
                return new Response("Internal error", { status: 500 });
            }
        }

        // ── Static file serving ──────────────────────────────────────────
        let pathname = url.pathname === "/" ? "/index.html" : url.pathname;
        // Prevent directory traversal
        const filePath = join(ROOT, pathname);
        if (!filePath.startsWith(ROOT)) {
            return new Response("Forbidden", { status: 403 });
        }

        const file = Bun.file(filePath);
        if (await file.exists()) {
            return new Response(file, {
                headers: { "Content-Type": mime(filePath) },
            });
        }

        return new Response("Not found", { status: 404 });
    },
});

console.log(`Origami Simulator running at http://localhost:${PORT}`);
console.log(`Screenshots will be saved to: ${SCREENSHOTS_DIR}`);
