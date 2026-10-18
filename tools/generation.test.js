import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import vm from 'node:vm';

// Expose private functions only in the test VM; the browser API stays unchanged.
function loadModule(file, init, exports, globals = {}) {
    const context = vm.createContext({ console, setTimeout, clearTimeout, window: {}, $: () => ({ css: () => {} }), document: { getElementById: () => null } });
    vm.runInContext(readFileSync(new URL('../dependencies/three.min.js', import.meta.url), 'utf8'), context);
    const source = readFileSync(new URL('../js/' + file, import.meta.url), 'utf8');
    const at = source.lastIndexOf('    return {');
    const exposed = source.slice(0, at) + source.slice(at).replace('    return {', '    return {' + exports.map(n => `${n}: ${n},`).join(''));
    vm.runInContext(exposed, context);
    return context[init](typeof globals === "function" ? globals(context.THREE) : globals);
}

const generator = loadModule('presetGenerator.js', 'initPresetGenerator', ['normalizeStepsForDifficulty']);
const benchmark = loadModule('benchmark.js', 'initBenchmark', ['generateCandidateTrajectories']);

test('validated rotation precision survives preset assembly', () => {
    const steps = [0, 35, 70].map((fold, i) => ({ fold, pov: [.5, .8, .3], rotation: [i * .123, i * .217, i * .031] }));
    const normalized = generator.normalizeStepsForDifficulty(steps, 4, generator.makeRng(42));
    expect(normalized[1].rotation).toEqual(steps[1].rotation);
    expect(normalized[2].rotation).toEqual(steps[2].rotation);
});

test('early trajectory candidates cover different viewing directions', () => {
    const povs = [[-.9, .4, -.2], [-.89, .4, -.3], [.8, .5, .3], [.2, .9, .3]];
    const states = [0, 70].flatMap(fold => povs.map(pov => ({ fold, pov, visibleFaceIds: [0] })));
    const candidates = benchmark.generateCandidateTrajectories(states, [0, 70], 4, {});
    const [a, b] = candidates.slice(0, 2).map(t => t[0].pov);
    const cosine = a.reduce((s, v, i) => s + v * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b));
    expect(Math.acos(cosine)).toBeGreaterThan(1);
    expect(candidates).toHaveLength(4);
    expect(candidates.every(t => JSON.stringify(t[0].pov) === JSON.stringify(t[1].pov))).toBe(true);
});

const cache = loadModule('benchmark.js', 'initBenchmark', ['buildEvaluationCacheKey']);
test('evaluation cache keys include acceptance inputs but allow larger search budgets', () => {
    const settings = { model: '/Bases/birdBase.svg', difficulty: 4, rngSeed: 42,
        scanFoldSteps: [0, 35, 70], facePoints: { 0: [{ u: .3, v: .3, w: .4 }] }, rotationProfileCount: 6 };
    const key = c => cache.buildEvaluationCacheKey(c, [0], .05, 300);
    expect(key({ ...settings, rotationProfileCount: 12 })).toBe(key(settings));
    expect(key({ ...settings, rotationProfiles: [[[0, 0, 0], [.1, .2, .3], [.2, .4, .6]]] })).toBe(key(settings));
    expect(key({ ...settings, scanFoldSteps: [0, 35, 60] })).not.toBe(key(settings));
    expect(key({ ...settings, minPointSeparationPx: 100 })).not.toBe(key(settings));
    expect(key({ ...settings, facePoints: { 1: [{ u: .3, v: .3, w: .4 }] } })).not.toBe(key(settings));
    expect(cache.buildEvaluationCacheKey(settings, [0], .05, 800)).not.toBe(key(settings));
});


test('marker clearance catches a clipped dot whose center remains visible', () => {
    let positions = [-1,-1,0, 1,-1,0, 0,2,0, .01,-1,.1, 1,-1,.1, .01,1,.1];
    const points = loadModule('facePoints.js', 'initFacePoints', [], THREE => {
        const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, .1, 10);
        camera.position.set(0, 0, 5);
        camera.lookAt(new THREE.Vector3(0, 0, 0));
        camera.updateMatrixWorld(true);
        camera.matrixWorldInverse.getInverse(camera.matrixWorld);
        return { model: { getFaces: () => [[0, 1, 2], [3, 4, 5]], getPositionsArray: () => positions },
            threeView: { camera, modelWrapper: new THREE.Object3D() } };
    });
    points.initFromConfig({0: [[1/3, 1/3, 1/3]]});
    expect(points.isPointVisible(0)).toBe(true);
    expect(points.hasSurfaceClearance(0, .02)).toBe(false);
    positions = positions.slice();
    for (let i = 11; i < positions.length; i += 3) positions[i] = -1;
    expect(points.hasSurfaceClearance(0, .02)).toBe(true);
});

test('refinement cannot select an original position occluded at an earlier step', async () => {
    let globals, points, benchmark, positions;
    points = loadModule('facePoints.js', 'initFacePoints', [], THREE => {
        const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, .1, 10);
        camera.position.set(0, 0, 5);
        camera.lookAt(new THREE.Vector3());
        camera.updateMatrixWorld(true);
        camera.matrixWorldInverse.getInverse(camera.matrixWorld);
        // A narrow overlapping strip hides only the center of the lower face.
        positions = [-1,-1,0, 1,-1,0, 0,2,0, -.03,-1,.1, .03,-1,.1, .03,1,.1, -.03,1,.1];
        globals = {
            model: { getFaces: () => [[0,1,2], [3,4,5], [3,5,6]], getPositionsArray: () => positions, reset() {} },
            threeView: { camera, modelWrapper: new THREE.Object3D(), renderer: { domElement: { width: 512, height: 512 } }, resetModel() {} },
            setCreasePercent(fold) { for (let i = 11; i < positions.length; i += 3) positions[i] = fold > .3 ? -1 : .1; }
        };
        return globals;
    });
    globals.facePoints = points;
    benchmark = loadModule('benchmark.js', 'initBenchmark', [], globals);
    globals.benchmark = { applySettings: preset => points.initFromConfig(preset.facePoints), getPointScreenPosition: benchmark.getPointScreenPosition };
    const refiner = loadModule('presetGenerator.js', 'initPresetGenerator', ['refineFacePointBarycentric'], globals);
    const preset = { difficulty: 3, facePoints: { 0: [{ u: 1/3, v: 1/3, w: 1/3 }] }, steps: [{ fold: 0 }, { fold: 70 }] };
    points.initFromConfig(preset.facePoints);
    expect(points.isPointVisible(0)).toBe(false);
    await new Promise(resolve => refiner.refineFacePointBarycentric(preset, 1, refiner.makeRng(42), resolve));
    globals.setCreasePercent(0);
    points.initFromConfig(preset.facePoints);
    expect(points.isPointVisible(0)).toBe(true);
});


test('failed final validation cannot emit an unchecked original preset', async () => {
    const api = loadModule('presetGenerator.js', 'initPresetGenerator', ['refineAndRevalidate']);
    const preset = { facePoints: { 0: [{ u: .3, v: .3, w: .4 }] }, steps: [{ fold: 0 }] };
    const result = await new Promise(resolve => api.refineAndRevalidate([preset], 1, api.makeRng(42), resolve));
    expect(result).toEqual([]);
});

test('marker viewing quality detects edge-on faces and distinguishes sides', () => {
    let wrapper;
    const points = loadModule('facePoints.js', 'initFacePoints', [], THREE => {
        const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, .1, 10);
        camera.position.set(0, 0, 5);
        camera.lookAt(new THREE.Vector3());
        camera.updateMatrixWorld(true);
        camera.matrixWorldInverse.getInverse(camera.matrixWorld);
        wrapper = new THREE.Object3D();
        return { model: { getFaces: () => [[0,1,2]], getPositionsArray: () => [-1,-1,0, 1,-1,0, 0,2,0] }, threeView: { camera, modelWrapper: wrapper } };
    });
    points.initFromConfig({ 0: [[1/3,1/3,1/3]], 1: [[1/3,1/3,1/3]] });
    expect(points.getPointViewQuality(0)).toBeCloseTo(1);
    expect(points.getPointViewQuality(1)).toBe(0);
    wrapper.rotation.y = Math.acos(.2);
    expect(points.isPointVisible(0)).toBe(true);
    expect(points.getPointViewQuality(0)).toBeCloseTo(.2);
    wrapper.rotation.y = Math.PI;
    expect(points.getPointViewQuality(0)).toBe(0);
    expect(points.getPointViewQuality(1)).toBeCloseTo(1);
});

test('point selection prefers fewer readable dots over filling slots with edge-on faces', () => {
    const api = loadModule('presetGenerator.js', 'initPresetGenerator', ['selectFacePointsFromTrajectory']);
    const state = { visibleFaceIds: [0,1,2,3,4], qualities: {0: 1, 1: .8, 2: .6, 3: .1, 4: .05} };
    const configs = api.selectFacePointsFromTrajectory({visibilityTimeline: [state, state]}, 1, 5, [0,1,2,3,4], [], api.makeRng(42), '/Bases/birdBase.svg', .3);
    expect(configs.length).toBeGreaterThan(0);
    for (const config of configs) {
        expect(Object.keys(config.facePoints).sort()).toEqual(['0', '1', '2']);
        expect(Object.values(config.facePoints).flat().filter(p => !p.hidden)).toHaveLength(2);
    }
});

test('validator rejects missing preset banks instead of reporting zero failures', () => {
    const run = Bun.spawnSync([process.execPath, new URL('validate-presets.js', import.meta.url).pathname,
        '--inputs', new URL('fixtures/missing-bank.json', import.meta.url).pathname]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain('Cannot read preset bank');
});

test('matrix skips mapfold at the clustered tiers and keeps its other tiers', () => {
    // A stub `bun` on PATH records each generate-presets.js slot instead of running it.
    const dir = mkdtempSync(join(tmpdir(), 'origami-matrix-test-'));
    try {
        const spawned = join(dir, 'spawned.txt');
        writeFileSync(join(dir, 'bun'), `#!/bin/sh\necho "$@" >> "${spawned}"\n`, { mode: 0o755 });
        const matrix = (models, difficulties) => Bun.spawnSync([process.execPath, new URL('generate-matrix.js', import.meta.url).pathname,
            '--models', models, '--difficulties', difficulties, '--out-dir', relative(new URL('..', import.meta.url).pathname, join(dir, 'out'))],
            { env: { ...process.env, PATH: dir + ':' + process.env.PATH } });
        const run = matrix('mapfold,bird', '3,4,5');
        expect(run.exitCode).toBe(0);
        expect(run.stdout.toString()).toContain('skipping mapfold-d3, mapfold-d5');
        const slots = readFileSync(spawned, 'utf8').trim().split('\n').map(line => line.match(/--base-name (\S+)/)[1]);
        expect(slots.sort()).toEqual(['bird-d3', 'bird-d4', 'bird-d5', 'mapfold-d4']);
        expect(matrix('mapfold', '5').exitCode).not.toBe(0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('render --skip-existing skips only presets complete under DATASET_DIR', () => {
    const dir = mkdtempSync(join(tmpdir(), 'origami-render-test-'));
    try {
        const out = join(dir, 'out'), dataset = join(dir, 'presets.json');
        const preset = { model: '/Bases/birdBase.svg', steps: [{ fold: 0 }] };
        const images = ['bird-01/step_0000_current.png'];
        mkdirSync(join(out, 'metadata'), { recursive: true });
        mkdirSync(join(out, 'bird-01'));
        writeFileSync(join(out, images[0]), 'png');
        writeFileSync(join(out, 'metadata/bird_metadata.json'), JSON.stringify({ 'bird-01': { presetConfig: preset, images } }));
        writeFileSync(join(out, 'dataset.jsonl'), JSON.stringify({ images, meta_info: { benchmark: 'bird-01' } }) + '\n');
        // A missing browser stops a pending render right after the skip check.
        const render = (config) => {
            writeFileSync(dataset, JSON.stringify({ 'bird-01': config }));
            return Bun.spawnSync([process.execPath, new URL('render-dataset.js', import.meta.url).pathname, '--dataset', dataset, '--skip-existing'],
                { env: { ...process.env, DATASET_DIR: out, PUPPETEER_EXECUTABLE_PATH: join(dir, 'no-browser') } }).stdout.toString();
        };
        expect(render(preset)).toContain('Nothing to render.');
        expect(render({ ...preset, steps: [{ fold: 70 }] })).toMatch(/To render:\s+1 /);
        unlinkSync(join(out, images[0]));
        expect(render(preset)).toMatch(/To render:\s+1 /);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('reverse-presets requires its paths and reverses every sequence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'origami-reverse-test-'));
    try {
        const script = new URL('reverse-presets.js', import.meta.url).pathname;
        const missing = Bun.spawnSync([process.execPath, script]);
        expect(missing.exitCode).not.toBe(0);
        expect(missing.stderr.toString()).toContain('--input <bank.json> --output <reversed.json>');
        const input = join(dir, 'bank.json'), output = join(dir, 'reversed.json');
        writeFileSync(input, JSON.stringify({ 'bird-01': { model: '/Bases/birdBase.svg', steps: [{ fold: 0 }, { fold: 70 }] } }));
        expect(Bun.spawnSync([process.execPath, script, '--input', input, '--output', output]).exitCode).toBe(0);
        const reversed = JSON.parse(readFileSync(output, 'utf8'))['bird-01'];
        expect(reversed.steps).toEqual([{ fold: 70 }, { fold: 0 }]);
        expect(reversed.direction).toBe('reverse');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('mapfold refinement follows the same intermediate-occlusion rule as validation', async () => {
    let globals, positions;
    const points = loadModule('facePoints.js', 'initFacePoints', [], THREE => {
        const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, .1, 10);
        camera.position.set(0, 0, 5);
        camera.lookAt(new THREE.Vector3());
        camera.updateMatrixWorld(true);
        camera.matrixWorldInverse.getInverse(camera.matrixWorld);
        positions = [-1,-1,0, 1,-1,0, 0,2,0, -.03,-2,-1, .03,-2,-1, .03,2,-1, -.03,2,-1];
        globals = {
            model: { getFaces: () => [[0,1,2], [3,4,5], [3,5,6]], getPositionsArray: () => positions, reset() {} },
            threeView: { camera, modelWrapper: new THREE.Object3D(), renderer: { domElement: { width: 512, height: 512 } }, resetModel() {} },
            setCreasePercent(fold) {
                const width = fold > 0 && fold < .5 ? 2 : .03;
                for (let vertex = 3; vertex <= 6; vertex++) {
                    positions[vertex*3] = vertex === 3 || vertex === 6 ? -width : width;
                    positions[vertex*3+2] = fold === 0 ? -1 : .1;
                }
            }
        };
        return globals;
    });
    globals.facePoints = points;
    const benchmark = loadModule('benchmark.js', 'initBenchmark', [], globals);
    globals.benchmark = { applySettings: preset => points.initFromConfig(preset.facePoints), getPointScreenPosition: benchmark.getPointScreenPosition };
    const api = loadModule('presetGenerator.js', 'initPresetGenerator', ['refineFacePointBarycentric'], globals);
    const preset = { model: '/SimpleFolds/mapfold.svg', difficulty: 3, facePoints: {0: [{u: 1/3, v: 1/3, w: 1/3}]}, steps: [{fold: 0}, {fold: 35}, {fold: 70}] };
    await new Promise(resolve => api.refineFacePointBarycentric(preset, 1, api.makeRng(42), resolve));
    points.initFromConfig(preset.facePoints);
    expect(points.isPointVisible(0)).toBe(true);
});

test('clearance search can find exposed positions beyond the central grid', async () => {
    let globals, positions;
    const points = loadModule('facePoints.js', 'initFacePoints', [], THREE => {
        const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, .1, 10);
        camera.position.set(0, 0, 5);
        camera.lookAt(new THREE.Vector3());
        camera.updateMatrixWorld(true);
        camera.matrixWorldInverse.getInverse(camera.matrixWorld);
        positions = [-1,-1,0, 1,-1,0, 0,2,0, -.03,-2,-1, .03,-2,-1, .03,2,-1, -.03,2,-1];
        globals = {
            model: { getFaces: () => [[0,1,2], [3,4,5], [3,5,6]], getPositionsArray: () => positions, reset() {} },
            threeView: { camera, modelWrapper: new THREE.Object3D(), renderer: { domElement: { width: 512, height: 512 } }, resetModel() {} },
            setCreasePercent(fold) {
                const width = .25;
                for (let vertex = 3; vertex <= 6; vertex++) {
                    positions[vertex*3] = vertex === 3 || vertex === 6 ? -width : width;
                    positions[vertex*3+2] = fold === 0 ? -1 : .1;
                }
            }
        };
        return globals;
    });
    globals.facePoints = points;
    const benchmark = loadModule('benchmark.js', 'initBenchmark', [], globals);
    globals.benchmark = { applySettings: preset => points.initFromConfig(preset.facePoints), getPointScreenPosition: benchmark.getPointScreenPosition };
    const api = loadModule('presetGenerator.js', 'initPresetGenerator', ['refineFacePointBarycentric'], globals);
    const preset = { model: '/Bases/birdBase.svg', difficulty: 1, requirePointClearance: true, minPointViewQuality: .3, facePoints: {0: [{u: 1/3, v: 1/3, w: 1/3}]}, steps: [{fold: 0}, {fold: 70}] };
    await new Promise(resolve => api.refineFacePointBarycentric(preset, 1, api.makeRng(42), resolve));
    points.initFromConfig(preset.facePoints);
    expect(points.isPointVisible(0)).toBe(true);
    expect(points.hasSurfaceClearance(0, .03)).toBe(true);
});


test('benchmark replay resets solver history before applying the initial fold', () => {
    const events = [];
    const playback = loadModule('benchmark.js', 'initBenchmark', ['run'], {
        setCreasePercent: value => events.push(['fold', value]),
        model: { reset: () => events.push(['reset']), step: () => events.push(['step']) },
        threeView: { resetModel: () => events.push(['rotation']) }
    });
    playback.run({ fold: 0, steps: [] }, () => {});
    expect(events).toEqual([['fold', 0], ['reset'], ['rotation'], ['fold', 0], ['step']]);
});

const expertApi = loadModule('presetGenerator.js', 'initPresetGenerator', [
    'measureExpertMotion', 'clusterPresetFailures', 'filterCandidatesByDifficulty',
    'createPresetFromProgression', 'foldLadderForDifficulty', 'selectFacePointsFromTrajectory',
    'buildExpertRotationProfiles', 'rotationBoundsForTier', 'expertMotionFailures'
]);
// Fixture models have 8 faces; a 180-degree turn maps face f to f+4 (mod 8),
// on the same side. Back points sit at faceId + 8.
const TABLE8 = [4, 5, 6, 7, 0, 1, 2, 3];
const twin8 = f => f < 8 ? TABLE8[f] : TABLE8[f - 8] + 8;
const dot = (faceId, hidden = true) => ({faceId, u: .34, v: .33, w: .33, hidden});
// Every seed dot gains a hidden twin on its face's twin face, linked by pair.
// Expert leaves back dots (faceId >= 8) untwinned.
function withTwins(seeds, twinFace = twin8, twinBack = true) {
    return seeds.flatMap((p, k) => !twinBack && p.faceId >= 8 ? [p]
        : [{...p, pair: k}, {...p, faceId: twinFace(p.faceId), pair: k, twin: true, hidden: true}]);
}
const expertTwins = (seeds, twinFace = twin8) => withTwins(seeds, twinFace, false);
function expertFixture() {
    // Seeds: two tracked panels of three and an untwinned back dot: thirteen dots.
    const points = expertTwins([dot(0, false), dot(0), dot(0), dot(1, false), dot(1), dot(1), dot(14)]);
    const [rotations] = expertApi.buildExpertRotationProfiles(14, 1, 42, expertApi.rotationBoundsForTier(5));
    const steps = expertApi.foldLadderForDifficulty(5, 70).map((fold, i) => ({fold, pov: [.5,.8,.3], rotation: rotations[i]}));
    const preset = expertApi.createPresetFromProgression({steps}, points, {
        difficulty: 5, rng: expertApi.makeRng(42), modelFaceCount: 8, twinSymmetry: 'rotate180',
        colors: ['0077cc','00538f'], minPointSeparationPx: 30, minPointViewQuality: .1
    });
    return {preset, points};
}

test('expert assembly uses fourteen frames, small same-color markers, and scaled spacing', () => {
    const {preset, points} = expertFixture();
    expect(preset.difficulty).toBe(5);
    expect(preset.steps).toHaveLength(14);
    expect(expertApi.foldLadderForDifficulty(4,70)).toHaveLength(10);
    expect(expertApi.clusterPresetFailures(preset, points, 8)).toEqual([]);
    // Expert dots shrink to 0.014 and the spacing floor shrinks with them.
    expect(preset.pointRadius).toBe(.014);
    expect(preset.minPointSeparationPx).toBe(39);
    const motion = expertApi.measureExpertMotion(preset.steps);
    expect(motion.endAngle).toBeGreaterThan(1.3);
    expect(motion.maxStepAngle).toBeLessThan(.9);
    expect(motion.pathAngle).toBeGreaterThan(5);
    expect(motion.headingTurn).toBeGreaterThanOrEqual(Math.PI);
});

test('non-expert presets keep the default marker size', () => {
    const {preset, points} = expertFixture();
    const d4 = expertApi.createPresetFromProgression({steps: preset.steps.slice(0, 10)}, points.slice(0, 4), {
        difficulty: 4, rng: expertApi.makeRng(42), modelFaceCount: 8
    });
    expect(d4.pointRadius).toBeUndefined();
    expect(d4.minPointSeparationPx).toBe(70);
});

test('expert motion rejects the straight ramps that the six-frame contract accepted', () => {
    const {preset, points} = expertFixture();
    const ramp = preset.steps.map((s, i) => ({...s, rotation: [1.1*i/13, 1.3*i/13, .25*i/13]}));
    const failures = expertApi.clusterPresetFailures({...preset, steps: ramp}, points, 8).map(f => f.reason);
    expect(failures.some(r => r.includes('path of at least'))).toBe(true);
    expect(failures.some(r => r.includes('change direction'))).toBe(true);
});

test('expert spin cannot be faked with a 2*pi jump between frames', () => {
    const {preset, points} = expertFixture();
    // Adding 2*pi to yaw from frame 7 on leaves every orientation unchanged.
    const jumped = preset.steps.map((s, i) => ({...s, rotation: i < 7 ? [0, 0, 0] : [0, 2 * Math.PI, 0]}));
    const failures = expertApi.clusterPresetFailures({...preset, steps: jumped}, points, 8).map(f => f.reason);
    expect(failures.some(r => r.includes('change gradually'))).toBe(true);
});

for (const [style, minPath, spins] of [['detour', 5, 0], ['spin', 7, 1], ['tumble', 6.5, 0], ['pendulum', 6.5, 0]]) {
    test(`${style} expert profiles meet the contract at a steady pace`, () => {
        const build = () => expertApi.buildExpertRotationProfiles(14, 40, 7, expertApi.rotationBoundsForTier(5), style);
        const profiles = build();
        expect(profiles).toHaveLength(40);
        expect(build()).toEqual(profiles);
        for (const rotations of profiles) {
            expect(rotations[0]).toEqual([0, 0, 0]);
            const steps = rotations.map(rotation => ({rotation}));
            expect(expertApi.expertMotionFailures(steps)).toEqual([]);
            const motion = expertApi.measureExpertMotion(steps);
            expect(motion.pathAngle).toBeGreaterThanOrEqual(minPath);
            expect(motion.spinTurns).toBeGreaterThanOrEqual(spins - .01);
            if (!spins) expect(motion.maxYawStep).toBeLessThanOrEqual(.6);
            // Frames are evenly spaced along the curve. Steps are measured as
            // chords, which are shorter on curvy stretches, so allow some slack.
            expect(motion.maxStepAngle).toBeLessThan(1.5 * motion.pathAngle / 13);
        }
    });
}

test('unknown expert motion styles are rejected', () => {
    expect(() => expertApi.buildExpertRotationProfiles(14, 1, 7, expertApi.rotationBoundsForTier(5), 'wobble')).toThrow();
});

test('expert validation rejects easy motion, abrupt jumps, missing distractors, and relaxed readability', () => {
    const {preset, points} = expertFixture();
    const invalid = [
        {...preset, steps: preset.steps.map(s => ({...s, rotation: [0,0,0]}))},
        {...preset, steps: preset.steps.map((s,i) => ({...s, rotation: i===7 ? [1.1,1.3,.25] : [0,0,0]}))},
        {...preset, steps: preset.steps.map((s,i) => ({...s, rotation: [0,1.5*i/7,0]}))},
        {...preset, steps: preset.steps.slice(1)},
        {...preset, steps: preset.steps.slice(0, 10)},
        {...preset, color2: 'ffffff'},
        {...preset, minPointViewQuality: .1},
        {...preset, minPointSeparationPx: 30},
        {...preset, pointRadius: .018},
        {...preset, pointRadius: undefined},
        {...preset, enforceSeparationAllSteps: false},
        {...preset, steps: preset.steps.map((s,i) => ({...s,pov:i===5?[1,0,0]:s.pov}))}
    ];
    for (const bad of invalid) expect(expertApi.clusterPresetFailures(bad, points, 8).length).toBeGreaterThan(0);
    expect(expertApi.clusterPresetFailures(preset, points.slice(0,5), 8).length).toBeGreaterThan(0);
    const seeds = [dot(0, false), dot(0), dot(0), dot(1, false), dot(1), dot(1), dot(14)];
    const layouts = {
        unpaired: seeds,
        visibleTwin: expertTwins(seeds).map(p => p.twin && p.faceId === 4 ? {...p, hidden: false} : p),
        twinsSplitAcrossPanels: expertTwins(seeds).map((p, i) => i === 3 ? {...p, faceId: 7} : p),
        twinOnSeedPanel: expertTwins(seeds, f => f === 0 ? 1 : twin8(f)),
        twinnedBack: withTwins(seeds),
        fiveOnOnePanel: expertTwins([dot(0, false), dot(0), dot(0), dot(0), dot(0), dot(1), dot(14)]),
        twoAnchorsOnOnePanel: expertTwins([dot(0, false), dot(0, false), dot(0), dot(1), dot(1), dot(1), dot(14)]),
        threeTracked: expertTwins([dot(0, false), dot(1, false), dot(1), dot(2, false), dot(2), dot(2), dot(15)]),
        visibleBack: expertTwins([dot(0, false), dot(0), dot(0), dot(1), dot(1), dot(1), dot(14, false)]),
        backUnderFrontGroup: expertTwins([dot(0, false), dot(0), dot(0), dot(1), dot(1), dot(1), dot(8)]),
        noBack: expertTwins([dot(0, false), dot(0), dot(0), dot(1, false), dot(1), dot(1)]),
        elevenDots: expertTwins([dot(0, false), dot(0), dot(1), dot(1), dot(1), dot(14)]),
        twentyOneDots: expertTwins([dot(0, false), dot(0), dot(0), dot(0), dot(1, false), dot(1), dot(1), dot(1), dot(2), dot(2), dot(15)])
    };
    for (const [name, bad] of Object.entries(layouts)) {
        expect([name, expertApi.clusterPresetFailures(preset, bad, 8).length > 0]).toEqual([name, true]);
    }
    // Twins need a rotation: a mirror leaves the halves distinguishable.
    const mirrored = {...preset, clusterPlacement: {...preset.clusterPlacement, symmetry: 'mirrorX'}};
    expect(expertApi.clusterPresetFailures(mirrored, points, 8).length).toBeGreaterThan(0);
    expect(expertApi.clusterPresetFailures({...preset, clusterPlacement: {}}, points, 8).length).toBeGreaterThan(0);
});

test('expert validation accepts uneven groups, lone dots and decoy-only panels', () => {
    const {preset} = expertFixture();
    // A lone tracked dot, decoy-only groups of four and two, one back dot: fifteen dots.
    const lone = expertTwins([dot(0, false), dot(1), dot(1), dot(1), dot(1), dot(2), dot(2), dot(15)]);
    expect(expertApi.clusterPresetFailures(preset, lone, 8)).toEqual([]);
    // Tracked panels of four and four, a decoy pair, two back panels: twenty dots.
    const wide = expertTwins([dot(0, false), dot(0), dot(0), dot(0), dot(1, false), dot(1), dot(1), dot(1), dot(15), dot(14)]);
    expect(expertApi.clusterPresetFailures(preset, wide, 8)).toEqual([]);
    // Back panels hold groups too: twelve dots.
    const groupedBack = expertTwins([dot(0, false), dot(0), dot(1), dot(1), dot(1), dot(14), dot(14)]);
    expect(expertApi.clusterPresetFailures(preset, groupedBack, 8)).toEqual([]);
});

test('expert candidate filtering cannot fall back to a lower-motion example', () => {
    const {preset} = expertFixture();
    const easy = {...preset, steps: preset.steps.map(s => ({...s,rotation:[0,0,0]}))};
    const kept = expertApi.filterCandidatesByDifficulty([easy,preset],5,8,2,expertApi.makeRng(42));
    expect(kept).toEqual([preset]);
});

// Checks one emitted clustered config: every front seed dot (and every back
// one when L.twinBack) has a hidden twin on its face's twin face, and the
// seed layout meets the tier's ranges. L.points counts twins.
function expectClusterConfig(config, faceCount, L, twinFace = twin8) {
    const all = Object.entries(config.facePoints).flatMap(([face, pts]) => pts.map(p => ({...p, faceId: Number(face)})));
    const seeds = all.filter(p => !p.twin), twins = all.filter(p => p.twin);
    const twinned = seeds.filter(p => L.twinBack || p.faceId < faceCount);
    expect(twins.length).toBe(twinned.length);
    expect(seeds.filter(p => !twinned.includes(p)).every(p => p.pair == null)).toBe(true);
    for (const seed of twinned) {
        const mate = twins.filter(t => t.pair === seed.pair);
        expect(mate.length).toBe(1);
        expect(mate[0].hidden).toBe(true);
        expect(mate[0].faceId).toBe(twinFace(seed.faceId));
    }
    const groups = {};
    for (const seed of seeds) (groups[seed.faceId] = groups[seed.faceId] || []).push(seed);
    const entries = Object.entries(groups).map(([face, points]) => [Number(face), points]);
    const front = entries.filter(([face]) => face < faceCount), back = entries.filter(([face]) => face >= faceCount);
    const anchored = front.filter(([, points]) => points.some(p => !p.hidden));
    expect(all.length).toBeGreaterThanOrEqual(L.points[0]);
    expect(all.length).toBeLessThanOrEqual(L.points[1]);
    expect(anchored.length).toBeGreaterThanOrEqual(L.tracked[0]);
    expect(anchored.length).toBeLessThanOrEqual(L.tracked[1]);
    expect(front.length - anchored.length).toBeGreaterThanOrEqual(L.decoyGroups[0]);
    expect(front.length - anchored.length).toBeLessThanOrEqual(L.decoyGroups[1]);
    for (const [, points] of front) {
        expect(points.length).toBeLessThanOrEqual(L.groupSize[1]);
        expect(points.filter(p => !p.hidden).length).toBeLessThanOrEqual(1);
        expect(new Set(points.map(p => JSON.stringify([p.u, p.v, p.w]))).size).toBe(points.length);
    }
    expect(back.length).toBeGreaterThanOrEqual(L.back[0]);
    expect(back.length).toBeLessThanOrEqual(L.back[1]);
    for (const [, points] of back) {
        expect(points.every(p => p.hidden)).toBe(true);
        expect(points.length).toBeLessThanOrEqual(L.groupSize[1]);
    }
}
// Seed-layout ranges; points counts every dot, twins included.
const EXPERT_RANGES = {tracked: [1, 2], decoyGroups: [0, 2], groupSize: [1, 4], back: [1, 2], points: [12, 20], twinBack: false};
const MEDIUM_RANGES = {tracked: [2, 3], decoyGroups: [0, 2], groupSize: [1, 4], back: [0, 0], points: [10, 14], twinBack: true};
const ROTATIONS8 = [{name: 'rotate180', faces: TABLE8}];

// Front faces 0, 1, 4, 5 and back faces 2, 3, 6, 7 are readable: two front
// and two back twin pairs under the 180-degree table.
const TWIN_STATE = {fold:0, visibleFaceIds:[0,1,4,5], qualities:{0:.9,1:.8,4:.7,5:.6},
    backSideVisibleFaceIds:[2,3,6,7], backQualities:{2:.8,3:.7,6:.8,7:.7}};

test('symmetric twins put tracked dots only on panel pairs whose twin panel is readable throughout', () => {
    const api = loadModule('presetGenerator.js', 'initPresetGenerator',
        ['selectFacePointsFromTrajectory', 'setClusterSymmetricTwins', 'twinPairs', 'makeRng']);
    // Face 4 (face 0's twin) drops out mid-sequence; faces 1 and 5 stay readable.
    const mid = {...TWIN_STATE, fold: 35, visibleFaceIds: [0, 1, 5], qualities: {0: .9, 1: .8, 5: .6}};
    const timeline = [TWIN_STATE, mid, {...TWIN_STATE, fold: 70}];
    const anchorFaces = on => {
        api.setClusterSymmetricTwins(on);
        const faces = new Set();
        for (let seed = 1; seed <= 12; seed++) {
            for (const config of api.selectFacePointsFromTrajectory({visibilityTimeline: timeline}, 5, 8, [0, 1, 4, 5], [],
                    api.makeRng(seed), '/Bases/birdBase.svg', .3, {twinRotations: ROTATIONS8})) {
                const all = Object.entries(config.facePoints).flatMap(([face, pts]) => pts.map(p => ({...p, faceId: Number(face)})));
                for (const p of all.filter(p => !p.hidden && !p.twin)) faces.add(p.faceId);
            }
        }
        return faces;
    };
    // Without the rule, face 0 can hold the tracked dot although its twin
    // panel (4) is unreadable mid-sequence; with it, only the 1/5 pair can.
    expect(anchorFaces(false).has(0)).toBe(true);
    const symmetric = anchorFaces(true);
    expect(symmetric.size).toBeGreaterThan(0);
    for (const face of symmetric) expect([1, 5]).toContain(face);
    // The pair rule itself: with both panels required, face 0's pair drops.
    const readable = {0: true, 1: true, 4: true, 5: true}, anchors = {0: true, 1: true, 5: true};
    expect(Array.from(api.twinPairs(TABLE8, readable, anchors), p => Array.from(p))).toEqual([[0, 4], [1, 5]]);
    expect(Array.from(api.twinPairs(TABLE8, readable, anchors, true), p => Array.from(p))).toEqual([[1, 5]]);
    api.setClusterSymmetricTwins(false);
});

test('expert point selection pairs every group with a readable twin and needs all-step anchors', () => {
    const state = TWIN_STATE;
    const select = (timeline, opts = {twinRotations: ROTATIONS8}) => expertApi.selectFacePointsFromTrajectory(
        {visibilityTimeline:timeline},5,8,[0,1,4,5],[],expertApi.makeRng(42),'/Bases/birdBase.svg',.3,opts);
    const configs = select([state,state]);
    expect(configs.length).toBeGreaterThan(0);
    for (const config of configs) {
        expectClusterConfig(config, 8, EXPERT_RANGES);
        expect(config.twinSymmetry).toBe('rotate180');
    }
    // Expert back groups need no twin, but they need a readable back panel.
    expect(select([state,{...state,backSideVisibleFaceIds:[2,3]}]).length).toBeGreaterThan(0);
    expect(select([state,{...state,backSideVisibleFaceIds:[]}])).toEqual([]);
    expect(select([state,{...state,fold:35,visibleFaceIds:[]},{...state,fold:70}])).toEqual([]);
    // Without a rotation the folded model carries, nothing can be twinned.
    expect(select([state,state], {})).toEqual([]);
    // Only face 0 stays visible throughout, so every anchor sits on it.
    const narrowed = select([{...state,visibleFaceIds:[0]},state]);
    expect(narrowed.length).toBeGreaterThan(0);
    for (const config of narrowed) {
        expectClusterConfig(config, 8, EXPERT_RANGES);
        const anchorFaces = Object.entries(config.facePoints).filter(([, pts]) => pts.some(p => !p.hidden)).map(([f]) => f);
        expect(anchorFaces).toEqual(['0']);
    }
});

test('models sharing a seed draw different cluster layouts', () => {
    const layouts = model => JSON.stringify(expertApi.selectFacePointsFromTrajectory({visibilityTimeline:[TWIN_STATE,TWIN_STATE]},5,8,[0,1,4,5],[],
        expertApi.makeRng(42),model,.3,{configsPerTrajectory:4, twinRotations: ROTATIONS8}).map(c => c.layout));
    const models = ['/Bases/birdBase.svg', '/Bases/boatBase.svg', '/Bases/waterbombBase.svg', '/Bases/squareBase.svg'];
    expect(new Set(models.map(layouts)).size).toBeGreaterThan(1);
    expect(layouts(models[0])).toBe(layouts(models[0]));
});

test('twins follow only rotations the folded model carries', () => {
    // A square sheet in the x-z plane: centre node 4 and four corner fans.
    // Folding lifts corners 0 and 2, so the model keeps its 180-degree turn,
    // loses the 90-degree one, and keeps the 0-2 diagonal only as a mirror.
    const flat = [[1, 0, 1], [-1, 0, 1], [-1, 0, -1], [1, 0, -1], [0, 0, 0]];
    const folded = [[.8, .5, .8], [-1, 0, 1], [-.8, .5, -.8], [1, 0, -1], [0, 0, 0]];
    const faces = [[4, 0, 1], [4, 1, 2], [4, 2, 3], [4, 3, 0]];
    const globals = {
        model: { getNodes: () => flat.map(([x, y, z]) => ({ getOriginalPosition: () => ({x, y, z}) })),
                 getFaces: () => faces, getPositionsArray: () => folded.flat() },
        facePoints: { insetBarycentric: (u, v, w) => ({u, v, w}) }
    };
    const api = loadModule('presetGenerator.js', 'initPresetGenerator',
        ['flatSheet', 'sheetSymmetries', 'foldedSymmetry', 'twinPoint', 'carriedRotations'], globals);
    const sheet = api.flatSheet();
    const syms = Object.fromEntries(api.sheetSymmetries(sheet).map(sym => [sym.name, sym]));
    expect(Object.keys(syms).sort()).toEqual(['mirrorAntidiagonal', 'mirrorDiagonal', 'mirrorX', 'mirrorY', 'rotate180', 'rotate270', 'rotate90']);
    const half = api.foldedSymmetry(syms.rotate180.perm, sheet.size);
    expect(half.error).toBeLessThan(1e-9);
    expect(half.rotation).toBe(true);
    expect(api.foldedSymmetry(syms.rotate90.perm, sheet.size).error).toBeGreaterThan(.1);
    // The diagonal through corners 0 and 2 maps the folded model onto itself only as a mirror.
    const diagonal = Object.values(syms).find(sym => sym.perm[0] === 0 && sym.perm[2] === 2 && sym.perm[1] === 3);
    const mirrored = api.foldedSymmetry(diagonal.perm, sheet.size);
    expect(mirrored.error).toBeLessThan(1e-9);
    expect(mirrored.rotation).toBe(false);
    // A dot's twin under the turn sits in the opposite fan at the matching spot.
    expect(api.twinPoint({faceId: 0, u: .2, v: .5, w: .3}, syms.rotate180, sheet, 4)).toEqual({faceId: 2, u: .2, v: .5, w: .3});
    // A back dot keeps its side.
    expect(api.twinPoint({faceId: 4, u: .2, v: .5, w: .3}, syms.rotate180, sheet, 4).faceId).toBe(6);
    expect(api.carriedRotations()).toEqual([{name: 'rotate180', faces: [2, 3, 0, 1]}]);
});

test('trajectory search needs readable panel and twin-panel pairs', () => {
    const api = loadModule('benchmark.js','initBenchmark',['hasRequiredPointPools']);
    const required = {visibleFront:1, finalFront:2, finalBack:0, minQuality:.3, twinFrontPairs:1, twinBackPairs:0, twinAnchorPairs:1,
        twins: [{name: 'rotate180', faces: [2, 3, 0, 1]}]};
    const state = faces => ({visibleFaceIds: faces, qualities: Object.fromEntries(faces.map(f => [f, .8])), backSideVisibleFaceIds: [], backQualities: {}});
    expect(api.hasRequiredPointPools([state([0, 2]), state([0, 2])], required)).toBe(true);
    // Faces 0 and 1 are readable, but their twins 2 and 3 are not.
    expect(api.hasRequiredPointPools([state([0, 1]), state([0, 1])], required)).toBe(false);
    // The pair is readable at the end, but neither face stays visible for an anchor.
    expect(api.hasRequiredPointPools([state([1]), state([0, 2])], required)).toBe(false);
});

test('spin turns each profile about the paper normal and keeps angles continuous', () => {
    const api = loadModule('presetGenerator.js', 'initPresetGenerator',
        ['spinProfiles', 'buildExpertRotationProfiles', 'rotationBoundsForTier', 'expertMotionFailures', 'makeRng']);
    const fixed = value => ({randFloat: () => value});
    const base = Array.from({length: 10}, (_, i) => [.03 * i, .05 * i, .01 * i]);
    for (const psi of [1, 3.1, -3.1]) {
        const [spun] = api.spinProfiles([base], fixed(psi), null);
        expect(spun[0]).toEqual([0, 0, 0]);
        // Consecutive frames differ gradually, even past a half turn.
        for (let i = 1; i < spun.length; i++) {
            expect(Math.max(...spun[i].map((v, k) => Math.abs(v - spun[i - 1][k])))).toBeLessThan(.6);
        }
    }
    // Expert keeps enough spun profiles that still meet its motion limits.
    const profiles = api.buildExpertRotationProfiles(14, 60, 7, api.rotationBoundsForTier(5));
    const kept = api.spinProfiles(profiles, api.makeRng(5), api.expertMotionFailures);
    expect(kept.length).toBeGreaterThan(10);
    for (const rotations of kept) expect(api.expertMotionFailures(rotations.map(rotation => ({rotation})))).toEqual([]);
});

test('expert spin turns about the paper normal itself, so the tilt toward the camera is kept', () => {
    const api = loadModule('presetGenerator.js', 'initPresetGenerator',
        ['spinAboutNormal', 'buildExpertRotationProfiles', 'rotationBoundsForTier', 'expertMotionFailures', 'maxPlaneStep', 'makeRng']);
    const context = vm.createContext({window: {}});
    vm.runInContext(readFileSync(new URL('../dependencies/three.min.js', import.meta.url), 'utf8'), context);
    const {THREE} = context;
    const quat = r => new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0], r[1], r[2], 'XYZ'));
    const normal = r => new THREE.Vector3(0, 1, 0).applyQuaternion(quat(r));
    // A rolled pose: Euler y would turn about an axis 0.6 rad off the normal.
    const base = Array.from({length: 14}, (_, i) => [1.3 * i / 13, .2 * i / 13, .6 * i / 13]);
    for (const psi of [2.8, -2.8, 1.6]) {
        const [spun] = api.spinAboutNormal([base], {randFloat: () => psi}, null);
        expect(spun[0]).toEqual([0, 0, 0]);
        spun.forEach((r, i) => {
            expect(normal(r).distanceTo(normal(base[i]))).toBeLessThan(1e-3);
            const want = quat(base[i]).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), psi * i / 13));
            expect(Math.abs(quat(r).dot(want))).toBeGreaterThan(1 - 1e-6);
        });
        // No whole-turn jumps. Near the XYZ gimbal lock x and z move faster
        // than the pose does, so the bound is expert's gradual-change rule.
        for (let i = 1; i < spun.length; i++) {
            expect(Math.max(...spun[i].map((v, k) => Math.abs(v - spun[i - 1][k])))).toBeLessThan(1.8);
        }
    }
    const profiles = api.buildExpertRotationProfiles(14, 60, 7, api.rotationBoundsForTier(5));
    const kept = api.spinAboutNormal(profiles, api.makeRng(5), api.expertMotionFailures);
    expect(kept.length).toBeGreaterThan(30);
    for (const rotations of kept) {
        expect(api.expertMotionFailures(rotations.map(rotation => ({rotation})))).toEqual([]);
        expect(api.maxPlaneStep(rotations)).toBeLessThanOrEqual(.6);
    }
});

test('expert profiles are balanced so the least-turn guess is right half the time', () => {
    const api = loadModule('presetGenerator.js', 'initPresetGenerator',
        ['spinAboutNormal', 'balanceLeastTurn', 'leastTurnShare', 'buildExpertRotationProfiles', 'rotationBoundsForTier',
         'expertMotionFailures', 'makeRng']);
    for (const turns of [[Math.PI / 2, -Math.PI / 2], [Math.PI / 2], [Math.PI]]) {
        const spun = api.spinAboutNormal(api.buildExpertRotationProfiles(14, 160, 11, api.rotationBoundsForTier(5)),
            api.makeRng(4), api.expertMotionFailures);
        const picked = api.balanceLeastTurn(spun, turns, 40);
        expect(picked.length).toBe(40);
        const lean = picked.reduce((s, r) => s + api.leastTurnShare(r, turns) - .5, 0);
        expect(Math.abs(lean)).toBeLessThanOrEqual(.5);
    }
    // One-sided input stops at the first pick that would lean too far.
    const flat = Array.from({length: 14}, (_, i) => [.1 * i / 13, 0, 0]);
    expect(api.leastTurnShare(flat, [Math.PI])).toBe(1);
    expect(api.balanceLeastTurn([flat, flat, flat], [Math.PI], 3)).toHaveLength(1);
});

test('a spun final pose adds the turn to the paper-normal angle', () => {
    const api = loadModule('presetGenerator.js', 'initPresetGenerator', ['spinProfiles']);
    const base = Array.from({length: 10}, (_, i) => [.04 * i, .02 * i, -.01 * i]);
    const [spun] = api.spinProfiles([base], {randFloat: () => 2.5}, null);
    expect(spun[9]).toEqual([base[9][0], Math.round((base[9][1] + 2.5) * 10000) / 10000, base[9][2]]);
    expect(spun[4][1]).toBeCloseTo(base[4][1] + 2.5 * 4 / 9, 4);
});

test('medium motion is judged without its spin, so large spins are not ranked last', () => {
    const api = loadModule('presetGenerator.js', 'initPresetGenerator', ['matchesDifficultyMotion', 'spinProfiles']);
    const ramp = Array.from({length: 10}, (_, i) => [.03 * i, .05 * i, .01 * i]);
    for (const psi of [.2, 1.5, 3.0, -3.0]) {
        const [spun] = api.spinProfiles([ramp], {randFloat: () => psi}, null);
        expect(api.matchesDifficultyMotion(spun.map(rotation => ({rotation, pov: [.5, .8, .3]})), 3)).toBe(true);
    }
});

test('anchored groups are chosen with odds proportional to size', () => {
    const api = loadModule('presetGenerator.js', 'initPresetGenerator', ['chooseAnchoredGroups', 'makeRng']);
    const rng = api.makeRng(3), sizes = [1, 2, 3, 4], hits = [0, 0, 0, 0], runs = 20000;
    for (let i = 0; i < runs; i++) {
        const picked = api.chooseAnchoredGroups(sizes, 2, rng);
        expect(new Set(picked).size).toBe(2);
        picked.forEach(g => hits[g]++);
    }
    // Inclusion is 2 * size / 10, so each dot is an answer with odds 1/5.
    sizes.forEach((size, g) => expect(Math.abs(hits[g] / runs - 2 * size / 10)).toBeLessThan(.015));
    // A group holding more than total/count dots cannot be fair, so the layout is redrawn.
    expect(api.chooseAnchoredGroups([1, 1, 4], 2, rng)).toBeNull();
});

test('cluster layouts vary per draw and treat tracked and decoy-only groups alike', () => {
    const api = loadModule('presetGenerator.js', 'initPresetGenerator', ['drawClusterLayout', 'TIER_LAYOUTS', 'makeRng']);
    const L = api.TIER_LAYOUTS[5];
    const rng = api.makeRng(11);
    const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
    const counts = new Set();
    // Ample panels, and scarce ones where groups must be large to reach the
    // seed minimum. These are seed halves; twins double them.
    for (const avail of [{tracked: 4, front: 6, back: 3}, {tracked: 2, front: 3, back: 2}]) {
        const sizes = {tracked: [], decoy: [], back: []};
        for (let i = 0; i < 3000; i++) {
            const layout = api.drawClusterLayout(L, rng, avail);
            // Front dots are twinned; expert back dots are not.
            const total = 2 * [...layout.tracked, ...layout.decoyGroups].reduce((a, b) => a + b, 0)
                + (L.twinBack ? 2 : 1) * layout.backGroups.reduce((a, b) => a + b, 0);
            expect(total).toBeGreaterThanOrEqual(L.points[0]);
            expect(total).toBeLessThanOrEqual(L.points[1]);
            expect(layout.backGroups.length).toBeGreaterThanOrEqual(1);
            sizes.tracked.push(...layout.tracked);
            sizes.decoy.push(...layout.decoyGroups);
            sizes.back.push(...layout.backGroups);
            counts.add(`${layout.tracked.length}/${layout.decoyGroups.length}/${layout.backGroups.length}`);
        }
        // Twinned front and back groups share one size distribution. Expert
        // back groups are untwinned, and so already tell themselves apart.
        if (L.twinBack) expect(Math.abs(mean([...sizes.tracked, ...sizes.decoy]) - mean(sizes.back))).toBeLessThan(.15);
        // Anchored groups are drawn in proportion to size, so they run larger.
        expect(mean(sizes.tracked)).toBeGreaterThan(mean(sizes.decoy));
        for (const size of [1, 2, 3, 4]) {
            expect(sizes.tracked.includes(size) && sizes.decoy.includes(size) && sizes.back.includes(size)).toBe(true);
        }
    }
    expect(counts.size).toBeGreaterThanOrEqual(6);
    const again = (seed) => api.drawClusterLayout(L, api.makeRng(seed), {tracked: 4, front: 6, back: 3});
    expect(again(5)).toEqual(again(5));
    // No anchor panel, no back panel for expert, or no front panel means no layout.
    expect(api.drawClusterLayout(L, api.makeRng(1), {tracked: 0, front: 6, back: 3})).toBeNull();
    expect(api.drawClusterLayout(L, api.makeRng(1), {tracked: 2, front: 4, back: 0})).toBeNull();
    expect(api.drawClusterLayout(api.TIER_LAYOUTS[3], api.makeRng(1), {tracked: 1, front: 0, back: 3})).toBeNull();
});

test('barycentric samples respect the floor and spread toward edges when alpha is below one', () => {
    const api = loadModule('presetGenerator.js', 'initPresetGenerator', ['sampleBarycentric', 'makeRng']);
    const meanMin = alpha => {
        const rng = api.makeRng(3);
        let sum = 0;
        for (let i = 0; i < 1500; i++) {
            const b = api.sampleBarycentric(rng, alpha, .03);
            expect(Math.min(b.u, b.v, b.w)).toBeGreaterThanOrEqual(.03);
            expect(Math.abs(b.u + b.v + b.w - 1)).toBeLessThan(.0015);
            sum += Math.min(b.u, b.v, b.w);
        }
        return sum / 1500;
    };
    expect(meanMin(.5)).toBeLessThan(meanMin(1) - .02);
});

test('expert output keeps a distinct difficulty label', () => {
    const api=loadModule('benchmark.js','initBenchmark',['difficultyLabelForTier']);
    expect(api.difficultyLabelForTier(4)).toBe('hard');
    expect(api.difficultyLabelForTier(5)).toBe('expert');
});


test('expert scan early stopping counts only trajectories with readable point pools', () => {
    const api = loadModule('benchmark.js','initBenchmark',['hasRequiredPointPools']);
    const required = {visibleFront:2, finalFront:2, finalBack:2, minQuality:.3};
    const state = {visibleFaceIds:[0,1,2,3], qualities:{0:.8,1:.7,2:.6,3:.5}, backSideVisibleFaceIds:[6,7], backQualities:{6:.7,7:.6}};
    expect(api.hasRequiredPointPools([state,state], required)).toBe(true);
    expect(api.hasRequiredPointPools([state,{...state,backQualities:{6:.7,7:.1}}],required)).toBe(false);
    expect(api.hasRequiredPointPools([state,{...state,visibleFaceIds:[0]}],required)).toBe(false);
    expect(api.hasRequiredPointPools([{...state,visibleFaceIds:[0]},state],required)).toBe(false);
    expect(api.hasRequiredPointPools([],undefined)).toBe(true);
});


test('expert point ordering varies the answer labels reproducibly across seeds', () => {
    const {points,preset} = expertFixture();
    const answers = new Set();
    function make(seed) {
        return expertApi.createPresetFromProgression({steps:preset.steps},points,{
            difficulty:5,modelFaceCount:8,rng:expertApi.makeRng(seed)
        });
    }
    for (let seed=1;seed<=64;seed++) {
        const p=make(seed);
        const labels=p.facePoints.flatMap((point,i)=>point.hidden?[]:[String.fromCharCode(65+i)]);
        answers.add(labels.join(','));
    }
    expect(answers.size).toBeGreaterThanOrEqual(10);
    expect(make(42)).toEqual(make(42));
});

test('face diversity uses face IDs when expert points have shuffled array order', () => {
    const api=loadModule('presetGenerator.js','initPresetGenerator',['faceSetJaccard']);
    expect(api.faceSetJaccard([{faceId:3},{faceId:7}],[{faceId:7},{faceId:3}])).toBe(0);
    expect(api.faceSetJaccard([{faceId:3},{faceId:7}],[{faceId:2},{faceId:4}])).toBe(1);
});

test('expert labels do not repeat across every model when the seed is shared', () => {
    const {points,preset}=expertFixture();
    const answers=new Set(['/Bases/birdBase.svg','/Bases/waterbombBase.svg','/Bases/pinwheelBase.svg'].map(model=>{
        const p=expertApi.createPresetFromProgression({steps:preset.steps},points,{
            difficulty:5,model,modelFaceCount:8,rng:expertApi.makeRng(42)
        });
        return p.facePoints.flatMap((point,i)=>point.hidden?[]:[String.fromCharCode(65+i)]).join(',');
    }));
    expect(answers.size).toBeGreaterThan(1);
});

test('expert refinement varies placements by seed and keeps a paired distractor readable', async () => {
    let globals;
    const points = loadModule('facePoints.js', 'initFacePoints', [], THREE => {
        const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, .1, 10);
        camera.position.set(0, 0, 5); camera.lookAt(new THREE.Vector3()); camera.updateMatrixWorld(true);
        camera.matrixWorldInverse.getInverse(camera.matrixWorld);
        globals = {
            model: { getFaces: () => [[0,1,2]], getPositionsArray: () => [-1.8,-1.8,0, 1.8,-1.8,0, 0,1.8,0], reset() {} },
            threeView: { camera, modelWrapper: new THREE.Object3D(), renderer: { domElement: { width: 1024, height: 1024 } }, resetModel() {} },
            setCreasePercent() {}
        };
        return globals;
    });
    globals.facePoints = points;
    const bench = loadModule('benchmark.js', 'initBenchmark', [], globals);
    globals.benchmark = { applySettings: p => points.initFromConfig(p.facePoints), getPointScreenPosition: bench.getPointScreenPosition };
    const api = loadModule('presetGenerator.js', 'initPresetGenerator', ['refineFacePointBarycentric'], globals);
    async function refine(seed) {
        const preset = { difficulty: 5, requirePointClearance: true, minPointViewQuality: .3, minPointSeparationPx: 50, pointRadius: .018,
            trackingEvalMode: 'finalStepOnly', steps: [{fold: 0}], facePoints: [
                {faceId: 0, u: .3, v: .3, w: .4}, {faceId: 0, u: .6, v: .2, w: .2, hidden: true}
            ] };
        await new Promise(resolve => api.refineFacePointBarycentric(preset, 1, api.makeRng(seed), resolve));
        points.initFromConfig(preset.facePoints);
        const [a,b] = [0,1].map(i => bench.getPointScreenPosition(i));
        return { points: preset.facePoints, distance: Math.hypot(a.x-b.x, a.y-b.y) };
    }
    const a = await refine(41), b = await refine(41), c = await refine(917);
    expect(a).toEqual(b);
    expect(a.points).not.toEqual(c.points);
    // Spacing floor, and within validation's group spread of the pair's midpoint.
    for (const {distance} of [a, c]) {
        expect(distance).toBeGreaterThanOrEqual(50);
        expect(distance / 2).toBeLessThanOrEqual(125);
    }
});

test('expert refinement groups each anchor with its decoys without making it the middle dot', async () => {
    let globals;
    const points = loadModule('facePoints.js', 'initFacePoints', [], THREE => {
        const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, .1, 10);
        camera.position.set(0, 0, 5); camera.lookAt(new THREE.Vector3()); camera.updateMatrixWorld(true);
        camera.matrixWorldInverse.getInverse(camera.matrixWorld);
        globals = {
            model: { getFaces: () => [[0,1,2]], getPositionsArray: () => [-1.8,-1.8,0, 1.8,-1.8,0, 0,1.8,0], reset() {} },
            threeView: { camera, modelWrapper: new THREE.Object3D(), renderer: { domElement: { width: 1024, height: 1024 } }, resetModel() {} },
            setCreasePercent() {}
        };
        return globals;
    });
    globals.facePoints = points;
    const bench = loadModule('benchmark.js', 'initBenchmark', [], globals);
    globals.benchmark = { applySettings: p => points.initFromConfig(p.facePoints), getPointScreenPosition: bench.getPointScreenPosition };
    const api = loadModule('presetGenerator.js', 'initPresetGenerator', ['refineFacePointBarycentric'], globals);
    const start = {faceId: 0, u: .34, v: .33, w: .33};
    let anchorIsMiddle = 0;
    const seeds = 16;
    for (let seed = 1; seed <= seeds; seed++) {
        const preset = { difficulty: 5, requirePointClearance: true, minPointViewQuality: .3, minPointSeparationPx: 50, pointRadius: .018,
            trackingEvalMode: 'finalStepOnly', steps: [{fold: 0}],
            facePoints: [start, {...start, hidden: true}, {...start, hidden: true}, {...start, hidden: true}] };
        await new Promise(resolve => api.refineFacePointBarycentric(preset, 1, api.makeRng(seed), resolve));
        points.initFromConfig(preset.facePoints);
        const at = [0,1,2,3].map(i => bench.getPointScreenPosition(i));
        const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
        const cx = at.reduce((s, p) => s + p.x, 0) / 4, cy = at.reduce((s, p) => s + p.y, 0) / 4;
        for (const p of at) expect(Math.hypot(p.x - cx, p.y - cy)).toBeLessThanOrEqual(125);
        for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) expect(d(at[i], at[j])).toBeGreaterThanOrEqual(50);
        const middle = [0,1,2,3].reduce((best, i) => {
            const sum = at.reduce((s, p) => s + d(at[i], p), 0);
            return sum < best.sum ? {i, sum} : best;
        }, {i: -1, sum: Infinity}).i;
        if (middle === 0) anchorIsMiddle++;
    }
    // Exchangeable groups make the anchor the middle dot about 1 time in 4.
    // Packing decoys around the anchor made it the middle dot every time.
    expect(anchorIsMiddle).toBeLessThanOrEqual(9);
}, 60000);

// ── Re-point pass: harvesting more placements from one trajectory ──────
//
// selectFacePointsFromTrajectory enumerates every valid (visible-front pair,
// hidden-back pair) combination into a pool, then keeps only K. K was pinned
// at 2, so repeat jobs on the same trajectory re-derived the same pool and
// re-shipped pool[0] — the reason all 44 banked opensink presets share one
// face set. configsPerTrajectory lifts K so a single Phase 2 evaluation can
// yield the combinations that were being computed and discarded.
const selector = loadModule('presetGenerator.js', 'initPresetGenerator',
    ['selectFacePointsFromTrajectory', 'selectFromTrajectoryK', 'makeRng']);

// 20 faces; a 180-degree turn maps f to f+10 (mod 20). Front faces 0-3 and
// their twins 10-13 stay readable, and back faces 4, 5, 14, 15 are exposed:
// four front pairs and two back pairs.
const TABLE20 = Array.from({length: 20}, (_, f) => (f + 10) % 20);
function trajectoryFixture() {
    const ids = [0, 1, 2, 3, 10, 11, 12, 13];
    const front = { visibleFaceIds: ids, qualities: Object.fromEntries(ids.map(f => [f, .9])) };
    const final = { ...front, backSideVisibleFaceIds: [4, 5, 14, 15], backQualities: { 4: .9, 5: .9, 14: .9, 15: .9 } };
    return { visibilityTimeline: [front, final] };
}

function configsFor(opts) {
    return selector.selectFacePointsFromTrajectory(trajectoryFixture(), 5, 20, [0, 1, 2, 3, 10, 11, 12, 13], [],
        selector.makeRng(7), '/Bases/opensinkBase.svg', .3, {...(opts || {}), twinRotations: [{name: 'rotate180', faces: TABLE20}]});
}
const twin20 = f => f < 20 ? TABLE20[f] : TABLE20[f - 20] + 20;

test('per-trajectory config count defaults to todays behaviour', () => {
    expect(selector.selectFromTrajectoryK(1)).toBe(1);
    expect(selector.selectFromTrajectoryK(5)).toBe(2);
    expect(configsFor(undefined)).toHaveLength(2);
});

test('configsPerTrajectory harvests pooled face combinations beyond K=2', () => {
    expect(selector.selectFromTrajectoryK(5, { configsPerTrajectory: 8 })).toBe(8);
    const configs = configsFor({ configsPerTrajectory: 8 });
    expect(configs).toHaveLength(8);

    // Every config must be a distinct layout (panels, their dot counts and
    // which hold anchors), not the same panels with the dots nudged; that
    // distinction is the whole point of the pass.
    const signatures = configs.map(c => JSON.stringify(Object.entries(c.facePoints)
        .map(([f, pts]) => [f, pts.length, pts.some(p => !p.hidden)]).sort()));
    expect(new Set(signatures).size).toBe(8);

    // Each still meets the d5 layout ranges.
    for (const c of configs) expectClusterConfig(c, 20, EXPERT_RANGES, twin20);
});

test('configsPerTrajectory never pads with repeated layouts', () => {
    const configs = configsFor({ configsPerTrajectory: 50 });
    expect(configs.length).toBeLessThanOrEqual(50);
    expect(configs.length).toBeGreaterThan(8);
    const signatures = configs.map(c => JSON.stringify(Object.entries(c.facePoints).map(([f, pts]) => [f, pts.length, pts.some(p => !p.hidden)]).sort()));
    expect(new Set(signatures).size).toBe(configs.length);
});

const repoint = loadModule('presetGenerator.js', 'initPresetGenerator', ['trajectoryFromSteps']);

test('a banked preset splits back into the candidate and profile phase 2 consumes', () => {
    const steps = [
        { fold: 0, pov: [.5, .8, .3] },
        { fold: 35, pov: [.5, .8, .3], rotation: [.1, .2, .3] },
        { fold: 70, pov: [.5, .8, .3], rotation: [.4, .5, .6] },
    ];
    const { candidate, profile } = repoint.trajectoryFromSteps(steps);

    // Phase 2 reads only fold + pov off a candidate step (benchmark.js:2750).
    expect(candidate).toEqual([
        { fold: 0, pov: [.5, .8, .3] },
        { fold: 35, pov: [.5, .8, .3] },
        { fold: 70, pov: [.5, .8, .3] }]);
    // State 1 is the zero-rotation hero shot, so a missing rotation is [0,0,0].
    expect(profile.rotations).toEqual([[0, 0, 0], [.1, .2, .3], [.4, .5, .6]]);

    // Copies, not aliases: the evaluated trajectory must stay bit-identical to
    // the banked one, so nothing downstream may mutate the bank's arrays.
    profile.rotations[1][0] = 9;
    candidate[1].pov[0] = 9;
    expect(steps[1].rotation[0]).toBe(.1);
    expect(steps[1].pov[0]).toBe(.5);
});

test('phase 2 replays the banked rotation the re-point pass hands it', () => {
    const steps = [0, 35, 70].map((fold, i) => ({ fold, pov: [.5, .8, .3], rotation: [i * .1, i * .2, i * .3] }));
    const { candidate, profile } = repoint.trajectoryFromSteps(steps);
    const api = loadModule('benchmark.js', 'initBenchmark', ['buildAutoRotationProfiles']);
    // The form presetGenerator passes as rotationProfiles when re-pointing.
    const parsed = api.buildAutoRotationProfiles(candidate, { difficulty: 5, rotationProfiles: [profile.rotations] });
    expect(parsed).toHaveLength(1);
    expect(parsed[0].rotations.map(r => [r.x, r.y, r.z])).toEqual(profile.rotations);
    const source = readFileSync(new URL('../js/presetGenerator.js', import.meta.url), 'utf8');
    expect(source).toContain('rotationProfiles: repointTrajectory ? [repointTrajectory.profile.rotations]');
});

test('arrow labels switch lanes so leader lines do not cross other dots', () => {
    const api = loadModule('pointAnnotations.js', 'initPointAnnotations', ['arrangeLabels']);
    // Final-frame anchors from a rendered expert bird preset: B, H and E sit
    // in one row, so the centroid split drew B's line through H and E.
    const anchors = {B:[672,264], H:[750,265], E:[828,266], J:[697,336], G:[425,473],
        D:[475,540], A:[546,558], F:[408,580], I:[695,509], C:[668,688]};
    const items = Object.entries(anchors).map(([label, [x, y]]) => ({label, anchorX: x, anchorY: y, labelY: y}));
    const layout = api.arrangeLabels(items, 1280, 960, 960 / 900);
    const crossed = [];
    for (const item of items) {
        const fromX = item.side === 'left' ? layout.laneLeftX : layout.laneRightX;
        const [ax, ay, bx, by] = [fromX, item.labelY, item.anchorX, item.anchorY];
        for (const other of items) {
            if (other === item) continue;
            const len2 = (bx-ax)**2 + (by-ay)**2;
            const t = Math.max(0, Math.min(1, ((other.anchorX-ax)*(bx-ax) + (other.anchorY-ay)*(by-ay)) / len2));
            if (Math.hypot(other.anchorX - (ax + t*(bx-ax)), other.anchorY - (ay + t*(by-ay))) < 14 * 960 / 900) crossed.push(item.label + '>' + other.label);
        }
    }
    // Leader lines must not cross each other either.
    const segs = items.map(it => [[it.side === 'left' ? layout.laneLeftX : layout.laneRightX, it.labelY], [it.anchorX, it.anchorY]]);
    const orient = (p, q, r) => (q[0]-p[0])*(r[1]-p[1]) - (q[1]-p[1])*(r[0]-p[0]);
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
        const [a, b] = [segs[i], segs[j]];
        if (orient(b[0], b[1], a[0]) * orient(b[0], b[1], a[1]) < 0 && orient(a[0], a[1], b[0]) * orient(a[0], a[1], b[1]) < 0)
            crossed.push(items[i].label + 'x' + items[j].label);
    }
    expect(crossed).toEqual([]);
    expect(layout.leftItems.length + layout.rightItems.length).toBe(10);
    expect([layout.dotCrossings, layout.lineCrossings]).toEqual([0, 0]);
});

test('left-lane labels start below the step caption', () => {
    const api = loadModule('pointAnnotations.js', 'initPointAnnotations', ['arrangeLabels']);
    // Twelve dots on the left near the top: the lane would start them at the
    // top margin, under the "STATE N" caption (72 px tall at pixel ratio 1).
    const items = Array.from({length: 12}, (_, i) => ({label: String.fromCharCode(65 + i),
        anchorX: 300 + 10 * i, anchorY: 40 + 20 * i, labelY: 40 + 20 * i}));
    const layout = api.arrangeLabels(items, 1280, 960, 960 / 900);
    expect(layout.leftItems.length).toBeGreaterThan(0);
    for (const item of layout.leftItems) expect(item.labelY).toBeGreaterThanOrEqual(72 + 14 * 960 / 900);
});

test('label layout reports a leader line it cannot route around a dot', () => {
    const api = loadModule('pointAnnotations.js', 'initPointAnnotations', ['arrangeLabels']);
    // A dot boxed in on every side: each lane's line to it passes over a neighbour.
    const anchors = [[640,480], [560,480], [720,480], [640,440], [640,520], [600,450], [680,450], [600,510], [680,510]];
    const items = anchors.map(([x, y], i) => ({label: String.fromCharCode(65 + i), anchorX: x, anchorY: y, labelY: y}));
    const layout = api.arrangeLabels(items, 1280, 960, 960 / 900);
    expect(layout.dotCrossings).toBeGreaterThan(0);
});

test('a run can set clustered dot totals for its own generation and validation', () => {
    const api = loadModule('presetGenerator.js', 'initPresetGenerator', ['clusterLayout', 'drawClusterLayout', 'setClusterPoints', 'makeRng']);
    // Panels only for the minimum: two twin pairs at the front, two back panels.
    for (const [tier, total, avail] of [[3, 16, {tracked: 2, front: 2, back: 0}], [5, 20, {tracked: 2, front: 2, back: 2}]]) {
        api.setClusterPoints([total, total]);
        const L = api.clusterLayout(tier);
        expect(Array.from(L.points)).toEqual([total, total]);
        const rng = api.makeRng(tier);
        for (let i = 0; i < 20; i++) {
            const layout = api.drawClusterLayout(L, rng, avail);
            expect(layout).not.toBeNull();
            const front = [...layout.tracked, ...layout.decoyGroups].reduce((a, b) => a + b, 0);
            const back = layout.backGroups.reduce((a, b) => a + b, 0);
            expect(2 * front + (L.twinBack ? 2 : 1) * back).toBe(total);
        }
    }
    api.setClusterPoints(null);
    expect(Array.from(api.clusterLayout(3).points)).toEqual([10, 14]);
});

test('scatter dots join the anchor draw as groups of one, so every front dot is equally likely an answer', () => {
    const api = loadModule('presetGenerator.js', 'initPresetGenerator',
        ['clusterLayout', 'drawClusterLayout', 'setClusterPoints', 'setClusterScatter', 'makeRng']);
    api.setClusterPoints([16, 16]);
    api.setClusterScatter([2, 3]);
    const L = api.clusterLayout(3), rng = api.makeRng(11);
    let scatterRate = 0, groupRate = 0, runs = 4000, loneAnswers = 0;
    for (let i = 0; i < runs; i++) {
        const layout = api.drawClusterLayout(L, rng, {tracked: 3, front: 4, back: 0});
        const groupDots = [...layout.tracked, ...layout.decoyGroups].reduce((a, b) => a + b, 0);
        expect(2 * (groupDots + layout.scatter)).toBe(16);
        expect(layout.scatter).toBeGreaterThanOrEqual(2);
        expect(layout.tracked.length + layout.trackedScatter).toBeGreaterThanOrEqual(2);
        expect(layout.tracked.length + layout.trackedScatter).toBeLessThanOrEqual(3);
        scatterRate += layout.trackedScatter / layout.scatter;
        groupRate += layout.tracked.length / groupDots;
        loneAnswers += layout.trackedScatter > 0;
    }
    expect(Math.abs(scatterRate / runs - groupRate / runs)).toBeLessThan(.03);
    expect(loneAnswers / runs).toBeGreaterThan(.3);
});

test('a group size override keeps a decoy beside every grouped dot', () => {
    const api = loadModule('presetGenerator.js', 'initPresetGenerator',
        ['clusterLayout', 'drawClusterLayout', 'setClusterPoints', 'setClusterScatter', 'setClusterGroupSize', 'makeRng']);
    api.setClusterPoints([20, 20]);
    api.setClusterScatter([3, 5]);
    api.setClusterGroupSize([2, 4]);
    const L = api.clusterLayout(3), rng = api.makeRng(4);
    expect(Array.from(L.groupSize)).toEqual([2, 4]);
    for (let i = 0; i < 200; i++) {
        const layout = api.drawClusterLayout(L, rng, {tracked: 3, front: 4, back: 0});
        expect(layout).not.toBeNull();
        for (const size of [...layout.tracked, ...layout.decoyGroups]) expect(size).toBeGreaterThanOrEqual(2);
    }
    api.setClusterGroupSize(null);
    expect(Array.from(api.clusterLayout(3).groupSize)).toEqual([1, 4]);
});

test('a back-group override of 0,0 makes front-only expert layouts and search', () => {
    const api = loadModule('presetGenerator.js', 'initPresetGenerator',
        ['clusterLayout', 'drawClusterLayout', 'setClusterPoints', 'setClusterScatter', 'setClusterBackGroups', 'matchesDifficultySideConfig', 'makeRng']);
    api.setClusterPoints([18, 20]);
    api.setClusterScatter([3, 5]);
    api.setClusterBackGroups([0, 0]);
    const L = api.clusterLayout(5), rng = api.makeRng(8);
    expect(Array.from(L.backGroups)).toEqual([0, 0]);
    expect(L.searchPools.finalBack).toBe(0);
    for (let i = 0; i < 100; i++) {
        // A 180-degree base's final frame: no readable back panels.
        const layout = api.drawClusterLayout(L, rng, {tracked: 2, front: 3, back: 0});
        expect(layout).not.toBeNull();
        expect(layout.backGroups).toHaveLength(0);
    }
    // The side filter keeps front-only expert presets under the override.
    const frontOnly = [{faceId: 0, u: .3, v: .3, w: .4}, {faceId: 1, u: .3, v: .3, w: .4, hidden: true}];
    const withBack = [...frontOnly, {faceId: 9, u: .3, v: .3, w: .4, hidden: true}];
    expect(api.matchesDifficultySideConfig(frontOnly, 5, 8)).toBe(true);
    api.setClusterBackGroups(null);
    expect(api.matchesDifficultySideConfig(frontOnly, 5, 8)).toBe(false);
    expect(api.matchesDifficultySideConfig(withBack, 5, 8)).toBe(true);
    expect(Array.from(api.clusterLayout(5).backGroups)).toEqual([1, 2]);
    expect(api.clusterLayout(5).searchPools.finalBack).toBe(2);
});

test('scatter configs twin every scatter dot and start it on the group it surrounds', () => {
    const api = loadModule('presetGenerator.js', 'initPresetGenerator',
        ['selectFacePointsFromTrajectory', 'setClusterPoints', 'setClusterScatter', 'makeRng']);
    api.setClusterPoints([16, 16]);
    api.setClusterScatter([2, 3]);
    const ids = [0, 1, 2, 4, 5, 6];
    const state = {fold:0, visibleFaceIds:ids, qualities:Object.fromEntries(ids.map(f => [f, .8])), backSideVisibleFaceIds:[], backQualities:{}};
    let configs = 0;
    for (let seed = 1; seed <= 12; seed++) {
        for (const config of api.selectFacePointsFromTrajectory({visibilityTimeline:[state,state]},3,8,ids,[],api.makeRng(seed),
                '/Bases/birdBase.svg',.3,{twinRotations: ROTATIONS8})) {
            configs++;
            const all = Object.entries(config.facePoints).flatMap(([face, pts]) => pts.map(p => ({...p, faceId: Number(face)})));
            expect(all).toHaveLength(16);
            const scatter = all.filter(p => p.scatter && !p.twin);
            expect(scatter.length).toBe(config.layout.scatter);
            expect(scatter.length).toBeGreaterThanOrEqual(2);
            for (const p of scatter) {
                expect(p.faceId).toBe(p.near);
                expect(all.some(q => !q.scatter && !q.twin && q.faceId === p.near)).toBe(true);
                const twins = all.filter(q => q.twin && q.pair === p.pair);
                expect(twins).toHaveLength(1);
                expect(twins[0].scatter && twins[0].hidden).toBe(true);
                expect(twins[0].faceId).toBe(twin8(p.near));
            }
            const anchors = all.filter(p => !p.hidden).length;
            expect(anchors).toBeGreaterThanOrEqual(2);
            expect(anchors).toBeLessThanOrEqual(3);
            expect(scatter.filter(p => !p.hidden)).toHaveLength(config.layout.trackedScatter);
        }
    }
    expect(configs).toBeGreaterThan(0);
});

test('scatter candidates spread over the sheet in proportion to face area', () => {
    const api = loadModule('presetGenerator.js', 'initPresetGenerator', ['areaSampleCounts']);
    // A unit square split into a big and a small triangle, plus a sliver.
    const xy = [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5], [0, 0.001]];
    const faces = [[0, 1, 2], [2, 3, 4], [0, 4, 5]];
    const counts = Array.from(api.areaSampleCounts(faces, xy, 300));
    // Areas 0.5, 0.25 and about 0.00025.
    expect(counts[0]).toBe(200);
    expect(counts[1]).toBe(100);
    // Every face keeps at least one candidate.
    expect(counts[2]).toBe(1);
});

test('the contract counts scatter dots apart from groups', () => {
    const api = loadModule('presetGenerator.js', 'initPresetGenerator',
        ['createPresetFromProgression', 'clusterPresetFailures', 'foldLadderForDifficulty', 'setClusterScatter', 'makeRng']);
    api.setClusterScatter([1, 2]);
    // A tracked group of three and a decoy pair, plus two scatter dots that
    // landed on the tracked panel and on an unused one (one is an anchor).
    const scatter = (faceId, hidden = true) => ({...dot(faceId, hidden), scatter: true, near: 0});
    const seeds = [dot(0, false), dot(0), dot(0), dot(1), dot(1), scatter(0), scatter(2, false)];
    const points = withTwins(seeds).map(p => p.twin && seeds[p.pair].scatter ? {...p, scatter: true} : p);
    const steps = api.foldLadderForDifficulty(3, 70).map((fold, i) => ({fold, pov: [.5,.8,.3], rotation: [.3*i/9, .6*i/9, .1*i/9]}));
    const preset = api.createPresetFromProgression({steps}, points, {
        difficulty: 3, rng: api.makeRng(7), modelFaceCount: 8, colors: ['0077cc','00538f'], twinSymmetry: 'rotate180'
    });
    expect(api.clusterPresetFailures(preset, points, 8)).toEqual([]);
    // A scatter dot whose twin is not marked scatter breaks the pairing rule.
    const unmarked = points.map(p => p.twin && p.pair === 6 ? {...p, scatter: false} : p);
    expect(api.clusterPresetFailures(preset, unmarked, 8).length).toBeGreaterThan(0);
    // Too many scatter dots for the run's range.
    const extra = withTwins([...seeds, scatter(5), scatter(6)]).map(p => p.twin && [...seeds, scatter(5), scatter(6)][p.pair].scatter ? {...p, scatter: true} : p);
    expect(api.clusterPresetFailures(preset, extra, 8).length).toBeGreaterThan(0);
});

test('a wider medium spin turns further but never more than 0.6 rad between frames', () => {
    const api = loadModule('presetGenerator.js', 'initPresetGenerator', ['spinProfiles', 'maxPlaneStep', 'makeRng']);
    // Ten frames with a small ramp in pitch, as medium's ramp profiles have.
    const base = Array.from({length: 400}, () => Array.from({length: 10}, (_, i) => [0.3 * i / 9, 0, 0.1 * i / 9]));
    const half = api.spinProfiles(base, api.makeRng(1), null);
    const wide = api.spinProfiles(base, api.makeRng(1), null, 1.5 * Math.PI);
    const last = profiles => profiles.map(p => Math.abs(p[p.length - 1][1]));
    expect(Math.max(...last(half))).toBeLessThanOrEqual(Math.PI + 1e-3);
    expect(Math.max(...last(wide))).toBeGreaterThan(Math.PI);
    expect(Math.max(...last(wide))).toBeLessThanOrEqual(1.5 * Math.PI + 1e-3);
    for (const profile of [...half, ...wide]) expect(api.maxPlaneStep(profile)).toBeLessThanOrEqual(0.6);
    // Too wide a spin breaks the step cap, so those profiles are dropped.
    expect(api.spinProfiles(base, api.makeRng(1), null, 3 * Math.PI).length).toBeLessThan(base.length);
});

test('end sizes give every dot its own last-image size, and the contract checks them', () => {
    const api = loadModule('presetGenerator.js', 'initPresetGenerator',
        ['createPresetFromProgression', 'clusterPresetFailures', 'foldLadderForDifficulty', 'markerClearanceRadius', 'makeRng']);
    const seeds = [dot(0, false), dot(0), dot(0), dot(1), dot(1), dot(2, false), dot(2)];
    const points = withTwins(seeds);
    const steps = api.foldLadderForDifficulty(3, 70).map((fold, i) => ({fold, pov: [.5,.8,.3], rotation: [.3*i/9, .6*i/9, .1*i/9]}));
    const make = extra => api.createPresetFromProgression({steps}, points.map(p => ({...p})), {
        difficulty: 3, rng: api.makeRng(7), modelFaceCount: 8, colors: ['0077cc','00538f'], twinSymmetry: 'rotate180', ...extra});
    const plain = make({});
    expect(plain.endDotSizes).toBeUndefined();
    expect(plain.facePoints.every(p => p.endScale === undefined)).toBe(true);
    const sized = make({clusterEndSizes: [.75, 1.25]});
    expect(Array.from(sized.endDotSizes)).toEqual([.75, 1.25]);
    const scales = sized.facePoints.map(p => p.endScale);
    expect(scales.every(s => s >= .75 && s <= 1.25)).toBe(true);
    expect(new Set(scales).size).toBeGreaterThan(3);
    expect(api.clusterPresetFailures(sized, sized.facePoints, 8)).toEqual([]);
    const unsized = sized.facePoints.map((p, i) => i === 0 ? {...p, endScale: undefined} : p);
    expect(api.clusterPresetFailures(sized, unsized, 8).length).toBeGreaterThan(0);
    // The footprint check covers the largest end size.
    expect(api.markerClearanceRadius(sized) / api.markerClearanceRadius(plain)).toBeCloseTo(1.25);
});

test('leader arrows stop at the dot edge along their own direction', () => {
    const api = loadModule('pointAnnotations.js', 'initPointAnnotations', ['dotReach']);
    // A dot foreshortened to a 12 x 4 px ellipse.
    const rim = Array.from({length: 16}, (_, k) => [6 * Math.cos(k * Math.PI / 8), 2 * Math.sin(k * Math.PI / 8)]);
    expect(api.dotReach({rim}, 1, 0, 1)).toBeCloseTo(6);
    // Across the thin axis the overlay disc (4 px) sets the reach.
    expect(api.dotReach({rim}, 0, 1, 1)).toBe(4);
    expect(api.dotReach({}, 1, 0, 1.2)).toBeCloseTo(4.8);
});

test('question templates describe large rotations and dot-free middle images', () => {
    const api = loadModule('benchmark.js', 'initBenchmark', ['JSONL_QUESTION_TEMPLATE', 'JSONL_QUESTION_TEMPLATE_REVERSE']);
    for (const template of [api.JSONL_QUESTION_TEMPLATE, api.JSONL_QUESTION_TEMPLATE_REVERSE]) {
        // Expert frames turn up to ~0.9 rad each; "rotating slowly" was false.
        expect(template).not.toContain('slowly');
        expect(template).toContain('sometimes by a large angle');
        expect(template).toContain('{dots_shown}');
        expect(template).toContain('{dots_shown}{dot_sizes}');
    }
});

test('medium point selection draws the shared layout and stays on the front', () => {
    const ids = [0, 1, 2, 4, 5, 6];
    const state = {fold:0, visibleFaceIds:ids, qualities:Object.fromEntries(ids.map(f => [f, .8])), backSideVisibleFaceIds:[3,7], backQualities:{3:.8,7:.7}};
    const layouts = new Set();
    for (let seed = 1; seed <= 12; seed++) {
        const configs = expertApi.selectFacePointsFromTrajectory({visibilityTimeline:[state,state]},3,8,ids,[3,7],expertApi.makeRng(seed),'/Bases/birdBase.svg',.3,{twinRotations: ROTATIONS8});
        expect(configs.length).toBeGreaterThan(0);
        for (const config of configs) {
            expectClusterConfig(config, 8, MEDIUM_RANGES);
            layouts.add(Object.values(config.facePoints).map(pts => pts.length).sort().join(','));
        }
    }
    expect(layouts.size).toBeGreaterThan(2);
});

test('validation checks pairs on the preset, not on the loaded points that drop them', () => {
    const points = withTwins([dot(0, false), dot(0), dot(1, false), dot(1), dot(2)]);
    const steps = expertApi.foldLadderForDifficulty(3, 70).map((fold, i) => ({fold, pov: [.5,.8,.3], rotation: [.3*i/9, .6*i/9, .1*i/9]}));
    const preset = expertApi.createPresetFromProgression({steps}, points, {
        difficulty: 3, rng: expertApi.makeRng(7), modelFaceCount: 8, colors: ['0077cc','00538f'], twinSymmetry: 'rotate180'
    });
    let folds = 0;
    const globals = {
        // The first fold change resets the baseline; the second starts the step walk.
        setCreasePercent() { if (++folds > 1) throw new Error('reached steps'); },
        model: { getFaces: () => Array.from({length: 8}, () => [0, 1, 2]), setMeshMaterial() {} },
        threeView: { resetModel() {} },
        // Loaded points keep face, position and hidden only.
        facePoints: { getPoints: () => preset.facePoints.map(({faceId, u, v, w, hidden}) => ({faceId, u, v, w, hidden})),
                      initFromConfig() {}, clearPoints() {} }
    };
    const api = loadModule('presetGenerator.js', 'initPresetGenerator', ['validatePreset'], globals);
    const reached = bad => {
        let result = null;
        try { api.validatePreset(bad, 1, r => { result = r; }); } catch (e) { if (e.message !== 'reached steps') throw e; return true; }
        return result;
    };
    expect(reached(preset)).toBe(true);
    folds = 0;
    const unpaired = {...preset, facePoints: preset.facePoints.map(({pair, twin, ...rest}) => rest)};
    expect(reached(unpaired).failures.length).toBeGreaterThan(0);
});

test('medium assembly keeps its ramp but uses expert-style markers', () => {
    const points = withTwins([dot(0, false), dot(0), dot(1, false), dot(1), dot(2)]);
    const ladder = expertApi.foldLadderForDifficulty(3, 70);
    expect(ladder).toHaveLength(10);
    const steps = ladder.map((fold, i) => ({fold, pov: [.5,.8,.3], rotation: [.3*i/9, .6*i/9, .1*i/9]}));
    const preset = expertApi.createPresetFromProgression({steps}, points, {
        difficulty: 3, rng: expertApi.makeRng(7), modelFaceCount: 8, colors: ['0077cc','00538f'], twinSymmetry: 'rotate180'
    });
    expect(preset.color1).toBe(preset.color2);
    expect(preset.pointRadius).toBe(.018);
    expect(preset.minPointSeparationPx).toBe(50);
    expect(preset.enforceSeparationAllSteps).toBe(true);
    expect(Array.isArray(preset.facePoints)).toBe(true);
    expect(expertApi.clusterPresetFailures(preset, preset.facePoints, 8)).toEqual([]);
    // Medium has no back dots, keeps ten frames, and needs no expert motion.
    const withBack = withTwins([dot(0, false), dot(0), dot(1, false), dot(1), dot(14)]);
    expect(expertApi.clusterPresetFailures(preset, withBack, 8).length).toBeGreaterThan(0);
    expect(expertApi.clusterPresetFailures({...preset, steps: preset.steps.slice(1)}, preset.facePoints, 8).length).toBeGreaterThan(0);
    expect(expertApi.clusterPresetFailures({...preset, pointRadius: .025}, preset.facePoints, 8).length).toBeGreaterThan(0);
    expect(expertApi.clusterPresetFailures({...preset, color2: 'ffffff'}, preset.facePoints, 8).length).toBeGreaterThan(0);
    // Old medium layouts (decoys on other panels) fail the new contract.
    const oldMedium = [{faceId: 0, hidden: false}, {faceId: 1, hidden: false}, {faceId: 2, hidden: true}, {faceId: 3, hidden: true}]
        .map(p => ({...p, u: .34, v: .33, w: .33}));
    expect(expertApi.clusterPresetFailures(preset, oldMedium, 8).length).toBeGreaterThan(0);
});
