// Independent presentation clock for WebGPU canvases. The effect host presents one frame per `GPUCanvasContext.getCurrentTexture()` call; the tracker (installed before
// any page script) stamps every call with performance.now(). This is the browser API the polyfill actually drives, NOT the polyfill's own `effectframe` event (TEST-PLAN
// rule 7: the cap is never judged by the polyfill's own counters).
export const PRESENT_SRC = `(() => {
  if (window.__present) return;
  const P = window.__present = { stamps: [] };
  const C = window.GPUCanvasContext; if (!C) return;
  const o = C.prototype.getCurrentTexture;
  C.prototype.getCurrentTexture = function (...a) { P.stamps.push(performance.now()); if (P.stamps.length > 20000) P.stamps.splice(0, 10000); return o.apply(this, a); };
})()`;

/** Presented-frame rate over `ms` from the independent stamps. */
export async function presentedHz(page, ms = 3000) {
  const stamps = await page.evaluate(`(async () => { const s = window.__present.stamps; const n0 = s.length; await new Promise((r) => setTimeout(r, ${ms})); return s.slice(n0); })()`);
  if (stamps.length < 2) return { frames: stamps.length, hz: 0 };
  return { frames: stamps.length, hz: (stamps.length - 1) / ((stamps[stamps.length - 1] - stamps[0]) / 1000) };
}
