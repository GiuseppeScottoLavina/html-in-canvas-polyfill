#!/usr/bin/env node
// Gallery click-through for the CRT plugin (headless Chrome, trusted input): see plugins/_shared/gallery-click.mjs. Then the controls:
// the preset picker is mounted on Arcade (the default), Monitor moves every slider to its values, a slider moved by hand shows Custom;
// the flicker keeps the effect animating and flicker 0 lets the host go idle. `--record` also writes media/crt.webp and the README
// thumbnail docs/media/plugins/crt.webp.
//   npm run build && node plugins/crt/test/gallery.e2e.mjs [--record]
import { join } from 'node:path';
import { UNIFORM_FLOATS, bezelWidth, cornerRadius, mapCrtPoint, meta, presets } from '../index.js';
import { runGalleryClickThrough } from '../../_shared/gallery-click.mjs';
import { ROOT, checklist, framesDuring, openGallery, rectOf, sleep, startRecording, writeWebp } from '../../_shared/gallery-e2e.mjs';

/** @type {Float32Array|null} */ let state = null;
await runGalleryClickThrough({
  name: 'crt',
  async setup(ctx) {
    // the barrel of the default options, for the canvas size of the page (the same numbers render() writes)
    const { w, h } = ctx.canvas;
    state = new Float32Array(UNIFORM_FLOATS);
    state[2] = w; state[3] = h; state[4] = meta.defaults.curvature * 0.5; state[5] = bezelWidth(w, h); state[6] = cornerRadius(w, h);
  },
  mapFor: () => (p) => mapCrtPoint(/** @type {Float32Array} */ (state), p),
  // the CRT flickers on its own: no pointer needed to animate it
  animate: async () => {},
});
const clickThroughCode = process.exitCode;

const c = checklist('crt controls in the gallery');
const g = await openGallery('crt');
try {
  const { page } = g;
  const ui = (/** @type {string} */ js) => page.evaluate(`(() => { const box = document.querySelector('#effect-controls .hic-crt-ui'); ${js} })()`);
  const values = () => ui(`return { preset: box.querySelector('select').value, sliders: Object.fromEntries([...box.querySelectorAll('input[type=range]')].map((r) => [r.id.replace(/^hic-crt-\\d+-/, ''), Number(r.value) / 100])) };`);
  const first = await values();
  c.check('the preset picker is mounted on Arcade and the sliders show the arcade preset (meta.defaults)', first.preset === 'arcade' && meta.defaults === presets.arcade
    && Object.entries(first.sliders).every(([k, v]) => Math.abs(v - /** @type {any} */ (presets.arcade)[k]) < 0.006), first);
  await ui(`const s = box.querySelector('select'); s.value = 'monitor'; s.dispatchEvent(new Event('change'));`);
  await sleep(200);
  const monitor = await values();
  c.check('choosing Monitor moves every slider to the monitor preset', monitor.preset === 'monitor' && Object.entries(monitor.sliders).every(([k, v]) => Math.abs(v - /** @type {any} */ (presets.monitor)[k]) < 0.006), monitor);
  await ui(`const r = box.querySelector('input[id$="-glow"]'); r.value = '90'; r.dispatchEvent(new Event('input'));`);
  await sleep(200);
  c.check('a slider moved by hand shows Custom in the picker', (await values()).preset === '');
  await ui(`const s = box.querySelector('select'); s.value = 'arcade'; s.dispatchEvent(new Event('change'));`);
  await page.evaluate(`document.getElementById('stage').frameCap = 120`);
  await page.mouseMove(5, 5);
  await sleep(800);
  const animated = await framesDuring(page, 1000);
  c.check('the arcade preset flickers: the screen keeps animating', animated >= 40, { framesPerSecond: animated });
  await ui(`const r = box.querySelector('input[id$="-flicker"]'); r.value = '0'; r.dispatchEvent(new Event('input'));`);
  await sleep(800);
  const still = await framesDuring(page, 1000);
  c.check('flicker 0: nothing animates, the host goes idle', still <= 2, { framesPerSecond: still });
  await ui(`const s = box.querySelector('select'); s.value = 'arcade'; s.dispatchEvent(new Event('change'));`);

  if (process.argv.includes('--record')) {
    const stage = await rectOf(page, '#stage');
    await sleep(800);
    const stop = await startRecording(page);
    await sleep(1800);
    await page.evaluate(`(() => { const m = document.getElementById('message'); m.focus(); m.setSelectionRange(m.value.length, m.value.length); })()`);
    await page.typeText(' Insert coin to continue.');
    await sleep(1400);
    const frames = await stop();
    // the form side at 1:1 (one CSS px per pixel), so the scanlines and the phosphor stripes survive the encoding; the thumbnail is the whole screen
    const near = { x: stage.x + stage.w - 600, y: stage.y + 24, w: 576, h: 324 };
    const bytes = writeWebp(frames, join(ROOT, 'plugins/crt/media/crt.webp'), near, { width: 576, fps: 10, quality: 58 });
    const crop = { x: stage.x, y: stage.y, w: stage.w, h: stage.h };
    c.check('recording: media/crt.webp under 500 KB', bytes < 500 * 1024, { screencastFrames: frames.length, bytes });
    const thumb = writeWebp(frames, join(ROOT, 'docs/media/plugins/crt.webp'), crop, { width: 264, fps: 6, quality: 60 });
    c.check('recording: the README thumbnail docs/media/plugins/crt.webp under 80 KB', thumb < 80 * 1024, { bytes: thumb });
  }
  const errors = await page.evaluate('window.__e2e.errors');
  c.check('no effecterror', errors.length === 0, errors);
} finally {
  await g.close();
}
c.finish();
if (clickThroughCode) process.exitCode = clickThroughCode;
