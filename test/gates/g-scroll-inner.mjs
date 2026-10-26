// G-scroll-inner: F2 through the polyfill vs its plain-DOM twin, the SAME trusted input sent to both tabs.
//   wheel scroll of the inner list at several offsets (sticky header must stay pinned), page scroll, keyboard scroll, Tab focus-reveal, a position:fixed child, :hover.
//   Every step compares the CANVAS BACKING STORE with the twin (whole surface tight + per-element regions: the sticky header and the fixed child are checked from
//   canvas pixels, not from the live DOM), with the live layer's computed opacity asserted 0. One blank watch spans all interaction (a one-frame blank during
//   scroll fails). Positive control: a renderer that never repaints after the first draw (and one that draws black).
import { runGate, H } from './lib/gate.mjs';
import { openRef, openPoly, rectsOf, center } from './lib/f1.mjs';
import { compareToTwin, canvasShot, colorShare, dumpFailure } from './lib/pixel.mjs';
import { withBlankWatch } from './lib/sections.mjs';

const CSS_EXTRA = '.row:hover{background:#7a3030 !important}';
const HEAD_BG = [0x2d, 0x44, 0x70];
const RED = [0xdd, 0x33, 0x33];
const REGIONS = ['#bar', '#list .head', '#side', '#fixed-child'];

async function onBoth(ctx, ref, page, fn) {
  await ctx.focus(ref); await fn(ref, 'ref');
  await ctx.focus(page); await fn(page, 'poly');
}

/** Regions present in the twin right now (the sticky header rect is read where it IS after the scroll). */
const regionsNow = async (ref) => {
  const r = await rectsOf(ref, REGIONS);
  const vp = await ref.evaluate('({ w: innerWidth, h: innerHeight })');
  const inView = (q) => q && q.width > 0 && q.y >= 0 && q.y + q.height <= vp.h && q.x >= 0 && q.x + q.width <= vp.w;
  return REGIONS.filter((s) => inView(r[s])).map((s) => ({ name: s, rect: r[s] }));
};

async function compare(ctx, ref, page, name, numbers) {
  await H.sleep(700);
  const out = await compareToTwin(ctx, { ref, page, name, numbers, regions: regionsNow, minContent: 0.05, tight: { tolerance: 6, max: 0.004 }, regionMax: 0.02, regionTolerance: 6 });
  if (!ctx.control) await dumpFailure(ctx, name, out.poly.img, out.twin.img);
  return out;
}

/** wait until the list stopped moving (smooth scrolling) */
async function stable(page, expr = `document.querySelector('#list').scrollTop`) {
  let last = -1;
  for (let i = 0; i < 40; i++) { const v = await page.evaluate(expr); if (v === last) return v; last = v; await H.sleep(250); }
  return last;
}
const scrollTops = async (page) => page.evaluate(`({ list: document.querySelector('#list').scrollTop, side: document.querySelector('#side').scrollTop, y: scrollY })`);

/** The sticky header is where it belongs in the CANVAS pixels: the header background fills its rect (header rect read from the plain-DOM twin). */
async function stickyFromCanvas(ctx, ref, page, name, numbers) {
  await ctx.focus(ref);
  const r = (await rectsOf(ref, ['#list .head', '#hic-surface']));
  await ctx.focus(page);
  const shot = await canvasShot(page, '#hic-surface');
  const geo = await page.evaluate(`(() => { const e = document.querySelector('#hic-surface').getBoundingClientRect(); return { x: e.left, y: e.top, dpr: devicePixelRatio }; })()`);
  const share = colorShare(shot.img, r['#list .head'], { x: r['#hic-surface'].x, y: r['#hic-surface'].y }, geo.dpr, HEAD_BG, 18);
  numbers[`${name} stickyHeaderShare`] = share;
  ctx.check(`${name}: the sticky header fills its rect in the canvas pixels (header colour share >= 50 %)`, share >= 0.5, { share, rect: r['#list .head'] }, 'region');
}

runGate('G-scroll-inner', async (ctx) => {
  const numbers = {};
  const ref = await openRef(ctx, 'f2');
  const page = await openPoly(ctx, 'f2');
  const errors0 = page.errors().length;
    await onBoth(ctx, ref, page, (p) => p.setInnerSize(1400, 820));
  await H.sleep(500);
  await ctx.focus(ref);
  const r = await rectsOf(ref, ['#list', '#hic-surface', '#side', '.inner']);
  const listC = center(r['#list']);

  await compare(ctx, ref, page, 'rest', numbers);
  const watch = await H.startBlankDetector(await (async () => { await ctx.focus(page); return page; })(), { selector: '#hic-surface', grid: [160, 100] });

  // inner list: wheel at three offsets
  const offsets = [];
  for (let k = 1; k <= 3; k++) {
    await onBoth(ctx, ref, page, async (p) => { await p.mouseMove(listC.x, listC.y); await H.sleep(60); await H.wheelStream(p, { x: listC.x, y: listC.y, deltaY: 60, count: 5 * k, intervalMs: 16 }); });
    await stable(page); await ctx.focus(ref); await stable(ref); await ctx.focus(page);
    const t = await scrollTops(page); const tr = await scrollTops(ref);
    offsets.push({ poly: t.list, ref: tr.list });
    ctx.check(`wheel step ${k}: native wheel scrolled the live list (>= 90 % of the injected delta; plain DOM within one tick)`, t.list >= 0.9 * 5 * k * 60 && Math.abs(t.list - tr.list) <= 61, { poly: t.list, ref: tr.list, expected: 5 * k * 60 }, 'scroll');
    // the plain DOM page may drop one wheel tick (smooth-scroll start); pixels are compared at EQUAL offsets
    await ctx.focus(ref); await ref.evaluate(`document.querySelector('#list').scrollTop = ${t.list}`);
    await compare(ctx, ref, page, `wheel-offset-${k}`, numbers);
    await stickyFromCanvas(ctx, ref, page, `wheel-offset-${k}`, numbers);
  }
  numbers.listScrollTops = offsets;

  // page scroll (the canvas moves in the viewport)
  // each page is read once its smooth scroll has ended, while it is the foreground tab: a background tab does not advance the animation, so a fixed wait
  // read the twin frozen part-way on the slower hosted macOS runner (ref 100, poly 200 px after a 300 px stream, 2026-10-26)
  await onBoth(ctx, ref, page, async (p) => { await H.wheelStream(p, { x: 700, y: 60, deltaY: 100, count: 3, intervalMs: 16 }); await stable(p, 'scrollY'); });
  await stable(page, 'scrollY'); await ctx.focus(ref); await stable(ref, 'scrollY'); await ctx.focus(page);
  const ps = await scrollTops(page); const prs = await scrollTops(ref);
  ctx.check('page scroll moved both pages equally', ps.y > 0 && ps.y === prs.y, { poly: ps.y, ref: prs.y }, 'scroll');
  await compare(ctx, ref, page, 'page-scroll', numbers);
  await onBoth(ctx, ref, page, (p) => p.evaluate('scrollTo(0, 0)'));

  // keyboard scroll: click a row's text (focus the scroller area), PageDown x2
  await onBoth(ctx, ref, page, (p) => p.evaluate('document.querySelector("#list").scrollTop = 0'));
  await H.sleep(300);
  await ctx.focus(ref);
  const rect = await rectsOf(ref, ['#list', '.row[data-i="3"] .txt']);
  const rowText = center(rect['.row[data-i="3"] .txt']);
  const before = await scrollTops(page);
  await onBoth(ctx, ref, page, async (p) => { await p.click(rowText.x, rowText.y); await H.sleep(100); await H.pressKeys(p, ['PageDown', 'PageDown'], { intervalMs: 120 }); });
  await stable(page); await ctx.focus(ref); await stable(ref); await ctx.focus(page);
  const after = await scrollTops(page); const afterRef = await scrollTops(ref);
  ctx.check('keyboard PageDown scrolls the live list by >= one page (plain DOM reference scrolled too)', after.list >= 500 && afterRef.list >= 500, { before: before.list, poly: after.list, ref: afterRef.list }, 'scroll');
  await ctx.focus(ref); await ref.evaluate(`document.querySelector('#list').scrollTop = ${after.list}`);
  await compare(ctx, ref, page, 'keyboard-scroll', numbers);
  await stickyFromCanvas(ctx, ref, page, 'keyboard-scroll', numbers);

  // Tab focus reveal: tab until an input far below is focused; the scroller scrolls it into view
  const tabTo = async (p, id) => {
    await p.evaluate('document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0); document.querySelector("#list").scrollTop = 0');
    await H.sleep(100);
    for (let i = 0; i < 80; i++) {
      await p.key('Tab'); await H.sleep(30);
      if (await p.evaluate(`document.activeElement && document.activeElement.id`) === id) return i + 1;
    }
    return -1;
  };
  const tabs = {};
  await onBoth(ctx, ref, page, async (p, which) => { tabs[which] = await tabTo(p, 'in-25'); });
  await H.sleep(500);
  numbers.tabPresses = tabs;
  const reveal = await page.evaluate(`(() => { const e = document.activeElement.getBoundingClientRect(); const l = document.querySelector('#list').getBoundingClientRect(); return { id: document.activeElement.id, inside: e.top >= l.top - 1 && e.bottom <= l.bottom + 1, listTop: document.querySelector('#list').scrollTop }; })()`);
  ctx.check('Tab to a far row focuses the live input and reveals it inside the list', tabs.poly > 0 && reveal.inside && reveal.listTop > 0, { tabs, reveal }, 'scroll');
  await compare(ctx, ref, page, 'tab-reveal', numbers);
  await onBoth(ctx, ref, page, (p) => p.evaluate('document.activeElement.blur(); document.querySelector("#list").scrollTop = 0'));

  // position:fixed child inside the drawable (the drawable is a containing block for fixed descendants)
  await onBoth(ctx, ref, page, (p, which) => p.evaluate(`(() => { const root = document.querySelector('#root'); if (${JSON.stringify(which)} === 'ref') { root.style.contain = 'layout'; root.style.isolation = 'isolate'; }
    const d = document.createElement('div'); d.id = 'fixed-child'; d.textContent = 'fixed child'; d.style.cssText = 'position:fixed;left:300px;top:200px;width:160px;height:44px;background:#d33;color:#fff;font:700 16px sans-serif;display:grid;place-items:center;z-index:5'; root.appendChild(d); })()`));
  await compare(ctx, ref, page, 'fixed-child', numbers);
  await ctx.focus(ref);
  const fr = await rectsOf(ref, ['#fixed-child', '#hic-surface']);
  await ctx.focus(page);
  const fx = await canvasShot(page, '#hic-surface');
  const fshare = colorShare(fx.img, fr['#fixed-child'], { x: fr['#hic-surface'].x, y: fr['#hic-surface'].y }, fx.geo.dpr, RED, 24);
  numbers.fixedChildRedShare = fshare;
  ctx.check('the fixed child is visible in the canvas pixels (red box fills its rect, share >= 60 %)', fshare >= 0.6, { fshare }, 'region');

  // :hover painted
  await onBoth(ctx, ref, page, (p) => p.evaluate(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(CSS_EXTRA)}; document.head.appendChild(s); })()`));
  await H.sleep(300);
  await onBoth(ctx, ref, page, (p) => p.evaluate('document.querySelector("#fixed-child")?.remove()'));
  const hoverRect = (await rectsOf(ref, ['.row[data-i="6"]']))['.row[data-i="6"]'];
  const hoverRow = center(hoverRect);
  for (const [which, p] of [['ref', ref], ['poly', page]]) {
    await p.bringToFront(); await H.sleep(200);
    await p.mouseMove(hoverRow.x - 40, hoverRow.y - 3); await p.mouseMove(hoverRow.x, hoverRow.y);
    await H.sleep(600);
    numbers[`hoverMatches_${which}`] = await p.evaluate(`document.querySelector('.row[data-i="6"]').matches(':hover') ? 'hover' : 'no-hover'`);
  }
  ctx.check('hover: the plain DOM row is hovered (the input reached it)', numbers.hoverMatches_ref === 'hover', numbers, 'scroll');
  // no refocus between the move and the reads: the click of focusPage would move the pointer away and drop :hover
  const twinHover = await H.screenshotElement(ref, '#hic-surface').catch(() => null);
  await page.bringToFront(); await H.sleep(200);
  await page.mouseMove(hoverRow.x - 40, hoverRow.y - 3); await page.mouseMove(hoverRow.x, hoverRow.y); await H.sleep(500);
  const polyHover = await canvasShot(page, '#hic-surface');
  const geoH = polyHover.geo;
  const hs = colorShare(polyHover.img, hoverRect, { x: r['#hic-surface'].x, y: r['#hic-surface'].y }, geoH.dpr, [0x7a, 0x30, 0x30], 20);
  numbers.hoverRowShare = hs;
  ctx.check('the hovered row is painted with the :hover colour in the canvas pixels (share >= 30 %)', hs >= 0.3, { hs }, 'region');
  if (twinHover) {
    const cmp = H.compareImages(polyHover.img, twinHover.img, { tolerance: 16, diffImage: false });
    numbers.hover = cmp.sizeMatch ? { fraction: cmp.fraction, countOver16: cmp.countOver16 } : { sizeMismatch: cmp.sizes };
    ctx.check('hover: O-pixel <= 3 % against plain DOM (canvas backing store)', cmp.sizeMatch && cmp.fraction <= 0.03, numbers.hover, 'pixel');
  }

  await ctx.focus(page);
  const report = await watch.stop();
  numbers.blank = { frames: report.frames, blankFrames: report.blankFrames.length, valid: report.valid };
  ctx.check(`blank watch across wheel, page scroll, keyboard, Tab and hover ran on a canvas with content (${report.frames} frames)`, report.valid && report.frames >= 20, { frames: report.frames, baseline: report.baseline }, 'blank');
  ctx.check('zero blank frames in every rendering update while the page scrolled', report.blankFrames.length === 0, { blankFrames: report.blankFrames.slice(0, 5), runs: report.blankRuns }, 'blank');
  const errs = page.errors({ includeWarnings: false }).slice(errors0);
  ctx.check('no page error or console error', errs.length === 0, errs.slice(0, 3), 'surface');
  numbers.dpr = fx.geo.dpr;
  return { numbers };
}, { controlSabotage: ['stale', 'nowheel'], controlClasses: ['pixel', 'region', 'scroll', 'content'] });
