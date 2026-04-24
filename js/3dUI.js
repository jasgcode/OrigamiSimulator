/**
 * Created by amandaghassaei on 5/5/17.
 */


function init3DUI(globals) {

    var raycaster = new THREE.Raycaster();
    var mouse = new THREE.Vector2();
    var raycasterPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1));
    var isDragging = false;
    var draggingNode = null;
    var draggingNodeFixed = false;
    var mouseDown = false;
    var mouseDownX = 0;
    var mouseDownY = 0;
    var CLICK_THRESHOLD_PX = 5;
    var highlightedObj;
    var draggingFacePointIndex = -1;
    var HIT_THRESHOLD = 0.05;
    var HIT_THRESHOLD_MOVE_MODE = 0.15;
    var pointMoveMode = false;

    // V key toggles point-move mode: larger grab radius, orbit disabled, easier dragging
    document.addEventListener('keydown', function(e) {
        if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
        if (e.key === 'v' || e.key === 'V') {
            if (!isFacePointMode() || !globals.facePoints) return;
            pointMoveMode = !pointMoveMode;
            globals.threeView.enableControls(!pointMoveMode);
            var indicator = document.getElementById("pointMoveModeIndicator");
            if (indicator) indicator.style.display = pointMoveMode ? "block" : "none";
        }
    });

    var highlighter1 = new Node(new THREE.Vector3());
    highlighter1.setTransparent();
    globals.threeView.scene.add(highlighter1.getObject3D());

    $(document).dblclick(function() {
    });

    document.addEventListener('mousedown', function(e){
        mouseDown = true;
        mouseDownX = e.clientX;
        mouseDownY = e.clientY;
    }, false);
    function isFacePointMode(){
        return globals.colorMode === "faceTriangleID" || globals.colorMode === "labelOnly" || globals.colorMode === "greyscaleLabel";
    }
    function addPointAtScreenPos(clientX, clientY) {
        if (!globals.facePoints || !globals.model) return;
        var mx = (clientX / window.innerWidth) * 2 - 1;
        var my = -(clientY / window.innerHeight) * 2 + 1;
        var rc = new THREE.Raycaster();
        rc.setFromCamera(new THREE.Vector2(mx, my), globals.threeView.camera);
        var meshArray = globals.model.getMesh();
        var hits = rc.intersectObjects(meshArray, false);
        if (hits.length === 0) return;
        var inter = hits[0];
        var newPt = globals.facePoints.pointFromRayIntersection(inter, meshArray);
        if (!newPt) return;
        var inset = globals.facePoints.insetBarycentric(newPt.u, newPt.v, newPt.w);
        globals.facePoints.addPoint(newPt.faceId, inset.u, inset.v, inset.w);
        globals.model.updateFaceColors();
        if (globals.controls && globals.controls.refreshFacePointList) globals.controls.refreshFacePointList();
    }
    document.addEventListener('mouseup', function(e){
        var dx = e.clientX - mouseDownX, dy = e.clientY - mouseDownY;
        var wasClick = mouseDown && Math.sqrt(dx * dx + dy * dy) < CLICK_THRESHOLD_PX;
        isDragging = false;
        var lockControls = pointMoveMode || (globals.clickToAddFacePoints && isFacePointMode());
        if (draggingFacePointIndex >= 0){
            draggingFacePointIndex = -1;
            globals.threeView.enableControls(!lockControls);
            if (globals.controls && globals.controls.refreshFacePointList) globals.controls.refreshFacePointList();
        }
        if (draggingNode){
            draggingNode.setFixed(draggingNodeFixed);
            draggingNode = null;
            globals.fixedHasChanged = true;
            globals.threeView.enableControls(true);
            setHighlightedObj(null);
            globals.shouldCenterGeo = true;
        }
        // Handle click-to-add: pure click (no drag) on the mesh adds a point
        if (wasClick && globals.clickToAddFacePoints && isFacePointMode() && globals.facePoints) {
            addPointAtScreenPos(e.clientX, e.clientY);
        }
        mouseDown = false;
    }, false);
    document.addEventListener( 'mousemove', mouseMove, false );
    function mouseMove(e){

        if (mouseDown) {
            isDragging = true;
        }

        var allowFacePointOnly = isFacePointMode() && globals.facePoints;
        if (!globals.userInteractionEnabled && !allowFacePointOnly) return;

        mouse.x = (e.clientX/window.innerWidth)*2-1;
        mouse.y = - (e.clientY/window.innerHeight)*2+1;
        raycaster.setFromCamera(mouse, globals.threeView.camera);

        if (isFacePointMode() && globals.facePoints){
            var meshArray = globals.model.getMesh();
            var interArr = raycaster.intersectObjects(meshArray, false);
            if (interArr.length > 0){
                var inter = interArr[0];
                var meshHit = inter.object;
                var faceIndex = inter.faceIndex;
                if (faceIndex === undefined) faceIndex = Math.floor(inter.face.a / 3);
                var N = globals.model.getFaces().length;
                var isBackside = meshArray.length > 1 && meshHit === meshArray[1];
                var faceId = isBackside ? N + faceIndex : faceIndex;

                if (!isDragging && globals.clickToAddFacePoints){
                    var pts = globals.facePoints.getPoints();
                    var overExisting = false;
                    var mwMat = globals.threeView.modelWrapper ? globals.threeView.modelWrapper.matrixWorld : new THREE.Matrix4();
                    for (var i = 0; i < pts.length; i++){
                        var pp = globals.facePoints.getPointPosition(i);
                        if (pp) pp = pp.clone().applyMatrix4(mwMat);
                        var ht = pointMoveMode ? HIT_THRESHOLD_MOVE_MODE : HIT_THRESHOLD;
                        if (pp && pp.distanceTo(inter.point) < ht){ overExisting = true; break; }
                    }
                    if (!overExisting){
                        var previewPt = globals.facePoints.pointFromRayIntersection(inter, meshArray);
                        if (previewPt){
                            var triIdx = previewPt.faceId < N ? previewPt.faceId : previewPt.faceId - N;
                            var previewPos = globals.facePoints.barycentricToWorld(triIdx, previewPt.u, previewPt.v, previewPt.w);
                            if (previewPos) globals.model.updateFacePointPreview(previewPos, true);
                        } else { globals.model.updateFacePointPreview(null, false); }
                    } else { globals.model.updateFacePointPreview(null, false); }
                } else if (!isDragging){
                    globals.model.updateFacePointPreview(null, false);
                }

                if (isDragging || (pointMoveMode && mouseDown)){
                    globals.model.updateFacePointPreview(null, false);
                    // Get model world matrix for local↔world transforms
                    var modelWrapper = globals.threeView.modelWrapper;
                    var modelWorldMatrix = modelWrapper ? modelWrapper.matrixWorld : new THREE.Matrix4();
                    var modelInvMatrix = new THREE.Matrix4().getInverse(modelWorldMatrix);

                    if (draggingFacePointIndex >= 0){
                        var pts = globals.facePoints.getPoints();
                        var pt = pts[draggingFacePointIndex];
                        if (pt){
                            var triIdx = pt.faceId < N ? pt.faceId : pt.faceId - N;
                            var plane = new THREE.Plane();
                            var vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
                            var faces = globals.model.getFaces();
                            var posArr = globals.model.getPositionsArray();
                            var face = faces[triIdx];
                            // Build plane in world space by transforming local vertices
                            vA.set(posArr[face[0]*3], posArr[face[0]*3+1], posArr[face[0]*3+2]).applyMatrix4(modelWorldMatrix);
                            vB.set(posArr[face[1]*3], posArr[face[1]*3+1], posArr[face[1]*3+2]).applyMatrix4(modelWorldMatrix);
                            vC.set(posArr[face[2]*3], posArr[face[2]*3+1], posArr[face[2]*3+2]).applyMatrix4(modelWorldMatrix);
                            plane.setFromCoplanarPoints(vA, vB, vC);
                            var dragPoint = new THREE.Vector3();
                            raycaster.ray.intersectPlane(plane, dragPoint);
                            if (dragPoint) {
                                // Transform hit back to local space for barycentric computation
                                var localDragPoint = dragPoint.clone().applyMatrix4(modelInvMatrix);
                                var bary = globals.facePoints.worldToBarycentric(triIdx, localDragPoint);
                                if (bary){
                                    bary = globals.facePoints.clampBarycentric(bary);
                                    bary = globals.facePoints.insetBarycentric(bary.u, bary.v, bary.w);
                                    globals.facePoints.updatePointPosition(draggingFacePointIndex, pt.faceId, bary.u, bary.v, bary.w);
                                    globals.model.updateFaceColors();
                                }
                            }
                        }
                        globals.threeView.enableControls(false);
                        return;
                    }
                    var pts = globals.facePoints.getPoints();
                    var hitPointIndex = -1;
                    var grabThreshold = pointMoveMode ? HIT_THRESHOLD_MOVE_MODE : HIT_THRESHOLD;
                    for (var i = 0; i < pts.length; i++){
                        // getPointPosition returns local space; transform to world for comparison with inter.point
                        var pp = globals.facePoints.getPointPosition(i);
                        if (pp) pp = pp.clone().applyMatrix4(modelWorldMatrix);
                        if (pp && pp.distanceTo(inter.point) < grabThreshold){
                            hitPointIndex = i;
                            break;
                        }
                    }
                    if (hitPointIndex >= 0){
                        draggingFacePointIndex = hitPointIndex;
                        globals.threeView.enableControls(false);
                    } else if (globals.clickToAddFacePoints){
                        var newPt = globals.facePoints.pointFromRayIntersection(inter, meshArray);
                        if (newPt){
                            var inset = globals.facePoints.insetBarycentric(newPt.u, newPt.v, newPt.w);
                            globals.facePoints.addPoint(newPt.faceId, inset.u, inset.v, inset.w);
                            draggingFacePointIndex = globals.facePoints.getPoints().length - 1;
                            globals.model.updateFaceColors();
                            if (globals.controls && globals.controls.refreshFacePointList) globals.controls.refreshFacePointList();
                        }
                    }
                    return;
                }
            }
            globals.model.updateFacePointPreview(null, false);
            highlighter1.getObject3D().visible = false;
            setHighlightedObj(null);
            return;
        }

        var _highlightedObj = null;
        if (!isDragging) {
            _highlightedObj = checkForIntersections(e, globals.model.getMesh());
            setHighlightedObj(_highlightedObj);
        }  else if (isDragging && highlightedObj){
            if (!draggingNode) {
                draggingNode = highlightedObj;
                draggingNodeFixed = draggingNode.isFixed();
                draggingNode.setFixed(true);
                globals.fixedHasChanged = true;
                globals.threeView.enableControls(false);
            }
            var intersection = getIntersectionWithObjectPlane(highlightedObj.getPosition().clone());
            highlightedObj.moveManually(intersection);
            globals.nodePositionHasChanged = true;
        }

        if (highlightedObj){
            var position = highlightedObj.getPosition();
            highlighter1.getObject3D().position.set(position.x, position.y, position.z);
        }
    }

    function getIntersectionWithObjectPlane(position){
        var cameraOrientation = globals.threeView.camera.getWorldDirection();
        var dist = position.dot(cameraOrientation);
        raycasterPlane.set(cameraOrientation, -dist);
        var intersection = new THREE.Vector3();
        raycaster.ray.intersectPlane(raycasterPlane, intersection);
        return intersection;
    }

    function setHighlightedObj(object){
        if (highlightedObj && (object != highlightedObj)) {
            // highlightedObj.unhighlight();
            highlighter1.getObject3D().visible = false;
        }
        highlightedObj = object;
        if (highlightedObj) {
            // highlightedObj.highlight();
            highlighter1.getObject3D().visible = true;
        }
    }

    function checkForIntersections(e, objects){
        var _highlightedObj = null;
        var intersections = raycaster.intersectObjects(objects, false);
        if (intersections.length>0){
            var face = intersections[0].face;
            var position = intersections[0].point;
            var positionsArray = globals.model.getPositionsArray();
            var vertices = [];
            vertices.push(new THREE.Vector3(positionsArray[3*face.a], positionsArray[3*face.a+1], positionsArray[3*face.a+2]));
            vertices.push(new THREE.Vector3(positionsArray[3*face.b], positionsArray[3*face.b+1], positionsArray[3*face.b+2]));
            vertices.push(new THREE.Vector3(positionsArray[3*face.c], positionsArray[3*face.c+1], positionsArray[3*face.c+2]));
            var dist = vertices[0].clone().sub(position).lengthSq();
            var nodeIndex = face.a;
            for (var i=1;i<3;i++){
                var _dist = (vertices[i].clone().sub(position)).lengthSq();
                if (_dist<dist){
                    dist = _dist;
                    if (i==1) nodeIndex = face.b;
                    else nodeIndex = face.c;
                }
            }
            var nodesArray = globals.model.getNodes();
            _highlightedObj = nodesArray[nodeIndex];
        }
        return _highlightedObj;
    }

    function hideHighlighters(){
        highlighter1.getObject3D().visible = false;
    }
    
    // globals.threeView.sceneAdd(raycasterPlane);

    return {
        hideHighlighters: hideHighlighters
    }

}