// G-regress-stacking: page content that natively paints above a non-positioned canvas but is covered by the live layer is REPORTED as `stacking-overlap` (REVIEW-browser M2:
// the audit existed but was never called), and a page without overlap stays silent. report() is the subject of this gate, so reading it is not a rule-7 leak.
// Positive control: the "must report" check is pointed at the page WITHOUT an overlay, so it must go red (class 'report'); the "must stay silent" check is pointed at the overlay page (class 'silent').
import { runGate, H } from './lib/gate.mjs';
import { openRegress } from './lib/regress.mjs';

const entriesOf = (page) => page.evaluate(`(() => { const r = window.__HIC__.installed.report(); return [...r.unsupported, ...(r.deviations || [])].filter((u) => JSON.stringify(u).includes('stacking-overlap')).map((u) => ({ feature: u.feature || u.id, count: u.count ?? 1, detail: String(u.detail || u.message || '').slice(0, 120) })); })()`);

runGate('G-regress-stacking', async (ctx) => {
  const numbers = {};
  const page = await ctx.page();
  const errors0 = page.errors().length;
  await openRegress(ctx, page, 'stacking.html', { overlay: ctx.control ? 0 : 1 });
  await H.sleep(3500);
  const found = await entriesOf(page);
  numbers.overlayReport = found;
  ctx.check('an overlay that natively covers the drawn drawable is reported as stacking-overlap (within 3.5 s)', found.length >= 1, { found }, 'report');
  const logs = page.errors({ includeWarnings: false }).filter((e) => /stacking-overlap/.test(e.text));
  ctx.check('... exactly once per (canvas, element) in the console', logs.length <= 1, { n: logs.length }, 'report');
  await openRegress(ctx, page, 'stacking.html', { overlay: ctx.control ? 1 : 0 });
  await H.sleep(3500);
  const silent = await entriesOf(page);
  numbers.cleanReport = silent;
  ctx.check('a page without any overlap stays silent', silent.length === 0, { silent }, 'silent');
  const errs = page.errors({ includeWarnings: false }).slice(errors0).filter((e) => !/stacking-overlap/.test(e.text));
  ctx.check('no unrelated page error', errs.length === 0, errs.slice(0, 3), 'surface');
  return { numbers };
}, { controlClasses: ['report', 'silent'] });
