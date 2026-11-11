#!/usr/bin/env node
// Gallery click-through of the glitch plugin in headless Chrome with trusted input (CDP), on examples/plugins/?effect=glitch:
// the ambient mode renders only while its events play and keeps the form usable, a burst renders within the frame cap, a Submit with an invalid email (the gallery's own
// validation, unchanged) plays a burst, the Burst button of the plugin's controls plays one, burst mode at rest presents no frame, the
// actions burst and demo from the gallery's buttons (handle.trigger),
// and prefers-reduced-motion. `--record` also writes media/glitch.webp.
//
//   npm run build   (the bundles; `npm run test:plugins` runs every gallery e2e)
//   node plugins/glitch/test/gallery.e2e.mjs [--record]
import { join } from 'node:path';
import { ROOT, actionChecks, changed, clickOn, framesDuring, openGallery, rectOf, shot, sleep, startRecording, writePreview } from '../../_shared/gallery-e2e.mjs';

const record = process.argv.includes('--record');
/** @type {{name: string, ok: boolean, detail: unknown}[]} */
const checks = [];
const check = (/** @type {string} */ name, /** @type {boolean} */ ok, /** @type {unknown} */ detail) => { checks.push({ name, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}  ${JSON.stringify(detail)}`); };
const BURST_MS = 520;

async function main() {
  const g = await openGallery('glitch');
  const { page } = g;
  console.log(`Chrome ${g.chrome}, plugin bundle ${g.bundle.bytes} bytes (minified)`);
  try {
    const c = await rectOf(page, '#stage');
    const area = c.w * c.h;
    const st = await page.evaluate(`({ controls: !!document.querySelector('#effect-controls .hic-glitch-ui'), mode: window.__gallery.mode })`);
    check('the gallery runs the effect and mounts the plugin controls inside the drawn form', st.mode === 'effect' && st.controls, st);

    await page.evaluate(`document.getElementById('stage').frameCap = 120`);
    await page.mouseMove(5, 5);
    await page.evaluate('window.__gallery.handle.settled()');   // a gallery that plays the demo on selection: after it
    await sleep(300);
    const ambientFps = (await framesDuring(page, 4200)) / 4.2;
    check('ambient renders only while an event plays: a few effect frames per second at cap 120, never none (it rendered every frame before)', ambientFps >= 1 && ambientFps <= 15, { framesPerSecond: ambientFps });
    const burstFrames = {};
    for (const cap of [120, 15]) {
      await page.evaluate(`document.getElementById('stage').frameCap = ${cap}`);
      await sleep(300);
      const n0 = await page.evaluate('window.__e2e.frames');
      await page.evaluate(`window.__gallery.handle.trigger('burst')`);
      burstFrames[cap] = (await page.evaluate('window.__e2e.frames')) - n0;
      await sleep(300);
    }
    check('a burst renders at its pattern and grain steps, within the frame cap (frames of one burst at caps 120 / 15)',
      burstFrames[120] >= 12 && burstFrames[120] <= 40 && burstFrames[15] <= Math.ceil((BURST_MS / 1000) * 15) + 3 && burstFrames[15] < burstFrames[120], burstFrames);
    await page.evaluate(`document.getElementById('stage').frameCap = 120`);

    await clickOn(page, '#name');
    await sleep(200);
    await page.typeText('x');
    await sleep(150);
    let s = await page.evaluate(`({ active: document.activeElement && document.activeElement.id, name: document.getElementById('name').value })`);
    check('ambient: a trusted click focuses the drawn name field and typing reaches it', s.active === 'name' && s.name === 'Adax', s);
    await page.evaluate(`document.activeElement.blur()`);

    // the gallery's own validation (unchanged): an invalid email + Submit sets .invalid and data-state="error"; the plugin watches for them
    await page.evaluate(`document.getElementById('email').value = 'not-an-email'`);
    await sleep(300);
    const calm = (await shot(page)).img;
    await clickOn(page, '#submit');
    await sleep(90);
    const during = changed((await shot(page)).img, calm, 16);
    await sleep(BURST_MS + 400);
    const settled = changed((await shot(page)).img, calm, 16);
    s = await page.evaluate(`({ feedback: document.getElementById('form-feedback').textContent, invalid: document.getElementById('email').classList.contains('invalid') })`);
    check('a Submit with an invalid email (trusted click through the effect) plays a burst; afterwards only the form\'s own error state differs',
      s.invalid && /email/.test(s.feedback) && during.px > 0.03 * area && settled.px < 0.01 * area, { ...s, burstPx: during.px, afterPx: settled.px });

    await page.evaluate(`document.getElementById('email').value = 'ada@example.com'`);
    await clickOn(page, '#submit');
    await sleep(BURST_MS + 400);
    const valid = await page.evaluate(`document.getElementById('form-feedback').dataset.state`);
    const before = (await shot(page)).img;
    await clickOn(page, '#effect-controls .hic-glitch-ui button');
    await sleep(90);
    const button = changed((await shot(page)).img, before, 16);
    check('the Burst button of the plugin controls (trusted click, drawn inside the form) plays a burst', valid === 'success' && button.px > 0.03 * area, { feedbackState: valid, burstPx: button.px });
    await sleep(BURST_MS + 300);

    await page.evaluate(`(() => { const s = document.querySelector('#effect-controls .hic-glitch-ui select'); s.value = 'burst'; s.dispatchEvent(new Event('change')); })()`);
    await sleep(400);
    const rest = await framesDuring(page, 1000);
    check('burst mode at rest presents no effect frame (nothing moves, nothing is focused)', rest <= 2, { framesPerSecond: rest });
    // the action of the effect handle, as a page uses it (the gallery's button calls handle.trigger('burst'))
    await actionChecks(page, check, [
      { action: 'burst', state: 'idle', midMs: 90, minChanged: 0.03 * area },
      // 840 ms: early in the full burst of the demo (it starts at 820 ms), before its first clean pattern (135 ms into it)
      { action: 'demo', state: 'idle', midMs: 840, minChanged: 0.03 * area },
    ], { older: 'demo', newer: 'burst', state: 'idle' });
    const errors = await page.evaluate('window.__e2e.errors');
    check('no effecterror', errors.length === 0, errors);

    if (record) {
      await page.evaluate(`(() => { const s = document.querySelector('#effect-controls .hic-glitch-ui select'); s.value = 'ambient'; s.dispatchEvent(new Event('change')); document.getElementById('email').value = 'not-an-email'; })()`);
      await page.mouseMove(c.cx, c.cy);
      await sleep(400);
      const stop = await startRecording(page);
      await sleep(1600);                                   // ambient (an event about every 1.4 s)
      await clickOn(page, '#submit');                      // the gallery's validation error: a burst
      await sleep(900);
      await page.evaluate(`window.__gallery.handle.trigger('demo')`);   // the demo sequence (resolves when it ends)
      await sleep(300);
      const frames = await stop();
      writePreview(frames, 'glitch', { x: c.x, y: c.y, w: c.w, h: c.h }, check);
    }
  } finally {
    await g.close();
  }

  const r = await openGallery('glitch', { reducedMotion: true });
  try {
    const c = await rectOf(r.page, '#stage');
    await r.page.evaluate(`document.getElementById('stage').frameCap = 120`);
    await sleep(300);
    const rest = await framesDuring(r.page, 1000);
    const before = (await shot(r.page)).img;
    await clickOn(r.page, '#effect-controls .hic-glitch-ui button');
    await sleep(90);
    const during = changed((await shot(r.page)).img, before, 16);
    const burstFrames = await framesDuring(r.page, BURST_MS + 300);
    const after = changed((await shot(r.page)).img, before, 16);
    check('prefers-reduced-motion: ambient presents no frame at rest; a burst is one steady colour frame for its length and one frame that ends it, then the page as before',
      rest <= 2 && during.px > 0.005 * c.w * c.h && burstFrames <= 3 && after.px < 0.002 * c.w * c.h,
      { framesAtRest: rest, burstPx: during.px, framesDuringAndAfterBurst: burstFrames, afterPx: after.px });
    const t0 = Date.now();
    const state = await r.page.evaluate(`window.__gallery.handle.trigger('burst')`);
    check('prefers-reduced-motion: the action burst plays the steady burst and resolves idle when it ends', state === 'idle' && Date.now() - t0 >= BURST_MS - 50, { state, ms: Date.now() - t0 });
  } finally {
    await r.close();
  }
  const failed = checks.filter((x) => !x.ok);
  console.log(`\nglitch gallery click-through: ${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(2); });
