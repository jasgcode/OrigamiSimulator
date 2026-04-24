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
 *   stepLabelPrefix — prefix text for step overlay (default: "Step")
 *   stepLabelFontSize — step overlay font size in px
 *   stepLabelShowTotal — default false ("STATE N" only); set "true" to render "STATE N/M"
 *   trackingEvalMode — tracking strictness: "strictAllSteps" (default) or "finalStepOnly"
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
    // JSONL dataset output state. jsonlBatchStarted resets to false at runAll
    // start; the first POST per batch truncates dataset.jsonl, subsequent POSTs
    // append. currentJsonlId is the question id used for image folder naming.
    // jsonlStepIndex is 0-based per preset.
    var jsonlBatchStarted = false;
    var currentJsonlId = null;
    var jsonlStepIndex = 0;
    var stepLabelPrefix = "STATE";
    var stepLabelFontSize = null;
    // Default OFF: render overlay shows "STATE N" (current state only),
    // not "STATE N/M". Pass `stepLabelShowTotal: true` in the preset cfg
    // or URL param to opt back in.
    var stepLabelShowTotal = false;

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
        applyStepOverlayConfig(cfg);

        if (cfg.colorMode) {
            globals.colorMode = cfg.colorMode;
            // update radio UI
            $(".radio>input[value=" + cfg.colorMode + "]").prop("checked", true);
            // show/hide option panels
            $("#coloredMaterialOptions").toggle(cfg.colorMode === "color" || cfg.colorMode === "greyscale");
            $("#axialStrainMaterialOptions").toggle(cfg.colorMode === "axialStrain");
            $("#faceIDOptions").toggle(cfg.colorMode === "faceID");
            $("#faceTriangleIDOptions").toggle(cfg.colorMode === "faceTriangleID" || cfg.colorMode === "labelOnly" || cfg.colorMode === "greyscaleLabel");
            $("#labelOnlyOptions").toggle(cfg.colorMode === "labelOnly");
            globals.model.setMeshMaterial();
        }

        if (cfg.pointA !== undefined && cfg.pointA !== null) {
            var val = parseInt(cfg.pointA);
            if (!isNaN(val)) {
                if (globals.colorMode === "faceTriangleID" || globals.colorMode === "labelOnly" || globals.colorMode === "greyscaleLabel") {
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
                if (globals.colorMode === "faceTriangleID" || globals.colorMode === "labelOnly" || globals.colorMode === "greyscaleLabel") {
                    if (globals.facePoints) globals.facePoints.addPoint(val);
                    if (globals.controls && globals.controls.refreshFacePointList) globals.controls.refreshFacePointList();
                } else {
                    globals.highlightedFaceB = val;
                    $("#highlightFaceB").val(val);
                }
                globals.model.updateFaceColors();
            }
        }

        if (cfg.facePoints && globals.facePoints && (globals.colorMode === "faceTriangleID" || globals.colorMode === "labelOnly" || globals.colorMode === "greyscaleLabel")) {
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
            if (globals.colorMode === "labelOnly" || globals.colorMode === "greyscaleLabel" || globals.colorMode === "color" || globals.colorMode === "greyscale") globals.model.setMeshMaterial();
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

    // ── Step number overlay ──
    var $stepOverlay = null;
    function getStepNumberText(index, total) {
        var stepNumber = index + 1;
        return stepLabelPrefix + " " + (stepLabelShowTotal ? (stepNumber + "/" + total) : stepNumber);
    }
    function applyStepOverlayConfig(cfg) {
        var labelPrefix = cfg && cfg.stepLabelPrefix;
        if (labelPrefix !== undefined && labelPrefix !== null && String(labelPrefix).trim() !== "") {
            stepLabelPrefix = String(labelPrefix).trim();
        } else {
            stepLabelPrefix = "STATE";
        }

        var fontSize = cfg ? parseFloat(cfg.stepLabelFontSize) : NaN;
        if (!isNaN(fontSize) && fontSize > 0) {
            stepLabelFontSize = fontSize;
        } else {
            stepLabelFontSize = null;
        }

        // Default OFF — "STATE N" not "STATE N/M". Caller can opt in via
        // cfg.stepLabelShowTotal === true.
        stepLabelShowTotal = cfg && cfg.stepLabelShowTotal === true;

        if (!$stepOverlay) $stepOverlay = $("#stepNumberOverlay");
        if (stepLabelFontSize !== null) {
            $stepOverlay.css("font-size", stepLabelFontSize + "px");
        } else {
            $stepOverlay.css("font-size", "");
        }
    }
    function showStepNumber(index, total) {
        if (!$stepOverlay) $stepOverlay = $("#stepNumberOverlay");
        var text = getStepNumberText(index, total);
        $stepOverlay.text(text).show();
        globals.stepNumberText = text;
    }
    function hideStepNumber() {
        if (!$stepOverlay) $stepOverlay = $("#stepNumberOverlay");
        $stepOverlay.hide();
        globals.stepNumberText = null;
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
        // Map hidden point indices to labels (A, B, ..., Z, AA, AB, ...)
        var hiddenPointLabels = {};
        for (var hi = 0; hi < hiddenPoints.length; hi++) {
            hiddenPointLabels[hiddenPoints[hi]] = pointIndexToLabel(hiddenPoints[hi]);
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

        saveMetadataJson(name, summary);
        // Append a JSONL row for this preset to screenshots/dataset.jsonl
        // (truncates if first preset of the batch).
        try {
            postJsonlEntry(buildJsonlEntry(name, summary));
        } catch (e) {
            console.warn("benchmark: buildJsonlEntry failed", e && e.message ? e.message : e);
        }
    }

    // Saves metadata JSON (no eval questions/answers — those are in Hydra config).
    // One entry per benchmark with images, point info, and difficulty.
    function saveMetadataJson(name, summary) {
        if (capturedFiles.length === 0) return;
        var images = capturedFiles.slice();

        // Build the list of ALL labels in the final state (A, B, ..., Z, AA, AB, ...)
        // and identify which are the "initial" (non-hidden) points.
        var allLabels = [];
        var initialLabels = [];
        for (var i = 0; i < summary.totalPoints; i++) {
            var letter = pointIndexToLabel(i);
            allLabels.push(letter);
            var isHidden = summary.hiddenPoints.indexOf(i) !== -1;
            if (!isHidden) {
                initialLabels.push(letter);
            }
        }

        // Separate points by side: front (faceId < N) vs back (faceId >= N)
        var frontPoints = [];
        var backPoints = [];
        var pts = globals.facePoints && globals.facePoints.getPoints ? globals.facePoints.getPoints() : [];
        var faces = globals.model && globals.model.getFaces ? globals.model.getFaces() : [];
        var N = faces.length;
        for (var pi = 0; pi < pts.length; pi++) {
            var label = allLabels[pi] || pointIndexToLabel(pi);
            if (pts[pi].faceId < N) {
                frontPoints.push(label);
            } else {
                backPoints.push(label);
            }
        }
        frontPoints.sort();
        backPoints.sort();

        var samples = [{
            id:                datasetSampleCounter++,
            images:            images,
            benchmark:         name,
            colorMode:         globals.colorMode || null,
            difficulty:        config && config.difficulty != null ? config.difficulty : null,
            totalPoints:       summary.totalPoints,
            initialPoints:     initialLabels,
            hiddenPoints:      summary.hiddenPoints,
            allLabels:         allLabels,
            hiddenPointLabels: summary.hiddenPointLabels,
            frontPoints:       frontPoints,
            backPoints:        backPoints
        }];

        var blob = new Blob([JSON.stringify(samples, null, 2)], { type: "application/json" });
        var formData = new FormData();
        formData.append("file", blob, "metadata.json");
        fetch("/api/screenshot?folder=" + encodeURIComponent(name), { method: "POST", body: formData })
            .then(function (res) {
                if (!res.ok) throw new Error("server error");
                console.log("benchmark: saved screenshots/" + name + "/metadata.json");
            })
            .catch(function () {
                console.warn("benchmark: could not save metadata JSON (server unavailable)");
            });
    }


    // filenameLabel — used in the PNG filename (e.g. "step01"); hides POV from evaluators
    // recordLabel  — passed to recordStateVisibility for fold/pov ground truth parsing
    //                (e.g. "fold000_pov-y"); if omitted, filenameLabel is used for both
    // Files are saved to screenshots/{benchmarkName}/{filenameLabel}.png
    function captureScreenshot(filenameLabel, recordLabel, callback) {
        if (typeof recordLabel === "function") { callback = recordLabel; recordLabel = filenameLabel; }
        var name = currentBenchmarkName || globals.filename || "benchmark";
        // JSONL-style path: images/<id>/step_NNNN_current.png. The 0-based
        // jsonlStepIndex is incremented per captureScreenshot call within
        // a preset (reset in run() alongside stateAccumulator/capturedFiles).
        var jsonlId = currentJsonlId || buildJsonlId(name, config && config.model, config && config.difficulty);
        var stepIdx = jsonlStepIndex++;
        var filename = jsonlStepFilename(stepIdx);
        var folder = "images/" + jsonlId;
        var relativePath = folder + "/" + filename;
        globals.screenRecordFilename = jsonlId + "_step_" + stepIdx;
        globals.captureCallback = function (blob) {
            var formData = new FormData();
            formData.append("file", blob, filename);
            fetch("/api/screenshot?folder=" + encodeURIComponent(folder), { method: "POST", body: formData })
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
        // Default to true when unspecified — every difficulty should hide
        // intermediate-frame point markers during fold animation so the
        // captured PNGs only show points at the canonical step boundaries.
        // Pass `hidePointsDuringAnimation: false` to opt out.
        var hidePoints = opts.hidePointsDuringAnimation !== false;

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
            hideStepNumber();
            updateStatus("Benchmark complete (" + steps.length + " steps).");
            console.log("benchmark: sequence complete");
            saveBenchmarkSummary(currentBenchmarkName || globals.filename || "benchmark");
            if (onComplete) onComplete();
            return;
        }

        running = true;
        currentStep = index;
        var step = steps[index];

        showStepNumber(index, steps.length);
        updateStatus("Step " + (index + 1) + "/" + steps.length +
                     " — fold " + step.fold + "%" +
                     (step.pov ? ", POV " + step.pov : ""));

        var isBoundaryStep = (index === 0 || index === steps.length - 1);
        // Default-on: hide points during inter-step animation unless caller
        // explicitly passes false. Boundary steps (first/last) always show
        // points so the captured PNG includes them.
        globals.hideFacePointsDuringAnimation = hidePointsDuringAnimation !== false && !isBoundaryStep;

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

        var trackingEvalMode = getParam("trackingEvalMode");
        if (trackingEvalMode) cfg.trackingEvalMode = trackingEvalMode;

        var stepLabelPrefixParam = getParam("stepLabelPrefix");
        if (stepLabelPrefixParam !== null && stepLabelPrefixParam !== undefined) cfg.stepLabelPrefix = stepLabelPrefixParam;

        var stepLabelFontSizeParam = getParamFloat("stepLabelFontSize");
        if (stepLabelFontSizeParam !== null) cfg.stepLabelFontSize = stepLabelFontSizeParam;

        if (getParam("stepLabelShowTotal") !== null) cfg.stepLabelShowTotal = getParamBool("stepLabelShowTotal");

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
        var maxTrajectoryCandidates = getParamInt("maxTrajectoryCandidates");
        if (maxTrajectoryCandidates !== null) cfg.maxTrajectoryCandidates = maxTrajectoryCandidates;
        var phase2LogEveryMs = getParamInt("phase2LogEveryMs");
        if (phase2LogEveryMs !== null) cfg.phase2LogEveryMs = phase2LogEveryMs;
        var phase2StallWarnMs = getParamInt("phase2StallWarnMs");
        if (phase2StallWarnMs !== null) cfg.phase2StallWarnMs = phase2StallWarnMs;
        if (getParam("enforceSeparationAllSteps") !== null) cfg.enforceSeparationAllSteps = getParamBool("enforceSeparationAllSteps");
        if (getParam("phase2VerboseRejects") !== null) cfg.phase2VerboseRejects = getParamBool("phase2VerboseRejects");
        var minFaceQualityParam = getParamFloat("minFaceQuality");
        if (minFaceQualityParam !== null) cfg.minFaceQuality = minFaceQualityParam;
        var phase2MaxTargetFaces = getParamInt("phase2MaxTargetFaces");
        if (phase2MaxTargetFaces !== null) cfg.phase2MaxTargetFaces = phase2MaxTargetFaces;
        var difficultyParam = getParamInt("difficulty");
        if (difficultyParam !== null) cfg.difficulty = difficultyParam;

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

    function generatePovGrid(count, opts) {
        // Fibonacci sphere sampling, filtered by y bounds. Default bounds
        // (y in [0.3, 0.95]) keep every sampled POV in the "iso-ish" upper
        // hemisphere — above the equator (y >= 0.3 ≈ 17°+ above horizon)
        // but not pure top-down (y <= 0.95 leaves at least ~18° of off-axis
        // tilt). iso is (1,1,1) normalized so y = 0.577. This guarantees
        // the initial state of every preset is rendered from a BEV-ish
        // angle that reads as 3D rather than top-down or edge-on.
        // Override via opts.minY / opts.maxY (or cfg.minPovY / cfg.maxPovY
        // upstream) if a preset needs a wider sphere.
        var minY = (opts && opts.minY != null) ? opts.minY : 0.3;
        var maxY = (opts && opts.maxY != null) ? opts.maxY : 0.95;
        var goldenAngle = Math.PI * (3 - Math.sqrt(5));
        var candidates = [];
        for (var i = 0; i < count; i++) {
            var y = 1 - (2 * i / (count - 1));
            if (y < minY || y > maxY) continue;
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
    //
    // Static POV is mandatory: every step uses the same endpoint POV
    // (no iso-start lerp). Motion is expressed via object rotation.
    // This keeps phase-2 validation aligned with emitted presets.
    function generateCandidateTrajectories(scanStates, foldSteps, count, opts) {
        var staticPov = true;
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
        function endpointFromPov(pov) {
            var dir = getPOVDirection(pov);
            if (!dir) return null;
            var n = dir.normalize();
            return round2([n.x, n.y, n.z]);
        }

        // Collect all unique continuous POVs scanned at the last fold step as potential endpoints
        var lastFold = foldSteps[foldSteps.length - 1];
        var endpoints = [];
        var seen = {};
        // In staticPov mode, the same POV is used at every fold step. POVs that
        // can't see the tracked face at fold=0 (flat paper, only upper-hemisphere
        // POVs see the front) will fail validation at step 1. Pre-filter to
        // endpoints whose fold=0 scan state has at least one visible face.
        var fold0VisiblePovs = null;
        if (staticPov) {
            fold0VisiblePovs = {};
            var firstFold = foldSteps[0];
            for (var si0 = 0; si0 < scanStates.length; si0++) {
                var st0 = scanStates[si0];
                if (st0.fold !== firstFold) continue;
                if (!st0.visibleFaceIds || st0.visibleFaceIds.length === 0) continue;
                var povKey0 = Array.isArray(st0.pov) ? st0.pov.join(",") : String(st0.pov);
                fold0VisiblePovs[povKey0] = true;
            }
        }
        for (var si = 0; si < scanStates.length; si++) {
            var st = scanStates[si];
            if (st.fold !== lastFold) continue;
            if (staticPov) {
                var povKey = Array.isArray(st.pov) ? st.pov.join(",") : String(st.pov);
                if (!fold0VisiblePovs[povKey]) continue;
            }
            var endpoint = endpointFromPov(st.pov);
            if (!endpoint) continue;
            var k = endpoint.join(",");
            if (!seen[k]) { seen[k] = true; endpoints.push(endpoint); }
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

            if (staticPov) {
                // One trajectory per endpoint: every step uses the endpoint
                // POV directly. Rotation-profile sweep in Phase 2 is what
                // provides motion variety.
                var staticSteps = [];
                for (var fsi = 0; fsi < foldSteps.length; fsi++) {
                    staticSteps.push({ fold: foldSteps[fsi], pov: ep.slice() });
                }
                trajectories.push(staticSteps);
                continue;
            }
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
                if (staticPov) {
                    var dupeEp = false;
                    for (var di0 = 0; di0 < trajectories.length; di0++) {
                        var la = trajectories[di0][trajectories[di0].length - 1].pov;
                        if (Array.isArray(la) && la[0] === ep2[0] && la[1] === ep2[1] && la[2] === ep2[2]) {
                            dupeEp = true; break;
                        }
                    }
                    if (dupeEp) continue;
                    var staticSteps2 = [];
                    for (var fsi2 = 0; fsi2 < foldSteps.length; fsi2++) {
                        staticSteps2.push({ fold: foldSteps[fsi2], pov: ep2.slice() });
                    }
                    trajectories.push(staticSteps2);
                    continue;
                }
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

    function pointIndexToLabel(index) {
        var n = parseInt(index, 10);
        if (isNaN(n) || n < 0) return null;
        var label = "";
        n += 1;
        while (n > 0) {
            var rem = (n - 1) % 26;
            label = String.fromCharCode(65 + rem) + label;
            n = Math.floor((n - 1) / 26);
        }
        return label;
    }

    // ── JSONL dataset helpers ──

    function slugifyId(s) {
        return String(s || "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "");
    }

    // Extract the model basename from a path like "/Bases/birdBase.svg" → "birdbase".
    function modelStem(modelPath) {
        var p = String(modelPath || "");
        var lastSlash = p.lastIndexOf("/");
        if (lastSlash >= 0) p = p.substring(lastSlash + 1);
        var dot = p.lastIndexOf(".");
        if (dot >= 0) p = p.substring(0, dot);
        return slugifyId(p);
    }

    function parseSeedFromName(name) {
        // Try to extract a trailing seed-like number from preset names.
        // Currently presetGenerator names them like "bird-d4-final-01" — last
        // numeric chunk = 01. If not present, return null.
        var m = String(name || "").match(/(\d+)\s*$/);
        return m ? parseInt(m[1], 10) : null;
    }

    // Build a compact, unique question id for a preset.
    // Form: origami_point_tracking_difficulty_<n>_<modelStem>_<NN>
    // Example: origami_point_tracking_difficulty_4_birdbase_01
    // Capped at 60 chars to satisfy the user's "not too long" constraint.
    function buildJsonlId(name, modelPath, difficulty) {
        var d = parseInt(difficulty, 10);
        if (isNaN(d) || d < 1) d = 1;
        var stem = modelStem(modelPath);
        var idx = parseSeedFromName(name);
        var idxStr = (idx != null) ? String(idx).padStart(2, "0") : slugifyId(name);
        var id = "origami_point_tracking_difficulty_" + d + "_" + stem + "_" + idxStr;
        if (id.length > 60) id = id.substring(0, 60).replace(/_+$/, "");
        return id;
    }

    function jsonlStepFilename(stepIndex) {
        var s = String(stepIndex);
        while (s.length < 4) s = "0" + s;
        return "step_" + s + "_current.png";
    }

    var JSONL_QUESTION_TEMPLATE_PARTS = [
        "You are solving a 3D point-tracking question on a folding origami model. ",
        "The model goes through {N} folding states. ",
        "At each state, identify which labeled points (e.g. A, B, C, ...) are currently visible on the model. ",
        "Some points may be hidden until the final state."
    ];

    function buildJsonlEntry(name, summary) {
        var id = currentJsonlId || buildJsonlId(name, config && config.model, config && config.difficulty);
        var totalSteps = stateAccumulator.length;
        var question = JSONL_QUESTION_TEMPLATE_PARTS.join("").replace("{N}", totalSteps);
        var hiddenSet = {};
        for (var hi = 0; hi < (summary.hiddenPoints || []).length; hi++) {
            hiddenSet[summary.hiddenPoints[hi]] = true;
        }

        // Build per-step visible-label arrays. Hidden indices are excluded
        // from non-final steps and included at the final step (matches the
        // reveal semantics).
        function answerLabelsForStep(si, isFinal) {
            var st = stateAccumulator[si] || {};
            var visIdx = (st.visiblePoints || []).slice().sort(function (a, b) { return a - b; });
            var labels = [];
            for (var vi = 0; vi < visIdx.length; vi++) {
                if (!isFinal && hiddenSet[visIdx[vi]]) continue;
                var lbl = pointIndexToLabel(visIdx[vi]);
                if (lbl) labels.push(lbl);
            }
            return labels;
        }

        var lastIdx = (totalSteps > 0) ? totalSteps - 1 : 0;
        var initialState = {
            image: "images/" + id + "/" + jsonlStepFilename(0),
            visible_points: answerLabelsForStep(0, false)
        };
        var finalState = {
            image: "images/" + id + "/" + jsonlStepFilename(lastIdx),
            visible_points: answerLabelsForStep(lastIdx, true)
        };
        var intermediateImages = [];
        for (var si = 1; si < lastIdx; si++) {
            intermediateImages.push("images/" + id + "/" + jsonlStepFilename(si));
        }

        var d = parseInt(config && config.difficulty, 10);
        if (isNaN(d) || d < 1) d = 1;
        var seed = parseSeedFromName(name);

        return {
            id: id,
            category: ["origami", "origami_point_tracking"],
            type: "episode_rollout",
            question: question,
            meta_info: {
                task_name: "origami_point_tracking",
                config: "../../metadata.json",
                level: modelStem(config && config.model) + "_difficulty_" + d,
                seed: seed,
                repeat_index: 0,
                difficulty: "d" + d,
                model_id: "oracle",
                success: true,
                final_reason: "all_states_rendered",
                total_steps: totalSteps
            },
            initial_state: initialState,
            final_state: finalState,
            intermediate_images: intermediateImages
        };
    }

    function postJsonlEntry(entry) {
        // Always append. Truncation is the CALLER's responsibility (e.g.
        // the python parallel runner removes dataset.jsonl before launching
        // shards). Per-process truncate-on-first-preset would race and
        // silently drop entries when multiple shards run concurrently.
        jsonlBatchStarted = true;
        var line = JSON.stringify(entry);
        return fetch("/api/jsonl-append", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: "dataset.jsonl", line: line, fresh: false })
        })
        .then(function (res) {
            if (!res.ok) throw new Error("jsonl-append failed");
            console.log("benchmark: appended dataset.jsonl entry " + entry.id);
        })
        .catch(function (err) {
            console.warn("benchmark: jsonl-append error", err && err.message ? err.message : err);
        });
    }

    function pointLabelToIndex(label) {
        if (label === undefined || label === null) return null;
        var s = String(label).trim().toUpperCase();
        if (!s || !/^[A-Z]+$/.test(s)) return null;
        var value = 0;
        for (var i = 0; i < s.length; i++) {
            value = value * 26 + (s.charCodeAt(i) - 64);
        }
        return value - 1;
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

    // Returns the subset of point indices that are NOT hidden.
    // Used to enforce "initial visible anchors must be visible at step 0"
    // even when trackingEvalMode is finalStepOnly.
    function getNonHiddenPointIndices(indices) {
        if (!Array.isArray(indices) || indices.length === 0) return [];
        var out = [];
        for (var i = 0; i < indices.length; i++) {
            var idx = indices[i];
            var hidden = globals.facePoints && globals.facePoints.isPointHidden
                ? globals.facePoints.isPointHidden(idx) : false;
            if (!hidden && out.indexOf(idx) === -1) out.push(idx);
        }
        return out;
    }

    function normalizeTrackingEvalMode(mode) {
        var s = mode == null ? "strictallsteps" : String(mode).trim().toLowerCase();
        if (s === "finalsteponly" || s === "finalstep" || s === "final" || s === "final-only" || s === "final_step_only") {
            return "finalStepOnly";
        }
        if (s === "strict" || s === "all" || s === "allsteps" || s === "strict-all-steps" || s === "strictallsteps") {
            return "strictAllSteps";
        }
        return "strictAllSteps";
    }

    function normalizeDifficultyTier(difficulty) {
        var d = parseInt(difficulty, 10);
        if (isNaN(d)) return null;
        if (d < 1) return 1;
        if (d > 4) return 4;
        return d;
    }

    function getRotationBoundsForDifficulty(difficulty) {
        var tier = normalizeDifficultyTier(difficulty);
        // d1: static — no inter-step motion. (Diversity from constant-rotation
        // poses is layered in by presetGenerator.js's rotationBoundsForTier
        // and propagated via cfg.rotationYawMax/Pitch/Roll, not here.)
        if (tier === 1) return { yaw: 0, pitch: 0, roll: 0 };
        if (tier === 2) return { yaw: 0.2, pitch: 0.2, roll: 0.05 };
        if (tier === 3) return { yaw: 0.5, pitch: 0.15, roll: 0.08 };
        if (tier === 4) return { yaw: 1.0, pitch: 1.0, roll: 0.25 };
        // Fallback for custom/manual scan configs without a difficulty.
        return { yaw: 1.0, pitch: 1.0, roll: 0.25 };
    }

    function getRotationMotionThresholdsForDifficulty(difficulty) {
        var tier = normalizeDifficultyTier(difficulty);
        if (tier === 4) return { end: 0.45, total: 0.95 };
        if (tier === 3) return { end: 0.20, total: 0.45 };
        // d1/d2: no default rotation gate. d1 is static; d2 can be
        // geometry-constrained on thin back pools, so keep permissive.
        return { end: 0, total: 0 };
    }

    function normalizeFaceIdToFront(faceId, faceCount) {
        var id = parseInt(faceId, 10);
        if (isNaN(id) || faceCount <= 0) return null;
        if (id >= 0 && id < faceCount) return id;
        if (id >= faceCount && id < faceCount * 2) return id - faceCount;
        return null;
    }

    function normalizeFaceIdList(faceIds, faceCount) {
        var out = [];
        if (!Array.isArray(faceIds)) return out;
        for (var i = 0; i < faceIds.length; i++) {
            var normalized = normalizeFaceIdToFront(faceIds[i], faceCount);
            if (normalized !== null && out.indexOf(normalized) === -1) out.push(normalized);
        }
        return out;
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

    function getRotationForStep(step) {
        var r = parseRotation(step && step.rotation);
        if (!r) return { x: 0, y: 0, z: 0 };
        return r;
    }

    function rotationDistanceBetweenSteps(a, b) {
        var ra = getRotationForStep(a);
        var rb = getRotationForStep(b);
        var dx = ra.x - rb.x;
        var dy = ra.y - rb.y;
        var dz = ra.z - rb.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    function getProgressionMotionMetrics(steps) {
        if (!steps || steps.length < 2) {
            return {
                endAngle: 0,
                totalAngle: 0,
                rotationEndAngle: 0,
                rotationTotalAngle: 0
            };
        }
        var first = getPovDirectionForStep(steps[0]);
        var last = getPovDirectionForStep(steps[steps.length - 1]);
        var endAngle = angularDistanceBetweenDirs(first, last);
        var totalAngle = 0;
        var rotationEndAngle = rotationDistanceBetweenSteps(steps[0], steps[steps.length - 1]);
        var rotationTotalAngle = 0;
        for (var i = 1; i < steps.length; i++) {
            totalAngle += angularDistanceBetweenDirs(getPovDirectionForStep(steps[i - 1]), getPovDirectionForStep(steps[i]));
            rotationTotalAngle += rotationDistanceBetweenSteps(steps[i - 1], steps[i]);
        }
        return {
            endAngle: endAngle,
            totalAngle: totalAngle,
            rotationEndAngle: rotationEndAngle,
            rotationTotalAngle: rotationTotalAngle
        };
    }

    function progressionDistance(aSteps, bSteps) {
        if (!aSteps || !bSteps || aSteps.length === 0 || bSteps.length === 0) return 0;
        var len = Math.min(aSteps.length, bSteps.length);
        var totalPov = 0;
        var totalRot = 0;
        var count = 0;
        for (var i = 0; i < len; i++) {
            totalPov += angularDistanceBetweenDirs(getPovDirectionForStep(aSteps[i]), getPovDirectionForStep(bSteps[i]));
            totalRot += rotationDistanceBetweenSteps(aSteps[i], bSteps[i]);
            count++;
        }
        if (count === 0) return 0;
        var meanPov = totalPov / count;
        var meanRot = totalRot / count;
        // Static-POV progressions have zero POV distance by definition;
        // in that case use rotation distance for diversity selection.
        if (meanPov < 1e-8) return meanRot;
        return Math.max(meanPov, meanRot * 0.75);
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
                finalViewScore: p.finalViewScore,
                metrics: p.metrics,
                // Preserve per-step visibility timeline for trajectory-first
                // face-point selection in presetGenerator.js. Without this,
                // selectFacePointsFromTrajectory sees no timeline and returns
                // [], collapsing every trajectory to "empty config".
                visibilityTimeline: p.visibilityTimeline
            };
        });
    }

    function formatDurationMs(ms) {
        var totalSec = Math.max(0, Math.round(ms / 1000));
        var h = Math.floor(totalSec / 3600);
        var m = Math.floor((totalSec % 3600) / 60);
        var s = totalSec % 60;
        if (h > 0) return h + "h" + (m < 10 ? "0" : "") + m + "m" + (s < 10 ? "0" : "") + s + "s";
        if (m > 0) return m + "m" + (s < 10 ? "0" : "") + s + "s";
        return s + "s";
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
        // Only phase-1 fields affect scanStates (visible faces per fold/pov).
        // Phase-2 params (targets, tracking, rotation profiles, separations)
        // re-evaluate on top of the cached scan and must not invalidate it.
        var payload = {
            version: 3,
            model: cfg.model || "",
            scanFoldSteps: foldSteps,
            scanPovs: cfg.scanPovs || null,
            povGridSize: cfg.povGridSize || null,
            minFaceQuality: cfg.minFaceQuality != null ? cfg.minFaceQuality : 0.35
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

        function sampleEnvelope(points, t) {
            if (!points || points.length === 0) return 1;
            if (points.length === 1) return points[0];
            var clamped = Math.max(0, Math.min(1, t));
            var pos = clamped * (points.length - 1);
            var i0 = Math.floor(pos);
            var i1 = Math.min(points.length - 1, i0 + 1);
            var frac = pos - i0;
            return points[i0] + (points[i1] - points[i0]) * frac;
        }

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

        var difficulty = cfg && cfg.difficulty != null ? parseInt(cfg.difficulty, 10) : NaN;
        var tierBounds = getRotationBoundsForDifficulty(difficulty);
        var yawMax = cfg && cfg.rotationYawMax != null ? cfg.rotationYawMax : tierBounds.yaw;
        var pitchMax = cfg && cfg.rotationPitchMax != null ? cfg.rotationPitchMax : tierBounds.pitch;
        var rollMax = cfg && cfg.rotationRollMax != null ? cfg.rotationRollMax : tierBounds.roll;
        // When hidden points only need to be visible at fold=70
        // (finalStepOnly), pitch/roll must END at their peak — not
        // return to zero — so back-side faces are exposed at the
        // final state. Without this, yaw-only at final step keeps
        // the underside hidden and static-POV back-reveal fails.
        var tm = cfg && cfg.trackingEvalMode ? String(cfg.trackingEvalMode).trim().toLowerCase() : "";
        var exposeBackside = (tm === "finalsteponly" || tm === "finalstep" || tm === "final" || tm === "final-only" || tm === "final_step_only");

        // d1: static camera + static model. Tier semantics require ZERO
        // motion BETWEEN steps, but the model can sit at any fixed pose.
        // We sample multiple constant-rotation profiles (every step gets
        // the same non-zero rotation) to gain visual diversity beyond the
        // legacy "always flat from above" view. Per CLAUDE.md: d1 has no
        // motion across fold steps — frozen rotation respects this.
        //
        // Borrowing rotation magnitudes from d3 (yaw=0.5, pitch=0.15) so
        // d1 explores the same angular space d3 uses. Phase 2 will accept
        // the (POV, frozen-rotation) pairs that keep the anchor visible
        // at every fold; users see "same fold sequence from various tilted
        // angles" rather than the single boring default view.
        if (!isNaN(difficulty) && difficulty === 1) {
            // Use d3's rotation bounds for diversity sampling (yaw=0.5,
            // pitch=0.15, roll=0.08) unless the caller overrides via cfg.
            var d1YawMag = (cfg && cfg.rotationYawMax != null) ? Math.abs(cfg.rotationYawMax) : 0.5;
            var d1PitchMag = (cfg && cfg.rotationPitchMax != null) ? Math.abs(cfg.rotationPitchMax) : 0.15;
            var d1RollMag = (cfg && cfg.rotationRollMax != null) ? Math.abs(cfg.rotationRollMax) : 0.08;
            var d1Templates = [
                { name: "d1-static-zero",    yaw:  0,    pitch:  0,    roll:  0 },
                { name: "d1-static-yaw-pos", yaw:  1.0,  pitch:  0,    roll:  0 },
                { name: "d1-static-yaw-neg", yaw: -1.0,  pitch:  0,    roll:  0 },
                { name: "d1-static-pitch",   yaw:  0,    pitch:  1.0,  roll:  0 },
                { name: "d1-static-yp-pos",  yaw:  0.7,  pitch:  0.7,  roll:  0.5 },
                { name: "d1-static-yp-neg",  yaw: -0.7,  pitch:  0.7,  roll: -0.5 }
            ];
            var requestedD1 = (cfg && cfg.rotationProfileCount != null) ? cfg.rotationProfileCount : 6;
            var d1Count = Math.max(1, Math.min(requestedD1, d1Templates.length));
            var d1Profiles = [];
            for (var d1ti = 0; d1ti < d1Count; d1ti++) {
                var d1Tpl = d1Templates[d1ti];
                var d1Yaw   = Math.round(d1Tpl.yaw   * d1YawMag   * 1000) / 1000;
                var d1Pitch = Math.round(d1Tpl.pitch * d1PitchMag * 1000) / 1000;
                var d1Roll  = Math.round(d1Tpl.roll  * d1RollMag  * 1000) / 1000;
                var d1Rots = [];
                for (var d1si = 0; d1si < stepCount; d1si++) {
                    // Same rotation at every step = no inter-step motion.
                    d1Rots.push({ x: d1Pitch, y: d1Yaw, z: d1Roll });
                }
                d1Profiles.push({ name: d1Tpl.name, rotations: d1Rots });
            }
            return d1Profiles;
        }

        // d2: Phase 2 uses d4's RAMPING profiles (so it actually finds
        // back-exposing trajectories — constant rotation from step 0 makes
        // Phase 2 reject most trajectories because anchor fails visibility
        // at flat-paper-plus-max-tilt). The "no inter-step motion" contract
        // is enforced POST-PHASE-2 by normalizeStepsForDifficulty: for d2
        // it overrides every step's rotation with the FINAL step's value,
        // yielding a constant-rotation preset whose final pose matches
        // Phase 2's proven back-exposing state. User insight: "for d2 we
        // can use final states of d4 rather than manually finding angles."
        if (!isNaN(difficulty) && difficulty === 2) {
            var d2YawEnv = [0.00, 0.10, 0.22, 0.34, 0.46, 0.58, 0.70, 0.82, 0.92, 1.00];
            var d2PitchEnv = [0.00, 0.10, 0.22, 0.34, 0.46, 0.58, 0.70, 0.82, 0.92, 1.00];
            var d2RollEnv = [0.00, 0.04, 0.10, 0.18, 0.28, 0.40, 0.54, 0.70, 0.86, 1.00];
            var d2Templates = [
                { name: "d2-cw",            yaw:  1.00, pitch:  1.00, roll:  0.95 },
                { name: "d2-ccw",           yaw: -1.00, pitch: -1.00, roll: -0.95 },
                { name: "d2-cw-strong",     yaw:  1.12, pitch:  1.00, roll:  1.00 },
                { name: "d2-ccw-strong",    yaw: -1.12, pitch: -1.00, roll: -1.00 },
                { name: "d2-cw-pitch-neg",  yaw:  1.05, pitch: -0.60, roll:  0.82 },
                { name: "d2-ccw-pitch-neg", yaw: -1.05, pitch:  0.60, roll: -0.82 }
            ];
            var requestedD2 = (cfg && cfg.rotationProfileCount != null) ? cfg.rotationProfileCount : 6;
            var d2Count = Math.max(1, Math.min(requestedD2, d2Templates.length));
            var d2Profiles = [];
            for (var d2t = 0; d2t < d2Count; d2t++) {
                var d2Tpl = d2Templates[d2t];
                var d2Rots = [];
                for (var d2s = 0; d2s < stepCount; d2s++) {
                    var d2Norm = stepCount <= 1 ? 1 : (d2s / (stepCount - 1));
                    var d2Yaw = d2Tpl.yaw * yawMax * sampleEnvelope(d2YawEnv, d2Norm);
                    var d2Pitch = d2Tpl.pitch * pitchMax * sampleEnvelope(d2PitchEnv, d2Norm);
                    var d2Roll = d2Tpl.roll * rollMax * sampleEnvelope(d2RollEnv, d2Norm);
                    d2Rots.push({
                        x: Math.round(d2Pitch * 1000) / 1000,
                        y: Math.round(d2Yaw * 1000) / 1000,
                        z: Math.round(d2Roll * 1000) / 1000
                    });
                }
                d2Profiles.push({ name: d2Tpl.name, rotations: d2Rots });
            }
            return d2Profiles;
        }

        // d3 (single-side moderate motion): keep a fixed POV and use a
        // compact, low-amplitude rotation family with a mild late crest.
        // This preserves trackability while still creating clearly
        // meaningful object motion across fold steps.
        if (!exposeBackside && !isNaN(difficulty) && difficulty === 3) {
            var d3YawEnv = [0.00, 0.10, 0.22, 0.34, 0.48, 0.62, 0.76, 0.86, 0.95, 0.88];
            var d3PitchEnv = [0.00, 0.07, 0.13, 0.20, 0.28, 0.36, 0.44, 0.50, 0.54, 0.48];
            var d3RollEnv = [0.00, 0.01, 0.04, 0.07, 0.11, 0.15, 0.19, 0.23, 0.25, 0.21];

            var d3Templates = [
                { name: "d3-cw",         yaw:  1.00, pitch: 0.75, roll:  0.65 },
                { name: "d3-ccw",        yaw: -1.00, pitch: 0.75, roll: -0.65 },
                { name: "d3-cw-strong",  yaw:  1.08, pitch: 0.85, roll:  0.75 },
                { name: "d3-ccw-strong", yaw: -1.08, pitch: 0.85, roll: -0.75 },
                { name: "d3-cw-soft",    yaw:  0.72, pitch: 0.45, roll:  0.35 },
                { name: "d3-ccw-soft",   yaw: -0.72, pitch: 0.45, roll: -0.35 }
            ];

            var requestedD3 = cfg && cfg.rotationProfileCount != null ? cfg.rotationProfileCount : 6;
            var d3Count = Math.max(1, Math.min(requestedD3, d3Templates.length));
            var d3Profiles = [];
            for (var dti = 0; dti < d3Count; dti++) {
                var dt = d3Templates[dti];
                var d3Rots = [];
                for (var dsi = 0; dsi < stepCount; dsi++) {
                    var dtNorm = stepCount <= 1 ? 1 : (dsi / (stepCount - 1));
                    var dYaw = dt.yaw * yawMax * sampleEnvelope(d3YawEnv, dtNorm);
                    var dPitch = dt.pitch * pitchMax * sampleEnvelope(d3PitchEnv, dtNorm);
                    var dRoll = dt.roll * rollMax * sampleEnvelope(d3RollEnv, dtNorm);
                    d3Rots.push({
                        x: Math.round(dPitch * 1000) / 1000,
                        y: Math.round(dYaw * 1000) / 1000,
                        z: Math.round(dRoll * 1000) / 1000
                    });
                }
                d3Profiles.push({ name: dt.name, rotations: d3Rots });
            }
            return d3Profiles;
        }

        // d4 uses a compact bird-frontback style profile family. Per CLAUDE.md
        // "ramps monotonically (not bell-curve) so the final step reaches
        // full rotation magnitude — essential for the hidden-back-reveal
        // model." Earlier envelopes peaked mid-trajectory and *retracted*
        // at the final step (yaw 1.10 at index 8 → 1.00 at index 9), causing
        // back faces to slip back out of view exactly when the reveal should
        // be most visible. New envelopes ramp monotonically to 1.0 at final.
        if (exposeBackside && !isNaN(difficulty) && difficulty >= 4) {
            var birdYawEnv = [0.00, 0.10, 0.22, 0.34, 0.46, 0.58, 0.70, 0.82, 0.92, 1.00];
            var birdPitchEnv = [0.00, 0.10, 0.22, 0.34, 0.46, 0.58, 0.70, 0.82, 0.92, 1.00];
            var birdRollEnv = [0.00, 0.04, 0.10, 0.18, 0.28, 0.40, 0.54, 0.70, 0.86, 1.00];

            // d4: moderate two-sided motion.
            var birdTemplates = [
                { name: "bird-d4-cw",            yaw:  1.00, pitch:  1.00, roll:  0.95 },
                { name: "bird-d4-ccw",           yaw: -1.00, pitch: -1.00, roll: -0.95 },
                { name: "bird-d4-cw-strong",     yaw:  1.12, pitch:  1.00, roll:  1.00 },
                { name: "bird-d4-ccw-strong",    yaw: -1.12, pitch: -1.00, roll: -1.00 },
                { name: "bird-d4-cw-pitch-neg",  yaw:  1.05, pitch: -0.60, roll:  0.82 },
                { name: "bird-d4-ccw-pitch-neg", yaw: -1.05, pitch:  0.60, roll: -0.82 }
            ];

            var requestedBird = cfg && cfg.rotationProfileCount != null ? cfg.rotationProfileCount : 6;
            var birdCount = Math.max(1, Math.min(requestedBird, birdTemplates.length));
            var birdProfiles = [];

            for (var bti = 0; bti < birdCount; bti++) {
                var bt = birdTemplates[bti];
                var birdRots = [];
                for (var bsi = 0; bsi < stepCount; bsi++) {
                    var btNorm = stepCount <= 1 ? 1 : (bsi / (stepCount - 1));
                    var yaw = bt.yaw * yawMax * sampleEnvelope(birdYawEnv, btNorm);
                    var pitch = bt.pitch * pitchMax * sampleEnvelope(birdPitchEnv, btNorm);
                    var roll = bt.roll * rollMax * sampleEnvelope(birdRollEnv, btNorm);
                    birdRots.push({
                        x: Math.round(pitch * 1000) / 1000,
                        y: Math.round(yaw * 1000) / 1000,
                        z: Math.round(roll * 1000) / 1000
                    });
                }
                birdProfiles.push({ name: bt.name, rotations: birdRots });
            }
            return birdProfiles;
        }

        // Templates describe signed per-axis amplitudes as fractions of
        // {yawMax, pitchMax, rollMax}. Each template produces one profile
        // whose final-step rotation is (yaw*yawMax, pitch*pitchMax,
        // roll*rollMax) when exposeBackside=true (monotonic ramp).
        //
        // The default 6 templates remain yaw-dominant CW/CCW. When
        // exposeBackside=true (d2-hidden / d4), 4 extra templates
        // cover pitch-dominant + negative-pitch + roll-dominant — these
        // reach thin back pools (2–3 back faces) where a specific axis
        // direction is the only way to bring a back face into view.
        var baseTemplates = [
            { name: "cw-soft",   yaw:  0.75, pitch:  0.75, roll:  0.75 },
            { name: "cw-med",    yaw:  1.0,  pitch:  1.0,  roll:  1.0  },
            { name: "cw-strong", yaw:  1.2,  pitch:  1.2,  roll:  1.2  },
            { name: "ccw-soft",  yaw: -0.75, pitch:  0.75, roll: -0.75 },
            { name: "ccw-med",   yaw: -1.0,  pitch:  1.0,  roll: -1.0  },
            { name: "ccw-strong",yaw: -1.2,  pitch:  1.2,  roll: -1.2  }
        ];
        var expositionTemplates = exposeBackside ? [
            // Pitch-dominant (paper tips forward) — reveals back faces
            // under the leading edge from an above POV.
            { name: "pitch-pos",       yaw:  0.3, pitch:  1.2, roll:  0.0 },
            // Pitch-negative (paper tips back) — reveals back faces
            // under the trailing edge.
            { name: "pitch-neg",       yaw:  0.3, pitch: -1.2, roll:  0.0 },
            // Pitch-negative with opposite yaw — complements pitch-neg
            // to sweep more of the back hemisphere.
            { name: "pitch-neg-ccw",   yaw: -0.3, pitch: -1.2, roll:  0.0 },
            // Roll-dominant — rotates paper in its plane; useful when
            // back faces are along a diagonal axis.
            { name: "roll-pos",        yaw:  0.3, pitch:  0.3, roll:  1.2 }
        ] : [];
        var templates = baseTemplates.concat(expositionTemplates);
        // Default profile count: 6 (backwards compatible). When
        // expose-backside extras are present, bump the default to
        // cover them — the 4 exposition templates are the primary
        // reason this fix exists. User override via rotationProfileCount
        // still takes precedence.
        var defaultCount = exposeBackside ? Math.min(templates.length, 10) : 6;
        var requested = cfg && cfg.rotationProfileCount != null ? cfg.rotationProfileCount : defaultCount;
        var count = Math.max(1, Math.min(requested, templates.length));
        var profiles = [];
        for (var ti = 0; ti < count; ti++) {
            var tplt = templates[ti];
            var rots = [];
            for (var si2 = 0; si2 < stepCount; si2++) {
                var t = stepCount <= 1 ? 1 : (si2 / (stepCount - 1));
                var yaw = tplt.yaw * yawMax * t;
                var pitch = exposeBackside
                    ? tplt.pitch * pitchMax * t                 // monotonic ramp — peaks at final
                    : Math.abs(tplt.pitch) * pitchMax * 4 * t * (1 - t); // bell curve (non-expose keeps legacy shape)
                var roll = exposeBackside
                    ? tplt.roll * rollMax * t
                    : tplt.roll * rollMax * Math.sin(t * Math.PI);
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

    // Evaluate tracked-point visibility + screen-space separation at a step.
    //
    // Invariants (do NOT break):
    //   - Non-hidden tracked points MUST be visible at every step when
    //     mode === "strictAllSteps" (the default). This matches the human
    //     trackability requirement: "if a person couldn't follow the point
    //     with their eyes, the trajectory is invalid."
    //   - Hidden (pop-up) points are by design only checked at the final
    //     step — they are picked from the final-step visible set via the
    //     two-pass selection in presetGenerator.addHiddenPointsFromFinalStep.
    //   - `hidePointsDuringAnimation` is a RENDERING toggle only and must
    //     never influence this function. Visibility here is measured against
    //     geometry, not render state.
    function evaluateTrackedPoints(targetPointIndices, stepIndex, totalSteps, minPointSeparation, trackingEvalMode, enforceSeparationAllSteps) {
        var mode = normalizeTrackingEvalMode(trackingEvalMode);
        var isFinalStep = (stepIndex === totalSteps - 1);

        if (!targetPointIndices || targetPointIndices.length === 0) {
            return {
                ok: true,
                requiredCount: 0,
                visibleCount: 0,
                missingCount: 0,
                minSep: Infinity,
                mode: mode,
                reason: null
            };
        }

        var required = [];
        for (var i = 0; i < targetPointIndices.length; i++) {
            var idx = targetPointIndices[i];
            var hidden = globals.facePoints && globals.facePoints.isPointHidden ? globals.facePoints.isPointHidden(idx) : false;
            if (!hidden || isFinalStep) required.push(idx);
        }

        var visibleScreens = [];
        var missingCount = 0;
        for (var ri = 0; ri < required.length; ri++) {
            var rIdx = required[ri];
            var isVisible = !!(globals.facePoints && globals.facePoints.isPointVisible && globals.facePoints.isPointVisible(rIdx));
            var screen = isVisible ? getPointScreenPosition(rIdx) : null;
            if (!isVisible || !screen) {
                missingCount++;
                continue;
            }
            visibleScreens.push(screen);
        }

        if (missingCount > 0 && (mode === "strictAllSteps" || isFinalStep)) {
            return {
                ok: false,
                requiredCount: required.length,
                visibleCount: visibleScreens.length,
                missingCount: missingCount,
                minSep: 0,
                mode: mode,
                reason: "visibility"
            };
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

        var checkSeparation = isFinalStep || (mode === "strictAllSteps" && enforceSeparationAllSteps === true);
        if (checkSeparation && visibleScreens.length >= 2 && minSep < minPointSeparation) {
            return {
                ok: false,
                requiredCount: required.length,
                visibleCount: visibleScreens.length,
                missingCount: missingCount,
                minSep: minSep,
                mode: mode,
                reason: "separation"
            };
        }

        return {
            ok: true,
            requiredCount: required.length,
            visibleCount: visibleScreens.length,
            missingCount: missingCount,
            minSep: minSep,
            mode: mode,
            reason: null
        };
    }

    // ── Phase 2: live trajectory evaluation ──
    // Sets camera to each interpolated POV, measures actual face quality via getFaceViewQualities.
    // Keeps trajectories where all targetFaces stay >= minQuality at every step.

    // Cap how many face IDs participate in the per-step view-quality gate.
    // When cap === 2 and more faces are tracked, keep the lowest and highest
    // face indices so adjacent strip triangles (0,1,2) don't all have to
    // simultaneously satisfy a tight grazing-angle threshold.
    function capPhase2TargetFaces(faceIds, cap) {
        if (!faceIds || cap <= 0) return [];
        if (faceIds.length <= cap) return faceIds.slice();
        var sorted = faceIds.slice().sort(function (a, b) { return a - b; });
        if (cap === 2 && sorted.length >= 2) {
            return [sorted[0], sorted[sorted.length - 1]];
        }
        return sorted.slice(0, cap);
    }

    function evaluateTrajectoriesLive(candidates, targetFaces, minQuality, maxCount, settleMs, cfg, callback) {
        var validProgressions = [];
        var targetPointIndices = getTargetPointIndicesForCfg(cfg || {});
        var primaryTargetPointIndices = getPrimaryTargetPointIndicesForCfg(cfg || {});
        var initialTargetPointIndices = getNonHiddenPointIndices(targetPointIndices);
        var initialPrimaryTargetPointIndices = getNonHiddenPointIndices(primaryTargetPointIndices);
        var minPointSeparation = (cfg && cfg.minPointSeparationPx != null) ? cfg.minPointSeparationPx : 70;
        var enforceSeparationAllSteps = !!(cfg && cfg.enforceSeparationAllSteps);
        // Defaults to true: even in finalStepOnly modes, step 0 should show
        // the non-hidden anchor points so trajectories are trackable from the
        // beginning.
        var enforceInitialTrackedVisible = !(cfg && cfg.enforceInitialTrackedVisible === false);
        var trackingEvalMode = normalizeTrackingEvalMode(cfg && cfg.trackingEvalMode);
        // Verbose per-reject logs (reason=quality|tracked|primaryTracked|initialTracked|motion).
        // Default ON unless cfg.phase2VerboseRejects === false (quiet CI / prod runs).
        var phase2VerboseRejects = !(cfg && cfg.phase2VerboseRejects === false);
        // One-time diagnostic: log the target indices and tracking mode.
        // Phase 2 rejects every trajectory at step 1 when point indices are
        // empty/mis-aligned; this log line surfaces the state.
        try {
            var dbgPts = globals.facePoints && globals.facePoints.getPoints
                ? globals.facePoints.getPoints() : [];
            var dbgHidden = [];
            for (var _di = 0; _di < dbgPts.length; _di++) {
                if (dbgPts[_di] && dbgPts[_di].hidden) dbgHidden.push(_di);
            }
            console.log("benchmark: evaluateTrajectoriesLive: mode=" + trackingEvalMode +
                        " targets=[" + targetPointIndices.join(",") + "]" +
                        " primary=[" + primaryTargetPointIndices.join(",") + "]" +
                        " initialTargets=[" + initialTargetPointIndices.join(",") + "]" +
                        " initialPrimary=[" + initialPrimaryTargetPointIndices.join(",") + "]" +
                        " pointCount=" + dbgPts.length +
                        " hiddenIdx=[" + dbgHidden.join(",") + "]" +
                        " targetFaces=[" + (targetFaces || []).join(",") + "]" +
                        " minSepPx=" + minPointSeparation);
        } catch (_e) {}
        var phase2LogEveryMs = (cfg && cfg.phase2LogEveryMs != null) ? cfg.phase2LogEveryMs : 5000;
        var phase2StallWarnMs = (cfg && cfg.phase2StallWarnMs != null) ? cfg.phase2StallWarnMs : 30000;
        var minProgressionEndAngle = (cfg && cfg.minProgressionEndAngle != null) ? cfg.minProgressionEndAngle : 0.85;
        var minProgressionTotalAngle = (cfg && cfg.minProgressionTotalAngle != null) ? cfg.minProgressionTotalAngle : 1.75;
        var motionThresholds = getRotationMotionThresholdsForDifficulty(cfg && cfg.difficulty);
        var minRotationEndAngle = (cfg && cfg.minRotationEndAngle != null) ? cfg.minRotationEndAngle : motionThresholds.end;
        var minRotationTotalAngle = (cfg && cfg.minRotationTotalAngle != null) ? cfg.minRotationTotalAngle : motionThresholds.total;
        var minProgressionPairDistance = (cfg && cfg.minProgressionPairDistance != null) ? cfg.minProgressionPairDistance : 0.22;
        // Per-scan-candidate early-stop: once we have this many valid
        // progressions from the current evaluateTrajectoriesLive call,
        // skip the remaining trajectory/profile combos. Each scan
        // candidate only needs a handful of progressions for the outer
        // preset generator's diverse-select pass; evaluating all 40×6
        // combos per scan is typically 4–6× more work than needed.
        // Default: min(maxCount, 5) — enough diversity to feed selectDiverse
        // without over-spending time on a single face-pair.
        var phase2EarlyStopCount = (cfg && cfg.phase2EarlyStopCount != null)
            ? (cfg.phase2EarlyStopCount | 0)
            : Math.min(Math.max(3, maxCount | 0), 5);
        var rotationProfiles = buildAutoRotationProfiles(candidates[0] || [], cfg || {});
        var candidateCount = candidates.length;
        var profileCount = rotationProfiles.length;
        var totalProfiles = Math.max(1, candidateCount * profileCount);
        var phase2StartedAt = Date.now();
        var lastAdvanceAt = phase2StartedAt;
        var lastStallWarnAt = 0;
        var heartbeatTimer = null;
        var evaluationStats = {
            trackingEvalMode: trackingEvalMode,
            completedProfiles: 0,
            rejectedByQuality: 0,
            rejectedByTrackedPoints: 0,
            rejectedByPrimaryTrackedPoints: 0,
            rejectedByInitialTrackedPoints: 0,
            rejectedByMotionThresholds: 0,
            acceptedByMotionThresholds: 0,
            validBeforeDiversity: 0,
            selectedAfterDiversity: 0
        };

        function getCurrentStepCount() {
            if (currentTraj >= candidates.length) return 0;
            var traj = candidates[currentTraj] || [];
            return traj.length || 0;
        }

        function getCurrentProfileProgress() {
            var stepCount = getCurrentStepCount();
            if (stepCount <= 0) return 0;
            return Math.max(0, Math.min(1, currentStep / stepCount));
        }

        function emitPhase2Heartbeat() {
            var now = Date.now();
            var doneProfiles = Math.max(0, Math.min(totalProfiles, evaluationStats.completedProfiles));
            var partial = getCurrentProfileProgress();
            var estimatedDone = Math.max(0, Math.min(totalProfiles, doneProfiles + partial));
            var ratio = totalProfiles > 0 ? (estimatedDone / totalProfiles) : 0;
            var elapsedMs = now - phase2StartedAt;
            var etaMs = ratio > 0.0001 ? (elapsedMs * (1 - ratio) / ratio) : null;

            console.log(
                "benchmark: phase2 heartbeat " +
                "profiles " + doneProfiles + "/" + totalProfiles +
                " (~" + Math.round(ratio * 100) + "%)" +
                ", traj " + (Math.min(currentTraj + 1, candidateCount)) + "/" + candidateCount +
                ", profile " + (Math.min(currentProfile + 1, profileCount)) + "/" + profileCount +
                ", step " + (currentStep + 1) + "/" + Math.max(1, getCurrentStepCount()) +
                ", valid=" + validProgressions.length +
                ", elapsed=" + formatDurationMs(elapsedMs) +
                (etaMs !== null ? ", eta~" + formatDurationMs(etaMs) : "")
            );

            if (phase2StallWarnMs > 0 && (now - lastAdvanceAt) > phase2StallWarnMs && (now - lastStallWarnAt) > Math.max(5000, Math.floor(phase2StallWarnMs / 2))) {
                lastStallWarnAt = now;
                console.warn(
                    "benchmark: phase2 slow/stalled for " + formatDurationMs(now - lastAdvanceAt) +
                    " at traj " + (Math.min(currentTraj + 1, candidateCount)) + "/" + candidateCount +
                    ", profile " + (Math.min(currentProfile + 1, profileCount)) + "/" + profileCount +
                    ", step " + (currentStep + 1) + "/" + Math.max(1, getCurrentStepCount())
                );
            }
        }

        if (phase2LogEveryMs > 0) {
            heartbeatTimer = setInterval(emitPhase2Heartbeat, phase2LogEveryMs);
        }

        function stopPhase2Heartbeat() {
            if (heartbeatTimer) {
                clearInterval(heartbeatTimer);
                heartbeatTimer = null;
            }
        }

        // Flatten all trajectory steps into a sequential evaluation queue.
        // We evaluate one trajectory at a time, step by step.
        var currentTraj = 0;
        var currentStep = 0;
        var currentProfile = 0;
        var currentFaceStats = {}; // fid -> { worst, seenSteps }
        // Final-step viewability score (0..1). Set when the final step's
        // quality/tracked/primary checks pass; read at the validProgressions
        // push site so selectDiverseProgressions prefers clearer poses.
        var currentFinalViewScore = 0;
        // Per-step visibility records for the trajectory currently under
        // evaluation. Populated by recordStepVisibility() at every step
        // (and replaced by the 800ms recheck values at the final step).
        // Attached to the accepted progression at validProgressions.push
        // so callers can do post-hoc face-point selection from the timeline
        // instead of pre-baking face IDs into Phase 2's input.
        var currentVisibilityTimeline = [];

        // Used by trajectory-first selection (selectFacePointsFromTrajectory in
        // presetGenerator.js). Lightweight: only stores the face IDs visible at
        // each step and their quality scores — already computed for the quality
        // gate, so no extra GPU work.
        function recordStepVisibility(step, stepRot, visibleFaceIds, qualityMap) {
            // Also record faces whose BACK side is camera-facing — used by
            // selectFacePointsFromTrajectory to detect d2/d4 hidden-back
            // candidates. Without this the timeline only knows about
            // front-facing faces and can't tell whether a back surface is
            // exposed at the final step.
            var backSideVisibleFaceIds = [];
            try {
                if (globals.facePoints && globals.facePoints.getBackSideVisibleFaceIds) {
                    backSideVisibleFaceIds = globals.facePoints.getBackSideVisibleFaceIds();
                }
            } catch (_e) {}
            currentVisibilityTimeline.push({
                stepIndex: currentStep,
                fold: step.fold,
                pov: step.pov,
                rotation: stepRot ? [stepRot.x, stepRot.y, stepRot.z] : null,
                visibleFaceIds: (visibleFaceIds || []).slice(),
                qualities: qualityMap ? Object.assign({}, qualityMap) : {},
                backSideVisibleFaceIds: backSideVisibleFaceIds
            });
        }

        function skipCurrentTrajectoryProfile(reason) {
            evaluationStats.completedProfiles++;
            lastAdvanceAt = Date.now();
            if (reason === "quality") evaluationStats.rejectedByQuality++;
            if (reason === "tracked") evaluationStats.rejectedByTrackedPoints++;
            if (reason === "primaryTracked") evaluationStats.rejectedByPrimaryTrackedPoints++;
            if (reason === "initialTracked") evaluationStats.rejectedByInitialTrackedPoints++;
            if (reason === "motion") evaluationStats.rejectedByMotionThresholds++;
            if (phase2VerboseRejects) {
                try {
                    console.log("benchmark: Phase 2: reject traj " + (currentTraj + 1) +
                                " profile " + (currentProfile + 1) +
                                " at step " + (currentStep + 1) +
                                " reason=" + (reason || "unknown"));
                } catch (_ee) {}
            }
            currentProfile++;
            if (currentProfile >= profileCount) {
                currentProfile = 0;
                currentTraj++;
            }
            currentStep = 0;
            currentFaceStats = {};
            currentFinalViewScore = 0;
            currentVisibilityTimeline = [];
        }

        // Score the final-pose viewability of tracked points.
        // Returns a scalar in [0, 1].
        //
        // Base term (all tiers): mean per-point clarity where each visible
        // tracked point contributes:
        //   edge-margin * nearest-neighbor-separation * face-quality
        //
        // Both-side term (two-sided tracking configs): add a balance-aware
        // term so "one side excellent, other side barely visible" ranks low.
        // Side grouping uses two strategies:
        //   1) hidden-vs-visible split (preferred). For two-pass d4
        //      presets, revealed points are encoded as hidden=true and often
        //      live on front-indexed face IDs, so faceId sign alone cannot
        //      detect the two sides reliably.
        //   2) front-vs-back faceId split (fallback).
        // This keeps both-side ranking active for d4 even when hidden
        // reveal points use normalized face IDs.
        //
        // Back-side points read 0 from getFaceViewQualities (that function
        // uses front normals), so we treat visible back-side points as a
        // neutral quality baseline of 0.5 to avoid unfairly penalising them.
        function computeFinalViewScore(qualityMap) {
            if (!targetPointIndices || targetPointIndices.length === 0) return 0;
            var canvas = globals.threeView && globals.threeView.renderer ? globals.threeView.renderer.domElement : null;
            var canvasW = canvas && canvas.width ? canvas.width : 1024;
            var canvasH = canvas && canvas.height ? canvas.height : 1024;
            var faces = globals.model && globals.model.getFaces ? globals.model.getFaces() : [];
            var modelN = faces ? faces.length : 0;
            var pts = globals.facePoints && globals.facePoints.getPoints ? globals.facePoints.getPoints() : [];
            var screens = [];
            var trackedSides = { front: false, back: false };
            var trackedHidden = { hidden: false, visible: false };
            for (var fi = 0; fi < targetPointIndices.length; fi++) {
                var idx = targetPointIndices[fi];
                var pt = pts[idx];
                var fid = pt && pt.faceId != null ? pt.faceId : -1;
                var hidden = globals.facePoints && globals.facePoints.isPointHidden
                    ? !!globals.facePoints.isPointHidden(idx) : false;
                var side = null;
                if (fid >= 0 && fid < modelN) {
                    side = "front";
                    trackedSides.front = true;
                } else if (fid >= modelN && fid < modelN * 2) {
                    side = "back";
                    trackedSides.back = true;
                }
                if (hidden) trackedHidden.hidden = true;
                else trackedHidden.visible = true;
                if (!globals.facePoints || !globals.facePoints.isPointVisible || !globals.facePoints.isPointVisible(idx)) continue;
                var scr = getPointScreenPosition(idx);
                if (!scr) continue;
                var triIdx = (fid >= modelN) ? (fid - modelN) : fid;
                var rawQ = (qualityMap && qualityMap[triIdx] != null) ? qualityMap[triIdx] : 0;
                screens.push({ x: scr.x, y: scr.y, q: rawQ, side: side, hidden: hidden });
            }
            if (screens.length === 0) return 0;
            var sum = 0;
            var sideSums = {};
            var sideCounts = {};
            var useHiddenSplit = trackedHidden.hidden && trackedHidden.visible;
            var useFaceSplit = !useHiddenSplit && trackedSides.front && trackedSides.back;
            for (var j = 0; j < screens.length; j++) {
                var s = screens[j];
                var edge = Math.min(s.x, s.y, Math.max(0, canvasW - s.x), Math.max(0, canvasH - s.y));
                var minN = Infinity;
                for (var k = 0; k < screens.length; k++) {
                    if (k === j) continue;
                    var dx = s.x - screens[k].x;
                    var dy = s.y - screens[k].y;
                    var d = Math.sqrt(dx * dx + dy * dy);
                    if (d < minN) minN = d;
                }
                if (!isFinite(minN)) minN = minPointSeparation * 2;
                var eClamp = Math.max(0, Math.min(1, edge / 120));
                var nClamp = Math.max(0, Math.min(1, minN / Math.max(1, minPointSeparation * 1.25)));
                var q = s.q > 0 ? s.q : 0.5;
                var qClamp = Math.pow(Math.max(0, Math.min(1, q)), 0.75);
                var pointScore = eClamp * nClamp * qClamp;
                sum += pointScore;
                var sideKey = null;
                if (useHiddenSplit) sideKey = s.hidden ? "reveal" : "initial";
                else if (useFaceSplit && (s.side === "front" || s.side === "back")) sideKey = s.side;
                if (sideKey !== null) {
                    if (sideSums[sideKey] == null) sideSums[sideKey] = 0;
                    if (sideCounts[sideKey] == null) sideCounts[sideKey] = 0;
                    sideSums[sideKey] += pointScore;
                    sideCounts[sideKey]++;
                }
            }
            var meanScore = sum / screens.length;
            var expectsBothSides = useHiddenSplit || useFaceSplit;
            if (!expectsBothSides) return meanScore;

            // If both sides are tracked, reward trajectories where BOTH are
            // strong and balanced. A weak side drags the score down sharply.
            var sideAKey = useHiddenSplit ? "initial" : "front";
            var sideBKey = useHiddenSplit ? "reveal" : "back";
            var sideA = sideCounts[sideAKey] > 0 ? (sideSums[sideAKey] / sideCounts[sideAKey]) : 0;
            var sideB = sideCounts[sideBKey] > 0 ? (sideSums[sideBKey] / sideCounts[sideBKey]) : 0;
            var sideGeom = Math.sqrt(Math.max(0, sideA) * Math.max(0, sideB));
            var hi = Math.max(sideA, sideB);
            var lo = Math.min(sideA, sideB);
            var balanceRatio = hi > 1e-8 ? (lo / hi) : 0;
            return (0.35 * meanScore) + (0.45 * sideGeom) + (0.20 * balanceRatio);
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
                    if (stat.seenSteps === totalSteps && stat.worst >= minQuality) {
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
                var finalViewScore = currentFinalViewScore || 0;
                var score = 0;
                score += Math.min(1, metrics.endAngle / Math.max(0.1, minProgressionEndAngle));
                score += Math.min(1, metrics.totalAngle / Math.max(0.1, minProgressionTotalAngle));
                if (minRotationEndAngle > 0) {
                    score += Math.min(1, metrics.rotationEndAngle / Math.max(0.1, minRotationEndAngle));
                }
                if (minRotationTotalAngle > 0) {
                    score += Math.min(1, metrics.rotationTotalAngle / Math.max(0.1, minRotationTotalAngle));
                }
                score += Object.keys(consistentFaces).length * 0.02;
                score += trackedStepBonus;
                // Final-pose viewability: favour trajectories whose tracked
                // points sit well inside the canvas, away from each other,
                // on faces that face the camera. This replaces the old
                // "first valid profile wins" bias with a clarity-based rank.
                score += finalViewScore * 1.5;

                var meetsPovMotion = (metrics.endAngle >= minProgressionEndAngle && metrics.totalAngle >= minProgressionTotalAngle);
                var meetsRotationMotion = (metrics.rotationEndAngle >= minRotationEndAngle && metrics.rotationTotalAngle >= minRotationTotalAngle);
                if (meetsPovMotion && meetsRotationMotion) {
                    validProgressions.push({
                        steps: cleanSteps,
                        consistentFaces: consistentFaces,
                        score: Math.round(score * 1000) / 1000,
                        finalViewScore: Math.round(finalViewScore * 1000) / 1000,
                        metrics: {
                            endAngle: Math.round(metrics.endAngle * 1000) / 1000,
                            totalAngle: Math.round(metrics.totalAngle * 1000) / 1000,
                            rotationEndAngle: Math.round(metrics.rotationEndAngle * 1000) / 1000,
                            rotationTotalAngle: Math.round(metrics.rotationTotalAngle * 1000) / 1000
                        },
                        // Per-step {visibleFaceIds, qualities} for the trajectory.
                        // Used by trajectory-first face-point selection in
                        // presetGenerator.js (selectFacePointsFromTrajectory).
                        visibilityTimeline: currentVisibilityTimeline.slice()
                    });
                    evaluationStats.acceptedByMotionThresholds++;
                } else {
                    evaluationStats.rejectedByMotionThresholds++;
                }

                skipCurrentTrajectoryProfile();

                // Early-stop: if we have enough valid progressions from
                // this face-pair, skip remaining trajectories. Jump
                // currentTraj to candidates.length so the next loop iter
                // falls into the "done" branch. (Diversity is preserved —
                // outer loop will try other face-pair scan candidates.)
                if (phase2EarlyStopCount > 0 && validProgressions.length >= phase2EarlyStopCount && currentTraj < candidates.length) {
                    var skipped = candidates.length - currentTraj;
                    if (skipped > 0) {
                        console.log("benchmark: phase2 early-stop — " + validProgressions.length + " valid progressions collected, skipping " + skipped + " remaining trajector(y/ies)");
                    }
                    currentTraj = candidates.length;
                }
            }

            if (currentTraj >= candidates.length) {
                stopPhase2Heartbeat();
                var selected = selectDiverseProgressions(validProgressions, maxCount, minProgressionPairDistance);
                evaluationStats.validBeforeDiversity = validProgressions.length;
                evaluationStats.selectedAfterDiversity = selected.length;
                emitPhase2Heartbeat();
                console.log("evaluateTrajectoriesLive: " + validProgressions.length + " valid candidates out of " + candidates.length + ", selected " + selected.length);
                callback(selected, evaluationStats);
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

                var isFinalStep = (currentStep === candidates[currentTraj].length - 1);
                var validationSettleMs = 800;
                var extraSettle = Math.max(0, validationSettleMs - settleMs);

                // Final-step correctness gate. The first 300ms Phase 2
                // settle is too short to measure final-pose quality and
                // back-face visibility reliably — the mesh is still
                // transitioning. Defer all final-step checks to the
                // recheck block at 800ms settle (matching the validator's
                // settle time) to avoid rejecting correct trajectories
                // that haven't finished settling yet.
                //
                // Quality gate: only applied for strictAllSteps mode.
                // finalStepOnly accepts any trajectory whose tracked
                // points are visible and well-separated at the final
                // pose — face view quality (an angle-to-camera proxy)
                // is a legitimate concern only when we require ALL steps
                // to look clean. isPointVisible already enforces the
                // stricter frontfacing + occlusion test that matters.
                if (isFinalStep && extraSettle > 0) {
                    setTimeout(function () {
                        try {
                            var reVisibleFaceIds = globals.facePoints && globals.facePoints.getVisibleFaceIds
                                ? globals.facePoints.getVisibleFaceIds() : [];
                            var reFaceQualities = globals.facePoints && globals.facePoints.getFaceViewQualities
                                ? globals.facePoints.getFaceViewQualities(reVisibleFaceIds) : {};
                            if (step.fold > 0 && trackingEvalMode !== "finalStepOnly") {
                                for (var rti = 0; rti < targetFaces.length; rti++) {
                                    var rq = reFaceQualities[targetFaces[rti]] || 0;
                                    if (rq < minQuality) {
                                        skipCurrentTrajectoryProfile("quality");
                                        evaluateNext();
                                        return;
                                    }
                                }
                            }
                            faceQualities = reFaceQualities;
                            var recheckTracked = evaluateTrackedPoints(targetPointIndices, currentStep, candidates[currentTraj].length, minPointSeparation, trackingEvalMode, enforceSeparationAllSteps);
                            if (!recheckTracked.ok) {
                                skipCurrentTrajectoryProfile("tracked");
                                evaluateNext();
                                return;
                            }
                            var recheckPrimary = evaluateTrackedPoints(primaryTargetPointIndices, currentStep, candidates[currentTraj].length, minPointSeparation, trackingEvalMode, enforceSeparationAllSteps);
                            if (!recheckPrimary.ok) {
                                skipCurrentTrajectoryProfile("primaryTracked");
                                evaluateNext();
                                return;
                            }
                            if (enforceInitialTrackedVisible && currentStep === 0) {
                                var recheckInitialTracked = evaluateTrackedPoints(initialTargetPointIndices, currentStep, candidates[currentTraj].length, minPointSeparation, "strictAllSteps", enforceSeparationAllSteps);
                                if (!recheckInitialTracked.ok) {
                                    skipCurrentTrajectoryProfile("initialTracked");
                                    evaluateNext();
                                    return;
                                }
                                var recheckInitialPrimary = evaluateTrackedPoints(initialPrimaryTargetPointIndices, currentStep, candidates[currentTraj].length, minPointSeparation, "strictAllSteps", enforceSeparationAllSteps);
                                if (!recheckInitialPrimary.ok) {
                                    skipCurrentTrajectoryProfile("initialTracked");
                                    evaluateNext();
                                    return;
                                }
                            }
                            currentFinalViewScore = computeFinalViewScore(reFaceQualities);
                            recordStepVisibility(step, stepRot, reVisibleFaceIds, reFaceQualities);
                            recordFaceStatsAndAdvance();
                        } catch (err2) {
                            console.warn("benchmark: final-step recheck error; skipping candidate", err2);
                            skipCurrentTrajectoryProfile("error");
                            evaluateNext();
                        }
                    }, extraSettle);
                    return;
                }

                // Non-final step checks. For finalStepOnly, skip quality
                // and tracked checks at intermediate steps — the back
                // face may be partially occluded mid-transition and
                // that is fine. For strictAllSteps, enforce quality at
                // all non-zero steps (except the final, handled above).
                var qualityGateActive = (step.fold > 0) &&
                    (trackingEvalMode !== "finalStepOnly");
                if (qualityGateActive) {
                    for (var ti = 0; ti < targetFaces.length; ti++) {
                        var q = faceQualities[targetFaces[ti]] || 0;
                        if (q < minQuality) {
                            skipCurrentTrajectoryProfile("quality");
                            evaluateNext();
                            return;
                        }
                    }
                }

                var trackedEval = evaluateTrackedPoints(targetPointIndices, currentStep, candidates[currentTraj].length, minPointSeparation, trackingEvalMode, enforceSeparationAllSteps);
                if (!trackedEval.ok) {
                    skipCurrentTrajectoryProfile("tracked");
                    evaluateNext();
                    return;
                }

                var primaryTrackedEval = evaluateTrackedPoints(primaryTargetPointIndices, currentStep, candidates[currentTraj].length, minPointSeparation, trackingEvalMode, enforceSeparationAllSteps);
                if (!primaryTrackedEval.ok) {
                    skipCurrentTrajectoryProfile("primaryTracked");
                    evaluateNext();
                    return;
                }

                if (enforceInitialTrackedVisible && currentStep === 0) {
                    var initialTrackedEval = evaluateTrackedPoints(initialTargetPointIndices, currentStep, candidates[currentTraj].length, minPointSeparation, "strictAllSteps", enforceSeparationAllSteps);
                    if (!initialTrackedEval.ok) {
                        skipCurrentTrajectoryProfile("initialTracked");
                        evaluateNext();
                        return;
                    }
                    var initialPrimaryTrackedEval = evaluateTrackedPoints(initialPrimaryTargetPointIndices, currentStep, candidates[currentTraj].length, minPointSeparation, "strictAllSteps", enforceSeparationAllSteps);
                    if (!initialPrimaryTrackedEval.ok) {
                        skipCurrentTrajectoryProfile("initialTracked");
                        evaluateNext();
                        return;
                    }
                }

                if (isFinalStep) {
                    currentFinalViewScore = computeFinalViewScore(faceQualities);
                }
                recordStepVisibility(step, stepRot, allVisibleFaceIds, faceQualities);
                recordFaceStatsAndAdvance();

                function recordFaceStatsAndAdvance() {
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
                    lastAdvanceAt = Date.now();
                    evaluateNext();
                }
                } catch (err) {
                    console.warn("benchmark: trajectory eval error; skipping candidate", err);
                    skipCurrentTrajectoryProfile("error");
                    evaluateNext();
                }
            }, settleMs);
        }

        evaluateNext();
    }

    // ── Scan mode: dense fold × POV face-visibility discovery (no screenshots) ──

    function runScan(cfg, onComplete) {
        // Apply colorMode + facePoints so phase-2 trajectory evaluation can
        // actually see the tracked points. Without this, runScan never
        // initializes globals.facePoints from cfg.facePoints and
        // isPointVisible() rejects every trajectory at step 1.
        applySettings(cfg);
        var foldSteps = cfg.scanFoldSteps || [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
        var povs      = cfg.scanPovs      || ["y", "-y", "z", "-z", "x", "-x", "iso"];
        // If povGridSize is set, generate a continuous POV grid instead
        if (cfg.povGridSize && !cfg.scanPovs) {
            var grid = generatePovGrid(cfg.povGridSize, {
                minY: cfg.minPovY != null ? cfg.minPovY : 0.3,
                maxY: cfg.maxPovY != null ? cfg.maxPovY : 0.95
            });
            // Include standard named POVs as well for completeness
            povs = ["y", "-y", "z", "-z", "x", "-x", "iso"].concat(grid);
        }
        var settleMs  = cfg.scanSettleMs  != null ? cfg.scanSettleMs : 300;
        var name      = currentBenchmarkName || globals.filename || "scan";
        var useScanCache = cfg.useScanCache !== false;
        var forceRescan = cfg.forceRescan === true;
        var cacheKey = buildScanCacheKey(cfg, foldSteps);
        var maxTrajectoryCandidates = (cfg.maxTrajectoryCandidates != null) ? parseInt(cfg.maxTrajectoryCandidates, 10) : 0;

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
                    var faceCount = (globals.model && globals.model.getFaces) ? globals.model.getFaces().length : 0;
                    var targetFaces = normalizeFaceIdList(cfg.targetFaces || [], faceCount);
                    if (targetFaces.length === 0 && cfg.facePoints) {
                        if (Array.isArray(cfg.facePoints)) {
                            cfg.facePoints.forEach(function (p) {
                                if (p.faceId != null) {
                                    var normalizedId = normalizeFaceIdToFront(p.faceId, faceCount);
                                    if (normalizedId !== null && targetFaces.indexOf(normalizedId) === -1) targetFaces.push(normalizedId);
                                }
                            });
                        } else {
                            Object.keys(cfg.facePoints).forEach(function (k) {
                                var normalizedId = normalizeFaceIdToFront(k, faceCount);
                                if (normalizedId !== null && targetFaces.indexOf(normalizedId) === -1) targetFaces.push(normalizedId);
                            });
                        }
                    }
                    var progQuality = cfg.minFaceQuality != null ? cfg.minFaceQuality : 0.35;
                    var maxTargetFaces = cfg.phase2MaxTargetFaces;
                    if ((maxTargetFaces === undefined || maxTargetFaces === null) && cfg.difficulty === 1) {
                        maxTargetFaces = 2;
                    }
                    if (maxTargetFaces != null && maxTargetFaces > 0 && targetFaces.length > maxTargetFaces) {
                        var beforeCap = targetFaces.slice();
                        targetFaces = capPhase2TargetFaces(targetFaces, maxTargetFaces);
                        console.log("benchmark: Phase 2: capped targetFaces from [" + beforeCap.join(",") + "] to [" + targetFaces.join(",") + "] (phase2MaxTargetFaces=" + maxTargetFaces + ")");
                    }
                    var progCount = typeof cfg.buildProgressions === "number" ? cfg.buildProgressions : 20;
                    var candidates = generateCandidateTrajectories(scanStates, foldSteps, progCount, {
                        staticPov: true
                    });
                    if (!isNaN(maxTrajectoryCandidates) && maxTrajectoryCandidates > 0 && candidates.length > maxTrajectoryCandidates) {
                        console.log("benchmark: capping phase 2 trajectories from " + candidates.length + " to " + maxTrajectoryCandidates);
                        candidates = candidates.slice(0, maxTrajectoryCandidates);
                    }

                    updateStatus("Phase 2: evaluating " + candidates.length + " trajectories live…");
                    evaluateTrajectoriesLive(candidates, targetFaces, progQuality, progCount, settleMs, cfg, function (diverseProgressions, progressionStats) {
                        if (useScanCache && !forceRescan) {
                            saveScanCache(cacheKey, {
                                cacheKey: cacheKey,
                                benchmark: name,
                                foldSteps: foldSteps,
                                povCount: povs.length,
                                scanStates: scanStates
                            });
                        }
                        finishScan(suggestedSequences, diverseProgressions, progressionStats);
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

                finishScan(suggestedSequences, [], null);
                return;

                function finishScan(suggestedSequences, diverseProgressions, progressionStats) {
                    var result = {
                        benchmark:          name,
                        model:              cfg.model || null,
                        totalFaces:         totalFaces,
                        scanPovs:           povs.length > 20 ? povs.length + " POVs (grid)" : povs,
                        scanFoldSteps:      foldSteps,
                        suggestedSequences: suggestedSequences,
                        diverseProgressions: diverseProgressions.length > 0 ? diverseProgressions : undefined,
                        progressionStats:   progressionStats || undefined,
                        povAnalysis:        cfg.povGridSize ? undefined : povAnalysis
                    };

                    if (cfg.saveScanResult !== false) {
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
                    }

                    running = false;
                    if (diverseProgressions.length > 0) {
                        updateStatus("Scan complete. Built " + diverseProgressions.length + " diverse progressions.");
                        console.log("benchmark: scan complete, " + diverseProgressions.length + " progressions:", diverseProgressions);
                    } else {
                        var count = suggestedSequences && suggestedSequences.length ? suggestedSequences.length : 0;
                        updateStatus("Scan complete. Suggested sequences: " + count);
                    }
                    console.log("benchmark: scan complete, suggestedSequences:", suggestedSequences);
                    if (onComplete) onComplete(result);
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
        jsonlStepIndex = 0;
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
                            showStepNumber(1, 2);
                            updateStatus("Capturing end state…");
                            captureFinalWithBothStyles(stepLabel(anim.to != null ? anim.to : 90, endPov), stepLabel(anim.to != null ? anim.to : 90, endPov), cfg.labelStyle, function () {
                                hideStepNumber();
                                console.log("benchmark: fold animation complete");
                                if (onComplete) onComplete();
                            });
                        } else {
                            hideStepNumber();
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
                        showStepNumber(0, 2);
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
        // Reset JSONL batch state so the first preset of this run truncates
        // dataset.jsonl (subsequent presets append).
        jsonlBatchStarted = false;
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
    //
    // Model cache: if the requested model is already loaded (same path AND
    // mesh faces present), skip importDemoFile and just apply settings.
    // Saves ~1-2s per preset on shards that share a model, which is the
    // common case in dataset rendering (e.g. a 50-preset birdBase shard
    // re-parses the SVG 50 times today). run() resets fold + rotation on
    // its first call, so simulation state from the previous preset doesn't
    // leak through.
    function selectPresetFromConfig(name, cfg, callback) {
        currentBenchmarkName = name;
        config = cfg;
        // Compute a question id for this preset so captureScreenshot writes
        // PNGs under images/<id>/ and saveBenchmarkSummary's JSONL row uses
        // the same id.
        currentJsonlId = buildJsonlId(name, cfg && cfg.model, cfg && cfg.difficulty);
        if (cfg.model) {
            var requestedModel = cfg.model.replace(/'/g, '');
            var modelAlreadyLoaded = false;
            try {
                var faces = (globals.model && globals.model.getFaces) ? globals.model.getFaces() : null;
                modelAlreadyLoaded = (globals.loadedModel === requestedModel) && faces && faces.length > 0;
            } catch (_e) {}

            if (modelAlreadyLoaded) {
                applySettings(cfg);
                if (callback) callback();
                return;
            }

            globals.loadedModel = requestedModel;
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

    function ensureJsonPathOption(path) {
        if (!path || !$("#benchmarkJsonPath").length) return;
        var $sel = $("#benchmarkJsonPath");
        var exists = false;
        $sel.find("option").each(function () {
            if ($(this).val() === path) {
                exists = true;
                return false;
            }
        });
        if (!exists) {
            $sel.append($("<option></option>").attr("value", path).text(path));
        }
    }

    function refreshJsonPaths(selectedPath, callback) {
        var $sel = $("#benchmarkJsonPath");
        var pathFromUrl = getParam("benchmarks");
        var targetPath = selectedPath || pathFromUrl || ($sel.length ? $sel.val() : null) || "benchmarks.json";

        if (!$sel.length) {
            if (callback) callback(targetPath);
            return;
        }

        var basePaths = [];
        $sel.find("option").each(function () {
            var v = $(this).val();
            if (v && basePaths.indexOf(v) === -1) basePaths.push(v);
        });
        if (basePaths.length === 0) basePaths.push("benchmarks.json");

        $.getJSON("/api/candidates?_=" + Date.now())
            .done(function (resp) {
                var candidates = (resp && Array.isArray(resp.files)) ? resp.files : [];
                var allPaths = basePaths.slice();
                candidates.forEach(function (path) {
                    if (allPaths.indexOf(path) === -1) allPaths.push(path);
                });
                if (targetPath && allPaths.indexOf(targetPath) === -1) allPaths.push(targetPath);

                $sel.empty();
                allPaths.forEach(function (path) {
                    $sel.append($("<option></option>").attr("value", path).text(path));
                });
                $sel.val(targetPath);
            })
            .fail(function () {
                ensureJsonPathOption(targetPath);
                $sel.val(targetPath);
            })
            .always(function () {
                if (callback) callback($sel.val() || targetPath || "benchmarks.json");
            });
    }

    // ── Public: initialize — called from main.js before model load ──
    // loadModelCallback(modelPath) is called once config is parsed,
    // passing the model path to load (from benchmark preset, URL, or null for default).

    function init(cb) {
        loadModelCallback = cb;
        refreshJsonPaths(null, function (jsonPath) {
            $.getJSON(jsonPath + "?_=" + Date.now())
                .done(function (loaded) {
                    presets = loaded;
                    config = buildConfig(presets);
                    populatePresetDropdown();
                    startWatching(jsonPath);
                    onConfigReady(cb);
                })
                .fail(function () {
                    presets = null;
                    config = buildConfig(null);
                    updateStatus("No benchmark JSON found at " + jsonPath + ".");
                    onConfigReady(cb);
                });
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

    function populateStepSelect() {
        var $sel = $("#benchmarkStepSelect");
        if (!$sel.length) return;
        $sel.empty();
        if (!config || !config.steps || config.steps.length === 0) {
            $sel.append("<option value=''>— no steps —</option>");
            return;
        }
        for (var i = 0; i < config.steps.length; i++) {
            var s = config.steps[i];
            var desc = "Step " + (i + 1) + ": fold " + s.fold + "%";
            if (s.pov) desc += ", " + (Array.isArray(s.pov) ? "[" + s.pov.join(",") + "]" : s.pov);
            if (s.rotation) desc += " +rot";
            $sel.append($("<option></option>").attr("value", i).text(desc));
        }
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
                populateStepSelect();
            });
        } else {
            applySettings(config);
            updateStatus("Preset \"" + name + "\" applied. " + config.steps.length + " steps.");
            populateStepSelect();
        }
    }

    function onConfigReady(cb) {
        var benchmarkName = getParam("benchmark");
        if (benchmarkName && $("#benchmarkPresetSelect").length) {
            $("#benchmarkPresetSelect").val(benchmarkName);
        }
        var benchmarksPath = getParam("benchmarks");
        if (benchmarksPath && $("#benchmarkJsonPath").length) {
            ensureJsonPathOption(benchmarksPath);
            $("#benchmarkJsonPath").val(benchmarksPath);
        }
        var benchmarkModel = config ? config.model : null;
        if (cb) cb(benchmarkModel);

        if (!config && !getParamBool("runAll")) return;

        waitForModelLoad(function () {
            if (config) {
                applySettings(config);
                var readyStepCount = (config.steps && config.steps.length) ? config.steps.length : 0;
                if (config.scanMode) {
                    updateStatus("Benchmark ready: scan mode (" + readyStepCount + " steps).");
                } else {
                    updateStatus("Benchmark ready: " + readyStepCount + " steps.");
                }
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

    function loadJson(path, silent) {
        if (!path) return;
        $.getJSON(path + "?_=" + Date.now())
            .done(function (loaded) {
                presets = loaded;
                var prevPreset = currentBenchmarkName;
                populatePresetDropdown();
                // re-select and refresh current preset if it still exists
                if (prevPreset && presets[prevPreset]) {
                    var prevStep = parseInt($("#benchmarkStepSelect").val(), 10);
                    config = $.extend(true, {}, presets[prevPreset]);
                    if (!config.pauseDuration) config.pauseDuration = 2;
                    if (!config.steps) config.steps = [{ fold: 0, pov: "iso" }];
                    $("#benchmarkPresetSelect").val(prevPreset);
                    populateStepSelect();
                    if (!isNaN(prevStep) && prevStep >= 0 && config.steps && prevStep < config.steps.length) {
                        $("#benchmarkStepSelect").val(prevStep);
                    }
                    if (!silent) updateStatus("Reloaded \"" + prevPreset + "\" (" + config.steps.length + " steps).");
                } else {
                    if (!silent) updateStatus("Loaded " + Object.keys(loaded).length + " presets from " + path);
                }
            })
            .fail(function () {
                if (!silent) {
                    presets = null;
                    populatePresetDropdown();
                    updateStatus("Could not load " + path);
                }
            });
    }

    // Auto-reload JSON on file change (polls every 2s via Last-Modified header)
    var _watchPath = null;
    var _watchLastModified = null;
    var _watchTimer = null;

    function startWatching(path) {
        stopWatching();
        _watchPath = path;
        _watchLastModified = null;
        _watchTimer = setInterval(function () {
            if (!_watchPath) return;
            $.ajax({
                url: _watchPath + "?_=" + Date.now(),
                type: "HEAD",
                success: function (data, status, xhr) {
                    var lm = xhr.getResponseHeader("Last-Modified");
                    if (!lm) return;
                    if (_watchLastModified === null) {
                        _watchLastModified = lm;
                        return;
                    }
                    if (lm !== _watchLastModified) {
                        _watchLastModified = lm;
                        loadJson(_watchPath, true);
                        updateStatus("JSON reloaded (file changed).");
                    }
                }
            });
        }, 2000);
    }

    function stopWatching() {
        if (_watchTimer) { clearInterval(_watchTimer); _watchTimer = null; }
        _watchPath = null;
        _watchLastModified = null;
    }

    function goToStep(index) {
        if (!config || !config.steps) return;
        var steps = config.steps;
        if (index < 0 || index >= steps.length) return;
        var step = steps[index];
        currentStep = index;

        // set fold
        globals.setCreasePercent(step.fold / 100);
        globals.shouldChangeCreasePercent = true;

        // set camera POV
        setPOV(step.pov);

        // apply rotation
        if (step.rotation !== undefined && step.rotation !== null) {
            applyRotation(step.rotation);
        } else {
            globals.threeView.resetModel();
        }

        // reveal hidden points only on last step
        globals.revealHiddenPoints = (index === steps.length - 1);
        globals.hideFacePointsDuringAnimation = false;

        if (globals.model && globals.model.updateFaceColors) globals.model.updateFaceColors();
        if (globals.controls && globals.controls.updateCreasePercent) globals.controls.updateCreasePercent();

        updateStatus("Step " + (index + 1) + "/" + steps.length +
                     " — fold " + step.fold + "%" +
                     (step.pov ? ", POV " + (Array.isArray(step.pov) ? "[" + step.pov.join(", ") + "]" : step.pov) : ""));
    }

    function saveViewToStep(index) {
        if (!config || !config.steps) return null;
        var steps = config.steps;
        if (index < 0 || index >= steps.length) return null;
        var step = steps[index];

        var cam = globals.threeView.camera;
        var mw = globals.threeView.modelWrapper;
        if (!cam || !mw) return null;

        // Current camera direction → pov
        var camPos = cam.position.clone().normalize();
        var pov = [
            parseFloat(camPos.x.toFixed(2)),
            parseFloat(camPos.y.toFixed(2)),
            parseFloat(camPos.z.toFixed(2))
        ];
        step.pov = pov;

        // Current model rotation
        var rx = parseFloat(mw.rotation.x.toFixed(2));
        var ry = parseFloat(mw.rotation.y.toFixed(2));
        var rz = parseFloat(mw.rotation.z.toFixed(2));
        if (rx !== 0 || ry !== 0 || rz !== 0) {
            step.rotation = [rx, ry, rz];
        } else {
            delete step.rotation;
        }

        // Also update the master presets object so it can be saved
        if (presets && currentBenchmarkName && presets[currentBenchmarkName]) {
            presets[currentBenchmarkName].steps[index] = $.extend(true, {}, step);
        }

        populateStepSelect();
        $("#benchmarkStepSelect").val(index);

        updateStatus("Saved view to step " + (index + 1) + ": pov [" + pov.join(", ") + "]" +
            (step.rotation ? ", rot [" + step.rotation.join(", ") + "]" : ""));
        return step;
    }

    return {
        init: init,
        run: run,
        runAll: runAll,
        runScan: runScan,
        loadJson: loadJson,
        startWatching: startWatching,
        refreshJsonPaths: refreshJsonPaths,
        selectPreset: selectPreset,
        goToStep: goToStep,
        saveViewToStep: saveViewToStep,
        getConfig: function () { return config; },
        getPresets: function () { return presets; },
        isRunning: function () { return running; },
        setPOV: setPOV,
        applySettings: applySettings,
        getPointScreenPosition: getPointScreenPosition,
        evaluateTrackedPoints: evaluateTrackedPoints
    };
}
