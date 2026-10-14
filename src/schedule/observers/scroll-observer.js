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
  /** @param {Element} target @param {Element} drawable @param {boolean} served the steps were composed: the exact tile is built now */
  const later = (target, drawable, served) => {
    env.window.clearTimeout(settle.get(target));
    settle.set(target, env.window.setTimeout(() => {
      settle.delete(target);
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
  return () => {
    root.removeEventListener('scroll', onScroll, { capture: true });
    for (const t of settle.values()) env.window.clearTimeout(t);
    settle.clear();
  };
}
