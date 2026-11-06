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
// blank (compositor screenshot); on the playground, whose canvas is in a sandboxed frame, the status line must report the install and the canvas in the frame (an element screenshot of the frame, cropped) must not be blank. Controls: the same site with the core bundle missing must fail, and a flat image must be blank.
//
// Before the browser, over HTTP on the same server (the public address SITE mapped onto it), the search and sharing metadata of the built site:
//   - metadata: the landing (examples/), the gallery (also as ?effect=water) and the playground have one absolute canonical, the page's own public
//     address (a query variant of the gallery names the gallery), a title and a description, Open Graph and twitter:card summary_large_image;
//     the landing has its SoftwareSourceCode JSON-LD; the root names examples/ as its canonical; every canonical answers 200;
//   - og-image: every og:image answers 200 as a PNG under 1 MB, 1280 x 640, as its og:image:width and og:image:height say;
//   - sitemap: sitemap.xml lists absolute addresses under SITE, without query or duplicates, each answering 200, the three pages above included;
//   - noindex: no page of the site (the root, every example, every sitemap address) has a robots or googlebot meta tag or an X-Robots-Tag
//     header with noindex or none;
//   - redirect: the root reaches examples/ in at most 5 redirects, none of them back to an address already visited;
//   - snippet-version: the landing's CDN snippet names the package version; verification: a google-site-verification meta tag of the landing
//     is also in the root page.
// Each of these checks has a control: the same site with one file edited so that the check must fail (CONTROLS below).
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as H from '../test/harness/index.mjs';

/** The public address of the site; scripts/build-pages.mjs writes the same one into the root page and the sitemap. */
const SITE = 'https://giuseppescottolavina.github.io/html-in-canvas-polyfill/';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (H.arg('base') ?? '/html-in-canvas-polyfill/').replace(/\/?$/, '/');
const VIEW = { width: 1200, height: 1300 };
const MIME = { '.xml': 'application/xml', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.md': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

if (!existsSync(join(ROOT, 'dist/plugins/manifest.json'))) { console.error('dist/ is missing: run `npm run build` first.'); process.exit(2); }

/**
 * A static server of `dir` under BASE only; `missing` paths answer 404 and `overrides` replace a path's body, type or headers (the controls).
 * @param {string} dir @param {{missing?: Set<string>, overrides?: Record<string, {body?: string|Buffer, type?: string, headers?: Record<string, string>}>}} [o]
 */
function serve(dir, { missing = new Set(), overrides = {} } = {}) {
  /** @type {{url: string, status: number}[]} */ const log = [];
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    // Access-Control-Allow-Origin: * as GitHub Pages sends it (the playground's opaque-origin preview loads the bundles with CORS)
    const send = (/** @type {number} */ status, /** @type {string} */ type, /** @type {any} */ body, headers = {}) => { log.push({ url: path, status }); res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', ...headers }); res.end(body); };
    if (path === '/favicon.ico') return send(204, 'image/x-icon', '');
    if (!path.startsWith(BASE) || missing.has(path)) return send(404, 'text/plain', 'not found');
    const over = overrides[path];
    let file = resolve(dir, '.' + path.slice(BASE.length - 1));
    if (!file.startsWith(dir + sep) && file !== dir) return send(403, 'text/plain', 'forbidden');
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!path.endsWith('/')) return send(301, 'text/plain', '', { Location: path + '/' });
      file = join(file, 'index.html');
    }
    if (!existsSync(file) && !over?.body) return send(404, 'text/plain', 'not found');
    send(200, over?.type ?? MIME[/** @type {keyof typeof MIME} */ (extname(file))] ?? 'application/octet-stream', over?.body ?? readFileSync(file), over?.headers ?? {});
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => {
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    // close() waits for every open connection: a keep-alive socket the page still held kept it waiting until the CI job timed out (macOS runner, 2026-10-27,
    // after the control page). The harness server (test/harness/server.mjs) drops them the same way
    ok({ url: `http://127.0.0.1:${port}${BASE}`, dir, log, close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done(undefined)); }) });
  }));
}

/**
 * The canvas box inside the playground's preview frame (css px of the frame), or null. Chrome runs the sandboxed frame (opaque origin) out of process:
 * attach to its target, the child of this page. @param {any} page
 */
async function previewCanvasBox(page) {
  const { targetInfos } = await page.conn.send('Target.getTargets');
  const child = targetInfos.find((/** @type {any} */ t) => t.type === 'iframe' && t.parentFrameId === page.targetId);
  if (!child) return null;
  const { sessionId } = await page.conn.send('Target.attachToTarget', { targetId: child.targetId, flatten: true });
  try {
    const r = await page.conn.send('Runtime.evaluate', { expression: `(() => { const c = document.querySelector('canvas'); if (!c) return null; const b = c.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })()`, returnByValue: true }, sessionId);
    return r.result?.value ?? null;
  } finally { await page.conn.send('Target.detachFromTarget', { sessionId }).catch(() => {}); }
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
  } else if (await page.evaluate(`!!document.querySelector('iframe#preview[sandbox]')`)) {
    // the playground: the canvas is inside its sandboxed preview frame; the status line reports the install, the frame's screenshot must not be blank
    const installed = await page.waitForFunction(`['polyfill', 'native'].includes(document.getElementById('status').dataset.state)`, { timeout: 15000 }).then(() => true, () => false);
    if (!installed) problems.push(`the playground preview did not install: ${await page.evaluate(`document.getElementById('status').textContent`)}`);
    await H.sleep(500);
    const box = await previewCanvasBox(page);
    if (!box) problems.push('the playground preview has no canvas');
    else {
      const { img } = await H.screenshotElement(page, '#preview');
      const x = Math.max(0, Math.round(box.x)), y = Math.max(0, Math.round(box.y));
      const canvasImg = H.cropImage(img, x, y, Math.min(Math.round(box.w), img.width - x), Math.min(Math.round(box.h), img.height - y));
      if (!H.pixelStats(canvasImg).nonBlank) problems.push('the playground preview canvas is blank');
    }
  } else if (!/examples\/$|examples\/index\.html$|^$/.test(path)) problems.push('no canvas on the page');
  for (const e of page.errors({ includeWarnings: false })) if (!/favicon/.test(e.text ?? '')) problems.push(`console: ${String(e.text).slice(0, 200)}`);
  for (const r of site.log) if (r.status >= 400) problems.push(`HTTP ${r.status} ${r.url}`);
  return problems;
}

// ---- search and sharing metadata, over HTTP -------------------------------------------------------------------------------------------
const PKG_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const NPM_PAGE = 'https://www.npmjs.com/package/@giuseppe-scotto-lavina/html-in-canvas-polyfill';
/** The pages with their own search metadata: path on the site, and the canonical (relative to SITE) it must name. */
const MAIN = [
  { path: 'examples/', canonical: 'examples/', jsonLd: true },
  { path: 'examples/plugins/', canonical: 'examples/plugins/' },
  { path: 'examples/plugins/?effect=water', canonical: 'examples/plugins/' },
  { path: 'examples/playground/', canonical: 'examples/playground/' },
];
const MAX_IMAGE_BYTES = 1000 * 1000;   // GitHub's social preview limit, "under 1 MB"

/** GET a site path (redirects not followed). @param {any} site @param {string} path */
async function get(site, path) {
  const r = await fetch(site.url + path, { redirect: 'manual' });
  const body = Buffer.from(await r.arrayBuffer());
  return { status: r.status, headers: r.headers, body, text: body.toString('utf8') };
}
/** The site path of a public address, or null when it is not under SITE. @param {string} url */
const sitePath = (url) => url.startsWith(SITE) ? url.slice(SITE.length) : null;
/** The attributes of every `<tag ...>` in html, as objects. @param {string} html @param {string} tag */
function tags(html, tag) {
  return [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'gi'))].map((m) => Object.fromEntries([...m[1].matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)].map((a) => [a[1].toLowerCase(), a[2]])));
}
/** The content of the meta tags with this name or property. @param {string} html @param {string} key */
const metas = (html, key) => tags(html, 'meta').filter((m) => m.name === key || m.property === key).map((m) => m.content ?? '');
/** The width and height of a PNG from its IHDR, or null. @param {Buffer} buf */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** @type {Record<string, (site: any) => Promise<string[]>>} */
const SITE_CHECKS = {
  async metadata(site) {
    const p = [];
    for (const m of MAIN) {
      const r = await get(site, m.path);
      if (r.status !== 200) { p.push(`${m.path}: HTTP ${r.status}`); continue; }
      const canon = tags(r.text, 'link').filter((l) => l.rel === 'canonical').map((l) => l.href);
      if (canon.length !== 1 || canon[0] !== SITE + m.canonical) p.push(`${m.path}: canonical ${JSON.stringify(canon)}, expected exactly ${SITE + m.canonical}`);
      const titles = [...r.text.matchAll(/<title>([^<]*)<\/title>/g)].map((t) => t[1]);
      if (titles.length !== 1 || !/HTML-in-Canvas Polyfill/.test(titles[0])) p.push(`${m.path}: title ${JSON.stringify(titles)} (one, naming the project)`);
      const one = (/** @type {string} */ key) => { const v = metas(r.text, key); if (v.length !== 1 || !v[0].trim()) p.push(`${m.path}: ${key} ${JSON.stringify(v)} (exactly one, not empty)`); return v[0] ?? ''; };
      one('description'); one('og:title'); one('og:description'); one('og:image:alt'); one('twitter:card');
      if (one('og:type') !== 'website') p.push(`${m.path}: og:type is not website`);
      if (one('og:url') !== SITE + m.canonical) p.push(`${m.path}: og:url is not the canonical`);
      if (!sitePath(one('og:image'))) p.push(`${m.path}: og:image is not an absolute address under ${SITE}`);
      if (metas(r.text, 'twitter:card')[0] !== 'summary_large_image') p.push(`${m.path}: twitter:card is not summary_large_image`);
      if (m.jsonLd) {
        const blocks = [...r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((b) => { try { return JSON.parse(b[1]); } catch { return null; } });
        const code = blocks.find((b) => b && b['@type'] === 'SoftwareSourceCode');
        if (!code) p.push(`${m.path}: no parseable SoftwareSourceCode JSON-LD block`);
        else {
          for (const k of ['name', 'description', 'codeRepository', 'programmingLanguage', 'license']) if (typeof code[k] !== 'string' || !code[k]) p.push(`${m.path}: JSON-LD ${k} missing`);
          if (!/^https:\/\/github\.com\//.test(code.codeRepository ?? '')) p.push(`${m.path}: JSON-LD codeRepository is not the GitHub repository`);
          if (![code.url, ...[code.sameAs ?? []].flat()].includes(NPM_PAGE)) p.push(`${m.path}: JSON-LD names the npm package neither as url nor in sameAs`);
        }
      }
    }
    const root = await get(site, '');
    const rootCanon = tags(root.text, 'link').filter((l) => l.rel === 'canonical').map((l) => l.href);
    if (rootCanon.length !== 1 || rootCanon[0] !== SITE + 'examples/') p.push(`site root: canonical ${JSON.stringify(rootCanon)}, expected ${SITE}examples/`);
    for (const c of new Set(MAIN.map((m) => m.canonical))) { const r = await get(site, c); if (r.status !== 200) p.push(`canonical ${c}: HTTP ${r.status}`); }
    return p;
  },
  async 'og-image'(site) {
    const p = [];
    /** @type {Map<string, {w: string, h: string, from: string}>} */ const images = new Map();
    for (const m of MAIN) {
      const html = (await get(site, m.path)).text;
      for (const url of metas(html, 'og:image')) images.set(url, { w: metas(html, 'og:image:width')[0], h: metas(html, 'og:image:height')[0], from: m.path });
    }
    if (!images.size) p.push('no og:image on the pages');
    for (const [url, d] of images) {
      const path = sitePath(url);
      if (path === null) { p.push(`${url}: not under ${SITE}`); continue; }
      const r = await get(site, path);
      const size = pngSize(r.body);
      if (r.status !== 200) p.push(`${url}: HTTP ${r.status}`);
      else if (!/^image\/png/.test(r.headers.get('content-type') ?? '') || !size) p.push(`${url}: not served as a PNG`);
      else {
        if (r.body.length >= MAX_IMAGE_BYTES) p.push(`${url}: ${r.body.length} bytes, the limit is under ${MAX_IMAGE_BYTES}`);
        if (size.width !== 1280 || size.height !== 640) p.push(`${url}: ${size.width} x ${size.height}, expected 1280 x 640`);
        if (String(size.width) !== d.w || String(size.height) !== d.h) p.push(`${url}: og:image:width/height ${d.w} x ${d.h} on ${d.from}, the image is ${size.width} x ${size.height}`);
      }
    }
    return p;
  },
  async sitemap(site) {
    const p = [];
    const r = await get(site, 'sitemap.xml');
    if (r.status !== 200) return [`sitemap.xml: HTTP ${r.status}`];
    if (!/<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/.test(r.text)) p.push('sitemap.xml: no urlset of the sitemap namespace');
    const locs = [...r.text.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
    if (new Set(locs).size !== locs.length) p.push('sitemap.xml: duplicate addresses');
    for (const m of MAIN) if (!locs.includes(SITE + m.canonical)) p.push(`sitemap.xml: ${SITE + m.canonical} is missing`);
    for (const loc of locs) {
      const path = sitePath(loc);
      if (path === null || /[?#]/.test(loc)) { p.push(`sitemap.xml: ${loc} is not a plain address under ${SITE}`); continue; }
      const page = await get(site, path);
      if (page.status !== 200) p.push(`sitemap.xml: ${loc} answers HTTP ${page.status}`);
      const canon = tags(page.text, 'link').filter((l) => l.rel === 'canonical').map((l) => l.href);
      if (canon.length && canon[0] !== loc) p.push(`sitemap.xml: ${loc} names another canonical, ${canon[0]}`);
    }
    return p;
  },
  async noindex(site) {
    const p = [];
    const sm = (await get(site, 'sitemap.xml')).text;
    const examples = readdirSync(join(site.dir, 'examples')).filter((n) => statSync(join(site.dir, 'examples', n)).isDirectory() && existsSync(join(site.dir, 'examples', n, 'index.html')));
    const paths = new Set(['', 'examples/', ...examples.map((n) => `examples/${n}/`), ...MAIN.map((m) => m.path),
      ...[...sm.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => sitePath(m[1])).filter((x) => x !== null)]);
    for (const path of paths) {
      const r = await get(site, /** @type {string} */ (path));
      const header = r.headers.get('x-robots-tag') ?? '';
      if (/noindex|none/i.test(header)) p.push(`${path || 'site root'}: X-Robots-Tag ${header}`);
      for (const key of ['robots', 'googlebot']) for (const c of metas(r.text, key)) if (/noindex|none/i.test(c)) p.push(`${path || 'site root'}: meta ${key} ${c}`);
    }
    return p;
  },
  async redirect(site) {
    let url = site.url;
    const seen = [url];
    for (let hop = 0; hop <= 5; hop++) {
      const r = await fetch(url, { redirect: 'manual' });
      const text = await r.text();
      let next = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
      if (!next) next = tags(text, 'meta').find((m) => (m['http-equiv'] ?? '').toLowerCase() === 'refresh')?.content?.match(/url=(.*)$/i)?.[1]?.trim() ?? null;
      if (!next) return r.status === 200 && new URL(url).pathname === `${BASE}examples/` ? [] : [`the redirects from the root end at ${url} (HTTP ${r.status}), not at ${BASE}examples/`];
      url = new URL(next, url).href;
      if (seen.includes(url)) return [`redirect loop: ${[...seen, url].join(' -> ')}`];
      seen.push(url);
    }
    return [`more than 5 redirects from the root: ${seen.join(' -> ')}`];
  },
  async 'snippet-version'(site) {
    const versions = [...(await get(site, 'examples/')).text.matchAll(/html-in-canvas-polyfill@([0-9A-Za-z.-]+)\//g)].map((m) => m[1]);
    if (!versions.length) return ['the landing names no package version in its CDN snippet'];
    return versions.filter((v) => v !== PKG_VERSION).map((v) => `the landing's CDN snippet names ${v}, the package is ${PKG_VERSION}`);
  },
  async verification(site) {
    const root = (await get(site, '')).text;
    return metas((await get(site, 'examples/')).text, 'google-site-verification').filter((c) => !metas(root, 'google-site-verification').includes(c))
      .map((c) => `the google-site-verification tag ${c} of the landing is not in the root page`);
  },
};

/**
 * One control per site check: a file of the built site served with one edit (anchor -> replacement; the anchor must occur exactly once),
 * or replaced, so that the check must report a problem.
 * @type {{check: string, what: string, path: string, edit?: [string, string], body?: (dir: string) => string|Buffer, headers?: Record<string, string>}[]}
 */
const CONTROLS = [
  { check: 'metadata', what: 'the gallery names its ?effect=water variant as canonical', path: 'examples/plugins/index.html', edit: [`<link rel="canonical" href="${SITE}examples/plugins/">`, `<link rel="canonical" href="${SITE}examples/plugins/?effect=water">`] },
  { check: 'metadata', what: 'the playground has no og:image', path: 'examples/playground/index.html', edit: [`<meta property="og:image" content="${SITE}examples/assets/social-preview-chrome-capture.png">`, ''] },
  { check: 'og-image', what: 'the social image is 64 x 64', path: 'examples/assets/social-preview-chrome-capture.png', body: () => H.encodePng({ width: 64, height: 64, data: new Uint8Array(64 * 64 * 4).fill(200) }) },
  { check: 'sitemap', what: 'the sitemap lists a page that does not exist', path: 'sitemap.xml', edit: ['</urlset>', `  <url><loc>${SITE}examples/no-such-page/</loc></url>\n</urlset>`] },
  { check: 'noindex', what: 'the landing has a robots noindex meta tag', path: 'examples/index.html', edit: ['<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="robots" content="noindex">'] },
  { check: 'noindex', what: 'the gallery is served with X-Robots-Tag: noindex', path: 'examples/plugins/index.html', headers: { 'X-Robots-Tag': 'noindex' } },
  { check: 'redirect', what: 'the root redirects to itself', path: 'index.html', edit: ['content="0; url=examples/"', 'content="0; url=./"'] },
  { check: 'snippet-version', what: 'the landing names an older version', path: 'examples/index.html', edit: [`html-in-canvas-polyfill@${PKG_VERSION}/`, 'html-in-canvas-polyfill@0.1.0-preview.1/'] },
  { check: 'verification', what: 'the landing has a verification tag that the root lacks', path: 'examples/index.html', edit: ['<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="google-site-verification" content="control-token">'] },
];

/** The server path and override of one control, or an Error (anchor drift). @param {string} dir @param {typeof CONTROLS[number]} c */
function controlOverride(dir, c) {
  const urlPath = BASE + c.path.replace(/(^|\/)index\.html$/, '$1');
  const file = join(dir, c.path);
  const type = MIME[/** @type {keyof typeof MIME} */ (extname(file))];
  if (c.body) return { [urlPath]: { body: c.body(dir), type } };
  if (!c.edit) return { [urlPath]: { headers: c.headers } };
  const text = readFileSync(file, 'utf8');
  const n = text.split(c.edit[0]).length - 1;
  if (n !== 1) return new Error(`ANCHOR DRIFT: the anchor of the control "${c.what}" occurs ${n} times in ${c.path}`);
  return { [urlPath]: { body: text.replace(c.edit[0], c.edit[1]), type, headers: c.headers } };
}

const dir = mkdtempSync(join(tmpdir(), 'hic-pages-'));
let failed = 0;
try {
  execFileSync(process.execPath, [join(ROOT, 'scripts/build-pages.mjs'), `--out=${dir}`], { stdio: 'inherit' });
  const examples = readdirSync(join(dir, 'examples')).filter((n) => existsSync(join(dir, 'examples', n, 'index.html'))).sort();   // the pages (examples/assets is not one)
  const { plugins } = JSON.parse(readFileSync(join(dir, 'dist/plugins/manifest.json'), 'utf8'));
  const site = /** @type {any} */ (await serve(dir));
  try {
    for (const [name, check] of Object.entries(SITE_CHECKS)) {
      const problems = await check(site);
      console.log(`${problems.length ? 'FAIL' : 'ok  '} ${name}${problems.length ? '  ' + problems.join(' | ') : ''}`);
      if (problems.length) failed += 1;
    }
    if (!process.argv.includes('--no-control')) for (const c of CONTROLS) {
      const overrides = controlOverride(dir, c);
      if (overrides instanceof Error) { console.log(`FAIL control (${c.check}): ${overrides.message}`); failed += 1; continue; }
      const broken = /** @type {any} */ (await serve(dir, { overrides }));
      try {
        const red = await SITE_CHECKS[c.check](broken);
        console.log(`${red.length ? 'ok  ' : 'FAIL'} control (${c.check}): ${c.what}: ${red.length ? red[0] : 'NOT caught'}`);
        if (!red.length) failed += 1;
      } finally { await broken.close(); }
    }
  } catch (e) { await site.close(); throw e; }
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
      const broken = /** @type {any} */ (await serve(dir, { missing: new Set([`${BASE}dist/hic-live-polyfill.iife.min.js`]) }));
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
