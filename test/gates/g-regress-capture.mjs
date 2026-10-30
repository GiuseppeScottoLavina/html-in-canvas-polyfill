// G-regress-capture: end-to-end through the real bundle, canvas backing store vs the plain-DOM twin (run at DPR 1 and 2 by run-all):
//   browser M1  CSS scoped to ANCESTORS of the canvas (snippet 14: html[data-theme], body.dark, .app.theme-dark ..., wrapper custom properties) and wrapper custom properties /
//               inherited text properties (snippet 29) reach the clone
//   browser M3  :last-child / :only-child / :nth-last-child(1) / flex :last-child lay out exactly like the plain DOM although the live layer is a sibling after the canvas
//   browser M4  a <canvas> inside a drawable redrawn by SCRIPT (no DOM mutation) is repainted
//   listbox     a listbox select under the canvas is scrolled to its selected option exactly as the engine scrolls the same select on the plain page (scrollTop within 0.01 px),
//               one of fractional height among them (Chrome for Android, DPR 2.625: a scale read from the rounded offsetHeight scrolled it 34.78 px instead of 34)
// Positive control: a black renderer (pixel pages), a sibling inserted after the canvas (layout pages), the redraw skipped on the polyfill page only (child canvas),
// the polyfill page's listboxes scrolled 2 css px further (listbox).
import { runGate, H } from './lib/gate.mjs';
import { compareToTwin, dumpFailure } from './lib/pixel.mjs';
import { REGRESS, regressUrl } from './lib/regress.mjs';

const near = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 0.51);

async function openPair(ctx, file) {
  const ref = await ctx.page();
  await ref.navigate(H.fixtureUrl(ctx.srv, REGRESS + file, { mode: 'ref' }));
  await ctx.focus(ref);
  await ref.waitForFunction('window.__HIC_FIXTURE && window.__HIC_FIXTURE.ready', { timeout: 8000 });
  const page = await ctx.page();
  await page.navigate(ctx.polyUrl(REGRESS + file));
  await ctx.focus(page);
  await page.waitForFunction('window.__HIC_FIXTURE && window.__HIC_FIXTURE.ready', { timeout: 15000 });
  await H.sleep(700);
  return { ref, page };
}

async function pixelPage(ctx, file, name, numbers, extra = {}) {
  const { ref, page } = await openPair(ctx, file);
  const out = await compareToTwin(ctx, { ref, page, name, numbers, minContent: 0.05, tight: { tolerance: 16, max: 0.01 }, ...extra });
  if (!ctx.control) await dumpFailure(ctx, name, out.poly.img, out.twin.img);
  return out;
}

async function layoutCases(ctx, numbers) {
  const ref = await ctx.page();
  const page = await ctx.page();
  const n = await (async () => { await page.navigate(regressUrl(ctx, 'siblings.html', { case: 0 })); await page.waitForFunction('window.__ready', { timeout: 10000 }); return page.evaluate('window.__cases.length'); })();
  const rects = (p) => p.evaluate(`JSON.stringify(['P', 'after', 'cv'].map((id) => { const e = document.getElementById(id); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }))`).then(JSON.parse);
  const rows = [];
  for (let i = 0; i < n; i++) {
    await page.navigate(regressUrl(ctx, 'siblings.html', { case: i }));
    await page.waitForFunction('window.__ready', { timeout: 10000 });
    await H.sleep(500);
    if (ctx.control) { await page.evaluate(`document.getElementById('cv').insertAdjacentHTML('afterend', '<span id="ctl">.</span>')`); await H.sleep(300); }
    const a = await rects(page);
    await ref.navigate(regressUrl(ctx, 'siblings.html', { case: i, mode: 'ref' }, { bundle: false }));
    await ref.waitForFunction('window.__ready', { timeout: 10000 });
    const b = await rects(ref);
    const name = await page.evaluate('window.__case.name');
    rows.push({ name, same: a.every((r, k) => (r === null) === (b[k] === null) && (r === null || near(r, b[k]))), poly: a, ref: b });
  }
  numbers.layout = rows.map((r) => ({ name: r.name, same: r.same }));
  for (const r of rows) ctx.check(`layout: ${r.name}: P, the next element and the canvas box lay out like the plain DOM`, r.same, { poly: r.poly, ref: r.ref }, 'layout');
}

async function listboxScroll(ctx, numbers) {
  const { ref, page } = await openPair(ctx, 'listbox-scroll.html');
  const offsets = (p) => p.evaluate(`JSON.stringify(['frac', 'natural'].map((id) => document.getElementById(id).scrollTop))`).then(JSON.parse);
  if (ctx.control) await page.evaluate(`(() => { for (const id of ['frac', 'natural']) document.getElementById(id).scrollTop += 2; return true; })()`);
  const a = await offsets(page), b = await offsets(ref);
  numbers.listbox = { poly: a, ref: b };
  ['frac', 'natural'].forEach((id, i) => ctx.check(`listbox: the ${id === 'frac' ? 'fractional-height' : 'natural-size'} listbox is scrolled to its selected option as the engine scrolls it (scrollTop ${a[i]} vs ${b[i]})`, b[i] > 0 && Math.abs(a[i] - b[i]) <= 0.01, { poly: a[i], ref: b[i] }, 'listbox'));
}

runGate('G-regress-capture', async (ctx) => {
  const numbers = {};
  await pixelPage(ctx, 'ancestor-css.html', 'ancestor-scoped CSS (snippet 14)', numbers);
  await pixelPage(ctx, 'wrapper-vars.html', 'wrapper custom properties (snippet 29)', numbers);
  await layoutCases(ctx, numbers);
  await listboxScroll(ctx, numbers);

  // child canvas redrawn by script
  const { ref, page } = await openPair(ctx, 'child-canvas.html');
  await ctx.focus(ref);
  await ref.evaluate("window.__drawInner('#36c')");
  await ctx.focus(page);
  if (!ctx.control) await page.evaluate("window.__drawInner('#36c')"); // control: the polyfill page never redraws
  await H.sleep(300); // a script redraw must reach the canvas within a few frames, not wait for some later poll
  const inner = await ref.evaluate(`(() => { const r = document.getElementById('inner').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
  const out = await compareToTwin(ctx, { ref, page, name: 'script-redrawn child canvas (M4)', numbers, polyFirst: true, minContent: 0.02, tight: { tolerance: 16, max: 0.01 }, regions: [{ name: 'inner canvas', rect: inner }], regionMax: 0.02, regionTolerance: 16 });
  if (!ctx.control) await dumpFailure(ctx, 'child-canvas', out.poly.img, out.twin.img);
  numbers.dpr = out.twin.geo.dpr;
  return { numbers };
}, { controlSabotage: ['blank'], controlClasses: ['pixel', 'layout', 'region', 'listbox'] });
