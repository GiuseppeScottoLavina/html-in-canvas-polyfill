// G-resize-drag: F3 under a REAL window drag (Browser.setWindowBounds in steps) at 50 ms and 8 ms cadence.
//   zero blank frames after the first non-blank paint; final pixels (CANVAS BACKING STORE, tight) equal the plain-DOM twin at 1400 and 700 px; the live layout converges within
//   4 rendering updates; a trusted click ~50 ms after the last resize event at the INNER EDGE of the drawn button lands on it and on none of its neighbours; the edge
//   probe of every control after the drag matches the twin.
// Positive control (pre-first-paint sabotage: black renderer + geometry never applied + a layer that keeps a stale width): a named check of EVERY class goes red.
import { runGate, H } from './lib/gate.mjs';
import { openRef, openPoly, rectsOf, center } from './lib/f1.mjs';
import { canvasShot, checkSurface, assertLayerHidden, dumpFailure } from './lib/pixel.mjs';
import { checkEdgeHits } from './lib/hit.mjs';

const BIG = { width: 1400, height: 800 };
const SMALL = { width: 700, height: 800 };
const GO = '.c0 button';
const OTHERS = '.cards .card:not(.c0) button, #go';

runGate('G-resize-drag', async (ctx) => {
  const numbers = {};
  const ref = await openRef(ctx, 'f3');
  const page = await openPoly(ctx, 'f3');
  await ctx.focus(page);
  await page.setInnerSize(BIG.width, BIG.height);
  await H.sleep(500);
  await ctx.focus(ref);
  const refBig = await H.screenshotElement(ref, '#hic-surface');
  await ref.setInnerSize(SMALL.width, SMALL.height);
  await H.sleep(500);
  await ctx.focus(ref);
  const goRect = (await rectsOf(ref, [GO]))[GO];
  const refSmall = await H.screenshotElement(ref, '#hic-surface');
  await ref.setInnerSize(BIG.width, BIG.height);
  await H.sleep(300);

  await ctx.focus(page);
  await page.evaluate(`window.__go = 0; window.__other = 0; document.querySelector(${JSON.stringify(GO)}).addEventListener('click', () => { window.__go++; });
    for (const b of document.querySelectorAll(${JSON.stringify(OTHERS)})) b.addEventListener('click', () => { window.__other++; })`);
  const errors0 = page.errors().length;
  const detector = await H.startBlankDetector(page);
  await H.sleep(300);
  const drags = [];
  for (const cadence of [50, 8]) {
    for (const [from, to] of [[BIG, SMALL], [SMALL, BIG]]) {
      const d = await H.dragResize(page, { from, to, steps: 30, intervalMs: cadence, settleMs: 500 });
      drags.push({ cadence, to: `${to.width}x${to.height}`, reached: d.reachedTarget, resizeEvents: d.pageSaw.resizeEvents, distinctWidths: d.pageSaw.distinctWidths, actual: d.injector.actual, cadenceOk: d.injector.cadenceOk });
    }
  }
  const report = await detector.stop();
  numbers.drags = drags;
  numbers.blank = { frames: report.frames, valid: report.valid, blankFrames: report.blankFrames.length, blankRuns: report.blankRuns, longestBlankRun: report.longestBlankRun, sizeWrites: report.sizeChanges.length, frameGapMs: report.frameGapMs };
  ctx.check('the blank detector run is valid (the canvas had content)', report.valid, { baseline: report.baseline, frames: report.frames }, 'blank');
  ctx.check('every drag reached its target size and the page saw many sizes', drags.every((d) => d.reached && d.distinctWidths >= 8), drags, 'resize');
  ctx.check('zero blank frames across all four drags (after the first non-blank paint)', report.blankFrames.length === 0, { blankFrames: report.blankFrames.slice(0, 5), runs: report.blankRuns }, 'blank');
  ctx.check('the canvas backing store followed the window (>= 20 size writes by the explainer RO)', report.sizeChanges.length >= 20, { sizeWrites: report.sizeChanges.length }, 'resize');

  // final pixels at 1400 against the twin: canvas backing store, tight
  await H.sleep(500);
  await assertLayerHidden(ctx, page, 'after the drags');
  const big = await canvasShot(page, '#hic-surface');
  const sizeBig = big.img.width === refBig.img.width && big.img.height === refBig.img.height;
  ctx.check('after the drag back to 1400 px the canvas size equals the twin size', sizeBig, { canvas: [big.img.width, big.img.height], twin: [refBig.img.width, refBig.img.height] }, 'pixel');
  checkSurface(ctx, { name: 'final 1400', poly: big.img, twin: refBig.img, dpr: refBig.geo.dpr, numbers, minContent: 0.03, tight: { tolerance: 6, max: 0.004 } });
  if (!ctx.control) await dumpFailure(ctx, 'final-1400', big.img, refBig.img);
  // at rest the live root must sit exactly on its layout box: a correction left over from a stretched mid-drag drawing (measured: 1377 / 1401.43 px wide at innerWidth 1400, in ~50 % of drags
  // before the fix) would be a wrong hit area for good although the pixels may look right
  const rest = await page.evaluate(`(() => { const r = document.querySelector('#root').getBoundingClientRect(); return { x: r.x, width: r.width, innerWidth }; })()`);
  numbers.restRootAfterDrags = rest;
  ctx.check('after the drags the live root sits exactly on its layout box (no stale stretch correction at rest)', Math.abs(rest.width - rest.innerWidth) < 0.01 && Math.abs(rest.x) < 0.01, rest, 'converge');

  // drag to 700; the live element follows the DRAWN pixels, which converge to the new layout 1-3 frames after the last resize event
  await page.evaluate(`window.__m = []; window.__lastResize = 0; addEventListener('resize', () => { window.__lastResize = performance.now(); });
    (function f() { const r = document.querySelector('#root').getBoundingClientRect(); window.__m.push([performance.now(), Math.round(r.x), Math.round(r.width), innerWidth]); requestAnimationFrame(f); })()`);
  const d3 = await H.dragResize(page, { to: SMALL, steps: 30, intervalMs: 8, settleMs: 0 });
  await H.sleep(40);
  // click 2 px inside the LEFT edge of the drawn button at its plain-DOM-twin position (~50 ms after the last resize event)
  await ctx.focus(page);
  const tClick = Date.now();
  await page.click(goRect.x + 2, goRect.y + goRect.height / 2);
  numbers.clickDelayAfterLastResizeMs = Date.now() - tClick + 40;
  await H.sleep(250);
  const clicks = await page.evaluate('({ go: window.__go, other: window.__other })');
  const mon = await page.evaluate('({ last: window.__lastResize, m: window.__m.filter((a) => a[0] >= window.__lastResize - 5) })');
  const settled = mon.m.findIndex((a) => a[1] === 0 && a[2] === a[3]);
  numbers.framesToConverge = settled;
  ctx.check('the live layout converges within 4 rendering updates of the last resize event', settled >= 0 && settled <= 4, { settled, first: mon.m.slice(0, 6) }, 'converge');
  ctx.check('a trusted click 2 px inside the button edge ~50 ms after the last resize event lands on the drawn button', clicks.go === 1, { clicks, reached: d3.reachedTarget }, 'hit');
  ctx.check('... and no neighbouring button received it', clicks.other === 0, clicks, 'hit');
  await H.sleep(600);
  await assertLayerHidden(ctx, page, 'at 700 px');
  const small = await canvasShot(page, '#hic-surface');
  const sizeSmall = small.img.width === refSmall.img.width && small.img.height === refSmall.img.height;
  ctx.check('at 700 px the canvas size equals the twin size', sizeSmall, { canvas: [small.img.width, small.img.height], twin: [refSmall.img.width, refSmall.img.height] }, 'pixel');
  checkSurface(ctx, { name: 'final 700', poly: small.img, twin: refSmall.img, dpr: refSmall.geo.dpr, numbers, minContent: 0.03, tight: { tolerance: 6, max: 0.03 } }); // rounded cards and wrapped text: ~1.7 % of pixels differ by 7-60 levels on a sound build (curve AA), a 1-6 px shift or a tint is far above
  if (!ctx.control) await dumpFailure(ctx, 'final-700', small.img, refSmall.img);

  // edge probe of the controls at the final (700 px) layout; the twin tab shares the window, so both are laid out at 700
  await ctx.focus(ref);
  await H.sleep(300);
  const tr = await rectsOf(ref, [GO, '#t1', '#t2', '#go']);
  await checkEdgeHits(ctx, { page, ref, controls: [['card button', 'button', GO], ['t1', 't1', '#t1'], ['t2', 't2', '#t2'], ['go', 'go', '#go']].map(([name, id, s]) => ({ name, id, rect: tr[s] })), group: 'edge hits at 700 px', numbers });
  const errs = page.errors({ includeWarnings: false }).slice(errors0);
  ctx.check('no page error or console error', errs.length === 0, errs.slice(0, 3), 'surface');
  numbers.dpr = small.geo.dpr;
  return { numbers };
}, { controlSabotage: ['blank', 'nogeom', 'freezelayer'], controlClasses: ['blank', 'pixel', 'content', 'hit', 'converge'] });
