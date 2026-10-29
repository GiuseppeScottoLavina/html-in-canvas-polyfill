/**
 * Reach of an element: how far its painting may extend (frame css px).
 * Module: util (leaf).
 */

import { inflateRect } from './rect.js';

/** @typedef {import('../contracts/types.js').LiveLayer} LiveLayer */
/** @typedef {import('../contracts/types.js').Rect} Rect */

/**
 * The box and the reach of `el` now (frame css px): the reach is its box grown to its scrollable overflow, `ink` on every side and the ink it paints beyond its box
 * (LiveLayer.paintInk); `own` is the box grown the same way. null = not laid out. The damage rects of hover, class and text changes (schedule/observers/damage-rect.js)
 * and the hover strips of the scroll compositor measure with it.
 * @param {number} ink @param {LiveLayer} layer @param {Element} el
 * @returns {{box: Rect, reach: Rect, own: Rect, painted: boolean}|null}
 */
export function measureReach(ink, layer, el) {
  const box = layer.frameRect(el);
  if (!box) return null;
  const scrollW = /** @type {HTMLElement} */ (el).scrollWidth;
  const scrollH = /** @type {HTMLElement} */ (el).scrollHeight;
  const width = Math.max(box.width, Number.isFinite(scrollW) ? scrollW : 0);
  const height = Math.max(box.height, Number.isFinite(scrollH) ? scrollH : 0);
  const p = layer.paintInk?.(el) ?? null;
  const painted = !!p && p.left + p.top + p.right + p.bottom > 0;
  /** @param {Rect} r */
  const grow = (r) => {
    const g = inflateRect(r, ink);
    return painted && p ? { x: g.x - p.left, y: g.y - p.top, width: g.width + p.left + p.right, height: g.height + p.top + p.bottom } : g;
  };
  return { box, reach: grow({ x: box.x, y: box.y, width, height }), own: grow(box), painted };
}
