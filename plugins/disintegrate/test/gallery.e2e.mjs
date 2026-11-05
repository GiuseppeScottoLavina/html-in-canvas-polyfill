#!/usr/bin/env node
// The disintegrate plugin in the REAL gallery (examples/plugins/) in headless Chrome, with trusted input: the steps of
// plugins/_shared/transition-e2e.mjs, with a valid form (the gallery's own validation) so that the Submit burns the form from the Submit
// button and it re-forms showing the success line; then the "Turn to dust" button of the plugin's controls (no frame is dark: the page stays),
// and the live content: the "Live counter" of the controls runs while the content turns to dust, and text typed meanwhile reaches the field
// and is shown by the re-formed page.
//   npm run build && node plugins/disintegrate/test/gallery.e2e.mjs [--record]     (--record also writes media/disintegrate.webp)
import { runTransitionGalleryE2E } from '../../_shared/transition-e2e.mjs';
import { actionChecks, actionResult, clickAction, clickOn, compareImages, framesDuring, idle, rectOf, shot, sleep } from '../../_shared/gallery-e2e.mjs';

/** open the gallery at `url` in the same page, with the effect-frame counters of openGallery (gallery-e2e.mjs) @param {any} page @param {string} url */
async function reopen(page, url) {
  await page.navigate(url);
  await page.waitForFunction('!!(window.__gallery && window.__gallery.ready)', { timeout: 20000 });
  await page.evaluate(`(() => {
    const c = document.getElementById('stage');
    window.__e2e = { frames: 0, last: performance.now(), errors: [] };
    c.addEventListener('effectframe', () => { window.__e2e.frames += 1; window.__e2e.last = performance.now(); });
    c.addEventListener('effecterror', (e) => { window.__e2e.errors.push(String(e.detail && e.detail.error)); });
    c.scrollIntoView({ block: 'start' });
  })()`);
  await idle(page);
}

/** the live counter of the plugin's controls, on (trusted click on its checkbox) @param {any} page */
async function counterOn(page) {
  if (!(await page.evaluate(`document.querySelector('#effect-controls .hic-dis-live input').checked`))) await clickOn(page, '#effect-controls .hic-dis-live input');
  await sleep(200);
}

await runTransitionGalleryE2E({
  name: 'disintegrate',
  submitLabel: 'a trusted click on Submit (valid form) turns the content of the form to dust',
  midMs: 450,
  formState: async (page) => ({ name: 'the success state is set by the page', ok: (await page.evaluate(`document.getElementById('form-feedback').dataset.state`)) === 'success' }),
  backLabel: 'the form re-forms, not blank, close to the start (only the feedback line and the focus ring changed)',
  async extra(page, c) {
    const quiet = (await shot(page)).img;
    await clickOn(page, '#effect-controls .hic-dis-ui button');
    await sleep(450);
    c.check('the "Turn to dust" button of the plugin controls (trusted click) plays it', compareImages((await shot(page)).img, quiet).countOver16 > 3000);
    // the page stays: no frame of the transition is dark (the content turns to dust, the panels remain)
    const lum = (/** @type {any} */ img) => { let sum = 0; for (let i = 0; i < img.data.length; i += 4) sum += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]; return sum / (img.data.length / 4); };
    const quietLum = lum(quiet);
    /** @type {number[]} */ const lums = [];
    for (let k = 0; k < 8; k += 1) { lums.push(lum((await shot(page)).img)); await sleep(200); }
    c.check('no frame of the transition is dark: the page stays, only its content turns to dust', Math.min(...lums) > 0.6 * quietLum, { idle: Math.round(quietLum), during: lums.map(Math.round) });
    c.check('and it ends', await idle(page));

    // the actions of the effect handle, as a page uses them (the gallery's buttons call handle.trigger)
    await actionChecks(page, (n, ok, d) => c.check(n, ok, d), [
      { action: 'out', state: 'out', midMs: 450, minChanged: 3000 },
      { action: 'in', state: 'in', midMs: 450, minChanged: 3000 },
      { action: 'play', state: 'in', midMs: 450, minChanged: 3000 },
      { action: 'demo', state: 'in', midMs: 450, minChanged: 3000 },
    ], { older: 'out', newer: 'in', state: 'in' });

    // zero work at rest: after the demo, no effect frame at all (the plugin is not continuous and asks for none)
    await clickAction(page, 'demo');
    await actionResult(page);
    await idle(page);
    const rest = await framesDuring(page, 2000);
    c.check('after the demo the effect settles: 0 effect frames in 2 s', rest === 0, { framesIn2s: rest });
    // the demo gives way to the user: a trusted press on the canvas 500 ms into it re-forms the page at once (the press itself is
    // swallowed, as during any transition); the control is the same demo left alone, which takes its full 3 s
    const demoLength = async (/** @type {boolean} */ press) => {
      await clickAction(page, 'demo');
      const t0 = Date.now();
      await sleep(500);
      if (press) { const st = await rectOf(page, '#stage'); await page.click(st.x + st.w * 0.25, st.y + st.h * 0.6); }
      const r = await actionResult(page);
      return { ms: Date.now() - t0, state: r && r.state };
    };
    const alone = await demoLength(false);
    await idle(page);
    const pressed = await demoLength(true);
    c.check('a press during the demo takes over: the page re-forms within a second, the demo left alone takes about 3 s; both resolve \'in\'',
      pressed.state === 'in' && alone.state === 'in' && pressed.ms < 1300 && alone.ms > 2600, { pressed, alone });
    await idle(page);

    // live content: the counter runs, the form burns, text is typed into the name field WHILE it burns
    await counterOn(page);
    const readCounter = () => page.evaluate(`document.querySelector('#effect-controls .hic-dis-counter').value`);
    const n0 = await readCounter();
    await sleep(300);
    c.check('the "Live counter" checkbox of the controls starts a running counter inside the drawn form', (await readCounter()) !== n0, { from: n0, to: await readCounter() });
    const field = await rectOf(page, '#name');
    const stage = await rectOf(page, '#stage');
    await page.click(field.x + field.w - 12, field.cy);
    await sleep(300);
    const before = (await shot(page)).img;
    await page.key('Enter');   // implicit submission: the content turns to dust, the focus stays in the name field
    await sleep(250);
    /** @type {string[]} */ const during = [];
    const typed = ' burning';
    for (const ch of typed) { await page.typeText(ch); await sleep(90); during.push(await readCounter()); }
    const value = await page.evaluate(`document.getElementById('name').value`);
    c.check('typing while the content is dust reaches the focused field (keyboard input is not blocked), and the counter keeps running', value.endsWith(typed) && new Set(during).size >= 6, { value, counter: during });
    // the counter keeps the page changing (about 20 times a second): the host renders that often, so "idle" here is the end of the burn's own
    // animation: the effect frames fall from the display rate to the counter's
    await sleep(3400);
    const rate = await framesDuring(page, 1000);
    c.check('the transition ends: the effect frames fall to the rate of the counter', rate <= 26 && rate >= 5, { framesPerSecond: rate });
    const after = (await shot(page)).img;
    const r = { x: field.x - stage.x, y: field.y - stage.y, w: field.w, h: field.h };
    let changedInField = 0;
    for (let y = Math.max(0, Math.floor(r.y)); y < Math.min(after.height, r.y + r.h); y += 1) {
      for (let x = Math.max(0, Math.floor(r.x)); x < Math.min(after.width, r.x + r.w); x += 1) {
        const i = (y * after.width + x) * 4;
        if (Math.abs(after.data[i] - before.data[i]) + Math.abs(after.data[i + 1] - before.data[i + 1]) + Math.abs(after.data[i + 2] - before.data[i + 2]) > 60) changedInField += 1;
      }
    }
    c.check('the form re-forms in its new live state: the text typed meanwhile is drawn in the name field', changedInField > 60, { changedInField });
    // the first appearance, as a visitor meets it: the gallery plays the demo on selection (this run opened it with &demo=0, so it is
    // opened again without). A trusted click on the chip, from "Effect off"; 250 ms later the canvas shows the page (the demo's way out has
    // just begun), not the page without its content (before the fix the demo waited 2.7 s there). The control: that empty page, after 'out'.
    const url = await page.evaluate('location.href');
    await reopen(page, url.replace(/[?&]demo=0/, '').replace(/effect=[^&]*/, 'effect=off'));
    const off = (await shot(page)).img;
    await page.evaluate('window.scrollTo(0, 0)');
    await clickOn(page, '#picker button[data-effect="disintegrate"]');
    await page.evaluate(`document.getElementById('stage').scrollIntoView({ block: 'start' })`);
    await sleep(250);
    const early = (await shot(page)).img;
    await page.waitForFunction('!!(window.__gallery.demo && window.__gallery.demo.done)', { timeout: 15000 });
    await idle(page);
    await clickAction(page, 'out'); await actionResult(page); await idle(page);
    const empty = (await shot(page)).img;
    await clickAction(page, 'in'); await actionResult(page); await idle(page);
    const span = compareImages(off, empty).countOver16, fromEmpty = compareImages(early, empty).countOver16;
    c.check('first appearance: 250 ms after a trusted click on the chip (with the demo on selection) the canvas shows the page, not the page without its content',
      span > 3000 && fromEmpty > 0.5 * span, { offVsEmptyPage: span, at250msVsEmptyPage: fromEmpty });
    await reopen(page, url);
    // the film starts from the form as the page first shows it, so that the way back shows the new (success) state
    await page.evaluate(`(() => { const f = document.getElementById('form-feedback'); f.dataset.state = 'idle'; f.textContent = 'Nothing is sent anywhere.'; document.getElementById('name').value = 'Ada'; })()`);
  },
  async recordAction(page) {
    await counterOn(page);
    const field = await rectOf(page, '#name');
    await page.click(field.x + field.w - 12, field.cy);
    await sleep(400);
    await page.key('Enter');                  // valid: the content turns to dust, the counter keeps running on it
    await page.typeText(' is still typing', { intervalMs: 110 });   // typed meanwhile: the dust of the field carries it, the re-formed field shows it
    await sleep(2600);
  },
});
