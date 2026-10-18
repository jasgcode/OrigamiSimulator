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
        if (!(globals.colorMode === "labelOnly" || globals.colorMode === "faceTriangleID" || globals.colorMode === "greyscaleLabel")) return false;
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
            var y = clamp(items[i].anchorY + (items[i].labelShift || 0), minY, maxY);
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

    // Splits labels into a left and a right lane. Each leader line runs
    // straight from its lane to its dot, so in a tight group a line can cross
    // other dots or other lines. Starting from a split at the anchors' centroid, labels
    // switch lanes or shift up or down (tilting the line) while that reduces
    // the number of dots crossed.
    // The capture draws the step caption ("STATE N") over the top-left corner
    // after the labels (js/threeView.js): 16 CSS px from the top, 48 px text
    // and 4 px padding above and below. Left-lane labels start below it, or a
    // label there loses its letter under the caption.
    var CAPTION_BOTTOM_CSS = 16 + 48 + 8;
    function captionBottom(w) {
        var base = globals.threeView && globals.threeView.renderer && globals.threeView.renderer.domElement;
        return CAPTION_BOTTOM_CSS * (base && base.clientWidth ? w / base.clientWidth : 1);
    }

    function arrangeLabels(items, w, h, styleScale) {
        var minGap = 28 * styleScale;
        var marginY = 24 * styleScale;
        var leftTop = Math.max(marginY, captionBottom(w) + minGap / 2);
        var laneInset = 20 * styleScale;
        var lanePad = 84 * styleScale;
        // Slightly more than a marker's on-screen radius.
        var clearPx = 14 * styleScale;

        function initialSides() {
            if (items.length === 0) return [];
            var centroidX = 0;
            for (var ci = 0; ci < items.length; ci++) centroidX += items[ci].anchorX;
            centroidX /= items.length;
            // Clamp centroid so we don't put all labels on one extreme edge
            centroidX = clamp(centroidX, w * 0.25, w * 0.75);
            var sides = items.map(function (item) { return item.anchorX <= centroidX ? "left" : "right"; });
            // If all items ended up on one side, split the outermost one to the other
            var order = items.map(function (_, i) { return i; }).sort(function (a, b) { return items[a].anchorX - items[b].anchorX; });
            var lefts = sides.filter(function (side) { return side === "left"; }).length;
            if (lefts === 0 && items.length > 1) sides[order[0]] = "left";
            else if (lefts === items.length && items.length > 1) sides[order[order.length - 1]] = "right";
            return sides;
        }

        // Resolve line crossings within each lane: if two labels' lines cross,
        // swap their labelY positions to uncross them
        function uncrossLane(laneItems) {
            if (laneItems.length < 2) return;
            var swapped = true;
            var maxPasses = laneItems.length * laneItems.length;
            while (swapped && maxPasses-- > 0) {
                swapped = false;
                for (var a = 0; a < laneItems.length - 1; a++) {
                    for (var b = a + 1; b < laneItems.length; b++) {
                        // Lines cross if label order and anchor order disagree
                        var labelOrder = laneItems[a].labelY - laneItems[b].labelY;
                        var anchorOrder = laneItems[a].anchorY - laneItems[b].anchorY;
                        if (labelOrder * anchorOrder < 0) {
                            var tmp = laneItems[a].labelY;
                            laneItems[a].labelY = laneItems[b].labelY;
                            laneItems[b].labelY = tmp;
                            swapped = true;
                        }
                    }
                }
            }
        }

        function arrange(sides, shifts) {
            var leftItems = [], rightItems = [];
            items.forEach(function (item, i) {
                item.side = sides[i];
                item.labelShift = shifts[i] * minGap;
                (sides[i] === "left" ? leftItems : rightItems).push(item);
            });
            layoutLane(leftItems, leftTop, h - marginY, minGap);
            layoutLane(rightItems, marginY, h - marginY, minGap);
            uncrossLane(leftItems);
            uncrossLane(rightItems);
            // Compute lane X positions based on each side's anchors
            var laneLeftX = laneInset, laneRightX = w - laneInset;
            if (leftItems.length > 0) {
                var minLeftAnchor = Math.min.apply(null, leftItems.map(function (item) { return item.anchorX; }));
                laneLeftX = clamp(minLeftAnchor - lanePad, laneInset, w * 0.48);
            }
            if (rightItems.length > 0) {
                var maxRightAnchor = Math.max.apply(null, rightItems.map(function (item) { return item.anchorX; }));
                laneRightX = clamp(maxRightAnchor + lanePad, w * 0.52, w - laneInset);
            }
            return { leftItems: leftItems, rightItems: rightItems, laneLeftX: laneLeftX, laneRightX: laneRightX };
        }

        function segmentDistance(px, py, ax, ay, bx, by) {
            var dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
            var t = len2 > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0;
            return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
        }

        function segmentsIntersect(a, b) {
            function orient(p, q, r) { return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); }
            var d1 = orient(b[0], b[1], a[0]), d2 = orient(b[0], b[1], a[1]);
            var d3 = orient(a[0], a[1], b[0]), d4 = orient(a[0], a[1], b[1]);
            return d1 * d2 < 0 && d3 * d4 < 0;
        }

        // Leader lines that pass over another dot, and pairs of lines that cross.
        function crossingCounts(layout) {
            var dots = 0, lines = 0;
            var segments = items.map(function (item) {
                var fromX = item.side === "left" ? layout.laneLeftX : layout.laneRightX;
                return [[fromX, item.labelY], [item.anchorX, item.anchorY]];
            });
            items.forEach(function (item, i) {
                var seg = segments[i];
                items.forEach(function (other, j) {
                    if (j === i) return;
                    if (segmentDistance(other.anchorX, other.anchorY, seg[0][0], seg[0][1], seg[1][0], seg[1][1]) < clearPx) dots++;
                    if (j > i && segmentsIntersect(seg, segments[j])) lines++;
                });
            });
            return { dots: dots, lines: lines };
        }
        function crossings(layout) {
            var c = crossingCounts(layout);
            return c.dots + c.lines;
        }

        var sides = initialSides();
        var shifts = items.map(function () { return 0; });
        var best = crossings(arrange(sides, shifts));
        // Greedy: apply the single move (lane switch or shift of up to two
        // label gaps) that removes the most crossings.
        var SHIFTS = [0, -1, 1, -2, 2];
        for (var round = 0; best > 0 && round < 3 * items.length; round++) {
            var bestMove = null;
            for (var f = 0; f < items.length; f++) {
                var oldSide = sides[f], oldShift = shifts[f];
                ["left", "right"].forEach(function (side) {
                    SHIFTS.forEach(function (shift) {
                        if (side === oldSide && shift === oldShift) return;
                        sides[f] = side; shifts[f] = shift;
                        var c = crossings(arrange(sides, shifts));
                        if (c < best) { best = c; bestMove = { index: f, side: side, shift: shift }; }
                    });
                });
                sides[f] = oldSide; shifts[f] = oldShift;
            }
            if (!bestMove) break;
            sides[bestMove.index] = bestMove.side;
            shifts[bestMove.index] = bestMove.shift;
        }
        var layout = arrange(sides, shifts);
        var counts = crossingCounts(layout);
        layout.dotCrossings = counts.dots;
        layout.lineCrossings = counts.lines;
        return layout;
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

    // Screen-space label items for the dots render() would draw. Hidden dots
    // are included when revealed, or when includeHidden asks for the final
    // frame's dots before the reveal. Returns null when the scene is not ready.
    function collectItems(w, h, includeHidden) {
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

        var visibleItems = [];

        for (var i = 0; i < points.length; i++) {
            var point = points[i];
            if (!point) continue;
            if (globals.facePoints.isPointHidden && globals.facePoints.isPointHidden(i) && !globals.revealHiddenPoints && !includeHidden) continue;
            if (globals.facePoints.isPointVisible && !globals.facePoints.isPointVisible(i)) continue;

            var posLocal = globals.facePoints.getPointPosition ? globals.facePoints.getPointPosition(i) : null;
            if (!posLocal) continue;
            var triIdx = point.faceId < totalFaces ? point.faceId : point.faceId - totalFaces;
            var normalLocal = getFaceNormalLocal(triIdx, faces, positions);
            if (!normalLocal) continue;
            var faceDirLocal = point.faceId < totalFaces ? normalLocal : normalLocal.clone().negate();
            var dotLocal = posLocal.clone().add(faceDirLocal.clone().multiplyScalar(POINT_OFFSET));
            var screen = worldToScreen(dotLocal.clone().applyMatrix4(modelWorld), camera, w, h);
            if (!screen) continue;
            var endScale = (globals.revealHiddenPoints || includeHidden) && globals.facePoints.pointEndScale
                ? globals.facePoints.pointEndScale(i) : 1;

            visibleItems.push({
                label: pointLetter(i),
                anchorX: screen.x,
                anchorY: screen.y,
                labelY: screen.y,
                scale: endScale,
                rim: dotRim(dotLocal, faceDirLocal, modelWorld, camera, w, h, screen, endScale)
            });
        }
        return visibleItems;
    }

    // Screen offsets from the anchor to points on the dot's edge. The dot is a
    // disc in its panel's plane (js/model.js draws the black circle out to
    // 28/32 of the disc radius), so a tilted panel shows it as an ellipse.
    var DOT_FILL = 28 / 32;
    // `scale` is the dot's size relative to the preset's (its end size in the
    // last image).
    function dotRim(centerLocal, normalLocal, modelWorld, camera, w, h, anchor, scale) {
        var radius = (globals.facePointRadius || 0.025) * DOT_FILL * (scale || 1);
        var n = normalLocal.clone().normalize();
        var a = new THREE.Vector3(1, 0, 0);
        if (Math.abs(n.dot(a)) > 0.9) a.set(0, 1, 0);
        a.sub(n.clone().multiplyScalar(a.dot(n))).normalize();
        var b = n.clone().cross(a);
        var rim = [];
        for (var k = 0; k < 16; k++) {
            var t = 2 * Math.PI * k / 16;
            var edge = centerLocal.clone()
                .add(a.clone().multiplyScalar(radius * Math.cos(t)))
                .add(b.clone().multiplyScalar(radius * Math.sin(t)));
            var s = worldToScreen(edge.applyMatrix4(modelWorld), camera, w, h);
            if (s) rim.push([s.x - anchor.x, s.y - anchor.y]);
        }
        return rim;
    }

    // Distance from the anchor at which a leader line heading toward
    // (dirX, dirY) leaves the dot: the dot's extent along that direction, at
    // least the overlay disc. Arrows stop a gap past it, so the arrowhead
    // never covers a small or foreshortened dot.
    function dotReach(item, dirX, dirY, styleScale) {
        var reach = 4 * styleScale * (item.scale || 1);
        (item.rim || []).forEach(function (o) { reach = Math.max(reach, o[0] * dirX + o[1] * dirY); });
        return reach;
    }

    function styleScaleFor(h) {
        return Math.max(0.75, Math.min(1.35, h / 900));
    }

    // Crossings in the label layout of the final frame as it stands now, with
    // hidden dots revealed: leader lines over another dot, and crossing lines.
    // Validation rejects clustered presets whose lines pass over a dot.
    function labelCrossings() {
        var base = globals.threeView && globals.threeView.renderer && globals.threeView.renderer.domElement;
        if (overlayCanvas) updateSize();
        var w = overlayCanvas ? overlayCanvas.width : base && base.width;
        var h = overlayCanvas ? overlayCanvas.height : base && base.height;
        var items = w && h ? collectItems(w, h, true) : null;
        if (!items) return null;
        var layout = arrangeLabels(items, w, h, styleScaleFor(h));
        return { dots: layout.dotCrossings, lines: layout.lineCrossings };
    }

    function render() {
        updateSize();
        clear();
        if (!isActive()) return;
        overlayCanvas.style.display = "block";

        var w = overlayCanvas.width;
        var h = overlayCanvas.height;
        var styleScale = styleScaleFor(h);
        var fontSize = Math.round(26 * styleScale);
        var connectorGap = 10 * styleScale;
        var visibleItems = collectItems(w, h, false);
        if (!visibleItems) return;

        var arranged = arrangeLabels(visibleItems, w, h, styleScale);
        var leftItems = arranged.leftItems;
        var rightItems = arranged.rightItems;
        var laneLeftX = arranged.laneLeftX;
        var laneRightX = arranged.laneRightX;

        overlayCtx.save();
        overlayCtx.lineWidth = 2 * styleScale;
        overlayCtx.strokeStyle = "#111111";
        overlayCtx.fillStyle = "#111111";
        overlayCtx.font = "700 " + fontSize + "px Arial";
        overlayCtx.textBaseline = "middle";

        function drawItem(item) {
            var labelX;
            var connectorX;

            if (item.side === "left") {
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

            var dx = connectorX - anchorX, dy = item.labelY - anchorY;
            var len = Math.sqrt(dx * dx + dy * dy);
            if (len > 0.001) {
                var stop = dotReach(item, dx / len, dy / len, styleScale) + 3 * styleScale;
                if (len - stop > 10 * styleScale) {
                    drawArrow(connectorX, item.labelY, anchorX + dx / len * stop, anchorY + dy / len * stop, styleScale);
                }
            }

            overlayCtx.beginPath();
            overlayCtx.arc(anchorX, anchorY, 4 * styleScale * (item.scale || 1), 0, Math.PI * 2);
            overlayCtx.fill();

            overlayCtx.lineWidth = 4 * styleScale;
            overlayCtx.strokeStyle = "#ffffff";
            // Mitred joins spike past the sharp inner corners of M, V and W.
            overlayCtx.lineJoin = "round";
            overlayCtx.strokeText(item.label, labelX, item.labelY);
            overlayCtx.lineWidth = 2 * styleScale;
            overlayCtx.strokeStyle = "#111111";
            overlayCtx.fillStyle = "#111111";
            overlayCtx.fillText(item.label, labelX, item.labelY);
        }

        for (var fi = 0; fi < leftItems.length; fi++) drawItem(leftItems[fi]);
        for (var bi = 0; bi < rightItems.length; bi++) drawItem(rightItems[bi]);

        overlayCtx.restore();
    }

    return {
        render: render,
        labelCrossings: labelCrossings,
        clear: clear,
        onResize: updateSize,
        isActive: isActive,
        getCanvas: function () { return overlayCanvas; }
    };
}
