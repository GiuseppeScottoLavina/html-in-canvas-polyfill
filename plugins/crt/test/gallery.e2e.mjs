#!/usr/bin/env node
// Gallery click-through for the CRT plugin (headless Chrome, trusted input): see plugins/_shared/gallery-click.mjs. Then the interlace:
// the toggle is mounted and on, the alternating fields keep the effect animating with the flicker at 0, and turning interlace off too
// lets the host go idle. `--record` also writes media/crt.webp.
//   npm run build && node plugins/crt/test/gallery.e2e.mjs [--record]
import { join } from 'node:path';
import { UNIFORM_FLOATS, bezelWidth, cornerRadius, mapCrtPoint, meta } from '../index.js';
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

const c = checklist('crt interlace in the gallery');
const g = await openGallery('crt');
try {
  const { page } = g;
  const ui = (/** @type {string} */ js) => page.evaluate(`(() => { const box = document.querySelector('#effect-controls .hic-crt-ui'); ${js} })()`);
  const toggle = await ui(`const t = box.querySelector('input[type=checkbox]'); return { present: !!t, checked: t && t.checked, label: t && t.parentElement.textContent };`);
  c.check('the interlace toggle is mounted in the plugin controls and on by default (meta.defaults.interlace)', toggle.present && toggle.checked && meta.defaults.interlace === true, toggle);
  await page.evaluate(`document.getElementById('stage').frameCap = 120`);
  await ui(`const r = box.querySelectorAll('input[type=range]')[3]; r.value = '0'; r.dispatchEvent(new Event('input'));`);   // flicker 0
  await page.mouseMove(5, 5);
  await sleep(800);
  const fields = await framesDuring(page, 1000);
  c.check('flicker at 0, interlace on: the alternating fields keep the screen animating', fields >= 40, { framesPerSecond: fields });
  await ui(`const t = box.querySelector('input[type=checkbox]'); t.click();`);
  await sleep(800);
  const off = await framesDuring(page, 1000);
  c.check('flicker at 0, interlace off: nothing animates, the host goes idle', off <= 2, { framesPerSecond: off });
  await ui(`const t = box.querySelector('input[type=checkbox]'); t.click(); const r = box.querySelectorAll('input[type=range]')[3]; r.value = '50'; r.dispatchEvent(new Event('input'));`);

  if (process.argv.includes('--record')) {
    const stage = await rectOf(page, '#stage');
    await sleep(800);
    const stop = await startRecording(page);
    await sleep(2200);
    await page.evaluate(`(() => { const m = document.getElementById('message'); m.focus(); m.setSelectionRange(m.value.length, m.value.length); })()`);   // typing changes the picture: the old field combs for a moment
    await page.typeText(' Fields alternate at 60 Hz.');
    await sleep(1600);
    const frames = await stop();
    const bytes = writeWebp(frames, join(ROOT, 'plugins/crt/media/crt.webp'), { x: stage.x, y: stage.y, w: stage.w, h: stage.h }, { width: 560, fps: 15, quality: 45 });
    c.check('recording: media/crt.webp under 500 KB', bytes < 500 * 1024, { screencastFrames: frames.length, bytes });
  }
  const errors = await page.evaluate('window.__e2e.errors');
  c.check('no effecterror', errors.length === 0, errors);
} finally {
  await g.close();
}
c.finish();
if (clickThroughCode) process.exitCode = clickThroughCode;
