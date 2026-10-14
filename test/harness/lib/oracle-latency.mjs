// Input -> pixel latency probe.
//
// Per trial: (1) the page snapshots a region of the target canvas, (2) the harness injects a trusted event, (3) a page-side
// sampler reads the region after every rendering update and reports the FIRST update whose pixels contain the expected change.
//
//   t0 = event.timeStamp of the first matching trusted event as the page received it (same clock as performance.now()).
//        Browser->renderer IPC before that point is NOT included (typically well under a frame).
//   t1 = rAF timestamp (frame start) of the first rendering update whose committed canvas pixels satisfy `expect`.
//   commitMs    = t1 - t0
//   presentedMs = commitMs + one measured frame period: the update that committed the change is shown at the following
//                 refresh; this is an estimate, quantised to the frame period (8.3 ms at 120 Hz). Use p50/p95 over many trials.
//
// OBSERVER OVERHEAD: the sampler reads back a region every frame (drawImage + getImageData, see sampleCostMs, typically
// 0.2-2 ms/frame). It adds to main-thread load, so compare like with like (same probe on both arms) and never mix a probed
// latency run with a RunTask-budget run. Caret blink / animations inside `region` cause false hits: choose a quiet region or a
// stricter `expect`.
//
// WebGPU canvases can return empty readbacks (known): probe a 2D canvas, or `effect=off` surfaces.
import { stats } from './util.mjs';

const INSTALL_SRC = `(() => {
  if (window.__hicLat) return true;
  const L = window.__hicLat = { pending: null };
  L.prepare = (o) => {
    const canvas = document.querySelector(o.selector); if (!canvas) throw new Error('latency probe: canvas not found ' + o.selector);
    const dpr = canvas.width / (canvas.getBoundingClientRect().width || canvas.width);
    const r = o.region ?? { x: 0, y: 0, w: canvas.width, h: canvas.height }; // canvas backing pixels
    const GW = Math.min(o.maxW ?? 160, r.w), GH = Math.min(o.maxH ?? 96, r.h);
    const sc = document.createElement('canvas'); sc.width = GW; sc.height = GH; const sctx = sc.getContext('2d', { willReadFrequently: true });
    const read = () => { sctx.clearRect(0, 0, GW, GH); sctx.drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, GW, GH); return sctx.getImageData(0, 0, GW, GH).data; };
    const st = { o, base: read(), t0: null, t1: null, frames: 0, costs: [], done: false, dpr, GW, GH, framePeriods: [], lastRaf: null };
    const ch = new MessageChannel(); let rafTs = 0;
    const evType = o.eventType;
    const onEv = (e) => { if (st.t0 === null) { st.t0 = e.timeStamp; } };
    addEventListener(evType, onEv, { capture: true, passive: true });
    const hit = (d) => {
      const e = o.expect ?? { kind: 'changed', minFraction: 0.001, delta: 12 };
      if (e.kind === 'pixel') { const i = ((e.y * GW) + e.x) * 4; return Math.max(Math.abs(d[i] - e.rgb[0]), Math.abs(d[i + 1] - e.rgb[1]), Math.abs(d[i + 2] - e.rgb[2])) <= (e.tol ?? 8); }
      let ch = 0; for (let i = 0; i < d.length; i += 4) if (Math.max(Math.abs(d[i] - st.base[i]), Math.abs(d[i + 1] - st.base[i + 1]), Math.abs(d[i + 2] - st.base[i + 2]), Math.abs(d[i + 3] - st.base[i + 3])) > (e.delta ?? 12)) ch++;
      return ch / (GW * GH) >= (e.minFraction ?? 0.001);
    };
    ch.port1.onmessage = () => {
      if (st.done) return;
      const a = performance.now(); const d = read(); st.costs.push(performance.now() - a);
      st.frames++;
      if (st.t0 !== null && hit(d)) finish(false);
    };
    const finish = (timedOut) => { st.done = true; st.timedOut = timedOut; st.t1 = timedOut ? null : rafTs; removeEventListener(evType, onEv, true); clearTimeout(st.timer); st.resolve({ t0: st.t0, t1: st.t1, timedOut, frames: st.frames, costs: st.costs, framePeriods: st.framePeriods }); };
    const frame = (ts) => { if (st.done) return; rafTs = ts; if (st.lastRaf !== null) st.framePeriods.push(ts - st.lastRaf); st.lastRaf = ts; ch.port2.postMessage(0); requestAnimationFrame(frame); };
    st.promise = new Promise(res => { st.resolve = res; });
    st.timer = setTimeout(() => finish(true), o.timeoutMs ?? 1500);
    requestAnimationFrame(frame);
    L.pending = st; return true;
  };
  L.result = () => L.pending.promise;
  return true;
})()`;

/**
 * @typedef {object} LatencyOptions
 * @property {string} [selector='#hic-surface'] target canvas
 * @property {{x:number,y:number,w:number,h:number}} [region] in CANVAS BACKING pixels; default whole canvas (downscaled to <= 160x96, so give a small region for small changes)
 * @property {'keydown'|'pointerdown'|'pointerup'|'pointermove'|'wheel'|'click'|'input'} [eventType='keydown']
 * @property {()=>Promise<any>} trigger injects the event (e.g. () => page.key('a'))
 * @property {number} [trials=20]
 * @property {number} [gapMs=250] quiet time between trials so the previous change has settled
 * @property {number} [timeoutMs=1500]
 * @property {{kind:'changed',minFraction?:number,delta?:number}|{kind:'pixel',x:number,y:number,rgb:number[],tol?:number}} [expect]
 */
/**
 * @param {import('./page.mjs').Page} page
 * @param {LatencyOptions} o
 * @returns {Promise<{trials:object[], timedOut:number, noEvent:number, commitMs:object, presentedMs:object, sampleCostMs:object, framePeriodMs:number, note:string}>}
 */
export async function measureLatency(page, o) {
  const { trials = 20, gapMs = 250, trigger } = o;
  await page.assertForeground('before latency probe');
  await page.evaluate(INSTALL_SRC);
  const rows = [];
  for (let i = 0; i < trials; i++) {
    await page.evaluate(`window.__hicLat.prepare(${JSON.stringify({ selector: o.selector ?? '#hic-surface', region: o.region, eventType: o.eventType ?? 'keydown', timeoutMs: o.timeoutMs ?? 1500, expect: o.expect })})`);
    const result = page.evaluate('window.__hicLat.result()');
    await new Promise(r => setTimeout(r, 30)); // let the sampler arm its first frame
    await trigger(i);
    const r = await result;
    rows.push(r);
    await new Promise(r2 => setTimeout(r2, gapMs));
  }
  const periods = rows.flatMap(r => r.framePeriods).filter(p => p > 1);
  const framePeriodMs = stats(periods).p50 ?? 0;
  const ok = rows.filter(r => !r.timedOut && r.t0 !== null);
  const commit = ok.map(r => r.t1 - r.t0);
  return {
    trials: rows.map((r, i) => ({ i, t0: r.t0, t1: r.t1, commitMs: r.t0 !== null && r.t1 !== null ? r.t1 - r.t0 : null, timedOut: r.timedOut })),
    timedOut: rows.filter(r => r.timedOut && r.t0 !== null).length, noEvent: rows.filter(r => r.t0 === null).length,
    commitMs: stats(commit), presentedMs: stats(commit.map(c => c + framePeriodMs)),
    sampleCostMs: stats(rows.flatMap(r => r.costs)), framePeriodMs,
    note: 'commitMs = rAF timestamp of the first update whose canvas pixels show the change minus event.timeStamp; presentedMs adds one frame period (estimate). Quantised to the frame period.',
  };
}
