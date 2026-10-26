// watchVisibility (src/util/visibility.js) with the browser's real IntersectionObserver: no GPU needed.
import { test, assert, fixture, frames } from '/test/unit/lib/t.js';
import { watchVisibility, VISIBILITY_MARGIN } from '/src/util/visibility.js';

const env = { window };

/** A canvas placed at `top` px (page coordinates) inside a fixture; the page does not scroll in these tests. */
function placed(top, height = 100) {
  const root = fixture(`<canvas style="position:absolute;left:0;top:${top}px;width:200px;height:${height}px"></canvas>`);
  return /** @type {HTMLCanvasElement} */ (root.querySelector('canvas'));
}

/** Wait until `fn()` is true (IntersectionObserver reports a frame late), at most `n` frames. */
async function until(fn, n = 30) {
  for (let i = 0; i < n && !fn(); i += 1) await frames(1);
  return fn();
}

test('the margin is half the viewport (and half each scroll container)', () => {
  assert.equal(VISIBILITY_MARGIN, '50%');
});

test('a canvas far below the viewport is not visible; inside the margin it is (rendering resumes before it scrolls in); a partly visible canvas is visible', async (t) => {
  const vh = innerHeight;
  const canvas = placed(vh * 3);
  const changes = [];
  const w = watchVisibility(env, canvas, (v) => changes.push(v));
  t.cleanup(() => w.dispose());
  assert.equal(w.visible, true, 'visible until the first report');
  assert.ok(await until(() => !w.visible), 'far below: not visible');
  assert.deepEqual(changes, [false]);
  canvas.style.top = `${Math.round(vh * 1.3)}px`;   // below the viewport, but within half a viewport of it
  assert.ok(await until(() => w.visible), 'inside the margin: visible');
  canvas.style.top = `${Math.round(vh * 1.7)}px`;   // beyond the margin
  assert.ok(await until(() => !w.visible), 'beyond the margin: not visible');
  canvas.style.top = `${vh - 30}px`;   // 30 px of 100 on screen
  assert.ok(await until(() => w.visible), 'partly visible: visible');
  canvas.style.top = `${-vh * 2}px`;   // far above
  assert.ok(await until(() => !w.visible), 'far above: not visible');
  assert.deepEqual(changes, [false, true, false, true, false], 'one callback per change, none for the initial state');
});

test('a jump into view (scrollTo) is reported in the scroll steps of that frame, before its animation frame callbacks; the observer alone reports it a frame later (control)', async (t) => {
  const vh = innerHeight;
  const canvas = placed(vh * 3);
  const w = watchVisibility(env, canvas, () => {});
  let plain = true;   // the control: an IntersectionObserver with the same margin, without the scroll check
  const io = new IntersectionObserver((es) => { plain = es[es.length - 1].isIntersecting; }, { scrollMargin: '50%', rootMargin: '0px' });
  io.observe(canvas);
  t.cleanup(() => { w.dispose(); io.disconnect(); scrollTo(0, 0); });
  assert.ok(await until(() => !w.visible && !plain), 'far below: not visible');
  // the jump from a task (as a click handler does), not from an animation frame callback: a scroll made inside the rendering update is
  // dispatched in the next one, after the observer of the current one has already reported
  const inFrame = await new Promise((resolve) => setTimeout(() => {
    scrollTo(0, vh * 3 - 100);
    requestAnimationFrame(() => resolve({ watch: w.visible, observer: plain }));
  }, 0));
  assert.deepEqual(inFrame, { watch: true, observer: false }, 'in the first frame after the jump: the watch already says visible, the plain observer not yet');
  await frames(3);
  assert.equal(w.visible, true, 'and the observer confirms it');
  assert.equal(plain, true);
});

test('a jump that brings the box into the viewport while a scroll container still clips the canvas away: reported visible, then corrected by the observer', async (t) => {
  const vh = innerHeight;
  const root = fixture(`<div style="height:${vh * 6}px"></div><div id="sc" style="position:absolute;left:0;top:${vh * 3}px;width:300px;height:200px;overflow:auto">
    <div style="height:3000px;position:relative"><canvas style="position:absolute;left:0;top:${Math.round(vh * 0.9)}px;width:200px;height:50px"></canvas></div></div>`);
  const canvas = /** @type {HTMLCanvasElement} */ (root.querySelector('canvas'));
  const changes = [];
  const w = watchVisibility(env, canvas, (v) => changes.push(v));
  t.cleanup(() => { w.dispose(); scrollTo(0, 0); });
  assert.ok(await until(() => !w.visible));
  scrollTo(0, vh * 3);   // the scroller at the top of the viewport: the canvas box is inside the viewport plus the margin, its scroller clips it away
  assert.ok(await until(() => changes.length >= 3), `changes ${JSON.stringify(changes)}`);
  assert.deepEqual(changes, [false, true, false], 'resumed on the box test, paused again by the observer');
  await frames(3);
  assert.equal(w.visible, false);
});

test('display:none (nothing to see) is not visible', async (t) => {
  const canvas = placed(10);
  const w = watchVisibility(env, canvas, () => {});
  t.cleanup(() => w.dispose());
  await frames(3);
  assert.equal(w.visible, true);
  canvas.style.display = 'none';
  assert.ok(await until(() => !w.visible));
});

test('inside a scroll container: clipped away by more than half the container is not visible (scrollMargin); within it, visible', async (t) => {
  if (!('scrollMargin' in IntersectionObserver.prototype)) {
    console.warn('SKIPPED part: IntersectionObserver.scrollMargin is not supported by this browser');
    return;
  }
  const root = fixture(`<div id="sc" style="position:absolute;left:0;top:0;width:300px;height:200px;overflow:auto">
    <div style="height:2000px;position:relative"><canvas style="position:absolute;left:0;top:1000px;width:200px;height:50px"></canvas></div></div>`);
  const sc = /** @type {HTMLElement} */ (root.querySelector('#sc'));
  const canvas = /** @type {HTMLCanvasElement} */ (root.querySelector('canvas'));
  const w = watchVisibility(env, canvas, () => {});
  t.cleanup(() => w.dispose());
  assert.ok(await until(() => !w.visible), 'canvas 800 px below the scroller\'s clip: not visible');
  sc.scrollTop = 1000 - 200 - 60;   // the canvas is 60 px below the clip: inside the 100 px (50%) scroll margin
  assert.ok(await until(() => w.visible), 'within the scroll margin: visible');
  sc.scrollTop = 0;
  assert.ok(await until(() => !w.visible));
});

test('a hidden document is not visible; shown again, visible', async (t) => {
  const canvas = placed(10);
  const changes = [];
  const w = watchVisibility(env, canvas, (v) => changes.push(v));
  t.cleanup(() => { w.dispose(); delete document.visibilityState; });
  await frames(3);
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(w.visible, false);
  delete document.visibilityState;
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(w.visible, true);
  assert.deepEqual(changes, [false, true]);
});

test('the margin is given once: as scrollMargin where the engine has it (it also covers the document scroller), else as rootMargin', async (t) => {
  const seen = [];
  class Spy { constructor(cb, o) { seen.push(o); } observe() {} disconnect() {} }
  const canvas = placed(10);
  const a = watchVisibility({ window: { IntersectionObserver: class extends Spy {} } }, canvas, () => {});
  const B = class extends Spy {};
  Object.defineProperty(B.prototype, 'scrollMargin', { get: () => '0px' });
  const b = watchVisibility({ window: { IntersectionObserver: B } }, canvas, () => {});
  t.cleanup(() => { a.dispose(); b.dispose(); });
  assert.deepEqual(seen, [{ rootMargin: '50%', threshold: 0 }, { scrollMargin: '50%', threshold: 0 }]);
});

test('without IntersectionObserver the canvas always counts as visible (no pause)', async (t) => {
  const canvas = placed(innerHeight * 4);
  const w = watchVisibility({ window: { IntersectionObserver: undefined } }, canvas, () => assert.fail('no change expected'));
  t.cleanup(() => w.dispose());
  await frames(3);
  assert.equal(w.visible, true);
});

test('dispose disconnects: no callback after it', async () => {
  const canvas = placed(10);
  let calls = 0;
  const w = watchVisibility(env, canvas, () => { calls += 1; });
  await frames(3);
  w.dispose();
  canvas.style.top = `${innerHeight * 4}px`;
  document.dispatchEvent(new Event('visibilitychange'));
  await frames(4);
  assert.equal(calls, 0);
});
