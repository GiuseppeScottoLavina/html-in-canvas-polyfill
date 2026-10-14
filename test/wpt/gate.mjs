#!/usr/bin/env node
// G-wpt-subset: the OFFICIAL WPT HTML-in-Canvas tests (test/vendor/wpt, pinned commit in test/vendor/wpt/VERSION.json) in three configurations,
// a triage of every difference and the three failure conditions of docs/TEST-PLAN.md.
//   node test/wpt/gate.mjs [--reps=3] [--only=id,id] [--filter=text] [--reuse] [--skip-oracle] [--update-expectations] [--no-docs] [--table]
//     --reuse                 triage the latest saved results of A, B and C without running a browser
//     --skip-oracle           run B and C only (A from the latest saved result)
//     --update-expectations   rewrite the `pass`, `partial` and `stable` lists from this subject run (reasons and categories are never written by a tool)
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_ROOT, arg } from '../harness/lib/util.mjs';
import { RESULTS_DIR, runConfig, saveResults, selectTests } from './run.mjs';
import { gateFailures, formatTable, loadJson, triage } from './triage.mjs';
import { writeConformance } from './report.mjs';

const EXPECTATIONS = resolve(PROJECT_ROOT, 'test/wpt/expectations.json');
const args = new Set(process.argv.slice(2));
const reps = Number(arg('reps') ?? 3);
const latest = n => loadJson(`${RESULTS_DIR}/wpt-${n}-latest.json`);

async function collect() {
  const tests = selectTests({ only: arg('only'), filter: arg('filter') });
  const out = {};
  for (const id of ['A', 'B', 'C']) {
    if (args.has('--reuse') || (id === 'A' && args.has('--skip-oracle'))) { out[id] = latest(id); if (!out[id]) throw new Error(`no saved result for ${id}: run without --reuse`); continue; }
    const doc = await runConfig(id, tests, { reps: id === 'C' ? 1 : reps, log: s => process.stdout.write(s + '\n') });
    doc.selection = arg('only') || arg('filter') ? 'subset' : 'full';
    console.log(`saved ${saveResults(doc, id)}`);
    out[id] = doc;
  }
  return out;
}

function updateExpectations(exp, B) {
  const pass = []; const partial = {}; const stable = [];
  for (const [id, t] of Object.entries(B.tests)) {
    const np = t.result.subtests.filter(s => s.status === 'PASS').length;
    if (t.pass) pass.push(id); else if (np) partial[id] = np;
    if (t.stable) stable.push(id);
  }
  return { ...exp, pass: pass.sort(), partial, stable: stable.sort() };
}

const docs = await collect();
let expectations = loadJson(EXPECTATIONS) ?? { tests: {}, controlPass: {} };
if (args.has('--update-expectations')) {
  expectations = updateExpectations(expectations, docs.B);
  writeFileSync(EXPECTATIONS, JSON.stringify(expectations, null, 1) + '\n');
  console.log(`rewrote the pass/partial/stable lists of ${EXPECTATIONS}`);
}
const baseline = loadJson(resolve(PROJECT_ROOT, 'test/wpt/oracle-baseline.json'));
const result = triage(docs, expectations, baseline);
const failures = gateFailures(docs, expectations, result);
const pinned = `Chrome/${loadJson(resolve(PROJECT_ROOT, 'test/vendor/wpt/VERSION.json'))?.chromium?.tag}`;
if (docs.A.config.version !== pinned && (!baseline || baseline.build !== pinned)) failures.push(`(iv) the oracle is ${docs.A.config.version}, not the build of the pinned WPT revision (${pinned}), and test/wpt/oracle-baseline.json has no runs of ${pinned}: native passes cannot be trusted`);
if (args.has('--table')) console.log(formatTable(result));
const f = result.counts.files; const s = result.counts.subtests;
console.log(`\nWPT HTML-in-Canvas (${docs.A.config.version} native / ${docs.B.config.version} + polyfill / ${docs.C.config.version} control)`);
console.log(`files:    oracle ${f.A}/${f.total}   subject ${f.B}/${f.total}   control ${f.C}/${f.total}`);
console.log(`subtests: oracle ${s.A}/${s.total}   subject ${s.B}/${s.total}   control ${s.C}/${s.total}`);
if (result.drift) console.log(`ORACLE DRIFT: the oracle is ${result.drift.oracle}, the pinned WPT revision matches ${result.drift.build}; ${result.drift.subtests.length} subtests that passed at the pinned build fail now and are triaged as native passes (test/wpt/oracle-baseline.json).\n          oracle at the pinned build: files ${f.P}/${f.total}, subtests ${s.P}/${s.total}`);
console.log('subtests by category:', JSON.stringify(result.cat));
console.log('files by category:   ', JSON.stringify(result.catFiles));
if (!args.has('--no-docs') && docs.A.selection !== 'subset' && docs.B.selection !== 'subset') console.log(`wrote ${writeConformance({ docs, result, expectations, failures })}`);
if (failures.length) {
  console.error(`\nG-wpt-subset FAILED (${failures.length}):`);
  for (const x of failures.slice(0, 60)) console.error('  ' + x);
  if (failures.length > 60) console.error(`  ... ${failures.length - 60} more`);
  process.exit(1);
}
console.log('\nG-wpt-subset OK');
