// REPORTED DATA, no thresholds: RunTask on CrRendererMain (Chrome trace, marks m0/m1) for typing, slider drag and a real window drag, effect off, with the load snapshot.
//   node test/gates/measure-timing.mjs [--dpr=1|2]
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { H, BUNDLE, RESULTS, focusPage } from './lib/gate.mjs';

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const srv = await H.startServer();
const browser = await H.launchChrome({ name: 'timing', ...(arg('dpr') ? { dpr: +arg('dpr') } : {}) });
const out = { at: new Date().toISOString(), chrome: browser.version?.Browser, runs: {}, focus: {} };
try {
  const traceDir = resolve(H.PROJECT_ROOT, '.scratch/results/traces'); mkdirSync(traceDir, { recursive: true });
  async function traced(name, page, action) {
    const load = H.loadSnapshot({ ownPids: [browser.pid, process.pid] });
    await focusPage(page, out.focus);
    await page.evaluate('performance.clearMarks()');
    await H.sleep(300);
    await browser.traceStart();
    await page.evaluate('performance.mark("m0")');
    const injected = await action();
    await page.evaluate('performance.mark("m1")');
    const file = resolve(traceDir, `${name}-${Date.now()}.json`);
    await browser.traceStop(file);
    const rep = H.analyzeTrace(file, { windowMarks: ['m0', 'm1'], thresholdMs: H.FRAME_120, top: 3 });
    const loadAfter = H.loadSnapshot({ ownPids: [browser.pid, process.pid] });
    out.runs[name] = { runTask: rep.runTask ?? rep, longest: rep.longest?.slice(0, 3), injected: injected && { actual: injected.actual, cadenceOk: injected.cadenceOk, effectiveHz: injected.effectiveHz },
      load: { before: load, after: loadAfter }, highLoad: load.highLoad || loadAfter.highLoad, trace: file };
  }
  const page = await browser.newPage();
  await H.openFixture(page, srv, 'f1', { mode: 'poly', bundle: BUNDLE });
  await focusPage(page, out.focus);
  out.raf = await page.measureRaf({ frames: 90 }).then((r) => ({ hz: Math.round(r.hz * 10) / 10, p50: r.p50 }));
  const r = await page.evaluate(`document.getElementById('name').getBoundingClientRect().toJSON()`);
  await page.click(r.x + r.width / 2, r.y + r.height / 2);
  await page.key('End');
  await traced('typing-40keys-50ms', page, () => H.typeKeys(page, 'abcdefghijklmnopqrstuvwxyzabcdefghijklmn', { intervalMs: 50 }));
  const s = await page.evaluate(`document.getElementById('fps-cap').getBoundingClientRect().toJSON()`);
  await traced('slider-drag-60steps-16ms', page, () => H.mouseDrag(page, { x: s.x + s.width * 0.2, y: s.y + s.height / 2 }, { x: s.x + s.width * 0.9, y: s.y + s.height / 2 }, { steps: 60, intervalMs: 16 }));
  const f3 = await browser.newPage({ reuseFirst: false });
  await H.openFixture(f3, srv, 'f3', { mode: 'poly', bundle: BUNDLE });
  await f3.setInnerSize(1400, 800);
  await H.sleep(400);
  await traced('resize-drag-30steps-16ms', f3, () => H.dragResize(f3, { to: { width: 700, height: 800 }, steps: 30, intervalMs: 16, settleMs: 300 }));
  await traced('resize-drag-30steps-8ms', f3, () => H.dragResize(f3, { to: { width: 1400, height: 800 }, steps: 30, intervalMs: 8, settleMs: 300 }));
} catch (e) { out.error = String(e.stack || e); }
finally { await browser.close(); await srv.close(); }
mkdirSync(RESULTS, { recursive: true });
const file = resolve(RESULTS, `timing-${out.at.replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify(out) + '\n');
for (const [k, v] of Object.entries(out.runs)) console.log(k, JSON.stringify({ n: v.runTask.count, over8_33: v.runTask.over8_33ms, over16_7: v.runTask.over16_7ms, p95: v.runTask.p95, max: v.runTask.max, busyPct: v.runTask.busyPct, highLoad: v.highLoad }));
console.log(out.error ?? 'ok', file);
