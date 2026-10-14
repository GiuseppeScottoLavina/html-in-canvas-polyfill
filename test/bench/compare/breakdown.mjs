#!/usr/bin/env node
// Exclusive (self) time per trace event name inside the renderer main thread's RunTasks > 8.33 ms, for OUR polyfill on the losing paths
// (F4 1000-node author update, F2 wheel stream, F1 typing). Complements profile.mjs (JS-only) with Blink's own work (style, layout, paint,
// SVG image raster, decode). Writes .scratch/results/bench-compare-breakdown-<stamp>.json.   node test/bench/compare/breakdown.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Session, SUBJECTS, RESULTS_DIR, H } from './lib/session.mjs';
import { nonce, canvasGeo } from './lib/common.mjs';

const CATS = [...H.DEFAULT_TRACE_CATEGORIES, 'disabled-by-default-devtools.timeline.stack', 'disabled-by-default-blink.debug.layout', 'loading', 'disabled-by-default-v8.compile', 'gpu', 'disabled-by-default-cc.debug.display_items'];

export function selfTimes(file, thresholdMs = 8.33) {
  const ev = H.loadTraceEvents(file);
  const a = H.analyzeTrace(file, { windowMarks: ['m0', 'm1'] });
  if (a.error) return { error: a.error };
  const main = ev.filter((e) => e.pid === a.pid && e.tid === a.tid && e.ph === 'X' && typeof e.dur === 'number').sort((x, y) => x.ts - y.ts || y.dur - x.dur);
  const longs = main.filter((e) => e.name === 'RunTask' && e.dur / 1000 > thresholdMs);
  const all = main.filter((e) => e.name === 'RunTask' && e.dur > 0);
  const agg = (tasks) => {
    const self = new Map(); let total = 0;
    for (const t of tasks) {
      total += t.dur / 1000;
      const inside = main.filter((e) => e !== t && e.ts >= t.ts && e.ts + e.dur <= t.ts + t.dur);
      // exclusive time: own duration minus direct children (stack walk)
      const stack = [];
      const excl = new Map();
      for (const e of inside) {
        while (stack.length && stack[stack.length - 1].ts + stack[stack.length - 1].dur <= e.ts) stack.pop();
        if (stack.length) excl.set(stack[stack.length - 1], (excl.get(stack[stack.length - 1]) ?? stack[stack.length - 1].dur) - e.dur);
        excl.set(e, excl.get(e) ?? e.dur);
        stack.push(e);
      }
      for (const [e, d] of excl) self.set(e.name, (self.get(e.name) ?? 0) + Math.max(0, d) / 1000);
    }
    return { tasks: tasks.length, totalMs: +total.toFixed(1), bySelf: [...self].sort((x, y) => y[1] - x[1]).slice(0, 18).map(([n, ms]) => ({ name: n, ms: +ms.toFixed(1), pct: +(100 * ms / (total || 1)).toFixed(1) })) };
  };
  return { longTasks: agg(longs), allTasks: agg(all) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

async function main() {
const sess = new Session(SUBJECTS.ours);
const out = { kind: 'bench-compare-breakdown', startedAt: new Date().toISOString(), cases: {} };
async function run(name, fn) {
  const file = resolve(H.SCRATCH_DIR, 'bench-compare', 'traces', `breakdown-${name}.json`);
  await sess.browser.traceStart({ categories: CATS });
  await H.sleep(150);
  await sess.page.evaluate('performance.mark("m0")');
  await fn();
  await sess.page.evaluate('performance.mark("m1")');
  await sess.browser.traceStop(file);
  out.cases[name] = selfTimes(file);
  const L = out.cases[name].longTasks;
  console.log(`\n### ${name}: ${L?.tasks} tasks > 8.33 ms, ${L?.totalMs} ms\n` + (L?.bySelf ?? []).map((r) => `${String(r.ms).padStart(8)} ms ${String(r.pct).padStart(5)} %  ${r.name}`).join('\n'));
}
try {
  await sess.open();
  out.load = await sess.loadCheck('breakdown');
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
  let page;
  if (!only || only === 'f4') {
  page = await sess.goto('f4', { nodes: 1000 });
  await run('f4-1000-update', async () => { for (let i = 0; i < 15; i++) { await page.evaluate(`document.querySelector('#root header h1').textContent = ${JSON.stringify('F4 ' + nonce(8))}`); await H.sleep(160); } });
  }
  if (!only || only === 'wheel') {
  page = await sess.goto('f2');
  const r = await page.evaluate('(() => { const e = document.getElementById("list").getBoundingClientRect(); return { x: e.left + e.width / 2, y: e.top + e.height / 2 }; })()');
  await run('f2-wheel-stream', async () => { await H.wheelStream(page, { x: r.x, y: r.y, deltaY: 40, count: 60, intervalMs: 8 }); await H.sleep(300); });
  }
  if (!only || only === 'typing') {
  page = await sess.goto('f1');
  const geo = await canvasGeo(page, '#hic-surface');
  const p = await page.evaluate('(() => { const c = document.querySelector("#hic-surface").getBoundingClientRect(); const e = document.getElementById("project").getBoundingClientRect(); return { x: e.left - c.left + e.width / 2, y: e.top - c.top + e.height / 2 }; })()');
  await page.click(geo.x + p.x, geo.y + p.y); await H.sleep(200);
  await run('f1-typing-120ms', async () => { await H.typeKeys(page, nonce(20), { intervalMs: 120 }); await H.sleep(300); });
  // the same after a script clear (value = '' + input event), as the bench's traced typing pass does
  await page.evaluate('(() => { const e = document.getElementById("project"); e.value = ""; e.dispatchEvent(new Event("input", { bubbles: true })); e.focus(); })()');
  await H.sleep(300);
  await run('f1-typing-120ms-after-clear', async () => { await H.typeKeys(page, nonce(20), { intervalMs: 120 }); await H.sleep(300); });
  }
} finally {
  const f = resolve(RESULTS_DIR, `bench-compare-breakdown-${out.startedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(f, JSON.stringify(out, null, 1)); console.log('-> ' + f);
  await sess.close();
}
}
