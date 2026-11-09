// The listener matrix (listener-matrix.mjs), two listeners on the target, lifecycle step unmount (one of the three files of that part, so that each stays
// well inside a file's time on the slowest CI machine): order, passive next to non-passive, cancelling through saved native methods,
// stopImmediatePropagation and removal of the other, across no lifecycle step, a remount, an uninstall and install, and a window with the canvas unmounted. Every divergence is listed.
import { test, assert } from '/test/unit/lib/t.js';
import { setupPair, pairCasesFor, pairDivergences, pairSummary } from '/test/unit/live/listener-matrix.mjs';
import { controlOf } from '/test/unit/live/listener-matrix.mjs';

test('listener matrix (two listeners, unmount): they behave as on a native element, for every pair of options, first-listener behaviour, lifecycle step and order of the two routes', async (t) => {
  const pair = await setupPair(t);
  const cases = pairCasesFor(['unmount']);
  assert.equal(cases.length, 2176, 'the cases of this part');
  const div = await pairDivergences(pair, cases);
  // positive control: the same cases with a canvas that drops `once` must diverge
  const control = await pairDivergences(controlOf(pair), cases);
  assert.ok(control.length > 0, `control: a canvas that drops once diverged in ${control.length} of ${cases.length} cases`);
  assert.equal(div.length, 0, pairSummary(div, cases.length));
}, { timeout: 55000 });
