// POSITIVE-CONTROLLED blank-frame detector.
//
// A page-side sampler reads a 2D/WebGPU/WebGL canvas after EVERY rendering update and records a content score. Frames whose
// score collapses (cleared bitmap, flat fill, size write that wiped the backing store) are reported as blank.
//
// WHEN IS A FRAME SAMPLED: rAF callback k posts a MessageChannel message; the handler runs as a separate task AFTER the
// rendering update k (rAF -> style/layout -> ResizeObserver -> paint-event -> commit) has finished. So the sample is the canvas
// state that update k committed (what the next display refresh shows), regardless of the order of other rAF callbacks.
// A blank that exists only INSIDE one task (cleared and redrawn before the update ends) was never presented and is correctly
// not reported.
//
// OBSERVER OVERHEAD: each sample is drawImage(canvas -> GRID) + getImageData(GRID) on the main thread. The cost per sample is
// recorded (`sampleCostMs`) and printed by the self-test; for a 2D canvas at 2x DPR it is a few tenths of a ms to ~1-2 ms. It
// is NOT free: do not use the detector's own run for a main-thread-budget claim; measure jank in a separate traced run.
//
// POSITIVE CONTROL: `injectBlankFrame()` makes the sampler clear the (2D) canvas for exactly one presented frame and restore it.
// `proveBlankDetector()` runs a clean run (must report 0 blank frames) and an injected run (must report exactly 1 blank run of
// 1 frame); a detector that cannot see an injected blank must not be trusted for any gate.
import { quantile } from './util.mjs';

const SAMPLER_SRC = (selector, gw, gh) => `(() => {
  const GW = ${gw}, GH = ${gh};
  const canvas = document.querySelector(${JSON.stringify(selector)});
  if (!canvas) throw new Error('blank detector: canvas not found: ' + ${JSON.stringify(selector)});
  const scratch = document.createElement('canvas'); scratch.width = GW; scratch.height = GH;
  const sctx = scratch.getContext('2d', { willReadFrequently: true });
  const rec = { t: [], score: [], alpha: [], w: [], h: [], cost: [], injected: [] };
  const S = { running: true, injectPending: false, restoreNext: false, backup: null, injectedAtFrame: null, healed: false };
  const ch = new MessageChannel();
  function sample() {
    const t0 = performance.now();
    let score = 0, alpha = 0;
    if (canvas.width > 0 && canvas.height > 0) {
      sctx.clearRect(0, 0, GW, GH);
      try { sctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, GW, GH); } catch (e) { S.error = String(e); }
      const d = sctx.getImageData(0, 0, GW, GH).data, n = GW * GH;
      const hist = [0, 1, 2, 3].map(() => new Uint16Array(256));
      let a = 0;
      for (let i = 0; i < n; i++) { hist[0][d[i*4]]++; hist[1][d[i*4+1]]++; hist[2][d[i*4+2]]++; hist[3][d[i*4+3]]++; a += d[i*4+3]; }
      alpha = a / n / 255;
      const med = hist.map(h => { let c = 0; for (let v = 0; v < 256; v++) { c += h[v]; if (c * 2 >= n) return v; } return 0; });
      let off = 0;
      for (let i = 0; i < n; i++) if (Math.max(Math.abs(d[i*4]-med[0]), Math.abs(d[i*4+1]-med[1]), Math.abs(d[i*4+2]-med[2]), Math.abs(d[i*4+3]-med[3])) > 10) off++;
      score = off / n;
    }
    const idx = rec.t.length;
    rec.t.push(performance.now()); rec.score.push(score); rec.alpha.push(alpha); rec.w.push(canvas.width); rec.h.push(canvas.height);
    rec.cost.push(performance.now() - t0); rec.injected.push(S.restoreNext ? 1 : 0);
    if (S.restoreNext) { restore(); }
    else if (S.injectPending) { S.injectPending = false; inject(idx); }
  }
  function inject(idx) {
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('injectBlankFrame needs a 2D canvas');
    const b = document.createElement('canvas'); b.width = canvas.width; b.height = canvas.height;
    b.getContext('2d').drawImage(canvas, 0, 0);
    S.backup = b; S.injectedAtFrame = idx + 1; S.restoreNext = true;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.restore();
  }
  function restore() {
    const ctx = canvas.getContext('2d');
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'copy'; ctx.drawImage(S.backup, 0, 0); ctx.restore();
    S.restoreNext = false; S.backup = null;
  }
  ch.port1.onmessage = sample;
  function frame() { if (!S.running) return; ch.port2.postMessage(0); requestAnimationFrame(frame); }
  requestAnimationFrame(frame);
  window.__hicBlank = {
    inject: () => { S.injectPending = true; },
    stop: () => { S.running = false; return { rec, injectedAtFrame: S.injectedAtFrame, error: S.error ?? null, devicePixelRatio }; },
    frames: () => rec.t.length,
  };
  return true;
})()`;

/**
 * Start sampling `selector` every rendering update.
 * @param {import('./page.mjs').Page} page
 * @param {{selector?:string, grid?:[number,number]}} [o]
 */
export async function startBlankDetector(page, { selector = '#hic-surface', grid = [96, 64] } = {}) {
  await page.assertForeground('before starting the blank detector (rAF stalls in hidden tabs)');
  await page.evaluate(SAMPLER_SRC(selector, grid[0], grid[1]));
  return {
    /** Schedule the one-frame blank (positive control). Needs a 2D canvas that is not redrawn every frame by the app. */
    injectBlankFrame: () => page.evaluate('window.__hicBlank.inject()'),
    framesSoFar: () => page.evaluate('window.__hicBlank.frames()'),
    /** Stop and analyse. @returns {Promise<BlankReport>} */
    stop: async () => analyseBlank(await page.evaluate('window.__hicBlank.stop()')),
  };
}

/**
 * @typedef {object} BlankReport
 * @property {number} frames sampled rendering updates
 * @property {boolean} valid false when the canvas never had content (then every frame is "blank" and the run proves nothing)
 * @property {number} baseline 75th percentile of the content score
 * @property {{frame:number,tMs:number,score:number,alpha:number,reason:string}[]} blankFrames
 * @property {number} blankRuns number of consecutive-blank runs
 * @property {number} longestBlankRun frames
 * @property {{frame:number,from:number[],to:number[]}[]} sizeChanges backing-store size writes (each one clears a 2D canvas)
 * @property {{frame:number,score:number}[]} degradedFrames informational: score below 60 % of baseline but not blank
 * @property {{p50:number,p95:number,max:number}} sampleCostMs observer overhead per sample
 * @property {{n:number,p50:number,p95:number,max:number}} frameGapMs rAF-to-rAF gaps (dropped frames show up here)
 * @property {number|null} injectedAtFrame
 */
export function analyseBlank({ rec, injectedAtFrame, error }, { relMin = 0.25, absMin = 0.0005 } = {}) {
  const n = rec.t.length;
  const baseline = quantile(rec.score, 0.75);
  const valid = n > 0 && baseline >= absMin * 4;
  const isBlank = i => rec.alpha[i] < 0.002 || rec.score[i] < Math.max(absMin, relMin * baseline) || rec.w[i] === 0;
  const blankFrames = []; let runs = 0, longest = 0, cur = 0;
  for (let i = 0; i < n; i++) {
    if (isBlank(i)) {
      blankFrames.push({ frame: i, tMs: rec.t[i], score: rec.score[i], alpha: rec.alpha[i], reason: rec.alpha[i] < 0.002 ? 'transparent' : rec.w[i] === 0 ? 'zero-size' : 'flat' });
      if (cur === 0) runs++; cur++; longest = Math.max(longest, cur);
    } else cur = 0;
  }
  const sizeChanges = [];
  for (let i = 1; i < n; i++) if (rec.w[i] !== rec.w[i - 1] || rec.h[i] !== rec.h[i - 1]) sizeChanges.push({ frame: i, from: [rec.w[i - 1], rec.h[i - 1]], to: [rec.w[i], rec.h[i]] });
  const gaps = rec.t.slice(1).map((t, i) => t - rec.t[i]);
  return {
    frames: n, valid, baseline, blankFrames, blankRuns: runs, longestBlankRun: longest, sizeChanges, injectedAtFrame, error,
    degradedFrames: rec.score.map((score, frame) => ({ frame, score })).filter(f => !isBlank(f.frame) && f.score < 0.6 * baseline),
    sampleCostMs: { p50: quantile(rec.cost, 0.5), p95: quantile(rec.cost, 0.95), max: Math.max(...rec.cost, 0) },
    frameGapMs: { n: gaps.length, p50: quantile(gaps, 0.5), p95: quantile(gaps, 0.95), max: Math.max(...gaps, 0) },
  };
}

/** A gate helper: throws unless the run was valid and had no blank frame. */
export function assertNoBlankFrames(report, what = 'surface') {
  if (!report.valid) throw new Error(`${what}: blank detector run is INVALID (canvas never had content), so it proves nothing`);
  if (report.blankFrames.length) throw new Error(`${what}: ${report.blankFrames.length} blank frame(s) in ${report.blankRuns} run(s), longest ${report.longestBlankRun}; first at frame ${report.blankFrames[0].frame}`);
}

/**
 * Prove the detector fires on THIS canvas. Clean run -> expect 0 blank frames; injected run -> expect exactly one blank run of
 * one frame at the injected frame. The canvas must be a 2D canvas whose app does not redraw it every frame.
 * @returns {Promise<{ok:boolean, clean:BlankReport, injected:BlankReport, caught:boolean, falsePositives:number, reasons:string[]}>}
 */
export async function proveBlankDetector(page, { selector = '#hic-surface', frames = 40 } = {}) {
  const waitFrames = async (d, n) => { const t0 = await d.framesSoFar(); while ((await d.framesSoFar()) < t0 + n) await new Promise(r => setTimeout(r, 15)); };
  const d1 = await startBlankDetector(page, { selector }); await waitFrames(d1, frames); const clean = await d1.stop();
  const d2 = await startBlankDetector(page, { selector }); await waitFrames(d2, frames >> 1);
  await d2.injectBlankFrame(); await waitFrames(d2, frames >> 1); const injected = await d2.stop();
  const reasons = [];
  if (!clean.valid) reasons.push('clean run invalid (canvas had no content)');
  if (clean.blankFrames.length) reasons.push(`false positive: ${clean.blankFrames.length} blank frame(s) in the clean run`);
  if (!injected.valid) reasons.push('injected run invalid');
  const caught = injected.blankRuns === 1 && injected.longestBlankRun === 1 && injected.blankFrames[0]?.frame === injected.injectedAtFrame;
  if (!caught) reasons.push(`injected blank NOT caught as exactly one 1-frame run at frame ${injected.injectedAtFrame}: runs=${injected.blankRuns} longest=${injected.longestBlankRun} frames=${injected.blankFrames.map(f => f.frame)}`);
  return { ok: reasons.length === 0, clean, injected, caught, falsePositives: clean.blankFrames.length, reasons };
}
