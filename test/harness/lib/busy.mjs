// "Busy main thread" load: blocks the page's main thread for `busyMs` out of every `periodMs`, to show whether an interaction
// (page scroll, resize, effect frames) survives a loaded main thread. Compositor-driven scrolling should not care; anything that
// needs main-thread JS per frame will.
//
//   const load = await startBusyMain(page, { busyMs: 12, periodMs: 16.7 });
//   ... run the interaction, trace it ...
//   const r = await load.stop();   // {ticks, achievedBusyPct, requestedBusyPct, blockMs:{p50,p95,max}, periodMsActual:{...}, ok}
//
// Check `ok` / `achievedBusyPct`: timers can be late, so the load that was really applied is measured, not assumed.
import { stats } from './util.mjs';

export async function startBusyMain(page, { busyMs = 12, periodMs = 1000 / 60 } = {}) {
  await page.evaluate(`(() => {
    const busy = ${busyMs}, period = ${periodMs}; const blocks = [], starts = [];
    const S = window.__hicBusy = { running: true, t0: performance.now() };
    const tick = () => {
      if (!S.running) return;
      const s = performance.now(); starts.push(s);
      while (performance.now() - s < busy) { /* burn */ }
      blocks.push(performance.now() - s);
      const next = Math.max(0, period - (performance.now() - s));
      setTimeout(tick, next);
    };
    S.stop = () => { S.running = false; return { blocks, starts, spanMs: performance.now() - S.t0 }; };
    setTimeout(tick, 0); return true;
  })()`);
  return {
    stop: async () => {
      const { blocks, starts, spanMs } = await page.evaluate('window.__hicBusy.stop()');
      const gaps = starts.slice(1).map((s, i) => s - starts[i]);
      const achievedBusyPct = 100 * blocks.reduce((a, b) => a + b, 0) / spanMs;
      const requestedBusyPct = 100 * busyMs / periodMs;
      return { ticks: blocks.length, requestedBusyPct, achievedBusyPct, blockMs: stats(blocks), periodMsActual: stats(gaps), ok: Math.abs(achievedBusyPct - requestedBusyPct) <= Math.max(5, 0.2 * requestedBusyPct) };
    },
  };
}
