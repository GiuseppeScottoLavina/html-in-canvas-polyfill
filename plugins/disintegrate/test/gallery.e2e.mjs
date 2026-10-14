#!/usr/bin/env node
// The disintegrate plugin in the REAL gallery (examples/plugins/) in headless Chrome, with trusted input: the steps of
// plugins/_shared/transition-e2e.mjs, with a valid form (the gallery's own validation) so that the Submit burns the form from the Submit
// button and it re-forms showing the success line, plus the Burn button of the plugin's controls.
//   npm run build && node plugins/disintegrate/test/gallery.e2e.mjs [--record]     (--record also writes media/disintegrate.webp: a submit)
import { runTransitionGalleryE2E } from '../../_shared/transition-e2e.mjs';
import { clickOn, compareImages, idle, shot, sleep } from '../../_shared/gallery-e2e.mjs';

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
    // the film starts from the form as the page first shows it, so that the way back shows the new (success) state
    await page.evaluate(`(() => { const f = document.getElementById('form-feedback'); f.dataset.state = 'idle'; f.textContent = 'Nothing is sent anywhere.'; })()`);
  },
  async recordAction(page) {
    await clickOn(page, '#submit');   // valid: the fire starts at the Submit button; the form re-forms with "Thanks, Ada."
    await sleep(4900);
  },
});
