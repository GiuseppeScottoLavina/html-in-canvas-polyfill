/**
 * Caret painted on the retained surface after the tile, so a blink never builds a tile (docs/ARCHITECTURE.md ADR-D.2).
 * Module: snapshot-store (src/snapshot/store/*).
 */

import { makeCanvas } from './surfaces.js';

/** @typedef {import('../../contracts/types.js').Rect} Rect */
/** @typedef {HTMLCanvasElement|OffscreenCanvas} Surface */
/** @typedef {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} Ctx2D */

/**
 * @typedef {Object} CaretPatch
 * @property {(surface: HTMLCanvasElement|OffscreenCanvas, rectPx: Rect, color: string) => void} show  save the pixels under the caret rect, fillRect the caret
 * @property {(surface: HTMLCanvasElement|OffscreenCanvas) => void} hide  put the saved pixels back (no-op when hidden)
 * @property {(landedRectPx: Rect) => void} tileLanded  a tile covered the caret rect: forget the saved pixels (the tile is caret-free) so the next show() re-saves
 * @property {() => boolean} visible
 */

/** @param {Surface} surface @returns {Ctx2D|null} */
const context = (surface) => {
  const ctx = surface.getContext('2d');
  return ctx && !ctx.isContextLost?.() ? ctx : null;
};

/**
 * One patch per drawable. Painting counts as a write: the store forks a pinned surface first (rare: a pinned ElementImage while a text control blinks).
 * The pixels under the caret are saved with a GPU-side drawImage into a tiny scratch canvas, never getImageData (a readback stalls the GPU pipeline); the whole blink costs O(caret rect).
 * @returns {CaretPatch}
 */
export function createCaretPatch() {
  /** @type {{x: number, y: number, width: number, height: number}|null} */
  let saved = null;
  /** @type {Surface|null} */
  let pad = null;

  /** @param {number} w @param {number} h @returns {Surface} */
  const padOf = (w, h) => {
    if (!pad || pad.width < w || pad.height < h) pad = makeCanvas(Math.max(w, pad?.width ?? 0), Math.max(h, pad?.height ?? 0));
    return pad;
  };

  /** @param {Surface} surface */
  const hide = (surface) => {
    if (!saved || !pad) return;
    const s = saved;
    saved = null;
    const ctx = context(surface);
    if (!ctx) return;
    ctx.save();
    try {
      ctx.beginPath();
      ctx.rect(s.x, s.y, s.width, s.height);
      ctx.clip();
      ctx.globalCompositeOperation = 'copy';
      ctx.drawImage(pad, 0, 0, s.width, s.height, s.x, s.y, s.width, s.height);
    } finally {
      ctx.restore();
    }
  };

  return {
    show(surface, rectPx, color) {
      hide(surface);
      const x = Math.max(0, Math.floor(rectPx.x));
      const y = Math.max(0, Math.floor(rectPx.y));
      const width = Math.min(surface.width, Math.ceil(rectPx.x + rectPx.width)) - x;
      const height = Math.min(surface.height, Math.ceil(rectPx.y + rectPx.height)) - y;
      const ctx = context(surface);
      if (!ctx || width <= 0 || height <= 0) return;
      const p = padOf(width, height);
      const pctx = /** @type {Ctx2D} */ (p.getContext('2d'));
      pctx.clearRect(0, 0, width, height);
      pctx.drawImage(surface, x, y, width, height, 0, 0, width, height);
      saved = { x, y, width, height };
      ctx.fillStyle = color;
      ctx.fillRect(x, y, width, height);
    },
    hide,
    tileLanded(landedRectPx) {
      const s = saved;
      if (!s) return;
      const r = landedRectPx;
      if (r.x <= s.x && r.y <= s.y && r.x + r.width >= s.x + s.width && r.y + r.height >= s.y + s.height) saved = null;
    },
    visible: () => saved !== null,
  };
}
