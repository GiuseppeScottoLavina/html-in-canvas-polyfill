#!/usr/bin/env node
// CPU profiles (V8 sampling profiler, 100 us) of OUR polyfill on the paths where the comparison shows a loss. Uses the UNMINIFIED bundle so
// function names survive. Writes .scratch/results/bench-compare-profile-<stamp>.json (top self/total functions per case) and prints tables.
//   node test/bench/compare/profile.mjs [--cases=wheel,f4,typing,resize,idle]
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Session, SUBJECTS, OURS_DEBUG_URL, RESULTS_DIR, H } from './lib/session.mjs';
import { canvasGeo, nonce } from './lib/common.mjs';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const cases = arg('cases', 'wheel,f4,typing,resize,idle,click').split(',');
const sess = new Session({ ...SUBJECTS.ours, id: 'ours-debug', bundle: OURS_DEBUG_URL });
const out = { kind: 'bench-compare-profile', bundle: OURS_DEBUG_URL, startedAt: new Date().toISOString(), cases: {} };

async function profiled(name, fn) {
  const p = sess.page;
  await p.cpuProfileStart({ intervalUs: 100 });
  const t0 = Date.now();
  await fn();
  const prof = await p.cpuProfileStop();
  const s = H.summarizeCpuProfile(prof, { top: 30 });
  const short = (r) => ({ fn: r.fn, at: `${r.url.split('/').pop()}:${r.line}`, selfMs: +r.selfMs.toFixed(1), selfPct: +r.selfPct.toFixed(1), totalMs: +r.totalMs.toFixed(1) });
  out.cases[name] = { wallMs: Date.now() - t0, profiledMs: +s.totalMs.toFixed(1), bySelf: s.bySelf.map(short), byTotal: s.byTotal.map(short) };
  console.log(`\n### ${name} (wall ${Date.now() - t0} ms)\n` + H.formatProfileTable(s, { rows: 18 }) + '\n' + H.formatProfileTable(s, { by: 'byTotal', rows: 14 }));
}

try {
  await sess.open();
  out.load = await sess.loadCheck('profile start');
  if (cases.includes('wheel')) {
    const page = await sess.goto('f2');
    const r = await page.evaluate('(() => { const e = document.getElementById("list").getBoundingClientRect(); return { x: e.left + e.width / 2, y: e.top + e.height / 2 }; })()');
    await profiled('wheel stream F2 #list (120 ticks of 40 px at 8 ms)', async () => { await H.wheelStream(page, { x: r.x, y: r.y, deltaY: 40, count: 60, intervalMs: 8 }); await H.wheelStream(page, { x: r.x, y: r.y, deltaY: -40, count: 60, intervalMs: 8 }); await H.sleep(300); });
  }
  if (cases.includes('f4')) {
    const page = await sess.goto('f4', { nodes: 1000 });
    await profiled('F4 1000 nodes: 30 header text updates every 160 ms', async () => { for (let i = 0; i < 30; i++) { await page.evaluate(`document.querySelector('#root header h1').textContent = ${JSON.stringify('F4 ' + nonce(8))}`); await H.sleep(160); } });
  }
  if (cases.includes('typing')) {
    const page = await sess.goto('f1');
    const geo = await canvasGeo(page, '#hic-surface');
    const r = await page.evaluate('(() => { const c = document.querySelector("#hic-surface").getBoundingClientRect(); const e = document.getElementById("project").getBoundingClientRect(); return { x: e.left - c.left + e.width / 2, y: e.top - c.top + e.height / 2 }; })()');
    await page.click(geo.x + r.x, geo.y + r.y); await H.sleep(200);
    await profiled('F1 #project: 40 keys every 30 ms', async () => { await H.typeKeys(page, nonce(40), { intervalMs: 30 }); await H.sleep(300); });
  }
  if (cases.includes('click')) {
    const page = await sess.goto('f1');
    const pts = await page.evaluate('(() => { const a = document.getElementById("name").getBoundingClientRect(); const b = document.querySelector("#demo-form h1").getBoundingClientRect(); return [{ x: a.left + a.width / 2, y: a.top + a.height / 2 }, { x: b.left + b.width / 2, y: b.top + b.height / 2 }]; })()');
    await profiled('F1: 15 focus/blur click pairs', async () => { for (let i = 0; i < 15; i++) { await page.click(pts[0].x, pts[0].y); await H.sleep(200); await page.click(pts[1].x, pts[1].y); await H.sleep(200); } });
  }
  if (cases.includes('resize')) {
    const page = await sess.goto('f3');
    await profiled('F3: 4 real window drags 1400 <-> 900 px', async () => { for (let i = 0; i < 4; i++) await H.dragResize(page, { to: { width: i % 2 ? 1400 : 900, height: 880 }, steps: 12, intervalMs: 16, settleMs: 400 }); });
    await page.setInnerSize(1400, 880);
  }
  if (cases.includes('idle')) {
    const page = await sess.goto('f1');
    await page.evaluate('document.activeElement && document.activeElement.blur()');
    await profiled('F1 idle, nothing focused, 10 s', () => H.sleep(10000));
  }
} finally {
  out.finishedAt = new Date().toISOString();
  const f = resolve(RESULTS_DIR, `bench-compare-profile-${out.startedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(f, JSON.stringify(out, null, 1));
  console.log('-> ' + f);
  await sess.close();
}
