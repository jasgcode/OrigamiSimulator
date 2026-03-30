/**
 * Bun dev server for Origami Simulator.
 * Serves static files and provides a /api/screenshot endpoint
 * that saves PNGs to the local screenshots/ directory.
 *
 *   bun run dev   (or: bun server.js)
 */

import { join } from "path";
import { mkdir } from "fs/promises";

const ROOT = import.meta.dir;
const SCREENSHOTS_DIR = join(ROOT, "screenshots");
const PORT = 3000;

// Ensure screenshots directory exists
await mkdir(SCREENSHOTS_DIR, { recursive: true });

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
                // Optional ?folder= query param — creates screenshots/{folder}/ subdirectory
                const rawFolder = url.searchParams.get("folder");
                const safeFolder = rawFolder ? rawFolder.replace(/[/\\]/g, "_") : null;
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
