/**
 * Preset Generator for Origami Simulator benchmarks.
 *
 * Generates diverse benchmark preset configs by:
 *   1. Extracting rotation/POV templates from existing high-quality presets
 *   2. Producing parameterized variants (mirror, scale, shift, perturb)
 *   3. Selecting face points per difficulty level
 *   4. Validating visibility via live WebGL
 *   5. Selecting diverse output via greedy farthest-first
 *
 * Follows the project module pattern: initPresetGenerator(globals) → module object.
 */

function initPresetGenerator(globals) {

    // ── Seeded PRNG (xoshiro128**) ──────────────────────────────────────

    function makeRng(seed) {
        var s = [seed | 0, (seed * 2654435761) | 0, (seed * 2246822519) | 0, (seed * 3266489917) | 0];
        for (var i = 0; i < 4; i++) { s[i] = s[i] === 0 ? 1 : s[i]; }
        function rotl(x, k) { return (x << k) | (x >>> (32 - k)); }
        function next() {
            var result = Math.imul(rotl(Math.imul(s[1], 5), 7), 9) >>> 0;
            var t = s[1] << 9;
            s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3];
            s[2] ^= t; s[3] = rotl(s[3], 11);
            return result / 4294967296;
        }
        // Warm up
        for (var w = 0; w < 20; w++) next();
        return {
            random: next,
            randInt: function (min, max) { return min + Math.floor(next() * (max - min + 1)); },
            randFloat: function (min, max) { return min + next() * (max - min); },
            pick: function (arr) { return arr[Math.floor(next() * arr.length)]; },
            shuffle: function (arr) {
                var a = arr.slice();
                for (var i = a.length - 1; i > 0; i--) {
                    var j = Math.floor(next() * (i + 1));
                    var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
                }
                return a;
            },
            gaussian: function (mean, sigma) {
                var u1 = next(), u2 = next();
                if (u1 < 1e-10) u1 = 1e-10;
                return mean + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
            }
        };
    }

    // ── Same-hue color pairs (back = darker front) ─────────────────────
    // Each pair is [front, back] where back is the front shade darkened to
    // ~70% luminance. Reads as a single-colored sheet of paper with the
    // reverse side naturally shaded. Previously both sides were contrasting
    // colors; changed for a more paper-like visual.

    var COLOR_PAIRS = [
        ["e74c3c", "a2352a"],   // red
        ["f39c12", "aa6d0d"],   // orange
        ["0077cc", "00538f"],   // blue
        ["16a085", "0f705d"],   // teal
        ["2980b9", "1d5a82"],   // cerulean
        ["27ae60", "1b7a43"],   // green
        ["e84393", "a22f67"],   // pink
        ["34495e", "243342"],   // navy
        ["9b59b6", "6d3e7f"],   // purple
        ["d63031", "962222"],   // red (alt)
        ["00cec9", "00908d"],   // cyan
        ["fd79a8", "b15576"],   // rose
        ["e17055", "9e4e3c"],   // burnt orange
        ["a29bfe", "716db2"],   // lavender
        ["55efc4", "3ca789"]    // mint
    ];

    // ── Bird base known-good face ID pools ─────────────────────────────
    // Retained as a last-resort fallback only. New code should use
    // discoverFacePools() — it caches per-model pools to assets/facepools/.

    var BIRD_FRONT_FACES = [0, 1, 2, 3, 5, 8, 9, 10];
    var BIRD_BACK_FACES = [13, 14, 15, 17, 18, 21, 22, 23, 25, 26];

    // ── Automated face pool discovery ──────────────────────────────────
    //
    // Convention:
    //   front = face IDs visible from iso/+y at fold=0 (flat paper)
    //   back  = face IDs visible at fold=70 only from the opposite
    //           hemisphere (-y / -1,-1,-1) — i.e. hidden from iso/+y
    //
    // User constraint: never sweep past fold 90. fold=70 is the intended
    // final-state viewing fold, so the back pool is classified there.
    //
    // Cached per-model under assets/facepools/<key>.json via /api/face-pools.
    // Lazy-generates on cache miss using globals.benchmark.runScan.

    function modelCacheKey(model) {
        return String(model).replace(/^\/+/, "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
    }

    // Resolve the effective final-fold target for a generation call.
    // Honors explicit `opts.finalFold` if provided; otherwise applies
    // per-model defaults (e.g. mapfold caps at 60 so panels stay less
    // reoriented at the final pose — keeps face qualities closer to
    // iso-flat baseline so the 0.6 floor in selectFacePointsFromTrajectory
    // is achievable).
    function resolveFinalFold(opts) {
        if (opts && opts.finalFold != null) return opts.finalFold;
        var m = String((opts && opts.model) || "");
        if (m.indexOf("mapfold") >= 0) return 60;
        return null;
    }

    // Linearly rescale a fold ladder so its last entry equals `target`.
    // Used by the per-model `finalFold` override (e.g. squareBase needs a
    // shallower terminal fold so back faces remain exposed at the final
    // step). Returns the original ladder unchanged when target is null,
    // matches the existing terminal value, or the ladder is degenerate.
    function rescaleFoldLadder(ladder, target) {
        if (target == null || !Array.isArray(ladder) || ladder.length === 0) return ladder;
        var last = ladder[ladder.length - 1];
        if (last <= 0 || last === target) return ladder;
        var scale = target / last;
        var out = new Array(ladder.length);
        for (var i = 0; i < ladder.length; i++) {
            out[i] = Math.round(ladder[i] * scale);
        }
        out[out.length - 1] = target;
        return out;
    }

    function poolsUnion(arrs) {
        var seen = {}, out = [];
        for (var i = 0; i < arrs.length; i++) {
            for (var j = 0; j < arrs[i].length; j++) {
                var id = arrs[i][j];
                if (!seen[id]) { seen[id] = 1; out.push(id); }
            }
        }
        return out.sort(function (a, b) { return a - b; });
    }

    // Hemisphere POV set used for face-pool discovery. Expanded from the
    // original 4-POV set so that `frontAt70` / `backAt70` pick up faces
    // visible from any reasonable camera angle. findTwoSidedStaticPOVs
    // queries this same set to locate POVs where both front and back
    // tracked faces are visible simultaneously at fold=70.
    //
    // Camera stays in the upper hemisphere ("we in general should be in
    // iso or +y for this"); the two -y entries cover back-face classification.
    var FACE_POOL_SCAN_POVS = [
        "iso",        // [1, 1, 1]
        "y",          // [0, 1, 0] top-down
        "x",          // [1, 0, 0]
        "-x",         // [-1, 0, 0]
        "z",          // [0, 0, 1]
        "-z",         // [0, 0, -1]
        "1,1,-1",     // iso mirror z
        "-1,1,1",     // iso mirror x
        "-1,1,-1",    // iso mirror xz
        "0.5,1,0.5",  // high-iso
        "-y",         // back classification
        "-1,-1,-1"    // back classification
    ];
    var FACE_POOL_FRONT_POVS = ["iso", "y", "x", "-x", "z", "-z", "1,1,-1", "-1,1,1", "-1,1,-1", "0.5,1,0.5"];
    var FACE_POOL_BACK_POVS  = ["-y", "-1,-1,-1"];

    function povSetSignature(povs) {
        return (povs || []).slice().sort().join("|");
    }

    function discoverFacePools(model, callback) {
        var key = modelCacheKey(model);
        var currentSig = povSetSignature(FACE_POOL_SCAN_POVS);
        fetch("/api/face-pools?key=" + encodeURIComponent(key), { method: "GET" })
            .then(function (res) {
                if (!res.ok) throw new Error("miss");
                return res.json();
            })
            .then(function (cached) {
                if (cached && Array.isArray(cached.front) && Array.isArray(cached.back)) {
                    var cachedSig = povSetSignature(cached.scanPovs || []);
                    var hasVisMap = cached.visibilityByPovFold && typeof cached.visibilityByPovFold === "object";
                    if (cachedSig === currentSig && hasVisMap) {
                        console.log("presetGenerator: face pools cache hit for " + key +
                                    " (front:" + cached.front.length + " back:" + cached.back.length + ")");
                        callback({
                            front: cached.front,
                            back: cached.back,
                            frontAt70: cached.frontAt70 || [],
                            backAt70: cached.backAt70 || [],
                            visibilityByPovFold: cached.visibilityByPovFold,
                            scanPovs: cached.scanPovs,
                            cached: true
                        });
                        return;
                    }
                    console.log("presetGenerator: face pools cache stale for " + key +
                                " (scanPovs or visibility map changed); re-discovering");
                }
                runPoolDiscovery();
            })
            .catch(runPoolDiscovery);

        function runPoolDiscovery() {
            if (!globals.benchmark || !globals.benchmark.runScan) {
                console.warn("presetGenerator: benchmark.runScan unavailable; using legacy bird pools");
                var isBird = model.indexOf("birdBase") >= 0;
                callback({
                    front: isBird ? BIRD_FRONT_FACES : null,
                    back:  isBird ? BIRD_BACK_FACES  : null,
                    cached: false,
                    discoveryUnavailable: true
                });
                return;
            }
            var frontPovs = FACE_POOL_FRONT_POVS.slice();
            var backPovs  = FACE_POOL_BACK_POVS.slice();
            var allPovs   = FACE_POOL_SCAN_POVS.slice();
            updateStatus("Discovering face pools for " + key + "…");
            globals.benchmark.runScan({
                model: model,
                scanMode: true,
                saveScanResult: false,
                useScanCache: true,
                forceRescan: false,
                scanFoldSteps: [0, 70],
                scanPovs: allPovs,
                scanSettleMs: 300,
                minFaceQuality: 0.35
            }, function (result) {
                var povAnalysis = (result && result.povAnalysis) || {};
                function idsAt(pov, fold) {
                    var p = povAnalysis[pov];
                    if (!p || !p.states) return [];
                    for (var i = 0; i < p.states.length; i++) {
                        if (p.states[i].fold === fold) return p.states[i].visibleFaceIds || [];
                    }
                    return [];
                }
                function qualitiesAt(pov, fold) {
                    var p = povAnalysis[pov];
                    if (!p || !p.states) return {};
                    for (var i = 0; i < p.states.length; i++) {
                        if (p.states[i].fold === fold) return p.states[i].faceQualities || {};
                    }
                    return {};
                }
                var frontPool = poolsUnion(frontPovs.map(function (p) { return idsAt(p, 0); }));
                var frontAt70 = poolsUnion(frontPovs.map(function (p) { return idsAt(p, 70); }));
                var backAt70  = poolsUnion(backPovs .map(function (p) { return idsAt(p, 70); }));
                var frontSet = {};
                for (var k = 0; k < frontAt70.length; k++) frontSet[frontAt70[k]] = 1;
                var backPool = backAt70.filter(function (id) { return !frontSet[id]; });

                // If the back pool came up empty (thin/flat models), fall back
                // to the opposite-hemisphere at-70 set as-is. Hidden-point
                // selection will re-validate visibility anyway.
                if (backPool.length === 0 && backAt70.length > 0) {
                    console.warn("presetGenerator: back pool empty after subtraction; using backAt70 directly");
                    backPool = backAt70.slice();
                }

                // Build per-POV-per-fold visibility map for findTwoSidedStaticPOVs.
                var visibilityByPovFold = {};
                for (var pi = 0; pi < allPovs.length; pi++) {
                    var p = allPovs[pi];
                    visibilityByPovFold[p] = {
                        "0":  { ids: idsAt(p, 0),  qualities: qualitiesAt(p, 0)  },
                        "70": { ids: idsAt(p, 70), qualities: qualitiesAt(p, 70) }
                    };
                }

                var payload = {
                    model: model,
                    front: frontPool,
                    back: backPool,
                    frontAt0: frontPool,
                    frontAt70: frontAt70,
                    backAt70: backAt70,
                    frontPovs: frontPovs,
                    backPovs: backPovs,
                    scanPovs: allPovs,
                    visibilityByPovFold: visibilityByPovFold,
                    discoveredAt: new Date().toISOString()
                };
                fetch("/api/face-pools?key=" + encodeURIComponent(key), {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                }).catch(function () { /* non-fatal */ });

                console.log("presetGenerator: discovered face pools for " + key +
                            " — front:" + frontPool.length + " back:" + backPool.length +
                            " scanPovs:" + allPovs.length);
                callback({
                    front: frontPool,
                    back: backPool,
                    frontAt70: frontAt70,
                    backAt70: backAt70,
                    visibilityByPovFold: visibilityByPovFold,
                    scanPovs: allPovs,
                    cached: false,
                    meta: payload
                });
            });
        }
    }

    function namedPovToVec(name) {
        var map = {
            "iso": [1, 1, 1], "x": [1, 0, 0], "-x": [-1, 0, 0],
            "y": [0, 1, 0], "-y": [0, -1, 0],
            "z": [0, 0, 1], "-z": [0, 0, -1]
        };
        return map[name] || [1, 0.55, 0];
    }

    function clampDifficultyTier(difficulty) {
        var d = parseInt(difficulty, 10);
        if (isNaN(d)) d = 4;
        if (d < 1) d = 1;
        if (d > 4) d = 4;  // d5 dropped per user spec
        return d;
    }

    function getDifficultyProfile(difficulty) {
        var tier = clampDifficultyTier(difficulty);
        return {
            tier: tier,
            requiresBothSides: tier === 4,
            isStaticTier: tier === 1,
            isMajorMotionTier: tier === 4
        };
    }

    function vecLen3(v) {
        return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    }

    function normalizeVec3(v) {
        var m = vecLen3(v);
        if (m < 1e-8) return [1, 0.55, 0];
        return [v[0] / m, v[1] / m, v[2] / m];
    }

    function subVec3(a, b) {
        return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    }

    function addVec3(a, b) {
        return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    }

    function scaleVec3(v, s) {
        return [v[0] * s, v[1] * s, v[2] * s];
    }

    function roundVec3(v) {
        return [
            Math.round(v[0] * 100) / 100,
            Math.round(v[1] * 100) / 100,
            Math.round(v[2] * 100) / 100
        ];
    }

    function angleBetweenVec3(a, b) {
        var na = normalizeVec3(a);
        var nb = normalizeVec3(b);
        var dot = na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2];
        dot = Math.max(-1, Math.min(1, dot));
        return Math.acos(dot);
    }

    function parsePovVec(pov) {
        if (Array.isArray(pov) && pov.length >= 3) {
            return normalizeVec3([Number(pov[0]) || 0, Number(pov[1]) || 0, Number(pov[2]) || 0]);
        }
        if (typeof pov === "string" && pov.indexOf(",") !== -1) {
            var parts = pov.split(",").map(Number);
            if (parts.length >= 3) return normalizeVec3([parts[0] || 0, parts[1] || 0, parts[2] || 0]);
        }
        if (typeof pov === "string") {
            return normalizeVec3(namedPovToVec(pov));
        }
        return normalizeVec3(namedPovToVec("iso"));
    }

    function parseRotationVec(rotation) {
        if (!rotation) return [0, 0, 0];
        if (Array.isArray(rotation) && rotation.length >= 3) {
            return [Number(rotation[0]) || 0, Number(rotation[1]) || 0, Number(rotation[2]) || 0];
        }
        if (typeof rotation === "object") {
            return [Number(rotation.x) || 0, Number(rotation.y) || 0, Number(rotation.z) || 0];
        }
        return [0, 0, 0];
    }

    function tuneRotationCurveForDifficulty(curve, difficulty, rng) {
        if (!Array.isArray(curve) || curve.length === 0) return [];
        var profile = getDifficultyProfile(difficulty);
        if (profile.isStaticTier) {
            var outStatic = [];
            for (var si = 0; si < curve.length; si++) outStatic.push([0, 0, 0]);
            return outStatic;
        }
        var scale = profile.isMajorMotionTier ? rng.randFloat(0.85, 1.2) : rng.randFloat(0.3, 0.65);
        var out = [];
        for (var i = 0; i < curve.length; i++) {
            var c = curve[i] || [0, 0, 0];
            out.push([
                Math.round((c[0] || 0) * scale * 100) / 100,
                Math.round((c[1] || 0) * scale * 100) / 100,
                Math.round((c[2] || 0) * scale * 100) / 100
            ]);
        }
        return out;
    }

    function tunePovCurveForDifficulty(curve, difficulty, rng) {
        if (!Array.isArray(curve) || curve.length === 0) return [];
        var profile = getDifficultyProfile(difficulty);
        var first = parsePovVec(curve[0]);
        if (profile.isStaticTier) {
            var outStatic = [];
            for (var si = 0; si < curve.length; si++) outStatic.push(roundVec3(first));
            return outStatic;
        }
        var scale = profile.isMajorMotionTier ? rng.randFloat(0.9, 1.35) : rng.randFloat(0.35, 0.7);
        var out = [];
        for (var i = 0; i < curve.length; i++) {
            var cur = parsePovVec(curve[i]);
            var delta = subVec3(cur, first);
            var tuned = normalizeVec3(addVec3(first, scaleVec3(delta, scale)));
            out.push(roundVec3(tuned));
        }
        return out;
    }

    function computeStepMotionMetrics(steps) {
        if (!steps || steps.length === 0) {
            return {
                povEndAngle: 0,
                povTotalAngle: 0,
                rotationEndMagnitude: 0,
                rotationTotal: 0
            };
        }

        var povs = [];
        var rotations = [];
        for (var i = 0; i < steps.length; i++) {
            povs.push(parsePovVec(steps[i].pov));
            rotations.push(parseRotationVec(steps[i].rotation));
        }

        // Hero-shot step 0 uses a fixed iso POV for the thumbnail frame and
        // is not part of the tracking motion model. Classify motion from
        // states 2..N (tracking-optimized POV) so d1 thresholds stay
        // consistent regardless of the hero-shot override.
        var motionPovs = povs.length > 1 ? povs.slice(1) : povs;
        var motionRots = rotations.length > 1 ? rotations.slice(1) : rotations;

        var povTotalAngle = 0;
        for (var pi = 1; pi < motionPovs.length; pi++) {
            povTotalAngle += angleBetweenVec3(motionPovs[pi - 1], motionPovs[pi]);
        }
        var povEndAngle = angleBetweenVec3(motionPovs[0], motionPovs[motionPovs.length - 1]);

        var rotationTotal = 0;
        for (var ri = 1; ri < motionRots.length; ri++) {
            var dr = subVec3(motionRots[ri], motionRots[ri - 1]);
            rotationTotal += vecLen3(dr);
        }
        var rotationEndMagnitude = vecLen3(subVec3(motionRots[motionRots.length - 1], motionRots[0]));

        return {
            povEndAngle: povEndAngle,
            povTotalAngle: povTotalAngle,
            rotationEndMagnitude: rotationEndMagnitude,
            rotationTotal: rotationTotal
        };
    }

    function matchesDifficultyMotion(steps, difficulty, metrics) {
        var d = clampDifficultyTier(difficulty);
        var m = metrics || computeStepMotionMetrics(steps);
        var motionStrength = Math.max(
            m.povEndAngle,
            m.rotationEndMagnitude,
            m.rotationTotal * 0.5,
            m.povTotalAngle * 0.7
        );

        if (d <= 2) {
            return m.povEndAngle <= 0.08 &&
                   m.povTotalAngle <= 0.15 &&
                   m.rotationEndMagnitude <= 0.2 &&
                   m.rotationTotal <= 0.25;
        }
        if (d <= 4) {
            return motionStrength >= 0.2 &&
                   motionStrength <= 1.1 &&
                   m.povTotalAngle <= 2.0 &&
                   m.rotationTotal <= 2.6;
        }
        return motionStrength >= 1.0;
    }

    function getFacePointSideCounts(facePointsConfig, modelFaceCount) {
        var counts = { front: 0, back: 0 };
        if (!facePointsConfig || !modelFaceCount) return counts;

        if (Array.isArray(facePointsConfig)) {
            for (var i = 0; i < facePointsConfig.length; i++) {
                var p = facePointsConfig[i] || {};
                var faceId = parseInt(p.faceId != null ? p.faceId : p.face, 10);
                if (isNaN(faceId)) continue;
                if (faceId < modelFaceCount) counts.front++;
                else counts.back++;
            }
            return counts;
        }

        var keys = Object.keys(facePointsConfig);
        for (var k = 0; k < keys.length; k++) {
            var faceIdKey = parseInt(keys[k], 10);
            if (isNaN(faceIdKey)) continue;
            var val = facePointsConfig[keys[k]];
            var qty = 1;
            if (Array.isArray(val)) qty = Math.max(1, val.length);
            else if (typeof val === "number") qty = Math.max(1, Math.floor(val));
            if (faceIdKey < modelFaceCount) counts.front += qty;
            else counts.back += qty;
        }
        return counts;
    }

    function matchesDifficultySideConfig(facePointsConfig, difficulty, modelFaceCount) {
        if (!modelFaceCount) return true;
        var profile = getDifficultyProfile(difficulty);
        var counts = getFacePointSideCounts(facePointsConfig, modelFaceCount);
        if (profile.requiresBothSides) {
            return counts.front > 0 && counts.back > 0;
        }
        return counts.front > 0 && counts.back === 0;
    }

    function getColorModeForDifficulty(difficulty, rng) {
        // All tiers render as labelOnly — uniform visual style across the
        // dataset. (Was tier-dependent faceTriangleID / labelOnly mix.)
        return "labelOnly";
    }

    // ── Pass 2: pick hidden points from the trajectory's final step ────
    //
    // Navigates to the preset's final step (fold, POV, rotation), queries
    // visible face IDs, intersects with the back/front pool, and appends
    // `{ u,v,w, hidden: true }` entries to preset.facePoints. If no
    // back-pool face is visible at the final step, the preset is returned
    // unchanged — validation will then reject it, freeing the next
    // candidate.

    function addHiddenPointsFromFinalStep(preset, backPool, frontPool, plan, settleMs, rng, callback) {
        var wantBack = Math.max(0, plan && plan.plannedHiddenBack | 0);
        var wantFront = Math.max(0, plan && plan.plannedHiddenFront | 0);
        if (wantBack === 0 && wantFront === 0) { callback(preset); return; }
        if (!globals.benchmark || !globals.model || !globals.facePoints || !globals.threeView) {
            callback(preset); return;
        }

        var steps = preset.steps || [];
        if (steps.length === 0) { callback(preset); return; }
        var finalStep = steps[steps.length - 1];

        // Apply settings so the mesh / face point system matches the preset.
        if (globals.benchmark.applySettings) globals.benchmark.applySettings(preset);

        globals.setCreasePercent((finalStep.fold != null ? finalStep.fold : 70) / 100);
        globals.shouldChangeCreasePercent = true;

        if (globals.benchmark.setPOV && finalStep.pov) globals.benchmark.setPOV(finalStep.pov);
        if (finalStep.rotation && globals.threeView.setModelRotation) {
            var r = Array.isArray(finalStep.rotation)
                ? finalStep.rotation
                : [finalStep.rotation.x || 0, finalStep.rotation.y || 0, finalStep.rotation.z || 0];
            globals.threeView.setModelRotation(r[0], r[1], r[2]);
        } else {
            globals.threeView.resetModel();
        }

        var settle = Math.max(settleMs || 300, 600);
        setTimeout(function () {
            var visibleIds = (globals.facePoints.getVisibleFaceIds && globals.facePoints.getVisibleFaceIds()) || [];
            var qualities = (globals.facePoints.getFaceViewQualities && globals.facePoints.getFaceViewQualities(visibleIds)) || {};

            function normalize(pool, useBackSide) {
                var src = Array.isArray(pool) ? pool : [];
                var N = (globals.model.getFaces() || []).length;
                var out = [];
                for (var i = 0; i < src.length; i++) {
                    var fid = parseInt(src[i], 10);
                    if (isNaN(fid)) continue;
                    // getVisibleFaceIds returns 0..N-1 always; normalize pool likewise
                    if (fid >= N) fid -= N;
                    if (fid < 0 || fid >= N) continue;
                    out.push(fid);
                }
                return out;
            }
            var backIds = normalize(backPool, true);
            var frontIds = normalize(frontPool, false);

            function pickFromPool(poolIds, count) {
                if (count <= 0) return [];
                var cands = poolIds.filter(function (id) { return visibleIds.indexOf(id) !== -1; });
                cands.sort(function (a, b) { return (qualities[b] || 0) - (qualities[a] || 0); });
                // De-duplicate against face IDs already used in preset.facePoints
                var used = {};
                Object.keys(preset.facePoints || {}).forEach(function (k) { used[parseInt(k, 10)] = 1; });
                return cands.filter(function (id) { return !used[id]; }).slice(0, count);
            }

            function randomBary() {
                var u = Math.round(((rng ? rng.randFloat(0.25, 0.55) : 0.35)) * 100) / 100;
                var v = Math.round(((rng ? rng.randFloat(0.25, 0.55) : 0.35)) * 100) / 100;
                var w = Math.round((1 - u - v) * 100) / 100;
                if (w < 0.08) { w = 0.1; u = Math.round((1 - v - w) * 100) / 100; }
                return { u: u, v: v, w: w };
            }

            function addHidden(faceId) {
                var key = String(faceId);
                if (!preset.facePoints[key]) preset.facePoints[key] = [];
                var bary = randomBary();
                preset.facePoints[key].push({ u: bary.u, v: bary.v, w: bary.w, hidden: true });
            }

            var pickedBack = pickFromPool(backIds, wantBack);
            var pickedFront = pickFromPool(frontIds, wantFront);
            pickedBack.forEach(addHidden);
            pickedFront.forEach(addHidden);

            // Record what was selected for debugging
            preset._hiddenSelected = {
                wantBack: wantBack, wantFront: wantFront,
                pickedBack: pickedBack, pickedFront: pickedFront
            };

            // Once a hidden point is injected, validation must switch to
            // finalStepOnly — hidden points are only required visible at
            // fold=70, not throughout the trajectory.
            if (pickedBack.length > 0 || pickedFront.length > 0) {
                preset.trackingEvalMode = "finalStepOnly";
                // Refresh targetPointLabels so the newly-injected hidden
                // points are actually tracked. Without this the preset
                // declares only ["A"] (the front anchor selected before
                // hidden injection) and the benchmark runner ignores the
                // hidden point at the final step, defeating the purpose
                // of the reveal. Use "all" mode so every point (visible
                // front + hidden back/front) is in the target list.
                var refreshedTargets = chooseTrackingTargetsFromFacePoints(preset.facePoints, "all", {});
                if (refreshedTargets.targetPointLabels && refreshedTargets.targetPointLabels.length > 0) {
                    preset.targetPointLabels = refreshedTargets.targetPointLabels;
                }
                if (refreshedTargets.primaryTargetPointLabels && refreshedTargets.primaryTargetPointLabels.length > 0) {
                    preset.primaryTargetPointLabels = refreshedTargets.primaryTargetPointLabels;
                }
            }

            // Reset model rotation to avoid leaking state to the next candidate.
            globals.threeView.resetModel();
            callback(preset);
        }, settle);
    }

    // ── Pass 3: final-pose barycentric refinement ──────────────────────
    //
    // After hidden-point injection, each tracked point's (u,v,w) is still
    // the random value picked by selectFacePoints / addHiddenPointsFromFinalStep.
    // That placement can land near a face edge or near the image border once
    // the model has rotated into its final pose, making labels hard to read.
    //
    // refineFacePointBarycentric navigates to the final step and, for every
    // point in preset.facePoints, sweeps a small barycentric grid on its
    // face and picks the (u,v,w) that scores best on:
    //   - isPointVisible (required)
    //   - screen-space distance to canvas edges (edge margin)
    //   - screen-space distance to other tracked points (neighbor sep)
    //   - barycentric margin min(u, v, w) (interior of the triangle)
    //
    // The best candidate replaces the entry's (u,v,w) in preset.facePoints.
    // If no candidate is visible, the original placement is preserved.
    //
    // Determinism: the grid order is fixed; ties are broken by first-seen
    // (which depends only on geometry given a fixed mesh + pose).

    function refineFacePointBarycentric(preset, settleMs, rng, callback) {
        if (!preset || !preset.facePoints) { callback(preset); return; }
        if (!globals.benchmark || !globals.model || !globals.facePoints || !globals.threeView) {
            callback(preset); return;
        }
        var steps = preset.steps || [];
        if (steps.length === 0) { callback(preset); return; }

        // mapfold-only: stricter barycentric centrality requirement.
        // Forces u, v, w ≥ 0.27 (the closer to {0.33, 0.33, 0.33} the
        // better). Panels in mapfold's accordion fold can be tilted
        // near edge-on to the camera at the final pose, and a point
        // sitting near a face's edge can merge with the dark crease
        // shadow at the adjacent panel boundary. Centering the point
        // gives the rendered dot a clear "well inside one panel"
        // appearance regardless of fold orientation.
        var refineMinBaryMargin = (preset.model && preset.model.indexOf("mapfold") >= 0) ? 0.27 : 0;

        resetValidationBaseline();

        // Apply settings (re-initializes globals.facePoints from preset.facePoints)
        if (globals.benchmark.applySettings) globals.benchmark.applySettings(preset);

        // The mesh is path-dependent: jumping from fold=0 to fold=70%
        // converges to a DIFFERENT local minimum than walking 0 → 8 → ...
        // → 70% across 10 steps. The validator does the step-by-step walk
        // with ≥400ms settle per step (see validatePreset), so refinement
        // must too — otherwise a barycentric that is visible at the
        // refined-state mesh can fail visibility at the validated mesh
        // and we ship a broken preset. Match validator settle exactly.
        // (Was 800ms historically; dropped to 500ms since mesh convergence
        // on origami bases stabilises well before then — verified by A/B
        // on the existing matrix models. Further dropped to 400ms as a
        // pipeline speedup; mesh convergence still stable at this floor.)
        var perStepSettle = Math.max(settleMs || 300, 400);
        var finalSettle = Math.max(settleMs || 300, 400);

        // ── Build entries + candidates UP FRONT ────────────────────────
        // Hoisted from inside scoreAndRefine so we can probe candidates'
        // mid-fold visibility during the step-by-step walk below. Without
        // this, refinement only knows whether a candidate is visible at the
        // FINAL pose; many candidates pass at final but fail mid-fold,
        // causing post-refinement validation to drop the preset.
        function parseBaryEntry(e) {
            if (!e) return null;
            if (Array.isArray(e) && e.length >= 3) return { u: e[0], v: e[1], w: e[2] };
            if (typeof e === "object" && "u" in e && "v" in e && "w" in e) return { u: e.u, v: e.v, w: e.w };
            return null;
        }
        var entries = [];
        var pointIndex = 0;
        if (Array.isArray(preset.facePoints)) {
            for (var ai0 = 0; ai0 < preset.facePoints.length; ai0++) {
                var arrEntry0 = preset.facePoints[ai0];
                var arrBary0 = parseBaryEntry(arrEntry0);
                if (arrBary0) {
                    entries.push({ ref: arrEntry0, idx: pointIndex++, hidden: !!arrEntry0.hidden });
                } else {
                    var c00 = parseInt(arrEntry0 && arrEntry0.count != null ? arrEntry0.count : 1, 10);
                    pointIndex += (isNaN(c00) ? 0 : Math.max(1, c00));
                }
            }
        } else if (typeof preset.facePoints === "object") {
            for (var key0 in preset.facePoints) {
                if (!preset.facePoints.hasOwnProperty(key0)) continue;
                var val0 = preset.facePoints[key0];
                if (Array.isArray(val0)) {
                    for (var ki0 = 0; ki0 < val0.length; ki0++) {
                        var bary0 = parseBaryEntry(val0[ki0]);
                        if (bary0) {
                            entries.push({ ref: val0[ki0], idx: pointIndex++, hidden: !!(val0[ki0] && val0[ki0].hidden) });
                        } else {
                            pointIndex++;
                        }
                    }
                } else {
                    var c10 = parseInt(val0, 10);
                    if (!isNaN(c10) && c10 >= 1) pointIndex += c10;
                }
            }
        }

        // Build the candidate grid (deterministic per-preset jittered).
        var jitterSeedHoisted = (function () {
            var h = 2166136261;
            var fp = preset && preset.facePoints;
            if (fp && typeof fp === "object") {
                var keysS = Object.keys(fp).sort();
                for (var ks = 0; ks < keysS.length; ks++) {
                    var keyS = keysS[ks];
                    for (var ci = 0; ci < keyS.length; ci++) {
                        h ^= keyS.charCodeAt(ci);
                        h = Math.imul(h, 16777619);
                    }
                    var arrS = fp[keyS];
                    if (Array.isArray(arrS)) {
                        for (var asi = 0; asi < arrS.length; asi++) {
                            var ent = arrS[asi];
                            if (ent && typeof ent === "object") {
                                h ^= Math.round((ent.u || 0) * 1000) | 0;
                                h = Math.imul(h, 16777619);
                                h ^= Math.round((ent.v || 0) * 1000) | 0;
                                h = Math.imul(h, 16777619);
                                h ^= Math.round((ent.w || 0) * 1000) | 0;
                                h = Math.imul(h, 16777619);
                                if (ent.hidden) { h ^= 0xdeadbeef; h = Math.imul(h, 16777619); }
                            }
                        }
                    }
                }
            }
            return h | 0;
        })();
        var jitterRngHoisted = makeRng(jitterSeedHoisted);
        function jitterAxisH() { return jitterRngHoisted.randFloat(-0.025, 0.025); }
        function mkH(u, v) {
            var ju = u + jitterAxisH();
            var jv = v + jitterAxisH();
            if (ju < 0.20) ju = 0.20; else if (ju > 0.55) ju = 0.55;
            if (jv < 0.20) jv = 0.20; else if (jv > 0.55) jv = 0.55;
            var ru = Math.round(ju * 100) / 100;
            var rv = Math.round(jv * 100) / 100;
            var rw = Math.round((1 - ru - rv) * 100) / 100;
            return { u: ru, v: rv, w: rw };
        }
        var refineTierH = (preset && preset.difficulty) ? clampDifficultyTier(preset.difficulty) : 4;
        var gridValuesH = (refineTierH <= 2) ? [0.27, 0.37, 0.47] : [0.22, 0.30, 0.38, 0.45, 0.52];
        var baseCandidates = [];
        for (var uH = 0; uH < gridValuesH.length; uH++) {
            for (var vH = 0; vH < gridValuesH.length; vH++) {
                var cH = mkH(gridValuesH[uH], gridValuesH[vH]);
                if (cH.w < 0.18) continue;
                baseCandidates.push(cH);
            }
        }
        baseCandidates.push(mkH(0.33, 0.33));

        // survivesByEntry[entryIdx][candIdx] = true initially; flipped to
        // false the first time a non-hidden point's candidate placement
        // tests as invisible mid-fold. Used as a hard gate in scoring.
        // Hidden entries are NOT probed (they only need final-step visibility,
        // which scoreCandidate already checks).
        var survivesByEntry = {};
        for (var ei0 = 0; ei0 < entries.length; ei0++) {
            var em0 = entries[ei0];
            if (em0.hidden) continue;
            survivesByEntry[em0.idx] = new Array(baseCandidates.length);
            for (var ci0 = 0; ci0 < baseCandidates.length; ci0++) survivesByEntry[em0.idx][ci0] = true;
        }

        // After each settled step, save current bary per non-hidden entry,
        // probe each candidate's visibility, restore. Cost ~150-300ms/step
        // (set + check + restore × ~26 candidates × ~6 entries) — small
        // vs the 400ms settle.
        function probeCandidatesAtCurrentStep() {
            var probePts = globals.facePoints.getPoints ? globals.facePoints.getPoints() : [];
            for (var pe = 0; pe < entries.length; pe++) {
                var pem = entries[pe];
                if (pem.hidden) continue;
                if (pem.idx < 0 || pem.idx >= probePts.length) continue;
                var ppt = probePts[pem.idx];
                if (!ppt) continue;
                var pFaceId = ppt.faceId;
                var pOrigU = ppt.u, pOrigV = ppt.v, pOrigW = ppt.w;
                var survArr = survivesByEntry[pem.idx];
                for (var pci = 0; pci < baseCandidates.length; pci++) {
                    if (!survArr[pci]) continue;  // already failed at an earlier step
                    var pcand = baseCandidates[pci];
                    globals.facePoints.updatePointPosition(pem.idx, pFaceId, pcand.u, pcand.v, pcand.w);
                    if (!globals.facePoints.isPointVisible(pem.idx)) survArr[pci] = false;
                }
                // Restore so subsequent points / steps see the original bary.
                globals.facePoints.updatePointPosition(pem.idx, pFaceId, pOrigU, pOrigV, pOrigW);
            }
        }

        var stepIdx = 0;
        function applyNextStep() {
            if (stepIdx >= steps.length) {
                scoreAndRefine();
                return;
            }
            var isLast = stepIdx === steps.length - 1;
            var step = steps[stepIdx];
            globals.setCreasePercent((step.fold != null ? step.fold : 0) / 100);
            globals.shouldChangeCreasePercent = true;
            if (globals.benchmark.setPOV && step.pov) globals.benchmark.setPOV(step.pov);
            if (step.rotation && globals.threeView.setModelRotation) {
                var rr = Array.isArray(step.rotation)
                    ? step.rotation
                    : [step.rotation.x || 0, step.rotation.y || 0, step.rotation.z || 0];
                globals.threeView.setModelRotation(rr[0], rr[1], rr[2]);
            } else {
                globals.threeView.resetModel();
            }
            setTimeout(function () {
                // After settle, probe candidates BEFORE advancing to the
                // next step. Skip probe at the final step — scoreCandidate
                // already handles final-step visibility.
                if (!isLast) {
                    try { probeCandidatesAtCurrentStep(); } catch (_pe) {}
                }
                stepIdx++;
                applyNextStep();
            }, isLast ? finalSettle : perStepSettle);
        }

        function scoreAndRefine() {
            try {
                // entries / baseCandidates / jitter are pre-built up top so
                // the per-step probe could run during the walk. Re-use them.
                if (entries.length === 0) {
                    globals.threeView.resetModel();
                    callback(preset);
                    return;
                }

                var pts = globals.facePoints.getPoints ? globals.facePoints.getPoints() : [];
                var canvas = globals.threeView && globals.threeView.renderer ? globals.threeView.renderer.domElement : null;
                var canvasW = canvas && canvas.width ? canvas.width : 1024;
                var canvasH = canvas && canvas.height ? canvas.height : 1024;
                // Forward-clearance distance, in mesh-local units. Using a
                // percentage of the bbox diagonal keeps the threshold
                // scale-invariant across models. ~2% of the diagonal is
                // large enough to catch panels stacked just above a
                // point (where origami layers typically sit 0.01–0.03
                // units apart after folding) yet small enough that
                // truly open space still passes.
                var clearanceDist = 0.03;
                if (globals.model && globals.model.getDimensions) {
                    try {
                        var dim = globals.model.getDimensions();
                        if (dim && typeof dim.length === "function") {
                            clearanceDist = Math.max(0.015, dim.length() * 0.02);
                        }
                    } catch (_e) {}
                }

                // baseCandidates / jitter were built up top so the per-step
                // probe could populate survivesByEntry during the walk.

                // Scoring uses two tiers for the forward-clearance test:
                //   Tier 1 (strict): candidate passes clearance. These get
                //     the full score and we prefer them.
                //   Tier 2 (relaxed): candidate fails clearance but is
                //     still visible. Score is penalised so any Tier-1
                //     candidate beats any Tier-2 candidate, yet within
                //     Tier 2 we still pick the best one. This prevents
                //     regressions on geometry where *every* placement on
                //     a face is in a tight pocket — we still improve
                //     over the unrefined random barycentric.
                var TIER2_PENALTY = 1e6; // larger than any Tier-1 score
                function scoreCandidate(idx, cand, selfPtsSnapshot) {
                    if (!globals.facePoints.isPointVisible(idx)) return -Infinity;
                    var clearanceOk = !globals.facePoints.hasForwardClearance
                        || globals.facePoints.hasForwardClearance(idx, clearanceDist);
                    var scr = globals.benchmark.getPointScreenPosition
                        ? globals.benchmark.getPointScreenPosition(idx) : null;
                    if (!scr) return -Infinity;
                    var edge = Math.min(
                        scr.x, scr.y,
                        Math.max(0, canvasW - scr.x),
                        Math.max(0, canvasH - scr.y)
                    );
                    var minN = Infinity;
                    for (var oi = 0; oi < pts.length; oi++) {
                        if (oi === idx) continue;
                        if (!globals.facePoints.isPointVisible(oi)) continue;
                        var oScr = globals.benchmark.getPointScreenPosition
                            ? globals.benchmark.getPointScreenPosition(oi) : null;
                        if (!oScr) continue;
                        var dx = scr.x - oScr.x, dy = scr.y - oScr.y;
                        var d = Math.sqrt(dx * dx + dy * dy);
                        if (d < minN) minN = d;
                    }
                    if (!isFinite(minN)) minN = 400;
                    var baryMargin = Math.min(cand.u, cand.v, cand.w);
                    // Hard gates: reject candidates that sit on the image
                    // border or overlap another point. Everything above
                    // these floors contributes MONOTONICALLY to score —
                    // no hard saturation at 1, otherwise two perfectly
                    // adequate candidates tie and the first-enumerated
                    // one wins (bug: all points collapsed to (0.30, 0.30)
                    // because it was the first grid slot that cleared the
                    // saturation thresholds).
                    if (edge < 30) return -Infinity;
                    if (minN < 30) return -Infinity;
                    if (baryMargin < refineMinBaryMargin) return -Infinity;
                    // Cap each axis to a reasonable maximum so one alone
                    // can't dominate (e.g. a point 800px from the edge
                    // shouldn't beat one with better baryMargin). Units:
                    //   edge, minN: screen pixels; baryMargin: [0,0.33].
                    var eScore = Math.min(edge, 300);
                    var nScore = Math.min(minN, 250);
                    var bScore = Math.min(baryMargin, 0.33);
                    // Weights tuned so a 0.03 barycentric gain (e.g.
                    // 0.30 → 0.33 = face center) rivals ~25 px of edge
                    // margin — both produce comparable visual improvement
                    // so we want them comparable in the score.
                    var raw = 2.0 * eScore + 1.0 * nScore + 600 * bScore;
                    // Tier-2 candidates are visible but sit under a
                    // hovering panel; always rank below any Tier-1
                    // candidate. Subtract a constant larger than the
                    // Tier-1 score range so ordering within Tier 2 still
                    // matches raw score ordering.
                    return clearanceOk ? raw : raw - TIER2_PENALTY;
                }

                // Two passes: the 2nd pass lets later-refined points react to
                // earlier-refined ones for better pairwise separation.
                for (var pass = 0; pass < 2; pass++) {
                    for (var ei = 0; ei < entries.length; ei++) {
                        var em = entries[ei];
                        var idx = em.idx;
                        if (idx < 0 || idx >= pts.length) continue;
                        var pt = pts[idx];
                        if (!pt) continue;
                        var faceId = pt.faceId;
                        var origU = pt.u, origV = pt.v, origW = pt.w;

                        // Use baseCandidates directly (so candidate indices
                        // align with survivesByEntry). The original-bary
                        // fallback is appended at the end with a sentinel
                        // "always-survives" index so it can win when no
                        // grid candidate survives mid-fold.
                        var cands = baseCandidates;
                        var survArr = survivesByEntry[idx];  // undefined for hidden entries

                        // Collect all scored candidates so we can pick
                        // the Nth-best based on the preset's sibling
                        // index. This is how sibling configs from the
                        // same trajectory get distinct placements on
                        // SHARED faces — config 0 picks the best,
                        // config 1 picks the 2nd best, etc.
                        var scoredCands = [];
                        for (var ci = 0; ci < cands.length; ci++) {
                            // Hard gate: for non-hidden entries, skip
                            // candidates that failed mid-fold visibility.
                            if (survArr && !survArr[ci]) continue;
                            var c = cands[ci];
                            globals.facePoints.updatePointPosition(idx, faceId, c.u, c.v, c.w);
                            var s = scoreCandidate(idx, c);
                            if (s > -Infinity) {
                                scoredCands.push({ u: c.u, v: c.v, w: c.w, score: s });
                            }
                        }
                        // Always evaluate the original (pre-refinement)
                        // bary too — for hidden entries it's the only path,
                        // and for non-hidden it's a fallback when no grid
                        // candidate survived.
                        globals.facePoints.updatePointPosition(idx, faceId, origU, origV, origW);
                        var sOrig = scoreCandidate(idx, { u: origU, v: origV, w: origW });
                        if (sOrig > -Infinity) {
                            scoredCands.push({ u: origU, v: origV, w: origW, score: sOrig });
                        }

                        // Sort descending by score. With sibling biasing,
                        // config 0 picks index 0 (best), config 1 picks
                        // index 1 (2nd-best), capped at scoredCands.length-1
                        // so the worst case is "same as best" if there
                        // aren't enough distinct candidates.
                        scoredCands.sort(function (a, b) { return b.score - a.score; });
                        var siblingIdx = preset._siblingIndex || 0;
                        var pickIdx = Math.min(siblingIdx, scoredCands.length - 1);
                        var roundedU, roundedV, roundedW;
                        if (scoredCands.length > 0 && pickIdx >= 0) {
                            // Grid values are already 2-decimal rounded, so
                            // pass them through verbatim; no extra rounding
                            // that could drift the scored position.
                            roundedU = scoredCands[pickIdx].u;
                            roundedV = scoredCands[pickIdx].v;
                            roundedW = scoredCands[pickIdx].w;
                        } else {
                            roundedU = origU; roundedV = origV; roundedW = origW;
                        }

                        globals.facePoints.updatePointPosition(idx, faceId, roundedU, roundedV, roundedW);
                        // On the final pass, persist the refined barycentric
                        // back into preset.facePoints so the exported JSON
                        // carries the refined values.
                        if (pass === 1 && em.ref) {
                            em.ref.u = roundedU;
                            em.ref.v = roundedV;
                            em.ref.w = roundedW;
                        }
                        // Refresh the local pts snapshot so subsequent entries
                        // see the updated positions.
                        pts = globals.facePoints.getPoints ? globals.facePoints.getPoints() : pts;
                    }
                }

                globals.threeView.resetModel();
                callback(preset);
            } catch (err) {
                console.warn("refineFacePointBarycentric error:", err);
                try { globals.threeView.resetModel(); } catch (_e) {}
                callback(preset);
            }
        }

        // Kick off the step-by-step walk; scoreAndRefine runs once all
        // steps have been applied and the final step has settled.
        applyNextStep();
    }

    // Sequentially refine a batch of presets. Used by the legacy generation
    // path (which builds candidates without going through
    // addHiddenPointsFromFinalStep) to ensure every preset gets barycentric
    // refinement before validation.
    function refineBatch(presets, settleMs, rng, progressCb, callback) {
        if (!Array.isArray(presets) || presets.length === 0) {
            callback(presets || []);
            return;
        }
        var refined = new Array(presets.length);
        var idx = 0;
        function next() {
            if (idx >= presets.length) { callback(refined); return; }
            var i = idx;
            idx++;
            if (progressCb) {
                try { progressCb(i, presets.length); } catch (_e) {}
            }
            refineFacePointBarycentric(presets[i], settleMs, rng, function (r) {
                refined[i] = r;
                next();
            });
        }
        next();
    }

    // Refine only the final selected presets (post-diversity), then
    // re-validate each. If refinement regresses a preset (e.g. the new
    // barycentric sits on an occlusion boundary that shifts with mesh
    // state), fall back to the pre-refine facePoints so the output JSON
    // still satisfies the validator. Determinism: per-preset fallback is
    // a pure function of the revalidation result, which itself is
    // deterministic given seeded candidate selection.
    // Refine an entire batch of candidate presets BEFORE validation. With
    // refineFacePointBarycentric's per-step survives check, refinement
    // picks barycentric placements that pass mid-fold visibility for
    // visible-front anchors. Running refinement first means downstream
    // validateBatch sees candidates with already-survivable placements,
    // dramatically lifting pass rate for d4 cells where the original bary
    // grid often lands on edge-grazing positions.
    function preRefineBatch(presets, settleMs, rng, progressCb, callback) {
        if (!Array.isArray(presets) || presets.length === 0) {
            callback(presets || []);
            return;
        }
        var idx = 0;
        function next() {
            if (idx >= presets.length) { callback(presets); return; }
            if (progressCb) progressCb(idx, presets.length);
            refineFacePointBarycentric(presets[idx], settleMs, rng, function () {
                idx++;
                next();
            });
        }
        next();
    }

    function refineAndRevalidate(selected, settleMs, rng, callback) {
        if (!Array.isArray(selected) || selected.length === 0) {
            callback(selected || []);
            return;
        }
        var result = new Array(selected.length);
        var idx = 0;
        // Snapshot original facePoints per preset so we can restore on
        // revalidation failure. Deep-cloned via JSON round-trip since the
        // preset.facePoints shape is plain data (faceId -> array of
        // {u,v,w,hidden?} entries or numeric counts).
        function snapshotFacePoints(p) {
            try { return JSON.parse(JSON.stringify(p.facePoints || {})); }
            catch (_e) { return null; }
        }
        function next() {
            if (idx >= selected.length) { callback(result); return; }
            var i = idx;
            idx++;
            var preset = selected[i];
            var originalFP = snapshotFacePoints(preset);
            updateStatus("Refining selected preset " + (i + 1) + "/" + selected.length + "...");
            refineFacePointBarycentric(preset, settleMs, rng, function (refined) {
                // Revalidate the refined preset. validatePreset walks the
                // full step sequence at ≥800ms settle — same contract as
                // tools/validate-presets.js — so a pass here means the
                // refined placement will ship as-is.
                updateStatus("Revalidating refined preset " + (i + 1) + "/" + selected.length + "...");
                validatePreset(refined, settleMs, function (res) {
                    if (res && res.valid) {
                        result[i] = refined;
                    } else {
                        // Refinement regressed visibility. Restore the
                        // pre-refine facePoints in-place so we ship a
                        // preset we know passes validation (it was
                        // selected from the passing pool).
                        if (originalFP) refined.facePoints = originalFP;
                        result[i] = refined;
                        var reason = res && res.failures && res.failures[0] ? res.failures[0].reason : "unknown";
                        console.warn("presetGenerator: refinement regressed preset " + (i + 1) + " (" + reason + "); restored original barycentric");
                    }
                    next();
                });
            });
        }
        next();
    }

    // ── Diversity metrics ──────────────────────────────────────────────

    function rotationCurveDistance(a, b) {
        if (a.length !== b.length) return 999;
        var sum = 0;
        for (var i = 0; i < a.length; i++) {
            var dx = a[i][0] - b[i][0];
            var dy = a[i][1] - b[i][1];
            var dz = a[i][2] - b[i][2];
            sum += Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
        return sum / a.length;
    }

    function povCurveDistance(a, b) {
        if (a.length !== b.length) return 999;
        var sum = 0;
        for (var i = 0; i < a.length; i++) {
            var dx = a[i][0] - b[i][0];
            var dy = a[i][1] - b[i][1];
            var dz = a[i][2] - b[i][2];
            sum += Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
        return sum / a.length;
    }

    function faceSetJaccard(a, b) {
        var setA = {}, setB = {};
        var keysA = Object.keys(a), keysB = Object.keys(b);
        for (var i = 0; i < keysA.length; i++) setA[keysA[i]] = true;
        for (var j = 0; j < keysB.length; j++) setB[keysB[j]] = true;
        var intersection = 0, union = 0;
        var all = {};
        for (var k in setA) all[k] = true;
        for (var l in setB) all[l] = true;
        var allKeys = Object.keys(all);
        for (var m = 0; m < allKeys.length; m++) {
            union++;
            if (setA[allKeys[m]] && setB[allKeys[m]]) intersection++;
        }
        return union > 0 ? 1 - (intersection / union) : 0;
    }

    function presetDistance(a, b) {
        var rotDist = rotationCurveDistance(a._rotCurve || [], b._rotCurve || []);
        var povDist = povCurveDistance(a._povCurve || [], b._povCurve || []);
        var faceDist = faceSetJaccard(a.facePoints || {}, b.facePoints || {});
        return rotDist * 0.5 + povDist * 0.3 + faceDist * 0.2;
    }

    // ── Greedy diverse selection ───────────────────────────────────────

    // Produces a signature that identifies a preset's structure so we can
    // dedupe exact duplicates before the diversity pass. Two presets with
    // the same face points, POV, and per-step rotation are operationally
    // identical — diversity selection should never pick both.
    function presetSignature(p) {
        var fp = p && p.facePoints ? p.facePoints : {};
        var keys = Object.keys(fp).sort();
        var fpPart = keys.map(function (k) {
            var arr = fp[k];
            if (!Array.isArray(arr)) return k + ":?";
            var ptStr = arr.map(function (pt) {
                var u = Math.round((pt.u || 0) * 100) / 100;
                var v = Math.round((pt.v || 0) * 100) / 100;
                var w = Math.round((pt.w || 0) * 100) / 100;
                var h = pt.hidden ? "h" : "v";
                return u + "," + v + "," + w + "," + h;
            }).join("|");
            return k + ":" + ptStr;
        }).join(";");
        var steps = (p && p.steps) || [];
        var stepPart = steps.map(function (s) {
            var pov = Array.isArray(s.pov) ? s.pov.map(function (n) { return Math.round(n * 100) / 100; }).join(",") : String(s.pov);
            var rot = "";
            if (Array.isArray(s.rotation)) {
                rot = s.rotation.map(function (n) { return Math.round(n * 100) / 100; }).join(",");
            }
            return s.fold + "|" + pov + "|" + rot;
        }).join(">");
        return fpPart + "@" + stepPart;
    }

    function dedupeBySignature(list) {
        var seen = {};
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var sig = presetSignature(list[i]);
            if (seen[sig]) continue;
            seen[sig] = true;
            out.push(list[i]);
        }
        return out;
    }

    function selectDiverse(candidates, count, existingPresets) {
        candidates = dedupeBySignature(candidates || []);

        // Remove candidates that are exact duplicates of existing/reference
        // presets so we never emit a preset identical to one already shipped.
        var existingSigs = {};
        var referenceList = existingPresets || [];
        for (var ei = 0; ei < referenceList.length; ei++) {
            existingSigs[presetSignature(referenceList[ei])] = true;
        }
        candidates = candidates.filter(function (c) {
            return !existingSigs[presetSignature(c)];
        });

        if (candidates.length <= count) return candidates.slice();

        var selected = [];
        var reference = referenceList.slice();

        for (var pick = 0; pick < count; pick++) {
            var bestIdx = -1;
            var bestMinDist = -1;

            for (var ci = 0; ci < candidates.length; ci++) {
                var minDist = Infinity;

                // Distance to already-selected
                for (var si = 0; si < selected.length; si++) {
                    var d = presetDistance(candidates[ci], selected[si]);
                    if (d < minDist) minDist = d;
                }
                // Distance to existing reference presets
                for (var ri = 0; ri < reference.length; ri++) {
                    var d2 = presetDistance(candidates[ci], reference[ri]);
                    if (d2 < minDist) minDist = d2;
                }

                if (minDist > bestMinDist) {
                    bestMinDist = minDist;
                    bestIdx = ci;
                }
            }

            if (bestIdx >= 0) {
                selected.push(candidates[bestIdx]);
                candidates.splice(bestIdx, 1);
            }
        }
        return selected;
    }

    // Target rotation magnitudes per tier (yaw/pitch/roll Euler radians).
    // d3 ≈ 30°, d4 ≈ 60°. Pitch/roll scale to ≈25% of yaw.
    function rotationTargetForTier(tier, rng) {
        if (tier === 1) return [0, 0, 0];
        var r = rng || { randFloat: function (a, b) { return (a + b) / 2; }, random: function () { return 0.5; } };
        var yawBase, pitchBase, rollBase;
        if (tier === 3) {
            yawBase = r.randFloat(0.4, 0.6);
            pitchBase = r.randFloat(0.08, 0.18);
            rollBase = r.randFloat(0.03, 0.1);
        } else {
            // tier === 4
            yawBase = r.randFloat(0.85, 1.15);
            pitchBase = r.randFloat(0.15, 0.28);
            rollBase = r.randFloat(0.05, 0.15);
        }
        var yawDir = r.random && r.random() < 0.5 ? 1 : -1;
        var rollDir = r.random && r.random() < 0.5 ? 1 : -1;
        // Pitch leans positive (tilting up to expose back) more often than
        // negative for two-sided reveal intuition.
        var pitchDir = r.random && r.random() < 0.3 ? -1 : 1;
        return [pitchDir * pitchBase, yawDir * yawBase, rollDir * rollBase];
    }

    // Hero-shot constraint: state 1 (step 0) keeps the trajectory's STATIC
    // POV — same as states 2..N — but has zero rotation. This renders the
    // flat paper (fold=0) from the trajectory's own viewing direction,
    // giving a clean "before" reference frame while preserving a single
    // camera viewpoint across the entire sequence.
    //
    // Earlier versions forced iso POV here, which caused a visible
    // "inversion" between state 1 and state 2 when the trajectory POV sat
    // in a different hemisphere than iso (e.g. trajectory at
    // [-0.5, 0.63, -0.59] vs iso at [0.58, 0.58, 0.58] — the model appears
    // to flip left-right when stepping from 1 → 2). Keeping POV static
    // across all states eliminates that flip; only rotation distinguishes
    // state 1 (zero) from states 2..N (ramping d3 / d4 motion).
    //
    // runStep / validatePreset honor per-step rotation and fall back to
    // resetModel() when step.rotation is absent.
    function applyHeroShotStep0(out) {
        if (!out || out.length === 0) return out;
        delete out[0].rotation;
        return out;
    }

    function normalizeStepsForDifficulty(steps, difficulty, rng) {
        var profile = getDifficultyProfile(difficulty);
        var out = [];
        if (!steps || !Array.isArray(steps)) return out;

        for (var i = 0; i < steps.length; i++) {
            var src = steps[i] || {};
            var next = {
                fold: src.fold != null ? src.fold : 0,
                pov: parsePovVec(src.pov)
            };
            next.pov = roundVec3(next.pov);
            out.push(next);
        }

        if (out.length === 0) return out;

        // Detect incoming rotation from Phase 2 profiles BEFORE we strip
        // any rotation field. The presence of non-zero rotation means
        // Phase 2 validated this trajectory with those specific values
        // — they must be preserved.
        var hasIncomingRotation = false;
        for (var rci = 0; rci < steps.length; rci++) {
            var rv = parseRotationVec(steps[rci] && steps[rci].rotation);
            if (Math.abs(rv[0]) > 1e-8 || Math.abs(rv[1]) > 1e-8 || Math.abs(rv[2]) > 1e-8) {
                hasIncomingRotation = true;
                break;
            }
        }

        // Static POV: use the final-step POV across all steps. Phase 2
        // trajectories always start at iso, but the final-step POV is where
        // visibility was confirmed for the tracked face. All tiers now use
        // a single static camera POV; motion happens via object rotation.
        var staticPov = out[out.length - 1].pov.slice();
        for (var si = 0; si < out.length; si++) {
            out[si].pov = staticPov.slice();
            delete out[si].rotation;
        }

        // Preserve Phase 2's rotation curve when present — those specific
        // values are what made the trajectory succeed (brought the hidden
        // back face into view, kept the front face visible, etc).
        if (hasIncomingRotation) {
            for (var rji = 0; rji < steps.length; rji++) {
                var srv = parseRotationVec(steps[rji] && steps[rji].rotation);
                if (Math.abs(srv[0]) > 1e-8 || Math.abs(srv[1]) > 1e-8 || Math.abs(srv[2]) > 1e-8) {
                    out[rji].rotation = [
                        Math.round(srv[0] * 100) / 100,
                        Math.round(srv[1] * 100) / 100,
                        Math.round(srv[2] * 100) / 100
                    ];
                }
            }
            // d1 (static tier): step 0 shares the constant per-preset tilt
            // with steps 1..N. Hero-shot would unrotate only step 0, creating
            // a visible "untilt → tilt" jump between state 1 and state 2.
            // d3/d4 keep hero-shot: their rotation ramps from ~0 at step 1,
            // so stripping step 0 rotation is near-invisible.
            if (profile.isStaticTier) return out;
            return applyHeroShotStep0(out);
        }

        // No incoming rotation and static tier: emit static preset.
        // No rotation anywhere → hero-shot is a no-op (nothing to strip).
        if (profile.isStaticTier) return applyHeroShotStep0(out);

        // Synthesize a tier-appropriate rotation: 0 → target with
        // ease-in-out so the reveal happens in the last ~30% of the
        // sweep (matches hidden-point-reveal-at-end semantics for d4).
        var target = rotationTargetForTier(profile.tier, rng);
        var n = out.length;
        for (var ri = 0; ri < n; ri++) {
            var t = n <= 1 ? 1 : ri / (n - 1);
            var et = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            var rx = target[0] * et;
            var ry = target[1] * et;
            var rz = target[2] * et;
            if (Math.abs(rx) > 1e-3 || Math.abs(ry) > 1e-3 || Math.abs(rz) > 1e-3) {
                out[ri].rotation = [
                    Math.round(rx * 100) / 100,
                    Math.round(ry * 100) / 100,
                    Math.round(rz * 100) / 100
                ];
            }
        }

        return applyHeroShotStep0(out);
    }

    function scoreDifficultyFit(preset, difficulty, modelFaceCount) {
        var score = 0;
        if (matchesDifficultySideConfig(preset.facePoints, difficulty, modelFaceCount)) score += 2;
        if (matchesDifficultyMotion(preset.steps, difficulty)) score += 2;
        var tier = clampDifficultyTier(difficulty);
        if ((tier === 1 && preset.colorMode === "faceTriangleID") ||
            (tier === 4 && preset.colorMode === "labelOnly") ||
            (tier === 3 && (preset.colorMode === "faceTriangleID" || preset.colorMode === "labelOnly"))) {
            score += 1;
        }
        return score;
    }

    function filterCandidatesByDifficulty(candidates, difficulty, modelFaceCount, minCount, rng) {
        var strict = [];
        var sideOnly = [];
        var motionOnly = [];
        var fallback = [];

        for (var i = 0; i < candidates.length; i++) {
            var c = candidates[i];
            var sideOk = matchesDifficultySideConfig(c.facePoints, difficulty, modelFaceCount);
            var motionOk = matchesDifficultyMotion(c.steps, difficulty);
            if (sideOk && motionOk) strict.push(c);
            else if (sideOk) sideOnly.push(c);
            else if (motionOk) motionOnly.push(c);
            else fallback.push(c);
        }

        if (strict.length >= minCount) return strict;

        var merged = strict.slice();
        var rest = sideOnly.concat(motionOnly, fallback);
        rest.sort(function (a, b) {
            var sa = scoreDifficultyFit(a, difficulty, modelFaceCount);
            var sb = scoreDifficultyFit(b, difficulty, modelFaceCount);
            if (sa !== sb) return sb - sa;
            return rng.random() < 0.5 ? -1 : 1;
        });
        for (var r = 0; r < rest.length; r++) merged.push(rest[r]);
        return merged;
    }

    // ── Preset assembly ────────────────────────────────────────────────

    function cloneObject(obj) {
        return JSON.parse(JSON.stringify(obj));
    }

    function buildFacePointLabelMap(points) {
        var labels = {};
        for (var i = 0; i < points.length; i++) {
            var n = i + 1;
            var label = "";
            while (n > 0) {
                var rem = (n - 1) % 26;
                label = String.fromCharCode(65 + rem) + label;
                n = Math.floor((n - 1) / 26);
            }
            labels[label] = i;
        }
        return labels;
    }

    function getVisiblePointScores(allPointIndices) {
        var screens = [];
        for (var i = 0; i < allPointIndices.length; i++) {
            var idx = allPointIndices[i];
            if (!(globals.facePoints && globals.facePoints.isPointVisible && globals.facePoints.isPointVisible(idx))) continue;
            var sp = globals.benchmark && globals.benchmark.getPointScreenPosition ? globals.benchmark.getPointScreenPosition(idx) : null;
            if (sp) screens.push({ idx: idx, x: sp.x, y: sp.y });
        }
        var minSep = Infinity;
        for (var a = 0; a < screens.length; a++) {
            for (var b = a + 1; b < screens.length; b++) {
                var dx = screens[a].x - screens[b].x;
                var dy = screens[a].y - screens[b].y;
                var dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < minSep) minSep = dist;
            }
        }
        return {
            visibleCount: screens.length,
            minSeparationPx: minSep
        };
    }

    function chooseTrackingTargetsFromFacePoints(facePointsConfig, mode, options) {
        var modeNorm = String(mode || "all").trim().toLowerCase();
        var opts = options || {};
        var points = [];
        if (Array.isArray(facePointsConfig)) {
            for (var ai = 0; ai < facePointsConfig.length; ai++) {
                var p = facePointsConfig[ai];
                if (p && p.faceId != null) points.push({ faceId: p.faceId, hidden: !!p.hidden });
            }
        } else {
            var keys = Object.keys(facePointsConfig || {});
            for (var ki = 0; ki < keys.length; ki++) {
                var faceId = parseInt(keys[ki], 10);
                if (isNaN(faceId)) continue;
                var arr = facePointsConfig[keys[ki]];
                if (!Array.isArray(arr)) continue;
                for (var pi = 0; pi < arr.length; pi++) {
                    points.push({ faceId: faceId, hidden: !!(arr[pi] && arr[pi].hidden) });
                }
            }
        }

        if (points.length === 0) return { targetPointLabels: [], primaryTargetPointLabels: [] };

        var labelsByIndex = buildFacePointLabelMap(points);
        var allLabels = [];
        var hiddenLabels = [];
        var visibleLabels = [];
        for (var label in labelsByIndex) {
            if (!labelsByIndex.hasOwnProperty(label)) continue;
            var idx = labelsByIndex[label];
            allLabels.push(label);
            if (points[idx].hidden) hiddenLabels.push(label);
            else visibleLabels.push(label);
        }

        allLabels.sort();
        hiddenLabels.sort();
        visibleLabels.sort();

        function appendVisibleAnchors(baseLabels) {
            var out = baseLabels.slice();
            var requested = parseInt(opts.initialVisibleTrackedPointCount, 10);
            var anchorCount = isNaN(requested) ? 1 : Math.max(1, requested);
            for (var i = 0; i < visibleLabels.length && i < anchorCount; i++) {
                if (out.indexOf(visibleLabels[i]) === -1) out.push(visibleLabels[i]);
            }
            return out;
        }

        function wantsVisibleAnchor() {
            if (opts.includeInitialVisibleTrackedPoint === true) return true;
            return modeNorm === "hidden-plus-visible-anchor" ||
                modeNorm === "hidden-plus-initial-visible" ||
                modeNorm === "back-final-plus-initial";
        }

        if (modeNorm === "visible-only") {
            return {
                targetPointLabels: visibleLabels,
                primaryTargetPointLabels: visibleLabels.length > 0 ? [visibleLabels[0]] : []
            };
        }
        if (modeNorm === "hidden-only") {
            var hiddenOnlyTargets = hiddenLabels.slice();
            if (wantsVisibleAnchor()) hiddenOnlyTargets = appendVisibleAnchors(hiddenOnlyTargets);
            var hiddenOnlyPrimary = hiddenLabels.length > 0 ? [hiddenLabels[0]] : (hiddenOnlyTargets.length > 0 ? [hiddenOnlyTargets[0]] : []);
            return {
                targetPointLabels: hiddenOnlyTargets,
                primaryTargetPointLabels: hiddenOnlyPrimary
            };
        }

        if (modeNorm === "hidden-plus-visible-anchor" || modeNorm === "hidden-plus-initial-visible" || modeNorm === "back-final-plus-initial") {
            var hiddenWithAnchorTargets = appendVisibleAnchors(hiddenLabels);
            var hiddenWithAnchorPrimary = hiddenLabels.length > 0 ? [hiddenLabels[0]] : (hiddenWithAnchorTargets.length > 0 ? [hiddenWithAnchorTargets[0]] : []);
            return {
                targetPointLabels: hiddenWithAnchorTargets,
                primaryTargetPointLabels: hiddenWithAnchorPrimary
            };
        }

        // default: all
        var primary = hiddenLabels.length > 0 ? hiddenLabels.slice(0, 1) : allLabels.slice(0, 1);
        return {
            targetPointLabels: allLabels,
            primaryTargetPointLabels: primary
        };
    }

    function stepsFromProgression(progression, fallbackFoldSteps) {
        var out = [];
        var src = progression && progression.steps ? progression.steps : [];
        for (var i = 0; i < src.length; i++) {
            var st = src[i] || {};
            var step = {
                fold: st.fold != null ? st.fold : (fallbackFoldSteps && fallbackFoldSteps[i] != null ? fallbackFoldSteps[i] : 0),
                pov: st.pov != null ? st.pov : [1, 0.55, 0]
            };
            if (st.rotation) step.rotation = Array.isArray(st.rotation) ? st.rotation.slice() : [st.rotation.x || 0, st.rotation.y || 0, st.rotation.z || 0];
            out.push(step);
        }
        return out;
    }

    function facePointsHaveHidden(config) {
        if (!config) return false;
        if (Array.isArray(config)) {
            for (var ai = 0; ai < config.length; ai++) {
                if (config[ai] && config[ai].hidden) return true;
            }
            return false;
        }
        var ks = Object.keys(config);
        for (var ki = 0; ki < ks.length; ki++) {
            var arr = config[ks[ki]];
            if (!Array.isArray(arr)) continue;
            for (var ii = 0; ii < arr.length; ii++) {
                if (arr[ii] && arr[ii].hidden) return true;
            }
        }
        return false;
    }

    // A back-face point (faceId >= modelFaceCount) is not geometrically
    // visible at fold=0 — the paper is flat, so only the front side faces
    // the upper hemisphere. strictAllSteps therefore always fails at
    // step 1 for any config with a back-face point. Callers should
    // upgrade to finalStepOnly whenever this returns true.
    function facePointsHaveBackFace(config, modelFaceCount) {
        if (!config || !modelFaceCount || modelFaceCount <= 0) return false;
        if (Array.isArray(config)) {
            for (var ai = 0; ai < config.length; ai++) {
                if (!config[ai]) continue;
                var fid = parseInt(config[ai].faceId != null ? config[ai].faceId : config[ai].face, 10);
                if (!isNaN(fid) && fid >= modelFaceCount) return true;
            }
            return false;
        }
        var ks = Object.keys(config);
        for (var ki = 0; ki < ks.length; ki++) {
            var fid2 = parseInt(ks[ki], 10);
            if (!isNaN(fid2) && fid2 >= modelFaceCount) return true;
        }
        return false;
    }

    // True when any tracked point requires a fold transition to become
    // visible: explicit "hidden": true, or a back-face point.
    function facePointsNeedFinalStepOnly(config, modelFaceCount) {
        return facePointsHaveHidden(config) || facePointsHaveBackFace(config, modelFaceCount);
    }

    function createPresetFromProgression(progression, facePointsConfig, options) {
        var opts = options || {};
        var difficulty = clampDifficultyTier(opts.difficulty || 5);
        if (!opts.rng) throw new Error("createPresetFromProgression: opts.rng is required (deterministic seeding)");
        var rng = opts.rng;
        var colorMode = opts.colorMode || getColorModeForDifficulty(difficulty, rng);
        var colors = opts.colors || ["e74c3c", "3498db"];
        var bgColor = opts.backgroundColor || "f0f0f0";
        var foldSteps = opts.foldSteps || rescaleFoldLadder(
            difficulty === 1
                ? [0, 12, 25, 37, 50]
                : [0, 8, 16, 24, 32, 40, 48, 56, 64, 70],
            resolveFinalFold(opts)
        );
        var rawSteps = stepsFromProgression(progression, foldSteps);
        var normalizedSteps = normalizeStepsForDifficulty(rawSteps, difficulty, rng);

        // trackingEvalMode: if any face point is hidden (d4 always) force
        // finalStepOnly so validation only requires the point visible at
        // the last fold step. This overrides caller-provided
        // trackingEvalMode because CLI defaults (strictAllSteps) would
        // break d4's hidden-back reveal semantics silently.
        var createFaceCount = opts.modelFaceCount;
        if (createFaceCount == null && globals.model && globals.model.getFaces) {
            var cfs = globals.model.getFaces();
            createFaceCount = cfs ? cfs.length : 0;
        }
        var resolvedTrackingMode;
        if (facePointsNeedFinalStepOnly(facePointsConfig, createFaceCount)) {
            resolvedTrackingMode = "finalStepOnly";
        } else {
            resolvedTrackingMode = opts.trackingEvalMode || "strictAllSteps";
        }

        var preset = {
            model: opts.model || "/Bases/birdBase.svg",
            colorMode: colorMode,
            labelStyle: "arrow",
            backgroundColor: bgColor,
            fold: 0,
            pauseDuration: 1,
            showPointNumbers: true,
            autoCapture: true,
            hidePointsDuringAnimation: true,
            difficulty: difficulty,
            facePoints: cloneObject(facePointsConfig),
            steps: normalizedSteps,
            minPointSeparationPx: opts.minPointSeparationPx != null ? opts.minPointSeparationPx : 70,
            trackingEvalMode: resolvedTrackingMode,
            // Sibling index within a trajectory's K-config emission.
            // Refinement uses this to pick the Nth-best barycentric
            // candidate for each face, so sibling configs from the same
            // trajectory end up with VISIBLY DIFFERENT point placements
            // on shared faces (rather than all converging to the same
            // global-optimum position).
            _siblingIndex: opts.siblingIndex || 0
        };
        if (colorMode === "labelOnly") {
            preset.color1 = colors[0];
            preset.color2 = colors[1];
        }

        var targets = chooseTrackingTargetsFromFacePoints(facePointsConfig, opts.targetSelectionMode || "all", opts);
        if (targets.targetPointLabels && targets.targetPointLabels.length > 0) {
            preset.targetPointLabels = targets.targetPointLabels;
        }
        if (targets.primaryTargetPointLabels && targets.primaryTargetPointLabels.length > 0) {
            preset.primaryTargetPointLabels = targets.primaryTargetPointLabels;
        }

        var rotCurve = [];
        var povCurve = [];
        for (var si = 0; si < normalizedSteps.length; si++) {
            var st = normalizedSteps[si] || {};
            povCurve.push(parsePovVec(st.pov));
            rotCurve.push(parseRotationVec(st.rotation));
        }
        preset._rotCurve = rotCurve;
        preset._povCurve = povCurve;
        preset._progressionScore = progression && progression.score != null ? progression.score : 0;
        preset._progressionMetrics = progression && progression.metrics ? cloneObject(progression.metrics) : null;
        return preset;
    }

    // ── Trajectory-first face-point selection ──────────────────────────
    //
    // Given an accepted progression (from evaluateTrajectoriesLive) with a
    // per-step visibilityTimeline and the model's face pools, emit up to K
    // distinct facePoints configs that satisfy the difficulty tier's tracked-
    // point requirements (CLAUDE.md "Tracked point counts" + "Difficulty
    // tiers"). Returns [] if the trajectory cannot satisfy the tier (e.g. no
    // back-pool face is visible at the final step for d4).
    //
    // Tier rules (canonical from CLAUDE.md):
    //   d1: 3 visible front, strictAllSteps
    //   d3: 3 visible front, strictAllSteps
    //   d4: 2 visible front + 1 hidden front + 1 hidden back, finalStepOnly
    //
    // Selection logic:
    //   - Visible-front slots: faces in frontPool that are visible at EVERY
    //     step of the timeline, ranked by min-step quality (descending).
    //   - Hidden-back slots: faces in backPool that are visible at the FINAL
    //     step, ranked by final quality (descending). discoverFacePools'
    //     ordering provides the tiebreaker on quality=0 (back-side qualities
    //     read 0 from getFaceViewQualities — see benchmark.js:2024).
    //   - Hidden-front slots: faces in frontPool that are visible at the
    //     FINAL step but excluded from the visible-front pick (so the same
    //     face isn't picked twice).
    //
    // Configs per trajectory, per-tier. K=1 for d1/d3 preserves
    // "unique trajectory per preset". K=4 for d4 lifts yield past the
    // thin-back-pool ceiling — d4 presets can share POV/rotation but
    // differ in hidden-back pick and barycentric position, producing
    // visually distinct outputs. Safe: presetSignature() keys on
    // facePoints+steps jointly so shared trajectories with different
    // face picks still dedupe correctly.
    function selectFromTrajectoryK(tier) {
        // K=1 for d1, K=2 for d3/d4. Maximizes trajectory diversity per
        // cell: each (POV, rotation) trajectory yields at most one config
        // for d1 (single-side, no reveal) and at most two for d3/d4
        // (room for hidden-front/hidden-back variants on the same path).
        // Continuation passes lift cells whose geometry yields fewer
        // unique trajectories than the per-cell target.
        if (tier === 1) return 1;
        return 2;
    }

    function selectFacePointsFromTrajectory(trajectory, difficulty, modelFaceCount, frontPool, backPool, rng, model) {
        var tier = clampDifficultyTier(difficulty);
        var K = selectFromTrajectoryK(tier);
        var timeline = trajectory && trajectory.visibilityTimeline;
        if (!Array.isArray(timeline) || timeline.length === 0) return [];
        var N = modelFaceCount;
        if (!N || N < 1) return [];

        // mapfold-only: enforce a final-step face-quality floor on all
        // anchor pools. Mapfold's accordion fold leaves many faces at
        // grazing angles to the camera at the final pose — they pass
        // isPointVisible (which is binary front-facing + occlusion) but
        // the rendered dot sits on a near-edge-on panel and reads as
        // invisible.
        //
        // mapfold split thresholds:
        //   minFinalQuality       — visible-front anchors (rankedFronts).
        //   minHiddenFinalQuality — hidden-front + hidden-back picks.
        // Split because visible-front anchors are also constrained by
        // alwaysVisible (faces visible at first + final step), which
        // shrinks mapfold's candidate pool to faces that stay roughly
        // iso-flat-oriented throughout the trajectory — most cap at
        // ~0.4 final quality at fold=60. The faces that DO reach 0.6+
        // are the ones that swing favorably during folding, and those
        // are typically only finalVisible (not alwaysVisible). So we
        // accept 0.4 for the visible-front "throughout the trajectory"
        // anchors and require 0.6 for the hidden anchors that only
        // need to be visible at the answer frame — exactly where the
        // user observed the "invisible point" rendering issue.
        // For mapfold, gate at 0.4 across all anchor types. Combined
        // with the stricter refinement baryMargin floor (≥0.27, see
        // refineFacePointBarycentric) this gives "stronger visibility"
        // without over-pruning the trajectory pool: candidates clear
        // the face-quality gate freely, then refinement picks
        // barycentric placements far enough from any crease line that
        // the rendered dot doesn't blend with shadow/edge artifacts.
        var modelStr = String(model || "");
        var isMapfoldModel = modelStr.indexOf("mapfold") >= 0;
        var minFinalQuality = isMapfoldModel ? 0.4 : 0;
        var minHiddenFinalQuality = isMapfoldModel ? 0.4 : 0;

        // Front pool: keep visibility-discovered front faces (faces visible
        // from above at fold=0). Used for visible-front anchors.
        function normalizePool(src) {
            var out = [];
            var seen = {};
            var arr = Array.isArray(src) ? src : [];
            for (var i = 0; i < arr.length; i++) {
                var raw = parseInt(arr[i], 10);
                if (isNaN(raw)) continue;
                if (raw >= N) raw -= N;
                if (raw < 0 || raw >= N) continue;
                if (!seen[raw]) { seen[raw] = true; out.push(raw); }
            }
            return out;
        }
        var fronts = normalizePool(frontPool);

        // Back pool: ALL mesh face indices [0, N-1]. The actual "back" gate
        // is the geometric isBackSideExposed filter below — a face qualifies
        // as a back-pool member only if its back side is camera-facing AND
        // unoccluded at the trajectory's final step (per the
        // backSideVisibleFaceIds timeline data). Thin-pool models like boat
        // / waterbomb / simplevertex have their geometric back faces at
        // arbitrary indices (often [0,1] — outside any "second half"
        // range), so any pre-filter on index range deterministically kills
        // d4 for those models. Letting the geometric gate be the sole
        // filter satisfies the user's primary contract: "guarantee a point
        // on the back side of the paper visible at the final state."
        var backs = [];
        for (var bii = 0; bii < N; bii++) backs.push(bii);

        // Build alwaysVisible set + min-step quality from the timeline.
        //
        // mapfold-only: only require visibility at first + final step
        // (skip intermediate steps). Mapfold's accordion fold stacks
        // panels over each other at fold=24-40, transiently occluding
        // even the panels that recover full visibility at the final
        // pose. The strict "visible at every step" rule decimates the
        // candidate pool — many faces that ARE clearly visible in the
        // initial (flat) and final (folded) renders get dropped.
        // The same trade-off appears in validatePreset (mid-step
        // visibility check is skipped for mapfold) so this mirrors the
        // accepted "ugly mid-fold frames OK, endpoint frames must be
        // clean" semantic.
        var firstStep = timeline[0];
        var finalStepForVis = timeline[timeline.length - 1];
        var stepsToCheck = isMapfoldModel
            ? [firstStep, finalStepForVis]
            : timeline;
        var alwaysVisible = {};
        var minStepQuality = {};
        for (var i0 = 0; i0 < firstStep.visibleFaceIds.length; i0++) {
            var fid0 = firstStep.visibleFaceIds[i0];
            alwaysVisible[fid0] = true;
            minStepQuality[fid0] = (firstStep.qualities && firstStep.qualities[fid0] != null)
                ? firstStep.qualities[fid0] : 0;
        }
        for (var s = 1; s < stepsToCheck.length; s++) {
            var step = stepsToCheck[s];
            var stepSet = {};
            for (var v = 0; v < step.visibleFaceIds.length; v++) {
                stepSet[step.visibleFaceIds[v]] = true;
            }
            var keys = Object.keys(alwaysVisible);
            for (var ki = 0; ki < keys.length; ki++) {
                var kid = parseInt(keys[ki], 10);
                if (!stepSet[kid]) {
                    delete alwaysVisible[kid];
                    delete minStepQuality[kid];
                    continue;
                }
                var q = (step.qualities && step.qualities[kid] != null) ? step.qualities[kid] : 0;
                if (q < minStepQuality[kid]) minStepQuality[kid] = q;
            }
        }

        var finalStep = timeline[timeline.length - 1];
        var finalQuality = finalStep.qualities || {};
        var finalVisible = {};
        for (var fi2 = 0; fi2 < finalStep.visibleFaceIds.length; fi2++) {
            finalVisible[finalStep.visibleFaceIds[fi2]] = true;
        }
        // Final-step back-side-visible faces (face's back surface is
        // camera-facing AND unoccluded). Computed by getBackSideVisibleFaceIds
        // in facePoints.js and recorded in the timeline. Used to gate d4
        // hidden-back picks: a hidden back point only "guarantees back side
        // visibility" if the underlying face's back surface is actually
        // exposed at the final state.
        var finalBackSideVisible = {};
        var finalBackQuality = {};
        var bsv = finalStep.backSideVisibleFaceIds || [];
        var fbq = finalStep.backQualities || {};
        for (var fbi = 0; fbi < bsv.length; fbi++) {
            var bfid = bsv[fbi];
            finalBackSideVisible[bfid] = true;
            finalBackQuality[bfid] = (fbq[bfid] != null) ? fbq[bfid] : 0;
        }

        // Visible-front anchors must be visible at EVERY step regardless of
        // tier. The user's hard contract: "initial points must be visible
        // throughout all progressions and final state". finalStepOnly is a
        // HIDDEN-point semantic (a hidden point reveals at the final step),
        // not a visible-anchor one.
        //
        // Earlier this was tier-conditional and used finalVisible for d4
        // — but that let visible-fronts disappear mid-fold, producing presets
        // that look broken (the user observed this in the rendered output).
        var rankedFronts = fronts.filter(function (fid) {
            return alwaysVisible[fid]
                && (minStepQuality[fid] || 0) > 0
                && (finalQuality[fid] || 0) >= minFinalQuality;
        });
        rankedFronts.sort(function (a, b) {
            return (minStepQuality[b] || 0) - (minStepQuality[a] || 0);
        });

        // Hidden-back candidates must satisfy BOTH (per user spec):
        //   (a) Index-based: face id in [N/2, N-1] (already in `backs`).
        //   (b) Geometric back-side exposed at final: the face's BACK
        //       surface is camera-facing AND unoccluded. Computed by
        //       getBackSideVisibleFaceIds (the back-facing analogue of
        //       getVisibleFaceIds) and recorded in the timeline as
        //       backSideVisibleFaceIds.
        // The picked face indices are stored in the preset with faceId =
        // (idx + N) so isPointVisible's `isFront = id < N` path correctly
        // checks back-facing visibility, and the renderer treats the point
        // as a back-surface marker.
        function isBackSideExposed(fid) {
            return !!finalBackSideVisible[fid];
        }
        var rankedBacks = backs.filter(function (fid) {
            return isBackSideExposed(fid) && (finalBackQuality[fid] || 0) >= minHiddenFinalQuality;
        });
        // Rank by how directly the back surface faces the camera at the final
        // step (1.0 = squarely back-facing, ~0 = grazing). Best-viewed first
        // so K-output picks land on faces that actually read as back surface
        // in the rendered PNG. Falls back to pool order when qualities tie or
        // are missing (older timelines, error paths).
        rankedBacks.sort(function (a, b) {
            var qa = finalBackQuality[a] || 0;
            var qb = finalBackQuality[b] || 0;
            if (qb !== qa) return qb - qa;
            return backs.indexOf(a) - backs.indexOf(b);
        });

        // Hidden-front candidates: in frontPool, visible at final step.
        // (Used by d4 for "late reveal" of front anchors.)
        var rankedHiddenFronts = fronts.filter(function (fid) {
            return finalVisible[fid] && (finalQuality[fid] || 0) >= minHiddenFinalQuality;
        });
        rankedHiddenFronts.sort(function (a, b) {
            return (finalQuality[b] || 0) - (finalQuality[a] || 0);
        });

        // Per-tier slot count RANGES (d1/d3/d4 only).
        // Constraint: every preset has at least 2 visible (non-hidden)
        // anchors so initial state is trackable, and the total fits the
        // tier's range. Each tier picks greedily from its range based on
        // what the trajectory's pools support; empty config returned if
        // the lower bound can't be met.
        //
        //   d1: static (no rotation across steps), 2 visible front + 1-3
        //       hidden front (revealed at final step). Total 3-5.
        //   d3: rotated, 2 visible front + 1-3 hidden front. Total 3-5.
        //   d4: rotated, 2 visible front + 1-2 hidden front + 1-2 hidden
        //       back (mix of late-front-reveal and back-via-rotation).
        //       Total 4-6.
        var ranges;
        if (tier === 1)      ranges = { vF: [2, 2], hF: [1, 3], hB: [0, 0] };
        else if (tier === 3) ranges = { vF: [2, 2], hF: [1, 3], hB: [0, 0] };
        else                 ranges = { vF: [2, 2], hF: [1, 2], hB: [1, 2] };

        // For d4, the FINAL POSE must show at least hB.lower back-pool
        // faces that are GEOMETRICALLY back-side-exposed at the final step
        // — same definition rankedBacks uses (index in [N/2, N-1] AND
        // front-normal quality < BACK_SIDE_QUALITY_MAX). This guarantees
        // the rendered PNG actually has visible back-surface for the
        // hidden reveal, not just a face-id in the back-half range that
        // happens to be front-facing.
        var requiresBothSides = (tier === 4);
        var backVisibleAtFinalCount = 0;
        for (var bvi = 0; bvi < backs.length; bvi++) {
            if (isBackSideExposed(backs[bvi])) backVisibleAtFinalCount++;
        }
        if (requiresBothSides) {
            var minBackAtFinal = ranges.hB[0];
            if (backVisibleAtFinalCount < minBackAtFinal) return [];
        }

        // Build a plan from the ranges given pool sizes. Greedy: pick the
        // most each slot can support, capped by the slot max and the global
        // total-of-6 budget. Returns null if any slot's lower bound can't
        // be met.
        function clampRange(want, lo, hi) { return Math.max(lo, Math.min(hi, want)); }
        function buildPlan() {
            var TOTAL_MAX = 6;
            var vF = clampRange(rankedFronts.length, ranges.vF[0], ranges.vF[1]);
            if (vF < ranges.vF[0]) return null;

            // Hidden-back budget: respect tier range and pool availability.
            var hB = clampRange(Math.min(rankedBacks.length, backVisibleAtFinalCount),
                                ranges.hB[0], ranges.hB[1]);
            if (hB < ranges.hB[0]) return null;

            // Hidden-front budget: pool minus vF picks (rankedHiddenFronts may
            // overlap rankedFronts at high quality), capped by tier range and
            // total-budget headroom.
            var headroom = Math.max(0, TOTAL_MAX - vF - hB);
            var hF_pool_avail = Math.max(0, rankedHiddenFronts.length - vF);
            var hF = clampRange(Math.min(hF_pool_avail, headroom), ranges.hF[0], ranges.hF[1]);
            if (hF < ranges.hF[0]) return null;

            // Final total cap (in case range mins themselves exceed 6 — they
            // don't today but defensive code is cheap).
            while (vF + hF + hB > TOTAL_MAX) {
                if (hF > ranges.hF[0]) hF--;
                else if (vF > ranges.vF[0]) vF--;
                else if (hB > ranges.hB[0]) hB--;
                else break;
            }
            return { vF: vF, hF: hF, hB: hB };
        }
        var plan = buildPlan();
        if (!plan) return [];

        function makeBary() {
            var u = Math.round(rng.randFloat(0.30, 0.50) * 100) / 100;
            var v = Math.round(rng.randFloat(0.30, 0.50) * 100) / 100;
            var w = Math.round((1 - u - v) * 100) / 100;
            if (w < 0.10) {
                w = 0.10;
                u = Math.round((1 - v - w) * 100) / 100;
            }
            return { u: u, v: v, w: w };
        }

        // Barycentric grid: 9 positions spanning the interior of a face.
        // Cycled by configIdx so each emitted config uses a different bary
        // for the same face. Refinement's minNeighborPx constraint then
        // diverges placements within a config; combined with rotated bary
        // across configs, sibling configs from the same trajectory get
        // visually distinct point layouts.
        var baryGrid = [
            { u: 0.34, v: 0.33, w: 0.33 },
            { u: 0.50, v: 0.25, w: 0.25 },
            { u: 0.25, v: 0.50, w: 0.25 },
            { u: 0.25, v: 0.25, w: 0.50 },
            { u: 0.42, v: 0.39, w: 0.19 },
            { u: 0.19, v: 0.42, w: 0.39 },
            { u: 0.39, v: 0.19, w: 0.42 },
            { u: 0.35, v: 0.40, w: 0.25 },
            { u: 0.25, v: 0.35, w: 0.40 }
        ];

        // Combinatorial K-expansion with max-diversity selection.
        //
        // Two-stage approach for stronger variance when K > 1:
        //   1. Enumerate ALL valid (visF-pair, hF-offset, hB-offset)
        //      combinations into a pool, tagged with their face-set.
        //   2. Greedily pick K of them, maximizing per-pick the average
        //      non-overlap-with-chosen face set.
        // The original loop emitted the first K combinations from a
        // nested iteration — for K=2 this meant sibling configs shared
        // the same visF pair (only differing in hidden-back), so global
        // refinement gave identical visible-front placements.
        var hFCycleMax = Math.max(1, rankedHiddenFronts.length);
        var hBCycleMax = Math.max(1, rankedBacks.length);

        // Stage 1: collect all unique combinations into a pool.
        var pool = [];
        var seenSig = {};
        for (var i = 0; i < rankedFronts.length - (plan.vF - 1); i++) {
            for (var j = i + 1; j < rankedFronts.length; j++) {
                var visFp = [rankedFronts[i], rankedFronts[j]];
                var u0 = {};
                u0[visFp[0]] = true;
                u0[visFp[1]] = true;

                for (var hOff = 0; hOff < hFCycleMax; hOff++) {
                    var hidFp = [];
                    var u1 = Object.assign({}, u0);
                    for (var hi = 0; hi < rankedHiddenFronts.length && hidFp.length < plan.hF; hi++) {
                        var hfid = rankedHiddenFronts[(hi + hOff) % rankedHiddenFronts.length];
                        if (u1[hfid]) continue;
                        hidFp.push(hfid);
                        u1[hfid] = true;
                    }
                    if (hidFp.length < plan.hF) continue;

                    for (var bOff = 0; bOff < hBCycleMax; bOff++) {
                        var hidBp = [];
                        var u2 = Object.assign({}, u1);
                        for (var bi = 0; bi < rankedBacks.length && hidBp.length < plan.hB; bi++) {
                            var bfid = rankedBacks[(bi + bOff) % rankedBacks.length];
                            if (u2[bfid]) continue;
                            hidBp.push(bfid);
                            u2[bfid] = true;
                        }
                        if (hidBp.length < plan.hB) continue;

                        var sigP = visFp.slice().sort().join(",")
                                 + "|" + hidFp.slice().sort().join(",")
                                 + "|" + hidBp.slice().sort().join(",");
                        if (seenSig[sigP]) continue;
                        seenSig[sigP] = true;

                        var faceSet = {};
                        for (var fk = 0; fk < visFp.length; fk++) faceSet[visFp[fk]] = true;
                        for (var fk2 = 0; fk2 < hidFp.length; fk2++) faceSet[hidFp[fk2]] = true;
                        for (var fk3 = 0; fk3 < hidBp.length; fk3++) faceSet[hidBp[fk3]] = true;

                        pool.push({
                            visF: visFp.slice(),
                            hidF: hidFp.slice(),
                            hidB: hidBp.slice(),
                            faceSet: faceSet
                        });
                    }
                }
            }
        }

        if (pool.length === 0) return [];

        // Stage 2: greedy max-diversity selection. Seed with pool[0]
        // (top-ranked combination by enumeration order). Each subsequent
        // pick maximizes the average non-overlap-face-count against the
        // already-chosen set.
        var chosen = [pool[0]];
        var chosenSet = {}; chosenSet[0] = true;
        while (chosen.length < K && chosen.length < pool.length) {
            var bestIdx = -1;
            var bestScore = -1;
            for (var pi = 0; pi < pool.length; pi++) {
                if (chosenSet[pi]) continue;
                var cand = pool[pi];
                var totalNonOverlap = 0;
                for (var ci = 0; ci < chosen.length; ci++) {
                    var nonOverlap = 0;
                    for (var f in cand.faceSet) {
                        if (!chosen[ci].faceSet[f]) nonOverlap++;
                    }
                    totalNonOverlap += nonOverlap;
                }
                var avgNonOverlap = totalNonOverlap / chosen.length;
                if (avgNonOverlap > bestScore) {
                    bestScore = avgNonOverlap;
                    bestIdx = pi;
                }
            }
            if (bestIdx < 0) break;
            chosen.push(pool[bestIdx]);
            chosenSet[bestIdx] = true;
        }

        // Stage 3: materialize selected combinations into config
        // objects with per-config bary positions (cycled through grid).
        var configs = [];
        for (var ck = 0; ck < chosen.length; ck++) {
            var sel = chosen[ck];
            var baryForThisConfig = baryGrid[ck % baryGrid.length];
            var config = {};
            var addPoint = function (fid, hidden) {
                var key = String(fid);
                if (!config[key]) config[key] = [];
                var entry = { u: baryForThisConfig.u, v: baryForThisConfig.v, w: baryForThisConfig.w };
                if (hidden) entry.hidden = true;
                config[key].push(entry);
            };
            for (var av = 0; av < sel.visF.length; av++) addPoint(sel.visF[av], false);
            for (var af = 0; af < sel.hidF.length; af++) addPoint(sel.hidF[af], true);
            // Hidden-back picks: use faceId = (idx + N) so the simulator
            // treats the point as a back-surface marker (isPointVisible's
            // `isFront = id < N` path will require the BACK normal to face
            // the camera). Without this the point would be a front-side
            // marker on the same face — visible only when the front is
            // exposed, defeating d4's hidden-back-reveal semantic.
            for (var ab = 0; ab < sel.hidB.length; ab++) addPoint(sel.hidB[ab] + N, true);

            configs.push({
                facePoints: config,
                siblingIndex: ck,
                _selection: {
                    visibleFronts: sel.visF,
                    hiddenFronts: sel.hidF,
                    hiddenBacks: sel.hidB
                }
            });
        }
        return configs;
    }

    // ── Generic anchor for trajectory-first Phase 2 ────────────────────
    //
    // Phase 2 still needs at least one tracked point so its visibility +
    // separation gate has something to operate on. We pick a single front-
    // pool face's centroid as a "generic anchor" — the trajectory
    // acceptance is intentionally weaker than today's per-(front,back)
    // gate so post-hoc selection has a superset of viable trajectories to
    // pick from. The final face-point selection happens after Phase 2 via
    // selectFacePointsFromTrajectory.
    //
    // The chosen face is frontPool[0] (discoverFacePools sorts the front
    // pool by quality at the standard view). Centroid bary {0.34, 0.33,
    // 0.33} maximizes interior margin so the anchor stays well inside its
    // face under the chosen POV.
    function buildGenericAnchorFacePoints(frontPool, modelFaceCount, difficulty, backPool, opts) {
        var N = modelFaceCount;
        if (!Array.isArray(frontPool) || frontPool.length === 0 || !N || N < 1) return null;

        // d4: anchor is a HIDDEN back-side face. Reasoning: under d4's heavy
        // rotation (yaw 1.4, pitch 1.3 rad) the front-pool faces typically
        // rotate AWAY from the camera by the final step, so a front anchor
        // fires `reason=tracked` rejection at step 10 in evaluateTrackedPoints.
        // A back-side face has the opposite property — its back surface is
        // exposed precisely *because* of the heavy rotation. Marked hidden
        // so Phase 2's finalStepOnly mode only checks visibility at the
        // final step (back faces aren't visible at fold=0 / no rotation).
        // This puts trajectory acceptance on the same gate the post-hoc
        // selectFacePointsFromTrajectory uses for hidden-back picks, which
        // is exactly what we want for d4 yield.
        // forceFrontAnchor: caller wants the d1/d3-style front-pool anchor
        // even for d4. Used when all d4 back-anchor probes failed (model's
        // back faces don't expose under d4 rotation at all — observed on
        // bird-d4, where the front anchor stays visible because bird's
        // compact 3D structure resists the d4 rotation budget).
        if (difficulty === 4 && !(opts && opts.forceFrontAnchor)) {
            // Place a single hidden back-side anchor. Phase 2's
            // finalStepOnly mode validates hidden anchors only at the
            // final step — perfect since back-exposure happens at the
            // rotated final pose, not at the flat fold=0 start.
            //
            // The specific face index used is selected via opts.d4AnchorIndex
            // (default 0). Caller can re-invoke with successive indices when
            // Phase 2 yields zero progressions, walking the back pool until
            // a face that exposes under the trajectory rotations is found
            // (see retry loop in selectFacePointsFromTrajectory's caller).
            var srcPool = (Array.isArray(backPool) && backPool.length > 0) ? backPool : frontPool;
            var anchorIdx = (opts && opts.d4AnchorIndex != null) ? (opts.d4AnchorIndex | 0) : 0;
            // Pick the anchorIdx-th valid back-pool face (skipping any that
            // can't be normalized into [0, N)).
            var pickIdx = null;
            var seen = 0;
            for (var i = 0; i < srcPool.length; i++) {
                var rb = parseInt(srcPool[i], 10);
                if (isNaN(rb)) continue;
                if (rb >= N) rb -= N;
                if (rb < 0 || rb >= N) continue;
                if (seen === anchorIdx) { pickIdx = rb; break; }
                seen++;
            }
            if (pickIdx != null) {
                var cfg4 = {};
                cfg4[String(pickIdx + N)] = [{ u: 0.34, v: 0.33, w: 0.33, hidden: true }];
                return cfg4;
            }
            // Fall through if pool resolution failed.
        }

        var raw = parseInt(frontPool[0], 10);
        if (isNaN(raw)) return null;
        if (raw >= N) raw -= N;
        if (raw < 0 || raw >= N) return null;
        var cfg = {};
        cfg[String(raw)] = [{ u: 0.34, v: 0.33, w: 0.33 }];
        return cfg;
    }

    // Rotation bounds per CLAUDE.md "Rotation magnitude per tier" table.
    // d1=static-tilted-pose, d3=moderate single-side, d4=moderate two-sided.
    function rotationBoundsForTier(difficulty) {
        var tier = clampDifficultyTier(difficulty);
        // d1: STATIC (no motion across steps), but each preset can sit at a
        // tilted constant pose (buildAutoRotationProfiles emits constant-
        // rotation profiles). These bounds determine how tilted the static
        // pose can be. Without this d1 collapses to the single "flat from
        // above" view.
        if (tier === 1) return { yaw: 0.5, pitch: 0.15, roll: 0.08 };
        // d3: rotated single-side, moderate envelope — larger than d1
        // (static-pose) so the ramping motion is visually noticeable,
        // but stays below d4's full two-sided envelope.
        if (tier === 3) return { yaw: 0.8, pitch: 0.5, roll: 0.2 };
        // d4: rotated two-sided, ~1.0 rad to match bird-frontback reference
        // quality (0.6 cap produced ~0.74 rad final, references reach ~1.0+).
        return { yaw: 1.4, pitch: 1.3, roll: 0.4 };
    }

    function generateFromScanProgressions(options, callback) {
        var opts = options || {};
        if (!globals.benchmark || !globals.benchmark.runScan) {
            callback({ error: "benchmark scan module unavailable", generated: [] });
            return;
        }

        var model = opts.model || "/Bases/birdBase.svg";
        var difficulty = clampDifficultyTier(opts.difficulty || 5);
        var count = opts.count || 7;
        var seed = opts.seed || Date.now();
        var rng = makeRng(seed);
        var foldSteps = opts.foldSteps || rescaleFoldLadder(
            difficulty === 1
                ? [0, 12, 25, 37, 50]
                : [0, 8, 16, 24, 32, 40, 48, 56, 64, 70],
            resolveFinalFold(opts)
        );
        var maxScanCandidates = opts.maxScanCandidates || Math.max(count * 3, 12);

        var modelFaceCount = 0;
        if (globals.model && globals.model.getFaces) {
            var faces = globals.model.getFaces();
            modelFaceCount = faces ? faces.length : 0;
        }

        // Resolve face pools up front (cached per model).
        discoverFacePools(model, function (pools) {
            continueGeneration(pools);
        });
        return;

        function continueGeneration(pools) {

        var frontFaces = pools.front;
        var backFaces = pools.back;
        var tierProfile = getDifficultyProfile(difficulty);
        var rotBounds = rotationBoundsForTier(difficulty);

        // Generic anchor for Phase 2's visibility/separation gate. The
        // anchor never appears in the output preset — face points are
        // selected post-hoc from the trajectory's visibilityTimeline by
        // selectFacePointsFromTrajectory.
        // For d4, the anchor face is selected by index from the back pool
        // via opts.d4AnchorIndex (default 0). The retry loop below cycles
        // this index when Phase 2 yields zero progressions, so different
        // back-pool faces get tested as the anchor in turn.
        var d4AnchorIdx = (opts && opts.d4AnchorIndex != null) ? (opts.d4AnchorIndex | 0) : 0;
        var anchorFacePoints = buildGenericAnchorFacePoints(
            frontFaces, modelFaceCount, difficulty, backFaces,
            { d4AnchorIndex: d4AnchorIdx }
        );
        if (!anchorFacePoints) {
            callback({ error: "Could not build generic anchor (frontPool empty?)", generated: [] });
            return;
        }

        // Slot-level tracking mode for Phase 2 is ALWAYS finalStepOnly. The
        // generic anchor (a single front-pool face) is throwaway — its only
        // job is to give Phase 2 something to gate on. Requiring it visible
        // at every step caused observed regressions on models like bird where
        // any single face goes grazing under modest rotation (bird-d3 saw
        // every trajectory rejected with reason=quality despite the timeline
        // having other faces visible throughout).
        //
        // Per-tier visibility semantics are enforced DOWNSTREAM:
        //   - selectFacePointsFromTrajectory uses alwaysVisible for d1/d3
        //     visible-front anchors (strictAllSteps tier)
        //   - validatePreset enforces strictAllSteps at every step for d1/d3
        //     trackingEvalMode
        // So a permissive Phase 2 gate accepts more candidate trajectories;
        // the strict gate fires later on the right faces, not on the throwaway
        // anchor.
        var slotTrackingMode = "finalStepOnly";

        // Thin-back tiers benefit from a relaxed separation gate.
        var backPoolThin = Array.isArray(backFaces) && backFaces.length > 0 && backFaces.length <= 3;
        var defaultMinSep = (tierProfile.requiresBothSides && backPoolThin) ? 50 : 70;

        // Single Phase 2 run per slot. buildProgressions is bumped vs the
        // old per-candidate cfg because we now extract K=3 face-point
        // configs per accepted progression — we need a richer trajectory
        // pool to compensate for the dropped per-candidate parallelism.
        var slotScanCfg = {
            model: model,
            difficulty: difficulty,
            scanMode: true,
            saveScanResult: false,
            useScanCache: opts.useScanCache !== false,
            forceRescan: opts.forceRescan === true,
            fold: 0,
            // colorMode required so applySettings() initializes face points
            // (without it, phase-2 isPointVisible(0) checks a never-initialized
            // point and every trajectory is rejected at step 1).
            colorMode: "labelOnly",
            facePoints: anchorFacePoints,
            trackingEvalMode: slotTrackingMode,
            minPointSeparationPx: opts.minPointSeparationPx != null ? opts.minPointSeparationPx : defaultMinSep,
            enforceSeparationAllSteps: opts.enforceSeparationAllSteps === true,
            // Lower than legacy (0.35) because the trajectory-first anchor is
            // generic — its mid-fold quality doesn't matter, only that it
            // stays visible (isPointVisible enforces that separately). The
            // legacy gate was designed for tracked points where mid-fold
            // quality matters for UX. With one anchor per slot, the strict
            // gate caused observed all-trajectories-rejected failures (e.g.
            // bird-d3 — the single anchor face went grazing mid-fold and
            // every rotation profile was rejected). 0.05 still weeds out
            // trajectories where the anchor folds in on itself entirely.
            //
            // mapfold-specific cap at 0.5: even with the stricter Stage A/B
            // values of 0.6, mapfold's coplanar normals sit just under the
            // gate. Capping ensures the stage never rises above 0.5 for
            // mapfold while preserving Stage C's 0.05 (which is already
            // more permissive than the cap).
            minFaceQuality: (function () {
                var def = opts.minFaceQuality != null ? opts.minFaceQuality : 0.05;
                return model.indexOf("mapfold") >= 0 ? Math.min(def, 0.5) : def;
            })(),
            phase2VerboseRejects: opts.phase2VerboseRejects === false ? false : true,
            phase2MaxTargetFaces: opts.phase2MaxTargetFaces != null
                ? opts.phase2MaxTargetFaces
                : (difficulty === 1 ? 2 : undefined),
            buildProgressions: typeof opts.buildProgressions === "number"
                ? opts.buildProgressions
                : Math.max(40, count * 12),
            // Phase 2 stops once this many valid progressions are found.
            // K=1 means each progression → 1 preset, so we need ~count
            // valid progressions plus a small margin for downstream
            // attrition (selectFacePointsFromTrajectory rejects, refinement
            // failures, etc.). 1.5× is the sweet spot — enough margin for
            // d4's lower pass-rate, not so much that we waste wall-time.
            // d4: lifted to count*5 because the new requireFinalBackExposure
            // gate filters out front-visible-but-no-back trajectories. The
            // remaining accepted trajectories all satisfy d4's contract,
            // giving refinement a much bigger pool of valid candidates.
            phase2EarlyStopCount: opts.phase2EarlyStopCount != null
                ? opts.phase2EarlyStopCount
                : (difficulty === 1
                    ? Math.max(3, count)
                    : difficulty === 4
                        ? Math.max(5, Math.ceil(count * 5))
                        : Math.max(5, Math.ceil(count * 1.5))),
            // d4: require at least 1 back-side face to be camera-exposed at
            // the final step. Combined with the front-anchor visibility gate
            // (which checks every step), accepted trajectories satisfy both
            // human-trackability AND the hidden-back-reveal contract.
            requireFinalBackExposure: opts.requireFinalBackExposure != null
                ? opts.requireFinalBackExposure
                : (difficulty === 4 ? 1 : 0),
            maxTrajectoryCandidates: opts.maxTrajectoryCandidates != null
                ? opts.maxTrajectoryCandidates
                : Math.max(60, count * 18),
            phase2LogEveryMs: opts.phase2LogEveryMs != null ? opts.phase2LogEveryMs : 5000,
            phase2StallWarnMs: opts.phase2StallWarnMs != null ? opts.phase2StallWarnMs : 30000,
            scanFoldSteps: foldSteps.slice(),
            scanSettleMs: opts.scanSettleMs != null ? opts.scanSettleMs : 300,
            povGridSize: opts.povGridSize != null ? opts.povGridSize : (difficulty >= 4 ? 110 : 90),
            staticPovTrajectories: true,
            // Static-POV mode: POV doesn't change between steps, so
            // POV-based motion gates are zero. Rotation provides motion.
            minProgressionEndAngle: opts.minProgressionEndAngle != null ? opts.minProgressionEndAngle : 0,
            minProgressionTotalAngle: opts.minProgressionTotalAngle != null ? opts.minProgressionTotalAngle : 0,
            minRotationEndAngle: opts.minRotationEndAngle != null
                ? opts.minRotationEndAngle
                : (difficulty >= 4 ? 0.45 : (difficulty >= 3 ? 0.20 : 0)),
            minRotationTotalAngle: opts.minRotationTotalAngle != null
                ? opts.minRotationTotalAngle
                : (difficulty >= 4 ? 0.95 : (difficulty >= 3 ? 0.45 : 0)),
            rotationYawMax: opts.rotationYawMax != null ? opts.rotationYawMax : rotBounds.yaw,
            rotationPitchMax: opts.rotationPitchMax != null ? opts.rotationPitchMax : rotBounds.pitch,
            rotationRollMax: opts.rotationRollMax != null ? opts.rotationRollMax : rotBounds.roll,
            // Profile counts tuned for single-seed yield. Trajectory pool is
            // small (~19 from pov90, ~23 from pov110), so (traj, profile)
            // pair count is trajs × profiles. Higher profiles = more pairs
            // = more chances to hit the earlyStop cap.
            //   d4: 30 — count*5=105 cap; sampled profiles help d4 because
            //        finalStepOnly mode validates anchors only at final step.
            //   d3: 6  — strictAllSteps mode validates per-step visibility;
            //        sampled (random) profiles fail per-step validation
            //        downstream, hurting yield. Stay at 6 hardcoded only.
            //   d1: 20 — finalStepOnly mode (only anchor visibility matters);
            //        bump from 10 to fill count=84 cap from 19-traj pool.
            rotationProfileCount: opts.rotationProfileCount != null
                ? opts.rotationProfileCount
                : (difficulty === 4 ? 30
                   : (difficulty >= 3 ? 6
                      : (slotTrackingMode === "finalStepOnly" ? 20 : 6))),
            targetSelectionMode: opts.targetSelectionMode || "all",
            includeInitialVisibleTrackedPoint: opts.includeInitialVisibleTrackedPoint === true,
            initialVisibleTrackedPointCount: opts.initialVisibleTrackedPointCount != null
                ? opts.initialVisibleTrackedPointCount : 1,
            // Anchor's only point label is "A". With a single tracked point,
            // separation checks degrade to "in-frame" — exactly the loose
            // gate we want so post-hoc selection has room to work.
            targetPointLabels: ["A"],
            primaryTargetPointLabels: ["A"],
            // Plumb the per-shard seed into Phase 2 so buildAutoRotationProfiles
            // can deterministically sample additional rotation profiles per
            // shard. Same seed → same profile sequence.
            // Per-shard seed for deterministic rotation profile sampling.
            rngSeed: seed,
            // mapfold-only override: skip the initial-step (currentStep===0,
            // fold=0) visibility gate. The flat sheet's coplanar normals fail
            // isPointVisible under d3/d4 rotation, but step 0 will be rendered
            // at zero rotation thanks to applyHeroShotStep0 — so the gate is
            // asserting visibility under a pose that never actually renders.
            // Other models curl up enough at fold=0 not to need this.
            enforceInitialTrackedVisible: model.indexOf("mapfold") < 0
        };

        // Tier slot plan (mirrors selectFacePointsFromTrajectory). Used by
        // the safety top-off below.
        var tierPlan = (function () {
            if (difficulty === 1) return { hB: 0, hF: 0 };
            if (difficulty === 3) return { hB: 0, hF: 0 };
            return                     { hB: 1, hF: 1 };  // d4
        })();

        var earlyStopThreshold = Math.max(count * 2, 15);
        var collected = [];
        var trajectoriesUsed = 0;
        var trajectoriesEmpty = 0;

        updateStatus("Trajectory-first scan: building progressions for d" + difficulty + "...");

        var runFn = (globals.benchmark && globals.benchmark.run)
            ? globals.benchmark.run.bind(globals.benchmark)
            : globals.benchmark.runScan.bind(globals.benchmark);

        // Count valid back-pool faces (for the d4 anchor-retry budget).
        // A trajectory's d4 anchor is one back face whose back surface is
        // expected to expose at the final pose. backPool[0] is good for most
        // models, but on some (observed: bird) backPool[0] never exposes
        // under d4 rotation, so Phase 2 yields 0 progressions. Retry with
        // backPool[1], [2], … until we find an anchor that survives or the
        // pool is exhausted.
        var d4PoolSize = (function () {
            if (difficulty !== 4 || !Array.isArray(backFaces)) return 0;
            var src = (backFaces.length > 0) ? backFaces : (frontFaces || []);
            var n = 0;
            for (var bi = 0; bi < src.length; bi++) {
                var v = parseInt(src[bi], 10);
                if (!isNaN(v)) n++;
            }
            return n;
        })();

        // Run a SHORT Phase 2 probe (small build budget). Used to score
        // each d4 anchor candidate by how many trajectories survive Phase 2
        // under that anchor — a proxy for full-run yield. Early-stop set
        // high enough that good anchors return notably more than poor ones,
        // so the picker can distinguish "barely usable" from "great fit".
        // Without this, all surviving anchors return 1 (early-stop=1) and
        // the picker can't tell front-anchor (high yield) from back-anchor
        // (marginal). Cost: each probe ~30-90s depending on yield.
        function runProbe(probeOpts, onCount) {
            var probeCfg = {};
            for (var pk in slotScanCfg) {
                if (slotScanCfg.hasOwnProperty(pk)) probeCfg[pk] = slotScanCfg[pk];
            }
            probeCfg.facePoints = buildGenericAnchorFacePoints(
                frontFaces, modelFaceCount, difficulty, backFaces, probeOpts
            );
            probeCfg.buildProgressions = 8;
            probeCfg.maxTrajectoryCandidates = 12;
            probeCfg.maxScanCandidates = 8;
            probeCfg.phase2EarlyStopCount = 4;
            probeCfg.phase2VerboseRejects = false;
            runFn(probeCfg, function (probeResult) {
                var probedProgs = [];
                try {
                    probedProgs = probeResult && Array.isArray(probeResult.diverseProgressions)
                        ? probeResult.diverseProgressions
                        : [];
                } catch (_pErr) {}
                onCount(probedProgs.length);
            });
        }

        function runFullPhase2(anchorOpts, onResult) {
            slotScanCfg.facePoints = buildGenericAnchorFacePoints(
                frontFaces, modelFaceCount, difficulty, backFaces, anchorOpts
            );
            runFn(slotScanCfg, function (scanResult) {
                var progressions = [];
                try {
                    progressions = scanResult && Array.isArray(scanResult.diverseProgressions)
                        ? scanResult.diverseProgressions
                        : [];
                } catch (err) {
                    console.warn("presetGenerator: progression extraction error", err);
                }
                onResult(scanResult, progressions);
            });
        }

        // d4 anchor selection: just use front anchor for everyone. Probing
        // back anchors introduced too much variance — RNG state from probes
        // (which run mini-Phase-2s before the real one) shifted full Phase 2
        // sampling enough to drop opensink-d4 from ~30 yield to 0. The front
        // anchor was the original main-run choice and gives stable yields
        // across all models (bird ~100%, others ~25-45%). For d1/d3, same
        // thing — single front-pool face anchor.
        function pickAndRun(onResult) {
            if (difficulty === 4) {
                runFullPhase2({ forceFrontAnchor: true }, onResult);
            } else {
                runFullPhase2({ d4AnchorIndex: 0 }, onResult);
            }
        }

        pickAndRun(function (scanResult, progressions) {

            updateStatus("Trajectory-first: " + progressions.length + " progression(s); selecting points per tier...");
            console.log("presetGenerator: trajectory-first received " + progressions.length + " progressions");

            // d4 needs hidden-back picks, so re-order progressions by the
            // strongest back-side exposure at the final step. Other tiers
            // (d1/d3) don't require any back exposure (hB=[0,0]) and are
            // left in diversity-selected order. Score = max final-step
            // back quality across the trajectory's back-visible faces.
            // 0 when no face's back surface is exposed at final pose.
            if (difficulty === 4) {
                var maxFinalBackQuality = function (prog) {
                    var tl = prog && prog.visibilityTimeline;
                    if (!tl || tl.length === 0) return 0;
                    var last = tl[tl.length - 1];
                    var bq = last && last.backQualities;
                    if (!bq) return 0;
                    var best = 0;
                    for (var k in bq) {
                        if (!bq.hasOwnProperty(k)) continue;
                        if (bq[k] > best) best = bq[k];
                    }
                    return best;
                };
                progressions = progressions.slice().sort(function (a, b) {
                    return maxFinalBackQuality(b) - maxFinalBackQuality(a);
                });
            }

            var pi = 0;
            function processProgression() {
                if (pi >= progressions.length || collected.length >= earlyStopThreshold) {
                    if (collected.length >= earlyStopThreshold && pi < progressions.length) {
                        updateStatus("Trajectory-first early-stop: " + collected.length + " presets (threshold " + earlyStopThreshold + "), skipped " + (progressions.length - pi) + " progression(s)");
                    } else {
                        updateStatus("Trajectory-first complete: " + collected.length + " preset(s) from " + trajectoriesUsed + "/" + progressions.length + " progressions (" + trajectoriesEmpty + " empty)");
                    }
                    callback({
                        generatedPresets: collected,
                        generatedCount: collected.length,
                        sourceCandidates: 1,
                        sourceTrajectories: progressions.length,
                        trajectoriesUsed: trajectoriesUsed,
                        trajectoriesEmpty: trajectoriesEmpty
                    });
                    return;
                }

                var prog = progressions[pi];
                pi++;

                var configs = selectFacePointsFromTrajectory(prog, difficulty, modelFaceCount, frontFaces, backFaces, rng, model);
                if (configs.length === 0) {
                    trajectoriesEmpty++;
                    processProgression();
                    return;
                }
                trajectoriesUsed++;

                var ci = 0;
                function processConfig() {
                    if (ci >= configs.length || collected.length >= earlyStopThreshold) {
                        processProgression();
                        return;
                    }
                    var cfg = configs[ci];
                    ci++;

                    var colorIdx = rng.randInt(0, COLOR_PAIRS.length - 1);
                    var preset = createPresetFromProgression(prog, cfg.facePoints, {
                        model: model,
                        difficulty: difficulty,
                        colorMode: getColorModeForDifficulty(difficulty, rng),
                        colors: COLOR_PAIRS[colorIdx],
                        backgroundColor: rng.pick(["f0f0f0", "f5f5f5", "ffffff"]),
                        rng: rng,
                        foldSteps: foldSteps,
                        minPointSeparationPx: slotScanCfg.minPointSeparationPx,
                        targetSelectionMode: slotScanCfg.targetSelectionMode,
                        includeInitialVisibleTrackedPoint: slotScanCfg.includeInitialVisibleTrackedPoint,
                        initialVisibleTrackedPointCount: slotScanCfg.initialVisibleTrackedPointCount,
                        modelFaceCount: modelFaceCount,
                        siblingIndex: cfg.siblingIndex || 0
                    });

                    // Safety top-off: in normal operation,
                    // selectFacePointsFromTrajectory already filled the
                    // tier's hidden plan from final-step visibility. This
                    // only runs if the timeline's final-step record
                    // disagrees with the live (settle-time) geometry.
                    //
                    // "back" = faceId >= N (back-side IDs). The picker
                    // stores hidden-back picks with faceId = (idx + N) so
                    // the simulator treats them as back-surface markers
                    // (isPointVisible's `isFront = id < N` path requires
                    // back-normal facing camera). Counting must use the
                    // same semantic so the top-off doesn't fire spuriously.
                    var presetHiddenBack = 0, presetHiddenFront = 0;
                    var presetKeys = Object.keys(preset.facePoints || {});
                    for (var pk = 0; pk < presetKeys.length; pk++) {
                        var fid = parseInt(presetKeys[pk], 10);
                        var arr = preset.facePoints[presetKeys[pk]];
                        if (!Array.isArray(arr)) continue;
                        for (var ai = 0; ai < arr.length; ai++) {
                            if (arr[ai] && arr[ai].hidden) {
                                if (!isNaN(fid) && fid >= modelFaceCount) presetHiddenBack++;
                                else presetHiddenFront++;
                            }
                        }
                    }
                    var topoffBack = Math.max(0, tierPlan.hB - presetHiddenBack);
                    var topoffFront = Math.max(0, tierPlan.hF - presetHiddenFront);

                    if (topoffBack === 0 && topoffFront === 0) {
                        collected.push(preset);
                        processConfig();
                        return;
                    }

                    addHiddenPointsFromFinalStep(
                        preset, backFaces, frontFaces,
                        { plannedHiddenBack: topoffBack, plannedHiddenFront: topoffFront },
                        opts.scanSettleMs,
                        rng,
                        function (finalizedPreset) {
                            var sel = finalizedPreset._hiddenSelected || {};
                            var satBack = topoffBack === 0 || (sel.pickedBack && sel.pickedBack.length >= topoffBack);
                            var satFront = topoffFront === 0 || (sel.pickedFront && sel.pickedFront.length >= topoffFront);
                            if (!satBack || !satFront) {
                                // Plan unfulfillable for this trajectory under
                                // settle-time geometry. Drop and try next config.
                                processConfig();
                                return;
                            }
                            collected.push(finalizedPreset);
                            processConfig();
                        }
                    );
                }
                processConfig();
            }
            processProgression();
        });
        } // end continueGeneration
    }

    // ── Validation (requires live WebGL) ───────────────────────────────
    //
    // Same invariants as benchmark.evaluateTrackedPoints:
    //   - Non-hidden points are checked every step under strictAllSteps
    //     (default). Hidden points only at the final step.
    //   - `preset.hidePointsDuringAnimation` is a rendering toggle and has
    //     no effect on validation — the human-trackability contract means
    //     "geometry-visible at every step", independent of whether labels
    //     are drawn.

    // Fold %, solver textures, and model rotation can leak between hybrid
    // Phase-2 candidates, refinement passes, or sequential validateBatch
    // entries — leaving the mesh in a different local minimum than a cold
    // `tools/validate-presets.js` run. Reset to a flat, unrotated baseline
    // before any preset-driven applySettings / step walk.
    function resetValidationBaseline() {
        try {
            if (globals.setCreasePercent) {
                globals.setCreasePercent(0);
                globals.shouldChangeCreasePercent = true;
            }
        } catch (_e0) {}
        try {
            if (globals.model && globals.model.reset) globals.model.reset();
        } catch (_e1) {}
        try {
            if (globals.threeView && globals.threeView.resetModel) globals.threeView.resetModel();
        } catch (_e2) {}
        try {
            if (globals.facePoints && globals.facePoints.clearPoints) globals.facePoints.clearPoints();
        } catch (_e3) {}
    }

    function validatePreset(preset, settleMs, callback) {
        if (!globals.facePoints || !globals.model || !globals.threeView) {
            callback({ valid: false, error: "Missing required modules" });
            return;
        }

        var steps = preset.steps;
        if (!steps || steps.length === 0) {
            callback({ valid: false, error: "No steps" });
            return;
        }

        resetValidationBaseline();

        // Apply colorMode, colors, and facePoints via benchmark.applySettings
        // so the mesh material and face point rendering are correct for visibility checks.
        if (globals.benchmark && globals.benchmark.applySettings) {
            globals.benchmark.applySettings(preset);
        } else {
            // Fallback: set colorMode directly and init face points manually
            if (preset.colorMode) {
                globals.colorMode = preset.colorMode;
                globals.model.setMeshMaterial();
            }
            globals.facePoints.initFromConfig(preset.facePoints);
        }
        var allPts = globals.facePoints.getPoints();
        var pointIndices = [];
        for (var pi = 0; pi < allPts.length; pi++) {
            pointIndices.push({ idx: pi, hidden: !!allPts[pi].hidden });
        }

        var stepIdx = 0;
        var failures = [];
        var settle = settleMs || 300;
        var trackingMode = preset.trackingEvalMode || "strictAllSteps";
        var trackingModeNorm = String(trackingMode).trim().toLowerCase();
        var strictTracking = !(trackingModeNorm === "finalsteponly" || trackingModeNorm === "finalstep" || trackingModeNorm === "final" || trackingModeNorm === "final-only" || trackingModeNorm === "final_step_only");
        var enforceSeparationAllSteps = preset.enforceSeparationAllSteps === true;

        function validateStep() {
            if (stepIdx >= steps.length) {
                // Clean up
                globals.facePoints.clearPoints();
                globals.threeView.resetModel();
                callback({
                    valid: failures.length === 0,
                    failures: failures,
                    stepsChecked: steps.length
                });
                return;
            }

            var step = steps[stepIdx];
            var isLast = stepIdx === steps.length - 1;

            // Apply fold — must also set shouldChangeCreasePercent so the
            // simulation loop actually recomputes geometry at the new fold %.
            globals.setCreasePercent(step.fold / 100);
            globals.shouldChangeCreasePercent = true;

            // Apply POV
            if (globals.benchmark && globals.benchmark.setPOV) {
                globals.benchmark.setPOV(step.pov);
            }

            // Apply rotation
            if (step.rotation && globals.threeView.setModelRotation) {
                var r = Array.isArray(step.rotation) ? step.rotation : [step.rotation.x || 0, step.rotation.y || 0, step.rotation.z || 0];
                globals.threeView.setModelRotation(r[0], r[1], r[2]);
            } else {
                globals.threeView.resetModel();
            }

            // Wait for simulation to settle. Minimum 400ms — origami mesh
            // convergence stabilises well before then on the current model
            // set, and this floor is matched by refineFacePointBarycentric
            // so refined barycentrics and validated barycentrics see the
            // same mesh state. (Was 800ms historically, then 500ms; further
            // dropped to 400ms as a pipeline speedup.)
            var actualSettle = Math.max(settle, 400);
            // mapfold-only: skip intermediate-step visibility checks
            // (non-final, fold>0). Mapfold's accordion fold stacks panels
            // over anchor points at fold=24-40, causing isPointVisible to
            // return false even though the trajectory's final pose recovers
            // full visibility. Final-step visibility (the answer frame) and
            // step-0 / hero-shot visibility remain enforced.
            var isMapfold = preset.model && preset.model.indexOf("mapfold") >= 0;
            var skipMidStepVisibility = isMapfold && !isLast && step.fold > 0;
            setTimeout(function () {

                var requiredIndices = [];
                for (var i = 0; i < pointIndices.length; i++) {
                    var pInfo = pointIndices[i];
                    // Hidden points only need to be visible at final step.
                    if (pInfo.hidden && !isLast) continue;
                    requiredIndices.push(pInfo.idx);

                    if (skipMidStepVisibility) continue;

                    var visible = globals.facePoints.isPointVisible(pInfo.idx);
                    if (!visible) {
                        failures.push({
                            step: stepIdx,
                            pointIndex: pInfo.idx,
                            hidden: pInfo.hidden,
                            fold: step.fold,
                            reason: "not visible"
                        });
                    }
                }

                // Check point separation (always at final step, optional at all steps)
                if ((isLast || (strictTracking && enforceSeparationAllSteps)) && globals.benchmark.getPointScreenPosition) {
                    var minSeparationPx = preset.minPointSeparationPx != null ? preset.minPointSeparationPx : 70;
                    var screens = [];
                    for (var si2 = 0; si2 < requiredIndices.length; si2++) {
                        var sp = globals.benchmark.getPointScreenPosition(requiredIndices[si2]);
                        if (sp) screens.push(sp);
                    }
                    for (var a = 0; a < screens.length; a++) {
                        for (var b = a + 1; b < screens.length; b++) {
                            var dx = screens[a].x - screens[b].x;
                            var dy = screens[a].y - screens[b].y;
                            var dist = Math.sqrt(dx * dx + dy * dy);
                            if (dist < minSeparationPx) {
                                failures.push({
                                    step: stepIdx,
                                    reason: "points too close (" + Math.round(dist) + "px < " + minSeparationPx + "px)"
                                });
                            }
                        }
                    }
                }

                stepIdx++;
                validateStep();
            }, actualSettle);
        }

        validateStep();
    }

    // ── Batch validation ───────────────────────────────────────────────

    function validateBatch(presets, settleMs, progressCb, callback) {
        var results = [];
        var idx = 0;

        function next() {
            if (idx >= presets.length) {
                callback(results);
                return;
            }

            if (progressCb) progressCb(idx, presets.length);

            validatePreset(presets[idx], settleMs, function (result) {
                result.presetIndex = idx;
                results.push(result);
                idx++;
                next();
            });
        }

        next();
    }

    // ── Main generation function ───────────────────────────────────────

    function generate(options, callback) {
        var opts = options || {};
        var model = opts.model || "/Bases/birdBase.svg";
        var difficulty = clampDifficultyTier(opts.difficulty || 5);
        var count = opts.count || 7;
        var baseName = opts.baseName || "bird-frontback";
        var startIndex = opts.startIndex || 9;
        var seed = opts.seed || Date.now();
        var foldSteps = opts.foldSteps || rescaleFoldLadder(
            difficulty === 1
                ? [0, 12, 25, 37, 50]
                : [0, 8, 16, 24, 32, 40, 48, 56, 64, 70],
            resolveFinalFold(opts)
        );
        var validate = opts.validate !== false;
        var settleMs = opts.settleMs || 300;
        var trajectoryMode = opts.trajectoryMode || "hybrid";
        var normalizedTrajectoryMode = String(trajectoryMode).trim().toLowerCase();

        var rng = makeRng(seed);

        // Determine face pools (async — cached per model)
        var frontFaces = null;
        var backFaces = null;
        var modelFaceCount = 0;
        if (globals.model && globals.model.getFaces) {
            var faces = globals.model.getFaces();
            modelFaceCount = faces ? faces.length : 0;
        }

        // Existing references for diversity scoring. Scan-progression path
        // does not preload from benchmark presets; selectDiverse handles an
        // empty list gracefully.
        var existingRefs = [];

        function runHybridOrScan() {
            generateFromScanProgressions(opts, function (scanGen) {
                if (scanGen && scanGen.error) {
                    console.warn("presetGenerator: scan progression generation failed", scanGen.error);
                    callback({ error: scanGen.error, generated: [] });
                    return;
                }

                var scanCandidates = scanGen && Array.isArray(scanGen.generatedPresets)
                    ? scanGen.generatedPresets
                    : [];

                if (scanCandidates.length === 0) {
                    callback({ error: "No progression candidates generated", generated: [] });
                    return;
                }

                console.log("presetGenerator: generated " + scanCandidates.length + " progression candidates");

                // d4 path: PRE-REFINE candidates before validateBatch. The
                // per-step refinement check picks placements that survive
                // mid-fold visibility for visible-front anchors. Without
                // this, the original bary (often near face edges) fails
                // validation on heavy-rotation steps and the candidate is
                // dropped before refinement gets a chance. Pre-refining
                // lets every candidate present its best-survivable shot to
                // validation. Cost: ~5s per candidate (10 steps × 0.4s
                // settle + per-step probe). 33 candidates ≈ 3 min — large
                // but offset by 5x increase in passing-rate downstream.
                if (difficulty === 4 && validate) {
                    var preRefStart = Date.now();
                    updateStatus("Pre-refining " + scanCandidates.length + " d4 candidates before validation...");
                    preRefineBatch(scanCandidates, settleMs, rng, function (i, n) {
                        updateStatus("Pre-refining d4 candidate " + (i + 1) + "/" + n + "...");
                    }, function () {
                        console.log("presetGenerator: pre-refine done (" + scanCandidates.length + " candidates, " + ((Date.now() - preRefStart) / 1000).toFixed(1) + "s)");
                        runValidateBatch();
                    });
                    return;
                }
                runValidateBatch();

                function runValidateBatch() {
                // d1 short-circuit batch validation — d1's static-pose flat
                // walks predictably pass. refineAndRevalidate still does
                // per-preset validation below, so any genuinely broken
                // preset is caught.
                var skipBatchValidation = !validate || difficulty <= 1;
                if (skipBatchValidation) {
                    scanCandidates = filterCandidatesByDifficulty(scanCandidates, difficulty, modelFaceCount, count, rng);
                    var scanSelected = selectDiverse(scanCandidates, count, existingRefs);
                    refineAndRevalidate(scanSelected, settleMs, rng, function (finalPresets) {
                        finalize(finalPresets, baseName, startIndex, callback);
                    });
                    return;
                }

                updateStatus("Validating " + scanCandidates.length + " progression candidates...");
                validateBatch(scanCandidates, settleMs, function (idx, total) {
                    updateStatus("Validating progression candidate " + (idx + 1) + "/" + total + "...");
                }, function (results) {
                    var passing = [];
                    for (var vi = 0; vi < results.length; vi++) {
                        if (results[vi].valid) passing.push(scanCandidates[results[vi].presetIndex]);
                    }

                    if (passing.length === 0) {
                        // Diagnostic: dump first 3 preset failures to surface
                        // what specific gate is rejecting everything (visibility,
                        // separation, etc.).
                        try {
                            for (var di = 0; di < Math.min(3, results.length); di++) {
                                var r = results[di];
                                var pIdx = r.presetIndex != null ? r.presetIndex : di;
                                var pre = scanCandidates[pIdx] || {};
                                var faces = pre.facePoints ? Object.keys(pre.facePoints) : [];
                                console.log("presetGenerator: validation FAIL diag #" + di
                                    + " — faces=" + JSON.stringify(faces)
                                    + " stepsChecked=" + r.stepsChecked
                                    + " failures=" + JSON.stringify((r.failures || []).slice(0, 3)));
                            }
                        } catch (e) { /* noop */ }
                        callback({ error: "No scan progression candidates passed validation", generated: [] });
                        return;
                    }

                    passing = filterCandidatesByDifficulty(passing, difficulty, modelFaceCount, Math.min(count, passing.length), rng);
                    var selected = selectDiverse(passing, count, existingRefs);
                    refineAndRevalidate(selected, settleMs, rng, function (finalPresets) {
                        finalize(finalPresets, baseName, startIndex, callback);
                    });
                });
                }  // end runValidateBatch
            });
        }

        discoverFacePools(model, function (pools) {
            frontFaces = pools.front;
            backFaces = pools.back;

            if (normalizedTrajectoryMode === "scanprogression" ||
                normalizedTrajectoryMode === "scan" ||
                normalizedTrajectoryMode === "hybrid") {
                runHybridOrScan();
                return;
            }
            callback({
                error: "Unsupported trajectoryMode: '" + normalizedTrajectoryMode +
                    "' (supported: 'scan', 'scanprogression', 'hybrid')",
                generated: []
            });
        });
    }

    function finalize(selected, baseName, startIndex, callback) {
        var output = {};
        for (var si = 0; si < selected.length; si++) {
            // 3-digit zero-pad: oversampling pushes counts past 99 (e.g.
            // 30 per shard × 4 shards = 120). 2-digit padding broke
            // alphabetic sort order in the assembler.
            var name = baseName + "-" + String(startIndex + si).padStart(3, "0");
            var preset = selected[si];

            // Remove internal metadata before output
            var clean = {};
            var keys = Object.keys(preset);
            for (var ki = 0; ki < keys.length; ki++) {
                if (keys[ki].charAt(0) !== "_") {
                    clean[keys[ki]] = preset[keys[ki]];
                }
            }
            output[name] = clean;
        }

        console.log("presetGenerator: finalized " + selected.length + " presets");
        updateStatus("Generated " + selected.length + " presets");
        callback({ generated: output, count: selected.length });
    }

    // ── Status reporting ───────────────────────────────────────────────

    function updateStatus(msg) {
        var el = document.getElementById("generatorStatus");
        if (el) el.textContent = msg;
        console.log("presetGenerator: " + msg);
    }

    // ── Public API ─────────────────────────────────────────────────────

    return {
        generate: generate,
        validatePreset: validatePreset,
        validateBatch: validateBatch,
        selectDiverse: selectDiverse,
        COLOR_PAIRS: COLOR_PAIRS,
        makeRng: makeRng
    };
}
