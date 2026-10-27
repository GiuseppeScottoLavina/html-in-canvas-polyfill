/**
 * Scroll compositor, capture side: may a scroller be shown by composing cached PAGES (its scrollport rendered at other
 * offsets, CaptureRequest.scroll) plus its pinned sticky elements, and with what geometry. Answers null for everything the composition could not reproduce exactly; that
 * scroller keeps the plain snapshot path (a whole-scroller tile per scroll step), which is exact by construction.
 * Module: snapshot-capture (src/snapshot/capture/*).
 */

import { currentEngine } from '../../util/engine.js';
import { parseColor } from './caret-overlay.js';
import { chromiumBarLook, chromiumVerticalBar, parseScrollbarColor, scrollFacts, styledMinThumb, verticalBar } from './scroll-emulation.js';

/** @typedef {import('../../contracts/types.js').LiveLayer} LiveLayer */
/** @typedef {import('../../contracts/types.js').Rect} Rect */
/** @typedef {import('../../contracts/types.js').ScrollPlan} ScrollPlan */

/** at most this many elements in the scroller are inspected (larger: no composition; the node budget's absolute limit is 20000) */
const MAX_SCAN = 20000;
/** elements inspected per step of a large scroller's scan (planSteps) */
const SCAN_STEP = 2500;
const UNSAFE_TAGS = new Set(['video', 'canvas', 'iframe', 'embed', 'object']);

/** @param {string} v @returns {number} */
const px = (v) => parseFloat(v) || 0;

/** @param {CSSStyleDeclaration} cs @returns {boolean} no effect that mixes pixels across the scrollport or depends on the scroll offset */
function plainEffects(cs) {
  return cs.filter === 'none' && (cs.backdropFilter ?? 'none') === 'none' && (cs.mixBlendMode ?? 'normal') === 'normal' && (cs.clipPath ?? 'none') === 'none'
    && ((/** @type {any} */ (cs)).maskImage ?? 'none') === 'none';
}

/** @param {CSSStyleDeclaration} cs @returns {boolean} square corners */
const square = (cs) => px(cs.borderTopLeftRadius) === 0 && px(cs.borderTopRightRadius) === 0 && px(cs.borderBottomLeftRadius) === 0 && px(cs.borderBottomRightRadius) === 0;

/** @param {string} v one computed corner radius ("10px", "10px 5px", "50%") @param {number} w @param {number} h @returns {{x: number, y: number}} */
function corner(v, w, h) {
  const [a, b = a] = v.trim().split(/\s+/);
  const len = (/** @type {string} */ t, /** @type {number} */ of) => (t.endsWith('%') ? (parseFloat(t) / 100) * of : px(t));
  return { x: Math.max(0, len(a, w)), y: Math.max(0, len(b, h)) };
}

/**
 * The used outer radii of a border box w x h (percentages resolved, scaled down together where adjacent radii overlap, CSS Backgrounds 3 section 5.5).
 * @param {CSSStyleDeclaration} cs @param {number} w @param {number} h
 */
export function outerRadii(cs, w, h) {
  const tl = corner(cs.borderTopLeftRadius, w, h), tr = corner(cs.borderTopRightRadius, w, h);
  const br = corner(cs.borderBottomRightRadius, w, h), bl = corner(cs.borderBottomLeftRadius, w, h);
  let f = 1;
  for (const [side, sum] of [[w, tl.x + tr.x], [w, bl.x + br.x], [h, tl.y + bl.y], [h, tr.y + br.y]]) if (sum > side) f = Math.min(f, side / sum);
  const k = (/** @type {{x: number, y: number}} */ r) => ({ x: r.x * f, y: r.y * f });
  return { tl: k(tl), tr: k(tr), br: k(br), bl: k(bl) };
}

/**
 * Inner radii of the scrollport (the padding box edge: outer radius minus the adjacent border width), null when every one is 0.
 * @param {CSSStyleDeclaration} cs @param {number} w @param {number} h border box
 * @returns {NonNullable<ScrollPlan['round']>|null}
 */
export function innerRadii(cs, w, h) {
  const o = outerRadii(cs, w, h);
  const bl = px(cs.borderLeftWidth), bt = px(cs.borderTopWidth), br = px(cs.borderRightWidth), bb = px(cs.borderBottomWidth);
  const r = {
    tl: { x: Math.max(0, o.tl.x - bl), y: Math.max(0, o.tl.y - bt) }, tr: { x: Math.max(0, o.tr.x - br), y: Math.max(0, o.tr.y - bt) },
    br: { x: Math.max(0, o.br.x - br), y: Math.max(0, o.br.y - bb) }, bl: { x: Math.max(0, o.bl.x - bl), y: Math.max(0, o.bl.y - bb) },
  };
  return Object.values(r).some((c) => c.x > 0 && c.y > 0) ? r : null;
}

/**
 * A sticky element the compositor can draw from one tile at its live position: an opaque rectangle with nothing outside its border box.
 * @param {Element} el @param {CSSStyleDeclaration} cs @returns {boolean}
 */
function pinnable(el, cs) {
  const bg = parseColor(cs.backgroundColor);
  const h = /** @type {HTMLElement} */ (el);
  return !!bg && bg[3] >= 1 && cs.backgroundImage === 'none' && square(cs) && cs.boxShadow === 'none' && (cs.outlineStyle === 'none' || px(cs.outlineWidth) === 0)
    && (cs.opacity === '1' || cs.opacity === '') && cs.transform === 'none' && plainEffects(cs) && cs.zIndex !== 'auto' && Number(cs.zIndex) > 0
    && h.scrollWidth <= h.clientWidth + 1 && h.scrollHeight <= h.clientHeight + 1;
}

/**
 * Nothing but the scroller or its descendants is hit on a grid over its scrollport (32 css px), and every point lies in the viewport. Points outside a rounded
 * corner of the port are skipped (what is hit there is what lies behind the corner).
 * @param {Document} doc @param {Element} scroller @param {DOMRect} port viewport rect of the scrollport @param {ScrollPlan['round']} round
 */
function portUnobstructed(doc, scroller, port, round) {
  const win = doc.defaultView;
  if (!win || port.left < 0 || port.top < 0 || port.right > win.innerWidth || port.bottom > win.innerHeight) return false;
  const root = /** @type {Document|ShadowRoot} */ (scroller.getRootNode());
  const hit = typeof root.elementFromPoint === 'function' ? root : doc;
  const cols = Math.min(32, Math.ceil(port.width / 32) + 1);
  const rows = Math.min(32, Math.ceil(port.height / 32) + 1);
  for (let c = 0; c < cols; c++) {
    const x = port.left + 1 + ((port.width - 2) * c) / Math.max(1, cols - 1);
    for (let r = 0; r < rows; r++) {
      const y = port.top + 1 + ((port.height - 2) * r) / Math.max(1, rows - 1);
      if (round && outsideCorner(x - port.left, y - port.top, port.width, port.height, round)) continue;
      const top = hit.elementFromPoint(x, y);
      if (!top || (top !== scroller && !scroller.contains(top))) return false;
    }
  }
  return true;
}

/** @param {number} x @param {number} y point in the port @param {number} w @param {number} h port size @param {NonNullable<ScrollPlan['round']>} r inner radii @returns {boolean} */
function outsideCorner(x, y, w, h, r) {
  const out = (/** @type {number} */ dx, /** @type {number} */ dy, /** @type {{x: number, y: number}} */ c) => dx < c.x && dy < c.y && ((c.x - dx) / c.x) ** 2 + ((c.y - dy) / c.y) ** 2 > 1;
  return out(x, y, r.tl) || out(w - x, y, r.tr) || out(w - x, h - y, r.br) || out(x, h - y, r.bl);
}

/**
 * Plan the composition of `scroller` (a vertical scroller inside `drawable`, or the drawable itself). Expensive (a computed-style scan of the subtree and a hit-test grid):
 * the store caches it until something other than this scroller's own scrolling damages the drawable.
 * @param {Document} doc @param {LiveLayer} layer @param {Element} scroller @param {Element} drawable
 * @returns {ScrollPlan|null}
 */
export function planScrollPages(doc, layer, scroller, drawable) {
  const steps = planSteps(doc, layer, scroller, drawable);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/**
 * planScrollPages in steps: the scan of a large scroller yields after every SCAN_STEP elements, so the store can spread it over several post-frame tasks
 * (Capture.scrollPlan). A step that finds the scroller changed in between answers null (the store plans it again later).
 * @param {Document} doc @param {LiveLayer} layer @param {Element} scroller @param {Element} drawable
 * @returns {Generator<void, ScrollPlan|null, void>}
 */
export function* planSteps(doc, layer, scroller, drawable) {
  const win = doc.defaultView;
  if (!win || currentEngine().engine !== 'chromium' || layer.nearestDrawable(scroller) !== drawable && scroller !== drawable) return null;
  const s = /** @type {HTMLElement} */ (scroller);
  const cs = win.getComputedStyle(s);
  // the bar gutters from whole-pixel sizes: offsetWidth and clientWidth are rounded each on its own, so a fractional layout (a 400.4 px track at DPR 1.25: 400 and 399)
  // shows a gutter of -1 or +1 px that is not there; a classic bar is far wider
  const gutter = (/** @type {number} */ g) => (Math.abs(g) <= 1 ? 0 : g);
  const gutterX = gutter(s.offsetWidth - s.clientWidth - px(cs.borderLeftWidth) - px(cs.borderRightWidth));
  const gutterY = gutter(s.offsetHeight - s.clientHeight - px(cs.borderTopWidth) - px(cs.borderBottomWidth));
  // a vertical classic bar is composed from its track and thumb tiles; a horizontal one (or a corner) is not
  if (!/^(auto|scroll)$/.test(cs.overflowY) || s.scrollHeight <= s.clientHeight || s.scrollWidth > s.clientWidth + 1 || s.scrollLeft !== 0 || gutterX < -0.5 || Math.abs(gutterY) > 0.5) return null;
  // the author's values: the scroll synchronisation (LiveLayer.syncScroll) overrides these three on the live scroller while it scrolls
  const own = layer.scrollAuthorStyle?.(s) ?? cs;
  if (/ inset/.test(` ${own.boxShadow}`) || !plainEffects(cs) || (own.backgroundImage !== 'none' && !/^local/.test(own.backgroundAttachment))) return null;
  const frame = layer.frameRect(s);
  // offsetWidth is rounded to an integer (a fractional layout at DPR 1.25 / 1.5 is still a plain box)
  if (!frame || Math.abs(frame.width - s.offsetWidth) > 0.51 || Math.abs(frame.height - s.offsetHeight) > 0.51) return null;
  const bl = px(cs.borderLeftWidth);
  const bt = px(cs.borderTopWidth);
  // the padding box at its layout size: clientWidth / clientHeight are rounded to whole css px, and in a fractional layout (a grid track of 541.33 px) a port of
  // 541 px left the last device pixel column out of every page, and refused the sticky header, which is 541.33 px wide (a classic bar keeps the client size)
  const port = { x: frame.x + bl, y: frame.y + bt, width: gutterX > 0.5 ? s.clientWidth : frame.width - bl - px(cs.borderRightWidth), height: frame.height - bt - px(cs.borderBottomWidth) };
  for (let a = s.parentElement; a && scroller !== drawable; a = a.parentElement) {
    const acs = win.getComputedStyle(a);
    if (!plainEffects(acs) || (a !== drawable && acs.transform !== 'none')) return null;
    // a rounded clip of an ancestor over the port is not offset-invariant: the pages would carry it along
    if (acs.overflowX !== 'visible' && !square(acs)) {
      const ar = layer.frameRect(a);
      const o = ar && outerRadii(acs, ar.width, ar.height);
      if (!ar || !o) return null;
      const near = [[ar.x, ar.y, o.tl], [ar.x + ar.width - o.tr.x, ar.y, o.tr], [ar.x + ar.width - o.br.x, ar.y + ar.height - o.br.y, o.br], [ar.x, ar.y + ar.height - o.bl.y, o.bl]];
      for (const [x, y, r] of /** @type {Array<[number, number, {x: number, y: number}]>} */ (near)) {
        if (port.x < x + r.x && port.x + port.width > x && port.y < y + r.y && port.y + port.height > y) return null;
      }
    }
    if (a === drawable) break;
  }
  const round = square(cs) ? null : innerRadii(cs, frame.width, frame.height);
  const active = /** @type {Document|ShadowRoot} */ (s.getRootNode()).activeElement;
  if (active && s.contains(active) && active !== s) return null;
  const sel = doc.getSelection();
  if (sel && !sel.isCollapsed && sel.rangeCount && sel.getRangeAt(0).intersectsNode(s)) return null;
  const all = s.getElementsByTagName('*');
  if (all.length > MAX_SCAN) return null;
  const drawables = new Set(layer.drawableElements());
  const animated = new Set((doc.getAnimations?.() ?? []).map((a) => /** @type {KeyframeEffect|null} */ (a.effect)?.target).filter(Boolean));
  /** @type {Element[]} */
  const pinned = [];
  let otherZ = -Infinity;
  const count = all.length;
  for (let i = 0; i < count; i++) {
    if (i && i % SCAN_STEP === 0) {
      yield;
      if (all.length !== count || !s.isConnected) return null;
    }
    const el = all[i];
    if (drawables.has(el) || UNSAFE_TAGS.has(el.localName) || animated.has(el) || el.shadowRoot) return null;
    const ecs = win.getComputedStyle(el);
    const pos = ecs.position;
    if (pos === 'static') continue;
    if (pos === 'fixed' || (pos === 'absolute' && cs.position === 'static')) return null;
    if (pos === 'sticky') {
      if (!pinnable(el, ecs) || pinned.some((p) => p.contains(el) || el.contains(p))) return null;
      pinned.push(el);
      continue;
    }
    otherZ = Math.max(otherZ, ecs.zIndex === 'auto' ? 0 : Number(ecs.zIndex));
  }
  if (pinned.some((p) => Number(win.getComputedStyle(p).zIndex) <= otherZ)) return null;
  const vr = s.getBoundingClientRect();
  if (!portUnobstructed(doc, s, new DOMRect(vr.left + bl, vr.top + bt, s.clientWidth, s.clientHeight), round)) return null;
  let bar = null;
  if (gutterX > 0.5) {
    const f = scrollFacts(s, cs);
    if (!f || !f.scrollableY) return null;
    const look = chromiumBarLook(win, s, cs, f.styled);
    const v = look ? chromiumVerticalBar(look, f.gv, f.ch ?? s.clientHeight, s.clientHeight, s.scrollHeight)
      : verticalBar(f.gv, s.clientHeight, s.scrollHeight, f.styled, !f.styled && !!parseScrollbarColor(cs.scrollbarColor), f.styled ? styledMinThumb(win, s) : 0);
    bar = { gutter: { x: port.x + (f.cw ?? s.clientWidth), y: port.y, width: f.gv, height: s.clientHeight }, ...v };
  }
  return { port, frame, pinned, bar, maxTop: s.scrollHeight - s.clientHeight, scrollHeight: s.scrollHeight, client: { width: s.clientWidth, height: s.clientHeight }, round, clear: (rects) => clearOver(doc, layer, s, port, rects) };
}

/**
 * ScrollPlan.clear: a hit test on a small grid of each rect (inside the port): only the scroller or its descendants are hit. Frame css px are mapped to the viewport
 * through the scroller's own box (the layer may carry a transform).
 * @param {Document} doc @param {LiveLayer} layer @param {HTMLElement} s @param {Rect} port @param {Rect[]} rects @returns {boolean}
 */
function clearOver(doc, layer, s, port, rects) {
  const fr = layer.frameRect(s);
  if (!fr || !s.isConnected || !(fr.width > 0) || !(fr.height > 0)) return false;
  const vr = s.getBoundingClientRect();
  const kx = vr.width / fr.width, ky = vr.height / fr.height;
  const root = /** @type {Document|ShadowRoot} */ (s.getRootNode());
  const hit = typeof root.elementFromPoint === 'function' ? root : doc;
  for (const r of rects) {
    const x0 = Math.max(r.x, port.x) + 1, x1 = Math.min(r.x + r.width, port.x + port.width) - 1;
    const y0 = Math.max(r.y, port.y) + 1, y1 = Math.min(r.y + r.height, port.y + port.height) - 1;
    if (x1 < x0 || y1 < y0) continue;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const at = hit.elementFromPoint(vr.left + (x0 + ((x1 - x0) * i) / 2 - fr.x) * kx, vr.top + (y0 + ((y1 - y0) * j) / 2 - fr.y) * ky);
        if (!at || (at !== s && !s.contains(at))) return false;
      }
    }
  }
  return true;
}
