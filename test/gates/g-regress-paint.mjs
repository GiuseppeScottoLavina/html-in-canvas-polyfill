// G-regress-paint: end-to-end regression gates for correctness findings (REVIEW-correctness). Every check here is a correctness check; the paint RATE checks of M5 and
// M6 are G-regress-paint-rate (a throughput measurement that stays on a local Mac, test/ci/macos-plan.mjs).
//   M1 a drawable appended after mount is tracked and painted (paint fires, the draw does not throw, its pixels are in the canvas) without any other damage
//   M2 three drawables drawn in ONE task all stay hit-testable (elementsFromPoint + a trusted click reaches each one and no other)
//   M3 `canvas.width = N` inside onpaint does not start a paint loop (paint count over 1.5 s stays small)
//   M4 digits changing at 60 Hz on a TRANSPARENT drawable (a counter whose text-shadow reaches past its box + ink margin, and a clock) leave no ghost of older digits: the canvas after the
//      run, and again after one more change once the run settled, equals a fresh page that shows the same texts (the app clears its canvas on every paint, so any old
//      ink left in it comes from the retained surface)
//   M5 a 60 Hz counter in proportional digits (its width changes, so its neighbours in the row move) ends pixel-exact after 2 s of changes
//   M6 the same counter beside 2,000 inline cells (row damage, cells below the tile left out of the clone) ends pixel-exact after the run and a final narrow-to-wide change
//      that moves its neighbours far
// Positive control per class: M1 appends a plain element (no `drawable`), M2 runs with geometry never applied, M3 adds a real requestPaint() loop, M4 composites tiles
// source-over instead of replacing them; every class (append, hit, loop, ghost) must go red. The final-canvas checks of M5 and M6 share the class `ghost`; the
// mutants moved-siblings-ignored and truncation-cuts-inside-tile show that they can fail (test/gates/mutants/mutants.mjs).
import { runGate, H } from './lib/gate.mjs';
import { openRegress, differingPixels, LARGE_COUNTER } from './lib/regress.mjs';
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
  // the canvas against a fresh page: pixels that differ (> 8 levels in a channel), ghost pixels (ink where the fresh page has none), and the fresh page's ink
  const compareGhost = (/** @type {string} */ ranPx, /** @type {string} */ freshPx) => {
    const A = Buffer.from(ranPx, 'base64'), B = Buffer.from(freshPx, 'base64');
    let differ = 0, ghost = 0, ink = 0;
    for (let p = 0; p < A.length; p += 4) {
      let m = 0; for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(A[p + k] - B[p + k]));
      if (m > 8) differ++;
      if (A[p + 3] > 8 && B[p + 3] === 0) ghost++;
      if (B[p + 3] > 0) ink++;
    }
    return { sameSize: A.length === B.length, differ, ghost, ink };
  };
  await openRegress(ctx, page, 'ghost-digits.html', ctx.control ? { sabotage: 1 } : {});
  await page.evaluate('window.__run(1500)');
  const ran = await page.evaluate('window.__pixels()');
  // then one change on the settled page: what the last commits of the 60 Hz run repaint depends on timing (with a damage that leaves out the shadow, the run alone ended
  // pixel-exact in 1 of 2 runs on the macOS runner), a lone change does not.
  // Its damage must cover the counter's text-shadow, 110 px right of its box: where the old digits' shadow was, and where the new one is.
  await page.evaluate("document.getElementById('glow').firstChild.data = '1'");
  await H.sleep(300);
  await page.evaluate("document.getElementById('glow').firstChild.data = '888'");
  const settled = await page.evaluate('window.__pixels()');
  await openRegress(ctx, page, 'ghost-digits.html', { init: JSON.stringify(ran.texts) });
  const fresh = await page.evaluate('window.__pixels()');
  await openRegress(ctx, page, 'ghost-digits.html', { init: JSON.stringify(settled.texts) });
  const freshSettled = await page.evaluate('window.__pixels()');
  const run = compareGhost(ran.px, fresh.px), last = compareGhost(settled.px, freshSettled.px);
  numbers.ghost = { texts: ran.texts, paints: ran.paints, differ: run.differ, ghost: run.ghost, freshInkPixels: run.ink, size: [ran.w, ran.h], errors: [...ran.errors, ...fresh.errors] };
  numbers.ghostAfterOneChange = { texts: settled.texts, differ: last.differ, ghost: last.ghost, freshInkPixels: last.ink, errors: [...settled.errors, ...freshSettled.errors] };
  ctx.check('M4: the run painted its changes and the fresh page is not blank', ran.paints > 20 && run.ink > 200 && ran.errors.length + fresh.errors.length === 0, numbers.ghost, 'surface');
  ctx.check('M4: no ghost of older digits: the canvas after 1.5 s of 60 Hz changes equals a fresh page with the same texts (<= 4 px differ)', run.sameSize && run.differ <= 4 && run.ghost === 0, numbers.ghost, 'ghost');
  ctx.check('M4: no ghost after one more change once the run settled (the counter to 1, then 888): the canvas equals a fresh page with the same texts (<= 4 px differ)', last.sameSize && last.differ <= 4 && last.ghost === 0 && last.ink > 200 && !numbers.ghostAfterOneChange.errors.length, numbers.ghostAfterOneChange, 'ghost');

  // --- M5: a 60 Hz counter in proportional digits ends pixel-exact ---------------------------------------------------------------------------------------
  // Its box changes width on most changes; in the fixed-size flex row the damage is the row (M6 follows that path with a large drawable). The paint rate of this run is
  // recorded, not judged: G-regress-paint-rate judges it against a tabular reference.
  await openRegress(ctx, page, 'proportional-counter.html', { font: 'georgia', bg: 'transparent' });
  const counter = await page.evaluate('window.__run(2000)');
  const counterAfter = await page.evaluate('window.__pixels()');
  await openRegress(ctx, page, 'proportional-counter.html', { font: 'georgia', bg: 'transparent', init: counterAfter.text });
  const counterRef = await page.evaluate('window.__pixels()');
  const counterDiffer = differingPixels(counterAfter.px, counterRef.px);
  numbers.proportional = { paints: Math.round(counter.paintsPerSec * 10) / 10, changed: Math.round(counter.changedPerSec * 10) / 10, store: counter.store, text: counterAfter.text, differ: counterDiffer, errors: [...counter.errors, ...counterAfter.errors] };
  ctx.check('M5: after the run the canvas equals a fresh page that shows the same counter (<= 4 px differ)', counterDiffer !== null && counterDiffer <= 4 && !counterAfter.errors.length, numbers.proportional, 'ghost');

  // --- M6: the same counter beside 2,000 inline cells (a large drawable) ends pixel-exact ----------------------------------------------------------------
  // Its width change moves its neighbours in the row, not the cells below: the damage is the row, and the clone leaves out the cells below the tile.
  await openRegress(ctx, page, 'proportional-counter.html', LARGE_COUNTER);
  const big = await page.evaluate('window.__run(2000)');
  // then one narrow-to-wide change, so the counter's neighbours move far, out of its own old and new place: their new place must be painted too
  await page.evaluate("document.getElementById('n').firstChild.data = '1'");
  await H.sleep(300);
  await page.evaluate("document.getElementById('n').firstChild.data = '8888'");
  const bigAfter = await page.evaluate('window.__pixels()');
  await openRegress(ctx, page, 'proportional-counter.html', { ...LARGE_COUNTER, init: bigAfter.text });
  const bigRef = await page.evaluate('window.__pixels()');
  const bigDiffer = differingPixels(bigAfter.px, bigRef.px);
  numbers.large = { paints: Math.round(big.paintsPerSec * 10) / 10, changed: Math.round(big.changedPerSec * 10) / 10, store: big.store, text: bigAfter.text, differ: bigDiffer, errors: [...big.errors, ...bigAfter.errors, ...bigRef.errors] };
  ctx.check('M6: after the run the canvas equals a fresh page with the same counter and cells (<= 4 px differ)', bigDiffer !== null && bigDiffer <= 4 && !numbers.large.errors.length, numbers.large, 'ghost');

  const errs = page.errors({ includeWarnings: false }).slice(errors0);
  ctx.check('no page error or console error', errs.length === 0, errs.slice(0, 3), 'surface');
  return { numbers };
}, { controlSabotage: ['nogeom'], controlClasses: ['append', 'hit', 'loop', 'ghost'] });
