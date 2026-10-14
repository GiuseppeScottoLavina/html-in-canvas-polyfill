// Section helpers: a blank-frame watch around an interaction (O-blank across typing, scroll and click, not only resize) and a bounded keystroke-to-pixel
// latency assertion (O-latency). Both read the CANVAS backing store, so a live-DOM leak cannot satisfy them.
import { H } from './gate.mjs';

/**
 * Run `fn` while every rendering update's canvas content score is sampled; zero blank frames and a valid run (the canvas had content) are asserted.
 * A one-frame blank inside `fn` is therefore a failure even though the gate sleeps before reading its screenshots.
 * @param {*} ctx @param {*} page @param {string} name
 * @param {() => Promise<any>} fn
 * @param {{selector?:string, grid?:[number,number], inject?:boolean}} [o]  inject: control only, clear one frame so the detector must see it
 */
export async function withBlankWatch(ctx, page, name, fn, { selector = '#hic-surface', grid = [160, 100], inject = false } = {}) {
  await ctx.focus(page);
  const detector = await H.startBlankDetector(page, { selector, grid });
  await H.sleep(150);
  let out;
  try { out = await fn(); } finally { /* the detector is stopped below even when fn throws */ }
  if (inject) { await detector.injectBlankFrame(); await H.sleep(300); }
  const report = await detector.stop();
  await ctx.stillFocused(page, `${name} blank watch`);
  ctx.check(`${name}: the blank watch ran on a canvas with content (${report.frames} frames)`, report.valid && report.frames >= 5, { frames: report.frames, baseline: report.baseline }, 'blank');
  ctx.check(`${name}: zero blank frames in every rendering update`, report.blankFrames.length === 0, { blankFrames: report.blankFrames.slice(0, 5), runs: report.blankRuns }, 'blank');
  return { out, report };
}

/** A random lowercase nonce: typed first so no snapshot image of this run was ever decoded/cached for the following text states. */
export const nonce = (n = 4) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');

/** Distinct characters, so no two trials produce the same pixels (an image-cache hit would make a trial look fast). */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Keydown-to-canvas-pixel latency into the focused text control, with bounded assertions (O-latency: >= 30 trials, p50 and p95).
 * Two blocks: (A) the typed text FITS the field (3 rounds of 10 trials, the field cleared and a fresh nonce typed between rounds so no text state repeats and no
 * decoded-image cache can answer a trial), (B) the text overflows and scrolls inside the field (10 trials).
 * @param {{region:{x:number,y:number,w:number,h:number}, inputId:string, p50Max?:number, p95Max?:number, name?:string, minFraction?:number, gapMs?:number, selector?:string, numbers?:object}} o  region in canvas BACKING pixels
 */
export async function checkTypingLatency(ctx, page, { region, inputId, p50Max = 34, p95Max = 100, name = 'typing latency', minFraction = 0.004, gapMs = 140, numbers = {}, selector = '#hic-surface' }) {
  await ctx.focus(page);
  const block = async (count, k) => {
    const res = await H.measureLatency(page, {
      selector, region, eventType: 'keydown', trials: count, gapMs, timeoutMs: 1500,
      expect: { kind: 'changed', minFraction, delta: 24 },
      trigger: (i) => page.key(ALPHABET[(k + i) % ALPHABET.length]),
    });
    return res;
  };
  const summarize = (label, results) => {
    const all = results.flatMap((r) => r.trials.map((t) => t.commitMs).filter((v) => v !== null));
    const n = results.reduce((a, r) => a + r.trials.length, 0);
    const timedOut = results.reduce((a, r) => a + r.timedOut, 0), noEvent = results.reduce((a, r) => a + r.noEvent, 0);
    const s = H.stats(all);
    const rec = { trials: n, perTrialMs: results.flatMap((r) => r.trials.map((t) => (t.commitMs === null ? null : Math.round(t.commitMs)))), timedOut, noEvent, commitMs: s, framePeriodMs: results[0].framePeriodMs };
    numbers[`${name} ${label}`] = rec;
    return { rec, s, timedOut, noEvent, n };
  };
  const clear = async () => { await page.evaluate(`(() => { const e = document.getElementById(${JSON.stringify(inputId)}); e.value = ''; e.focus(); })()`); await H.sleep(250); await H.typeKeys(page, nonce(3), { intervalMs: 50 }); await H.sleep(300); };
  const fit = [];
  for (let round = 0; round < 3; round++) { await clear(); fit.push(await block(10, round * 10)); }
  const a = summarize('(text fits the field)', fit);
  await ctx.stillFocused(page, name);
  ctx.check(`${name}: every trial reached the canvas pixels while the text fits (timeouts ${a.timedOut}, missing events ${a.noEvent}, ${a.n} trials)`, a.timedOut === 0 && a.noEvent === 0 && a.s.n === a.n && a.n >= 30, a.rec, 'latency');
  ctx.check(`${name}: keydown-to-pixel p50 <= ${p50Max} ms and p95 <= ${p95Max} ms while the text fits (commit time, observer overhead included)`, a.s.p50 <= p50Max && a.s.p95 <= p95Max, { p50: a.s.p50, p95: a.s.p95, max: a.s.max }, 'latency');
  await clear();
  await H.typeKeys(page, 'abcdefghijklmnopqrstuvwxyz', { intervalMs: 40 }); // the text now overflows the field and scrolls
  await H.sleep(700);
  const over = summarize('(text scrolls inside the field)', [await block(12, 30)]);
  ctx.check(`${name}: the same bound holds while the text scrolls inside the field (p50 <= ${p50Max} ms, p95 <= ${p95Max} ms)`, over.timedOut === 0 && over.s.p50 <= p50Max && over.s.p95 <= p95Max, { p50: over.s.p50, p95: over.s.p95, max: over.s.max, perTrialMs: over.rec.perTrialMs }, 'latency');
  return { fit: a.rec, overflow: over.rec };
}
