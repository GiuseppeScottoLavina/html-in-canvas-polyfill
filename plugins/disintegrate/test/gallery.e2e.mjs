#!/usr/bin/env node
// The disintegrate plugin in the REAL gallery (examples/plugins/) in headless Chrome, with trusted input: the steps of
// plugins/_shared/transition-e2e.mjs, with a valid form (the gallery's own validation) so that the Submit burns the form from the Submit
// button and it re-forms showing the success line; then the Burn button of the plugin's controls, and the live content: the "Live counter"
// of the controls runs while the form burns, and text typed while it burns reaches the field and is shown by the re-formed page.
//   npm run build && node plugins/disintegrate/test/gallery.e2e.mjs [--record]     (--record also writes media/disintegrate.webp)
import { runTransitionGalleryE2E } from '../../_shared/transition-e2e.mjs';
import { clickOn, compareImages, framesDuring, idle, rectOf, shot, sleep } from '../../_shared/gallery-e2e.mjs';

/** the live counter of the plugin's controls, on (trusted click on its checkbox) @param {any} page */
async function counterOn(page) {
  if (!(await page.evaluate(`document.querySelector('#effect-controls .hic-dis-live input').checked`))) await clickOn(page, '#effect-controls .hic-dis-live input');
  await sleep(200);
}

await runTransitionGalleryE2E({
  name: 'disintegrate',
  submitLabel: 'a trusted click on Submit (valid form) burns the form from the Submit button',
  midMs: 450,
  formState: async (page) => ({ name: 'the success state is set by the page', ok: (await page.evaluate(`document.getElementById('form-feedback').dataset.state`)) === 'success' }),
  backLabel: 'the form re-forms, not blank, close to the start (only the feedback line and the focus ring changed)',
  async extra(page, c) {
    const quiet = (await shot(page)).img;
    await clickOn(page, '#effect-controls .hic-dis-ui button');
    await sleep(450);
    c.check('the Burn button of the plugin controls (trusted click) plays it', compareImages((await shot(page)).img, quiet).countOver16 > 5000);
    c.check('and it ends', await idle(page));

    // live content: the counter runs, the form burns, text is typed into the name field WHILE it burns
    await counterOn(page);
    const readCounter = () => page.evaluate(`document.querySelector('#effect-controls .hic-dis-counter').value`);
    const n0 = await readCounter();
    await sleep(300);
    c.check('the "Live counter" checkbox of the controls starts a running counter inside the drawn form', (await readCounter()) !== n0, { from: n0, to: await readCounter() });
    const field = await rectOf(page, '#name');
    const stage = await rectOf(page, '#stage');
    await page.click(field.x + field.w - 12, field.cy);
    await sleep(1700);   // older than 1.5 s: the fire starts at the Submit button, not at this press
    const before = (await shot(page)).img;
    await page.key('Enter');   // implicit submission: the form burns, the focus stays in the name field
    await sleep(250);
    /** @type {string[]} */ const during = [];
    const typed = ' burning';
    for (const ch of typed) { await page.typeText(ch); await sleep(90); during.push(await readCounter()); }
    const value = await page.evaluate(`document.getElementById('name').value`);
    c.check('typing while the form burns reaches the focused field (keyboard input is not blocked), and the counter keeps running', value.endsWith(typed) && new Set(during).size >= 6, { value, counter: during });
    // the counter keeps the page changing (about 20 times a second): the host renders that often, so "idle" here is the end of the burn's own
    // animation: the effect frames fall from the display rate to the counter's
    await sleep(7600);
    const rate = await framesDuring(page, 1000);
    c.check('the burn ends: the effect frames fall to the rate of the counter', rate <= 26 && rate >= 5, { framesPerSecond: rate });
    const after = (await shot(page)).img;
    const r = { x: field.x - stage.x, y: field.y - stage.y, w: field.w, h: field.h };
    let changedInField = 0;
    for (let y = Math.max(0, Math.floor(r.y)); y < Math.min(after.height, r.y + r.h); y += 1) {
      for (let x = Math.max(0, Math.floor(r.x)); x < Math.min(after.width, r.x + r.w); x += 1) {
        const i = (y * after.width + x) * 4;
        if (Math.abs(after.data[i] - before.data[i]) + Math.abs(after.data[i + 1] - before.data[i + 1]) + Math.abs(after.data[i + 2] - before.data[i + 2]) > 60) changedInField += 1;
      }
    }
    c.check('the form re-forms in its new live state: the text typed during the burn is drawn in the name field', changedInField > 60, { changedInField });
    // the film starts from the form as the page first shows it, so that the way back shows the new (success) state
    await page.evaluate(`(() => { const f = document.getElementById('form-feedback'); f.dataset.state = 'idle'; f.textContent = 'Nothing is sent anywhere.'; document.getElementById('name').value = 'Ada'; })()`);
  },
  async recordAction(page) {
    await counterOn(page);
    const field = await rectOf(page, '#name');
    await page.click(field.x + field.w - 12, field.cy);
    await sleep(1700);
    await page.key('Enter');                  // valid: the fire starts at the Submit button, next to the running counter
    await page.typeText(' is still typing', { intervalMs: 110 });   // typed while it burns: the flakes of the field carry it
    await sleep(5800);
  },
});
