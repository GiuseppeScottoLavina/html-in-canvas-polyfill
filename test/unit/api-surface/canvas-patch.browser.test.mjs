import { test, assert, fixture, microtasks, frames } from '/test/unit/lib/t.js';
import { installCanvasPatches } from '/src/api/canvas-patch.js';
import { installOffscreenPatches } from '/src/api/offscreen-patch.js';
import { installContext2DPatches } from '/src/api/context2d-patch.js';
import { ElementImage, createElementImage } from '/src/api/element-image.js';
import { CanvasPaintEvent, createSchedulerHooks } from '/src/api/paint-event.js';
import { BUS } from '/src/contracts/events.js';
import { arrange, assertStockBrowser, createWorld, throwsDom } from './fakes.mjs';

const PATCHES = [installOffscreenPatches, installCanvasPatches, installContext2DPatches];
const set = (t, o = {}) => arrange(t, fixture, { patches: PATCHES, ...o });

test('baseline: a stock browser has none of the names', () => assertStockBrowser(assert));

// ---------------------------------------------------------------------------------------------- content
test('content reflects only fallback|drawable: missing, invalid and mixed case', async (t) => {
  const { canvas } = await set(t, { canvasAttrs: '' });
  assert.equal(canvas.content, 'fallback');
  canvas.setAttribute('content', 'bogus');
  assert.equal(canvas.content, 'fallback');
  canvas.setAttribute('content', 'DrAwAbLe');
  assert.equal(canvas.content, 'drawable');
  canvas.content = 'fallback';
  assert.equal(canvas.getAttribute('content'), 'fallback');
  canvas.content = null;
  assert.equal(canvas.getAttribute('content'), 'null', 'DOMString conversion');
  assert.equal(canvas.content, 'fallback');
  canvas.content = 'drawable';
  assert.equal(canvas.getAttribute('content'), 'drawable');
  assert.equal(canvas.content, 'drawable');
});

test('content setter, setAttribute, removeAttribute and toggleAttribute hand a connected canvas to the registry synchronously', async (t) => {
  const { world, canvas, root } = await set(t, { canvasAttrs: '' });
  const adopted = () => world.calls.adopt.splice(0);
  canvas.content = 'drawable';
  assert.deepEqual(adopted(), [canvas]);
  canvas.setAttribute('content', 'fallback');
  assert.deepEqual(adopted(), [canvas]);
  canvas.setAttribute('CONTENT', 'drawable');
  assert.deepEqual(adopted(), [canvas], 'attribute names are case-insensitive in HTML');
  canvas.removeAttribute('content');
  assert.deepEqual(adopted(), [canvas]);
  canvas.toggleAttribute('content', true);
  assert.deepEqual(adopted(), [canvas]);
  canvas.setAttribute('width', '10');
  canvas.setAttribute('contents', 'x');
  canvas.setAttribute('data-hic', 'x');
  assert.deepEqual(adopted(), [], 'other attributes (even of the same length) are not forwarded');
  const div = document.createElement('div');
  root.append(div);
  div.setAttribute('content', 'drawable');
  assert.deepEqual(adopted(), [], 'only canvases');
  const loose = document.createElement('canvas');
  loose.setAttribute('content', 'drawable');
  assert.deepEqual(adopted(), [], 'a disconnected canvas is not adopted');
});

test('the patched attribute methods keep their results, arguments and errors', async (t) => {
  const { canvas } = await set(t, { canvasAttrs: '' });
  assert.equal(canvas.setAttribute('x-a', '1'), undefined);
  assert.equal(canvas.toggleAttribute('x-b'), true);
  assert.equal(canvas.toggleAttribute('x-b'), false);
  assert.equal(canvas.toggleAttribute('content', true), true);
  assert.equal(canvas.toggleAttribute('content', false), false);
  assert.throws(() => canvas.setAttribute('content'), TypeError);
  assert.throws(() => canvas.setAttribute('bad name', 'x'), DOMException);
  assert.equal(Element.prototype.setAttribute.name, 'setAttribute');
  assert.equal(Element.prototype.setAttribute.length, 2);
  assert.equal(Element.prototype.removeAttribute.length, 1);
});

test('legacy layoutsubtree: attribute and property adopt, warn once, and are absent without legacyNames', async (t) => {
  const warns = [];
  const warn = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  t.cleanup(() => { console.warn = warn; });
  const { world, canvas } = await set(t, { canvasAttrs: '' });
  assert.equal(canvas.layoutSubtree, false);
  canvas.layoutSubtree = true;
  assert.equal(canvas.hasAttribute('layoutsubtree'), true);
  assert.equal(canvas.layoutSubtree, true);
  assert.deepEqual(world.calls.adopt.splice(0), [canvas, ]);
  canvas.layoutSubtree = false;
  assert.equal(canvas.hasAttribute('layoutsubtree'), false);
  world.calls.adopt.length = 0;
  canvas.setAttribute('layoutsubtree', '');
  assert.deepEqual(world.calls.adopt, [canvas]);
  assert.equal(warns.filter((w) => w.includes('layoutsubtree')).length, 1, 'one warning per install');
  assert.equal(world.reports.deviation.filter((d) => d.id === 'layoutsubtree-legacy').length, 1);
});

test('legacyNames:false installs no layoutSubtree and ignores the attribute', async (t) => {
  const { world, canvas } = await set(t, { canvasAttrs: '', options: { legacyNames: false } });
  assert.equal('layoutSubtree' in canvas, false);
  canvas.setAttribute('layoutsubtree', '');
  assert.deepEqual(world.calls.adopt, []);
});

// ---------------------------------------------------------------------------------------------- handlers, framecap
test('onpaint / onelementgeometryupdate: IDL handler semantics', async (t) => {
  const { env, canvas, record } = await set(t);
  assert.equal(canvas.onpaint, null);
  assert.equal(canvas.onelementgeometryupdate, null);
  const seen = [];
  const handler = function (e) { seen.push([this, e]); };
  canvas.onpaint = handler;
  assert.equal(canvas.onpaint, handler);
  createSchedulerHooks(env).firePaint(record, [canvas.firstElementChild]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], canvas, 'this is the canvas');
  assert.ok(seen[0][1] instanceof CanvasPaintEvent);
  assert.equal(seen[0][1].type, 'paint');
  assert.equal(seen[0][1].isTrusted, false);
  canvas.onpaint = 42;
  assert.equal(canvas.onpaint, null, 'non-callable coerces to null');
  createSchedulerHooks(env).firePaint(record, []);
  assert.equal(seen.length, 1);
  assert.throws(() => Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'onpaint').get.call({}), TypeError);
});

test('the onpaint content attribute is compiled lazily, sees `event`, and is superseded by a later attribute change', async (t) => {
  const { env, canvas, record } = await set(t, { canvasAttrs: 'content="drawable" onpaint="window.__hits = (window.__hits || []); window.__hits.push([this === document.getElementById(\'c\'), event.type])"' });
  t.cleanup(() => { delete window.__hits; });
  assert.equal(typeof canvas.onpaint, 'function');
  createSchedulerHooks(env).firePaint(record, []);
  assert.deepEqual(window.__hits, [[true, 'paint']]);
  canvas.onpaint = () => window.__hits.push('prop');
  createSchedulerHooks(env).firePaint(record, []);
  assert.equal(window.__hits.at(-1), 'prop');
  canvas.setAttribute('onpaint', 'window.__hits.push("attr2")');
  createSchedulerHooks(env).firePaint(record, []);
  assert.equal(window.__hits.at(-1), 'attr2', 'a changed content attribute supersedes the property');
  canvas.removeAttribute('onpaint');
  assert.equal(canvas.onpaint, null);
});

test('a content-attribute handler runs before listeners that the page adds later, once the canvas is mounted', async (t) => {
  const { env, canvas, record } = await set(t, { canvasAttrs: 'content="drawable" onpaint="window.__order.push(\'attr\')"' });
  window.__order = [];
  t.cleanup(() => { delete window.__order; });
  env.bus.emit(BUS.CANVAS_MOUNTED, { record });
  canvas.addEventListener('paint', () => window.__order.push('listener'));
  createSchedulerHooks(env).firePaint(record, []);
  assert.deepEqual(window.__order, ['attr', 'listener']);
});

test('framecap / frameCap: reflect the attribute, clamp at 240, default from the options', async (t) => {
  const { canvas } = await set(t, { options: { defaultFrameCap: 15 } });
  assert.equal(canvas.frameCap, 15, 'missing');
  canvas.setAttribute('framecap', '30');
  assert.equal(canvas.frameCap, 30);
  canvas.setAttribute('framecap', 'abc');
  assert.equal(canvas.frameCap, 15, 'invalid');
  canvas.setAttribute('framecap', '999');
  assert.equal(canvas.frameCap, 240);
  canvas.frameCap = 12.7;
  assert.equal(canvas.getAttribute('framecap'), '12');
  canvas.frameCap = 300;
  assert.equal(canvas.getAttribute('framecap'), '240');
  canvas.frameCap = 0;
  assert.equal(canvas.getAttribute('framecap'), '0');
  assert.equal(canvas.frameCap, 0);
});

// ---------------------------------------------------------------------------------------------- requestPaint
test('requestPaint reaches the scheduler for a managed canvas and is a silent no-op otherwise', async (t) => {
  const { world, canvas, record, root } = await set(t);
  assert.equal(canvas.requestPaint(), undefined);
  assert.deepEqual(world.calls.requestPaint, [record]);
  const plain = document.createElement('canvas');
  root.append(plain);
  plain.requestPaint();
  record.state = 'detached';
  canvas.requestPaint();
  assert.equal(world.calls.requestPaint.length, 1);
  assert.throws(() => HTMLCanvasElement.prototype.requestPaint.call({}), TypeError);
});

test('requestPaint on a canvas without content=drawable still fires ONE empty paint at the next frame (WPT get-element-transform removes content and waits for a paint)', async (t) => {
  const { root, world } = await set(t);
  const plain = document.createElement('canvas');
  root.append(plain);
  const seen = [];
  plain.addEventListener('paint', (e) => seen.push([e.type, Array.from(e.changedElements), e instanceof CanvasPaintEvent]));
  let handled = 0;
  plain.onpaint = () => { handled++; };
  plain.requestPaint();
  plain.requestPaint();
  assert.equal(seen.length, 0, 'never synchronous');
  await frames(2);
  assert.deepEqual(seen, [['paint', [], true]], 'once, however often it was requested');
  assert.equal(handled, 1, 'the onpaint handler runs too');
  assert.equal(world.calls.requestPaint.length, 0, 'no scheduler involved: the canvas is not managed');
  const detached = document.createElement('canvas');
  detached.addEventListener('paint', () => seen.push(['detached']));
  detached.requestPaint();
  await frames(2);
  assert.equal(seen.length, 1, 'a canvas that is not in the document does not paint');
});

test('requestPaint adopts a connected content=drawable canvas the registry has not seen yet', async (t) => {
  const { world, root } = await set(t);
  const fresh = document.createElement('canvas');
  fresh.setAttribute('content', 'drawable');
  root.append(fresh);
  world.onAdopt = (canvas) => { world.addCanvas(canvas, { drawables: [] }); };
  fresh.requestPaint();
  assert.equal(world.calls.adopt.includes(fresh), true);
  assert.equal(world.calls.requestPaint.length, 1);
  assert.equal(world.calls.requestPaint[0].canvas, fresh);
});

// ---------------------------------------------------------------------------------------------- captureElementImage / ElementImage
test('captureElementImage returns an immutable ElementImage pinned to the newest version', async (t) => {
  const { canvas, el, store, version } = await set(t);
  const a = canvas.captureElementImage(el);
  assert.ok(a instanceof ElementImage);
  assert.equal(Object.prototype.toString.call(a), '[object ElementImage]');
  assert.deepEqual([a.width, a.height], [40, 20]);
  assert.equal(version.refs, 1, 'pinned');
  store.commit(el, { width: 60, height: 30 });
  const b = canvas.captureElementImage(el);
  assert.deepEqual([a.width, a.height], [40, 20], 'A keeps the old snapshot');
  assert.deepEqual([b.width, b.height], [60, 30]);
});

test('ElementImage.width/height follow the CURRENT canvas bitmap size, and are 0 once closed', async (t) => {
  const { canvas, el, version } = await set(t);
  const image = canvas.captureElementImage(el);
  canvas.width = 200;
  canvas.height = 50;
  assert.deepEqual([image.width, image.height], [80, 10], '40 * 200/100, 20 * 50/100');
  image.close();
  assert.deepEqual([image.width, image.height], [0, 0]);
  image.close();
  assert.equal(version.refs, 0, 'close is idempotent and unpins once');
});

test('ElementImage: no constructor, wrong receiver, toImageBitmap copies the border box, a closed image refuses', async (t) => {
  const { canvas, el } = await set(t);
  assert.throws(() => new ElementImage(), TypeError);
  assert.throws(() => Object.getOwnPropertyDescriptor(ElementImage.prototype, 'width').get.call({}), TypeError);
  const image = canvas.captureElementImage(el);
  const bitmap = await image.toImageBitmap();
  assert.deepEqual([bitmap.width, bitmap.height], [40, 20]);
  image.close();
  let err = null;
  try { await image.toImageBitmap(); } catch (e) { err = e; }
  assert.equal(err?.name, 'InvalidStateError');
});

test('captureElementImage exceptions follow the table of API-CONTRACT 6.1', async (t) => {
  const { world, canvas, el, root, record, store, env, version } = await set(t);
  assert.throws(() => canvas.captureElementImage(), TypeError);
  assert.throws(() => canvas.captureElementImage({}), TypeError);
  assert.throws(() => canvas.captureElementImage('el'), TypeError);
  const loose = document.createElement('div');
  root.append(loose);
  throwsDom(() => canvas.captureElementImage(loose), 'InvalidStateError');
  store.drop(el);
  throwsDom(() => canvas.captureElementImage(el), 'InvalidStateError');
  store.commit(el, { canvasId: record.id });
  const plain = document.createElement('canvas');
  root.append(plain);
  throwsDom(() => plain.captureElementImage(el), 'InvalidStateError');
  const image = createElementImage(env, record, store.version(el));
  image.close();
  assert.throws(() => canvas.captureElementImage(image), TypeError); // the IDL takes an Element only
  record.state = 'detached';
  throwsDom(() => canvas.captureElementImage(el), 'InvalidStateError');
  assert.equal(world.reports.unsupported.length, 0);
});

test('an ElementImage of another canvas is an InvalidStateError for capture; the originating element being gone is InvalidStateError', async (t) => {
  const { world, canvas, el, root, record, env, version } = await set(t);
  const other = document.createElement('canvas');
  const otherEl = document.createElement('div');
  other.append(otherEl);
  root.append(other);
  const otherRecord = world.addCanvas(other, { drawables: [otherEl] });
  world.store.commit(otherEl, { canvasId: otherRecord.id });
  const image = canvas.captureElementImage(el);
  assert.throws(() => other.captureElementImage(image), TypeError, 'an ElementImage is not an Element: TypeError before any canvas check');
  assert.throws(() => canvas.captureElementImage(image), TypeError, 'captureElementImage takes an Element only: an ElementImage would pin a newer version than the one passed in');
  assert.ok(canvas.getElementTransform(image) instanceof DOMMatrix, 'the geometry methods still accept an ElementImage');
  record.drawables.delete(el);
  throwsDom(() => canvas.getElementTransform(image), 'InvalidStateError');
});

test('SVG drawable: an inner SVG element (<rect drawable>) throws svg-drawable from capture and the geometry methods, reported; an outermost <svg drawable> is not refused (X-13)', async (t) => {
  const { world, canvas, root } = await set(t);
  canvas.insertAdjacentHTML('beforeend', '<svg id="s"><rect id="r" drawable width="10" height="10"/></svg>');
  const rect = canvas.querySelector('#r');
  for (const call of [() => canvas.captureElementImage(rect), () => canvas.getElementTransform(rect), () => canvas.updateElementGeometry(rect), () => canvas.clearElementGeometry(rect)]) {
    let err;
    try { call(); } catch (e) { err = e; }
    assert.equal(err?.feature, 'svg-drawable');
    assert.equal(err.name, 'NotSupportedError');
    assert.equal(err.code, 9);
    assert.ok(err.hint.includes('outermost <svg>'));
  }
  assert.equal(world.reports.unsupported.length, 4);
  canvas.insertAdjacentHTML('beforeend', '<svg id="o" drawable width="10" height="10"></svg>');
  const outer = canvas.querySelector('#o');
  for (const call of [() => canvas.captureElementImage(outer), () => canvas.getElementTransform(outer)]) {
    let err;
    try { call(); } catch (e) { err = e; }
    assert.notEqual(err?.feature, 'svg-drawable', 'an outermost <svg> is a CSS box: never refused as svg-drawable');
  }
  assert.equal(world.reports.unsupported.length, 4, 'nothing reported for the outermost <svg>');
  assert.equal(world.reports.unsupported[0].feature, 'svg-drawable');
  assert.equal(world.reports.unsupported[0].canvas, canvas);
});

// ---------------------------------------------------------------------------------------------- geometry methods
test('updateElementGeometry / getElementTransform / clearElementGeometry round trip', async (t) => {
  const { canvas, el, record, version } = await set(t);
  const identity = canvas.getElementTransform(el);
  assert.ok(identity instanceof DOMMatrix);
  assert.equal(identity.isIdentity, true);
  assert.notEqual(canvas.getElementTransform(el), canvas.getElementTransform(el), 'a new DOMMatrix each call');
  assert.equal(canvas.updateElementGeometry(el, { canvasTransform: { a: 2, d: 3, e: 10, f: 20 }, clip: { x: 1, y: 2, width: 3, height: 4 } }), undefined);
  const m = canvas.getElementTransform(el);
  assert.deepEqual([m.a, m.b, m.c, m.d, m.e, m.f], [2, 0, 0, 3, 10, 20]);
  assert.equal(m.is2D, true);
  m.a = 99;
  assert.equal(canvas.getElementTransform(el).a, 2, 'a copy');
  const clip = record.geometry.byElement.get(el).clip;
  assert.deepEqual([clip.x, clip.y, clip.width, clip.height], [1, 2, 3, 4]);
  assert.equal(record.layerCalls.applyGeometry.at(-1).layoutOffset, version.layoutOffset);
  assert.equal(canvas.clearElementGeometry(el), undefined);
  assert.equal(canvas.getElementTransform(el).isIdentity, true);
  assert.equal(record.layerCalls.applyGeometry.at(-1).geometry, null, 'the live element loses its correction');
  assert.deepEqual(record.geometry.order, []);
});

test('updateElementGeometry: 3D matrices are kept, canvasClip is accepted, clip wins, ElementImage targets resolve to the element', async (t) => {
  const { canvas, el, record } = await set(t);
  canvas.updateElementGeometry(el, { canvasTransform: { m11: 2, m34: 0.001, m43: 5 } });
  const m = canvas.getElementTransform(el);
  assert.equal(m.is2D, false);
  assert.deepEqual([m.m11, m.m34, m.m43], [2, 0.001, 5]);
  canvas.updateElementGeometry(el, { canvasClip: { width: 7 } });
  assert.equal(record.geometry.byElement.get(el).clip.width, 7);
  canvas.updateElementGeometry(el, { clip: { width: 8 }, canvasClip: { width: 9 } });
  assert.equal(record.geometry.byElement.get(el).clip.width, 8);
  const image = canvas.captureElementImage(el);
  canvas.updateElementGeometry(image, { canvasTransform: { e: 3 } });
  assert.equal(canvas.getElementTransform(image).e, 3);
  canvas.clearElementGeometry(image);
  assert.equal(canvas.getElementTransform(el).isIdentity, true);
});

test('updateElementGeometry: invalid init is a TypeError (even before the element is checked), and it needs no snapshot', async (t) => {
  const { canvas, el, store, root } = await set(t);
  assert.throws(() => canvas.updateElementGeometry(el, { canvasTransform: { a: 1, m11: 2 } }), TypeError);
  assert.throws(() => canvas.updateElementGeometry(el, { canvasTransform: { is2D: true, m13: 1 } }), TypeError);
  canvas.updateElementGeometry(el, { clip: { x: NaN } }); // DOMRectInit is unrestricted double
  assert.throws(() => canvas.updateElementGeometry(el, 5), TypeError);
  assert.throws(() => canvas.updateElementGeometry(), TypeError);
  const stray = document.createElement('div');
  root.append(stray);
  assert.throws(() => canvas.updateElementGeometry(stray, { canvasTransform: { a: 1, m11: 2 } }), TypeError);
  store.drop(el);
  canvas.updateElementGeometry(el, { canvasTransform: { e: 1 } });
  assert.equal(canvas.getElementTransform(el).e, 1);
});

test('geometry methods: InvalidStateError for ineligible elements and unmanaged canvases (WPT error-conditions)', async (t) => {
  const { canvas, el, root, record } = await set(t);
  const stray = document.createElement('div');
  root.append(stray);
  const nested = document.createElement('span');
  el.append(nested);
  for (const m of ['getElementTransform', 'updateElementGeometry', 'clearElementGeometry']) {
    throwsDom(() => canvas[m](stray), 'InvalidStateError');
    throwsDom(() => canvas[m](nested), 'InvalidStateError');
  }
  const plain = document.createElement('canvas');
  root.append(plain);
  throwsDom(() => plain.getElementTransform(el), 'InvalidStateError');
  record.state = 'detached';
  for (const m of ['getElementTransform', 'updateElementGeometry', 'clearElementGeometry']) throwsDom(() => canvas[m](el), 'InvalidStateError');
});

test('updateElementGeometry rank: last updated is top-most; preserveHitTestOrder keeps the place of a listed element', async (t) => {
  const { canvas, el, record, world } = await set(t);
  const b = document.createElement('div');
  canvas.append(b);
  record.drawables.add(b);
  canvas.updateElementGeometry(el);
  canvas.updateElementGeometry(b);
  assert.deepEqual(record.geometry.order, [el, b]);
  canvas.updateElementGeometry(el, { preserveHitTestOrder: true });
  assert.deepEqual(record.geometry.order, [el, b]);
  canvas.updateElementGeometry(el);
  assert.deepEqual(record.geometry.order, [b, el]);
  const c = document.createElement('div');
  canvas.append(c);
  record.drawables.add(c);
  canvas.updateElementGeometry(c, { preserveHitTestOrder: true });
  assert.deepEqual(record.geometry.order, [b, el, c], 'not listed yet: appended');
  assert.equal(world.reports.caught.length, 0);
});

test('getElementTransform(element, drawTransform) returns the matrix a draw with that transform would store (S^-1 D S), without changing state', async (t) => {
  const { canvas, el, record } = await set(t, { version: { originX: 0, originY: 0 } });
  canvas.width = 200;
  canvas.height = 200;
  const draw = new DOMMatrix([1, 0, 0, 1, 20, 10]);
  const m = canvas.getElementTransform(el, draw);
  assert.deepEqual([m.a, m.d, m.e, m.f], [1, 1, 10, 5], 'S^-1 * D * S with S = scale(2): the draw transform acts on the element at its natural grid size (WPT get-element-transform)');
  assert.equal(record.geometry.byElement.has(el), false);
  assert.equal(canvas.getElementTransform(el).isIdentity, true);
  assert.equal(canvas.getElementTransform(el, undefined).isIdentity, true);
  assert.throws(() => canvas.getElementTransform(el, { a: 1, m11: 2 }), TypeError);
});

test('the two-argument getElementTransform is standard: it does not depend on legacyNames', async (t) => {
  const { canvas, el } = await set(t, { options: { legacyNames: false } });
  assert.equal(canvas.getElementTransform(el, new DOMMatrix([1, 0, 0, 1, 20, 10])).isIdentity, false);
});

test('methods look like platform methods', async (t) => {
  await set(t);
  const p = HTMLCanvasElement.prototype;
  assert.deepEqual(['requestPaint', 'captureElementImage', 'updateElementGeometry', 'clearElementGeometry', 'getElementTransform'].map((n) => [p[n].name, p[n].length]),
    [['requestPaint', 0], ['captureElementImage', 1], ['updateElementGeometry', 1], ['clearElementGeometry', 1], ['getElementTransform', 1]]);
  for (const n of ['requestPaint', 'captureElementImage', 'updateElementGeometry', 'clearElementGeometry', 'getElementTransform']) {
    assert.throws(() => p[n].call({}, document.body), TypeError, n);
  }
});

// ---------------------------------------------------------------------------------------------- width / height
test('canvas.width/height: original behaviour, grid scale refreshed from the layer, ONE paintNow microtask', async (t) => {
  const { world, canvas, record } = await set(t);
  canvas.width = 150;
  canvas.height = 80;
  canvas.width = 160;
  assert.deepEqual([canvas.width, canvas.height], [160, 80], 'the platform setter ran (and clears the bitmap)');
  assert.equal(record.layerCalls.syncPresentation, 3, 'each write refreshes the presentation');
  assert.equal(world.calls.paintNow.length, 0, 'not synchronously');
  await microtasks();
  assert.deepEqual(world.calls.paintNow, [record], 'one paint for the three writes');
  canvas.height = 90;
  await microtasks();
  assert.equal(world.calls.paintNow.length, 2);
});

test('canvas.width/height on an unmanaged or suspended canvas do not touch the scheduler; invalid values still throw as natively', async (t) => {
  const { world, canvas, record, root } = await set(t);
  const plain = document.createElement('canvas');
  root.append(plain);
  plain.width = 20;
  record.state = 'suspended';
  canvas.width = 50;
  await microtasks();
  assert.deepEqual([world.calls.paintNow.length, record.layerCalls.syncPresentation], [0, 0]);
  assert.equal(canvas.width, 50);
  canvas.width = '77';
  assert.equal(canvas.width, 77);
});

test('a width write inside a ResizeObserver callback repaints in a microtask BEFORE the next observer callback (same frame)', async (t) => {
  const { world, canvas, record } = await set(t);
  const log = [];
  const original = world.env.scheduler.paintNow;
  world.env.scheduler.paintNow = (r) => { log.push('paintNow'); return original(r); };
  const first = new ResizeObserver(() => { log.push('ro-app'); canvas.width = 120; });
  const second = new ResizeObserver(() => { log.push('ro-later'); });
  first.observe(canvas);
  second.observe(canvas);
  t.cleanup(() => { first.disconnect(); second.disconnect(); });
  await frames(3);
  assert.deepEqual(log.slice(0, 3), ['ro-app', 'paintNow', 'ro-later']);
  assert.equal(canvas.width, 120);
});

test('a canvas write queues no paint after the record was disposed', async (t) => {
  const { world, canvas, record } = await set(t);
  canvas.width = 30;
  record.state = 'disposed';
  await microtasks();
  assert.equal(world.calls.paintNow.length, 0);
});

// ---------------------------------------------------------------------------------------------- ledger
test('restoreAll removes every canvas member and puts the platform descriptors back', async (t) => {
  const before = {
    canvas: Object.getOwnPropertyNames(HTMLCanvasElement.prototype).join(),
    element: ['setAttribute', 'removeAttribute', 'toggleAttribute'].map((n) => Element.prototype[n]),
    width: Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width'),
  };
  const { world } = await set(t);
  assert.notEqual(Element.prototype.setAttribute, before.element[0]);
  const left = world.ledger.restoreAll();
  assert.deepEqual(left, []);
  assert.equal(Object.getOwnPropertyNames(HTMLCanvasElement.prototype).join(), before.canvas);
  assert.deepEqual(['setAttribute', 'removeAttribute', 'toggleAttribute'].map((n) => Element.prototype[n]), before.element);
  const w = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
  assert.deepEqual([w.get, w.set], [before.width.get, before.width.set]);
  assert.equal('drawElementImage' in CanvasRenderingContext2D.prototype, false);
  assert.equal('updateElementGeometry' in OffscreenCanvas.prototype, false);
});
