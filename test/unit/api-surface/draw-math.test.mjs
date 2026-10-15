import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canvasTransformValues, clipToSurface, parseDrawArgs, resolveRects, snapDefaultSize, storedTransformValues,
} from '../../../src/api/draw-math.js';
import { IDENTITY16, translation16, scale16 } from '../../../src/util/matrix.js';

const close = (actual, expected, msg) => {
  assert.equal(actual.length, expected.length, msg);
  expected.forEach((v, i) => assert.ok(Math.abs(actual[i] - v) < 1e-9, `${msg ?? ''} [${i}] expected ${v}, got ${actual[i]}`));
};
const EL = { tag: 'element' };

test('parseDrawArgs: the four overloads', () => {
  let a = parseDrawArgs([EL, 10, 20]);
  assert.deepEqual([a.hasSource, a.dx, a.dy, a.dw, a.dh, a.sx], [false, 10, 20, NaN, NaN, NaN]);
  a = parseDrawArgs([EL, 10, 20, 30, 40]);
  assert.deepEqual([a.hasSource, a.dx, a.dy, a.dw, a.dh], [false, 10, 20, 30, 40]);
  a = parseDrawArgs([EL, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual([a.hasSource, a.sx, a.sy, a.sw, a.sh, a.dx, a.dy, a.dw, a.dh], [true, 1, 2, 3, 4, 5, 6, NaN, NaN]);
  a = parseDrawArgs([EL, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([a.sx, a.sy, a.sw, a.sh, a.dx, a.dy, a.dw, a.dh], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(a.target, EL);
});

test('parseDrawArgs: trailing options object, undefined options, string numbers', () => {
  assert.equal(parseDrawArgs([EL, 1, 2, { preserveElementGeometry: true }]).preserveElementGeometry, true);
  assert.equal(parseDrawArgs([EL, 1, 2, {}]).preserveElementGeometry, false);
  assert.equal(parseDrawArgs([EL, 1, 2, undefined]).preserveElementGeometry, false);
  assert.equal(parseDrawArgs([EL, 1, 2, 3, 4, { preserveElementGeometry: 1 }]).preserveElementGeometry, true);
  assert.equal(parseDrawArgs([EL, 1, 2, 3, 4, 5, 6, 7, 8, { preserveElementGeometry: true }]).preserveElementGeometry, true);
  assert.equal(parseDrawArgs([EL, '7', '8']).dx, 7);
});

test('parseDrawArgs: NaN or infinite numeric argument returns null (spec: return silently)', () => {
  assert.equal(parseDrawArgs([EL, NaN, 2]), null);
  assert.equal(parseDrawArgs([EL, 1, Infinity]), null);
  assert.equal(parseDrawArgs([EL, 1, 2, 3, -Infinity]), null);
  assert.equal(parseDrawArgs([EL, 'x', 2]), null);
  assert.equal(parseDrawArgs([EL, 1, 2, 3, 4, 5, 6, 7, NaN]), null);
});

test('parseDrawArgs: TypeError on bad arity, on a non-object options argument and on a Symbol/BigInt number', () => {
  assert.throws(() => parseDrawArgs([]), TypeError);
  assert.throws(() => parseDrawArgs([EL]), TypeError);
  assert.throws(() => parseDrawArgs([EL, 1]), TypeError);
  assert.throws(() => parseDrawArgs([EL, 1, 2, 3]), TypeError, 'three numbers: the third is an options argument that is a number');
  assert.throws(() => parseDrawArgs([EL, 1, 2, 3, 4, 5]), TypeError);
  assert.throws(() => parseDrawArgs([EL, 1, 2, 3, 4, 5, 6, 7]), TypeError);
  assert.throws(() => parseDrawArgs([EL, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), TypeError);
  assert.throws(() => parseDrawArgs([EL, Symbol('x'), 2]), TypeError);
  assert.throws(() => parseDrawArgs([EL, 10n, 2]), TypeError);
});

// version: 100x50 css px element on a 200x100 css px canvas; output bitmap 400x200 => scale 2
const V = { width: 100, height: 50, canvasWidth: 200, canvasHeight: 100 };

test('resolveRects: defaults are the element size times the grid scale', () => {
  const r = resolveRects(parseDrawArgs([EL, 10, 20]), V, 400, 200);
  assert.deepEqual(r.src, { sx: 0, sy: 0, sw: 100, sh: 50 });
  assert.deepEqual([r.dx, r.dy, r.dw, r.dh], [10, 20, 200, 100]);
  assert.deepEqual([r.scaleX, r.scaleY, r.kx, r.ky], [2, 2, 2, 2]);
  assert.deepEqual([r.dwDefaulted, r.dhDefaulted, r.degenerate], [true, true, false]);
});

test('resolveRects: explicit dest size, explicit source rect', () => {
  let r = resolveRects(parseDrawArgs([EL, 10, 20, 50, 25]), V, 400, 200);
  assert.deepEqual([r.dw, r.dh, r.kx, r.ky, r.dwDefaulted], [50, 25, 0.5, 0.5, false]);
  r = resolveRects(parseDrawArgs([EL, 10, 5, 40, 20, 3, 4]), V, 400, 200);
  assert.deepEqual(r.src, { sx: 10, sy: 5, sw: 40, sh: 20 });
  assert.deepEqual([r.dx, r.dy, r.dw, r.dh], [3, 4, 80, 40]);
});

test('resolveRects: negative sizes never mirror, the rect is normalised', () => {
  let r = resolveRects(parseDrawArgs([EL, 100, 50, -30, -10]), V, 400, 200);
  assert.deepEqual([r.dx, r.dy, r.dw, r.dh], [70, 40, 30, 10]);
  assert.equal(r.kx, 0.3);
  assert.equal(r.ky, 0.2);
  r = resolveRects(parseDrawArgs([EL, 30, 10, -20, -10, 0, 0, 40, 20]), V, 400, 200);
  assert.deepEqual(r.src, { sx: 10, sy: 0, sw: 20, sh: 10 });
});

test('resolveRects: zero sized rects are degenerate; a zero canvas size falls back to scale 1', () => {
  assert.equal(resolveRects(parseDrawArgs([EL, 0, 0, 0, 10]), V, 400, 200).degenerate, true);
  assert.equal(resolveRects(parseDrawArgs([EL, 0, 0, 1, 2, 3, 4, 5, 0]), V, 400, 200).degenerate, true);
  assert.equal(resolveRects(parseDrawArgs([EL, 1, 1]), { ...V, width: 0 }, 400, 200).degenerate, true);
  const r = resolveRects(parseDrawArgs([EL, 1, 1]), { ...V, canvasWidth: 0, canvasHeight: 0 }, 400, 200);
  assert.deepEqual([r.scaleX, r.scaleY, r.dw, r.dh], [1, 1, 100, 50]);
});

const INK = { left: 24, top: 24, right: 24, bottom: 24 };

test('clipToSurface: a source rect inside the surface is unchanged', () => {
  const r = resolveRects(parseDrawArgs([EL, 10, 5, 40, 20, 3, 4]), V, 400, 200);
  const c = clipToSurface(r, { ...V, ink: INK });
  assert.deepEqual(c, { src: { sx: 10, sy: 5, sw: 40, sh: 20 }, dx: 3, dy: 4, dw: 80, dh: 40 });
});

test('clipToSurface: ink overflow is reachable up to the margin, beyond it the destination shrinks proportionally', () => {
  // source x from -30 (6 px beyond the 24 px ink) to 170 (46 beyond width+ink=124 => clipped to 124); kx = 2
  const r = resolveRects(parseDrawArgs([EL, -30, 0, 200, 50, 100, 10]), V, 400, 200);
  const c = clipToSurface(r, { ...V, ink: INK });
  assert.deepEqual(c.src, { sx: -24, sy: 0, sw: 148, sh: 50 });
  assert.equal(c.dx, 100 + 6 * 2);
  assert.equal(c.dw, 148 * 2);
  assert.equal(c.dy, 10);
});

test('clipToSurface: no overlap or a degenerate rect gives null', () => {
  const far = resolveRects(parseDrawArgs([EL, 500, 0, 10, 10, 0, 0]), V, 400, 200);
  assert.equal(clipToSurface(far, { ...V, ink: INK }), null);
  const none = resolveRects(parseDrawArgs([EL, 0, 0, 0, 10, 0, 0]), V, 400, 200);
  assert.equal(clipToSurface(none, { ...V, ink: INK }), null);
});

test('snapDefaultSize: default-size draws copy the raster 1:1 when the raster scale equals the grid scale', () => {
  const r = resolveRects(parseDrawArgs([EL, 0, 0]), { width: 100.5, height: 50, canvasWidth: 100, canvasHeight: 50 }, 125, 62.5);
  assert.equal(r.scaleX, 1.25);
  const clipped = { src: r.src, dw: r.dw, dh: r.dh };
  assert.equal(r.dw, 125.625);
  assert.deepEqual(snapDefaultSize(r, clipped, { sw: 126, sh: 63 }, 1.25), { dw: 126, dh: 63 });
  // an explicit dw more than 1 px / 1 % away from the raster is never snapped, a different raster scale is never snapped, a clipped source is never snapped
  const explicit = resolveRects(parseDrawArgs([EL, 0, 0, 120, 60]), V, 400, 200);
  assert.deepEqual(snapDefaultSize(explicit, { src: explicit.src, dw: 120, dh: 60 }, { sw: 126, sh: 63 }, 2), { dw: 120, dh: 60 });
  assert.deepEqual(snapDefaultSize(r, clipped, { sw: 126, sh: 63 }, 2), { dw: 125.625, dh: 62.5 + 0 });
  assert.deepEqual(snapDefaultSize(r, { src: { ...r.src, sw: 10 }, dw: 5, dh: 5 }, { sw: 126, sh: 63 }, 1.25), { dw: 5, dh: 5 });
});

test('snapDefaultSize: an explicit size within 1 px and 1 % of the raster is drawn 1:1 (offsetWidth * devicePixelRatio at DPR 1.25 / 1.5), farther ones are scaled', () => {
  // F1 at DPR 1.25: a 1178.4 css px form rasterised to 1473 px, drawn at offsetWidth (1178) * 1.25 = 1472.5 px
  const r = resolveRects(parseDrawArgs([EL, 0, 0, 1472.5, 947.5]), { width: 1178.4, height: 758.4, canvasWidth: 1178.4, canvasHeight: 758.4 }, 1473, 948);
  const clipped = { src: r.src, dw: r.dw, dh: r.dh };
  assert.deepEqual(snapDefaultSize(r, clipped, { sw: 1473, sh: 948 }, 1.25), { dw: 1473, dh: 948 });
  // 1 px or more away, or more than 1 % of a small raster: the requested size stands
  assert.deepEqual(snapDefaultSize(r, { ...clipped, dw: 1472 }, { sw: 1473, sh: 948 }, 1.25), { dw: 1472, dh: 948 });
  assert.deepEqual(snapDefaultSize(r, { ...clipped, dw: 19.6, dh: 20 }, { sw: 20, sh: 20 }, 1.25), { dw: 19.6, dh: 20 });
  // a clipped source is never snapped
  assert.deepEqual(snapDefaultSize(r, { src: { ...r.src, sw: 10 }, dw: 1472.5, dh: 947.5 }, { sw: 1473, sh: 948 }, 1.25), { dw: 1472.5, dh: 947.5 });
});

test('canvasTransformValues: translation only, grid scale 1', () => {
  const r = { sx: 0, sy: 0, sw: 100, sh: 50, dx: 10, dy: 20, dw: 100, dh: 50 };
  close(canvasTransformValues(IDENTITY16, r, 1, 1, IDENTITY16), translation16(10, 20));
});

test('canvasTransformValues: grid scale 2 with a defaulted size cancels out, so the stored matrix is in css px', () => {
  const r = { sx: 0, sy: 0, sw: 100, sh: 50, dx: 10, dy: 20, dw: 200, dh: 100, kx: 2, ky: 2 };
  close(canvasTransformValues(IDENTITY16, r, 2, 2, IDENTITY16), translation16(5, 10));
  // a pure translation commutes with the transform-origin conjugation
  close(canvasTransformValues(IDENTITY16, r, 2, 2, translation16(50, 25)), translation16(5, 10));
});

test('canvasTransformValues: scaled draw around the transform origin', () => {
  // draw at half size, T_tr = translate(50,25): x -> 0.5(x+50)-50 = 0.5x-25, y -> 0.5(y+25)-25 = 0.5y-12.5
  const r = { sx: 0, sy: 0, sw: 100, sh: 50, dx: 0, dy: 0, dw: 50, dh: 25 };
  close(canvasTransformValues(IDENTITY16, r, 1, 1, translation16(50, 25)), scale16(0.5, 0.5).map((v, i) => (i === 12 ? -25 : i === 13 ? -12.5 : v)));
});

test('canvasTransformValues: the source origin shifts the element the other way', () => {
  const r = { sx: 10, sy: 4, sw: 50, sh: 20, dx: 0, dy: 0, dw: 50, dh: 20 };
  close(canvasTransformValues(IDENTITY16, r, 1, 1, IDENTITY16), translation16(-10, -4));
});

test('canvasTransformValues: the context transform is applied after the destination translation (rotate 90deg)', () => {
  const rotate90 = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const r = { sx: 0, sy: 0, sw: 10, sh: 10, dx: 10, dy: 0, dw: 10, dh: 10 };
  // point p -> rotate90(p + (10,0)): translation part = rotate90 * (10,0) = (0,10)
  close(canvasTransformValues(rotate90, r, 1, 1, IDENTITY16), [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 10, 0, 1]);
});

test('canvasTransformValues: kx/ky override dw/sw, otherwise the ratio is used', () => {
  const base = { sx: 0, sy: 0, sw: 100, sh: 50, dx: 0, dy: 0, dw: 126, dh: 63 };
  close(canvasTransformValues(IDENTITY16, base, 1, 1, IDENTITY16), scale16(1.26, 1.26));
  close(canvasTransformValues(IDENTITY16, { ...base, kx: 1.25, ky: 1.25 }, 1, 1, IDENTITY16), scale16(1.25, 1.25));
});

test('storedTransformValues: the legacy getElementTransform(element, drawTransform) formula', () => {
  // T_draw = translate(8,6), S = scale(2,3), T_tr = translate(5,5): x -> 0.5(x+5)+4-5 = 0.5x+1.5, y -> (y+5)/3+2-5 = y/3-4/3
  close(storedTransformValues(translation16(8, 6), 2, 3, translation16(5, 5)), [0.5, 0, 0, 0, 0, 1 / 3, 0, 0, 0, 0, 1, 0, 1.5, -4 / 3, 0, 1]);
  // identity draw, S = scale(4), T_tr = translate(10,10): x -> 0.25(x+10)-10 = 0.25x-7.5
  close(storedTransformValues(IDENTITY16, 4, 4, translation16(10, 10)), [0.25, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, 1, 0, -7.5, -7.5, 0, 1]);
  // no scale, no origin: the draw transform itself
  close(storedTransformValues(translation16(3, 4), 1, 1, IDENTITY16), translation16(3, 4));
});
