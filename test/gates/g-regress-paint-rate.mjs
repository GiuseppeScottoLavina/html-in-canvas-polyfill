// G-regress-paint-rate: the paint RATE checks of the review findings M5 and M6 (REVIEW-correctness). They are throughput measurements, so they stay on a local Mac
// (test/ci/macos-plan.mjs); the correctness checks of the same findings (the canvas after the run equals a fresh page) are G-regress-paint, which runs in CI.
//   M5 a 60 Hz counter in proportional digits (its width changes; in a line of text every change supersedes the build in flight) paints at the rate of a tabular one
//   M6 the same counter beside 2,000 inline cells paints at that rate too (row damage, cells below the tile left out of the clone)
// Positive control: every snapshot decode is held 60 ms (the fixture's `slow=1`), a renderer that paints rarely; the class `rate` must go red.
import { runGate } from './lib/gate.mjs';
import { openRegress, LARGE_COUNTER } from './lib/regress.mjs';

runGate('G-regress-paint-rate', async (ctx) => {
  const numbers = {};
  const page = await ctx.page();
  const errors0 = page.errors().length;
  const slow = ctx.control ? { slow: 1 } : {};

  // --- M5: a 60 Hz counter in proportional digits paints at the display rate ---------------------------------------------------------------------------
  // Its box changes width on most changes. In a line of text (layout=inline) each change is whole-drawable damage that supersedes the build in flight; when every superseded
  // build was dropped the canvas froze (0 to 30 paints/s against ~55 for tabular digits). In the fixed-size flex row the damage is the row (M6 follows that path with a large drawable).
  // Reference: the same counter in a monospace font on the same machine.
  const rate = {};
  for (const [key, font, bg, layout] of [['mono', 'mono', 'transparent'], ['georgia', 'georgia', 'transparent'], ['impact', 'impact', 'opaque'], ['georgia-inline', 'georgia', 'transparent', 'inline']]) {
    await openRegress(ctx, page, 'proportional-counter.html', { font, bg, ...(layout ? { layout } : {}), ...slow });
    const r = await page.evaluate('window.__run(2000)');
    rate[key] = { paints: Math.round(r.paintsPerSec * 10) / 10, changed: Math.round(r.changedPerSec * 10) / 10, store: r.store, errors: r.errors };
  }
  numbers.proportional = rate;
  const floor = Math.max(20, 0.75 * rate.mono.paints);
  for (const font of ['georgia', 'impact', 'georgia-inline']) {
    const r = rate[font];
    ctx.check(`M5: a ${font} counter changing at 60 Hz paints at least 75 % of the tabular rate and >= 20/s, every paint a changed picture`, r.paints >= floor && r.changed >= floor && !r.errors.length, { ...r, floor }, 'rate');
  }

  // --- M6: the same counter beside 2,000 inline cells (a large drawable) still paints at that rate --------------------------------------------------------
  // Its width change moves its neighbours in the row, not the cells below: the damage is the row, and the clone leaves out the cells below the tile. When every change
  // rebuilt the whole drawable (or cloned every cell into a row tile) the rate fell to ~27/s at 2,000 cells.
  await openRegress(ctx, page, 'proportional-counter.html', { ...LARGE_COUNTER, ...slow });
  const big = await page.evaluate('window.__run(2000)');
  numbers.large = { paints: Math.round(big.paintsPerSec * 10) / 10, changed: Math.round(big.changedPerSec * 10) / 10, store: big.store, floor, errors: big.errors };
  ctx.check('M6: a georgia counter beside 2,000 inline cells paints at least 75 % of the tabular rate and >= 20/s, every paint a changed picture', big.paintsPerSec >= floor && big.changedPerSec >= floor && !big.errors.length, numbers.large, 'rate');

  const errs = page.errors({ includeWarnings: false }).slice(errors0);
  ctx.check('no page error or console error', errs.length === 0, errs.slice(0, 3), 'surface');
  return { numbers };
}, { controlClasses: ['rate'] });
