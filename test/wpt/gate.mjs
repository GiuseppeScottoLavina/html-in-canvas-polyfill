#!/usr/bin/env node
// G-wpt-subset: the OFFICIAL WPT HTML-in-Canvas tests (test/vendor/wpt, pinned commit in test/vendor/wpt/VERSION.json) in three configurations,
// a triage of every difference and the three failure conditions of docs/TEST-PLAN.md.
//   node test/wpt/gate.mjs [--reps=3] [--only=id,id] [--filter=text] [--reuse] [--skip-oracle] [--update-expectations] [--no-docs] [--table]
//     --reuse                 triage the latest saved results of A, B and C without running a browser
//     --skip-oracle           run B and C only (A from the latest saved result)
//     --update-expectations   rewrite the `pass`, `partial` and `stable` lists from this subject run (reasons and categories are never written by a tool);
//                             only from a full subject run of the bundle in dist now (also when reused), and only when the gate passes with the new lists
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_ROOT, arg } from '../harness/lib/util.mjs';
import { RESULTS_DIR, runConfig, saveResults, selectTests, sha256File } from './run.mjs';
import { driftCount, gateFailures, formatTable, loadJson, subjectRunRefusal, triage, updateExpectations } from './triage.mjs';
import { writeConformance } from './report.mjs';
import { listTests, missingResources } from './lib/inventory.mjs';

const EXPECTATIONS = resolve(PROJECT_ROOT, 'test/wpt/expectations.json');
const args = new Set(process.argv.slice(2));
const reps = Number(arg('reps') ?? 3);
const latest = n => loadJson(`${RESULTS_DIR}/wpt-${n}-latest.json`);

// the lists are rebuilt from the subject run: refused before any browser runs when that run is a subset (updateExpectations refuses a reused one)
if (args.has('--update-expectations') && (arg('only') || arg('filter'))) {
  console.error('G-wpt-subset: --update-expectations needs a run of every test; it is refused with --only or --filter (the lists would lose every test not run)');
  process.exit(2);
}

async function collect() {
  const tests = selectTests({ only: arg('only'), filter: arg('filter') });
  const out = {};
  for (const id of ['A', 'B', 'C']) {
    if (args.has('--reuse') || (id === 'A' && args.has('--skip-oracle'))) { out[id] = latest(id); if (!out[id]) throw new Error(`no saved result for ${id}: run without --reuse`); continue; }
    // runConfig records the selection and the injected bundle itself, so a standalone run.mjs result carries them too
    const doc = await runConfig(id, tests, { reps: id === 'C' ? 1 : reps, log: s => process.stdout.write(s + '\n') });
    console.log(`saved ${saveResults(doc, id)}`);
    out[id] = doc;
  }
  return out;
}

const docs = await collect();
let expectations = loadJson(EXPECTATIONS) ?? { tests: {}, controlPass: {} };
// the subject run as it is now: the vendored inventory and the bundle in dist (what --update-expectations and the conformance report stand for)
const current = { inventory: listTests().map(t => t.id), bundleSha256: sha256File(resolve(PROJECT_ROOT, 'dist/hic-live-polyfill.iife.js')) };
// the new lists are only kept in memory here: expectations.json is written below, once the gate has passed with them
const rewrite = args.has('--update-expectations');
if (rewrite) {
  try { expectations = updateExpectations(expectations, docs.B, current); }
  catch (e) { console.error(`G-wpt-subset: ${e.message}; expectations.json is unchanged`); process.exit(2); }
}
const baseline = loadJson(resolve(PROJECT_ROOT, 'test/wpt/oracle-baseline.json'));
const result = triage(docs, expectations, baseline);
const failures = gateFailures(docs, expectations, result);
const pinned = `Chrome/${loadJson(resolve(PROJECT_ROOT, 'test/vendor/wpt/VERSION.json'))?.chromium?.tag}`;
if (docs.A.config.version !== pinned && (!baseline || baseline.build !== pinned)) failures.push(`(iv) the oracle is ${docs.A.config.version}, not the build of the pinned WPT revision (${pinned}), and test/wpt/oracle-baseline.json has no runs of ${pinned}: native passes cannot be trusted`);
for (const m of missingResources()) failures.push(`(v) ${m.url} is referenced by ${m.from.length} vendored test file(s) (${m.from[0]}) and is not vendored: the test cannot load what it loads upstream (copy it from the pinned WPT commit, or list it in ABSENT_UPSTREAM of test/wpt/lib/inventory.mjs when upstream lacks it too)`);
if (args.has('--table')) console.log(formatTable(result));
const f = result.counts.files; const s = result.counts.subtests;
console.log(`\nWPT HTML-in-Canvas (${docs.A.config.version} native / ${docs.B.config.version} + polyfill / ${docs.C.config.version} control)`);
console.log(`files:    oracle ${f.A}/${f.total}   subject ${f.B}/${f.total}   control ${f.C}/${f.total}`);
console.log(`subtests: oracle ${s.A}/${s.total}   subject ${s.B}/${s.total}   control ${s.C}/${s.total}`);
if (result.drift) console.log(`ORACLE DRIFT: the oracle is ${result.drift.oracle}, the pinned WPT revision matches ${result.drift.build}; ${driftCount(result.drift.subtests.length, 'that passed at the pinned build')} now, counted as passing natively (test/wpt/oracle-baseline.json).\n          oracle at the pinned build: files ${f.P}/${f.total}, subtests ${s.P}/${s.total}`);
console.log('subtests by category:', JSON.stringify(result.cat));
console.log('files by category:   ', JSON.stringify(result.catFiles));
// the report stands for the bundle in dist: written only from full runs of the three configurations, the subject's of that bundle
const notReported = ['A', 'C'].filter(id => docs[id].selection !== 'full').map(id => `${id} is not a full run (selection ${docs[id].selection ?? 'not recorded'})`);
const subjectRefusal = subjectRunRefusal(docs.B, current);
if (subjectRefusal) notReported.push(`B: ${subjectRefusal}`);
// a report triaged with lists that are not written would not match expectations.json
if (rewrite && failures.length) notReported.push('the gate fails with the new pass/partial/stable lists, which are not written');
if (args.has('--no-docs')) { /* asked for */ } else if (notReported.length) console.log(`docs/CONFORMANCE.md not written: ${notReported.join('; ')}`);
else console.log(`wrote ${writeConformance({ docs, result, expectations, failures })}`);
if (rewrite && failures.length) console.error('expectations.json not rewritten: the gate fails with the new lists (below)');
else if (rewrite) { writeFileSync(EXPECTATIONS, JSON.stringify(expectations, null, 1) + '\n'); console.log(`rewrote the pass/partial/stable lists of ${EXPECTATIONS}`); }
if (failures.length) {
  console.error(`\nG-wpt-subset FAILED (${failures.length}):`);
  for (const x of failures.slice(0, 60)) console.error('  ' + x);
  if (failures.length > 60) console.error(`  ... ${failures.length - 60} more`);
  process.exit(1);
}
console.log('\nG-wpt-subset OK');
