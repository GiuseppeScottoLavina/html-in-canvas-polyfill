// G-bridged-translation: mode `native-bridged` end to end. A page written for the CURRENT API (test/fixtures/bridged) runs on a real native build of the
// earlier `layoutsubtree` draft (Chrome for Testing 154 or 155 with --enable-blink-features=CanvasDrawElement) with the native-bridge bundle loaded before the
// core, and every row of docs/API-CONTRACT.md 2.1 is checked against what that build really does:
//   mode      install() reports `native-bridged`, kind `legacy`, no internal error;
//   markup    `content` IDL and attribute mirrored to `layoutsubtree` (parser-created, setAttribute, innerHTML, removal); native paint events fire;
//   pixel     the native 2D draw puts each quadrant of the element exactly where the standard call asked, nothing at its layout box;
//   hit       the automatic geometry after a draw: hit testing and a trusted click land on the DRAWN element, the one-argument getElementTransform answers;
//   preserve  a draw with {preserveElementGeometry: true} keeps the previous geometry; a later plain draw moves it;
//   matrix    a standard caller gets undefined, a legacy caller (`layoutsubtree` written by the page) keeps the native DOMMatrix and no transform rule;
//   report    a draw of a NON-direct descendant, which the native build refuses, is reported (`legacy-native-bridge`) and the native error rethrown;
//   size      getElementImageDefaultSize, missing natively, is built over the capture's width/height and returns that build's numbers;
//   gl        texElementSubImage2D (native on both builds) uploads the exact pixels with the bridge loaded, and is not replaced;
//   gpu       drawElementImageToTexture with the current dictionary (sized, unsized, source rect) and the earlier copyElementImageToTexture call: exact pixels;
//   gapfill   SYNTHETIC shape on the real build (names deleted before any bundle loads: onelementgeometryupdate, ElementGeometryUpdateEvent,
//             WebGL2 texElementSubImage2D, GPUQueue.drawElementImageToTexture; on Chrome 154 the first two are absent anyway): never a refusal, each name built
//             from the native API that is left and checked with the same pixel oracle; the earlier copyElementImageToTexture built over the current name
//             (option legacyNames) where the native current name takes the current dictionary;
//   renderer  the native renderer is never replaced: no 2D drawImage of a raster, no SVG or blob image, no live layer, no polyfill marker but the bridge's hit rule.
// End to end: every check above runs the real native implementation; only `gapfill` deletes native names first (a synthetic shape), and says which it deleted.
// Control (must turn every class red): the same pages WITHOUT the bridge bundle (mode native, used as found), and the renderer page installed with
// `forcePolyfill` (the polyfill replaces the native renderer).
//
//   node test/gates/g-bridged-translation.mjs [--chrome=<path> | --build=154|155] [--allow-no-webgpu] [--no-control] [--bridge-file=<copy>] [--bundle-file=<copy>]
// The browser: --chrome; else --build, Chrome for Testing 154.0.8037.92 or 155.0.8059.79 in the @puppeteer/browsers cache layout under HIC_BROWSERS_CACHE
// (a list of roots separated like PATH) or ~/.cache/puppeteer ( `npx @puppeteer/browsers install chrome@155.0.8059.79 --path ~/.cache/puppeteer`); else HIC_BRIDGED_CHROME; else build 155.
// The two builds differ where the bridge matters (measured 2026-11-06): 154 lacks onelementgeometryupdate and ElementGeometryUpdateEvent, and its
// drawElementImageToTexture takes the earlier destination dictionary; 155 has both names and the current dictionary. Headless (no display needed).
// --allow-no-webgpu: a browser without a WebGPU adapter (the Linux CI runner) records the gpu checks as not run instead of failing them; the class is then
// not required to turn red.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { runGate, H, BRIDGE_BUNDLE } from './lib/gate.mjs';

/** the measured builds of the earlier draft, by major */
export const BUILDS = { 154: '154.0.8037.92', 155: '155.0.8059.79' };
export const PINNED = BUILDS[155];
/** The executable of a Chrome for Testing build in the @puppeteer/browsers cache layout. @param {string} version @param {string} [root] */
export function cachedChrome(version, root = resolve(homedir(), '.cache/puppeteer'), platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') {
    const dir = arch === 'arm64' ? ['mac_arm', 'chrome-mac-arm64'] : ['mac', 'chrome-mac-x64'];
    return resolve(root, `chrome/${dir[0]}-${version}/${dir[1]}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`);
  }
  if (platform === 'win32') return resolve(root, `chrome/win64-${version}/chrome-win64/chrome.exe`);
  return resolve(root, `chrome/linux-${version}/chrome-linux64/chrome`);
}

const arg = (/** @type {string} */ k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const allowNoGpu = process.argv.includes('--allow-no-webgpu');
const build = arg('build');
if (build && !BUILDS[build]) { console.error(`--build must be one of ${Object.keys(BUILDS).join(', ')}`); process.exit(2); }
// the cache roots, in order: HIC_BROWSERS_CACHE (a list separated like PATH), then ~/.cache/puppeteer; the first that holds the build wins
const roots = [...(process.env.HIC_BROWSERS_CACHE ?? '').split(delimiter).filter(Boolean), resolve(homedir(), '.cache/puppeteer')];
const fromCache = (/** @type {string} */ version) => roots.map((r) => cachedChrome(version, r)).find((p) => existsSync(p)) ?? cachedChrome(version, roots[roots.length - 1]);
const chrome = arg('chrome') ?? (build ? fromCache(BUILDS[build]) : process.env.HIC_BRIDGED_CHROME ?? fromCache(PINNED));
if (!arg('chrome') && !existsSync(chrome)) {
  const version = BUILDS[build ?? 155];
  console.error(`G-bridged-translation needs a native build of the earlier draft: ${chrome} is missing. Fetch it with\n  npx @puppeteer/browsers install chrome@${version} --path ~/.cache/puppeteer\nor pass --chrome=<path> (Chrome for Testing 154 or 155).`);
}

const PAGE = '/test/fixtures/bridged/index.html';
const SYNTHETIC = ['HTMLCanvasElement.onelementgeometryupdate', 'ElementGeometryUpdateEvent', 'WebGL2RenderingContext.texElementSubImage2D', 'GPUQueue.drawElementImageToTexture'];
/** the GPU call shapes of the fixture and where each lands in the 128 x 80 texture: [dx, dy, w, h, sx, sy] */
const GPU = { sized: [20, 10, 100, 60, 0, 0], unsized: [20, 10, 100, 60, 0, 0], rect: [20, 10, 50, 30, 50, 30], legacy: [20, 10, 100, 60, 0, 0] };

runGate('G-bridged-translation', async (ctx) => {
  const numbers = {};
  const core = ctx.bundle;
  // the control drops the bridge: the same native build used as found
  const bundles = ctx.control ? core : `${BRIDGE_BUNDLE},${core}`;
  const url = (/** @type {Record<string, string>} */ q) => `${ctx.srv.url}${PAGE}?${new URLSearchParams({ bundle: bundles, ...q })}`;
  const page = await ctx.page();
  const ev = (/** @type {string} */ js) => page.evaluate(js);
  const painted = () => H.until(() => ev('!!(window.__b && __b.results.stdPainted && __b.results.legReturn !== undefined && __b.results.gl && __b.results.gl2 && __paints.gpu)'), 6000);
  // a GPU copy needs the element's paint record: the first paint of its canvas after the canvas became drawable
  const gpuPainted = (/** @type {Page} */ p) => H.until(() => p.evaluate('!!(window.__paints && __paints.gpu)'), 6000);
  /** in-page: a GPU variant's pixels judged by the oracle, without moving the texture to Node */
  const gpuCase = (/** @type {string} */ variant) => ev(`__b.paintGpu(${JSON.stringify(variant)}).then((r) => ({ error: r.error, noAdapter: !!r.noAdapter, oracle: r.pixels ? __b.quadCheck(r.pixels, 128, 80, ${GPU[variant].join(', ')}, true) : null }))`);
  const glCase = (/** @type {string} */ id) => ev(`(() => { const r = __b.results.${id}; return { error: r.error, glError: r.glError, boundAfter: r.boundAfter, oracle: r.pixels ? __b.quadCheck(r.pixels, 128, 80, 20, 10, 100, 60, 0, 0, true) : null }; })()`);
  const gpuChecks = async (/** @type {string} */ label, /** @type {string[]} */ variants, cls = 'gpu') => {
    for (const v of variants) {
      const r = await gpuCase(v);
      numbers[`${label}_${v}`] = r;
      if (r.noAdapter && allowNoGpu) { numbers.webgpu = 'no adapter (--allow-no-webgpu): the gpu checks were not run'; continue; }
      ctx.check(`${label}: ${v === 'legacy' ? 'copyElementImageToTexture({source}, {destination: {texture, origin}, width, height})' : `drawElementImageToTexture, ${v}`} copies the element's exact pixels to the asked place of the texture`,
        !r.error && r.oracle?.ok, { error: r.error, oracle: r.oracle }, cls);
    }
  };

  // ---- 1. the standard page on the real build ------------------------------------------------------------------------------------------
  await page.navigate(url({}));
  await painted();
  numbers.browser = (await ctx.browser.info?.())?.product ?? ctx.browser.version?.Browser ?? null;
  const m = await ev('__b.mode()');
  numbers.mode = m;
  ctx.check('install() over the legacy native build reports mode native-bridged (kind legacy), no internal error', m.mode === 'native-bridged' && m.kind === 'legacy' && m.errors === 0 && m.deviations.includes('legacy-native-bridge'), m, 'mode');

  const markup = await ev(`new Promise((done) => {
    const std = document.getElementById('std');
    const a = document.createElement('canvas'); document.body.append(a); a.setAttribute('content', 'drawable');
    const sync = a.hasAttribute('layoutsubtree');
    const b = document.createElement('div'); document.body.append(b); b.innerHTML = '<canvas content="drawable"></canvas>';
    const viaIdl = document.createElement('canvas'); document.body.append(viaIdl); viaIdl.content = 'drawable';
    setTimeout(() => { const inner = b.firstChild.hasAttribute('layoutsubtree'); a.removeAttribute('content'); const removed = !a.hasAttribute('layoutsubtree');
      const out = { content: std.content, attr: std.hasAttribute('layoutsubtree'), sync, inner, idl: viaIdl.getAttribute('content') === 'drawable' && viaIdl.hasAttribute('layoutsubtree'), removed, paints: window.__paints.std || 0 };
      a.remove(); b.remove(); viaIdl.remove(); done(out); }, 50); })`);
  numbers.markup = markup;
  ctx.check('content="drawable" is mirrored to layoutsubtree (parser, setAttribute at once, innerHTML by the observer, the content IDL) and taken back with it; the native build fires paint',
    markup.content === 'drawable' && markup.attr && markup.sync && markup.inner && markup.idl && markup.removed && markup.paints >= 1, markup, 'markup');

  const px2d = await ev(`(() => { const p = __b.canvasPixels('std'); return { tile: __b.quadCheck(p, 240, 160, 130, 10, 100, 60, 0, 0, false),
    layoutBox: (() => { let n = 0, bad = 0; for (let y = 1; y < 59; y++) for (let x = 1; x < 99; x++) { n++; if (p[4 * (y * 240 + x) + 3] !== 0) bad++; } return { n, bad }; })() }; })()`);
  numbers.pixel2d = px2d;
  ctx.check('the native 2D draw shows each quadrant of the element exactly where drawElementImage(tile, 130, 10) asked, and nothing at its layout box', px2d.tile.ok && px2d.layoutBox.bad === 0, px2d, 'pixel');

  const hit = await ev(`(() => { const at = (x, y) => { const e = document.elementFromPoint(x, y); return e && (e.id || (e.parentElement && e.parentElement.id + '>' + e.localName)); };
    return { drawn: at(180, 40), layout: at(50, 30), transform: __b.transform('std', 'tile') }; })()`);
  await page.click(170, 90);
  await H.sleep(150);
  hit.clickFocus = await ev('document.activeElement && document.activeElement.id');
  numbers.hit = hit;
  ctx.check('auto geometry after a draw: the drawn tile is hit where it was drawn, not at its layout box; getElementTransform(el) answers the draw; a trusted click on the drawn field focuses it',
    hit.drawn === 'tile>i' && hit.layout !== 'tile>i' && JSON.stringify(hit.transform) === JSON.stringify([1, 0, 0, 1, 130, 10]) && hit.clickFocus === 'field', hit, 'hit');

  const pin = async (/** @type {number} */ x, /** @type {boolean} */ preserve) => {
    await ev(`__b.movePin(${x}, 125, ${preserve})`);
    await H.sleep(250);
    return ev(`(() => { const at = (x, y) => { const e = document.elementFromPoint(x, y); return e && e.id; }; const t = __b.transform('std', 'pin');
      return { transform: Array.isArray(t) ? t.slice(4) : t, at130: at(150, 135), at10: at(30, 135) }; })()`);
  };
  const kept = await pin(10, true);
  const moved = await pin(10, false);
  numbers.preserve = { kept, moved };
  ctx.check('a draw with {preserveElementGeometry: true} keeps the previous geometry (the pin stays hit at 130), a later plain draw moves it to 10',
    JSON.stringify(kept.transform) === '[130,125]' && kept.at130 === 'pin' && kept.at10 !== 'pin' && JSON.stringify(moved.transform) === '[10,125]' && moved.at10 === 'pin' && moved.at130 !== 'pin', numbers.preserve, 'preserve');

  const matrix = await ev(`(() => { const r = __b.results; const l = r.legReturn; return { stdPainted: r.stdPainted || 0, std: r.stdReturn === undefined ? 'undefined' : String(r.stdReturn),
    legacy: l && l.constructor.name, legacyE: l && [l.e, l.f], legacyRule: document.getElementById('ltile').hasAttribute('data-hic-hit') }; })()`);
  numbers.matrix = matrix;
  ctx.check('drawElementImage returns undefined to a standard caller (content=drawable) and the native DOMMatrix to a legacy caller (layoutsubtree), whose element gets no transform rule',
    matrix.stdPainted >= 1 && matrix.std === 'undefined' && matrix.legacy === 'DOMMatrix' && JSON.stringify(matrix.legacyE) === '[10,10]' && !matrix.legacyRule, matrix, 'matrix');

  const report = await ev(`(() => { const before = __b.mode().unsupported.length; let thrown = null; let fired = 0; const c = document.getElementById('std');
    c.addEventListener('hicunsupported', () => fired++);
    try { c.getContext('2d').drawElementImage(document.getElementById('deep'), 0, 0); } catch (e) { thrown = e.name + ': ' + e.message; }
    const after = __b.mode().unsupported; c.requestPaint(); return { before, thrown, after, fired }; })()`);
  numbers.report = report;
  ctx.check('a draw of a non-direct descendant, refused natively, is reported loudly (legacy-native-bridge, hicunsupported on the canvas) and the native error is rethrown; direct children report nothing',
    report.before === 0 && /^InvalidStateError/.test(report.thrown ?? '') && report.after.some((u) => /^legacy-native-bridge: .*DIRECT children/.test(u)) && report.fired === 1, report, 'report');

  const size = await ev(`(() => { const c = document.getElementById('std'); const t = document.getElementById('tile'); let s = null, cap = null;
    try { const d = c.getElementImageDefaultSize(t); s = [d.width, d.height]; } catch (e) { s = 'threw ' + e.message; }
    try { const i = c.captureElementImage(t); cap = [i.width, i.height]; i.close(); } catch (e) { cap = 'threw ' + e.message; }
    return { s, cap, gap: (__b.mode().gaps || []).includes('getElementImageDefaultSize') }; })()`);
  numbers.size = size;
  ctx.check('getElementImageDefaultSize (missing natively) is built over the capture\'s width/height: 100 x 60 for the 100 x 60 css px tile at DPR 1, equal to the native capture',
    size.gap && JSON.stringify(size.s) === '[100,60]' && JSON.stringify(size.s) === JSON.stringify(size.cap), size, 'size');

  for (const id of ['gl', 'gl2']) {
    const r = await glCase(id);
    r.native = await ev(`${id === 'gl' ? 'WebGLRenderingContext' : 'WebGL2RenderingContext'}.prototype.texElementSubImage2D === __native.${id === 'gl' ? 'texSub' : 'texSub2'}`);
    numbers[id] = r;
    ctx.check(`${id === 'gl' ? 'WebGL' : 'WebGL2'}: texElementSubImage2D(TEXTURE_2D, 0, 20, 10, element) uploads the element's exact pixels at the offset, no GL error; the native method is not replaced`,
      !r.error && r.glError === 0 && r.oracle?.ok && r.native, r, 'gl');
  }
  await gpuChecks('WebGPU', ['sized', 'unsized', 'rect', 'legacy']);

  // ---- 2. the renderer: nothing of the polyfill's own pipeline runs ---------------------------------------------------------------------
  const renderer = async (/** @type {string} */ label, /** @type {Page} */ p) => {
    const r = await p.evaluate(`({ hooks: __hooks, layer: document.querySelectorAll('hic-layer').length, marks: [...document.querySelectorAll('*')].flatMap((e) => [...e.attributes].map((a) => a.name)).filter((n) => /^data-hic-/.test(n) && n !== 'data-hic-hit' && n !== 'data-hic-manual'),
      mode: __b.mode().mode, stdPainted: __b.results.stdPainted || 0 })`);
    numbers[`renderer_${label}`] = r;
    ctx.check(`${label}: the native renderer is never replaced: no 2D drawImage of a raster, no SVG or blob image, no live layer, no polyfill marker but the bridge's hit rule (the page's own data-hic-manual aside; the page still painted)`,
      r.stdPainted >= 1 && r.hooks.drawImage === 0 && r.hooks.svgImages === 0 && r.layer === 0 && r.marks.length === 0, r, 'renderer');
  };
  await renderer('auto install', page);
  // the control installs with forcePolyfill: the polyfill's renderer replaces the native one, which the hooks must see
  const manual = await ctx.page();
  await manual.navigate(`${ctx.srv.url}${PAGE}?${new URLSearchParams({ bundle: `${BRIDGE_BUNDLE},${core}`, manual: '1' })}`);
  numbers.manualMode = await manual.evaluate(`(() => { const m = __b.install(${ctx.control ? '{ forcePolyfill: true }' : '{}'}); __b.start(); return m; })()`);
  await H.until(() => manual.evaluate('!!__b.results.stdPainted'), 6000);
  await H.sleep(800);
  await renderer(`explicit install() (mode ${numbers.manualMode})`, manual);

  // ---- 3. the synthetic shape: additive names deleted on the real build -------------------------------------------------------------
  const syn = await ctx.page();
  await syn.navigate(url({ delete: SYNTHETIC.join(',') }));
  await H.until(() => syn.evaluate('!!(window.__b && __b.results.gl2)'), 6000);
  await gpuPainted(syn);
  const gap = await syn.evaluate(`(() => { const m = __b.mode(); const c = document.getElementById('std'); let calls = 0, got = null;
    const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'onelementgeometryupdate');
    try { c.onelementgeometryupdate = (e) => { calls++; got = e; }; const e = new ElementGeometryUpdateEvent('elementgeometryupdate'); c.dispatchEvent(e); got = got === e; } catch (err) { got = 'threw ' + err.message; }
    return { mode: m.mode, gaps: m.gaps, errors: m.errors, deleted: __deleted, accessor: !!(d && d.get && d.set), handler: typeof c.onelementgeometryupdate, calls, sameEvent: got,
      texSub2Built: typeof WebGL2RenderingContext.prototype.texElementSubImage2D === 'function' && WebGL2RenderingContext.prototype.texElementSubImage2D !== __native.texSub2,
      gpuBuilt: !window.GPUQueue || (typeof GPUQueue.prototype.drawElementImageToTexture === 'function' && GPUQueue.prototype.drawElementImageToTexture !== __native.gpuDraw) }; })()`);
  numbers.gapfill = gap;
  ctx.check(`synthetic shape (deleted: ${gap.deleted.join(', ') || 'none'}): mode native-bridged, never a refusal; onelementgeometryupdate and ElementGeometryUpdateEvent are built and a dispatched event reaches the handler`,
    gap.mode === 'native-bridged' && gap.errors === 0 && ['onelementgeometryupdate', 'ElementGeometryUpdateEvent'].every((n) => gap.gaps?.includes(n)) && gap.accessor && gap.handler === 'function' && gap.calls === 1 && gap.sameEvent === true, gap, 'gapfill');
  const gl2 = await syn.evaluate(`(() => { const r = __b.results.gl2; return { error: r.error, glError: r.glError, boundAfter: r.boundAfter, oracle: r.pixels ? __b.quadCheck(r.pixels, 128, 80, 20, 10, 100, 60, 0, 0, true) : null }; })()`);
  numbers.gapfill_gl2 = gl2;
  ctx.check('synthetic shape: WebGL2 texElementSubImage2D built over the native texElementImage2D uploads the exact pixels at the offset and leaves the texture binding as it was',
    gap.texSub2Built && !gl2.error && gl2.glError === 0 && gl2.boundAfter && gl2.oracle?.ok, gl2, 'gapfill');
  for (const v of ['sized', 'unsized', 'rect']) {
    const r = await syn.evaluate(`__b.paintGpu(${JSON.stringify(v)}).then((r) => ({ error: r.error, noAdapter: !!r.noAdapter, oracle: r.pixels ? __b.quadCheck(r.pixels, 128, 80, ${GPU[v].join(', ')}, true) : null }))`);
    numbers[`gapfill_gpu_${v}`] = r;
    if (r.noAdapter && allowNoGpu) continue;
    ctx.check(`synthetic shape: drawElementImageToTexture built over the native copyElementImageToTexture, ${v}: exact pixels at the asked place`, gap.gpuBuilt && !r.error && r.oracle?.ok, r, 'gapfill');
  }
  // the earlier name for a legacy caller (option legacyNames), built over the current one
  const leg = await ctx.page();
  await leg.navigate(`${ctx.srv.url}${PAGE}?${new URLSearchParams({ bundle: bundles, manual: '1', delete: 'GPUQueue.copyElementImageToTexture' })}`);
  const legMode = await leg.evaluate(`(() => { const m = __b.install({ legacyNames: true }); __b.start(); return m; })()`);
  await gpuPainted(leg);
  const lr = await leg.evaluate(`__b.paintGpu('legacy').then((r) => ({ error: r.error, noAdapter: !!r.noAdapter, oracle: r.pixels ? __b.quadCheck(r.pixels, 128, 80, 20, 10, 100, 60, 0, 0, true) : null,
    built: !!window.GPUQueue && typeof GPUQueue.prototype.copyElementImageToTexture === 'function' && GPUQueue.prototype.copyElementImageToTexture !== __native.gpuCopy }))`);
  numbers.gapfill_gpu_legacyCaller = { mode: legMode, ...lr };
  if (!(lr.noAdapter && allowNoGpu)) {
    ctx.check('synthetic shape (copyElementImageToTexture deleted, option legacyNames): the earlier call is built over the native drawElementImageToTexture, exact pixels at the asked place',
      legMode === 'native-bridged' && lr.built && !lr.error && lr.oracle?.ok, numbers.gapfill_gpu_legacyCaller, 'gapfill');
  }

  const errs = [page, manual, syn, leg].flatMap((p) => p.errors({ includeWarnings: false })).filter((e) => !/legacy native implementation can only draw DIRECT children/.test(String(e?.text ?? e)));
  ctx.check('no uncaught exception and no console error on the pages, but the expected report of the non-direct draw', errs.length === 0, errs.slice(0, 4), 'mode');
  return { numbers };
}, {
  chrome, nativeDrawElement: true, dpr: 1, windowSize: [900, 900], headless: true,
  controlClasses: ['mode', 'markup', 'pixel', 'hit', 'preserve', 'matrix', 'report', 'size', 'gl', ...(allowNoGpu ? [] : ['gpu']), 'gapfill', 'renderer'],
});

/** @typedef {import('../harness/lib/page.mjs').Page} Page */
