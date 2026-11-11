#!/usr/bin/env node
// The ink plugin in the plugin gallery (examples/plugins/?effect=ink) in headless Chrome with trusted input (CDP): at rest the host
// renders nothing; a hovering pointer stirs the page (the presented pixels change) and it heals by itself to the very picture it was; a
// pressed pointer releases pigment and selects no text; a trusted click on the DRAWN position of the checkbox, where the browser's own
// hit test finds something else, toggles it (and a click on its DOM position, where the ink shows something else, does not); typing
// reaches the drawn field; the frame cap bounds the effect frames; the actions from the gallery's buttons (handle.trigger), superseding,
// settled(); the demo gives way to a press; reduced motion; no console error. `--record` also writes media/ink.webp.
//   npm run build && node plugins/ink/test/gallery.e2e.mjs [--record]     (`npm run test:plugins` runs every gallery e2e)
import { join } from 'node:path';
import { ROOT, actionChecks, changed, checklist, clickOn, drag, framesDuring, idle, openGallery, rectOf, shot, sleep, startRecording, writePreview } from '../../_shared/gallery-e2e.mjs';
import { CHANNELS } from '../sim.js';
import { G, GLOBALS_LENGTH, INK_LIFE, mapInkPoint } from '../index.js';

const c = checklist('ink gallery e2e');
// the uniform block and the field that the plugin uploads, read where the page writes them (the state of its input mapper)
const WATCH = `(() => { const q = GPUQueue.prototype; const wb = q.writeBuffer, wt = q.writeTexture; window.__ig = null; window.__if = null;
  q.writeBuffer = function (buf, off, data, ...rest) { if (buf && buf.label === 'hic-ink-globals' && data) window.__ig = Array.from(data); return wb.call(this, buf, off, data, ...rest); };
  q.writeTexture = function (dst, data, ...rest) { if (dst && dst.texture && dst.texture.label === 'hic-ink-field') window.__if = Array.from(data); return wt.call(this, dst, data, ...rest); }; })();`;
const g = await openGallery('ink', { initScript: WATCH });
const { page } = g;
console.log(`Chrome ${g.chrome}, plugin bundle ${g.bundle.bytes} bytes (minified)`);
try {
  const st = await page.evaluate(`({ mode: window.__gallery.mode, controls: document.querySelectorAll('#effect-controls input[type=range]').length })`);
  c.check('the gallery runs the effect on WebGPU and mounts the plugin controls (three sliders) inside the drawn form', st.mode === 'effect' && st.controls === 3, st);
  const stage = await rectOf(page, '#stage');
  const park = () => page.mouseMove(stage.x + 5, stage.y + stage.h - 5);
  await park();
  c.check('the ink is at rest after the selection', await idle(page, 600, 12000));
  const atRest = await framesDuring(page, 3000);
  c.check('at rest: no effect frame in 3 s (zero work while nothing moves)', atRest === 0, { effectFrames: atRest });
  const calm = (await shot(page)).img;
  /** a pointer path across the left half of the page (text, no control) */
  const sweep = async (/** @type {number} */ steps, /** @type {number} */ stepMs) => {
    for (let i = 0; i <= steps; i += 1) {
      await page.mouseMove(stage.x + stage.w * (0.06 + 0.36 * (i / steps)), stage.y + stage.h * (0.42 + 0.14 * Math.sin((i / steps) * Math.PI * 2)));
      await sleep(stepMs);
    }
  };
  const during = framesDuring(page, 700);
  await sweep(24, 16);
  const stirred = changed((await shot(page)).img, calm, 16);
  c.check('a hovering pointer stirs the page: the presented pixels change', stirred.px > 1500, stirred);
  const movingFrames = await during;
  c.check('while the ink moves the host renders it (more than 20 frames in 0.7 s)', movingFrames > 20, { effectFrames: movingFrames });
  await park();
  let t0 = Date.now();
  c.check('the page heals by itself: the host goes idle again', await idle(page, 400, 8000), { ms: Date.now() - t0 });
  const back = changed((await shot(page)).img, calm, 0);
  c.check('at rest the picture is the still picture again, pixel for pixel', back.px === 0, back);

  // a pressed pointer: pigment, and no text selected under the path (the path crosses the headline and the paragraph)
  const strokePath = () => Array.from({ length: 25 }, (_, i) => [stage.x + stage.w * (0.05 + 0.36 * (i / 24)), stage.y + stage.h * (0.2 + 0.3 * (i / 24))]);
  await drag(page, strokePath(), { stepMs: 16 });
  const inked = await shot(page);
  /** pixels of the left half that became clearly coloured (the pigment), against the calm frame */
  const coloured = (/** @type {any} */ img) => { let n = 0; for (let y = 0; y < img.height; y += 1) for (let x = 0; x < img.width / 2; x += 1) { const i = (y * img.width + x) * 4, r = img.data[i], gg = img.data[i + 1], b = img.data[i + 2]; if (Math.max(r, gg, b) - Math.min(r, gg, b) > 70 && Math.abs(r - calm.data[i]) + Math.abs(gg - calm.data[i + 1]) + Math.abs(b - calm.data[i + 2]) > 90) n += 1; } return n; };
  const ink = coloured(inked.img);
  c.check('a pressed pointer releases pigment along its path (coloured pixels)', ink > 1500, { colouredPixels: ink });
  const selected = await page.evaluate('String(getSelection())');
  c.check('and selects no text of the page it crosses', selected === '', { selected });
  await park();
  t0 = Date.now();
  c.check('the pigment is gone by itself: idle again', await idle(page, 400, 9000), { ms: Date.now() - t0 });
  c.check('and the picture is the still picture again, pixel for pixel', changed((await shot(page)).img, calm, 0).px === 0);
  // control: with selectText the same drag selects text (so the check above can fail)
  await page.evaluate(`window.__gallery.handle.setOptions({ selectText: true })`);
  await drag(page, strokePath(), { stepMs: 16 });
  const selectedNow = await page.evaluate('String(getSelection())');
  c.check('control: with the option selectText the same drag selects text', selectedNow.length > 10, { length: selectedNow.length });
  await page.evaluate(`(getSelection().removeAllRanges(), window.__gallery.handle.setOptions({ selectText: false }), window.__gallery.handle.trigger('clear'))`);
  await park();
  await idle(page, 400, 9000);

  // ---- a click through the displaced picture ----------------------------------------------------------------------------------------
  // The page is pushed aside next to the checkbox and left to heal slowly (heal 0, flow 0: the water stops, the page takes seconds), so
  // the picture holds still enough to aim. The plugin's own mapper (the formula that the GPU tests hold to the pixels), over the field the
  // page uploaded, says where the checkbox is DRAWN; the click goes to a drawn point that is not in its DOM box.
  await page.evaluate(`window.__gallery.handle.setOptions({ heal: 0, flow: 0, pigment: 0, intensity: 1 })`);
  const box = await rectOf(page, '#consent');
  const canvas = await page.evaluate(`(() => { const e = document.getElementById('stage'); const r = e.getBoundingClientRect(); return { x: r.left + e.clientLeft, y: r.top + e.clientTop, w: e.clientWidth, h: e.clientHeight }; })()`);
  // a pressed drag from the plain page left of the checkbox, down and to the right across it
  const pushPath = Array.from({ length: 13 }, (_, i) => [box.x - 30 + 6 * i, box.y - 30 + 6 * i]);
  await drag(page, pushPath, { stepMs: 12 });
  await park();
  await sleep(650);
  const read = async () => {
    const s = await page.evaluate(`({ g: window.__ig, f: window.__if })`);
    const state = new Float32Array(GLOBALS_LENGTH + s.f.length);
    state.set(s.g); state.set(s.f, GLOBALS_LENGTH);
    return state;
  };
  const state = await read();
  const map = (/** @type {number} */ x, /** @type {number} */ y) => { const m = mapInkPoint(state, { x: x - canvas.x, y: y - canvas.y, width: canvas.w, height: canvas.h }); return { x: m.x + canvas.x, y: m.y + canvas.y }; };
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  /** the point outside the checkbox's DOM box (by 3 CSS px or more) that shows the middle of the checkbox best */
  const findAim = () => {
    let best = null;
    for (let y = box.y - 70; y <= box.y + box.h + 70; y += 1) for (let x = box.x - 70; x <= box.x + box.w + 70; x += 1) {
      const out = Math.max(box.x - x, x - box.x - box.w, box.y - y, y - box.y - box.h);
      if (out < 3) continue;
      const m = map(x, y), off = Math.hypot(m.x - cx, m.y - cy);
      if (off < 3 && (!best || off < best.off)) best = { x, y, out, off, drawn: m };
    }
    return best;
  };
  /** the point of the checkbox's DOM box where the ink shows something farthest from the checkbox */
  const findMiss = () => {
    let best = null;
    for (let y = box.y + 3; y <= box.y + box.h - 3; y += 1) for (let x = box.x + 3; x <= box.x + box.w - 3; x += 1) {
      const m = map(x, y), away = Math.max(box.x - m.x, m.x - box.x - box.w, box.y - m.y, m.y - box.y - box.h);
      if (away >= 6 && (!best || away > best.away)) best = { x, y, away, drawn: m };
    }
    return best;
  };
  const click = async (/** @type {{x: number, y: number}} */ p) => { await page.mouseMove(p.x, p.y); await page.mouseDown(p.x, p.y); await page.mouseUp(p.x, p.y); await sleep(150); };
  const checked = () => page.evaluate(`document.getElementById('consent').checked`);
  const active = state[G.MOVED] > 0.5 && state.length === GLOBALS_LENGTH + (state[G.GRID] + 4) * (state[G.GRID + 1] + 4) * CHANNELS;
  // control first: a click in the checkbox's DOM box, where the ink draws something else
  const miss = active ? findMiss() : null;
  const shiftAt = (() => { const m = map(cx, cy); return Math.round(Math.hypot(m.x - cx, m.y - cy) * 10) / 10; })();
  if (c.check('the ink draws something else over the DOM box of the checkbox (found with the plugin mapper over the uploaded field)', !!miss, { miss, active, displacedByPx: shiftAt })) {
    const before = await checked();
    await click(miss);
    const after = await checked();
    c.check('control: a click at the DOM position of the checkbox, where the ink draws something else, does not toggle it', after === before, { before, after });
    // (that press pushed the water again: let it stop, and aim on the newest field)
    await park();
    await sleep(650);
    state.set(await read());
  }
  const aim = findAim();
  if (c.check('the checkbox is drawn where a click natively reaches something else', !!aim, aim)) {
    const natively = await page.evaluate(`(() => { const e = document.elementFromPoint(${aim.x}, ${aim.y}); return e && (e.id || e.localName); })()`);
    const was = await checked();
    await click(aim);
    const now = await checked();
    c.check('a trusted click on the DRAWN position of the checkbox toggles it', natively !== 'consent' && now !== was, { nativelyUnder: natively, before: was, after: now });
  }
  await page.evaluate(`(window.__gallery.handle.setOptions({ heal: 0.5, flow: 0.5, pigment: 0.7, intensity: 0.6 }), window.__gallery.handle.trigger('clear'))`);
  await park();
  await idle(page, 400, 9000);

  // typing: the pointer stirs its way to the name field, a click focuses it (a press on a field drops no ink on it), the typing shows
  await sweep(24, 16);
  await clickOn(page, '#name');
  await sleep(200);
  await page.typeText('x');
  await sleep(150);
  const typed = await page.evaluate(`({ active: document.activeElement && document.activeElement.id, name: document.getElementById('name').value })`);
  c.check('a trusted click through the moving picture focuses the drawn name field and typing reaches it', typed.active === 'name' && typed.name === 'Adax', typed);
  await idle(page, 400, 9000);
  const field = await rectOf(page, '#name');
  const withX = await shot(page);
  await page.evaluate(`(document.getElementById('name').value = 'Ada', document.activeElement.blur())`);
  await park();
  await idle(page, 400, 9000);
  const without = changed((await shot(page)).img, withX.img, 16);
  c.check('and the typed letter was drawn in the field (the picture differs there once it is removed)', without.px > 5 && !!without.box && without.box.x >= field.x - stage.x - 4 && without.box.y >= field.y - stage.y - 4, without);

  // the frame cap bounds the effect frames while the ink moves
  await page.evaluate(`document.getElementById('stage').frameCap = 30`);
  await page.evaluate(`window.__capDemo = window.__gallery.handle.trigger('demo'); 0`);
  await sleep(200);
  const at30 = await framesDuring(page, 1000);
  c.check('frame cap 30: at most about 30 effect frames per second while the ink moves', at30 >= 15 && at30 <= 33, { framesPerSecond: at30 });
  const capped = await page.evaluate('window.__capDemo');
  c.check('and the demo still ends at rest at that cap', capped === 'still', { state: capped });
  await page.evaluate(`document.getElementById('stage').frameCap = 0`);
  await idle(page, 400, 9000);

  // the actions of the effect handle, as a page uses them (the gallery's buttons call handle.trigger)
  await actionChecks(page, (n, ok, d) => c.check(n, ok, d), [
    { action: 'demo', state: 'still', midMs: 700, minChanged: 4000 },
    { action: 'stir', state: 'still', midMs: 300, minChanged: 800 },
    { action: 'clear', state: 'still', moves: false },
  ], { older: 'demo', newer: 'stir', state: 'still' });
  await idle(page, 400, 9000);
  await park();
  await idle(page, 400, 9000);
  const beforeDemo = (await shot(page)).img;
  const demo = await page.evaluate(`(async () => { const t = performance.now(); const state = await window.__gallery.handle.trigger('demo'); return { state, ms: Math.round(performance.now() - t) }; })()`);
  c.check('the demo resolves still within 4.6 s', demo.state === 'still' && demo.ms < 4600 && demo.ms > 1300 + INK_LIFE * 1000, demo);
  c.check('and ends on the picture it started from, pixel for pixel', changed((await shot(page)).img, beforeDemo, 0).px === 0);
  // user input takes over: a press during the demo
  await page.evaluate(`window.__taken = undefined; window.__gallery.handle.trigger('demo').then((s) => { window.__taken = s; }); 0`);
  await sleep(300);
  await page.mouseMove(stage.x + stage.w * 0.2, stage.y + stage.h * 0.8);
  await page.mouseDown(stage.x + stage.w * 0.2, stage.y + stage.h * 0.8); await page.mouseUp(stage.x + stage.w * 0.2, stage.y + stage.h * 0.8);
  await sleep(100);
  const taken = await page.evaluate('window.__taken');
  c.check('a press during the demo takes over: the demo resolves null', taken === null, { state: taken });
  await park();
  await idle(page, 400, 9000);

  if (process.argv.includes('--record')) {
    await page.evaluate(`(document.getElementById('name').value = 'Ada', document.activeElement && document.activeElement.blur())`);
    const stop = await startRecording(page);
    await page.evaluate(`window.__gallery.handle.trigger('demo'); 0`);
    await sleep(2300);
    // a stirring hand: two turns of a pressed pointer over the text
    const turns = Array.from({ length: 70 }, (_, i) => { const a = (i / 70) * 4 * Math.PI, r = 50 + 45 * (i / 70); return [stage.x + stage.w * 0.25 + r * Math.cos(a), stage.y + stage.h * 0.55 + r * Math.sin(a)]; });
    await drag(page, turns, { stepMs: 16 });
    await sleep(500);
    await clickOn(page, '#name');
    await sleep(200);
    await page.typeText(' Lovelace', { intervalMs: 70 });
    await park();
    await sleep(2400);
    const frames = await stop();
    writePreview(frames, 'ink', { x: stage.x, y: stage.y, w: stage.w, h: stage.h }, c.check);
  }
  const errors = [...page.errors({ includeWarnings: false }).map((/** @type {any} */ e) => e.text), ...(await page.evaluate('window.__e2e.errors'))];
  c.check('no console error, page exception or effecterror', errors.length === 0, errors.slice(0, 3));
} finally {
  await g.close();
}

// prefers-reduced-motion: nothing flows. Pointer moves change nothing, a click still reaches the drawn field, a press on the page leaves
// a tint that fades in place, and the demo resolves at once.
const r = await openGallery('ink', { reducedMotion: true });
try {
  const page = r.page;
  const stage = await rectOf(page, '#stage');
  await page.mouseMove(stage.x + 5, stage.y + stage.h - 5);
  await sleep(800);
  const still = (await shot(page)).img;
  const idleFrames = await framesDuring(page, 1000);
  for (let i = 0; i <= 24; i += 1) { await page.mouseMove(stage.x + stage.w * (0.06 + 0.36 * (i / 24)), stage.y + stage.h * 0.45); await sleep(16); }
  await page.mouseMove(stage.x + 5, stage.y + stage.h - 5);
  await sleep(300);
  const after = changed((await shot(page)).img, still, 16);
  c.check('reduced motion: no animation while idle (at most 2 effect frames in one second)', idleFrames <= 2, { idleFrames });
  c.check('reduced motion: pointer moves stir nothing (the presented pixels stay put)', after.px < 50, after);
  await clickOn(page, '#name');
  await sleep(200);
  const s = await page.evaluate(`({ active: document.activeElement && document.activeElement.id })`);
  c.check('reduced motion: a click focuses the drawn name field', s.active === 'name', s);
  await page.evaluate(`document.activeElement.blur()`);
  await sleep(200);
  const base = (await shot(page)).img;
  const px = stage.x + stage.w * 0.2, py = stage.y + stage.h * 0.75;
  await page.mouseMove(px, py); await page.mouseDown(px, py); await page.mouseUp(px, py);
  await sleep(300);
  await page.mouseMove(stage.x + 5, stage.y + stage.h - 5);
  const tint = changed((await shot(page)).img, base, 16);
  const near = !!tint.box && Math.abs(tint.box.x + tint.box.w / 2 - stage.w * 0.2) < 12 && Math.abs(tint.box.y + tint.box.h / 2 - stage.h * 0.75) < 12 && tint.box.w < 90;
  c.check('reduced motion: a press leaves a tint where it landed, and it does not move', tint.px > 300 && near, tint);
  const t0 = Date.now();
  const gone = await idle(page, 400, 6000);
  c.check('reduced motion: the tint fades out by itself and the picture is the still one again', gone && changed((await shot(page)).img, base, 0).px === 0, { ms: Date.now() - t0 });
  const demo = await page.evaluate(`(async () => { const t = performance.now(); return { state: await window.__gallery.handle.trigger('demo'), ms: Math.round(performance.now() - t) }; })()`);
  c.check('reduced motion: the demo resolves still at once', demo.state === 'still' && demo.ms < 100, demo);
  const errors = [...page.errors({ includeWarnings: false }).map((/** @type {any} */ e) => e.text), ...(await page.evaluate('window.__e2e.errors'))];
  c.check('reduced motion: no console error, page exception or effecterror', errors.length === 0, errors.slice(0, 3));
} finally {
  await r.close();
}
c.finish();
