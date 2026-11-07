#!/usr/bin/env node
// G-native-loader: the loader on a browser that ships HTML-in-Canvas (Chrome 157 or later, or Canary, with the native API enabled) downloads nothing: status
// 'native', installed null, and ZERO requests for the core, the engines bundle or the native bridge; no prototype carries the polyfill's patch mark. For the classic
// loader (.js and .min.js) and the module loader (dist/esm/loader.js). Control: the same pages with the native API disabled (the harness default) load the core and
// install in mode polyfill, so the request log and the patch check do see a download and an install. Also prints the bytes a page downloads on the native
// browser with the loader and with a plain <script> tag of the core (Resource Timing; the harness server does not compress).
// With a plain <script> tag the core installs in mode native over the browser's implementation: HicInstalled.whenPainted is checked there against the
// native paint events (test/gates/lib/when-painted.mjs: at once after a paint, also in an adopted shadow root; at the first paint; TimeoutError).
//   npm run build && node test/native-effects/g-native-loader.mjs --chrome=<Chrome 157+ or canary> [--no-control]
import * as H from '../harness/index.mjs';
import { whenPaintedChecks, whenPaintedProbe } from '../gates/lib/when-painted.mjs';

const chrome = process.argv.find((a) => a.startsWith('--chrome='))?.slice(9) ?? 'canary';
const control = !process.argv.includes('--no-control');
const PAGE = '/test/fixtures/loader/native.html';
// the module loader's core module and engines are chunks of dist/esm (chunks/loader-core-<hash>.js, chunks/engines-<hash>.js); the package entry must never be imported
const BUNDLES = /\/dist\/(hic-live-polyfill|hic-live-engines|hic-live-native-bridge)\.iife(\.min)?\.js$|\/dist\/esm\/(index|native-bridge)\.js$|\/dist\/esm\/chunks\/(loader-core|engines)-\w+\.js$/;
const CASES = [['classic', 'script=/dist/hic-live-loader.iife.js'], ['classic min', 'script=/dist/hic-live-loader.iife.min.js'], ['module', 'module=/dist/esm/loader.js']];
const MARKED = `(() => {
  const mark = Symbol.for('hic.patch');
  const names = ['HTMLCanvasElement', 'CanvasRenderingContext2D', 'OffscreenCanvas', 'OffscreenCanvasRenderingContext2D', 'Element', 'Node', 'Document', 'EventTarget', 'WebGLRenderingContext', 'WebGL2RenderingContext', 'Selection'];
  const out = [];
  for (const n of names) for (const o of [globalThis[n]?.prototype, globalThis[n]].filter(Boolean)) for (const k of Reflect.ownKeys(o)) {
    const d = Object.getOwnPropertyDescriptor(o, k);
    if ([d.value, d.get, d.set].some((f) => typeof f === 'function' && f[mark] === true)) out.push(n + '.' + String(k));
  }
  return out;
})()`;

/** @param {any} browser @param {any} srv @param {string} query */
async function visit(browser, srv, query) {
  const page = await browser.newPage({ reuseFirst: false });
  srv.requests.length = 0;
  try {
    await page.navigate(`${srv.url}${PAGE}?${query}`);
    const r = await page.evaluate('window.__load');
    await H.sleep(300);
    const resources = await page.evaluate('performance.getEntriesByType("resource").map((e) => ({ path: new URL(e.name).pathname, bytes: e.encodedBodySize }))');
    const marked = await page.evaluate(MARKED);
    const extra = await page.evaluate("[!!window[Symbol.for('hic.installed')], 'HicLivePolyfill' in window, typeof CanvasRenderingContext2D.prototype.drawElementImage]");
    const requests = srv.requests.map((x) => x.url.split('?')[0]);
    return { r, resources, marked, installedSlot: extra[0], coreGlobal: extra[1], draw: extra[2], bundles: requests.filter((u) => BUNDLES.test(u)), requests };
  } finally { await page.close(); }
}

const srv = await H.startServer();
const problems = [];
const bytes = {};
try {
  const browser = await H.launchChrome({ name: 'native-loader', chrome, nativeDrawElement: true, windowSize: [800, 600], dpr: 1, extraArgs: ['--headless=new'] });
  try {
    console.log(`G-native-loader: ${(await browser.info?.())?.product ?? chrome}`);
    for (const [label, query] of CASES) {
      const v = await visit(browser, srv, query);
      const bad = [];
      if (v.r?.status !== 'native' || v.r?.mode !== 'native' || v.r?.installed !== false) bad.push(`result ${JSON.stringify(v.r)}`);
      if (v.r?.kind !== 'complete') bad.push(`native kind ${v.r?.kind} (this run needs a browser that ships the API)`);
      if (v.bundles.length) bad.push(`requested ${v.bundles.join(', ')}`);
      if (v.marked.length) bad.push(`patched by the polyfill: ${v.marked.join(', ')}`);
      if (v.installedSlot || v.coreGlobal) bad.push('the core is on the page');
      if (v.draw !== 'function') bad.push('the native drawElementImage is missing');
      bytes[label] = v.resources.reduce((n, e) => n + e.bytes, 0);
      console.log(`${bad.length ? 'FAIL' : 'ok  '} native, ${label}: status ${v.r?.status}, ${v.requests.length} requests (${v.requests.join(', ')}), ${bytes[label]} bytes of scripts, decided in ${v.r?.ms?.toFixed(1)} ms${bad.length ? ' :: ' + bad.join(' | ') : ''}`);
      problems.push(...bad.map((b) => `native, ${label}: ${b}`));
    }
    for (const [label, query] of [['plain core script tag', 'script=/dist/hic-live-polyfill.iife.js'], ['plain core script tag, min', 'script=/dist/hic-live-polyfill.iife.min.js']]) {
      const v = await visit(browser, srv, query);
      bytes[label] = v.resources.reduce((n, e) => n + e.bytes, 0);
      console.log(`info native, ${label}: ${bytes[label]} bytes of scripts (the core steps aside after downloading)`);
    }
    const wp = await browser.newPage({ reuseFirst: false });
    try {
      await wp.navigate(`${srv.url}${PAGE}?script=/dist/hic-live-polyfill.iife.js`);
      await wp.bringToFront();
      const r = await wp.evaluate(whenPaintedProbe('content'));
      const mode = r?.mode === 'native' && r?.kind === 'complete';
      console.log(`${mode ? 'ok  ' : 'FAIL'} plain core script tag: the core installs in mode ${r?.mode}, kind ${r?.kind}`);
      if (!mode) problems.push(`whenPainted: the core installed in mode ${r?.mode}, kind ${r?.kind} (mode native, kind complete expected)`);
      for (const [name, ok, detail] of whenPaintedChecks(r, 'plain core script tag')) {
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' :: ' + JSON.stringify(detail)}`);
        if (!ok) problems.push(name);
      }
    } finally { await wp.close(); }
  } finally { await browser.close().catch(() => {}); }
  if (control) {
    const off = await H.launchChrome({ name: 'native-loader-control', chrome, windowSize: [800, 600], dpr: 1, extraArgs: ['--headless=new'] });
    try {
      for (const [label, query] of CASES) {
        const v = await visit(off, srv, query);
        const caught = v.r?.status === 'polyfill' && v.bundles.length > 0 && v.marked.length > 0;
        console.log(`${caught ? 'ok  ' : 'FAIL'} CONTROL native disabled, ${label}: status ${v.r?.status}, bundles ${v.bundles.join(', ')}, ${v.marked.length} marked members`);
        if (!caught) problems.push(`CONTROL ${label}: with the native API disabled the checks must see a download and an install`);
      }
    } finally { await off.close().catch(() => {}); }
  }
} finally { await srv.close().catch(() => {}); }
console.log(`bytes on the native browser: ${Object.entries(bytes).map(([k, v]) => `${k} ${v}`).join(', ')}`);
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('G-native-loader: OK');
