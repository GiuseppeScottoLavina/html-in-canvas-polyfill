// G-bundle (docs/TEST-PLAN.md): the built bundles are what they claim to be.
//   node scripts/check-bundle.mjs [--no-build] [--allow-size] [--skip-browser]
//   1. size: core min <= 150 KB (the target), and never above the recorded RATCHET (a regression fails even with --allow-size); every other bundle below its own ceiling;
//      the five classic bundles also below their gzip budget (level 9). The ceilings and budgets are the measured sizes plus a small margin.
//   2. static: each IIFE parses as a CLASSIC script (a static import/export or import.meta is a SyntaxError there) and has no dynamic import()
//   3. in headless Chrome, for the readable AND the minified files: core alone, core + effects, core + effects + each plugin of dist/plugins/, native bridge + core:
//      the globals exist and work, the page made NO request beyond its own scripts (server log + Resource Timing), and the minified FEATURES agree with src/contracts/features.js
// --allow-size: the 150 KB target is a KNOWN RED (printed, does not fail); the ratchet still fails. Used by `npm test` and CI until the target is met (docs/BUNDLES.md).
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Script } from 'node:vm';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverPlugins } from '../plugins/_shared/contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowSize = process.argv.includes('--allow-size');
const KB = 1000; // decimal, as in the 150 KB target
/**
 * target = the gate threshold; ceiling = the recorded minified size the bundle may not exceed (regression guard); gzip = the recorded gzip (level 9) size it may not exceed.
 * Raise a ceiling only with a measured reason, lower it when the bundle shrinks. Since 2026-10-15 every ceiling is the measured size plus a small margin (the size budget).
 */
const LIMITS = {
  // raised deliberately, one measured reason at a time; 254 -> 257 KB (+2,893 bytes, 2026-10-14): the core-only native probe that never refuses a usable native, and getElementImageDefaultSize
  // 257 -> 257.5 KB (+493 bytes, 2026-10-14): a selection of the static text inside the canvas repaints when it changes (bug report)
  // 257.5 -> 257.6 KB (+78 bytes, 2026-10-14): a whole tile overtaken by a DOM mutation is committed, so a counter in proportional digits is not starved (bug report)
  // 257.6 -> 256.5 KB (-1,181 bytes, 2026-10-14): dead bus topics, test-only methods and plugin ABI 1 removed
  // 256.5 -> 259.8 KB (+3,428 bytes, 2026-10-15): paint in the frame / task where a tile lands (first paint in the first frame, WPT paint-timing files), frame ordering across same-origin
  //   iframes, styled scrollbar images, z-index-only style changes left undamaged
  // 259.8 -> 260.8 KB (+925 bytes, 2026-10-15): sticky / fixed drawables re-measured while the page scrolls (hit testing after a page scroll)
  // 260.8 -> 261 KB (+94 bytes, 2026-10-15): an explicit draw size within 1 px and 1 % of the raster is drawn 1:1 (fractional DPR, G-pixel-dpr)
  // 261 -> 260.5 KB, gzip budget 90.6 KB (2026-10-15, measured 259,952 / 90,358): the Gecko / WebKit control rules moved to the engines bundle, cheaper startup presentation sync
  // 260.5 -> 264.75 KB, gzip 90.6 -> 92.1 KB (+4,277 / +1,471 bytes, 2026-10-15, measured 264,229 / 91,829): large drawables, a changed element's damage bounded by the children
  //   of its unchanged parent that moved, the trailing children below a pruned tile left out of the clone (a 60 Hz counter beside 2,000 cells: 27 -> 59 paints/s)
  // 264.75 -> 265.5 KB, gzip 92.1 -> 92.35 KB (+1,052 / +446 bytes, 2026-10-16, measured 265,281 / 92,275): a classic scrollbar gutter at its exact width (a whole number of
  //   device pixels, measured on a probe; F4 at DPR 1.25 / 1.5 against native 2.0 / 1.2 % -> 0.005 %)
  // 265.5 -> 267.5 KB, gzip 92.35 -> 93.25 KB (+1,859 / +735 bytes, 2026-10-16, measured 267,140 / 93,010): phones and tablets (mobile browser gate: iOS / iPadOS / Android
  //   classification, web views refused; phone surface budgets; the snapshot raster scale in the report)
  // 267.5 -> 269 KB, gzip 93.25 -> 93.75 KB (+1,684 / +555 bytes, 2026-10-16, measured 268,824 / 93,565): fixes found on real Chromium 158 for Android (a listbox shows
  //   its selected option after the move into the layer, checkbox / radio zoom back to the device scale, the indeterminate look at the live size and its dark dash, the
  //   Android listbox thumb)
  // 269 -> 269.25 KB (+421 bytes, 2026-10-16, measured 269,245 / 93,735): paint timing that machine load cannot reorder (a deferred decode start in a user-blocking
  //   task, the first build of every drawable in one round charged its fixed estimate, builds paced in frame time by a credit of builds) and changedElements without a
  //   drawable removed during a held paint (WPT onpaint flakes)
  'hic-live-polyfill.iife.min.js': { target: 150 * KB, ceiling: 269.25 * KB, gzip: 93.75 * KB },
  // 27 -> 27.5 KB (+432 bytes, 2026-10-14): NO_TARGET of the effects ABI (mapper chain and interposer); 27.5 -> 27.25 KB (-347 bytes): plugin ABI 1 removed (measured 27,037 / 10,540)
  // 27.25 -> 30.25 KB, gzip 10.75 -> 11.5 KB (+3,054 / +985 bytes, 2026-10-16, measured 30,091 / 11,525): plugin actions (the declared `actions` of ABI v2, handle.trigger and
  //   handle.settled with their validation messages, superseding, and the pending promises across removal, disable, failure and device loss)
  'hic-live-effects.iife.min.js': { target: 30.25 * KB, ceiling: 30.25 * KB, gzip: 11.5 * KB },
  // 11 -> 11.5 KB (2026-10-14): getElementImageDefaultSize over the earlier ElementImage.width/height (measured 11,132 / 4,295)
  // 11.5 -> 14 KB, gzip 4.5 -> 5.5 KB (+2,581 / +957 bytes, 2026-10-16, measured 13,857 / 5,307): Safari Technology Preview's HTML-in-Canvas internal feature, measured
  //   live (paint requests for a build that fires paint only from requestPaint(), the standard size of a sizeless draw, no transform rule on a build without geometry methods)
  'hic-live-native-bridge.iife.min.js': { target: 14 * KB, ceiling: 14 * KB, gzip: 5.5 * KB },
  // the Gecko / WebKit painters, outside the core; 40 -> 38.5 KB (2026-10-15, measured 38,295 / 14,794, with the control rules that left the core)
  // 38.5 -> 42 KB, gzip 15 -> 16.25 KB (+3,509 / +1,244 bytes, 2026-10-16, measured 41,804 / 16,038): the iOS control look (system tint, pill buttons and pop-ups from the computed
  //   style, the colour-well hue ring, medium-style date pills, no spin button, popup labels pinned) and the iOS classification of the engine
  // 42 -> 42.25 KB (+411 bytes, 2026-10-16, measured 42,215): the search field's magnifier is probed from layout (Safari Technology Preview 254 has none) instead of
  //   assumed from Safari >= 27
  'hic-live-engines.iife.min.js': { target: 42.25 * KB, ceiling: 42.25 * KB, gzip: 16.25 * KB },
  // WebGL / WebGPU element textures, outside the core; 16 -> 10.75 KB (2026-10-15, measured 10,469 / 4,015)
  'hic-live-gpu.iife.min.js': { target: 10.75 * KB, ceiling: 10.75 * KB, gzip: 4.25 * KB },
};
/** A new plugin bundle (dist/plugins/<name>.iife.min.js) has this ceiling until PLUGIN_LIMITS records its own: plugins are small add-ons. */
const PLUGIN_CEILING = 16 * KB;
/**
 * Per plugin: the measured minified size (2026-10-14; 2026-10-16 for the plugins with actions) plus a small margin, so that growth is a decision, not an accident. disintegrate and
 * shatter are above the 16 KB default: most of each is its WGSL, inlined by the build (shatter also builds its crack pattern on the CPU).
 */
const PLUGIN_LIMITS = {
  crt: 14 * KB, // 13,669; 10.5 -> 14 KB: the arcade look (glow rings, aperture grille, glass), the presets and their picker
  disintegrate: 26.5 * KB, // 25,807; 41.5 -> 26.5 KB: content-only dust (background estimate by mean shift, eroding sweep, instanced grains with live colours; the WGSL is inlined)
  glitch: 13.75 * KB, // 13,510; 13.5 -> 13.75 KB: the action 'burst' (handle.trigger) in place of the `trigger` option
  'holo-card': 12.75 * KB, // 12,358
  'liquid-glass': 12.25 * KB, // 11,810
  'page-curl': 33.5 * KB, // 32,375; 15.5 -> 33.5 KB: 3D sheet (fold model, strip mesh, MSAA, shadow and blur passes, perspective mapper; the WGSL is inlined)
  shatter: 29 * KB, // 28,363; 16.25 -> 29 KB: two-stage glass (spiderweb cracks, the cracked-pane mapper, 3D fall, debris; the WGSL is inlined)
  water: 11.75 * KB, // 11,623; 10.5 -> 10.75 KB: meta.reducedMotion; 10.75 -> 11.75 KB: the action 'drop' (handle.trigger, settled when calm)
};
const problems = [];
const known = [];

if (!process.argv.includes('--no-build')) execFileSync(process.execPath, [join(root, 'scripts/build.mjs'), '--quiet'], { stdio: 'inherit' });
const sizes = JSON.parse(readFileSync(join(root, 'dist/sizes.json'), 'utf8'));
const { plugins: PLUGINS } = JSON.parse(readFileSync(join(root, 'dist/plugins/manifest.json'), 'utf8'));
for (const p of PLUGINS) {
  const ceiling = PLUGIN_LIMITS[p.name] ?? PLUGIN_CEILING;
  LIMITS[`plugins/${p.name}.iife.min.js`] = { target: ceiling, ceiling };
}
for (const name of discoverPlugins(root).map((p) => p.name)) if (!PLUGINS.some((p) => p.name === name)) problems.push(`G-bundle: plugins/${name} is not in dist/plugins/manifest.json`);

// ---- 1. size
const sizeProblem = (raw, target, ceiling) => (raw > ceiling ? 'ceiling' : raw > target ? 'target' : null);
const dynamicImport = (text) => /\bimport\s*\(/.test(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));
console.log('bundle'.padEnd(38), 'raw'.padStart(9), 'gzip'.padStart(9));
for (const r of sizes) console.log(r.file.padEnd(38), String(r.raw).padStart(9), String(r.gzip).padStart(9));
for (const [file, { target, ceiling, gzip }] of Object.entries(LIMITS)) {
  const row = sizes.find((r) => r.file === file);
  if (!row) { problems.push(`G-bundle: ${file} was not built`); continue; }
  if (gzip !== undefined && row.gzip > gzip) problems.push(`G-bundle: ${file} is ${row.gzip} bytes gzipped, above its gzip budget ${gzip} (a regression)`);
  const verdict = sizeProblem(row.raw, target, ceiling);
  if (verdict === 'ceiling') problems.push(`G-bundle: ${file} is ${row.raw} bytes, above its ceiling ${ceiling} (a regression)`);
  else if (verdict === 'target') (allowSize ? known : problems).push(`G-bundle: ${file} is ${row.raw} bytes (${(row.raw / KB).toFixed(1)} KB), target <= ${target / KB} KB`);
}

// ---- 2. static: classic scripts
const iifes = sizes.filter((r) => /\.iife(\.min)?\.js$/.test(r.file)).map((r) => r.file);
for (const file of iifes) {
  const text = readFileSync(join(root, 'dist', file), 'utf8');
  try { new Script(text, { filename: file }); } catch (e) { problems.push(`G-bundle: ${file} does not parse as a classic script: ${e.message}`); }
  // static import/export and import.meta already fail to parse as a script; a dynamic import() parses, so look for it in the code (comments removed)
  if (dynamicImport(text)) problems.push(`G-bundle: ${file} contains a dynamic import()`);
}

// every published file is free of the build machine's paths (esbuild names a virtual module by its path in a comment: plugin-wgsl:/Users/... shipped in every plugin bundle)
/** @param {string} text @returns {boolean} */
const buildPath = (text) => text.includes(root) || /(?:^|[\s"'`(:])(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s"'`]/.test(text);
for (const entry of readdirSync(join(root, 'dist'), { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !/\.(js|mjs|json|ts|map)$/.test(entry.name)) continue;
  const rel = join(entry.parentPath, entry.name).slice(join(root, 'dist').length + 1);
  if (buildPath(readFileSync(join(entry.parentPath, entry.name), 'utf8'))) problems.push(`G-bundle: dist/${rel} contains a path of the build machine`);
}
if (!buildPath(`// plugin-wgsl:${root}/plugins/water/wgsl.js`) || !buildPath('// x:/Users/someone/p.js') || buildPath('const userAgent = navigator.userAgent; // /Users is a word')) problems.push('G-bundle: the build-path check failed its own positive controls');

// positive controls of the static checks: a module and a dynamic import must be seen, an oversize bundle must be a problem
let moduleParses = true;
try { new Script('export const a = 1;'); } catch { moduleParses = false; }
if (moduleParses || !dynamicImport("const m = import('./x.js');") || dynamicImport('/* import(x) */ const a = 1;') || sizeProblem(2, 1, 3) !== 'target' || sizeProblem(4, 1, 3) !== 'ceiling' || sizeProblem(1, 1, 3) !== null) problems.push('G-bundle: the static checks failed their own positive controls');

// ---- 3. browser
if (!process.argv.includes('--skip-browser')) {
  const H = await import(pathToFileURL(join(root, 'test/harness/index.mjs')).href);
  const { FEATURES } = await import(pathToFileURL(join(root, 'src/contracts/features.js')).href);
  const srv = await H.startServer();
  const browser = await H.launchChrome({ name: 'bundle-check', chrome: 'stable', windowSize: [900, 700], dpr: 1, extraArgs: ['--headless=new', '--hide-scrollbars'] });
  const results = [];
  try {
    for (const min of [false, true]) {
      const f = (name) => `/dist/${name}.iife${min ? '.min' : ''}.js`;
      const CORE = f('hic-live-polyfill'), EFFECTS = f('hic-live-effects'), BRIDGE = f('hic-live-native-bridge'), ENGINES = f('hic-live-engines'), GPU = f('hic-live-gpu');
      const tag = min ? 'min' : 'js';
      /** @param {string} name @param {string[]} scripts @param {string} expr page-side check, must return a string[] of problems */
      const check = async (name, scripts, expr, declared = scripts, allowErrors = /$^/) => {
        const page = await browser.newPage({ reuseFirst: false });
        srv.requests.length = 0;
        try {
          page.clearLogs();
          await page.navigate(`${srv.url}/test/fixtures/bundle-load/index.html?scripts=${scripts.join(',')}`);
          await H.sleep(300);
          const out = await page.evaluate(`(async () => { ${expr} })()`);
          const requested = srv.requests.map((r) => r.url.split('?')[0]).filter((u) => !/favicon/.test(u));
          const expected = ['/test/fixtures/bundle-load/index.html', ...declared];
          const extra = requested.filter((u) => !expected.includes(u));
          const resources = await page.evaluate('performance.getEntriesByType("resource").map((e) => new URL(e.name).pathname + ":" + e.initiatorType)');
          const strayResources = resources.filter((r) => !/favicon/.test(r)).filter((r) => !declared.includes(r.split(':')[0]) || !/^(script)$/.test(r.split(':').pop()));
          const errs = page.errors({ includeWarnings: false }).map((e) => e.text).filter((t) => !/favicon/.test(t) && !allowErrors.test(t));
          const bad = [...out, ...extra.map((u) => `unexpected request ${u}`), ...strayResources.map((r) => `unexpected resource ${r}`), ...errs.map((e) => `page error: ${e}`)];
          results.push({ name: `${name} [${tag}]`, bad });
        } finally { await page.close(); }
      };
      const fullIds = JSON.stringify(FEATURES.map((x) => [x.id, x.status]));
      await check('core alone', [CORE], `
        const bad = [];
        if (typeof HicLivePolyfill?.install !== 'function') bad.push('window.HicLivePolyfill missing');
        if (window.__HIC__?.installed?.mode !== 'polyfill') bad.push('not installed in polyfill mode: ' + JSON.stringify(window.__HIC__?.error?.message));
        if (JSON.stringify(HicLivePolyfill.FEATURES.map((x) => [x.id, x.status])) !== ${JSON.stringify(fullIds)}) bad.push('FEATURES ids/status differ from src/contracts/features.js');
        if ('HTMLInCanvasEffects' in window) bad.push('the core alone must not define HTMLInCanvasEffects');
        const c = document.getElementById('c');
        if (typeof c.requestPaint !== 'function' || typeof c.getContext('2d').drawElementImage !== 'function') bad.push('2D surface missing');
        await __HIC__.installed.whenPainted(c, 4000).catch((e) => bad.push('no first paint: ' + e.message));
        return bad;`);
      await check('core + engines (engines first, then the core)', [ENGINES, CORE], `
        const bad = [];
        if (window.__HIC__?.installed?.mode !== 'polyfill') bad.push('not installed in polyfill mode');
        if (typeof globalThis[Symbol.for('hic.engine-skins')]?.paintNativeControl !== 'function') bad.push('the engines bundle did not register its painter');
        const c = document.getElementById('c');
        await __HIC__.installed.whenPainted(c, 4000).catch((e) => bad.push('no first paint: ' + e.message));
        return bad;`);
      await check('core alone: element-texture methods exist and throw a loud NotSupportedError naming the GPU bundle', [CORE], `
        const bad = [];
        const gl = document.createElement('canvas').getContext('webgl2');
        if (!gl || typeof gl.texElementSubImage2D !== 'function') bad.push('texElementSubImage2D missing (feature detection must still see it)');
        else { try { gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, document.body); bad.push('the stub did not throw'); } catch (e) { if (e.name !== 'NotSupportedError' || !/hic-live-gpu/.test(e.message + ' ' + (e.hint || ''))) bad.push('unexpected error: ' + e.name + ' ' + e.message); } }
        return bad;`, [CORE], /unsupported webgl-tex-element: .*needs the polyfill's GPU bundle/);
      for (const [label, order] of [['GPU before the core', [GPU, CORE]], ['GPU after the core', [CORE, GPU]]]) {
        await check(`core + gpu (${label}): texElementSubImage2D uploads an element`, order, `
          const bad = [];
          const c = document.getElementById('c');
          await __HIC__.installed.whenPainted(c, 4000).catch((e) => bad.push('no first paint: ' + e.message));
          const cv = document.createElement('canvas');
          cv.setAttribute('content', 'drawable');
          const el = document.createElement('div');
          el.setAttribute('drawable', '');
          el.style.cssText = 'width:40px;height:20px;background:#0a0';
          el.textContent = 'gl';
          cv.append(el);
          document.body.append(cv);
          const gl = cv.getContext('webgl2');
          await __HIC__.installed.whenPainted(cv, 4000).catch((e) => bad.push('no first paint of the GL canvas: ' + e.message));
          const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
          try { gl.texElementImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el); } catch (e) { bad.push('upload threw: ' + e.name + ' ' + e.message); }
          if (gl.getError() !== gl.NO_ERROR) bad.push('GL error after the upload');
          return bad;`);
      }
      await check('core alone has no engine painter', [CORE], `
        return typeof globalThis[Symbol.for('hic.engine-skins')] === 'undefined' ? [] : ['the core alone must not carry the Gecko / WebKit painters'];`);
      await check('core + effects', [CORE, EFFECTS], `
        const bad = [];
        const api = window.HTMLInCanvasEffects;
        if (!api || api.version !== 2 || typeof api.createHost !== 'function' || typeof api.definePlugin !== 'function') bad.push('HTMLInCanvasEffects missing or wrong');
        if (!Object.isFrozen(api)) bad.push('HTMLInCanvasEffects is not frozen');
        const copy = { x: 0, y: 0, [Symbol.for('html-in-canvas-polyfill.effects.no-target')]: true };
        if (!api.NO_TARGET || !api.isNoTarget(api.NO_TARGET) || !api.isNoTarget(copy) || api.isNoTarget({ x: -1e5, y: -1e5 })) bad.push('HTMLInCanvasEffects.NO_TARGET / isNoTarget missing or wrong');
        const err = await api.createHost(document.getElementById('c'), document.getElementById('d'), { interposer: false }).then(() => null, (e) => e);
        if (err && /needs the installed polyfill/.test(err.message)) bad.push('the effects bundle did not find the installed core: ' + err.message);
        __HIC__.installed.uninstall();
        const after = await api.createHost(document.getElementById('c'), document.getElementById('d')).then(() => null, (e) => e);
        if (!after || !/needs the installed polyfill/.test(after.message)) bad.push('after uninstall createHost must reject with the installed-polyfill message, got ' + after);
        return bad;`);
      // every plugin: it registers itself, the effects host accepts its definition, and it compiles its shaders from inlined strings (no request)
      for (const p of PLUGINS) {
        const PLUGIN = `/dist/plugins/${min ? p.files.min : p.files.iife}`;
        const shaders = discoverPlugins(root).find((x) => x.name === p.name)?.wgsl.length ?? 0;
        await check(`core + effects + plugin ${p.name} (inlined shaders)`, [CORE, EFFECTS, PLUGIN], `
          const bad = [];
          const entry = window.HicLivePlugins?.[${JSON.stringify(p.name)}];
          if (!entry || entry.meta?.name !== ${JSON.stringify(p.name)} || entry.plugin?.type !== ${JSON.stringify(p.name)}) { bad.push('HicLivePlugins.${p.name} missing or wrong'); return bad; }
          try { HTMLInCanvasEffects.definePlugin(entry.plugin); } catch (e) { bad.push('definePlugin refused it: ' + e.message); }
          const codes = [];
          const stop = () => { throw new Error('stop after the shaders'); };
          const device = new Proxy({ createShaderModule: (d) => { codes.push(d.code); return {}; }, createRenderPipeline: stop, createComputePipeline: stop, createRenderPipelineAsync: stop, createComputePipelineAsync: stop }, { get: (t, k) => (k in t ? t[k] : stop) });
          await entry.plugin.create({ apiVersion: 2, device, format: 'bgra8unorm', canvas: document.getElementById('c'), source: document.getElementById('d'), listen() { return () => {}; }, requestRender() {}, viewport: () => ({}) }, {}).catch(() => {});
          if (${shaders} > 0 && !codes.some((c) => typeof c === 'string' && /@(vertex|fragment|compute)/.test(c))) bad.push('the plugin did not compile an inlined WGSL string: ' + String(codes[0]).slice(0, 60));
          return bad;`);
      }
      // positive control: a script the page was not declared to load is an unexpected request, and a missing global is reported
      if (!min) {
        await check('CONTROL undeclared script', [CORE, EFFECTS], 'return [];', [CORE]);
        await check('CONTROL missing global', [CORE], "return typeof HicLivePlugins === 'object' ? [] : ['HicLivePlugins missing (expected for this control)'];");
      }
      await check('native bridge + core', [BRIDGE, CORE], `
        const bad = [];
        const slot = globalThis[Symbol.for('hic.native-bridge')];
        if (typeof slot?.install !== 'function') bad.push('the native bridge did not register itself');
        if (window.__HIC__?.installed?.mode !== 'polyfill') bad.push('core after bridge did not install');
        return bad;`);
    }
    // the ESM builds, as native modules (the split: index / effects / native-bridge + shared chunks, and dist/plugins/water.esm.js)
    {
      const page = await browser.newPage({ reuseFirst: false });
      srv.requests.length = 0;
      try {
        page.clearLogs();
        await page.navigate(`${srv.url}/test/fixtures/bundle-load/esm.html`);
        await page.waitForFunction('window.__esm?.done === true', { timeout: 15000 }).catch(() => {});
        const out = await page.evaluate('JSON.stringify(window.__esm ?? { bad: ["no result"] })').then(JSON.parse);
        const stray = srv.requests.map((r) => r.url.split('?')[0]).filter((u) => u !== '/test/fixtures/bundle-load/esm.html' && !u.startsWith('/dist/esm/') && u !== '/dist/plugins/water.esm.js' && !/favicon/.test(u));
        const errs = page.errors({ includeWarnings: false }).map((e) => e.text).filter((t) => !/favicon/.test(t));
        results.push({ name: 'ESM builds', bad: [...(out.bad ?? []), ...(out.done ? [] : ['the module did not finish']), ...stray.map((u) => `unexpected request ${u}`), ...errs.map((e) => `page error: ${e}`)] });
      } finally { await page.close(); }
    }
  } finally { await browser.close().catch(() => {}); await srv.close().catch(() => {}); }
  for (const r of results.filter((x) => x.name.startsWith('CONTROL'))) {
    if (r.bad.length === 0) problems.push(`G-bundle: ${r.name}: the control did not fail, the browser check cannot see a stray request / a missing global`);
    results.splice(results.indexOf(r), 1);
  }
  for (const r of results) {
    console.log(`${r.bad.length ? 'FAIL' : 'ok  '} browser: ${r.name}${r.bad.length ? ' :: ' + r.bad.join(' | ') : ''}`);
    for (const b of r.bad) problems.push(`G-bundle: ${r.name}: ${b}`);
  }
}

if (known.length) console.warn('KNOWN RED (G-bundle target, docs/BUNDLES.md):\n' + known.join('\n'));
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('G-bundle: OK');
