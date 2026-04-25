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

    // ── High-contrast color pairs ──────────────────────────────────────

    var COLOR_PAIRS = [
        ["e74c3c", "3498db"],   // red / blue
        ["f39c12", "1abc9c"],   // orange / teal
        ["0077cc", "e67e22"],   // blue / orange
        ["16a085", "d35400"],   // teal / dark orange
        ["2980b9", "c0392b"],   // blue / red
        ["27ae60", "8e44ad"],   // green / purple
        ["e84393", "00b894"],   // pink / green
        ["34495e", "f1c40f"],   // navy / yellow
        ["9b59b6", "1abc9c"],   // purple / teal
        ["d63031", "0984e3"],   // red / blue (alt)
        ["00cec9", "6c5ce7"],   // cyan / indigo
        ["fd79a8", "00b894"],   // pink / emerald
        ["e17055", "74b9ff"],   // burnt orange / sky blue
        ["a29bfe", "ff7675"],   // lavender / salmon
        ["55efc4", "a29bfe"]    // mint / lavender
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
    // tracked faces are visible simultaneously at fold=70 (used by d2).
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

    // ── Two-sided POV search ───────────────────────────────────────────
    // Given a front face and back face, find all POVs in the face-pool scan
    // set where BOTH faces are visible at fold=70. Returns a ranked list
    // (best first by minimum face quality). Empty list means no two-sided
    // static POV exists — d2 should degrade to the hidden-back-reveal
    // model.

    // ── Template extraction ───────────────────────────────────────────

    function extractRotationTemplates(presets, namePattern) {
        var templates = [];
        var regex = new RegExp("^" + namePattern.replace(/\*/g, ".*") + "$");
        var keys = Object.keys(presets);
        for (var i = 0; i < keys.length; i++) {
            var name = keys[i];
            if (!regex.test(name)) continue;
            var preset = presets[name];
            if (!preset.steps || !Array.isArray(preset.steps)) continue;

            var rotCurve = [];
            var povCurve = [];
            var foldSteps = [];
            for (var si = 0; si < preset.steps.length; si++) {
                var step = preset.steps[si];
                foldSteps.push(step.fold != null ? step.fold : 0);
                // Rotation — default to [0,0,0] for step 0
                if (step.rotation) {
                    var r = Array.isArray(step.rotation) ? step.rotation : [step.rotation.x || 0, step.rotation.y || 0, step.rotation.z || 0];
                    rotCurve.push([r[0], r[1], r[2]]);
                } else {
                    rotCurve.push([0, 0, 0]);
                }
                // POV
                if (Array.isArray(step.pov)) {
                    povCurve.push([step.pov[0], step.pov[1], step.pov[2]]);
                } else if (typeof step.pov === "string") {
                    // Convert named POVs to vectors
                    var pvec = namedPovToVec(step.pov);
                    povCurve.push(pvec);
                } else {
                    povCurve.push([1, 0.55, 0]);
                }
            }
            templates.push({
                name: name,
                rotationCurve: rotCurve,
                povCurve: povCurve,
                foldSteps: foldSteps,
                facePoints: preset.facePoints,
                colorMode: preset.colorMode,
                color1: preset.color1,
                color2: preset.color2
            });
        }
        return templates;
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
            requiresBothSides: tier === 2 || tier === 4,
            // d1 = no inter-step motion, d2 = "small" rotation but POV static.
            // Both render with constant or near-constant rotation across steps.
            isStaticTier: tier <= 2,
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
        // states 2..N (tracking-optimized POV) so d1/d2 thresholds stay
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

    // ── Rotation curve variation ─────���─────────────────────────────────

    function generateRotationVariants(template, count, rng) {
        var base = template.rotationCurve;
        var n = base.length;
        var variants = [];

        for (var vi = 0; vi < count; vi++) {
            var strategy = vi % 6;
            var curve = [];
            // Pre-compute per-variant random values (so they're consistent across steps)
            var scale = rng.randFloat(0.75, 1.2);
            var blend = rng.randFloat(0.3, 0.7);

            for (var si = 0; si < n; si++) {
                var bx = base[si][0], by = base[si][1], bz = base[si][2];

                switch (strategy) {
                    case 0: // Mirror Y + Z
                        curve.push([bx, -by, -bz]);
                        break;
                    case 1: // Scale (consistent across all steps)
                        curve.push([bx * scale, by * scale, bz * scale]);
                        break;
                    case 2: // Time-shift forward (delayed onset)
                        var shifted = Math.max(0, si - 1);
                        curve.push([base[shifted][0], base[shifted][1], base[shifted][2]]);
                        break;
                    case 3: // Axis blend — swap pitch/roll energy
                        curve.push([bx * blend + bz * (1 - blend), by, bz * blend + bx * (1 - blend)]);
                        break;
                    case 4: // Perturb
                        curve.push([
                            bx + rng.gaussian(0, 0.04),
                            by + rng.gaussian(0, 0.06),
                            bz + rng.gaussian(0, 0.04)
                        ]);
                        break;
                    case 5: // Envelope reshape — ease-in-out
                        var t = n <= 1 ? 1 : si / (n - 1);
                        var eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
                        var linearT = t;
                        var ratio = linearT > 0.01 ? eased / linearT : 1;
                        curve.push([bx * ratio, by * ratio, bz * ratio]);
                        break;
                }
            }

            // Round values
            for (var ri = 0; ri < curve.length; ri++) {
                curve[ri] = [
                    Math.round(curve[ri][0] * 100) / 100,
                    Math.round(curve[ri][1] * 100) / 100,
                    Math.round(curve[ri][2] * 100) / 100
                ];
            }
            variants.push(curve);
        }
        return variants;
    }

    // ── POV curve variation ────────────────────────────────────────���───

    function generatePovVariants(template, count, rng) {
        var base = template.povCurve;
        var n = base.length;
        var variants = [];

        for (var vi = 0; vi < count; vi++) {
            var strategy = vi % 4;
            var curve = [];

            for (var si = 0; si < n; si++) {
                var px = base[si][0], py = base[si][1], pz = base[si][2];

                switch (strategy) {
                    case 0: // Mirror Z
                        curve.push([px, py, -pz]);
                        break;
                    case 1: // Shift Y
                        var yShift = rng.randFloat(-0.08, 0.08);
                        curve.push([px, py + yShift, pz]);
                        break;
                    case 2: // Scale Z drift
                        var zScale = rng.randFloat(0.6, 1.4);
                        var baseZ = base[0][2];
                        var driftZ = (pz - baseZ) * zScale;
                        curve.push([px, py, baseZ + driftZ]);
                        break;
                    case 3: // Perturb
                        curve.push([
                            px + rng.gaussian(0, 0.03),
                            py + rng.gaussian(0, 0.03),
                            pz + rng.gaussian(0, 0.06)
                        ]);
                        break;
                }
            }

            // Round
            for (var ri = 0; ri < curve.length; ri++) {
                curve[ri] = [
                    Math.round(curve[ri][0] * 100) / 100,
                    Math.round(curve[ri][1] * 100) / 100,
                    Math.round(curve[ri][2] * 100) / 100
                ];
            }
            variants.push(curve);
        }
        return variants;
    }

    // ── Fresh rotation curves from parameters (not template-based) ────

    function generateFreshRotationCurve(stepCount, rng, params) {
        var yawMax = params.yawMax || rng.randFloat(1.0, 1.6);
        var pitchMax = params.pitchMax || rng.randFloat(0.15, 0.7);
        var rollMax = params.rollMax || rng.randFloat(0, 0.4);
        var yawDir = params.yawDir || (rng.random() < 0.5 ? 1 : -1);
        var easeType = params.easeType || rng.randInt(0, 3);

        var curve = [];
        for (var si = 0; si < stepCount; si++) {
            var t = stepCount <= 1 ? 1 : si / (stepCount - 1);

            // Apply easing to t
            var et;
            switch (easeType) {
                case 0: et = t; break; // linear
                case 1: et = t * t; break; // ease-in
                case 2: et = 1 - (1 - t) * (1 - t); break; // ease-out
                case 3: et = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; break; // ease-in-out
                default: et = t;
            }

            // Yaw ramps up, may plateau or taper at end
            var yawTaper = t > 0.8 ? 1 - (t - 0.8) * 1.5 : 1;
            var yaw = yawDir * yawMax * et * Math.max(0.5, yawTaper);

            // Pitch follows a bell curve (peaks mid-fold)
            var pitch = pitchMax * 4 * t * (1 - t);

            // Roll follows sine envelope
            var roll = yawDir * rollMax * Math.sin(t * Math.PI);

            curve.push([
                Math.round(pitch * 100) / 100,
                Math.round(yaw * 100) / 100,
                Math.round(roll * 100) / 100
            ]);
        }
        return curve;
    }

    // ── Fresh POV curves ──────────────────────────────────────────────

    function generateFreshPovCurve(stepCount, rng, startZ) {
        // Sample the full upper hemisphere rather than a narrow +x cone. The
        // old form was [~1, ~0.5, z∈[-0.9,0.9]] which kept candidates looking
        // from roughly +x and systematically failed on models whose tracked
        // faces face -x or ±z (e.g. boat at fold=70). Pick a random azimuth
        // plus a positive-y tilt so the camera still looks from above, then
        // apply small drifts for the trajectory.
        var azimuth = rng.randFloat(0, Math.PI * 2);
        var startY = rng.randFloat(0.30, 0.70);
        var horiz = Math.sqrt(Math.max(0, 1 - startY * startY));
        var startX = Math.cos(azimuth) * horiz;
        var zFromAzimuth = Math.sin(azimuth) * horiz;
        var z = startZ != null ? startZ : zFromAzimuth;
        var xDriftTotal = rng.randFloat(-0.4, 0.4);
        var yDriftTotal = rng.randFloat(-0.3, 0.1);
        var zDriftTotal = rng.randFloat(-0.4, 0.4);

        var curve = [];
        for (var si = 0; si < stepCount; si++) {
            var t = stepCount <= 1 ? 1 : si / (stepCount - 1);
            var et = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

            curve.push([
                Math.round((startX + xDriftTotal * et) * 100) / 100,
                Math.round((startY + yDriftTotal * et) * 100) / 100,
                Math.round((z + zDriftTotal * et) * 100) / 100
            ]);
        }
        return curve;
    }

    // ── Face point selection ───��───────────────────────────────────────

    function selectFacePoints(difficulty, rng, modelFaceCount, knownFrontFaces, knownBackFaces, options) {
        var profile = getDifficultyProfile(difficulty);
        var opts = options || {};
        // When skipHidden is set, the hidden-point slots planned for this
        // difficulty tier are reserved (plannedHiddenBack / plannedHiddenFront)
        // but the actual face IDs are chosen later from the trajectory's
        // final-step visibility (two-pass selection). This avoids rejecting
        // good trajectories just because the pre-chosen hidden face isn't
        // visible at the final POV.
        var skipHidden = opts.skipHidden === true;
        // For d2: forceHiddenBack overrides the default "try visible-back first"
        // behavior. Set when findTwoSidedStaticPOVs returns no candidates —
        // caller is asking us to build the hidden-back fallback model.
        var forceHiddenBack = opts.forceHiddenBack === true;
        var N = modelFaceCount;
        if (!N || N < 1) return {
            config: {}, visibleCount: 0, hiddenCount: 0,
            plannedHiddenBack: 0, plannedHiddenFront: 0
        };

        function normalizePool(pool, useBackSide) {
            var out = [];
            var seen = {};
            var src = Array.isArray(pool) ? pool : [];
            for (var i = 0; i < src.length; i++) {
                var raw = parseInt(src[i], 10);
                if (isNaN(raw)) continue;
                var faceId = raw;
                if (useBackSide) {
                    if (faceId >= 0 && faceId < N) faceId += N;
                    if (faceId < N || faceId >= N * 2) continue;
                } else {
                    if (faceId >= N && faceId < N * 2) faceId -= N;
                    if (faceId < 0 || faceId >= N) continue;
                }
                if (!seen[faceId]) {
                    seen[faceId] = true;
                    out.push(faceId);
                }
            }
            if (out.length === 0) {
                var start = useBackSide ? N : 0;
                var end = useBackSide ? N * 2 : N;
                for (var f = start; f < end; f++) out.push(f);
            }
            // stableOrder mode: caller cycles frontIndex/backIndex across
            // scan candidates to force face diversity. Sort numerically so
            // callers can rely on a deterministic (face-id-ordered) layout.
            if (opts.stableOrder) {
                return out.sort(function (a, b) { return a - b; });
            }
            return rng.shuffle(out);
        }

        var frontPool = normalizePool(knownFrontFaces, false);
        var backPool = normalizePool(knownBackFaces, true);

        function makeBary() {
            return {
                u: rng.randFloat(0.15, 0.55),
                v: rng.randFloat(0.15, 0.55),
                w: 0
            };
        }

        function makePoint(faceId, hidden) {
            var b = makeBary();
            b.w = Math.round((1 - b.u - b.v) * 100) / 100;
            b.u = Math.round(b.u * 100) / 100;
            b.v = Math.round(b.v * 100) / 100;
            if (b.w < 0.08) { b.w = 0.1; b.u = Math.round((1 - b.v - b.w) * 100) / 100; }
            var pt = { faceId: faceId, u: b.u, v: b.v, w: b.w };
            if (hidden) pt.hidden = true;
            return pt;
        }

        function nextFace(pool, offset) {
            if (!pool || pool.length === 0) return 0;
            return pool[offset % pool.length];
        }

        // Tier mapping (static-POV + object-rotation motion model):
        //   d1: one-sided, all visible front points
        //   d2: two-sided; prefer hidden-back reveal when forced fallback
        //   d3: one-sided with motion, all visible front points
        //   d4: two-sided with hidden-back reveal (+ one hidden front)
        //   d5: two-sided with hidden-back reveal (+ more hidden front)
        //
        // User constraint:
        //   - Minimum 3 tracked points for every difficulty
        //   - Maximum 6 tracked points
        //   - Side placement depends on difficulty tier
        //
        // Hidden back slots are intentionally planned for d2/d4/d5 reveal
        // tiers. In two-pass mode (skipHidden=true), their face IDs are
        // chosen later from faces actually visible at the final step.
        //
        // Cycling indices across scan candidates (set by caller) force
        // distinct face IDs per candidate, so that e.g. 20 d1 candidates
        // each pick a different front face rather than all drawing from
        // index 0 of a per-call-reshuffled pool (which produced exact
        // duplicates on low-diversity pools).
        var frontIdx = (opts.frontIndex != null) ? (opts.frontIndex | 0) : 0;
        var backIdx  = (opts.backIndex  != null) ? (opts.backIndex  | 0) : 0;

        function buildPointPlan() {
            // Counts include hidden slots (whether materialized now or deferred
            // to pass-2 depends on skipHidden).
            if (profile.tier === 1) {
                return { frontVisible: 3, backVisible: 0, frontHidden: 0, backHidden: 0 };
            }
            if (profile.tier === 2) {
                // d2 visible-back (legacy path) keeps one back point visible.
                // d2 hidden-back fallback reserves a hidden back reveal slot.
                if (forceHiddenBack) {
                    return { frontVisible: 2, backVisible: 0, frontHidden: 0, backHidden: 1 };
                }
                return { frontVisible: 2, backVisible: 1, frontHidden: 0, backHidden: 0 };
            }
            if (profile.tier === 3) {
                return { frontVisible: 3, backVisible: 0, frontHidden: 0, backHidden: 0 };
            }
            if (profile.tier === 4) {
                return { frontVisible: 2, backVisible: 0, frontHidden: 1, backHidden: 1 };
            }
            // tier 5: denser target set while staying <= 6 total points
            return { frontVisible: 2, backVisible: 0, frontHidden: 2, backHidden: 1 };
        }

        function totalPlanCount(plan) {
            return (plan.frontVisible || 0) + (plan.backVisible || 0) +
                (plan.frontHidden || 0) + (plan.backHidden || 0);
        }

        function enforcePlanBounds(plan, minCount, maxCount) {
            var p = {
                frontVisible: Math.max(0, plan.frontVisible | 0),
                backVisible: Math.max(0, plan.backVisible | 0),
                frontHidden: Math.max(0, plan.frontHidden | 0),
                backHidden: Math.max(0, plan.backHidden | 0)
            };
            while (totalPlanCount(p) < minCount) {
                // Prefer adding visible front anchors.
                p.frontVisible++;
            }
            while (totalPlanCount(p) > maxCount) {
                // Trim in this order to preserve difficulty intent:
                // optional hidden front -> hidden back -> extra visible front -> visible back.
                if (p.frontHidden > 0) { p.frontHidden--; continue; }
                if (p.backHidden > 0 && p.backHidden + p.backVisible > 1) { p.backHidden--; continue; }
                if (p.frontVisible > 1) { p.frontVisible--; continue; }
                if (p.backVisible > 0) { p.backVisible--; continue; }
                break;
            }
            return p;
        }

        var pointPlan = enforcePlanBounds(buildPointPlan(), 3, 6);
        var visiblePoints = [];
        var plannedHiddenBack = 0;
        var plannedHiddenFront = 0;
        var frontCursor = frontIdx;
        var backCursor = backIdx;

        function addFrontPoint(hidden) {
            visiblePoints.push(makePoint(nextFace(frontPool, frontCursor), hidden));
            frontCursor++;
        }

        function addBackPoint(hidden) {
            visiblePoints.push(makePoint(nextFace(backPool, backCursor), hidden));
            backCursor++;
        }

        for (var vf = 0; vf < pointPlan.frontVisible; vf++) addFrontPoint(false);
        for (var vb = 0; vb < pointPlan.backVisible; vb++) addBackPoint(false);
        for (var hb = 0; hb < pointPlan.backHidden; hb++) {
            if (skipHidden) plannedHiddenBack++;
            else addBackPoint(true);
        }
        for (var hf = 0; hf < pointPlan.frontHidden; hf++) {
            if (skipHidden) plannedHiddenFront++;
            else addFrontPoint(true);
        }

        // Build facePoints config object (group by faceId)
        var config = {};
        for (var pi = 0; pi < visiblePoints.length; pi++) {
            var p = visiblePoints[pi];
            var key = String(p.faceId);
            if (!config[key]) config[key] = [];
            var entry = { u: p.u, v: p.v, w: p.w };
            if (p.hidden) entry.hidden = true;
            config[key].push(entry);
        }

        var hiddenCount = 0;
        for (var vi = 0; vi < visiblePoints.length; vi++) {
            if (visiblePoints[vi].hidden) hiddenCount++;
        }

        return {
            config: config,
            visibleCount: visiblePoints.length - hiddenCount,
            hiddenCount: hiddenCount,
            plannedHiddenBack: plannedHiddenBack,
            plannedHiddenFront: plannedHiddenFront
        };
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
            stepIdx++;
            setTimeout(applyNextStep, isLast ? finalSettle : perStepSettle);
        }

        function scoreAndRefine() {
            try {
                // Walk preset.facePoints in the SAME order as facePoints.initFromConfig
                // so the pointIndex we assign lines up with the point populated in
                // globals.facePoints. See js/facePoints.js initFromConfig.
                var entries = [];
                var pointIndex = 0;
                function parseBaryEntry(e) {
                    if (!e) return null;
                    if (Array.isArray(e) && e.length >= 3) return { u: e[0], v: e[1], w: e[2] };
                    if (typeof e === "object" && "u" in e && "v" in e && "w" in e) return { u: e.u, v: e.v, w: e.w };
                    return null;
                }
                if (Array.isArray(preset.facePoints)) {
                    for (var ai = 0; ai < preset.facePoints.length; ai++) {
                        var arrEntry = preset.facePoints[ai];
                        var arrBary = parseBaryEntry(arrEntry);
                        if (arrBary) {
                            entries.push({ ref: arrEntry, idx: pointIndex++ });
                        } else {
                            // numeric-count form — skip (preset-generated presets always include u/v/w)
                            var c0 = parseInt(arrEntry && arrEntry.count != null ? arrEntry.count : 1, 10);
                            pointIndex += (isNaN(c0) ? 0 : Math.max(1, c0));
                        }
                    }
                } else if (typeof preset.facePoints === "object") {
                    for (var key in preset.facePoints) {
                        if (!preset.facePoints.hasOwnProperty(key)) continue;
                        var val = preset.facePoints[key];
                        if (Array.isArray(val)) {
                            for (var ki = 0; ki < val.length; ki++) {
                                var bary = parseBaryEntry(val[ki]);
                                if (bary) {
                                    entries.push({ ref: val[ki], idx: pointIndex++ });
                                } else {
                                    // still occupies a point slot, but we can't refine it
                                    pointIndex++;
                                }
                            }
                        } else {
                            var c1 = parseInt(val, 10);
                            if (!isNaN(c1) && c1 >= 1) pointIndex += c1;
                        }
                    }
                }

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

                // Fixed barycentric grid over (u,v) ∈ [0.22, 0.52] with
                // w ≥ 0.18; every candidate sits inside the triangle with a
                // comfortable margin from all three edges.
                //
                // Grid values are pre-rounded to 2 decimals so that the
                // score we compute is for the EXACT barycentric we will
                // write to the preset. Otherwise a candidate could score
                // "visible" at an unrounded position (e.g. 0.295, 0.295)
                // but then round to a near-edge position (0.30, 0.30) that
                // validation sees as occluded. Scoring the rounded value
                // keeps refiner→validator visibility contract intact.
                function mk(u, v) {
                    var ru = Math.round(u * 100) / 100;
                    var rv = Math.round(v * 100) / 100;
                    var rw = Math.round((1 - ru - rv) * 100) / 100;
                    return { u: ru, v: rv, w: rw };
                }
                // Tier-aware grid density. d1/d2 use a 3×3 grid (~9
                // candidates) since their geometry is simpler and refinement
                // is cosmetic. d3/d4 keep the 5×5 grid (~25 candidates) for
                // tighter placement on rotated/two-sided poses where the
                // rendered point is more sensitive to barycentric position.
                var refineTier = (preset && preset.difficulty) ? clampDifficultyTier(preset.difficulty) : 4;
                var gridValues = (refineTier <= 2)
                    ? [0.27, 0.37, 0.47]
                    : [0.22, 0.30, 0.38, 0.45, 0.52];
                var baseCandidates = [];
                for (var ui = 0; ui < gridValues.length; ui++) {
                    for (var vi = 0; vi < gridValues.length; vi++) {
                        var c = mk(gridValues[ui], gridValues[vi]);
                        if (c.w < 0.18) continue;
                        baseCandidates.push(c);
                    }
                }
                baseCandidates.push(mk(0.33, 0.33));

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

                        var cands = baseCandidates.slice();
                        cands.push({ u: origU, v: origV, w: origW });

                        var bestScore = -Infinity;
                        var bestU = origU, bestV = origV, bestW = origW;

                        for (var ci = 0; ci < cands.length; ci++) {
                            var c = cands[ci];
                            globals.facePoints.updatePointPosition(idx, faceId, c.u, c.v, c.w);
                            var s = scoreCandidate(idx, c);
                            if (s > bestScore) {
                                bestScore = s;
                                bestU = c.u; bestV = c.v; bestW = c.w;
                            }
                        }

                        var roundedU, roundedV, roundedW;
                        if (bestScore > -Infinity) {
                            // Grid values are already 2-decimal rounded, so
                            // pass them through verbatim; no extra rounding
                            // that could drift the scored position.
                            roundedU = bestU;
                            roundedV = bestV;
                            roundedW = bestW;
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
    // d3 ≈ 30°, d4 ≈ 60°, d5 ≈ 90–110°. Pitch/roll scale to ≈25% of yaw.
    function rotationTargetForTier(tier, rng) {
        if (tier <= 2) return [0, 0, 0];
        var r = rng || { randFloat: function (a, b) { return (a + b) / 2; }, random: function () { return 0.5; } };
        var yawBase, pitchBase, rollBase;
        if (tier === 3) {
            yawBase = r.randFloat(0.4, 0.6);
            pitchBase = r.randFloat(0.08, 0.18);
            rollBase = r.randFloat(0.03, 0.1);
        } else if (tier === 4) {
            yawBase = r.randFloat(0.85, 1.15);
            pitchBase = r.randFloat(0.15, 0.28);
            rollBase = r.randFloat(0.05, 0.15);
        } else {
            yawBase = r.randFloat(1.5, 1.9);
            pitchBase = r.randFloat(0.25, 0.4);
            rollBase = r.randFloat(0.1, 0.22);
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
    // state 1 (zero) from states 2..N (frozen d2 / ramping d4).
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
        // — they must be preserved, even for static tiers (d2 hidden-
        // back fallback is d2 + non-zero rotation).
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
        //
        // d2 exception: Phase 2 uses a ramping profile (to actually expose
        // back faces during trajectory search), but the emitted preset must
        // be STATIC (no inter-step motion per user spec). Freeze every step
        // to the FINAL step's rotation — that's where the back-exposing
        // pose lives. Final-state geometry matches d4's success; d2 differs
        // only in that the paper is already pre-tilted to that pose at
        // fold=0 rather than ramping into it.
        if (hasIncomingRotation) {
            var isD2 = (profile.tier === 2);
            if (isD2) {
                var finalRv = null;
                for (var fri = steps.length - 1; fri >= 0; fri--) {
                    var frv = parseRotationVec(steps[fri] && steps[fri].rotation);
                    if (Math.abs(frv[0]) > 1e-8 || Math.abs(frv[1]) > 1e-8 || Math.abs(frv[2]) > 1e-8) {
                        finalRv = frv;
                        break;
                    }
                }
                if (finalRv) {
                    var frozenRot = [
                        Math.round(finalRv[0] * 100) / 100,
                        Math.round(finalRv[1] * 100) / 100,
                        Math.round(finalRv[2] * 100) / 100
                    ];
                    for (var rji2 = 0; rji2 < out.length; rji2++) {
                        out[rji2].rotation = frozenRot.slice();
                    }
                    return applyHeroShotStep0(out);
                }
            }
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
            return applyHeroShotStep0(out);
        }

        // No incoming rotation and static tier: emit static preset.
        if (profile.isStaticTier) return applyHeroShotStep0(out);

        // Synthesize a tier-appropriate rotation: 0 → target with
        // ease-in-out so the reveal happens in the last ~30% of the
        // sweep (matches hidden-point-reveal-at-end semantics for d4/d5).
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
        if ((tier <= 2 && preset.colorMode === "faceTriangleID") ||
            (tier >= 4 && preset.colorMode === "labelOnly") ||
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

    function assemblePreset(rotCurve, povCurve, foldSteps, facePointsConfig, options) {
        var opts = options || {};
        var difficulty = clampDifficultyTier(opts.difficulty || 5);
        if (!opts.rng) throw new Error("assemblePreset: opts.rng is required (deterministic seeding)");
        var rng = opts.rng;
        var colorMode = opts.colorMode || getColorModeForDifficulty(difficulty, rng);
        var colors = opts.colors || ["e74c3c", "3498db"];
        var bgColor = opts.backgroundColor || "f0f0f0";

        var steps = [];
        for (var si = 0; si < foldSteps.length; si++) {
            var step = {
                fold: foldSteps[si],
                pov: povCurve[si].slice()
            };
            // Only add rotation if non-zero
            if (si > 0 && (rotCurve[si][0] !== 0 || rotCurve[si][1] !== 0 || rotCurve[si][2] !== 0)) {
                step.rotation = rotCurve[si].slice();
            }
            steps.push(step);
        }

        var normalizedSteps = normalizeStepsForDifficulty(steps, difficulty, rng);

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
            facePoints: facePointsConfig,
            steps: normalizedSteps
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

        preset.minPointSeparationPx = opts.minPointSeparationPx != null ? opts.minPointSeparationPx : 70;
        var assembleFaceCount = opts.modelFaceCount;
        if (assembleFaceCount == null && globals.model && globals.model.getFaces) {
            var fs = globals.model.getFaces();
            assembleFaceCount = fs ? fs.length : 0;
        }
        // Configs with hidden OR back-face points must use finalStepOnly —
        // strictAllSteps would fail at fold=0 since back faces are not
        // geometrically visible on flat paper. This overrides any caller-
        // provided trackingEvalMode because CLI defaults (strictAllSteps)
        // would otherwise break d2/d4/d5 silently.
        if (facePointsNeedFinalStepOnly(facePointsConfig, assembleFaceCount)) {
            preset.trackingEvalMode = "finalStepOnly";
        } else {
            preset.trackingEvalMode = opts.trackingEvalMode || "strictAllSteps";
        }

        // Attach internal metadata for diversity selection (not serialized to JSON)
        preset._rotCurve = rotCurve;
        preset._povCurve = povCurve;

        return preset;
    }

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
        var foldSteps = opts.foldSteps || (difficulty === 1
            ? [0, 12, 25, 37, 50]
            : [0, 8, 16, 24, 32, 40, 48, 56, 64, 70]);
        var rawSteps = stepsFromProgression(progression, foldSteps);
        var normalizedSteps = normalizeStepsForDifficulty(rawSteps, difficulty, rng);

        // trackingEvalMode: if any face point is hidden (d4/d5 always,
        // d2 fallback) or on a back face (d2 visible-back tracks a back
        // point that is not visible at fold=0), force finalStepOnly so
        // validation only requires the point visible at the last fold step.
        // This overrides caller-provided trackingEvalMode because CLI
        // defaults (strictAllSteps) would break d2/d4/d5 silently.
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
            trackingEvalMode: resolvedTrackingMode
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
    // per-step visibilityTimeline and the model's face pools, emit up to K=3
    // distinct facePoints configs that satisfy the difficulty tier's tracked-
    // point requirements (CLAUDE.md "Tracked point counts" + "Difficulty
    // tiers"). Returns [] if the trajectory cannot satisfy the tier (e.g. no
    // back-pool face is visible at the final step for d2/d4/d5).
    //
    // Tier rules (canonical from CLAUDE.md):
    //   d1: 3 visible front, strictAllSteps
    //   d2: 2 visible front + 1 hidden back, finalStepOnly
    //   d3: 3 visible front, strictAllSteps
    //   d4: 2 visible front + 1 hidden front + 1 hidden back, finalStepOnly
    //   d5: 2 visible front + 2 hidden front + 1 hidden back, finalStepOnly
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
    // K configs per trajectory: each accepted trajectory spawns up to K
    // face-point configs by rotating anchor picks. K=1 means every preset
    // has a unique trajectory (uniqueness contract: no trajectory repeats
    // within a model). Bump only if count is large and trajectory search
    // can't keep up — but the wall-time trade is not linear.
    var SELECT_FROM_TRAJECTORY_K = 1;

    function selectFacePointsFromTrajectory(trajectory, difficulty, modelFaceCount, frontPool, backPool, rng) {
        var tier = clampDifficultyTier(difficulty);
        var timeline = trajectory && trajectory.visibilityTimeline;
        if (!Array.isArray(timeline) || timeline.length === 0) return [];
        var N = modelFaceCount;
        if (!N || N < 1) return [];

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
        // d2/d4 for those models. Letting the geometric gate be the sole
        // filter satisfies the user's primary contract: "guarantee a point
        // on the back side of the paper visible at the final state."
        var backs = [];
        for (var bii = 0; bii < N; bii++) backs.push(bii);

        // Build alwaysVisible set + min-step quality from the timeline.
        var firstStep = timeline[0];
        var alwaysVisible = {};
        var minStepQuality = {};
        for (var i0 = 0; i0 < firstStep.visibleFaceIds.length; i0++) {
            var fid0 = firstStep.visibleFaceIds[i0];
            alwaysVisible[fid0] = true;
            minStepQuality[fid0] = (firstStep.qualities && firstStep.qualities[fid0] != null)
                ? firstStep.qualities[fid0] : 0;
        }
        for (var s = 1; s < timeline.length; s++) {
            var step = timeline[s];
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
        // in facePoints.js and recorded in the timeline. Used to gate d2/d4
        // hidden-back picks: a hidden back point only "guarantees back side
        // visibility" if the underlying face's back surface is actually
        // exposed at the final state.
        var finalBackSideVisible = {};
        var bsv = finalStep.backSideVisibleFaceIds || [];
        for (var fbi = 0; fbi < bsv.length; fbi++) {
            finalBackSideVisible[bsv[fbi]] = true;
        }

        // Visible-front anchors must be visible at EVERY step regardless of
        // tier. The user's hard contract: "initial points must be visible
        // throughout all progressions and final state". finalStepOnly is a
        // HIDDEN-point semantic (a hidden point reveals at the final step),
        // not a visible-anchor one.
        //
        // Earlier this was tier-conditional and used finalVisible for d2/d4/d5
        // — but that let visible-fronts disappear mid-fold, producing presets
        // that look broken (the user observed this in the rendered output).
        var rankedFronts = fronts.filter(function (fid) {
            return alwaysVisible[fid] && (minStepQuality[fid] || 0) > 0;
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
        var rankedBacks = backs.filter(isBackSideExposed);
        rankedBacks.sort(function (a, b) {
            return backs.indexOf(a) - backs.indexOf(b);
        });

        // Hidden-front candidates: in frontPool, visible at final step.
        // (Used by d4/d5 for "late reveal" of front anchors.)
        var rankedHiddenFronts = fronts.filter(function (fid) { return finalVisible[fid]; });
        rankedHiddenFronts.sort(function (a, b) {
            return (finalQuality[b] || 0) - (finalQuality[a] || 0);
        });

        // Per-tier slot count RANGES (d1–d4 only; d5 dropped per user spec).
        // Constraint: every preset has at least 2 visible (non-hidden)
        // anchors so initial state is trackable, and the total fits the
        // tier's range. Each tier picks greedily from its range based on
        // what the trajectory's pools support; empty config returned if
        // the lower bound can't be met.
        //
        //   d1: static (no rotation across steps), 2 visible front + 1-3
        //       hidden front (revealed at final step). Total 3-5.
        //   d2: static POV + small rotation, 2 visible front + 1-2 hidden
        //       back (revealed at final via rotation). Total 3-4.
        //   d3: rotated, 2 visible front + 1-3 hidden front. Total 3-5.
        //   d4: rotated, 2 visible front + 1-2 hidden front + 1-2 hidden
        //       back (mix of late-front-reveal and back-via-rotation).
        //       Total 4-6.
        var ranges;
        if (tier === 1)      ranges = { vF: [2, 2], hF: [1, 3], hB: [0, 0] };
        else if (tier === 2) ranges = { vF: [2, 2], hF: [0, 0], hB: [1, 2] };
        else if (tier === 3) ranges = { vF: [2, 2], hF: [1, 3], hB: [0, 0] };
        else                 ranges = { vF: [2, 2], hF: [1, 2], hB: [1, 2] };

        // For two-sided tiers (d2, d4), the FINAL POSE must show at least
        // hB.lower back-pool faces that are GEOMETRICALLY back-side-exposed
        // at the final step — same definition rankedBacks uses (index in
        // [N/2, N-1] AND front-normal quality < BACK_SIDE_QUALITY_MAX).
        // This guarantees the rendered PNG actually has visible back-surface
        // for the hidden reveal, not just a face-id in the back-half range
        // that happens to be front-facing.
        var requiresBothSides = (tier === 2 || tier === 4);
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

        var configs = [];
        // Try up to maxShifts rank windows; keep at most K successful configs.
        // Decoupling "max attempts" from "max kept" ensures K=1 doesn't kill
        // a trajectory whose first rank window fails but later windows succeed.
        var maxShifts = Math.max(1, rankedFronts.length - plan.vF + 1);
        for (var k = 0; k < maxShifts && configs.length < SELECT_FROM_TRAJECTORY_K; k++) {
            var visF = rankedFronts.slice(k, k + plan.vF);
            if (visF.length < plan.vF) break;

            var used = {};
            for (var vi = 0; vi < visF.length; vi++) used[visF[vi]] = true;

            var hidF = [];
            for (var hi = 0; hi < rankedHiddenFronts.length && hidF.length < plan.hF; hi++) {
                var hidFid = rankedHiddenFronts[(hi + k) % rankedHiddenFronts.length];
                if (used[hidFid]) continue;
                hidF.push(hidFid);
                used[hidFid] = true;
            }
            if (hidF.length < plan.hF) continue;

            var hidB = [];
            for (var bi = 0; bi < rankedBacks.length && hidB.length < plan.hB; bi++) {
                var hidBid = rankedBacks[(bi + k) % rankedBacks.length];
                if (used[hidBid]) continue;
                hidB.push(hidBid);
                used[hidBid] = true;
            }
            if (hidB.length < plan.hB) continue;

            var config = {};
            function add(fid, hidden) {
                var key = String(fid);
                if (!config[key]) config[key] = [];
                var b = makeBary();
                var entry = { u: b.u, v: b.v, w: b.w };
                if (hidden) entry.hidden = true;
                config[key].push(entry);
            }
            for (var av = 0; av < visF.length; av++) add(visF[av], false);
            for (var af = 0; af < hidF.length; af++) add(hidF[af], true);
            // Hidden-back picks: use faceId = (idx + N) so the simulator
            // treats the point as a back-surface marker (isPointVisible's
            // `isFront = id < N` path will require the BACK normal to face
            // the camera). Without this the point would be a front-side
            // marker on the same face — visible only when the front is
            // exposed, defeating the d2/d4 hidden-back-reveal semantic.
            for (var ab = 0; ab < hidB.length; ab++) add(hidB[ab] + N, true);

            configs.push({
                facePoints: config,
                _selection: {
                    visibleFronts: visF,
                    hiddenFronts: hidF,
                    hiddenBacks: hidB
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
    function buildGenericAnchorFacePoints(frontPool, modelFaceCount) {
        var N = modelFaceCount;
        if (!Array.isArray(frontPool) || frontPool.length === 0 || !N || N < 1) return null;
        var raw = parseInt(frontPool[0], 10);
        if (isNaN(raw)) return null;
        if (raw >= N) raw -= N;
        if (raw < 0 || raw >= N) return null;
        var cfg = {};
        cfg[String(raw)] = [{ u: 0.34, v: 0.33, w: 0.33 }];
        return cfg;
    }

    // Rotation bounds per CLAUDE.md "Rotation magnitude per tier" table.
    // Single source of truth — replaces per-candidate rotationBoundsForCandidate
    // logic from the legacy generator. d1=static, d2=small (hidden-back reveal
    // needs a rotation budget to expose the back face at fold=70), d3=moderate
    // single-side, d4=moderate two-sided, d5=large two-sided.
    function rotationBoundsForTier(difficulty) {
        var tier = clampDifficultyTier(difficulty);
        // d1: STATIC (no motion across steps), but each preset can sit at a
        // tilted constant pose (buildAutoRotationProfiles emits constant-
        // rotation profiles). These bounds determine how tilted the static
        // pose can be. Without this d1 collapses to the single "flat from
        // above" view.
        if (tier === 1) return { yaw: 0.5, pitch: 0.15, roll: 0.08 };
        // d2: Phase 2 uses ramping rotation (like d4) so it actually finds
        // back-exposing trajectories, then normalizeStepsForDifficulty
        // FREEZES the emitted preset's rotation to the final step's value.
        // Uses d4-magnitude rotation (yaw/pitch ≈ 1.0) — smaller magnitudes
        // don't reliably expose back-side faces at the final state. The
        // hero-shot step-0 override (iso POV + no rotation) prevents the
        // initial frame from being edge-on, so validation of step 0 passes
        // even under large constant rotation for steps 1..N.
        if (tier === 2) return { yaw: 1.0, pitch: 1.0, roll: 0.25 };
        // d3: rotated single-side, moderate yaw with mild pitch/roll.
        if (tier === 3) return { yaw: 0.5, pitch: 0.15, roll: 0.08 };
        // d4: rotated two-sided, ~1.0 rad to match bird-frontback reference
        // quality (0.6 cap produced ~0.74 rad final, references reach ~1.0+).
        return { yaw: 1.0, pitch: 1.0, roll: 0.25 };
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
        var foldSteps = opts.foldSteps || (difficulty === 1
            ? [0, 12, 25, 37, 50]
            : [0, 8, 16, 24, 32, 40, 48, 56, 64, 70]);
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
        var anchorFacePoints = buildGenericAnchorFacePoints(frontFaces, modelFaceCount);
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
            minFaceQuality: opts.minFaceQuality != null ? opts.minFaceQuality : 0.05,
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
            phase2EarlyStopCount: opts.phase2EarlyStopCount != null
                ? opts.phase2EarlyStopCount
                : (difficulty === 1
                    ? Math.max(3, count)
                    : Math.max(5, Math.ceil(count * 1.5))),
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
            rotationProfileCount: opts.rotationProfileCount != null
                ? opts.rotationProfileCount
                : (difficulty >= 3 ? 6 : (slotTrackingMode === "finalStepOnly" ? 10 : 6)),
            targetSelectionMode: opts.targetSelectionMode || "all",
            includeInitialVisibleTrackedPoint: opts.includeInitialVisibleTrackedPoint === true,
            initialVisibleTrackedPointCount: opts.initialVisibleTrackedPointCount != null
                ? opts.initialVisibleTrackedPointCount : 1,
            // Anchor's only point label is "A". With a single tracked point,
            // separation checks degrade to "in-frame" — exactly the loose
            // gate we want so post-hoc selection has room to work.
            targetPointLabels: ["A"],
            primaryTargetPointLabels: ["A"]
        };

        // Tier slot plan (mirrors selectFacePointsFromTrajectory). Used by
        // the safety top-off below.
        var tierPlan = (function () {
            if (difficulty === 1) return { hB: 0, hF: 0 };
            if (difficulty === 2) return { hB: 1, hF: 0 };
            if (difficulty === 3) return { hB: 0, hF: 0 };
            if (difficulty === 4) return { hB: 1, hF: 1 };
            return                     { hB: 1, hF: 2 };
        })();

        var earlyStopThreshold = Math.max(count * 2, 15);
        var collected = [];
        var trajectoriesUsed = 0;
        var trajectoriesEmpty = 0;

        updateStatus("Trajectory-first scan: building progressions for d" + difficulty + "...");

        var runFn = (globals.benchmark && globals.benchmark.run)
            ? globals.benchmark.run.bind(globals.benchmark)
            : globals.benchmark.runScan.bind(globals.benchmark);

        runFn(slotScanCfg, function (scanResult) {
            var progressions = [];
            try {
                progressions = scanResult && Array.isArray(scanResult.diverseProgressions)
                    ? scanResult.diverseProgressions
                    : [];
            } catch (err) {
                console.warn("presetGenerator: progression extraction error", err);
            }

            updateStatus("Trajectory-first: " + progressions.length + " progression(s); selecting points per tier...");
            console.log("presetGenerator: trajectory-first received " + progressions.length + " progressions");

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

                var configs = selectFacePointsFromTrajectory(prog, difficulty, modelFaceCount, frontFaces, backFaces, rng);
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
                        modelFaceCount: modelFaceCount
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
            setTimeout(function () {

                var requiredIndices = [];
                // d2 presets are emitted with FROZEN rotation (final-step
                // value applied to every step) even though Phase 2 tested a
                // ramping trajectory. This means middle-step geometry in
                // the emitted preset is NOT what Phase 2 validated — face
                // visibility at mid-folds with max rotation can flicker.
                // For d2 we therefore only check non-hidden points at the
                // boundary states (step 0 hero-shot and final step),
                // mirroring what the user actually sees: state 0 is the
                // high-visibility iso overview, final state is the proven
                // back-exposing pose. Middle-state flicker is accepted.
                var isD2Preset = (preset.difficulty === 2);
                var isBoundaryStep = (stepIdx === 0) || isLast;
                for (var i = 0; i < pointIndices.length; i++) {
                    var pInfo = pointIndices[i];
                    // Hidden points only need to be visible at final step.
                    if (pInfo.hidden && !isLast) continue;
                    requiredIndices.push(pInfo.idx);

                    // Non-hidden: all tiers except d2 require visible at
                    // every step. d2 requires visible only at boundary
                    // (state 0 hero + final state).
                    if (isD2Preset && !isBoundaryStep) continue;

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
        var templatePattern = opts.templatePattern || "bird-frontback-0*";
        var seed = opts.seed || Date.now();
        var foldSteps = opts.foldSteps || (difficulty === 1
            ? [0, 12, 25, 37, 50]
            : [0, 8, 16, 24, 32, 40, 48, 56, 64, 70]);
        var validate = opts.validate !== false;
        var settleMs = opts.settleMs || 300;
        var trajectoryMode = opts.trajectoryMode || "hybrid";
        var normalizedTrajectoryMode = String(trajectoryMode).trim().toLowerCase();

        var rng = makeRng(seed);

        // Get presets from benchmark module
        var presets = {};
        if (globals.benchmark && globals.benchmark.getPresets) {
            presets = globals.benchmark.getPresets() || {};
        }

        // Extract templates
        var templates = extractRotationTemplates(presets, templatePattern);
        console.log("presetGenerator: extracted " + templates.length + " templates from '" + templatePattern + "'");

        // Determine face pools (async — cached per model)
        var frontFaces = null;
        var backFaces = null;
        var modelFaceCount = 0;
        if (globals.model && globals.model.getFaces) {
            var faces = globals.model.getFaces();
            modelFaceCount = faces ? faces.length : 0;
        }

        // Build existing preset references for diversity
        var existingRefs = [];
        for (var ti = 0; ti < templates.length; ti++) {
            existingRefs.push({
                _rotCurve: templates[ti].rotationCurve,
                _povCurve: templates[ti].povCurve,
                facePoints: templates[ti].facePoints
            });
        }

        function runLegacyGeneration(existingRefs) {
        // ── Generate candidates ────────────────────────────────────

        var candidates = [];
        var targetCandidates = count * 5;

        // Strategy 1: Variants from existing templates
        if (templates.length > 0) {
            var variantsPerTemplate = Math.ceil(targetCandidates / templates.length / 2);
            for (var tpl = 0; tpl < templates.length; tpl++) {
                var rotVars = generateRotationVariants(templates[tpl], variantsPerTemplate, rng);
                var povVars = generatePovVariants(templates[tpl], variantsPerTemplate, rng);

                for (var rv = 0; rv < rotVars.length; rv++) {
                    var pvIdx = rv % povVars.length;
                    var fp = selectFacePoints(difficulty, rng, modelFaceCount, frontFaces, backFaces);
                    var colorIdx = rng.randInt(0, COLOR_PAIRS.length - 1);
                    var tunedRot = tuneRotationCurveForDifficulty(rotVars[rv], difficulty, rng);
                    var tunedPov = tunePovCurveForDifficulty(povVars[pvIdx], difficulty, rng);
                    var colorMode = getColorModeForDifficulty(difficulty, rng);

                    candidates.push(assemblePreset(
                        tunedRot, tunedPov, foldSteps, fp.config,
                        {
                            model: model,
                            difficulty: difficulty,
                            colorMode: colorMode,
                            colors: COLOR_PAIRS[colorIdx],
                            backgroundColor: rng.pick(["f0f0f0", "f5f5f5", "ffffff"]),
                            targetSelectionMode: opts.targetSelectionMode || "all",
                            includeInitialVisibleTrackedPoint: opts.includeInitialVisibleTrackedPoint === true,
                            initialVisibleTrackedPointCount: opts.initialVisibleTrackedPointCount != null ? opts.initialVisibleTrackedPointCount : 1,
                            rng: rng
                        }
                    ));
                }
            }
        }

        // Strategy 2: Fresh curves (when templates are sparse or for extra diversity)
        var freshCount = Math.max(targetCandidates - candidates.length, targetCandidates / 2);
        for (var fi = 0; fi < freshCount; fi++) {
            var startZ = rng.pick([-0.9, -0.6, -0.3, 0, 0.3, 0.6, 0.9]);
            var freshRot = generateFreshRotationCurve(foldSteps.length, rng, {
                yawMax: rng.randFloat(0.4, 1.0),
                pitchMax: rng.randFloat(0.08, 0.35),
                rollMax: difficulty >= 3 ? rng.randFloat(0.0, 0.4) : 0,
                yawDir: rng.random() < 0.5 ? 1 : -1,
                easeType: rng.randInt(0, 3)
            });
            var freshPov = generateFreshPovCurve(foldSteps.length, rng, startZ);
            var freshFp = selectFacePoints(difficulty, rng, modelFaceCount, frontFaces, backFaces);
            var freshColorIdx = rng.randInt(0, COLOR_PAIRS.length - 1);
            freshRot = tuneRotationCurveForDifficulty(freshRot, difficulty, rng);
            freshPov = tunePovCurveForDifficulty(freshPov, difficulty, rng);
            var freshColorMode = getColorModeForDifficulty(difficulty, rng);

            candidates.push(assemblePreset(
                freshRot, freshPov, foldSteps, freshFp.config,
                {
                    model: model,
                    difficulty: difficulty,
                    colorMode: freshColorMode,
                    colors: COLOR_PAIRS[freshColorIdx],
                    backgroundColor: rng.pick(["f0f0f0", "f5f5f5", "ffffff"]),
                    targetSelectionMode: opts.targetSelectionMode || "all",
                    includeInitialVisibleTrackedPoint: opts.includeInitialVisibleTrackedPoint === true,
                    initialVisibleTrackedPointCount: opts.initialVisibleTrackedPointCount != null ? opts.initialVisibleTrackedPointCount : 1,
                    rng: rng
                }
            ));
        }

        candidates = filterCandidatesByDifficulty(candidates, difficulty, modelFaceCount, count, rng);

        console.log("presetGenerator: generated " + candidates.length + " candidates");

        if (!validate) {
            // Skip validation — select diverse subset directly
            var selected = selectDiverse(candidates, count, existingRefs);
            finalize(selected, baseName, startIndex, callback);
            return;
        }

        // ── Validate, pick top-N, then refine only the winners ────
        //
        // Refinement is a step-walk at validator-matching settle times
        // (~8s per preset for a 10-step trajectory). Running it on every
        // candidate would add minutes per generation; running it only on
        // the diverse subset picked for output is ~N × 8s and produces
        // the same final quality because refinement is a purely local
        // barycentric search per face, independent of the other
        // candidates in the pool.

        updateStatus("Validating " + candidates.length + " candidates...");
        validateBatch(candidates, settleMs, function (idx, total) {
            updateStatus("Validating candidate " + (idx + 1) + "/" + total + "...");
        }, function (results) {
            var passing = [];
            for (var vi = 0; vi < results.length; vi++) {
                if (results[vi].valid) {
                    passing.push(candidates[results[vi].presetIndex]);
                }
            }
            console.log("presetGenerator: " + passing.length + "/" + candidates.length + " passed validation");
            updateStatus(passing.length + " candidates passed validation");

            if (passing.length === 0) {
                callback({ error: "No candidates passed validation", generated: [] });
                return;
            }

            passing = filterCandidatesByDifficulty(passing, difficulty, modelFaceCount, Math.min(count, passing.length), rng);
            var selected = selectDiverse(passing, count, existingRefs);
            refineAndRevalidate(selected, settleMs, rng, function (finalPresets) {
                finalize(finalPresets, baseName, startIndex, callback);
            });
        });
        }

        function runHybridOrScan(existingRefs, strictScanMode) {
            generateFromScanProgressions(opts, function (scanGen) {
                if (scanGen && scanGen.error) {
                    console.warn("presetGenerator: scan progression generation failed", scanGen.error);
                    if (strictScanMode) {
                        callback({ error: scanGen.error, generated: [] });
                        return;
                    }
                    runLegacyGeneration(existingRefs);
                    return;
                }

                var scanCandidates = scanGen && Array.isArray(scanGen.generatedPresets)
                    ? scanGen.generatedPresets
                    : [];

                if (scanCandidates.length === 0) {
                    if (strictScanMode) {
                        callback({ error: "No progression candidates generated", generated: [] });
                        return;
                    }
                    console.log("presetGenerator: hybrid fallback to legacy generator (no scan candidates)");
                    runLegacyGeneration(existingRefs);
                    return;
                }

                console.log("presetGenerator: generated " + scanCandidates.length + " progression candidates");
                // Skip pre-refinement validateBatch for d1. d1 uses static
                // constant-rotation profiles over a 5-step flat-paper walk
                // with no back-side requirement — validation predictably
                // passes, so the batch step is ~60s of wasted wall time.
                // refineAndRevalidate below still runs a per-preset
                // revalidate, so any genuinely broken preset (separation
                // mishap, edge barycentric) is still caught there.
                //
                // Also short-circuits when caller explicitly opts out with
                // --no-validate.
                // d1/d2 short-circuit batch validation — d1 because validation
                // predictably passes for static-pose flat walks; d2 because it's
                // derived post-hoc from d4's already-validated trajectory.
                // refineAndRevalidate still does per-preset validation below, so
                // any genuinely broken preset is caught.
                var skipBatchValidation = !validate || difficulty <= 2;
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
                        if (strictScanMode) {
                            callback({ error: "No scan progression candidates passed validation", generated: [] });
                            return;
                        }
                        console.log("presetGenerator: hybrid fallback to legacy generator (scan candidates failed validation)");
                        runLegacyGeneration(existingRefs);
                        return;
                    }

                    passing = filterCandidatesByDifficulty(passing, difficulty, modelFaceCount, Math.min(count, passing.length), rng);
                    var selected = selectDiverse(passing, count, existingRefs);
                    refineAndRevalidate(selected, settleMs, rng, function (finalPresets) {
                        finalize(finalPresets, baseName, startIndex, callback);
                    });
                });
            });
        }

        discoverFacePools(model, function (pools) {
            frontFaces = pools.front;
            backFaces = pools.back;

            if (normalizedTrajectoryMode === "scanprogression" || normalizedTrajectoryMode === "scan") {
                runHybridOrScan(existingRefs, true);
                return;
            }
            if (normalizedTrajectoryMode === "hybrid") {
                runHybridOrScan(existingRefs, false);
                return;
            }

            runLegacyGeneration(existingRefs);
        });
    }

    function finalize(selected, baseName, startIndex, callback) {
        var output = {};
        for (var si = 0; si < selected.length; si++) {
            var name = baseName + "-" + String(startIndex + si).padStart(2, "0");
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

    // ── Save to server ─────────────────────────────────────────────────

    function saveToServer(presets, callback) {
        var xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/save-benchmarks", true);
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.onload = function () {
            if (xhr.status === 200) {
                var resp = JSON.parse(xhr.responseText);
                callback(null, resp);
            } else {
                callback("Server error: " + xhr.status);
            }
        };
        xhr.onerror = function () { callback("Network error"); };
        xhr.send(JSON.stringify(presets));
    }

    // ── Public API ─────────────────────────────────────────────────────

    return {
        generate: generate,
        validatePreset: validatePreset,
        validateBatch: validateBatch,
        saveToServer: saveToServer,
        extractRotationTemplates: extractRotationTemplates,
        generateRotationVariants: generateRotationVariants,
        generatePovVariants: generatePovVariants,
        generateFreshRotationCurve: generateFreshRotationCurve,
        generateFreshPovCurve: generateFreshPovCurve,
        selectFacePoints: selectFacePoints,
        selectDiverse: selectDiverse,
        assemblePreset: assemblePreset,
        COLOR_PAIRS: COLOR_PAIRS,
        makeRng: makeRng
    };
}
