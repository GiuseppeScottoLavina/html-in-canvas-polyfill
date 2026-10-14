/**
 * Image decode of the data: URL (async), the atomic bounded tile commit and image release.
 * Module: snapshot-store (src/snapshot/store/*).
 */

import { typeError } from '../../contracts/errors.js';

/** A decode that never settles would hold the pipeline (depth 1) forever. */
export const DECODE_TIMEOUT_MS = 4000;

/**
 * new Image(); decoding=async; src=url; await decode(). Rejects on a broken image or after `timeoutMs` (the pump reports it and keeps the previous version).
 * Only data: URLs are accepted: a blob: URL would taint every sink the surface is later copied to.
 * @param {string} url
 * @param {{timeoutMs?: number, create?: () => HTMLImageElement}} [opts]  `create` lets tests substitute the image
 * @returns {Promise<HTMLImageElement>}
 */
export async function decodeDataUrl(url, opts = {}) {
  if (typeof url !== 'string' || !url.startsWith('data:')) throw typeError('decodeDataUrl accepts data: URLs only (blob: URLs taint the surface)');
  const img = opts.create ? opts.create() : new Image();
  img.decoding = 'async';
  img.src = url;
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`image decode timed out after ${opts.timeoutMs ?? DECODE_TIMEOUT_MS} ms`)), opts.timeoutMs ?? DECODE_TIMEOUT_MS);
  });
  try {
    await Promise.race([img.decode(), timeout]);
  } catch (err) {
    releaseImage(img);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  return img;
}

/**
 * ATOMIC bounded commit of one decoded tile: guard `img.complete && img.naturalWidth > 0`, then save(); beginPath(); rect(crop); clip(); globalCompositeOperation = 'copy'; drawImage(tile); restore().
 * Replaces ONLY the clipped rect (transparent tile pixels replace the old ones as clearRect+draw did) and a throwing/empty drawImage leaves the previous pixels intact (measured: clear-then-draw left alpha 0; clip+copy kept 200,0,0,255).
 * An unbounded copy here was a missing clip. Returns false (surface untouched) when the guard or drawImage fails; the caller reports once and re-damages the crop.
 * @param {HTMLCanvasElement|OffscreenCanvas} surface
 * @param {HTMLImageElement} img
 * @param {{x: number, y: number, width: number, height: number}} cropPx  whole surface pixels
 * @returns {boolean}
 */
export function drawTileAtomic(surface, img, cropPx) {
  if (!(img.complete && img.naturalWidth > 0)) return false;
  const ctx = surface.getContext('2d');
  if (!ctx || ctx.isContextLost?.()) return false;
  ctx.save();
  try {
    ctx.beginPath();
    ctx.rect(cropPx.x, cropPx.y, cropPx.width, cropPx.height);
    ctx.clip();
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(img, cropPx.x, cropPx.y, cropPx.width, cropPx.height);
    return true;
  } catch {
    return false;
  } finally {
    ctx.restore();
  }
}

/**
 * img.src = "" to free the decoded bitmap.
 * @param {HTMLImageElement} img
 */
export function releaseImage(img) {
  img.src = '';
}
