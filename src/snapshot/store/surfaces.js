/**
 * Retained surface allocation, pin and copy-on-write fork.
 * Module: snapshot-store (src/snapshot/store/*).
 */

import { HicUnsupportedError } from '../../contracts/errors.js';

/** @typedef {import('../../contracts/types.js').Insets} Insets */
/** @typedef {import('../../contracts/types.js').ResolvedOptions} ResolvedOptions */
/** @typedef {import('../../contracts/types.js').Size} Size */
/** @typedef {HTMLCanvasElement|OffscreenCanvas} Surface */

/** Chrome's hard limit per canvas dimension. */
const MAX_DIMENSION = 32767;
/** Below this raster scale the drawable is unreadable; the reduction is exhausted and the drawable is refused. */
const MIN_SCALE = 0.25;

/** Surfaces whose context was lost and not yet restored. */
const lostSurfaces = new WeakSet();

/**
 * A bare canvas without the context check (caret scratch pads). OffscreenCanvas when the platform has it, else an off-DOM canvas element.
 * @param {number} width
 * @param {number} height
 * @returns {Surface}
 */
export function makeCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  const c = globalThis.document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

/**
 * A 2D canvas (OffscreenCanvas or an off-DOM HTMLCanvasElement) of the given pixel size; throws HicUnsupportedError('surface-size') when the platform refuses it
 * (dimension limit, no 2D context, context already lost).
 * @param {number} width
 * @param {number} height
 * @returns {Surface}
 */
export function allocateSurface(width, height) {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  if (w > MAX_DIMENSION || h > MAX_DIMENSION) {
    throw new HicUnsupportedError('surface-size', `a ${w}x${h} px surface exceeds the canvas dimension limit (${MAX_DIMENSION})`, { hint: 'lower options.maxDpr or the drawable size' });
  }
  const surface = makeCanvas(w, h);
  const ctx = surface.getContext('2d');
  if (!ctx || ctx.isContextLost?.()) {
    throw new HicUnsupportedError('surface-size', `could not allocate a ${w}x${h} px 2D surface (no context or context lost)`, { hint: 'lower options.maxTotalSurfaceBytes or reduce the number/size of drawables' });
  }
  return surface;
}

/** @param {Surface} surface @returns {number} bytes of the backing store (RGBA) */
export function surfaceBytes(surface) {
  return surface.width * surface.height * 4;
}

/** True between contextlost and contextrestored, or when the platform says the context is lost. @param {Surface} surface @returns {boolean} */
export function isSurfaceLost(surface) {
  if (lostSurfaces.has(surface)) return true;
  return !!surface.getContext('2d')?.isContextLost?.();
}

/**
 * contextlost/contextrestored on a retained surface: on loss mark it lost (reads and writes skip it, the last committed version stays published), on restore call `onRestored`
 * (the store re-rasters the whole drawable: damage 'forced', BUS.SURFACE_RESTORED). The loss handler calls preventDefault(), which is what asks the browser to restore the context at all.
 * The pixels are blank after a restore even though isContextLost() reads false again: only a re-raster brings them back.
 * @param {Surface} surface
 * @param {() => void} onLost
 * @param {() => void} onRestored
 * @returns {() => void} remover
 */
export function watchSurfaceLoss(surface, onLost, onRestored) {
  const target = /** @type {EventTarget} */ (surface);
  /** @param {Event} e */
  const lost = (e) => { e.preventDefault(); lostSurfaces.add(surface); onLost(); };
  const restored = () => { lostSurfaces.delete(surface); onRestored(); };
  target.addEventListener('contextlost', lost);
  target.addEventListener('contextrestored', restored);
  return () => { target.removeEventListener('contextlost', lost); target.removeEventListener('contextrestored', restored); };
}

/**
 * Full drawImage copy of a pinned surface into a fresh one (the old stays with its ElementImages).
 * @param {Surface} surface
 * @returns {Surface}
 */
export function forkSurface(surface) {
  if (isSurfaceLost(surface)) throw new HicUnsupportedError('context-loss', 'cannot fork a surface whose 2D context is lost');
  const copy = allocateSurface(surface.width, surface.height);
  const ctx = /** @type {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} */ (copy.getContext('2d'));
  ctx.drawImage(surface, 0, 0);
  return copy;
}

/**
 * PURE. The scale a canvas grid asks the snapshots to be rasterised at: the device pixel ratio when the grid is the content box in device pixels to within one pixel
 * on both axes, else the grid's x scale. The ResizeObserver device-pixel-content-box pattern rounds a content box that is not a whole number of device pixels (a 1 px
 * border is 0.8 css px at DPR 1.25: a 168.4 css px box is 210.5 device px, a grid of 211): rasterised at the grid's 1.25297 instead of the page's 1.25, every glyph sat
 * up to half a pixel from where the page sets it, and drawn at the other axis' scale the tile was resampled by a hair (both blur text: 7.7 % of a scroll box's pixels
 * over 16 in the field test at DPR 1.25). Native draws such a grid as the page does: Chrome Canary 158 on a 312.4 x 184.4 css px box at DPR 1.25 (a 391 x 231 grid),
 * 0 % of the pixels over 16 against the plain page, where a raster at the grid's x scale is 7.3-8.6 %.
 * @param {{width: number, height: number, gridScaleX: number, gridScaleY: number}} box  content box, css px, and its grid scales
 * @param {number} dpr
 * @returns {number}
 */
export function gridRasterScale(box, dpr) {
  const fits = (/** @type {number} */ css, /** @type {number} */ grid) => Math.abs(css * grid - css * dpr) < 1;
  return dpr > 0 && box.width > 0 && box.height > 0 && box.gridScaleX !== dpr && fits(box.width, box.gridScaleX) && fits(box.height, box.gridScaleY) ? dpr : box.gridScaleX;
}

/**
 * raster scale = clamp(gridScale, 1, maxDpr), reduced until the surface fits options.maxSurfacePixels AND `usedBytes` of the other surfaces plus this one stay within options.maxTotalSurfaceBytes;
 * `reduced` is the reporting flag (feature surface-size). Throws HicUnsupportedError('surface-size') when even MIN_SCALE does not fit.
 * At DPR 3 one full-canvas drawable (1440x900 css) is 46.7 MB: the total budget, not the per-drawable one, is what bounds 30 drawables.
 * @param {Size} borderBox
 * @param {Insets} ink
 * @param {number} gridScale
 * @param {ResolvedOptions} options
 * @param {number} [usedBytes]  bytes held by every OTHER retained surface of the install
 * @returns {{scale: number, reduced: boolean}}
 */
export function chooseScale(borderBox, ink, gridScale, options, usedBytes = 0) {
  const w = borderBox.width + ink.left + ink.right;
  const h = borderBox.height + ink.top + ink.bottom;
  const wanted = Math.min(Math.max(Number.isFinite(gridScale) ? gridScale : 1, 1), options.maxDpr);
  const limitPx = Math.min(options.maxSurfacePixels, Math.floor((options.maxTotalSurfaceBytes - usedBytes) / 4));
  /** @param {number} s */
  const fits = (s) => Math.ceil(w * s) * Math.ceil(h * s) <= limitPx;
  if (!(w > 0 && h > 0) || fits(wanted)) return { scale: wanted, reduced: false };
  let s = Math.min(wanted, Math.sqrt(Math.max(limitPx, 0) / (w * h)));
  while (s >= MIN_SCALE && !fits(s)) s *= 0.995;
  s = Math.floor(s * 10000) / 10000;
  if (!(s >= MIN_SCALE) || !fits(s)) {
    throw new HicUnsupportedError('surface-size', `a ${Math.round(w)}x${Math.round(h)} css px drawable does not fit the surface budget even at scale ${MIN_SCALE}`, {
      hint: 'raise options.maxSurfacePixels / options.maxTotalSurfaceBytes or split the drawable',
    });
  }
  return { scale: s, reduced: true };
}
