// G-regress-pagescroll: a sticky drawable moves inside the live layer when the PAGE scrolls (its scrollport is the viewport), and nothing but that scroll announces it.
// The hit-test correction was computed from the offset measured before the scroll, so after a trusted page scroll a trusted click on the place where the app draws the
// drawable missed it (it hit the outer drawable). The layer now re-measures sticky / fixed drawables in the scroll events of a page scroll, with a passive listener that
// exists only while such a drawable does.
//   hit   trusted wheel scroll of the page (sticky engaged), then a trusted click at the drawn place: it reaches the sticky drawable (and elementsFromPoint agrees); again after scrolling back
//   idle  no window scroll listener of the polyfill without a sticky / fixed drawable; exactly one, passive, with one
// Positive control (sabotage nopagescroll): the polyfill's window scroll listener is dropped (the build before the fix had none): both classes must go red.
import { runGate, H } from './lib/gate.mjs';
import { openRegress } from './lib/regress.mjs';

/** Scroll the page with trusted wheel events over the empty area right of the canvas until scrollY reaches `y` (smooth scrolling animates), then let a frame pass. */
async function scrollPageTo(page, y) {
  for (let i = 0; i < 20; i++) {
    const now = await page.evaluate('scrollY');
    if (Math.abs(now - y) < 1) break;
    await page.wheel(600, 300, 0, y - now);
    await page.waitForFunction(`Math.abs(scrollY - ${y}) < 1`, { timeout: 1500 }).catch(() => {});
  }
  await H.sleep(150);
  return page.evaluate('scrollY');
}

/** Trusted click at the centre of the drawn sticky button; returns what reached it. */
async function clickDrawn(page) {
  const at = await page.evaluate(`(() => { const r = document.getElementById('c').getBoundingClientRect(); return { x: r.left + window.__at[0] + 60, y: r.top + window.__at[1] + 20 }; })()`);
  const top = await page.evaluate(`(document.elementsFromPoint(${at.x}, ${at.y})[0] || {}).id || ''`);
  const before = await page.evaluate('window.__clicks');
  await page.click(at.x, at.y);
  await H.sleep(120);
  const clicks = (await page.evaluate('window.__clicks')) - before;
  return { ...at, top, clicks };
}

runGate('G-regress-pagescroll', async (ctx) => {
  const numbers = {};
  const page = await ctx.page();
  const errors0 = page.errors().length;

  await openRegress(ctx, page, 'sticky-scroll.html', { sticky: 0 });
  numbers.listenersStatic = await page.evaluate('window.__winScroll');
  ctx.check('idle: without a sticky / fixed drawable the polyfill has no window scroll listener', numbers.listenersStatic === 0, numbers.listenersStatic, 'idle');

  await openRegress(ctx, page, 'sticky-scroll.html', { sticky: 1 });
  numbers.listenersSticky = await page.evaluate('({ n: window.__winScroll, passive: window.__winScrollPassive })');
  ctx.check('idle: with a drawn sticky drawable there is exactly one window scroll listener, and it is passive', numbers.listenersSticky.n === 1 && numbers.listenersSticky.passive === true, numbers.listenersSticky, 'idle');

  const rest = await clickDrawn(page);
  ctx.check('hit: before any scroll, a click on the drawn sticky button reaches it', rest.clicks === 1 && rest.top === 's', rest, 'surface');

  const y = await scrollPageTo(page, 200);
  // the canvas top is above the viewport and the outer drawable still covers the viewport top: the sticky box is stuck there, 100 px below its place at rest
  const geo = await page.evaluate(`(() => { const r = document.getElementById('c').getBoundingClientRect(); return { canvasTop: r.top, canvasBottom: r.bottom }; })()`);
  const after = await clickDrawn(page);
  numbers.afterScroll = { scrollY: y, ...geo, ...after };
  ctx.check('the page really scrolled far enough to stick the sticky drawable', y >= 199 && geo.canvasTop <= -50 && geo.canvasBottom > 100, { y, ...geo }, 'surface');
  ctx.check('hit: after a trusted page scroll, a trusted click on the drawn sticky button reaches it', after.clicks === 1, after, 'hit');
  ctx.check('hit: ... and elementsFromPoint at that place returns it', after.top === 's', after, 'hit');

  await scrollPageTo(page, 0);
  const back = await clickDrawn(page);
  numbers.back = back;
  ctx.check('hit: scrolled back to the top, the click reaches it again', back.clicks === 1 && back.top === 's', back, 'hit');

  const errs = page.errors({ includeWarnings: false }).slice(errors0);
  const drawErrors = await page.evaluate('window.__errors');
  ctx.check('no page error, no draw error', errs.length === 0 && drawErrors.length === 0, { errs: errs.slice(0, 3), drawErrors }, 'surface');
  return { numbers };
}, { controlSabotage: ['nopagescroll'], controlClasses: ['hit', 'idle'] });
