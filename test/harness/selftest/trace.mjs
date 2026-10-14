// Tracing + RunTask analysis, CPU profile summaries, heap/DOM/listener sampling.
import { resolve } from 'node:path';
import { analyzeTrace } from '../lib/trace.mjs';
import { summarizeCpuProfile } from '../lib/cpuprofile.mjs';
import { sleep } from '../lib/util.mjs';

const spin = ms => `{ const s = performance.now(); while (performance.now() - s < ${ms}) {} }`;

export async function run({ check, info, page, browser, srv, outDir }) {
  await page.navigate(`${srv.url}/test/harness/selftest-fixture/app.html`);
  await page.waitForFunction('window.__APP_READY');
  await page.requireForeground('trace section');

  // ---- trace parser positive controls: a 40 ms task, a 12 ms task, and a quiet window, all in ONE trace
  await browser.traceStart();
  await page.evaluate(`(async () => {
    const gap = ms => new Promise(r => setTimeout(r, ms));
    await gap(150);
    performance.mark('q0'); await gap(400); performance.mark('q1');            // quiet window
    await gap(100);
    performance.mark('n0'); await gap(60); ${spin(12)} await gap(60); performance.mark('n1');   // exactly one 12 ms task
    await gap(100);
    performance.mark('m0'); await gap(60); ${spin(40)} await gap(60); performance.mark('m1');   // exactly one 40 ms task
    await gap(100);
  })()`);
  const tr = await browser.traceStop(resolve(outDir, 'selftest-trace.json'));
  info('trace file', { bytes: tr.bytes, ms: tr.ms });
  const quiet = analyzeTrace(tr.file, { windowMarks: ['q0', 'q1'] });
  const mid = analyzeTrace(tr.file, { windowMarks: ['n0', 'n1'] });
  const big = analyzeTrace(tr.file, { windowMarks: ['m0', 'm1'] });
  check('trace: quiet window has no task over 8.33 ms', !quiet.error && quiet.runTask.over8_33ms === 0, quiet.error ?? quiet.runTask);
  check('trace: 12 ms task counted over 8.33 ms but NOT over 16.7 ms', !mid.error && mid.runTask.over8_33ms === 1 && mid.runTask.over16_7ms === 0 && mid.runTask.max >= 11.5 && mid.runTask.max < 16, mid.error ?? mid.runTask);
  check('trace: 40 ms task counted over 16.7 ms and over 8.33 ms, max ~40', !big.error && big.runTask.over16_7ms === 1 && big.runTask.over8_33ms === 1 && big.runTask.max >= 39 && big.runTask.over50ms === 0, big.error ?? big.runTask);
  check('trace: longFrames lists the long task with its duration and top events', big.longFrames?.length === 1 && big.longFrames[0].durMs >= 39, big.longFrames);
  check('trace: renderer chosen from the process that emitted the marks (pid matches)', big.pid === mid.pid && big.pid === quiet.pid, { pid: big.pid });
  const none = analyzeTrace(tr.file, { windowMarks: ['nope0', 'nope1'] });
  check('trace: missing marks -> explicit error (not "0 long tasks")', !!none.error, none.error);
  const empty = analyzeTrace(tr.file, { window: { startTs: 9e15, endTs: 9.1e15 }, pid: big.pid });
  check('trace: empty window -> explicit error (an empty trace can never pass a gate)', !!empty.error, empty.error);
  info('quiet window busy %', { busyPct: quiet.runTask.busyPct, tasks: quiet.runTask.count, rafFires: quiet.rafFires.n });

  // ---- CPU profile: self vs total
  await page.evaluate(`window.inner = function inner() { ${spin(30)} }; window.outer = function outer() { inner(); inner(); inner(); }; 0`);
  await page.cpuProfileStart({ intervalUs: 200 });
  await page.evaluate('outer()');
  const prof = await page.cpuProfileStop(resolve(outDir, 'selftest.cpuprofile'));
  const sum = summarizeCpuProfile(prof);
  const inner = sum.bySelf.find(r => r.fn === 'inner'), outer = sum.byTotal.find(r => r.fn === 'outer'), outerSelf = sum.bySelf.find(r => r.fn === 'outer');
  // performance.now() builtin samples are attributed to `now`, so inner's self time is below the 90 ms burned; its inclusive time is not
  check('cpu profile: inner() is the top self row, ~90 ms inclusive (3 x 30 ms)', !!inner && sum.bySelf[0].fn === 'inner' && inner.selfMs > 50 && inner.totalMs > 75 && inner.totalMs < 140, inner);
  check('cpu profile: total table has outer() >= inner self, with ~0 self time of its own', !!outer && outer.totalMs >= inner.totalMs * 0.95 && (!outerSelf || outerSelf.selfMs < 5), { outer, outerSelf });
  info('cpu profile', { totalMs: sum.totalMs, negativeDeltas: sum.negativeDeltas, topSelf: sum.bySelf.slice(0, 3).map(r => `${r.fn} ${r.selfMs.toFixed(1)}`) });

  // ---- heap / DOM node / listener sampling: growth must be visible
  await page.evaluate(`setTimeout(() => { window.__leak = []; for (let i = 0; i < 4000; i++) { const d = document.createElement('div'); d.addEventListener('click', () => {}); d.addEventListener('keydown', () => {}); document.body.appendChild(d); window.__leak.push(d); } }, 250)`);
  const hs = await page.sampleHeap({ n: 6, intervalMs: 150 });
  check('heap sampler: DOM node growth >= 4000 and listener growth >= 8000 visible', hs.growth.nodes >= 4000 && hs.growth.jsEventListeners >= 8000, hs.growth);
  info('heap rows (first,last)', [hs.rows[0], hs.rows[hs.rows.length - 1]]);
  await page.evaluate('window.__leak.forEach(d => d.remove()); window.__leak = null; 0');
  await sleep(100);
  const pm = await page.perfMetrics();
  check('perfMetrics returns JSHeapUsedSize', pm.JSHeapUsedSize > 0, { JSHeapUsedSize: pm.JSHeapUsedSize, Nodes: pm.Nodes });
}
