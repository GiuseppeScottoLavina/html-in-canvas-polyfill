/**
 * Damage rectangles for observers that know WHICH element changed but not how far the change reaches (hover rules, class toggles, animations, text edits).
 * Module: schedule (src/schedule/observers/*).
 *
 * A rect is only safe when nothing around it moves. The memory therefore keeps, per element, the last box and the last reach (box grown to its scrollable overflow, the ink margin and the
 * ink it paints beyond its box: shadows, outline, LiveLayer.paintInk):
 * the next damage is the union of old and new reach (a dropdown that closes still clears its old pixels), and a first sighting or a box that changed size answers null (whole drawable),
 * because siblings may have shifted.
 */

import { inflateRect, unionRect } from '../../util/rect.js';

/** @typedef {import('../../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../../contracts/types.js').LiveLayer} LiveLayer */
/** @typedef {import('../../contracts/types.js').Rect} Rect */

/**
 * @typedef {Object} RectMemory
 * @property {(layer: LiveLayer, el: Element) => Rect|null} own  frame rect of `el` grown by the ink margin and its painted ink (and by the ink it painted before, which the change may have removed); for changes that stay inside the box (typing, caret, focus ring). Remembers the box for later `reach` calls. null = not laid out
 * @property {(layer: LiveLayer, el: Element) => Rect|null} reach  union of the previous and the current reach of `el`; null (whole drawable) on first sight, when the box changed size or when `el` is not laid out
 */

/** @type {WeakMap<HicEnv, RectMemory>} */
const memories = new WeakMap();

/**
 * One memory per install, shared by every observer so that a hover seen first by the tracker is already known to the mutation observer.
 * @param {HicEnv} env
 * @returns {RectMemory}
 */
export function getRectMemory(env) {
  let memory = memories.get(env);
  if (!memory) {
    memory = createRectMemory(env.options.inkMargin);
    memories.set(env, memory);
  }
  return memory;
}

/**
 * @param {number} ink  css px added on every side
 * @returns {RectMemory}
 */
export function createRectMemory(ink) {
  /** @type {WeakMap<Element, {box: Rect, reach: Rect, own: Rect, painted: boolean}>} */
  const last = new WeakMap();

  /** @param {LiveLayer} layer @param {Element} el */
  function measure(layer, el) {
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

  return {
    own(layer, el) {
      const m = measure(layer, el);
      const prev = last.get(el);
      if (!m) {
        last.delete(el);
        return null;
      }
      last.set(el, m);
      return prev?.painted ? unionRect(prev.own, m.own) : m.own;
    },
    reach(layer, el) {
      const cur = measure(layer, el);
      const prev = last.get(el);
      if (cur) last.set(el, cur);
      else last.delete(el);
      if (!cur) return null;
      if (prev && prev.box.width === cur.box.width && prev.box.height === cur.box.height) return unionRect(prev.reach, cur.reach);
      return bounded(layer, el, prev ? unionRect(prev.reach, cur.reach) : null);
    },
  };

  /**
   * `el` resized (or is seen for the first time): what moved is bounded by the nearest ancestor inside the drawable whose box neither moved nor resized since it was last
   * measured; its old and new reach are the damage (optimization 4: a text change that resizes a heading repaints the header, not a 1,000-node drawable). An ancestor never
   * measured before cannot vouch for anything (recorded now, the next change can use it); reaching the drawable answers null (whole drawable), as before.
   * @param {LiveLayer} layer @param {Element} el @param {Rect|null} own  old and new reach of `el` (null = its old reach is unknown)
   * @returns {Rect|null}
   */
  function bounded(layer, el, own) {
    const drawable = layer.nearestDrawable(el);
    let acc = own;
    for (let a = el.parentElement, depth = 0; a && a !== drawable && depth < MAX_BOUND_DEPTH; a = a.parentElement, depth++) {
      const cur = measure(layer, a);
      const prev = last.get(a);
      if (cur) last.set(a, cur); else last.delete(a);
      if (!cur || !prev) continue;
      const span = unionRect(prev.reach, cur.reach);
      acc = acc ? unionRect(acc, span) : span;
      if (sameBox(prev.box, cur.box)) return acc;
    }
    return null;
  }
}

/** ancestors inspected above a resized element */
const MAX_BOUND_DEPTH = 24;

/** @param {Rect} a @param {Rect} b @returns {boolean} same position and size (layout units) */
function sameBox(a, b) {
  return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.width - b.width) < 0.01 && Math.abs(a.height - b.height) < 0.01;
}

/**
 * Per-drawable accumulator of damage rects: a null rect (whole drawable) absorbs everything.
 * @returns {{add: (drawable: Element, rect: Rect|null) => void, flush: (emit: (drawable: Element, rect: Rect|null) => void) => void, size: () => number}}
 */
export function createDamageBatch() {
  /** @type {Map<Element, Rect|null>} */
  const byDrawable = new Map();
  return {
    add(drawable, rect) {
      if (!byDrawable.has(drawable)) byDrawable.set(drawable, rect);
      else {
        const prev = byDrawable.get(drawable);
        byDrawable.set(drawable, prev && rect ? unionRect(prev, rect) : null);
      }
    },
    flush(emit) {
      const items = [...byDrawable];
      byDrawable.clear();
      for (const [drawable, rect] of items) emit(drawable, rect);
    },
    size: () => byDrawable.size,
  };
}
