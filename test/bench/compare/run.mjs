#!/usr/bin/env node
// Performance comparison bench: our polyfill vs the competitor (html-in-canvas-polyfill 1.0.1 + attribute adapter) vs native (Canary flag).
//
//   npm run bench:compare                                     all subjects, all scenarios, then the report
//   node test/bench/compare/run.mjs --subjects=ours,native --scenarios=typing,slider [--no-report] [--quick]
//
// One browser at a time (quiet-machine rule); a load snapshot (uptime + top CPU, a process not started by the run above 15 % CPU = machine load above threshold, waits up to 2 min)
// is taken before every scenario and stored with the numbers. Results: .scratch/results/bench-compare-<stamp>.json (one file per subject run,
// merged by report.mjs into docs/PERFORMANCE-COMPARISON.md).
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Session, SUBJECTS, RESULTS_DIR, H } from './lib/session.mjs';
import { SCENARIOS } from './scenarios/index.mjs';

const has = (k) => process.argv.includes(`--${k}`);
const subjects = H.arg('subjects', 'ours,competitor,native').split(',');
const scenarios = H.arg('scenarios', Object.keys(SCENARIOS).join(',')).split(',');
const quick = has('quick');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

mkdirSync(RESULTS_DIR, { recursive: true });
let failed = 0;
for (const sid of subjects) {
  const subject = SUBJECTS[sid];
  if (!subject) throw new Error('unknown subject ' + sid);
  const sess = new Session(subject);
  const result = { kind: 'bench-compare', subject: sid, label: subject.label, startedAt: new Date().toISOString(), quick, scenarios: {}, errors: {} };
  const file = resolve(RESULTS_DIR, `bench-compare-${sid}-${stamp}.json`);
  const save = () => { result.loads = sess.loads; writeFileSync(file, JSON.stringify(result, null, 1)); };
  try {
    await sess.open();
    result.environment = await H.environmentFacts(sess.browser, sess.page, { rafFrames: 120 });
    result.load0 = await sess.loadCheck('start');
    console.log(`== ${subject.label}: ${result.environment.chrome}, raf ${result.environment.rafMeasured?.impliedHz?.toFixed(1)} Hz, dpr ${result.environment.viewport.dpr}, load ${result.load0.loadAvg} highLoad=${result.load0.highLoad}`);
    for (const sc of scenarios) {
      const t0 = Date.now();
      try {
        console.log(`-- ${sid} ${sc}`);
        result.scenarios[sc] = await SCENARIOS[sc](sess, { quick });
      } catch (e) {
        failed++;
        result.errors[sc] = String(e?.stack ?? e).slice(0, 2000);
        console.log(`   ERROR ${sc}: ${String(e?.message ?? e).slice(0, 300)}`);
        try { await sess.page.navigate('about:blank'); } catch { /* recover */ }
      }
      result.durations = { ...(result.durations ?? {}), [sc]: Date.now() - t0 };
      save();
    }
  } finally {
    result.finishedAt = new Date().toISOString();
    save();
    await sess.close();
  }
  console.log(`   -> ${file}`);
}
if (!has('no-report')) { const { writeReport } = await import('./report.mjs'); writeReport(); }
process.exit(failed ? 1 : 0);
