#!/usr/bin/env node
// G-field-test: the field test page (examples/field-test/) runs end to end in HEADLESS Chrome and produces a valid report.
//
//   npm run build && npm run test:field
//   node scripts/check-field-test.mjs [--only=clean,dpr125,broken,denied,refused,missing] [--headed]
//
// Runs (each in a fresh page of one headless Chrome, trusted input through CDP):
//   clean    every step with an accepted tab capture (--auto-select-tab-capture-source-by-title picks this tab): the capture calibrates,
//            the picture comparisons of box A (canvas) and box B (plain page) PASS, typing and scrolling are measured on screen, the
//            effect step runs, the zoom step sees an emulated 125 % zoom, the report downloads through the page's own button and validates
//            (page validator + the independent assertions below), the in-page self-check passes.
//   dpr125   the same at a device pixel ratio of 1.25 (--force-device-scale-factor, the common Windows setting), without the zoom step.
//   broken   POSITIVE CONTROL: drawElementImage is wrapped to draw 8 grid px lower (a deliberately broken polyfill canvas); the pixel
//            oracle must FAIL the picture comparisons.
//   denied   getDisplayMedia rejects with NotAllowedError: the report records 'denied', the canvas-only checks still run.
//   refused  the user agent says Chrome 120: the polyfill refuses, the page still runs and records the refusal.
//   missing  the core bundle answers 404: the page still runs and records that the script did not load.
// Results: .scratch/results/field-test-<timestamp>/ (the downloaded report of each run, a screenshot of the finished page, a summary JSON).
// Headless by default; --headed runs the same steps in a visible window (it takes the screen focus).
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as H from '../test/harness/index.mjs';
import { startServer } from '../examples/serve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TITLE = 'HTML-in-Canvas field test';
const only = H.arg('only')?.split(',');
const headed = process.argv.includes('--headed');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(ROOT, '.scratch/results', `field-test-${stamp}`);
const q = JSON.stringify;
if (!existsSync(join(ROOT, 'dist/hic-live-polyfill.iife.min.js'))) { console.error('dist/ is missing: run `npm run build` first.'); process.exit(2); }
mkdirSync(outDir, { recursive: true });

// ------------------------------------------------------------------------------------------------------------------------------------
// Differences of src/ that this script found and does not hide. Each entry is printed on every run as KNOWN RED and recorded in the summary;
// it matches ONE check of ONE run (by its exact name), so any other failure still fails the script. Remove the entry when src/ is fixed.
/** @type {Array<{run: string, check: string, where: string}>} */
const KNOWN_RED = [
  // empty: the scroll box at a device pixel ratio of 1.25 (3.6-8 % of its pixels) was a canvas grid rounded from a content box that is not a whole number of device
  // pixels (210.5 device px high, a grid of 211), and the default-size draw stretched the snapshot to that grid by a hair; fixed in src/api/draw-math.js snapDefaultSize.
];

/** @typedef {{name: string, ok: boolean, known?: string, detail?: unknown}} Check */
class Run {
  constructor(name) { this.name = name; /** @type {Check[]} */ this.checks = []; this.report = null; }
  check(name, ok, detail) {
    const known = !ok ? KNOWN_RED.find((k) => k.run === this.name && k.check === name) : null;
    this.checks.push({ name, ok: !!ok || !!known, ...(known ? { known: known.where } : {}), ...(detail === undefined ? {} : { detail }) });
    console.log(`  ${ok ? 'ok  ' : known ? 'KNOWN RED' : 'FAIL'} ${name}${!ok && detail !== undefined ? '  ' + q(detail).slice(0, 400) : ''}${known ? `  (${known.where})` : ''}`);
    return !!ok;
  }
}

const centerOf = (page, selector) => page.evaluate(`(() => { const e = document.querySelector(${q(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()`);
const current = (page) => page.evaluate('window.__fieldTest ? window.__fieldTest.state.current : null');
/** poll until fn() is truthy; throws after the timeout (H.until returns null) */
async function need(fn, timeout, what) {
  const v = await H.until(async () => fn(), timeout, 100);
  if (!v) throw new Error(`timed out after ${timeout} ms: ${what}`);
  return v;
}
async function waitStep(page, id, timeout = 60000) {
  const ok = await H.until(async () => (await current(page)) === id, timeout, 100);
  if (!ok) throw new Error(`timed out after ${timeout} ms waiting for step ${id}; now ${await current(page).catch(() => '?')}: ${await page.evaluate("document.getElementById('ft-step-title').textContent + ' / ' + document.getElementById('ft-status').textContent").catch(() => '?')}`);
}
/** click a step button by its data-action (trusted click, it gives the user activation getDisplayMedia needs) */
async function press(page, action, timeout = 20000) {
  const sel = `#ft-step-buttons [data-action="${action}"]`;
  await need(() => page.evaluate(`!!document.querySelector(${q(sel)}) && !document.querySelector(${q(sel)}).disabled`), timeout, `button ${action}`);
  await page.evaluate(`document.querySelector(${q(sel)}).scrollIntoView({ block: 'center' })`);
  await H.sleep(100);
  const c = await centerOf(page, sel);
  await page.click(c.x, c.y);
}
async function skipUntil(page, last) {
  for (let i = 0; i < 12; i++) {
    const id = await current(page);
    if (id === last || id === 'finish') return;
    await press(page, 'skip');
    await need(async () => (await current(page)) !== id, 20000, `leaving step ${id}`);
  }
}
async function finishAndDownload(page, run, downloadDir) {
  await waitStep(page, 'finish', 120000);
  mkdirSync(downloadDir, { recursive: true });
  await page.browser.conn.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
  const before = new Set(readdirSync(downloadDir));
  await press(page, 'download');
  const file = await H.until(async () => readdirSync(downloadDir).find((f) => !before.has(f) && f.endsWith('.json')), 15000, 200);
  run.check('the Download button saves a JSON file named hic-field-test-<date>-<platform>-<browser>.json', !!file && /^hic-field-test-\d{4}-\d{2}-\d{2}-[a-z0-9-]+-[a-z0-9-]+\.json$/.test(file), file);
  if (!file) return null;
  const text = readFileSync(join(downloadDir, file), 'utf8');
  const report = JSON.parse(text);
  run.report = report;
  const problems = await page.evaluate(`window.__fieldTest.validate(${text})`);
  run.check('the report validates against the page schema', problems.length === 0, problems);
  run.check('the report is below 3 MB', text.length < 3e6, text.length);
  run.check('the page never went blank (the finish step is shown)', (await page.evaluate("document.getElementById('ft-step-title').textContent")).length > 0);
  await page.evaluate('window.scrollTo(0, 0)');
  await page.screenshot({ file: join(downloadDir, 'finished-page.png') }).catch(() => {});
  return report;
}
const checkById = (report, id) => report?.checks.find((c) => c.id === id);

/** the fields this script relies on, checked independently of the page's own validator */
function assertShape(run, r) {
  run.check('environment: user agent, DPR, refresh rate, media, system colours, scrollbars, fonts, WebGPU, WebGL', !!(r.environment.browser.userAgent && r.environment.display.devicePixelRatio > 0 && r.environment.display.refresh.hz > 0
    && r.environment.media.colorGamut && r.environment.systemColors.Highlight && r.environment.scrollbars.type && Array.isArray(r.environment.fonts.available) && 'available' in r.environment.webgpu && 'available' in r.environment.webgl),
  { dpr: r.environment.display.devicePixelRatio, hz: r.environment.display.refresh.hz, highlight: r.environment.systemColors.Highlight, scrollbars: r.environment.scrollbars });
  run.check('every step has a status', ['welcome', 'capture', 'picture', 'typing', 'scrolling', 'effect', 'zoom', 'finish'].every((id) => r.steps[id] && r.steps[id].status), Object.fromEntries(Object.entries(r.steps).map(([k, v]) => [k, v.status])));
  run.check('the summary counts the verdicts', r.summary && Object.values(r.summary.verdicts).reduce((a, b) => a + b, 0) === r.checks.length, r.summary);
}

async function runClean(browser, site, { name = 'clean', zoom = true } = {}) {
  const run = new Run(name);
  const page = await browser.newPage({ reuseFirst: false });
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.navigate(site.url + '/examples/field-test/');
  await need(() => page.evaluate('!!window.__fieldTest'), 15000, 'the page script');
  await press(page, 'start');
  await waitStep(page, 'capture', 30000);
  await press(page, 'allow');
  await waitStep(page, 'picture', 30000);
  run.check('the tab capture is active and calibrated', (await page.evaluate('window.__fieldTest.captureState()')) === 'active', await page.evaluate('window.__fieldTest.report.capture'));
  await waitStep(page, 'typing', 120000);
  // typing: click the field inside the canvas (the live element sits under the drawn one) and type
  const field = await centerOf(page, '#ft-canvas-sample .ft-type');
  await page.click(field.x, field.y);
  await H.sleep(200);
  await page.typeText('hello field test', { intervalMs: 140 });
  if (!(await H.until(async () => (await current(page)) !== 'typing', 30000, 100))) await press(page, 'done');
  // scrolling: wheel over the grey box of box A until the step completes
  await waitStep(page, 'scrolling', 30000);
  const box = await centerOf(page, '#ft-canvas-scroll .ft-scroller');
  const t0 = Date.now();
  for (let i = 0; Date.now() - t0 < 20000 && (await current(page)) === 'scrolling' && !(await page.evaluate("document.getElementById('ft-status').textContent.startsWith('Thank you')")); i++) {
    await page.wheel(box.x, box.y, 0, Math.floor(i / 10) % 2 ? -40 : 40);
    await H.sleep(16);
  }
  // effect: move the pointer over the effect canvas
  await waitStep(page, 'effect', 30000);
  const fx = await need(() => page.evaluate(`(() => { const e = document.querySelector('#ft-canvas-effect'); if (!e || e.closest('[hidden]')) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`), 15000, 'the effect canvas');
  for (let i = 0; (await current(page)) === 'effect' && i < 600; i++) { await page.mouseMove(fx.x + 20 + (i * 7) % (fx.w - 40), fx.y + 20 + (i * 3) % (fx.h - 40)); await H.sleep(16); }
  // zoom: an emulated device scale factor change (the page sees devicePixelRatio change as with Ctrl/Cmd +), then back
  await waitStep(page, 'zoom', 30000);
  if (!zoom) await press(page, 'skip');
  else {
    const vp = await page.evaluate('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })');
    await page.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: vp.dpr * 1.25, mobile: false });
    await need(() => page.evaluate("!!document.querySelector('#ft-step-buttons [data-action=\"continue\"]')"), 90000, 'the zoom measurement');
    await page.send('Emulation.clearDeviceMetricsOverride');
    if (!(await H.until(async () => (await current(page)) !== 'zoom', 20000, 100))) await press(page, 'continue');
  }
  const r = await finishAndDownload(page, run, join(outDir, name));
  if (!r) return run;
  assertShape(run, r);
  run.check('no page error in the report', r.errors.length === 0, r.errors);
  run.check(`the page ran at the browser's device pixel ratio (${browser.options.dpr ?? 'display'})`, !browser.options.dpr || r.environment.display.devicePixelRatio === browser.options.dpr, r.environment.display.devicePixelRatio);
  run.check('the capture did not change the device pixel ratio', r.capture.devicePixelRatioDuringCapture === r.environment.display.devicePixelRatio, { before: r.environment.display.devicePixelRatio, during: r.capture.devicePixelRatioDuringCapture });
  run.check('the capture was calibrated with a residual below 1.5 frame px', r.capture.calibrations?.some((c) => c.ok && c.residualFramePx < 1.5), r.capture.calibrations);
  for (const id of ['rest', 'focus', 'select-input', 'select-text', 'scroller']) {
    const c = checkById(r, 'picture.' + id);
    run.check(`picture.${id}: box A equals box B on screen (verdict pass)`, c?.verdict === 'pass', c);
  }
  const sel = r.steps.picture.results.scenarios['select-input'];
  run.check('select-input: the selection colours of the canvas are measured', !!sel?.canvas?.selectionColours?.background, sel?.canvas?.selectionColours);
  const typing = r.steps.typing.results;
  run.check('typing: at least 10 keys measured in the canvas and on screen', typing.keyToCanvasMs?.n >= 10 && typing.onScreen?.keyToCanvasMs?.n >= 10, { canvas: typing.keyToCanvasMs, onScreen: typing.onScreen });
  const scrolling = r.steps.scrolling.results;
  run.check('scrolling: canvas and plain-page update rates measured on screen', scrolling.onScreen?.canvasChangesPerSec > 0 && scrolling.onScreen?.plainChangesPerSec > 0, scrolling.onScreen);
  run.check('scroll-end: box A equals box B where the scrolling stopped', checkById(r, 'scrolling.scroll-end')?.verdict === 'pass', checkById(r, 'scrolling.scroll-end'));
  run.check('effect: the step ran and recorded its path', r.steps.effect.status === 'done' && ['effect', '2d'].includes(r.steps.effect.results.path), r.steps.effect.results);
  if (zoom) run.check('zoom: the emulated 125 % zoom was seen and measured', r.steps.zoom.status === 'done' && r.steps.zoom.results.zoomPercent === 125 && checkById(r, 'zoom.rest')?.verdict === 'pass', { zoom: r.steps.zoom.results.zoomPercent, rest: checkById(r, 'zoom.rest') });
  run.check('crops: PNG pictures within the 2 MB budget', Object.keys(r.crops.images).length >= 5 && r.crops.usedChars <= 2e6, { n: Object.keys(r.crops.images).length, used: r.crops.usedChars, omitted: r.crops.omitted.length });
  // the self-check button for developers
  await page.evaluate("document.getElementById('ft-selfcheck-button').scrollIntoView({ block: 'center' })");
  const b = await centerOf(page, '#ft-selfcheck-button');
  await page.click(b.x, b.y);
  const sc = await H.until(() => page.evaluate('window.__fieldTest.report.selfCheck'), 20000, 200);
  run.check('self-check: the oracle passes identical pictures and fails broken ones', sc?.ok === true, sc);
  await page.close();
  return run;
}

async function runBroken(browser, site) {
  const run = new Run('broken (positive control)');
  const page = await browser.newPage({ reuseFirst: false });
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.navigate(site.url + '/examples/field-test/');
  await need(() => page.evaluate('!!window.__fieldTest'), 15000, 'the page script');
  // the deliberately broken canvas: every drawElementImage lands 8 grid px lower
  await page.evaluate(`(() => {
    const proto = CanvasRenderingContext2D.prototype, original = proto.drawElementImage;
    proto.drawElementImage = function (el, x, y, ...rest) { return original.call(this, el, x, y + 8, ...rest); };
    for (const c of document.querySelectorAll('canvas[content=drawable]')) c.requestPaint && c.requestPaint();
  })()`);
  await press(page, 'start');
  await waitStep(page, 'capture', 30000);
  await press(page, 'allow');
  await waitStep(page, 'typing', 120000);
  await skipUntil(page, 'finish');
  const r = await finishAndDownload(page, run, join(outDir, 'broken'));
  if (r) {
    for (const id of ['rest', 'focus', 'select-input', 'select-text', 'scroller']) {
      const c = checkById(r, 'picture.' + id);
      run.check(`picture.${id}: the oracle FAILS the shifted canvas`, c?.verdict === 'fail', c);
    }
    run.check('the failing comparisons keep their diff pictures', Object.keys(r.crops.images).some((k) => k.endsWith('.diff')), Object.keys(r.crops.images));
  }
  await page.close();
  return run;
}

async function runDenied(browser, site) {
  const run = new Run('denied');
  const page = await browser.newPage({ reuseFirst: false });
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: "navigator.mediaDevices.getDisplayMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));" });
  await page.navigate(site.url + '/examples/field-test/');
  await need(() => page.evaluate('!!window.__fieldTest'), 15000, 'the page script');
  await press(page, 'start');
  await waitStep(page, 'capture', 30000);
  await press(page, 'allow');
  await waitStep(page, 'typing', 120000);
  await skipUntil(page, 'finish');
  const r = await finishAndDownload(page, run, join(outDir, 'denied'));
  if (r) {
    run.check("the capture state is 'denied'", r.capture.state === 'denied', r.capture);
    const c = checkById(r, 'picture.select-input');
    run.check('without the capture the canvas-only checks still run (select-input: the selection is drawn)', c?.verdict === 'info' && c.numbers?.roiChangedPct > 0.5, c);
    run.check('without the capture the canvas backing store is kept as a picture', Object.keys(r.crops.images).some((k) => k.endsWith('canvas-backing-store')), Object.keys(r.crops.images));
    run.check('skipped steps are recorded as skipped', ['typing', 'scrolling', 'effect', 'zoom'].every((id) => r.steps[id].status === 'skipped'), Object.fromEntries(Object.entries(r.steps).map(([k, v]) => [k, v.status])));
    run.check('a skipped step records no measurement verdict', r.checks.filter((c) => ['typing', 'scrolling', 'effect', 'zoom'].includes(c.id.split('.')[0])).every((c) => c.verdict === 'skipped'), r.checks.filter((c) => ['typing', 'scrolling', 'effect', 'zoom'].includes(c.id.split('.')[0])));
  }
  await page.close();
  return run;
}

async function runWithoutPolyfill(browser, site, name, setup) {
  const run = new Run(name);
  const page = await browser.newPage({ reuseFirst: false });
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await setup(page);
  await page.navigate(site.url + '/examples/field-test/');
  const started = !!(await H.until(() => page.evaluate('!!window.__fieldTest'), 15000));
  run.check('the page starts', started);
  if (!started) { await page.close(); return run; }
  await press(page, 'start');
  await waitStep(page, 'capture', 30000);
  await skipUntil(page, 'finish');
  const r = await finishAndDownload(page, run, join(outDir, name));
  if (r) {
    assertShape(run, r);
    run.check(name === 'refused' ? 'the refusal is recorded' : 'the missing script is recorded', name === 'refused' ? r.polyfill.refused?.feature === 'browser' && /120/.test(r.polyfill.refused.message) : r.polyfill.scriptLoaded === false, r.polyfill);
    run.check('the install check fails with the reason', checkById(r, 'polyfill.install')?.verdict === 'fail', checkById(r, 'polyfill.install'));
  }
  await page.close();
  return run;
}

const RUNS = {
  clean: (b, s) => runClean(b, s),
  dpr125: (b, s) => runClean(b, s, { name: 'dpr125', zoom: false }),
  broken: (b, s) => runBroken(b, s),
  denied: (b, s) => runDenied(b, s),
  refused: (b, s) => runWithoutPolyfill(b, s, 'refused', (page) => page.send('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    userAgentMetadata: { brands: [{ brand: 'Chromium', version: '120' }, { brand: 'Google Chrome', version: '120' }], fullVersion: '120.0.0.0', platform: 'macOS', platformVersion: '15.0.0', architecture: 'arm', model: '', mobile: false } })),
  missing: (b, s) => runWithoutPolyfill(b, s, 'missing', async () => {}),
};

const results = [];
let failed = 0;
for (const name of Object.keys(RUNS).filter((n) => !only || only.includes(n))) {
  const site = await startServer(name === 'missing' ? { files: { '/dist/hic-live-polyfill.iife.min.js': join(outDir, 'does-not-exist.js') } } : {});
  const browser = await H.launchChrome({ name: 'field-test', ...(name === 'dpr125' ? { dpr: 1.25 } : {}), windowSize: [1280, Number(H.arg('wh', 1100))], extraArgs: [...(headed ? [] : ['--headless=new']), `--auto-select-tab-capture-source-by-title=${TITLE}`] });
  browser.conn.sendTimeoutMs = 60000;
  console.log(`${name}: Chrome ${browser.version?.Browser} (${headed ? 'headed' : 'headless'}), ${site.url}`);
  const t0 = Date.now();
  let run;
  try { run = await RUNS[name](browser, site); }
  catch (error) {
    run = new Run(name); run.check('the run completed', false, String(error?.stack ?? error).slice(0, 600));
    // keep what the page had measured, for the diagnosis
    const page = browser.pages.at(-1);
    const partial = page ? await page.evaluate('JSON.stringify(window.__fieldTest.buildReport({ crops: false }), null, 1)').catch(() => null) : null;
    if (partial) { writeFileSync(join(outDir, `${name}-partial-report.json`), partial); console.log(`  partial report: ${join(outDir, `${name}-partial-report.json`)}`); }
  }
  finally { await browser.close().catch(() => browser.kill()); await site.close(); }
  const bad = run.checks.filter((c) => !c.ok).length;
  if (bad || !run.checks.length) failed += 1;
  const knownN = run.checks.filter((c) => c.known).length;
  console.log(`${bad ? 'FAIL' : 'ok  '} ${name}: ${run.checks.length - bad}/${run.checks.length} checks${knownN ? ` (${knownN} known red)` : ''}, ${Math.round((Date.now() - t0) / 1000)} s`);
  results.push({ name, checks: run.checks, summary: run.report?.summary ?? null });
}
writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
console.log(`results: ${outDir}`);
console.log(failed ? `G-field-test: FAILED (${failed} run(s))` : 'G-field-test: OK');
process.exit(failed ? 1 : 0);
