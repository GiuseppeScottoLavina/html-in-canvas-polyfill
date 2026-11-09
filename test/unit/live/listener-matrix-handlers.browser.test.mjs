// The listener matrix (listener-matrix.mjs), the on* event handler property next to a listener, across no lifecycle step, a remount, an uninstall and
// install, and a window with the canvas unmounted. Every divergence from the native element is listed.
import { test, assert } from '/test/unit/lib/t.js';
import { setupPair, handlerCasesFor, handlerDivergences, handlerSummary } from '/test/unit/live/listener-matrix.mjs';

test('listener matrix (on* handler and a listener): they behave as on a native element, for every listener option, order of registration, handler behaviour, lifecycle step and order of the two routes', async (t) => {
  const pair = await setupPair(t);
  const cases = handlerCasesFor(['none', 'remount', 'reinstall', 'unmount', 'uninstall']);
  const div = await handlerDivergences(pair, cases);
  assert.equal(div.length, 0, handlerSummary(div, cases.length));
}, { timeout: 55000 });
