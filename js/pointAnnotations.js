function initPointAnnotations(globals) {

    var overlayCanvas = document.getElementById("pointAnnotationCanvas");
    var overlayCtx = overlayCanvas ? overlayCanvas.getContext("2d") : null;

    function clear() {
        if (!overlayCanvas || !overlayCtx) return;
        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
        if (overlayCanvas.style.display !== "none") overlayCanvas.style.display = "none";
    }

    function updateSize() {
        if (!overlayCanvas || !overlayCtx || !globals.threeView || !globals.threeView.renderer) return;
        var base = globals.threeView.renderer.domElement;
        if (!base) return;

        var w = base.width || Math.max(1, Math.floor(window.innerWidth * (window.devicePixelRatio || 1)));
        var h = base.height || Math.max(1, Math.floor(window.innerHeight * (window.devicePixelRatio || 1)));
        if (overlayCanvas.width !== w) overlayCanvas.width = w;
        if (overlayCanvas.height !== h) overlayCanvas.height = h;

        var cssW = base.clientWidth || window.innerWidth;
        var cssH = base.clientHeight || window.innerHeight;
        overlayCanvas.style.width = cssW + "px";
        overlayCanvas.style.height = cssH + "px";
    }

    function isActive() {
        if (!overlayCanvas || !overlayCtx) return false;
        if (!globals || !globals.facePoints || !globals.model) return false;
        if (globals.labelStyle !== "arrow") return false;
        if (!(globals.colorMode === "labelOnly" || globals.colorMode === "faceTriangleID")) return false;
        if (globals.hideFacePointsDuringAnimation) return false;
        if (!globals.revealHiddenPoints) return false;
        return true;
    }

    function pointLetter(index) {
        return String.fromCharCode(65 + (index % 26));
    }

    function worldToScreen(worldPos, camera, width, height) {
        var p = worldPos.clone().project(camera);
        if (p.z < -1 || p.z > 1) return null;
        return {
            x: (p.x * 0.5 + 0.5) * width,
            y: (-p.y * 0.5 + 0.5) * height
        };
    }

    function getFaceNormalLocal(faceIndex, faces, positions) {
        if (faceIndex < 0 || faceIndex >= faces.length) return null;
        var face = faces[faceIndex];
        var ax = positions[face[0] * 3], ay = positions[face[0] * 3 + 1], az = positions[face[0] * 3 + 2];
        var bx = positions[face[1] * 3], by = positions[face[1] * 3 + 1], bz = positions[face[1] * 3 + 2];
        var cx = positions[face[2] * 3], cy = positions[face[2] * 3 + 1], cz = positions[face[2] * 3 + 2];
        var abx = bx - ax, aby = by - ay, abz = bz - az;
        var acx = cx - ax, acy = cy - ay, acz = cz - az;
        var nx = aby * acz - abz * acy;
        var ny = abz * acx - abx * acz;
        var nz = abx * acy - aby * acx;
        var mag = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (mag < 1e-10) return null;
        return new THREE.Vector3(nx / mag, ny / mag, nz / mag);
    }

    function clamp(val, lo, hi) {
        return Math.max(lo, Math.min(hi, val));
    }

    function layoutLane(items, minY, maxY, minGap) {
        if (!items || items.length === 0) return;

        items.sort(function (a, b) {
            return a.anchorY - b.anchorY;
        });

        var prev = minY - minGap;
        for (var i = 0; i < items.length; i++) {
            var y = clamp(items[i].anchorY, minY, maxY);
            y = Math.max(y, prev + minGap);
            items[i].labelY = y;
            prev = y;
        }

        var overflow = items[items.length - 1].labelY - maxY;
        if (overflow > 0) {
            for (var j = 0; j < items.length; j++) {
                items[j].labelY -= overflow;
            }
        }

        for (var k = items.length - 2; k >= 0; k--) {
            if (items[k].labelY > items[k + 1].labelY - minGap) {
                items[k].labelY = items[k + 1].labelY - minGap;
            }
        }

        var underflow = minY - items[0].labelY;
        if (underflow > 0) {
            for (var q = 0; q < items.length; q++) {
                items[q].labelY += underflow;
            }
        }
    }

    function drawArrow(fromX, fromY, toX, toY, styleScale) {
        var dx = toX - fromX;
        var dy = toY - fromY;
        var len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.001) return;
        var ux = dx / len;
        var uy = dy / len;

        var headLen = 8 * styleScale;
        var headHalf = 4 * styleScale;
        var bx = toX - ux * headLen;
        var by = toY - uy * headLen;
        var px = -uy;
        var py = ux;

        overlayCtx.beginPath();
        overlayCtx.moveTo(fromX, fromY);
        overlayCtx.lineTo(bx, by);
        overlayCtx.stroke();

        overlayCtx.beginPath();
        overlayCtx.moveTo(toX, toY);
        overlayCtx.lineTo(bx + px * headHalf, by + py * headHalf);
        overlayCtx.lineTo(bx - px * headHalf, by - py * headHalf);
        overlayCtx.closePath();
        overlayCtx.fill();
    }

    function render() {
        updateSize();
        clear();
        if (!isActive()) return;
        overlayCanvas.style.display = "block";

        var camera = globals.threeView && globals.threeView.camera;
        var modelWrapper = globals.threeView && globals.threeView.modelWrapper;
        var points = globals.facePoints && globals.facePoints.getPoints ? globals.facePoints.getPoints() : null;
        var totalFaces = globals.model && globals.model.getFaces ? globals.model.getFaces().length : 0;
        var faces = globals.model && globals.model.getFaces ? globals.model.getFaces() : null;
        var positions = globals.model && globals.model.getPositionsArray ? globals.model.getPositionsArray() : null;
        if (!camera || !modelWrapper || !points || !totalFaces || !faces || !positions) return;

        modelWrapper.updateMatrixWorld(true);
        var modelWorld = modelWrapper.matrixWorld;
        var POINT_OFFSET = 0.003;

        var w = overlayCanvas.width;
        var h = overlayCanvas.height;
        var styleScale = Math.max(0.75, Math.min(1.35, h / 900));
        var fontSize = Math.round(26 * styleScale);
        var minGap = 28 * styleScale;
        var marginY = 24 * styleScale;
        var laneInset = 20 * styleScale;
        var connectorGap = 10 * styleScale;

        var frontItems = [];
        var backItems = [];

        for (var i = 0; i < points.length; i++) {
            var point = points[i];
            if (!point) continue;
            if (globals.facePoints.isPointHidden && globals.facePoints.isPointHidden(i) && !globals.revealHiddenPoints) continue;
            if (globals.facePoints.isPointVisible && !globals.facePoints.isPointVisible(i)) continue;

            var posLocal = globals.facePoints.getPointPosition ? globals.facePoints.getPointPosition(i) : null;
            if (!posLocal) continue;
            var triIdx = point.faceId < totalFaces ? point.faceId : point.faceId - totalFaces;
            var normalLocal = getFaceNormalLocal(triIdx, faces, positions);
            if (!normalLocal) continue;
            var faceDirLocal = point.faceId < totalFaces ? normalLocal : normalLocal.clone().negate();
            var dotLocal = posLocal.clone().add(faceDirLocal.multiplyScalar(POINT_OFFSET));
            var posWorld = dotLocal.applyMatrix4(modelWorld);
            var screen = worldToScreen(posWorld, camera, w, h);
            if (!screen) continue;

            var side = point.faceId < totalFaces ? "front" : "back";
            var item = {
                label: pointLetter(i),
                anchorX: screen.x,
                anchorY: screen.y,
                side: side,
                labelY: screen.y
            };
            if (side === "front") frontItems.push(item);
            else backItems.push(item);
        }

        layoutLane(frontItems, marginY, h - marginY, minGap);
        layoutLane(backItems, marginY, h - marginY, minGap);

        var allItems = frontItems.concat(backItems);
        var minAnchorX = w * 0.35;
        var maxAnchorX = w * 0.65;
        if (allItems.length > 0) {
            minAnchorX = allItems[0].anchorX;
            maxAnchorX = allItems[0].anchorX;
            for (var ai = 1; ai < allItems.length; ai++) {
                if (allItems[ai].anchorX < minAnchorX) minAnchorX = allItems[ai].anchorX;
                if (allItems[ai].anchorX > maxAnchorX) maxAnchorX = allItems[ai].anchorX;
            }
        }

        var lanePad = 84 * styleScale;
        var laneLeftX = clamp(minAnchorX - lanePad, laneInset, w * 0.48);
        var laneRightX = clamp(maxAnchorX + lanePad, w * 0.52, w - laneInset);

        overlayCtx.save();
        overlayCtx.lineWidth = 2 * styleScale;
        overlayCtx.strokeStyle = "#111111";
        overlayCtx.fillStyle = "#111111";
        overlayCtx.font = "700 " + fontSize + "px Arial";
        overlayCtx.textBaseline = "middle";

        function drawItem(item) {
            var labelX;
            var connectorX;

            if (item.side === "front") {
                overlayCtx.textAlign = "right";
                labelX = laneLeftX - connectorGap;
                connectorX = laneLeftX;
            } else {
                overlayCtx.textAlign = "left";
                labelX = laneRightX + connectorGap;
                connectorX = laneRightX;
            }

            var anchorX = clamp(item.anchorX, 8 * styleScale, w - 8 * styleScale);
            var anchorY = clamp(item.anchorY, 8 * styleScale, h - 8 * styleScale);

            drawArrow(connectorX, item.labelY, anchorX, anchorY, styleScale);

            overlayCtx.beginPath();
            overlayCtx.arc(anchorX, anchorY, 4 * styleScale, 0, Math.PI * 2);
            overlayCtx.fill();

            overlayCtx.lineWidth = 4 * styleScale;
            overlayCtx.strokeStyle = "#ffffff";
            overlayCtx.strokeText(item.label, labelX, item.labelY);
            overlayCtx.lineWidth = 2 * styleScale;
            overlayCtx.strokeStyle = "#111111";
            overlayCtx.fillStyle = "#111111";
            overlayCtx.fillText(item.label, labelX, item.labelY);
        }

        for (var fi = 0; fi < frontItems.length; fi++) drawItem(frontItems[fi]);
        for (var bi = 0; bi < backItems.length; bi++) drawItem(backItems[bi]);

        overlayCtx.restore();
    }

    return {
        render: render,
        clear: clear,
        onResize: updateSize,
        isActive: isActive,
        getCanvas: function () { return overlayCanvas; }
    };
}
