// The listener matrix (listener-matrix.mjs), lifecycle steps: reinstall, reinstall+remove, uninstall (dispatches while uninstalled). Every divergence from the native element is listed in the failure message.
import { test, assert } from '/test/unit/lib/t.js';
import { setupPair, casesFor, divergences, summary } from '/test/unit/live/listener-matrix.mjs';

test('listener matrix (reinstall, reinstall+remove, uninstall): a canvas listener behaves as on a native element, for every option, callback behaviour and order of the two routes', async (t) => {
  const pair = await setupPair(t);
  const cases = casesFor(['reinstall', 'reinstall+remove', 'uninstall']);
  const div = await divergences(pair, cases);
  assert.equal(div.length, 0, summary(div, cases.length));
}, { timeout: 55000 });
