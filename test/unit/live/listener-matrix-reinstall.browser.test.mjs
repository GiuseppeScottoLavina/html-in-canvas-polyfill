// The listener matrix (listener-matrix.mjs), lifecycle steps: reinstall, reinstall+remove, uninstall (dispatches while uninstalled). Every divergence from the native element is listed in the failure message.
import { test, assert } from '/test/unit/lib/t.js';
import { setupPair, casesFor, divergences, summary } from '/test/unit/live/listener-matrix.mjs';
import { controlOf } from '/test/unit/live/listener-matrix.mjs';

test('listener matrix (reinstall, reinstall+remove, uninstall): a canvas listener behaves as on a native element, for every option, callback behaviour and order of the two routes', async (t) => {
  const pair = await setupPair(t);
  const cases = casesFor(['reinstall', 'reinstall+remove', 'uninstall']);
  assert.equal(cases.length, 1728, 'the cases of this part');
  const div = await divergences(pair, cases);
  // positive control: the same cases with a canvas that drops `once` must diverge
  const control = await divergences(controlOf(pair), cases);
  assert.ok(control.length > 0, `control: a canvas that drops once diverged in ${control.length} of ${cases.length} cases`);
  assert.equal(div.length, 0, summary(div, cases.length));
}, { timeout: 55000 });
