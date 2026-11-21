// G-css-var-shorthand: a shorthand with var() that a later longhand of the same rule partly overrides (`border: solid var(--c); border-width: 0 1.5px 1.5px 0`), drawn
// through the polyfill against Chrome's own implementation of the same page (fixtures/css-var-shorthand). The CSSOM serialises such a rule with its other longhands
// empty (Chrome 157: `border-top-style: ;`), and the snapshot copied it lossy: the border lost its style and colour and was not drawn. Found by a library built on
// the polyfill (a summary::before chevron, 1.5 px or 2 px alike); the same loss moved a `margin: var()` box and changed a `font: var()` text.
//   pixel     every case's canvas equals native's: delta > 16 on at most LIMIT pixels, and native draws something there. The cases: the chevron of the report
//             (v1) and its variants (2 px, not rotated, the variable on the element, inline-block, a real element instead of the pseudo-element), margin and font,
//             a linked sheet inside @media and a sheet reached through @import; the same look without var() or with longhands is the baseline (v3, v4, v7, v9, v12, v13b, v14b).
//   surface   both pages paint every canvas, no page error.
// DPR 1: at DPR 2 a 1.5 px border on these 1x canvases differs from native with or without var() (the baselines too, the same before the fix): another matter.
// Positive control (sabotage lossycss: the sheet's own text cannot be parsed): the var() cases go red, the baselines stay green.
import { runGate, H } from './lib/gate.mjs';

const FIXTURE = '/test/gates/fixtures/css-var-shorthand/index.html';
const LIMIT = 2;
const WINDOW = [900, 400];

/** @param {any} page @param {string} url @param {string|null} core */
async function shoot(page, url, core) {
  if (core) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: core });
  await page.navigate(url);
  await page.waitForFunction(`__painted() >= document.querySelectorAll('canvas').length`, { timeout: 15000 });
  await H.sleep(1500);
  return page.evaluate('({ mode: window.__HIC__?.installed?.mode ?? null, cases: __V, px: __px(), canvases: document.querySelectorAll("canvas").length, painted: __painted() })');
}

async function nativeReference() {
  const srv = await H.startServer();
  let browser = null;
  try {
    browser = await H.launchChrome({ name: 'gate-G-css-var-shorthand-native', chrome: 'stable', nativeDrawElement: true, dpr: 1, windowSize: WINDOW, extraArgs: ['--headless=new'] });
    const page = await browser.newPage({ reuseFirst: true });
    const shot = await shoot(page, new URL(FIXTURE, srv.url).href, null);
    return { ...shot, errors: page.errors({ includeWarnings: false }), version: browser.version?.Browser ?? null, error: null };
  } catch (err) {
    return { px: {}, cases: {}, errors: [], version: browser?.version?.Browser ?? null, error: String(err?.message ?? err).slice(0, 400) };
  } finally {
    await browser?.close().catch(() => {});
    await srv.close();
  }
}

/** pixels whose channel delta exceeds 16, and the pixels native draws (not white) @param {number[]} a @param {number[]} b */
function compare(a, b) {
  let diff = 0, ink = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3])) > 16) diff++;
    if (b[i + 3] > 0 && (b[i] < 235 || b[i + 1] < 235 || b[i + 2] < 235)) ink++;
  }
  return { diff, ink };
}

const native = await nativeReference();

runGate('G-css-var-shorthand', async (ctx) => {
  const numbers = { native: native.version, limit: LIMIT, cases: {} };
  ctx.check('the native reference ran (Chrome with CanvasDrawElement, no polyfill), every canvas painted, no page error',
    !native.error && native.painted >= native.canvases && native.errors.length === 0, { error: native.error, errors: native.errors?.slice(0, 3) }, 'surface');
  if (native.error) return { numbers };
  const page = await ctx.page();
  const core = await (await fetch(new URL(ctx.bundle, ctx.srv.url))).text();
  const errors0 = page.errors().length;
  const poly = await shoot(page, new URL(FIXTURE, ctx.srv.url).href, core);
  ctx.check('the polyfill drew the page (mode polyfill), every canvas painted', poly.mode === 'polyfill' && poly.painted >= poly.canvases, { mode: poly.mode, painted: poly.painted }, 'surface');
  for (const [id, label] of Object.entries(native.cases)) {
    const got = poly.px[id], ref = native.px[id];
    if (!got || !ref || got.length !== ref.length) { ctx.check(`${id} (${label}): both canvases exist with the same size`, false, { got: got?.length, ref: ref?.length }, 'surface'); continue; }
    const c = compare(got, ref);
    numbers.cases[id] = { label, ...c };
    ctx.check(`${id} (${label}): equals native (delta > 16 on ${c.diff} <= ${LIMIT} pixels; native draws ${c.ink})`, c.ink > 0 && c.diff <= LIMIT, c, 'pixel');
  }
  const errs = page.errors({ includeWarnings: false }).slice(errors0);
  ctx.check('no page error', errs.length === 0, errs.slice(0, 3), 'surface');
  return { numbers };
}, { dpr: 1, windowSize: WINDOW, headless: true, controlSabotage: ['lossycss'], controlClasses: ['pixel'] });

