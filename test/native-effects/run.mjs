#!/usr/bin/env node
// G-native-effects suite: the effects extension over the browser's OWN HTML-in-Canvas implementation (Chrome Canary started with
// --enable-blink-features=CanvasDrawElement; the polyfill installed in mode native), against the BUILT bundles. One browser at a time:
//   1. G-native-effects       (headed gate, real + control) source pixels, typing, frame cap, off-screen pause, actions, device loss
//   2. G-native-interposer    (headed gate, real + control) trusted clicks and hover through a strong displacement (CRT, water)
//   3. the plugin gallery e2e of water and disintegrate (plugins/<name>/test/gallery.e2e.mjs, headless, HIC_E2E_NATIVE=1)
//   4. examples/effect-plugin (scripts/check-examples.mjs --only=effect-plugin --native, headless)
//
//   npm run build && npm run test:native-effects            [--only=gates,gallery,example] [--require-canary]
//
// Without Chrome Canary the suite is SKIPPED and says so loudly (exit 0, so machines without Canary, such as CI, stay green);
// --require-canary turns that into a failure.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChrome } from '../harness/lib/chrome.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',');
const want = (/** @type {string} */ part) => !only || only.includes(part);

let canary = null;
try { canary = resolveChrome('canary'); } catch { /* not installed */ }
if (!canary) {
  const line = '='.repeat(100);
  console.log(`${line}\nG-native-effects: SKIPPED - Chrome Canary is not installed here, so the effects over a native implementation were NOT tested.\n${line}`);
  process.exit(process.argv.includes('--require-canary') ? 1 : 0);
}
if (!existsSync(resolve(ROOT, 'dist/plugins/manifest.json'))) { console.error('dist/ is missing: run `npm run build` first.'); process.exit(2); }

/** @type {Array<[string, string, string[], Record<string, string>]>} */
const stages = [];
if (want('gates')) {
  stages.push(['gates', 'G-native-effects', ['test/native-effects/g-native-effects.mjs'], {}]);
  stages.push(['gates', 'G-native-interposer', ['test/native-effects/g-native-interposer.mjs'], {}]);
}
if (want('gallery')) {
  for (const name of ['water', 'disintegrate']) stages.push(['gallery', `gallery e2e: ${name}`, [`plugins/${name}/test/gallery.e2e.mjs`], { HIC_E2E_NATIVE: '1' }]);
}
if (want('example')) stages.push(['example', 'examples/effect-plugin', ['scripts/check-examples.mjs', '--only=effect-plugin', '--native', '--no-control'], {}]);

console.log(`G-native-effects: Chrome Canary at ${canary}`);
const rows = [];
for (const [, what, args, env] of stages) {
  console.log(`\n=== ${what}: node ${args.join(' ')}`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env }, timeout: 1800000 });
  rows.push({ what, result: r.status === 0 ? 'PASS' : `FAIL (exit ${r.status ?? r.signal})`, seconds: Math.round((Date.now() - t0) / 1000) });
}
console.log('\nG-native-effects:');
console.table(rows);
const failed = rows.filter((r) => r.result !== 'PASS');
console.log(failed.length ? `G-native-effects: FAILED (${failed.length} of ${rows.length})` : `G-native-effects: OK (${rows.length} stages)`);
process.exit(failed.length ? 1 : 0);
