// The pixel oracle of the gates (test/gates/lib/pixel.mjs): it must PASS identical images and FAIL a blank, a 1 px shift, a 10 % tint and a hidden-layer mismatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSurface, maskOutsideViewport, colorShare, deviceBox, regionCompare } from '../../gates/lib/pixel.mjs';

/** A 200x100 image: flat background with a dark text-like bar pattern and a coloured box. */
function scene(shift = 0, tint = 0) {
  const W = 200, H = 100, data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4; let v = [240 - (x >> 4), 240 - (y >> 5), 245];
    const xs = x - shift;
    if (y >= 20 && y < 60 && xs >= 20 && xs < 120 && ((xs >> 1) & 1)) v = [20, 20, 30];
    if (y >= 70 && y < 90 && xs >= 30 && xs < 90) v = (y >= 74 && y < 86 && xs >= 40 && xs < 70 && ((xs >> 2) & 1)) ? [255, 255, 255] : [200, 40, 40];
    data[i] = Math.min(255, v[0] - tint); data[i + 1] = Math.min(255, v[1] - tint); data[i + 2] = Math.min(255, v[2] - tint); data[i + 3] = 255;
  }
  return { width: W, height: H, data };
}
const fakeCtx = () => { const checks = []; return { checks, check: (name, ok, detail, cls) => { checks.push({ name, ok: !!ok, cls }); return ok; }, failedClasses: () => new Set(checks.filter((c) => !c.ok).map((c) => c.cls)) }; };
const regions = [{ name: 'bars', rect: { x: 20, y: 20, width: 100, height: 40 } }, { name: 'box', rect: { x: 30, y: 70, width: 60, height: 20 } }];
const run = (poly, twin = scene()) => { const ctx = fakeCtx(); checkSurface(ctx, { name: 't', poly, twin, dpr: 1, regions, minContent: 0.02, tight: { tolerance: 6, max: 0.003 } }); return ctx; };

test('identical images pass every check', () => { const c = run(scene()); assert.deepEqual(c.checks.filter((x) => !x.ok).map((x) => x.name), []); });
test('a blank canvas fails content, pixel and region checks', () => {
  const blank = { width: 200, height: 100, data: new Uint8Array(200 * 100 * 4).fill(255) };
  const f = run(blank).failedClasses(); assert.ok(f.has('content') && f.has('pixel') && f.has('region'));
});
test('a 1 px shift is caught by the tight pass and the regions', () => { const f = run(scene(1)).failedClasses(); assert.ok(f.has('pixel') && f.has('region')); });
test('a 10 % grey tint (13 levels) is caught by the tight pass although delta <= 16', () => {
  const ctx = run(scene(0, 13));
  const names = ctx.checks.filter((c) => !c.ok).map((c) => c.name);
  assert.ok(names.some((n) => /tight pass/.test(n)));
  assert.ok(!names.some((n) => /O-pixel <= 3 %/.test(n)), 'the 3 % / delta > 16 gate alone would have passed it');
});
test('a twin without content cannot make a blank canvas fit the budget', () => {
  const flat = { width: 200, height: 100, data: new Uint8Array(200 * 100 * 4).fill(255) };
  const f = run(flat, flat).failedClasses(); assert.ok(f.has('content'));
});
test('maskOutsideViewport blanks the part outside the viewport in both images', () => {
  const a = scene(), b = scene();
  assert.equal(maskOutsideViewport(a, b, { x: 0, y: -40, dpr: 1, innerWidth: 200, innerHeight: 40 }), true);
  assert.deepEqual([...a.data.slice(0, 4)], [0, 0, 0, 255]); // row 0 (css y -40) is above the viewport
  assert.deepEqual([...b.data.slice(((90) * 200) * 4, ((90) * 200) * 4 + 4)], [0, 0, 0, 255]);
  assert.equal(maskOutsideViewport(scene(), scene(), { x: 0, y: 0, dpr: 1, innerWidth: 400, innerHeight: 400 }), false);
});
test('colorShare and deviceBox read device pixels of a css rect', () => {
  const img = scene();
  assert.ok(colorShare(img, { x: 30, y: 70, width: 10, height: 4 }, { x: 0, y: 0 }, 1, [200, 40, 40], 10) > 0.99);
  assert.ok(colorShare(img, { x: 150, y: 10, width: 40, height: 10 }, { x: 0, y: 0 }, 1, [200, 40, 40], 10) < 0.01);
  assert.deepEqual(deviceBox({ x: 10.2, y: 5, width: 3, height: 2 }, { x: 0, y: 0 }, 2, img, 1), { x: 19, y: 9, w: 9, h: 6 });
  assert.equal(regionCompare(img, img, { x: 20, y: 20, width: 10, height: 10 }, { x: 0, y: 0 }, 1).fraction, 0);
});
