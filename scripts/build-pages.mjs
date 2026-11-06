#!/usr/bin/env node
// Assembles the GitHub Pages site (the live demo) from the built bundles and the examples:
//   npm run build && node scripts/build-pages.mjs [--out=_site]
// Layout: <out>/index.html (redirects to examples/), <out>/examples/index.html (the landing page), <out>/examples/<name>/,
// <out>/examples/assets/ (the landing's screenshot and the social preview image), <out>/sitemap.xml (the canonical public pages),
// <out>/dist/*.iife(.min).js and <out>/dist/plugins/ (the plugin bundles and manifest.json, read by the plugin gallery). The examples load
// ../../dist/*, so the site works under any base path; the canonical links, the Open Graph image and the sitemap name the public site, SITE.
// Files in examples/assets/site-root/ (a search engine's verification file, for example) are copied to the site root instead, and a
// google-site-verification meta tag of examples/index.html is repeated in the generated root page, so both survive every deploy.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? '_site');
const EXAMPLES = ['basic', 'form', 'plugins', 'effect-plugin', 'scroll-and-resize', 'webgl-texture', 'playground', 'field-test'];
/** The public address of the site (GitHub Pages of the repository): canonical links and the sitemap name it. */
const SITE = 'https://giuseppescottolavina.github.io/html-in-canvas-polyfill/';
const ASSETS = join(root, 'examples/assets');
const SITE_ROOT_FILES = join(ASSETS, 'site-root');

const dist = join(root, 'dist');
const bundles = existsSync(dist) ? readdirSync(dist).filter((f) => /\.iife(\.min)?\.js$/.test(f)) : [];
const pluginFiles = existsSync(join(dist, 'plugins')) ? readdirSync(join(dist, 'plugins')).filter((f) => /\.iife(\.min)?\.js$|^manifest\.json$/.test(f)) : [];
if (!bundles.includes('hic-live-polyfill.iife.min.js') || !pluginFiles.includes('manifest.json')) {
  console.error('dist/ is missing or incomplete: run `npm run build` first.');
  process.exit(2);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'dist'), { recursive: true });
for (const f of bundles) cpSync(join(dist, f), join(out, 'dist', f));
mkdirSync(join(out, 'dist/plugins'), { recursive: true });
for (const f of pluginFiles) cpSync(join(dist, 'plugins', f), join(out, 'dist/plugins', f));
const landing = readFileSync(join(root, 'examples/index.html'), 'utf8');
cpSync(join(root, 'examples/index.html'), join(out, 'examples/index.html'));
for (const name of EXAMPLES) cpSync(join(root, 'examples', name), join(out, 'examples', name), { recursive: true });
// the landing's images (copied explicitly: the site holds only what this script puts there)
if (existsSync(ASSETS)) cpSync(ASSETS, join(out, 'examples/assets'), { recursive: true, filter: (src) => src !== SITE_ROOT_FILES });
const rootFiles = existsSync(SITE_ROOT_FILES) ? readdirSync(SITE_ROOT_FILES).filter((f) => !f.startsWith('.')) : [];
for (const f of rootFiles) cpSync(join(SITE_ROOT_FILES, f), join(out, f));
const verification = landing.match(/<meta name="google-site-verification" content="[^"<>]*">/g) ?? [];
writeFileSync(join(out, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<meta http-equiv="refresh" content="0; url=examples/">
<link rel="canonical" href="${SITE}examples/">
${verification.map((m) => m + '\n').join('')}<title>HTML-in-Canvas Polyfill</title>
</head>
<body>
<p><a href="examples/">HTML-in-Canvas Polyfill: introduction and demos</a></p>
</body>
</html>
`);
// the canonical public pages: the landing first, then each example (no lastmod: the build does not know when a page last changed)
const pages = ['examples/', ...['plugins', 'playground', ...EXAMPLES.filter((n) => n !== 'plugins' && n !== 'playground')].map((n) => `examples/${n}/`)];
writeFileSync(join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((p) => `  <url><loc>${SITE}${p}</loc></url>\n`).join('')}</urlset>
`);
console.log(`pages site written to ${out}: ${bundles.length} bundles, ${pluginFiles.length} files in dist/plugins, ${EXAMPLES.length} examples, ${pages.length} pages in sitemap.xml${rootFiles.length ? `, ${rootFiles.length} file(s) at the site root` : ''}`);
