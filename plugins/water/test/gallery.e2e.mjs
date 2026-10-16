#!/usr/bin/env node
// The water plugin in the plugin gallery (examples/plugins/?effect=water) in headless Chrome with trusted input (CDP): pointer moves
// raise ripples (the presented pixels change), a click through the rippling picture focuses the drawn name field and typing reaches it,
// the frame cap bounds the effect frames, the action drop from the gallery's button (handle.trigger), no console error. `--record` also writes media/water.webp.
//   npm run build && node plugins/water/test/gallery.e2e.mjs [--record]     (`npm run test:plugins` runs every gallery e2e)
import { join } from 'node:path';
import { ROOT, actionChecks, changed, checklist, clickOn, framesDuring, openGallery, rectOf, shot, sleep, startRecording, writeWebp } from '../../_shared/gallery-e2e.mjs';

const c = checklist('water gallery e2e');
const g = await openGallery('water');
const { page } = g;
console.log(`Chrome ${g.chrome}, plugin bundle ${g.bundle.bytes} bytes (minified)`);
try {
  const st = await page.evaluate(`({ mode: window.__gallery.mode, controls: document.getElementById('effect-controls').children.length })`);
  c.check('the gallery runs the effect on WebGPU and mounts the plugin controls inside the drawn form', st.mode === 'effect' && st.controls > 0, st);
  const stage = await rectOf(page, '#stage');
  await page.mouseMove(stage.x + 5, stage.y + stage.h - 5);
  await sleep(1500);   // earlier ripples (from the page load) die out
  const calm = (await shot(page)).img;
  /** a pointer path across the form */
  const sweep = async (/** @type {number} */ steps, /** @type {number} */ stepMs) => {
    for (let i = 0; i <= steps; i += 1) {
      await page.mouseMove(stage.x + stage.w * (0.15 + 0.7 * (i / steps)), stage.y + stage.h * (0.3 + 0.25 * Math.sin((i / steps) * Math.PI * 2)));
      await sleep(stepMs);
    }
  };
  await sweep(24, 16);
  const rippled = changed((await shot(page)).img, calm, 16);
  c.check('pointer moves raise ripples: the presented pixels change', rippled.px > 2000, rippled);

  await clickOn(page, '#name');
  await sleep(200);
  await page.typeText('x');
  await sleep(150);
  const s = await page.evaluate(`({ active: document.activeElement && document.activeElement.id, name: document.getElementById('name').value })`);
  c.check('a trusted click through the rippling picture focuses the drawn name field and typing reaches it', s.active === 'name' && s.name === 'Adax', s);
  await page.evaluate(`document.activeElement.blur()`);

  await page.evaluate(`document.getElementById('stage').frameCap = 30`);
  await sleep(300);
  const at30 = await framesDuring(page, 1000);
  await page.evaluate(`document.getElementById('stage').frameCap = 120`);
  c.check('frame cap 30: at most about 30 effect frames per second', at30 >= 15 && at30 <= 33, { framesPerSecond: at30 });

  // the action of the effect handle, as a page uses it (the gallery's button calls handle.trigger('drop'); a drop at the centre)
  await page.mouseMove(stage.x + 5, stage.y + stage.h - 5);
  await sleep(3500);   // the ripples of the pointer die out
  await actionChecks(page, (n, ok, d) => c.check(n, ok, d), [{ action: 'drop', state: 'calm', midMs: 250, minChanged: 1500 }],
    { older: 'drop', newer: 'drop', state: 'calm' }, { continuous: true });

  if (process.argv.includes('--record')) {
    await page.evaluate(`document.getElementById('name').value = 'Ada'`);
    // a stronger displacement than the default, so that a small preview shows it (the plugin's own intensity slider)
    await page.evaluate(`(() => { const r = document.querySelector('#effect-controls input[type=range]'); r.value = '60'; r.dispatchEvent(new Event('input')); })()`);
    await page.mouseMove(stage.x + 5, stage.y + stage.h - 5);
    await sleep(1500);
    const stop = await startRecording(page);
    await sweep(60, 30);
    await clickOn(page, '#email');
    await sleep(400);
    await sweep(30, 30);
    await sleep(800);
    const frames = await stop();
    const bytes = writeWebp(frames, join(ROOT, 'plugins/water/media/water.webp'), { x: stage.x, y: stage.y, w: stage.w, h: stage.h }, { width: 480, fps: 15, quality: 40 });
    c.check('recording: media/water.webp under 500 KB', bytes < 500 * 1024, { screencastFrames: frames.length, bytes });
  }
  const errors = [...page.errors({ includeWarnings: false }).map((/** @type {any} */ e) => e.text), ...(await page.evaluate('window.__e2e.errors'))];
  c.check('no console error, page exception or effecterror', errors.length === 0, errors.slice(0, 3));
} finally {
  await g.close();
}

// prefers-reduced-motion: calm water. Pointer moves and presses raise no ripple, nothing animates while idle, and a click still reaches the drawn field.
const r = await openGallery('water', { reducedMotion: true });
try {
  const page = r.page;
  const stage = await rectOf(page, '#stage');
  await page.mouseMove(stage.x + 5, stage.y + stage.h - 5);
  await sleep(800);
  const still = (await shot(page)).img;
  const idleFrames = await framesDuring(page, 1000);
  for (let i = 0; i <= 24; i += 1) { await page.mouseMove(stage.x + stage.w * (0.15 + 0.7 * (i / 24)), stage.y + stage.h * 0.45); await sleep(16); }
  await sleep(300);
  const after = changed((await shot(page)).img, still, 16);
  c.check('reduced motion: no animation while idle (at most 2 effect frames in one second)', idleFrames <= 2, { idleFrames });
  c.check('reduced motion: pointer moves raise no ripple (the presented pixels stay put, apart from the hover look of the controls)', after.px < 2000, after);
  await clickOn(page, '#name');
  await sleep(200);
  const s = await page.evaluate(`({ active: document.activeElement && document.activeElement.id })`);
  c.check('reduced motion: a click through the still water focuses the drawn name field', s.active === 'name', s);
  const calmFrame = (await shot(page)).img;
  const dropped = await page.evaluate(`window.__gallery.handle.trigger('drop')`);
  await sleep(300);
  const afterDrop = changed((await shot(page)).img, calmFrame, 16);
  c.check('reduced motion: the action drop starts no ripple and resolves calm at once', dropped === 'calm' && afterDrop.px < 2000, { state: dropped, ...afterDrop });
  const errors = [...page.errors({ includeWarnings: false }).map((/** @type {any} */ e) => e.text), ...(await page.evaluate('window.__e2e.errors'))];
  c.check('reduced motion: no console error, page exception or effecterror', errors.length === 0, errors.slice(0, 3));
} finally {
  await r.close();
}
c.finish();
