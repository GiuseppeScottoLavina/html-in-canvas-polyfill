// A drawable whose border box has no width or no height draws nothing, as natively (children of a content="drawable" canvas are shrink-to-fit):
// the first draw or capture of such an element logs one console warning that names the cause; a drawable with a size draws and stays silent.
import { test, assert } from '/test/unit/lib/t.js';
import { inst, mk, frames } from './_real.mjs';

/** Collects console.warn messages until the test ends. @param {any} t @returns {string[]} */
function warnings(t) {
  const seen = /** @type {string[]} */ ([]);
  const warn = console.warn;
  console.warn = (...a) => { seen.push(a.map(String).join(' ')); };
  t.cleanup(() => { console.warn = warn; });
  return seen;
}

/** @param {string[]} seen @returns {string[]} */
const zeroSize = (seen) => seen.filter((m) => /so nothing is drawn/.test(m));

/** The canvas 2D context with the polyfill's methods. @param {HTMLCanvasElement} c @returns {any} */
const ctx2d = (c) => c.getContext('2d');

test('a drawable of zero width (the playground report: a stage of absolutely positioned children) warns once, over several paints and captures', async t => {
  const seen = warnings(t);
  const i = inst(t);
  const c = await mk(t, i, {
    inner: '<div id="z" drawable><div class="stage" style="position:relative;width:100%;height:100vh"><div style="position:absolute;left:10px;top:10px;width:50px;height:20px;background:rgb(255,0,0)"></div></div></div>',
  });
  const z = /** @type {HTMLElement} */ (c.querySelector('#z'));
  const box = z.getBoundingClientRect();
  assert.equal(box.width, 0, 'shrink-to-fit: no in-flow content with an intrinsic width');
  assert.ok(box.height > 0, `the height is not zero (${box.height})`);
  const ctx = ctx2d(c);
  for (let k = 0; k < 3; k++) {
    ctx.drawElementImage(z, 0, 0);
    c.captureElementImage(z).close();
    c.requestPaint();
    await i.whenPainted(c);
    await frames(1);
  }
  const hits = zeroSize(seen);
  assert.equal(hits.length, 1, `one warning: ${seen.join(' | ')}`);
  assert.ok(hits[0].startsWith('[hic-live-polyfill] <div drawable> has a zero width, so nothing is drawn:'), hits[0]);
  assert.ok(/shrink-to-fit/.test(hits[0]) && /width: 100%/.test(hits[0]), hits[0]);
  const pixels = ctx.getImageData(0, 0, c.width, c.height).data;
  assert.ok(pixels.every((/** @type {number} */ v) => v === 0), 'nothing is drawn, as natively');
});

test('a drawable of zero height warns once with a height hint; capturing it warns too', async t => {
  const seen = warnings(t);
  const i = inst(t);
  const c = await mk(t, i, { inner: '<div id="h" drawable style="width:80px"><div style="position:absolute;width:20px;height:20px;background:rgb(0,0,255)"></div></div>' });
  const h = /** @type {HTMLElement} */ (c.querySelector('#h'));
  assert.equal(h.getBoundingClientRect().height, 0);
  c.captureElementImage(h).close();
  ctx2d(c).drawElementImage(h, 0, 0);
  const hits = zeroSize(seen);
  assert.equal(hits.length, 1, `one warning: ${seen.join(' | ')}`);
  assert.ok(hits[0].startsWith('[hic-live-polyfill] <div drawable> has a zero height, so nothing is drawn:'), hits[0]);
  assert.ok(/give it a height/.test(hits[0]), hits[0]);
});

test('positive control: a drawable with a size draws its pixels and logs no zero-size warning', async t => {
  const seen = warnings(t);
  const i = inst(t);
  const c = await mk(t, i);
  const ctx = ctx2d(c);
  const a = /** @type {Element} */ (c.querySelector('#a'));
  const red = () => { ctx.clearRect(0, 0, c.width, c.height); ctx.drawElementImage(a, 0, 0); return Array.from(ctx.getImageData(90, 40, 1, 1).data).join(); };
  // the first paint can precede the decoded raster of the drawable: wait for later paints, as other pixel tests do
  for (let k = 0; k < 20 && red() !== '255,0,0,255'; k++) { c.requestPaint(); await i.whenPainted(c); await frames(2); }
  { const px = red(); assert.equal(px, '255,0,0,255', `the red drawable is drawn: ${px}`); }
  c.captureElementImage(a).close();
  assert.equal(zeroSize(seen).length, 0, seen.join(' | '));
});
