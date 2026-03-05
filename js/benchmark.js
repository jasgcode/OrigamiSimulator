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
 *   colorMode    — color mode to apply after load
 *   pointA       — face ID for highlight point A
 *   pointB       — face ID for highlight point B
 *   facePoints   — JSON object mapping face IDs to point counts, e.g. {"0":3,"5":2} for 3 random points on face 0, 2 on face 5. URL: facePoints={"0":3,"5":2}
 *   foldStart    — fold % for first step  (0-100)
 *   foldMid      — fold % for middle step (0-100)
 *   foldEnd      — fold % for last step   (0-100)
 *   povStart     — camera POV at first step  (iso, x, -x, y, -y, z, -z)
 *   povMid       — camera POV at middle step
 *   povEnd       — camera POV at last step
 *   pauseDuration — seconds to wait at each step (default 2)
 *   autoCapture  — "true" to capture PNG at each step
 *   autoRun      — "true" to start sequence automatically after load
 *   foldAnimation — "true" to animate fold 0→90 over 4s (or use foldAnimFrom/foldAnimTo/foldAnimDuration)
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

    // ── Fold animation (0→90 over 4s etc) ──

    function runFoldAnimation(opts, callback) {
        var from = opts.from != null ? opts.from : 0;
        var to = opts.to != null ? opts.to : 90;
        var durationSec = opts.duration != null ? opts.duration : 4;

        globals.setCreasePercent(from / 100);
        globals.shouldChangeCreasePercent = true;

        var startTime = performance.now();

        function tick(t) {
            var elapsed = (t - startTime) / 1000;
            if (elapsed >= durationSec) {
                globals.setCreasePercent(to / 100);
                globals.shouldChangeCreasePercent = true;
                updateStatus("Fold animation complete (0→" + to + "%).");
                if (callback) callback();
                return;
            }
            var tNorm = elapsed / durationSec;
            var pct = from + (to - from) * tNorm;
            globals.setCreasePercent(pct / 100);
            globals.shouldChangeCreasePercent = true;
            updateStatus("Fold animation: " + Math.round(pct) + "% (" + Math.round(elapsed * 10) / 10 + "s / " + durationSec + "s)");
            requestAnimationFrame(tick);
        }
        updateStatus("Fold animation: " + from + "% → " + to + "% over " + durationSec + "s");
        requestAnimationFrame(tick);
    }

    // ── Step runner ──

    function runStep(steps, index, pauseSec, autoCapture) {
        if (index >= steps.length) {
            running = false;
            updateStatus("Benchmark complete (" + steps.length + " steps).");
            console.log("benchmark: sequence complete");
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
                        runStep(steps, index + 1, pauseSec, autoCapture);
                    }, 300);
                });
            } else {
                runStep(steps, index + 1, pauseSec, autoCapture);
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

    function run(cfg) {
        if (!cfg) cfg = config;
        if (!cfg) {
            console.warn("benchmark: no valid config to run");
            return;
        }
        applySettings(cfg);

        if (cfg.foldAnimation) {
            running = true;
            currentStep = 0;
            setPOV(cfg.foldAnimation.pov || "iso");
            runFoldAnimation(cfg.foldAnimation, function () {
                running = false;
                console.log("benchmark: fold animation complete");
            });
            return;
        }

        if (!cfg.steps || cfg.steps.length === 0) {
            console.warn("benchmark: no steps and no foldAnimation");
            return;
        }
        runStep(cfg.steps, 0, cfg.pauseDuration, cfg.autoCapture);
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
        var benchmarkModel = config ? config.model : null;
        if (cb) cb(benchmarkModel);

        if (!config) return;

        waitForModelLoad(function () {
            applySettings(config);
            updateStatus("Benchmark ready: " + config.steps.length + " steps.");
            if (config.autoRun) {
                setTimeout(function () { run(config); }, 500);
            }
        });
    }

    return {
        init: init,
        run: run,
        selectPreset: selectPreset,
        getConfig: function () { return config; },
        getPresets: function () { return presets; },
        isRunning: function () { return running; },
        setPOV: setPOV
    };
}
