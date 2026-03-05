/**
 * Face (triangle) ID points module.
 * Manages a list of points on mesh faces with barycentric coords.
 * Supports add, remove, update, and conversion between world and barycentric.
 */

function initFacePoints(globals) {

    var points = [];  // [{ faceId, u, v, w }, ...]

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

    function getPoints() {
        return points;
    }

    function addPoint(faceId, u, v, w) {
        if (u === undefined) u = 1 / 3;
        if (v === undefined) v = 1 / 3;
        if (w === undefined) w = 1 / 3;
        var faces = globals.model.getFaces();
        var N = faces ? faces.length : 0;
        if (faceId < 0 || faceId >= N * 2) return -1;
        points.push({ faceId: faceId, u: u, v: v, w: w });
        return points.length - 1;
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
        return barycentricToWorld(triIdx, p.u, p.v, p.w);
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
        var bary = worldToBarycentric(faceIndex, intersection.point);
        if (!bary) return null;
        bary = clampBarycentric(bary);
        return { faceId: faceId, u: bary.u, v: bary.v, w: bary.w };
    }

    function clearPoints() {
        points.length = 0;
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
        clearPoints: clearPoints
    };
}
