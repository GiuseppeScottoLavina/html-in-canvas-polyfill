/**
 * Capture-phase scroll listener on the layer -> damage on the scroller box.
 * Module: schedule (src/schedule/observers/*).
 */

import { typingDeferred } from './input-observer.js';

/** @typedef {import('../../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../../contracts/types.js').Rect} Rect */

/** ms without a scroll event after which a composed scroller gets its exact tile */
const SETTLE_MS = 100;

/** @param {Element} el @returns {boolean} el is a scroll container with overflow to scroll (layout reads; cheap while the layout is clean) */
function scrolls(el) {
  const h = /** @type {HTMLElement} */ (el);
  const y = h.scrollHeight > h.clientHeight + 1;
  const x = h.scrollWidth > h.clientWidth + 1;
  if (!x && !y) return false;
  const cs = /** @type {Window} */ (el.ownerDocument.defaultView).getComputedStyle(el);
  return (y && /^(auto|scroll)$/.test(cs.overflowY)) || (x && /^(auto|scroll)$/.test(cs.overflowX));
}

/**
 * scroll does not bubble: use capture on the layer. Rect = layer.frameRect(scroller) in the frame of the drawable that owns it (the clone mirrors scrollTop/Left, so the scroller box is everything that changes).
 * A scroller that is not inside any drawable (the layer itself, moved by a focus reveal) damages the whole canvas. Passive and never wheel/touch: native scrolling stays on the compositor (measured with a listener audit).
 * @param {HicEnv} env
 * @param {CanvasRecord} record
 * @returns {() => void}
 */
export function observeScroll(env, record) {
  const layer = record.layer;
  if (!layer) return () => {};
  const root = layer.element;
  /** @type {Map<Element, number>} scrollers whose exact tile waits for the scrolling to stop */
  const settle = new Map();
  /**
   * Scroll synchronisation (LiveLayer.syncScroll, live/scroll-sync.js): the scrollers under the pointer are synchronised BEFORE the gesture starts (a trackpad or
   * wheel gesture scrolls what is under the pointer), every other scroller from its first scroll event; a scroller is released when the pointer is not over it and
   * its scrolling has settled. Measured: synchronising at the first scroll event left the rest of that gesture at half rate in most runs, synchronising before it did not.
   * @type {Set<Element>}
   */
  let under = new Set();
  const sync = (/** @type {Element} */ el, /** @type {boolean} */ on) => layer.syncScroll?.(el, on);
  /** @param {Event} ev */
  const onOver = (ev) => {
    const t = /** @type {Element|null} */ (ev.target);
    if (!layer.syncScroll || !t || t.nodeType !== 1) return;
    const drawable = layer.nearestDrawable(t);
    /** @type {Set<Element>} */
    const next = new Set();
    if (drawable) for (let el = /** @type {Element|null} */ (t); el && el !== root; el = el.parentElement) { if (scrolls(el)) next.add(el); if (el === drawable) break; }
    for (const el of under) if (!next.has(el) && !settle.has(el)) sync(el, false);
    let seen = false;
    for (const el of next) {
      sync(el, true);
      // seen before its first scroll: the compositor plans it and builds its first pages after this frame, so the whole first gesture can be composed
      if (!under.has(el) && drawable) { env.store.scrollSettled?.(drawable, el); seen = true; }
    }
    under = next;
    // the plan and the pages are side builds of the post-frame pump, which runs only in a frame with work: without the wake they waited for the first scroll event,
    // and that gesture began with a plain build inside its first frame and the plan and page builds in the frames after it. Not for a finger: its gesture starts
    // within a few frames, and the builds woken at touchstart delayed its first step (measured: +10 to +35 ms at 4x / 6x CPU throttling)
    if (seen && /** @type {PointerEvent} */ (ev).pointerType !== 'touch') env.scheduler.wake(record);
  };
  /** @param {Event} ev */
  const onOut = (ev) => {
    const to = /** @type {PointerEvent} */ (ev).relatedTarget;
    if (to instanceof Node && root.contains(to)) return;
    for (const el of under) if (!settle.has(el)) sync(el, false);
    under = new Set();
  };
  /** @param {Element} target @param {Element} drawable @param {boolean} served the steps were composed: the exact tile is built now */
  const later = (target, drawable, served) => {
    env.window.clearTimeout(settle.get(target));
    settle.set(target, env.window.setTimeout(() => {
      settle.delete(target);
      if (!under.has(target)) sync(target, false);
      if (record.layer !== layer || !target.isConnected) return;
      if (served) env.scheduler.damage(record, 'scroll', drawable, layer.frameRect(target));
      // a scroller the compositor does not know yet is planned now that it is quiet (its next scroll can then be composed)
      env.store.scrollSettled?.(drawable, target);
      env.scheduler.wake(record);
    }, SETTLE_MS));
  };
  /** @param {Event} ev */
  const onScroll = (ev) => {
    const target = /** @type {Element|null} */ (ev.target);
    if (!target || target.nodeType !== 1) return;
    const drawable = layer.nearestDrawable(target);
    if (drawable) sync(target, true);
    // a text field scrolled by its own typing while the text overlay shows that typing (the overlay draws the live scrollLeft): the overlay is painted again at the new
    // offset and the snapshot keeps waiting for the typing pause, instead of one build per key (a field whose overlay fails is damaged by the store)
    if (drawable && typingDeferred(record, target) && env.store.overlayText?.(drawable, target)) {
      env.scheduler.wake(record);
      return;
    }
    // scroll compositor (store.scrollCompose): the next frame shows the new offset from cached pages; the exact tile follows when the scrolling stops
    if (drawable && env.store.scrollCompose?.(drawable, target)) {
      env.scheduler.wake(record);
      later(target, drawable, true);
      return;
    }
    env.scheduler.damage(record, 'scroll', drawable, drawable ? layer.frameRect(target) : null);
    if (drawable) later(target, drawable, false);
  };
  root.addEventListener('scroll', onScroll, { capture: true, passive: true });
  root.addEventListener('pointerover', onOver, { capture: true, passive: true });
  root.addEventListener('pointerout', onOut, { capture: true, passive: true });
  return () => {
    root.removeEventListener('scroll', onScroll, { capture: true });
    root.removeEventListener('pointerover', onOver, { capture: true });
    root.removeEventListener('pointerout', onOut, { capture: true });
    for (const t of settle.values()) env.window.clearTimeout(t);
    for (const el of [...settle.keys(), ...under]) sync(el, false);
    settle.clear();
    under = new Set();
  };
}
