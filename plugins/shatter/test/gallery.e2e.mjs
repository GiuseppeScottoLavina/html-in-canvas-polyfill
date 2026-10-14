#!/usr/bin/env node
// The shatter plugin in the REAL gallery (examples/plugins/) in headless Chrome, with trusted input: the steps of
// plugins/_shared/transition-e2e.mjs with an invalid email, so that the Submit shatters the form from the Submit button and it comes back
// showing the validation error, plus the Shatter button of the plugin's controls.
//   npm run build && node plugins/shatter/test/gallery.e2e.mjs [--record]     (--record also writes media/shatter.webp: an invalid submit)
import { runTransitionGalleryE2E } from '../../_shared/transition-e2e.mjs';
import { clickOn, compareImages, idle, shot, sleep } from '../../_shared/gallery-e2e.mjs';

await runTransitionGalleryE2E({
  name: 'shatter',
  submitLabel: 'a trusted click on Submit with an invalid email shatters the form',
  beforeSubmit: (page) => page.evaluate(`document.getElementById('email').value = 'ada@example'`),   // the gallery's check wants a dot in the domain
  midMs: 350,
  formState: async (page) => {
    const state = await page.evaluate(`document.getElementById('form-feedback').dataset.state + ' ' + document.getElementById('email').className`);
    return { name: 'the page set its error state', ok: state === 'error invalid', detail: state };
  },
  backLabel: 'the form is back, not blank, close to the start (only the error line, the red email border and the focus changed)',
  async extra(page, c) {
    const quiet = (await shot(page)).img;
    await clickOn(page, '#effect-controls .hic-shatter-ui button');
    await sleep(350);
    c.check('the Shatter button of the plugin controls (trusted click) plays it', compareImages((await shot(page)).img, quiet).countOver16 > 5000);
    c.check('and it ends', await idle(page));
  },
  async recordAction(page) {
    await clickOn(page, '#submit');   // the email is still invalid: the cracks start at the Submit button
    await sleep(3700);
  },
});
