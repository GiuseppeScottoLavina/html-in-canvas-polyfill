// Discover and classify the vendored WPT HTML-in-Canvas tests (test/vendor/wpt/html/canvas/**/draw-element-image).
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { VENDOR_ROOT } from '../server.mjs';

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

if (process.argv[1]?.endsWith('inventory.mjs')) {
  const t = listTests(); const by = {};
  for (const x of t) by[x.type] = (by[x.type] ?? 0) + 1;
  console.log(t.length, by, 'privacy', t.filter(x => x.privacy).length, 'worker', t.filter(x => x.worker).length);
}
