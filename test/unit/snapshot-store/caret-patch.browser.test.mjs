import { test, assert } from '/test/unit/lib/t.js';
import { createCaretPatch } from '/src/snapshot/store/caret-patch.js';
import { allocateSurface } from '/src/snapshot/store/surfaces.js';
import { allPixels, fill, pixel, RGBA, samePixels } from './helpers.mjs';

/** A surface with a non-uniform pattern so a wrong restore cannot pass by accident. */
function patterned() {
  const s = allocateSurface(60, 40);
  const ctx = s.getContext('2d');
  for (let x = 0; x < 60; x += 4) { ctx.fillStyle = `rgb(${x * 4},${255 - x * 4},${(x * 7) % 256})`; ctx.fillRect(x, 0, 4, 40); }
  return s;
}
const rect = { x: 20, y: 10, width: 2, height: 16 };

test('show paints the caret colour over the rect only; hide restores the surface bit-exact', () => {
  const s = patterned();
  const before = allPixels(s);
  const p = createCaretPatch();
  assert.equal(p.visible(), false);
  p.show(s, rect, 'rgb(255,0,0)');
  assert.equal(p.visible(), true);
  assert.deepEqual(pixel(s, 20, 12), RGBA.red);
  assert.deepEqual(pixel(s, 21, 25), RGBA.red);
  assert.ok(!samePixels(before, allPixels(s)));
  assert.deepEqual(pixel(s, 19, 12), [...before.slice((12 * 60 + 19) * 4, (12 * 60 + 19) * 4 + 4)], 'outside the rect is untouched');
  p.hide(s);
  assert.equal(p.visible(), false);
  assert.ok(samePixels(before, allPixels(s)), 'restored exactly');
});

test('hide when hidden is a no-op; show twice restores the first save before saving again', () => {
  const s = patterned();
  const before = allPixels(s);
  const p = createCaretPatch();
  p.hide(s);
  assert.ok(samePixels(before, allPixels(s)));
  p.show(s, rect, 'rgb(255,0,0)');
  p.show(s, { x: 40, y: 5, width: 2, height: 10 }, 'rgb(0,0,255)');
  assert.deepEqual(pixel(s, 20, 12), [...before.slice((12 * 60 + 20) * 4, (12 * 60 + 20) * 4 + 4)], 'first caret rect was restored');
  assert.deepEqual(pixel(s, 40, 8), RGBA.blue);
  p.hide(s);
  assert.ok(samePixels(before, allPixels(s)));
});

test('a rect that reaches past the surface is clipped, not an error', () => {
  const s = patterned();
  const before = allPixels(s);
  const p = createCaretPatch();
  p.show(s, { x: 58, y: 36, width: 10, height: 10 }, 'rgb(255,0,0)');
  assert.deepEqual(pixel(s, 59, 39), RGBA.red);
  p.hide(s);
  assert.ok(samePixels(before, allPixels(s)));
  p.show(s, { x: 100, y: 100, width: 2, height: 2 }, 'rgb(255,0,0)');
  assert.equal(p.visible(), false, 'nothing to paint outside the surface');
});

test('tileLanded: a tile covering the rect forgets the saved pixels; a partial overlap does not', () => {
  const s = patterned();
  const p = createCaretPatch();
  p.show(s, rect, 'rgb(255,0,0)');
  p.tileLanded({ x: 0, y: 0, width: 21, height: 40 });
  assert.equal(p.visible(), true, 'partial cover keeps the state');
  p.tileLanded({ x: 0, y: 0, width: 60, height: 40 });
  assert.equal(p.visible(), false, 'full cover forgets');
  // After a tile repainted the area (caret-free), hide must not paste the stale saved pixels back.
  fill(s, 'lime');
  p.hide(s);
  assert.deepEqual(pixel(s, 20, 12), RGBA.lime);
});

test('a lost context makes show/hide silent no-ops', () => {
  const s = patterned();
  const p = createCaretPatch();
  p.show(s, rect, 'rgb(255,0,0)');
  const ctx = s.getContext('2d');
  ctx.isContextLost = () => true;
  p.hide(s);
  assert.equal(p.visible(), false);
  delete ctx.isContextLost;
});

test('hide puts back transparent pixels too (copy, not source-over)', () => {
  const s = allocateSurface(60, 40);
  const ctx = s.getContext('2d');
  ctx.fillStyle = 'rgb(0,255,0)';
  ctx.fillRect(0, 0, 20, 40);
  const p = createCaretPatch();
  p.show(s, { x: 10, y: 5, width: 20, height: 10 }, 'rgb(255,0,0)');
  p.hide(s);
  assert.deepEqual(pixel(s, 25, 8), [0, 0, 0, 0], 'the transparent part is transparent again');
  assert.deepEqual(pixel(s, 12, 8), RGBA.lime);
});
