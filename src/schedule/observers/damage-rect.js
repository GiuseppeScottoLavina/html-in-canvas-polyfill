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
function createRectMemory(ink) {
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
   * `el` resized (or is seen for the first time): what moved is bounded by the nearest ancestor inside the drawable (the drawable included) whose box neither moved nor resized
   * since it was last measured. Inside that ancestor only its children can have moved: when every child box is known, the damage is the old and new reach of the children that
   * moved or resized (a counter that changes width in a fixed-size row repaints the row, not the 1,000 nodes beside it); otherwise it is the ancestor's own old and new reach
   * (a text change that resizes a heading repaints the header), or the whole drawable (null) when that ancestor is the drawable. An ancestor never measured before cannot
   * vouch for anything (recorded now, the next change can use it).
   * @param {LiveLayer} layer @param {Element} el @param {Rect|null} own  old and new reach of `el` (null = its old reach is unknown)
   * @returns {Rect|null}
   */
  function bounded(layer, el, own) {
    const drawable = layer.nearestDrawable(el);
    if (!drawable || el === drawable) return null;
    let acc = own;
    // acc covers the old and new reach of `child` (the chain element below `a`): only then can the children of an unchanged ancestor be inspected one by one
    let exact = own !== null;
    let child = el;
    for (let a = el.parentElement, depth = 0; a && depth < MAX_BOUND_DEPTH; child = a, a = a.parentElement, depth++) {
      const whole = a === drawable;
      const cur = measure(layer, a);
      const prev = last.get(a);
      if (cur) last.set(a, cur); else last.delete(a);
      if (!cur || !prev) { if (whole) return null; exact = false; continue; }
      if (sameBox(prev.box, cur.box)) {
        const moved = exact ? movedChildren(layer, a, child) : undefined;
        if (moved !== undefined) return moved ? unionRect(/** @type {Rect} */ (acc), moved) : acc;
        if (whole) return null;
        const span = unionRect(prev.reach, cur.reach);
        return acc ? unionRect(acc, span) : span;
      }
      if (whole) return null;
      const span = unionRect(prev.reach, cur.reach);
      acc = acc ? unionRect(acc, span) : span;
      exact = true;
    }
    return null;
  }

  /**
   * Inside `parent`, whose box did not change, the children other than `except` that moved or resized: the union of their old and new reach (null: none moved).
   * undefined when that cannot be known: a child never measured before (it is recorded now), a child that is not laid out but renders (display: contents), more than
   * MAX_SIBLINGS children, text of `parent` itself (it reflows with its children), or generated content / a marker of `parent` (they move with the children, untracked).
   * @param {LiveLayer} layer @param {Element} parent @param {Element} except
   * @returns {Rect|null|undefined}
   */
  function movedChildren(layer, parent, except) {
    const kids = parent.children;
    if (kids.length > MAX_SIBLINGS) return undefined;
    for (const n of parent.childNodes) if (n.nodeType === 3 && /\S/.test(/** @type {Text} */ (n).data)) return undefined;
    const win = parent.ownerDocument.defaultView;
    if (!win || win.getComputedStyle(parent).display.includes('list-item')) return undefined;
    for (const pseudo of ['::before', '::after']) {
      const content = win.getComputedStyle(parent, pseudo).content;
      if (content && content !== 'none' && content !== 'normal') return undefined;
    }
    let known = true;
    /** @type {Rect|null} */
    let acc = null;
    for (const k of kids) {
      if (k === except) continue;
      const cur = measure(layer, k);
      const prev = last.get(k);
      if (cur) last.set(k, cur); else last.delete(k);
      if (!cur) {
        // display:none (script, style, hidden) paints nothing; a box the layer cannot measure (display: contents) may
        if (prev || win.getComputedStyle(k).display !== 'none') known = false;
        continue;
      }
      if (!prev) { known = false; continue; }
      if (sameBox(prev.box, cur.box) && sameBox(prev.reach, cur.reach)) continue;
      const span = unionRect(prev.reach, cur.reach);
      acc = acc ? unionRect(acc, span) : span;
    }
    return known ? acc : undefined;
  }
}

/** children of an unchanged ancestor inspected for movement; more than this and the ancestor's own reach (or the whole drawable) is the damage */
const MAX_SIBLINGS = 32;

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
