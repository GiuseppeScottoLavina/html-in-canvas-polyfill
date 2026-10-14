import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipPlanToSurface, planUpload } from '../../../src/api/texture-math.js';

/** element 100x50 css px; canvas grid scale g => ElementImage size = (100g, 50g) */
const plan = (g, config = {}, surfaceScale = 1, css = { width: 100, height: 50 }) =>
  planUpload({ width: css.width * g, height: css.height * g }, { ...css, scaleX: g, scaleY: g }, config, surfaceScale);

test('planUpload: default size is the whole element at the grid scale, surface 1:1 means no resample', () => {
  const p = plan(1);
  assert.deepEqual(p.sourceCss, { sx: 0, sy: 0, sw: 100, sh: 50 });
  assert.deepEqual([p.width, p.height, p.resample], [100, 50, false]);
});

test('planUpload: grid scale 2 with a surface raster scale of 2 is still a 1:1 copy', () => {
  const p = plan(2, {}, 2);
  assert.deepEqual([p.width, p.height, p.resample], [200, 100, false]);
});

test('planUpload: grid scale 0.5 over a DPR 2 surface resamples (200x100 surface px into 50x25 texels)', () => {
  const p = plan(0.5, {}, 2);
  assert.deepEqual([p.width, p.height, p.resample], [50, 25, true]);
});

test('planUpload: grid scale 3 above the raster cap of 2.5 resamples up', () => {
  const p = plan(3, {}, 2.5);
  assert.deepEqual([p.width, p.height, p.resample], [300, 150, true]);
});

test('planUpload: grid scale 1 over a DPR 2 surface resamples down', () => {
  assert.equal(plan(1, {}, 2).resample, true);
});

test('planUpload: fractional sizes use ceil, as the preallocation advice of issue 174', () => {
  const p = plan(1, {}, 1, { width: 100.5, height: 200.75 });
  assert.deepEqual([p.width, p.height], [101, 201]);
  assert.equal(p.resample, false, 'the surface also rounds 100.5 up to 101 px');
});

test('planUpload: floating point noise just above an integer does not add a texel', () => {
  const noisy = 0.1 * 3 * 10;
  assert.notEqual(noisy, 3, 'the premise: the product is not exactly 3');
  const p = planUpload({ width: noisy, height: 50 }, { width: 1, height: 50, scaleX: noisy, scaleY: 1 }, {}, 1);
  assert.equal(p.width, 3);
});

test('planUpload: fractional DPR 1.25, border box 100.5 => 125.625 grid px => 126 texels, surface ceil(125.625) = 126 px', () => {
  const p = plan(1.25, {}, 1.25, { width: 100.5, height: 50 });
  assert.deepEqual([p.width, p.height, p.resample], [126, 63, false]);
});

test('planUpload: config width/height override the destination and force a resample', () => {
  const p = plan(1, { width: 64, height: 32 });
  assert.deepEqual([p.width, p.height, p.resample], [64, 32, true]);
  assert.equal(plan(1, { width: 7.9 }).width, 7, 'GLsizei truncates');
});

test('planUpload: a config of the natural size is not a resample', () => {
  assert.equal(plan(1, { width: 100, height: 50 }).resample, false);
});

test('planUpload: a source sub-rect keeps the grid scale in its natural size', () => {
  const p = plan(2, { sx: 10, sy: 5, swidth: 40, sheight: 20 }, 2);
  assert.deepEqual(p.sourceCss, { sx: 10, sy: 5, sw: 40, sh: 20 });
  assert.deepEqual([p.width, p.height, p.resample], [80, 40, false]);
});

test('planUpload: a sub-rect at fractional surface positions rounds the surface rect outwards', () => {
  // x from 0.5 to 10.5 at scale 1 covers surface px floor(0.5)=0 .. ceil(10.5)=11 => 11 px; natural width ceil(10)=10 => resample
  const p = plan(1, { sx: 0.5, swidth: 10 });
  assert.deepEqual([p.width, p.resample], [10, true]);
});

test('planUpload: an empty element gives an empty plan; the scale fallback is used', () => {
  const p = planUpload({ width: 0, height: 0 }, { width: 0, height: 0, scaleX: 2, scaleY: 2 }, { swidth: 10, sheight: 5 }, 1);
  assert.deepEqual([p.width, p.height], [20, 10]);
  const empty = planUpload({ width: 0, height: 0 }, { width: 0, height: 0, scaleX: 2, scaleY: 2 }, {}, 1);
  assert.deepEqual([empty.width, empty.height], [0, 0]);
});

test('planUpload: TypeError for a non-finite member or a negative size', () => {
  assert.throws(() => plan(1, { sx: NaN }), TypeError);
  assert.throws(() => plan(1, { swidth: Infinity }), TypeError);
  assert.throws(() => plan(1, { sheight: -1 }), TypeError);
  assert.throws(() => plan(1, { width: -1 }), TypeError);
  assert.throws(() => plan(1, { width: 'abc' }), TypeError);
});

const INK = { left: 24, top: 24, right: 24, bottom: 24 };

test('clipPlanToSurface: a rect inside the surface keeps its place and is whole', () => {
  const p = plan(2, {}, 2);
  assert.deepEqual(clipPlanToSurface(p, { width: 100, height: 50, ink: INK }),
    { src: { sx: 0, sy: 0, sw: 100, sh: 50 }, dx: 0, dy: 0, dw: 200, dh: 100, whole: true });
});

test('clipPlanToSurface: a rect reaching into the ink and beyond it is clipped; the visible part stays in place', () => {
  // x from -30 .. 70 (100 css px) into 200 texels => 2 texels per css px; the first 6 css px (12 texels) have no pixels
  const p = plan(2, { sx: -30, swidth: 100, sheight: 50 }, 2);
  assert.deepEqual([p.width, p.height], [200, 100]);
  assert.deepEqual(clipPlanToSurface(p, { width: 100, height: 50, ink: INK }),
    { src: { sx: -24, sy: 0, sw: 94, sh: 50 }, dx: 12, dy: 0, dw: 188, dh: 100, whole: false });
});

test('clipPlanToSurface: nothing to copy gives null', () => {
  const far = plan(1, { sx: 500, swidth: 10, sheight: 10 });
  assert.equal(clipPlanToSurface(far, { width: 100, height: 50, ink: INK }), null);
  assert.equal(clipPlanToSurface(plan(1, { swidth: 0 }), { width: 100, height: 50, ink: INK }), null);
});
