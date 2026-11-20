// changedElements as Chromium builds it (LocalFrameView::DidPaintCanvasDrawable: every drawable REPAINTED in the frame, whether its pixels changed or not), for the two
// invalidations the polyfill reproduces (src/api/canvas-patch.js installSizeSetters, src/api/geometry.js):
//   size writes  HTMLCanvasElement::OnWidthOrHeightAssigned: a canvas with a 2D context whose size does not change is left alone; any other width / height write (property or
//                attribute; a new size, no context yet, a WebGL context) invalidates every descendant, so the next paint event lists every laid-out drawable
//   geometry     Element::SetCanvasTransform / SetCanvasClip / Clear*: a transform or clip set to a new value invalidates the element, listed in the next paint event
//                (the invalidation requests no frame of its own)
// Each expectation below is what Chrome 157 with CanvasDrawElement answered for the same page (2026-11-20, probe pages measured side by side with the polyfill).
// Issue #150: the official WICG webGL example attaches its paint handler after the first paint event and uploads only the drawables a later event lists; its
// ResizeObserver writes the unchanged size before the canvas has a context.
import { test, assert } from '/test/unit/lib/t.js';
import { inst, sleep } from '../api-core/_real.mjs';

const KIDS = '<div id="a" drawable style="width:100px;height:40px;background:rgb(200,0,0)">a</div><div id="b" drawable style="width:100px;height:40px;background:rgb(0,0,200)">b</div>';

/** @param {any} t @param {string} [extra] @returns {HTMLCanvasElement} */
function canvasWith(t, extra = '') {
  const host = document.createElement('div');
  host.innerHTML = `<canvas content="drawable" width="300" height="150">${KIDS}${extra}</canvas>`;
  document.body.append(host);
  t.cleanup(() => host.remove());
  return /** @type {HTMLCanvasElement} */ (host.firstElementChild);
}

/** every paint event of `canvas` as the ids it lists */
function recorder(canvas) {
  /** @type {string[][]} */
  const seen = [];
  canvas.addEventListener('paint', (e) => seen.push(Array.from(/** @type {any} */ (e).changedElements, (el) => /** @type {Element} */ (el).id)));
  return seen;
}

/** waits until `seen` has more than `n` events (or `ms` passed) and returns the events after the first n */
async function after(seen, n, ms = 1500) {
  const end = performance.now() + ms;
  while (seen.length <= n && performance.now() < end) await sleep(10);
  await sleep(120);
  return seen.slice(n);
}

/** a canvas past its first paint (both drawables listed), quiet */
async function settled(t, i, extra = '', context = '2d') {
  const c = canvasWith(t, extra);
  if (context) c.getContext(/** @type {any} */ (context));
  const seen = recorder(c);
  c.requestPaint();
  await i.whenPainted(c);
  await sleep(300);
  return { c, seen };
}

test('2D context, the same size written: nothing more is listed (native: the write is ignored)', async (t) => {
  const i = inst(t);
  const { c, seen } = await settled(t, i);
  const n = seen.length;
  c.width = c.width;
  c.requestPaint();
  const next = await after(seen, n);
  assert.ok(next.length >= 1, 'a paint event follows the requestPaint');
  assert.deepEqual(next.flat(), [], `nothing listed: ${JSON.stringify(next)}`);
});

test('2D context, a new size: the next paint event lists every drawable', async (t) => {
  const i = inst(t);
  const { c, seen } = await settled(t, i);
  const n = seen.length;
  c.width = 320;
  const next = await after(seen, n);
  assert.deepEqual(next[0], ['a', 'b']);
});

test('no context yet, the same size written (the WICG webGL example): the next paint event lists every drawable', async (t) => {
  const i = inst(t);
  const { c, seen } = await settled(t, i, '', null);
  const n = seen.length;
  c.width = c.width;
  c.height = c.height;
  const next = await after(seen, n);
  assert.deepEqual(next[0], ['a', 'b']);
});

test('a WebGL context, the same size written: the next paint event lists every drawable', async (t) => {
  const i = inst(t);
  const { c, seen } = await settled(t, i, '', 'webgl2');
  const n = seen.length;
  c.height = 150;
  const next = await after(seen, n);
  assert.deepEqual(next[0], ['a', 'b']);
});

test('the width attribute written with its own value, no context: the next paint event lists every drawable; an unrelated attribute lists nothing', async (t) => {
  const i = inst(t);
  const { c, seen } = await settled(t, i, '', null);
  let n = seen.length;
  c.setAttribute('data-x', '1');
  c.setAttribute('WIDTH', '300');
  c.requestPaint();
  const next = await after(seen, n);
  assert.deepEqual(next[0], ['a', 'b']);
  n = seen.length;
  c.setAttribute('title', 'x');
  c.requestPaint();
  assert.deepEqual((await after(seen, n)).flat(), []);
});

test('a drawable that is not laid out is not listed after a size write', async (t) => {
  const i = inst(t);
  const { c, seen } = await settled(t, i, '<div id="h" drawable style="display:none">h</div>', null);
  const n = seen.length;
  c.width = c.width;
  const next = await after(seen, n);
  assert.deepEqual(next[0], ['a', 'b']);
});

test('a size write inside a paint handler lists nothing more', async (t) => {
  const i = inst(t);
  const { c, seen } = await settled(t, i, '', null);
  let once = true;
  c.addEventListener('paint', () => { if (once) { once = false; c.width = c.width; } });
  const n = seen.length;
  c.requestPaint();
  await after(seen, n);
  const m = seen.length;
  c.requestPaint();
  assert.deepEqual((await after(seen, m)).flat(), []);
});

test('a drawable drawn for the first time is listed by the next paint event, which the draw does not fire by itself; the same draw again lists nothing', async (t) => {
  const i = inst(t);
  const { c, seen } = await settled(t, i);
  const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
  const b = /** @type {Element} */ (c.querySelector('#b'));
  c.onpaint = () => { ctx.reset(); ctx.drawElementImage(b, 0, 0); };
  let n = seen.length;
  c.requestPaint();
  assert.deepEqual((await after(seen, n))[0], [], 'the paint that draws it lists nothing');
  n = seen.length;
  await sleep(300);
  assert.equal(seen.length, n, 'no paint event of its own (native: 2 events, then the next requestPaint)');
  c.requestPaint();
  assert.deepEqual((await after(seen, n))[0], ['b'], 'listed by the next one');
  n = seen.length;
  c.requestPaint();
  assert.deepEqual((await after(seen, n)).flat(), [], 'the same draw (same transform) lists nothing');
});

test('updateElementGeometry with a new transform lists the element; the same transform, or options without one, list nothing; clearElementGeometry lists it', async (t) => {
  const i = inst(t);
  const { c, seen } = await settled(t, i);
  const a = /** @type {Element} */ (c.querySelector('#a'));
  const step = async (fn) => { const n = seen.length; fn(); c.requestPaint(); return (await after(seen, n)).flat(); };
  assert.deepEqual(await step(() => c.updateElementGeometry(a, { canvasTransform: new DOMMatrix().translate(10, 0) })), ['a']);
  assert.deepEqual(await step(() => c.updateElementGeometry(a, { canvasTransform: new DOMMatrix().translate(10, 0) })), []);
  assert.deepEqual(await step(() => c.updateElementGeometry(a, {})), []);
  assert.deepEqual(await step(() => c.clearElementGeometry(a)), ['a']);
});
