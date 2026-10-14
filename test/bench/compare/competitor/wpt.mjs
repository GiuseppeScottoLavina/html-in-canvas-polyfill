#!/usr/bin/env node
// Runs the official WPT HTML-in-Canvas subset (test/wpt, configuration B: Chrome stable, script injected) against the comparison
// subject built by ./build.mjs instead of this polyfill. Results: .scratch/results/wpt-competitor[-partK].json.
//   node test/bench/compare/competitor/wpt.mjs [reps=3] [part/of=1/1]
// part/of splits the 230 files (for example 1/4 ... 4/4) so each chunk stays under the runner's 40-minute watchdog.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RESULTS_DIR, runConfig, selectTests } from '../../../wpt/run.mjs';

const file = resolve(RESULTS_DIR, '../competitor/competitor-adapted.iife.js');
const [reps = '3', part = '1/1'] = process.argv.slice(2);
const [k, n] = part.split('/').map(Number);
const all = selectTests({});
const size = Math.ceil(all.length / n);
const doc = await runConfig('B', all.slice((k - 1) * size, k * size), { reps: Number(reps), polyfillFile: file });
mkdirSync(RESULTS_DIR, { recursive: true });
const out = resolve(RESULTS_DIR, `wpt-competitor${n > 1 ? `-part${k}` : ''}.json`);
writeFileSync(out, JSON.stringify(doc));
const t = Object.values(doc.tests);
let pass = 0, total = 0;
for (const x of t) { total += x.result.subtests.length; pass += x.result.subtests.filter((s) => s.status === 'PASS').length; }
console.log(`competitor ${part}: files ${t.filter((x) => x.pass).length}/${t.length}, subtests ${pass}/${total} -> ${out}`);
process.exit(0);
