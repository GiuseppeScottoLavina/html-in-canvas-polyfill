#!/usr/bin/env node
// The liquid-glass plugin in the plugin gallery (headless Chrome, trusted CDP input).
// 1. Click-through (plugins/_shared/gallery-click.mjs): the lens is brought next to a control by the pointer, pinned with the keyboard
//    (its "Pin lens" checkbox), and the control is clicked where the pinned lens draws it.
// 2. Touch (Chrome touch emulation, Input.dispatchTouchEvent): a finger drag that starts off the lens scrolls the page and leaves the
//    lens; a finger drag on the lens moves it and the page does not scroll; a tap on the lens focuses the field the lens shows.
// 3. The demo action (handle.trigger('demo')): it moves the lens, resolves 'free' within 4.5 s, and then the host does no work (no
//    effectframe in 3 s); also no effectframe in 3 s once the page has settled after load.
// `--record` also writes media/liquid-glass.webp (the demo).
//   npm run build && node plugins/liquid-glass/test/gallery.e2e.mjs [--record]
import { join } from 'node:path';
import * as H from '../../../test/harness/index.mjs';
import { UNIFORM_FLOATS, mapLensPoint, meta, writeLensGeometry } from '../index.js';
import { TARGETS, runGalleryClickThrough } from '../../_shared/gallery-click.mjs';
import { ROOT, checklist, framesDuring, idle, openGallery, rectOf, scrollRoom, shot, sleep, startRecording, writeWebp } from '../../_shared/gallery-e2e.mjs';

/** the mapper of the default lens at rest, centred on (cx, cy), on a w x h canvas */
function lensMapper(/** @type {number} */ w, /** @type {number} */ h, /** @type {number} */ cx, /** @type {number} */ cy) {
  const s = new Float32Array(UNIFORM_FLOATS);
  s[2] = w; s[3] = h;
  writeLensGeometry(s, { cx, cy, size: meta.defaults.size, aspect: 1.45, refraction: meta.defaults.refraction });
  return (/** @type {any} */ p) => mapLensPoint(s, p);
}

const plan = {
  name: 'liquid-glass',
  /** @type {(p: any) => (p: any) => {x: number, y: number}} */
  mapFor: () => (p) => ({ x: p.x, y: p.y }),
  async setup(/** @type {any} */ ctx) {
    const { w, h } = ctx.canvas;
    // a lens position near a control from which the lens draws that control away from its DOM position
    let pick = null;
    // the submit button first: it has no label around it, so the browser's hit test next to it cannot land on a label whose fractional
    // box the DOM rectangles round differently (the glass shifts a control by at most about 9 CSS px, so the click lands close to it)
    for (const target of [...TARGETS].sort((a, b) => Number(b.sel === '#submit') - Number(a.sel === '#submit'))) {
      const box = ctx.boxes.find((/** @type {any} */ b) => `#${b.id}` === target.sel);
      if (!box) continue;
      for (let r = 30; r <= 140 && !pick; r += 5) {
        for (let a = 0; a < 32 && !pick; a += 1) {
          const cx = Math.round(box.x + box.w / 2 + r * Math.cos((a * Math.PI) / 16));
          const cy = Math.round(box.y + box.h / 2 + r * Math.sin((a * Math.PI) / 16));
          if (cx < 0 || cy < 0 || cx > w || cy > h) continue;
          const map = lensMapper(w, h, cx, cy);
          if (ctx.findDrawn(() => map, [target])) pick = { cx, cy, target };
        }
      }
      if (pick) break;
    }
    if (!pick) throw new Error('no lens position draws a control away from its DOM position');
    // the lens follows the pointer there and comes to rest exactly under it, then it is pinned with the keyboard
    await ctx.moveTo(pick.cx, pick.cy);
    await H.sleep(1500);
    await ctx.page.evaluate(`document.querySelector('#effect-controls input[id$="-pinned"]').focus()`);
    await ctx.page.key(' ');
    await H.sleep(200);
    const pinned = await ctx.page.evaluate(`document.querySelector('#effect-controls input[id$="-pinned"]').checked`);
    if (!pinned) throw new Error('the lens could not be pinned');
    await ctx.page.evaluate(`document.activeElement.blur()`);
    const map = lensMapper(w, h, pick.cx, pick.cy);
    plan.mapFor = () => map;
    plan.targets = [pick.target];
  },
  /** @type {typeof TARGETS|undefined} */
  targets: undefined,
  // unpinned again: the pointer drags the lens across the form while frames are counted
  async animate(/** @type {any} */ ctx) {
    await ctx.page.evaluate(`(() => { const b = document.querySelector('#effect-controls input[id$="-pinned"]'); b.checked = false; b.dispatchEvent(new Event('change')); })()`);
    for (let k = 0; k < 60; k += 1) { await ctx.moveTo(200 + (k % 20) * 40, 150 + (k % 7) * 40); await H.sleep(30); }
  },
};
await runGalleryClickThrough(plan);
const clickThroughCode = process.exitCode;

/** pixels of `a` and `b` (decoded RGBA, the same size) inside `box` whose largest channel difference exceeds 24 */
function changedIn(/** @type {any} */ a, /** @type {any} */ b, /** @type {{x: number, y: number, w: number, h: number}} */ box) {
  let n = 0;
  for (let y = Math.max(0, Math.round(box.y)); y < Math.min(a.height, Math.round(box.y + box.h)); y += 1) {
    for (let x = Math.max(0, Math.round(box.x)); x < Math.min(a.width, Math.round(box.x + box.w)); x += 1) {
      const k = (y * a.width + x) * 4;
      if (Math.max(Math.abs(a.data[k] - b.data[k]), Math.abs(a.data[k + 1] - b.data[k + 1]), Math.abs(a.data[k + 2] - b.data[k + 2])) > 24) n += 1;
    }
  }
  return n;
}

const c = checklist('liquid-glass touch, demo and idle');
const g = await openGallery('liquid-glass', { width: 1200, height: 760 });
const { page } = g;
console.log(`Chrome ${g.chrome}, plugin bundle ${g.bundle.bytes} bytes (minified)`);
try {
  await page.evaluate(`document.getElementById('stage').frameCap = 120`);
  // the premise of the touch checks: the page can scroll (the gallery's own page is barely taller than the viewport)
  const room = await scrollRoom(page);
  c.check('premise: the page can scroll by several hundred px either way', room.up >= 300 && room.down >= 300, room);
  // the stage 100 px below the top of the viewport: the page can still scroll up by several hundred px
  await page.evaluate(`(() => { const r = document.getElementById('stage').getBoundingClientRect(); scrollTo(0, Math.max(0, scrollY + r.top - 100)); })()`);
  await page.mouseMove(2, 2);
  await sleep(600);
  c.check('the host goes idle after load', await idle(page, 400, 8000));
  const settledFrames = await framesDuring(page, 3000);
  c.check('zero work at rest: no effectframe in 3 s once the lens has settled', settledFrames === 0, { frames: settledFrames });

  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await sleep(200);
  const stage = await rectOf(page, '#stage');
  const W = stage.w - 2;
  const Hh = stage.h - 2;
  const lens = { x: 0.73 * W, y: 0.3 * Hh };   // its home (meta.defaults)
  const lensBox = (/** @type {{x: number, y: number}} */ p) => ({ x: p.x - 100, y: p.y - 70, w: 200, h: 140 });
  const scrollY = () => page.evaluate('scrollY');

  // a drag off the lens: the page scrolls (the finger moves down, so the page scrolls up), the lens stays
  const before = (await shot(page)).img;
  const y0 = await scrollY();
  await H.touchDrag(page, { x: stage.x + 0.2 * W, y: stage.y + 0.8 * Hh, dir: -1, step: 12, count: 14, intervalMs: 16 });
  await sleep(1200);
  const y1 = await scrollY();
  c.check('a finger drag that starts off the lens scrolls the page', y0 - y1 > 60, { before: y0, after: y1 });
  const afterScroll = (await shot(page)).img;
  const lensMoved = changedIn(before, afterScroll, lensBox(lens));
  c.check('and leaves the lens where it was', lensMoved < 200, { changedPx: lensMoved });
  await page.evaluate(`window.scrollTo(0, ${y0})`);
  await sleep(500);

  // a drag on the lens: the lens moves over the message field, the page does not scroll
  const form = await page.evaluate(`(() => { const s = document.getElementById('stage').getBoundingClientRect(); const r = document.getElementById('message').getBoundingClientRect(); return { x: r.left - s.left + r.width * 0.3, y: r.top - s.top + r.height / 2 }; })()`);
  const st0 = await rectOf(page, '#stage');
  const start = (await shot(page)).img;
  const yA = await scrollY();
  const steps = 24;
  const at = (/** @type {number} */ i) => [{ x: st0.x + lens.x + ((form.x - lens.x) * i) / steps, y: st0.y + lens.y + ((form.y - lens.y) * i) / steps, radiusX: 4, radiusY: 4, force: 1, id: 2 }];
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) });
  await sleep(60);
  for (let i = 1; i <= steps; i += 1) { await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(i) }); await sleep(16); }
  await sleep(250);   // the finger rests before it lifts: no flick
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(1500);
  const yB = await scrollY();
  // reported, not checked: the host's interposer may focus a control that the press of the drag started on (see the README)
  console.log(`focus after the drag on the lens: ${JSON.stringify(await page.evaluate('document.activeElement && (document.activeElement.id || document.activeElement.localName)'))}`);
  const moved = (await shot(page)).img;
  c.check('a finger drag on the lens does not scroll the page', Math.abs(yB - yA) <= 1, { before: yA, after: yB });
  const leftHome = changedIn(start, moved, lensBox(lens));
  const arrived = changedIn(start, moved, lensBox(form));
  c.check('it moves the lens: its home looks different and so does the place it was dropped', leftHome > 2000 && arrived > 2000, { leftHome, arrived });
  // the press of the drag may have focused a field (the host's interposer, see the README): its caret blinks, and the host renders that
  await page.evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
  await sleep(300);
  const frameAfterDrag = await framesDuring(page, 2000);
  c.check('the dropped lens comes to rest: no effectframe in 2 s', frameAfterDrag === 0, { frames: frameAfterDrag });

  // a tap at the centre of the lens: a native tap (the gesture was not claimed), so the field the lens shows takes the focus
  await page.evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
  const tap = [{ x: st0.x + form.x, y: st0.y + form.y, radiusX: 4, radiusY: 4, force: 1, id: 3 }];
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tap });
  await sleep(60);
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(400);
  const focused = await page.evaluate(`document.activeElement && document.activeElement.id`);
  c.check('a tap on the lens reaches the field it shows (the message field is focused)', focused === 'message', { focused });
  await page.evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page.mouseMove(2, 2);
  await idle(page, 400, 8000);

  // the demo, as the gallery runs it (handle.trigger): the lens tours the form and comes back to rest
  const demo = async () => {
    await page.evaluate(`(() => { window.__lgIntervals = []; window.__lgT = 0; window.__lgOn = window.__lgOn || (document.getElementById('stage').addEventListener('effectframe', () => { const n = performance.now(); if (window.__lgT) window.__lgIntervals.push(n - window.__lgT); window.__lgT = n; }), true); })()`);
    const t0 = Date.now();
    const f0 = await page.evaluate('window.__e2e.frames');
    const state = await page.evaluate(`window.__gallery.handle.trigger('demo')`);
    const seconds = (Date.now() - t0) / 1000;
    const frames = (await page.evaluate('window.__e2e.frames')) - f0;
    const iv = /** @type {number[]} */ (await page.evaluate('window.__lgIntervals.slice(1)')).sort((a, b) => a - b);
    const q = (/** @type {number} */ p) => +(iv[Math.min(iv.length - 1, Math.floor(p * iv.length))] ?? NaN).toFixed(2);
    return { state, seconds: +seconds.toFixed(2), frames, fps: +(frames / seconds).toFixed(1), p50: q(0.5), p95: q(0.95), max: q(0.999) };
  };
  const preDemo = (await shot(page)).img;
  const mid = sleep(1200).then(() => shot(page));
  const d = await demo();
  const midImg = (await mid).img;
  c.check('demo: resolves with the state it rests in, within 4.5 s', d.state === 'free' && d.seconds < 4.5, d);
  const tour = changedIn(preDemo, midImg, { x: 0, y: 0, w: preDemo.width, h: preDemo.height });
  c.check('demo: the lens really tours the form (the picture changes while it plays)', tour > 3000, { changedPx: tour });
  const afterDemo = await framesDuring(page, 3000);
  c.check('demo: then zero work at rest (no effectframe in 3 s)', afterDemo === 0, { frames: afterDemo });

  if (process.argv.includes('--record')) {
    const r = await rectOf(page, '#stage');
    const stop = await startRecording(page);
    await sleep(300);
    await demo();
    await sleep(300);
    const frames = await stop();
    const bytes = writeWebp(frames, join(ROOT, 'plugins/liquid-glass/media/liquid-glass.webp'), { x: r.x, y: r.y, w: r.w, h: r.h }, { width: 660, fps: 30, quality: 60 });
    c.check('recording: media/liquid-glass.webp under 500 KB', bytes < 500 * 1024, { screencastFrames: frames.length, bytes });
  }
  const errors = await page.evaluate('window.__e2e.errors');
  c.check('no effecterror', errors.length === 0, errors);
  const pageErrors = page.errors({ includeWarnings: false });
  c.check('no console error or page exception', pageErrors.length === 0, pageErrors);
} finally {
  await g.close();
}
c.finish();
if (clickThroughCode) process.exitCode = clickThroughCode;
