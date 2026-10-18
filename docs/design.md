# Benchmark design

An item shows a sheet of paper with a few unmarked dots and then the same sheet folding into an origami base while it turns in front of a fixed camera. In the last image many more dots appear, each with a letter. The model must name the letters of the dots it saw in the first image. [dataset.md](dataset.md) shows examples.

The task should be solvable only by following the paper through the fold. Every construction rule on this page exists because an earlier version of the dataset could be answered another way, for example from the final image's layout alone or from the first and last images alone. Each section below states:

- the shortcut and how it was measured;
- the rule that closes it, with the code that implements it;
- how the release is audited for it.

Unless noted, code references are to [`js/presetGenerator.js`](../js/presetGenerator.js).

## Contents

- [Difficulty tiers](#difficulty-tiers)
- [Legibility rules](#legibility-rules)
- [Shortcuts and how the tiers close them](#shortcuts-and-how-the-tiers-close-them)
- [Audits](#audits)
- [Known limitations](#known-limitations)
- [Calibration history](#calibration-history)

## Difficulty tiers

The generator has four tiers. The release uses tiers 3 (`medium`) and 5 (`expert`), the **clustered tiers**. Tiers 1 (`easy`) and 4 (`hard`) belong to the earlier uniform-1000 set ([uniform-1000.md](uniform-1000.md)).

In every tier:

- **The camera is fixed.** Each step sets a rotation of the model (Euler XYZ, radians) instead of moving the camera.
- **The first image is the flat sheet at zero rotation**, seen from the trajectory's camera direction. Tier 1 is the exception: it keeps its constant tilt there too.
- **Dots appear only in the first and last images.**

| | Tier 3 `medium` | Tier 5 `expert` |
|---|---|---|
| Images | 10 | 14 |
| Fold schedule | 0 → 70% in equal steps | 0 → 70% in equal steps (the generator allows ≥55%, ≤20 points per step) |
| Motion | A rotation that ramps to a crest near the last frame, plus a spin about the paper normal | A direction-changing path to a pose that shows the back of the model, plus a spin about the paper normal (see [§4](#4-the-least-turn-prior--spin)) |
| Rotation bounds (yaw, pitch, roll) | 0.8, 0.5, 0.2 rad | 1.8, 1.5, 0.7 rad |
| Tracked panels | 2–3 | 1–2 |
| Decoy-only front panels | 0–2 | 0–2 |
| Back panels | none | 1–2, decoys only |
| Dot radius (model units) | 0.018 | 0.014 |
| Minimum dot spacing | 50 px | 39 px |
| Paper | One random color on both sides | Same |
| **Release settings** (generator defaults in brackets) | | |
| Dots in the final image | 20 [10–14] | 22, waterbomb 16–18 [12–20] |
| Dots per group | 2–4 [1–4] | 2–4, waterbomb 1–4 [1–4] |
| Scatter dots ([§6](#6-local-density--groups-of-24-and-scatter-dots)) | 3–5 [none] | 3–5, waterbomb 1–2 [none] |
| Last-image dot sizes ([§7](#7-dot-size--random-last-image-sizes)) | 0.6–1.4× [1×] | 0.75–1.25× [1×] |
| Spin range | ±¾ turn [±½ turn] | ±½ turn |

**Overriding the defaults.** The release overrides the generator defaults per run with `--cluster-points`, `--cluster-group-size`, `--cluster-scatter`, `--cluster-end-sizes` and `--cluster-spin-turns`. These flags are passed to `tools/generate-expert-dataset.py`, which forwards them to generation, validation and assembly. The tier defaults live in `TIER_LAYOUTS`, `TIER_FRAME_COUNT` and the per-tier rotation bounds.

**Expert motion** follows `buildExpertRotationProfiles` and `EXPERT_MOTION`:

| Rule | Limit |
|---|---|
| Net turn from first to last frame | ≥ 1.3 rad |
| Total path | ≥ 5 rad (6.5 for the `pendulum` style), and ≥ 1.6 × the net turn |
| Rotation axis over the sequence | turns by ≥ π |
| Euler axes | all three move, two of them by ≥ 0.8 rad |
| Orientation change per frame | ≤ 0.9 rad, of which ≤ 0.6 rad in plane |

Frames are resampled to constant angular speed.

The release runner alternates two path styles (`MOTION_STYLES` in `tools/generate-expert-dataset.py`):

- **`detour`** swings, orbits, weaves or wanders on its way to the final pose.
- **`pendulum`** swings wide in yaw.

Two further styles exist but are not used. `tumble` was dropped for yield (one valid preset in 17 jobs). `spin` makes frames look alike on symmetric bases.

**Tiers 1 and 4** (uniform-1000): tier 1 has a constant tilted pose with no motion (bounds 0.5, 0.15, 0.08), two tracked front dots and 1–3 hidden front decoys. Tier 4 has a monotonic ramp to the final frame (bounds 1.4, 1.3, 0.4), two tracked front dots, 1–2 hidden front decoys and 1–2 hidden back decoys, a 0.025 radius and 70 px spacing.

## Legibility rules

Harder items must stay readable: a dot that is clipped, edge-on or hidden behind a flap makes an item unfair rather than hard. Every released preset passes these rules. They are checked during placement, at final validation, and again in an independent replay of the whole preset at 800 ms per step (`tools/validate-presets.js`).

| Rule | Applies to | Implementation |
|---|---|---|
| Visible: the face points at the camera, the dot is inside the frame, and no layer blocks the ray to the camera | Tracked dots at **every** step; decoys at the last step (`trackingEvalMode: "finalStepOnly"`) | `isPointVisible` in [`js/facePoints.js`](../js/facePoints.js), using ray–triangle tests with no back-face culling |
| Viewing ratio ≥ 0.30 (minor/major axis of the projected dot, so no thin edge-on dots) | Every dot in the last image; tracked dots at every step | `minPointViewQuality` |
| Spacing ≥ 50 px (medium) / 39 px (expert) between dots, scaling with dot radius | Last image; tracked dots at every step | `clusterMinSeparationPx` |
| A clear disk around each final dot, so no crease or flap edge cuts through it | Last image, at the largest end size | `markerClearanceRadius`, `hasSurfaceClearance` |
| At least 30 px from the image edge | Every dot | refinement gate |
| Each group's dots within 100 px (medium) / 125 px (expert) of their centroid | Last image | `TIER_LAYOUTS[...].group.spreadPx` |
| No label leader line crosses another dot | Last image | `labelCrossings` in [`js/pointAnnotations.js`](../js/pointAnnotations.js) |
| Every twin decoy is readable | Last image | `twinFailures` |

The generator does not relax these rules to meet a quota. When a base cannot satisfy them for a tier, that base yields fewer items, which is why bases are unevenly represented (see [dataset.md](dataset.md#at-a-glance)).

## Shortcuts and how the tiers close them

### 1. Finding the answer's panel from the final layout → drawn layouts

**Shortcut.** The first clustered layout (the earlier `eval/` set) placed four dots on each tracked panel and lone dots on the back panels. The answer was always one dot per four-dot cluster. A solver could find the answer's panel from the final image alone. It then only had to match the dot's position on that panel between the flat and final images, which is easy on distinctive panels.

**Rule.** Each preset now draws its own layout (`drawClusterLayout`):

1. Every group, whether tracked, decoy-only or back, draws its size from the same range.
2. The groups that hold a tracked dot are chosen among the front groups with probability proportional to size, by systematic sampling (`chooseAnchoredGroups`). Every front dot is then equally likely to be an answer.
3. Lone dots can be tracked dots, front decoys or back dots.

Two earlier versions leaked through group size:

- Picking tracked groups before drawing sizes made tracked groups larger: 3.2 dots against 2.4 in a trial, and only 1 of 33 lone dots was an answer.
- Picking them uniformly after drawing sizes made dots in small groups likelier answers.

On simulated layouts, the best structure-only guesser (one dot from the largest or smallest groups) scores 1.1–1.25× chance with this rule, against 1.7× (medium) and 2.8× (expert) on the fixed layout.

### 2. Position within a group → sampled placement and balancing

**Shortcut.** Packing decoys around the tracked dot made it the middle dot of its group every time, which answers the item from the final image.

**Rule.** Placement is sampled, not optimized for evenness (`clusterOffsets`):

1. Each preset draws a Dirichlet α from 0.5–1.0 (`clusterPlacement.alpha`). Values below 1 favor spots near creases.
2. Candidate spots are Dirichlet samples rounded to 0.001 in barycentric coordinates.
3. Each panel's first dot takes the legible spot nearest a sampled one.
4. The panel's other dots land at random within a per-group radius (medium 40–60 px, expert 60–95 px) around a group center.
5. The group center is the first dot with probability 1/(group size). Otherwise it is a spot just beyond the spacing floor from that dot (medium 50–70 px, expert 39–79 px).

Groups centered on the tracked dot fit narrow panels more easily, so they survive validation more often. Selection therefore keeps the middle-dot rate at chance per base (`balance_middle` in `tools/generate-expert-dataset.py`, used by `release/dataset-300b/select-300b.py`). Chance is summed per group, because group sizes vary. For banks where dropping presets would cost too much, [`tools/rebalance-anchors.py`](../tools/rebalance-anchors.py) instead re-chooses which dot in each group is tracked; this was used for the earlier `eval/` set.

### 3. Matching the flat and final images → twin decoys

**Shortcut.** With only the first and last images, a solver can reason about how a flat sheet folds into the known base and locate the dot without following the frames in between.

**Rule.** Every front dot gets a hidden **twin**. The twin sits at the dot's image under a rotation of the sheet that the folded model carries (`carriedRotations`, measured at the final fold for each job). A rotated copy of the folded model looks the same, so the final image cannot tell a dot from its twin. Only the frames in between show which way the paper turned.

Carried rotations per base at the final fold:

| Base | Carried rotations |
|---|---|
| bird, waterbomb, pinwheel | 90°, 180°, 270° |
| boat, open sink, square | 180° |
| mapfold | none, so it is left out of the clustered tiers |

**Why this bounds a frame matcher.** A solver that matches only the first and last frames must pick one of two poses: the real one, or the one turned onto the twins. That single pick settles every dot in the item, so it is right on at most half of the items.

**Mirrors are not used.** A mirror-symmetric fold still shows which half is which, and every base's mirror symmetries fold as true mirrors. `foldedSymmetry` checks this with the sign of a vertex tetrahedron's volume.

**Twins must be visible.** A rotation twin usually sits on the far side of the model. Trajectory search therefore requires readable pairs of front panel and twin panel in the final frame: two pairs for medium and one for expert, each with a seed panel that stays readable throughout (`searchPools.twin*`, `hasTwinPairs` in [`js/benchmark.js`](../js/benchmark.js)).

**Expert back groups have no twins.** Real dots are always on the front, and a search that also required back twins found none in about 6,000 tries per base.

Boat, open sink and square carry only the 180° rotation, which puts the twins on the side opposite the back panels. Their expert items cannot show both, so they appear only as front-only filler (`--cluster-back-groups 0,0`). The release has one such item.

### 4. The least-turn prior → spin

**Shortcut.** Twins only help if the paper could have turned either way. With small rotation ramps, guessing that the paper took the smaller turn from flat to final picked the real pose in 71 of 74 medium presets. Claude Opus 5.5 answered 67% of first-and-last-image probes, against 94% with every image.

**Rule.** The clustered tiers add a **spin** about the paper normal, drawn uniformly over its range and applied at constant speed across the frames:

- **Medium** adds the spin to the Euler y angle (`spinProfiles`). Medium's roll stays under 0.2 rad, so Euler y is nearly the normal.
- **Expert** rolls up to 0.7 rad. An Euler-y spin there swung the back panels away from the camera, the search rejected the large spins, and the real pose was still the least turn in 61 of 80 presets. Expert therefore turns about the normal exactly: each frame's rotation R becomes R·Ry(turn), written on a continuous Euler branch (`spinAboutNormal`, `eulerNear`).

**Two limits keep the spin readable** in both tiers:

- Spun profiles that turn more than 0.6 rad in plane between frames are dropped (`maxPlaneStep`). Most bases are 4- or 8-fold symmetric, and a larger in-plane step can look like a smaller one in the other direction.
- Spun profiles that break the motion limits are dropped.

Among expert profiles, those limits still lean the least-turn guess to 42–64%, depending on style. So `balanceLeastTurn` alternates expert profiles that lean toward the dot and toward the twin, under the twin rotations the base carries (`TWIN_TURNS`), until the guess is right about half the time.

Presets from one trajectory share a final pose, so the rate still swings from run to run. Assembly therefore picks presets in both tiers so that the least-turn rate stays near half (`least_turn_lean` in `balance_middle`). `select-300b.py` applies the same balance again to the expert half.

### 5. Twin facing → balanced selection

**Shortcut.** Tracked dots must stay readable in every frame, and twins only in the last. Tracked panels therefore tended to end up facing the camera more squarely than their twin panels, so the tracked dots looked rounder. In an earlier 300-item build, 70% of expert tracked groups faced the camera more than their twins (z = +5.5).

**Rule.** Two fixes were tried:

- **At source**, with the `--symmetric-twins` option: both panels of each tracked pair must stay readable in every frame. This collapsed yield. Waterbomb found no trajectories in 8 jobs, and bird and pinwheel found 0–2 valid paths per job instead of 10–25. The release does not use it.
- **By selection** (adopted): `select-300b.py` picks expert items from every preset that passed validation, keeping per base the longest prefix of a balanced ordering whose twin-facing, least-turn and middle-dot rates all stay within 5 points of their targets.

The release's rates are 0.509 (medium) and 0.539 (expert) for twin facing, against 0.5 chance.

### 6. Local density → groups of 2–4 and scatter dots

**Shortcut.** Tight groups alone left each panel with one tidy cluster. A solver could find the panel, then pick by position along a short line of dots.

**Rule.** **Scatter dots** (`--cluster-scatter`) are extra lone dots, each with its own twin:

- Each scatter dot starts on a front group's panel, chosen with probability proportional to group size.
- Refinement then moves it to a uniformly random legible spot anywhere on the visible paper. Candidates cover every front face in proportion to its flat area (`areaSampleCounts`), and nothing sets the dot's distance from any group.
- Scatter dots join the answer draw as groups of one (`drawScatteredLayout`), so a lone dot is as likely an answer as a grouped one.

Two earlier placements looked patterned: a ring 60–150 px from the group center, then a Gaussian around it. Keeping scatter dots on their group's panel packed thin flaps into a line.

Spreading scatter dots over the whole paper thinned the crowd around groups, and grouped answers got easier (77% of grouped answer dots found, against 55–58% before). Groups of 2–4 (`--cluster-group-size 2,4`) put at least one intentional decoy beside every grouped dot. A lone dot is then always a scatter dot, and scatter dots are as likely to be answers as any other dot.

### 7. Dot size → random last-image sizes

**Shortcut.** Dots keep their first-image size, so if dots differed in size a solver could match them by size.

**Rule.** In the last image only, every dot is drawn at its own size: a multiple of the tier's radius drawn uniformly per dot (`--cluster-end-sizes`, recorded as `endDotSizes` on the preset and `endScale` per point). Sizes are drawn independently of a dot's role, and the question states that size does not show which dot is which. The footprint check uses the largest size.

### 8. Other cues

- **Paper side.** Both sides are one color (`labelOnly` color mode with `color1 = color2`), so color does not separate front dots from back dots.
- **Answer letters.** Letters follow the order of the preset's point array. Generation shuffles that order with the job seed, so letters carry no information about face IDs or roles. Sorting `facePoints` by face would leak the answers.
- **Back dots.** In expert, back dots are always decoys. A solver that can tell, from the geometry alone, that a dot sits on the back of the sheet can exclude it. That is legitimate reasoning about the fold, and it is the reason back panels exist.

## Audits

[`tools/shortcut-baselines.py`](../tools/shortcut-baselines.py) reads a bank together with the final dot positions and viewing ratios from its validation report. It reports:

| Check | Fails the bank when |
|---|---|
| Tracked dot is its group's middle dot | above chance by more than 3 standard errors (ties share credit) |
| The most central dots are the answer | above chance by more than 3 standard errors |
| Dots off the tracked panels, and tracked dots, stand apart from every other dot | (reported; if only one rate is high, isolation alone separates answers from decoys) |
| Real pose is the least turn of the two poses | above half by more than 3 standard errors |
| Tracked group faces the camera more than its twin group | far from half in either direction |

`release/dataset-300b/audit.py` matches each released preset to its own validation row and runs these checks per tier. [reproduce.md](reproduce.md#3-regenerate-from-scratch) lists the release's numbers. No position-only baseline beats chance on either tier.

**Image probes.** Two reduced-image versions of the dataset check how much of a score needs the fold sequence ([dataset.md § Probes](dataset.md#probes)):

- **Final image only:** a score near chance shows the answer cannot be read from the final layout.
- **First and last images:** a score well below the full-sequence score shows the middle frames are needed.

For Claude Opus 5.5 on medium, the first-and-last probe drops from 45.3% to 18.7%.

## Known limitations

- **The calibration model is also the reference model.** Difficulty was tuned in rounds against Claude Opus 5.5 ([below](#calibration-history)), and the reference results use the same model. Its scores are therefore not an independent estimate of difficulty for that model. They show where the calibration stopped.
- **Uneven bases.** Expert is 84% bird and pinwheel, with one boat item and no open sink or square, because only bases that carry a 90° rotation can show twins and back panels together. Medium has only 10 square items. Mapfold carries no rotation and is absent from both tiers.
- **Legibility is checked geometrically.** Every item passes the geometric tests above on its rendered poses. Readability is established by those tests, not by a person reviewing each item.
- **Expert is near chance for the reference model**, with or without the middle frames. That alone does not show that expert items are solvable. The legibility rules and the twin construction make them solvable in principle by following the frames.
- **Single sampled runs.** Reference scores come from one run. Re-asking the same 150 medium items gave 46% against 45.3%.

## Calibration history

The clustered tiers reached their release settings over a series of rounds. Each round changed one setting, generated about 45–60 items, and scored them with Claude Opus 5.5 on the full sequence and on the first and last images. Round-to-round noise at this size is about ±8–10 points.

| Round | Change | Full | First + last |
|---|---|---|---|
| **Medium** | | | |
| Earlier `eval/` set (30 items) | 8 dots, no twins | 77% | 43% |
| r0 | Twin decoys | 98% | 75% |
| r1 | Spin (Euler y) | 78% | 37% |
| r2b | 10–14 dots | 59% | 37% |
| r3 | Two tracked dots in every item | 44% | 17% |
| r4 | Tighter groups | 44% | 16% |
| r5 | 16 dots, scatter dots in a ring | 50% | 23% |
| r7 | 20 dots, scatter anywhere on the paper | 65% | 25% |
| r8 | Groups of 2–4 | 54% | 16% |
| r9 | Last-image sizes 0.75–1.25× | 40% | 21% |
| r10 | Last-image sizes 0.6–1.4× | 59% | 24% |
| r11 (release settings) | Spin ±¾ turn | 44% | 20% |
| **Expert** | | | |
| Earlier `eval/` set (30 items) | 10 dots, no twins | 10% | 10% |
| r0 | Twin decoys | 24% | 24% |
| r1 | Euler-y spin, 12–20 dots, radius 0.014 | 13% | 16% |
| r2 | Spin about the normal, balanced least turn (chance 7%) | 7% | 9% |
| r5 (release settings) | 22 dots, scatter, groups of 2–4, last-image sizes (chance 2.6%) | 10% | 10% |

The release's medium half uses r11's settings and its expert half uses r5's. The 300 items were then selected and balanced as described in [reproduce.md](reproduce.md#3-regenerate-from-scratch).
