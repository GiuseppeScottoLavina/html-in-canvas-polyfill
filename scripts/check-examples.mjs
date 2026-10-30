#!/usr/bin/env node
// G-examples: every page under examples/ loads in HEADLESS Chrome against the BUILT dist/ and works.
//
//   npm run build && npm run test:examples
//   node scripts/check-examples.mjs [--only=basic,form,smoke] [--no-control] [--chrome=stable|canary|/path] [--native]
//   --only takes example names, `smoke` (every smoke page) or `smoke:<name>` (only those smoke pages; the macOS CI job leaves out the WebGPU one)
//   --native: Chrome Canary with --enable-blink-features=CanvasDrawElement, and every example must run in mode native (the browser's own implementation;
//   used by test/native-effects/run.mjs for effect-plugin)
//
// Per example (real run):
//   1. no console error, no page exception, no failed request (Log errors such as a 404 count)
//   2. the polyfill API is installed (public names; mode 'polyfill', or 'native' on a Chrome that ships the API)
//   3. the live layer is invisible (computed opacity 0), so a screenshot cannot show the live DOM instead of the canvas
//   4. the canvas is NOT BLANK (2D canvases: backing-store readback; WebGL / WebGPU canvases: compositor screenshot)
//   5. the key interaction works with TRUSTED input: typing reaches the live field AND changes the canvas pixels (basic, form,
//      webgl-texture), the frame cap slider changes canvas.frameCap (effect-plugin, plugins), wheel scroll + a viewport resize (scroll-and-resize),
//      effect-plugin's submit runs the disintegrate actions (handle.trigger 'out', then 'in') and the form re-forms with the page's answer,
//      the gallery (plugins) lists every plugin of dist/plugins/manifest.json, applies each one (its controls mount, the pixels change) and "Effect off" removes it;
//      a trusted double click on a word of its static text shows the selection on the canvas and a click elsewhere removes it (with an effect, with "Effect off", and on the 2D path)
//   playground: the code runs in a sandboxed preview frame (opaque origin), so install and mode come from the page's status line, the pixels from an element
//      screenshot of the frame cropped to its canvas; the default code is examples/basic's explainer block; the frame is sandboxed with allow-scripts only and
//      cannot reach the page; trusted click + typing in the drawn field; a forged message from another window is ignored; user errors, rejections and
//      console.error reach the console panel as text; Tab / Esc+Tab in the editor; too-long and damaged links; Share + reload restores Unicode code; Reset;
//      five runs leave one frame; an endless loop is reported and Reset recovers
//   effect-plugin and plugins run a second time with navigator.gpu hidden: the 2D fallback (and, for the gallery, the message and the disabled effects),
//   and a third time with navigator.gpu present but requestAdapter() resolving null (simulators, blocklisted GPUs): the same 2D fallback must draw
//   (the canvas must not have been claimed by a 'webgpu' context before the adapter was known)
// Smoke pages (test/examples-smoke/, served by the harness server) run the code the documentation shows:
//   esm-quickstart  README "ES modules": install() from dist/esm/index.js, then the standard pattern
//   doc-readme-basic, doc-getting-started   the HTML blocks printed in README.md and docs/guides/GETTING-STARTED.md, extracted from the Markdown and run as written
//   wobble-plugin   docs/guides/EFFECTS-PLUGINS.md: the complete plugin (the guide's block must equal the smoke file); its captureInputMapper
//                   is compared with GPU pixels, and its action runs through handle.trigger
//                   (control inside the check: the identity mapper must be visibly wrong on the same pixels)
// Positive controls (the script fails if any of them does not turn red):
//   C1  the dist path is broken (the polyfill script URL answers 404): every example must report failed checks
//   C2  a click that misses the field: the "typing reaches the field" and "pixels changed" checks of `basic` must fail
//   C3  a blank canvas must be classified blank by the pixel check
//   C4  the ESM entry is missing: the ESM smoke page must fail
//   C5  four variants of the playground page (allow-same-origin, console text set as HTML, messages heard from any window, the old frame kept): each must turn
//       its playground check red
// Results: .scratch/results/examples-<timestamp>.json and a PNG per example next to it.
// Headless Chrome only (it never takes the screen, so it can run next to other work). The viewport is an Emulation override and says so in the result.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as H from '../test/harness/index.mjs';
import { startServer } from '../examples/serve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const only = H.arg('only')?.split(',');
/** the smoke pages to run: all of them without --only or with `smoke`, else those named `smoke:<name>` */
const smokeWanted = (/** @type {string} */ name) => !only || only.includes('smoke') || only.includes(`smoke:${name}`);
const anySmoke = !only || only.some((n) => n === 'smoke' || n.startsWith('smoke:'));
const withControl = !process.argv.includes('--no-control');
const NATIVE = process.argv.includes('--native');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(ROOT, '.scratch/results', `examples-${stamp}`);
const VIEW = { width: 1100, height: 800 };
const NAMES = ['basic', 'form', 'plugins', 'effect-plugin', 'scroll-and-resize', 'webgl-texture', 'playground'];
const DIST_FILES = [...['hic-live-polyfill', 'hic-live-engines', 'hic-live-gpu', 'hic-live-effects'].map((n) => `dist/${n}.iife.min.js`), 'dist/plugins/manifest.json', 'dist/plugins/water.iife.min.js', 'dist/plugins/disintegrate.iife.min.js'];

// ------------------------------------------------------------------------------------------------------------------------------------
// Defects of src/ that this script found and does not hide. Each entry is printed on every run as KNOWN RED and recorded in the result file;
// it matches ONE console message of ONE example, so any other error still fails the check. Remove the entry when src/ is fixed.
/** @type {Array<{id: string, examples: string[], pattern: RegExp, where: string}>} */
const KNOWN_RED = []; // empty: the effects-frame-before-presenter entry was removed when src/effects/effect-host.js was fixed


const sleep = H.sleep;
const q = JSON.stringify;

/** @typedef {{name: string, ok: boolean, detail?: unknown, cls: string}} Check */

class Run {
  /** @param {import('../test/harness/lib/page.mjs').Page} page @param {string} name @param {string} baseUrl */
  constructor(page, name, baseUrl) { this.page = page; this.name = name; this.baseUrl = baseUrl; /** @type {Check[]} */ this.checks = []; this.numbers = {}; this.notes = []; this.shots = {}; /** @type {string[]} */ this.known = []; }
  /** @param {string} cls check class: load | install | leak | surface | interact */
  check(cls, name, ok, detail) { this.checks.push({ cls, name, ok: !!ok, ...(detail === undefined ? {} : { detail }) }); return !!ok; }
  /** Run a step; an exception is a failed check, never a crash of the whole script. */
  async step(cls, name, fn) {
    try { const out = await fn(); if (out !== undefined) this.check(cls, name, out === true || out?.ok === true, out === true ? undefined : out); }
    catch (error) {
      if (error instanceof H.CdpTimeoutError) throw error; // a stuck renderer cannot be recovered: abort the whole run (main kills the browser)
      this.check(cls, name, false, { error: String(error?.message ?? error).slice(0, 300) });
    }
  }
  failed() { return this.checks.filter((c) => !c.ok); }
}

/** Center of an element's border box in viewport CSS px. */
const centerOf = (page, selector) => page.evaluate(`(() => { const e = document.querySelector(${q(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()`);

/** The canvas as pixels. 'gpu' canvases (WebGL / WebGPU) cannot be read back reliably: compositor screenshot (the live layer is opacity 0, asserted separately). */
async function canvasImage(page, selector, kind) {
  if (kind === '2d') return H.readCanvas(page, selector, { waitFrames: 2 });
  return (await H.screenshotElement(page, selector)).img;
}


/** Trusted typing, refused (as a failed check) when no editable element has focus: see Page.typeText for why sending keys there must never happen. */
const typeText = (page, text, intervalMs = 25) => page.typeText(text, { intervalMs });

async function setViewport(page, width, height) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
}

/** Steps shared by every example. Returns the first non-blank image (or null). */
async function genericChecks(run, { canvas, kind, ready }) {
  const { page } = run;
  await run.step('install', 'the polyfill (or a native implementation) provides drawElementImage', async () => {
    const info = await page.evaluate(`({ api: typeof CanvasRenderingContext2D.prototype.drawElementImage === 'function', mode: window.__HIC__ && window.__HIC__.installed ? window.__HIC__.installed.mode : null, error: window.__HIC__ && window.__HIC__.error ? String(window.__HIC__.error.message) : null })`);
    run.numbers.mode = info.mode;
    return { ok: info.api && (NATIVE ? info.mode === 'native' : info.mode === 'polyfill' || info.mode === 'native'), ...info };
  });
  await run.step('install', 'the page signalled that its setup finished', async () => ({ ok: !!(await H.until(() => page.evaluate(ready), run.fast ? 2500 : 12000)), ready }));
  let first = null;
  await run.step('surface', 'the canvas is not blank (first paint)', async () => {
    first = await H.until(async () => { const img = await canvasImage(page, canvas, kind); return H.pixelStats(img).nonBlank ? img : null; }, run.fast ? 2500 : 12000, 250);
    if (!first) { const stats = H.pixelStats(await canvasImage(page, canvas, kind)); return { ok: false, ...stats, dominantColor: undefined }; }
    return { ok: true, ...(({ distinctColors, nonDominantFraction }) => ({ distinctColors, nonDominantFraction }))(H.pixelStats(first)) };
  });
  await run.step('leak', 'the live layer is invisible (computed opacity 0, or absent in native mode)', async () => {
    const layers = await page.evaluate(`[...document.querySelectorAll('hic-layer')].map((l) => getComputedStyle(l).opacity)`);
    return { ok: layers.every((o) => o === '0'), layers };
  });
  if (first) run.shots.first = first;
  return first;
}

/** Wait until the canvas differs from `before` by more than `minPixels` pixels (delta > 16). Returns the comparison or null. */
async function changedFrom(page, selector, kind, before, minPixels = 30, timeoutMs = 6000) {
  let last = null;
  const found = await H.until(async () => {
    const img = await canvasImage(page, selector, kind);
    if (img.width !== before.width || img.height !== before.height) return null;
    last = H.compareImages(img, before);
    return last.countOver16 >= minPixels ? { ...last, img } : null;
  }, timeoutMs, 200);
  return found ?? { countOver16: last?.countOver16 ?? 0, timedOut: true };
}

/**
 * Selection of static text drawn in the canvas (a heading, not a field): a trusted double click on the word `word` must show the highlight on the canvas within
 * `timeoutMs`, and a trusted click outside the canvas must remove it again (the word's pixels return to the picture before the double click). With the effects host,
 * the source version that the host uploads must advance both times (the effect sees the new source). Measured in the word's box only, so an animated effect
 * elsewhere does not count. Returns the check detail.
 */
async function staticSelectionShows(page, selector, kind, word, { effect = false, timeoutMs = 1500 } = {}) {
  await page.evaluate(`(() => { const layer = document.querySelector('hic-layer'); const tw = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT); let t;
    while ((t = tw.nextNode())) if (t.data.includes(${q(word)})) { t.parentElement.scrollIntoView({ block: 'center' }); break; }
    getSelection().removeAllRanges();
    window.__selSource = null; if (!window.__selSourceListener) { window.__selSourceListener = true; document.querySelector(${q(selector)}).addEventListener('effectframe', (e) => { window.__selSource = e.detail.sourceVersion; }); } })()`);
  await sleep(400);
  const target = await page.evaluate(`(() => { const layer = document.querySelector('hic-layer'); const tw = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT); let t;
    while ((t = tw.nextNode())) { const i = t.data.indexOf(${q(word)}); if (i < 0) continue;
      const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + ${word.length}); const b = r.getBoundingClientRect(); const c = document.querySelector(${q(selector)}).getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, box: { x: b.left - c.left, y: b.top - c.top, w: b.width, h: b.height }, canvas: { w: c.width, h: c.height } }; }
    return null; })()`);
  if (!target) return { ok: false, reason: `no text "${word}" in the layer` };
  const source = () => page.evaluate('window.__selSource');
  const before = await canvasImage(page, selector, kind);
  const sx = before.width / target.canvas.w, sy = before.height / target.canvas.h;
  const x0 = Math.max(0, Math.floor(target.box.x * sx)), y0 = Math.max(0, Math.floor(target.box.y * sy));
  const x1 = Math.min(before.width, Math.ceil((target.box.x + target.box.w) * sx)), y1 = Math.min(before.height, Math.ceil((target.box.y + target.box.h) * sy));
  const area = Math.max(1, (x1 - x0) * (y1 - y0));
  /** pixels of the word's box that differ from the picture before the double click */
  const changed = (img) => { let n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * img.width + x) * 4; if (Math.abs(img.data[i] - before.data[i]) + Math.abs(img.data[i + 1] - before.data[i + 1]) + Math.abs(img.data[i + 2] - before.data[i + 2]) > 48) n++; } return n; };
  const wait = async (want) => { const t0 = Date.now(); let n = -1; do { const img = await canvasImage(page, selector, kind); n = img.width === before.width ? changed(img) : -1; if (want(n)) return { ms: Date.now() - t0, n }; await sleep(50); } while (Date.now() - t0 < timeoutMs); return { ms: null, n }; };
  const v0 = await source();
  await page.mouseMove(target.x, target.y);
  await page.mouseDown(target.x, target.y, { clickCount: 1 }); await page.mouseUp(target.x, target.y, { clickCount: 1 });
  await page.mouseDown(target.x, target.y, { clickCount: 2 }); await page.mouseUp(target.x, target.y, { clickCount: 2 });
  const selected = await page.evaluate('String(getSelection())');
  const shown = await wait((n) => n > area * 0.2);
  const v1 = await source();
  await page.click(4, target.y); // the page padding, outside the canvas: collapses the selection
  const cleared = await page.evaluate('getSelection().isCollapsed');
  const gone = await wait((n) => n >= 0 && n < area * 0.02);
  const v2 = await source();
  const sourceOk = !effect || (v1 !== null && v1 !== v0 && v2 !== null && v2 !== v1);
  return { ok: selected === word && shown.ms !== null && cleared && gone.ms !== null && sourceOk, selected, shownAfterMs: shown.ms, shownPixels: shown.n, goneAfterMs: gone.ms, residualPixels: gone.n, wordPixels: area,
    ...(effect ? { sourceVersions: [v0, v1, v2] } : {}) };
}

// ---- the playground: the canvas lives in a sandboxed preview frame (opaque origin) -----------------------------------------------------------
/**
 * Evaluate in the playground's preview frame. Chrome runs a sandboxed frame without allow-same-origin out of process: attach to its target, the
 * child of this page. A frame in the page's process (a build that does not isolate sandboxed frames, or allow-same-origin) is reached through an
 * isolated world, which sees the same DOM.
 */
async function inPreview(page, expression, started = Date.now()) {
  const value = (r) => { if (r.exceptionDetails) throw new Error('evaluate in the preview failed: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)); return r.result.value; };
  const { targetInfos } = await page.conn.send('Target.getTargets');
  const children = targetInfos.filter((t) => t.type === 'iframe' && t.parentFrameId === page.targetId);
  if (children.length > 1) {                                       // the frame of the previous run is still going away
    if (Date.now() - started > 3000) throw new Error(`${children.length} preview frames under the page`);
    await sleep(100); return inPreview(page, expression, started);
  }
  if (children.length === 1) {
    const { sessionId } = await page.conn.send('Target.attachToTarget', { targetId: children[0].targetId, flatten: true });
    try { return value(await page.conn.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)); }
    finally { await page.conn.send('Target.detachFromTarget', { sessionId }).catch(() => {}); }
  }
  const frames = (await page.send('Page.getFrameTree')).frameTree.childFrames ?? [];
  if (frames.length !== 1) throw new Error(`${frames.length} preview frames in the page`);
  const { executionContextId } = await page.send('Page.createIsolatedWorld', { frameId: frames[0].frame.id, worldName: 'playground-check' });
  return value(await page.send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true, awaitPromise: true }));
}

/** The explainer example as examples/basic prints it, between its two marker comments: the playground's default code must be exactly this. */
function basicExplainerBlock() {
  const html = readFileSync(resolve(ROOT, 'examples/basic/index.html'), 'utf8');
  const start = html.indexOf('\n', html.indexOf('<!-- ===== the WICG HTML-in-Canvas explainer')) + 1;
  return html.slice(start, html.indexOf('<!-- ===== end of the explainer example ===== -->', start));
}

/**
 * Page variants of the playground that its scenario must catch (control C5): each is one string edit of examples/playground/index.html, served in its
 * place, and the check whose name starts with `check` must turn red. The anchor must occur exactly once (else the page changed: fix the anchor).
 */
const PLAYGROUND_VARIANTS = [
  { name: 'same-origin-sandbox', edit: ['sandbox="allow-scripts"', 'sandbox="allow-scripts allow-same-origin"'], check: 'the preview is sandboxed' },
  { name: 'console-as-html', edit: ["li.textContent = (kind === 'log'", "li.innerHTML = (kind === 'log'"], check: 'an error in the user code' },
  { name: 'any-sender', edit: ['if (e.source !== preview.contentWindow) return;', ''], check: 'a message from another window' },
  { name: 'iframe-kept', edit: ['old.remove();', ''], check: 'running again replaces the preview frame' },
];

/** examples/playground/index.html with one variant's edit, or an Error when its anchor is not there exactly once. */
function playgroundVariant(variant) {
  const text = readFileSync(resolve(ROOT, 'examples/playground/index.html'), 'utf8');
  const [anchor, replacement] = variant.edit;
  const count = text.split(anchor).length - 1;
  if (count !== 1) return new Error(`ANCHOR DRIFT: the anchor of ${variant.name} occurs ${count} times in examples/playground/index.html`);
  return text.replace(anchor, replacement);
}

// ---- per example scenarios ------------------------------------------------------------------------------------------------------------
const SCENARIOS = {
  async basic(run, opts) {
    const { page } = run;
    const first = await genericChecks(run, { canvas: 'canvas', kind: '2d', ready: `!!document.querySelector('canvas') && document.querySelector('canvas').width > 0 && !!window.__HIC__` });
    if (!first || opts.generic) return;
    await run.step('interact', 'typing reaches the live input AND changes the canvas pixels', async () => {
      const c = await centerOf(page, '#name');
      await page.click(opts.misclick ? 4 : c.x, opts.misclick ? 4 : c.y);
      await sleep(150);
      await typeText(page, 'hello world');
      const value = await page.evaluate(`document.getElementById('name').value`);
      const diff = await changedFrom(page, 'canvas', '2d', first, 40);
      run.shots.after = diff.img ?? first;
      return { ok: value === 'hello world' && !diff.timedOut, value, changedPixels: diff.countOver16 };
    });
  },

  async form(run, opts) {
    const { page } = run;
    const first = await genericChecks(run, { canvas: '#stage', kind: '2d', ready: `document.getElementById('stage').width > 0 && !!window.__HIC__ && document.getElementById('log').textContent !== 'log: waiting for the first paint'` });
    if (!first || opts.generic) return;
    await run.step('interact', 'click + type in the drawn name and email fields reach the live inputs', async () => {
      for (const [sel, text] of [['#name', 'Ada Lovelace'], ['#email', 'ada@example.com']]) {
        const c = await centerOf(page, sel);
        await page.click(c.x, c.y); await sleep(150);
        await typeText(page, text);
      }
      const values = await page.evaluate(`({ name: document.getElementById('name').value, email: document.getElementById('email').value, active: document.activeElement && document.activeElement.id })`);
      return { ok: values.name === 'Ada Lovelace' && values.email === 'ada@example.com', ...values };
    });
    await run.step('interact', 'a trusted click on the drawn checkbox ticks it; the submit button runs the handler', async () => {
      const box = await centerOf(page, '#consent');
      await page.click(box.x, box.y); await sleep(150);
      const send = await centerOf(page, '#send');
      await page.click(send.x, send.y); await sleep(250);
      const state = await page.evaluate(`({ checked: document.getElementById('consent').checked, result: document.getElementById('result').textContent })`);
      return { ok: state.checked && /^Thanks, Ada Lovelace/.test(state.result), ...state };
    });
    await run.step('interact', 'the canvas pixels show the typed text and the result line', async () => {
      const diff = await changedFrom(page, '#stage', '2d', first, 300);
      run.shots.after = diff.img ?? first;
      return { ok: !diff.timedOut, changedPixels: diff.countOver16 };
    });
  },

  async ['effect-plugin'](run, opts) {
    const { page } = run;
    const pathOk = await H.until(() => page.evaluate(`document.getElementById('status').dataset.path || null`), run.fast ? 2500 : 15000);
    run.numbers.path = pathOk === 'effect' ? 'webgpu-effect' : pathOk === '2d' ? '2d-fallback' : 'unknown';
    run.notes.push(`presentation path exercised: ${run.numbers.path}${pathOk === '2d' ? (opts.noGpu ? ' (navigator.gpu hidden on purpose: this run exercises the fallback, not the effect)' : opts.noAdapter ? ' (requestAdapter() returns null on purpose: this run exercises the fallback, not the effect)' : ' (no WebGPU adapter in this headless Chrome, so the effect itself was NOT exercised)') : ''}`);
    if (opts.noGpu) run.check('install', 'with navigator.gpu hidden the page takes the 2D fallback path', pathOk === '2d', { path: run.numbers.path });
    if (opts.noAdapter) run.check('install', 'with no WebGPU adapter the page takes the 2D fallback path', pathOk === '2d', { path: run.numbers.path });
    const kind = pathOk === 'effect' ? 'gpu' : '2d';
    const first = await genericChecks(run, { canvas: '#stage', kind, ready: `!!document.getElementById('status').dataset.path` });
    if (!first || opts.generic) return;
    if (pathOk === 'effect') await sleep(3600); // the water plugin starts two ripples (3.2 s lifetime): wait until they are gone so the pointer map is near the identity
    await run.step('interact', 'click + type in the name field reaches the live input', async () => {
      const c = await centerOf(page, 'input[name=name]');
      await page.click(c.x, c.y); await sleep(200);
      await typeText(page, 'x');
      const state = await page.evaluate(`({ value: document.querySelector('input[name=name]').value, active: document.activeElement && document.activeElement.name })`);
      return { ok: state.value === 'Adax', ...state };
    });
    await run.step('interact', 'the frame cap slider changes canvas.frameCap (keyboard, trusted)', async () => {
      await page.evaluate(`document.getElementById('cap').focus()`);
      await page.key('Home'); await sleep(150);
      const at15 = await page.evaluate(`({ prop: document.getElementById('stage').frameCap, label: document.getElementById('cap-value').textContent })`);
      await page.key('ArrowRight'); await sleep(150);
      const at30 = await page.evaluate(`({ prop: document.getElementById('stage').frameCap, label: document.getElementById('cap-value').textContent })`);
      // the property is this library's extension; install() defines it over a native implementation too
      return { ok: at15.prop === 15 && at30.prop === 30 && at15.label === '15' && at30.label === '30', at15, at30 };
    });
    if (pathOk === 'effect') {
      await run.step('interact', 'the effect renders at about the cap (15 and 30 fps, page-side count of effectframe, +-30 %)', async () => {
        await page.evaluate(`window.__ef = 0; document.getElementById('stage').addEventListener('effectframe', () => { window.__ef += 1; })`);
        const rate = async (seconds) => { await page.evaluate('window.__ef = 0'); await sleep(seconds * 1000); return (await page.evaluate('window.__ef')) / seconds; };
        await page.evaluate(`document.getElementById('cap').focus()`); await page.key('Home'); await sleep(300);
        const r15 = await rate(2);
        await page.key('ArrowRight'); await sleep(300);
        const r30 = await rate(2);
        run.numbers.effectFrameRates = { cap15: r15, cap30: r30 };
        await page.key('End'); await sleep(200);
        return { ok: Math.abs(r15 - 15) <= 4.5 && Math.abs(r30 - 30) <= 9, cap15: r15, cap30: r30 };
      });
      await run.step('interact', 'a trusted click on Send runs the disintegrate actions: the form turns to dust (frame differs 500 ms later), then re-forms with the page\'s answer', async () => {
        const before = await canvasImage(page, '#stage', 'gpu');
        const send = await centerOf(page, '#form button');
        await page.click(send.x, send.y);
        await sleep(500);
        const mid = H.compareImages(await canvasImage(page, '#stage', 'gpu'), before).countOver16;
        const answered = await H.until(() => page.evaluate(`/^Thanks, Adax\./.test(document.getElementById('result').textContent) || null`), 8000);
        await sleep(2000);   // the way back (1.2 s)
        const img = await canvasImage(page, '#stage', 'gpu'); run.shots.after = img;
        const back = H.compareImages(img, before).countOver16;
        return { ok: mid > 3000 && !!answered && H.pixelStats(img).nonBlank && back > 30 && back < 0.2 * img.width * img.height, midChangedPixels: mid, answered: !!answered, changedAfterPixels: back };
      });
    } else {
      await run.step('interact', 'the 2D path: Send writes the answer into the drawn form (no effect, no action)', async () => {
        const send = await centerOf(page, '#form button');
        await page.click(send.x, send.y);
        const answered = await H.until(() => page.evaluate(`/^Thanks, Adax\./.test(document.getElementById('result').textContent) || null`), 4000);
        const diff = await changedFrom(page, '#stage', '2d', first, 30);
        run.shots.after = diff.img ?? first;
        return { ok: !!answered && !diff.timedOut, answered: !!answered, changedPixels: diff.countOver16 };
      });
    }
  },

  async plugins(run, opts) {
    const { page } = run;
    const { plugins: manifest } = JSON.parse(readFileSync(resolve(ROOT, 'dist/plugins/manifest.json'), 'utf8'));
    const mode = await H.until(() => page.evaluate(`window.__gallery && window.__gallery.mode`), run.fast ? 2500 : 15000);
    run.numbers.path = mode === 'effect' ? 'webgpu-effect' : mode === '2d' ? '2d-fallback' : 'unknown';
    run.notes.push(`presentation path exercised: ${run.numbers.path}${mode === '2d' ? (opts.noGpu ? ' (navigator.gpu hidden on purpose)' : opts.noAdapter ? ' (requestAdapter() returns null on purpose)' : ' (no WebGPU adapter in this headless Chrome, so the effects were NOT exercised)') : ''}`);
    if (opts.noGpu) run.check('install', 'with navigator.gpu hidden the gallery takes the 2D fallback path', mode === '2d', { path: run.numbers.path });
    if (opts.noAdapter) run.check('install', 'with no WebGPU adapter the gallery takes the 2D fallback path', mode === '2d', { path: run.numbers.path });
    const kind = mode === 'effect' ? 'gpu' : '2d';
    const first = await genericChecks(run, { canvas: '#stage', kind, ready: `!!(window.__gallery && window.__gallery.ready)` });
    if (!first || opts.generic) return;
    const pick = async (name) => {
      await page.evaluate(`document.querySelector('#picker button[data-effect=${q(name)}]').scrollIntoView({ block: 'center' })`);
      const c = await centerOf(page, `#picker button[data-effect="${name}"]`);
      await page.click(c.x, c.y);
      return H.until(() => page.evaluate(`window.__gallery.active === ${q(name)} ? true : null`), 8000);
    };
    await run.step('install', 'the picker lists "Effect off" and every plugin of dist/plugins/manifest.json, with its title and description', async () => {
      const listed = await page.evaluate(`[...document.querySelectorAll('#picker button')].map((b) => ({ name: b.dataset.effect, text: b.textContent, disabled: b.disabled }))`);
      const ok = listed.length === manifest.length + 1 && listed[0].name === 'off' && manifest.every((p) => listed.some((l) => l.name === p.name && l.text.includes(p.title) && l.text.includes(p.description)));
      return { ok, listed: listed.map((l) => l.name), manifest: manifest.map((p) => p.name) };
    });
    if (mode === 'effect') {
      for (const p of manifest) {
        await run.step('interact', `selecting ${p.name} (trusted click) applies it: its controls mount in the form, the presented pixels change against "Effect off", and the panel shows its title, version and reduced-motion behaviour`, async () => {
          if (!(await pick('off'))) return { ok: false, reason: 'off not selected' };
          await sleep(600);
          const off = await canvasImage(page, '#stage', 'gpu');
          const selected = await pick(p.name);
          await sleep(900);
          const on = await canvasImage(page, '#stage', 'gpu');
          const controls = await page.evaluate(`document.getElementById('effect-controls').children.length`);
          const about = await page.evaluate(`document.getElementById('about').textContent`);
          const described = about.includes(p.title) && about.includes(`v${p.version}`) && (!p.reducedMotion || about.includes(p.reducedMotion));
          const cmp = H.compareImages(on, off);
          run.shots[`effect-${p.name}`] = on;
          return { ok: !!selected && controls > 0 && described && cmp.countOver16 > 300 && H.pixelStats(on).nonBlank, controls, described, changedPixels: cmp.countOver16 };
        });
      }
      await run.step('interact', '"Effect off" removes the plugin and its controls; the frame is still presented and not blank', async () => {
        const off = await pick('off');
        await sleep(600);
        const img = await canvasImage(page, '#stage', 'gpu');
        const st = await page.evaluate(`({ controls: document.getElementById('effect-controls').children.length, url: location.search })`);
        return { ok: !!off && st.controls === 0 && !st.url.includes('effect=') && H.pixelStats(img).nonBlank, ...st };
      });
    } else {
      await run.step('install', 'without WebGPU the page says so above the canvas and the effects are disabled ("Effect off" stays)', async () => {
        const st = await page.evaluate(`({ notice: document.getElementById('notice').textContent, shown: getComputedStyle(document.getElementById('notice')).display !== 'none', disabled: [...document.querySelectorAll('#picker button')].filter((b) => b.disabled).map((b) => b.dataset.effect), active: window.__gallery.active })`);
        return { ok: st.shown && /WebGPU|effects host/.test(st.notice) && st.disabled.length === manifest.length && st.active === 'off', ...st };
      });
    }
    // bug report: a double click on a word of the static text showed no selection on the canvas until the effect changed; nor did the deselection
    const selectionCases = mode === 'effect' ? [manifest.some((p) => p.name === 'glitch') ? 'glitch' : manifest[0].name, 'off'] : ['off'];
    for (const name of selectionCases) {
      await run.step('interact', `a trusted double click on a word of the static text shows the selection on the canvas, a click elsewhere removes it (${mode === 'effect' ? (name === 'off' ? 'effects host, "Effect off"' : `effect ${name}`) : '2D, no effect'})`, async () => {
        if (mode === 'effect' && !(await pick(name))) return { ok: false, reason: `${name} not selected` };
        await sleep(600);
        return staticSelectionShows(page, '#stage', kind, 'Touch', { effect: mode === 'effect' });
      });
    }
    await run.step('interact', 'click + type in the name field reaches the live input (effect off)', async () => {
      if (mode === 'effect' && !(await pick('off'))) return { ok: false, reason: 'off not selected' };
      await page.evaluate(`window.scrollTo(0, 0); document.getElementById('name').scrollIntoView({ block: 'nearest' })`);   // in the viewport whatever the notice above the canvas takes
      await sleep(150);
      const c = await centerOf(page, '#name');
      await page.click(c.x, c.y); await sleep(200);
      await typeText(page, 'x');
      const state = await page.evaluate(`({ value: document.getElementById('name').value, active: document.activeElement && document.activeElement.id })`);
      return { ok: state.value === 'Adax', ...state };
    });
    await run.step('interact', 'the frame cap slider changes canvas.frameCap (keyboard, trusted)', async () => {
      await page.evaluate(`document.getElementById('fps-cap').focus()`);
      await page.key('Home'); await sleep(150);
      const at15 = await page.evaluate(`({ prop: document.getElementById('stage').frameCap, attr: document.getElementById('stage').getAttribute('framecap') })`);
      for (let i = 0; i < 3; i++) await page.key('ArrowRight');
      await sleep(150);
      const at30 = await page.evaluate(`({ prop: document.getElementById('stage').frameCap, attr: document.getElementById('stage').getAttribute('framecap') })`);
      return { ok: at15.prop === 15 && at15.attr === '15' && at30.prop === 30 && at30.attr === '30', at15, at30 };
    });
  },

  async ['scroll-and-resize'](run, opts) {
    const { page } = run;
    const first = await genericChecks(run, { canvas: '#stage', kind: '2d', ready: `document.getElementById('stage').width > 0 && !!window.__HIC__ && /paints [1-9]/.test(document.getElementById('readout').textContent)` });
    if (!first || opts.generic) return;
    await run.step('interact', 'a trusted wheel gesture over the drawn list scrolls the live list and changes the canvas pixels', async () => {
      const c = await centerOf(page, '#inbox');
      for (let i = 0; i < 6; i++) { await page.wheel(c.x, c.y, 0, 100); await sleep(60); }
      await sleep(300);
      const top = await page.evaluate(`document.getElementById('inbox').scrollTop`);
      const diff = await changedFrom(page, '#stage', '2d', first, 500);
      run.shots.scrolled = diff.img ?? first;
      return { ok: top > 100 && !diff.timedOut, scrollTop: top, changedPixels: diff.countOver16 };
    });
    await run.step('interact', 'click + type in the note field reaches the live input', async () => {
      const c = await centerOf(page, '#note');
      await page.click(c.x, c.y); await sleep(150);
      await typeText(page, 'resize me');
      return { ok: (await page.evaluate(`document.getElementById('note').value`)) === 'resize me' };
    });
    const layoutName = () => page.evaluate(`getComputedStyle(document.querySelector('#panel .layout-name'), '::after').content`);
    await run.step('interact', 'after a viewport resize below 760 px the canvas follows, is not blank and shows the narrow layout (Emulation override)', async () => {
      const wide = await canvasImage(page, '#stage', '2d');
      await setViewport(page, 700, VIEW.height);
      const narrow = await H.until(async () => {
        const w = await page.evaluate(`document.getElementById('stage').width`);
        const name = await layoutName();
        return /narrow/.test(name) && w > 0 && w < wide.width ? { w, name } : null;
      }, 6000);
      await sleep(500);
      const img = await canvasImage(page, '#stage', '2d');
      run.shots.narrow = img;
      const cmp = img.width === wide.width ? H.compareImages(img, wide) : { countOver16: -1 };
      return { ok: !!narrow && H.pixelStats(img).nonBlank && img.width < wide.width, narrow, width: img.width, wideWidth: wide.width, differsFromWide: cmp.countOver16 };
    });
    await run.step('interact', 'back to the wide viewport: the wide layout and the typed note are drawn again', async () => {
      await setViewport(page, VIEW.width, VIEW.height);
      const back = await H.until(async () => /wide/.test(await layoutName()), 6000);
      await sleep(500);
      const img = await canvasImage(page, '#stage', '2d');
      return { ok: !!back && H.pixelStats(img).nonBlank, width: img.width };
    });
  },

  async ['webgl-texture'](run, opts) {
    const { page } = run;
    const uploads = () => page.evaluate(`Number((/uploads: (\\d+)/.exec(document.getElementById('status').textContent) || [])[1] || 0)`);
    const first = await genericChecks(run, { canvas: '#gl', kind: 'gpu', ready: `/uploads: [1-9]/.test(document.getElementById('status').textContent)` });
    if (!first || opts.generic) return;
    await run.step('surface', 'the cube spins (two frames 500 ms apart differ)', async () => {
      await sleep(500);
      const later = await canvasImage(page, '#gl', 'gpu');
      const cmp = H.compareImages(later, first);
      run.shots.later = later;
      return { ok: cmp.sizeMatch !== false && cmp.countOver16 > 500, changedPixels: cmp.countOver16 };
    });
    await run.step('interact', 'typing in the form (the flat copy is the live form) changes the texture: input, text node and uploads advance, HUD pixels change', async () => {
      const before = await uploads();
      const hud = await centerOf(page, '#card');
      const hudRect = { x: Math.round(hud.x - hud.w / 2), y: Math.round(hud.y - hud.h / 2), w: Math.round(hud.w), h: Math.round(hud.h) };
      const shotBefore = await canvasImage(page, '#gl', 'gpu');
      const nameBox = await centerOf(page, '#name');
      await page.click(nameBox.x, nameBox.y); await sleep(200);
      await typeText(page, 'zzz');
      const state = await page.evaluate(`({ value: document.getElementById('name').value, big: document.getElementById('big').textContent })`);
      await H.until(async () => (await uploads()) > before, 6000);
      await sleep(300);
      const shotAfter = await canvasImage(page, '#gl', 'gpu');
      // the HUD rectangle of the canvas (page CSS px relative to the canvas), cropped from both screenshots
      const origin = await page.evaluate(`(() => { const r = document.getElementById('gl').getBoundingClientRect(); return { x: r.x, y: r.y }; })()`);
      const crop = (img) => H.cropImage(img, Math.round(hudRect.x - origin.x), Math.round(hudRect.y - origin.y), hudRect.w, hudRect.h);
      const cmp = H.compareImages(crop(shotAfter), crop(shotBefore));
      run.shots.after = shotAfter;
      const after = await uploads();
      return { ok: state.value === 'cubezzz' && state.big === 'cubezzz' && after > before && cmp.countOver16 > 60, ...state, uploadsBefore: before, uploadsAfter: after, hudChangedPixels: cmp.countOver16 };
    });
  },

  /**
   * The playground: the code runs in a sandboxed preview frame with an opaque origin, so install and mode come from the page's status line (the reporter in the
   * frame posts them), the pixels from an element screenshot of the frame cropped to the canvas, and the frame's DOM through inPreview.
   */
  async playground(run, opts) {
    const { page } = run;
    run.expectedErrors = /playground check|pg-injected|endless loop check/;   // thrown on purpose by the user-code steps below (seen only when the frame shares the page's process)
    const status = () => page.evaluate(`({ state: document.getElementById('status').dataset.state, text: document.getElementById('status').textContent.trim(), run: window.__playground.run, mode: window.__playground.mode,
      messages: window.__playground.messages, console: document.getElementById('console').textContent })`);
    /** the status after run `minRun` finished installing (or failed to); null on timeout */
    const settled = (minRun) => H.until(async () => { const s = await status(); return s.run >= minRun && !['idle', 'running'].includes(s.state) ? s : null; }, run.fast ? 4000 : 15000, 100);
    /** the preview's canvas, cropped from an element screenshot of the frame (DPR 1: css px are device px) */
    const canvasShot = async () => {
      const box = await inPreview(page, `(() => { const c = document.querySelector('canvas'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
      if (!box) throw new Error('no canvas in the preview');
      const { img } = await H.screenshotElement(page, '#preview');
      const x = Math.max(0, Math.round(box.x)), y = Math.max(0, Math.round(box.y));
      return H.cropImage(img, x, y, Math.min(Math.round(box.w), img.width - x), Math.min(Math.round(box.h), img.height - y));
    };
    const untilChanged = async (before, minPixels) => {
      let last = 0;
      const img = await H.until(async () => { const now = await canvasShot(); last = H.compareImages(now, before).countOver16; return last >= minPixels ? now : null; }, 6000, 200);
      return { img, changedPixels: last };
    };
    const runs = () => page.evaluate('window.__playground.run');
    const setCode = (text) => page.evaluate(`document.getElementById('code').value = ${q(text)}`);
    const clickOn = async (selector) => { const c = await centerOf(page, selector); await page.click(c.x, c.y); };
    const reload = async () => { const loaded = page.conn.waitFor('Page.loadEventFired', { sessionId: page.sessionId, timeout: 20000 }); await page.send('Page.reload', {}); await loaded; };

    let st = null;
    await run.step('install', 'the status line reports the polyfill installed (mode polyfill), or the native API, in the preview', async () => {
      st = await settled(1);
      run.numbers.mode = st?.mode ?? null;
      return { ok: !!st && (NATIVE ? st.state === 'native' : st.state === 'polyfill' || st.state === 'native'), ...(st ?? {}), console: st?.console.slice(0, 300) };
    });
    let first = null;
    await run.step('surface', 'the preview canvas is not blank (element screenshot of the frame, cropped to the canvas)', async () => {
      first = await H.until(async () => { const img = await canvasShot(); return H.pixelStats(img).nonBlank ? img : null; }, run.fast ? 2500 : 12000, 250);
      if (!first) return { ok: false, ...H.pixelStats(await canvasShot()), dominantColor: undefined };
      return { ok: true, ...(({ distinctColors, nonDominantFraction }) => ({ distinctColors, nonDominantFraction }))(H.pixelStats(first)) };
    });
    await run.step('leak', 'the live layer in the preview is invisible (computed opacity 0, or absent in native mode)', async () => {
      const layers = await inPreview(page, `[...document.querySelectorAll('hic-layer')].map((l) => getComputedStyle(l).opacity)`);
      return { ok: layers.every((o) => o === '0'), layers };
    });
    if (first) run.shots.first = first;
    if (!first || !st || opts.generic) return;

    await run.step('load', 'the default code is the explainer example of examples/basic, character for character, and runs with no console message', async () => {
      const defaultCode = await page.evaluate(`document.getElementById('code').defaultValue`);
      const same = defaultCode === basicExplainerBlock();
      return { ok: same && st.messages === 0, same, messages: st.messages, console: st.console.slice(0, 300) };
    });
    await run.step('load', 'the preview is sandboxed with allow-scripts only, in an opaque origin, and cannot reach the page\'s document', async () => {
      const sandbox = await page.evaluate(`document.getElementById('preview').getAttribute('sandbox')`);
      const inside = await inPreview(page, `({ origin: location.origin, parentDocument: (() => { try { return typeof parent.document.body; } catch (e) { return e.name; } })() })`);
      return { ok: sandbox === 'allow-scripts' && inside.origin === 'null' && inside.parentDocument === 'SecurityError', sandbox, ...inside };
    });
    await run.step('interact', 'a trusted click on the drawn field focuses the live input in the preview; typing changes input.value and the preview pixels', async () => {
      const field = await inPreview(page, `(() => { const r = document.getElementById('name').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      const frame = await page.evaluate(`(() => { const e = document.getElementById('preview'); const r = e.getBoundingClientRect(); return { x: r.x + e.clientLeft, y: r.y + e.clientTop }; })()`);
      await page.click(frame.x + (opts.misclick ? 4 : field.x), frame.y + (opts.misclick ? 4 : field.y));
      await sleep(250);
      // Page.typeText's guard, across the frame: keys are sent only when the focus is on an editable element of the preview
      const focus = await page.evaluate(`({ page: document.activeElement && document.activeElement.id, preview: window.__playground.focus })`);
      if (focus.page !== 'preview' || focus.preview !== 'input#name') return { ok: false, reason: 'the live input has no focus: no key sent', ...focus };
      const before = await canvasShot();
      for (const ch of 'hello world') { await page.key(ch); await sleep(25); }
      const value = await inPreview(page, `document.getElementById('name').value`);
      const diff = await untilChanged(before, 100);
      if (diff.img) run.shots.typed = diff.img;
      return { ok: value === 'hello world' && !!diff.img, value, changedPixels: diff.changedPixels, ...focus };
    });
    await run.step('interact', 'a message from another window that carries the run\'s token is not shown (only the preview frame is heard)', async () => {
      const token = await page.evaluate(`(/\\)\\("([a-z0-9]+)", /.exec(document.getElementById('preview').srcdoc) || [])[1] || null`);
      await page.evaluate(`window.postMessage({ token: ${q(token)}, kind: 'error', text: 'forged message' }, '*')`);
      await sleep(400);
      const s = await status();
      return { ok: !!token && !s.console.includes('forged message'), token: !!token, console: s.console.slice(0, 200) };
    });
    await run.step('interact', 'an error in the user code, an unhandled rejection and console.error reach the console panel as text (Ctrl+Enter runs)', async () => {
      await setCode(`<p>error check</p>\n<script>\n  console.error('<img id="pg-injected" src="data:,">');\n  Promise.reject(new Error('rejected, playground check'));\n  throw new TypeError('playground check');\n</script>\n`);
      const n = await runs();
      await page.evaluate(`document.getElementById('code').focus()`);
      await page.key('Enter', { modifiers: 2 });                    // Ctrl
      const s = await settled(n + 1);
      const shown = await H.until(async () => { const c = (await status()).console; return /TypeError: playground check/.test(c) && /unhandled rejection: Error: rejected, playground check/.test(c) ? c : null; }, 5000);
      const injected = await page.evaluate(`!!document.getElementById('pg-injected')`);
      const asText = !!shown && shown.includes('<img id="pg-injected" src="data:,">');
      return { ok: !!s && s.state === st.state && !!shown && asText && !injected, state: s?.state, injected, asText, console: (shown ?? (await status()).console).slice(0, 400) };
    });
    await run.step('interact', 'Tab in the editor inserts two spaces; Esc then Tab moves the focus on', async () => {
      await setCode('x');
      await page.evaluate(`(() => { const c = document.getElementById('code'); c.focus(); c.setSelectionRange(0, 0); })()`);
      await page.key('Tab');
      const indented = await page.evaluate(`({ value: document.getElementById('code').value, active: document.activeElement.id })`);
      await page.key('Escape'); await page.key('Tab');
      const left = await page.evaluate('document.activeElement.id');
      return { ok: indented.value === '  x' && indented.active === 'code' && left !== 'code', ...indented, after: left };
    });
    await run.step('interact', 'a code too long for a link is refused with a message, and the link is not changed', async () => {
      await setCode('x'.repeat(13000));
      await clickOn('#share');
      const said = await H.until(() => page.evaluate(`/too long/.test(document.getElementById('share-status').textContent) ? document.getElementById('share-status').textContent : null`), 3000);
      const hash = await page.evaluate('location.hash');
      return { ok: !!said && hash === '', said, hash };
    });
    await run.step('interact', 'a damaged link (bad base64, too long) says so, keeps the original example, and the page has no error', async () => {
      const results = [];
      for (const hash of ['#code=@@@', '#code=' + 'A'.repeat(16004), '#code=_w']) {                       // not the alphabet, over the cap, not UTF-8
        await page.evaluate(`history.replaceState(null, '', ${q(hash)})`);
        await reload();
        const s = await settled(1);
        const st2 = await page.evaluate(`({ said: document.getElementById('share-status').textContent, isDefault: document.getElementById('code').value === document.getElementById('code').defaultValue })`);
        results.push({ hash: hash.slice(0, 12), state: s?.state, ...st2 });
      }
      await page.evaluate(`history.replaceState(null, '', location.pathname)`);
      return { ok: results.every((r) => r.isDefault && r.said.length > 0 && r.state === st.state), results };
    });
    await run.step('interact', 'Share puts the edited code (non-ASCII included) in the link; reloading that link restores it and runs it', async () => {
      await page.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: run.baseUrl }).catch(() => {});
      const edited = (await page.evaluate(`document.getElementById('code').defaultValue`)).replace('name:', 'name (имя, 名前, ✓):');
      await setCode(edited);
      await page.evaluate(`document.getElementById('share-status').textContent = ''`);
      await clickOn('#share');
      const said = await H.until(() => page.evaluate(`document.getElementById('share-status').textContent || null`), 3000);
      const hash = await page.evaluate('location.hash');
      const decoded = hash.startsWith('#code=') ? Buffer.from(hash.slice(6), 'base64url').toString('utf8') : null;
      await reload();
      const s = await settled(1);
      const restored = await page.evaluate(`document.getElementById('code').value`);
      const label = s ? await inPreview(page, `document.querySelector('label').textContent`) : null;
      return { ok: decoded === edited && restored === edited && label === 'name (имя, 名前, ✓):' && !!s && s.state === st.state && /Link copied|address bar/.test(said ?? ''), said, hashLength: hash.length, label, state: s?.state };
    });
    await run.step('interact', 'Reset restores the original example, clears the link and runs it', async () => {
      const n = await runs();
      await clickOn('#reset');
      const s = await settled(n + 1);
      const after = await page.evaluate(`({ isDefault: document.getElementById('code').value === document.getElementById('code').defaultValue, hash: location.hash })`);
      const img = s ? await H.until(async () => { const i = await canvasShot(); return H.pixelStats(i).nonBlank ? i : null; }, 8000, 250) : null;
      return { ok: after.isDefault && after.hash === '' && !!s && s.state === st.state && !!img, ...after, state: s?.state };
    });
    await run.step('interact', 'running again replaces the preview frame: after five runs there is one frame and one frame target, and it works', async () => {
      const n = await runs();
      for (let i = 0; i < 5; i++) { await clickOn('#run'); await sleep(150); }
      const s = await settled(n + 5);
      await sleep(500);
      const frames = await page.evaluate(`document.querySelectorAll('iframe').length`);
      const { targetInfos } = await page.conn.send('Target.getTargets');
      const targets = targetInfos.filter((t) => t.type === 'iframe' && t.parentFrameId === page.targetId).length;
      return { ok: frames === 1 && targets <= 1 && !!s && s.state === st.state && s.messages === 0, frames, frameTargets: targets, state: s?.state };
    });
    // a page variant may run the frame in the page's process (allow-same-origin), where an endless loop would freeze the page and the run
    if (opts.variant) return;
    await run.step('interact', 'an endless loop in the user code: the page stays responsive, the status says the preview is not responding, and Reset brings the example back', async () => {
      const n = await runs();
      await setCode('<p>endless loop check</p>\n<script>\n  setTimeout(() => { for (;;) {} }, 200);\n</script>\n');
      await clickOn('#run');
      await settled(n + 1);
      const t0 = Date.now();
      const stuck = await H.until(async () => (await status()).state === 'unresponsive' || null, 8000, 200);
      const pageAnswersMs = Date.now() - t0;                             // the page's own script answered every poll meanwhile
      await clickOn('#reset');
      const back = await H.until(async () => { const s = await status(); return s.state === st.state ? s : null; }, 20000, 250);
      const img = back ? await H.until(async () => { const i = await canvasShot(); return H.pixelStats(i).nonBlank ? i : null; }, 8000, 250) : null;
      const isDefault = await page.evaluate(`document.getElementById('code').value === document.getElementById('code').defaultValue`);
      return { ok: !!stuck && !!back && !!img && isDefault, stuck: !!stuck, notRespondingAfterMs: pageAnswersMs, recovered: !!back, notBlank: !!img, isDefault };
    });
  },
};



/** Shared by the two doc-snippet pages: loads, is not blank, and a trusted click + typing reaches the live input and the pixels. */
async function docTyping(run, canvasSelector, inputSelector) {
  const { page } = run;
  const first = await genericChecks(run, { canvas: canvasSelector, kind: '2d', ready: `document.querySelector(${q(canvasSelector)}).width > 0 && !!window.__HIC__` });
  if (!first) return;
  await run.step('interact', 'the snippet as printed: typing reaches the live input AND changes the canvas pixels', async () => {
    const c = await centerOf(page, inputSelector);
    await page.click(c.x, c.y); await sleep(150);
    await typeText(page, 'doc check');
    const value = await page.evaluate(`document.querySelector(${q(inputSelector)}).value`);
    const diff = await changedFrom(page, canvasSelector, '2d', first, 40);
    return { ok: value === 'doc check' && !diff.timedOut, value, changedPixels: diff.countOver16 };
  });
}

/** The first fenced block of `lang` after the heading line that starts with `heading` in a Markdown file. */
function codeBlockAfter(file, heading, lang) {
  const text = readFileSync(file, 'utf8');
  const at = text.indexOf(heading);
  if (at < 0) throw new Error(`heading not found in ${file}: ${heading}`);
  const open = text.indexOf('```' + lang + '\n', at);
  if (open < 0) throw new Error(`no ${lang} block after ${heading} in ${file}`);
  const start = open + 4 + lang.length;
  return text.slice(start, text.indexOf('\n```', start));
}

// ---- smoke pages for the documentation (test/examples-smoke/): the code the guides show must run -------------------------------------------
const SMOKE = {
  /** README "ESM path". */
  async ['esm-quickstart'](run) {
    const { page } = run;
    await run.step('install', 'install() from dist/esm/index.js ran and the page is ready', async () => {
      const st = await H.until(() => page.evaluate('window.__state && (window.__state.ready || window.__state.error) ? window.__state : null'), 8000);
      return { ok: !!st && st.ready === true && st.mode === 'polyfill', ...st };
    });
    await run.step('surface', 'the canvas drawn through the ESM-installed polyfill is not blank', async () => {
      const img = await H.until(async () => { const i = await canvasImage(page, '#c', '2d'); return H.pixelStats(i).nonBlank ? i : null; }, 8000, 250);
      return { ok: !!img };
    });
  },

  /** The snippets printed in README.md (the explainer example of "Quick start") and docs/guides/GETTING-STARTED.md (section 2), extracted from the Markdown and run as written. */
  async ['doc-readme-basic'](run) { await docTyping(run, 'canvas', '#name'); },
  async ['doc-getting-started'](run) { await docTyping(run, '#c', '#name'); },

  /** docs/guides/EFFECTS-PLUGINS.md: the complete example plugin, and its input mapper against the pixels the GPU produced. */
  async ['wobble-plugin'](run) {
    const { page } = run;
    if (!(await page.evaluate('(async () => !!navigator.gpu && !!(await navigator.gpu.requestAdapter()))()'))) { run.notes.push('SKIPPED: no WebGPU adapter in this Chrome; the guide plugin was NOT exercised'); run.numbers.skipped = true; return; }
    await run.step('install', 'createHost + addPlugin(WobblePlugin) succeeded', async () => {
      const st = await H.until(() => page.evaluate('window.__state && (window.__state.ready || window.__state.error) ? window.__state : null'), 10000);
      return { ok: !!st && st.ready === true, ...st };
    });
    await run.step('surface', 'the presented frame is not blank and the live layer is invisible', async () => {
      await sleep(600);
      const img = await canvasImage(page, '#stage', 'gpu'); run.shots.first = img;
      const layers = await page.evaluate(`[...document.querySelectorAll('hic-layer')].map((l) => getComputedStyle(l).opacity)`);
      return { ok: H.pixelStats(img).nonBlank && layers.length > 0 && layers.every((o) => o === '0'), layers };
    });
    await run.step('surface', 'the plugin displaces the pixels (amplitude 24 differs from amplitude 0)', async () => {
      await page.evaluate('window.__handle.setOptions({ amplitude: 0 })'); await sleep(500);
      const flat = await canvasImage(page, '#stage', 'gpu');
      await page.evaluate('window.__handle.setOptions({ amplitude: 24 })'); await sleep(500);
      const bent = await canvasImage(page, '#stage', 'gpu');
      const cmp = H.compareImages(bent, flat);
      return { ok: cmp.countOver16 > 400, changedPixels: cmp.countOver16 };
    });
    // The mapper contract, judged from GPU pixels: the red bar is a vertical stripe at x = 300 css px in the SOURCE. In the presented frame its left edge is
    // at x_out(y). A correct mapper turns (x_out(y), y) back into x = 300. The frame is frozen (framecap 1) so the screenshot and the mapper describe the same frame.
    const edges = (img) => { const rows = []; for (let y = 8; y < img.height - 8; y += 8) { let x = -1; for (let i = 0; i < img.width; i++) { const o = (y * img.width + i) * 4; if (img.data[o] > 150 && img.data[o + 1] < 70 && img.data[o + 2] < 70) { x = i; break; } } if (x >= 0) rows.push({ y, x }); } return rows; };
    await run.step('interact', 'captureInputMapper agrees with the GPU pixels: mapper(visible bar edge) = the bar x in the source (+-2 px)', async () => {
      let result = null;
      for (let attempt = 0; attempt < 4 && !result; attempt++) {
        await page.evaluate(`window.__ef = 0; (() => { const c = document.getElementById('stage'); c.addEventListener('effectframe', () => { window.__ef += 1; }); c.setAttribute('framecap', '1'); })()`);
        await H.until(() => page.evaluate('window.__ef >= 1'), 4000, 50);
        const efBefore = await page.evaluate('window.__ef');
        const img = (await H.screenshotElement(page, '#stage')).img;
        const rows = edges(img);
        const errors = await page.evaluate(`(() => { const m = window.__instance.captureInputMapper({}); return ${JSON.stringify(rows)}.map((r) => { const s = m({ x: r.x + 0.5, y: r.y + 0.5, width: 600, height: 320 }); return s.x - 300; }); })()`);
        const identityErrors = rows.map((r) => r.x + 0.5 - 300);
        const efAfter = await page.evaluate('window.__ef');
        await page.evaluate(`document.getElementById('stage').removeAttribute('framecap')`);
        if (efAfter !== efBefore) continue; // a new frame was presented in between: retry
        const maxErr = Math.max(...errors.map(Math.abs)), maxIdentityErr = Math.max(...identityErrors.map(Math.abs));
        const xs = rows.map((r) => r.x);
        result = { rows: rows.length, maxErrorPx: +maxErr.toFixed(2), identityMapperMaxErrorPx: +maxIdentityErr.toFixed(2), edgeRangePx: Math.max(...xs) - Math.min(...xs) };
      }
      if (!result) return { ok: false, reason: 'no stable frame in 4 attempts' };
      run.numbers.mapper = result;
      // the control: the identity mapper (what a plugin without captureInputMapper would give) must be visibly wrong on the same pixels
      return { ok: result.rows >= 20 && result.edgeRangePx >= 20 && result.maxErrorPx <= 2 && result.identityMapperMaxErrorPx >= 8, ...result };
    });
    await run.step('interact', 'the action of the guide\'s plugin: handle.trigger(\'pulse\') resolves \'calm\' after the pulse, settled() then \'calm\'; an unknown action rejects listing \'pulse\'', async () => {
      const t0 = Date.now();
      const state = await page.evaluate(`window.__handle.trigger('pulse', { amplitude: 40, ms: 400 })`);
      const ms = Date.now() - t0;
      const rest = await page.evaluate('window.__handle.settled()');
      const unknown = await page.evaluate(`window.__handle.trigger('shake').then(() => 'resolved', (e) => e.name + ': ' + e.message)`);
      return { ok: state === 'calm' && ms >= 350 && rest === 'calm' && /^TypeError: .*its actions are 'pulse'$/.test(unknown), state, ms, rest, unknown };
    });
  },
};

/** The plugin printed in docs/guides/EFFECTS-PLUGINS.md is the file the wobble smoke page runs: a difference means the guide shows untested code. */
function guidePluginProblem() {
  const guide = codeBlockAfter(resolve(ROOT, 'docs/guides/EFFECTS-PLUGINS.md'), '### 16. A complete plugin: horizontal wobble', 'js');
  const file = readFileSync(resolve(ROOT, 'test/examples-smoke/wobble-plugin/wobble-plugin.js'), 'utf8');
  return guide.trim() === file.trim() ? null : 'the plugin in docs/guides/EFFECTS-PLUGINS.md section 16 differs from test/examples-smoke/wobble-plugin/wobble-plugin.js';
}

// ------------------------------------------------------------------------------------------------------------------------------------
async function runExample(browser, server, name, opts = {}) {
  const scenarios = opts.smoke ? SMOKE : SCENARIOS;
  const path = opts.url ?? (opts.smoke ? `test/examples-smoke/${name}/` : `examples/${name}/`);
  const page = await browser.newPage({ reuseFirst: false });
  const run = new Run(page, name, server.url); run.fast = !!opts.generic; // a control only needs to see red: short waits
  try {
    await setViewport(page, VIEW.width, VIEW.height);
    if (opts.noGpu) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true })" });
    if (opts.noAdapter) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: "if (navigator.gpu) Object.defineProperty(navigator.gpu, 'requestAdapter', { value: async () => null, configurable: true })" });
    page.clearLogs();
    await page.navigate(`${server.url}/${path}`);
    await sleep(opts.generic ? 800 : 300);
    await scenarios[name](run, opts);
    await sleep(200);
    const all = page.errors({ includeWarnings: false }).filter((e) => !/favicon/.test(e.text ?? ''));
    // KNOWN RED, named and narrow: see KNOWN_RED above. Anything else is a failure.
    // without an adapter the polyfill's loud report of the refused effect host is the documented behaviour (one console.error), not a defect
    const expected = opts.noAdapter ? all.filter((e) => /unsupported effect-plugins: .*no adapter was returned/.test(e.text ?? '')) : [];
    if (opts.noAdapter) run.check('load', 'the refused effect host is reported once (unsupported effect-plugins, no adapter)', expected.length === 1, expected.length);
    if (run.expectedErrors) expected.push(...all.filter((e) => run.expectedErrors.test(e.text ?? '')));
    const errors = all.filter((e) => !expected.includes(e) && !KNOWN_RED.some((k) => k.examples.includes(name) && k.pattern.test(e.text ?? '')));
    for (const e of all.filter((x) => !errors.includes(x) && !expected.includes(x))) run.known.push(KNOWN_RED.find((k) => k.examples.includes(name) && k.pattern.test(e.text ?? '')).id);
    run.check('load', 'no console error, page exception or failed request', errors.length === 0, errors.slice(0, 5));
  } catch (error) {
    if (error instanceof H.CdpTimeoutError) throw error;
    run.check('load', 'the scenario ran to the end', false, { error: String(error?.message ?? error).slice(0, 300) });
  } finally {
    if (!opts.noShots) for (const [key, img] of Object.entries(run.shots)) {
      try { writeFileSync(resolve(outDir, `${opts.smoke ? 'smoke-' : ''}${name}${opts.tag ? '-' + opts.tag : ''}-${key}.png`), H.encodePng(img)); } catch { /* best effort */ }
    }
    await page.close().catch(() => {});
  }
  return run;
}

function summarize(run) {
  return { example: run.name, ok: run.failed().length === 0, numbers: run.numbers, notes: run.notes, knownRed: [...new Set(run.known)], checks: run.checks };
}

async function main() {
  const missing = DIST_FILES.filter((f) => !existsSync(resolve(ROOT, f)));
  if (missing.length) { console.error(`dist/ is missing ${missing.join(', ')}. Run \`npm run build\` first.`); process.exit(2); }
  mkdirSync(outDir, { recursive: true });
  const names = NAMES.filter((n) => !only || only.includes(n));
  if (!names.length && !anySmoke) { console.error('no example selected'); process.exit(2); }

  const browser = await H.launchChrome({ name: 'examples', chrome: H.arg('chrome') ?? (NATIVE ? 'canary' : 'stable'), nativeDrawElement: NATIVE, windowSize: [VIEW.width, VIEW.height + 100], dpr: 1,
    extraArgs: ['--headless=new', '--hide-scrollbars'] });
  const result = { script: 'scripts/check-examples.mjs', startedAt: new Date().toISOString(), headless: true, dpr: 1, viewport: VIEW, viewportKind: 'Emulation.setDeviceMetricsOverride',
    chrome: browser.version?.Browser, examples: [], controls: [], pass: false };
  browser.conn.sendTimeoutMs = 30000; // a stuck renderer must fail the run in 30 s, never hang it
  let server, brokenServer;
  const problems = [];
  try {
    server = await startServer();
    console.log(`Chrome ${browser.version?.Browser} (headless), examples server ${server.url}`);
    // ---- real runs
    for (const name of names) {
      const run = await runExample(browser, server, name);
      const s = summarize(run); result.examples.push(s);
      console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${name}  (${run.checks.filter((c) => c.ok).length}/${run.checks.length} checks)${run.notes.length ? '  note: ' + run.notes.join('; ') : ''}`);
      for (const id of s.knownRed) console.log(`       KNOWN RED ${id}: ${KNOWN_RED.find((k) => k.id === id).where}`);
      for (const c of run.failed()) { console.log(`       x [${c.cls}] ${c.name}  ${JSON.stringify(c.detail)}`); problems.push(`${name}: ${c.name}`); }
    }
    // ---- the 2D fallback of the effect pages (a browser without WebGPU), same checks except the GPU-only ones
    for (const name of ['plugins', 'effect-plugin'].filter((n) => names.includes(n))) {
      const run = await runExample(browser, server, name, { noGpu: true, tag: 'no-gpu' });
      const s = summarize(run); s.example = `${name} (navigator.gpu hidden)`; result.examples.push(s);
      console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${name}, no WebGPU  (${run.checks.filter((c) => c.ok).length}/${run.checks.length} checks)  note: ${run.notes.join('; ')}`);
      for (const c of run.failed()) { console.log(`       x [${c.cls}] ${c.name}  ${JSON.stringify(c.detail)}`); problems.push(`${name} no-gpu: ${c.name}`); }
    }
    // ---- the same fallback when navigator.gpu exists but returns no adapter (iOS / Android simulators, blocklisted GPUs)
    for (const name of ['plugins', 'effect-plugin'].filter((n) => names.includes(n))) {
      const run = await runExample(browser, server, name, { noAdapter: true, tag: 'no-adapter' });
      const s = summarize(run); s.example = `${name} (no WebGPU adapter)`; result.examples.push(s);
      console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${name}, no WebGPU adapter  (${run.checks.filter((c) => c.ok).length}/${run.checks.length} checks)  note: ${run.notes.join('; ')}`);
      for (const c of run.failed()) { console.log(`       x [${c.cls}] ${c.name}  ${JSON.stringify(c.detail)}`); problems.push(`${name} no-adapter: ${c.name}`); }
    }
    // ---- smoke pages of the documentation (served by the harness server, repository root)
    if (anySmoke) {
      const drift = guidePluginProblem();
      result.examples.push({ example: 'smoke:guide-plugin-is-the-tested-file', ok: !drift, checks: [{ cls: 'load', name: 'the plugin printed in the guide is the file the smoke page runs', ok: !drift, detail: drift }] });
      console.log(`${drift ? 'FAIL' : 'ok  '} smoke: the plugin printed in docs/guides/EFFECTS-PLUGINS.md is test/examples-smoke/wobble-plugin/wobble-plugin.js${drift ? '  ' + drift : ''}`);
      if (drift) problems.push(drift);
      // Doc snippets, extracted from the Markdown and served under /__docs/ (the harness server refuses dot directories, so a files map is used)
      const docDir = resolve(outDir, 'docs'); mkdirSync(docDir, { recursive: true });
      const polyfillTag = '<script src="/dist/hic-live-polyfill.iife.min.js"></script>\n';
      const readmeBlock = codeBlockAfter(resolve(ROOT, 'README.md'), "This is the explainer's own example, unchanged:", 'html');
      const guideBlock = codeBlockAfter(resolve(ROOT, 'docs/guides/GETTING-STARTED.md'), '## 2. Your first canvas with a script tag', 'html').replaceAll('src="dist/', 'src="/dist/');
      writeFileSync(resolve(docDir, 'readme-basic.html'), `<!doctype html><meta charset="utf-8"><title>README basic</title>\n${polyfillTag}<body>\n${readmeBlock}\n`);
      writeFileSync(resolve(docDir, 'getting-started.html'), `<!doctype html><meta charset="utf-8"><title>GETTING-STARTED</title>\n${guideBlock}\n`);
      const smokeServer = await H.startServer({ files: { '/__docs/readme-basic.html': resolve(docDir, 'readme-basic.html'), '/__docs/getting-started.html': resolve(docDir, 'getting-started.html') } });
      try {
        for (const name of Object.keys(SMOKE).filter(smokeWanted)) {
          const url = name === 'doc-readme-basic' ? '__docs/readme-basic.html' : name === 'doc-getting-started' ? '__docs/getting-started.html' : undefined;
          const run = await runExample(browser, smokeServer, name, { smoke: true, url });
          const s = summarize(run); s.example = `smoke:${name}`; result.examples.push(s);
          console.log(`${s.ok ? 'ok  ' : 'FAIL'} smoke:${name}  (${run.checks.filter((c) => c.ok).length}/${run.checks.length} checks)${run.notes.length ? '  note: ' + run.notes.join('; ') : ''}`);
          for (const c of run.failed()) { console.log(`       x [${c.cls}] ${c.name}  ${JSON.stringify(c.detail)}`); problems.push(`smoke:${name}: ${c.name}`); }
        }
      } finally { await smokeServer.close().catch(() => {}); }
    }
    // ---- positive controls
    if (withControl) {
      // C1: the polyfill script answers 404 (a broken dist path). Every example must fail: generic checks only, so it is quick.
      brokenServer = await startServer({ files: { '/dist/hic-live-polyfill.iife.min.js': resolve(ROOT, '.scratch/does-not-exist/hic-live-polyfill.iife.min.js') } });
      for (const name of names) {
        const run = await runExample(browser, brokenServer, name, { generic: true, tag: 'control-broken-dist', noShots: true });
        const red = run.failed();
        const control = { control: 'C1 broken dist path', example: name, turnedRed: red.length > 0, failedChecks: red.map((c) => c.name) };
        result.controls.push(control);
        console.log(`${control.turnedRed ? 'ok  ' : 'FAIL'} control C1 (broken dist path) -> ${name}: ${red.length} check(s) red`);
        if (!control.turnedRed) problems.push(`control C1 did not fail for ${name}`);
      }
      // C2: the click misses the field: the interaction checks of `basic` must turn red
      if (names.includes('basic')) {
        const run = await runExample(browser, server, 'basic', { misclick: true, tag: 'control-misclick', noShots: true });
        const red = run.failed().filter((c) => c.cls === 'interact');
        const control = { control: 'C2 click misses the field', example: 'basic', turnedRed: red.length > 0, failedChecks: red.map((c) => c.name) };
        result.controls.push(control);
        console.log(`${control.turnedRed ? 'ok  ' : 'FAIL'} control C2 (click misses the field) -> basic: ${red.length} interaction check(s) red`);
        if (!control.turnedRed) problems.push('control C2 did not fail');
      }
      // C5: page variants of the playground (a sandbox with allow-same-origin, console text parsed as HTML, messages heard from any window, the old frame kept):
      // the playground scenario must turn the named check red on each
      if (names.includes('playground')) {
        for (const variant of PLAYGROUND_VARIANTS) {
          const text = playgroundVariant(variant);
          let red = [];
          if (text instanceof Error) red = null;
          else {
            const file = resolve(outDir, `playground-${variant.name}.html`); writeFileSync(file, text);
            const variantServer = await startServer({ files: { '/examples/playground/': file } });
            try { red = (await runExample(browser, variantServer, 'playground', { tag: `control-${variant.name}`, noShots: true, variant: true })).failed().map((c) => c.name); }
            finally { await variantServer.close().catch(() => {}); }
          }
          const turnedRed = !!red && red.some((n) => n.startsWith(variant.check));
          result.controls.push({ control: `C5 playground variant ${variant.name}`, example: 'playground', turnedRed, failedChecks: red ?? [String(text.message)] });
          console.log(`${turnedRed ? 'ok  ' : 'FAIL'} control C5 (playground: ${variant.name}) -> "${variant.check}..." ${turnedRed ? 'red' : red ? 'stayed green' : text.message}`);
          if (!turnedRed) problems.push(`control C5 ${variant.name} did not fail`);
        }
      }
      // C4: the ESM entry is missing: the ESM smoke page must fail
      if (smokeWanted('esm-quickstart')) {
        const brokenEsm = await H.startServer({ files: { '/dist/esm/index.js': resolve(ROOT, '.scratch/does-not-exist/index.js') } });
        try {
          const run = await runExample(browser, brokenEsm, 'esm-quickstart', { smoke: true, generic: true, tag: 'control-broken-esm', noShots: true });
          const control = { control: 'C4 broken ESM path', example: 'smoke:esm-quickstart', turnedRed: run.failed().length > 0, failedChecks: run.failed().map((c) => c.name) };
          result.controls.push(control);
          console.log(`${control.turnedRed ? 'ok  ' : 'FAIL'} control C4 (broken ESM path) -> smoke:esm-quickstart: ${run.failed().length} check(s) red`);
          if (!control.turnedRed) problems.push('control C4 did not fail');
        } finally { await brokenEsm.close().catch(() => {}); }
      }
      // C3: a blank canvas is classified blank
      const blank = { width: 64, height: 64, data: new Uint8Array(64 * 64 * 4).fill(255) };
      const classified = H.pixelStats(blank).nonBlank === false;
      result.controls.push({ control: 'C3 blank canvas is blank', turnedRed: classified });
      console.log(`${classified ? 'ok  ' : 'FAIL'} control C3 (a flat white canvas is classified blank)`);
      if (!classified) problems.push('control C3: the blank detector accepted a blank image');
    }
  } catch (error) {
    if (!(error instanceof H.CdpTimeoutError)) throw error;
    browser.kill(); // the renderer spins at 100 %: SIGKILL our own browser tree now instead of waiting for a graceful close
    problems.push(`renderer stuck: ${error.message}`);
    console.log(`FAIL renderer stuck: ${error.message}`);
  } finally {
    await server?.close().catch(() => {});
    await brokenServer?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  result.pass = problems.length === 0 && result.examples.every((e) => e.ok);
  result.problems = problems;
  const file = resolve(ROOT, '.scratch/results', `examples-${stamp}.json`);
  writeFileSync(file, JSON.stringify(result, null, 1));
  console.log(`${result.pass ? 'G-examples: OK' : 'G-examples: FAILED'}  results: ${file}`);
  process.exit(result.pass ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
