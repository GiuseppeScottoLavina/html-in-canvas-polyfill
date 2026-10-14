#!/usr/bin/env node
// G-plugins-e2e: every gallery end-to-end test of the example plugins (plugins/<name>/test/*.e2e.mjs), against the BUILT bundles.
//
//   npm run build && npm run test:plugins
//   node scripts/check-plugins-e2e.mjs [--only=crt,glitch] [--timeout=240]
//
// Each test opens examples/plugins/?effect=<name> in its own headless Chrome, drives it with trusted CDP input (clicks through the effect,
// typing, the frame cap, prefers-reduced-motion) and closes it. The tests run one after the other, never in parallel (one browser at a
// time); a test that does not finish within the timeout is killed with its browser and counts as failed. Every test has its own controls
// (see the file of each plugin).
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverPlugins } from '../plugins/_shared/contract.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (/** @type {string} */ name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = arg('only')?.split(',');
const timeoutMs = Number(arg('timeout') ?? 240) * 1000;

if (!existsSync(join(ROOT, 'dist/plugins/manifest.json'))) { console.error('dist/plugins/manifest.json is missing: run `npm run build` first.'); process.exit(2); }

const plugins = discoverPlugins(ROOT).filter((p) => !only || only.includes(p.name));
/** @type {{plugin: string, file: string}[]} */
const tests = plugins.flatMap((p) => (existsSync(join(p.dir, 'test')) ? readdirSync(join(p.dir, 'test')).filter((f) => f.endsWith('.e2e.mjs')).sort().map((f) => ({ plugin: p.name, file: join(p.dir, 'test', f) })) : []));
const without = plugins.filter((p) => !tests.some((t) => t.plugin === p.name)).map((p) => p.name);
if (!tests.length) { console.error('no plugin e2e test selected'); process.exit(2); }

/** @param {string} file @returns {Promise<{code: number|null, ms: number, timedOut: boolean, tail: string}>} */
function run(file) {
  return new Promise((done) => {
    const t0 = Date.now();
    // its own process group, so that a stuck test is killed together with the Chrome it launched
    const child = spawn(process.execPath, [file], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    const keep = (/** @type {Buffer} */ b) => { process.stdout.write(b); out = (out + b.toString()).slice(-4000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const killGroup = (/** @type {NodeJS.Signals} */ signal) => { try { process.kill(-(/** @type {number} */ (child.pid)), signal); } catch { /* already gone */ } };
    const timer = setTimeout(() => { timedOut = true; killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 3000); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); done({ code, ms: Date.now() - t0, timedOut, tail: out }); });
  });
}

const results = [];
for (const t of tests) {
  const rel = relative(ROOT, t.file);
  console.log(`\n=== ${t.plugin}: node ${rel}`);
  const r = await run(t.file);
  const ok = r.code === 0 && !r.timedOut;
  results.push({ plugin: t.plugin, file: rel, ok, seconds: Math.round(r.ms / 100) / 10, why: r.timedOut ? `timed out after ${timeoutMs / 1000} s` : r.code === 0 ? '' : `exit code ${r.code}` });
}

console.log('\nplugin gallery e2e:');
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.plugin.padEnd(14)} ${r.file}  (${r.seconds} s)${r.why ? '  ' + r.why : ''}`);
if (without.length) console.log(`no gallery e2e (covered by scripts/check-examples.mjs only): ${without.join(', ')}`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `G-plugins-e2e: FAILED (${failed.length} of ${results.length})` : `G-plugins-e2e: OK (${results.length} tests)`);
process.exit(failed.length ? 1 : 0);
