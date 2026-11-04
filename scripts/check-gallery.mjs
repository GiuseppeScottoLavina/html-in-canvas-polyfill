#!/usr/bin/env node
// G-gallery: the plugin gallery (examples/plugins/) against the rules of docs/guides/EFFECTS-PLUGINS.md 15.1 (touch, demo, zero work at rest)
// and its own layout, for every plugin of dist/plugins/manifest.json plus the template plugin (plugins/_template/, bundled here and injected:
// the model plugin, whose `demo` exercises the gallery's demo path). HEADLESS Chrome, against the BUILT dist/.
//
//   npm run build && npm run test:gallery
//   node scripts/check-gallery.mjs [--only=water,template] [--views=phone,ipad] [--no-control] [--controls-only]
//
// Per plugin and view (phone 390 x 844 at DPR 3, iPad landscape 1194 x 748 at DPR 2; mobile metrics and touch emulation):
//   fold      the stage (the canvas) lies entirely in the first viewport; no horizontal page scroll
//   fit       the form fits the stage without an inner scroll (scrollHeight <= clientHeight + 1), with the plugin's controls mounted
//   demo      a plugin with an action `demo`: the gallery played it on selection, it resolved with a state (not null, no error) within 6 s,
//             and frames were presented while it played; a plugin without one must be listed in NO_DEMO with the reason
//   rest      once the demo ended and handle.settled() resolved, after 1 s of grace: 0 effectframe events over 2 s, unless the plugin
//             declares `meta.continuous` (then the rate at rest is printed); the HUD then reads 0 fx/s
//   scroll    (phone) a vertical touch drag that starts on the stage, left of the middle and away from the corners, scrolls the page
// Once, under prefers-reduced-motion (phone): no demo is played ('prefers-reduced-motion'). Once ('off', iPad): the frame cap defaults to
// the display rate measured by the page (canvas.frameCap 0 = uncapped, the slider at its top = the rounded rate).
// Positive controls (each must turn ITS check red; --no-control skips them), all on the template plugin unless said otherwise:
//   C1 fold    a 700 px block above the stage                     C2 fit     600 px more padding in the form's card
//   C3 rest    the page changes a drawn text every 100 ms         C4 rest    the effects bundle with a host that never idles (hasContinuous
//                                                                            always true: a mutant of dist/hic-live-effects.iife.min.js)
//   C5 demo    the gallery opened with ?demo=0                    C6 scroll  a non-passive touchstart listener that cancels every touch
//   C7 reduced the page sees no reduced-motion preference while the emulation sets it
//   C8 cap     the slider moved to 60 before the check ('off')
// Results: .scratch/results/gallery-<timestamp>.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import * as H from '../test/harness/index.mjs';
import { startServer } from '../examples/serve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const only = H.arg('only')?.split(',');
const viewsWanted = H.arg('views')?.split(',');
const withControl = !process.argv.includes('--no-control');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

const VIEWS = [
  { name: 'phone', width: 390, height: 844, dpr: 3 },
  { name: 'ipad', width: 1194, height: 748, dpr: 2 },
].filter((v) => !viewsWanted || viewsWanted.includes(v.name));
/** Plugins whose look does not depend on an input or an event, so they need no `demo` (EFFECTS-PLUGINS.md 15.1, rule 2). */
const NO_DEMO = /** @type {Record<string, string>} */ ({ crt: 'a monitor look that is there at rest; it is continuous by design' });
const DEMO_LIMIT_MS = 6000;

if (!existsSync(join(ROOT, 'dist/plugins/manifest.json'))) { console.error('dist/plugins/manifest.json is missing: run `npm run build` first.'); process.exit(2); }
const { plugins: manifest } = JSON.parse(readFileSync(join(ROOT, 'dist/plugins/manifest.json'), 'utf8'));

// ---- the template plugin, bundled like scripts/build.mjs does (its .wgsl inlined) and registered by an init script ---------------------
async function templateBundle() {
  const dir = join(ROOT, 'plugins/_template');
  const register = "import * as m from './index.js';\nconst g = globalThis;\nconst r = g.HicLivePlugins || Object.defineProperty(g, 'HicLivePlugins', { value: {}, configurable: true }).HicLivePlugins;\n"
    + "Object.defineProperty(r, 'template', { value: Object.freeze({ ...m }), configurable: true, enumerable: true });\n";
  const wgsl = { name: 'inline-wgsl', setup(/** @type {any} */ b) {
    b.onResolve({ filter: /^\.\/wgsl\.js$/ }, (/** @type {any} */ a) => (a.importer.startsWith(dir + sep) ? { path: 'template-wgsl', namespace: 'wgsl' } : undefined));
    b.onLoad({ filter: /.*/, namespace: 'wgsl' }, () => ({ contents: `const f = { 'offset.wgsl': ${JSON.stringify(readFileSync(join(dir, 'offset.wgsl'), 'utf8'))} };\nexport async function wgsl(n) { return f[n]; }\n`, loader: 'js' }));
  } };
  const out = await build({ stdin: { contents: register, resolveDir: dir, sourcefile: 'template-register.js', loader: 'js' }, bundle: true, format: 'iife', write: false, plugins: [wgsl], target: 'es2022' });
  const { meta, plugin } = await import(pathToFileURL(join(dir, 'index.js')).href);
  const entry = { name: meta.name, title: meta.title, description: meta.description, reducedMotion: meta.reducedMotion, version: plugin.version, defaults: meta.defaults ?? {}, actions: plugin.actions ?? [], files: { min: 'template.iife.min.js' } };
  return { source: out.outputFiles[0].text, entry };
}
const template = await templateBundle();
const all = [...manifest.map((/** @type {any} */ p) => p.name), 'template'].filter((n) => !only || only.includes(n));

/** init script: the template registered, and appended to the manifest the gallery fetches; the effect frames counted from the first one */
const initScript = `${template.source}
;(() => {
  const real = window.fetch;
  window.fetch = async function (input, init) {
    const r = await real.call(this, input, init);
    if (!/dist\\/plugins\\/manifest\\.json$/.test(String(input && input.url || input))) return r;
    const j = await r.clone().json(); j.plugins.push(${JSON.stringify(template.entry)});
    return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  window.__gc = { frames: 0, last: 0 };
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('stage')?.addEventListener('effectframe', () => { window.__gc.frames += 1; window.__gc.last = performance.now(); });
  });
})();`;

/** the effects bundle with a host that never idles (C4) */
function neverIdleEffects() {
  const text = readFileSync(join(ROOT, 'dist/hic-live-effects.iife.min.js'), 'utf8');
  const anchor = 'hasContinuous(){return ';
  if (text.split(anchor).length !== 2) throw new Error(`C4: the anchor "${anchor}" must occur exactly once in dist/hic-live-effects.iife.min.js (rebuilt? fix the anchor)`);
  return text.replace(anchor, `${anchor}!0||`);
}

/**
 * One gallery run. @param {any} browser @param {any} server @param {string} name @param {any} view
 * @param {{query?: string, css?: string, script?: string, effects?: string, reducedMotion?: boolean, fakeNoReduce?: boolean, steps?: string[]}} [o]
 */
async function runOne(browser, server, name, view, o = {}) {
  const page = await browser.newPage({ reuseFirst: false });
  const checks = /** @type {{step: string, name: string, ok: boolean, detail?: unknown}[]} */ ([]);
  const check = (/** @type {string} */ step, /** @type {string} */ what, /** @type {unknown} */ ok, /** @type {unknown} */ detail) => { checks.push({ step, name: what, ok: !!ok, detail }); return !!ok; };
  const want = (/** @type {string} */ s) => !o.steps || o.steps.includes(s);
  const numbers = /** @type {Record<string, unknown>} */ ({});
  try {
    await page.send('Emulation.setDeviceMetricsOverride', { width: view.width, height: view.height, deviceScaleFactor: view.dpr, mobile: true });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: o.reducedMotion ? 'reduce' : 'no-preference' }] });
    let script = initScript;
    if (o.css) script += `\ndocument.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(o.css)}; document.head.append(s); });`;
    if (o.fakeNoReduce) script += `\n{ const mm = window.matchMedia.bind(window); window.matchMedia = (q) => /reduced-motion/.test(q) ? Object.assign(mm('(min-width: 999999px)'), {}) : mm(q); }`;
    if (o.script) script += '\n' + o.script;
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: script });
    if (o.effects) {
      await page.send('Fetch.enable', { patterns: [{ urlPattern: '*hic-live-effects.iife.min.js' }] });
      page.on('Fetch.requestPaused', (/** @type {any} */ ev) => {
        page.send('Fetch.fulfillRequest', { requestId: ev.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }], body: Buffer.from(/** @type {string} */ (o.effects)).toString('base64') }).catch(() => {});
      });
    }
    page.clearLogs();
    await page.navigate(`${server.url}/examples/plugins/?effect=${name}${o.query ?? ''}`);
    const ready = await page.waitForFunction(`!!(window.__gallery && window.__gallery.ready && window.__gallery.active === ${JSON.stringify(name)})`, { timeout: 20000 }).then(() => true, () => false);
    if (!check('load', `the gallery is ready with ${name} applied on the WebGPU path`, ready && (await page.evaluate('window.__gallery.mode')) === 'effect', { mode: await page.evaluate('window.__gallery && window.__gallery.mode') })) return { checks, numbers };
    const info = await page.evaluate(`(() => { const e = window.HicLivePlugins && window.HicLivePlugins[${JSON.stringify(name)}]; const h = window.__gallery.handle;
      return { continuous: e && e.meta && e.meta.continuous || null, actions: h && h.actions ? [...h.actions] : [] }; })()`);
    numbers.continuous = info.continuous;

    // demo: played on selection, resolved, frames while it played
    const hasDemo = info.actions.includes('demo');
    if (want('demo') && name !== 'off') {
      if (o.reducedMotion) {
        const d = await page.evaluate('window.__gallery.demo');
        check('demo', 'under prefers-reduced-motion the gallery plays no demo', !!d && !d.played && (hasDemo ? d.skipped === 'prefers-reduced-motion' : true), d);
      } else if (hasDemo) {
        const d = await H.until(() => page.evaluate('window.__gallery.demo && window.__gallery.demo.done ? window.__gallery.demo : null'), DEMO_LIMIT_MS + 4000);
        const framesDuring = await page.evaluate('window.__gc.frames');
        numbers.demo = d && { state: d.state, ms: d.ms, frames: framesDuring };
        check('demo', `the gallery played the demo on selection; it resolved with a state within ${DEMO_LIMIT_MS / 1000} s and presented frames`,
          !!d && d.played && d.state !== null && d.state !== undefined && !d.error && d.ms <= DEMO_LIMIT_MS && framesDuring >= 10, { demo: d, framesDuring });
      } else {
        check('demo', 'a plugin whose look depends on an input or an event has an action `demo` (EFFECTS-PLUGINS.md 15.1)', name in NO_DEMO, { actions: info.actions, exemption: NO_DEMO[name] ?? null });
      }
    }

    // rest: settled, 1 s of grace, then 2 s without an effect frame
    if (want('rest')) {
      if (info.actions.length) numbers.settled = await page.evaluate(`Promise.race([Promise.resolve(window.__gallery.handle.settled()), new Promise((r) => setTimeout(() => r('still in motion after 10 s'), 10000))])`);
      await H.sleep(1000);
      const a = await page.evaluate('window.__gc.frames');
      await H.sleep(2000);
      const atRest = (await page.evaluate('window.__gc.frames')) - a;
      numbers.framesAtRest2s = atRest;
      if (info.continuous) check('rest', `continuous by design (meta.continuous): ${atRest / 2} effect frames/s at rest`, true, { continuous: info.continuous });
      else check('rest', 'once it settled: 0 effect frames over 2 s (zero work at rest)', atRest === 0, { framesIn2s: atRest, settled: numbers.settled });
      await H.sleep(1100);
      const hud = await page.evaluate(`({ text: document.getElementById('m-fps').textContent, hud: window.__gallery.hud })`);
      if (!info.continuous && atRest === 0) check('rest', 'the HUD reads 0 effect frames per second at rest', hud.text === '0' || hud.text === '-', hud);
    }

    // fold and fit, with the plugin's controls mounted
    if (want('fold') || want('fit')) {
      const m = await page.evaluate(`(() => { const s = document.getElementById('stage').getBoundingClientRect(); const f = document.getElementById('demo-form');
        return { stage: { top: s.top, bottom: s.bottom, left: s.left, right: s.right }, vw: innerWidth, vh: innerHeight, scrollWidth: document.documentElement.scrollWidth, formScroll: f.scrollHeight, formClient: f.clientHeight }; })()`);
      numbers.layout = m;
      if (want('fold')) check('fold', `the stage lies entirely in the first viewport (${view.width} x ${view.height}), no horizontal page scroll`, m.stage.top >= 0 && m.stage.left >= 0 && m.stage.bottom <= m.vh + 0.5 && m.stage.right <= m.vw + 0.5 && m.scrollWidth <= m.vw, m);
      if (want('fit')) check('fit', 'the form fits the stage without an inner scroll', m.formScroll <= m.formClient + 1, { scrollHeight: m.formScroll, clientHeight: m.formClient });
    }

    // a vertical touch drag on the stage scrolls the page
    if (want('scroll') && view.name === 'phone') {
      await page.evaluate('window.scrollTo(0, 0)');
      await H.sleep(150);
      const s = await page.evaluate(`(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { x: r.left + r.width * 0.3, y: r.top + r.height * 0.62 }; })()`);
      await H.touchDrag(page, { x: Math.round(s.x), y: Math.round(s.y), dir: 1, step: 14, count: 14, intervalMs: 16, restMs: 30 });
      const scrolled = await H.until(() => page.evaluate('window.scrollY > 60 ? window.scrollY : null'), 1500);
      check('scroll', 'a vertical touch drag that starts on the stage (away from a handle) scrolls the page', !!scrolled, { scrollY: scrolled ?? (await page.evaluate('window.scrollY')), at: s });
    }

    // the frame cap defaults to the display rate
    if (want('cap')) {
      const c = await H.until(() => page.evaluate(`window.__gallery.displayHz ? (() => { const r = document.getElementById('fps-cap'); return { hz: window.__gallery.displayHz, cap: document.getElementById('stage').frameCap, value: r.value, max: r.max, label: document.getElementById('fps-cap-value').textContent }; })() : null`), 6000);
      numbers.cap = c;
      const top = c && String(Math.min(240, Math.max(30, Math.round(c.hz / 5) * 5)));
      check('cap', 'the frame cap defaults to the display rate the page measured (frameCap 0 = uncapped; the slider at its top, the rounded rate)', !!c && c.cap === 0 && c.value === top && c.max === top && /display/.test(c.label), c);
    }
    const errors = page.errors({ includeWarnings: false }).filter((e) => !/favicon/.test(e.text ?? ''));
    check('load', 'no console error or page exception', errors.length === 0, errors.slice(0, 3).map((e) => String(e.text).slice(0, 200)));
  } catch (error) {
    check('load', 'the run finished', false, String(/** @type {Error} */ (error).message ?? error));
  } finally {
    await page.close().catch(() => {});
  }
  return { checks, numbers };
}

const results = { script: 'scripts/check-gallery.mjs', startedAt: new Date().toISOString(), headless: true, views: VIEWS, runs: /** @type {any[]} */ ([]), controls: /** @type {any[]} */ ([]), pass: false };
const server = await startServer();
let failed = 0;
/** a new headless Chrome per group of runs: one browser at a time, and a crash costs one group, not the run */
async function withBrowser(/** @type {(b: any) => Promise<void>} */ fn) {
  const browser = await H.launchChrome({ name: 'gallery-check', windowSize: [1300, 950], dpr: 1, extraArgs: ['--headless=new', '--hide-scrollbars'] });
  browser.conn.sendTimeoutMs = 30000;
  try { await fn(browser); } finally { await browser.close().catch(() => browser.kill()); }
}
try {
  for (const name of process.argv.includes('--controls-only') ? [] : all) {
    await withBrowser(async (browser) => {
      for (const view of VIEWS) {
        const r = await runOne(browser, server, name, view, { steps: ['demo', 'rest', 'fold', 'fit', 'scroll'] });
        results.runs.push({ plugin: name, view: view.name, ...r });
        for (const c of r.checks) { console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${name.padEnd(13)} ${view.name.padEnd(6)} [${c.step}] ${c.name}${c.ok ? '' : '  ' + JSON.stringify(c.detail)}`); if (!c.ok) failed += 1; }
      }
      if (VIEWS.some((v) => v.name === 'phone')) {
        const r = await runOne(browser, server, name, VIEWS.find((v) => v.name === 'phone'), { reducedMotion: true, steps: ['demo'] });
        results.runs.push({ plugin: name, view: 'phone, reduced motion', ...r });
        for (const c of r.checks) { console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${name.padEnd(13)} reduce [${c.step}] ${c.name}${c.ok ? '' : '  ' + JSON.stringify(c.detail)}`); if (!c.ok) failed += 1; }
      }
    });
  }
  if ((!only || only.includes('off')) && !process.argv.includes('--controls-only')) {
    await withBrowser(async (browser) => {
      const view = VIEWS.find((v) => v.name === 'ipad') ?? VIEWS[0];
      const r = await runOne(browser, server, 'off', view, { steps: ['cap', 'fold', 'fit'] });
      results.runs.push({ plugin: 'off', view: view.name, ...r });
      for (const c of r.checks) { console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${'off'.padEnd(13)} ${view.name.padEnd(6)} [${c.step}] ${c.name}${c.ok ? '' : '  ' + JSON.stringify(c.detail)}`); if (!c.ok) failed += 1; }
    });
  }

  if (withControl) {
    const phone = { name: 'phone', width: 390, height: 844, dpr: 3 }, ipad = { name: 'ipad', width: 1194, height: 748, dpr: 2 };
    const CONTROLS = [
      { id: 'C1', step: 'fold', name: 'template', view: ipad, o: { css: '#top::after { content: ""; display: block; height: 700px; }', steps: ['fold'] } },
      { id: 'C2', step: 'fit', name: 'template', view: phone, o: { css: '#demo-form .card { padding-bottom: 600px !important; }', steps: ['fit'] } },
      { id: 'C3', step: 'rest', name: 'template', view: ipad, o: { script: "addEventListener('load', () => setInterval(() => { const f = document.getElementById('form-feedback'); if (f) f.textContent = 'tick ' + Date.now(); }, 100));", steps: ['demo', 'rest'] } },
      { id: 'C4', step: 'rest', name: 'template', view: ipad, o: { effects: neverIdleEffects(), steps: ['demo', 'rest'] } },
      { id: 'C5', step: 'demo', name: 'template', view: ipad, o: { query: '&demo=0', steps: ['demo'] } },
      { id: 'C6', step: 'scroll', name: 'template', view: phone, o: { script: "document.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false, capture: true });", steps: ['scroll'] } },
      { id: 'C7', step: 'demo', name: 'template', view: phone, o: { reducedMotion: true, fakeNoReduce: true, steps: ['demo'] } },
      { id: 'C8', step: 'cap', name: 'off', view: ipad, o: { script: "addEventListener('load', () => setTimeout(() => { const r = document.getElementById('fps-cap'); r.value = '60'; r.dispatchEvent(new Event('input')); }, 300));", steps: ['cap'] } },
    ];
    await withBrowser(async (browser) => {
      for (const c of CONTROLS) {
        const r = await runOne(browser, server, c.name, c.view, /** @type {any} */ (c.o));
        const red = r.checks.filter((x) => x.step === c.step && !x.ok);
        const loaded = r.checks.find((x) => x.step === 'load' && /ready/.test(x.name))?.ok;
        const ok = !!loaded && red.length > 0;
        results.controls.push({ id: c.id, step: c.step, red: ok, checks: r.checks });
        console.log(`${ok ? 'ok  ' : 'FAIL'} control ${c.id} [${c.step}] turns red${ok ? ': ' + red[0].name : '  (it did not: ' + JSON.stringify(r.checks.map((x) => [x.step, x.ok])) + ')'}`);
        if (!ok) failed += 1;
      }
    });
  }
} finally {
  await server.close().catch(() => {});
}
results.pass = failed === 0;
const outDir = resolve(ROOT, '.scratch/results'); mkdirSync(outDir, { recursive: true });
const file = join(outDir, `gallery-${stamp}.json`);
writeFileSync(file, JSON.stringify(results, null, 1));
console.log(`\nresults: ${file}`);
console.log(failed ? `G-gallery: FAILED (${failed} checks)` : `G-gallery: OK (${results.runs.reduce((n, r) => n + r.checks.length, 0)} checks, ${results.controls.length} controls red)`);
process.exit(failed ? 1 : 0);
