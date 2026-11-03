// A script that changes the timing of a paused (or finished, idle) animation inside a drawable repaints the drawable (observers/animation-observer.js): a seek
// (currentTime, startTime), finish(), reverse(), a playback rate change or an effect edit changes the rendering of the children, so natively the paint event fires,
// but no event announces it and the frame-hook loop only follows running animations. Before the timing hooks a page that paused every animation and seeked it 15
// times a second (a scrubber, a timeline editor) got 0 paint events per second: the canvas stayed frozen at the pause.
// Oracle: the canvas after each change equals a full rebuild of the drawable (an attribute change on it), and (positive control) the change is visible: the canvas
// before it differs from that rebuild. Controls: a seek to the current time and a seek of an animation outside the canvas paint nothing.
import { test, assert } from '/test/unit/lib/t.js';
import { install } from '/src/index.js';
import { inst, sleep } from '../api-core/_real.mjs';

const STYLE = '@keyframes hic-seek{from{transform:translateX(0)}to{transform:translateX(150px)}} .hic-seek{animation:hic-seek 1s linear infinite}';
const DRAWABLE = '<div id="d" drawable style="width:220px;height:80px;background:#fff">'
  + '<div id="css" class="hic-seek" style="width:40px;height:30px;background:rgb(200,0,0)"></div>'
  + '<div id="waapi" style="width:40px;height:30px;background:rgb(0,90,200)"></div></div>';

/** @param {any} t */
async function rig(t) {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.append(style);
  t.cleanup(() => style.remove());
  const i = inst(t);
  const host = document.createElement('div');
  host.innerHTML = `<canvas content="drawable" width="240" height="100" style="width:240px;height:100px">${DRAWABLE}</canvas>`
    + '<div id="out" class="hic-seek" style="width:40px;height:30px;background:#0a0"></div>';
  document.body.append(host);
  t.cleanup(() => host.remove());
  const c = /** @type {HTMLCanvasElement} */ (host.querySelector('canvas'));
  const ctx = /** @type {any} */ (c.getContext('2d'));
  const d = /** @type {HTMLElement} */ (host.querySelector('#d'));
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (host.querySelector(`#${id}`));
  const waapi = $('waapi').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(150px)' }], { duration: 1000, iterations: Infinity });
  t.cleanup(() => waapi.cancel());
  let paints = 0;
  c.onpaint = () => { paints++; ctx.reset(); ctx.drawElementImage(d, 0, 0); };
  c.requestPaint();
  await i.whenPainted(c);
  const css = /** @type {Animation} */ ($('css').getAnimations()[0]);
  const out = /** @type {Animation} */ ($('out').getAnimations()[0]);
  for (const a of [css, waapi, out]) { a.pause(); a.currentTime = 0; }
  /** settled: no paint for 250 ms (bounded: 3 s) */
  const settle = async () => {
    for (let k = 0; k < 12; k++) { const n = paints; await sleep(250); if (n === paints) return; }
  };
  await settle();
  const pixels = () => ctx.getImageData(0, 0, c.width, c.height).data;
  /** @param {Uint8ClampedArray} a @param {Uint8ClampedArray} b @returns {number} pixels more than 32 levels apart in a channel */
  const differing = (a, b) => { let n = 0; for (let k = 0; k < a.length; k += 4) if (Math.abs(a[k] - b[k]) > 32 || Math.abs(a[k + 1] - b[k + 1]) > 32 || Math.abs(a[k + 2] - b[k + 2]) > 32) n++; return n; };
  let serial = 0;
  /** a whole rebuild of the drawable: what the canvas must show */
  const truth = async () => { d.setAttribute('data-truth', String(++serial)); await settle(); return pixels(); };
  await truth();
  return { i, css, waapi, out, pixels, differing, settle, truth, paints: () => paints };
}

/** @type {Array<[string, (r: {css: Animation, waapi: Animation}) => void]>} */
const CHANGES = [
  ['paused CSS animation: currentTime', (r) => { r.css.currentTime = 400; }],
  ['paused element.animate(): currentTime', (r) => { r.waapi.currentTime = 600; }],
  ['paused CSS animation: startTime (it plays from then on; paused again)', (r) => { r.css.startTime = /** @type {number} */ (document.timeline.currentTime) - 800; r.css.pause(); }],
  ['paused element.animate(): updateTiming() (a delay)', (r) => { r.waapi.effect?.updateTiming({ delay: -300 }); }],
  ['paused element.animate(): setKeyframes()', (r) => { /** @type {KeyframeEffect} */ (r.waapi.effect).setKeyframes([{ transform: 'translateX(20px)' }, { transform: 'translateX(120px)' }]); }],
  ['paused element.animate(): cancel() (back to the unanimated style)', (r) => { r.waapi.cancel(); }],
  ['idle element.animate(): finish() (its end state, filled forwards: 40 % into the last iteration)', (r) => { r.waapi.effect?.updateTiming({ iterations: 1.4, fill: 'forwards', delay: 0 }); r.waapi.finish(); }],
  ['finished element.animate(): currentTime (back inside the active interval, paused)', (r) => { r.waapi.pause(); r.waapi.currentTime = 100; }],
];

test('a script that seeks or retimes a paused, finished or idle animation repaints the drawable: the canvas equals a full rebuild after each change', async (t) => {
  const r = await rig(t);
  /** @type {string[]} */
  const stale = [];
  /** @type {string[]} */
  const invisible = [];
  for (const [name, change] of CHANGES) {
    const before = r.pixels();
    change(r);
    await r.settle();
    const after = r.pixels();
    const want = await r.truth();
    if (r.differing(before, want) < 20) invisible.push(name);
    const off = r.differing(after, want);
    if (off > 0) stale.push(`${name}: ${off} px`);
  }
  assert.ok(invisible.length === 0, `positive control: every change moves a box (else the comparison proves nothing); unchanged: ${invisible.join('; ')}`);
  assert.ok(stale.length === 0, `the canvas shows each change without any other damage; stale: ${stale.join('; ')}`);
}, { timeout: 60000 });

test('pausing every animation and seeking it to the timeline 15 times a second paints at that rate (it painted 0 times a second)', async (t) => {
  const r = await rig(t);
  const n = r.paints();
  const timer = setInterval(() => {
    for (const a of document.getAnimations()) { if (a.playState !== 'paused') a.pause(); a.currentTime = document.timeline.currentTime; }
  }, 1000 / 15);
  t.cleanup(() => clearInterval(timer));
  await sleep(1000);
  clearInterval(timer);
  const painted = r.paints() - n;
  assert.ok(painted >= 8 && painted <= 20, `about one paint per seek (15 in 1 s): ${painted}`);
  await r.settle();
  const after = r.pixels();
  assert.equal(r.differing(after, await r.truth()), 0, 'the last seek is on the canvas');
}, { timeout: 20000 });

test('a seek to the current time, or of an animation outside the canvas, paints nothing; several changes in one task paint once', async (t) => {
  const r = await rig(t);
  const n = r.paints();
  r.css.currentTime = r.css.currentTime;
  r.waapi.pause();
  r.waapi.playbackRate = r.waapi.playbackRate;
  r.out.currentTime = 700;
  r.out.effect?.updateTiming({ delay: -100 });
  await sleep(400);
  assert.equal(r.paints(), n, 'no paint after seeks that change nothing inside the canvas');
  r.css.currentTime = 300;
  r.waapi.currentTime = 500;
  r.waapi.updatePlaybackRate(2);
  await r.settle();
  assert.equal(r.paints(), n + 1, 'positive control: the changes inside the canvas paint, once for the task');
}, { timeout: 20000 });

test('uninstall restores every timing member of Animation, AnimationEffect and KeyframeEffect by identity', async () => {
  /** @returns {Map<string, PropertyDescriptor|undefined>} */
  const snapshot = () => {
    const out = new Map();
    for (const proto of [Animation.prototype, AnimationEffect.prototype, KeyframeEffect.prototype, Element.prototype]) {
      for (const key of Reflect.ownKeys(proto)) out.set(`${proto.constructor.name}.${String(key)}`, Object.getOwnPropertyDescriptor(proto, key));
    }
    return out;
  };
  /** @param {Map<string, PropertyDescriptor|undefined>} a @param {Map<string, PropertyDescriptor|undefined>} b @returns {string[]} */
  const changed = (a, b) => [...a].filter(([key, d]) => ['value', 'get', 'set'].some((f) => !Object.is(/** @type {any} */ (d)?.[f], /** @type {any} */ (b.get(key))?.[f]))).map(([key]) => key);
  const before = snapshot();
  const i = install();
  const patched = changed(before, snapshot());
  i.uninstall();
  for (const key of ['Animation.currentTime', 'Animation.startTime', 'Animation.pause', 'Animation.finish', 'Animation.cancel', 'Animation.reverse', 'Animation.updatePlaybackRate', 'Animation.playbackRate', 'AnimationEffect.updateTiming', 'KeyframeEffect.setKeyframes', 'KeyframeEffect.target']) {
    assert.ok(patched.includes(key), `positive control: the install patches ${key} (patched: ${patched.join(', ')})`);
  }
  assert.deepEqual(changed(before, snapshot()), [], 'nothing is left patched');
});
