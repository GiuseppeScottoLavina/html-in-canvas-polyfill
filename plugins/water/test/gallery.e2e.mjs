#!/usr/bin/env node
// The water plugin in the plugin gallery (examples/plugins/?effect=water) in headless Chrome with trusted input (CDP): at rest the host
// renders nothing; pointer moves raise a wake (the presented pixels change) and the surface comes back to rest by itself; a click through
// the ripples focuses the drawn name field and typing reaches it; the frame cap bounds the effect frames while the water moves; the
// actions drop and demo from the gallery's buttons (handle.trigger), superseding, settled(); reduced motion; no console error.
// `--record` also writes media/water.webp; `--record --hero` also the README's hero, docs/media/hero.webp.
//   npm run build && node plugins/water/test/gallery.e2e.mjs [--record [--hero]]     (`npm run test:plugins` runs every gallery e2e)
import { join } from 'node:path';
import { ROOT, actionChecks, changed, checklist, clickOn, framesDuring, idle, openGallery, rectOf, shot, sleep, startRecording, writeWebp } from '../../_shared/gallery-e2e.mjs';

const c = checklist('water gallery e2e');
const g = await openGallery('water');
const { page } = g;
console.log(`Chrome ${g.chrome}, plugin bundle ${g.bundle.bytes} bytes (minified)`);
try {
  const st = await page.evaluate(`({ mode: window.__gallery.mode, controls: document.getElementById('effect-controls').children.length })`);
  c.check('the gallery runs the effect on WebGPU and mounts the plugin controls inside the drawn form', st.mode === 'effect' && st.controls > 0, st);
  const stage = await rectOf(page, '#stage');
  await page.mouseMove(stage.x + 5, stage.y + stage.h - 5);
  // whatever the gallery played on selection (a demo) settles; then nothing is rendered
  c.check('the water settles after the selection', await idle(page, 600, 12000));
  const atRest = await framesDuring(page, 3000);
  c.check('at rest: no effect frame in 3 s (zero work while the surface is still)', atRest === 0, { effectFrames: atRest });
  const calm = (await shot(page)).img;
  /** a pointer path across the form */
  const sweep = async (/** @type {number} */ steps, /** @type {number} */ stepMs) => {
    for (let i = 0; i <= steps; i += 1) {
      await page.mouseMove(stage.x + stage.w * (0.15 + 0.7 * (i / steps)), stage.y + stage.h * (0.3 + 0.25 * Math.sin((i / steps) * Math.PI * 2)));
      await sleep(stepMs);
    }
  };
  const during = framesDuring(page, 800);
  await sweep(24, 16);
  const rippled = changed((await shot(page)).img, calm, 16);
  c.check('pointer moves raise a wake: the presented pixels change', rippled.px > 2000, rippled);
  const movingFrames = await during;
  c.check('while the water moves the host renders it (more than 20 frames in 0.8 s)', movingFrames > 20, { effectFrames: movingFrames });
  await page.mouseMove(stage.x + 5, stage.y + stage.h - 5);
  const t0 = Date.now();
  c.check('the wake dies out by itself: the host goes idle again', await idle(page, 400, 8000), { ms: Date.now() - t0 });
  const back = changed((await shot(page)).img, calm, 16);
  c.check('at rest the picture is the still picture again', back.px < 50, back);

  await sweep(24, 16);
  await clickOn(page, '#name');
  await sleep(200);
  await page.typeText('x');
  await sleep(150);
  const s = await page.evaluate(`({ active: document.activeElement && document.activeElement.id, name: document.getElementById('name').value })`);
  c.check('a trusted click through the rippling picture focuses the drawn name field and typing reaches it', s.active === 'name' && s.name === 'Adax', s);
  await page.evaluate(`document.activeElement.blur()`);
  await page.mouseMove(stage.x + 5, stage.y + stage.h - 5);
  await idle(page, 400, 8000);

  // the frame cap bounds the effect frames while the water moves (the demo rains for about 1.6 s)
  await page.evaluate(`document.getElementById('stage').frameCap = 30`);
  await page.evaluate(`window.__capDemo = window.__gallery.handle.trigger('demo'); 0`);
  await sleep(200);
  const at30 = await framesDuring(page, 1000);
  c.check('frame cap 30: at most about 30 effect frames per second while the water moves', at30 >= 15 && at30 <= 33, { framesPerSecond: at30 });
  await page.evaluate('window.__capDemo');
  await page.evaluate(`document.getElementById('stage').frameCap = 0`);
  await idle(page, 400, 8000);

  // the actions of the effect handle, as a page uses them (the gallery's buttons call handle.trigger)
  await actionChecks(page, (n, ok, d) => c.check(n, ok, d), [
    { action: 'drop', state: 'calm', midMs: 250, minChanged: 1500 },
    { action: 'demo', state: 'calm', midMs: 700, minChanged: 4000 },
  ], { older: 'demo', newer: 'drop', state: 'calm' });
  await idle(page, 400, 8000);
  const demo = await page.evaluate(`(async () => { const t = performance.now(); const state = await window.__gallery.handle.trigger('demo'); return { state, ms: Math.round(performance.now() - t) }; })()`);
  c.check("handle.trigger('demo') resolves 'calm' within about 4 s", demo.state === 'calm' && demo.ms < 4600, demo);
  const afterDemo = await framesDuring(page, 2000);
  c.check('after the demo: no effect frame in 2 s', afterDemo === 0, { effectFrames: afterDemo });
  // user input during the demo takes over at once: the demo resolves null
  await page.evaluate(`window.__taken = 'pending'; window.__gallery.handle.trigger('demo').then((s) => { window.__taken = s; }); 0`);
  await sleep(500);
  await sweep(8, 16);
  await sleep(100);
  const taken = await page.evaluate('window.__taken');
  c.check('a pointer move during the demo takes over: the demo resolves null', taken === null, { state: taken });
  await page.mouseMove(stage.x + 5, stage.y + stage.h - 5);
  await idle(page, 400, 8000);

  if (process.argv.includes('--record')) {
    await page.evaluate(`document.getElementById('name').value = 'Ada'`);
    const stop = await startRecording(page);
    await page.evaluate(`window.__gallery.handle.trigger('demo'); 0`);
    await sleep(1400);
    await sweep(50, 30);
    await clickOn(page, '#email');
    await sleep(500);
    await sweep(26, 30);
    await page.mouseMove(stage.x + 5, stage.y + stage.h - 5);
    await sleep(1800);
    const frames = await stop();
    const bytes = writeWebp(frames, join(ROOT, 'plugins/water/media/water.webp'), { x: stage.x, y: stage.y, w: stage.w, h: stage.h }, { width: 560, fps: 20, quality: 50 });
    c.check('recording: media/water.webp under 900 KB', bytes < 900 * 1024, { screencastFrames: frames.length, bytes });
    if (process.argv.includes('--hero')) {
      // the README's hero (docs/media/hero.webp): rain, the pointer stirs, a click through the ripples focuses the name field and the typing shows in the drawn form
      await page.evaluate(`(() => { document.getElementById('name').value = 'Ada'; document.activeElement && document.activeElement.blur(); })()`);
      await idle(page, 400, 8000);
      const stopHero = await startRecording(page);
      await page.evaluate(`window.__gallery.handle.trigger('demo'); 0`);
      await sleep(1400);
      await sweep(50, 30);
      await clickOn(page, '#name');
      await sleep(300);
      await page.typeText(' Lovelace', { intervalMs: 90 });
      await sleep(300);
      await sweep(30, 30);
      await sleep(900);
      const heroFrames = await stopHero();
      const hero = writeWebp(heroFrames, join(ROOT, 'docs/media/hero.webp'), { x: stage.x, y: stage.y, w: stage.w, h: stage.h }, { width: 800, fps: 15, quality: 45 });
      c.check('recording: docs/media/hero.webp under 1.5 MB', hero < 1.5 * 1024 * 1024, { screencastFrames: heroFrames.length, bytes: hero });
    }
  }
  const errors = [...page.errors({ includeWarnings: false }).map((/** @type {any} */ e) => e.text), ...(await page.evaluate('window.__e2e.errors'))];
  c.check('no console error, page exception or effecterror', errors.length === 0, errors.slice(0, 3));
} finally {
  await g.close();
}

// prefers-reduced-motion: still water. Pointer moves and presses raise no ripple, nothing animates, a click still reaches the drawn field,
// and the actions resolve at once.
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
  const demo = await page.evaluate(`window.__gallery.handle.trigger('demo')`);
  await sleep(300);
  const afterActions = changed((await shot(page)).img, calmFrame, 16);
  c.check('reduced motion: the actions drop and demo start no ripple and resolve calm at once', dropped === 'calm' && demo === 'calm' && afterActions.px < 2000, { drop: dropped, demo, ...afterActions });
  const errors = [...page.errors({ includeWarnings: false }).map((/** @type {any} */ e) => e.text), ...(await page.evaluate('window.__e2e.errors'))];
  c.check('reduced motion: no console error, page exception or effecterror', errors.length === 0, errors.slice(0, 3));
} finally {
  await r.close();
}
c.finish();
