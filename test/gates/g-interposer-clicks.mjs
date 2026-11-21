// G-interposer-clicks: the clicks of a re-targeted gesture with TRUSTED input, against Chrome's own implementation of the same page. A spatial plugin
// whose mapper sends every point to A (the element drawn under the pointer) over a source where the browser hits B (fixtures/interposer-clicks.html).
// Found by a library built on the polyfill: a click over a paragraph that the mapper sends to a drawn button clicked the button AND the paragraph.
//   clicks      for each layout (a button over a button, a div over a paragraph, a button over a form, a paragraph over a button, a span inside a button,
//               a summary, a label, and a double click over a button and over a paragraph), the click and dblclick events that the listeners of the page
//               see (a capture listener on the document, a listener on each element) are the ones they see natively, by type and target, and none
//               reaches B. The polyfill's are not trusted (a script cannot make a trusted event): only their type and target are compared.
//   activation  what the click does is what it does natively: the details open, the checkbox checked, the focused element.
//   flight      rows in flight (fixtures/interposer-flight.html): the pointer rests over row B, then the picture moves so that row A is drawn under it (rows flying
//               to their place after a sort) and a press and release follow without any move. The click goes to what the gesture's mapper shows there, A's
//               cell or A's button, and to nothing else (1.0.2: B, or A's button and B's, or a trusted click at the tbody). The same on both paths: over the
//               native implementation the hit-test geometry was aimed at the last move, before the rows flew, so that press is re-targeted there too.
//   surface     both pages start (core, effects host, plugin) without a page error.
// Not compared, by design (src/effects/interposer.js): the pointer events, which plugins and the page keep seeing at the element the browser hit, and
// mousedown / mouseup, which the cancelled press stops there and which are not re-created at A (natively A gets both).
// Positive control: the host created with `interposer: false` (?interposer=0): the clicks reach B, clicks goes red.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runGate, H, ROOT, EFFECTS_BUNDLE } from './lib/gate.mjs';

const FIXTURE = '/test/gates/fixtures/interposer-clicks.html';
const LAYOUTS = ['button-button', 'div-p', 'button-p', 'button-form', 'p-button', 'span-in-button-p', 'summary-p', 'label-p'];
const DOUBLE = ['button-button', 'div-p'];
const FLIGHT = '/test/gates/fixtures/interposer-flight.html';
/** where the pointer rests (row B) -> the only click expected: what row A, drawn there after the flight, shows at that point */
const FLIGHT_CASES = { B: ['click:A'], Bbtn: ['click:Abtn'] };
const FLIGHT_ROUNDS = 3;
const WINDOW = [800, 600];

/** @param {any} page @param {string} source */
async function inject(page, source) { await page.send('Page.addScriptToEvaluateOnNewDocument', { source }); }

/**
 * Every case on `page`: a trusted click (two for a double click) over B, 110 / 80 css px into the canvas.
 * @param {any} page @param {string} base @param {string} [extra]
 */
async function runCases(page, base, extra = '') {
  /** @type {Record<string, any>} */
  const out = {};
  const cases = [...LAYOUTS.map((l) => ({ l, double: false })), ...DOUBLE.map((l) => ({ l, double: true }))];
  for (const { l, double } of cases) {
    const key = double ? `${l} double` : l;
    await page.navigate(`${base}${FIXTURE}?l=${l}${extra}`);
    await page.waitForFunction('window.__ready || window.__err', { timeout: 15000 });
    const err = await page.evaluate('window.__err || null');
    if (err) { out[key] = { error: String(err).slice(0, 300) }; continue; }
    const p = await page.evaluate(`(() => { const c = document.getElementById('c').getBoundingClientRect(); return { x: c.left + 110, y: c.top + 80 }; })()`);
    await page.mouseMove(p.x - 20, p.y);
    await H.sleep(100);
    await page.evaluate('window.__log.length = 0');
    for (const n of double ? [1, 2] : [1]) {
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: n });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: n });
    }
    await H.sleep(300);
    out[key] = await page.evaluate(`({
      seen: window.__log.filter((e) => /click/.test(e.type)).map((e) => e.type + '@' + e.target),
      open: document.getElementById('D')?.open ?? null, checked: document.getElementById('K')?.checked ?? null,
      active: document.activeElement?.id || document.activeElement?.localName })`);
  }
  return out;
}

/** The rows-in-flight case, FLIGHT_ROUNDS times per resting place. @param {any} page @param {string} base @param {string} [extra] */
async function runFlight(page, base, extra = '') {
  /** @type {Record<string, string[][]>} */
  const out = {};
  for (const target of Object.keys(FLIGHT_CASES)) {
    out[target] = [];
    for (let k = 0; k < FLIGHT_ROUNDS; k++) {
      await page.navigate(`${base}${FLIGHT}?${extra.replace(/^&/, '')}`);
      await page.waitForFunction('window.__ready || window.__err', { timeout: 15000 });
      const err = await page.evaluate('window.__err || null');
      if (err) { out[target].push([`error: ${String(err).slice(0, 200)}`]); continue; }
      const p = await page.evaluate(`(() => { const r = document.getElementById('${target}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await page.mouseMove(p.x, p.y);
      await H.sleep(300);
      await page.evaluate('window.__fly()');
      await H.sleep(400);
      await page.evaluate('window.__log.length = 0');
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await H.sleep(60);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await H.sleep(250);
      out[target].push(await page.evaluate(`window.__log.filter((s) => s.startsWith('click:')).map((s) => s.replace(/\\*$/, ''))`));
    }
  }
  return out;
}

/** @param {any} ctx @param {string} path @param {Record<string, string[][]>} runs */
function checkFlight(ctx, path, runs) {
  for (const [target, want] of Object.entries(FLIGHT_CASES)) {
    const got = runs[target] ?? [];
    ctx.check(`flight, ${path}: the pointer resting over ${target}, rows flying under it: every press clicks ${want.join(', ')} and nothing else (${FLIGHT_ROUNDS} presses)`,
      got.length === FLIGHT_ROUNDS && got.every((g) => JSON.stringify(g) === JSON.stringify(want)), { got, want }, 'flight');
  }
}

/** The native reference, in its own browser before the gate's (one browser at a time). */
async function nativeReference(core, effects) {
  const srv = await H.startServer();
  let browser = null;
  try {
    browser = await H.launchChrome({ name: 'gate-G-interposer-clicks-native', chrome: 'stable', nativeDrawElement: true, windowSize: WINDOW, extraArgs: ['--headless=new'] });
    const page = await browser.newPage({ reuseFirst: true });
    await inject(page, `${core}\n;${effects}`);
    const cases = await runCases(page, srv.url.replace(/\/$/, ''));
    const mode = await page.evaluate('window.__HIC__?.installed?.mode ?? null');
    const flight = await runFlight(page, srv.url.replace(/\/$/, ''));
    return { cases, mode, flight, errors: page.errors({ includeWarnings: false }), version: browser.version?.Browser ?? null, error: null };
  } catch (err) {
    return { cases: {}, mode: null, flight: {}, errors: [], version: browser?.version?.Browser ?? null, error: String(err?.message ?? err).slice(0, 400) };
  } finally {
    await browser?.close().catch(() => {});
    await srv.close();
  }
}

const CORE = readFileSync(resolve(ROOT, 'dist/hic-live-polyfill.iife.js'), 'utf8');
const EFFECTS = readFileSync(resolve(ROOT, 'dist/hic-live-effects.iife.js'), 'utf8');
const native = await nativeReference(CORE, EFFECTS);

runGate('G-interposer-clicks', async (ctx) => {
  const numbers = { native: native.version, nativeMode: native.mode, cases: {} };
  ctx.check('the native reference ran (Chrome with CanvasDrawElement, the effects host over the native implementation), with no page error',
    !native.error && native.mode === 'native' && native.errors.length === 0 && Object.values(native.cases).every((c) => !c.error), { error: native.error, mode: native.mode, errors: native.errors.slice(0, 3) }, 'surface');
  if (native.error) return { numbers };
  const page = await ctx.page();
  const core = await (await fetch(new URL(ctx.bundle, ctx.srv.url))).text();
  const effects = await (await fetch(new URL(EFFECTS_BUNDLE, ctx.srv.url))).text();
  await inject(page, `${core}\n;${effects}`);
  const errors0 = page.errors().length;
  const poly = await runCases(page, ctx.srv.url.replace(/\/$/, ''), ctx.control ? '&interposer=0' : '');
  for (const [key, ref] of Object.entries(native.cases)) {
    const got = poly[key] ?? { error: 'not run' };
    numbers.cases[key] = { poly: got, native: ref };
    ctx.check(`${key}: the page starts`, !got.error, got.error ?? null, 'surface');
    if (got.error) continue;
    const toB = got.seen.filter((s) => /@B$/.test(s));
    ctx.check(`${key}: the click events the page sees are native's (${ref.seen.join(', ')}), none at B`,
      toB.length === 0 && JSON.stringify(got.seen) === JSON.stringify(ref.seen), { poly: got.seen, native: ref.seen }, 'clicks');
    ctx.check(`${key}: the click does what it does natively (details open ${ref.open}, checkbox ${ref.checked}, focus on ${ref.active})`,
      got.open === ref.open && got.checked === ref.checked && got.active === ref.active, { poly: { open: got.open, checked: got.checked, active: got.active }, native: ref }, 'activation');
  }
  const flight = await runFlight(page, ctx.srv.url.replace(/\/$/, ''), ctx.control ? '&interposer=0' : '');
  numbers.flight = { poly: flight, native: native.flight };
  checkFlight(ctx, 'polyfill', flight);
  if (!ctx.control) checkFlight(ctx, 'over the native implementation', native.flight);
  const errs = page.errors({ includeWarnings: false }).slice(errors0);
  ctx.check('no page error', errs.length === 0, errs.slice(0, 3), 'surface');
  return { numbers };
}, { windowSize: WINDOW, headless: true, controlClasses: ['clicks', 'flight'] });
