/**
 * Created by ghassaei on 9/16/16.
 */

function initThreeView(globals) {

    var scene = new THREE.Scene();
    var modelWrapper = new THREE.Object3D();

    var camera = new THREE.PerspectiveCamera(60, window.innerWidth/window.innerHeight, 0.1, 500);
    // var camera = new THREE.OrthographicCamera(window.innerWidth / -2, window.innerWidth / 2, window.innerHeight / 2, window.innerHeight / -2, -10000, 10000);//-40, 40);
    var renderer = new THREE.WebGLRenderer({antialias: true, alpha: true, premultipliedAlpha: false});
    // var svgRenderer = new THREE.SVGRenderer();
    var controls;

    // Static reference pole drawn into every captured PNG: a thin
    // vertical line spanning the full canvas height. Sits in the
    // background (semi-transparent muted color) so it doesn't compete
    // visually with the origami model but is always available as a
    // fixed vertical reference for the viewer to anchor against.

    init();

    function init() {

        var container = $("#threeContainer");
        renderer.setPixelRatio( window.devicePixelRatio );
        renderer.setSize(window.innerWidth, window.innerHeight);
        container.append(renderer.domElement);

        // Transparent WebGL canvas so the merge-step background color
        // and reference pole show through where the model isn't drawn.
        // The bg color is painted onto the merged 2D canvas in _render
        // before the WebGL canvas is composited on top.
        scene.background = null;
        renderer.setClearColor(0xffffff, 0);
        scene.add(modelWrapper);
        var directionalLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight1.position.set(0, 100, 0);
        scene.add(directionalLight1);
        var directionalLight4 = new THREE.DirectionalLight(0xffffff, 0.3);
        directionalLight4.position.set(0, -100, 0);
        scene.add(directionalLight4);
        var directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight2.position.set(100, -30, 0);
        scene.add(directionalLight2);
        var directionalLight3 = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight3.position.set(-100, -30, 0);
        scene.add(directionalLight3);
        var directionalLight4 = new THREE.DirectionalLight(0xffffff, 0.3);
        directionalLight4.position.set(0, 30, 100);
        scene.add(directionalLight4);
        var directionalLight5 = new THREE.DirectionalLight(0xffffff, 0.3);
        directionalLight5.position.set(0, 30, -100);
        scene.add(directionalLight5);
        // var ambientLight = new THREE.AmbientLight(0xffffff, 0.1);
        // scene.add(ambientLight);
        //scene.fog = new THREE.FogExp2(0xf4f4f4, 1.7);
        //renderer.setClearColor(scene.fog.color);

        scene.add(camera);

        resetCamera();

        controls = new THREE.TrackballControls(camera, renderer.domElement);
        controls.rotateSpeed = 4.0;
        controls.zoomSpeed = 15;
        controls.noPan = true;
        controls.staticMoving = true;
        controls.dynamicDampingFactor = 0.3;
        controls.minDistance = 1;
	    controls.maxDistance = 30;
        // controls.addEventListener("change", render);

        _render();//render before model loads

    }

    function resetCamera(){
        camera.zoom = 7;
        camera.updateProjectionMatrix();
        camera.position.x = 5;
        camera.position.y = 5;
        camera.position.z = 5;
        if (controls) setCameraIso();
    }

    function setCameraX(sign){
        controls.reset(new THREE.Vector3(sign,0,0));
    }
    function setCameraY(sign){
        controls.reset(new THREE.Vector3(0,sign,0));
    }
    function setCameraZ(sign){
        controls.reset(new THREE.Vector3(0,0,sign));
    }
    function setCameraIso(){
        controls.reset(new THREE.Vector3(1,1,1));
    }

    // Minimum distance so the entire model fits in the camera view (no clipping).
    // Uses bounding sphere of mesh geometry and camera FOV.
    function getMinCameraDistanceToFitModel() {
        var meshArray = globals.model && globals.model.getMesh ? globals.model.getMesh() : null;
        if (!meshArray || !meshArray[0] || !meshArray[0].geometry) return null;
        var geo = meshArray[0].geometry;
        if (!geo.computeBoundingSphere) return null;
        geo.computeBoundingSphere();
        var R = geo.boundingSphere.radius;
        if (R <= 0) return null;
        var fovRad = (camera.fov || 60) * Math.PI / 180;
        var minDist = R / Math.tan(fovRad / 2);
        var margin = 1.08;
        return Math.max(minDist * margin, controls.minDistance);
    }

    // Set camera to an arbitrary position vector (direction from origin).
    // Used for smooth POV transitions during benchmark animation.
    // fitAllPoints: if true, scales distance so the entire model always stays in view.
    function setCameraToPosition(positionVec, fitAllPoints, preserveModelRotation) {
        if (!preserveModelRotation) resetModel();
        var pos = positionVec.clone();
        if (fitAllPoints) {
            var minDist = getMinCameraDistanceToFitModel();
            if (minDist != null) pos.normalize().multiplyScalar(minDist);
        }
        controls.reset(pos);
    }

    // Fixed camera for "track model" mode: camera stays at iso, zoomed to fit entire model.
    // Use with setModelRotationForPOV — the model rotates, camera tracks (always sees all points).
    function setCameraFixedForTracking() {
        var isoDir = new THREE.Vector3(1, 1, 1).normalize();
        var minDist = getMinCameraDistanceToFitModel();
        var pos = isoDir.clone().multiplyScalar(minDist != null ? minDist : 7);
        resetModel();
        controls.reset(pos);
    }

    // Rotate the model so that POV direction faces the camera.
    // Camera stays fixed at iso; model rotates to achieve the requested view.
    // povDir: normalized direction (where "camera would be" for that POV).
    function setModelRotationForPOV(povDir) {
        var isoDir = new THREE.Vector3(1, 1, 1).normalize();
        var d = povDir.clone().normalize();
        if (d.lengthSq() < 0.0001) return;
        if (Math.abs(d.dot(isoDir)) > 0.9999) {
            modelWrapper.rotation.set(0, 0, 0);
            return;
        }
        var q = new THREE.Quaternion().setFromUnitVectors(d, isoDir);
        modelWrapper.rotation.setFromQuaternion(q);
    }

    function startAnimation(){
        console.log("starting animation");
        renderer.animate(_loop);
    }

    function pauseSimulation(){
        globals.simulationRunning = false;
        console.log("pausing simulation");
    }

    function startSimulation(){
        console.log("starting simulation");
        globals.simulationRunning = true;
    }

    // ── Face ID overlay ──
    var faceIdCanvas = document.getElementById("faceIdCanvas");
    var faceIdCtx = faceIdCanvas ? faceIdCanvas.getContext("2d") : null;
    var _faceIdVisible = false;

    function hideFaceIdOverlay() {
        if (_faceIdVisible && faceIdCanvas) {
            faceIdCanvas.style.display = "none";
            _faceIdVisible = false;
        }
    }

    function renderFaceIdOverlay() {
        if (!faceIdCanvas || !faceIdCtx || !globals.model) { hideFaceIdOverlay(); return; }
        var faces = globals.model.getFaces();
        if (!faces || faces.length === 0) { hideFaceIdOverlay(); return; }

        // size canvas to match renderer
        var base = renderer.domElement;
        var w = base.width || window.innerWidth;
        var h = base.height || window.innerHeight;
        if (faceIdCanvas.width !== w) faceIdCanvas.width = w;
        if (faceIdCanvas.height !== h) faceIdCanvas.height = h;
        var cssW = base.clientWidth || window.innerWidth;
        var cssH = base.clientHeight || window.innerHeight;
        faceIdCanvas.style.width = cssW + "px";
        faceIdCanvas.style.height = cssH + "px";
        faceIdCanvas.style.display = "block";
        _faceIdVisible = true;

        faceIdCtx.clearRect(0, 0, w, h);

        var cam = camera;
        cam.updateMatrixWorld();
        var camDir = new THREE.Vector3();
        cam.getWorldDirection(camDir);

        var scale = w / cssW;
        var fontSize = Math.max(10, Math.round(11 * scale));
        faceIdCtx.font = fontSize + "px Arial";
        faceIdCtx.textAlign = "center";
        faceIdCtx.textBaseline = "middle";

        for (var i = 0; i < faces.length; i++) {
            var centroid = globals.model.getFaceCentroid(i);
            if (!centroid) continue;

            // transform centroid through modelWrapper
            var worldPos = centroid.clone();
            modelWrapper.updateMatrixWorld();
            worldPos.applyMatrix4(modelWrapper.matrixWorld);

            // project to screen
            var projected = worldPos.clone().project(cam);
            if (projected.z < -1 || projected.z > 1) continue;
            var sx = (projected.x * 0.5 + 0.5) * w;
            var sy = (-projected.y * 0.5 + 0.5) * h;

            // draw background pill + text
            var text = String(i);
            var metrics = faceIdCtx.measureText(text);
            var pw = metrics.width + 6;
            var ph = fontSize + 4;
            faceIdCtx.fillStyle = "rgba(0,0,0,0.55)";
            faceIdCtx.fillRect(sx - pw / 2, sy - ph / 2, pw, ph);
            faceIdCtx.fillStyle = "#fff";
            faceIdCtx.fillText(text, sx, sy);
        }
    }

    var captureStats = $("#stopRecord>span");
    function drawReferencePole(ctx, canvasW, canvasH) {
        // Vertical pole spanning the full canvas height. Static, sits
        // behind the model. Warm dark-orange color so it reads as
        // visibly distinct from the blue/purple paper material the
        // models render with.
        var poleWidth = Math.max(6, Math.round(canvasW * 0.009));
        var poleX = Math.round(canvasW * 0.92);  // ~8% from right edge
        ctx.save();
        ctx.fillStyle = "rgba(150, 80, 40, 0.75)";
        ctx.fillRect(poleX, 0, poleWidth, canvasH);
        ctx.restore();
    }

    function _render(){
        if (globals.vrEnabled){
            globals.vive.render();
            return;
        }
        renderer.render(scene, camera);
        if (globals.pointAnnotations && globals.pointAnnotations.render) globals.pointAnnotations.render();
        if (globals.showFaceIds) renderFaceIdOverlay();
        else hideFaceIdOverlay();
        if (globals.capturer) {
            if (globals.capturer == "png"){
                var canvas = globals.threeView.renderer.domElement;
                var annotationCanvas = (globals.pointAnnotations && globals.pointAnnotations.getCanvas)
                    ? globals.pointAnnotations.getCanvas()
                    : null;
                var _captureCallback = globals.captureCallback || null;
                globals.capturer = null;
                globals.captureCallback = null;
                globals.shouldScaleCanvas = false;
                globals.shouldAnimateFoldPercent = false;
                var sourceCanvas = canvas;
                // Always merge so the rotation gizmo can be composited in
                // the top-right corner of every captured PNG.
                var needsMerge = true;
                if (needsMerge) {
                    var merged = document.createElement("canvas");
                    merged.width = canvas.width;
                    merged.height = canvas.height;
                    var mergedCtx = merged.getContext("2d");
                    // Paint the background color first (the WebGL canvas
                    // is alpha-transparent now). Then the reference pole
                    // (so it sits BEHIND the model in the rendered PNG),
                    // then the WebGL canvas with the model on top, then
                    // labels.
                    var bgHex = (globals.backgroundColor || "ffffff").replace(/^#/, "");
                    mergedCtx.fillStyle = "#" + bgHex;
                    mergedCtx.fillRect(0, 0, merged.width, merged.height);
                    drawReferencePole(mergedCtx, merged.width, merged.height);
                    mergedCtx.drawImage(canvas, 0, 0);
                    if (annotationCanvas && annotationCanvas.style.display !== "none") {
                        mergedCtx.drawImage(annotationCanvas, 0, 0, merged.width, merged.height);
                    }
                    if (globals.stepNumberText) {
                        var scale = merged.width / (canvas.clientWidth || merged.width);
                        var fontSize = Math.round(48 * scale);
                        mergedCtx.font = "bold " + fontSize + "px Arial, sans-serif";
                        var text = globals.stepNumberText;
                        var metrics = mergedCtx.measureText(text);
                        var padX = Math.round(12 * scale);
                        var padY = Math.round(4 * scale);
                        var tx = Math.round(16 * scale);
                        var ty = Math.round(16 * scale);
                        var boxW = metrics.width + padX * 2;
                        var boxH = fontSize + padY * 2;
                        mergedCtx.fillStyle = "rgba(255,255,255,0.75)";
                        mergedCtx.beginPath();
                        mergedCtx.roundRect(tx, ty, boxW, boxH, Math.round(6 * scale));
                        mergedCtx.fill();
                        mergedCtx.fillStyle = "#222";
                        mergedCtx.fillText(text, tx + padX, ty + padY + fontSize * 0.85);
                    }
                    sourceCanvas = merged;
                }
                sourceCanvas.toBlob(function(blob) {
                    if (_captureCallback) {
                        _captureCallback(blob);
                    } else {
                        saveAs(blob, globals.screenRecordFilename + ".png");
                    }
                }, "image/png");
                globals.threeView.onWindowResize();
                return;
            }
            captureStats.html("( " + ++globals.capturerFrames + " frames  at " + globals.currentFPS  + "fps )");
            globals.capturer.capture(renderer.domElement);
        }
    }

    function _loop(){
        if (globals.rotateModel !== null){
            if (globals.rotateModel == "x") modelWrapper.rotateX(globals.rotationSpeed);
            if (globals.rotateModel == "y") modelWrapper.rotateY(globals.rotationSpeed);
            if (globals.rotateModel == "z") modelWrapper.rotateZ(globals.rotationSpeed);
        }
        if (globals.needsSync){
            globals.model.sync();
        }
        if (globals.simNeedsSync){
            globals.model.syncSolver();
        }
        if (globals.simulationRunning) globals.model.step();
        if (globals.vrEnabled){
            _render();
            return;
        }
        controls.update();
        _render();
    }

    function sceneAddModel(object){
        modelWrapper.add(object);
    }

    function onWindowResize() {

        if (globals.vrEnabled){
            globals.warn("Can't resize window when in VR mode.");
            return;
        }

        camera.aspect = window.innerWidth / window.innerHeight;
        // camera.left = -window.innerWidth / 2;
        // camera.right = window.innerWidth / 2;
        // camera.top = window.innerHeight / 2;
        // camera.bottom = -window.innerHeight / 2;
        camera.updateProjectionMatrix();

        var scale = 1;
        if (globals.shouldScaleCanvas) scale = globals.capturerScale;
        renderer.setSize(scale*window.innerWidth, scale*window.innerHeight);
        controls.handleResize();
        if (globals.pointAnnotations && globals.pointAnnotations.onResize) globals.pointAnnotations.onResize();
    }

    function enableControls(state){
        controls.enabled = state;
        controls.enableRotate = state;
    }

    // function saveSVG(){
    //     // svgRenderer.setClearColor(0xffffff);
    //     svgRenderer.setSize(window.innerWidth,window.innerHeight);
    //     svgRenderer.sortElements = true;
    //     svgRenderer.sortObjects = true;
    //     svgRenderer.setQuality('high');
    //     svgRenderer.render(scene,camera);
    //     //get svg source.
    //     var serializer = new XMLSerializer();
    //     var source = serializer.serializeToString(svgRenderer.domElement);
    //
    //     //add name spaces.
    //     if(!source.match(/^<svg[^>]+xmlns="http\:\/\/www\.w3\.org\/2000\/svg"/)){
    //         source = source.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
    //     }
    //     if(!source.match(/^<svg[^>]+"http\:\/\/www\.w3\.org\/1999\/xlink"/)){
    //         source = source.replace(/^<svg/, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
    //     }
    //
    //     //add xml declaration
    //     source = '<?xml version="1.0" standalone="no"?>\r\n' + source;
    //
    //     var svgBlob = new Blob([source], {type:"image/svg+xml;charset=utf-8"});
    //     var svgUrl = URL.createObjectURL(svgBlob);
    //     var downloadLink = document.createElement("a");
    //     downloadLink.href = svgUrl;
    //     downloadLink.download =  globals.filename + " : " + parseInt(globals.creasePercent*100) +  "PercentFolded.svg";
    //     document.body.appendChild(downloadLink);
    //     downloadLink.click();
    //     document.body.removeChild(downloadLink);
    // }

    function resetModel(){
        modelWrapper.rotation.set(0,0,0);
    }

    function setModelRotation(x, y, z){
        modelWrapper.rotation.set(x, y, z);
    }

    function setBackgroundColor(color){
        // No-op: scene.background is null (alpha-transparent WebGL).
        // The actual bg color is painted in _render's merge step from
        // globals.backgroundColor, which is set by preset configs.
    }

    return {
        sceneAddModel: sceneAddModel,
        onWindowResize: onWindowResize,

        startAnimation: startAnimation,
        startSimulation: startSimulation,
        pauseSimulation: pauseSimulation,

        enableControls: enableControls,//user interaction
        scene: scene,
        camera: camera,//needed for user interaction
        renderer: renderer,//needed for VR
        modelWrapper:modelWrapper,

        // saveSVG: saveSVG,//svg screenshot

        setCameraX:setCameraX,
        setCameraY: setCameraY,
        setCameraZ: setCameraZ,
        setCameraIso: setCameraIso,
        setCameraToPosition: setCameraToPosition,
        setCameraFixedForTracking: setCameraFixedForTracking,
        setModelRotationForPOV: setModelRotationForPOV,

        resetModel: resetModel,//reset model orientation
        resetCamera:resetCamera,
        setBackgroundColor: setBackgroundColor,
        setModelRotation: setModelRotation
    }
}
