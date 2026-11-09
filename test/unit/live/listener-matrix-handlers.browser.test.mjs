// The listener matrix (listener-matrix.mjs), the on* event handler property next to a listener, across no lifecycle step, a remount, an uninstall and
// install, and a window with the canvas unmounted. Every divergence from the native element is listed.
import { test, assert } from '/test/unit/lib/t.js';
import { setupPair, handlerCasesFor, handlerDivergences, handlerSummary } from '/test/unit/live/listener-matrix.mjs';
import { controlOf } from '/test/unit/live/listener-matrix.mjs';

test('listener matrix (on* handler and a listener): they behave as on a native element, for every listener option, order of registration, handler behaviour, lifecycle step and order of the two routes', async (t) => {
  const pair = await setupPair(t);
  const cases = handlerCasesFor(['none', 'remount', 'reinstall', 'unmount', 'uninstall']);
  assert.equal(cases.length, 960, 'the cases of this part');
  const div = await handlerDivergences(pair, cases);
  // positive control: the same cases with a canvas that drops `once` must diverge
  const control = await handlerDivergences(controlOf(pair), cases);
  assert.ok(control.length > 0, `control: a canvas that drops once diverged in ${control.length} of ${cases.length} cases`);
  assert.equal(div.length, 0, handlerSummary(div, cases.length));
}, { timeout: 55000 });
