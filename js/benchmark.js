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
 *                   hidePointsDuringAnimation: "true" to hide face points during fold animation.
 *                   delay / delayBeforeAnimation: seconds to wait before animation starts (e.g. 1).
 *                   delayAfterPreview: seconds to pause between previewRotation and foldAnimation (e.g. 1).
 *   previewRotation  — top-level: { duration: 2, povKeyframes: [...] } — rotate view at cfg.fold (initial fold).
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

    function getPOVDirection(pov) {
        if (!pov) return null;
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

    // ── Apply settings (colorMode, highlights) ──

    function applySettings(cfg) {
        if (cfg.colorMode) {
            globals.colorMode = cfg.colorMode;
            // update radio UI
            $(".radio>input[value=" + cfg.colorMode + "]").prop("checked", true);
            // show/hide option panels
            $("#coloredMaterialOptions").toggle(cfg.colorMode === "color");
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
            if (globals.colorMode === "labelOnly" || globals.colorMode === "color") globals.model.setMeshMaterial();
        }
    }

    // ── Screenshot capture ──

    function captureScreenshot(stepIndex, callback) {
        var baseName = globals.filename || "benchmark";
        globals.screenRecordFilename = baseName + "_step" + stepIndex;
        // trigger PNG capture on next render frame
        globals.capturer = "png";
        // wait for the render loop to consume the capture flag
        var poll = setInterval(function () {
            if (globals.capturer !== "png") {
                clearInterval(poll);
                if (callback) callback();
            }
        }, 50);
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
                if (trackModel) {
                    globals.threeView.setCameraFixedForTracking();
                    globals.threeView.setModelRotationForPOV(initialDir);
                } else {
                    globals.threeView.setCameraToPosition(initialDir, fitAllPoints);
                }
            }
        }

        function prevTick(t) {
            var elapsed = (t - start) / 1000;
            if (elapsed >= duration) {
                var finalDir = keyframes.length > 0 ? getInterpolatedPOV(keyframes, 100) : null;
                if (finalDir) {
                    if (trackModel) globals.threeView.setModelRotationForPOV(finalDir);
                    else globals.threeView.setCameraToPosition(finalDir, fitAllPoints);
                }
                globals.threeView.startSimulation();
                updateStatus("Preview complete.");
                if (callback) callback();
                return;
            }
            var progress = 100 * (elapsed / duration);
            if (keyframes.length > 0) {
                var dir = getInterpolatedPOV(keyframes, progress);
                if (dir) {
                    if (trackModel) globals.threeView.setModelRotationForPOV(dir);
                    else globals.threeView.setCameraToPosition(dir, fitAllPoints);
                }
            }
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
            updateStatus("Fold animation: " + Math.round(pct) + "% (" + Math.round(elapsed * 10) / 10 + "s / " + durationSec + "s)");
            requestAnimationFrame(tick);
        }
        startFoldAnimation();
    }

    // ── Step runner ──

    function runStep(steps, index, pauseSec, autoCapture, onComplete) {
        if (index >= steps.length) {
            running = false;
            updateStatus("Benchmark complete (" + steps.length + " steps).");
            console.log("benchmark: sequence complete");
            if (onComplete) onComplete();
            return;
        }

        running = true;
        currentStep = index;
        var step = steps[index];

        updateStatus("Step " + (index + 1) + "/" + steps.length +
                     " — fold " + step.fold + "%" +
                     (step.pov ? ", POV " + step.pov : ""));

        // set fold percent
        globals.setCreasePercent(step.fold / 100);
        globals.shouldChangeCreasePercent = true;

        // set camera
        setPOV(step.pov);

        // wait for simulation to settle, then optionally capture
        var settleMs = Math.max(pauseSec * 1000, 500);
            setTimeout(function () {
            if (autoCapture) {
                captureScreenshot(index, function () {
                    // small delay after capture before next step
                    setTimeout(function () {
                        runStep(steps, index + 1, pauseSec, autoCapture, onComplete);
                    }, 300);
                });
            } else {
                runStep(steps, index + 1, pauseSec, autoCapture, onComplete);
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
                runFoldAnimation(cfg.foldAnimation, function () {
                    running = false;
                    console.log("benchmark: fold animation complete");
                    if (onComplete) onComplete();
                });
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
                runStep(cfg.steps, 0, cfg.pauseDuration, cfg.autoCapture, onComplete);
            });
        } else {
            runStep(cfg.steps, 0, cfg.pauseDuration, cfg.autoCapture, onComplete);
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

    return {
        init: init,
        run: run,
        runAll: runAll,
        selectPreset: selectPreset,
        getConfig: function () { return config; },
        getPresets: function () { return presets; },
        isRunning: function () { return running; },
        setPOV: setPOV
    };
}
