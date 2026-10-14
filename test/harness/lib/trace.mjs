// Chrome trace (JSON) -> RunTask statistics on the renderer main thread (CrRendererMain).
//
// WHY RunTask and not the Long Tasks API: Long Tasks only report > 50 ms. The budgets that matter are one frame at 120 Hz
// (8.33 ms) and 60 Hz (16.7 ms). Bracket the action with performance.mark('m0') / performance.mark('m1') (category
// blink.user_timing is on by default) and pass windowMarks:['m0','m1'] so setup and idle time are excluded; the renderer is
// then chosen from the process that emitted the marks, which is robust when several renderers exist.
import { readFileSync } from 'node:fs';
import { FRAME_120, FRAME_60, stats } from './util.mjs';

export function loadTraceEvents(file) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  return Array.isArray(j) ? j : j.traceEvents;
}

/**
 * @typedef {object} TraceOptions
 * @property {number} [pid] renderer pid
 * @property {string} [urlMatch] pick the renderer whose frame URL contains this
 * @property {string[]} [windowMarks] ['m0','m1'] user-timing marks bracketing the window
 * @property {{startTs:number,endTs:number}} [window] absolute trace timestamps (microseconds)
 * @property {number} [thresholdMs=FRAME_120] tasks above this go to `longFrames`
 * @property {number} [top=15]
 * @property {number} [maxLongFrames=200]
 *
 * @typedef {object} TraceReport
 * @property {{count:number,over8_33ms:number,over16_7ms:number,over50ms:number,p50:number,p95:number,p99:number,max:number,totalMs:number,busyPct:number|null}} runTask
 * @property {{tsMs:number,durMs:number,topEvents:[string,number][]}[]} longFrames every RunTask above thresholdMs, in time order
 * @property {{tsMs:number,durMs:number,topEvents:[string,number][]}[]} longest the `top` longest tasks
 */
/** @param {string} file @param {TraceOptions & {events?:object[]}} [opts] @returns {TraceReport|{error:string}} */
export function analyzeTrace(file, opts = {}) {
  return analyzeEvents(opts.events ?? loadTraceEvents(file), opts);
}

export function analyzeEvents(events, { pid, urlMatch, thread = 'CrRendererMain', window, windowMarks, thresholdMs = FRAME_120, top = 15, maxLongFrames = 200 } = {}) {
  const threadNames = new Map();
  for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') threadNames.set(`${e.pid}:${e.tid}`, e.args.name);
  const mains = [...threadNames].filter(([, n]) => n === thread).map(([k]) => k.split(':').map(Number));
  const runTasks = new Map();
  for (const e of events) if (e.name === 'RunTask' && e.ph === 'X' && typeof e.dur === 'number') {
    const k = `${e.pid}:${e.tid}`; if (threadNames.get(k) !== thread) continue;
    if (!runTasks.has(k)) runTasks.set(k, []);
    runTasks.get(k).push(e);
  }

  let w = window, chosen = null;
  if (!w && windowMarks) {
    const find = n => events.find(e => e.name === n && ['R', 'I', 'i', 'b', 'n'].includes(e.ph));
    const a = find(windowMarks[0]), b = find(windowMarks[1]);
    if (!a || !b) return { error: 'window marks not found in trace (is category blink.user_timing on, and were the marks made in the page?)', marks: windowMarks };
    w = { startTs: a.ts, endTs: b.ts };
    if (threadNames.get(`${a.pid}:${a.tid}`) === thread) chosen = [a.pid, a.tid];
    else chosen = mains.find(([p]) => p === a.pid) ?? null;
  }
  if (!chosen && pid) chosen = mains.find(([p]) => p === pid) ?? null;
  if (!chosen && urlMatch) {
    const pids = new Set();
    for (const e of events) {
      if (e.name === 'TracingStartedInBrowser') for (const f of e.args?.data?.frames ?? []) if (f.url?.includes(urlMatch)) pids.add(f.processId);
      const u = e.args?.data?.url; if (typeof u === 'string' && u.includes(urlMatch) && mains.some(([p]) => p === e.pid)) pids.add(e.pid);
    }
    chosen = mains.find(([p]) => pids.has(p)) ?? null;
  }
  if (!chosen) { // busiest main thread
    let best = -1; for (const [k, arr] of runTasks) { const t = arr.reduce((s, e) => s + e.dur, 0); if (t > best) { best = t; chosen = k.split(':').map(Number); } }
  }
  if (!chosen) return { error: `no ${thread} RunTask events found (missing disabled-by-default-devtools.timeline category?)`, eventCount: events.length };
  const [cpid, ctid] = chosen;

  // keep top-level RunTasks only (drop nested), then window
  const sorted = (runTasks.get(`${cpid}:${ctid}`) ?? []).slice().sort((a, b) => a.ts - b.ts);
  let tasks = []; let endMax = -Infinity;
  for (const t of sorted) if (t.ts >= endMax || t.ts + t.dur > endMax) { tasks.push(t); endMax = Math.max(endMax, t.ts + t.dur); }
  if (w) tasks = tasks.filter(t => t.ts >= w.startTs && t.ts + t.dur <= w.endTs);
  const durMs = tasks.map(t => t.dur / 1000);
  const startTs = w?.startTs ?? tasks[0]?.ts ?? 0;
  const endTs = w?.endTs ?? (tasks.length ? tasks[tasks.length - 1].ts + tasks[tasks.length - 1].dur : 0);
  const spanMs = (endTs - startTs) / 1000;
  // A window with zero tasks is a harness failure, never "0 long tasks": report it as an error so it cannot pass a gate.
  if (!tasks.length) return { error: 'no RunTask events inside the window: the trace/window is empty, not "no jank"', pid: cpid, spanMs };

  const mainEvents = events.filter(e => e.pid === cpid && e.tid === ctid && e.ph === 'X' && e.name !== 'RunTask' && (!w || (e.ts >= w.startTs && e.ts <= w.endTs)));
  const describe = t => {
    const agg = new Map();
    for (const e of mainEvents) if (e.ts >= t.ts && e.ts + (e.dur ?? 0) <= t.ts + t.dur) agg.set(e.name, (agg.get(e.name) ?? 0) + (e.dur ?? 0) / 1000);
    return { tsMs: (t.ts - startTs) / 1000, durMs: t.dur / 1000, topEvents: [...agg].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, d]) => [n, +d.toFixed(2)]) };
  };
  const incl = new Map();
  for (const e of mainEvents) { const a = incl.get(e.name) ?? { ms: 0, n: 0 }; a.ms += (e.dur ?? 0) / 1000; a.n++; incl.set(e.name, a); }
  const raf = mainEvents.filter(e => e.name === 'FireAnimationFrame').sort((a, b) => a.ts - b.ts);
  const rafIv = []; for (let i = 1; i < raf.length; i++) rafIv.push((raf[i].ts - raf[i - 1].ts) / 1000);
  const s = stats(durMs); const total = durMs.reduce((a, b) => a + b, 0);
  const over = limit => durMs.filter(d => d > limit).length;
  return {
    pid: cpid, tid: ctid, thread, renderers: mains.length, spanMs, windowed: !!w,
    runTask: { count: tasks.length, over8_33ms: over(FRAME_120), over16_7ms: over(FRAME_60), over50ms: over(50), p50: s.p50, p95: s.p95, p99: s.p99, max: s.max, totalMs: total, busyPct: spanMs ? 100 * total / spanMs : null },
    thresholdMs,
    longFrames: tasks.filter(t => t.dur / 1000 > thresholdMs).slice(0, maxLongFrames).map(describe),
    longest: tasks.slice().sort((a, b) => b.dur - a.dur).slice(0, top).map(describe),
    eventsByInclusiveMs: [...incl].sort((a, b) => b[1].ms - a[1].ms).slice(0, 25).map(([name, v]) => ({ name, ms: +v.ms.toFixed(2), n: v.n })),
    rafFires: { n: raf.length, intervalsMs: stats(rafIv) },
    note: 'over8_33ms / over16_7ms are the budgets that matter; the 50 ms Long Tasks threshold is NOT a success metric. eventsByInclusiveMs double-counts nesting.',
  };
}
