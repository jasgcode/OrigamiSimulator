/**
 * Face (triangle) ID points module.
 * Manages a list of points on mesh faces with barycentric coords.
 * Supports add, remove, update, and conversion between world and barycentric.
 */

function initFacePoints(globals) {

    var points = [];  // [{ faceId, u, v, w }, ...]
    var _modelWorld = new THREE.Matrix4();
    var _modelInv = new THREE.Matrix4();

    function updateModelMatrices() {
        if (globals.threeView && globals.threeView.modelWrapper) {
            globals.threeView.modelWrapper.updateMatrixWorld(true);
            _modelWorld.copy(globals.threeView.modelWrapper.matrixWorld);
            _modelInv.getInverse(_modelWorld);
        } else {
            _modelWorld.identity();
            _modelInv.identity();
        }
    }

    function barycentricToWorld(faceIndex, u, v, w) {
        var faces = globals.model.getFaces();
        var positions = globals.model.getPositionsArray();
        if (!faces || !positions || faceIndex < 0 || faceIndex >= faces.length) return null;
        var face = faces[faceIndex];
        var vA = new THREE.Vector3(positions[face[0] * 3], positions[face[0] * 3 + 1], positions[face[0] * 3 + 2]);
        var vB = new THREE.Vector3(positions[face[1] * 3], positions[face[1] * 3 + 1], positions[face[1] * 3 + 2]);
        var vC = new THREE.Vector3(positions[face[2] * 3], positions[face[2] * 3 + 1], positions[face[2] * 3 + 2]);
        var p = vA.clone().multiplyScalar(u).add(vB.clone().multiplyScalar(v)).add(vC.clone().multiplyScalar(w));
        return p;
    }

    function worldToBarycentric(faceIndex, worldPoint) {
        var faces = globals.model.getFaces();
        var positions = globals.model.getPositionsArray();
        if (!faces || !positions || faceIndex < 0 || faceIndex >= faces.length) return null;
        var face = faces[faceIndex];
        var vA = new THREE.Vector3(positions[face[0] * 3], positions[face[0] * 3 + 1], positions[face[0] * 3 + 2]);
        var vB = new THREE.Vector3(positions[face[1] * 3], positions[face[1] * 3 + 1], positions[face[1] * 3 + 2]);
        var vC = new THREE.Vector3(positions[face[2] * 3], positions[face[2] * 3 + 1], positions[face[2] * 3 + 2]);
        var v0 = vB.clone().sub(vA);
        var v1 = vC.clone().sub(vA);
        var v2 = worldPoint.clone().sub(vA);
        var dot00 = v0.dot(v0);
        var dot01 = v0.dot(v1);
        var dot11 = v1.dot(v1);
        var dot02 = v0.dot(v2);
        var dot12 = v1.dot(v2);
        var denom = dot00 * dot11 - dot01 * dot01;
        if (Math.abs(denom) < 1e-10) return null;
        var v = (dot11 * dot02 - dot01 * dot12) / denom;
        var w = (dot00 * dot12 - dot01 * dot02) / denom;
        var u = 1 - v - w;
        return { u: u, v: v, w: w };
    }

    var BARYCENTRIC_INSET = 0.08;

    function clampBarycentric(uvw) {
        var u = Math.max(0, Math.min(1, uvw.u));
        var v = Math.max(0, Math.min(1, uvw.v));
        var w = 1 - u - v;
        if (w < 0) {
            var excess = -w;
            u = Math.max(0, u - excess / 2);
            v = Math.max(0, v - excess / 2);
            w = 1 - u - v;
        }
        return { u: u, v: v, w: w };
    }

    function insetBarycentric(u, v, w, margin) {
        margin = margin != null ? margin : BARYCENTRIC_INSET;
        var m = margin;
        for (var iter = 0; iter < 6; iter++) {
            u = Math.max(m, Math.min(1 - 2 * m, u));
            v = Math.max(m, Math.min(1 - 2 * m, v));
            w = 1 - u - v;
            if (w < m) {
                w = m;
                var s = u + v;
                if (s > 1e-10) {
                    var r = (1 - m) / s;
                    u = u * r;
                    v = v * r;
                } else {
                    u = v = (1 - m) / 2;
                }
            }
        }
        return { u: u, v: v, w: w };
    }

    function getPoints() {
        return points;
    }

    function addPoint(faceId, u, v, w, hidden) {
        if (u === undefined) u = 1 / 3;
        if (v === undefined) v = 1 / 3;
        if (w === undefined) w = 1 / 3;
        var faces = globals.model.getFaces();
        var N = faces ? faces.length : 0;
        if (faceId < 0 || faceId >= N * 2) return -1;
        points.push({ faceId: faceId, u: u, v: v, w: w, hidden: !!hidden });
        return points.length - 1;
    }

    function isPointHidden(index) {
        if (index < 0 || index >= points.length) return false;
        return !!points[index].hidden;
    }

    function getHiddenIndices() {
        var result = [];
        for (var i = 0; i < points.length; i++) {
            if (points[i].hidden) result.push(i);
        }
        return result;
    }

    function removePoint(index) {
        if (index < 0 || index >= points.length) return;
        points.splice(index, 1);
    }

    function updatePointPosition(index, faceId, u, v, w) {
        if (index < 0 || index >= points.length) return;
        var p = points[index];
        p.faceId = faceId;
        p.u = u;
        p.v = v;
        p.w = w;
    }

    function getPointPosition(index) {
        if (index < 0 || index >= points.length) return null;
        var p = points[index];
        var N = globals.model.getFaces().length;
        var triIdx = p.faceId < N ? p.faceId : p.faceId - N;
        var inset = insetBarycentric(p.u, p.v, p.w);
        return barycentricToWorld(triIdx, inset.u, inset.v, inset.w);
    }

    function getFaceNormal(faceIndex) {
        var faces = globals.model.getFaces();
        var positions = globals.model.getPositionsArray();
        if (!faces || !positions || faceIndex < 0 || faceIndex >= faces.length) return null;
        var face = faces[faceIndex];
        var vA = new THREE.Vector3(positions[face[0]*3], positions[face[0]*3+1], positions[face[0]*3+2]);
        var vB = new THREE.Vector3(positions[face[1]*3], positions[face[1]*3+1], positions[face[1]*3+2]);
        var vC = new THREE.Vector3(positions[face[2]*3], positions[face[2]*3+1], positions[face[2]*3+2]);
        var edge1 = vB.clone().sub(vA);
        var edge2 = vC.clone().sub(vA);
        return edge1.cross(edge2).normalize();
    }

    function pointFromRayIntersection(intersection, meshArray) {
        if (!intersection || !meshArray) return null;
        var faceIndex = intersection.faceIndex;
        if (faceIndex === undefined) faceIndex = Math.floor(intersection.face.a / 3);
        var faces = globals.model.getFaces();
        var N = faces ? faces.length : 0;
        var normal = getFaceNormal(faceIndex);
        if (!normal) return null;
        if (intersection.object && intersection.object.matrixWorld) {
            normal.transformDirection(intersection.object.matrixWorld);
        }
        var toCamera = globals.threeView.camera.position.clone().sub(intersection.point);
        var isBackside = toCamera.dot(normal) < 0;
        var faceId = isBackside ? N + faceIndex : faceIndex;
        updateModelMatrices();
        var localPoint = intersection.point.clone().applyMatrix4(_modelInv);
        var bary = worldToBarycentric(faceIndex, localPoint);
        if (!bary) return null;
        bary = clampBarycentric(bary);
        return { faceId: faceId, u: bary.u, v: bary.v, w: bary.w };
    }

    function clearPoints() {
        points.length = 0;
    }

    function deterministicBarycentric(index) {
        var m = 2147483647;
        var r1 = ((index * 2654435761 + 1013904223) % m) / m;
        var r2 = ((index * 2246822519 + 1013904223) % m) / m;
        if (r1 <= 0) r1 = 1e-10;
        var u = 1 - Math.sqrt(r1);
        var v = Math.sqrt(r1) * (1 - r2);
        var w = Math.sqrt(r1) * r2;
        return { u: u, v: v, w: w };
    }

    function parseBarycentric(val) {
        if (Array.isArray(val) && val.length >= 3) return { u: val[0], v: val[1], w: val[2] };
        if (typeof val === "object" && val !== null && "u" in val && "v" in val && "w" in val) return { u: val.u, v: val.v, w: val.w };
        return null;
    }

    // Returns true if point[index] is both camera-facing AND unoccluded.
    // Step 1 — face-normal test: dot(toCamera, normal) > 0 for front-side points.
    // Step 2 — occlusion test: ray from point position toward camera must not hit
    //           another mesh face before reaching the camera.
    function isPointVisible(index) {
        if (index < 0 || index >= points.length) return false;
        var p = points[index];
        var faces = globals.model.getFaces();
        var N = faces ? faces.length : 0;
        if (N === 0) return false;
        var isFront = p.faceId < N;
        var triIdx = isFront ? p.faceId : p.faceId - N;
        var posLocal = getPointPosition(index);
        var normalLocal = getFaceNormal(triIdx);
        if (!posLocal || !normalLocal) return false;
        var camera = globals.threeView && globals.threeView.camera;
        if (!camera) return false;
        updateModelMatrices();
        var posWorld = posLocal.clone().applyMatrix4(_modelWorld);
        var normalWorld = normalLocal.clone().transformDirection(_modelWorld);
        var toCamera = camera.position.clone().sub(posWorld);
        var dot = toCamera.dot(normalWorld);
        var facingCamera = isFront ? dot > 0 : dot < 0;
        if (!facingCamera) return false;

        // Frustum check — without this, a point can pass the face-normal +
        // occlusion tests but be entirely off-screen (behind camera or
        // outside view cone), and validation falsely passes a preset whose
        // tracked point is invisible in the rendered PNG. Project to NDC
        // and reject anything outside [-1, 1] on x/y/z. The 2D label overlay
        // already does this (pointAnnotations.js:44) — this brings the core
        // visibility gate in line.
        if (camera.matrixWorldInverse && camera.projectionMatrix) {
            var ndc = posWorld.clone().project(camera);
            if (ndc.z < -1 || ndc.z > 1) return false;
            if (ndc.x < -1 || ndc.x > 1) return false;
            if (ndc.y < -1 || ndc.y > 1) return false;
        }

        // Occlusion test — raw ray-triangle, no material.side culling
        var positions = globals.model.getPositionsArray();
        if (!faces || !positions) return true; // can't test, assume visible
        var distToCamera = toCamera.length();
        if (distToCamera < 1e-8) return true;
        var dirWorld = toCamera.clone().divideScalar(distToCamera);
        var originWorld = posWorld.clone().addScaledVector(dirWorld, OCCL_EPSILON);

        var localCamera = camera.position.clone().applyMatrix4(_modelInv);
        var originLocal = originWorld.clone().applyMatrix4(_modelInv);
        var toCameraLocal = localCamera.clone().sub(originLocal);
        var localDistToCamera = toCameraLocal.length();
        if (localDistToCamera < 1e-8) return true;
        var dirLocal = toCameraLocal.clone().divideScalar(localDistToCamera);
        return !isOccluded(originLocal, dirLocal, localDistToCamera, faces, positions);
    }

    // Forward-clearance test. Imagines a short arrow pointing perpendicular
    // and outward from the point along the face's outward normal, then
    // asks two questions:
    //
    //   (1) along-normal path: is any mesh face crossing the arrow body?
    //       (ray from point along +normal for `dist`)
    //   (2) tip visibility:    is the arrow's TIP visible from the camera?
    //       (ray from tip toward camera)
    //
    // isPointVisible already rejects fully-occluded points via (2) applied
    // to the point itself, but a marker/label drawn at a point that is
    // technically visible can still visually collide with a panel sitting
    // just above it along the normal (the point's own camera ray slips
    // past the panel but the slightly-elevated tip does not, or a layer
    // physically crosses the outward arrow). This combined test catches
    // both geometries.
    //
    // dist is in LOCAL (pre-modelWorld) mesh units. The refiner passes
    // ~2% of the mesh bounding-box diagonal, which is enough to
    // discriminate "buried under a layer" from "out in the open".
    //
    // Returns true if the arrow is clear (both checks pass), false if
    // the arrow is cut off or the tip is hidden from the camera.
    function hasForwardClearance(index, dist) {
        if (index < 0 || index >= points.length) return false;
        if (!globals.model || !globals.model.getFaces) return true;
        var faces = globals.model.getFaces();
        var positions = globals.model.getPositionsArray();
        if (!faces || !positions) return true;
        var N = faces.length;
        if (N === 0) return true;
        var p = points[index];
        var isFront = p.faceId < N;
        var triIdx = isFront ? p.faceId : p.faceId - N;
        var posLocal = getPointPosition(index);
        var normalLocal = getFaceNormal(triIdx);
        if (!posLocal || !normalLocal) return true;
        var camera = globals.threeView && globals.threeView.camera;
        if (!camera) return true;
        updateModelMatrices();

        // Back-side points use the inward normal as their "outward".
        var dirLocal = isFront ? normalLocal.clone() : normalLocal.clone().multiplyScalar(-1);

        // (1) Along-normal path check. Nudge origin off the surface so
        //     the point's own face isn't hit.
        var originLocal = posLocal.clone().addScaledVector(dirLocal, OCCL_EPSILON);
        if (isOccluded(originLocal, dirLocal, dist, faces, positions)) return false;

        // (2) Tip visibility check. Compute the arrow tip in local
        //     coords, transform its world-space position, and cast a
        //     ray from the tip back toward the camera. A layer between
        //     the camera and the tip indicates the tip — and therefore
        //     the upper half of the arrow — is hidden.
        var tipLocal = posLocal.clone().addScaledVector(dirLocal, dist);
        var tipWorld = tipLocal.clone().applyMatrix4(_modelWorld);
        var toCameraWorld = camera.position.clone().sub(tipWorld);
        var distToCamera = toCameraWorld.length();
        if (distToCamera < 1e-8) return true;
        var dirToCameraWorld = toCameraWorld.clone().divideScalar(distToCamera);
        // Transform the ray into local space so we can reuse the local
        // positions array for triangle intersection.
        var originTipLocal = tipLocal.clone().addScaledVector(
            dirToCameraWorld.clone().transformDirection(_modelInv).normalize(),
            OCCL_EPSILON
        );
        var localCamera = camera.position.clone().applyMatrix4(_modelInv);
        var toCameraLocal = localCamera.clone().sub(originTipLocal);
        var localDistToCamera = toCameraLocal.length();
        if (localDistToCamera < 1e-8) return true;
        var dirToCameraLocal = toCameraLocal.clone().divideScalar(localDistToCamera);
        return !isOccluded(originTipLocal, dirToCameraLocal, localDistToCamera, faces, positions);
    }

    // Returns points array enriched with world position and camera-facing visibility.
    function getPointsWithVisibility() {
        return points.map(function (p, i) {
            var faces = globals.model.getFaces();
            var N = faces ? faces.length : 0;
            var isFront = p.faceId < N;
            var pos = getPointPosition(i);
            return {
                index: i,
                faceId: p.faceId,
                isFront: isFront,
                u: p.u,
                v: p.v,
                w: p.w,
                position: pos ? { x: pos.x, y: pos.y, z: pos.z } : null,
                visible: isPointVisible(i)
            };
        });
    }

    function initFromConfig(config) {
        clearPoints();
        var faces = globals.model.getFaces();
        var N = faces ? faces.length : 0;
        var maxFaceId = N * 2 - 1;
        if (!config || N === 0) return;
        var globalIndex = 0;
        if (Array.isArray(config)) {
            for (var i = 0; i < config.length; i++) {
                var entry = config[i];
                var faceId = parseInt(entry.faceId != null ? entry.faceId : entry.face, 10);
                if (isNaN(faceId) || faceId < 0 || faceId > maxFaceId) continue;
                var bary = parseBarycentric(entry);
                var isHidden = !!entry.hidden;
                if (bary) {
                    addPoint(faceId, bary.u, bary.v, bary.w, isHidden);
                } else {
                    var count = parseInt(entry.count != null ? entry.count : 1, 10);
                    for (var j = 0; j < count; j++) {
                        bary = deterministicBarycentric(globalIndex++);
                        addPoint(faceId, bary.u, bary.v, bary.w, isHidden);
                    }
                }
            }
            return;
        }
        if (typeof config !== "object") return;
        for (var key in config) {
            var faceId = parseInt(key, 10);
            if (isNaN(faceId) || faceId < 0 || faceId > maxFaceId) continue;
            var val = config[key];
            if (Array.isArray(val) && val.length > 0) {
                for (var k = 0; k < val.length; k++) {
                    var bary = parseBarycentric(val[k]);
                    var isHidden = !!(val[k] && val[k].hidden);
                    if (bary) {
                        addPoint(faceId, bary.u, bary.v, bary.w, isHidden);
                    } else {
                        bary = deterministicBarycentric(globalIndex++);
                        addPoint(faceId, bary.u, bary.v, bary.w, isHidden);
                    }
                }
            } else {
                var count = parseInt(val, 10);
                if (isNaN(count) || count < 1) continue;
                for (var j = 0; j < count; j++) {
                    var bary = deterministicBarycentric(globalIndex++);
                    addPoint(faceId, bary.u, bary.v, bary.w);
                }
            }
        }
    }

    // Raw ray-triangle occlusion test (no Raycaster — bypasses material.side culling).
    // Returns true if any triangle in the mesh blocks the segment [origin → origin+dir*maxDist].
    var _occRay  = new THREE.Ray();
    var _occVA   = new THREE.Vector3();
    var _occVB   = new THREE.Vector3();
    var _occVC   = new THREE.Vector3();
    var _occHit  = new THREE.Vector3();
    var OCCL_EPSILON = 0.002;
    function isOccluded(origin, dir, maxDist, faces, positions) {
        _occRay.set(origin, dir);
        for (var j = 0; j < faces.length; j++) {
            var f = faces[j];
            _occVA.set(positions[f[0]*3], positions[f[0]*3+1], positions[f[0]*3+2]);
            _occVB.set(positions[f[1]*3], positions[f[1]*3+1], positions[f[1]*3+2]);
            _occVC.set(positions[f[2]*3], positions[f[2]*3+1], positions[f[2]*3+2]);
            // backfaceCulling = false so we catch panels folded over from either side
            if (_occRay.intersectTriangle(_occVA, _occVB, _occVC, false, _occHit)) {
                var d = origin.distanceTo(_occHit);
                if (d > OCCL_EPSILON && d < maxDist - OCCL_EPSILON) return true;
            }
        }
        return false;
    }

    // Returns face IDs (0..N-1) that are both camera-facing AND unoccluded.
    // Step 1 — backface cull: dot(camera - centroid, outwardNormal) > 0
    // Step 2 — occlusion: raw ray-triangle test from centroid toward camera.
    function getVisibleFaceIds() {
        var faces = globals.model.getFaces();
        var positions = globals.model.getPositionsArray();
        var camera = globals.threeView && globals.threeView.camera;
        if (!faces || !positions || !camera) return [];
        updateModelMatrices();
        var localCamera = camera.position.clone().applyMatrix4(_modelInv);
        var N = faces.length;
        var result = [];
        for (var i = 0; i < N; i++) {
            var normalLocal = getFaceNormal(i);
            if (!normalLocal) continue;
            var face = faces[i];
            var centroidLocal = new THREE.Vector3(
                (positions[face[0]*3]   + positions[face[1]*3]   + positions[face[2]*3])   / 3,
                (positions[face[0]*3+1] + positions[face[1]*3+1] + positions[face[2]*3+1]) / 3,
                (positions[face[0]*3+2] + positions[face[1]*3+2] + positions[face[2]*3+2]) / 3
            );
            var centroidWorld = centroidLocal.clone().applyMatrix4(_modelWorld);
            var normalWorld = normalLocal.clone().transformDirection(_modelWorld);
            var toCamera = camera.position.clone().sub(centroidWorld);
            var dot = toCamera.dot(normalWorld);
            if (dot <= 0) continue; // back-facing, skip

            var distToCamera = toCamera.length();
            if (distToCamera < 1e-8) continue;
            var dirWorld = toCamera.clone().divideScalar(distToCamera);
            var originWorld = centroidWorld.clone().addScaledVector(dirWorld, OCCL_EPSILON);

            var originLocal = originWorld.clone().applyMatrix4(_modelInv);
            var toCameraLocal = localCamera.clone().sub(originLocal);
            var localDistToCamera = toCameraLocal.length();
            if (localDistToCamera < 1e-8) continue;
            var dirLocal = toCameraLocal.clone().divideScalar(localDistToCamera);
            if (!isOccluded(originLocal, dirLocal, localDistToCamera, faces, positions)) result.push(i);
        }
        return result;
    }

    // Same as getVisibleFaceIds but returns face indices (0..N-1) whose
    // BACK side is camera-facing AND unoccluded. A "back-side-visible" face
    // is one where front-normal · toCamera < 0 (so back normal points
    // toward camera) and the centroid is unoccluded by other geometry.
    // This is the primitive used by the trajectory-first preset generator
    // to pick d2/d4 hidden-back face indices, which are then stored in the
    // preset with faceId = (idx + N) so isPointVisible's `isFront = id < N`
    // path correctly checks back-facing visibility.
    function getBackSideVisibleFaceIds() {
        var faces = globals.model.getFaces();
        var positions = globals.model.getPositionsArray();
        var camera = globals.threeView && globals.threeView.camera;
        if (!faces || !positions || !camera) return [];
        updateModelMatrices();
        var localCamera = camera.position.clone().applyMatrix4(_modelInv);
        var N = faces.length;
        var result = [];
        for (var i = 0; i < N; i++) {
            var normalLocal = getFaceNormal(i);
            if (!normalLocal) continue;
            var face = faces[i];
            var centroidLocal = new THREE.Vector3(
                (positions[face[0]*3]   + positions[face[1]*3]   + positions[face[2]*3])   / 3,
                (positions[face[0]*3+1] + positions[face[1]*3+1] + positions[face[2]*3+1]) / 3,
                (positions[face[0]*3+2] + positions[face[1]*3+2] + positions[face[2]*3+2]) / 3
            );
            var centroidWorld = centroidLocal.clone().applyMatrix4(_modelWorld);
            var normalWorld = normalLocal.clone().transformDirection(_modelWorld);
            var toCamera = camera.position.clone().sub(centroidWorld);
            var dot = toCamera.dot(normalWorld);
            // Inverted check vs getVisibleFaceIds: back-facing means dot < 0.
            if (dot >= 0) continue; // front-facing, skip — caller wants back-side only

            var distToCamera = toCamera.length();
            if (distToCamera < 1e-8) continue;
            var dirWorld = toCamera.clone().divideScalar(distToCamera);
            var originWorld = centroidWorld.clone().addScaledVector(dirWorld, OCCL_EPSILON);

            var originLocal = originWorld.clone().applyMatrix4(_modelInv);
            var toCameraLocal = localCamera.clone().sub(originLocal);
            var localDistToCamera = toCameraLocal.length();
            if (localDistToCamera < 1e-8) continue;
            var dirLocal = toCameraLocal.clone().divideScalar(localDistToCamera);
            if (!isOccluded(originLocal, dirLocal, localDistToCamera, faces, positions)) result.push(i);
        }
        return result;
    }

    // Returns a quality score (0–1) for each face in faceIds: quality = dot(normalise(toCamera), normal).
    // 1.0 = squarely facing camera, ~0 = grazing angle.
    // Only front-facing faces (id < N) are scored; others get 0.
    function getFaceViewQualities(faceIds) {
        var faces = globals.model.getFaces();
        var positions = globals.model.getPositionsArray();
        var camera = globals.threeView && globals.threeView.camera;
        if (!faces || !positions || !camera) return {};
        updateModelMatrices();
        var N = faces.length;
        var result = {};
        for (var i = 0; i < faceIds.length; i++) {
            var id = faceIds[i];
            if (id < 0 || id >= N) { result[id] = 0; continue; }
            var normalLocal = getFaceNormal(id);
            if (!normalLocal) { result[id] = 0; continue; }
            var face = faces[id];
            var centroidLocal = new THREE.Vector3(
                (positions[face[0]*3]   + positions[face[1]*3]   + positions[face[2]*3])   / 3,
                (positions[face[0]*3+1] + positions[face[1]*3+1] + positions[face[2]*3+1]) / 3,
                (positions[face[0]*3+2] + positions[face[1]*3+2] + positions[face[2]*3+2]) / 3
            );
            var centroidWorld = centroidLocal.clone().applyMatrix4(_modelWorld);
            var normalWorld = normalLocal.clone().transformDirection(_modelWorld);
            var toCamera = camera.position.clone().sub(centroidWorld);
            var dist = toCamera.length();
            result[id] = dist > 0 ? Math.max(0, toCamera.dot(normalWorld) / dist) : 0;
        }
        return result;
    }

    // Back-side analogue of getFaceViewQualities. Score is how directly the
    // face's BACK surface points at the camera: 1.0 = squarely back-facing,
    // ~0 = grazing or front-facing. Faces whose front normal is toward the
    // camera (dot >= 0) score 0. No occlusion test here — pair with
    // getBackSideVisibleFaceIds when occlusion-aware filtering is needed.
    function getFaceBackQualities(faceIds) {
        var faces = globals.model.getFaces();
        var positions = globals.model.getPositionsArray();
        var camera = globals.threeView && globals.threeView.camera;
        if (!faces || !positions || !camera) return {};
        updateModelMatrices();
        var N = faces.length;
        var result = {};
        for (var i = 0; i < faceIds.length; i++) {
            var id = faceIds[i];
            if (id < 0 || id >= N) { result[id] = 0; continue; }
            var normalLocal = getFaceNormal(id);
            if (!normalLocal) { result[id] = 0; continue; }
            var face = faces[id];
            var centroidLocal = new THREE.Vector3(
                (positions[face[0]*3]   + positions[face[1]*3]   + positions[face[2]*3])   / 3,
                (positions[face[0]*3+1] + positions[face[1]*3+1] + positions[face[2]*3+1]) / 3,
                (positions[face[0]*3+2] + positions[face[1]*3+2] + positions[face[2]*3+2]) / 3
            );
            var centroidWorld = centroidLocal.clone().applyMatrix4(_modelWorld);
            var normalWorld = normalLocal.clone().transformDirection(_modelWorld);
            var toCamera = camera.position.clone().sub(centroidWorld);
            var dist = toCamera.length();
            result[id] = dist > 0 ? Math.max(0, -toCamera.dot(normalWorld) / dist) : 0;
        }
        return result;
    }

    return {
        getPoints: getPoints,
        addPoint: addPoint,
        removePoint: removePoint,
        updatePointPosition: updatePointPosition,
        getPointPosition: getPointPosition,
        pointFromRayIntersection: pointFromRayIntersection,
        barycentricToWorld: barycentricToWorld,
        worldToBarycentric: worldToBarycentric,
        clampBarycentric: clampBarycentric,
        insetBarycentric: insetBarycentric,
        clearPoints: clearPoints,
        initFromConfig: initFromConfig,
        isPointVisible: isPointVisible,
        hasForwardClearance: hasForwardClearance,
        getPointsWithVisibility: getPointsWithVisibility,
        getVisibleFaceIds: getVisibleFaceIds,
        getBackSideVisibleFaceIds: getBackSideVisibleFaceIds,
        getFaceViewQualities: getFaceViewQualities,
        getFaceBackQualities: getFaceBackQualities,
        isPointHidden: isPointHidden,
        getHiddenIndices: getHiddenIndices
    };
}
