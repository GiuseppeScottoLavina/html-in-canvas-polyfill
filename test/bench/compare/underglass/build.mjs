#!/usr/bin/env node
// Fetches the comparison subject `@underglass/html-in-canvas-polyfill` (npm) for the runs in README.md ("Compared with the alternatives") and
// docs/PERFORMANCE-COMPARISON.md:
//   node test/bench/compare/underglass/build.mjs            installs the pinned package into .scratch/underglass/pkg (npm, --ignore-scripts) and copies its
//                                                           classic builds to .scratch/underglass/ (page and worker), byte for byte
//   node test/bench/compare/underglass/wpt.mjs [reps]       runs the official WPT subset (configuration B) against them
// The package implements the current API (content="drawable", paint, drawElementImage), so it runs as published: no adapter and no wrapper. Its page build
// installs itself when it loads; on Chrome 157 with CanvasDrawElement switched off (the harness) it finds no native implementation and installs.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const OUT = resolve(ROOT, '.scratch/underglass');
const PKG = resolve(OUT, 'pkg');
export const VERSION = '0.5.0';
export const PAGE_FILE = resolve(OUT, 'html-in-canvas-polyfill.iife.js');
export const WORKER_FILE = resolve(OUT, 'html-in-canvas-polyfill.worker.iife.js');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(PKG, { recursive: true });
  const dist = resolve(PKG, 'node_modules/@underglass/html-in-canvas-polyfill/dist');
  const installed = (() => { try { return JSON.parse(readFileSync(resolve(PKG, 'node_modules/@underglass/html-in-canvas-polyfill/package.json'), 'utf8')).version; } catch { return null; } })();
  if (installed !== VERSION || !existsSync(resolve(dist, 'html-in-canvas-polyfill.iife.js'))) {
    writeFileSync(resolve(PKG, 'package.json'), JSON.stringify({ name: 'cmp', private: true }) + '\n');
    execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', `@underglass/html-in-canvas-polyfill@${VERSION}`], { cwd: PKG, stdio: 'inherit' });
  }
  copyFileSync(resolve(dist, 'html-in-canvas-polyfill.iife.js'), PAGE_FILE);
  copyFileSync(resolve(dist, 'html-in-canvas-polyfill.worker.iife.js'), WORKER_FILE);
  console.log(`wrote ${PAGE_FILE} and ${WORKER_FILE} (@underglass/html-in-canvas-polyfill@${VERSION})`);
}
