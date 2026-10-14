// G-listeners: the polyfill must not put main-thread work on the compositor-driven scroll (a non-passive wheel/touch/scroll listener) and must leave nothing behind.
//   Audited with the effect host OFF and ON, and after UNINSTALL; two independent instruments (DOMDebugger.getEventListeners incl. pierce into shadow roots, visualViewport, screen,
//   document.fonts and every media query list + a registration tracker; see lib/listeners.mjs). Listeners are attributed to the polyfill by their script URL.
//   After uninstall: zero listeners, zero active observers, zero intervals, no rAF callback fires.
// Positive control: scripts named like the bundle register a document wheel listener, a wheel listener on an element inside a shadow root, a visualViewport wheel listener and a
// non-passive window scroll listener (class 'forbidden'), and after uninstall a listener, a ResizeObserver and an interval (class 'leftover'): each must be seen.
import { runGate, H } from './lib/gate.mjs';
import { openAuditPage, checkListenerState, checkClean } from './lib/listeners.mjs';
import { setupEffect } from './lib/effect.mjs';

const CONTROL_URL = '//# sourceURL=http://127.0.0.1/dist/hic-live-polyfill.control.js';

async function exercise(page) {
  const r = await page.evaluate(`document.getElementById('name').getBoundingClientRect().toJSON()`);
  await page.click(r.x + r.width / 2, r.y + r.height / 2);
  await H.typeKeys(page, 'a', { intervalMs: 40 });
  await page.mouseMove(r.x + 10, r.y + 10);
  await H.sleep(500);
}

runGate('G-listeners', async (ctx) => {
  const numbers = {};
  const { page, urls } = await openAuditPage(ctx);

  // --- A: effect host off -----------------------------------------------------------------------------------------------------------------
  await page.navigate(H.fixtureUrl(ctx.srv, 'f1', { mode: 'poly', bundle: ctx.bundle }));
  await page.waitForFunction('window.__HIC_FIXTURE && window.__HIC_FIXTURE.ready', { timeout: 20000 });
  await ctx.focus(page);
  await exercise(page);
  if (ctx.control) {
    await page.evaluate(`(() => { document.addEventListener('wheel', () => {}, { capture: true }); const h = document.createElement('div'); const sr = h.attachShadow({ mode: 'open' }); const i = document.createElement('span'); sr.appendChild(i); i.addEventListener('wheel', () => {}); document.body.appendChild(h);
      window.visualViewport.addEventListener('wheel', () => {}); window.addEventListener('scroll', () => {}); })()\n${CONTROL_URL}`);
  }
  await checkListenerState(ctx, { page, urls, label: 'effect host off', numbers });
  const errsA = page.errors({ includeWarnings: false });
  ctx.check('no page error or console error (effect off)', errsA.length === 0, errsA.slice(0, 3), 'audit');

  // --- B: effect host on (the interposer registers capture pointer listeners on the layer by design) --------------------------------------------
  await ctx.focus(page);
  await setupEffect(ctx, page, { interposer: true });
  await exercise(page);
  await checkListenerState(ctx, { page, urls, label: 'effect host on', effectHost: true, numbers });

  // --- C: install -> exercise -> uninstall: nothing may be left ------------------------------------------------------------------------------
  await page.navigate(new URL('/test/fixtures/identity/index.html?bundle=' + ctx.bundle, ctx.srv.url).href);
  await ctx.focus(page);
  await page.waitForFunction('typeof HicLivePolyfill === "object" && !!window.__id', { timeout: 10000 });
  await page.evaluate('window.__id.install()');
  await H.sleep(600);
  const ir = await page.evaluate(`document.getElementById('in').getBoundingClientRect().toJSON()`);
  await page.click(ir.x + ir.width / 2, ir.y + ir.height / 2);
  await H.sleep(300);
  await checkListenerState(ctx, { page, urls, label: 'installed (identity page)', numbers });
  await page.evaluate('window.__id.uninstall()');
  if (ctx.control) await page.evaluate(`(() => { window.addEventListener('resize', () => {}); new ResizeObserver(() => {}).observe(document.body); setInterval(() => {}, 1000); })()\n${CONTROL_URL}`);
  await H.sleep(300);
  await checkClean(ctx, { page, urls, label: 'after uninstall', numbers });
  return { numbers };
}, { controlClasses: ['forbidden', 'leftover'] });
