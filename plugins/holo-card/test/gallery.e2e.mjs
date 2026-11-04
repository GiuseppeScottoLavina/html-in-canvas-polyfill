#!/usr/bin/env node
// Gallery click-through for the holo-card plugin (headless Chrome, trusted input): see plugins/_shared/gallery-click.mjs.
// The card tilts towards the pointer; the pointer is moved to a point where the TILTED card draws a control away from its DOM position,
// the card comes to rest there, and the click at that point must reach the control.
// Then, with touch emulation (Input.dispatchTouchEvent through the browser's touch pipeline): a finger dragged over the card tilts it AND
// the page scrolls (the card never claims the gesture); control: the same drag with a page listener that does claim it (preventDefault)
// scrolls nothing, so the check can fail. Then the action demo from the gallery's button (its state, superseding, settled) and zero work
// at rest after it. `--record` also writes media/holo-card.webp.
//   npm run build && node plugins/holo-card/test/gallery.e2e.mjs [--record]
import { join } from 'node:path';
import * as H from '../../../test/harness/index.mjs';
import { UNIFORM_FLOATS, mapCardPoint, meta, writeCardPose } from '../index.js';
import { runGalleryClickThrough } from '../../_shared/gallery-click.mjs';
import { ROOT, actionChecks, checklist, framesDuring, idle, openGallery, rectOf, sleep, startRecording, writeWebp } from '../../_shared/gallery-e2e.mjs';

let size = { w: 1, h: 1 };
const tilt = (meta.defaults.tilt * Math.PI) / 180;
await runGalleryClickThrough({
  name: 'holo-card',
  async setup(ctx) { size = { w: ctx.canvas.w, h: ctx.canvas.h }; },
  // the pose at rest with the pointer at p (render(): rx = -tilt * y, ry = tilt * x, with x, y = the pointer in -1..1)
  mapFor(p) {
    const s = new Float32Array(UNIFORM_FLOATS);
    s[2] = size.w; s[3] = size.h;
    writeCardPose(s, -tilt * ((2 * p.y) / size.h - 1), tilt * ((2 * p.x) / size.w - 1), 0.86, size.w, size.h);
    return (q) => mapCardPoint(s, q);
  },
  settleBeforeClick: 1500,
  // the pointer leaves: the card sways on its own (idle sway, default on)
  async animate(ctx) { await ctx.page.mouseMove(5, 5); },
});
const clickThroughCode = process.exitCode;

const c = checklist('holo-card touch, demo and rest in the gallery');
const g = await openGallery('holo-card');
try {
  const { page } = g;
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await page.evaluate(`window.__gallery.handle.setOptions({ idle: false })`);   // only the finger moves the card
  await page.mouseMove(5, 5);
  await page.evaluate('window.__gallery.handle.settled()');   // a gallery that plays the demo on selection: after it
  c.check('idle sway off and nothing touched: the host goes idle', await idle(page, 600));
  const rest = await framesDuring(page, 2000);
  c.check('zero work at rest: no effect frame in 2 s', rest === 0, { frames: rest });

  /** a finger dragged down over the right part of the card (the page scrolls up), then lifted; scroll and frames during it */
  const fingerDrag = async () => {
    const stage = await rectOf(page, '#stage');
    const y0 = await page.evaluate('scrollY');
    const f0 = await page.evaluate('window.__e2e.frames');
    await H.touchDrag(page, { x: Math.round(stage.x + stage.w * 0.82), y: Math.round(stage.y + stage.h * 0.35), dir: -1, step: 12, count: 14, intervalMs: 16, restMs: 120 });
    const during = (await page.evaluate('window.__e2e.frames')) - f0;
    await sleep(700);
    return { scrolled: Math.round(y0 - (await page.evaluate('scrollY'))), framesDuringDrag: during, scrollY: y0 };
  };
  await page.evaluate(`window.scrollTo(0, Math.max(400, scrollY))`);
  await sleep(300);
  const free = await fingerDrag();
  c.check('a finger dragged over the card tilts it (effect frames while it drags) and the page scrolls under it (the card never claims the gesture)',
    free.framesDuringDrag >= 3 && free.scrolled >= 60, free);
  c.check('the finger lifted: the card springs back and the host goes idle again', await idle(page, 600));
  // control: a page listener that claims the gesture (what a plugin that blocked scrolling would do): the same drag scrolls nothing
  await page.evaluate(`window.__claim = (e) => e.preventDefault(); document.addEventListener('touchstart', window.__claim, { passive: false, capture: true }); document.addEventListener('touchmove', window.__claim, { passive: false, capture: true })`);
  await page.evaluate(`window.scrollTo(0, Math.max(400, scrollY))`);
  await sleep(300);
  const claimed = await fingerDrag();
  await page.evaluate(`document.removeEventListener('touchstart', window.__claim, { capture: true }); document.removeEventListener('touchmove', window.__claim, { capture: true })`);
  c.check('control: with the gesture claimed by the page the same drag scrolls nothing (the scroll check can fail)', Math.abs(claimed.scrolled) <= 2, claimed);
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page.evaluate(`document.getElementById('stage').scrollIntoView({ block: 'start' })`);
  await page.mouseMove(5, 5);
  await idle(page, 600);

  const area = (await rectOf(page, '#stage')).w * (await rectOf(page, '#stage')).h;
  await actionChecks(page, c.check, [{ action: 'demo', state: 'rest', midMs: 900, minChanged: 0.05 * area }], { older: 'demo', newer: 'demo', state: 'rest' });
  await sleep(300);
  const after = await framesDuring(page, 2000);
  c.check('zero work at rest after the demo: no effect frame in 2 s', after === 0, { frames: after });

  if (process.argv.includes('--record')) {
    await page.evaluate(`window.__gallery.handle.setOptions({ idle: true })`);
    const stage = await rectOf(page, '#stage');
    await sleep(600);
    const stop = await startRecording(page);
    await sleep(1200);                                   // the idle sway
    for (let i = 0; i <= 50; i += 1) {                   // the pointer circles over the card: the glare and the foil follow it
      const a = (i / 50) * Math.PI * 2;
      await page.mouseMove(stage.x + stage.w * (0.5 + 0.4 * Math.cos(a)), stage.y + stage.h * (0.5 + 0.38 * Math.sin(a)));
      await sleep(32);
    }
    await page.mouseMove(5, 5);
    await page.evaluate(`window.__gallery.handle.trigger('demo')`);   // the demo sweep
    await sleep(400);
    const frames = await stop();
    const bytes = writeWebp(frames, join(ROOT, 'plugins/holo-card/media/holo-card.webp'), { x: stage.x, y: stage.y, w: stage.w, h: stage.h }, { width: 660, fps: 30, quality: 55 });
    c.check('recording: media/holo-card.webp under 500 KB', bytes < 500 * 1024, { screencastFrames: frames.length, bytes });
  }
  const errors = await page.evaluate('window.__e2e.errors');
  c.check('no effecterror', errors.length === 0, errors);
} finally {
  await g.close();
}
c.finish();
if (clickThroughCode) process.exitCode = clickThroughCode;
