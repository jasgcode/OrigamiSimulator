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
 *   foldStart    — fold % for first step  (0-100)
 *   foldMid      — fold % for middle step (0-100)
 *   foldEnd      — fold % for last step   (0-100)
 *   povStart     — camera POV at first step  (iso, x, -x, y, -y, z, -z)
 *   povMid       — camera POV at middle step
 *   povEnd       — camera POV at last step
 *   pauseDuration — seconds to wait at each step (default 2)
 *   autoCapture  — "true" to capture PNG at each step
 *   autoRun      — "true" to start sequence automatically after load
 */

function initBenchmark(globals) {

    var config = null;
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

        var pauseDuration = getParamFloat("pauseDuration");
        if (pauseDuration !== null) cfg.pauseDuration = pauseDuration;

        if (getParam("autoCapture") !== null) cfg.autoCapture = getParamBool("autoCapture");
        if (getParam("autoRun") !== null) cfg.autoRun = getParamBool("autoRun");

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
        if (!cfg || !cfg.steps || cfg.steps.length === 0) {
            console.warn("benchmark: no valid config to run");
            return;
        }
        applySettings(cfg);
        runStep(cfg.steps, 0, cfg.pauseDuration, cfg.autoCapture);
    }

    // ── Public: initialize — called from main.js before model load ──
    // loadModelCallback(modelPath) is called once config is parsed,
    // passing the model path to load (from benchmark preset, URL, or null for default).

    function init(loadModelCallback) {
        // try to load JSON presets, then build config
        $.getJSON("benchmarks.json")
            .done(function (presets) {
                config = buildConfig(presets);
                onConfigReady(loadModelCallback);
            })
            .fail(function () {
                // no benchmarks.json — use URL params only
                config = buildConfig(null);
                onConfigReady(loadModelCallback);
            });
    }

    function onConfigReady(loadModelCallback) {
        // tell main.js which model to load (benchmark model or null for default)
        var benchmarkModel = config ? config.model : null;
        if (loadModelCallback) loadModelCallback(benchmarkModel);

        if (!config) return; // no benchmark requested

        // wait for model load, then apply settings and optionally auto-run
        waitForModelLoad(function () {
            applySettings(config);
            updateStatus("Benchmark ready: " + config.steps.length + " steps.");
            if (config.autoRun) {
                // small delay to let the UI finish settling
                setTimeout(function () { run(config); }, 500);
            }
        });
    }

    return {
        init: init,
        run: run,
        getConfig: function () { return config; },
        isRunning: function () { return running; },
        setPOV: setPOV
    };
}
