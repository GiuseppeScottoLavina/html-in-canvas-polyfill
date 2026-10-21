// The raster scale of a canvas whose grid is its content box in device pixels, rounded (src/snapshot/store/surfaces.js gridRasterScale), and the 1:1 default-size draw
// of such a raster (src/api/draw-math.js snapDefaultSize). The field test at DPR 1.25 drew a scroll box 3.6-8 % of its pixels away from the plain page: its canvas
// content box is 338.4 x 168.4 css px (1 px borders are 0.8 css px there), i.e. 423 x 210.5 device px, and the ResizeObserver device-pixel-content-box pattern made a
// 423 x 211 grid. Native Canary draws such a grid as the page (0 % on a 312.4 x 184.4 css px box at DPR 1.25; 7.3-8.6 % at the grid's x scale). Positive controls: the earlier choices (the grid's x scale, a default draw scaled to the grid) are the ones the tests reject.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridRasterScale } from '../../../src/snapshot/store/surfaces.js';
import { parseDrawArgs, resolveRects, snapDefaultSize } from '../../../src/api/draw-math.js';

const EL = { tag: 'element' };

test('gridRasterScale: the device pixel ratio when the grid is the content box at device pixels within 1 px on both axes', () => {
  const field = { width: 338.4, height: 168.4, gridScaleX: 423 / 338.4, gridScaleY: 211 / 168.4 };
  assert.equal(gridRasterScale(field, 1.25), 1.25);
  // the other axis fractional (312.4 css px = 390.5 device px, a grid of 391): the grid's x scale 1.2516 was the raster scale before
  const wide = { width: 312.4, height: 184, gridScaleX: 391 / 312.4, gridScaleY: 230 / 184 };
  assert.equal(gridRasterScale(wide, 1.25), 1.25);
  assert.notEqual(wide.gridScaleX, 1.25, 'positive control: the earlier raster scale differs from the page');
  // DPR 1.5: 168.4 css px = 252.6 device px, a grid of 253
  assert.equal(gridRasterScale({ width: 300, height: 168.4, gridScaleX: 1.5, gridScaleY: 253 / 168.4 }, 1.5), 1.5);
});

test('gridRasterScale: any other grid keeps its own scale (a 2x canvas on a 1.25 screen, a 1x canvas, an unknown DPR)', () => {
  assert.equal(gridRasterScale({ width: 300, height: 150, gridScaleX: 2, gridScaleY: 2 }, 1.25), 2);
  assert.equal(gridRasterScale({ width: 300, height: 150, gridScaleX: 1, gridScaleY: 1 }, 1.25), 1);
  // one axis more than a pixel away: the grid is not the device-pixel box
  assert.equal(gridRasterScale({ width: 300, height: 150, gridScaleX: 1.25, gridScaleY: 1.27 }, 1.25), 1.25);
  assert.equal(gridRasterScale({ width: 400, height: 150, gridScaleX: 1.2475, gridScaleY: 1.25 }, 1.25), 1.2475);
  assert.equal(gridRasterScale({ width: 300, height: 150, gridScaleX: 1.2516, gridScaleY: 1.25 }, 0), 1.2516);
});

test('snapDefaultSize: a default-size draw within 1 px and 1 % of a raster at a scale within 1 % is copied 1:1 (no resampling by a hair)', () => {
  // the field-test scroll box: a 168.4 css px drawable rasterised at 1.25 (210.5 px), the grid at 211 / 168.4 = 1.25297
  const r = resolveRects(parseDrawArgs([EL, 0, 0]), { width: 338.4, height: 168.4, canvasWidth: 338.4, canvasHeight: 168.4 }, 423, 211);
  const clipped = { src: r.src, dw: r.dw, dh: r.dh };
  assert.ok(Math.abs(r.dh - 211) < 1e-9, 'the grid asks for 211 px');
  assert.deepEqual(snapDefaultSize(r, clipped, { sw: 423, sh: 210.5 }, 1.25), { dw: 423, dh: 210.5 });
  // positive control: the earlier rule kept the 211 px destination (a 1.0024 vertical resample)
  assert.notEqual(snapDefaultSize(r, clipped, { sw: 423, sh: 210.5 }, 1.25).dh, r.dh);
  // a raster at another scale (more than 1 % away) or more than 1 px away is still drawn at the grid's size
  assert.deepEqual(snapDefaultSize(r, clipped, { sw: 423, sh: 210.5 }, 1.3), { dw: r.dw, dh: r.dh });
  assert.deepEqual(snapDefaultSize(r, clipped, { sw: 423, sh: 209.5 }, 1.25), { dw: 423, dh: r.dh });
});
