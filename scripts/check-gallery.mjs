#!/usr/bin/env node
// G-gallery: the plugin gallery (examples/plugins/) against the rules of docs/guides/EFFECTS-PLUGINS.md 15.1 (touch, demo, zero work at rest)
// and its own layout, for every plugin of dist/plugins/manifest.json plus the template plugin (plugins/_template/, bundled here and injected:
// the model plugin, whose `demo` exercises the gallery's demo path). HEADLESS Chrome, against the BUILT dist/.
//
//   npm run build && npm run test:gallery
//   node scripts/check-gallery.mjs [--only=water,template] [--views=phone,ipad] [--no-control] [--controls-only]
//
// Per plugin and view (phone 390 x 844 at DPR 3, iPad landscape 1194 x 748 at DPR 2; mobile metrics and touch emulation; and a short phone, 375 x 667 at DPR 2,
// the height a phone browser leaves under its bars, where the stage has its smallest height and reaches below the first viewport: `fit` only):
//   fold      the stage (the canvas) lies entirely in the first viewport; no horizontal page scroll
//   fit       the form fits the stage without an inner scroll (scrollHeight <= clientHeight + 1), with the plugin's controls mounted
//   demo      a plugin with an action `demo`: the gallery played it on selection, it resolved with a state (not null, no error) within 6 s,
//             and frames were presented while it played; a plugin without one must be listed in NO_DEMO with the reason
//   rest      once the demo ended and handle.settled() resolved, after 1 s of grace: 0 effectframe events over 2 s, unless the plugin
//             declares `meta.continuous` (then the rate at rest is printed); the HUD then reads 0 fx/s
//   scroll    (phone) a vertical touch drag that starts on the stage, left of the middle and away from the corners, scrolls the page
//   beneath   (page-curl, iPad) the page under the page (createHost `under`): the gallery shows it to Page curl; while the demo turns the sheet, a touch tap where
//             the sheet uncovers the under page's field (found with host.mapPoint: a point with `under: true`) focuses that field and keeps the sheet open,
//             typing shows up in it; a tap on a field of the top page lets the sheet fall back, that field takes the focus and the under page turns inert
//             (a trusted Escape key is not used: in this emulation it stalled the headless renderer); control in the step: the same tap with the
//             curl at rest lands on the top page (a field of the form takes the focus, the under field's value is unchanged)
// Per scene other than the form (examples/plugins/ `?scene=daylight`, `?scene=live`) and view, with the water plugin:
//   scene     the gallery shows that scene: its block is laid out, the others are not, and __gallery.scene names it
//   fold, fit as above, with the scene's content
//   switch    a touch tap on the drawn switch, through the effect, selects another scene and comes back (the address follows)
//   live      (the live scene) the drawn content changes about once a second and the effect presents it: frames arrive at rest, and the drawn clock
//             moves on; back on the form, 0 effect frames over 2 s
// A chain of effects (examples/plugins/ `&then=<name>,<name>`, the Stack toggle at the head of the chips), part `stack`:
//   pick      (water; phone and iPad) a tap on Stack, then on a chip, runs that effect after the first: two plugins on the host, the chips numbered, the
//             chain and the address follow; a third joins, a fourth is refused while three run, the x in the chain takes one out; Stack off picks one alone;
//             the form shows the controls of the effect just added
//   tabs      with two effects the form has a switch between their controls: a touch tap on it, through both effects, shows the other effect's controls
//   rest      as above, with both effects settled
//   linked    (phone and short phone: the CRT monitor, the tallest controls, with water on top, from the address) both run; fit with either effect's controls shown; fold (phone)
//   under     (iPad: water under the CRT monitor at full curvature) a tap on the curved picture drops a pebble where the finger is SEEN: the first effect reads
//             the pointer through the second (EffectPluginContext.localPoint). The changed pixels are centred within UNDER_PX css px of the tap
//   pairs     (iPad, one page) every ordered pair of the manifest's plugins: both run, enabled, a frame was presented, no effecterror
//   hdr       (iPad: water, `&hdr=1`) the host uses extended range (a float canvas with the extended tone mapping), frames are presented and the page says so
//   map       (iPad: the CRT monitor at full curvature, `&map=1`) the input map: nothing drawn before a pointer arrives; a tap where the effect shows the email
//             field (found with host.mapPoint over a grid) names that field, frames its real box, shows its value, and the field has the focus; the pointer and
//             the place it is sent to are more than MAP_PX apart (the effect moved the field); a tap on the toggle takes the map away
// Once, under prefers-reduced-motion (phone): no demo is played ('prefers-reduced-motion'). Once ('off', iPad): the frame cap defaults to
// the display rate measured by the page (canvas.frameCap 0 = uncapped, the slider at its top = the rounded rate).
// Positive controls (each must turn ITS check red; --no-control skips them), all on the template plugin unless said otherwise:
//   C1 fold    a 700 px block above the stage                     C2 fit     600 px more padding in the form's card
//   C3 rest    the page changes a drawn text every 100 ms         C4 rest    the effects bundle with a host that never idles (hasContinuous
//                                                                            always true: a mutant of dist/hic-live-effects.iife.min.js)
//   C5 demo    the gallery opened with ?demo=0                    C6 scroll  a non-passive touchstart listener that cancels every touch
//   C7 reduced the page sees no reduced-motion preference while the emulation sets it
//   C8 cap     the slider moved to 60 before the check ('off')
//   C9 fit     (water, the daylight scene) a picture 900 px tall    C10 switch (water, the daylight scene) the switch takes no pointer input
//   C11 live   (water, the live scene) the page's one-second timer never starts
//   C12 fit    (page-curl, the daylight scene, the short phone) the scene's picture as a block under its title and a stage of 580 px
//   C13 pick   (water) the strip of chips takes no pointer input         C14 tabs   (water, shatter on top) the switch takes no pointer input
//   C15 under  (water under the CRT monitor) water gets a context whose localPoint returns the point on the canvas, as before the second effect
//   C16 pairs  the glitch plugin throws in render when it is not the first plugin
//   C17 map    the CRT monitor with an input mapper that returns the point as it is (the pointer is then sent to the place under it)
//   C18 hdr    the gallery opened with &hdr=0
//   C19 beneath (page-curl) the option underPage false: the page under the page is never uncovered for the pointer
// A selection that checks nothing (--controls-only with --no-control), or an unknown plugin, view or argument, is refused (exit 2) before a browser starts, and
// a run with 0 checks and 0 controls fails (scripts/gallery-plan.mjs). A selection that leaves out a plugin, a view, 'off', the scenes, the stack or the controls is a diagnostic run:
// it prints "DIAGNOSTIC PASS, not the gate" with what it left out, and its results say `scope: 'diagnostic'` and `green: false`; only the full run is green.
// Results: .scratch/results/gallery-<timestamp>.json (`pass`, `green`, `scope`, `selection`, `skipped`).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import * as H from '../test/harness/index.mjs';
import { startServer } from '../examples/serve.mjs';
import { galleryPlan, galleryVerdict } from './gallery-plan.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

const ALL_VIEWS = [
  { name: 'phone', width: 390, height: 844, dpr: 3 },
  { name: 'ipad', width: 1194, height: 748, dpr: 2 },
  { name: 'short', width: 375, height: 667, dpr: 2 },
];
/** what a view checks of a run's steps: the short phone only whether the form fits (its stage is below the first viewport by design) */
const stepsFor = (/** @type {any} */ view, /** @type {string[]} */ steps) => (view.name === 'short' ? steps.filter((s) => s === 'fit' || s === 'scene') : steps);
/** Plugins whose look does not depend on an input or an event, so they need no `demo` (EFFECTS-PLUGINS.md 15.1, rule 2). */
const NO_DEMO = /** @type {Record<string, string>} */ ({ crt: 'a monitor look that is there at rest; it is continuous by design' });
const DEMO_LIMIT_MS = 6000;
/** `under`: how far from the tap the centre of the changed pixels may lie, css px (measured: 4.1; with the pointer read on the canvas, C15, 24.4) */
const UNDER_PX = 12;
/** `map`: how far apart the pointer and the place it is sent to must be at the email field under the CRT monitor at full curvature, css px (measured: 39.5; 0 with a mapper that returns the point as it is, C17) */
const MAP_PX = 15;

if (!existsSync(join(ROOT, 'dist/plugins/manifest.json'))) { console.error('dist/plugins/manifest.json is missing: run `npm run build` first.'); process.exit(2); }
const { plugins: manifest } = JSON.parse(readFileSync(join(ROOT, 'dist/plugins/manifest.json'), 'utf8'));
// the selection, refused before any browser starts when a name is unknown or it checks nothing (--controls-only --no-control used to exit 0 with 0 checks)
const plan = galleryPlan(process.argv.slice(2), { plugins: [...manifest.map((/** @type {any} */ p) => p.name), 'template'], views: ALL_VIEWS.map((v) => v.name) });
if (plan.error !== null) { console.error(`G-gallery: ${plan.error}`); process.exit(2); }
const VIEWS = ALL_VIEWS.filter((v) => plan.views.includes(v.name));
const withControl = plan.controls;

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
  window.__gcErrors = [];
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('stage')?.addEventListener('effectframe', () => { window.__gc.frames += 1; window.__gc.last = performance.now(); });
    document.getElementById('stage')?.addEventListener('effecterror', (e) => { window.__gcErrors.push(String(e.detail && e.detail.type) + ': ' + String(e.detail && e.detail.error)); });
  });
})();`;

/** `map`: the CRT monitor at full curvature, nothing moving at rest, the input map on */
const MAP_QUERY = '&demo=0&opt.crt.flicker=0&opt.crt.curvature=1&map=1';
/** `under`: water under the CRT monitor at full curvature, nothing moving at rest */
const UNDER_QUERY = '&then=crt&demo=0&opt.crt.flicker=0&opt.crt.curvature=1';

/**
 * A page script for a control: every plugin bundle that registers itself (window.HicLivePlugins.<name> = {meta, plugin}) goes through `body`, which may replace
 * `entry` (the names `name` and `entry` are in scope).
 * @param {string} body
 */
function wrapPlugins(body) {
  return `{
    const had = window.HicLivePlugins || {}, real = {};
    const wrap = (name, entry) => { ${body} return entry; };
    for (const k of Object.keys(had)) real[k] = had[k];
    Object.defineProperty(window, 'HicLivePlugins', { configurable: true, value: new Proxy(real, { defineProperty(t, k, d) { return Reflect.defineProperty(t, k, d && d.value && d.value.plugin ? { ...d, value: wrap(String(k), d.value) } : d); } }) });
  }`;
}

/** the effects bundle with a host that never idles (C4) */
function neverIdleEffects() {
  const text = readFileSync(join(ROOT, 'dist/hic-live-effects.iife.min.js'), 'utf8');
  const anchor = 'hasContinuous(){return ';
  if (text.split(anchor).length !== 2) throw new Error(`C4: the anchor "${anchor}" must occur exactly once in dist/hic-live-effects.iife.min.js (rebuilt? fix the anchor)`);
  return text.replace(anchor, `${anchor}!0||`);
}

/**
 * One gallery run. @param {any} browser @param {any} server @param {string} name @param {any} view
 * @param {{query?: string, css?: string, script?: string, effects?: string, reducedMotion?: boolean, fakeNoReduce?: boolean, steps?: string[], scene?: string, then?: string}} [o]
 *   `then`: the second effect of a `stack` run (picked from the strip by `pick`, or already in `query`)
 */
async function runOne(browser, server, name, view, o = {}) {
  const page = await browser.newPage({ reuseFirst: false });
  const checks = /** @type {{step: string, name: string, ok: boolean, detail?: unknown}[]} */ ([]);
  const check = (/** @type {string} */ step, /** @type {string} */ what, /** @type {unknown} */ ok, /** @type {unknown} */ detail) => { checks.push({ step, name: what, ok: !!ok, detail }); return !!ok; };
  const want = (/** @type {string} */ s) => !o.steps || o.steps.includes(s);
  const numbers = /** @type {Record<string, unknown>} */ ({});
  /** a touch tap on the centre of an element, as it lies in the page (true: the element was there) @param {string} selector */
  const tapOn = async (selector) => {
    const at = await page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'nearest', inline: 'center' });
      const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    if (!at) return false;
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y, id: 1 }] });
    await H.sleep(60);
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return true;
  };
  const settle = () => page.evaluate(`Promise.race([Promise.all([window.__gallery.handle, window.__gallery.handle2].map((h) => (h && h.actions && h.actions.length ? h.settled() : null))), new Promise((r) => setTimeout(() => r('still in motion after 10 s'), 10000))])`);
  const framesIn = async (/** @type {number} */ ms) => { const a = await page.evaluate('window.__gc.frames'); await H.sleep(ms); return (await page.evaluate('window.__gc.frames')) - a; };
  const fits = () => page.evaluate(`(() => { const f = document.getElementById('demo-form'); return { scrollHeight: f.scrollHeight, clientHeight: f.clientHeight, controls: window.__gallery.controls }; })()`);
  const stackState = () => page.evaluate(`(() => { const g = window.__gallery, c = document.getElementById('effect-controls'); return { then: g.then, count: g.host.pluginCount, enabled: [g.handle, g.handle2].map((h) => (h ? h.enabled : null)),
    query: new URL(location.href).searchParams.get('then'), controls: g.controls, tabs: [...c.querySelectorAll('.fx-tabs:not([hidden]) button')].map((b) => b.dataset.fx), shown: [...c.querySelectorAll('.fx-ui')].filter((e) => !e.hidden).map((e) => e.dataset.fx),
    about2: !document.getElementById('about-2').hidden, stacking: g.stacking, chainShown: !document.getElementById('chain').hidden, chain: [...document.querySelectorAll('#chain .fx')].map((e) => e.dataset.fx),
    pressed: [...document.querySelectorAll('#picker button[data-effect][aria-pressed="true"]')].filter((b) => b.dataset.effect !== 'off').sort((x, y) => Number(x.querySelector('.n').textContent) - Number(y.querySelector('.n').textContent)).map((b) => b.dataset.effect) }; })()`);
  /** the stage as presented (compositor pixels) @returns {Promise<{img: any, ratio: number}>} */
  const stageShot = async () => {
    const r = await page.evaluate(`(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`);
    const img = H.decodePng(await page.screenshot({ clip: { ...r, scale: 1 } }));
    return { img, ratio: img.width / r.width };
  };
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

    // the scene the address asked for
    if (want('scene')) {
      const sc = await page.evaluate(`(() => { const f = document.getElementById('demo-form'); return { scene: window.__gallery.scene, attr: f.dataset.scene,
        shown: [...f.querySelectorAll('.scene')].filter((e) => e.offsetHeight > 0).map((e) => e.dataset.scene), pressed: [...f.querySelectorAll('.scenes button[aria-pressed="true"]')].map((b) => b.dataset.scene) }; })()`);
      numbers.scene = sc;
      check('scene', `the gallery shows the ${o.scene} scene and no other`, sc.scene === o.scene && sc.attr === o.scene && sc.shown.join() === o.scene && sc.pressed.join() === o.scene, sc);
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

    // a touch tap on the drawn switch selects another scene, through the effect, and comes back
    if (want('switch')) {
      await page.evaluate('window.scrollTo(0, 0)');
      await H.sleep(150);
      const tap = async (/** @type {string} */ scene) => {
        const at = await page.evaluate(`(() => { const r = document.querySelector('.scenes button[data-scene=${JSON.stringify(scene)}]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
        await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y, id: 1 }] });
        await H.sleep(60);
        await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        return H.until(() => page.evaluate(`window.__gallery.scene === ${JSON.stringify(scene)} ? { scene: window.__gallery.scene, query: new URL(location.href).searchParams.get('scene') } : null`), 2000);
      };
      const there = await tap('form'), back = await tap(/** @type {string} */ (o.scene));
      check('switch', `a tap on the drawn switch selects the form scene and one more comes back to ${o.scene} (the address follows)`,
        !!there && there.query === null && !!back && back.query === o.scene, { there, back, now: await page.evaluate('window.__gallery.scene') });
    }

    // the live scene: content that changes once a second is presented; the form scene is at rest again
    if (want('live')) {
      if ((await page.evaluate('window.__gallery.handle && window.__gallery.handle.actions ? 1 : 0')) === 1) await page.evaluate(`Promise.race([Promise.resolve(window.__gallery.handle.settled()), new Promise((r) => setTimeout(r, 10000))])`);
      await H.sleep(1200);
      const a = await page.evaluate(`({ frames: window.__gc.frames, clock: document.getElementById('live-clock').textContent })`);
      await H.sleep(3200);
      const b = await page.evaluate(`({ frames: window.__gc.frames, clock: document.getElementById('live-clock').textContent })`);
      numbers.live = { framesIn3s: b.frames - a.frames, from: a.clock, to: b.clock };
      check('live', 'the live scene changes about once a second and the effect presents it (the clock moves on; 3 to 120 effect frames in 3.2 s)', b.clock !== a.clock && b.frames - a.frames >= 3 && b.frames - a.frames <= 120, numbers.live);
      await page.evaluate(`document.querySelector('.scenes button[data-scene="form"]').click()`);
      await H.sleep(1500);
      const c = await page.evaluate('window.__gc.frames');
      await H.sleep(2000);
      const atRest = (await page.evaluate('window.__gc.frames')) - c;
      numbers.liveThenForm2s = atRest;
      check('live', 'back on the form scene: 0 effect frames over 2 s (the timer stopped)', atRest === 0, { framesIn2s: atRest });
    }

    // a second effect from the address: both run
    if (want('linked')) {
      await settle();
      const st = await stackState();
      numbers.linked = st;
      check('linked', `the address opens ${name} with ${o.then} after it: two plugins on the host, both enabled, Stack on, the chips numbered and the chain in that order`,
        st.then === o.then && st.count === 2 && st.enabled.every((e) => e === true) && st.stacking === true && st.pressed.join() === `${name},${o.then}` && st.chain.join() === `${name},${o.then}` && st.about2 && st.tabs.join() === `${name},${o.then}`, st);
      const one = await fits();
      await page.evaluate(`document.querySelector('.fx-tabs button[data-fx=${JSON.stringify(o.then)}]').click()`);
      await H.sleep(300);
      const two = await fits();
      check('linked', 'the form fits the stage with either effect\'s controls shown', one.controls === name && two.controls === o.then && one.scrollHeight <= one.clientHeight + 1 && two.scrollHeight <= two.clientHeight + 1, { one, two });
    }

    // Stack on, then a touch tap on a chip adds that effect after the first
    if (want('pick')) {
      await page.evaluate('window.scrollTo(0, 0)');
      await settle();
      await H.sleep(400);
      const toggled = await tapOn('#stack-toggle');
      const on = await H.until(() => page.evaluate(`window.__gallery.stacking && !document.getElementById('chain').hidden ? 1 : null`), 2000);
      const tapped = await tapOn(`#picker button[data-effect=${JSON.stringify(o.then)}]`);
      const there = await H.until(() => page.evaluate(`window.__gallery.then === ${JSON.stringify(o.then)} && window.__gallery.handle2 ? 1 : null`), 6000);
      await settle();
      await H.sleep(400);
      const st = await stackState();
      numbers.pick = st;
      check('pick', `a tap on Stack, then on "${o.then}", runs it after ${name}: two plugins, both enabled, the chips numbered 1 and 2, the chain and the address follow, the form shows its controls and a switch`,
        toggled && !!on && tapped && !!there && st.count === 2 && st.enabled.every((e) => e === true) && st.query === o.then && st.pressed.join() === `${name},${o.then}` && st.chain.join() === `${name},${o.then}` && st.about2 && st.tabs.join() === `${name},${o.then}` && st.shown.join() === o.then, st);
      // a third effect joins the chain; a fourth is refused while three run; the x of the third takes it out
      const [third, fourth] = manifest.map((/** @type {any} */ p) => p.name).filter((n) => n !== name && n !== o.then);
      await tapOn(`#picker button[data-effect=${JSON.stringify(third)}]`);
      const three = await H.until(() => page.evaluate(`window.__gallery.host.pluginCount === 3 && window.__gallery.chain.length === 3 ? 1 : null`), 6000);
      await tapOn(`#picker button[data-effect=${JSON.stringify(fourth)}]`);
      await H.sleep(800);
      const full = await stackState();
      await tapOn(`#chain .fx[data-fx=${JSON.stringify(third)}] button`);
      const back = await H.until(() => page.evaluate(`window.__gallery.host.pluginCount === 2 ? 1 : null`), 3000);
      const after = await stackState();
      numbers.chain = { full, after };
      check('pick', `a third effect (${third}) joins the chain; a fourth (${fourth}) is refused while three run; the x of the third in the chain takes it out`,
        !!three && full.count === 3 && full.chain.join() === `${name},${o.then},${third}` && full.pressed.join() === `${name},${o.then},${third}` && !!back && after.chain.join() === `${name},${o.then}` && after.query === o.then, numbers.chain);
    }

    // the switch between the two effects' controls, drawn in the canvas: a tap through both effects
    if (want('tabs')) {
      await page.evaluate('window.scrollTo(0, 0)');
      await settle();
      await H.sleep(300);
      const to = async (/** @type {string} */ fx) => { await tapOn(`.fx-tabs button[data-fx=${JSON.stringify(fx)}]`); return H.until(() => page.evaluate(`window.__gallery.controls === ${JSON.stringify(fx)} ? 1 : null`), 2000); };
      const first = await to(name), a = await stackState(), fitA = await fits();
      const second = await to(/** @type {string} */ (o.then)), b = await stackState(), fitB = await fits();
      check('tabs', `a tap on the drawn switch shows the controls of ${name}, and one more those of ${o.then}`, !!first && a.shown.join() === name && !!second && b.shown.join() === o.then, { a: a.shown, b: b.shown, controls: b.controls });
      check('tabs', 'the form fits the stage with either effect\'s controls shown', fitA.scrollHeight <= fitA.clientHeight + 1 && fitB.scrollHeight <= fitB.clientHeight + 1, { fitA, fitB });
    }

    // both effects at rest
    if (want('rest2')) {
      numbers.settled2 = await settle();
      await H.sleep(1000);
      const atRest = await framesIn(2000);
      numbers.framesAtRest2s = atRest;
      check('rest', 'with two effects, once both settled: 0 effect frames over 2 s (zero work at rest)', atRest === 0, { framesIn2s: atRest, settled: numbers.settled2 });
    }

    // the x in the chain takes the second effect away; Stack off leaves one effect, a tap on a chip picks it alone again
    if (want('pick')) {
      await page.evaluate('window.scrollTo(0, 0)');
      const tapped = await tapOn(`#chain .fx[data-fx=${JSON.stringify(o.then)}] button`);
      const gone = await H.until(() => page.evaluate(`window.__gallery.then === 'off' && window.__gallery.host.pluginCount === 1 ? 1 : null`), 3000);
      const st = await stackState();
      check('pick', `the x of "${o.then}" in the chain takes it away: one plugin, no switch, the address follows`, tapped && !!gone && st.query === null && !st.about2 && st.tabs.length === 0 && st.shown.join() === name && st.enabled[0] === true, st);
      await tapOn('#stack-toggle');
      await tapOn(`#picker button[data-effect=${JSON.stringify(o.then)}]`);
      const alone = await H.until(() => page.evaluate(`!window.__gallery.stacking && window.__gallery.chain.join() === ${JSON.stringify(o.then)} && window.__gallery.host.pluginCount === 1 ? 1 : null`), 6000);
      const off = await stackState();
      check('pick', `with Stack off a tap on a chip picks that effect alone, and the chain is not shown`, !!alone && !off.chainShown && off.pressed.join() === o.then, off);
    }

    // the first effect reads the pointer through the second: a tap drops a pebble where the finger is seen
    if (want('under')) {
      await page.evaluate('window.scrollTo(0, 0)');
      await settle();
      await H.sleep(1200);
      const quiet = await framesIn(600);
      const before = await stageShot();
      // over the empty part of the hero, left of the middle and away from the centre of the screen (the curved picture is moved most there)
      const at = await page.evaluate(`(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { x: Math.round(r.left + r.width * 0.13), y: Math.round(r.top + r.height * 0.64), left: r.left, top: r.top }; })()`);
      await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y, id: 1 }] });
      await H.sleep(40);
      await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await H.sleep(120);
      const after = await stageShot();
      const diff = H.compareImages(before.img, after.img, { tolerance: 10, diffImage: false });
      const box = diff.overBBox;
      const centre = box && { x: (box.x + box.w / 2) / after.ratio, y: (box.y + box.h / 2) / after.ratio };
      const off = centre && Math.hypot(centre.x - (at.x - at.left), centre.y - (at.y - at.top));
      numbers.under = { tap: { x: at.x - at.left, y: at.y - at.top }, centre, offPx: off && Math.round(off * 10) / 10, changedPx: diff.countOver16, box, framesBefore600ms: quiet };
      check('under', `still before the tap (0 frames in 0.6 s), and the tap changes the picture (a drop of ${name} under ${o.then})`, quiet === 0 && !!box && diff.countOver16 > 200 && box.w / after.ratio < 400 && box.h / after.ratio < 400, numbers.under);
      check('under', `the drop is centred where the finger is seen, within ${UNDER_PX} css px (the first effect reads the pointer through the second)`, off !== null && off <= UNDER_PX, numbers.under);
    }

    // every ordered pair of plugins
    if (want('pairs')) {
      const names = manifest.map((/** @type {any} */ p) => p.name);
      const bad = [];
      let pairs = 0;
      for (const a of names) {
        await page.evaluate(`window.__gallery.setChain([${JSON.stringify(a)}])`);
        await page.waitForFunction(`window.__gallery.active === ${JSON.stringify(a)} && !!window.__gallery.handle && window.__gallery.then === 'off'`, { timeout: 10000 });
        for (const b of names) {
          if (a === b) continue;
          pairs += 1;
          await page.evaluate(`window.__gcErrors.length = 0; window.__pairFrames = window.__gc.frames; window.__gallery.setChain([${JSON.stringify(a)}, ${JSON.stringify(b)}])`);
          const ok = await page.waitForFunction(`window.__gallery.then === ${JSON.stringify(b)} && !!window.__gallery.handle2 && window.__gc.frames > window.__pairFrames + 1`, { timeout: 10000 }).then(() => true, () => false);
          await H.sleep(250);
          const st = await page.evaluate(`(() => { const g = window.__gallery; return { then: g.then, count: g.host.pluginCount, enabled: [g.handle, g.handle2].map((h) => (h ? h.enabled : null)), frames: window.__gc.frames - window.__pairFrames, errors: window.__gcErrors.splice(0) }; })()`);
          if (!ok || st.count !== 2 || !st.enabled.every((e) => e === true) || st.errors.length) bad.push({ pair: `${a} then ${b}`, ...st });
        }
      }
      numbers.pairs = { pairs, bad };
      check('pairs', `every ordered pair of plugins runs stacked (${pairs} pairs): two plugins, both enabled, frames presented, no effecterror`, pairs === names.length * (names.length - 1) && bad.length === 0, bad.slice(0, 4));
    }

    // the input map: what the host does with the pointer, drawn over the stage
    if (want('map')) {
      await page.evaluate('window.scrollTo(0, 0)');
      await settle();
      await H.sleep(500);
      const before = await page.evaluate(`({ pressed: document.getElementById('map-toggle').getAttribute('aria-pressed'), hidden: document.getElementById('map').hidden, map: window.__gallery.map })`);
      check('map', 'with &map=1 the toggle is pressed and nothing is drawn before a pointer arrives', before.pressed === 'true' && before.hidden === true && before.map === null, before);
      // a point of the canvas where the effect shows the email field: the one whose place in the source is nearest to the field's centre
      const at = await page.evaluate(`(() => { const c = document.getElementById('stage'), r = c.getBoundingClientRect(), ox = r.left + c.clientLeft, oy = r.top + c.clientTop; const e = document.getElementById('email').getBoundingClientRect();
        const want = { x: e.left + e.width / 2 - ox, y: e.top + e.height / 2 - oy }; let best = null;
        for (let y = 4; y < c.clientHeight; y += 4) for (let x = 4; x < c.clientWidth; x += 4) { const q = window.__gallery.host.mapPoint({ x, y }); if (!q) continue; const d = Math.hypot(q.x - want.x, q.y - want.y); if (!best || d < best.d) best = { x, y, d }; }
        return best && { ...best, clientX: Math.round(ox + best.x), clientY: Math.round(oy + best.y), ox, oy, email: { x: e.left - ox, y: e.top - oy, width: e.width, height: e.height } }; })()`);
      if (at) {
        await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.clientX, y: at.clientY, id: 1 }] });
        await H.sleep(60);
        await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      }
      await H.until(() => page.evaluate(`window.__gallery.map && document.activeElement && document.activeElement.id === 'email' ? 1 : null`), 2500);
      const got = await page.evaluate(`(() => { const m = document.getElementById('map'), c = document.getElementById('stage'), r = c.getBoundingClientRect(), ox = r.left + c.clientLeft, oy = r.top + c.clientTop;
        const rel = (e) => { const b = e.getBoundingClientRect(); return { x: b.left - ox, y: b.top - oy, width: b.width, height: b.height }; };
        return { state: window.__gallery.map, active: document.activeElement && document.activeElement.id, hidden: m.hidden, box: rel(m.querySelector('.box')), dot: rel(m.querySelector('.dot')), label: m.querySelector('.tag').textContent }; })()`);
      const near = (/** @type {number} */ a, /** @type {number} */ b, tol = 1.5) => Math.abs(a - b) <= tol;
      const e = at ? at.email : { x: NaN, y: NaN, width: NaN, height: NaN };
      numbers.map = { at, ...got };
      check('map', 'a tap where the effect shows the email field: the map names that field with its value, frames its real box, marks the tap, and the field has the focus',
        !!at && at.d < 6 && got.active === 'email' && !!got.state && got.state.element === 'email' && !got.hidden && /^input#email "ada@example\.com"/.test(got.label)
        && near(got.box.x, e.x) && near(got.box.y, e.y) && near(got.box.width, e.width) && near(got.box.height, e.height) && near(got.dot.x + got.dot.width / 2, at.x, 2) && near(got.dot.y + got.dot.height / 2, at.y, 2), numbers.map);
      check('map', `the effect moved that field: the pointer and the place it is sent to are more than ${MAP_PX} css px apart`, !!got.state && got.state.moved > MAP_PX, { moved: got.state && got.state.moved, pointer: got.state && got.state.pointer, source: got.state && got.state.source });
      const tapped = await tapOn('#map-toggle');
      const off = await H.until(() => page.evaluate(`document.getElementById('map').hidden && window.__gallery.map === null && new URL(location.href).searchParams.get('map') === null ? 1 : null`), 2000);
      check('map', 'a tap on the toggle takes the map away (the address follows)', tapped && !!off, await page.evaluate(`({ hidden: document.getElementById('map').hidden, pressed: document.getElementById('map-toggle').getAttribute('aria-pressed'), query: location.search })`));
    }

    // the page under the page (Page curl over createHost `under`)
    if (want('beneath')) {
      await page.evaluate('window.scrollTo(0, 0)');
      await settle();
      const shown = await H.until(() => page.evaluate('window.__gallery.under === true && window.__gallery.host.stats().underUploads > 0 ? 1 : null'), 5000);
      check('beneath', 'Page curl gets the page under the page: shown, and uploaded by the host', !!shown, await page.evaluate('({ under: window.__gallery.under, underHost: window.__gallery.underHost, stats: window.__gallery.host.stats() })'));
      const inertAtRest = await page.evaluate("document.getElementById('under-page').inert");
      check('beneath', 'at rest (the dog-ear) the under page is inert: out of the tab order and the accessibility tree', inertAtRest === true, inertAtRest);
      // a point of the canvas where the effect shows the under page's field, as the mappers say (its place there is the same point)
      const FIND = `(() => { const g = window.__gallery, c = document.getElementById('stage'), r = c.getBoundingClientRect(), ox = r.left + c.clientLeft, oy = r.top + c.clientTop;
        const f = document.getElementById('under-note').getBoundingClientRect(), fx = f.left - ox, fy = f.top - oy;
        for (let y = fy + 6; y < fy + f.height - 6; y += 4) for (let x = fx + 12; x < fx + f.width - 12; x += 6) { const q = g.host.mapPoint({ x, y }); if (q && q.under === true && Math.abs(q.x - x) < 0.5) return { x: Math.round(ox + x), y: Math.round(oy + y) }; }
        return null; })()`;
      const tapAt = async (/** @type {{x: number, y: number}} */ p) => {
        await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, id: 1 }] });
        await H.sleep(60);
        await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      };
      const fieldState = () => page.evaluate(`(() => { const a = document.activeElement, n = document.getElementById('under-note');
        return { active: a && (a.id || a.name || a.localName), inForm: !!a && document.getElementById('demo-form').contains(a), value: n.value, inert: document.getElementById('under-page').inert }; })()`);
      page.evaluate('window.__gallery.handle.trigger("demo")').catch(() => {});
      let at = null;
      for (let i = 0; i < 160 && !at; i += 1) { at = await page.evaluate(FIND); if (!at) await H.sleep(20); }
      if (at) {
        await tapAt(at);
        await H.until(() => page.evaluate("document.activeElement && document.activeElement.id === 'under-note' ? 1 : null"), 2000);
        await page.send('Input.insertText', { text: 'beneath' });
        await H.sleep(300);
      }
      const open = await fieldState();
      const settled = await page.evaluate(`Promise.race([window.__gallery.handle.settled(), new Promise((r) => setTimeout(() => r('still moving'), 4000))])`);
      numbers.beneath = { at, open, settled };
      check('beneath', 'while the demo turns the sheet, a tap where it uncovers the under page\'s field focuses that field, typing shows up in it, and the sheet stays open',
        !!at && open.active === 'under-note' && open.value === 'beneath' && open.inert === false && settled === 'open', numbers.beneath);
      const tappedName = await tapOn('#name');
      const back = await H.until(() => page.evaluate("document.getElementById('under-page').inert && document.activeElement && document.activeElement.id === 'name' ? 1 : null"), 4000);
      check('beneath', 'a tap on a field of the top page: the sheet falls back, that field takes the focus and the under page turns inert', tappedName && !!back, await fieldState());
      await settle();
      await page.evaluate('document.activeElement && document.activeElement.blur()');
      await H.sleep(300);
      if (at) await tapAt(at);
      await H.sleep(400);
      const rest = await fieldState();
      check('beneath', 'control: the same tap with the curl at rest lands on the top page (nothing focused before it, a field of the form takes the focus; the under field keeps its value)',
        !!at && rest.inForm && rest.active !== 'under-note' && rest.value === 'beneath', { at, ...rest });
    }

    // extended range, asked for in the address
    if (want('hdr')) {
      const h = await page.evaluate(`({ state: window.__gallery.hdr, stats: window.__gallery.host.stats().hdr, text: document.getElementById('m-range').textContent, frames: window.__gc.frames })`);
      numbers.hdr = h;
      check('hdr', 'with &hdr=1 the host uses extended range (a float canvas with the extended tone mapping), frames are presented and the page says so', h.state === true && h.stats === true && /^extended/.test(h.text) && h.frames > 0, h);
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

const results = { script: 'scripts/check-gallery.mjs', startedAt: new Date().toISOString(), headless: true, scope: plan.scope, skipped: plan.skipped,
  selection: { plugins: plan.plugins, views: plan.views, off: plan.off, scenes: plan.scenes, stack: plan.stack, controls: plan.controls }, views: VIEWS, runs: /** @type {any[]} */ ([]), controls: /** @type {any[]} */ ([]), pass: false, green: false };
const server = await startServer();
let failed = 0;
/** a new headless Chrome per group of runs: one browser at a time, and a crash costs one group, not the run */
async function withBrowser(/** @type {(b: any) => Promise<void>} */ fn) {
  const browser = await H.launchChrome({ name: 'gallery-check', windowSize: [1300, 950], dpr: 1, extraArgs: ['--headless=new', '--hide-scrollbars'] });
  browser.conn.sendTimeoutMs = 30000;
  try { await fn(browser); } finally { await browser.close().catch(() => browser.kill()); }
}
try {
  for (const name of plan.plugins) {
    await withBrowser(async (browser) => {
      for (const view of VIEWS) {
        const r = await runOne(browser, server, name, view, { steps: stepsFor(view, ['demo', 'rest', 'fold', 'fit', 'scroll']) });
        results.runs.push({ plugin: name, view: view.name, ...r });
        for (const c of r.checks) { console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${name.padEnd(13)} ${view.name.padEnd(6)} [${c.step}] ${c.name}${c.ok ? '' : '  ' + JSON.stringify(c.detail)}`); if (!c.ok) failed += 1; }
      }
      // (page-curl, iPad) the page under the page
      if (name === 'page-curl' && VIEWS.some((v) => v.name === 'ipad')) {
        const r = await runOne(browser, server, name, VIEWS.find((v) => v.name === 'ipad'), { query: '&demo=0', steps: ['beneath'] });
        results.runs.push({ plugin: 'page-curl, the page under the page', view: 'ipad', ...r });
        for (const c of r.checks) { console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${name.padEnd(13)} ipad   [${c.step}] ${c.name}${c.ok ? '' : '  ' + JSON.stringify(c.detail)}`); if (!c.ok) failed += 1; }
      }
      if (VIEWS.some((v) => v.name === 'phone')) {
        const r = await runOne(browser, server, name, VIEWS.find((v) => v.name === 'phone'), { reducedMotion: true, steps: ['demo'] });
        results.runs.push({ plugin: name, view: 'phone, reduced motion', ...r });
        for (const c of r.checks) { console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${name.padEnd(13)} reduce [${c.step}] ${c.name}${c.ok ? '' : '  ' + JSON.stringify(c.detail)}`); if (!c.ok) failed += 1; }
      }
    });
  }
  if (plan.off) {
    await withBrowser(async (browser) => {
      const view = VIEWS.find((v) => v.name === 'ipad') ?? VIEWS[0];
      const r = await runOne(browser, server, 'off', view, { steps: view.name === 'short' ? ['cap', 'fit'] : ['cap', 'fold', 'fit'] });
      results.runs.push({ plugin: 'off', view: view.name, ...r });
      for (const c of r.checks) { console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${'off'.padEnd(13)} ${view.name.padEnd(6)} [${c.step}] ${c.name}${c.ok ? '' : '  ' + JSON.stringify(c.detail)}`); if (!c.ok) failed += 1; }
    });
  }

  if (plan.scenes) {
    await withBrowser(async (browser) => {
      for (const scene of ['daylight', 'live']) {
        for (const view of VIEWS) {
          // (the short phone with the plugin whose controls are the tallest)
          const plugin = view.name === 'short' ? 'page-curl' : 'water';
          const r = await runOne(browser, server, plugin, view, { query: `&scene=${scene}`, scene, steps: stepsFor(view, ['scene', 'fold', 'fit', 'switch', ...(scene === 'live' ? ['live'] : [])]) });
          results.runs.push({ plugin: `${plugin}, ${scene} scene`, view: view.name, ...r });
          for (const c of r.checks) { console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${scene.padEnd(13)} ${view.name.padEnd(6)} [${c.step}] ${c.name}${c.ok ? '' : '  ' + JSON.stringify(c.detail)}`); if (!c.ok) failed += 1; }
        }
      }
    });
  }

  if (plan.stack) {
    const log = (/** @type {string} */ what, /** @type {string} */ view, /** @type {any} */ r) => { for (const c of r.checks) { console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${what.padEnd(13)} ${view.padEnd(6)} [${c.step}] ${c.name}${c.ok ? '' : '  ' + JSON.stringify(c.detail)}`); if (!c.ok) failed += 1; } };
    await withBrowser(async (browser) => {
      for (const view of VIEWS.filter((v) => v.name !== 'short')) {
        const r = await runOne(browser, server, 'water', view, { query: '&demo=0', then: 'shatter', steps: ['pick', 'tabs', 'rest2'] });
        results.runs.push({ plugin: 'water, shatter picked on top', view: view.name, ...r });
        log('stack', view.name, r);
      }
      const ipad = VIEWS.find((v) => v.name === 'ipad');
      for (const view of VIEWS.filter((v) => v.name !== 'ipad')) {
        const r = await runOne(browser, server, 'crt', view, { query: '&then=water&demo=0&opt.crt.flicker=0', then: 'water', steps: view.name === 'short' ? ['linked'] : ['linked', 'fold', 'rest2'] });
        results.runs.push({ plugin: 'crt, water on top (address)', view: view.name, ...r });
        log('stack', view.name, r);
      }
      if (ipad) {
        // (at a device pixel ratio of 1: headless Chrome 157 ends when the WebGPU canvas is captured at 2 under these metrics, measured twice)
        const under = await runOne(browser, server, 'water', { ...ipad, dpr: 1 }, { query: UNDER_QUERY, then: 'crt', steps: ['under'] });
        results.runs.push({ plugin: 'water under crt', view: 'ipad', ...under });
        log('stack', 'ipad', under);
        const pairs = await runOne(browser, server, 'water', ipad, { query: '&demo=0', steps: ['pairs'] });
        results.runs.push({ plugin: 'every pair', view: 'ipad', ...pairs });
        log('stack', 'ipad', pairs);
        const hdr = await runOne(browser, server, 'water', ipad, { query: '&hdr=1', steps: ['hdr', 'demo', 'rest'] });
        results.runs.push({ plugin: 'water, extended range', view: 'ipad', ...hdr });
        log('stack', 'ipad', hdr);
        const map = await runOne(browser, server, 'crt', ipad, { query: MAP_QUERY, steps: ['map'] });
        results.runs.push({ plugin: 'crt, the input map', view: 'ipad', ...map });
        log('stack', 'ipad', map);
      }
    });
  }

  if (withControl) {
    const phone = { name: 'phone', width: 390, height: 844, dpr: 3 }, ipad = { name: 'ipad', width: 1194, height: 748, dpr: 2 }, short = { name: 'short', width: 375, height: 667, dpr: 2 };
    const CONTROLS = [
      { id: 'C1', step: 'fold', name: 'template', view: ipad, o: { css: '#top::after { content: ""; display: block; height: 700px; }', steps: ['fold'] } },
      { id: 'C2', step: 'fit', name: 'template', view: phone, o: { css: '#demo-form .card { padding-bottom: 600px !important; }', steps: ['fit'] } },
      { id: 'C3', step: 'rest', name: 'template', view: ipad, o: { script: "addEventListener('load', () => setInterval(() => { const f = document.getElementById('form-feedback'); if (f) f.textContent = 'tick ' + Date.now(); }, 100));", steps: ['demo', 'rest'] } },
      { id: 'C4', step: 'rest', name: 'template', view: ipad, o: { effects: neverIdleEffects(), steps: ['demo', 'rest'] } },
      { id: 'C5', step: 'demo', name: 'template', view: ipad, o: { query: '&demo=0', steps: ['demo'] } },
      { id: 'C6', step: 'scroll', name: 'template', view: phone, o: { script: "document.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false, capture: true });", steps: ['scroll'] } },
      { id: 'C7', step: 'demo', name: 'template', view: phone, o: { reducedMotion: true, fakeNoReduce: true, steps: ['demo'] } },
      { id: 'C8', step: 'cap', name: 'off', view: ipad, o: { script: "addEventListener('load', () => setTimeout(() => { const r = document.getElementById('fps-cap'); r.value = '60'; r.dispatchEvent(new Event('input')); }, 300));", steps: ['cap'] } },
      { id: 'C9', step: 'fit', name: 'water', view: phone, o: { query: '&scene=daylight', scene: 'daylight', css: '#demo-form .photo { height: 900px !important; }', steps: ['fit'] } },
      { id: 'C10', step: 'switch', name: 'water', view: ipad, o: { query: '&scene=daylight', scene: 'daylight', css: '#demo-form .scenes { pointer-events: none !important; }', steps: ['switch'] } },
      { id: 'C11', step: 'live', name: 'water', view: ipad, o: { query: '&scene=live', scene: 'live', script: "{ const si = window.setInterval; window.setInterval = function (f, ms, ...a) { return f && f.name === 'liveTick' ? 0 : si.call(this, f, ms, ...a); }; }", steps: ['live'] } },
      { id: 'C12', step: 'fit', name: 'page-curl', view: short, o: { query: '&scene=daylight', scene: 'daylight', css: ':root { --fit: 580px !important; } #demo-form .scene[data-scene="daylight"] { display: block !important; } #demo-form .photo { height: 64px !important; margin-top: 8px !important; }', steps: ['fit'] } },
      { id: 'C13', step: 'pick', name: 'water', view: ipad, o: { query: '&demo=0', then: 'shatter', css: '#picker { pointer-events: none !important; }', steps: ['pick'] } },
      { id: 'C14', step: 'tabs', name: 'water', view: ipad, o: { query: '&then=shatter&demo=0', then: 'shatter', css: '#demo-form .fx-tabs { pointer-events: none !important; }', steps: ['tabs'] } },
      { id: 'C15', step: 'under', name: 'water', view: { ...ipad, dpr: 1 }, o: { query: UNDER_QUERY, then: 'crt', script: wrapPlugins("if (name === 'water') { const create = entry.plugin.create; entry = { ...entry, plugin: { ...entry.plugin, create: (ctx, o) => create({ ...ctx, localPoint: (p) => ({ x: p.x, y: p.y }) }, o) } }; }"), steps: ['under'] } },
      { id: 'C16', step: 'pairs', name: 'water', view: ipad, o: { query: '&demo=0', script: wrapPlugins("if (name === 'glitch') { const create = entry.plugin.create; entry = { ...entry, plugin: { ...entry.plugin, create: async (ctx, o) => { const inst = await create(ctx, o); const render = inst.render; inst.render = function (frame) { if (frame.sourceTexture.label !== 'hic-source') throw new Error('control: not the first plugin'); return render.call(this, frame); }; return inst; } } }; }"), steps: ['pairs'] } },
      { id: 'C17', step: 'map', name: 'crt', view: ipad, o: { query: MAP_QUERY, script: wrapPlugins("if (name === 'crt') { const create = entry.plugin.create; entry = { ...entry, plugin: { ...entry.plugin, create: async (ctx, o) => { const inst = await create(ctx, o); inst.captureInputMapper = () => (p) => ({ x: p.x, y: p.y }); return inst; } } }; }"), steps: ['map'] } },
      { id: 'C18', step: 'hdr', name: 'water', view: ipad, o: { query: '&hdr=0', steps: ['hdr'] } },
      { id: 'C19', step: 'beneath', name: 'page-curl', view: ipad, o: { query: '&demo=0&opt.page-curl.underPage=false', steps: ['beneath'] } },
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
const verdict = galleryVerdict({ failed, checks: results.runs.reduce((n, r) => n + r.checks.length, 0), controls: results.controls.length, scope: plan.scope, skipped: plan.skipped });
results.pass = verdict.pass; results.green = verdict.green;
const outDir = resolve(ROOT, '.scratch/results'); mkdirSync(outDir, { recursive: true });
const file = join(outDir, `gallery-${stamp}.json`);
writeFileSync(file, JSON.stringify(results, null, 1));
console.log(`\nresults: ${file}`);
console.log(verdict.line);
process.exit(verdict.pass ? 0 : 1);
