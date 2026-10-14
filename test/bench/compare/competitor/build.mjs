#!/usr/bin/env node
// Builds the comparison subject `html-in-canvas-polyfill@1.0.1` (npm; a wrapper around three-html-render 0.1.2) as one classic
// script for the comparison runs in docs/COMPARISON.md and docs/PERFORMANCE-COMPARISON.md:
//   node test/bench/compare/competitor/build.mjs            installs the pinned package into .scratch/competitor/pkg (npm, --ignore-scripts)
//                                                           and writes .scratch/competitor/competitor-adapted.iife.js
//   node test/bench/compare/competitor/wpt.mjs [reps]       runs the official WPT subset (config B) against that file
// The file is the package's own classic build (three-html-render/dist/polyfill.js) byte for byte, wrapped so it installs once <html>
// exists (the WPT runner injects scripts before it), followed by ./adapter.js, which mirrors content="drawable" onto the
// `layoutsubtree` attribute the package expects. Neither the wrapper nor the adapter changes how the package renders.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const OUT = resolve(ROOT, '.scratch/competitor');
const PKG = resolve(OUT, 'pkg');
export const VERSION = '1.0.1';

mkdirSync(PKG, { recursive: true });
const polyfill = resolve(PKG, 'node_modules/three-html-render/dist/polyfill.js');
const installed = (() => { try { return JSON.parse(readFileSync(resolve(PKG, 'node_modules/html-in-canvas-polyfill/package.json'), 'utf8')).version; } catch { return null; } })();
if (installed !== VERSION || !existsSync(polyfill)) {
  writeFileSync(resolve(PKG, 'package.json'), JSON.stringify({ name: 'cmp', private: true }) + '\n');
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', `html-in-canvas-polyfill@${VERSION}`], { cwd: PKG, stdio: 'inherit' });
}
const prefix = '// Harness wrapper (ours): the WPT runner injects scripts at document start, before <html> exists; the competitor install observes\n'
  + '// document.documentElement and throws there. Defer it to the moment <html> is inserted (before any page script runs).\n'
  + '(function () { function __run() {\n';
const suffix = '} if (document.documentElement) __run(); else new MutationObserver(function (m, o) { if (document.documentElement) { o.disconnect(); __run(); } }).observe(document, { childList: true }); })();\n';
const file = resolve(OUT, 'competitor-adapted.iife.js');
writeFileSync(file, prefix + readFileSync(polyfill, 'utf8') + '\n' + readFileSync(resolve(HERE, 'adapter.js'), 'utf8') + suffix);
console.log(`wrote ${file} (html-in-canvas-polyfill@${VERSION})`);
