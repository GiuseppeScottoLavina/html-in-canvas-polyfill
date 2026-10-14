// G-bundle (docs/TEST-PLAN.md): the built bundles are what they claim to be.
//   node scripts/check-bundle.mjs [--no-build] [--allow-size] [--skip-browser]
//   1. size: core min <= 150 KB (the target), and never above the recorded RATCHET (a regression fails even with --allow-size); every other bundle below its own ceiling
//   2. static: each IIFE parses as a CLASSIC script (a static import/export or import.meta is a SyntaxError there) and has no dynamic import()
//   3. in headless Chrome, for the readable AND the minified files: core alone, core + effects, core + effects + each plugin of dist/plugins/, native bridge + core:
//      the globals exist and work, the page made NO request beyond its own scripts (server log + Resource Timing), and the minified FEATURES agree with src/contracts/features.js
// --allow-size: the 150 KB target is a KNOWN RED (printed, does not fail); the ratchet still fails. Used by `npm test` and CI until the target is met (docs/BUNDLES.md).
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Script } from 'node:vm';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverPlugins } from '../plugins/_shared/contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowSize = process.argv.includes('--allow-size');
const KB = 1000; // decimal, as in the 150 KB target
/** target = the gate threshold; ceiling = the recorded size the bundle may not exceed (regression guard). Raise a ceiling only with a measured reason, lower it when the bundle shrinks. */
const LIMITS = {
  // raised deliberately, one measured reason at a time; 254 -> 257 KB (+2,893 bytes, 2026-10-14): the core-only native probe that never refuses a usable native, and getElementImageDefaultSize
  // 257 -> 257.5 KB (+493 bytes, 2026-10-14): a selection of the static text inside the canvas repaints when it changes (owner bug report)
  // 257.5 -> 257.6 KB (+78 bytes, 2026-10-14): a whole tile overtaken by a DOM mutation is committed, so a counter in proportional digits is not starved (owner bug report)
  'hic-live-polyfill.iife.min.js': { target: 150 * KB, ceiling: 257.6 * KB },
  'hic-live-effects.iife.min.js': { target: 27.5 * KB, ceiling: 27.5 * KB }, // 27 -> 27.5 KB (+432 bytes, 2026-10-14): NO_TARGET of the effects ABI (mapper chain and interposer)
  'hic-live-native-bridge.iife.min.js': { target: 11.5 * KB, ceiling: 11.5 * KB }, // 11 -> 11.5 KB (2026-10-14): getElementImageDefaultSize over the earlier ElementImage.width/height
  'hic-live-engines.iife.min.js': { target: 40 * KB, ceiling: 40 * KB }, // the Gecko / WebKit painters, outside the core
  'hic-live-gpu.iife.min.js': { target: 16 * KB, ceiling: 16 * KB }, // WebGL / WebGPU element textures, outside the core
};
/** A new plugin bundle (dist/plugins/<name>.iife.min.js) has this ceiling until PLUGIN_LIMITS records its own: plugins are small add-ons. */
const PLUGIN_CEILING = 16 * KB;
/**
 * Per plugin: the measured minified size (2026-10-14) plus a small margin, so that growth is a decision, not an accident. disintegrate and
 * shatter are above the 16 KB default: most of each is its WGSL, inlined by the build (shatter also builds its crack pattern on the CPU).
 */
const PLUGIN_LIMITS = {
  crt: 14 * KB, // 13,669; 10.5 -> 14 KB: the arcade look (glow rings, aperture grille, glass), the presets and their picker
  disintegrate: 26.5 * KB, // 25,807; 41.5 -> 26.5 KB: content-only dust (background estimate by mean shift, eroding sweep, instanced grains with live colours; the WGSL is inlined)
  glitch: 13.5 * KB, // 13,269
  'holo-card': 12.75 * KB, // 12,358
  'liquid-glass': 12.25 * KB, // 11,810
  'page-curl': 33.5 * KB, // 32,375; 15.5 -> 33.5 KB: 3D sheet (fold model, strip mesh, MSAA, shadow and blur passes, perspective mapper; the WGSL is inlined)
  shatter: 29 * KB, // 28,363; 16.25 -> 29 KB: two-stage glass (spiderweb cracks, the cracked-pane mapper, 3D fall, debris; the WGSL is inlined)
  water: 10.75 * KB, // 10,479; 10.5 -> 10.75 KB: meta.reducedMotion
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
for (const [file, { target, ceiling }] of Object.entries(LIMITS)) {
  const row = sizes.find((r) => r.file === file);
  if (!row) { problems.push(`G-bundle: ${file} was not built`); continue; }
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
