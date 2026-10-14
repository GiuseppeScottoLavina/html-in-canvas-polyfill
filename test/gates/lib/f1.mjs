// Shared helpers of the F1 water-form gates: pair of pages (canvas + plain-DOM twin), element geometry from the twin, region diffs.
import { H, polyUrl, sabotage } from './gate.mjs';

export const F1 = '/test/fixtures/f1-water-form/index.html';

/** Open the plain-DOM twin (mode=ref). */
export async function openRef(ctx, id = 'f1', params = {}) {
  const ref = await ctx.page();
  await H.openFixture(ref, ctx.srv, id, { mode: 'ref', params });
  return ref;
}

/** Open the canvas variant with the polyfill. `params` go into the fixture query (painter=none, cap=N, ...). */
export async function openPoly(ctx, id = 'f1', params = {}, { timeout = 20000 } = {}) {
  const page = await ctx.page();
  await H.openFixture(page, ctx.srv, id, { mode: 'poly', bundle: ctx.bundle, params, timeout });
  return page;
}

/** css-px rect (viewport coordinates) of every selector, read from a plain DOM page. */
export async function rectsOf(page, selectors) {
  return page.evaluate(`(() => { const out = {}; for (const s of ${JSON.stringify(selectors)}) { const e = document.querySelector(s); if (!e) { out[s] = null; continue; } const r = e.getBoundingClientRect(); out[s] = { x: r.left, y: r.top, width: r.width, height: r.height }; } return out; })()`);
}

export const center = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/** Compositor screenshot of the surface element. */
export async function shotSurface(page, selector = '#hic-surface') {
  return H.screenshotElement(page, selector);
}

/** Pixel diff of two screenshots, optionally restricted to a css-px rect relative to the surface. */
export function diffImages(a, b, { rect, dpr = 1 } = {}) {
  if (!rect) return H.compareImages(a, b, { diffImage: false });
  const r = { x: Math.max(0, Math.floor(rect.x * dpr)), y: Math.max(0, Math.floor(rect.y * dpr)), w: Math.ceil(rect.width * dpr), h: Math.ceil(rect.height * dpr) };
  r.w = Math.min(r.w, a.width - r.x); r.h = Math.min(r.h, a.height - r.y);
  return H.compareImages(H.cropImage(a, r.x, r.y, r.w, r.h), H.cropImage(b, r.x, r.y, r.w, r.h), { diffImage: false });
}

export { H, polyUrl, sabotage };
