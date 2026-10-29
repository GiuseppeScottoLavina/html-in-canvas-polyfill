// Mutant suite runner: `npm run test:mutants`.
//   node test/gates/mutants/run.mjs [--only=a,b] [--gate=g-explainer] [--shard=k/n] [--repeat=N] [--list] [--check-anchors] [--no-baseline] [--wait-quiet=SECONDS]
// --shard=k/n runs the k-th of n parts of the selection (shard.mjs: every mutant in exactly one part; CI runs the parts on separate machines).
// --repeat=N runs every selected mutant N times against the same clean baseline and prints how often each was caught: a control that is caught only on some runs is
// timing-dependent, and one run cannot tell (stale-after-resize was missed in 8 of 20 runs on the macOS runner before G-resize-drag compared the pixels at rest, 2026-10-28). Every run counts: one miss fails the suite.
// For every mutant: build a mutated COPY of dist/hic-live-polyfill.iife.js (or of dist/hic-live-effects.iife.js for a mutant with `bundle: 'effects'`) under .scratch/mutants, run each targeted gate with --no-control --bundle-file=<copy> (--effects-file=<copy>), and compare the
// failed checks with the CLEAN bundle's run of the same gate (cached per gate). A mutant is CAUGHT when a check goes red that is green on the clean bundle.
//   CAUGHT        ok
//   MISSED        the gates did not notice: the suite fails
//   PENDING       MISSED but marked pendingFix (the fix of that finding is not in the bundle yet): reported, does not fail
//   ANCHOR DRIFT  the anchor no longer occurs exactly once (the bundle was rebuilt): fix the mutant definition; fails
//   NOT USABLE    a gate run was dropped (focus lost): rerun; fails
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTANTS } from './mutants.mjs';
import { buildMutant } from './build.mjs';
import { parseShard, planShards } from './shard.mjs';
import { gateRunOutcome } from '../lib/gate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const has = (k) => process.argv.includes(`--${k}`);
const only = arg('only')?.split(',');
const gateFilter = arg('gate');
const dir = resolve(root, '.scratch/mutants');
mkdirSync(dir, { recursive: true });
// the optional bundles a mutant can target (docs/BUNDLES.md); every other bundle stays the clean one
const BUNDLES = {
  core: { text: readFileSync(resolve(root, 'dist/hic-live-polyfill.iife.js'), 'utf8'), flag: 'bundle-file' },
  effects: { text: readFileSync(resolve(root, 'dist/hic-live-effects.iife.js'), 'utf8'), flag: 'effects-file' },
};
for (const [name, b] of Object.entries(BUNDLES)) { b.clean = resolve(dir, `clean-${name}.js`); writeFileSync(b.clean, b.text); }
const basePath = BUNDLES.core.clean;

const build = (m) => buildMutant(BUNDLES[m.bundle ?? 'core'].text, m);

const shard = parseShard(arg('shard'));
const filtered = MUTANTS.filter((m) => (!only || only.includes(m.name)) && (!gateFilter || m.gates.includes(gateFilter)));
const selected = shard ? planShards(filtered, shard.count)[shard.index - 1].mutants : filtered;
if (shard) console.log(`shard ${shard.index}/${shard.count}: ${selected.length} of ${filtered.length} mutants (${selected.map((m) => m.name).join(', ')})`);
if (has('list')) { for (const m of selected) console.log(`${m.name.padEnd(32)} ${m.bundle ?? 'core'} ${m.gates.join(',')}${m.pendingFix ? '  [pending ' + m.pendingFix + ']' : ''}\n    ${m.proves}`); process.exit(0); }

const built = new Map();
for (const m of selected) built.set(m.name, build(m));
if (has('check-anchors')) {
  let bad = 0;
  for (const m of selected) { const b = built.get(m.name); if (b.drift) { bad++; console.log(`DRIFT ${m.name}: ${b.drift}`); } }
  console.log(`${selected.length - bad}/${selected.length} anchors match exactly once`);
  process.exit(bad ? 1 : 0);
}

const passArgs = ['--no-control', ...(arg('wait-quiet') ? [`--wait-quiet=${arg('wait-quiet')}`] : [])];
/** @param {string} gate @param {string} file the bundle to serve @param {'core'|'effects'} [which] which of the bundles `file` replaces */
function runGate(gate, file, which = 'core') {
  return gateRunOutcome(spawnSync(process.execPath, [resolve(root, 'test/gates', gate + '.mjs'), ...passArgs, `--${BUNDLES[which].flag}=${file}`], { cwd: root, encoding: 'utf8', timeout: 900000 }));
}
const failedOf = (res) => new Set(res.assertions.filter((a) => !a.ok).map((a) => a.name).concat(res.failed.filter((f) => /^gate (ran|made|did not finish)/.test(f))));

const baselines = new Map();
const baseline = (gate) => {
  if (has('no-baseline')) return { failed: new Set(), usable: true };
  if (!baselines.has(gate)) { const r = runGate(gate, basePath); baselines.set(gate, r.notRun ? { failed: new Set(), usable: false, notRun: r.notRun } : { failed: failedOf(r), usable: r.usable, verdict: r.verdict }); }
  return baselines.get(gate);
};

const repeat = Math.max(1, Math.floor(+(arg('repeat') ?? 1)) || 1);
const rows = [];
for (const m of selected.flatMap((x) => Array.from({ length: repeat }, () => x))) {
  const b = built.get(m.name);
  if (b.drift) { rows.push({ mutant: m.name, status: 'ANCHOR DRIFT', detail: b.drift, perGate: {} }); continue; }
  const file = resolve(dir, `${m.name}.js`);
  writeFileSync(file, b.text);
  const perGate = {};
  for (const gate of m.gates) {
    const base = baseline(gate);
    const res = runGate(gate, file, m.bundle ?? 'core');
    if (res.notRun) { perGate[gate] = { caught: false, usable: false, detail: res.notRun }; continue; }
    const newly = [...failedOf(res)].filter((n) => !base.failed.has(n));
    perGate[gate] = { caught: newly.length > 0, usable: res.usable, newlyRed: newly.slice(0, 4), baselineRed: base.failed.size, highLoad: res.highLoad, focus: res.focus?.mode };
  }
  const entries = Object.values(perGate);
  const usable = entries.every((e) => e.usable !== false);
  const caught = m.expect === 'all' ? entries.every((e) => e.caught) : entries.some((e) => e.caught);
  const status = !usable ? 'NOT USABLE' : caught ? 'CAUGHT' : m.pendingFix ? 'PENDING' : 'MISSED';
  rows.push({ mutant: m.name, status, pendingFix: m.pendingFix ?? null, expect: m.expect ?? 'any', perGate });
  console.log(`${status.padEnd(12)} ${m.name.padEnd(32)} ${Object.entries(perGate).map(([g, e]) => `${g.replace(/^g-/, '')}:${e.caught ? 'red' : 'GREEN'}${e.caught ? ' (' + e.newlyRed.join(' | ').slice(0, 160) + ')' : ''}`).join(' ')}`);
}
if (repeat > 1) for (const m of selected) {
  const mine = rows.filter((r) => r.mutant === m.name);
  console.log(`repeat ${m.name}: caught ${mine.filter((r) => r.status === 'CAUGHT').length}/${mine.length}${mine.some((r) => r.status !== 'CAUGHT') ? ' (' + mine.map((r) => r.status).join(', ') + ')' : ''}`);
}
console.table(rows.map((r) => ({ mutant: r.mutant, status: r.status + (r.pendingFix ? ` (${r.pendingFix})` : ''), gates: Object.entries(r.perGate).map(([g, e]) => `${g.replace(/^g-/, '')}:${e.caught ? 'red' : 'green'}`).join(' ') || r.detail })));
mkdirSync(resolve(root, '.scratch/results'), { recursive: true });
writeFileSync(resolve(root, `.scratch/results/mutants-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ at: new Date().toISOString(), rows }, null, 1));
const bad = rows.filter((r) => ['MISSED', 'ANCHOR DRIFT', 'NOT USABLE'].includes(r.status));
console.log(bad.length ? `FAIL: ${bad.map((r) => r.mutant + ':' + r.status).join(', ')}` : `OK: ${rows.length} mutants, ${rows.filter((r) => r.status === 'PENDING').length} pending`);
process.exit(bad.length ? 1 : 0);
