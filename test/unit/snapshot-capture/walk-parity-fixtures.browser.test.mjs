// Walk parity of the test fixtures' canvases: F1-F6 and the explainer and unsupported-feature pages (helpers and the comparison: _walk-parity.mjs).
import { test } from '/test/unit/lib/t.js';
import { checkCase, pageCase } from './_walk-parity.mjs';

const PAGES = [
  ['F1 water form', 'f1-water-form/index.html'], ['F2 scroll', 'f2-scroll/index.html'], ['F3 resize', 'f3-resize/index.html'], ['F4 large app (500)', 'f4-large-app/index.html?nodes=500'],
  ['F4 large app (2000)', 'f4-large-app/index.html?nodes=2000', { flags: [[true, true, true]] }], ['F5 classic scrollbars', 'f5-classic-scrollbars/index.html'], ['F6 controls', 'f6-controls/index.html'],
  ['explainer', 'explainer/index.html'], ['unsupported', 'unsupported/index.html'],
];
for (const [name, path, extra] of PAGES) {
  test(`walk parity: ${name}`, async (t) => { await checkCase(t, await pageCase(`/test/fixtures/${path}`, extra)); }, { timeout: 60000 });
}
