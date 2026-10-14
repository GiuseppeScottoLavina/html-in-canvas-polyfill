// Shared helpers of the comparison scenarios: geometry, focusing a drawn control with a trusted click, sample statistics, nonces.
import { H } from './session.mjs';

/** Letters whose advance is >= ~6 css px in the fixture fonts (no i, j, l, f, t, r): every key moves the text by >= 12 device px. */
export const WIDE = 'abcdeghknopqsuvxyz';
export const nonce = (n, alphabet = WIDE) => Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');

export function stat(values) {
  const s = H.stats(values.filter((v) => v !== null && Number.isFinite(v)));
  if (!s.n) return { n: 0 };
  const r = (x) => (x === undefined ? undefined : +x.toFixed(2));
  return { n: s.n, p50: r(s.p50), p95: r(s.p95), max: r(s.max), mean: r(s.mean), min: r(s.min) };
}

/** Canvas rect (viewport css px) and backing size of the surface on the subject page. */
export async function canvasGeo(page, selector) {
  return page.evaluate(`(() => { const c = document.querySelector(${JSON.stringify(selector)}); const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height, bw: c.width, bh: c.height, dpr: devicePixelRatio }; })()`);
}

/** css rect relative to the canvas -> backing-store region (integers, clamped inside the canvas). */
export function toRegion(rect, geo, inset = { l: 0, r: 0, t: 0, b: 0 }) {
  const sx = geo.bw / geo.width, sy = geo.bh / geo.height;
  const x0 = Math.ceil((rect.x + inset.l) * sx), y0 = Math.ceil((rect.y + inset.t) * sy);
  const x1 = Math.floor((rect.x + rect.width - inset.r) * sx), y1 = Math.floor((rect.y + rect.height - inset.b) * sy);
  const x = Math.max(0, x0), y = Math.max(0, y0);
  return { x, y, w: Math.max(1, Math.min(geo.bw, x1) - x), h: Math.max(1, Math.min(geo.bh, y1) - y) };
}

export function parseRgb(s, fallback = [255, 255, 255]) {
  const m = String(s ?? '').match(/[\d.]+/g);
  if (!m) return fallback;
  if (m.length === 4 && +m[3] === 0) return fallback;
  return [+m[0], +m[1], +m[2]];
}

/** Trusted click at the DRAWN centre of a control (css rect relative to the canvas). Returns the id of the focused element. */
export async function clickDrawn(page, geo, rect) {
  const x = geo.x + rect.x + rect.width / 2, y = geo.y + rect.y + rect.height / 2;
  await page.click(x, y);
  await H.sleep(150);
  return page.evaluate('document.activeElement ? document.activeElement.id : null');
}

/** Focus the control: trusted click on its drawn position first; script focus only as a recorded fallback (the click result is reported). */
export async function focusControl(page, geo, rect, id) {
  const viaClick = await clickDrawn(page, geo, rect);
  if (viaClick === id) return { via: 'click', ok: true };
  await page.evaluate(`document.getElementById(${JSON.stringify(id)}).focus()`);
  await H.sleep(150);
  const now = await page.evaluate('document.activeElement ? document.activeElement.id : null');
  return { via: 'script', clickFocused: viaClick, ok: now === id };
}

/** Compare a canvas backing-store region with a twin screenshot crop. */
export function compareRegion(canvasImg, twinImg, region) {
  const a = H.cropImage(canvasImg, region.x, region.y, Math.min(region.w, canvasImg.width - region.x), Math.min(region.h, canvasImg.height - region.y));
  const b = H.cropImage(twinImg, region.x, region.y, Math.min(region.w, twinImg.width - region.x), Math.min(region.h, twinImg.height - region.y));
  if (a.width !== b.width || a.height !== b.height) return { sizeMismatch: [a.width, a.height, b.width, b.height] };
  const c = H.compareImages(a, b, { diffImage: false });
  return { fraction: +c.fraction.toFixed(4), countOver16: c.countOver16, maxDiff: c.maxDiff, nonBlank: H.pixelStats(a).nonBlank };
}

/** Background of a canvas element (first opaque ancestor colour) for compositing the readback. */
export async function canvasBg(page, selector) {
  return page.evaluate(`(() => { let bg = [255,255,255]; for (let n = document.querySelector(${JSON.stringify(selector)}); n; n = n.parentElement) { const m = getComputedStyle(n).backgroundColor.match(/[\\d.]+/g); if (m && !(m.length === 4 && +m[3] === 0)) { bg = [+m[0], +m[1], +m[2]]; break; } } return bg; })()`);
}

export async function readSurface(page, selector) {
  const bg = await canvasBg(page, selector);
  return H.compositeOver(await H.readCanvas(page, selector), bg);
}

/**
 * Positive control: a frozen renderer. While on, every `paint` event is swallowed in the capture phase AND the 2D calls a paint handler uses
 * (reset, clearRect, drawElementImage, drawImage) are no-ops, so the canvas keeps its last pixels whichever way the implementation invokes the
 * handler (a dispatched event, or a direct onpaint() call that bypasses the capture phase).
 */
export async function freezePaint(page, on) {
  await page.evaluate(`(() => { if (!window.__freezeInstalled) { window.__freezeInstalled = 1; addEventListener('paint', (e) => { if (window.__freeze) e.stopImmediatePropagation(); }, true);
      const P = CanvasRenderingContext2D.prototype; for (const m of ['reset', 'clearRect', 'drawElementImage', 'drawImage']) { const f = P[m]; if (typeof f !== 'function') continue;
        Object.defineProperty(P, m, { configurable: true, writable: true, value: function (...a) { if (window.__freeze && this.canvas && this.canvas.isConnected && this.canvas.hasAttribute('content') || window.__freeze && this.canvas && this.canvas.hasAttribute('layoutsubtree')) return undefined; return f.apply(this, a); } }); } }
    window.__freeze = ${on ? 'true' : 'false'}; return true; })()`);
}
