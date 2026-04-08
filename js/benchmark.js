/**
 * Benchmark system for Origami Simulator.
 *
 * Supports two configuration sources:
 *   1. JSON preset file (benchmarks.json) — selected via ?benchmark=<name>
 *   2. Ad-hoc URL parameters — override or replace JSON values
 *
 * URL parameters:
 *   model        — demo file path (e.g. Origami/flappingBird.svg)
 *   benchmark    — name of preset in benchmarks.json
 *   benchmarks   — JSON path for runAll (e.g. benchmarks.json)
 *   runAll       — "true" to run all presets from the benchmarks JSON in sequence
 *   colorMode    — color mode to apply after load
 *   pointA       — face ID for highlight point A
 *   pointB       — face ID for highlight point B
 *   facePoints   — Points on faces (deterministic). Counts: {"0":3,"5":2}. Explicit barycentric: {"0":[[0.33,0.33,0.34],[0.5,0.5,0]],"5":[[0.5,0.25,0.25]]} or [{faceId:0,u:0.33,v:0.33,w:0.34},...]. URL: facePoints={"0":3,"5":2}
 *   foldStart    — fold % for first step  (0-100)
 *   foldMid      — fold % for middle step (0-100)
 *   foldEnd      — fold % for last step   (0-100)
 *   povStart     — camera POV at first step  (iso, x, -x, y, -y, z, -z)
 *   povMid       — camera POV at middle step
 *   povEnd       — camera POV at last step
 *   fold         — initial fold % (0-100) before any animation; use top-level, not inside animation blocks
 *   pauseDuration — seconds to wait before starting (animation flow) or at each step (steps flow); default 2
 *   autoCapture  — "true" to capture PNG at each step
 *   autoRun      — "true" to start sequence automatically after load
 *   foldAnimation — "true" to animate fold 0→90 over 4s (or use foldAnimFrom/foldAnimTo/foldAnimDuration).
 *                   povKeyframes: [{fold, pov}, ...] for smooth POV change.
 *                   trackModel: "true" to rotate the model (camera fixed) so all points stay in view.
 *                   fitAllPoints: "true" to zoom out so entire model stays in view when camera orbits.
 *                   hidePointsDuringAnimation: "true" to hide face points during fold animation (and intermediate steps in steps mode).
 *                   delay / delayBeforeAnimation: seconds to wait before animation starts (e.g. 1).
 *                   delayAfterPreview: seconds to pause between previewRotation and foldAnimation (e.g. 1).
 *   previewRotation  — top-level: { duration: 2, povKeyframes: [...] } — rotate view at cfg.fold (initial fold).
 *                   trackModel: "true" to rotate the model instead of moving camera during preview.
 *                   fitAllPoints: "true" to zoom out so entire model stays in view during preview.
 *   color1, color2   — hex colors for labelOnly (front/back sides), e.g. ec008b, dddddd. URL: color1=ec008b&color2=dddddd
 *   backgroundColor — hex background color (e.g. ffffff or #ffffff).
 *   showPointNumbers — "false" to hide numbers on face points
 */

function initBenchmark(globals) {

    var config = null;
    var presets = null;
    var loadModelCallback = null;
    var running = false;
    var currentStep = 0;
    var currentBenchmarkName = null;
    var stateAccumulator = [];   // collects { fold, pov, visiblePoints } per captured step
    var capturedFiles = [];      // ordered PNG filenames saved this run (for dataset JSON)
    var datasetSampleCounter = 0; // monotonic integer ID across all benchmark runs in session

    // ── URL parameter helpers ──

    function getParam(name) {
        var match = new RegExp('[?&]' + name + '=([^&#]*)').exec(location.search);
        return match ? decodeURIComponent(match[1]) : null;
    }

    function getParamInt(name) {
        var v = getParam(name);
        return v !== null && !isNaN(parseInt(v)) ? parseInt(v) : null;
    }

    function getParamFloat(name) {
        var v = getParam(name);
        return v !== null && !isNaN(parseFloat(v)) ? parseFloat(v) : null;
    }

    function getParamBool(name) {
        var v = getParam(name);
        return v === "true" || v === "1";
    }

    // ── Camera POV ──

    function parsePOVVector(pov) {
        if (Array.isArray(pov) && pov.length === 3) {
            return new THREE.Vector3(pov[0], pov[1], pov[2]);
        }
        if (typeof pov === "string" && pov.indexOf(",") !== -1) {
            var parts = pov.split(",").map(Number);
            if (parts.length === 3 && parts.every(function(n) { return !isNaN(n); })) {
                return new THREE.Vector3(parts[0], parts[1], parts[2]);
            }
        }
        return null;
    }

    function getPOVDirection(pov) {
        if (!pov) return null;
        var vec = parsePOVVector(pov);
        if (vec) return vec;
        switch (pov) {
            case "iso":  return new THREE.Vector3(1, 1, 1);
            case "x":    return new THREE.Vector3(1, 0, 0);
            case "-x":   return new THREE.Vector3(-1, 0, 0);
            case "y":    return new THREE.Vector3(0, 1, 0);
            case "-y":   return new THREE.Vector3(0, -1, 0);
            case "z":    return new THREE.Vector3(0, 0, 1);
            case "-z":   return new THREE.Vector3(0, 0, -1);
            default:     return null;
        }
    }

    function setPOV(pov) {
        if (!pov) return;
        var vec = parsePOVVector(pov);
        if (vec) {
            globals.threeView.setCameraToPosition(vec);
            return;
        }
        globals.threeView.resetModel();
        switch (pov) {
            case "iso":  globals.threeView.setCameraIso(); break;
            case "x":    globals.threeView.setCameraX(1);  break;
            case "-x":   globals.threeView.setCameraX(-1); break;
            case "y":    globals.threeView.setCameraY(1);  break;
            case "-y":   globals.threeView.setCameraY(-1); break;
            case "z":    globals.threeView.setCameraZ(1);  break;
            case "-z":   globals.threeView.setCameraZ(-1); break;
            default:
                console.warn("benchmark: unknown POV '" + pov + "'");
        }
    }

    // ── Model rotation helpers ──

    function parseRotation(rot) {
        if (!rot) return null;
        if (Array.isArray(rot) && rot.length === 3) return { x: rot[0], y: rot[1], z: rot[2] };
        if (typeof rot === "object" && rot !== null && "x" in rot) return { x: rot.x || 0, y: rot.y || 0, z: rot.z || 0 };
        return null;
    }

    function applyRotation(rot) {
        var r = parseRotation(rot);
        if (r) {
            globals.threeView.setModelRotation(r.x, r.y, r.z);
        }
    }

    // Linear interpolation of Euler angles between keyframes that have a rotation field.
    // keyframes: [{ fold: N, rotation: [x,y,z] }, ...] — fold is the progress key.
    function getInterpolatedRotation(keyframes, foldPct) {
        if (!keyframes || keyframes.length === 0) return null;
        var hasAny = false;
        for (var i = 0; i < keyframes.length; i++) {
            if (keyframes[i].rotation) { hasAny = true; break; }
        }
        if (!hasAny) return null;
        var idx = 0;
        while (idx < keyframes.length - 1 && keyframes[idx + 1].fold <= foldPct) idx++;
        var a = keyframes[idx];
        var b = keyframes[idx + 1];
        var ra = parseRotation(a.rotation) || { x: 0, y: 0, z: 0 };
        if (!b) return ra;
        var t = Math.max(0, Math.min(1, (foldPct - a.fold) / (b.fold - a.fold)));
        var rb = parseRotation(b.rotation) || { x: 0, y: 0, z: 0 };
        return {
            x: ra.x + (rb.x - ra.x) * t,
            y: ra.y + (rb.y - ra.y) * t,
            z: ra.z + (rb.z - ra.z) * t
        };
    }

    // ── Apply settings (colorMode, highlights) ──

    function applySettings(cfg) {
        if (cfg.colorMode) {
            globals.colorMode = cfg.colorMode;
            // update radio UI
            $(".radio>input[value=" + cfg.colorMode + "]").prop("checked", true);
            // show/hide option panels
            $("#coloredMaterialOptions").toggle(cfg.colorMode === "color" || cfg.colorMode === "greyscale");
            $("#axialStrainMaterialOptions").toggle(cfg.colorMode === "axialStrain");
            $("#faceIDOptions").toggle(cfg.colorMode === "faceID");
            $("#faceTriangleIDOptions").toggle(cfg.colorMode === "faceTriangleID" || cfg.colorMode === "labelOnly");
            $("#labelOnlyOptions").toggle(cfg.colorMode === "labelOnly");
            globals.model.setMeshMaterial();
        }

        if (cfg.pointA !== undefined && cfg.pointA !== null) {
            var val = parseInt(cfg.pointA);
            if (!isNaN(val)) {
                if (globals.colorMode === "faceTriangleID" || globals.colorMode === "labelOnly") {
                    if (globals.facePoints) {
                        globals.facePoints.clearPoints();
                        globals.facePoints.addPoint(val);
                    }
                    if ($("#facePointFaceId").length) $("#facePointFaceId").val(val);
                    if (globals.controls && globals.controls.refreshFacePointList) globals.controls.refreshFacePointList();
                } else {
                    globals.highlightedFaceA = val;
                    $("#highlightFaceA").val(val);
                }
                globals.model.updateFaceColors();
            }
        }
        if (cfg.pointB !== undefined && cfg.pointB !== null) {
            var val = parseInt(cfg.pointB);
            if (!isNaN(val)) {
                if (globals.colorMode === "faceTriangleID" || globals.colorMode === "labelOnly") {
                    if (globals.facePoints) globals.facePoints.addPoint(val);
                    if (globals.controls && globals.controls.refreshFacePointList) globals.controls.refreshFacePointList();
                } else {
                    globals.highlightedFaceB = val;
                    $("#highlightFaceB").val(val);
                }
                globals.model.updateFaceColors();
            }
        }

        if (cfg.facePoints && globals.facePoints && (globals.colorMode === "faceTriangleID" || globals.colorMode === "labelOnly")) {
            globals.facePoints.initFromConfig(cfg.facePoints);
            if (globals.controls && globals.controls.refreshFacePointList) globals.controls.refreshFacePointList();
            globals.model.updateFaceColors();
        }

        if (cfg.showPointNumbers !== undefined) {
            globals.showFacePointNumbers = cfg.showPointNumbers !== false;
            if ($("#showFacePointNumbers").length) $("#showFacePointNumbers").prop("checked", globals.showFacePointNumbers);
            globals.model.updateFaceColors();
        }

        if (cfg.labelStyle !== undefined) {
            globals.labelStyle = (cfg.labelStyle === "both") ? "circle" : cfg.labelStyle;
            globals.model.updateFaceColors();
        }

        if (cfg.backgroundColor !== undefined && cfg.backgroundColor !== null) {
            var hex = String(cfg.backgroundColor).replace(/^#/, "");
            globals.backgroundColor = hex;
            if (globals.threeView && globals.threeView.setBackgroundColor) globals.threeView.setBackgroundColor(hex);
            if ($("#backgroundColor").length) $("#backgroundColor").val(hex);
        }

        if (cfg.color1 !== undefined && cfg.color1 !== null) {
            var c1 = String(cfg.color1).replace(/^#/, "");
            globals.color1 = c1;
            if ($("#color1").length) $("#color1").val(c1).css({ "border-color": "#" + c1 });
            if ($("#labelOnlyColor1").length) $("#labelOnlyColor1").val(c1);
        }
        if (cfg.color2 !== undefined && cfg.color2 !== null) {
            var c2 = String(cfg.color2).replace(/^#/, "");
            globals.color2 = c2;
            if ($("#color2").length) $("#color2").val(c2).css({ "border-color": "#" + c2 });
            if ($("#labelOnlyColor2").length) $("#labelOnlyColor2").val(c2);
        }
        if ((cfg.color1 !== undefined && cfg.color1 !== null) || (cfg.color2 !== undefined && cfg.color2 !== null)) {
            if (globals.colorMode === "labelOnly" || globals.colorMode === "color" || globals.colorMode === "greyscale") globals.model.setMeshMaterial();
        }
    }

    // ── Filename helpers ──

    // Zero-pad n to `len` digits, e.g. padNum(30, 3) → "030"
    function padNum(n, len) {
        var s = String(Math.round(n));
        while (s.length < len) s = "0" + s;
        return s;
    }

    // Canonical label for a captured state: fold{NNN}_pov-{pov}
    // e.g. "fold000_pov-y", "fold090_pov-iso"  — used internally for ground truth only
    function stepLabel(fold, pov) {
        return "fold" + padNum(fold != null ? fold : 0, 3) + "_pov-" + (pov || "iso");
    }

    // Opaque step filename for PNGs — hides POV from VLM evaluators
    // e.g. index 0 → "step01", index 4 → "step05"
    function stepFilename(index) {
        return "step" + padNum(index + 1, 2);
    }

    // ── Screenshot capture ──
    // label: descriptive string, e.g. "start", "end", "step0"
    // Files are saved to screenshots/{benchmarkName}_{label}.png via the
    // local Bun dev server (/api/screenshot). Falls back to browser saveAs
    // if the endpoint is unavailable (e.g. opening index.html directly).
    // After all steps, a single {benchmarkName}_summary.json is saved.

    // Records visibility state for the current step into stateAccumulator.
    // Called after each screenshot capture.
    function recordStateVisibility(label) {
        if (!globals.facePoints || !globals.facePoints.getPointsWithVisibility) return;
        var pts = globals.facePoints.getPointsWithVisibility();
        if (!pts || pts.length === 0) return;

        var fold = null, pov = null;
        var m = label.match(/^fold(\d+)_pov-(.+)$/);
        if (m) { fold = parseInt(m[1], 10); pov = m[2]; }

        var visiblePoints = [];
        for (var i = 0; i < pts.length; i++) {
            if (pts[i].visible) visiblePoints.push(i);
        }

        var visibleFaceIds = globals.facePoints.getVisibleFaceIds ? globals.facePoints.getVisibleFaceIds() : [];

        stateAccumulator.push({ fold: fold, pov: pov, visiblePoints: visiblePoints, visibleFaceIds: visibleFaceIds });
    }

    // Saves one JSON file per benchmark summarising visibility across all states.
    // Format: { benchmark, totalPoints, states: [{fold, pov, visiblePoints}], alwaysVisible }
    function saveBenchmarkSummary(name) {
        if (!globals.facePoints || !globals.facePoints.getPointsWithVisibility) return;
        if (stateAccumulator.length === 0) return;

        var pts = globals.facePoints.getPointsWithVisibility();
        var totalPoints = pts ? pts.length : 0;

        // alwaysVisible = intersection of visiblePoints across all states
        var alwaysVisible = stateAccumulator[0].visiblePoints.slice();
        for (var s = 1; s < stateAccumulator.length; s++) {
            var stateSet = stateAccumulator[s].visiblePoints;
            alwaysVisible = alwaysVisible.filter(function (idx) {
                return stateSet.indexOf(idx) !== -1;
            });
        }

        // alwaysVisibleFaceIds = intersection of visibleFaceIds across all states
        var alwaysVisibleFaceIds = (stateAccumulator[0].visibleFaceIds || []).slice();
        for (var sf = 1; sf < stateAccumulator.length; sf++) {
            var faceSet = stateAccumulator[sf].visibleFaceIds || [];
            alwaysVisibleFaceIds = alwaysVisibleFaceIds.filter(function (id) {
                return faceSet.indexOf(id) !== -1;
            });
        }

        var hiddenPoints = globals.facePoints.getHiddenIndices ? globals.facePoints.getHiddenIndices() : [];
        // Map hidden point indices to their letter labels (A, B, C, ...)
        var hiddenPointLabels = {};
        for (var hi = 0; hi < hiddenPoints.length; hi++) {
            hiddenPointLabels[hiddenPoints[hi]] = String.fromCharCode(65 + (hi % 26));
        }

        var summary = {
            benchmark:             name,
            totalPoints:           totalPoints,
            hiddenPoints:          hiddenPoints,
            hiddenPointLabels:     hiddenPointLabels,
            states:                stateAccumulator.slice(),
            alwaysVisible:         alwaysVisible,
            alwaysVisibleFaceIds:  alwaysVisibleFaceIds
        };

        var blob = new Blob([JSON.stringify(summary, null, 2)], { type: "application/json" });
        var formData = new FormData();
        formData.append("file", blob, "summary.json");
        fetch("/api/screenshot?folder=" + encodeURIComponent(name), { method: "POST", body: formData })
            .then(function (res) {
                if (!res.ok) throw new Error("server error");
                console.log("benchmark: saved screenshots/" + name + "/summary.json");
            })
            .catch(function () {
                console.warn("benchmark: could not save summary (server unavailable)");
            });

        saveDatasetJson(name, summary);
    }

    // Generates a DESIGN_PROTOCOL-compliant dataset JSON alongside the summary.
    // One sample per benchmark: asks which lettered points in the final folded state
    // correspond to the original unmarked dots on the flat paper.
    function saveDatasetJson(name, summary) {
        if (capturedFiles.length === 0) return;
        var samples = [];
        var images = capturedFiles.slice();
        var task = "order_origami_tracking";

        // Build the list of ALL letter labels in the final state (A, B, C, ...)
        // and identify which are the "initial" (non-hidden) points.
        var allLabels = [];
        var initialLabels = [];
        var letterIndex = 0;
        for (var i = 0; i < summary.totalPoints; i++) {
            var letter = String.fromCharCode(65 + (letterIndex % 26));
            allLabels.push(letter);
            letterIndex++;
            var isHidden = summary.hiddenPoints.indexOf(i) !== -1;
            if (!isHidden) {
                initialLabels.push(letter);
            }
        }

        var optionsList = allLabels.slice().sort();
        var answerSorted = initialLabels.slice().sort();
        var numInitial = initialLabels.length;

        samples.push({
            id:            datasetSampleCounter++,
            question:      "The first image show an unfolded paper with " + numInitial +
                           " unmarked dot(s). The paper is then folded through a sequence of steps." +
                           " The last image shows the folded result with all points labeled " +
                           optionsList.join(", ") + "." +
                           " Which lettered point(s) correspond to the original unmarked dot(s)?" +
                           " List the letter(s) separated by commas.",
            answer:        answerSorted.join(", "),
            images:        images,
            task:          task,
            category:      "order",
            level:         "perception",
            question_type: "origami_point_tracking",
            answer_type:   "list",
            options:       optionsList,
            metadata: {
                benchmark:         name,
                totalPoints:       summary.totalPoints,
                initialPoints:     initialLabels,
                hiddenPoints:      summary.hiddenPoints,
                allLabels:         allLabels,
                hiddenPointLabels: summary.hiddenPointLabels
            }
        });

        var blob = new Blob([JSON.stringify(samples, null, 2)], { type: "application/json" });
        var formData = new FormData();
        formData.append("file", blob, "dataset.json");
        fetch("/api/screenshot?folder=" + encodeURIComponent(name), { method: "POST", body: formData })
            .then(function (res) {
                if (!res.ok) throw new Error("server error");
                console.log("benchmark: saved screenshots/" + name + "/dataset.json");
            })
            .catch(function () {
                console.warn("benchmark: could not save dataset JSON (server unavailable)");
            });
    }


    // filenameLabel — used in the PNG filename (e.g. "step01"); hides POV from evaluators
    // recordLabel  — passed to recordStateVisibility for fold/pov ground truth parsing
    //                (e.g. "fold000_pov-y"); if omitted, filenameLabel is used for both
    // Files are saved to screenshots/{benchmarkName}/{filenameLabel}.png
    function captureScreenshot(filenameLabel, recordLabel, callback) {
        if (typeof recordLabel === "function") { callback = recordLabel; recordLabel = filenameLabel; }
        var name = currentBenchmarkName || globals.filename || "benchmark";
        var filename = filenameLabel + ".png";
        var relativePath = name + "/" + filename;
        globals.screenRecordFilename = name + "_" + filenameLabel;
        globals.captureCallback = function (blob) {
            var formData = new FormData();
            formData.append("file", blob, filename);
            fetch("/api/screenshot?folder=" + encodeURIComponent(name), { method: "POST", body: formData })
                .then(function (res) {
                    if (!res.ok) throw new Error("server error");
                    console.log("benchmark: saved screenshots/" + relativePath);
                    if (recordLabel !== null && recordLabel !== undefined) recordStateVisibility(recordLabel);
                    capturedFiles.push(relativePath);
                    if (callback) callback();
                })
                .catch(function () {
                    // fallback: browser download
                    saveAs(blob, filename);
                    capturedFiles.push(relativePath);
                    if (callback) callback();
                });
        };
        globals.capturer = "png";
    }

    function captureFinalWithBothStyles(filenameLabel, recordLabel, labelStyleMode, callback) {
        if (labelStyleMode !== "both") {
            captureScreenshot(filenameLabel, recordLabel, callback);
            return;
        }
        var originalStyle = globals.labelStyle;
        globals.labelStyle = "arrow";
        globals.model.updateFaceColors();
        captureScreenshot(filenameLabel, recordLabel, function () {
            globals.labelStyle = "circle";
            globals.model.updateFaceColors();
            captureScreenshot(filenameLabel + "_dot", null, function () {
                globals.labelStyle = originalStyle;
                globals.model.updateFaceColors();
                if (callback) callback();
            });
        });
    }

    // ── Interpolate POV between keyframes (fold % → POV) ──
    // povKeyframes: [{ fold: 0, pov: "iso" }, { fold: 50, pov: "z" }, ...]
    function getInterpolatedPOV(povKeyframes, foldPct) {
        if (!povKeyframes || povKeyframes.length === 0) return null;
        if (povKeyframes.length === 1) return getPOVDirection(povKeyframes[0].pov);
        // find segment
        var i = 0;
        while (i < povKeyframes.length - 1 && povKeyframes[i + 1].fold <= foldPct) i++;
        var a = povKeyframes[i];
        var b = povKeyframes[i + 1];
        if (!b) return getPOVDirection(a.pov);
        var t = (foldPct - a.fold) / (b.fold - a.fold);
        t = Math.max(0, Math.min(1, t));
        var dirA = getPOVDirection(a.pov);
        var dirB = getPOVDirection(b.pov);
        if (!dirA || !dirB) return dirA || dirB;
        var dir = dirA.clone().lerp(dirB, t);
        if (dir.lengthSq() < 0.0001) dir.copy(dirB);
        return dir.normalize();
    }

    // ── Preview rotation (standalone): rotate view of model at fixed fold, no folding ──

    function runPreviewRotation(opts, foldAt, trackModel, fitAllPoints, callback) {
        opts = opts || {};
        var hasOwn = Object.prototype.hasOwnProperty;
        var useTrackModel = hasOwn.call(opts, "trackModel") ? opts.trackModel === true : trackModel === true;
        var useFitAllPoints;
        if (hasOwn.call(opts, "fitAllPoints")) {
            useFitAllPoints = opts.fitAllPoints === true;
        } else if (hasOwn.call(opts, "povFitAllPoints")) {
            useFitAllPoints = opts.povFitAllPoints === true;
        } else {
            useFitAllPoints = fitAllPoints === true;
        }

        var fold = opts.fold !== undefined && opts.fold !== null ? opts.fold : foldAt;
        globals.setCreasePercent((fold != null ? fold : 0) / 100);
        globals.shouldChangeCreasePercent = true;
        // Apply fold state before pausing; solver only processes shouldChangeCreasePercent in step()
        globals.model.step();
        globals.threeView.pauseSimulation();

        var duration = opts.duration != null ? opts.duration : 2;
        var pk = opts.povKeyframes || opts.keyframes || opts.pov;
        var raw = [];
        if (Array.isArray(pk)) {
            raw = pk;
        } else if (pk && typeof pk === "string") {
            raw = [{ progress: 0, pov: pk }, { progress: 100, pov: pk }];
        } else {
            raw = [{ progress: 0, pov: "iso" }, { progress: 33, pov: "z" }, { progress: 66, pov: "-z" }, { progress: 100, pov: "iso" }];
        }
        var keyframes = raw.map(function (kf) {
            var v = kf.progress !== undefined ? kf.progress : (kf.fold !== undefined ? kf.fold : 0);
            return { fold: v, pov: kf.pov };
        });

        var start = performance.now();
        if (keyframes.length > 0) {
            var initialDir = getInterpolatedPOV(keyframes, 0);
            if (initialDir) {
                if (useTrackModel) {
                    globals.threeView.setCameraFixedForTracking();
                    globals.threeView.setModelRotationForPOV(initialDir);
                } else {
                    globals.threeView.setCameraToPosition(initialDir, useFitAllPoints);
                }
            }
        }

        function prevTick(t) {
            var elapsed = (t - start) / 1000;
            if (elapsed >= duration) {
                var finalDir = keyframes.length > 0 ? getInterpolatedPOV(keyframes, 100) : null;
                if (finalDir) {
                    if (useTrackModel) globals.threeView.setModelRotationForPOV(finalDir);
                    else globals.threeView.setCameraToPosition(finalDir, useFitAllPoints);
                }
                var finalRot = getInterpolatedRotation(keyframes, 100);
                if (finalRot) globals.threeView.setModelRotation(finalRot.x, finalRot.y, finalRot.z);
                globals.threeView.startSimulation();
                updateStatus("Preview complete.");
                if (callback) callback();
                return;
            }
            var progress = 100 * (elapsed / duration);
            if (keyframes.length > 0) {
                var dir = getInterpolatedPOV(keyframes, progress);
                if (dir) {
                    if (useTrackModel) globals.threeView.setModelRotationForPOV(dir);
                    else globals.threeView.setCameraToPosition(dir, useFitAllPoints);
                }
            }
            var prevRot = getInterpolatedRotation(keyframes, progress);
            if (prevRot) globals.threeView.setModelRotation(prevRot.x, prevRot.y, prevRot.z);
            updateStatus("Preview: rotating view (" + Math.round(progress) + "%)");
            requestAnimationFrame(prevTick);
        }
        updateStatus("Preview: rotating to show shape (" + duration + "s)");
        requestAnimationFrame(prevTick);
    }

    // ── Fold animation (0→90 over 4s etc) with optional smooth POV transition ──

    function runFoldAnimation(opts, callback) {
        var from = opts.from != null ? opts.from : 0;
        var to = opts.to != null ? opts.to : 90;
        var durationSec = opts.duration != null ? opts.duration : 4;
        var povKeyframes = opts.povKeyframes || opts.pov; // povKeyframes: [{fold, pov}, ...] or single "iso"
        var fitAllPoints = opts.fitAllPoints === true || opts.povFitAllPoints === true;
        var trackModel = opts.trackModel === true; // rotate model, camera fixed — always all points in view
        var hidePoints = opts.hidePointsDuringAnimation === true;

        globals.setCreasePercent(from / 100);
        globals.shouldChangeCreasePercent = true;

        // normalize povKeyframes: allow single string or array of {fold, pov}
        var keyframes = [];
        if (Array.isArray(povKeyframes)) {
            keyframes = povKeyframes;
        } else if (povKeyframes && typeof povKeyframes === "string") {
            keyframes = [{ fold: from, pov: povKeyframes }, { fold: to, pov: povKeyframes }];
        }

        var startTime;
        if (hidePoints) globals.hideFacePointsDuringAnimation = true;

        function startFoldAnimation() {
            startTime = performance.now();
            updateStatus("Fold animation: " + from + "% → " + to + "% over " + durationSec + "s");
            requestAnimationFrame(tick);
        }

        function tick(t) {
            var elapsed = (t - startTime) / 1000;
            if (elapsed >= durationSec) {
                globals.setCreasePercent(to / 100);
                globals.shouldChangeCreasePercent = true;
                if (keyframes.length > 0) {
                    var finalDir = getInterpolatedPOV(keyframes, to);
                    if (finalDir) {
                        if (trackModel) globals.threeView.setModelRotationForPOV(finalDir);
                        else globals.threeView.setCameraToPosition(finalDir, fitAllPoints);
                    }
                }
                if (hidePoints) globals.hideFacePointsDuringAnimation = false;
                globals.revealHiddenPoints = true;
                // apply final rotation interpolation
                var finalRot = getInterpolatedRotation(keyframes, to);
                if (finalRot) globals.threeView.setModelRotation(finalRot.x, finalRot.y, finalRot.z);
                globals.model.updateFaceColors();
                updateStatus("Fold animation complete (0→" + to + "%).");
                if (callback) callback();
                return;
            }
            var tNorm = elapsed / durationSec;
            var pct = from + (to - from) * tNorm;
            globals.setCreasePercent(pct / 100);
            globals.shouldChangeCreasePercent = true;
            if (keyframes.length > 0) {
                var dir = getInterpolatedPOV(keyframes, pct);
                if (dir) {
                    if (trackModel) globals.threeView.setModelRotationForPOV(dir);
                    else globals.threeView.setCameraToPosition(dir, fitAllPoints);
                }
            }
            // apply interpolated rotation from keyframes
            var interpRot = getInterpolatedRotation(keyframes, pct);
            if (interpRot) globals.threeView.setModelRotation(interpRot.x, interpRot.y, interpRot.z);
            updateStatus("Fold animation: " + Math.round(pct) + "% (" + Math.round(elapsed * 10) / 10 + "s / " + durationSec + "s)");
            requestAnimationFrame(tick);
        }
        startFoldAnimation();
    }

    // ── Step runner ──

    function runStep(steps, index, pauseSec, autoCapture, hidePointsDuringAnimation, labelStyleMode, onComplete) {
        if (index >= steps.length) {
            globals.hideFacePointsDuringAnimation = false;
            running = false;
            updateStatus("Benchmark complete (" + steps.length + " steps).");
            console.log("benchmark: sequence complete");
            saveBenchmarkSummary(currentBenchmarkName || globals.filename || "benchmark");
            if (onComplete) onComplete();
            return;
        }

        running = true;
        currentStep = index;
        var step = steps[index];

        updateStatus("Step " + (index + 1) + "/" + steps.length +
                     " — fold " + step.fold + "%" +
                     (step.pov ? ", POV " + step.pov : ""));

        var isBoundaryStep = (index === 0 || index === steps.length - 1);
        globals.hideFacePointsDuringAnimation = hidePointsDuringAnimation === true && !isBoundaryStep;

        // reveal hidden points only on the last step
        globals.revealHiddenPoints = (index === steps.length - 1);

        // set fold percent
        globals.setCreasePercent(step.fold / 100);
        globals.shouldChangeCreasePercent = true;

        // set camera
        setPOV(step.pov);

        // apply model rotation per-step; if omitted, keep this step unrotated
        if (step.rotation !== undefined && step.rotation !== null) {
            applyRotation(step.rotation);
        } else {
            globals.threeView.resetModel();
        }

        // wait for simulation to settle, then optionally capture
        var settleMs = Math.max(pauseSec * 1000, 500);
            setTimeout(function () {
            if (autoCapture) {
                var isFinalStep = index === steps.length - 1;
                var done = function () {
                    // small delay after capture before next step
                    setTimeout(function () {
                        runStep(steps, index + 1, pauseSec, autoCapture, hidePointsDuringAnimation, labelStyleMode, onComplete);
                    }, 300);
                };
                if (isFinalStep) {
                    captureFinalWithBothStyles(stepFilename(index), stepLabel(step.fold, step.pov), labelStyleMode, done);
                } else {
                    captureScreenshot(stepFilename(index), stepLabel(step.fold, step.pov), done);
                }
            } else {
                runStep(steps, index + 1, pauseSec, autoCapture, hidePointsDuringAnimation, labelStyleMode, onComplete);
            }
        }, settleMs);
    }

    // ── Status UI ──

    function updateStatus(msg) {
        var $el = $("#benchmarkStatus");
        if ($el.length) $el.html(msg);
        console.log("benchmark: " + msg);
    }

    // ── Build config from URL params + optional JSON preset ──

    function buildConfig(presets) {
        var benchmarkName = getParam("benchmark");
        var cfg = {};

        // start from JSON preset if specified
        if (benchmarkName && presets && presets[benchmarkName]) {
            cfg = $.extend(true, {}, presets[benchmarkName]);
        }

        // URL overrides
        var model = getParam("model");
        if (model) cfg.model = model;

        var colorMode = getParam("colorMode");
        if (colorMode) cfg.colorMode = colorMode;

        var backgroundColor = getParam("backgroundColor");
        if (backgroundColor !== null && backgroundColor !== undefined) cfg.backgroundColor = backgroundColor.replace(/^#/, "");

        var color1 = getParam("color1");
        if (color1 !== null && color1 !== undefined) cfg.color1 = color1.replace(/^#/, "");
        var color2 = getParam("color2");
        if (color2 !== null && color2 !== undefined) cfg.color2 = color2.replace(/^#/, "");

        var labelStyle = getParam("labelStyle");
        if (labelStyle) cfg.labelStyle = labelStyle;

        var pointA = getParamInt("pointA");
        if (pointA !== null) cfg.pointA = pointA;

        var pointB = getParamInt("pointB");
        if (pointB !== null) cfg.pointB = pointB;

        var facePointsConfig = getParam("facePoints");
        if (facePointsConfig) {
            try {
                cfg.facePoints = JSON.parse(facePointsConfig);
            } catch (e) {
                var parsed = {};
                facePointsConfig.split(",").forEach(function(pair) {
                    var m = pair.match(/^\s*(\d+)\s*:\s*(\d+)\s*$/);
                    if (m) parsed[m[1]] = parseInt(m[2], 10);
                });
                if (Object.keys(parsed).length) cfg.facePoints = parsed;
            }
        }

        var foldParam = getParamFloat("fold");
        if (foldParam !== null) cfg.fold = foldParam;

        var pauseDuration = getParamFloat("pauseDuration");
        if (pauseDuration !== null) cfg.pauseDuration = pauseDuration;

        if (getParam("autoCapture") !== null) cfg.autoCapture = getParamBool("autoCapture");
        if (getParam("autoRun") !== null) cfg.autoRun = getParamBool("autoRun");
        if (getParam("showPointNumbers") !== null) cfg.showPointNumbers = getParamBool("showPointNumbers");
        if (getParam("hidePointsDuringAnimation") !== null) cfg.hidePointsDuringAnimation = getParamBool("hidePointsDuringAnimation");
        if (getParam("useScanCache") !== null) cfg.useScanCache = getParamBool("useScanCache");
        if (getParam("forceRescan") !== null) cfg.forceRescan = getParamBool("forceRescan");

        var targetPointLabels = getParam("targetPointLabels");
        if (targetPointLabels) cfg.targetPointLabels = targetPointLabels;
        var targetPointIndices = getParam("targetPointIndices");
        if (targetPointIndices) cfg.targetPointIndices = targetPointIndices;
        var primaryTargetPointLabels = getParam("primaryTargetPointLabels");
        if (primaryTargetPointLabels) cfg.primaryTargetPointLabels = primaryTargetPointLabels;
        var primaryTargetPointIndices = getParam("primaryTargetPointIndices");
        if (primaryTargetPointIndices) cfg.primaryTargetPointIndices = primaryTargetPointIndices;
        var minPointSeparationPx = getParamFloat("minPointSeparationPx");
        if (minPointSeparationPx !== null) cfg.minPointSeparationPx = minPointSeparationPx;
        var minProgressionEndAngle = getParamFloat("minProgressionEndAngle");
        if (minProgressionEndAngle !== null) cfg.minProgressionEndAngle = minProgressionEndAngle;
        var minProgressionTotalAngle = getParamFloat("minProgressionTotalAngle");
        if (minProgressionTotalAngle !== null) cfg.minProgressionTotalAngle = minProgressionTotalAngle;
        var minProgressionPairDistance = getParamFloat("minProgressionPairDistance");
        if (minProgressionPairDistance !== null) cfg.minProgressionPairDistance = minProgressionPairDistance;
        var rotationYawMax = getParamFloat("rotationYawMax");
        if (rotationYawMax !== null) cfg.rotationYawMax = rotationYawMax;
        var rotationPitchMax = getParamFloat("rotationPitchMax");
        if (rotationPitchMax !== null) cfg.rotationPitchMax = rotationPitchMax;
        var rotationRollMax = getParamFloat("rotationRollMax");
        if (rotationRollMax !== null) cfg.rotationRollMax = rotationRollMax;
        var rotationProfileCount = getParamInt("rotationProfileCount");
        if (rotationProfileCount !== null) cfg.rotationProfileCount = rotationProfileCount;

        // fold animation: 0→90 over 4s (preset or URL)
        var foldAnimFrom = getParamFloat("foldAnimFrom");
        var foldAnimTo = getParamFloat("foldAnimTo");
        var foldAnimDuration = getParamFloat("foldAnimDuration");
        if (foldAnimFrom !== null || foldAnimTo !== null || foldAnimDuration !== null || getParam("foldAnimation") === "true") {
            cfg.foldAnimation = cfg.foldAnimation || {};
            if (foldAnimFrom !== null) cfg.foldAnimation.from = foldAnimFrom;
            if (foldAnimTo !== null) cfg.foldAnimation.to = foldAnimTo;
            if (foldAnimDuration !== null) cfg.foldAnimation.duration = foldAnimDuration;
            if (getParam("fitAllPoints") !== null) cfg.foldAnimation.fitAllPoints = getParamBool("fitAllPoints");
            if (getParam("trackModel") !== null) cfg.foldAnimation.trackModel = getParamBool("trackModel");
            if (getParam("hidePointsDuringAnimation") !== null) cfg.foldAnimation.hidePointsDuringAnimation = getParamBool("hidePointsDuringAnimation");
            var delayParam = getParamFloat("foldAnimDelay");
            if (delayParam !== null) cfg.foldAnimation.delay = delayParam;
            var delayAfterPreviewParam = getParamFloat("delayAfterPreview");
            if (delayAfterPreviewParam !== null) cfg.foldAnimation.delayAfterPreview = delayAfterPreviewParam;
            if (Object.keys(cfg.foldAnimation).length === 0 && getParam("foldAnimation") === "true") {
                cfg.foldAnimation = { from: 0, to: 90, duration: 4 };
            }
        }

        // ad-hoc steps from foldStart/foldMid/foldEnd
        var foldStart = getParamFloat("foldStart");
        var foldMid = getParamFloat("foldMid");
        var foldEnd = getParamFloat("foldEnd");
        if (foldStart !== null || foldMid !== null || foldEnd !== null) {
            cfg.steps = [];
            if (foldStart !== null) cfg.steps.push({ fold: foldStart, pov: getParam("povStart") || "iso" });
            if (foldMid !== null)   cfg.steps.push({ fold: foldMid,   pov: getParam("povMid") || "iso" });
            if (foldEnd !== null)   cfg.steps.push({ fold: foldEnd,   pov: getParam("povEnd") || "iso" });
        }

        // must have at least model or steps to be a valid benchmark
        if (!cfg.model && !cfg.steps) return null;

        // defaults
        if (!cfg.pauseDuration) cfg.pauseDuration = 2;
        if (!cfg.steps) cfg.steps = [{ fold: 0, pov: "iso" }];

        if (getParamBool("previewRotation") && !cfg.previewRotation) {
            cfg.previewRotation = { duration: 2 };
        }

        return cfg;
    }

    // ── POV grid generation (Fibonacci sphere on upper hemisphere) ──

    function generatePovGrid(count) {
        // Fibonacci sphere sampling, filtered to y >= -0.3.
        // count controls total sphere points before filtering; all passing points are kept.
        var goldenAngle = Math.PI * (3 - Math.sqrt(5));
        var candidates = [];
        for (var i = 0; i < count; i++) {
            var y = 1 - (2 * i / (count - 1));
            if (y < -0.3) continue;
            var radius = Math.sqrt(1 - y * y);
            var theta = goldenAngle * i;
            var x = Math.cos(theta) * radius;
            var z = Math.sin(theta) * radius;
            candidates.push([
                Math.round(x * 100) / 100,
                Math.round(y * 100) / 100,
                Math.round(z * 100) / 100
            ]);
        }
        return candidates;
    }

    // ── Diverse progression builder ──
    // Given scan results, builds N diverse smooth POV progressions where
    // all targetFaces have quality >= minQuality at every fold step.

    // Generate candidate trajectory POV lists from grid scan data.
    // Returns array of trajectories, each is array of { fold, pov } steps.
    // These are NOT validated — they need live evaluation in phase 2.
    function generateCandidateTrajectories(scanStates, foldSteps, count) {
        var isoVec = [1, 1, 1];
        function normalize(v) {
            var mag = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
            return mag > 0 ? [v[0]/mag, v[1]/mag, v[2]/mag] : [0, 1, 0];
        }
        function lerp3(a, b, t) {
            return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];
        }
        function round2(v) {
            return [Math.round(v[0]*100)/100, Math.round(v[1]*100)/100, Math.round(v[2]*100)/100];
        }
        function angularDist(a, b) {
            var dot = a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
            var mA = Math.sqrt(a[0]*a[0]+a[1]*a[1]+a[2]*a[2]);
            var mB = Math.sqrt(b[0]*b[0]+b[1]*b[1]+b[2]*b[2]);
            if (mA === 0 || mB === 0) return Math.PI;
            return Math.acos(Math.max(-1, Math.min(1, dot/(mA*mB))));
        }

        // Collect all unique continuous POVs scanned at the last fold step as potential endpoints
        var lastFold = foldSteps[foldSteps.length - 1];
        var endpoints = [];
        var seen = {};
        for (var si = 0; si < scanStates.length; si++) {
            var st = scanStates[si];
            if (st.fold !== lastFold || !Array.isArray(st.pov)) continue;
            var k = st.pov.join(",");
            if (!seen[k]) { seen[k] = true; endpoints.push(st.pov); }
        }

        // t-curves: control how fast camera moves from iso toward endpoint
        var tCurves = [
            function (fi, n) { return fi === 0 ? 0 : 1; },                              // immediate
            function (fi, n) { return fi / (n - 1); },                                   // linear
            function (fi, n) { var r = fi/(n-1); return r * r; },                         // slow start
            function (fi, n) { var r = fi/(n-1); return 1 - (1-r)*(1-r); },              // quick start
            function (fi, n) { return fi <= 1 ? 0 : (fi - 1) / (n - 2); }               // hold then go
        ];

        var nIso = normalize(isoVec);
        var trajectories = [];

        // Sort endpoints for diversity: greedy farthest-first from iso
        var sorted = endpoints.slice().sort(function (a, b) {
            return angularDist(b, nIso) - angularDist(a, nIso);
        });

        for (var ei = 0; ei < sorted.length; ei++) {
            var ep = sorted[ei];

            // Skip endpoints too close to already-used ones (0.15 rad ≈ 8.6°)
            var tooClose = false;
            for (var ui = 0; ui < trajectories.length; ui++) {
                var lastStep = trajectories[ui][trajectories[ui].length - 1];
                if (Array.isArray(lastStep.pov) && angularDist(ep, lastStep.pov) < 0.15) {
                    tooClose = true; break;
                }
            }
            if (tooClose) continue;

            for (var ci = 0; ci < tCurves.length; ci++) {
                var steps = [{ fold: foldSteps[0], pov: "iso" }];
                for (var fi = 1; fi < foldSteps.length; fi++) {
                    var t = tCurves[ci](fi, foldSteps.length);
                    steps.push({ fold: foldSteps[fi], pov: round2(lerp3(nIso, ep, t)) });
                }
                trajectories.push(steps);
            }
        }

        // Also add trajectories using ALL endpoints (no distance filter) if we don't have enough
        if (trajectories.length < count * 3) {
            for (var ei2 = 0; ei2 < sorted.length; ei2++) {
                var ep2 = sorted[ei2];
                for (var ci2 = 0; ci2 < tCurves.length; ci2++) {
                    var steps2 = [{ fold: foldSteps[0], pov: "iso" }];
                    for (var fi2 = 1; fi2 < foldSteps.length; fi2++) {
                        var t2 = tCurves[ci2](fi2, foldSteps.length);
                        steps2.push({ fold: foldSteps[fi2], pov: round2(lerp3(nIso, ep2, t2)) });
                    }
                    // Dedup
                    var isDupe = false;
                    for (var di = 0; di < trajectories.length; di++) {
                        var same = true;
                        for (var ds = 1; ds < steps2.length; ds++) {
                            var a = steps2[ds].pov, b = trajectories[di][ds].pov;
                            if (Array.isArray(a) && Array.isArray(b)) {
                                if (a[0]!==b[0]||a[1]!==b[1]||a[2]!==b[2]) { same=false; break; }
                            }
                        }
                        if (same) { isDupe = true; break; }
                    }
                    if (!isDupe) trajectories.push(steps2);
                }
            }
        }

        console.log("generateCandidateTrajectories: " + endpoints.length + " endpoints → " + trajectories.length + " candidates");
        return trajectories;
    }

    function pointLabelToIndex(label) {
        if (label === undefined || label === null) return null;
        var s = String(label).trim().toUpperCase();
        if (!s || s.length !== 1) return null;
        var code = s.charCodeAt(0);
        if (code < 65 || code > 90) return null;
        return code - 65;
    }

    function parseIndexList(list) {
        if (!list) return [];
        var arr = Array.isArray(list) ? list : String(list).split(",");
        var out = [];
        for (var i = 0; i < arr.length; i++) {
            var v = parseInt(arr[i], 10);
            if (!isNaN(v) && out.indexOf(v) === -1) out.push(v);
        }
        return out;
    }

    function parseLabelList(list) {
        if (!list) return [];
        var arr = Array.isArray(list) ? list : String(list).split(",");
        var out = [];
        for (var i = 0; i < arr.length; i++) {
            var idx = pointLabelToIndex(arr[i]);
            if (idx !== null && out.indexOf(idx) === -1) out.push(idx);
        }
        return out;
    }

    function getTargetPointIndicesForCfg(cfg) {
        var byIndex = parseIndexList(cfg && cfg.targetPointIndices);
        var byLabel = parseLabelList(cfg && cfg.targetPointLabels);
        var merged = byIndex.slice();
        for (var i = 0; i < byLabel.length; i++) {
            if (merged.indexOf(byLabel[i]) === -1) merged.push(byLabel[i]);
        }
        return merged;
    }

    function getPrimaryTargetPointIndicesForCfg(cfg) {
        var byPrimaryIndex = parseIndexList(cfg && cfg.primaryTargetPointIndices);
        var byPrimaryLabel = parseLabelList(cfg && cfg.primaryTargetPointLabels);
        var merged = byPrimaryIndex.slice();
        for (var i = 0; i < byPrimaryLabel.length; i++) {
            if (merged.indexOf(byPrimaryLabel[i]) === -1) merged.push(byPrimaryLabel[i]);
        }
        if (merged.length > 0) return merged;
        return getTargetPointIndicesForCfg(cfg);
    }

    function angularDistanceBetweenDirs(a, b) {
        if (!a || !b) return 0;
        var dot = a.x * b.x + a.y * b.y + a.z * b.z;
        dot = Math.max(-1, Math.min(1, dot));
        return Math.acos(dot);
    }

    function getPovDirectionForStep(step) {
        if (!step || step.pov === undefined || step.pov === null) return null;
        var dir = getPOVDirection(step.pov);
        if (!dir) return null;
        return dir.normalize();
    }

    function getProgressionMotionMetrics(steps) {
        if (!steps || steps.length < 2) return { endAngle: 0, totalAngle: 0 };
        var first = getPovDirectionForStep(steps[0]);
        var last = getPovDirectionForStep(steps[steps.length - 1]);
        var endAngle = angularDistanceBetweenDirs(first, last);
        var totalAngle = 0;
        for (var i = 1; i < steps.length; i++) {
            totalAngle += angularDistanceBetweenDirs(getPovDirectionForStep(steps[i - 1]), getPovDirectionForStep(steps[i]));
        }
        return { endAngle: endAngle, totalAngle: totalAngle };
    }

    function progressionDistance(aSteps, bSteps) {
        if (!aSteps || !bSteps || aSteps.length === 0 || bSteps.length === 0) return 0;
        var len = Math.min(aSteps.length, bSteps.length);
        var total = 0;
        var count = 0;
        for (var i = 0; i < len; i++) {
            total += angularDistanceBetweenDirs(getPovDirectionForStep(aSteps[i]), getPovDirectionForStep(bSteps[i]));
            count++;
        }
        return count > 0 ? total / count : 0;
    }

    function selectDiverseProgressions(candidates, maxCount, minPairDistance) {
        if (!candidates || candidates.length === 0) return [];
        var sorted = candidates.slice().sort(function (a, b) {
            return (b.score || 0) - (a.score || 0);
        });

        var selected = [];
        for (var i = 0; i < sorted.length; i++) {
            if (selected.length >= maxCount) break;
            var keep = true;
            for (var s = 0; s < selected.length; s++) {
                if (progressionDistance(sorted[i].steps, selected[s].steps) < minPairDistance) {
                    keep = false;
                    break;
                }
            }
            if (keep) selected.push(sorted[i]);
        }

        for (var j = 0; selected.length < maxCount && j < sorted.length; j++) {
            if (selected.indexOf(sorted[j]) === -1) selected.push(sorted[j]);
        }

        return selected.slice(0, maxCount).map(function (p) {
            return {
                steps: p.steps,
                consistentFaces: p.consistentFaces,
                score: p.score,
                metrics: p.metrics
            };
        });
    }

    function stableStringify(value) {
        if (value === null || value === undefined) return String(value);
        if (Array.isArray(value)) {
            var arr = [];
            for (var i = 0; i < value.length; i++) arr.push(stableStringify(value[i]));
            return "[" + arr.join(",") + "]";
        }
        if (typeof value === "object") {
            var keys = Object.keys(value).sort();
            var parts = [];
            for (var k = 0; k < keys.length; k++) {
                var key = keys[k];
                parts.push(JSON.stringify(key) + ":" + stableStringify(value[key]));
            }
            return "{" + parts.join(",") + "}";
        }
        return JSON.stringify(value);
    }

    function hashString(input) {
        var h = 5381;
        for (var i = 0; i < input.length; i++) {
            h = ((h << 5) + h) + input.charCodeAt(i);
            h = h & 0xffffffff;
        }
        var unsigned = h >>> 0;
        return unsigned.toString(16);
    }

    function buildScanCacheKey(cfg, foldSteps) {
        var payload = {
            version: 2,
            model: cfg.model || "",
            facePoints: cfg.facePoints || null,
            scanFoldSteps: foldSteps,
            scanPovs: cfg.scanPovs || null,
            povGridSize: cfg.povGridSize || null,
            minFaceQuality: cfg.minFaceQuality != null ? cfg.minFaceQuality : 0.6,
            buildProgressions: cfg.buildProgressions || 0,
            targetFaces: cfg.targetFaces || [],
            targetPointLabels: cfg.targetPointLabels || null,
            targetPointIndices: cfg.targetPointIndices || null,
            primaryTargetPointLabels: cfg.primaryTargetPointLabels || null,
            primaryTargetPointIndices: cfg.primaryTargetPointIndices || null,
            minPointSeparationPx: cfg.minPointSeparationPx != null ? cfg.minPointSeparationPx : 70,
            minProgressionEndAngle: cfg.minProgressionEndAngle != null ? cfg.minProgressionEndAngle : 0.85,
            minProgressionTotalAngle: cfg.minProgressionTotalAngle != null ? cfg.minProgressionTotalAngle : 1.75,
            minProgressionPairDistance: cfg.minProgressionPairDistance != null ? cfg.minProgressionPairDistance : 0.22,
            rotationYawMax: cfg.rotationYawMax != null ? cfg.rotationYawMax : 1.5,
            rotationPitchMax: cfg.rotationPitchMax != null ? cfg.rotationPitchMax : 0.35,
            rotationRollMax: cfg.rotationRollMax != null ? cfg.rotationRollMax : 0.18,
            rotationProfileCount: cfg.rotationProfileCount != null ? cfg.rotationProfileCount : 6,
            rotationProfiles: cfg.rotationProfiles || null
        };
        return "scan_" + hashString(stableStringify(payload));
    }

    function loadScanCache(cacheKey, callback) {
        var done = false;
        var timer = setTimeout(function () {
            if (done) return;
            done = true;
            callback(null);
        }, 2500);

        fetch("/api/scan-cache?key=" + encodeURIComponent(cacheKey), { method: "GET" })
            .then(function (res) {
                if (!res.ok) throw new Error("cache miss");
                return res.json();
            })
            .then(function (data) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                callback(data || null);
            })
            .catch(function () {
                if (done) return;
                done = true;
                clearTimeout(timer);
                callback(null);
            });
    }

    function saveScanCache(cacheKey, data) {
        fetch("/api/scan-cache?key=" + encodeURIComponent(cacheKey), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
        }).catch(function () {
            console.warn("benchmark: could not save scan cache");
        });
    }

    function buildAutoRotationProfiles(templateSteps, cfg) {
        var stepCount = templateSteps ? templateSteps.length : 0;
        if (stepCount === 0) return [{ name: "none", rotations: [] }];

        if (cfg && Array.isArray(cfg.rotationProfiles) && cfg.rotationProfiles.length > 0) {
            var parsedProfiles = [];
            for (var pi = 0; pi < cfg.rotationProfiles.length; pi++) {
                var raw = cfg.rotationProfiles[pi];
                if (!Array.isArray(raw) || raw.length !== stepCount) continue;
                var rots = [];
                var valid = true;
                for (var si = 0; si < raw.length; si++) {
                    var r = parseRotation(raw[si]);
                    if (!r) { valid = false; break; }
                    rots.push({ x: r.x, y: r.y, z: r.z });
                }
                if (valid) parsedProfiles.push({ name: "custom-" + (parsedProfiles.length + 1), rotations: rots });
            }
            if (parsedProfiles.length > 0) return parsedProfiles;
        }

        var yawMax = cfg && cfg.rotationYawMax != null ? cfg.rotationYawMax : 1.5;
        var pitchMax = cfg && cfg.rotationPitchMax != null ? cfg.rotationPitchMax : 0.35;
        var rollMax = cfg && cfg.rotationRollMax != null ? cfg.rotationRollMax : 0.18;
        var requested = cfg && cfg.rotationProfileCount != null ? cfg.rotationProfileCount : 6;
        var templates = [
            { name: "cw-soft", sign: 1, amp: 0.75 },
            { name: "cw-med", sign: 1, amp: 1.0 },
            { name: "cw-strong", sign: 1, amp: 1.2 },
            { name: "ccw-soft", sign: -1, amp: 0.75 },
            { name: "ccw-med", sign: -1, amp: 1.0 },
            { name: "ccw-strong", sign: -1, amp: 1.2 }
        ];
        var count = Math.max(1, Math.min(requested, templates.length));
        var profiles = [];
        for (var ti = 0; ti < count; ti++) {
            var tplt = templates[ti];
            var rots = [];
            for (var si2 = 0; si2 < stepCount; si2++) {
                var t = stepCount <= 1 ? 1 : (si2 / (stepCount - 1));
                var yaw = tplt.sign * yawMax * tplt.amp * t;
                var pitch = pitchMax * 4 * t * (1 - t);
                var roll = tplt.sign * rollMax * Math.sin(t * Math.PI);
                rots.push({
                    x: Math.round(pitch * 1000) / 1000,
                    y: Math.round(yaw * 1000) / 1000,
                    z: Math.round(roll * 1000) / 1000
                });
            }
            profiles.push({ name: tplt.name, rotations: rots });
        }
        return profiles;
    }

    function getPointScreenPosition(index) {
        if (!globals.facePoints || !globals.facePoints.getPointPosition) return null;
        var posLocal = globals.facePoints.getPointPosition(index);
        if (!posLocal) return null;
        if (!globals.threeView || !globals.threeView.camera || !globals.threeView.renderer || !globals.threeView.modelWrapper) return null;

        globals.threeView.modelWrapper.updateMatrixWorld(true);
        var posWorld = posLocal.clone().applyMatrix4(globals.threeView.modelWrapper.matrixWorld);
        var p = posWorld.clone().project(globals.threeView.camera);
        if (p.z < -1 || p.z > 1) return null;

        var canvas = globals.threeView.renderer.domElement;
        var w = canvas.width || Math.max(1, Math.floor(window.innerWidth * (window.devicePixelRatio || 1)));
        var h = canvas.height || Math.max(1, Math.floor(window.innerHeight * (window.devicePixelRatio || 1)));
        return {
            x: (p.x * 0.5 + 0.5) * w,
            y: (-p.y * 0.5 + 0.5) * h
        };
    }

    function evaluateTrackedPoints(targetPointIndices, stepIndex, totalSteps, minPointSeparation) {
        if (!targetPointIndices || targetPointIndices.length === 0) {
            return { ok: true, requiredCount: 0, visibleCount: 0, minSep: Infinity };
        }

        var required = [];
        for (var i = 0; i < targetPointIndices.length; i++) {
            var idx = targetPointIndices[i];
            var hidden = globals.facePoints && globals.facePoints.isPointHidden ? globals.facePoints.isPointHidden(idx) : false;
            if (!hidden || stepIndex === totalSteps - 1) required.push(idx);
        }

        var visibleScreens = [];
        for (var ri = 0; ri < required.length; ri++) {
            var rIdx = required[ri];
            if (!(globals.facePoints && globals.facePoints.isPointVisible && globals.facePoints.isPointVisible(rIdx))) {
                return { ok: false, requiredCount: required.length, visibleCount: visibleScreens.length, minSep: 0 };
            }
            var screen = getPointScreenPosition(rIdx);
            if (!screen) {
                return { ok: false, requiredCount: required.length, visibleCount: visibleScreens.length, minSep: 0 };
            }
            visibleScreens.push(screen);
        }

        var minSep = Infinity;
        for (var a = 0; a < visibleScreens.length; a++) {
            for (var b = a + 1; b < visibleScreens.length; b++) {
                var dx = visibleScreens[a].x - visibleScreens[b].x;
                var dy = visibleScreens[a].y - visibleScreens[b].y;
                var d = Math.sqrt(dx * dx + dy * dy);
                if (d < minSep) minSep = d;
            }
        }

        if (stepIndex === totalSteps - 1 && visibleScreens.length >= 2 && minSep < minPointSeparation) {
            return { ok: false, requiredCount: required.length, visibleCount: visibleScreens.length, minSep: minSep };
        }
        return { ok: true, requiredCount: required.length, visibleCount: visibleScreens.length, minSep: minSep };
    }

    // ── Phase 2: live trajectory evaluation ──
    // Sets camera to each interpolated POV, measures actual face quality via getFaceViewQualities.
    // Keeps trajectories where all targetFaces stay >= minQuality at every step.

    function evaluateTrajectoriesLive(candidates, targetFaces, minQuality, maxCount, settleMs, cfg, callback) {
        var validProgressions = [];
        var targetPointIndices = getTargetPointIndicesForCfg(cfg || {});
        var primaryTargetPointIndices = getPrimaryTargetPointIndicesForCfg(cfg || {});
        var minPointSeparation = (cfg && cfg.minPointSeparationPx != null) ? cfg.minPointSeparationPx : 70;
        var minProgressionEndAngle = (cfg && cfg.minProgressionEndAngle != null) ? cfg.minProgressionEndAngle : 0.85;
        var minProgressionTotalAngle = (cfg && cfg.minProgressionTotalAngle != null) ? cfg.minProgressionTotalAngle : 1.75;
        var minProgressionPairDistance = (cfg && cfg.minProgressionPairDistance != null) ? cfg.minProgressionPairDistance : 0.22;
        var rotationProfiles = buildAutoRotationProfiles(candidates[0] || [], cfg || {});
        var candidateCount = candidates.length;
        var profileCount = rotationProfiles.length;

        // Flatten all trajectory steps into a sequential evaluation queue.
        // We evaluate one trajectory at a time, step by step.
        var currentTraj = 0;
        var currentStep = 0;
        var currentProfile = 0;
        var currentFaceStats = {}; // fid -> { worst, seenSteps }

        function skipCurrentTrajectoryProfile() {
            currentProfile++;
            if (currentProfile >= profileCount) {
                currentProfile = 0;
                currentTraj++;
            }
            currentStep = 0;
            currentFaceStats = {};
        }

        function evaluateNext() {
            // Skip to next trajectory if current one has been fully evaluated or invalidated
            while (currentTraj < candidates.length && currentStep >= candidates[currentTraj].length) {
                // Trajectory fully evaluated — compute consistentFaces and accept
                var traj = candidates[currentTraj];
                var consistentFaces = {};
                var totalSteps = traj.length;
                for (var fid2 in currentFaceStats) {
                    if (!currentFaceStats.hasOwnProperty(fid2)) continue;
                    var stat = currentFaceStats[fid2];
                    if (stat.seenSteps === totalSteps && stat.worst >= 0.6) {
                        consistentFaces[fid2] = Math.round(stat.worst * 1000) / 1000;
                    }
                }

                var profile = rotationProfiles[Math.min(currentProfile, rotationProfiles.length - 1)] || { name: "none", rotations: [] };
                var cleanSteps = traj.map(function (s, i) {
                    var out = { fold: s.fold, pov: s.pov };
                    var r = profile.rotations && profile.rotations[i];
                    if (r) out.rotation = [r.x, r.y, r.z];
                    return out;
                });
                var metrics = getProgressionMotionMetrics(cleanSteps);
                var trackedStepBonus = primaryTargetPointIndices.length > 0 ? 0.2 : 0;
                var score = 0;
                score += Math.min(1, metrics.endAngle / Math.max(0.1, minProgressionEndAngle));
                score += Math.min(1, metrics.totalAngle / Math.max(0.1, minProgressionTotalAngle));
                score += Object.keys(consistentFaces).length * 0.02;
                score += trackedStepBonus;

                if (metrics.endAngle >= minProgressionEndAngle && metrics.totalAngle >= minProgressionTotalAngle) {
                    validProgressions.push({
                        steps: cleanSteps,
                        consistentFaces: consistentFaces,
                        score: Math.round(score * 1000) / 1000,
                        metrics: {
                            endAngle: Math.round(metrics.endAngle * 1000) / 1000,
                            totalAngle: Math.round(metrics.totalAngle * 1000) / 1000
                        }
                    });
                }

                skipCurrentTrajectoryProfile();
            }

            if (currentTraj >= candidates.length) {
                var selected = selectDiverseProgressions(validProgressions, maxCount, minProgressionPairDistance);
                console.log("evaluateTrajectoriesLive: " + validProgressions.length + " valid candidates out of " + candidates.length + ", selected " + selected.length);
                callback(selected);
                return;
            }

            var step = candidates[currentTraj][currentStep];
            var profileNow = rotationProfiles[Math.min(currentProfile, rotationProfiles.length - 1)] || { name: "none", rotations: [] };
            var stepRot = profileNow.rotations && profileNow.rotations[currentStep] ? profileNow.rotations[currentStep] : null;

            // Set fold and POV
            globals.setCreasePercent(step.fold / 100);
            globals.shouldChangeCreasePercent = true;
            setPOV(step.pov);
            if (stepRot) globals.threeView.setModelRotation(stepRot.x, stepRot.y, stepRot.z);
            else globals.threeView.resetModel();
            globals.model.step();

            var povLabel = Array.isArray(step.pov) ? "[" + step.pov.join(",") + "]" : step.pov;
            updateStatus("Phase 2: traj " + (currentTraj + 1) + "/" + candidateCount +
                         " profile " + (currentProfile + 1) + "/" + profileCount +
                         " (" + (profileNow.name || "rot") + ")" +
                         " step " + (currentStep + 1) + "/" + candidates[currentTraj].length +
                         " fold=" + step.fold + " pov=" + povLabel +
                         " (" + validProgressions.length + " valid so far)");

            setTimeout(function () {
                try {
                // Measure actual face quality at this POV
                var allVisibleFaceIds = globals.facePoints && globals.facePoints.getVisibleFaceIds
                    ? globals.facePoints.getVisibleFaceIds() : [];
                var faceQualities = globals.facePoints && globals.facePoints.getFaceViewQualities
                    ? globals.facePoints.getFaceViewQualities(allVisibleFaceIds) : {};

                // Check target faces pass quality threshold (skip fold=0, always passes)
                if (step.fold > 0) {
                    for (var ti = 0; ti < targetFaces.length; ti++) {
                        var q = faceQualities[targetFaces[ti]] || 0;
                        if (q < minQuality) {
                            // Trajectory fails — skip to next
                            skipCurrentTrajectoryProfile();
                            evaluateNext();
                            return;
                        }
                    }
                }

                var trackedEval = evaluateTrackedPoints(targetPointIndices, currentStep, candidates[currentTraj].length, minPointSeparation);
                if (!trackedEval.ok) {
                    skipCurrentTrajectoryProfile();
                    evaluateNext();
                    return;
                }

                var primaryTrackedEval = evaluateTrackedPoints(primaryTargetPointIndices, currentStep, candidates[currentTraj].length, minPointSeparation);
                if (!primaryTrackedEval.ok) {
                    skipCurrentTrajectoryProfile();
                    evaluateNext();
                    return;
                }

                for (var fid3 in faceQualities) {
                    if (!faceQualities.hasOwnProperty(fid3)) continue;
                    var q3 = faceQualities[fid3] || 0;
                    if (q3 <= 0) continue;
                    if (!currentFaceStats[fid3]) {
                        currentFaceStats[fid3] = { worst: q3, seenSteps: 1 };
                    } else {
                        if (q3 < currentFaceStats[fid3].worst) currentFaceStats[fid3].worst = q3;
                        currentFaceStats[fid3].seenSteps++;
                    }
                }
                currentStep++;
                evaluateNext();
                } catch (err) {
                    console.warn("benchmark: trajectory eval error; skipping candidate", err);
                    skipCurrentTrajectoryProfile();
                    evaluateNext();
                }
            }, settleMs);
        }

        evaluateNext();
    }

    // ── Scan mode: dense fold × POV face-visibility discovery (no screenshots) ──

    function runScan(cfg, onComplete) {
        var foldSteps = cfg.scanFoldSteps || [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
        var povs      = cfg.scanPovs      || ["y", "-y", "z", "-z", "x", "-x", "iso"];
        // If povGridSize is set, generate a continuous POV grid instead
        if (cfg.povGridSize && !cfg.scanPovs) {
            var grid = generatePovGrid(cfg.povGridSize);
            // Include standard named POVs as well for completeness
            povs = ["y", "-y", "z", "-z", "x", "-x", "iso"].concat(grid);
        }
        var settleMs  = cfg.scanSettleMs  != null ? cfg.scanSettleMs : 300;
        var name      = currentBenchmarkName || globals.filename || "scan";
        var useScanCache = cfg.useScanCache !== false;
        var forceRescan = cfg.forceRescan === true;
        var cacheKey = buildScanCacheKey(cfg, foldSteps);

        // Build flat list of {fold, pov} combinations
        var combinations = [];
        for (var fi = 0; fi < foldSteps.length; fi++) {
            for (var pi = 0; pi < povs.length; pi++) {
                combinations.push({ fold: foldSteps[fi], pov: povs[pi] });
            }
        }

        var faces = globals.model ? globals.model.getFaces() : null;
        var totalFaces = faces ? faces.length : 0;
        var scanStates = [];

        function cacheStateKey(fold, pov) {
            var povKey = Array.isArray(pov) ? pov.join(",") : String(pov);
            return String(fold) + "|" + povKey;
        }

        function isUsableCachedScan(cached) {
            if (!cached || !Array.isArray(cached.scanStates)) return false;
            if (cached.scanStates.length !== combinations.length) return false;
            var seen = {};
            for (var i = 0; i < cached.scanStates.length; i++) {
                var s = cached.scanStates[i];
                if (!s) return false;
                seen[cacheStateKey(s.fold, s.pov)] = true;
            }
            for (var j = 0; j < combinations.length; j++) {
                var c = combinations[j];
                if (!seen[cacheStateKey(c.fold, c.pov)]) return false;
            }
            return true;
        }

        function runCombination(index) {
            if (index >= combinations.length) {
                // Build per-POV analysis: for each POV, which faces are visible at every fold step?
                // Skip detailed per-POV analysis for large grids (handled by buildDiverseProgressions)
                var povAnalysis = {};
                var skipPovAnalysis = cfg.povGridSize && povs.length > 20;
                for (var pi = 0; !skipPovAnalysis && pi < povs.length; pi++) {
                    var pov = povs[pi];
                    var povStates = scanStates.filter(function (s) { return s.pov === pov; });

                    // Intersect visibleFaceIds across all fold steps for this POV
                    var alwaysIds = povStates.length > 0 ? povStates[0].visibleFaceIds.slice() : [];
                    for (var si = 1; si < povStates.length; si++) {
                        var fset = povStates[si].visibleFaceIds;
                        alwaysIds = alwaysIds.filter(function (id) { return fset.indexOf(id) !== -1; });
                    }

                    // Compute average minimum quality across states for ranking
                    var avgMinQuality = 0;
                    if (alwaysIds.length > 0 && povStates.length > 0) {
                        var totalMinQ = 0;
                        for (var si2 = 0; si2 < povStates.length; si2++) {
                            var sq = povStates[si2].faceQualities || {};
                            var minQ = alwaysIds.reduce(function (mn, id) { return Math.min(mn, sq[id] || 0); }, Infinity);
                            totalMinQ += (minQ === Infinity ? 0 : minQ);
                        }
                        avgMinQuality = Math.round((totalMinQ / povStates.length) * 1000) / 1000;
                    }

                    povAnalysis[pov] = {
                        alwaysVisibleFaceIds: alwaysIds,
                        faceCount:            alwaysIds.length,
                        avgMinQuality:        avgMinQuality,
                        states:               povStates.map(function (s) {
                            return { fold: s.fold, visibleFaceIds: s.visibleFaceIds, faceQualities: s.faceQualities || {} };
                        })
                    };
                }

                // Rank POVs by average minimum quality (primary), then face count (tiebreaker)
                var recommendedPovs = skipPovAnalysis ? [] : povs.slice()
                    .filter(function (p) { return povAnalysis[p] && povAnalysis[p].faceCount > 0; })
                    .sort(function (a, b) {
                        var qDiff = povAnalysis[b].avgMinQuality - povAnalysis[a].avgMinQuality;
                        if (Math.abs(qDiff) > 1e-6) return qDiff;
                        return povAnalysis[b].faceCount - povAnalysis[a].faceCount;
                    });

                // Pick 5 evenly-spaced fold steps from scanFoldSteps to use as sequence frames.
                // If there are ≤5 steps use all of them; otherwise sample evenly across the range.
                function pickFrames(steps, n) {
                    if (steps.length <= n) return steps.slice();
                    var picked = [];
                    for (var i = 0; i < n; i++) {
                        picked.push(steps[Math.round(i * (steps.length - 1) / (n - 1))]);
                    }
                    return picked;
                }
                var frameSteps = pickFrames(foldSteps, 5);

                // Build a lookup of visibleFaceIds and faceQualities for every {fold, pov} combination.
                var visLookup = {};
                var visQualityLookup = {};
                for (var li = 0; li < scanStates.length; li++) {
                    var ls = scanStates[li];
                    var key = ls.fold + '_' + ls.pov;
                    visLookup[key] = ls.visibleFaceIds;
                    visQualityLookup[key] = ls.faceQualities || {};
                }

                // Build a multi-POV sequence using only qualifying POVs (those with always-visible faces).
                // Frame 0 is always fold=0 pov="y" — flat paper top-down is the fixed anchor frame
                // so the viewer has a reference before folding begins. Remaining frames vary the POV.
                // candidatePovs: ordered list to try for frames 1-N; first entry is preferred.
                function buildMultiPovSequence(frames, candidatePovs) {
                    if (candidatePovs.length < 2) return null;

                    // Fixed first frame: fold=0, pov="y"
                    var firstFold = frames[0];
                    var firstFaceIds = visLookup[firstFold + '_y'] || [];
                    var firstQualities = visQualityLookup[firstFold + '_y'] || {};
                    var firstMinQuality = firstFaceIds.length > 0
                        ? firstFaceIds.reduce(function (mn, id) { return Math.min(mn, firstQualities[id] || 0); }, Infinity)
                        : 0;
                    var sequence = [{ fold: firstFold, pov: "y", minQuality: Math.round(firstMinQuality * 1000) / 1000 }];
                    var intersection = firstFaceIds.slice();
                    var lastPov = "y";

                    for (var fi = 1; fi < frames.length; fi++) {
                        var fold = frames[fi];
                        var bestPov = null, bestIntersection = null, bestMinQuality = -1, bestCount = -1;

                        for (var pi2 = 0; pi2 < candidatePovs.length; pi2++) {
                            var candidate = candidatePovs[pi2];
                            if (candidate === lastPov) continue; // no adjacent repeat
                            var faceIds = visLookup[fold + '_' + candidate] || [];
                            var newIntersection = intersection.filter(function (id) { return faceIds.indexOf(id) !== -1; });
                            if (newIntersection.length === 0) continue;
                            // Quality = minimum dot-product score across all tracked faces at this step
                            var qualities = visQualityLookup[fold + '_' + candidate] || {};
                            var minQ = newIntersection.reduce(function (mn, id) { return Math.min(mn, qualities[id] || 0); }, Infinity);
                            // Primary criterion: maximise minimum quality; tiebreak by count
                            if (minQ > bestMinQuality || (minQ === bestMinQuality && newIntersection.length > bestCount)) {
                                bestMinQuality = minQ;
                                bestCount = newIntersection.length;
                                bestPov = candidate;
                                bestIntersection = newIntersection;
                            }
                        }

                        if (!bestPov) break; // no valid candidate found
                        lastPov = bestPov;
                        sequence.push({ fold: fold, pov: bestPov, minQuality: Math.round(bestMinQuality * 1000) / 1000 });
                        intersection = bestIntersection || [];
                    }

                    if (!intersection || intersection.length === 0) return null;
                    return { steps: sequence, alwaysVisibleFaceIds: intersection, faceCount: intersection.length };
                }

                // Generate several multi-POV sequences by rotating which qualifying POV comes first.
                // This produces variants with different angle progressions for dataset diversity.
                // Candidates are restricted to qualifying POVs only — these are proven to keep
                // faces visible across all fold states, so mixing them stays tractable.
                var suggestedSequences = [];
                if (recommendedPovs.length >= 2) {
                    for (var seqi = 0; seqi < recommendedPovs.length; seqi++) {
                        // Rotate the candidate list so a different POV leads each variant
                        var rotated = recommendedPovs.slice(seqi).concat(recommendedPovs.slice(0, seqi));
                        var seq = buildMultiPovSequence(frameSteps, rotated);
                        if (seq) {
                            suggestedSequences.push({
                                alwaysVisibleFaceIds: seq.alwaysVisibleFaceIds,
                                faceCount:            seq.faceCount,
                                steps:                seq.steps
                            });
                        }
                    }
                    // Deduplicate sequences with identical step arrays
                    suggestedSequences = suggestedSequences.filter(function (s, idx) {
                        var key = s.steps.map(function (st) { return st.fold + '_' + st.pov; }).join(',');
                        for (var prev = 0; prev < idx; prev++) {
                            var pk = suggestedSequences[prev].steps.map(function (st) { return st.fold + '_' + st.pov; }).join(',');
                            if (pk === key) return false;
                        }
                        return true;
                    });
                }

                // Phase 2: live trajectory evaluation
                if (cfg.buildProgressions) {
                    var targetFaces = cfg.targetFaces || [];
                    if (targetFaces.length === 0 && cfg.facePoints) {
                        if (Array.isArray(cfg.facePoints)) {
                            cfg.facePoints.forEach(function (p) {
                                if (p.faceId != null && targetFaces.indexOf(p.faceId) === -1) targetFaces.push(p.faceId);
                            });
                        } else {
                            Object.keys(cfg.facePoints).forEach(function (k) {
                                var id = parseInt(k);
                                if (!isNaN(id) && targetFaces.indexOf(id) === -1) targetFaces.push(id);
                            });
                        }
                    }
                    var progQuality = cfg.minFaceQuality != null ? cfg.minFaceQuality : 0.6;
                    var progCount = typeof cfg.buildProgressions === "number" ? cfg.buildProgressions : 20;
                    var candidates = generateCandidateTrajectories(scanStates, foldSteps, progCount);

                    updateStatus("Phase 2: evaluating " + candidates.length + " trajectories live…");
                    evaluateTrajectoriesLive(candidates, targetFaces, progQuality, progCount, settleMs, cfg, function (diverseProgressions) {
                        if (useScanCache && !forceRescan) {
                            saveScanCache(cacheKey, {
                                cacheKey: cacheKey,
                                benchmark: name,
                                foldSteps: foldSteps,
                                povCount: povs.length,
                                scanStates: scanStates
                            });
                        }
                        finishScan(suggestedSequences, diverseProgressions);
                    });
                    return;
                }

                if (useScanCache && !forceRescan) {
                    saveScanCache(cacheKey, {
                        cacheKey: cacheKey,
                        benchmark: name,
                        foldSteps: foldSteps,
                        povCount: povs.length,
                        scanStates: scanStates
                    });
                }

                finishScan(suggestedSequences, []);
                return;

                function finishScan(suggestedSequences, diverseProgressions) {
                    var result = {
                        benchmark:          name,
                        model:              cfg.model || null,
                        totalFaces:         totalFaces,
                        scanPovs:           povs.length > 20 ? povs.length + " POVs (grid)" : povs,
                        scanFoldSteps:      foldSteps,
                        suggestedSequences: suggestedSequences,
                        diverseProgressions: diverseProgressions.length > 0 ? diverseProgressions : undefined,
                        povAnalysis:        cfg.povGridSize ? undefined : povAnalysis
                    };

                    var blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
                    var formData = new FormData();
                    formData.append("file", blob, "scan.json");
                    fetch("/api/screenshot?folder=" + encodeURIComponent(name), { method: "POST", body: formData })
                        .then(function (res) {
                            if (!res.ok) throw new Error("server error");
                            console.log("benchmark: saved screenshots/" + name + "/scan.json");
                        })
                        .catch(function () {
                            console.warn("benchmark: could not save scan (server unavailable)");
                        });

                    running = false;
                    if (diverseProgressions.length > 0) {
                        updateStatus("Scan complete. Built " + diverseProgressions.length + " diverse progressions.");
                        console.log("benchmark: scan complete, " + diverseProgressions.length + " progressions:", diverseProgressions);
                    } else {
                        var count = suggestedSequences && suggestedSequences.length ? suggestedSequences.length : 0;
                        updateStatus("Scan complete. Suggested sequences: " + count);
                    }
                    console.log("benchmark: scan complete, suggestedSequences:", suggestedSequences);
                    if (onComplete) onComplete();
                }
            }

            if (index > 0 && index % 25 === 0) {
                updateStatus("Scan progress: " + index + "/" + combinations.length + " combinations");
            }

            var combo = combinations[index];
            globals.setCreasePercent(combo.fold / 100);
            globals.shouldChangeCreasePercent = true;
            setPOV(combo.pov);
            globals.model.step();

            var povLabel = Array.isArray(combo.pov) ? "[" + combo.pov.join(",") + "]" : combo.pov;
            updateStatus("Scan: fold " + combo.fold + "% pov " + povLabel +
                         " (" + (index + 1) + "/" + combinations.length + ")");

            setTimeout(function () {
                try {
                var minFaceQuality = cfg.minFaceQuality != null ? cfg.minFaceQuality : 0.25;
                var allVisibleFaceIds = globals.facePoints && globals.facePoints.getVisibleFaceIds
                    ? globals.facePoints.getVisibleFaceIds()
                    : [];
                var faceQualities = globals.facePoints && globals.facePoints.getFaceViewQualities
                    ? globals.facePoints.getFaceViewQualities(allVisibleFaceIds)
                    : {};
                // Filter to faces meeting the quality threshold
                var visibleFaceIds = allVisibleFaceIds.filter(function (id) {
                    return (faceQualities[id] || 0) >= minFaceQuality;
                });

                // Keep compact quality map only for visible faces that pass threshold.
                var compactQualities = {};
                for (var vi = 0; vi < visibleFaceIds.length; vi++) {
                    var fid = visibleFaceIds[vi];
                    var q = faceQualities[fid] || 0;
                    compactQualities[fid] = Math.round(q * 1000) / 1000;
                }

                scanStates.push({ fold: combo.fold, pov: combo.pov, visibleFaceIds: visibleFaceIds, faceQualities: compactQualities });
                runCombination(index + 1);
                } catch (err) {
                    console.warn("benchmark: scan step error; skipping", err);
                    runCombination(index + 1);
                }
            }, settleMs);
        }

        running = true;
        if (useScanCache && !forceRescan) {
            updateStatus("Checking scan cache…");
            loadScanCache(cacheKey, function (cached) {
                if (isUsableCachedScan(cached)) {
                    scanStates = cached.scanStates;
                    updateStatus("Scan cache hit. Reusing " + scanStates.length + " cached states.");
                    runCombination(combinations.length);
                    return;
                }
                if (cached && cached.scanStates) {
                    console.warn("benchmark: cache exists but is incomplete/mismatched; rescanning");
                }
                updateStatus("Scan started (" + combinations.length + " combinations, " + settleMs + "ms settle)…");
                runCombination(0);
            });
            return;
        }
        updateStatus("Scan started (" + combinations.length + " combinations, " + settleMs + "ms settle)…");
        runCombination(0);
    }

    // ── Wait for model to finish loading ──

    function waitForModelLoad(callback) {
        var attempts = 0;
        var poll = setInterval(function () {
            attempts++;
            // model is loaded when needsSync has been consumed (set to false after sync)
            if (!globals.needsSync && globals.model && attempts > 5) {
                clearInterval(poll);
                callback();
            }
            if (attempts > 200) { // 10 second timeout
                clearInterval(poll);
                console.warn("benchmark: timed out waiting for model load");
                callback();
            }
        }, 50);
    }

    // ── Public: run the benchmark ──
    // onComplete: optional callback when benchmark finishes.

    function run(cfg, onComplete) {
        if (!cfg) cfg = config;
        if (!cfg) {
            console.warn("benchmark: no valid config to run");
            if (onComplete) onComplete();
            return;
        }
        if (cfg.scanMode) {
            runScan(cfg, onComplete);
            return;
        }
        stateAccumulator = [];
        capturedFiles = [];
        applySettings(cfg);

        // Apply initial fold state (top-level fold) before any animations
        if (cfg.fold != null) {
            globals.setCreasePercent(cfg.fold / 100);
            globals.shouldChangeCreasePercent = true;
            globals.model.step();
        }

        if (cfg.foldAnimation) {
            running = true;
            currentStep = 0;
            var anim = cfg.foldAnimation;
            var kf = anim.povKeyframes;
            var fitAll = anim.fitAllPoints === true || anim.povFitAllPoints === true;
            var track = anim.trackModel === true;
            var foldFrom = anim.from != null ? anim.from : (cfg.fold != null ? cfg.fold : 0);

            function startFold() {
                if (Array.isArray(kf) && kf.length > 0) {
                    var initialDir = getInterpolatedPOV(kf, foldFrom);
                    if (initialDir) {
                        if (track) {
                            globals.threeView.setCameraFixedForTracking();
                            globals.threeView.setModelRotationForPOV(initialDir);
                        } else {
                            globals.threeView.setCameraToPosition(initialDir, fitAll);
                        }
                    }
                } else {
                    setPOV(anim.pov || "iso");
                }

                function doAnimation() {
                    runFoldAnimation(cfg.foldAnimation, function () {
                        running = false;
                        // points are re-shown by runFoldAnimation before this callback
                        if (cfg.autoCapture) {
                            var endPov = (Array.isArray(kf) && kf.length > 0) ? kf[kf.length - 1].pov : (anim.pov || "iso");
                            updateStatus("Capturing end state…");
                            captureFinalWithBothStyles(stepLabel(anim.to != null ? anim.to : 90, endPov), stepLabel(anim.to != null ? anim.to : 90, endPov), cfg.labelStyle, function () {
                                console.log("benchmark: fold animation complete");
                                if (onComplete) onComplete();
                            });
                        } else {
                            console.log("benchmark: fold animation complete");
                            if (onComplete) onComplete();
                        }
                    });
                }

                if (cfg.autoCapture) {
                    // Wait for the simulation and renderer to settle on the start state
                    // before capturing. Uses captureSettleDelay (seconds) if set,
                    // otherwise falls back to pauseDuration, with a 1.5s minimum.
                    var settleMs = cfg.captureSettleDelay != null
                        ? cfg.captureSettleDelay * 1000
                        : Math.max((cfg.pauseDuration || 0) * 1000, 1500);
                    updateStatus("Settling " + (settleMs / 1000) + "s before start capture…");
                    setTimeout(function () {
                        var startPov = (Array.isArray(kf) && kf.length > 0) ? kf[0].pov : (anim.pov || "iso");
                        updateStatus("Capturing start state…");
                        captureScreenshot(stepLabel(foldFrom, startPov), function () {
                            doAnimation();
                        });
                    }, settleMs);
                } else {
                    doAnimation();
                }
            }

            function afterPreviewRotation() {
                var delayAfterPreview = anim.delayAfterPreview != null ? anim.delayAfterPreview : (cfg.delayAfterPreview || 0);
                if (delayAfterPreview > 0) {
                    updateStatus("Pausing " + delayAfterPreview + "s before fold…");
                    setTimeout(startFold, delayAfterPreview * 1000);
                } else {
                    startFold();
                }
            }

            function afterDelay() {
                if (cfg.previewRotation) {
                    var prevFold = cfg.fold != null ? cfg.fold : foldFrom;
                    runPreviewRotation(cfg.previewRotation, prevFold, track, fitAll, afterPreviewRotation);
                } else {
                    startFold();
                }
            }

            var delaySec = anim.delay != null ? anim.delay : (anim.delayBeforeAnimation != null ? anim.delayBeforeAnimation : (cfg.pauseDuration || 0));
            if (delaySec > 0) {
                updateStatus("Starting in " + delaySec + "s…");
                setTimeout(afterDelay, delaySec * 1000);
            } else {
                afterDelay();
            }
            return;
        }

        if (!cfg.steps || cfg.steps.length === 0) {
            console.warn("benchmark: no steps and no foldAnimation");
            if (onComplete) onComplete();
            return;
        }
        if (cfg.previewRotation) {
            var previewFold = cfg.fold != null ? cfg.fold : (cfg.steps && cfg.steps[0] ? cfg.steps[0].fold : 0);
            runPreviewRotation(cfg.previewRotation, previewFold, false, false, function () {
                runStep(cfg.steps, 0, cfg.pauseDuration, cfg.autoCapture, cfg.hidePointsDuringAnimation, cfg.labelStyle, onComplete);
            });
        } else {
            runStep(cfg.steps, 0, cfg.pauseDuration, cfg.autoCapture, cfg.hidePointsDuringAnimation, cfg.labelStyle, onComplete);
        }
    }

    // ── Public: run all presets from a JSON file in sequence ──
    // jsonPath: path to JSON (e.g. "benchmarks.json"). If null, uses current presets.
    // onComplete: optional callback when all presets finish.

    function runAll(jsonPath, onComplete) {
        var path = jsonPath || "benchmarks.json";
        $.getJSON(path)
            .done(function (loaded) {
                var names = Object.keys(loaded);
                if (names.length === 0) {
                    updateStatus("No presets in " + path);
                    if (onComplete) onComplete();
                    return;
                }
                var idx = 0;
                function runNext() {
                    if (idx >= names.length) {
                        running = false;
                        updateStatus("Run-all complete (" + names.length + " presets).");
                        if (onComplete) onComplete();
                        return;
                    }
                    var name = names[idx];
                    var cfg = $.extend(true, {}, loaded[name]);
                    cfg.model = cfg.model || loaded[name].model;
                    if (!cfg.model && !cfg.steps) {
                        idx++;
                        runNext();
                        return;
                    }
                    running = true;
                    currentBenchmarkName = name;
                    updateStatus("Run-all: " + (idx + 1) + "/" + names.length + " — " + name);
                    selectPresetFromConfig(name, cfg, function () {
                        run(cfg, function () {
                            idx++;
                            runNext();
                        });
                    });
                }
                runNext();
            })
            .fail(function () {
                updateStatus("Failed to load " + path);
                if (onComplete) onComplete();
            });
    }

    // Load a preset by name and config, then callback when model is ready.
    function selectPresetFromConfig(name, cfg, callback) {
        if (cfg.model) {
            globals.loadedModel = cfg.model.replace(/'/g, '');
            globals.importer.importDemoFile(globals.loadedModel);
            waitForModelLoad(function () {
                applySettings(cfg);
                if (callback) callback();
            });
        } else {
            applySettings(cfg);
            if (callback) callback();
        }
    }

    // ── Public: initialize — called from main.js before model load ──
    // loadModelCallback(modelPath) is called once config is parsed,
    // passing the model path to load (from benchmark preset, URL, or null for default).

    function init(cb) {
        loadModelCallback = cb;
        $.getJSON("benchmarks.json")
            .done(function (loaded) {
                presets = loaded;
                config = buildConfig(presets);
                populatePresetDropdown();
                onConfigReady(cb);
            })
            .fail(function () {
                presets = null;
                config = buildConfig(null);
                updateStatus("No benchmarks.json found.");
                onConfigReady(cb);
            });
    }

    function populatePresetDropdown() {
        var $sel = $("#benchmarkPresetSelect");
        $sel.find("option:not(:first)").remove();
        if (!presets) return;
        var names = Object.keys(presets).sort();
        names.forEach(function (name) {
            $sel.append($("<option></option>").attr("value", name).text(name));
        });
    }

    function selectPreset(name) {
        if (!presets || !name || !presets[name]) {
            config = null;
            updateStatus("Select a preset or use URL params to configure.");
            return;
        }
        currentBenchmarkName = name;
        config = $.extend(true, {}, presets[name]);
        if (!config.pauseDuration) config.pauseDuration = 2;
        if (!config.steps) config.steps = [{ fold: 0, pov: "iso" }];
        if (config.model) {
            globals.loadedModel = config.model.replace(/'/g, '');
            globals.importer.importDemoFile(globals.loadedModel);
            waitForModelLoad(function () {
                applySettings(config);
                updateStatus("Preset \"" + name + "\" ready. " + config.steps.length + " steps.");
            });
        } else {
            applySettings(config);
            updateStatus("Preset \"" + name + "\" applied. " + config.steps.length + " steps.");
        }
    }

    function onConfigReady(cb) {
        var benchmarkName = getParam("benchmark");
        if (benchmarkName && $("#benchmarkPresetSelect").length) {
            $("#benchmarkPresetSelect").val(benchmarkName);
        }
        var benchmarksPath = getParam("benchmarks");
        if (benchmarksPath && $("#benchmarkJsonPath").length) {
            $("#benchmarkJsonPath").val(benchmarksPath);
        }
        var benchmarkModel = config ? config.model : null;
        if (cb) cb(benchmarkModel);

        if (!config && !getParamBool("runAll")) return;

        waitForModelLoad(function () {
            if (config) {
                applySettings(config);
                updateStatus("Benchmark ready: " + config.steps.length + " steps.");
                if (config.autoRun) {
                    setTimeout(function () { run(config); }, 500);
                }
            }
            if (getParamBool("runAll")) {
                var jsonPath = getParam("benchmarks") || "benchmarks.json";
                setTimeout(function () { runAll(jsonPath); }, 500);
            }
        });
    }

    function loadJson(path) {
        if (!path) return;
        $.getJSON(path)
            .done(function (loaded) {
                presets = loaded;
                populatePresetDropdown();
                updateStatus("Loaded " + Object.keys(loaded).length + " presets from " + path);
            })
            .fail(function () {
                presets = null;
                populatePresetDropdown();
                updateStatus("Could not load " + path);
            });
    }

    return {
        init: init,
        run: run,
        runAll: runAll,
        loadJson: loadJson,
        selectPreset: selectPreset,
        getConfig: function () { return config; },
        getPresets: function () { return presets; },
        isRunning: function () { return running; },
        setPOV: setPOV
    };
}
