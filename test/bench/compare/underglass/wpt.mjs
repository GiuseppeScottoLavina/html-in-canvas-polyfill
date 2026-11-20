#!/usr/bin/env node
// Runs the official WPT HTML-in-Canvas subset (test/wpt, configuration B: Chrome stable, scripts injected) against the comparison subject fetched by
// ./build.mjs instead of this polyfill: its page build in every document and its worker build in every dedicated worker.
// Results: .scratch/results/wpt-underglass[-partK].json.
//   node test/bench/compare/underglass/wpt.mjs [reps=3] [part/of=1/1]
// part/of splits the files (for example 1/4 ... 4/4) so each chunk stays under the runner's 40-minute watchdog.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RESULTS_DIR, runConfig, selectTests } from '../../../wpt/run.mjs';
import { PAGE_FILE, WORKER_FILE } from './build.mjs';

for (const f of [PAGE_FILE, WORKER_FILE]) if (!existsSync(f)) { console.error(`missing ${f}: run node test/bench/compare/underglass/build.mjs first`); process.exit(2); }
const [reps = '3', part = '1/1'] = process.argv.slice(2);
const [k, n] = part.split('/').map(Number);
const all = selectTests({});
const size = Math.ceil(all.length / n);
const doc = await runConfig('B', all.slice((k - 1) * size, k * size), { reps: Number(reps), polyfillFile: PAGE_FILE, workerFile: WORKER_FILE });
mkdirSync(RESULTS_DIR, { recursive: true });
const out = resolve(RESULTS_DIR, `wpt-underglass${n > 1 ? `-part${k}` : ''}.json`);
writeFileSync(out, JSON.stringify(doc));
const t = Object.values(doc.tests);
let pass = 0, total = 0;
for (const x of t) { total += x.result.subtests.length; pass += x.result.subtests.filter((s) => s.status === 'PASS').length; }
console.log(`underglass ${part}: files ${t.filter((x) => x.pass).length}/${t.length}, subtests ${pass}/${total} -> ${out}`);
process.exit(0);
