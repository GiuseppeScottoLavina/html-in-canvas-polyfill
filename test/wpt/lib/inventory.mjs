// Discover and classify the vendored WPT HTML-in-Canvas tests (test/vendor/wpt/html/canvas/**/draw-element-image).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { VENDOR_ROOT, MAIN_HOST, ALT_DOMAIN, substitute } from '../server.mjs';

const ROOTS = ['html/canvas/element/manual/draw-element-image', 'html/canvas/offscreen/manual/draw-element-image'];
const SKIP_DIRS = new Set(['resources', 'support']);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, out); } else if (e.name.endsWith('.html') && !/-ref\.html$/.test(e.name)) out.push(p);
  }
  return out;
}

/** `maxDifference=0-2;totalPixels=0-40`, `0-10;0-500`, `1;0-3900`, optionally prefixed `ref.html:` -> {ref?, maxDifference:[lo,hi], totalPixels:[lo,hi]}. */
export function parseFuzzy(content) {
  let ref = null; let body = content.trim();
  const m = body.match(/^([^=;]*?\.html?):(.*)$/); if (m) { ref = m[1]; body = m[2]; }
  const range = s => { const [a, b] = s.split('-').map(Number); return b === undefined ? [0, a] : [a, b]; };
  const out = { ref, maxDifference: [0, 0], totalPixels: [0, 0] };
  const bare = ['maxDifference', 'totalPixels'];
  for (const part of body.split(';').map(s => s.trim()).filter(Boolean)) {
    const kv = part.match(/^(maxDifference|totalPixels)=(.+)$/);
    if (kv) out[kv[1]] = range(kv[2]); else out[bare.shift()] = range(part);
  }
  return out;
}

function classify(text, file) {
  if (/\/resources\/testharness\.js/.test(text)) return 'testharness';
  if (/<link[^>]+rel=["']?(?:match|mismatch)/i.test(text)) return 'reftest';
  if (/-crash\./.test(file)) return 'crashtest';
  return 'other';
}

function metaList(text, name) {
  const re = new RegExp(`<meta\\s+name=["']?${name}["']?\\s+content=["']([^"']*)["']`, 'gi');
  return [...text.matchAll(re)].map(m => m[1]);
}

export function listTests() {
  const tests = [];
  for (const root of ROOTS) {
    for (const abs of walk(join(VENDOR_ROOT, root))) {
      const text = readFileSync(abs, 'utf8');
      const path = '/' + relative(VENDOR_ROOT, abs).split(sep).join('/');
      const type = classify(text, path);
      const refs = [...text.matchAll(/<link[^>]+rel=["']?(match|mismatch)["']?[^>]*>/gi)].map(m => {
        const href = m[0].match(/href=["']([^"']+)["']/i)?.[1];
        return { rel: m[1].toLowerCase(), href: href && posix.normalize(posix.join(posix.dirname(path), href)) };
      }).filter(r => r.href);
      tests.push({
        path, id: path.replace(/^\/html\/canvas\//, '').replace(/^(element|offscreen)\/manual\/draw-element-image\//, (a, g) => (g === 'offscreen' ? 'offscreen/' : '')),
        type, refs, fuzzy: metaList(text, 'fuzzy').map(parseFuzzy), long: metaList(text, 'timeout').includes('long'),
        privacy: /\/privacy\//.test(path), worker: root.includes('offscreen'), https: /\.https\./.test(path),
        waitsForReftest: /class=["']?reftest-wait/.test(text),
        // author-styled scrollbars are part of what the test checks: it runs with the platform scrollbars shown (every other test runs with --hide-scrollbars)
        scrollbars: /::-webkit-scrollbar/.test(text),
      });
    }
  }
  return tests;
}

/**
 * Same-server URLs that the tests reference and that do not exist upstream at the pinned commit either (wptserve answers 404 there too), with the reason.
 * Every other same-server reference must be vendored: a missing helper, image or frame makes a test pass or fail for the wrong reason (before 2026-10-22,
 * five images and a video the privacy tests load were missing, so those tests drew nothing where the upstream run draws a picture).
 */
export const ABSENT_UPSTREAM = {
  '/html/canvas/element/manual/draw-element-image/non-existent-image.gif': 'broken-image tests: a missing image on purpose',
  '/images/green-filter.svg': 'privacy/filtered-div-ref-external-svg-ignored: absent upstream',
  '/imagess/red-filter.svg': 'privacy/filtered-div-ref-external-svg-ignored: misspelt path upstream',
  '/wimages/blue-100x50-transparent-100x50.svg': 'privacy/fragment-mask-svg-ignored: misspelt path upstream',
};

/** @param {string} h */
const ours = h => [MAIN_HOST, ALT_DOMAIN].some(d => h === d || h.endsWith('.' + d));

/**
 * Every same-server URL referenced by a file of the vendored test directories (attributes, CSS url(), quoted absolute paths in scripts) that is not a vendored
 * file and not in ABSENT_UPSTREAM. URLs that do not parse after the wptserve substitution (an upstream typo such as a port followed by a path without '/')
 * cannot be fetched by a browser either and are skipped. @returns {{url: string, from: string[]}[]}
 */
export function missingResources() {
  const out = new Map();
  const files = [];
  const all = dir => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) all(p); else if (/\.(html?|svg|css|m?js)$/.test(e.name)) files.push(p); } };
  for (const root of ROOTS) all(join(VENDOR_ROOT, root));
  const re = /(?:\b(?:src|href|xlink:href|data|poster)\s*=\s*["']([^"']+)["'])|url\(\s*["']?([^"')]+?)["']?\s*\)|["'`]((?:https?:\/\/\{\{[^"'`]+)|\/(?:images|media|common|resources|html|fonts|css|dom)\/[^"'`\s]+)["'`]/g;
  for (const abs of files) {
    const rel = '/' + relative(VENDOR_ROOT, abs).split(sep).join('/');
    const text = readFileSync(abs, 'utf8');
    for (const m of text.matchAll(re)) {
      const raw = (m[1] ?? m[2] ?? m[3]).trim();
      if (!raw || /^(data:|#|blob:|about:|javascript:|mailto:)/.test(raw) || /\$\{|\s\+\s/.test(raw)) continue;
      let u; try { u = new URL(substitute(raw, 8443), `https://${MAIN_HOST}:8443${rel}`); } catch { continue; }
      if (!/^https?:$/.test(u.protocol) || !ours(u.hostname)) continue;
      const path = decodeURIComponent(u.pathname);
      if (path === rel || existsSync(join(VENDOR_ROOT, path)) || ABSENT_UPSTREAM[path]) continue;
      if (!out.has(path)) out.set(path, new Set());
      out.get(path).add(rel);
    }
  }
  return [...out].map(([url, from]) => ({ url, from: [...from].sort() })).sort((a, b) => a.url.localeCompare(b.url));
}

if (process.argv[1]?.endsWith('inventory.mjs') && process.argv.includes('--resources')) {
  const miss = missingResources();
  for (const m of miss) console.log(`missing ${m.url} <- ${m.from.join(', ')}`);
  console.log(miss.length ? `${miss.length} referenced resources are not vendored` : 'every same-server resource the tests reference is vendored (or absent upstream too)');
  process.exit(miss.length ? 1 : 0);
} else if (process.argv[1]?.endsWith('inventory.mjs')) {
  const t = listTests(); const by = {};
  for (const x of t) by[x.type] = (by[x.type] ?? 0) + 1;
  console.log(t.length, by, 'privacy', t.filter(x => x.privacy).length, 'worker', t.filter(x => x.worker).length);
}
