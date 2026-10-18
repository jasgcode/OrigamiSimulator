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
        if (d > 5) d = 5;
        return d;
    }

    function getDifficultyProfile(difficulty) {
        var tier = clampDifficultyTier(difficulty);
        return {
            tier: tier,
            requiresBothSides: tier >= 4,
            isStaticTier: tier === 1,
            isMajorMotionTier: tier >= 4
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

    // Expert sequences are long and change direction. A path must travel far
    // (pathAngle), wander well beyond its net turn (detour), and keep changing
    // its axis of rotation (headingTurn), while each step stays small enough
    // to track by eye. EXPERT_STYLES may demand more but never less.
    var EXPERT_FRAME_COUNT = 14;
    // Clustered tiers settle this long per step, matching the independent
    // replay (validate-presets.js --settle-ms 800). At 400 ms, small markers
    // in tight groups ended clipped or a few pixels under the spacing floor.
    var CLUSTER_SETTLE_MS = 800;
    var EXPERT_MOTION = {
        minEndAngle: 1.3,
        maxStepAngle: 0.9,
        minPathAngle: 5,
        minDetour: 1.6,
        minHeadingTurn: Math.PI,
        minAxisSpan: 0.3,
        minMajorAxisSpan: 0.8
    };

    // Clustered point layouts. A preset is a seed layout plus its twin: every
    // front seed dot has a hidden twin at its image under a rotation the
    // folded model carries (see Symmetric twins), so the final image cannot
    // say which of the two is the dot without the frames in between. Back
    // groups are twinned only where twinBack is set; real dots are always on
    // the front, and expert found no poses showing back twins as well. The
    // ranges below describe the seed layout drawn by drawClusterLayout,
    // except points, which counts every dot, twins included. In the seed
    // layout, each tracked panel carries
    // one visible anchor and its hidden decoys, other front panels carry
    // decoy-only groups, and exposed back panels carry back groups (expert
    // keeps at least one, which its side rule requires). Every group draws its
    // size from groupSize, and which front groups hold the anchors is drawn
    // after the sizes, with odds proportional to size, so every front dot is
    // about equally likely to be an answer. Medium (d3) has no back groups,
    // so it keeps its one-sided character. searchPools is what trajectory
    // search requires before a trajectory counts: readable panels, and
    // readable panel and twin-panel pairs under a carried rotation (twin*).
    // Other tiers have no layout.
    var TIER_LAYOUTS = {
        3: { tracked: [2, 3], groupSize: [1, 4], decoyGroups: [0, 2], backGroups: [0, 0], points: [10, 14], twinBack: true,
             pointRadius: 0.018, scatter: [0, 0],
             group: { radiusPx: [40, 60], centerGapPx: 20, reachPx: 95, spreadPx: 100 },
             searchPools: { visibleFront: 2, finalFront: 2, finalBack: 0,
                 twinFrontPairs: 2, twinBackPairs: 0, twinAnchorPairs: 2 } },
        5: { tracked: [1, 2], groupSize: [1, 4], decoyGroups: [0, 2], backGroups: [1, 2], points: [12, 20], twinBack: false,
             pointRadius: 0.014, scatter: [0, 0],
             group: { radiusPx: [60, 95], centerGapPx: 40, reachPx: 120, spreadPx: 125 },
             searchPools: { visibleFront: 2, finalFront: 2, finalBack: 2,
                 twinFrontPairs: 1, twinBackPairs: 0, twinAnchorPairs: 1 } }
    };
    var EXPERT_LAYOUT = TIER_LAYOUTS[5];
    // A run can ask for other dot totals than the tier's (generate-presets.js
    // --cluster-points). Each job loads its own page, so the override covers
    // that job's generation and validation and nothing else.
    // Scatter dots likewise (--cluster-scatter): see drawClusterLayout. So
    // are group sizes (--cluster-group-size): 2,4 keeps a decoy beside every
    // grouped dot. End sizes (--cluster-end-sizes) draw each dot in the last
    // image at its own size, relative to pointRadius; see
    // createPresetFromProgression.
    // Back groups (--cluster-back-groups) likewise; 0,0 makes front-only
    // expert presets for bases whose twin pairs and back panels never show
    // together (the 180-degree bases: their twins sit on the far side).
    var clusterPointsOverride = null, clusterScatterOverride = null, clusterGroupSizeOverride = null;
    var clusterBackGroupsOverride = null;
    // Symmetric twins (--symmetric-twins): a tracked dot's twin must meet the
    // anchor's rules in every frame too, so neither panel of a pair is
    // favoured and the tracked group does not end up facing the camera more
    // squarely than its twin (expert's 70% twin-facing lean).
    var clusterSymmetricTwins = false;
    var clusterEndSizes = null;
    // Medium spin, in turns either way (--cluster-spin-turns); half a turn
    // when unset. See spinProfiles.
    var clusterSpinTurns = null;
    function asRange(range) { return Array.isArray(range) && range.length === 2 ? range.map(Number) : null; }
    function setClusterPoints(range) { clusterPointsOverride = asRange(range); }
    function setClusterScatter(range) { clusterScatterOverride = asRange(range); }
    function setClusterGroupSize(range) { clusterGroupSizeOverride = asRange(range); }
    function setClusterBackGroups(range) { clusterBackGroupsOverride = asRange(range); }
    function setClusterSymmetricTwins(on) { clusterSymmetricTwins = !!on; }
    function setClusterEndSizes(range) { clusterEndSizes = asRange(range); }
    function setClusterSpinTurns(turns) { clusterSpinTurns = turns > 0 ? Number(turns) : null; }
    function clusterLayout(difficulty) {
        var L = TIER_LAYOUTS[clampDifficultyTier(difficulty)] || null;
        if (!L || (!clusterPointsOverride && !clusterScatterOverride && !clusterGroupSizeOverride && !clusterBackGroupsOverride
            && !clusterSymmetricTwins)) return L;
        var searchPools = Object.assign({}, L.searchPools, clusterBackGroupsOverride
            ? { finalBack: Math.min(L.searchPools.finalBack, clusterBackGroupsOverride[1]) } : {},
            clusterSymmetricTwins ? { symmetricTwins: true } : {});
        return Object.assign({}, L, { searchPools: searchPools }, clusterSymmetricTwins ? { symmetricTwins: true } : {},
            clusterPointsOverride ? { points: clusterPointsOverride } : {},
            clusterScatterOverride ? { scatter: clusterScatterOverride } : {},
            clusterGroupSizeOverride ? { groupSize: clusterGroupSizeOverride } : {},
            // Search never asks for more readable back panels than groups.
            clusterBackGroupsOverride ? { backGroups: clusterBackGroupsOverride } : {});
    }

    // Draws one preset's layout: dot counts for its tracked panels, its
    // decoy-only front panels and its back panels. `avail` caps the panel
    // counts by what a trajectory offers (tracked: faces an anchor may use;
    // front: all front faces a group may use, tracked ones included; back:
    // exposed back faces). Group sizes are drawn first, all from one range,
    // and the total is fitted by redrawing. Anchored groups are then drawn
    // from the front groups with odds proportional to size: a group holds one
    // answer whatever its size, so uniform odds would make dots in small
    // groups likelier answers, and drawing roles before sizes made anchored
    // groups too large. Returns null when the trajectory cannot fit the tier.
    //
    // Scatter dots (L.scatter, off unless a run sets it) are extra lone dots
    // placed during refinement at random anywhere on the visible paper, so
    // their distance from the groups varies. Each gets a twin like any front
    // dot. They join the anchor
    // draw as groups of one, so a lone dot near a group is as likely to be
    // an answer as any grouped dot, and ignoring loose dots gains nothing.
    function drawClusterLayout(L, rng, avail) {
        if (L.scatter && L.scatter[1] > 0) return drawScatteredLayout(L, rng, avail);
        var minFront = L.tracked[0] + L.decoyGroups[0];
        var maxFront = Math.min(L.tracked[1] + L.decoyGroups[1], avail.front);
        var maxBack = Math.min(L.backGroups[1], avail.back);
        if (Math.min(L.tracked[1], avail.tracked) < L.tracked[0] || maxFront < minFront || maxBack < L.backGroups[0]) return null;
        for (var attempt = 0; attempt < 400; attempt++) {
            var front = rng.randInt(minFront, maxFront);
            var back = rng.randInt(L.backGroups[0], maxBack);
            var lo = Math.max(L.tracked[0], front - L.decoyGroups[1]);
            var hi = Math.min(L.tracked[1], front - L.decoyGroups[0], avail.tracked);
            if (hi < lo) continue;
            var sizes = [];
            for (var g = 0; g < front + back; g++) sizes.push(rng.randInt(L.groupSize[0], L.groupSize[1]));
            // Every front dot has a twin; back dots do unless twinBack is off.
            var total = sizes.reduce(function (sum, size, g) { return sum + size * (g < front || L.twinBack ? 2 : 1); }, 0);
            if (total < L.points[0] || total > L.points[1]) continue;
            var anchored = chooseAnchoredGroups(sizes.slice(0, front), rng.randInt(lo, hi), rng);
            if (!anchored) continue;
            var decoys = rng.shuffle(sizes.slice(0, front).map(function (_, i) { return i; })
                .filter(function (i) { return anchored.indexOf(i) < 0; }));
            return {
                tracked: anchored.map(function (i) { return sizes[i]; }),
                decoyGroups: decoys.map(function (i) { return sizes[i]; }),
                backGroups: sizes.slice(front)
            };
        }
        return null;
    }

    // drawClusterLayout with scatter dots. Anchors are drawn over the front
    // groups and the scatter dots together; a layout is redrawn when its
    // anchored groups need more anchor panels than the trajectory offers.
    // Decoy-only groups are capped through the front total (tracked plus
    // decoy maximum), not on their own: when anchors land on scatter dots,
    // more groups go unanchored, and redrawing those layouts made grouped
    // dots about 10% likelier answers than scatter dots. Returns the layout plus
    // `scatter` (scatter dots, before twins) and `trackedScatter` (how many
    // of them are anchors).
    function drawScatteredLayout(L, rng, avail) {
        var minFront = Math.max(1, L.decoyGroups[0]);
        var maxFront = Math.min(L.tracked[1] + L.decoyGroups[1], avail.front);
        var maxBack = Math.min(L.backGroups[1], avail.back);
        if (maxFront < minFront || maxBack < L.backGroups[0]) return null;
        for (var attempt = 0; attempt < 800; attempt++) {
            var front = rng.randInt(minFront, maxFront);
            var back = rng.randInt(L.backGroups[0], maxBack);
            var scatter = rng.randInt(L.scatter[0], L.scatter[1]);
            var sizes = [];
            for (var g = 0; g < front + back; g++) sizes.push(rng.randInt(L.groupSize[0], L.groupSize[1]));
            var total = 2 * scatter + sizes.reduce(function (sum, size, g) { return sum + size * (g < front || L.twinBack ? 2 : 1); }, 0);
            if (total < L.points[0] || total > L.points[1]) continue;
            var units = sizes.slice(0, front);
            for (var k = 0; k < scatter; k++) units.push(1);
            var anchored = chooseAnchoredGroups(units, rng.randInt(L.tracked[0], L.tracked[1]), rng);
            if (!anchored) continue;
            var groups = anchored.filter(function (i) { return i < front; });
            var decoys = front - groups.length;
            if (groups.length > avail.tracked || decoys < L.decoyGroups[0]) continue;
            return {
                tracked: groups.map(function (i) { return sizes[i]; }),
                decoyGroups: rng.shuffle(sizes.slice(0, front).map(function (_, i) { return i; })
                    .filter(function (i) { return groups.indexOf(i) < 0; })).map(function (i) { return sizes[i]; }),
                backGroups: sizes.slice(front),
                scatter: scatter,
                trackedScatter: anchored.length - groups.length
            };
        }
        return null;
    }

    // Picks `count` of the front groups to hold anchors, each with probability
    // count * size / total (systematic sampling in a random order), so every
    // front dot is equally likely to be an answer. Returns indices, or null
    // when a group is too large for that, which callers redraw.
    function chooseAnchoredGroups(sizes, count, rng) {
        var total = sizes.reduce(function (sum, size) { return sum + size; }, 0);
        var step = total / count;
        if (sizes.some(function (size) { return size > step; })) return null;
        var order = rng.shuffle(sizes.map(function (_, i) { return i; }));
        var next = rng.random() * step, cumulative = 0, picked = [];
        order.forEach(function (i) {
            cumulative += sizes[i];
            if (next < cumulative && picked.length < count) {
                picked.push(i);
                next += step;
            }
        });
        return picked;
    }

    // Dirichlet(alpha, alpha, alpha) barycentric sample with every coordinate
    // at least `floor`. alpha < 1 favours spots near a panel's edges and
    // corners. Gamma draws use Marsaglia-Tsang, boosted for alpha < 1.
    function sampleGamma(rng, alpha) {
        if (alpha < 1) return sampleGamma(rng, alpha + 1) * Math.pow(rng.random() || 1e-12, 1 / alpha);
        var d = alpha - 1 / 3, c = 1 / Math.sqrt(9 * d);
        for (;;) {
            var x = rng.gaussian(0, 1), v = 1 + c * x;
            if (v <= 0) continue;
            v = v * v * v;
            var u = rng.random();
            if (Math.log(u || 1e-12) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
        }
    }
    function sampleBarycentric(rng, alpha, floor) {
        for (var attempt = 0; attempt < 200; attempt++) {
            var g = [sampleGamma(rng, alpha), sampleGamma(rng, alpha), sampleGamma(rng, alpha)];
            var sum = g[0] + g[1] + g[2];
            var u = Math.round(g[0] / sum * 1000) / 1000;
            var v = Math.round(g[1] / sum * 1000) / 1000;
            var w = Math.round((1 - u - v) * 1000) / 1000;
            if (u >= floor && v >= floor && w >= floor) return { u: u, v: v, w: w };
        }
        return { u: 0.334, v: 0.333, w: 0.333 };
    }
    // Splits `total` samples over the faces in proportion to their area on
    // the flat sheet, at least one each, so uniform samples within each face
    // cover the whole sheet evenly.
    function areaSampleCounts(faces, xy, total) {
        var areas = faces.map(function (f) {
            var a = xy[f[0]], b = xy[f[1]], c = xy[f[2]];
            return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
        });
        var sum = areas.reduce(function (s, area) { return s + area; }, 0) || 1;
        return areas.map(function (area) { return Math.max(1, Math.round(total * area / sum)); });
    }
    // Clustered tiers use dots smaller than the 0.025 default: medium 0.018,
    // expert 0.014 (TIER_LAYOUTS pointRadius). The spacing floor and the
    // footprint check scale with the radius, so the gap between dots stays
    // about the same relative to their size: 50 px at 0.018.
    var DEFAULT_POINT_RADIUS = 0.025;
    var CLUSTER_POINT_RADIUS = 0.018;
    var CLUSTER_MIN_SEPARATION_PX = 50;
    function clusterPointRadius(difficulty) {
        var L = clusterLayout(difficulty);
        return L && L.pointRadius || CLUSTER_POINT_RADIUS;
    }
    function clusterMinSeparationPx(difficulty) {
        return Math.round(CLUSTER_MIN_SEPARATION_PX * clusterPointRadius(difficulty) / CLUSTER_POINT_RADIUS);
    }
    // Each tracked panel's dots form a tight group, so rough position cannot
    // tell the tracked dot from its decoys. Placement is sampled, not
    // optimised. Each preset draws a Dirichlet alpha for its barycentric
    // samples, and each group a radius (TIER_LAYOUTS group.radiusPx) within
    // which its later dots land at random around a center: the first dot,
    // or a spot up to group.centerGapPx beyond the spacing floor from it.
    // Decoys must land within group.reachPx of the center, and validation
    // requires every dot to finish within group.spreadPx of its group's
    // centroid. On narrow panels four dots form a line about 165 px long at
    // a 50 px floor (82 px from the centroid), so the spread must exceed
    // that. The spacing floor, footprint clearance, viewing-ratio and
    // group-spread checks keep every result legible; the barycentric floor
    // only keeps samples off the crease. Medium's groups are tighter than
    // expert's since the 2026-10-06 climb: the looser groups were too easy.
    var CLUSTER_ALPHA = [0.5, 1.0];
    var CLUSTER_BARY_FLOOR = 0.03;
    function clusterGroupGeometry(difficulty) {
        var L = clusterLayout(difficulty);
        return L && L.group || { radiusPx: [60, 95], centerGapPx: 40, reachPx: 120, spreadPx: 125 };
    }

    // The footprint check samples a disk slightly larger than the dot.
    // With endDotSizes, it covers the largest end size.
    function markerClearanceRadius(preset) {
        var largest = preset && preset.endDotSizes ? Math.max(1, preset.endDotSizes[1]) : 1;
        return 0.03 * (preset && preset.pointRadius || DEFAULT_POINT_RADIUS) / DEFAULT_POINT_RADIUS * largest;
    }

    // Point indices of every panel holding two or more dots: tracked groups
    // and decoy-only groups alike. Back dots sit on distinct panels, so they
    // never form a group.
    function clusterGroups(points) {
        var groups = {};
        points.forEach(function (p, i) { if (!p.scatter) (groups[p.faceId] = groups[p.faceId] || []).push(i); });
        return Object.keys(groups).map(function (face) { return groups[face]; })
            .filter(function (group) { return group.length > 1; });
    }

    // k-element subsets of items, in lexicographic index order.
    function combinationsOf(items, k) {
        var out = [];
        (function pick(from, chosen) {
            if (chosen.length === k) { out.push(chosen.slice()); return; }
            for (var i = from; i <= items.length - (k - chosen.length); i++) {
                chosen.push(items[i]);
                pick(i + 1, chosen);
                chosen.pop();
            }
        })(0, []);
        return out;
    }

    // Expert motion uses actual orientation changes, including the first
    // frame. Euler component lengths overstate some compound rotations.
    function measureExpertMotion(steps) {
        var rotations = steps.map(function (step) { return parseRotationVec(step.rotation); });
        var quaternions = rotations.map(function (r) {
            return new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0], r[1], r[2], "XYZ"));
        });
        var maxStepAngle = 0, pathAngle = 0, headingTurn = 0, prevAxis = null;
        for (var i = 1; i < quaternions.length; i++) {
            var dq = quaternions[i].clone().multiply(quaternions[i - 1].clone().conjugate());
            var stepAngle = 2 * Math.acos(Math.min(1, Math.abs(dq.w)));
            maxStepAngle = Math.max(maxStepAngle, stepAngle);
            pathAngle += stepAngle;
            // A near-zero step has no stable axis, so it cannot turn the path.
            if (stepAngle < 0.05) continue;
            var axis = new THREE.Vector3(dq.x, dq.y, dq.z).multiplyScalar(dq.w < 0 ? -1 : 1).normalize();
            if (prevAxis) headingTurn += Math.acos(Math.max(-1, Math.min(1, axis.dot(prevAxis))));
            prevAxis = axis;
        }
        var axisSpans = [0, 1, 2].map(function (k) {
            var values = rotations.map(function (r) { return r[k]; });
            return values.length ? Math.max.apply(null, values) - Math.min.apply(null, values) : 0;
        });
        // Euler y is the paper normal. Summed per-step changes count the
        // spin; the largest per-step change catches 2*pi jumps, which look
        // like no motion at all. maxYawStep matters on symmetric bases, where
        // a large in-plane step can look like a smaller one the other way.
        var spin = 0, maxEulerStep = 0, maxYawStep = 0;
        for (var e = 1; e < rotations.length; e++) {
            spin += rotations[e][1] - rotations[e - 1][1];
            maxYawStep = Math.max(maxYawStep, Math.abs(rotations[e][1] - rotations[e - 1][1]));
            for (var ax = 0; ax < 3; ax++) {
                maxEulerStep = Math.max(maxEulerStep, Math.abs(rotations[e][ax] - rotations[e - 1][ax]));
            }
        }
        var endAngle = quaternions.length
            ? 2 * Math.acos(Math.min(1, Math.abs(quaternions[0].dot(quaternions[quaternions.length - 1])))) : 0;
        return {
            endAngle: endAngle,
            maxStepAngle: maxStepAngle,
            pathAngle: pathAngle,
            detour: endAngle > 0 ? pathAngle / endAngle : 0,
            headingTurn: headingTurn,
            axisSpans: axisSpans,
            spinTurns: Math.abs(spin) / (2 * Math.PI),
            maxEulerStep: maxEulerStep,
            maxYawStep: maxYawStep
        };
    }

    function expertMotionFailures(steps) {
        var m = measureExpertMotion(steps || []);
        var c = EXPERT_MOTION;
        var failures = [];
        if (m.endAngle < c.minEndAngle) failures.push("requires a net turn of at least " + c.minEndAngle + " rad");
        if (m.maxStepAngle > c.maxStepAngle) failures.push("steps must turn no more than " + c.maxStepAngle + " rad");
        if (m.maxEulerStep > 2 * c.maxStepAngle) failures.push("rotation values must change gradually between frames");
        if (m.pathAngle < c.minPathAngle) failures.push("requires a path of at least " + c.minPathAngle + " rad");
        if (m.detour < c.minDetour) failures.push("path must be at least " + c.minDetour + "x the net turn");
        if (m.headingTurn < c.minHeadingTurn) failures.push("rotation axis must change direction by at least " + c.minHeadingTurn.toFixed(2) + " rad");
        var spans = m.axisSpans.slice().sort(function (a, b) { return a - b; });
        if (spans[0] < c.minAxisSpan || spans[1] < c.minMajorAxisSpan) {
            failures.push("requires all three axes to move, two of them by at least " + c.minMajorAxisSpan + " rad");
        }
        return failures;
    }

    // Contract for tiers with a clustered point layout (medium and expert).
    // Both need tight same-color groups of small markers and a fixed camera;
    // expert adds its frame count and direction-changing motion. Medium keeps
    // its own ramping motion, checked by matchesDifficultyMotion.
    var TIER_FRAME_COUNT = { 3: 10, 5: EXPERT_FRAME_COUNT };
    function clusterPresetFailures(preset, points, faceCount) {
        var failures = [];
        var tier = clampDifficultyTier(preset.difficulty);
        var L = clusterLayout(tier);
        var tierName = tier === 5 ? "expert" : "medium";
        function requireRule(ok, reason) { if (!ok) failures.push({ reason: tierName + " tier: " + reason }); }
        if (!L) return [{ reason: "tier " + tier + " has no clustered layout" }];
        var steps = preset.steps || [];
        requireRule(steps.length === TIER_FRAME_COUNT[tier], "requires " + TIER_FRAME_COUNT[tier] + " frames");
        if (tier === 5) expertMotionFailures(steps).forEach(function (reason) { requireRule(false, reason); });
        requireRule(steps.length > 0 && steps[0].fold === 0 && steps[steps.length - 1].fold >= 55,
            "requires a flat start and a final fold of at least 55 percent");
        for (var i = 1; i < steps.length; i++) {
            requireRule(steps[i].fold > steps[i - 1].fold && steps[i].fold - steps[i - 1].fold <= 20,
                "fold increments must be positive and no larger than 20 percent");
            requireRule(angleBetweenVec3(parsePovVec(steps[0].pov), parsePovVec(steps[i].pov)) < 0.0001,
                "camera must stay fixed");
        }
        function within(n, range) { return n >= range[0] && n <= range[1]; }
        // Pairs: every seed dot and its twin share `pair`; the twin is hidden
        // and marked `twin`, and the twins of one seed panel share one panel.
        // Back dots carry no pair when the tier leaves them untwinned.
        var pairs = {};
        points.forEach(function (point, i) { if (point.pair != null) (pairs[point.pair] = pairs[point.pair] || []).push(i); });
        var seeds = points.filter(function (point) { return !point.twin; });
        var twinFaceOf = {}, twinFacesConsistent = true;
        var pairsOk = points.every(function (point) {
                return L.twinBack || point.faceId < faceCount ? point.pair != null : point.pair == null && !point.twin;
            })
            && Object.keys(pairs).every(function (key) {
                var members = pairs[key].map(function (i) { return points[i]; });
                var twins = members.filter(function (point) { return point.twin; });
                if (members.length !== 2 || twins.length !== 1 || !twins[0].hidden) return false;
                var seed = members[0].twin ? members[1] : members[0];
                if (twinFaceOf[seed.faceId] != null && twinFaceOf[seed.faceId] !== twins[0].faceId) twinFacesConsistent = false;
                twinFaceOf[seed.faceId] = twins[0].faceId;
                return true;
            });
        var placement = preset.clusterPlacement || {};
        requireRule(pairsOk && twinFacesConsistent && SHEET_ISOMETRIES.some(function (iso) {
            return iso.name === placement.symmetry && !isMirror(iso);
        }), "every " + (L.twinBack ? "" : "front ") + "dot needs a hidden twin, on one twin panel per seed panel, under a named sheet rotation");
        // The seed half follows the tier's ranges.
        var frontGroups = {}, backPanels = {}, visibleBack = 0;
        // Scatter dots sit anywhere on the front panels, apart from the
        // group counts; they are checked on their own below.
        var scatterSeeds = seeds.filter(function (point) { return point.scatter; });
        var scatterAnchors = scatterSeeds.filter(function (point) { return !point.hidden; }).length;
        requireRule(within(scatterSeeds.length, L.scatter || [0, 0])
            && scatterSeeds.every(function (point) { return point.faceId < faceCount; })
            && points.every(function (point) { return !point.twin || !!point.scatter === !!(seedOfPair(point) || {}).scatter; }),
            "requires " + (L.scatter || [0, 0]).join("-") + " scatter dots on front panels, each twinned by a scatter dot");
        function seedOfPair(twin) {
            return points.filter(function (point) { return !point.twin && point.pair === twin.pair; })[0];
        }
        seeds.filter(function (point) { return !point.scatter; }).forEach(function (point) {
            if (point.faceId < faceCount) {
                var group = frontGroups[point.faceId] = frontGroups[point.faceId] || { size: 0, anchors: 0 };
                group.size++;
                if (!point.hidden) group.anchors++;
            } else {
                if (!point.hidden) visibleBack++;
                var physical = point.faceId % faceCount;
                backPanels[physical] = (backPanels[physical] || 0) + 1;
            }
        });
        var groups = Object.keys(frontGroups).map(function (face) { return frontGroups[face]; });
        var tracked = groups.filter(function (g) { return g.anchors > 0; });
        // With scatter, decoy-only groups are capped through the front total
        // (drawScatteredLayout).
        var decoyRange = scatterSeeds.length ? [L.decoyGroups[0], L.tracked[1] + L.decoyGroups[1] - tracked.length] : L.decoyGroups;
        requireRule(within(tracked.length + scatterAnchors, L.tracked)
            && tracked.every(function (g) { return g.anchors === 1; })
            && within(groups.length - tracked.length, decoyRange)
            && groups.every(function (g) { return within(g.size, L.groupSize); }),
            "requires " + L.tracked.join("-") + " tracked panels with one anchor each, " + L.decoyGroups.join("-")
            + " decoy-only panels, and " + L.groupSize.join("-") + " dots on every front panel used, before twins");
        requireRule(within(Object.keys(backPanels).length, L.backGroups) && visibleBack === 0
            && Object.keys(backPanels).every(function (face) { return within(backPanels[face], L.groupSize) && !frontGroups[face]; }),
            "requires " + L.backGroups.join("-") + " back panels of " + L.groupSize.join("-") + " hidden dots, apart from the front panels used, before twins");
        requireRule(within(points.length, L.points), "requires " + L.points.join("-") + " dots, twins included");
        var endSizes = preset.endDotSizes;
        requireRule(!endSizes || points.every(function (point) {
            return point.endScale >= endSizes[0] && point.endScale <= endSizes[1];
        }), "requires an end size within " + (endSizes || []).join("-") + " for every dot");
        // Every panel, seed or twin, holds one group.
        var panels = {};
        points.filter(function (point) { return !point.scatter; }).forEach(function (point) {
            var key = point.faceId + (point.twin ? "t" : "s");
            panels[key] = true;
        });
        var faceUse = {};
        Object.keys(panels).forEach(function (key) { var face = parseInt(key, 10); faceUse[face] = (faceUse[face] || 0) + 1; });
        var physicalUse = {};
        Object.keys(faceUse).forEach(function (face) { var phys = Number(face) % faceCount; physicalUse[phys] = (physicalUse[phys] || 0) + 1; });
        requireRule(Object.keys(faceUse).every(function (face) { return faceUse[face] === 1; })
            && Object.keys(physicalUse).every(function (phys) { return physicalUse[phys] === 1; }),
            "seed and twin groups need panels of their own");
        requireRule(preset.colorMode === "labelOnly" && !!preset.color1 && preset.color1 === preset.color2,
            "paper sides must use the same color");
        requireRule(preset.minPointViewQuality >= 0.3 && preset.requirePointClearance === true,
            "marker viewing quality and footprint clearance cannot be relaxed");
        requireRule(preset.pointRadius != null && preset.pointRadius <= clusterPointRadius(tier),
            "requires markers no larger than radius " + clusterPointRadius(tier));
        requireRule(preset.minPointSeparationPx >= clusterMinSeparationPx(tier) && preset.enforceSeparationAllSteps === true,
            "requires at least " + clusterMinSeparationPx(tier) + " px separation throughout the sequence");
        return failures;
    }

    function matchesDifficultyMotion(steps, difficulty, metrics) {
        var d = clampDifficultyTier(difficulty);
        if (d === 5) return expertMotionFailures(steps).length === 0;
        // Clustered medium spins about the paper normal (Euler y) on purpose
        // (spinProfiles). Judging that spin as ramp motion ranked large spins
        // last, so presets kept small turns and the least-turn guess told dots
        // from twins again. Judge the ramp on the other two angles.
        if (d === 3 && clusterLayout(d)) {
            metrics = null;
            steps = (steps || []).map(function (step) {
                var r = parseRotationVec(step.rotation);
                return Object.assign({}, step, { rotation: [r[0], 0, r[2]] });
            });
        }
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
        // Clustered tiers follow their layout: expert run with
        // --cluster-back-groups 0,0 is front only.
        var L = clusterLayout(difficulty);
        if (L ? L.backGroups[0] > 0 : profile.requiresBothSides) {
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

        // simpleVertex: settle 50% longer because the multi-panel stack at
        // the central vertex is still relaxing past the 600ms baseline.
        // The face that getVisibleFaceIds returns now may be different
        // from the one visible after another 300ms of solver iteration —
        // and the renderer settles longer, so we mirror that here.
        var isSVHidden = !!(preset.model && preset.model.indexOf("simpleVertex") >= 0);
        var settle = Math.max(settleMs || 300, isSVHidden ? 900 : 600);
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

            // simpleVertex: re-check back-side visibility at this longer
            // settle. Timeline-recorded backSideVisibleFaceIds came from
            // a 300ms-settle pass and can include faces whose back
            // collapses under another panel by 900ms. Tightening here
            // means the back-pool pick reflects the post-settle state
            // the renderer will actually see.
            var backVisibleNow = null;
            if (isSVHidden && globals.facePoints.getBackSideVisibleFaceIds) {
                var bv = globals.facePoints.getBackSideVisibleFaceIds() || [];
                backVisibleNow = {};
                for (var bvi = 0; bvi < bv.length; bvi++) backVisibleNow[bv[bvi]] = true;
            }

            function pickFromPool(poolIds, count, isBack) {
                if (count <= 0) return [];
                var cands = poolIds.filter(function (id) { return visibleIds.indexOf(id) !== -1; });
                if (isBack && backVisibleNow) {
                    cands = cands.filter(function (id) { return backVisibleNow[id]; });
                }
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

            var pickedBack = pickFromPool(backIds, wantBack, true);
            var pickedFront = pickFromPool(frontIds, wantFront, false);
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
    // Clustered tiers (medium, expert) sample instead of scoring for
    // evenness. Candidates come from the preset's Dirichlet, each panel's
    // first dot takes the legible spot nearest a sampled one, and later dots
    // land at random within the group's radius. The supplied RNG makes this
    // reproducible per seed; the readability gates still apply to every pick.

    function refineFacePointBarycentric(preset, settleMs, rng, callback) {
        if (!preset || !preset.facePoints) { callback(preset); return; }
        if (!globals.benchmark || !globals.model || !globals.facePoints || !globals.threeView) {
            callback(preset); return;
        }
        var steps = preset.steps || [];
        if (steps.length === 0) { callback(preset); return; }

        // Legacy mapfold presets use a centrality margin. New presets test
        // the marker footprint directly so exposed panel edges remain usable.
        var refineMinBaryMargin = (!preset.requirePointClearance && preset.model && preset.model.indexOf("mapfold") >= 0) ? 0.27 : 0;

        // simpleVertex-only: ~4-6 panels meet at one vertex, so the
        // converged layer ordering near the center takes noticeably
        // longer to settle than spread-fold geometries — and hidden
        // reveal points selected as "visible" at refinement-settle
        // can end up under a still-collapsing layer at render-settle.
        // Counter with (a) longer settle in refinement and (b) Tier-1
        // clearance required for hidden points (no Tier-2 fallback).
        var isSimpleVertexModel = !!(preset.model && preset.model.indexOf("simpleVertex") >= 0);

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
        // simpleVertex: bump ONLY finalSettle. The mid-fold probe (perStepSettle)
        // also got bumped briefly; that caused visible-front anchors to be
        // over-rejected by survivesByEntry because tighter post-settle stacks
        // occluded candidates that the renderer (which doesn't pause as long
        // mid-fold) never sees as occluded. Hidden reveals only need final-step
        // visibility, so the per-step floor stays at 400ms.
        // Expert: settle as long as the 800 ms replay that decides whether a
        // preset ships. The expert final pose leaves bird markers clipped or a
        // few pixels short of the spacing floor at 400 ms.
        var expertSettle = clusterLayout(preset.difficulty) ? CLUSTER_SETTLE_MS : 0;
        var perStepSettle = Math.max(settleMs || 300, 400, expertSettle);
        var finalSettle = Math.max(settleMs || 300, isSimpleVertexModel ? 800 : 400, expertSettle);

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

        // Scatter dots (and their twins) land anywhere on the paper, not in a group.
        function isScatter(entry) { return !!(entry && entry.ref && entry.ref.scatter); }

        // Twins follow their seed dots under the preset's rotation: they are
        // placed with them, not searched.
        var twinOf = {}, isTwinIndex = {};
        var twinFaceCount = globals.model.getFaces().length, twinSheet = null, twinIso = null;
        if (clusterLayout(preset.difficulty)) {
            var twinEntries = entries.filter(function (entry) { return entry.ref && entry.ref.twin; });
            entries = entries.filter(function (entry) { return !(entry.ref && entry.ref.twin); });
            var startPts = globals.facePoints.getPoints();
            twinEntries.forEach(function (twin) {
                twin.face = startPts[twin.idx] && startPts[twin.idx].faceId;
                isTwinIndex[twin.idx] = true;
                entries.forEach(function (seed) {
                    if (seed.ref && seed.ref.pair === twin.ref.pair) twinOf[seed.idx] = twin;
                });
            });
            if (twinEntries.length) {
                twinSheet = flatSheet();
                twinIso = SHEET_ISOMETRIES.filter(function (iso) {
                    return iso.name === (preset.clusterPlacement || {}).symmetry;
                })[0] || null;
            }
        }

        // Build the candidate grid (deterministic per-preset jittered).
        var jitterSeedHoisted = 2166136261;
        // Hash both supported point forms, including ordered expert arrays.
        var placementKey = JSON.stringify(preset.facePoints);
        for (var hk = 0; hk < placementKey.length; hk++) {
            jitterSeedHoisted = Math.imul(jitterSeedHoisted ^ placementKey.charCodeAt(hk), 16777619);
        }
        var layout = clusterLayout(preset.difficulty);
        var groupGeometry = clusterGroupGeometry(preset.difficulty);
        if (layout && rng) jitterSeedHoisted ^= rng.randInt(1, 2147483647);
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
        // Clustered tiers sample candidates from this preset's Dirichlet
        // instead of a grid, so no position recurs across presets.
        var clusterAlpha = layout ? ((preset.clusterPlacement && preset.clusterPlacement.alpha)
            || Math.round(jitterRngHoisted.randFloat(CLUSTER_ALPHA[0], CLUSTER_ALPHA[1]) * 100) / 100) : 0;
        var baseCandidates = [];
        if (layout) {
            for (var ds = 0; ds < 48; ds++) baseCandidates.push(sampleBarycentric(jitterRngHoisted, clusterAlpha, CLUSTER_BARY_FLOOR));
        } else {
            var refineTierH = (preset && preset.difficulty) ? clampDifficultyTier(preset.difficulty) : 4;
            var gridValuesH = (refineTierH <= 2) ? [0.27, 0.37, 0.47] : [0.22, 0.30, 0.38, 0.45, 0.52];
            for (var uH = 0; uH < gridValuesH.length; uH++) {
                for (var vH = 0; vH < gridValuesH.length; vH++) {
                    var cH = mkH(gridValuesH[uH], gridValuesH[vH]);
                    if (cH.w < 0.18) continue;
                    baseCandidates.push(cH);
                }
            }
            baseCandidates.push(mkH(0.33, 0.33));
            if (preset.requirePointClearance) {
                // Explore exposed parts of a folded panel outside its center.
                // Physical footprint clearance supplies the edge margin here.
                for (var gu = 1; gu <= 8; gu++) {
                    for (var gv = 1; gv <= 9 - gu; gv++) {
                        baseCandidates.push({ u: gu / 10, v: gv / 10, w: (10 - gu - gv) / 10 });
                    }
                }
            }
        }

        var trackingMode = String(preset.trackingEvalMode || "strictAllSteps").trim().toLowerCase();
        var finalOnly = ["finalsteponly", "finalstep", "final", "final-only", "final_step_only"].indexOf(trackingMode) >= 0;
        var entriesByIndex = {};
        entries.forEach(function (entry) {
            var original = parseBaryEntry(entry.ref);
            entry.candidates = baseCandidates.slice();
            // The original is a real candidate: it must pass the same gates.
            entry.candidates.push(original);
            entry.selected = entry.candidates.length - 1;
            // A spot drawn from the preset's Dirichlet, which may sit near a
            // crease. The first dot on a panel goes to the nearest legible
            // candidate, so different seeds give different placements.
            if (layout) entry.preferred = sampleBarycentric(jitterRngHoisted, clusterAlpha, CLUSTER_BARY_FLOOR);
            entriesByIndex[entry.idx] = entry;
        });
        // The first dot fitted on each panel seeds it: the anchor on a tracked
        // panel, the first decoy elsewhere. Later dots on the panel land at
        // random within the group's radius of a center near the seed.
        var seedOf = {}, groupSize = {}, groupRadius = {};
        if (layout) {
            // Fit anchors before their decoys without changing label order.
            // Scatter dots go last: they are placed around the groups.
            entries.sort(function (a, b) {
                return Number(isScatter(a)) - Number(isScatter(b)) || Number(a.hidden) - Number(b.hidden);
            });
            var ringPts = globals.facePoints.getPoints();
            entries.forEach(function (entry) {
                var point = ringPts[entry.idx];
                if (!point || isScatter(entry)) return;
                groupSize[point.faceId] = (groupSize[point.faceId] || 0) + 1;
                if (!(point.faceId in seedOf)) seedOf[point.faceId] = entry.idx;
            });
            // The panel-wide samples are too sparse to fit a tight group.
            // A random cloud around each seed's preferred spot, shared by
            // every dot on that panel, gives the group room to form.
            Object.keys(seedOf).forEach(function (face) {
                var c = entriesByIndex[seedOf[face]].preferred;
                if (groupSize[face] > 1) {
                    groupRadius[face] = jitterRngHoisted.randFloat(groupGeometry.radiusPx[0], groupGeometry.radiusPx[1]);
                }
                var cloud = [{ u: c.u, v: c.v, w: c.w }];
                for (var k = 0; k < 72; k++) {
                    var r = jitterRngHoisted.randFloat(0.02, 0.16), a = jitterRngHoisted.randFloat(0, 2 * Math.PI);
                    var u = Math.round((c.u + r * Math.cos(a)) * 1000) / 1000;
                    var v = Math.round((c.v + r * Math.sin(a)) * 1000) / 1000;
                    var w = Math.round((1 - u - v) * 1000) / 1000;
                    if (u >= CLUSTER_BARY_FLOOR && v >= CLUSTER_BARY_FLOOR && w >= CLUSTER_BARY_FLOOR) cloud.push({ u: u, v: v, w: w });
                }
                entries.forEach(function (entry) {
                    if (ringPts[entry.idx] && String(ringPts[entry.idx].faceId) === face && !isScatter(entry)) {
                        entry.candidates = entry.candidates.concat(cloud);
                    }
                });
            });
            // A scatter dot lands at random anywhere on the visible paper:
            // candidates are spread over every front face in proportion to
            // its area, uniform within it (Dirichlet 1), and scoreCandidate
            // ranks them by noise alone, so the legibility gates decide
            // which spots count as visible. Each carries its faceId.
            var scatterCandidates = [];
            var sheetFaces = globals.model.getFaces();
            var perFace = twinSheet ? areaSampleCounts(sheetFaces, twinSheet.xy, 320)
                : sheetFaces.map(function () { return Math.max(3, Math.ceil(320 / Math.max(1, twinFaceCount))); });
            for (var sf = 0; sf < twinFaceCount; sf++) {
                for (var sk = 0; sk < perFace[sf]; sk++) {
                    var sc = sampleBarycentric(jitterRngHoisted, 1, CLUSTER_BARY_FLOOR);
                    scatterCandidates.push({ faceId: sf, u: sc.u, v: sc.v, w: sc.w });
                }
            }
            entries.forEach(function (entry) {
                if (!isScatter(entry)) return;
                var start = entry.candidates[entry.candidates.length - 1];
                entry.candidates = scatterCandidates.concat([{ faceId: entry.ref.near, u: start.u, v: start.v, w: start.w }]);
            });
        }
        entries.forEach(function (entry) {
            entry.survives = entry.candidates.map(function () { return true; });
            entry.screens = entry.candidates.map(function () { return []; });
            // Random tie-breaks for spots inside a group's radius.
            if (layout) entry.noise = entry.candidates.map(function () { return jitterRngHoisted.random(); });
        });

        // Record each candidate once per pose. Two optimization passes can
        // compare complete point paths without replaying the physics solver.
        function probeCandidatesAtCurrentStep() {
            var probePts = globals.facePoints.getPoints();
            entries.forEach(function (entry) {
                if (entry.hidden && finalOnly) return;
                var point = probePts[entry.idx];
                if (!point) return;
                var faceId = point.faceId;
                var original = { u: point.u, v: point.v, w: point.w };
                // Symmetric twins: a tracked dot's spot counts only if its
                // twin's spot is readable in this frame too.
                var twinEntry = preset.symmetricTwins && !entry.hidden && twinIso ? twinOf[entry.idx] : null;
                var twinHome = twinEntry && probePts[twinEntry.idx]
                    ? { faceId: probePts[twinEntry.idx].faceId, u: probePts[twinEntry.idx].u, v: probePts[twinEntry.idx].v, w: probePts[twinEntry.idx].w } : null;
                entry.candidates.forEach(function (candidate, ci) {
                    if (!entry.survives[ci]) return;
                    var face = candidate.faceId != null ? candidate.faceId : faceId;
                    globals.facePoints.updatePointPosition(entry.idx, face, candidate.u, candidate.v, candidate.w);
                    var screen = globals.facePoints.isPointVisible(entry.idx)
                        ? globals.benchmark.getPointScreenPosition(entry.idx) : null;
                    entry.screens[ci][stepIdx] = screen;
                    if (!screen || (!entry.hidden && preset.minPointViewQuality > 0
                        && globals.facePoints.getPointViewQuality(entry.idx) < preset.minPointViewQuality)) entry.survives[ci] = false;
                    else if (twinHome) {
                        var t = twinPoint({ faceId: face, u: candidate.u, v: candidate.v, w: candidate.w }, twinIso, twinSheet, twinFaceCount);
                        if (!t) { entry.survives[ci] = false; return; }
                        globals.facePoints.updatePointPosition(twinEntry.idx, t.faceId, t.u, t.v, t.w);
                        if (!globals.facePoints.isPointVisible(twinEntry.idx) || (preset.minPointViewQuality > 0
                            && globals.facePoints.getPointViewQuality(twinEntry.idx) < preset.minPointViewQuality)) entry.survives[ci] = false;
                    }
                });
                if (twinHome) globals.facePoints.updatePointPosition(twinEntry.idx, twinHome.faceId, twinHome.u, twinHome.v, twinHome.w);
                globals.facePoints.updatePointPosition(entry.idx, faceId, original.u, original.v, original.w);
            });
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
                var skipMidStep = preset.difficulty !== 5 && preset.model && preset.model.indexOf("mapfold") >= 0 && step.fold > 0;
                if (!isLast && !skipMidStep) {
                    probeCandidatesAtCurrentStep();
                }
                stepIdx++;
                applyNextStep();
            }, isLast ? finalSettle : perStepSettle);
        }

        function scoreAndRefine() {
            try {
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
                function scoreCandidate(entry, candidateIndex) {
                    var idx = entry.idx;
                    var cand = entry.candidates[candidateIndex];
                    var isHidden = entry.hidden;
                    if (!globals.facePoints.isPointVisible(idx)) return -Infinity;
                    if (preset.minPointViewQuality > 0 && globals.facePoints.getPointViewQuality(idx) < preset.minPointViewQuality) return -Infinity;
                    var surfaceClear = !globals.facePoints.hasSurfaceClearance
                        || globals.facePoints.hasSurfaceClearance(idx, markerClearanceRadius(preset));
                    if (preset.requirePointClearance && !surfaceClear) return -Infinity;
                    var clearanceOk = surfaceClear && (!globals.facePoints.hasForwardClearance
                        || globals.facePoints.hasForwardClearance(idx, clearanceDist));
                    // simpleVertex hidden-point gate: refusing Tier-2 here
                    // means a hidden reveal must have real layer clearance
                    // at the final pose, not just be technically visible.
                    // Without this, a reveal point can pass refinement while
                    // sitting in a thin gap that closes by render-settle.
                    if (isSimpleVertexModel && isHidden && !clearanceOk) return -Infinity;
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
                        if (oi === idx || !isPlaced(oi)) continue;
                        if (!globals.facePoints.isPointVisible(oi)) continue;
                        var oScr = globals.benchmark.getPointScreenPosition
                            ? globals.benchmark.getPointScreenPosition(oi) : null;
                        if (!oScr) continue;
                        var dx = scr.x - oScr.x, dy = scr.y - oScr.y;
                        var d = Math.sqrt(dx * dx + dy * dy);
                        if (d < minN) minN = d;
                    }
                    // Apply the configured final separation while ranking by
                    // the worst frame, including both selected point paths.
                    var requiredSeparation = preset.minPointSeparationPx != null ? preset.minPointSeparationPx : 70;
                    if (minN < requiredSeparation) return -Infinity;
                    var history = entry.screens[candidateIndex];
                    for (var frame = 0; frame < history.length; frame++) {
                        var screen = history[frame];
                        if (!screen) continue;
                        edge = Math.min(edge, screen.x, screen.y, canvasW - screen.x, canvasH - screen.y);
                        // Hidden labels are only drawn in the final image.
                        if (entry.hidden) continue;
                        var frameMin = Infinity;
                        for (var otherIdx in entriesByIndex) {
                            var other = entriesByIndex[otherIdx];
                            if (other.idx === idx || other.hidden || !isPlaced(other.idx)) continue;
                            var otherScreen = other.screens[other.selected][frame];
                            if (!otherScreen) continue;
                            var hx = screen.x - otherScreen.x, hy = screen.y - otherScreen.y;
                            frameMin = Math.min(frameMin, Math.sqrt(hx * hx + hy * hy));
                        }
                        var frameFloor = preset.enforceSeparationAllSteps ? requiredSeparation : 30;
                        if (frameMin < frameFloor) return -Infinity;
                        minN = Math.min(minN, frameMin);
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
                    // A seed dot's spot is legible only if its twin's is too.
                    if (twinOf[idx] && !(placeTwin(idx, cand) && twinReadable(idx))) return -Infinity;
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
                    if (layout && isScatter(entry)) {
                        // Any legible spot on the paper is as good as another.
                        raw = entry.noise[candidateIndex];
                    } else if (layout) {
                        // Placement is sampled, not scored for evenness: the
                        // gates above keep it legible.
                        var face = pts[idx].faceId;
                        var seedIdx = seedOf[face];
                        if (seedIdx != null && seedIdx !== idx) {
                            var seedScreen = globals.benchmark.getPointScreenPosition(seedIdx);
                            var offset = clusterOffsets[face] || [0, 0];
                            var centerDistance = Math.hypot(scr.x - seedScreen.x - offset[0], scr.y - seedScreen.y - offset[1]);
                            if (centerDistance > groupGeometry.reachPx && !ignoreClusterRadius) return -Infinity;
                            // Every spot within the group's radius is equally
                            // good, so the pick among them is random. Beyond
                            // it, nearer the center is better.
                            raw = centerDistance <= groupRadius[face]
                                ? 1000 + 100 * entry.noise[candidateIndex]
                                : -10 * centerDistance;
                        } else {
                            // A seed or a lone dot takes the legible spot
                            // nearest its preferred one.
                            var du = cand.u - entry.preferred.u;
                            var dv = cand.v - entry.preferred.v;
                            var dw = cand.w - entry.preferred.w;
                            raw = -10000 * (du * du + dv * dv + dw * dw);
                        }
                    }
                    // Tier-2 candidates are visible but sit under a
                    // hovering panel; always rank below any Tier-1
                    // candidate. Subtract a constant larger than the
                    // Tier-1 score range so ordering within Tier 2 still
                    // matches raw score ordering.
                    return clearanceOk ? raw : raw - TIER2_PENALTY;
                }

                // Expert panels hold four dots. In the first pass, points
                // that have not been placed yet sit at their starting
                // positions and would crowd out every candidate, so spacing
                // counts only points already placed. The second pass checks
                // all points.
                var placed = {};
                var isPlaced = function (i) {
                    return !layout || placed[i] || (!entriesByIndex[i] && !isTwinIndex[i]);
                };
                // Moves the seed's twin to the rotated spot of a candidate;
                // null when that spot is off the twin's panel or undrawable.
                var placeTwin = function (seedIdx, cand) {
                    var twinEntry = twinOf[seedIdx];
                    if (!twinIso) return null;
                    var twin = twinPoint({ faceId: pts[seedIdx].faceId, u: cand.u, v: cand.v, w: cand.w }, twinIso, twinSheet, twinFaceCount);
                    // A scatter dot changes panel, and its twin with it.
                    if (!twin || (twin.faceId !== twinEntry.face && !isScatter(twinEntry))) return null;
                    globals.facePoints.updatePointPosition(twinEntry.idx, twin.faceId, twin.u, twin.v, twin.w);
                    return twin;
                };
                // The twin passes the same final-frame gates as any hidden dot.
                var twinReadable = function (seedIdx) {
                    var t = twinOf[seedIdx].idx;
                    if (!globals.facePoints.isPointVisible(t)) return false;
                    if (preset.minPointViewQuality > 0 && globals.facePoints.getPointViewQuality(t) < preset.minPointViewQuality) return false;
                    if (preset.requirePointClearance && globals.facePoints.hasSurfaceClearance
                        && !globals.facePoints.hasSurfaceClearance(t, markerClearanceRadius(preset))) return false;
                    var at = globals.benchmark.getPointScreenPosition(t);
                    if (!at || Math.min(at.x, at.y, canvasW - at.x, canvasH - at.y) < 30) return false;
                    var floor = preset.minPointSeparationPx != null ? preset.minPointSeparationPx : 70;
                    for (var oi = 0; oi < pts.length; oi++) {
                        if (oi === t || (oi !== seedIdx && !isPlaced(oi)) || !globals.facePoints.isPointVisible(oi)) continue;
                        var other = globals.benchmark.getPointScreenPosition(oi);
                        if (other && Math.hypot(at.x - other.x, at.y - other.y) < floor) return false;
                    }
                    return true;
                };
                // Group centers, as screen offsets from each panel's seed. If
                // decoys packed around the anchor, the anchor would always be
                // the group's middle dot and could be picked from the final
                // image alone. Instead the center is the seed itself with
                // probability 1/(group size), and otherwise a visible spot
                // near it, so the anchor is the middle dot no more often
                // than any decoy.
                var clusterOffsets = {};
                // Set while rescoring a decoy that found no spot within
                // group.reachPx; validation's group spread check
                // still decides whether the preset ships.
                var ignoreClusterRadius = false;
                var chooseClusterOffset = function (em, faceId) {
                    var anchorIdx = seedOf[faceId];
                    if (anchorIdx == null) return [0, 0];
                    if (jitterRngHoisted.random() < 1 / groupSize[faceId]) return [0, 0];
                    var anchorAt = globals.benchmark.getPointScreenPosition(anchorIdx);
                    var spots = [];
                    for (var ci = 0; ci < em.candidates.length; ci++) {
                        var c = em.candidates[ci];
                        globals.facePoints.updatePointPosition(em.idx, faceId, c.u, c.v, c.w);
                        if (!globals.facePoints.isPointVisible(em.idx)) continue;
                        var at = globals.benchmark.getPointScreenPosition(em.idx);
                        var gap = at ? Math.hypot(at.x - anchorAt.x, at.y - anchorAt.y) : 0;
                        var minGap = preset.minPointSeparationPx != null ? preset.minPointSeparationPx : 70;
                        if (gap >= minGap && gap <= minGap + groupGeometry.centerGapPx) spots.push([at.x - anchorAt.x, at.y - anchorAt.y]);
                    }
                    return spots.length ? spots[jitterRngHoisted.randInt(0, spots.length - 1)] : [0, 0];
                };
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
                        var groupMember = layout && !isScatter(em) && seedOf[faceId] != null && seedOf[faceId] !== idx;
                        if (groupMember && !(faceId in clusterOffsets)) {
                            clusterOffsets[faceId] = chooseClusterOffset(em, faceId);
                        }

                        var scoredCands = [];
                        for (var attempt = 0; attempt < 2 && scoredCands.length === 0; attempt++) {
                            // A second attempt only for later dots in a group.
                            if (attempt === 1 && !groupMember) break;
                            ignoreClusterRadius = attempt === 1;
                            for (var ci = 0; ci < em.candidates.length; ci++) {
                                if (!em.survives[ci]) continue;
                                var c = em.candidates[ci];
                                globals.facePoints.updatePointPosition(idx, c.faceId != null ? c.faceId : faceId, c.u, c.v, c.w);
                                var score = scoreCandidate(em, ci);
                                if (score > -Infinity) {
                                    scoredCands.push({ faceId: c.faceId != null ? c.faceId : faceId, u: c.u, v: c.v, w: c.w,
                                        score: score, candidateIndex: ci });
                                }
                            }
                        }
                        ignoreClusterRadius = false;

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
                            em.selected = scoredCands[pickIdx].candidateIndex;
                            faceId = scoredCands[pickIdx].faceId;
                            roundedU = scoredCands[pickIdx].u;
                            roundedV = scoredCands[pickIdx].v;
                            roundedW = scoredCands[pickIdx].w;
                        } else {
                            roundedU = origU; roundedV = origV; roundedW = origW;
                        }

                        globals.facePoints.updatePointPosition(idx, faceId, roundedU, roundedV, roundedW);
                        placed[idx] = true;
                        if (twinOf[idx]) {
                            var placedTwin = placeTwin(idx, { u: roundedU, v: roundedV, w: roundedW });
                            placed[twinOf[idx].idx] = true;
                            var twinRef = twinOf[idx].ref;
                            if (pass === 1 && placedTwin && twinRef && !Array.isArray(twinRef)) {
                                twinRef.faceId = placedTwin.faceId;
                                twinRef.u = placedTwin.u; twinRef.v = placedTwin.v; twinRef.w = placedTwin.w;
                            }
                        }
                        // On the final pass, persist the refined barycentric
                        // back into preset.facePoints so the exported JSON
                        // carries the refined values.
                        if (pass === 1 && em.ref) {
                            if (Array.isArray(em.ref)) {
                                em.ref[0] = roundedU; em.ref[1] = roundedV; em.ref[2] = roundedW;
                            } else {
                                em.ref.u = roundedU; em.ref.v = roundedV; em.ref.w = roundedW;
                                if (isScatter(em)) em.ref.faceId = faceId;
                            }
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

    // Refine diverse candidates on demand and stop once enough pass. A
    // failed selected candidate can be replaced by another scanned candidate.
    function refineAndRevalidate(selected, settleMs, rng, callback, spares) {
        var candidates = (selected || []).concat(spares || []);
        var targetCount = (selected || []).length;
        var result = [];
        var idx = 0;
        function next() {
            if (idx >= candidates.length || result.length >= targetCount) { callback(result); return; }
            var preset = candidates[idx++];
            var originalFP = cloneObject(preset.facePoints || {});
            updateStatus("Refining candidate " + idx + "/" + candidates.length + "...");
            refineFacePointBarycentric(preset, settleMs, rng, function (refined) {
                validatePreset(refined, settleMs, function (res) {
                    if (res && res.valid) {
                        result.push(refined);
                        next();
                        return;
                    }
                    if (JSON.stringify(refined.facePoints) === JSON.stringify(originalFP)) {
                        console.warn("presetGenerator: dropped unchanged candidate " + idx + ": " + JSON.stringify((res && res.failures || []).slice(0, 3)));
                        next();
                        return;
                    }
                    // Recheck restored coordinates instead of assuming the
                    // original candidate passed before refinement.
                    refined.facePoints = originalFP;
                    validatePreset(refined, settleMs, function (originalResult) {
                        if (originalResult && originalResult.valid) result.push(refined);
                        else console.warn("presetGenerator: dropped candidate " + idx + ": refined=" + JSON.stringify((res && res.failures || []).slice(0, 3)) + " original=" + JSON.stringify((originalResult && originalResult.failures || []).slice(0, 3)));
                        next();
                    });
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
        var keysA = Array.isArray(a) ? a.map(function (point) { return String(point.faceId); }) : Object.keys(a);
        var keysB = Array.isArray(b) ? b.map(function (point) { return String(point.faceId); }) : Object.keys(b);
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
        if (tier === 5) {
            yawBase = r.randFloat(1.1, 1.5);
            pitchBase = r.randFloat(0.7, 1.2);
            rollBase = r.randFloat(0.1, 0.3);
        } else if (tier === 3) {
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
                    // Replay exactly the rotation evaluated by Phase 2.
                    out[rji].rotation = srv.slice();
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

        if (clampDifficultyTier(difficulty) === 5 || strict.length >= minCount) return strict;

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

    function foldLadderForDifficulty(difficulty, finalFold) {
        var ladder = difficulty === 1 ? [0, 12, 25, 37, 50]
                   : difficulty === 5 ? [0, 5, 11, 16, 22, 27, 32, 38, 43, 48, 54, 59, 65, 70]
                   : [0, 8, 16, 24, 32, 40, 48, 56, 64, 70];
        return rescaleFoldLadder(ladder, finalFold);
    }

    function createPresetFromProgression(progression, facePointsConfig, options) {
        var opts = options || {};
        var difficulty = clampDifficultyTier(opts.difficulty || 4);
        if (!opts.rng) throw new Error("createPresetFromProgression: opts.rng is required (deterministic seeding)");
        var rng = opts.rng;
        var colorMode = opts.colorMode || getColorModeForDifficulty(difficulty, rng);
        var colors = opts.colors || ["e74c3c", "3498db"];
        var bgColor = opts.backgroundColor || "f0f0f0";
        var foldSteps = opts.foldSteps || foldLadderForDifficulty(difficulty, resolveFinalFold(opts));
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
            minPointViewQuality: opts.minPointViewQuality != null ? opts.minPointViewQuality : 0.3,
            requirePointClearance: true,
            trackingEvalMode: resolvedTrackingMode,
            enforceSeparationAllSteps: opts.enforceSeparationAllSteps === true,
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
            preset.color2 = clusterLayout(difficulty) ? colors[0] : colors[1];
        }

        if (clusterLayout(difficulty)) {
            // Labels follow entry order. Shuffling across all points
            // prevents answer letters from revealing which dots are targets.
            var orderedPoints = [];
            if (Array.isArray(preset.facePoints)) orderedPoints = preset.facePoints;
            else Object.keys(preset.facePoints).forEach(function (face) {
                preset.facePoints[face].forEach(function (point) {
                    orderedPoints.push(Object.assign({}, point, { faceId: Number(face) }));
                });
            });
            // Matrix slots share a seed. Include model and trajectory content
            // so the first sample in every slot does not share answer letters.
            var labelSeed = rng.randInt(1, 2147483647);
            var labelKey = preset.model + JSON.stringify(preset.steps) + JSON.stringify(orderedPoints);
            for (var li = 0; li < labelKey.length; li++) {
                labelSeed = Math.imul(labelSeed ^ labelKey.charCodeAt(li), 16777619);
            }
            var placementRng = makeRng(labelSeed);
            preset.facePoints = placementRng.shuffle(orderedPoints);
            // Placement parameters, kept in the preset so metadata can slice
            // results by them. Refinement samples positions with this alpha.
            preset.clusterPlacement = {
                alpha: Math.round(placementRng.randFloat(CLUSTER_ALPHA[0], CLUSTER_ALPHA[1]) * 100) / 100
            };
            if (opts.twinSymmetry) preset.clusterPlacement.symmetry = opts.twinSymmetry;
            if (opts.clusterLayout) {
                preset.clusterPlacement.trackedGroups = opts.clusterLayout.tracked.slice();
                preset.clusterPlacement.decoyGroups = opts.clusterLayout.decoyGroups.slice();
                preset.clusterPlacement.backGroups = opts.clusterLayout.backGroups.slice();
                if (opts.clusterLayout.scatter) {
                    preset.clusterPlacement.scatter = opts.clusterLayout.scatter;
                    preset.clusterPlacement.trackedScatter = opts.clusterLayout.trackedScatter;
                }
            }
            // Every dot is drawn at size 1 until the last image, which draws
            // each at its own size, drawn independently of the dot's role, so
            // size cannot show which dot is which. The question says so.
            if (clusterLayout(difficulty).symmetricTwins) preset.symmetricTwins = true;
            var endSizes = opts.clusterEndSizes || clusterEndSizes;
            if (endSizes) {
                preset.endDotSizes = endSizes.slice();
                preset.facePoints.forEach(function (point) {
                    point.endScale = Math.round(placementRng.randFloat(endSizes[0], endSizes[1]) * 100) / 100;
                });
            }
            preset.minPointViewQuality = Math.max(0.3, preset.minPointViewQuality);
            preset.pointRadius = clusterPointRadius(difficulty);
            preset.minPointSeparationPx = Math.max(clusterMinSeparationPx(difficulty),
                opts.minPointSeparationPx != null ? opts.minPointSeparationPx : clusterMinSeparationPx(difficulty));
            preset.enforceSeparationAllSteps = true;
        }

        var targets = chooseTrackingTargetsFromFacePoints(preset.facePoints, opts.targetSelectionMode || "all", opts);
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
    function selectFromTrajectoryK(tier, opts) {
        // K=1 for d1, K=2 for d3/d4/d5. Maximizes trajectory diversity per
        // cell: each (POV, rotation) trajectory yields at most one config
        // for d1 (single-side, no reveal) and at most two for d3/d4
        // (room for hidden-front/hidden-back variants on the same path).
        // Continuation passes lift cells whose geometry yields fewer
        // unique trajectories than the per-cell target.
        //
        // configsPerTrajectory overrides the default for the re-point pass,
        // which mines an already-accepted trajectory instead of searching for
        // new ones. Stage 1 below enumerates every valid face combination the
        // trajectory supports; at K=2 the rest are computed and discarded, and
        // because Stage 2 always seeds with pool[0], a repeat job on the same
        // trajectory re-ships the same face set rather than reaching pool[2:].
        // The pool still caps the result — K is a ceiling, never padding.
        var requested = (opts && opts.configsPerTrajectory != null)
            ? parseInt(opts.configsPerTrajectory, 10) : 0;
        if (requested > 0) return requested;
        if (tier === 1) return 1;
        return 2;
    }

    // Split a banked preset's steps back into the two inputs Phase 2 takes:
    // the candidate (fold + static pov per step, benchmark.js:2750) and the
    // rotation profile (per-step euler triples). The re-point pass evaluates
    // exactly this pair, so the trajectory handed to
    // selectFacePointsFromTrajectory is bit-identical to the one already
    // validated in the bank — only the face-point placement is new.
    function trajectoryFromSteps(steps) {
        var candidate = [];
        var rotations = [];
        var list = Array.isArray(steps) ? steps : [];
        for (var i = 0; i < list.length; i++) {
            var step = list[i] || {};
            candidate.push({
                fold: step.fold,
                pov: Array.isArray(step.pov) ? step.pov.slice() : step.pov
            });
            // State 1 renders at zero rotation (the d3/d4/d5 hero shot), so a
            // step with no rotation is an explicit zero, not a gap.
            rotations.push(Array.isArray(step.rotation) ? step.rotation.slice() : [0, 0, 0]);
        }
        return { candidate: candidate, profile: { name: "banked", rotations: rotations } };
    }

    // Emits up to K clustered configs from one trajectory's face pools
    // (selectFacePointsFromTrajectory). Each config picks a rotation the
    // folded model carries (rotations: [{name, faces}], see carriedRotations)
    // and draws its seed layout to fit the readable seed and twin panel pairs
    // under it. Panels are picked at random, preferring ones its siblings have
    // not used. Every seed dot gets a hidden twin on the twin panel, linked by
    // `pair`. Pools hold face indices; back points are stored at faceId +
    // faceCount. Starting positions are Dirichlet samples that refinement
    // replaces, twins included.
    function selectClusterConfigs(L, K, rng, pools, faceCount, rotations) {
        if (!rotations || !rotations.length) return [];
        var configs = [], seen = {}, usage = {};
        function asSet(ids) { var set = {}; ids.forEach(function (id) { set[id] = true; }); return set; }
        var readableFront = asSet(pools.front), readableBack = asSet(pools.back), anchorEligible = asSet(pools.tracked);
        for (var attempt = 0; configs.length < K && attempt < 10 * K; attempt++) {
            var rotation = rng.pick(rotations);
            var layout = drawClusterLayout(L, rng, {
                tracked: twinPairs(rotation.faces, readableFront, anchorEligible, L.symmetricTwins).length,
                front: twinPairs(rotation.faces, readableFront).length,
                back: L.twinBack ? twinPairs(rotation.faces, readableBack).length : pools.back.length
            });
            if (!layout) continue;
            var taken = {};
            var pickPairs = function (readable, eligible, count, bothEligible) {
                var open = rng.shuffle(rotation.faces.map(function (twin, face) { return [face, twin]; }).filter(function (pair) {
                    return pair[1] >= 0 && pair[1] !== pair[0] && readable[pair[0]] && readable[pair[1]]
                        && (!eligible || (eligible[pair[0]] && (!bothEligible || eligible[pair[1]])))
                        && !taken[pair[0]] && !taken[pair[1]];
                }));
                // Array sort is stable, so equally used pairs keep shuffled order.
                open.sort(function (a, b) { return (usage[a[0]] || 0) - (usage[b[0]] || 0); });
                var picked = [];
                open.forEach(function (pair) {
                    if (picked.length >= count || taken[pair[0]] || taken[pair[1]]) return;
                    taken[pair[0]] = taken[pair[1]] = true;
                    picked.push(pair);
                });
                return picked;
            };
            var trackedPairs = pickPairs(readableFront, anchorEligible, layout.tracked.length, L.symmetricTwins);
            // Decoy-only seeds prefer panels that also meet the anchor rule,
            // so a panel hidden mid-fold does not mark its dots as decoys.
            var decoyPairs = pickPairs(readableFront, anchorEligible, layout.decoyGroups.length);
            decoyPairs = decoyPairs.concat(pickPairs(readableFront, null, layout.decoyGroups.length - decoyPairs.length));
            // Untwinned back groups take single panels, recorded as [face, -1].
            var backPairs = L.twinBack ? pickPairs(readableBack, null, layout.backGroups.length)
                : rng.shuffle(pools.back.filter(function (face) { return !taken[face]; }))
                    .slice(0, layout.backGroups.length).map(function (face) { taken[face] = true; return [face, -1]; });
            if (trackedPairs.length < layout.tracked.length || decoyPairs.length < layout.decoyGroups.length
                || backPairs.length < layout.backGroups.length) continue;

            var facePoints = {}, nextPair = 0;
            var addGroup = function (pair, size, anchored, offset) {
                var seedFace = pair[0] + offset, twinned = pair[1] >= 0, twinFace = pair[1] + offset;
                facePoints[seedFace] = [];
                if (twinned) facePoints[twinFace] = [];
                for (var i = 0; i < size; i++) {
                    var bary = sampleBarycentric(rng, 1, CLUSTER_BARY_FLOOR);
                    var seedPoint = { u: bary.u, v: bary.v, w: bary.w };
                    if (!anchored || i > 0) seedPoint.hidden = true;
                    if (twinned) {
                        seedPoint.pair = nextPair;
                        facePoints[twinFace].push({ u: bary.u, v: bary.v, w: bary.w, pair: nextPair, twin: true, hidden: true });
                        nextPair++;
                    }
                    facePoints[seedFace].push(seedPoint);
                }
            };
            trackedPairs.forEach(function (pair, i) { addGroup(pair, layout.tracked[i], true, 0); });
            decoyPairs.forEach(function (pair, i) { addGroup(pair, layout.decoyGroups[i], false, 0); });
            backPairs.forEach(function (pair, i) { addGroup(pair, layout.backGroups[i], false, faceCount); });
            // Scatter dots start on a front group's panel, picked with odds
            // proportional to the group's size so they do not mark tracked
            // groups, and record that panel as `near`. Refinement moves each
            // to a random spot anywhere on the visible paper; the first
            // layout.trackedScatter of them are anchors.
            var frontPicks = trackedPairs.map(function (pair, i) { return { pair: pair, size: layout.tracked[i] }; })
                .concat(decoyPairs.map(function (pair, i) { return { pair: pair, size: layout.decoyGroups[i] }; }));
            var frontTotal = frontPicks.reduce(function (sum, f) { return sum + f.size; }, 0);
            for (var si = 0; si < (layout.scatter || 0); si++) {
                var draw = rng.random() * frontTotal, target = frontPicks[frontPicks.length - 1];
                for (var fi = 0; fi < frontPicks.length; fi++) {
                    draw -= frontPicks[fi].size;
                    if (draw < 0) { target = frontPicks[fi]; break; }
                }
                var sb = sampleBarycentric(rng, 1, CLUSTER_BARY_FLOOR);
                var scatterPoint = { u: sb.u, v: sb.v, w: sb.w, pair: nextPair, scatter: true, near: target.pair[0] };
                if (si >= (layout.trackedScatter || 0)) scatterPoint.hidden = true;
                facePoints[target.pair[0]].push(scatterPoint);
                facePoints[target.pair[1]].push({ u: sb.u, v: sb.v, w: sb.w, pair: nextPair, twin: true, hidden: true, scatter: true });
                nextPair++;
            }

            var signature = rotation.name + "|" + Object.keys(facePoints).sort().map(function (fid) {
                return fid + ":" + facePoints[fid].length + (facePoints[fid].some(function (p) { return !p.hidden; }) ? "a" : "");
            }).join(",");
            if (seen[signature]) continue;
            seen[signature] = true;
            trackedPairs.concat(decoyPairs, backPairs).forEach(function (pair) {
                pair.forEach(function (face) { if (face >= 0) usage[face] = (usage[face] || 0) + 1; });
            });
            configs.push({
                facePoints: facePoints,
                siblingIndex: configs.length,
                layout: layout,
                twinSymmetry: rotation.name,
                _selection: {
                    visibleFronts: trackedPairs.map(function (pair) { return pair[0]; }),
                    hiddenFronts: decoyPairs.map(function (pair) { return pair[0]; }),
                    hiddenBacks: backPairs.map(function (pair) { return pair[0]; })
                }
            });
        }
        return configs;
    }

    function selectFacePointsFromTrajectory(trajectory, difficulty, modelFaceCount, frontPool, backPool, rng, model, minPointViewQuality, opts) {
        var tier = clampDifficultyTier(difficulty);
        var K = selectFromTrajectoryK(tier, opts);
        var timeline = trajectory && trajectory.visibilityTimeline;
        if (!Array.isArray(timeline) || timeline.length === 0) return [];
        var N = modelFaceCount;
        if (!N || N < 1) return [];

        // A marker on an edge-on face stays thin at every barycentric
        // location. Filter such faces before spending a solver replay on them.
        // Keep mapfold's existing, stronger final-angle floor.
        var modelStr = String(model || "");
        var isMapfoldModel = modelStr.indexOf("mapfold") >= 0;
        var minFinalQuality = Math.max(isMapfoldModel ? 0.4 : 0, minPointViewQuality || 0);
        var minHiddenFinalQuality = minFinalQuality;

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
        var stepsToCheck = isMapfoldModel && tier !== 5
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
                && (minStepQuality[fid] || 0) >= Math.max(0.001, minPointViewQuality || 0)
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

        var tierLayout = clusterLayout(tier);
        if (tierLayout) {
            // Matrix slots share a seed. Mix in the model and this trajectory
            // so slots do not draw the same layout sequence.
            var layoutSeed = rng.randInt(1, 2147483647);
            var layoutKey = modelStr + JSON.stringify(timeline.map(function (st) { return st.visibleFaceIds; }));
            for (var lk = 0; lk < layoutKey.length; lk++) {
                layoutSeed = Math.imul(layoutSeed ^ layoutKey.charCodeAt(lk), 16777619);
            }
            return selectClusterConfigs(tierLayout, K, makeRng(layoutSeed), {
                tracked: rankedFronts,
                front: rankedFronts.concat(rankedHiddenFronts.filter(function (fid) { return rankedFronts.indexOf(fid) < 0; })),
                back: rankedBacks
            }, N, opts && opts.twinRotations);
        }

        // Per-tier point-count ranges.
        // Constraint: every preset has at least 2 visible (non-hidden)
        // anchors so initial state is trackable, and the total fits the
        // tier's range. Each tier picks greedily from its range based on
        // what the trajectory's pools support; empty config returned if
        // the lower bound can't be met.
        //
        //   d1: static (no rotation across steps), 2 visible front + 1-3
        //       hidden front (revealed at final step). Total 3-5.
        //   d4: rotated, 2 visible front + 1-2 hidden front + 1-2 hidden
        //       back (mix of late-front-reveal and back-via-rotation).
        //       Total 4-6.
        // Clustered tiers (d3, d5) returned above.
        var ranges;
        if (tier === 1) ranges = { vF: [2, 2], hF: [1, 3], hB: [0, 0] };
        else                 ranges = { vF: [2, 2], hF: [1, 2], hB: [1, 2] };

        // For d4, the FINAL POSE must show at least hB.lower back-pool
        // faces that are GEOMETRICALLY back-side-exposed at the final step
        // — same definition rankedBacks uses (index in [N/2, N-1] AND
        // front-normal quality < BACK_SIDE_QUALITY_MAX). This guarantees
        // the rendered PNG actually has visible back-surface for the
        // hidden reveal, not just a face-id in the back-half range that
        // happens to be front-facing.
        var requiresBothSides = (tier >= 4);
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
        // tier point budget. Returns null if any slot's lower bound can't
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

            // Respect the tier budget when allocating optional points.
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
        var visCombos = combinationsOf(rankedFronts, plan.vF);
        for (var vc = 0; vc < visCombos.length; vc++) {
            var visFp = visCombos[vc];
            var u0 = {};
            visFp.forEach(function (fid) { u0[fid] = true; });

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
                var bary = baryForThisConfig;
                var entry = { u: bary.u, v: bary.v, w: bary.w };
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
        if (difficulty >= 4 && !(opts && opts.forceFrontAnchor)) {
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
        if (tier === 5) return { yaw: 1.8, pitch: 1.5, roll: 0.7 };
        return { yaw: 1.4, pitch: 1.3, roll: 0.4 };
    }

    // Final poses that expose the back of the model, as [pitch, yaw, roll]
    // fractions of FINAL_POSE_SCALE. These are the endpoints of the hard-tier
    // ramp templates, which the previous expert contract accepted.
    var EXPERT_FINAL_POSES = [
        [1.0, 1.0, 0.95], [-1.0, -1.0, -0.95], [1.0, 1.12, 1.0], [-1.0, -1.12, -1.0],
        [-0.6, 1.05, 0.82], [0.6, -1.05, -0.82], [1.2, 0.3, 0], [-1.2, 0.3, 0],
        [-1.2, -0.3, 0], [0.3, 0.3, 1.2], [0.5, 1.0, 0], [0.5, -1.0, 0],
        [0.3, 0.3, -1.2], [1.2, -0.3, 0]
    ];
    var FINAL_POSE_SCALE = [1.4, 1.5, 0.45];

    // Expert motion styles. Every style heads for a back-exposing final pose
    // and adds a detour that vanishes at both ends, so the start and final
    // poses are unchanged. Styles differ in where the extra motion goes:
    //   detour   - swings, orbits, weaves and wanders across all axes
    //   spin     - one full turn about the paper normal, then the tilt
    //   tumble   - large pitch and roll wobbles with little yaw
    //   pendulum - wide yaw swings back and forth, never a full turn
    // Styles add floors on top of EXPERT_MOTION; they never relax it.
    // maxYawStep caps in-plane turn per frame. Most bases are 4- or 8-fold
    // symmetric, and a large in-plane step can read as a smaller one the other
    // way. Spin needs about 0.8 rad per frame for a full turn in ten frames;
    // on the waterbomb its frames look alike, so dataset runs leave it out.
    var EXPERT_STYLES = {
        detour: { families: ["swing", "orbit", "weave", "wander"], detourScale: 1, minPathAngle: 5, maxYawStep: 0.6 },
        spin: { families: ["swing", "orbit", "weave", "wander"], detourScale: 0.6, spinTurns: 1, minPathAngle: 7 },
        tumble: { families: ["tumble"], detourScale: 1, roll: 1.2, minPathAngle: 6.5, maxYawStep: 0.6 },
        pendulum: { families: ["pendulum"], detourScale: 1, minPathAngle: 6.5, maxYawStep: 0.6 }
    };
    var DEFAULT_EXPERT_STYLE = "detour";

    // Detours are sums of sin(n*pi*t) terms, so they vanish at both ends and
    // cannot move the start or final pose. Only paths that already meet the
    // expert motion contract reach Phase 2, so no solver replay is spent on
    // motion that assembly would reject.
    function buildExpertRotationProfiles(stepCount, count, seed, bounds, styleName) {
        var style = EXPERT_STYLES[styleName || DEFAULT_EXPERT_STYLE];
        if (!style) throw new Error("unknown expert motion style: " + styleName);
        var rng = makeRng((seed | 0) ^ 0x5EED5);
        function rf(a, b) { return rng.randFloat(a, b); }
        function sign() { return rng.random() < 0.5 ? -1 : 1; }
        var PI = Math.PI;
        // Each family returns t -> [pitch, yaw, roll] offsets as fractions of
        // the style limits.
        var families = {
            swing: function () {
                var a = sign() * rf(0.45, 0.7), b = rf(-0.3, 0.3), c = sign() * rf(0.3, 0.6);
                return function (t) { return [b * Math.sin(PI * t), a * Math.sin(2 * PI * t), c * Math.sin(3 * PI * t)]; };
            },
            orbit: function () {
                var r = rf(0.4, 0.6), turns = rf(1, 1.5), phase = rf(0, 2 * PI), dir = sign();
                return function (t) {
                    var env = r * Math.sin(PI * t), a = phase + dir * 2 * PI * turns * t;
                    return [env * Math.sin(a), env * Math.cos(a), 0.5 * env * Math.sin(a + 1)];
                };
            },
            weave: function () {
                var n = rng.randInt(3, 4), amp = rf(0.3, 0.5), bulge = sign() * rf(0.2, 0.4);
                return function (t) { return [amp * Math.sin(n * PI * t), bulge * Math.sin(PI * t), 0.6 * Math.sin((n + 1) * PI * t)]; };
            },
            wander: function () {
                var c = [0, 1, 2].map(function () {
                    return [1, 2, 3].map(function (n) { return rf(-0.6, 0.6) / Math.sqrt(n); });
                });
                return function (t) {
                    return c.map(function (terms) {
                        return terms.reduce(function (sum, cn, i) { return sum + cn * Math.sin((i + 1) * PI * t); }, 0);
                    });
                };
            },
            // Pitch and roll rock out of phase, so the model tips toward and
            // away from the camera while leaning side to side.
            tumble: function () {
                var n = rng.randInt(2, 3), a = sign() * rf(0.55, 0.8), b = sign() * rf(0.6, 0.9), c = sign() * rf(0.15, 0.3);
                return function (t) { return [a * Math.sin(n * PI * t), c * Math.sin(PI * t), b * Math.sin((n + 1) * PI * t)]; };
            },
            // Yaw swings far one way, back past the start, and out again.
            pendulum: function () {
                var n = rng.randInt(2, 3), a = sign() * rf(0.55, 0.75), b = sign() * rf(0.25, 0.45), c = sign() * rf(0.35, 0.6);
                return function (t) { return [b * Math.sin(PI * t), a * Math.sin(n * PI * t), c * Math.sin((n + 1) * PI * t)]; };
            }
        };
        var names = style.families;
        var limits = [bounds.pitch, bounds.yaw, style.roll || bounds.roll];
        var spinTurns = style.spinTurns || 0;

        function finalPose(attempt) {
            // Alternate the proven endpoints with sampled ones, switching per
            // full family cycle so every family gets both kinds.
            var f = Math.floor(attempt / names.length) % 2 === 0
                ? EXPERT_FINAL_POSES[rng.randInt(0, EXPERT_FINAL_POSES.length - 1)].map(function (v) { return v * rf(0.9, 1.1); })
                : [rf(-1.2, 1.2), rf(-1.2, 1.2), rf(-1.2, 1.2)];
            return f.map(function (v, k) { return v * FINAL_POSE_SCALE[k]; });
        }
        // A spin is a whole number of turns about the paper normal (Euler y),
        // so the final orientation equals the chosen final pose. It finishes
        // by SPIN_END while the paper is still nearly flat and untilted: a
        // folded panel spun under a steep tilt swings away from the camera
        // partway round. The tilt toward the final pose then eases in.
        var SPIN_END = 0.7;
        function smoothstep(x) { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); }
        function makePose(end, detour, spin) {
            return function (t) {
                var d = detour(t), tilt = spin ? t * t : t;
                return [0, 1, 2].map(function (k) {
                    var v = Math.max(-limits[k], Math.min(limits[k], end[k] * tilt + d[k] * style.detourScale * limits[k]));
                    return k === 1 && spin ? v + spin * smoothstep(t / SPIN_END) : v;
                });
            };
        }
        function quat(r) {
            return new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0], r[1], r[2], "XYZ"));
        }

        // Frames are spaced by equal orientation change rather than equal
        // curve time, so every step turns by the same angle. Otherwise the
        // path rushes through some stretches and stalls in others.
        var DENSE = 240;
        var profiles = [];
        for (var attempt = 0; profiles.length < count && attempt < count * 60; attempt++) {
            var end = finalPose(attempt);
            // Spin the way the final yaw already turns, so the two add up.
            var spin = spinTurns ? (end[1] < 0 ? -1 : 1) * 2 * PI * spinTurns : 0;
            var pose = makePose(end, families[names[attempt % names.length]](), spin);
            var ts = [0], arc = [0], prev = quat(pose(0));
            for (var j = 1; j <= DENSE; j++) {
                var q = quat(pose(j / DENSE));
                ts.push(j / DENSE);
                arc.push(arc[j - 1] + 2 * Math.acos(Math.min(1, Math.abs(q.dot(prev)))));
                prev = q;
            }
            var total = arc[DENSE], rotations = [], seg = 0;
            for (var i = 0; i < stepCount; i++) {
                var target = stepCount <= 1 ? total : total * i / (stepCount - 1);
                while (seg < DENSE - 1 && arc[seg + 1] < target) seg++;
                var span = arc[seg + 1] - arc[seg];
                var t = ts[seg] + (span > 0 ? (target - arc[seg]) / span : 0) * (ts[seg + 1] - ts[seg]);
                rotations.push(pose(Math.min(1, t)).map(function (v) { return Math.round(v * 1000) / 1000 || 0; }));
            }
            var steps = rotations.map(function (r) { return { rotation: r }; });
            if (expertMotionFailures(steps).length) continue;
            var m = measureExpertMotion(steps);
            if (m.pathAngle < style.minPathAngle || m.spinTurns < spinTurns - 0.01) continue;
            if (style.maxYawStep && m.maxYawStep > style.maxYawStep) continue;
            profiles.push(rotations);
        }
        return profiles;
    }

    function generateFromScanProgressions(options, callback) {
        var opts = options || {};
        if (!globals.benchmark || !globals.benchmark.runScan) {
            callback({ error: "benchmark scan module unavailable", generated: [] });
            return;
        }

        var model = opts.model || "/Bases/birdBase.svg";
        var difficulty = clampDifficultyTier(opts.difficulty || 4);
        var count = opts.count || 7;
        var seed = opts.seed || Date.now();
        var rng = makeRng(seed);
        var foldSteps = opts.foldSteps || foldLadderForDifficulty(difficulty, resolveFinalFold(opts));
        var maxScanCandidates = opts.maxScanCandidates || Math.max(count * 3, 12);

        var modelFaceCount = 0;
        if (globals.model && globals.model.getFaces) {
            var faces = globals.model.getFaces();
            modelFaceCount = faces ? faces.length : 0;
        }

        // Resolve face pools up front (cached per model). Clustered tiers also
        // need the rotations the folded model carries, for twins.
        discoverFacePools(model, function (pools) {
            if (!clusterLayout(difficulty)) { continueGeneration(pools, null); return; }
            measureCarriedRotations(foldSteps[foldSteps.length - 1], function (rotations) {
                if (!rotations.length) {
                    updateStatus("Folded model carries no sheet rotation; clustered tiers need one for twins");
                    callback({ error: "folded model carries no sheet rotation; clustered tiers need one for twins", generated: [] });
                    return;
                }
                continueGeneration(pools, rotations);
            });
        });
        return;

        function continueGeneration(pools, twinRotations) {

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
        var defaultMinSep = clusterLayout(difficulty) ? clusterMinSeparationPx(difficulty)
            : (tierProfile.requiresBothSides && backPoolThin) ? 50 : 70;

        // Single Phase 2 run per slot. buildProgressions is bumped vs the
        // old per-candidate cfg because we now extract K=3 face-point
        // configs per accepted progression — we need a richer trajectory
        // pool to compensate for the dropped per-candidate parallelism.
        // Re-point pass: mine an already-accepted trajectory for more face-point
        // placements instead of searching for new trajectories. Pinning the
        // candidate and its profile turns Phase 2 into a single 6-step
        // evaluation (1 trajectory x 1 profile) whose only product is the
        // visibilityTimeline that face-point selection needs. Every acceptance
        // gate below stays at its normal value — the trajectory is unchanged,
        // so it faces the same contract it already passed.
        var repointTrajectory = (Array.isArray(opts.repointSteps) && opts.repointSteps.length)
            ? trajectoryFromSteps(opts.repointSteps)
            : null;

        var slotScanCfg = {
            model: model,
            pinnedTrajectories: repointTrajectory ? [repointTrajectory.candidate] : undefined,
            // Phase 2 parses profiles as plain per-step rotation arrays; an
            // object here is skipped and random profiles replace the bank's.
            rotationProfiles: repointTrajectory ? [repointTrajectory.profile.rotations]
                : (opts.rotationProfiles || (difficulty === 5
                    ? buildExpertRotationProfiles(foldSteps.length,
                        opts.rotationProfileCount != null ? opts.rotationProfileCount : 30, seed, rotBounds,
                        opts.expertMotionStyle)
                    : undefined)),
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
                    : difficulty >= 4
                        ? Math.max(5, Math.ceil(count * 5))
                        : Math.max(5, Math.ceil(count * 1.5))),
            // Medium accepts most profiles of a view, so its early-stop
            // budget filled from the first view of a fixed order in every
            // job. Take at most two per view, in a per-job view and profile
            // order (benchmark.js evaluateTrajectoriesLive).
            phase2MaxPerTrajectory: difficulty === 3 ? 2 : 0,
            phase2ShuffleSeed: difficulty === 3 ? seed : undefined,
            // d4: require at least 1 back-side face to be camera-exposed at
            // the final step. Combined with the front-anchor visibility gate
            // (which checks every step), accepted trajectories satisfy both
            // human-trackability AND the hidden-back-reveal contract.
            requiredPointPools: clusterLayout(difficulty) ? Object.assign({}, clusterLayout(difficulty).searchPools, {
                minQuality: Math.max(0.3, opts.minPointViewQuality || 0),
                twins: twinRotations
            }) : undefined,
            requireFinalBackExposure: opts.requireFinalBackExposure != null
                ? opts.requireFinalBackExposure
                : (difficulty === 5 ? clusterLayout(difficulty).searchPools.finalBack : (difficulty === 4 ? 1 : 0)),
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
            // Expert profiles already meet the quaternion motion contract,
            // and assembly checks it again, so Phase 2 needs no Euler gate.
            minRotationEndAngle: opts.minRotationEndAngle != null
                ? opts.minRotationEndAngle
                : (difficulty === 5 ? 0 : (difficulty >= 4 ? 0.45 : (difficulty >= 3 ? 0.20 : 0))),
            minRotationTotalAngle: opts.minRotationTotalAngle != null
                ? opts.minRotationTotalAngle
                : (difficulty === 5 ? 0 : (difficulty >= 4 ? 0.95 : (difficulty >= 3 ? 0.45 : 0))),
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
                : (difficulty >= 4 ? 30
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
        // Clustered tiers turn the model about its paper normal by a random
        // angle over the sequence: with small turns, assuming the paper
        // turned as little as possible tells a dot from its twin. Medium adds
        // the turn to Euler y (spinProfiles; its roll stays under 0.2 rad).
        // Expert turns about the normal exactly and balances the least-turn
        // guess (spinAboutNormal, balanceLeastTurn). A re-pointed trajectory
        // keeps its banked rotation.
        if (clusterLayout(difficulty) && !repointTrajectory && !opts.rotationProfiles) {
            var spinRng = makeRng((seed ^ 0x5f3759df) | 0);
            if (difficulty === 5) {
                // Spinning can break expert's step limits (pendulum's wide yaw
                // swings keep about 1 in 5), and balancing least-turn drops
                // more; build spares. 300 profiles take about 0.3 s.
                var wanted = opts.rotationProfileCount != null ? opts.rotationProfileCount : 30;
                var turns = twinRotations.map(function (rotation) { return TWIN_TURNS[rotation.name]; })
                    .filter(function (turn) { return turn != null; });
                slotScanCfg.rotationProfiles = balanceLeastTurn(spinAboutNormal(buildExpertRotationProfiles(foldSteps.length,
                    wanted * 10, seed, rotBounds, opts.expertMotionStyle), spinRng, expertMotionFailures), turns, wanted);
            } else if (globals.benchmark.buildAutoRotationProfiles) {
                var baseProfiles = globals.benchmark.buildAutoRotationProfiles(foldSteps.map(function (fold) { return { fold: fold }; }), slotScanCfg);
                slotScanCfg.rotationProfiles = spinProfiles(baseProfiles.map(function (profile) {
                    return profile.rotations.map(function (r) { return [r.x, r.y, r.z]; });
                }), spinRng, null, clusterSpinTurns ? clusterSpinTurns * 2 * Math.PI : null);
            }
        }

        // Tier slot plan (mirrors selectFacePointsFromTrajectory). Used by
        // the safety top-off below.
        var tierPlan = (function () {
            // Clustered selection fills each config's drawn layout exactly.
            if (difficulty === 1 || clusterLayout(difficulty)) return { hB: 0, hF: 0 };
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
            if (difficulty < 4 || !Array.isArray(backFaces)) return 0;
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
            if (difficulty >= 4) {
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
            if (difficulty >= 4) {
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

                var configs = selectFacePointsFromTrajectory(prog, difficulty, modelFaceCount, frontFaces, backFaces, rng, model,
                    opts.minPointViewQuality != null ? opts.minPointViewQuality : 0.3, Object.assign({}, opts, { twinRotations: twinRotations }));
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
                        minPointViewQuality: opts.minPointViewQuality != null ? opts.minPointViewQuality : 0.3,
                        minPointSeparationPx: slotScanCfg.minPointSeparationPx,
                        enforceSeparationAllSteps: slotScanCfg.enforceSeparationAllSteps,
                        targetSelectionMode: slotScanCfg.targetSelectionMode,
                        includeInitialVisibleTrackedPoint: slotScanCfg.includeInitialVisibleTrackedPoint,
                        initialVisibleTrackedPointCount: slotScanCfg.initialVisibleTrackedPointCount,
                        modelFaceCount: modelFaceCount,
                        siblingIndex: cfg.siblingIndex || 0,
                        clusterLayout: cfg.layout,
                        twinSymmetry: cfg.twinSymmetry
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
                    // Count the selected face map before expert label
                    // shuffling converts the preset to an ordered array.
                    var selectedKeys = Object.keys(cfg.facePoints);
                    for (var pk = 0; pk < selectedKeys.length; pk++) {
                        var fid = parseInt(selectedKeys[pk], 10);
                        var arr = cfg.facePoints[selectedKeys[pk]];
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
        if (clusterLayout(preset.difficulty)) {
            // The preset's own points carry pair and twin; the loaded ones do not.
            var expertFailures = clusterPresetFailures(preset, Array.isArray(preset.facePoints) ? preset.facePoints : allPts,
                globals.model.getFaces().length);
            if (expertFailures.length) {
                globals.facePoints.clearPoints();
                callback({ valid: false, failures: expertFailures, stepsChecked: 0 });
                return;
            }
        }
        var pointIndices = [];
        // Symmetric twins: a tracked dot's twin meets the tracked dot's rules
        // in every frame, though it is drawn only in the last.
        var anchorTwin = {};
        if (preset.symmetricTwins && Array.isArray(preset.facePoints)) {
            var seedPairs = {};
            preset.facePoints.forEach(function (p) { if (!p.twin && !p.hidden && p.pair != null) seedPairs[p.pair] = true; });
            preset.facePoints.forEach(function (p, i) { if (p.twin && seedPairs[p.pair]) anchorTwin[i] = true; });
        }
        for (var pi = 0; pi < allPts.length; pi++) {
            pointIndices.push({ idx: pi, hidden: !!allPts[pi].hidden, anchorTwin: !!anchorTwin[pi] });
        }

        var stepIdx = 0;
        var failures = [];
        var quality = { minViewQuality: 1, minFinalViewQuality: 1, finalClearMarkers: 0, finalMarkerCount: 0 };
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
                    stepsChecked: steps.length,
                    quality: quality,
                    expertMotion: preset.difficulty === 5 ? measureExpertMotion(steps) : undefined
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
            var actualSettle = Math.max(settle, 400, clusterLayout(preset.difficulty) ? CLUSTER_SETTLE_MS : 0);
            // mapfold-only: skip intermediate-step visibility checks
            // (non-final, fold>0). Mapfold's accordion fold stacks panels
            // over anchor points at fold=24-40, causing isPointVisible to
            // return false even though the trajectory's final pose recovers
            // full visibility. Final-step visibility (the answer frame) and
            // step-0 / hero-shot visibility remain enforced.
            var isMapfold = preset.model && preset.model.indexOf("mapfold") >= 0;
            var skipMidStepVisibility = preset.difficulty !== 5 && isMapfold && !isLast && step.fold > 0;
            setTimeout(function () {

                var requiredIndices = [];
                for (var i = 0; i < pointIndices.length; i++) {
                    var pInfo = pointIndices[i];
                    // Visible anchors always track; hidden labels follow the configured mode.
                    if (pInfo.hidden && !pInfo.anchorTwin && !isLast && !strictTracking) continue;
                    // A twin is not drawn before the last image, so spacing
                    // does not apply to it until then.
                    if (!pInfo.anchorTwin || isLast) requiredIndices.push(pInfo.idx);

                    if (skipMidStepVisibility) continue;

                    var visible = globals.facePoints.isPointVisible(pInfo.idx);
                    if (!pInfo.hidden || pInfo.anchorTwin || isLast) {
                        var viewQuality = globals.facePoints.getPointViewQuality(pInfo.idx);
                        quality.minViewQuality = Math.min(quality.minViewQuality, viewQuality);
                        if (isLast) {
                            quality.minFinalViewQuality = Math.min(quality.minFinalViewQuality, viewQuality);
                            quality.finalMarkerCount++;
                            if (globals.facePoints.hasSurfaceClearance(pInfo.idx, markerClearanceRadius(preset))) quality.finalClearMarkers++;
                            else if (preset.requirePointClearance) {
                                failures.push({ step: stepIdx, pointIndex: pInfo.idx, fold: step.fold, reason: "marker footprint is clipped" });
                            }
                        }
                        if (viewQuality < (preset.minPointViewQuality || 0)) {
                            failures.push({ step: stepIdx, pointIndex: pInfo.idx, fold: step.fold,
                                reason: "marker is edge-on", viewQuality: viewQuality, minimum: preset.minPointViewQuality });
                        }
                    }
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

                // Final screen positions, in label order, for shortcut audits
                // (tools/shortcut-baselines.py). Reporting only; no gate.
                // Viewing ratios show which groups face the camera: a tracked
                // group that faces it more than its twin group tells them apart.
                if (isLast && globals.benchmark.getPointScreenPosition) {
                    quality.finalScreens = globals.facePoints.getPoints().map(function (_, i) {
                        var sp = globals.benchmark.getPointScreenPosition(i);
                        return sp ? [Math.round(sp.x), Math.round(sp.y)] : null;
                    });
                    quality.finalViewQuality = globals.facePoints.getPoints().map(function (_, i) {
                        return Math.round(globals.facePoints.getPointViewQuality(i) * 1000) / 1000;
                    });
                }

                // Twins must be exact rotated copies on a model that carries the rotation.
                if (isLast && clusterLayout(preset.difficulty)) {
                    twinFailures(preset).forEach(function (reason) { failures.push({ step: stepIdx, reason: reason }); });
                }

                // The answer frame's leader lines must not run over another dot,
                // or a label can be read as naming the wrong dot.
                if (isLast && globals.pointAnnotations && globals.pointAnnotations.labelCrossings) {
                    var crossed = globals.pointAnnotations.labelCrossings();
                    if (crossed) {
                        quality.labelCrossings = crossed;
                        if (clusterLayout(preset.difficulty) && crossed.dots > 0) {
                            failures.push({ step: stepIdx, reason: "a label's leader line crosses another dot" });
                        }
                    }
                }

                // Every clustered group, tracked or decoy-only, must finish as a cluster.
                if (isLast && clusterLayout(preset.difficulty) && globals.benchmark.getPointScreenPosition) {
                    var spreadPx = clusterGroupGeometry(preset.difficulty).spreadPx;
                    // Loaded points drop `scatter`; take it from the preset.
                    var flagged = globals.facePoints.getPoints().map(function (p, i) {
                        var source = Array.isArray(preset.facePoints) ? preset.facePoints[i] : null;
                        return { faceId: p.faceId, scatter: !!(source && source.scatter) };
                    });
                    clusterGroups(flagged).forEach(function (group) {
                        var at = group.map(function (i) { return globals.benchmark.getPointScreenPosition(i); });
                        if (at.some(function (p) { return !p; })) return;
                        var cx = at.reduce(function (sum, p) { return sum + p.x; }, 0) / at.length;
                        var cy = at.reduce(function (sum, p) { return sum + p.y; }, 0) / at.length;
                        at.forEach(function (p, k) {
                            var gap = Math.hypot(p.x - cx, p.y - cy);
                            if (gap > spreadPx) {
                                failures.push({ step: stepIdx, pointIndex: group[k],
                                    reason: "dot too far from its group (" + Math.round(gap) + "px > " + spreadPx + "px)" });
                            }
                        });
                    });
                }

                // Check point separation (always at final step, optional at all steps)
                if ((isLast || enforceSeparationAllSteps) && globals.benchmark.getPointScreenPosition) {
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

    // ── Spin ───────────────────────────────────────────────────────────
    // Twins defeat frame matching only if the paper could have turned either
    // way. With a small turn from the flat to the final pose, a solver can
    // assume the least turn and tell a dot from its twin, so clustered tiers
    // add a turn about the paper normal drawn uniformly over a full circle,
    // at constant speed from the flat frame to the last.

    // Spins each profile (per-step Euler XYZ triples, frame 0 unrotated) by
    // adding an angle drawn from rng, eased linearly over the frames, to the
    // Euler y angle, which is the paper normal (as for the expert spin
    // style). Composing quaternions instead would pass through the XYZ
    // gimbal lock at a quarter turn, where x and z jump. The angle is drawn
    // from +-maxTurn (default half a turn; --cluster-spin-turns sets it per
    // run). Profiles that `validate` (failure reasons for {rotation} steps)
    // rejects, or that turn more than SPIN_MAX_PLANE_STEP in the paper's
    // plane between frames, are dropped: on a 4-fold base a 45-degree step
    // looks the same either way, and the turn could not be followed.
    function spinProfiles(profiles, rng, validate, maxTurn) {
        var limit = maxTurn || Math.PI;
        return profiles.map(function (rotations) {
            var psi = rng.randFloat(-limit, limit), n = rotations.length;
            return rotations.map(function (r, i) {
                var turn = psi * (n > 1 ? i / (n - 1) : 1);
                return [r[0], Math.round((r[1] + turn) * 10000) / 10000, r[2]];
            });
        }).filter(function (rotations) {
            if (maxPlaneStep(rotations) > SPIN_MAX_PLANE_STEP) return false;
            return !validate || validate(rotations.map(function (rotation) { return { rotation: rotation }; })).length === 0;
        });
    }

    // Like spinProfiles, but the turn is about the paper normal itself: each
    // frame's orientation R becomes R * Ry(turn). Euler y turns about the
    // normal only when the roll (Euler z) is zero. Expert's final poses roll
    // up to 0.7 rad, so a large Euler-y spin swung the back panels away from
    // the camera, the final probe rejected it, and 76% of expert presets
    // kept the smaller turn. Profiles that `validate` rejects, or that turn
    // more than SPIN_MAX_PLANE_STEP in the paper's plane between frames,
    // are dropped.
    var SPIN_MAX_PLANE_STEP = 0.6;
    function spinAboutNormal(profiles, rng, validate) {
        var normal = new THREE.Vector3(0, 1, 0);
        return profiles.map(function (rotations) {
            var psi = rng.randFloat(-Math.PI, Math.PI), n = rotations.length, prev = null;
            return rotations.map(function (r, i) {
                var turn = psi * (n > 1 ? i / (n - 1) : 1);
                var q = eulerQuaternion(r).multiply(new THREE.Quaternion().setFromAxisAngle(normal, turn));
                prev = eulerNear(q, prev);
                return prev.map(function (v) { return Math.round(v * 10000) / 10000 || 0; });
            });
        }).filter(function (rotations) {
            if (maxPlaneStep(rotations) > SPIN_MAX_PLANE_STEP) return false;
            return !validate || validate(rotations.map(function (rotation) { return { rotation: rotation }; })).length === 0;
        });
    }

    function eulerQuaternion(r) {
        return new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0], r[1], r[2], "XYZ"));
    }

    // XYZ Euler angles of q closest to `prev`. Each orientation has two
    // triples, (x, y, z) and (x + pi, pi - y, z + pi), and each angle can
    // move by whole turns; the nearest keeps frames from jumping.
    function eulerNear(q, prev) {
        var e = new THREE.Euler().setFromQuaternion(q, "XYZ");
        var options = [[e.x, e.y, e.z], [e.x + Math.PI, Math.PI - e.y, e.z + Math.PI]];
        if (!prev) return options[0];
        var best = null, bestGap = Infinity;
        options.forEach(function (r) {
            var near = r.map(function (v, k) { return v + 2 * Math.PI * Math.round((prev[k] - v) / (2 * Math.PI)); });
            var gap = Math.max.apply(null, near.map(function (v, k) { return Math.abs(v - prev[k]); }));
            if (gap < bestGap) { bestGap = gap; best = near; }
        });
        return best;
    }

    // Largest turn in the paper's plane between frames: the twist about the
    // model's y axis in each frame-to-frame rotation, taken in the model's
    // own frame. Most bases are 4- or 8-fold symmetric, and a large in-plane
    // step can read as a smaller one the other way.
    function maxPlaneStep(rotations) {
        var worst = 0;
        for (var i = 1; i < rotations.length; i++) {
            var step = eulerQuaternion(rotations[i - 1]).conjugate().multiply(eulerQuaternion(rotations[i]));
            var twist = 2 * Math.atan2(step.y, step.w);
            worst = Math.max(worst, Math.abs(Math.atan2(Math.sin(twist), Math.cos(twist))));
        }
        return worst;
    }

    // Twin rotations as turns about the paper normal: under rotation `name`,
    // the twins sit where the dots would be had the final pose turned on by
    // this angle, R * Ry(turn). Rendering both poses confirms the sign.
    // Mirrors TWIN_TURNS in tools/shortcut-baselines.py.
    var TWIN_TURNS = { rotate90: Math.PI / 2, rotate180: Math.PI, rotate270: -Math.PI / 2 };
    function rotationAngle(q) { return 2 * Math.acos(Math.min(1, Math.abs(q.w))); }

    // Share of `turns` under which the final pose turns less from flat than
    // its twin pose does, i.e. how often a least-turn guess picks the dot.
    function leastTurnShare(rotations, turns) {
        if (!turns.length) return 0.5;
        var real = eulerQuaternion(rotations[rotations.length - 1]), normal = new THREE.Vector3(0, 1, 0);
        return turns.filter(function (turn) {
            return rotationAngle(real) < rotationAngle(real.clone().multiply(new THREE.Quaternion().setFromAxisAngle(normal, turn)));
        }).length / turns.length;
    }

    // Up to `count` profiles, in order, taken so the least-turn guess stays
    // right about half the time: while picks lean toward the dot (share above
    // one half), the next pick comes from profiles that lean toward the twin,
    // and back. Spin alone leaves a lean, because expert's motion rules
    // (net turn, path length) keep some turns more often than others.
    function balanceLeastTurn(profiles, turns, count) {
        var toDot = [], toTwin = [], picked = [], lean = 0;
        profiles.forEach(function (rotations) {
            var share = leastTurnShare(rotations, turns);
            (share > 0.5 ? toDot : toTwin).push({ rotations: rotations, lean: share - 0.5 });
        });
        while (picked.length < count && (toDot.length || toTwin.length)) {
            var from = lean > 0 ? toTwin : toDot;
            if (!from.length) {
                from = from === toTwin ? toDot : toTwin;
                if (Math.abs(lean + from[0].lean) > 0.5) break;
            }
            var next = from.shift();
            lean += next.lean;
            picked.push(next.rotations);
        }
        return picked;
    }

    // ── Symmetric twins ────────────────────────────────────────────────
    // Comparing only the flat and final images, a solver can place a dot only
    // up to the folded model's symmetry: a mirrored or rotated copy of the
    // model looks the same, and only the frames in between show which way it
    // turned. A decoy at a dot's symmetric image, its twin, cannot be told
    // from the dot without those frames.

    // Flat (fold 0) vertex positions as [x, y] in the sheet's plane, with the
    // sheet's centre and size.
    function flatSheet() {
        var flat = globals.model.getNodes().map(function (node) { return node.getOriginalPosition(); });
        var keys = ["x", "y", "z"];
        var spans = keys.map(function (k) {
            var values = flat.map(function (p) { return p[k]; });
            return { key: k, min: Math.min.apply(null, values), max: Math.max.apply(null, values) };
        });
        // The sheet is flat along the axis with the smallest span.
        var axes = spans.slice().sort(function (a, b) { return (b.max - b.min) - (a.max - a.min); }).slice(0, 2);
        return {
            xy: flat.map(function (p) { return [p[axes[0].key], p[axes[1].key]]; }),
            center: axes.map(function (a) { return (a.min + a.max) / 2; }),
            size: Math.max(axes[0].max - axes[0].min, axes[1].max - axes[1].min)
        };
    }

    // Isometries about the sheet's centre, as 2x2 matrices [a, b, c, d].
    var SHEET_ISOMETRIES = [
        { name: "rotate90", m: [0, -1, 1, 0] }, { name: "rotate180", m: [-1, 0, 0, -1] },
        { name: "rotate270", m: [0, 1, -1, 0] }, { name: "mirrorX", m: [1, 0, 0, -1] },
        { name: "mirrorY", m: [-1, 0, 0, 1] }, { name: "mirrorDiagonal", m: [0, 1, 1, 0] },
        { name: "mirrorAntidiagonal", m: [0, -1, -1, 0] }
    ];
    function isMirror(iso) { return iso.m[0] * iso.m[3] - iso.m[1] * iso.m[2] < 0; }
    function applyIsometry(iso, p, c) {
        var dx = p[0] - c[0], dy = p[1] - c[1];
        return [c[0] + iso.m[0] * dx + iso.m[1] * dy, c[1] + iso.m[2] * dx + iso.m[3] * dy];
    }

    // The isometries that map every flat vertex onto a vertex, each with the
    // vertex permutation it induces: the crease pattern's symmetries.
    function sheetSymmetries(sheet) {
        var tolerance = sheet.size * 1e-3;
        return SHEET_ISOMETRIES.map(function (iso) {
            var perm = sheet.xy.map(function (p) {
                var q = applyIsometry(iso, p, sheet.center);
                for (var j = 0; j < sheet.xy.length; j++) {
                    if (Math.hypot(q[0] - sheet.xy[j][0], q[1] - sheet.xy[j][1]) < tolerance) return j;
                }
                return -1;
            });
            return perm.indexOf(-1) < 0 ? { name: iso.name, m: iso.m, perm: perm } : null;
        }).filter(Boolean);
    }

    // How the folded model, in the current fold, carries a sheet symmetry.
    // error: the largest change in any pairwise vertex distance under the
    // permutation, as a fraction of the sheet's size; near zero means some
    // isometry maps the folded model onto itself. rotation: whether that
    // isometry is a rotation, from the sign of the volume of the largest
    // vertex tetrahedron before and after; null when the model is too flat to
    // tell. Only a rotation leaves the image unchanged: a mirror-symmetric
    // model still shows which half is which.
    function foldedSymmetry(perm, size) {
        var pos = globals.model.getPositionsArray();
        function at(v) { return [pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]]; }
        function gap(a, b) { var p = at(a), q = at(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); }
        function volume(a, b, c, d) {
            var p = at(a), q = at(b), r = at(c), s = at(d);
            var u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]], w = [s[0] - p[0], s[1] - p[1], s[2] - p[2]];
            return u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0]);
        }
        var n = perm.length, worst = 0;
        for (var a = 0; a < n; a++) {
            for (var b = a + 1; b < n; b++) worst = Math.max(worst, Math.abs(gap(a, b) - gap(perm[a], perm[b])));
        }
        // Largest tetrahedron: the two farthest vertices, the vertex farthest
        // from their line, then the vertex farthest from that plane.
        var i0 = 0, i1 = 0, i2 = 0, i3 = 0, best = -1;
        for (var x = 0; x < n; x++) { var g = gap(0, x); if (g > best) { best = g; i0 = x; } }
        best = -1;
        for (var y = 0; y < n; y++) { var h = gap(i0, y); if (h > best) { best = h; i1 = y; } }
        best = -1;
        for (var z = 0; z < n; z++) {
            var p0 = at(i0), p1 = at(i1), pz = at(z);
            var e = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], f = [pz[0] - p0[0], pz[1] - p0[1], pz[2] - p0[2]];
            var cross = Math.hypot(e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]);
            if (cross > best) { best = cross; i2 = z; }
        }
        best = -1;
        for (var t = 0; t < n; t++) { var vol = Math.abs(volume(i0, i1, i2, t)); if (vol > best) { best = vol; i3 = t; } }
        var before = volume(i0, i1, i2, i3), after = volume(perm[i0], perm[i1], perm[i2], perm[i3]);
        var flat = Math.abs(before) < 1e-3 * size * size * size;
        return { error: worst / size, rotation: flat ? null : before * after > 0 };
    }

    // The point at a dot's symmetric image, or null when the renderer would
    // draw it elsewhere (it pulls barycentric coordinates in to at least 0.08
    // from each edge). A sheet rotation keeps the dot's side of the paper. A
    // sheet mirror that the folded model carries as a rotation is a flip,
    // which puts the twin on the other side.
    function twinPoint(point, sym, sheet, faceCount) {
        var faces = globals.model.getFaces();
        var face = faces[point.faceId < faceCount ? point.faceId : point.faceId - faceCount];
        if (!face) return null;
        var b = globals.facePoints.insetBarycentric(point.u, point.v, point.w);
        var corners = face.map(function (v) { return sheet.xy[v]; });
        var q = applyIsometry(sym, [
            b.u * corners[0][0] + b.v * corners[1][0] + b.w * corners[2][0],
            b.u * corners[0][1] + b.v * corners[1][1] + b.w * corners[2][1]
        ], sheet.center);
        var hit = flatFaceAt(sheet, faces, q);
        if (!hit) return null;
        var drawn = globals.facePoints.insetBarycentric(hit.u, hit.v, hit.w);
        if (Math.abs(drawn.u - hit.u) + Math.abs(drawn.v - hit.v) > 1e-4) return null;
        var front = (point.faceId < faceCount) !== isMirror(sym);
        return {
            faceId: front ? hit.face : hit.face + faceCount,
            u: Math.round(hit.u * 1e6) / 1e6, v: Math.round(hit.v * 1e6) / 1e6, w: Math.round(hit.w * 1e6) / 1e6
        };
    }

    // Locates flat point q: the face containing it and its barycentric
    // coordinates there, or null.
    function flatFaceAt(sheet, faces, q) {
        for (var t = 0; t < faces.length; t++) {
            var A = sheet.xy[faces[t][0]], B = sheet.xy[faces[t][1]], C = sheet.xy[faces[t][2]];
            var det = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
            if (Math.abs(det) < 1e-12) continue;
            var u = ((B[1] - C[1]) * (q[0] - C[0]) + (C[0] - B[0]) * (q[1] - C[1])) / det;
            var v = ((C[1] - A[1]) * (q[0] - C[0]) + (A[0] - C[0]) * (q[1] - C[1])) / det;
            var w = 1 - u - v;
            if (Math.min(u, v, w) >= -1e-6) return { face: t, u: u, v: v, w: w };
        }
        return null;
    }

    // Folded models carry a rotation only to within the solver's settling;
    // larger errors would let the final image tell a dot from its twin.
    var TWIN_MAX_ERROR = 0.025;

    // Sheet rotations the folded model carries in the current fold, each with
    // its face table: the face holding each face's rotated centroid, or -1.
    function carriedRotations() {
        var sheet = flatSheet();
        var faces = globals.model.getFaces();
        return sheetSymmetries(sheet).filter(function (sym) { return !isMirror(sym); }).map(function (sym) {
            var folded = foldedSymmetry(sym.perm, sheet.size);
            if (folded.error > TWIN_MAX_ERROR || folded.rotation !== true) return null;
            return {
                name: sym.name,
                faces: faces.map(function (face) {
                    var c = [0, 1].map(function (k) { return (sheet.xy[face[0]][k] + sheet.xy[face[1]][k] + sheet.xy[face[2]][k]) / 3; });
                    var hit = flatFaceAt(sheet, faces, applyIsometry(sym, c, sheet.center));
                    return hit ? hit.face : -1;
                })
            };
        }).filter(Boolean);
    }

    // Folds the model, unrotated, to `foldPercent` and reports carriedRotations.
    function measureCarriedRotations(foldPercent, callback) {
        globals.setCreasePercent(foldPercent / 100);
        globals.shouldChangeCreasePercent = true;
        globals.threeView.resetModel();
        setTimeout(function () {
            var rotations = carriedRotations();
            globals.setCreasePercent(0);
            globals.shouldChangeCreasePercent = true;
            setTimeout(function () { callback(rotations); }, 400);
        }, Math.max(1500, CLUSTER_SETTLE_MS));
    }

    // Disjoint (seed face, twin face) pairs under one rotation's face table,
    // both faces in `readable`; with `anchors`, the seed face must be in it.
    // Mirrors twinPairs in js/benchmark.js, which gates trajectory search.
    function twinPairs(table, readable, anchors, bothAnchors) {
        var used = {}, pairs = [];
        table.forEach(function (twin, face) {
            if (twin < 0 || twin === face || used[face] || used[twin] || !readable[face] || !readable[twin]) return;
            if (anchors && (!anchors[face] || (bothAnchors && !anchors[twin]))) return;
            used[face] = used[twin] = true;
            pairs.push([face, twin]);
        });
        return pairs;
    }

    // Final-frame twin check for a clustered preset: the folded model must
    // carry the preset's rotation, and every twin must sit at its seed dot's
    // rotated spot. Returns failure reasons.
    function twinFailures(preset) {
        var name = (preset.clusterPlacement || {}).symmetry;
        var sheet = flatSheet();
        var sym = sheetSymmetries(sheet).filter(function (candidate) { return candidate.name === name && !isMirror(candidate); })[0];
        if (!sym) return ["twins need a rotation of the crease pattern; preset names " + name];
        var failures = [];
        var folded = foldedSymmetry(sym.perm, sheet.size);
        if (folded.error > TWIN_MAX_ERROR || folded.rotation !== true) {
            failures.push("folded model does not carry " + name + " as a rotation (error " + folded.error.toFixed(3) + ")");
        }
        var faceCount = globals.model.getFaces().length, points = preset.facePoints || [], seeds = {};
        points.forEach(function (point) { if (!point.twin) seeds[point.pair] = point; });
        points.forEach(function (point, i) {
            if (!point.twin) return;
            var expected = seeds[point.pair] && twinPoint(seeds[point.pair], sym, sheet, faceCount);
            if (!expected || expected.faceId !== point.faceId
                || Math.abs(expected.u - point.u) + Math.abs(expected.v - point.v) + Math.abs(expected.w - point.w) > 2e-3) {
                failures.push("dot " + i + " is not at its seed dot's " + name + " image");
            }
        });
        return failures;
    }

    // For the current pose: each sheet symmetry, how far the folded model is
    // from having it, and where every point's twin would land and how it
    // would read. Records only.
    function symmetryReport(preset) {
        var sheet = flatSheet();
        var faceCount = globals.model.getFaces().length;
        var points = globals.facePoints.getPoints();
        return sheetSymmetries(sheet).map(function (sym) {
            var folded = foldedSymmetry(sym.perm, sheet.size);
            return {
                name: sym.name,
                foldedError: Math.round(folded.error * 10000) / 10000,
                rotation: folded.rotation,
                twins: points.map(function (point, i) {
                    var twin = twinPoint(point, sym, sheet, faceCount);
                    if (!twin) return null;
                    var saved = { faceId: point.faceId, u: point.u, v: point.v, w: point.w };
                    globals.facePoints.updatePointPosition(i, twin.faceId, twin.u, twin.v, twin.w);
                    var sp = globals.benchmark.getPointScreenPosition(i);
                    var read = {
                        faceId: twin.faceId,
                        visible: globals.facePoints.isPointVisible(i),
                        viewQuality: Math.round(globals.facePoints.getPointViewQuality(i) * 1000) / 1000,
                        clear: globals.facePoints.hasSurfaceClearance(i, markerClearanceRadius(preset)),
                        screen: sp ? [Math.round(sp.x), Math.round(sp.y)] : null
                    };
                    globals.facePoints.updatePointPosition(i, saved.faceId, saved.u, saved.v, saved.w);
                    return read;
                })
            };
        });
    }

    // Replays a preset the way validatePreset does and records, for every
    // point at every step, its visibility, viewing ratio and screen position.
    // Visibility ignores the hidden flag, so one replay shows which dots in a
    // clustered group could be the tracked dot (tools/rebalance-anchors.py).
    // The final step adds symmetryReport. Records only; gates nothing.
    function tracePoints(preset, settleMs, callback) {
        var steps = preset.steps || [];
        if (!globals.facePoints || !globals.model || !globals.threeView || !steps.length) {
            callback({ error: "Missing required modules or steps" });
            return;
        }
        resetValidationBaseline();
        globals.benchmark.applySettings(preset);
        var count = globals.facePoints.getPoints().length;
        var settle = Math.max(settleMs || 300, 400, clusterLayout(preset.difficulty) ? CLUSTER_SETTLE_MS : 0);
        var trace = [];
        (function traceStep(stepIdx) {
            if (stepIdx >= steps.length) {
                globals.facePoints.clearPoints();
                globals.threeView.resetModel();
                callback({ steps: trace });
                return;
            }
            var step = steps[stepIdx];
            globals.setCreasePercent(step.fold / 100);
            globals.shouldChangeCreasePercent = true;
            globals.benchmark.setPOV(step.pov);
            if (step.rotation) {
                var r = Array.isArray(step.rotation) ? step.rotation : [step.rotation.x || 0, step.rotation.y || 0, step.rotation.z || 0];
                globals.threeView.setModelRotation(r[0], r[1], r[2]);
            } else {
                globals.threeView.resetModel();
            }
            setTimeout(function () {
                var row = { fold: step.fold, visible: [], viewQuality: [], screens: [] };
                for (var i = 0; i < count; i++) {
                    var sp = globals.benchmark.getPointScreenPosition(i);
                    row.visible.push(globals.facePoints.isPointVisible(i));
                    row.viewQuality.push(Math.round(globals.facePoints.getPointViewQuality(i) * 1000) / 1000);
                    row.screens.push(sp ? [Math.round(sp.x), Math.round(sp.y)] : null);
                }
                if (stepIdx === steps.length - 1) row.symmetry = symmetryReport(preset);
                trace.push(row);
                traceStep(stepIdx + 1);
            }, settle);
        })(0);
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
        var difficulty = clampDifficultyTier(opts.difficulty || 4);
        var count = opts.count || 7;
        var baseName = opts.baseName || "bird-frontback";
        var startIndex = opts.startIndex || 9;
        var seed = opts.seed || Date.now();
        var settleMs = opts.settleMs || 300;
        var trajectoryMode = opts.trajectoryMode || "hybrid";
        setClusterPoints(opts.clusterPoints);
        setClusterScatter(opts.clusterScatter);
        setClusterGroupSize(opts.clusterGroupSize);
        setClusterBackGroups(opts.clusterBackGroups);
        setClusterSymmetricTwins(opts.symmetricTwins);
        setClusterEndSizes(opts.clusterEndSizes);
        setClusterSpinTurns(opts.clusterSpinTurns);
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

                scanCandidates = filterCandidatesByDifficulty(scanCandidates, difficulty, modelFaceCount, count, rng);
                var selected = selectDiverse(scanCandidates, count, existingRefs);
                var spares = scanCandidates.filter(function (candidate) { return selected.indexOf(candidate) < 0; });
                refineAndRevalidate(selected, settleMs, rng, function (finalPresets) {
                    if (finalPresets.length === 0) {
                        callback({ error: "No refined progression candidates passed validation", generated: [] });
                        return;
                    }
                    finalize(finalPresets, baseName, startIndex, callback);
                }, spares);
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
        setClusterPoints: setClusterPoints,
        setClusterScatter: setClusterScatter,
        setClusterGroupSize: setClusterGroupSize,
        setClusterBackGroups: setClusterBackGroups,
        setClusterSymmetricTwins: setClusterSymmetricTwins,
        setClusterEndSizes: setClusterEndSizes,
        setClusterSpinTurns: setClusterSpinTurns,
        tracePoints: tracePoints,
        validateBatch: validateBatch,
        selectDiverse: selectDiverse,
        COLOR_PAIRS: COLOR_PAIRS,
        makeRng: makeRng
    };
}
