// Shared helpers of the cross-browser gate (test/xbrowser/run.mjs): page recorder, plain-DOM twin oracle in the SAME engine, canvas readback, in-page probes.
import { decodePng } from '../harness/lib/png.mjs';
import { compareImages, cropImage, pixelStats } from '../harness/lib/pixels.mjs';
import { sleep } from '../harness/lib/util.mjs';

/**
 * Injected at the top of every served HTML page (server `inject`): records console.error/warn, uncaught errors and rejections into window.__XB_LOG,
 * because classic WebDriver has no console log. With ?xbsab=1 (positive control only) it sabotages the page right after parsing: drawElementImage draws
 * nothing and the drawn children stop receiving pointer input. A sound gate must turn red on that page. With ?xbblock=a,b (targeted positive controls) the events a, b never
 * reach any page listener (stopped at the window in the capture phase; default actions still run).
 */
export const RECORDER = `<script>(function(){var L=window.__XB_LOG=[];['error','warn'].forEach(function(k){var o=console[k];console[k]=function(){try{L.push({k:k,m:Array.prototype.map.call(arguments,function(a){return a&&a.stack?String(a.stack):String(a)}).join(' ')})}catch(e){}return o.apply(console,arguments)}});
addEventListener('error',function(e){L.push({k:'exception',m:String(e.message)+' @'+e.filename+':'+e.lineno})});addEventListener('unhandledrejection',function(e){L.push({k:'rejection',m:String(e.reason&&e.reason.stack||e.reason)})});
var xb=/[?&]xbblock=([^&]*)/.exec(location.search);if(xb)decodeURIComponent(xb[1]).split(',').forEach(function(t){addEventListener(t,function(e){e.stopImmediatePropagation()},true)});
if(/[?&]xbsab=1/.test(location.search))document.addEventListener('DOMContentLoaded',function(){window.__XB_SABOTAGED=true;try{Object.defineProperty(CanvasRenderingContext2D.prototype,'drawElementImage',{value:function(){},configurable:true,writable:true})}catch(e){}
var s=document.createElement('style');s.textContent='[drawable],[drawable] *{pointer-events:none!important}';document.head.appendChild(s)});})();</script>`;

/** Page errors recorded by RECORDER (exceptions, rejections, console.error); warnings only when asked. */
export async function pageErrors(s, { warnings = false } = {}) {
  const log = (await s.evaluate('window.__XB_LOG || []')) ?? [];
  return log.filter((e) => warnings || e.k !== 'warn');
}

/**
 * Safari's WebDriver screenshot is in the DISPLAY's colour space (Display P3 on this Mac: the live accent rgb(0,122,255) reads back 52,120,246) while a canvas readback is
 * sRGB, so saturated colours compared 8-18 % apart although they look identical. Measured once per session: Safari on a P3 display (`color-gamut: p3`).
 * @returns {Promise<boolean>}
 */
async function displayP3Shots(s) {
  if (s.engine !== 'safari') return false;
  s.__p3 ??= await s.evaluate("matchMedia('(color-gamut: p3)').matches");
  return s.__p3;
}

/** In place: Display P3 pixels (8-bit, sRGB transfer) -> sRGB, clipped. */
export function p3ToSrgb(img) {
  const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const gam = (v) => { const c = Math.min(1, Math.max(0, v)); return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)); };
  const M = [[1.2249, -0.2247, 0], [-0.0420, 1.0419, 0], [-0.0197, -0.0786, 1.0979]];
  const cache = new Map();
  for (let i = 0; i < img.data.length; i += 4) {
    const key = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2];
    let out = cache.get(key);
    if (!out) { const r = lin(img.data[i]), g = lin(img.data[i + 1]), b = lin(img.data[i + 2]); out = M.map((row) => gam(row[0] * r + row[1] * g + row[2] * b)); cache.set(key, out); }
    img.data[i] = out[0]; img.data[i + 1] = out[1]; img.data[i + 2] = out[2];
  }
}

/** Viewport screenshot cropped to a css-px rect (viewport coordinates). The crop scale is screenshot width / innerWidth (device pixels on DPR 2). */
export async function shotRect(s, rect) {
  const iw = await s.evaluate('innerWidth');
  const img = decodePng(await s.screenshot());
  if (await displayP3Shots(s)) p3ToSrgb(img);
  const k = img.width / iw;
  return { img: cropImage(img, Math.round(rect.x * k), Math.round(rect.y * k), Math.round(rect.width * k), Math.round(rect.height * k)), scale: k };
}

export const rectOf = (s, sel) => s.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);

/** Canvas backing store -> RGBA composited over the canvas' computed background (the twin is opaque). Throws on a tainted canvas. */
export async function readCanvas(s, sel = 'canvas') {
  const r = await s.evaluate(`(async () => {
    const c = document.querySelector(${JSON.stringify(sel)});
    for (let i = 0; i < 2; i++) await new Promise((ok) => requestAnimationFrame(ok));
    const bg = getComputedStyle(c).backgroundColor;
    return { url: c.toDataURL('image/png'), bg };
  })()`);
  const img = decodePng(Buffer.from(r.url.split(',')[1], 'base64'));
  const m = r.bg.match(/[\d.]+/g)?.map(Number) ?? [];
  const bg = m.length >= 4 && m[3] === 0 ? [255, 255, 255] : [m[0] ?? 255, m[1] ?? 255, m[2] ?? 255];
  for (let i = 0; i < img.data.length; i += 4) {
    const a = img.data[i + 3] / 255;
    for (let k = 0; k < 3; k++) img.data[i + k] = Math.round(img.data[i + k] * a + bg[k] * (1 - a));
    img.data[i + 3] = 255;
  }
  return img;
}

/** Fraction of pixels with a channel delta > tol that ALSO differ from the reference pixel one device row above and below (same x). */
export function shiftTolerantFraction(a, b, tol = 16) {
  if (a.width !== b.width || a.height !== b.height) return 1;
  const { width: w, height: h } = a; let bad = 0;
  const near = (i, j) => Math.abs(a.data[i] - b.data[j]) <= tol && Math.abs(a.data[i + 1] - b.data[j + 1]) <= tol && Math.abs(a.data[i + 2] - b.data[j + 2]) <= tol;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (near(i, i) || (y > 0 && near(i, i - w * 4)) || (y < h - 1 && near(i, i + w * 4))) continue;
    bad++;
  }
  return bad / (w * h);
}

/**
 * The project oracle (fraction of pixels with a channel delta > 16, both images non-blank), adapted for Gecko and WebKit, whose SVG-image raster differs from their page
 * raster in two MEASURED ways no polyfill can change (docs/SUPPORT-MATRIX.md, Engines):
 *   1. text lines sit one device row above or below the plain DOM (dom 13,72,130,192 vs image 14,72,129,191 in Firefox 155 and Safari 27, for zoom, viewBox and transform);
 *   2. light text on a dark background is set thinner (the page dilates glyph strokes, the image does not): every glyph edge differs by 16-60 levels.
 * Gate: `shiftTolerant` (a pixel also matches the reference row above or below) <= 5 % at delta > 16, AND `structural` (same, at delta > 100) <= 1 %: missing or wrong
 * content (a blank surface, an absent control, a wrong scroll offset) moves many pixels by far more than 100 levels. Strict numbers are reported next to them.
 */
export function oracle(surface, ref, { maxFraction = 0.05, maxStructural = 0.01 } = {}) {
  // a 1 device-pixel difference is the rounding of the css rect crop, not a renderer fault: compare the common area
  if (Math.abs(surface.width - ref.width) <= 1 && Math.abs(surface.height - ref.height) <= 1 && (surface.width !== ref.width || surface.height !== ref.height)) {
    const w = Math.min(surface.width, ref.width), h = Math.min(surface.height, ref.height);
    surface = cropImage(surface, 0, 0, w, h); ref = cropImage(ref, 0, 0, w, h);
  }
  const cmp = compareImages(surface, ref, { tolerance: 16, diffImage: true });
  // the explainer twin has 0.2-0.5 % ink in Safari (a hairline input border): non-blank means >= 0.2 % non-dominant pixels; a blank surface has 0
  const sNon = pixelStats(surface, { minFraction: 0.002 }).nonBlank, rNon = pixelStats(ref, { minFraction: 0.002 }).nonBlank;
  const shiftTolerant = cmp.sizeMatch ? shiftTolerantFraction(surface, ref, 16) : 1;
  const structural = cmp.sizeMatch ? shiftTolerantFraction(surface, ref, 100) : 1;
  return { surface, ref, pass: !!cmp.sizeMatch && sNon && rNon && shiftTolerant <= maxFraction && structural <= maxStructural, sizeMatch: cmp.sizeMatch, size: [surface.width, surface.height], refSize: [ref.width, ref.height], fraction: cmp.fraction, shiftTolerant, structural, countOver16: cmp.countOver16, maxDiff: cmp.maxDiff, surfaceNonBlank: sNon, refNonBlank: rNon, diffImage: cmp.diffImage };
}

/** Region-hash change of a canvas between two reads (cheap typing check). */
export function regionChanged(a, b, rect) {
  const ca = cropImage(a, rect.x, rect.y, rect.w, rect.h), cb = cropImage(b, rect.x, rect.y, rect.w, rect.h);
  return compareImages(ca, cb, { tolerance: 16, diffImage: false }).countOver16;
}

/** In-page blank-frame sampler: after every rendering update (a task posted from rAF) it reads a 32x32 downscale of the canvas; a frame whose alpha is 0 everywhere is blank. */
export const BLANK_START = (sel) => `(() => { const c = document.querySelector(${JSON.stringify(sel)}); const t = document.createElement('canvas'); t.width = t.height = 32; const x = t.getContext('2d', { willReadFrequently: true });
  const st = window.__XB_BLANK = { frames: 0, blank: 0, seenNonBlank: false, sizes: new Set(), on: true }; const ch = new MessageChannel();
  ch.port1.onmessage = () => { if (!st.on) return; x.clearRect(0, 0, 32, 32); try { x.drawImage(c, 0, 0, 32, 32); } catch (e) { st.err = String(e); }
    const d = x.getImageData(0, 0, 32, 32).data; let n = 0; for (let i = 3; i < d.length; i += 4) n += d[i] ? 1 : 0;
    st.frames++; st.sizes.add(c.width + 'x' + c.height); if (n) st.seenNonBlank = true; else if (st.seenNonBlank) st.blank++; };
  const loop = () => { if (!st.on) return; ch.port2.postMessage(0); requestAnimationFrame(loop); }; requestAnimationFrame(loop); return true; })()`;
export const BLANK_STOP = `(() => { const st = window.__XB_BLANK; st.on = false; return { frames: st.frames, blank: st.blank, seenNonBlank: st.seenNonBlank, sizes: st.sizes.size, err: st.err ?? null }; })()`;

/** Wait until an expression is truthy (page side). */
export async function until(s, expr, timeoutMs = 10000) { return s.waitFor(expr, { timeoutMs }); }
export { sleep };
