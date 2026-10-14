// G-bundle (docs/TEST-PLAN.md): the built bundles are what they claim to be.
//   node scripts/check-bundle.mjs [--no-build] [--allow-size] [--skip-browser]
//   1. size: core min <= 150 KB (the target), and never above the recorded RATCHET (a regression fails even with --allow-size); every other bundle below its own ceiling
//   2. static: each IIFE parses as a CLASSIC script (a static import/export or import.meta is a SyntaxError there) and has no dynamic import()
//   3. in headless Chrome, for the readable AND the minified files: core alone, core + effects, core + effects + water, native bridge + core:
//      the globals exist and work, the page made NO request beyond its own scripts (server log + Resource Timing), and the minified FEATURES agree with src/contracts/features.js
// --allow-size: the 150 KB target is a KNOWN RED (printed, does not fail); the ratchet still fails. Used by `npm test` and CI until the target is met (docs/BUNDLES.md).
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Script } from 'node:vm';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowSize = process.argv.includes('--allow-size');
const KB = 1000; // decimal, as in the 150 KB target
/** target = the gate threshold; ceiling = the recorded size the bundle may not exceed (regression guard). Raise a ceiling only with a measured reason, lower it when the bundle shrinks. */
const LIMITS = {
  'hic-live-polyfill.iife.min.js': { target: 150 * KB, ceiling: 254 * KB }, // raised deliberately, one measured reason at a time
  'hic-live-effects.iife.min.js': { target: 27 * KB, ceiling: 27 * KB },
  'hic-live-effects-water.iife.min.js': { target: 10.5 * KB, ceiling: 10.5 * KB },
  'hic-live-native-bridge.iife.min.js': { target: 11 * KB, ceiling: 11 * KB },
  'hic-live-engines.iife.min.js': { target: 40 * KB, ceiling: 40 * KB }, // the Gecko / WebKit painters, outside the core
  'hic-live-gpu.iife.min.js': { target: 16 * KB, ceiling: 16 * KB }, // WebGL / WebGPU element textures, outside the core
};
const problems = [];
const known = [];

if (!process.argv.includes('--no-build')) execFileSync(process.execPath, [join(root, 'scripts/build.mjs'), '--quiet'], { stdio: 'inherit' });
const sizes = JSON.parse(readFileSync(join(root, 'dist/sizes.json'), 'utf8'));

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
      const CORE = f('hic-live-polyfill'), EFFECTS = f('hic-live-effects'), WATER = f('hic-live-effects-water'), BRIDGE = f('hic-live-native-bridge'), ENGINES = f('hic-live-engines'), GPU = f('hic-live-gpu');
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
        const err = await api.createHost(document.getElementById('c'), document.getElementById('d'), { interposer: false }).then(() => null, (e) => e);
        if (err && /needs the installed polyfill/.test(err.message)) bad.push('the effects bundle did not find the installed core: ' + err.message);
        __HIC__.installed.uninstall();
        const after = await api.createHost(document.getElementById('c'), document.getElementById('d')).then(() => null, (e) => e);
        if (!after || !/needs the installed polyfill/.test(after.message)) bad.push('after uninstall createHost must reject with the installed-polyfill message, got ' + after);
        return bad;`);
      await check('core + effects + water (inlined shader)', [CORE, EFFECTS, WATER], `
        const bad = [];
        const W = window.HicLiveEffectsWater?.WaterEffectPlugin;
        if (!W || W.type !== 'water') { bad.push('HicLiveEffectsWater.WaterEffectPlugin missing'); return bad; }
        let code = null;
        const device = { createShaderModule: (d) => { code = d.code; return {}; }, createRenderPipeline: () => { throw new Error('stop after the shader'); } };
        await W.create({ device, format: 'bgra8unorm', canvas: document.getElementById('c'), listen() {} }, {}).catch(() => {});
        if (typeof code !== 'string' || !code.includes('@fragment')) bad.push('the plugin did not compile an inlined WGSL string: ' + String(code).slice(0, 60));
        if (typeof window.HTMLInCanvasEffects?.definePlugin !== 'function') bad.push('effects bundle missing');
        return bad;`);
      // positive control: a script the page was not declared to load is an unexpected request, and a missing global is reported
      if (!min) {
        await check('CONTROL undeclared script', [CORE, EFFECTS], 'return [];', [CORE]);
        await check('CONTROL missing global', [CORE], "return typeof HicLiveEffectsWater === 'object' ? [] : ['HicLiveEffectsWater missing (expected for this control)'];");
      }
      await check('native bridge + core', [BRIDGE, CORE], `
        const bad = [];
        const slot = globalThis[Symbol.for('hic.native-bridge')];
        if (typeof slot?.install !== 'function') bad.push('the native bridge did not register itself');
        if (window.__HIC__?.installed?.mode !== 'polyfill') bad.push('core after bridge did not install');
        return bad;`);
    }
    // the ESM builds, as native modules (the split: index / effects / effects-water / native-bridge + shared chunks)
    {
      const page = await browser.newPage({ reuseFirst: false });
      srv.requests.length = 0;
      try {
        page.clearLogs();
        await page.navigate(`${srv.url}/test/fixtures/bundle-load/esm.html`);
        await page.waitForFunction('window.__esm?.done === true', { timeout: 15000 }).catch(() => {});
        const out = await page.evaluate('JSON.stringify(window.__esm ?? { bad: ["no result"] })').then(JSON.parse);
        const stray = srv.requests.map((r) => r.url.split('?')[0]).filter((u) => u !== '/test/fixtures/bundle-load/esm.html' && !u.startsWith('/dist/esm/') && !/favicon/.test(u));
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
