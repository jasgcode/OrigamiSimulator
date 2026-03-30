# Point Tracking — Intelligent Angle Selection

This document describes how the origami simulator discovers optimal camera angles for tracking labeled points across a fold sequence.

---

## Problem

When training a vision-language model (VLM) to track labeled points through an origami fold, each frame of the sequence must show the tracked points clearly. Two failure modes exist:

1. **Backface culling** — a face rotates past 90° relative to the camera and becomes invisible.
2. **Occlusion** — another panel folds over and blocks the point, even though the face itself is technically front-facing.
3. **Grazing angles** — the face is technically front-facing (dot product > 0) but nearly edge-on, making the point marker hard to read.

The system addresses all three by computing a per-face quality score and using it to drive a greedy POV selection algorithm.

---

## Face Visibility

### Backface test

A mesh triangle is front-facing if the outward normal points toward the camera:

```
dot(camera.position − centroid, faceNormal) > 0
```

The face normal is computed from the cross product of two triangle edges (`edge1 × edge2`). If the dot product is ≤ 0 the face is culled and no further testing is done.

Implementation: `getVisibleFaceIds()` in `js/facePoints.js`.

### Occlusion test

After passing the backface test, a ray is cast from the face centroid toward the camera. If any other triangle in the mesh intersects this ray before the camera is reached, the face is occluded.

The test uses raw `THREE.Ray.intersectTriangle` with `backfaceCulling = false`. This is intentional — panels that have folded over to the back still have a real physical thickness that blocks the view, and `THREE.FrontSide` material would miss them. A small epsilon (`OCCL_EPSILON = 0.002`) offsets the ray origin to avoid self-intersection with the source face.

```
origin = centroid + dir * OCCL_EPSILON
occluded = any triangle t where:
    ray(origin, dir) hits t
    AND hit distance ∈ (OCCL_EPSILON, distToCamera − OCCL_EPSILON)
```

Implementation: `isOccluded()` in `js/facePoints.js`.

### Point visibility

Individual labeled points use the same two-step test, but the ray originates from the **point's actual world position** (computed from barycentric coordinates) rather than the face centroid. A point near the edge of a face may be occluded even when the centroid is clear.

```
pos = barycentricToWorld(faceId, u, v, w)  // with inset margin
dir = normalise(camera.position − pos)
visible = dot(dir, faceNormal) > 0  AND  !isOccluded(pos, dir, distToCamera)
```

Implementation: `isPointVisible()` in `js/facePoints.js`.

---

## Quality Score

Binary visibility is too coarse — a face at a grazing angle passes the `dot > 0` test but the label is nearly edge-on and hard to read.

The quality score is the raw dot-product value, normalised to [0, 1]:

```
quality = dot(normalise(camera.position − centroid), faceNormal)
```

| Quality | Meaning |
|---------|---------|
| 1.0 | Face squarely facing camera (ideal) |
| 0.5 | Face at 60° to camera (acceptable) |
| 0.25 | Face at ~75° (minimum threshold) |
| < 0.25 | Grazing — filtered out |

The default minimum threshold is **0.25**. Faces passing the backface and occlusion tests but with quality below this threshold are excluded from the visible set. This can be overridden per scan benchmark with `"minFaceQuality": <value>`.

Implementation: `getFaceViewQualities()` in `js/facePoints.js`.

---

## Scan Mode

Scan mode densely samples every combination of fold percentage and camera POV, recording which faces are visible and their quality at each state. This produces a data-driven map used to select optimal sequences.

### Configuration

```json
"scan-bird": {
    "scanMode": true,
    "model": "/Bases/birdBase.svg",
    "scanPovs": ["y", "-y", "z", "-z", "x", "-x", "iso"],
    "scanFoldSteps": [0, 25, 50, 75, 90],
    "minFaceQuality": 0.25
}
```

Run via `?benchmark=scan-bird`. Output is saved to `screenshots/<name>_scan.json`.

### How it runs

For each `(fold, pov)` combination:

1. Set `globals.setCreasePercent(fold / 100)` and call `setPOV(pov)`.
2. Wait `scanSettleMs` (default 300 ms) for the physics to settle.
3. Call `getVisibleFaceIds()` — returns all unoccluded front-facing face IDs.
4. Call `getFaceViewQualities(visibleFaceIds)` — returns `{ faceId: quality }` for each.
5. Filter to faces meeting `minFaceQuality`.
6. Record `{ fold, pov, visibleFaceIds, faceQualities }`.

Total combinations = `|scanFoldSteps| × |scanPovs|` (e.g. 5 × 7 = 35 for default bird scan).

---

## POV Analysis

After all combinations are sampled, for each POV the system intersects the visible face sets across all fold steps:

```
alwaysVisibleFaceIds[pov] = ⋂ { visibleFaceIds[fold, pov] : fold in scanFoldSteps }
```

A face in `alwaysVisibleFaceIds` is visible at that POV at **every** fold level scanned.

Each POV also receives an `avgMinQuality` score — the average across fold steps of the minimum quality among always-visible faces. This reflects how squarely the tracked faces face the camera throughout the full fold.

### POV ranking

POVs are ranked by `avgMinQuality` descending, with `faceCount` as a tiebreaker. POVs with no always-visible faces are excluded.

---

## Greedy Sequence Algorithm

Given the ranked qualifying POVs and 5 evenly-spaced fold frames, the algorithm builds a multi-POV sequence that maximises face visibility quality at each step.

### Fixed anchor frame

Frame 0 is always `{ fold: 0, pov: "y" }` — the flat paper viewed from above. This gives the viewer an unambiguous reference before folding begins.

### Greedy selection (frames 1–4)

At each subsequent fold step, the algorithm tries every qualifying POV and picks the one that:

1. **Is not a repeat of the immediately preceding POV** (avoids static-looking sequences).
2. **Keeps a non-empty intersection** of tracked face IDs visible.
3. **Maximises the minimum quality** across all tracked faces at that step (primary criterion).
4. **Maximises face count** as a tiebreaker when quality is equal.

```
For each fold step f (after the anchor):
    bestPov = null, bestMinQuality = -1
    For each candidate pov in qualifyingPovs:
        if pov == lastPov: skip
        intersection = currentFaceIds ∩ visibleFaceIds[f, pov]
        if intersection is empty: skip
        minQ = min(quality[id] for id in intersection)
        if minQ > bestMinQuality:
            bestPov = pov, bestMinQuality = minQ
    append { fold: f, pov: bestPov, minQuality: bestMinQuality }
    update currentFaceIds = intersection
```

This is a greedy minimax — it maximises the worst-case quality at each step rather than the average, ensuring no single frame has a barely-visible point.

### Sequence variants

Multiple sequences are generated by rotating which qualifying POV leads the candidate list. This produces different angle progressions from the same face set, useful for dataset diversity. Duplicate sequences (same step array) are deduplicated.

---

## Scan Output Format

`screenshots/<name>_scan.json`:

```json
{
  "benchmark": "scan-bird",
  "model": "/Bases/birdBase.svg",
  "totalFaces": 16,
  "scanPovs": ["y", "-y", "z", "-z", "x", "-x", "iso"],
  "scanFoldSteps": [0, 25, 50, 75, 90],
  "suggestedSequences": [
    {
      "alwaysVisibleFaceIds": [9, 10],
      "faceCount": 2,
      "steps": [
        { "fold": 0,  "pov": "y",   "minQuality": 0.999 },
        { "fold": 25, "pov": "iso", "minQuality": 0.688 },
        { "fold": 50, "pov": "iso", "minQuality": 0.855 },
        { "fold": 75, "pov": "iso", "minQuality": 0.883 },
        { "fold": 90, "pov": "iso", "minQuality": 0.723 }
      ]
    }
  ],
  "povAnalysis": {
    "iso": {
      "alwaysVisibleFaceIds": [9, 10],
      "faceCount": 2,
      "avgMinQuality": 0.75,
      "states": [
        {
          "fold": 0,
          "visibleFaceIds": [0, 1, 2, ...],
          "faceQualities": { "0": 0.546, "9": 0.601, "10": 0.601, ... }
        }
      ]
    }
  }
}
```

---

## Benchmark Entry Format

Once suitable faces and steps have been identified from the scan, a tracking benchmark is added to `benchmarks.json`:

```json
"bird-track-4": {
    "model": "/Bases/birdBase.svg",
    "colorMode": "labelOnly",
    "color1": "0077cc",
    "color2": "eeeeee",
    "backgroundColor": "f0f0f0",
    "fold": 0,
    "pauseDuration": 2,
    "showPointNumbers": true,
    "autoCapture": true,
    "facePoints": {
        "10": [{ "u": 0.33, "v": 0.33, "w": 0.34 }, { "u": 0.6, "v": 0.2, "w": 0.2 }],
        "13": [{ "u": 0.5, "v": 0.25, "w": 0.25 }, { "u": 0.2, "v": 0.5, "w": 0.3 }]
    },
    "steps": [
        { "fold": 0,  "pov": "y"   },
        { "fold": 25, "pov": "iso" },
        { "fold": 50, "pov": "z"   },
        { "fold": 75, "pov": "iso" },
        { "fold": 90, "pov": "z"   }
    ]
}
```

`facePoints` keys are face IDs (0-indexed triangles). Values are arrays of barycentric coordinate objects `{ u, v, w }` where `u + v + w = 1`. Points are rendered with an inset margin from triangle edges to keep them clearly inside the face boundary.

---

## Workflow Summary

```
1. Run ?benchmark=scan-<model>
        ↓
2. For every (fold × pov): record visibleFaceIds + faceQualities
        ↓
3. Per POV: compute alwaysVisibleFaceIds (intersection) + avgMinQuality
        ↓
4. Rank qualifying POVs by avgMinQuality
        ↓
5. Greedy algorithm: build multi-POV sequences maximising min-quality per step
        ↓
6. Read suggestedSequences in <name>_scan.json
        ↓
7. Add benchmark entry to benchmarks.json with chosen facePoints + steps
        ↓
8. Run ?benchmark=<name> — each step captures a PNG
```

---

## Key Files

| File | Role |
|------|------|
| `js/facePoints.js` | Face/point visibility, occlusion test, quality scores |
| `js/benchmark.js` | Scan runner, POV analysis, greedy sequence builder |
| `benchmarks.json` | Benchmark and scan preset definitions |
| `screenshots/<name>_scan.json` | Scan output — POV analysis and suggested sequences |
