#!/usr/bin/env node
// Run the vendored official WPT HTML-in-Canvas tests in ONE configuration and write the raw per-run results.
//   node test/wpt/run.mjs --config=A|B|C [--reps=3] [--filter=text] [--only=id,id] [--no-privacy] [--out=file.json]
// A = oracle (Canary native), B = subject (Chrome stable + dist/hic-live-polyfill.iife.js), C = control (stable alone).
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PROJECT_ROOT, sleep } from '../harness/lib/util.mjs';
import { startWptServer } from './server.mjs';
import { listTests } from './lib/inventory.mjs';
import { Session, CONFIGS } from './lib/session.mjs';
import { runOne, filePasses } from './lib/run-one.mjs';

export const RESULTS_DIR = resolve(PROJECT_ROOT, '.scratch/results');
export const RUNNER_VERSION = 1;
/** Whole-configuration watchdog: a run that is still going after this long is killed (the harness exit handler terminates our own Chrome only). */
const WATCHDOG_MS = 40 * 60 * 1000;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

const signature = r => `${r.status}|${r.subtests.map(s => `${s.name}=${s.status}`).join(',')}`;

function load1m() { try { return Number(execFileSync('sysctl', ['-n', 'vm.loadavg'], { encoding: 'utf8' }).trim().replace(/[{}]/g, '').split(/\s+/)[0]); } catch { return 0; } }

async function waitForLoad(maxMin = 10) {
  const t0 = Date.now();
  while (load1m() >= 6 && Date.now() - t0 < maxMin * 60000) await sleep(15000);
  return load1m();
}

export function selectTests(args) {
  let tests = listTests();
  if (args.noPrivacy) tests = tests.filter(t => !t.privacy);
  if (args.only) { const ids = new Set(args.only.split(',')); tests = tests.filter(t => ids.has(t.id)); }
  if (args.filter) tests = tests.filter(t => t.id.includes(args.filter));
  return tests;
}

/** Run `tests` in `config`; returns the result document. */
export async function runConfig(configId, tests, { reps = 3, log = console.log, polyfillFile, shotRoot, relaxed = false } = {}) {
  const config = CONFIGS[configId]; if (!config) throw new Error('unknown config ' + configId);
  const load = await waitForLoad();
  const watchdog = setTimeout(() => { console.error(`WATCHDOG: configuration ${configId} ran longer than ${WATCHDOG_MS / 60000} min`); process.exit(3); }, WATCHDOG_MS);
  const server = await startWptServer();
  let session = await new Session(config, polyfillFile ? { polyfillFile } : {}).start();
  const doc = { runnerVersion: RUNNER_VERSION, config: session.info(), startedAt: new Date().toISOString(), loadAtStart: load, reps, tests: {} };
  const restart = async () => { await session.stop(); session = await new Session(config, polyfillFile ? { polyfillFile } : {}).start(); };
  try {
    let i = 0;
    for (const test of tests) {
      i++; const runs = [];
      for (let rep = 0; rep < reps; rep++) {
        let r;
        try { r = await runOne(session, server.origin, relaxed ? { ...test, path: test.path + '?relax=1' } : test, { shotDir: shotRoot && rep === 0 ? `${shotRoot}/${test.id.replace(/[^\w.-]+/g, '_')}` : null }); }
        catch (e) { r = { status: 'RUNNER_ERROR', message: String(e?.message ?? e).slice(0, 300), subtests: [], ms: 0 }; }
        runs.push(r);
        if (r.status === 'CRASH' || r.status === 'RUNNER_ERROR' || session.crashed) { if (r.stuck) await restart(); else await session.newTab().catch(restart); }
        if (reps > 1 && rep === 0 && config.role === 'control') break;
      }
      const sigs = new Set(runs.map(signature));
      // The reported result is the WORST repetition (fewest passing subtests) and a file passes only when every repetition passes: a flaky test can never read as a pass.
      const passing = x => x.subtests.filter(s => s.status === 'PASS').length;
      const worst = runs.reduce((w, x) => (passing(x) < passing(w) || (x.status !== 'OK' && w.status === 'OK' && passing(x) === passing(w)) ? x : w), runs[0]);
      doc.tests[test.id] = { type: test.type, privacy: test.privacy, worker: test.worker, stable: sigs.size === 1, runs, result: worst, pass: runs.every(filePasses) };
      const r = worst; const np = r.subtests.filter(s => s.status === 'PASS').length;
      log(`[${configId}] ${String(i).padStart(3)}/${tests.length} ${doc.tests[test.id].pass ? 'PASS' : r.status.padEnd(4)} ${np}/${r.subtests.length} ${sigs.size > 1 ? 'UNSTABLE ' : ''}${test.id} ${r.ms}ms`);
    }
  } finally { clearTimeout(watchdog); doc.stop = await session.stop(); await server.close(); }
  doc.finishedAt = new Date().toISOString();
  return doc;
}

export function saveResults(doc, name) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = doc.startedAt.replace(/[:.]/g, '-');
  const file = `${RESULTS_DIR}/wpt-${name}-${stamp}.json`;
  writeFileSync(file, JSON.stringify(doc)); writeFileSync(`${RESULTS_DIR}/wpt-${name}-latest.json`, JSON.stringify(doc));
  return file;
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const tests = selectTests({ noPrivacy: process.argv.includes('--no-privacy'), only: arg('only'), filter: arg('filter') });
  const cfg = arg('config') ?? 'B';
  const doc = await runConfig(cfg, tests, { relaxed: process.argv.includes('--relaxed'), reps: Number(arg('reps') ?? (cfg === 'C' ? 1 : 3)), shotRoot: arg('shots') && resolve(PROJECT_ROOT, arg('shots')), polyfillFile: arg('polyfill') && resolve(arg('polyfill')) });
  const file = saveResults(doc, arg('name') ?? cfg);
  const pass = Object.values(doc.tests).filter(t => t.pass).length;
  console.log(`config ${cfg} (${doc.config.version}): ${pass}/${tests.length} files pass; ${file}`);
}
