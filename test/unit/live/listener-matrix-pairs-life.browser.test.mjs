// The listener matrix (listener-matrix.mjs), two listeners on the target: order, passive next to non-passive, cancelling through saved native methods,
// stopImmediatePropagation and removal of the other, across no lifecycle step, a remount, an uninstall and install, and a window with the canvas unmounted. Every divergence is listed.
import { test, assert } from '/test/unit/lib/t.js';
import { setupPair, pairCasesFor, pairDivergences, pairSummary } from '/test/unit/live/listener-matrix.mjs';

test('listener matrix (two listeners, reinstall and unmounted): they behave as on a native element, for every pair of options, first-listener behaviour, lifecycle step and order of the two routes', async (t) => {
  const pair = await setupPair(t);
  const cases = pairCasesFor(['reinstall', 'unmount', 'uninstall']);
  const div = await pairDivergences(pair, cases);
  assert.equal(div.length, 0, pairSummary(div, cases.length));
}, { timeout: 55000 });
