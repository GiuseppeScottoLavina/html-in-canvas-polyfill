// G-wicg-examples: the official examples of the WICG HTML-in-Canvas repository, served UNMODIFIED (test/vendor/wicg-examples, VERSION.json), through the polyfill
// against Chrome's own implementation of the same examples. Code written by others, the way the proposal shows it: a polyfill that only passes our own fixtures
// can still break here (an example finds its drawable with document.querySelector('canvas form'), loads its matrix library from a CDN, attaches its paint handler
// in onload, uploads textures only for the elements a paint event lists as changed).
//   pixel  the polyfill's canvas against native's: delta > 16 on at most LIMIT of the pixels (2D: the backing store; WebGL: a screenshot of the canvas with the
//          live layer hidden), and the canvas is not blank. The 2D examples differ from native only on the edges of glyphs: the labels and the text are drawn at
//          fractional canvas positions, which the polyfill snaps for near-1:1 draws (api/draw-math.js; the same cause as G-pixel-dpr's F1 budget).
//   place  the picture is where native puts it: of the whole-pixel shifts -1..1 in x and y, no shift brings the polyfill's canvas closer to native's (the
//          difference without a shift is at most PLACE_RATIO of the best shifted one). A fraction budget alone cannot tell glyph edges from a picture moved by a
//          pixel; measured ratios 0.60-0.72.
//   surface no page error, and no request leaves the test server (the CDN script of webGL.html is answered with the vendored copy, the bytes its integrity
//          attribute names).
// Determinism: Math.random is fixed at 0.5 on both sides before any script runs (nested-sparkles draws random dots every frame); webGL.html is at rest without
// input (its card turns only on a click).
// Known red (KNOWN): a case listed there is reported with its reason and does not fail the gate; a listed case that passes fails it, so the list cannot go stale.
// Positive control (sabotage shift1: every 2D draw one device pixel to the right): pixel and place go red.
//   node test/gates/g-wicg-examples.mjs --dpr=1|2 (run-all runs both)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runGate, H, ROOT } from './lib/gate.mjs';
import { canvasShot, compositorShot } from './lib/pixel.mjs';

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const DPR = Number(arg('dpr') ?? 2);
const WINDOW = [1400, 1000];
const BASE = '/test/vendor/wicg-examples/';
const VENDOR = resolve(ROOT, 'test/vendor/wicg-examples');
const GPU_BUNDLE = resolve(ROOT, 'dist/hic-live-gpu.iife.js');
const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/gl-matrix/2.8.1/gl-matrix-min.js';
/** delta > 16 budgets per example and DPR (measured 2026-11-20, Chrome 157.0.8103.79, M1 Max; see TEST-PLAN) */
const EXAMPLES = [
  { file: 'complex-text.html', selector: '#canvas', kind: '2d', limit: { 1: 0.035, 2: 0.02 } },
  { file: 'nested-sparkles.html', selector: '#canvas', kind: '2d', limit: { 1: 0.02, 2: 0.011 } },
  { file: 'pie-chart.html', selector: 'canvas', kind: '2d', limit: { 1: 0.052, 2: 0.03 } },
  { file: 'webGL.html', selector: '#gl-canvas', kind: 'webgl', limit: { 1: 0.001, 2: 0.001 } },
];
const PLACE_RATIO = 0.85;
/** `${file}@${dpr}` -> why it is red; see the header */
const KNOWN = {
  // webGL.html@1 left the list with the fix of issue #150 (changedElements after a size write and a geometry change, as Chromium lists them)
};
const SETUP = 'Math.random = () => 0.5;';

/** @param {any} page @param {string[]} external */
async function routeNetwork(page, external) {
  const lib = readFileSync(resolve(VENDOR, 'gl-matrix-min.js'));
  page.on('Fetch.requestPaused', (/** @type {any} */ e) => {
    const url = e.request.url;
    if (url === CDN) {
      page.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: 200, body: lib.toString('base64'),
        responseHeaders: [{ name: 'content-type', value: 'application/javascript' }, { name: 'access-control-allow-origin', value: '*' }] }).catch(() => {});
    } else if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) {
      page.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {});
    } else {
      external.push(url);
      page.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    }
  });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: 'http*://*' }] });
}

/** @param {any} page @param {any} srv @param {{file: string, selector: string, kind: string}} ex */
async function shoot(page, srv, ex) {
  await page.navigate(new URL(BASE + ex.file, srv.url).href);
  await H.sleep(1500);
  return ex.kind === '2d' ? (await canvasShot(page, ex.selector)).img : (await compositorShot(page, ex.selector)).img;
}

/** Native references, captured in their own browser before the gate's (one browser at a time). */
async function nativeReferences() {
  const refs = new Map();
  const external = [];
  const srv = await H.startServer();
  let browser = null;
  try {
    browser = await H.launchChrome({ name: 'gate-G-wicg-examples-native', chrome: 'stable', nativeDrawElement: true, dpr: DPR, windowSize: WINDOW });
    const page = await browser.newPage({ reuseFirst: true });
    await page.ensureForeground({ timeout: 2500 }).catch(() => {});
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: SETUP });
    await routeNetwork(page, external);
    for (const ex of EXAMPLES) refs.set(ex.file, await shoot(page, srv, ex));
    const errors = page.errors({ includeWarnings: false });
    return { refs, external, errors, version: browser.version?.Browser ?? null, error: null };
  } catch (err) {
    return { refs, external, errors: [], version: browser?.version?.Browser ?? null, error: String(err?.message ?? err).slice(0, 400) };
  } finally {
    await browser?.close().catch(() => {});
    await srv.close();
  }
}

/** share of pixels with delta > 16 between `a` and `b` moved by (dx, dy), over the area both cover minus a 2 px frame */
function shiftedDiff(a, b, dx, dy) {
  let n = 0, t = 0;
  for (let y = 2; y < a.height - 2; y++) {
    const yb = y + dy;
    for (let x = 2; x < a.width - 2; x++) {
      const xb = x + dx, i = (y * a.width + x) * 4, j = (yb * b.width + xb) * 4;
      t++;
      if (Math.max(Math.abs(a.data[i] - b.data[j]), Math.abs(a.data[i + 1] - b.data[j + 1]), Math.abs(a.data[i + 2] - b.data[j + 2])) > 16) n++;
    }
  }
  return n / t;
}

const native = await nativeReferences();

runGate('G-wicg-examples', async (ctx) => {
  const numbers = { dpr: DPR, native: native.version, knownRed: [] };
  ctx.check('the native references were captured (Chrome with CanvasDrawElement), with no page error', !native.error && native.refs.size === EXAMPLES.length && native.errors.length === 0,
    { error: native.error, errors: native.errors.slice(0, 3) }, 'surface');
  if (native.error) return { numbers };
  const page = await ctx.page();
  await ctx.focus(page);
  const external = [];
  const core = await (await fetch(new URL(ctx.bundle, ctx.srv.url))).text();
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: SETUP });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `${core}\n;${readFileSync(GPU_BUNDLE, 'utf8')}` });
  await routeNetwork(page, external);
  const errors0 = page.errors().length;
  for (const ex of EXAMPLES) {
    const img = await shoot(page, ctx.srv, ex);
    const ref = native.refs.get(ex.file);
    const cmp = H.compareImages(img, ref, { tolerance: 16 });
    const row = { size: [img.width, img.height], sizeMatch: cmp.sizeMatch, vsNative: cmp.sizeMatch ? +(cmp.fraction * 100).toFixed(3) : 100, content: +H.pixelStats(img).nonDominantFraction.toFixed(4),
      nativeContent: +H.pixelStats(ref).nonDominantFraction.toFixed(4), limit: ex.limit[DPR] * 100 };
    const pixelOk = row.sizeMatch && row.content >= row.nativeContent * 0.5 && row.vsNative <= row.limit;
    if (row.sizeMatch) {
      const shifts = [];
      for (const dy of [-1, 0, 1]) for (const dx of [-1, 0, 1]) if (dx || dy) shifts.push(shiftedDiff(img, ref, dx, dy));
      row.placeRatio = +(shiftedDiff(img, ref, 0, 0) / Math.max(1e-9, Math.min(...shifts))).toFixed(3);
    }
    const placeOk = row.sizeMatch && row.placeRatio <= PLACE_RATIO;
    const key = `${ex.file}@${DPR}`;
    if (KNOWN[key] && !ctx.control) {
      numbers.knownRed.push({ case: key, reason: KNOWN[key], red: !(pixelOk && placeOk), row });
      ctx.check(`${ex.file} at DPR ${DPR}: KNOWN RED (${KNOWN[key].slice(0, 60)}...) is still red (a known red that passes must leave KNOWN)`, !(pixelOk && placeOk), row, 'surface');
    } else {
      ctx.check(`${ex.file} at DPR ${DPR}: the canvas is not blank and equals native's (delta > 16 on <= ${row.limit.toFixed(1)} %)`, pixelOk, row, 'pixel');
      if (ex.kind === '2d') ctx.check(`${ex.file} at DPR ${DPR}: drawn where native draws it (no whole-pixel shift is closer, ratio <= ${PLACE_RATIO})`, placeOk, row, 'place');
    }
    numbers[ex.file] = row;
  }
  ctx.check('no request leaves the test server (the CDN script is answered with the vendored copy)', external.length === 0 && native.external.length === 0,
    { poly: external.slice(0, 3), native: native.external.slice(0, 3) }, 'surface');
  const errs = page.errors({ includeWarnings: false }).slice(errors0);
  ctx.check('no page error', errs.length === 0, errs.slice(0, 3), 'surface');
  return { numbers };
}, { dpr: DPR, windowSize: WINDOW, controlSabotage: ['shift1'], controlClasses: ['pixel', 'place'] });
