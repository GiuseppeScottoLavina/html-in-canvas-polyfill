#!/usr/bin/env node
// Assembles the GitHub Pages site (the live demo) from the built bundles and the examples:
//   npm run build && node scripts/build-pages.mjs [--out=_site]
// Layout: <out>/index.html (redirects to examples/), <out>/examples/<name>/, <out>/dist/*.iife(.min).js and <out>/dist/plugins/ (the plugin
// bundles and manifest.json, read by the plugin gallery). The examples load
// ../../dist/*, so the site works under any base path, such as https://<user>.github.io/html-in-canvas-polyfill/.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? '_site');
const EXAMPLES = ['basic', 'form', 'plugins', 'effect-plugin', 'scroll-and-resize', 'webgl-texture', 'playground', 'field-test'];

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
cpSync(join(root, 'examples/index.html'), join(out, 'examples/index.html'));
for (const name of EXAMPLES) cpSync(join(root, 'examples', name), join(out, 'examples', name), { recursive: true });
writeFileSync(join(out, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<meta http-equiv="refresh" content="0; url=examples/">
<link rel="canonical" href="examples/">
<title>html-in-canvas-polyfill</title>
</head>
<body>
<p><a href="examples/">html-in-canvas-polyfill examples</a></p>
</body>
</html>
`);
console.log(`pages site written to ${out}: ${bundles.length} bundles, ${pluginFiles.length} files in dist/plugins, ${EXAMPLES.length} examples`);
