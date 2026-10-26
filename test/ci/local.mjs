// `npm run test:local`: the browser suites that the hosted macOS runner does not judge (test/ci/macos-plan.mjs, LOCAL_ONLY), one after the other, one browser
// at a time, with one table at the end. Meant to run unattended on a Mac with a 120 Hz display, a real GPU and Chrome Canary:
//   npm run build && caffeinate -dimsu npm run test:local [-- --skip=mobile,stp] [--wait-quiet=SECONDS]
// Leave the mouse and keyboard alone: the harness parks the OS pointer outside the browser window, and a run that received input it did not send is reported
// NOT USABLE (gates, mutants) or run again (G-xbrowser), never counted as a result. `npm run bench:compare` (45 min) is not part of it.
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_GATES, LOCAL_MUTANTS } from './macos-plan.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const node = process.execPath;
const skip = (process.argv.find((a) => a.startsWith('--skip='))?.slice(7) ?? '').split(',');
const quiet = process.argv.filter((a) => a.startsWith('--wait-quiet='));
const stages = [
  ['gates', `gates ${LOCAL_GATES.join(', ')} (real + control)`, [node, 'test/gates/run-all.mjs', `--only=${LOCAL_GATES.join(',')}`, ...quiet]],
  ['mutants', `the ${LOCAL_MUTANTS.length} mutants that target those gates`, [node, 'test/gates/mutants/run.mjs', `--only=${LOCAL_MUTANTS.map((m) => m.name).join(',')}`, ...quiet]],
  ['plugins', 'plugin gallery e2e (continuous WebGPU effects)', [node, 'scripts/check-plugins-e2e.mjs']],
  ['effect-plugin', 'examples/effect-plugin (its frame cap)', [node, 'scripts/check-examples.mjs', '--only=effect-plugin']],
  ['native-effects', 'the effects over Chrome Canary\'s own implementation', [node, 'test/native-effects/run.mjs', '--require-canary']],
  ['stp', 'G-xbrowser on Safari Technology Preview (skipped by the suite when it is not installed)', [node, 'test/xbrowser/run.mjs', '--engine=stp']],
  ['mobile', 'G-mobile: iOS Simulator and Android Emulator (docs/guides/MOBILE.md)', [node, 'test/mobile/run.mjs']],
];
const rows = [];
for (const [id, what, cmd] of stages) {
  if (skip.includes(id)) { rows.push({ stage: id, what, result: 'SKIPPED (--skip)' }); continue; }
  console.log(`\n=== ${id}: ${cmd.slice(1).join(' ')}`);
  const t0 = Date.now();
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: root, stdio: 'inherit', timeout: 4 * 3600000 });
  rows.push({ stage: id, what, result: r.status === 0 ? 'PASS' : `FAIL (exit ${r.status ?? r.signal})`, minutes: Math.round((Date.now() - t0) / 6000) / 10 });
}
console.log('\n=== test:local (the suites the hosted macOS runner does not judge) ===');
console.table(rows);
process.exit(rows.some((r) => String(r.result).startsWith('FAIL')) ? 1 : 0);
