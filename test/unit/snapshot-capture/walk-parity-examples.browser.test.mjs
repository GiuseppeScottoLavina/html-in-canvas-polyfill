// Walk parity of the examples' canvases (helpers and the comparison: _walk-parity.mjs).
import { test } from '/test/unit/lib/t.js';
import { checkCase, pageCase } from './_walk-parity.mjs';

for (const name of ['basic', 'form', 'scroll-and-resize', 'effect-plugin', 'plugins', 'webgl-texture']) {
  test(`walk parity: examples/${name}`, async (t) => { await checkCase(t, await pageCase(`/examples/${name}/index.html`)); }, { timeout: 60000 });
}
