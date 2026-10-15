// G-regress-paint: end-to-end regression gates for three correctness findings (REVIEW-correctness):
//   M1 a drawable appended after mount is tracked and painted (paint fires, the draw does not throw, its pixels are in the canvas) without any other damage
//   M2 three drawables drawn in ONE task all stay hit-testable (elementsFromPoint + a trusted click reaches each one and no other)
//   M3 `canvas.width = N` inside onpaint does not start a paint loop (paint count over 1.5 s stays small)
//   M4 digits changing at 60 Hz on a TRANSPARENT drawable (a counter whose text-shadow reaches past its box + ink margin, and a clock) leave no ghost of older digits: the canvas after the
//      run equals a fresh page that shows the same texts (the app clears its canvas on every paint, so any old ink left in it comes from the retained surface)
//   M5 a 60 Hz counter in proportional digits (its width changes; in a line of text every change supersedes the build in flight) paints at the rate of a tabular one, and ends pixel-exact
//   M6 the same counter beside 2,000 inline cells paints at that rate too (row damage, cells below the tile left out of the clone), and ends pixel-exact after a final
//      narrow-to-wide change that moves its neighbours far
// Positive control per finding: M1 appends a plain element (no `drawable`), M2 runs with geometry never applied, M3 adds a real requestPaint() loop, M4 composites tiles source-over
// instead of replacing them, M5 and M6 hold every snapshot decode 60 ms; every check class must go red.
import { runGate, H } from './lib/gate.mjs';
import { openRegress } from './lib/regress.mjs';
import { canvasShot, assertLayerHidden } from './lib/pixel.mjs';

runGate('G-regress-paint', async (ctx) => {
  const numbers = {};
  const page = await ctx.page();
  const errors0 = page.errors().length;

  // --- M1: dynamic append ---------------------------------------------------------------------------------------------------------------
  await openRegress(ctx, page, 'dynamic-append.html');
  const p0 = await page.evaluate('window.__paints');
  await page.evaluate(`window.__append(${ctx.control ? 'false' : 'true'})`);
  await H.sleep(1000);
  const after = await page.evaluate('({ paints: window.__paints, errors: window.__errors })');
  const shot = await canvasShot(page, '#c');
  const px = (x, y) => { const i = (y * shot.img.width + x) * 4; return [shot.img.data[i], shot.img.data[i + 1], shot.img.data[i + 2]]; };
  const blue = px(20, 70); // the second slot (y = 10 + 50) of the 300x160 grid
  numbers.append = { paintsBefore: p0, paintsAfter: after.paints, errors: after.errors, blueSample: blue };
  ctx.check('M1: a drawable appended after the first paint triggers a paint (without any other damage)', after.paints > p0, { before: p0, after: after.paints }, 'append');
  ctx.check('M1: its draw does not throw', after.errors.length === 0, after.errors, 'append');
  ctx.check('M1: the appended drawable is in the canvas pixels (blue box)', blue[2] > 150 && blue[0] < 90, { blue }, 'append');
  await assertLayerHidden(ctx, page, 'M1 page');

  // --- M2: two or more drawables drawn in one task --------------------------------------------------------------------------------------------
  await openRegress(ctx, page, 'two-hit.html');
  await H.sleep(500);
  const geo = await page.evaluate(`(() => { const r = document.getElementById('c').getBoundingClientRect(); return { x: r.left, y: r.top, pos: window.__pos }; })()`);
  const rows = [];
  for (const id of ['b1', 'b2', 'b3']) {
    const cx = geo.x + geo.pos[id][0] + 45, cy = geo.y + geo.pos[id][1] + 17;
    const top = await page.evaluate(`(document.elementsFromPoint(${cx}, ${cy})[0] || {}).id || ''`);
    await page.evaluate("for (const k of Object.keys(window.__clicks)) window.__clicks[k] = 0");
    await page.click(cx, cy);
    await H.sleep(150);
    const clicks = await page.evaluate('window.__clicks');
    rows.push({ id, top, clicks });
  }
  numbers.twoHit = rows;
  ctx.check('M2: elementsFromPoint over every drawn drawable returns that drawable first', rows.every((r) => r.top === r.id), rows, 'hit');
  ctx.check('M2: a trusted click on every drawn drawable reaches it and no other', rows.every((r) => Object.entries(r.clicks).every(([k, v]) => v === (k === r.id ? 1 : 0))), rows, 'hit');

  // --- M3: width write inside onpaint ---------------------------------------------------------------------------------------------------------
  await openRegress(ctx, page, 'width-loop.html', ctx.control ? { loop: 1 } : {});
  const w0 = await page.evaluate('window.__paints');
  await H.sleep(1500);
  const w1 = await page.evaluate('window.__paints');
  numbers.widthLoop = { paintsIn1500ms: w1 - w0 };
  ctx.check('M3: a canvas.width write inside onpaint does not start a paint loop (<= 6 paints in 1.5 s; the buggy build made ~180)', w1 - w0 <= 6, { paints: w1 - w0 }, 'loop');

  // --- M4: no ghost of older digits on a transparent drawable -----------------------------------------------------------------------------------------
  await openRegress(ctx, page, 'ghost-digits.html', ctx.control ? { sabotage: 1 } : {});
  await page.evaluate('window.__run(1500)');
  const ran = await page.evaluate('window.__pixels()');
  await openRegress(ctx, page, 'ghost-digits.html', { init: JSON.stringify(ran.texts) });
  const fresh = await page.evaluate('window.__pixels()');
  const A = Buffer.from(ran.px, 'base64'), B = Buffer.from(fresh.px, 'base64');
  let differ = 0, ghost = 0, ink = 0;
  for (let p = 0; p < A.length; p += 4) {
    let m = 0; for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(A[p + k] - B[p + k]));
    if (m > 8) differ++;
    if (A[p + 3] > 8 && B[p + 3] === 0) ghost++;
    if (B[p + 3] > 0) ink++;
  }
  numbers.ghost = { texts: ran.texts, paints: ran.paints, differ, ghost, freshInkPixels: ink, size: [ran.w, ran.h], errors: [...ran.errors, ...fresh.errors] };
  ctx.check('M4: the run painted its changes and the fresh page is not blank', ran.paints > 20 && ink > 200 && ran.errors.length + fresh.errors.length === 0, numbers.ghost, 'surface');
  ctx.check('M4: no ghost of older digits: the canvas after 1.5 s of 60 Hz changes equals a fresh page with the same texts (<= 4 px differ)', A.length === B.length && differ <= 4 && ghost === 0, numbers.ghost, 'ghost');

  // --- M5: a 60 Hz counter in proportional digits paints at the display rate ---------------------------------------------------------------------------
  // Its box changes width on most changes. In a line of text (layout=inline) each change is whole-drawable damage that supersedes the build in flight; when every superseded
  // build was dropped the canvas froze (0 to 30 paints/s against ~55 for tabular digits). In the fixed-size flex row the damage is the row (M6 follows that path with a large drawable).
  // Reference: the same counter in a monospace font on the same machine.
  const rate = {};
  for (const [key, font, bg, layout] of [['mono', 'mono', 'transparent'], ['georgia', 'georgia', 'transparent'], ['impact', 'impact', 'opaque'], ['georgia-inline', 'georgia', 'transparent', 'inline']]) {
    await openRegress(ctx, page, 'proportional-counter.html', { font, bg, ...(layout ? { layout } : {}), ...(ctx.control ? { slow: 1 } : {}) });
    const r = await page.evaluate('window.__run(2000)');
    rate[key] = { paints: Math.round(r.paintsPerSec * 10) / 10, changed: Math.round(r.changedPerSec * 10) / 10, store: r.store, errors: r.errors };
    if (key === 'georgia') {
      const after = await page.evaluate('window.__pixels()');
      await openRegress(ctx, page, 'proportional-counter.html', { font, bg, init: after.text });
      const ref = await page.evaluate('window.__pixels()');
      const P = Buffer.from(after.px, 'base64'), R = Buffer.from(ref.px, 'base64');
      let differ = 0;
      for (let p = 0; p < P.length; p += 4) { let m = 0; for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(P[p + k] - R[p + k])); if (m > 8) differ++; }
      rate.pixels = { text: after.text, differ };
      ctx.check('M5: after the run the canvas equals a fresh page that shows the same counter (<= 4 px differ)', P.length === R.length && differ <= 4 && !after.errors.length, rate.pixels, 'ghost');
    }
  }
  numbers.proportional = rate;
  const floor = Math.max(20, 0.75 * rate.mono.paints);
  for (const font of ['georgia', 'impact', 'georgia-inline']) {
    const r = rate[font];
    ctx.check(`M5: a ${font} counter changing at 60 Hz paints at least 75 % of the tabular rate and >= 20/s, every paint a changed picture`, r.paints >= floor && r.changed >= floor && !r.errors.length, { ...r, floor }, 'rate');
  }

  // a label wider than the ink margins around the counter, so the counter's own damage cannot cover where it moves
  const LONG_LABEL = 'your total score';
  // --- M6: the same counter beside 2,000 inline cells (a large drawable) still paints at that rate, and ends pixel-exact --------------------------------------------
  // Its width change moves its neighbours in the row, not the cells below: the damage is the row, and the clone leaves out the cells below the tile. When every change
  // rebuilt the whole drawable (or cloned every cell into a row tile) the rate fell to ~27/s at 2,000 cells.
  await openRegress(ctx, page, 'proportional-counter.html', { font: 'georgia', filler: 2000, label: LONG_LABEL, ...(ctx.control ? { slow: 1 } : {}) });
  const big = await page.evaluate('window.__run(2000)');
  // then one narrow-to-wide change, so the counter's neighbours move far, out of its own old and new place: their new place must be painted too
  await page.evaluate("document.getElementById('n').firstChild.data = '1'");
  await H.sleep(300);
  await page.evaluate("document.getElementById('n').firstChild.data = '8888'");
  const bigAfter = await page.evaluate('window.__pixels()');
  await openRegress(ctx, page, 'proportional-counter.html', { font: 'georgia', filler: 2000, label: LONG_LABEL, init: bigAfter.text });
  const bigRef = await page.evaluate('window.__pixels()');
  const G = Buffer.from(bigAfter.px, 'base64'), F = Buffer.from(bigRef.px, 'base64');
  let bigDiffer = 0;
  for (let p = 0; p < G.length; p += 4) { let m = 0; for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(G[p + k] - F[p + k])); if (m > 8) bigDiffer++; }
  numbers.large = { paints: Math.round(big.paintsPerSec * 10) / 10, changed: Math.round(big.changedPerSec * 10) / 10, store: big.store, floor, text: bigAfter.text, differ: bigDiffer, errors: [...big.errors, ...bigAfter.errors, ...bigRef.errors] };
  ctx.check('M6: a georgia counter beside 2,000 inline cells paints at least 75 % of the tabular rate and >= 20/s, every paint a changed picture', big.paintsPerSec >= floor && big.changedPerSec >= floor && !big.errors.length, numbers.large, 'rate');
  ctx.check('M6: after the run the canvas equals a fresh page with the same counter and cells (<= 4 px differ)', G.length === F.length && bigDiffer <= 4 && !numbers.large.errors.length, numbers.large, 'ghost');

  const errs = page.errors({ includeWarnings: false }).slice(errors0);
  ctx.check('no page error or console error', errs.length === 0, errs.slice(0, 3), 'surface');
  return { numbers };
}, { controlSabotage: ['nogeom'], controlClasses: ['append', 'hit', 'loop', 'ghost', 'rate'] });
