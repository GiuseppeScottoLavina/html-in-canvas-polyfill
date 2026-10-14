// `npm run test:gates:all`: runs EVERYTHING sequentially and prints one table: static checks, type check, unit tests, the browser gates (real + control), the mutant suite.
//   node scripts/test-all.mjs [--skip=unit,mutants,gates,lint,types,wpt] [--wait-quiet=SECONDS]
// One headed Chrome at a time (the gates and the mutant suite run strictly one after the other). Exit code 1 when any stage failed.
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skip = (process.argv.find((a) => a.startsWith('--skip='))?.slice(7) ?? '').split(',');
const pass = process.argv.filter((a) => a.startsWith('--wait-quiet='));
const node = process.execPath;
const stages = [
  ['lint', 'repo check (size, deps, no blob:)', [node, 'scripts/check-repo.mjs']],
  ['types', 'tsc strict checkJs', [resolve(root, 'node_modules/.bin/tsc'), '-p', 'jsconfig.json', '--noEmit']],
  ['unit', 'unit tests (node + browser)', ['npm', 'run', '--silent', 'test:unit']],
  ['gates', 'browser gates (real + control)', [node, 'test/gates/run-all.mjs', ...pass]],
  ['wpt', 'G-wpt-subset: official WPT HTML-in-Canvas tests (oracle / subject / control)', [node, 'test/wpt/gate.mjs']],
  ['mutants', 'mutant suite', [node, 'test/gates/mutants/run.mjs', ...pass]],
];
const rows = [];
for (const [id, what, cmd] of stages) {
  if (skip.includes(id)) { rows.push({ stage: id, what, result: 'SKIPPED' }); continue; }
  const t0 = Date.now();
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: root, stdio: 'inherit', timeout: 3600000 });
  rows.push({ stage: id, what, result: r.status === 0 ? 'PASS' : `FAIL (exit ${r.status})`, seconds: Math.round((Date.now() - t0) / 1000) });
}
const summary = resolve(root, '.scratch/results/summary.json');
const gates = existsSync(summary) ? JSON.parse(readFileSync(summary, 'utf8')) : null;
console.log('\n=== test:gates:all ===');
console.table(rows);
if (gates && !skip.includes('gates')) console.table(gates.rows.map((g) => ({ gate: g.gate, verdict: g.verdict, control: g.control, degraded: (g.degraded ?? []).join(',') })));
console.log(gates?.green ? 'gates: GREEN run (real)' : 'gates: not green (see rows)');
process.exit(rows.some((r) => String(r.result).startsWith('FAIL')) ? 1 : 0);
