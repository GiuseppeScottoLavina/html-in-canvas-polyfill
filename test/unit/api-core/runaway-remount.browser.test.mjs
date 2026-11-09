// A page that toggles a canvas between drawable and fallback content many times a second, while its listeners get events, is the page's doing, not a feedback
// loop: the runaway guard must not uninstall the polyfill. The mount's damage was `forced`, which the guard counts as the pipeline's own, and the listener
// matrix's positive controls (thousands of remounts with events in between) tripped it; the damage of a mount is now `content-attr` (scheduler.js resume).
import { test, assert } from '/test/unit/lib/t.js';
import { setupPair, pairCasesFor, pairDivergences, controlOf } from '/test/unit/live/listener-matrix.mjs';
import { getInstalled } from '/src/index.js';

test('two rounds of the two-listener matrix (thousands of remounts with listener traffic in between) keep the polyfill installed, and the canvas still mounts', async (t) => {
  const pair = await setupPair(t);
  const cases = pairCasesFor(['none', 'remount']);
  const t0 = performance.now();
  // the sequence that tripped the guard (three times out of three before the fix): the two-listener part of the matrix, then its positive control
  await pairDivergences(pair, cases);
  assert.ok(getInstalled(), 'still installed after the first round');
  await pairDivergences(controlOf(pair), cases);
  assert.ok(getInstalled(), `still installed after two rounds of ${cases.length} cases (${Math.round(performance.now() - t0)} ms)`);
  await pair.canvas.remount();
}, { timeout: 55000 });
