// Paint timing of the official WPT files onpaint-fires-post-resize-observer, requestPaint (both flaky: the first paint of a mounted canvas landed 1-2 frames late and was
// counted by the test), onpaint-fires-post-intersection-observation-steps (the paint of a change came after the IntersectionObserver delivery of its frame) and
// onpaint-iframe-post-tree-order (the canvas of an iframe painted after the canvas that contains the iframe). Real install, real scheduler, content unique per test so
// no image cache can serve a snapshot.
import { test, assert } from '/test/unit/lib/t.js';
import { inst, sleep } from '../api-core/_real.mjs';
import { buildSvgMarkup, encodeSvgDataUrl } from '/src/snapshot/capture/svg-builder.js';
import { decodeDataUrl, decodedAtOnce } from '/src/snapshot/store/decode.js';

/** The WPT tests' "wait one frame": a rAF, then a task. */
const oneFrame = async () => { await new Promise(requestAnimationFrame); await new Promise((r) => setTimeout(r)); };
const nonce = () => Math.random().toString(36).slice(2);

/** @param {any} t @param {string} inner @returns {HTMLCanvasElement} */
function canvasWith(t, inner) {
  const host = document.createElement('div');
  host.innerHTML = `<canvas content="drawable" width="200" height="200">${inner}</canvas>`;
  document.body.append(host);
  t.cleanup(() => host.remove());
  return /** @type {HTMLCanvasElement} */ (host.firstElementChild);
}

test('a tile with its stylesheet lands in the microtask after src is set; control: the same sheet as an XHTML <style> inside the foreignObject does not', async () => {
  const css = `.q${nonce()}{background:rgb(0,200,0)}`;
  const root = `<div xmlns="http://www.w3.org/1999/xhtml" class="q" style="width:20px;height:20px">${nonce()}</div>`;
  const url = encodeSvgDataUrl(buildSvgMarkup(root, css, { x: 0, y: 0, width: 20, height: 20 }, { width: 20, height: 20 }, 1));
  const img = await decodeDataUrl(url);
  assert.equal(decodedAtOnce(img), true, 'the SVG <style> image is complete one microtask after src');
  const xhtml = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><foreignObject width="20" height="20"><style xmlns="http://www.w3.org/1999/xhtml">${css}</style>${root.replace(/>[^<]*</, `>${nonce()}<`)}</foreignObject></svg>`;
  const other = await decodeDataUrl(encodeSvgDataUrl(xhtml));
  assert.equal(decodedAtOnce(other), false, 'control: the XHTML <style> delays the load to a later task (decode() path)');
  assert.equal(other.complete && other.naturalWidth > 0, true, 'and still decodes');
});

test('the first paint of a mounted canvas fires in its first rendering update (before the task after the first rAF)', async (t) => {
  inst(t);
  const c = canvasWith(t, `<div drawable style="width:100px;height:100px;background:rgb(0,0,255)">${nonce()}</div>`);
  let paints = 0;
  c.addEventListener('paint', () => { paints++; });
  await oneFrame();
  assert.equal(paints, 1, 'painted once by the end of the first frame');
  await oneFrame();
  await oneFrame();
  assert.equal(paints, 1, 'and no late initial paint follows');
});

test('the paint of a change fires after the frame computed IntersectionObserver entries and before they are delivered', async (t) => {
  inst(t);
  const host = document.createElement('div');
  host.innerHTML = '<div class="io" style="position:absolute;top:-200px;left:0;width:100px;height:100px"></div>';
  document.body.append(host);
  t.cleanup(() => host.remove());
  const target = /** @type {HTMLElement} */ (host.firstElementChild);
  const c = canvasWith(t, `<div drawable class="child" style="width:100px;height:100px;background:green">${nonce()}</div>`);
  const child = /** @type {HTMLElement} */ (c.querySelector('.child'));
  const events = [];
  let setup = true;
  c.addEventListener('paint', () => {
    if (setup) return;
    events.push('paint');
    if (events.length === 1) target.style.top = '-150px';
  });
  const entries = [];
  const io = new IntersectionObserver((list) => { if (!setup) { events.push('intersection'); entries.push(list[0].isIntersecting); } });
  io.observe(target);
  t.cleanup(() => io.disconnect());
  await oneFrame();
  await oneFrame();
  setup = false;
  child.style.background = 'purple';
  target.style.top = '0px';
  await oneFrame();
  await oneFrame();
  assert.deepEqual(events, ['paint', 'intersection'], 'paint first, then the observation of the frame of the change');
  assert.deepEqual(entries, [true], 'the observation was computed before the paint handler moved the target');
  await oneFrame();
  await oneFrame();
  assert.deepEqual(entries, [true, false], 'the move made in the handler is observed in the next frame');
});

test('the canvas of a same-origin iframe inside a drawable paints before the canvases that contain the iframe', async (t) => {
  inst(t);
  const outer = canvasWith(t, '<div drawable style="width:300px;height:300px"><canvas id="inner" content="drawable" width="200" height="200"><div drawable style="width:200px;height:200px"><iframe style="width:100px;height:100px"></iframe></div></canvas></div>');
  const inner = /** @type {HTMLCanvasElement} */ (outer.querySelector('#inner'));
  const frame = /** @type {HTMLIFrameElement} */ (outer.querySelector('iframe'));
  const loaded = new Promise((r) => frame.addEventListener('load', r, { once: true }));
  frame.srcdoc = `<!doctype html><canvas id="c" width="50" height="50" content="drawable"><div drawable style="width:50px;height:50px;background:red">${nonce()}</div></canvas>`
    + '<script type="module">import { install } from "/src/index.js"; const i = install(); window.__ready = i.whenPainted(document.getElementById("c"));</script>';
  await loaded;
  const win = /** @type {any} */ (frame.contentWindow);
  for (let k = 0; k < 100 && !win.__ready; k++) await sleep(10);
  await win.__ready;
  t.cleanup(() => frame.remove());
  const child = win.document.getElementById('c');
  await sleep(100);
  const order = [];
  child.addEventListener('paint', () => order.push('iframeCanvas'));
  inner.addEventListener('paint', () => order.push('inner'));
  outer.addEventListener('paint', () => order.push('outer'));
  const painted = (/** @type {HTMLCanvasElement} */ c) => new Promise((r) => { c.addEventListener('paint', r, { once: true }); /** @type {any} */ (c).requestPaint(); });
  await Promise.all([painted(child), painted(inner), painted(outer)]);
  assert.deepEqual(order, ['iframeCanvas', 'inner', 'outer']);
});

test('a z-index change in the inline style of a drawable fires no paint (it is its own stacking context); control: a colour change in the same style fires one', async (t) => {
  inst(t);
  const c = canvasWith(t, `<div drawable id="za" style="width:50px;height:50px;background:blue;z-index:1">${nonce()}</div>`);
  const za = /** @type {HTMLElement} */ (c.querySelector('#za'));
  await oneFrame();
  await oneFrame();
  let paints = 0;
  c.addEventListener('paint', () => { paints++; });
  za.style.zIndex = '3';
  for (let i = 0; i < 4; i++) await oneFrame();
  assert.equal(paints, 0, 'no paint for z-index alone');
  za.style.zIndex = '4';
  za.style.background = 'green';
  for (let i = 0; i < 4; i++) await oneFrame();
  assert.equal(paints, 1, 'control: z-index together with a colour change paints');
});

test('a change made between frames is painted before the task the app queued in the next frame\'s rAF (WPT onpaint: "fire once if a canvas child changes")', async (t) => {
  inst(t);
  const c = canvasWith(t, `<div drawable id="ch" style="width:60px;height:60px;background:blue">${nonce()}</div>`);
  const ch = /** @type {HTMLElement} */ (c.querySelector('#ch'));
  for (let i = 0; i < 4; i++) await oneFrame();
  let paints = 0;
  let changed = [];
  c.addEventListener('paint', (e) => { paints++; changed = [.../** @type {any} */ (e).changedElements]; });
  ch.style.background = 'green';
  await oneFrame();
  assert.equal(paints, 1);
  assert.deepEqual(changed, [ch]);
  await oneFrame();
  assert.equal(paints, 1, 'and only once');
});
