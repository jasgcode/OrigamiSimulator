/**
 * Created by amandaghassaei on 2/24/17.
 */

//model updates object3d geometry and materials

function initModel(globals){

    var material, material2, geometry, lineGeo;
    var frontside = new THREE.Mesh();//front face of mesh
    var backside = new THREE.Mesh();//back face of mesh (different color)
    backside.visible = false;

    var lineMaterial = new THREE.LineBasicMaterial({color: 0x000000, linewidth: 1});
    var hingeLines = new THREE.LineSegments(null, lineMaterial);
    var mountainLines = new THREE.LineSegments(null, lineMaterial);
    var valleyLines = new THREE.LineSegments(null, lineMaterial);
    var cutLines = new THREE.LineSegments(null, lineMaterial);
    var facetLines = new THREE.LineSegments(null, lineMaterial);
    var borderLines = new THREE.LineSegments(null, lineMaterial);

    var lines = {
        U: hingeLines,
        M: mountainLines,
        V: valleyLines,
        C: cutLines,
        F: facetLines,
        B: borderLines
    };

    clearGeometries();
    setMeshMaterial();

    function clearGeometries(){

        if (geometry) {
            frontside.geometry = null;
            backside.geometry = null;
            geometry.dispose();
        }

        geometry = new THREE.BufferGeometry();
        frontside.geometry = geometry;
        backside.geometry = geometry;
        geometry.dynamic = true;

        _.each(lines, function(line){
            var lineGeometry = line.geometry;
            if (lineGeometry) {
                line.geometry = null;
                lineGeometry.dispose();
            }

            lineGeometry = new THREE.BufferGeometry();
            line.geometry = lineGeometry;
            lineGeometry.dynamic = true;
        });
    }

    globals.threeView.sceneAddModel(frontside);
    globals.threeView.sceneAddModel(backside);
    _.each(lines, function(line){
        globals.threeView.sceneAddModel(line);
    });

    //3D label sprites for Point A and Point B
    var labelA = createLabelSprite("A", "#ff3333");//matches colorA in updateFaceColors
    var labelB = createLabelSprite("B", "#3366ff");//matches colorB in updateFaceColors
    labelA.visible = false;
    labelB.visible = false;
    globals.threeView.sceneAddModel(labelA);
    globals.threeView.sceneAddModel(labelB);

    function createLabelSprite(text, bgColor){
        var canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        var ctx = canvas.getContext('2d');
        //circle background
        ctx.beginPath();
        ctx.arc(64, 64, 56, 0, 2 * Math.PI);
        ctx.fillStyle = bgColor;
        ctx.fill();
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 4;
        ctx.stroke();
        //text
        ctx.fillStyle = "#000000";
        ctx.font = "bold 72px Arial";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, 64, 68);
        var texture = new THREE.CanvasTexture(canvas);
        var spriteMaterial = new THREE.SpriteMaterial({map: texture, depthTest: false});
        var sprite = new THREE.Sprite(spriteMaterial);
        sprite.scale.set(0.08, 0.08, 0.08);
        return sprite;
    }

    function getPanelCentroid(panelIndex){
        var cx = 0, cy = 0, cz = 0, count = 0;
        for (var f = 0; f < faces.length; f++){
            if (faceToPanel[f] !== panelIndex) continue;
            var face = faces[f];
            for (var v = 0; v < 3; v++){
                cx += positions[face[v]*3];
                cy += positions[face[v]*3+1];
                cz += positions[face[v]*3+2];
                count++;
            }
        }
        if (count === 0) return null;
        return new THREE.Vector3(cx/count, cy/count, cz/count);
    }

    function updateLabels(){
        var showLabels = globals.colorMode == "faceID" || globals.colorMode == "labelOnly";
        if (showLabels && globals.highlightedFaceA >= 0 && globals.highlightedFaceA < numPanels){
            var centroid = getPanelCentroid(globals.highlightedFaceA);
            if (centroid){
                labelA.position.copy(centroid);
                labelA.position.y += 0.08;
                labelA.visible = true;
            } else { labelA.visible = false; }
        } else {
            labelA.visible = false;
        }
        if (showLabels && globals.highlightedFaceB >= 0 && globals.highlightedFaceB < numPanels){
            var centroid = getPanelCentroid(globals.highlightedFaceB);
            if (centroid){
                labelB.position.copy(centroid);
                labelB.position.y += 0.08;
                labelB.visible = true;
            } else { labelB.visible = false; }
        } else {
            labelB.visible = false;
        }
    }

    var positions;//node positions (shared by lines)
    var colors;//node colors (for strain mode)
    var meshPositions;//per-face vertex positions (non-indexed, for mesh)
    var meshColors;//per-face vertex colors (non-indexed, for mesh)
    var panelColorPalette = [];//precomputed color per logical panel
    var faceToPanel = [];//maps triangle index to logical panel index
    var numPanels = 0;
    var indices;
    var nodes = [];
    var faces = [];
    var edges = [];
    var creases = [];
    var vertices = [];//indexed vertices array
    var fold, creaseParams;

    var nextCreaseParams, nextFold;

    var inited = false;

    function setMeshMaterial() {
        var polygonOffset = 0.5;
        if (globals.colorMode == "normal") {
            material = new THREE.MeshNormalMaterial({
                flatShading:true,
                side: THREE.DoubleSide,
                polygonOffset: true,
                polygonOffsetFactor: polygonOffset,
                polygonOffsetUnits: 1
            });
            backside.visible = false;
        } else if (globals.colorMode == "axialStrain"){
            material = new THREE.MeshBasicMaterial({
                vertexColors: THREE.VertexColors, side:THREE.DoubleSide,
                polygonOffset: true,
                polygonOffsetFactor: polygonOffset,
                polygonOffsetUnits: 1
            });
            backside.visible = false;
            if (!globals.threeView.simulationRunning) {
                getSolver().render();
                setGeoUpdates();
            }
        } else if (globals.colorMode == "faceID"){
            material = new THREE.MeshBasicMaterial({
                vertexColors: THREE.VertexColors,
                side: THREE.DoubleSide,
                polygonOffset: true,
                polygonOffsetFactor: polygonOffset,
                polygonOffsetUnits: 1
            });
            backside.visible = false;
            updateFaceColors();
        } else if (globals.colorMode == "labelOnly"){
            material = new THREE.MeshPhongMaterial({
                flatShading:true,
                side:THREE.FrontSide,
                polygonOffset: true,
                polygonOffsetFactor: polygonOffset,
                polygonOffsetUnits: 1
            });
            material2 = new THREE.MeshPhongMaterial({
                flatShading:true,
                side:THREE.BackSide,
                polygonOffset: true,
                polygonOffsetFactor: polygonOffset,
                polygonOffsetUnits: 1
            });
            material.color.setStyle( "#" + globals.color1);
            material2.color.setStyle( "#" + globals.color2);
            backside.visible = true;
            updateLabels();
        } else {
            material = new THREE.MeshPhongMaterial({
                flatShading:true,
                side:THREE.FrontSide,
                polygonOffset: true,
                polygonOffsetFactor: polygonOffset,
                polygonOffsetUnits: 1
            });
            material2 = new THREE.MeshPhongMaterial({
                flatShading:true,
                side:THREE.BackSide,
                polygonOffset: true,
                polygonOffsetFactor: polygonOffset,
                polygonOffsetUnits: 1
            });
            material.color.setStyle( "#" + globals.color1);
            material2.color.setStyle( "#" + globals.color2);
            backside.visible = true;
        }
        frontside.material = material;
        backside.material = material2;
    }

    function buildPanelMap(){
        //group triangles into logical panels by merging across facet ("F") edges
        //uses union-find to merge faces that share a non-crease edge

        //build edge-to-face adjacency: key = "v0,v1" (sorted), value = [faceIdx, ...]
        var edgeToFaces = {};
        for (var f = 0; f < faces.length; f++){
            var face = faces[f];
            for (var e = 0; e < 3; e++){
                var v0 = face[e], v1 = face[(e+1)%3];
                var key = Math.min(v0,v1) + "," + Math.max(v0,v1);
                if (!edgeToFaces[key]) edgeToFaces[key] = [];
                edgeToFaces[key].push(f);
            }
        }

        //identify facet edges (assignment "F") as a set for fast lookup
        var facetEdgeSet = {};
        for (var i = 0; i < fold.edges_assignment.length; i++){
            if (fold.edges_assignment[i] === "F"){
                var ev = fold.edges_vertices[i];
                var key = Math.min(ev[0],ev[1]) + "," + Math.max(ev[0],ev[1]);
                facetEdgeSet[key] = true;
            }
        }

        //union-find
        var parent = [];
        for (var f = 0; f < faces.length; f++) parent[f] = f;
        function find(x){
            while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
            return x;
        }
        function union(a, b){
            a = find(a); b = find(b);
            if (a !== b) parent[a] = b;
        }

        //merge faces that share a facet edge
        for (var key in edgeToFaces){
            if (facetEdgeSet[key] && edgeToFaces[key].length === 2){
                union(edgeToFaces[key][0], edgeToFaces[key][1]);
            }
        }

        //assign sequential panel IDs
        var rootToPanel = {};
        numPanels = 0;
        faceToPanel = [];
        for (var f = 0; f < faces.length; f++){
            var root = find(f);
            if (rootToPanel[root] === undefined){
                rootToPanel[root] = numPanels++;
            }
            faceToPanel[f] = rootToPanel[root];
        }

        //build color palette for panels
        panelColorPalette = [];
        for (var p = 0; p < numPanels; p++){
            var hue = (p * 0.618033988749895) % 1.0;
            panelColorPalette.push(new THREE.Color().setHSL(hue, 0.7, 0.6));
        }
    }

    function updateFaceColors(){
        if (!meshColors || faces.length === 0) return;
        var colorA = new THREE.Color(1.0, 0.2, 0.2);//red for Point A
        var colorB = new THREE.Color(0.2, 0.4, 1.0);//blue for Point B
        for (var f = 0; f < faces.length; f++){
            var panel = faceToPanel[f];
            var color;
            if (panel === globals.highlightedFaceA){
                color = colorA;
            } else if (panel === globals.highlightedFaceB){
                color = colorB;
            } else {
                color = panelColorPalette[panel] || new THREE.Color(0.5, 0.5, 0.5);
            }
            for (var v = 0; v < 3; v++){
                var idx = (f * 3 + v) * 3;
                meshColors[idx] = color.r;
                meshColors[idx + 1] = color.g;
                meshColors[idx + 2] = color.b;
            }
        }
        if (geometry.attributes.color) geometry.attributes.color.needsUpdate = true;
        updateLabels();
    }

    function expandPositionsToMesh(){
        if (!meshPositions || faces.length === 0) return;
        for (var f = 0; f < faces.length; f++){
            var face = faces[f];
            for (var v = 0; v < 3; v++){
                var nodeIdx = face[v];
                var meshIdx = (f * 3 + v) * 3;
                meshPositions[meshIdx] = positions[nodeIdx * 3];
                meshPositions[meshIdx + 1] = positions[nodeIdx * 3 + 1];
                meshPositions[meshIdx + 2] = positions[nodeIdx * 3 + 2];
            }
        }
    }

    function updateEdgeVisibility(){
        mountainLines.visible = globals.edgesVisible && globals.mtnsVisible;
        valleyLines.visible = globals.edgesVisible && globals.valleysVisible;
        facetLines.visible = globals.edgesVisible && globals.panelsVisible;
        hingeLines.visible = globals.edgesVisible && globals.passiveEdgesVisible;
        borderLines.visible = globals.edgesVisible && globals.boundaryEdgesVisible;
        cutLines.visible = false;
    }

    function updateMeshVisibility(){
        frontside.visible = globals.meshVisible;
        backside.visible = (globals.colorMode == "color" || globals.colorMode == "labelOnly") && globals.meshVisible;
    }

    function getGeometry(){
        //return an indexed geometry for export compatibility
        var exportGeo = new THREE.BufferGeometry();
        exportGeo.addAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
        var exportIndices = new Uint16Array(faces.length * 3);
        for (var i = 0; i < faces.length; i++){
            exportIndices[3*i] = faces[i][0];
            exportIndices[3*i+1] = faces[i][1];
            exportIndices[3*i+2] = faces[i][2];
        }
        exportGeo.setIndex(new THREE.BufferAttribute(exportIndices, 1));
        return exportGeo;
    }

    function getMesh(){
        return [frontside, backside];
    }

    function getPositionsArray(){
        return positions;
    }

    function getColorsArray(){
        return colors;
    }

    function pause(){
        globals.threeView.pauseSimulation();
    }

    function resume(){
        globals.threeView.startSimulation();
    }

    function reset(){
        getSolver().reset();
        setGeoUpdates();
    }

    function step(numSteps){
        getSolver().solve(numSteps);
        setGeoUpdates();
    }

    function setGeoUpdates(){
        //update mesh positions from node positions
        expandPositionsToMesh();
        geometry.attributes.position.needsUpdate = true;
        if (globals.colorMode == "axialStrain"){
            //strain mode: copy per-node colors into per-face-vertex colors
            for (var f = 0; f < faces.length; f++){
                var face = faces[f];
                for (var v = 0; v < 3; v++){
                    var nodeIdx = face[v];
                    var meshIdx = (f * 3 + v) * 3;
                    meshColors[meshIdx] = colors[nodeIdx * 3];
                    meshColors[meshIdx + 1] = colors[nodeIdx * 3 + 1];
                    meshColors[meshIdx + 2] = colors[nodeIdx * 3 + 2];
                }
            }
            geometry.attributes.color.needsUpdate = true;
        }
        if (globals.userInteractionEnabled || globals.vrEnabled) geometry.computeBoundingBox();
        //update line positions (lines share node positions buffer directly)
        _.each(lines, function(line){
            if (line.geometry.attributes.position) line.geometry.attributes.position.needsUpdate = true;
        });
        //update label positions to follow face centroids
        updateLabels();
    }

    function startSolver(){
        globals.threeView.startAnimation();
    }

    function getSolver(){
        if (globals.simType == "dynamic") return globals.dynamicSolver;
        else if (globals.simType == "static") return globals.staticSolver;
        return globals.rigidSolver;
    }




    function buildModel(fold, creaseParams){

        if (fold.vertices_coords.length == 0) {
            globals.warn("No geometry found.");
            return;
        }
        if (fold.faces_vertices.length == 0) {
            globals.warn("No faces found, try adjusting import vertex merge tolerance.");
            return;
        }
        if (fold.edges_vertices.length == 0) {
            globals.warn("No edges found.");
            return;
        }

        nextFold = fold;
        nextCreaseParams = creaseParams;

        globals.needsSync = true;
        globals.simNeedsSync = true;

        if (!inited) {
            startSolver();//start animation loop
            inited = true;
        }
    }



    function sync(){

        for (var i=0;i<nodes.length;i++){
            nodes[i].destroy();
        }

        for (var i=0;i<edges.length;i++){
            edges[i].destroy();
        }

        for (var i=0;i<creases.length;i++){
            creases[i].destroy();
        }

        fold = nextFold;
        nodes = [];
        edges = [];
        faces = fold.faces_vertices;
        creases = [];
        creaseParams = nextCreaseParams;
        var _edges = fold.edges_vertices;

        var _vertices = [];
        for (var i=0;i<fold.vertices_coords.length;i++){
            var vertex = fold.vertices_coords[i];
            _vertices.push(new THREE.Vector3(vertex[0], vertex[1], vertex[2]));
        }

        for (var i=0;i<_vertices.length;i++){
            nodes.push(new Node(_vertices[i].clone(), nodes.length));
        }

        for (var i=0;i<_edges.length;i++) {
            edges.push(new Beam([nodes[_edges[i][0]], nodes[_edges[i][1]]]));
        }

        for (var i=0;i<creaseParams.length;i++) {
            var _creaseParams = creaseParams[i];
            var type = _creaseParams[5]!=0 ? 1:0;
            creases.push(new Crease(
                edges[_creaseParams[4]],
                _creaseParams[0],
                _creaseParams[2],
                _creaseParams[5] * Math.PI / 180,
                type,
                nodes[_creaseParams[1]],
                nodes[_creaseParams[3]],
                creases.length));
        }

        vertices = [];
        for (var i=0;i<nodes.length;i++){
            vertices.push(nodes[i].getOriginalPosition());
        }

        if (globals.noCreasePatternAvailable() && globals.navMode == "pattern"){
            $("#navSimulation").parent().addClass("open");
            $("#navPattern").parent().removeClass("open");
            $("#svgViewer").hide();
            globals.navMode = "simulation";
        }

        //node-indexed arrays (used by solver and lines)
        positions = new Float32Array(vertices.length*3);
        colors = new Float32Array(vertices.length*3);

        //per-face-vertex arrays (used by mesh, non-indexed)
        meshPositions = new Float32Array(faces.length*3*3);
        meshColors = new Float32Array(faces.length*3*3);

        for (var i=0;i<vertices.length;i++){
            positions[3*i] = vertices[i].x;
            positions[3*i+1] = vertices[i].y;
            positions[3*i+2] = vertices[i].z;
        }

        clearGeometries();

        //line geometries share the node-indexed positions buffer
        var linePositionsAttribute = new THREE.BufferAttribute(positions, 3);

        var lineIndices = {
            U: [],
            V: [],
            M: [],
            B: [],
            F: [],
            C: []
        };
        for (var i=0;i<fold.edges_assignment.length;i++){
            var edge = fold.edges_vertices[i];
            var assignment = fold.edges_assignment[i];
            lineIndices[assignment].push(edge[0]);
            lineIndices[assignment].push(edge[1]);
        }
        _.each(lines, function(line, key){
            var indicesArray = lineIndices[key];
            var _indices = new Uint16Array(indicesArray.length);
            for (var i=0;i<indicesArray.length;i++){
                _indices[i] = indicesArray[i];
            }
            lines[key].geometry.addAttribute('position', linePositionsAttribute);
            lines[key].geometry.setIndex(new THREE.BufferAttribute(_indices, 1));
            lines[key].geometry.computeBoundingBox();
            lines[key].geometry.computeBoundingSphere();
            lines[key].geometry.center();
        });

        //expand node positions into per-face-vertex positions for the mesh
        expandPositionsToMesh();

        //mesh geometry uses non-indexed per-face-vertex buffers
        geometry.addAttribute('position', new THREE.BufferAttribute(meshPositions, 3));
        geometry.addAttribute('color', new THREE.BufferAttribute(meshColors, 3));
        //no setIndex — non-indexed geometry, each face has its own 3 vertices
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        geometry.center();

        var scale = 1/geometry.boundingSphere.radius;
        globals.scale = scale;

        //scale node positions
        for (var i=0;i<positions.length;i++){
            positions[i] *= scale;
        }
        for (var i=0;i<vertices.length;i++){
            vertices[i].multiplyScalar(scale);
        }

        //scale mesh positions
        for (var i=0;i<meshPositions.length;i++){
            meshPositions[i] *= scale;
        }

        //update vertices and edges
        for (var i=0;i<vertices.length;i++){
            nodes[i].setOriginalPosition(positions[3*i], positions[3*i+1], positions[3*i+2]);
        }
        for (var i=0;i<edges.length;i++){
            edges[i].recalcOriginalLength();
        }

        //group triangles into logical panels and build color palette
        buildPanelMap();
        if (globals.colorMode == "faceID") updateFaceColors();
        $("#totalFaces").html(numPanels);
        $("#totalFacesLabel").html(numPanels);

        updateEdgeVisibility();
        updateMeshVisibility();

        syncSolver();

        globals.needsSync = false;
        if (!globals.simulationRunning) reset();
    }

    function syncSolver(){
        getSolver().syncNodesAndEdges();
        globals.simNeedsSync = false;
    }

    function getNodes(){
        return nodes;
    }

    function getEdges(){
        return edges;
    }

    function getFaces(){
        return faces;
    }

    function getCreases(){
        return creases;
    }

    function getDimensions(){
        geometry.computeBoundingBox();
        return geometry.boundingBox.max.clone().sub(geometry.boundingBox.min);
    }

    return {
        pause: pause,
        resume: resume,
        reset: reset,
        step: step,

        getNodes: getNodes,
        getEdges: getEdges,
        getFaces: getFaces,
        getCreases: getCreases,
        getGeometry: getGeometry,//for save stl
        getPositionsArray: getPositionsArray,
        getColorsArray: getColorsArray,
        getMesh: getMesh,

        buildModel: buildModel,//load new model
        sync: sync,//update geometry to new model
        syncSolver: syncSolver,//update solver params

        //rendering
        setMeshMaterial: setMeshMaterial,
        updateEdgeVisibility: updateEdgeVisibility,
        updateMeshVisibility: updateMeshVisibility,
        updateFaceColors: updateFaceColors,

        getDimensions: getDimensions//for save stl
    }
}
