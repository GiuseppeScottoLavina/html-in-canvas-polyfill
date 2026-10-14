#!/usr/bin/env node
// The shatter plugin in the REAL gallery (examples/plugins/) in headless Chrome, with trusted input (CDP Input.*): the two impacts.
// Idle click-through and typing; a Submit with an invalid email cracks the glass from the Submit button, and the form stays usable through
// the cracked pane (a trusted click focuses the field drawn there, typing shows through the cracks); a second invalid Submit breaks the
// pane (a click during the fall changes nothing: NO_TARGET), it comes back showing the error state and usable; the Strike button cracks it
// again and a valid Submit heals it; then the gallery check of every plugin. --record writes media/shatter.webp: two invalid submits.
//   npm run build && node plugins/shatter/test/gallery.e2e.mjs [--record]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pixelStats } from '../../../test/harness/index.mjs';
import { ROOT, checklist, clickOn, compareImages, idle, openGallery, rectOf, shot, sleep, startRecording, writeWebp } from '../../_shared/gallery-e2e.mjs';

const c = checklist('shatter gallery e2e');
const g = await openGallery('shatter', { width: 1100, height: 1000 });
const { page } = g;
console.log(`Chrome ${g.chrome}, plugin bundle ${g.bundle.bytes} bytes (minified)`);
const active = () => page.evaluate('document.activeElement && document.activeElement.id');
const value = (/** @type {string} */ id) => page.evaluate(`document.getElementById(${JSON.stringify(id)}).value`);
const feedback = () => page.evaluate(`document.getElementById('form-feedback').dataset.state + ' ' + document.getElementById('email').className`);
const changed = async (/** @type {any} */ img) => compareImages((await shot(page)).img, img).countOver16;
/** what the pane shows once nothing moves ('intact', 'cracked', 'gone'): the plugin's own signal, resolved after the frame of the end state */
const rest = () => page.evaluate(`HicLivePlugins.shatter.settled(document.getElementById('stage'))`);
try {
  c.check('the gallery is ready with the plugin applied', true, await page.evaluate('({ mode: window.__gallery.mode, active: window.__gallery.active })'));
  c.check('the intro ends: the host stops rendering (idle, not continuous)', await idle(page));
  const before = (await shot(page)).img;
  const area = before.width * before.height;
  c.check('idle frame is not blank', pixelStats(before).nonBlank);

  await clickOn(page, '#name'); await sleep(150);
  c.check('idle: a trusted click focuses the drawn name field', (await active()) === 'name');
  await page.typeText('x');
  c.check('idle: trusted typing reaches it', (await value('name')) === 'Adax');
  await idle(page);
  const typed = (await shot(page)).img;

  // ---- first impact: the glass cracks, the form stays usable through it -------------------------------------------------------------
  await page.evaluate(`document.getElementById('email').value = 'ada@example'`);   // the gallery's check wants a dot in the domain
  await clickOn(page, '#submit');
  await sleep(120);
  c.check('a trusted click on Submit with an invalid email cracks the glass: the frame 120 ms later differs', (await changed(typed)) > 2000);
  c.check('the cracks settle: the plugin reports a cracked pane and the host goes idle (the pane is still)', (await rest()) === 'cracked' && await idle(page));
  const cracked = (await shot(page)).img;
  const crackDiff = compareImages(cracked, typed).countOver16;
  c.check('cracked: crack lines and shifted pieces over a form that is still there', crackDiff > 3000 && crackDiff < 0.35 * area && pixelStats(cracked).nonBlank, { changedPixels: crackDiff });
  c.check('the page set its error state', (await feedback()) === 'error invalid', await feedback());
  await clickOn(page, '#message'); await sleep(150);
  c.check('cracked: a trusted click through the cracked glass focuses the message field drawn there', (await active()) === 'message');
  await page.typeText('!');
  await sleep(250);
  c.check('and typing reaches it', /!$/.test(await value('message')));
  c.check('and shows through the cracks (the pane redraws the live form)', (await changed(cracked)) > 20);
  c.check('the pane stays cracked and still', await idle(page));

  // ---- second impact: the pane breaks, falls, flies back ---------------------------------------------------------------------------
  const crackedNow = (await shot(page)).img;
  const t0 = Date.now();
  await clickOn(page, '#submit');
  await sleep(350);
  const fallDiff = await changed(crackedNow);
  c.check('a second invalid Submit (a trusted click through the cracks) breaks the pane: the frame 350 ms later differs a lot', fallDiff > 0.15 * area, { changedPixels: fallDiff });
  const focusedBefore = await active();
  await clickOn(page, '#name'); await sleep(60);
  c.check('during the fall a trusted click on the name field changes nothing: no focus change (NO_TARGET, swallowed by the host)',
    (await active()) === focusedBefore, { before: focusedBefore, after: await active() });
  c.check('the fall ends: the plugin reports the intact pane and the host goes idle', (await rest()) === 'intact' && await idle(page), { ms: Date.now() - t0 });
  const after = (await shot(page)).img;
  const backDiff = compareImages(after, typed).countOver16;
  c.check('the form is back, cracks closed, not blank, close to before (only the error line, the red email border and the message changed)',
    pixelStats(after).nonBlank && backDiff < 0.03 * area, { changedPixels: backDiff });
  await clickOn(page, '#name'); await sleep(150);
  c.check('after the fall the form is usable again: the click focuses the name field', (await active()) === 'name');
  await idle(page);

  // ---- the Strike button cracks; fixing the form heals ------------------------------------------------------------------------------
  const intact = (await shot(page)).img;
  await clickOn(page, '#effect-controls .hic-shatter-ui button');
  await sleep(150);
  c.check('the Strike button of the plugin controls (trusted click) cracks the pane', (await changed(intact)) > 2000);
  c.check('and the pane rests cracked', (await rest()) === 'cracked');
  await page.evaluate(`document.getElementById('email').value = 'ada@example.com'`);
  await clickOn(page, '#submit');
  c.check('a valid Submit while cracked heals the glass (the cracks close)', (await rest()) === 'intact');
  const healed = (await shot(page)).img;
  const healDiff = compareImages(healed, intact).countOver16;
  c.check('healed: the intact form with the success line', (await page.evaluate(`document.getElementById('form-feedback').dataset.state`)) === 'success' && healDiff < 0.03 * area, { changedPixels: healDiff });
  await idle(page);
  // the same while the cracks are still running: pointer input is blocked then (NO_TARGET), but the keyboard is not (Enter submits the
  // form; modelled with requestSubmit): a fixed form must not stay behind cracked glass
  await clickOn(page, '#effect-controls .hic-shatter-ui button');
  await sleep(100);
  const running = await page.evaluate(`(() => { const s = HicLivePlugins.shatter.settled(document.getElementById('stage')); let done = false; s.then(() => { done = true; }); return new Promise((ok) => setTimeout(() => ok(!done), 0)); })()`);
  await page.evaluate(`document.getElementById('demo-form').requestSubmit()`);
  const quick = await rest();
  const quickDiff = await changed(healed);
  c.check('a valid submit (keyboard) while the cracks still run heals the glass too', running && quick === 'intact' && quickDiff < 0.03 * area, { running, state: quick, changedPixels: quickDiff });

  // what scripts/check-examples.mjs asks of every plugin of the gallery: picked after "Effect off", its controls mount and the presented
  // pixels 900 ms later differ from "Effect off" (here: the intro), and the frame is not blank
  const pick = async (/** @type {string} */ name) => {
    await clickOn(page, `#picker button[data-effect="${name}"]`);
    for (let i = 0; i < 80; i += 1) { if (await page.evaluate(`window.__gallery.active === ${JSON.stringify(name)}`)) return true; await sleep(100); }
    return false;
  };
  await page.evaluate(`document.activeElement && document.activeElement.blur()`);
  await page.evaluate('window.scrollTo(0, 0)');
  await pick('off'); await sleep(600);
  await page.evaluate(`document.getElementById('stage').scrollIntoView({ block: 'start' })`); await sleep(100);
  const off = (await shot(page)).img;
  await page.evaluate('window.scrollTo(0, 0)');
  await pick('shatter');
  await page.evaluate(`document.getElementById('stage').scrollIntoView({ block: 'start' })`); await sleep(800);
  const on = (await shot(page)).img;
  const changedPx = compareImages(on, off).countOver16;
  const controls = await page.evaluate(`document.getElementById('effect-controls').children.length`);
  c.check('the gallery check of scripts/check-examples.mjs: selected after "Effect off", controls mounted, pixels changed at 900 ms, not blank', controls > 0 && changedPx > 300 && pixelStats(on).nonBlank, { controls, changed: changedPx });
  await idle(page);

  if (process.argv.includes('--record')) {
    // the film: a submit with a broken email cracks the glass from the Submit button, a second one breaks it, it comes back with the error
    await page.evaluate(`(() => {
      document.getElementById('email').value = 'ada@example';
      document.getElementById('email').classList.remove('invalid');
      const f = document.getElementById('form-feedback'); f.dataset.state = 'idle'; f.textContent = 'Nothing is sent anywhere.';
      document.activeElement && document.activeElement.blur();
    })()`);
    await idle(page);
    const stage = await rectOf(page, '#stage');
    const stop = await startRecording(page);
    await sleep(400);
    await clickOn(page, '#submit');
    await sleep(1300);
    await clickOn(page, '#submit');
    await sleep(3900);
    const frames = await stop();
    const out = join(ROOT, 'plugins', 'shatter', 'media', 'shatter.webp');
    mkdirSync(join(out, '..'), { recursive: true });
    const bytes = writeWebp(frames, out, { x: stage.x, y: stage.y, w: stage.w, h: stage.h }, { width: 520, fps: 12, quality: 35 });
    c.check(`recorded media/shatter.webp (${frames.length} compositor frames)`, bytes < 500 * 1024, { kb: Math.round(bytes / 1024) });
  }
  const errors = [...page.errors({ includeWarnings: false }).map((/** @type {any} */ e) => e.text), ...(await page.evaluate('window.__e2e.errors'))];
  c.check('no console error, page exception or effecterror', errors.length === 0, errors.slice(0, 3));
} finally {
  await g.close();
}
c.finish();
