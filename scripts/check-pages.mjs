#!/usr/bin/env node
// G-pages: the GitHub Pages site (scripts/build-pages.mjs) works under its project path, in headless Chrome.
//
//   npm run build && npm run test:pages
//   node scripts/check-pages.mjs [--base=/html-in-canvas-polyfill/] [--no-control]
//
// The site is assembled into a temporary directory and served ONLY under `base` (any other path is a 404, so an absolute link that
// would break on https://<user>.github.io/html-in-canvas-polyfill/ fails here too). Every page is opened in one headless Chrome:
//   - the site root (it redirects to examples/), the examples index, every example page of the site;
//   - the plugin gallery with "Effect off" and with each plugin of dist/plugins/manifest.json (?effect=<name>): the effect is active, on
//     the WebGPU path, and the presented canvas is not blank.
// Per page: no console error, page exception or failed request (the server log is checked for 4xx too), and its largest canvas is not
// blank (compositor screenshot). Controls: the same site with the core bundle missing must fail, and a flat image must be blank.
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as H from '../test/harness/index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (/** @type {string} */ name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const BASE = (arg('base') ?? '/html-in-canvas-polyfill/').replace(/\/?$/, '/');
const VIEW = { width: 1200, height: 1300 };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.md': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

if (!existsSync(join(ROOT, 'dist/plugins/manifest.json'))) { console.error('dist/ is missing: run `npm run build` first.'); process.exit(2); }

/** A static server of `dir` under BASE only; `missing` paths answer 404 (the control). */
function serve(/** @type {string} */ dir, /** @type {Set<string>} */ missing = new Set()) {
  /** @type {{url: string, status: number}[]} */ const log = [];
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const send = (/** @type {number} */ status, /** @type {string} */ type, /** @type {any} */ body, headers = {}) => { log.push({ url: path, status }); res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers }); res.end(body); };
    if (path === '/favicon.ico') return send(204, 'image/x-icon', '');
    if (!path.startsWith(BASE) || missing.has(path)) return send(404, 'text/plain', 'not found');
    let file = resolve(dir, '.' + path.slice(BASE.length - 1));
    if (!file.startsWith(dir + sep) && file !== dir) return send(403, 'text/plain', 'forbidden');
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!path.endsWith('/')) return send(301, 'text/plain', '', { Location: path + '/' });
      file = join(file, 'index.html');
    }
    if (!existsSync(file)) return send(404, 'text/plain', 'not found');
    send(200, MIME[/** @type {keyof typeof MIME} */ (extname(file))] ?? 'application/octet-stream', readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => {
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    ok({ url: `http://127.0.0.1:${port}${BASE}`, log, close: () => new Promise((done) => server.close(() => done(undefined))) });
  }));
}

/** Open one page; returns the problems found. @param {any} page @param {any} site @param {string} path @param {{gallery?: string}} [o] */
async function visit(page, site, path, { gallery } = {}) {
  const problems = [];
  site.log.length = 0;
  page.clearLogs();
  await page.navigate(site.url + path);
  if (gallery) {
    const ok = await page.waitForFunction(`!!(window.__gallery && window.__gallery.ready && window.__gallery.active === ${JSON.stringify(gallery)})`, { timeout: 20000 }).then(() => true, () => false);
    if (!ok) problems.push(`the gallery did not become ready with ${gallery} active`);
    else if (gallery !== 'off' && (await page.evaluate('window.__gallery.mode')) !== 'effect') problems.push('the gallery is not on the WebGPU effect path, so the effect was not exercised');
    await H.sleep(1500);
  } else await H.sleep(2500);
  const canvas = await page.evaluate(`(() => {
    const all = [...document.querySelectorAll('canvas')].filter((c) => c.getBoundingClientRect().width > 0);
    if (!all.length) return null;
    const c = all.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    c.id ||= 'pages-check-canvas';
    c.scrollIntoView({ block: 'start' });
    return '#' + c.id;
  })()`);
  if (canvas) {
    await H.sleep(300);
    const { img } = await H.screenshotElement(page, canvas);
    if (!H.pixelStats(img).nonBlank) problems.push(`the canvas ${canvas} is blank`);
  } else if (!/examples\/$|examples\/index\.html$|^$/.test(path)) problems.push('no canvas on the page');
  for (const e of page.errors({ includeWarnings: false })) if (!/favicon/.test(e.text ?? '')) problems.push(`console: ${String(e.text).slice(0, 200)}`);
  for (const r of site.log) if (r.status >= 400) problems.push(`HTTP ${r.status} ${r.url}`);
  return problems;
}

const dir = mkdtempSync(join(tmpdir(), 'hic-pages-'));
let failed = 0;
try {
  execFileSync(process.execPath, [join(ROOT, 'scripts/build-pages.mjs'), `--out=${dir}`], { stdio: 'inherit' });
  const examples = readdirSync(join(dir, 'examples')).filter((n) => statSync(join(dir, 'examples', n)).isDirectory()).sort();
  const { plugins } = JSON.parse(readFileSync(join(dir, 'dist/plugins/manifest.json'), 'utf8'));
  const site = /** @type {any} */ (await serve(dir));
  const browser = await H.launchChrome({ name: 'pages-check', windowSize: [VIEW.width, VIEW.height + 100], dpr: 1, extraArgs: ['--headless=new', '--hide-scrollbars'] });
  browser.conn.sendTimeoutMs = 30000;
  try {
    const page = await browser.newPage();
    await page.send('Emulation.setDeviceMetricsOverride', { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, mobile: false });
    console.log(`Chrome ${browser.version?.Browser} (headless), site ${site.url}`);
    const pages = [
      { path: '', label: 'site root (redirects to examples/)' },
      { path: 'examples/', label: 'examples index' },
      ...examples.filter((n) => n !== 'plugins').map((n) => ({ path: `examples/${n}/`, label: n })),
      ...['off', ...plugins.map((/** @type {any} */ p) => p.name)].map((name) => ({ path: `examples/plugins/?effect=${name}`, label: `gallery: ${name}`, gallery: name })),
    ];
    for (const p of pages) {
      const problems = await visit(page, site, p.path, { gallery: p.gallery });
      if (p.path === '' && !(await page.evaluate('location.pathname')).endsWith('/examples/')) problems.push('the site root did not redirect to examples/');
      console.log(`${problems.length ? 'FAIL' : 'ok  '} ${p.label}${problems.length ? '  ' + problems.join(' | ') : ''}`);
      if (problems.length) failed += 1;
    }
    if (!process.argv.includes('--no-control')) {
      // control: the core bundle is missing from the site; the basic example must report it
      const broken = /** @type {any} */ (await serve(dir, new Set([`${BASE}dist/hic-live-polyfill.iife.min.js`])));
      try {
        const red = await visit(page, broken, 'examples/basic/');
        console.log(`${red.length ? 'ok  ' : 'FAIL'} control: with the core bundle missing the basic example fails (${red.length} problem(s))`);
        if (!red.length) failed += 1;
      } finally { await broken.close(); }
      const flat = { width: 64, height: 64, data: new Uint8Array(64 * 64 * 4).fill(255) };
      const blank = !H.pixelStats(flat).nonBlank;
      console.log(`${blank ? 'ok  ' : 'FAIL'} control: a flat image is classified blank`);
      if (!blank) failed += 1;
    }
  } finally {
    await browser.close().catch(() => browser.kill());
    await site.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `G-pages: FAILED (${failed})` : 'G-pages: OK');
process.exit(failed ? 1 : 0);
