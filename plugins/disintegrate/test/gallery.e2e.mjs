#!/usr/bin/env node
// The disintegrate plugin in the REAL gallery (examples/plugins/) in headless Chrome, with trusted input: the steps of
// plugins/_shared/transition-e2e.mjs, with a valid form (the gallery's own validation) so that the Submit plays the transition.
//   npm run build && node plugins/disintegrate/test/gallery.e2e.mjs [--record]     (--record also writes media/disintegrate.webp)
import { runTransitionGalleryE2E } from '../../_shared/transition-e2e.mjs';
import { sleep } from '../../_shared/gallery-e2e.mjs';

await runTransitionGalleryE2E({
  name: 'disintegrate',
  submitLabel: 'a trusted click on Submit (valid form) plays the transition',
  midMs: 450,
  formState: async (page) => ({ name: 'the success state is set by the page', ok: (await page.evaluate(`document.getElementById('form-feedback').dataset.state`)) === 'success' }),
  backLabel: 'reassembled frame is not blank and close to the start (only the feedback line and the focus ring changed)',
  async recordAction(page) {
    await page.evaluate(`(HicLivePlugins.disintegrate.trigger(document.getElementById('stage'), 'play'), 0)`);
    await sleep(4400);
  },
});
