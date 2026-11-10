// Mutant suite runner: `npm run test:mutants`.
//   node test/gates/mutants/run.mjs [--only=a,b] [--gate=g-explainer] [--shard=k/n] [--repeat=N] [--list] [--check-anchors] [--no-baseline] [--wait-quiet=SECONDS]
// --shard=k/n runs the k-th of n parts of the selection (shard.mjs: every mutant in exactly one part; CI runs the parts on separate machines).
// --repeat=N runs every selected mutant N times against the same clean baseline and prints how often each was caught: a control that is caught only on some runs is
// timing-dependent, and one run cannot tell (stale-after-resize was missed in 8 of 20 runs on the macOS runner before G-resize-drag compared the pixels at rest, 2026-10-28). Every run counts: one miss fails the suite.
// For every mutant: build a mutated COPY of dist/hic-live-polyfill.iife.js (or of dist/hic-live-effects.iife.js for a mutant with `bundle: 'effects'`, dist/hic-live-engines.iife.js for `bundle: 'engines'`, dist/hic-live-native-bridge.iife.js for `bundle: 'bridge'`) under .scratch/mutants, run each targeted gate with --no-control --bundle-file=<copy> (--effects-file=<copy>, --engines-file=<copy>, --bridge-file=<copy>), and compare the
// failed checks with the CLEAN bundle's run of the same gate (cached per gate; run twice when the first run has red checks). A mutant is CAUGHT when a check goes red
// that is green on every clean run (verdict.mjs). An unknown --only name, a --gate no mutant runs or an empty selection exits 2 before anything is built.
//   CAUGHT        ok
//   MISSED        the gates did not notice: the suite fails
//   PENDING       MISSED but marked pendingFix (the fix of that finding is not in the bundle yet): reported, does not fail
//   ANCHOR DRIFT  the anchor no longer occurs exactly once (the bundle was rebuilt): fix the mutant definition; fails
//   NOT USABLE    a gate run was dropped (focus lost), of the mutant or of the clean bundle: rerun; fails
//   UNCERTAIN     the only checks the mutant turned red were also red on one of the two clean runs (flaky): rerun; fails
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTANTS } from './mutants.mjs';
import { buildMutant } from './build.mjs';
import { parseShard, planShards } from './shard.mjs';
import { gateRunOutcome } from '../lib/gate.mjs';
import { selectMutants, baselineOf, gateVerdict, mutantStatus, asGateRun } from './verdict.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const has = (k) => process.argv.includes(`--${k}`);
const only = arg('only')?.split(',');
const gateFilter = arg('gate');
// the selection first: a name that is not a mutant or an empty selection exits 2 before anything is read, built or launched (verdict.mjs)
const selection = selectMutants(MUTANTS, { only, gate: gateFilter });
if (selection.error !== undefined) { console.error(selection.error); process.exit(2); }
const shard = parseShard(arg('shard'));
const filtered = selection.selected;
const selected = shard ? planShards(filtered, shard.count)[shard.index - 1].mutants : filtered;
if (shard) console.log(`shard ${shard.index}/${shard.count}: ${selected.length} of ${filtered.length} mutants (${selected.map((m) => m.name).join(', ')})`);
// a part of a sharded run can be empty: said so, and never reported as mutants caught
if (!selected.length) { console.log(`EMPTY: shard ${shard?.index}/${shard?.count} has no mutant of the selection; nothing was tested`); process.exit(0); }
const dir = resolve(root, '.scratch/mutants');
mkdirSync(dir, { recursive: true });
// the optional bundles a mutant can target (docs/BUNDLES.md); every other bundle stays the clean one
const BUNDLES = {
  core: { text: readFileSync(resolve(root, 'dist/hic-live-polyfill.iife.js'), 'utf8'), flag: 'bundle-file' },
  effects: { text: readFileSync(resolve(root, 'dist/hic-live-effects.iife.js'), 'utf8'), flag: 'effects-file' },
  // the Gecko / WebKit painters: only G-xbrowser scenarios load it (`xbrowser-<scenario>` gates)
  engines: { text: readFileSync(resolve(root, 'dist/hic-live-engines.iife.js'), 'utf8'), flag: 'engines-file' },
  // the native bridge: G-bridged-translation loads it before the core
  bridge: { text: readFileSync(resolve(root, 'dist/hic-live-native-bridge.iife.js'), 'utf8'), flag: 'bridge-file' },
};
for (const [name, b] of Object.entries(BUNDLES)) { b.clean = resolve(dir, `clean-${name}.js`); writeFileSync(b.clean, b.text); }
const basePath = BUNDLES.core.clean;

const build = (m) => buildMutant(BUNDLES[m.bundle ?? 'core'].text, m);

if (has('list')) { for (const m of selected) console.log(`${m.name.padEnd(32)} ${m.bundle ?? 'core'} ${m.gates.join(',')}${m.pendingFix ? '  [pending ' + m.pendingFix + ']' : ''}\n    ${m.proves}`); process.exit(0); }

const built = new Map();
for (const m of selected) built.set(m.name, build(m));
if (has('check-anchors')) {
  let bad = 0;
  for (const m of selected) { const b = built.get(m.name); if (b.drift) { bad++; console.log(`DRIFT ${m.name}: ${b.drift}`); } }
  // The controls of G-xbrowser and G-mobile scrollCompose serve mutant bundles of their own, and those gates run on a Mac and on devices only: an anchor of theirs
  // that drifted was seen only there (the `corner` mutant of G-mobile had not matched since 0.1.0-preview.23). With no selection, they are checked here too.
  let more = 0;
  if (!arg('only') && !arg('gate')) {
    const xb = await import('../../xbrowser/scenarios.mjs'), mobile = await import('../../mobile/scenarios.mjs');
    const scenario = [
      ...Object.entries(xb.GECKO_COMPOSE_MUTANTS).map(([name, edits]) => ({ name: `G-xbrowser scrollCompose (Firefox) ${name}`, bundle: 'core', edits })),
      ...Object.entries(xb.WEBKIT_BAR_MUTANTS).map(([name, m]) => ({ name: `G-xbrowser scrollCompose (Safari) ${name}`, bundle: m.bundle, edits: m.edits })),
      ...Object.entries(mobile.COMPOSE_MUTANTS).map(([name, edits]) => ({ name: `G-mobile scrollCompose ${name}`, bundle: 'core', edits })),
    ];
    more = scenario.length;
    for (const m of scenario) { const b = buildMutant(BUNDLES[/** @type {'core'|'engines'} */ (m.bundle)].text, { edits: m.edits }); if ('drift' in b) { bad++; console.log(`DRIFT ${m.name}: ${b.drift}`); } }
  }
  console.log(`${selected.length + more - bad}/${selected.length + more} anchors match exactly once`);
  process.exit(bad ? 1 : 0);
}

const passArgs = ['--no-control', ...(arg('wait-quiet') ? [`--wait-quiet=${arg('wait-quiet')}`] : [])];
/** @param {string} gate @param {string} file the bundle to serve @param {'core'|'effects'|'engines'|'bridge'} [which] which of the bundles `file` replaces */
/** @param {string[]} [args] extra gate arguments of the mutant (`args`, e.g. the browser build a check needs) */
function runGate(gate, file, which = 'core', args = []) {
  // `xbrowser-<scenario>`: that G-xbrowser scenario on Safari and Firefox (it prints the same result line as a gate)
  const xb = /^xbrowser-(.+)$/.exec(gate);
  const cmd = xb ? [resolve(root, 'test/xbrowser/run.mjs'), `--engine=${process.env.HIC_MUTANT_ENGINES ?? 'safari,firefox'}`, `--only=${xb[1]}`, '--no-control'] : [resolve(root, 'test/gates', gate + '.mjs'), ...passArgs];
  return gateRunOutcome(spawnSync(process.execPath, [...cmd, ...args, `--${BUNDLES[which].flag}=${file}`], { cwd: root, encoding: 'utf8', timeout: 900000 }));
}

const asRun = asGateRun;
const baselines = new Map();
// A check red on the clean bundle is left out of the comparison, so a flake there hid every mutant that check would catch (ancestor-css-lost MISSED in the nightly
// of 2026-11-07: the twin of snippet 14 was screenshotted blank on the clean run). A clean run with red checks is run once more: only the checks red on both are
// left out, and one red on a single run is flaky (verdict.mjs baselineOf). Both runs are kept in the receipt.
const baseline = (gate, args = []) => {
  if (has('no-baseline')) return { usable: true, failed: new Set(), flaky: new Set(), runs: 0 };
  const key = [gate, ...args].join(' ');
  if (!baselines.has(key)) {
    const runs = [asRun(runGate(gate, basePath, 'core', args))];
    if (runs[0].failed.size) runs.push(asRun(runGate(gate, basePath, 'core', args)));
    const b = { ...baselineOf(runs), receipts: runs.map((r) => ({ usable: r.usable, notRun: r.notRun, verdict: r.verdict, red: [...r.failed] })) };
    if (runs.length > 1) console.log(`baseline ${key}: ${runs[0].failed.size} check(s) red on the clean bundle, ${b.failed.size} red on both runs, ${b.flaky.size} on one only${b.usable ? '' : ' (not usable)'}`);
    baselines.set(key, b);
  }
  return baselines.get(key);
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
    const base = baseline(gate, m.args);
    const res = runGate(gate, file, m.bundle ?? 'core', m.args);
    const v = gateVerdict(base, asRun(res));
    perGate[gate] = { ...v, newlyRed: v.newlyRed.slice(0, 4), flakyRed: v.flakyRed.slice(0, 4), baselineRed: base.failed.size, baselineFlaky: base.flaky.size, highLoad: res.highLoad, focus: res.focus?.mode };
  }
  const status = mutantStatus(Object.values(perGate), m);
  rows.push({ mutant: m.name, status, pendingFix: m.pendingFix ?? null, expect: m.expect ?? 'any', perGate });
  console.log(`${status.padEnd(12)} ${m.name.padEnd(32)} ${Object.entries(perGate).map(([g, e]) => `${g.replace(/^g-/, '')}:${e.caught ? 'red' : 'GREEN'}${e.caught ? ' (' + e.newlyRed.join(' | ').slice(0, 160) + ')' : e.uncertain ? ' (only checks also red on a clean run: ' + e.flakyRed.join(' | ').slice(0, 120) + ')' : e.usable ? '' : ' (' + e.detail + ')'}`).join(' ')}`);
}
if (repeat > 1) for (const m of selected) {
  const mine = rows.filter((r) => r.mutant === m.name);
  console.log(`repeat ${m.name}: caught ${mine.filter((r) => r.status === 'CAUGHT').length}/${mine.length}${mine.some((r) => r.status !== 'CAUGHT') ? ' (' + mine.map((r) => r.status).join(', ') + ')' : ''}`);
}
console.table(rows.map((r) => ({ mutant: r.mutant, status: r.status + (r.pendingFix ? ` (${r.pendingFix})` : ''), gates: Object.entries(r.perGate).map(([g, e]) => `${g.replace(/^g-/, '')}:${e.caught ? 'red' : 'green'}`).join(' ') || r.detail })));
mkdirSync(resolve(root, '.scratch/results'), { recursive: true });
writeFileSync(resolve(root, `.scratch/results/mutants-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ at: new Date().toISOString(), rows, baselines: Object.fromEntries([...baselines].map(([k, b]) => [k, { usable: b.usable, runs: b.runs, failed: [...b.failed], flaky: [...b.flaky], receipts: b.receipts }])) }, null, 1));
const bad = rows.filter((r) => ['MISSED', 'ANCHOR DRIFT', 'NOT USABLE', 'UNCERTAIN'].includes(r.status));
console.log(bad.length ? `FAIL: ${bad.map((r) => r.mutant + ':' + r.status).join(', ')}` : `OK: ${rows.length} mutants, ${rows.filter((r) => r.status === 'PENDING').length} pending`);
process.exit(bad.length ? 1 : 0);
