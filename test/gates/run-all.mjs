// Runs every browser gate sequentially (ONE Chrome at a time), real + control, prints one table, writes .scratch/results/summary.json.
//   node test/gates/run-all.mjs [--only=G-explainer,g-listeners] [--no-control] [--dpr=1|2] [--bundle-file=/abs/bundle.js] [--wait-quiet=SECONDS]
// * `--only` runs ONLY the selected gates (gate id or file stem).
// * A gate that cannot run is `NOT RUN` and counts as failed. A gate whose control did not turn every declared check class red is failed (gate.mjs).
// * `--no-control` is explicit and flagged: such rows are never green.
// * Verdicts: PASS | FAIL | NOT USABLE (focus refused/lost; the run is dropped). `degraded` lists cdp-click focus, high machine load, no-control, locked screen.
//   A degraded PASS stays reportable but never counts toward a threshold decision.
// * summary.json is written every time; summary-green.json ONLY when the whole run was real: every row PASS with its control, nothing degraded.
import { spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateRunOutcome } from './lib/gate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const only = arg('only')?.split(',').map((s) => s.trim().toLowerCase());
const noControl = process.argv.includes('--no-control');
const extra = process.argv.filter((a) => a === '--no-control' || a.startsWith('--dpr=') || a.startsWith('--chrome=') || a.startsWith('--bundle-file=') || a.startsWith('--wait-quiet='));
const files = readdirSync(here).filter((f) => /^g-.*\.mjs$/.test(f)).sort();
const selected = files.filter((f) => !only || only.includes(f.replace(/\.mjs$/, '').toLowerCase()) || only.includes(('g-' + f.replace(/^g-/, '').replace(/\.mjs$/, '')).toLowerCase()));
const gateIdOf = (f) => 'G-' + f.replace(/^g-/, '').replace(/\.mjs$/, '');
const finalSelection = selected.length || !only ? selected : files.filter((f) => only.includes(gateIdOf(f).toLowerCase()));
if (only && !finalSelection.length) { console.error('--only matched no gate: ' + only.join(',')); process.exit(2); }

// gates whose promise is per device-pixel-ratio run once per listed DPR (a real DPR needs its own Chrome launch); `--dpr=` on the command line overrides
const DPRS = { 'g-regress-capture': [1, 2], 'g-pixel-dpr': [1.25, 1.5], 'g-scroll-cadence': [2, 1.25] };
const jobs = finalSelection.flatMap((f) => {
  const list = process.argv.some((a) => a.startsWith('--dpr=')) ? [null] : (DPRS[f.replace(/\.mjs$/, '')] ?? [null]);
  return list.map((dpr) => ({ f, dpr }));
});
const rows = [];
for (const { f, dpr } of jobs) {
  const proc = spawnSync(process.execPath, [resolve(here, f), ...extra, ...(dpr ? [`--dpr=${dpr}`] : [])], { cwd: root, encoding: 'utf8', timeout: 1200000 });
  const res = gateRunOutcome(proc);
  // a gate that did not pass prints its failed checks with their numbers here (its own summary, after the result line), so a CI log shows them
  if (res.notRun || !res.pass) console.log(`--- ${gateIdOf(f)}${dpr ? '@dpr' + dpr : ''}: ${res.notRun ? 'NOT RUN' : res.verdict}\n${(proc.stdout ?? '').split('\n').filter((l) => !l.startsWith('{"gate"') && !/^\s+ok\s/.test(l)).join('\n').slice(-6000)}`);
  if (res.notRun) { rows.push({ gate: gateIdOf(f) + (dpr ? `@dpr${dpr}` : ''), verdict: 'NOT RUN', pass: false, control: 'n/a', degraded: [], failed: [`NOT RUN: ${res.notRun}`], countsForThresholds: false }); continue; }
  const cl = res.control;
  rows.push({
    gate: res.gate + (dpr ? `@dpr${dpr}` : ''), verdict: res.verdict, pass: res.pass, usable: res.usable, countsForThresholds: res.countsForThresholds,
    control: !cl?.ran ? (noControl ? 'SKIPPED (--no-control)' : 'NOT RUN') : cl.detected && !cl.missingClasses.length ? `red [${cl.failedClasses.join(',')}]` : `DID NOT FAIL${cl.missingClasses.length ? ' classes ' + cl.missingClasses.join(',') : ''}`,
    controlOk: !!cl?.ran && cl.detected && !cl.missingClasses.length, degraded: res.degraded ?? [], highLoad: res.highLoad, focus: res.focus?.mode, failed: res.failed.slice(0, 3), ms: res.durationMs,
  });
}
console.table(rows.map((r) => ({ gate: r.gate, verdict: r.verdict, control: r.control, degraded: (r.degraded ?? []).join(',') || '', first_failure: (r.failed[0] ?? '').slice(0, 110) })));
const green = rows.length > 0 && !only && !noControl && rows.every((r) => r.pass && r.controlOk && r.verdict === 'PASS' && (r.degraded ?? []).length === 0);
mkdirSync(resolve(root, '.scratch/results'), { recursive: true });
const summary = { at: new Date().toISOString(), green, partial: !!only, noControl, rows };
writeFileSync(resolve(root, '.scratch/results/summary.json'), JSON.stringify(summary, null, 1));
const greenFile = resolve(root, '.scratch/results/summary-green.json');
if (green) writeFileSync(greenFile, JSON.stringify(summary, null, 1)); else if (!only) rmSync(greenFile, { force: true });
console.log(green ? 'GREEN RUN (real: every gate PASS with its control, nothing degraded) -> summary-green.json' : 'NOT GREEN' + (rows.some((r) => (r.degraded ?? []).length) ? ' (some rows degraded: high load / no-control / focus mode, they never count toward a threshold decision)' : ''));
process.exit(rows.every((r) => r.pass) ? 0 : 1);
