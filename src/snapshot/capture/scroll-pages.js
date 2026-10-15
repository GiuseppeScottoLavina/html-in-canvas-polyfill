/**
 * Scroll compositor, capture side: may a scroller be shown by composing cached PAGES (its scrollport rendered at other
 * offsets, CaptureRequest.scroll) plus its pinned sticky elements, and with what geometry. Answers null for everything the composition could not reproduce exactly; that
 * scroller keeps the plain snapshot path (a whole-scroller tile per scroll step), which is exact by construction.
 * Module: snapshot-capture (src/snapshot/capture/*).
 */

import { currentEngine } from '../../util/engine.js';
import { parseColor } from './caret-overlay.js';
import { parseScrollbarColor, scrollFacts, styledMinThumb, verticalBar } from './scroll-emulation.js';

/** @typedef {import('../../contracts/types.js').LiveLayer} LiveLayer */
/** @typedef {import('../../contracts/types.js').Rect} Rect */
/** @typedef {import('../../contracts/types.js').ScrollPlan} ScrollPlan */

/** at most this many elements in the scroller are inspected (larger: no composition) */
const MAX_SCAN = 6000;
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
 * Nothing but the scroller or its descendants is hit on a grid over its scrollport (32 css px), and every point lies in the viewport.
 * @param {Document} doc @param {Element} scroller @param {DOMRect} port viewport rect of the scrollport
 */
function portUnobstructed(doc, scroller, port) {
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
      const top = hit.elementFromPoint(x, y);
      if (!top || (top !== scroller && !scroller.contains(top))) return false;
    }
  }
  return true;
}

/**
 * Plan the composition of `scroller` (a vertical scroller inside `drawable`, or the drawable itself). Expensive (a computed-style scan of the subtree and a hit-test grid):
 * the store caches it until something other than this scroller's own scrolling damages the drawable.
 * @param {Document} doc @param {LiveLayer} layer @param {Element} scroller @param {Element} drawable
 * @returns {ScrollPlan|null}
 */
export function planScrollPages(doc, layer, scroller, drawable) {
  const win = doc.defaultView;
  if (!win || currentEngine().engine !== 'chromium' || layer.nearestDrawable(scroller) !== drawable && scroller !== drawable) return null;
  const s = /** @type {HTMLElement} */ (scroller);
  const cs = win.getComputedStyle(s);
  const gutterX = s.offsetWidth - s.clientWidth - px(cs.borderLeftWidth) - px(cs.borderRightWidth);
  const gutterY = s.offsetHeight - s.clientHeight - px(cs.borderTopWidth) - px(cs.borderBottomWidth);
  // a vertical classic bar is composed from its track and thumb tiles; a horizontal one (or a corner) is not
  if (!/^(auto|scroll)$/.test(cs.overflowY) || s.scrollHeight <= s.clientHeight || s.scrollWidth > s.clientWidth || s.scrollLeft !== 0 || gutterX < -0.5 || Math.abs(gutterY) > 0.5) return null;
  if (!square(cs) || / inset/.test(` ${cs.boxShadow}`) || !plainEffects(cs) || (cs.backgroundImage !== 'none' && !/^local/.test(cs.backgroundAttachment))) return null;
  for (let a = s.parentElement; a && scroller !== drawable; a = a.parentElement) {
    const acs = win.getComputedStyle(a);
    if (!plainEffects(acs) || (a !== drawable && acs.transform !== 'none')) return null;
    if (a === drawable) break;
  }
  const frame = layer.frameRect(s);
  if (!frame || Math.abs(frame.width - s.offsetWidth) > 0.01 || Math.abs(frame.height - s.offsetHeight) > 0.01) return null;
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
  for (let i = 0; i < all.length; i++) {
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
  const bl = px(cs.borderLeftWidth);
  const bt = px(cs.borderTopWidth);
  const port = { x: frame.x + bl, y: frame.y + bt, width: s.clientWidth, height: s.clientHeight };
  const vr = s.getBoundingClientRect();
  if (!portUnobstructed(doc, s, new DOMRect(vr.left + bl, vr.top + bt, s.clientWidth, s.clientHeight))) return null;
  let bar = null;
  if (gutterX > 0.5) {
    const f = scrollFacts(s, cs);
    if (!f || !f.scrollableY) return null;
    const v = verticalBar(f.gv, s.clientHeight, s.scrollHeight, f.styled, !f.styled && !!parseScrollbarColor(cs.scrollbarColor), f.styled ? styledMinThumb(win, s) : 0);
    bar = { gutter: { x: port.x + s.clientWidth, y: port.y, width: f.gv, height: s.clientHeight }, ...v };
  }
  return { port, frame, pinned, bar, maxTop: s.scrollHeight - s.clientHeight, scrollHeight: s.scrollHeight };
}
