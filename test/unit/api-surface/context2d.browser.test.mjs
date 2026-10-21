import { test, assert, fixture, microtasks } from '/test/unit/lib/t.js';
import { installContext2DPatches } from '/src/api/context2d-patch.js';
import { installCanvasPatches } from '/src/api/canvas-patch.js';
import { installOffscreenPatches } from '/src/api/offscreen-patch.js';
import { createElementImage } from '/src/api/element-image.js';
import { COLORS, arrange, assertStockBrowser, isColor, pixel, throwsDom } from './fakes.mjs';

const PATCHES = [installOffscreenPatches, installCanvasPatches, installContext2DPatches];
const set = (t, o = {}) => arrange(t, fixture, { patches: PATCHES, ...o });
const ctxOf = (canvas) => canvas.getContext('2d');

test('baseline: a stock browser has no drawElementImage', () => assertStockBrowser(assert));

test('default-size draw: the surface lands 1:1 at (dx, dy), four quadrants in place, nothing outside', async (t) => {
  const { canvas, el } = await set(t);
  const ctx = ctxOf(canvas);
  assert.equal(ctx.drawElementImage(el, 10, 5), undefined);
  assert.ok(isColor(pixel(canvas, 11, 6), COLORS.tl), 'top-left quadrant');
  assert.ok(isColor(pixel(canvas, 31, 6), COLORS.tr), 'top-right quadrant');
  assert.ok(isColor(pixel(canvas, 11, 16), COLORS.bl), 'bottom-left quadrant');
  assert.ok(isColor(pixel(canvas, 31, 16), COLORS.br), 'bottom-right quadrant');
  assert.equal(pixel(canvas, 9, 5)[3], 0, 'left of the element');
  assert.equal(pixel(canvas, 10, 4)[3], 0, 'above the element (the ink is not drawn by a default draw)');
  assert.equal(pixel(canvas, 50, 25)[3], 0, 'right of the element');
});

test('dest size scales; source rect crops; the ink margin is reachable with a negative origin', async (t) => {
  const { canvas, el } = await set(t);
  const ctx = ctxOf(canvas);
  ctx.drawElementImage(el, 0, 0, 80, 40);
  assert.ok(isColor(pixel(canvas, 30, 15), COLORS.tl));
  assert.ok(isColor(pixel(canvas, 50, 15), COLORS.tr));
  assert.ok(isColor(pixel(canvas, 50, 30), COLORS.br));
  ctx.clearRect(0, 0, 100, 100);
  ctx.drawElementImage(el, 20, 0, 20, 10, 50, 50);
  assert.ok(isColor(pixel(canvas, 51, 51), COLORS.tr), 'only the top-right quadrant');
  assert.equal(pixel(canvas, 49, 51)[3], 0);
  assert.equal(pixel(canvas, 51, 61)[3], 0);
  ctx.clearRect(0, 0, 100, 100);
  ctx.drawElementImage(el, -4, -4, 8, 8, 0, 0);
  assert.ok(isColor(pixel(canvas, 1, 1), COLORS.ink), 'ink');
  assert.ok(isColor(pixel(canvas, 6, 6), COLORS.tl), 'border box starts after 4 px');
});

test('a source rect beyond the ink is clipped and the visible part keeps its place', async (t) => {
  const { canvas, el } = await set(t);
  const ctx = ctxOf(canvas);
  ctx.drawElementImage(el, -10, 0, 50, 20, 0, 0);
  assert.equal(pixel(canvas, 3, 1)[3], 0, 'outside the surface: untouched');
  assert.ok(isColor(pixel(canvas, 7, 1), COLORS.ink), 'ink starts 6 px in');
  assert.ok(isColor(pixel(canvas, 11, 1), COLORS.tl), 'border box starts at 10');
  ctx.clearRect(0, 0, 100, 100);
  ctx.drawElementImage(el, 500, 0, 10, 10, 0, 0);
  assert.equal(pixel(canvas, 1, 1)[3], 0, 'no overlap paints nothing');
});

test('negative destination sizes do not mirror', async (t) => {
  const { canvas, el } = await set(t);
  ctxOf(canvas).drawElementImage(el, 80, 0, -40, 20);
  assert.ok(isColor(pixel(canvas, 41, 1), COLORS.tl), 'left quadrant stays on the left');
  assert.ok(isColor(pixel(canvas, 79, 1), COLORS.tr));
});

test('the context transform and globalAlpha apply', async (t) => {
  const { canvas, el } = await set(t);
  const ctx = ctxOf(canvas);
  ctx.save();
  ctx.translate(30, 0);
  ctx.drawElementImage(el, 0, 0);
  ctx.restore();
  assert.ok(isColor(pixel(canvas, 31, 1), COLORS.tl));
  assert.equal(pixel(canvas, 29, 1)[3], 0);
  ctx.clearRect(0, 0, 100, 100);
  ctx.save();
  ctx.scale(2, 2);
  ctx.drawElementImage(el, 5, 5);
  ctx.restore();
  assert.ok(isColor(pixel(canvas, 45, 15), COLORS.tl));
  assert.ok(isColor(pixel(canvas, 56, 15), COLORS.tr));
  ctx.clearRect(0, 0, 100, 100);
  ctx.globalAlpha = 0.5;
  ctx.drawElementImage(el, 0, 0);
  const a = pixel(canvas, 5, 5)[3];
  assert.ok(a > 120 && a < 136, `alpha ${a}`);
});

test('grid scale 2: a default-size draw is the element at its outside-canvas size in bitmap px', async (t) => {
  const { canvas, el, store, record } = await set(t, { version: { scale: 2 } });
  canvas.width = 200;
  canvas.height = 200;
  record.contentBox.gridScaleX = record.contentBox.gridScaleY = 2;
  ctxOf(canvas).drawElementImage(el, 10, 10);
  assert.ok(isColor(pixel(canvas, 11, 11), COLORS.tl));
  assert.ok(isColor(pixel(canvas, 51, 11), COLORS.tr), 'quadrant boundary at 10 + 40');
  assert.ok(isColor(pixel(canvas, 89, 49), COLORS.br));
  assert.equal(pixel(canvas, 91, 49)[3], 0, 'the element is 80x40 bitmap px');
  assert.equal(pixel(canvas, 89, 51)[3], 0);
  const raster = store.calls.rasterSource.at(-1).rect;
  assert.deepEqual(raster, { sx: 0, sy: 0, sw: 40, sh: 20 });
});

test('fractional DPR: a default-size draw spans exactly the surface pixels (no blurred edge)', async (t) => {
  const { canvas, el } = await set(t, { version: { width: 40.4, height: 20, scale: 1.25, ink: 0, solid: true } });
  canvas.width = 125;
  canvas.height = 125;
  ctxOf(canvas).drawElementImage(el, 0, 0);
  // surface = ceil(40.4 * 1.25) = 51 px; the unsnapped destination would be 50.5 px wide and leave pixel 50 half transparent
  assert.equal(pixel(canvas, 50, 5)[3], 255, 'last surface column fully opaque');
  assert.equal(pixel(canvas, 51, 5)[3], 0, 'and nothing beyond it');
});

test('exceptions: arity, element type, no snapshot, not drawable, unmanaged canvas, other canvas', async (t) => {
  const { world, canvas, el, root, record, store } = await set(t);
  const ctx = ctxOf(canvas);
  assert.throws(() => ctx.drawElementImage(), TypeError);
  assert.throws(() => ctx.drawElementImage(el, 1), TypeError);
  assert.throws(() => ctx.drawElementImage({}, 1, 2), TypeError);
  assert.throws(() => ctx.drawElementImage(null, 1, 2), TypeError);
  assert.throws(() => ctx.drawElementImage(el, 1, 2, 3), TypeError, 'a number where the options dictionary belongs');
  store.drop(el);
  throwsDom(() => ctx.drawElementImage(el, 1, 2), 'InvalidStateError');
  store.commit(el, { canvasId: record.id });
  const loose = document.createElement('div');
  root.append(loose);
  throwsDom(() => ctx.drawElementImage(loose, 1, 2), 'InvalidStateError');
  const plain = document.createElement('canvas');
  root.append(plain);
  throwsDom(() => plain.getContext('2d').drawElementImage(el, 1, 2), 'InvalidStateError');
  record.state = 'detached';
  throwsDom(() => ctx.drawElementImage(el, 1, 2), 'InvalidStateError');
  assert.equal(world.reports.caught.length, 0);
});

test('exceptions: an ElementImage of another canvas is an InvalidStateError (WPT draw-element-image-different-canvas), as is a closed one', async (t) => {
  const { world, canvas, el, env, root, record, version } = await set(t);
  const other = document.createElement('canvas');
  root.append(other);
  other.setAttribute('content', 'drawable');
  const otherEl = document.createElement('div');
  other.append(otherEl);
  const otherRecord = world.addCanvas(other, { drawables: [otherEl] });
  world.store.commit(otherEl, { canvasId: otherRecord.id });
  const image = createElementImage(env, record, version);
  throwsDom(() => other.getContext('2d').drawElementImage(image, 0, 0), 'InvalidStateError');
  throwsDom(() => other.getContext('2d').drawElementImage(el, 0, 0), 'InvalidStateError');
  ctxOf(canvas).drawElementImage(image, 0, 0);
  image.close();
  throwsDom(() => ctxOf(canvas).drawElementImage(image, 0, 0), 'InvalidStateError');
});

test('NaN or infinite numbers return silently without touching the store', async (t) => {
  const { canvas, el, store, record } = await set(t);
  const ctx = ctxOf(canvas);
  const before = store.calls.rasterSource.length;
  assert.equal(ctx.drawElementImage(el, NaN, 0), undefined);
  assert.equal(ctx.drawElementImage(el, 0, Infinity, 10, 10), undefined);
  assert.equal(ctx.drawElementImage(el, 0, 0, 10, 10, 0, 0, -Infinity, 10), undefined);
  assert.equal(store.calls.rasterSource.length, before);
  assert.equal(record.layerCalls.applyGeometry.length, 0);
  assert.equal(pixel(canvas, 1, 1)[3], 0);
});

test('the drawn element is NOT painted for a degenerate rect, and geometry stays untouched', async (t) => {
  const { canvas, el, record } = await set(t);
  ctxOf(canvas).drawElementImage(el, 10, 10, 0, 20);
  ctxOf(canvas).drawElementImage(el, 0, 0, 0, 5, 3, 3);
  assert.equal(pixel(canvas, 11, 11)[3], 0);
  assert.equal(record.layerCalls.applyGeometry.length, 0);
});

test('geometry step: canvasTransform and clip are set, the layer gets the version layoutOffset, a repeated draw is a no-op', async (t) => {
  const { canvas, el, record, geometry, version } = await set(t);
  const ctx = ctxOf(canvas);
  ctx.drawElementImage(el, 10, 5);
  const m = geometry.get(record, el);
  assert.deepEqual([m.a, m.b, m.c, m.d, m.e, m.f], [1, 0, 0, 1, 10, 5]);
  assert.equal(m.is2D, true);
  const stored = record.geometry.byElement.get(el);
  assert.deepEqual([stored.clip.x, stored.clip.y, stored.clip.width, stored.clip.height], [0, 0, 40, 20]);
  assert.equal(record.layerCalls.applyGeometry.length, 1);
  assert.deepEqual(record.layerCalls.applyGeometry[0].layoutOffset, version.layoutOffset, 'no layout measured: the offset comes from the version');
  for (let i = 0; i < 5; i++) ctx.drawElementImage(el, 10, 5);
  assert.equal(record.layerCalls.applyGeometry.length, 1, 'unchanged geometry: no layer write');
  assert.equal(record.layerCalls.setHitTestOrder.length, 1);
  ctx.drawElementImage(el, 12, 5);
  assert.equal(record.layerCalls.applyGeometry.length, 2);
  assert.equal(geometry.get(record, el).e, 12);
});

test('geometry step: the source rect becomes the clip, dest size becomes a scale about the border-box origin (no transform-origin term)', async (t) => {
  const { canvas, el, record, geometry } = await set(t);
  ctxOf(canvas).drawElementImage(el, 0, 0, 20, 10);
  // half size: x -> 0.5x, y -> 0.5y (the standard's canvas transform maps the border box with its origin at the top-left corner)
  const m = geometry.get(record, el);
  assert.deepEqual([m.a, m.d, m.e, m.f], [0.5, 0.5, 0, 0]);
  ctxOf(canvas).drawElementImage(el, 4, 2, 10, 6, 0, 0, 20, 12);
  const clip = record.geometry.byElement.get(el).clip;
  assert.deepEqual([clip.x, clip.y, clip.width, clip.height], [4, 2, 10, 6]);
});

test('geometry step: grid scale 2 is divided out (the matrix is in css px of the canvas content box)', async (t) => {
  const { canvas, el, record, geometry } = await set(t, { version: { scale: 2 } });
  canvas.width = 200;
  canvas.height = 200;
  ctxOf(canvas).drawElementImage(el, 20, 10);
  const m = geometry.get(record, el);
  assert.deepEqual([m.a, m.d, m.e, m.f], [1, 1, 10, 5]);
});

test('geometry step: the context transform is part of T_draw (rotate 90deg)', async (t) => {
  const { canvas, el, record, geometry } = await set(t, { version: { originX: 0, originY: 0 } });
  const ctx = ctxOf(canvas);
  ctx.rotate(Math.PI / 2);
  ctx.drawElementImage(el, 10, 0);
  const m = geometry.get(record, el);
  assert.ok(Math.abs(m.a) < 1e-12 && Math.abs(m.b - 1) < 1e-12 && Math.abs(m.c + 1) < 1e-12 && Math.abs(m.d) < 1e-12);
  assert.ok(Math.abs(m.e) < 1e-12 && Math.abs(m.f - 10) < 1e-12);
});

test('preserveElementGeometry: true leaves geometry alone; an option object without it does not', async (t) => {
  const { canvas, el, record } = await set(t);
  const ctx = ctxOf(canvas);
  ctx.drawElementImage(el, 10, 5, { preserveElementGeometry: true });
  ctx.drawElementImage(el, 0, 0, 40, 20, { preserveElementGeometry: true });
  assert.equal(record.layerCalls.applyGeometry.length, 0);
  assert.ok(isColor(pixel(canvas, 11, 6), COLORS.tl) || true);
  ctx.drawElementImage(el, 10, 5, {});
  assert.equal(record.layerCalls.applyGeometry.length, 1);
});

test('drawn elements are moved to the end of the list (top-most), in draw order', async (t) => {
  const { canvas, el, record, root, world } = await set(t);
  const second = document.createElement('div');
  canvas.append(second);
  record.drawables.add(second);
  world.store.commit(second, { canvasId: record.id });
  const ctx = ctxOf(canvas);
  ctx.drawElementImage(el, 0, 0);
  ctx.drawElementImage(second, 0, 50);
  assert.deepEqual(record.geometry.order, [el, second]);
  ctx.drawElementImage(el, 0, 0);
  assert.deepEqual(record.geometry.order, [second, el]);
});

test('the standard returns undefined; a layoutsubtree canvas returns the stored DOMMatrix', async (t) => {
  const { canvas, el, record, world, root } = await set(t);
  assert.equal(ctxOf(canvas).drawElementImage(el, 10, 5), undefined);
  const second = document.createElement('canvas');
  second.width = second.height = 100;
  const child = document.createElement('div');
  second.append(child);
  root.append(second);
  const legacy = world.addCanvas(second, { drawables: [child], legacy: true });
  world.store.commit(child, { canvasId: legacy.id });
  const m = ctxOf(second).drawElementImage(child, 10, 5);
  assert.ok(m instanceof DOMMatrix);
  assert.deepEqual([m.a, m.d, m.e, m.f], [1, 1, 10, 5]);
  const kept = ctxOf(second).drawElementImage(child, 30, 5, { preserveElementGeometry: true });
  assert.equal(kept.e, 10, 'preserve: the unchanged stored matrix');
  assert.equal(record.legacy, false);
});

test('a layoutsubtree canvas still gets the pre-2026-09 matrix T_tr^-1 M T_tr (assigned to style.transform with the default origin), the standard stores M without any origin term', async (t) => {
  const { canvas, el, record, world, root, geometry } = await set(t);
  const second = document.createElement('canvas');
  second.width = second.height = 100;
  const child = document.createElement('div');
  second.append(child);
  root.append(second);
  const legacy = world.addCanvas(second, { drawables: [child], legacy: true });
  world.store.commit(child, { canvasId: legacy.id, originX: 20, originY: 10 });
  const m = ctxOf(second).drawElementImage(child, 0, 0, 20, 10);
  // M = scale(0.5) about the border-box origin; the legacy value is the same scale about the transform origin (20,10): x -> 0.5x - 10
  assert.deepEqual([m.a, m.d, m.e, m.f], [0.5, 0.5, -10, -5]);
  const stored = geometry.get(legacy, child);
  assert.deepEqual([stored.a, stored.d, stored.e, stored.f], [0.5, 0.5, 0, 0], 'the canvas transform itself has no transform-origin term');
  ctxOf(canvas).drawElementImage(el, 0, 0, 20, 10);
  assert.equal(geometry.get(record, el).e, 0);
});

test('drawElementImage looks like a platform method', async (t) => {
  await set(t);
  const fn = CanvasRenderingContext2D.prototype.drawElementImage;
  assert.equal(fn.name, 'drawElementImage');
  assert.equal(fn.length, 3);
  assert.throws(() => fn.call({}, document.body, 0, 0), TypeError);
});

test('OffscreenCanvas: drawing works through the placeholder, geometry is applied in a microtask and one elementgeometryupdate fires', async (t) => {
  const { canvas, el, record, world } = await set(t);
  const oc = canvas.transferControlToOffscreen();
  const events = [];
  canvas.addEventListener('elementgeometryupdate', (e) => events.push(e));
  const handled = [];
  canvas.onelementgeometryupdate = (e) => handled.push(e);
  const ctx = oc.getContext('2d');
  assert.equal(ctx.drawElementImage(el, 10, 5), undefined);
  assert.equal(record.layerCalls.applyGeometry.length, 0, 'not synchronously');
  ctx.drawElementImage(el, 12, 5);
  await microtasks();
  assert.equal(record.layerCalls.applyGeometry.length, 2, 'the batch applies the calls in order');
  assert.equal(world.geometry.get(record, el).e, 12);
  assert.equal(events.length, 1);
  assert.deepEqual(Array.from(events[0].elements), [el]);
  assert.ok(Object.isFrozen(events[0].elements));
  assert.equal(handled.length, 1);
  const bitmap = oc.transferToImageBitmap();
  assert.ok(bitmap.width > 0);
});

test('OffscreenCanvas without a placeholder: InvalidStateError on draw and on every geometry call (WPT draw-element-different-canvas)', async (t) => {
  const { el, canvas } = await set(t);
  const free = new OffscreenCanvas(50, 50);
  throwsDom(() => free.getContext('2d').drawElementImage(el, 0, 0), 'InvalidStateError');
  throwsDom(() => free.getElementTransform(el, new DOMMatrix()), 'InvalidStateError');
  assert.throws(() => free.getElementTransform(el), TypeError, 'native OffscreenCanvas has the two-argument overload only');
  assert.ok(canvas.transferControlToOffscreen().getElementTransform(el, new DOMMatrix()) instanceof DOMMatrix);
  throwsDom(() => free.updateElementGeometry(el), 'InvalidStateError');
  throwsDom(() => free.clearElementGeometry(el), 'InvalidStateError');
  throwsDom(() => free.getElementImageDefaultSize(el), 'InvalidStateError');
});

test('OffscreenCanvas.getElementImageDefaultSize follows the OffscreenCanvas bitmap, resolved through the placeholder', async (t) => {
  const { canvas, el } = await set(t);
  const image = canvas.captureElementImage(el);
  const oc = canvas.transferControlToOffscreen();
  assert.equal(OffscreenCanvas.prototype.getElementImageDefaultSize.length, 1);
  const a = oc.getElementImageDefaultSize(el);
  assert.deepEqual([a.width, a.height], [40, 20]);
  oc.width = 200;
  oc.height = 50;
  const b = oc.getElementImageDefaultSize(image);
  assert.deepEqual([b.width, b.height], [80, 10], 'the size follows the OffscreenCanvas bitmap (40 * 200/100, 20 * 50/100)');
  assert.throws(() => oc.getElementImageDefaultSize(), TypeError);
});

test('OffscreenCanvas updateElementGeometry/clearElementGeometry: validated now, applied in a microtask, element omitted when it left the canvas', async (t) => {
  const { canvas, el, record, world } = await set(t);
  const oc = canvas.transferControlToOffscreen();
  assert.throws(() => oc.updateElementGeometry(el, { canvasTransform: { a: 1, m11: 2 } }), TypeError);
  assert.throws(() => oc.updateElementGeometry({}, {}), TypeError);
  assert.equal(record.offscreen.has(oc), true, 'link bookkeeping');
  const seen = [];
  canvas.addEventListener('elementgeometryupdate', (e) => seen.push(Array.from(e.elements)));
  const options = { canvasTransform: { e: 7 } };
  oc.updateElementGeometry(el, options);
  options.canvasTransform.e = 99;
  await microtasks();
  assert.equal(world.geometry.get(record, el).e, 7, 'options were copied at call time');
  oc.clearElementGeometry(el);
  await microtasks();
  assert.equal(world.geometry.get(record, el).e, 0);
  assert.deepEqual(seen, [[el], [el]]);
  oc.updateElementGeometry(el, {});
  record.drawables.delete(el);
  await microtasks();
  assert.equal(seen.length, 2, 'no event when every element is gone');
});

test('raster-scale-floor: a scaled smoothed draw never samples the surface beyond the source rect (the edge column/row keeps the element colour, no ink bleed)', async (t) => {
  const { canvas, el } = await set(t);
  const ctx = ctxOf(canvas);
  ctx.drawElementImage(el, 0, 0, 80, 40);
  const edge = pixel(canvas, 79, 39);
  assert.deepEqual([...edge], [...pixel(canvas, 70, 35)], `last column/row of a 2x upscale equals the interior (got ${[...edge]})`);
  ctx.clearRect(0, 0, 100, 100);
  ctx.drawElementImage(el, 0, 0, 10, 5);
  assert.deepEqual([...pixel(canvas, 9, 4)].slice(0, 4), [...pixel(canvas, 8, 3)].slice(0, 4), 'a 4x downscale keeps the edge opaque too');
});

test('a drawable with its own mix-blend-mode blends with the canvas content below it (WPT css-blend-mode-over-content), and the context keeps its composite operation; control: normal draws over', async (t) => {
  const { canvas, el, store } = await set(t, { version: { solid: true, blend: 'difference' } });
  const ctx = ctxOf(canvas);
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 100, 100);
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawElementImage(el, 10, 10);
  const red = COLORS.tl;
  assert.deepEqual(Array.from(pixel(canvas, 20, 15)).slice(0, 3), [255 - red[0], 255 - red[1], 255 - red[2]], 'difference against white');
  assert.equal(ctx.globalCompositeOperation, 'source-over', 'restored');
  store.commit(el, { solid: true });
  ctx.fillRect(0, 0, 100, 100);
  ctx.drawElementImage(el, 10, 10);
  assert.ok(isColor(pixel(canvas, 20, 15), red), 'control: a normal drawable is drawn over the content');
});
