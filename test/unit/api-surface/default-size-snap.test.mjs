// The 1:1 default-size draw of a raster whose scale is within 1 % of the grid's (src/api/draw-math.js snapDefaultSize). The field test at DPR 1.25 drew a scroll box
// 3.6-8 % of its pixels away from the plain page: its canvas content box is 338.4 x 168.4 css px (1 px borders are 0.8 css px there), i.e. 423 x 210.5 device px, and
// the ResizeObserver device-pixel-content-box pattern made a 423 x 211 grid: the raster is at the x scale 1.25, the default draw stretched it to the y scale 1.25297.
// Positive control: the earlier rule (a default draw scaled to the grid) is the one the test rejects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDrawArgs, resolveRects, snapDefaultSize } from '../../../src/api/draw-math.js';

const EL = { tag: 'element' };

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
