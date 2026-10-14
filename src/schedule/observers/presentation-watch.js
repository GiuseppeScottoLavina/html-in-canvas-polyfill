/**
 * Event-driven presentation sync: presentation changes are caught from events only, never by an idle poll, so an idle page costs nothing.
 * Module: schedule (src/schedule/observers/*).
 *
 * The layer copies the canvas's box, its inherited text properties and the custom properties computed above it (live/presentation.js). They change when the canvas or an
 * ancestor changes size, attributes, matched rules or interaction state, or animates. Every such cause has an event; each one asks for ONE presentation re-check in the next
 * animation frame (coalesced; the check compares and writes only what changed):
 * - stylesheet epoch, forced and DPR damage, an ancestor's attributes (BUS.DAMAGE, published by the other observers);
 * - window resize (viewport units, media queries), once the resize has settled (RESIZE_SETTLE_MS): during a drag the canvas ResizeObserver already re-checks each step;
 * - any attribute / child-list change in the document OUTSIDE the canvas layers (sibling combinators and `:has()` can restyle an ancestor from anywhere);
 * - pointer / focus boundary events that change `:hover`, `:active` or `:focus-within` of the canvas or one of its ancestors;
 * - transitions and animations (CSS events, and Web Animations through the script hook of animation-observer.js) running on the canvas or an ancestor: re-checked every frame
 *   while they run (a scheduler frame hook), then once more.
 */

import { BUS } from '../../contracts/events.js';
import { onScriptAnimation } from './animation-observer.js';

/** @typedef {import('../../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../../contracts/types.js').HicEnv} HicEnv */

const DAMAGE_CAUSES = new Set(['stylesheet', 'forced', 'dpr']);
/** ms without a window resize event before the viewport-dependent re-check */
const RESIZE_SETTLE_MS = 100;
const POINTER_EVENTS = ['pointerover', 'pointerout'];
const STATE_EVENTS = ['pointerdown', 'pointerup', 'focusin', 'focusout'];
const ANIMATION_START = ['transitionrun', 'animationstart'];
/** canvas attributes written by the polyfill or owned by other observers */
const OWN_ATTRIBUTE = /^(data-hic-|aria-owns$|content$|drawable$|layoutsubtree$|framecap$)/;

/** @param {Element} canvas @returns {Element[]} the canvas and the elements above it, through shadow hosts up to <html> */
function chainOf(canvas) {
  /** @type {Element[]} */
  const chain = [canvas];
  for (let el = canvas.parentElement ?? /** @type {ShadowRoot} */ (canvas.getRootNode()).host ?? null; el; el = el.parentElement ?? /** @type {ShadowRoot} */ (el.getRootNode()).host ?? null) chain.push(el);
  return chain;
}

/** @param {Element} a @param {unknown} node @returns {boolean} */
const holds = (a, node) => node instanceof Node && (a === node || a.contains(node));

/**
 * @param {HicEnv} env
 * @param {CanvasRecord} record
 * @param {() => void} refresh  re-check the presentation (cheap when nothing changed)
 * @returns {() => void}
 */
export function watchPresentation(env, record, refresh) {
  const win = /** @type {Window & typeof globalThis} */ (env.window);
  const doc = env.document;
  let frame = 0;
  let settle = 0;
  /** @type {(() => void)|null} */
  let removeHook = null;

  const later = () => {
    if (frame) return;
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      refresh();
    });
  };

  /** a transition / animation of the canvas or an ancestor: re-check in every frame the cap allows while one runs, then once more */
  function animate() {
    if (removeHook) return;
    removeHook = env.scheduler.addFrameHook(record, () => {
      refresh();
      if (chainOf(record.canvas).some((el) => el.getAnimations?.().some((a) => a.playState === 'running' || a.pending))) return true;
      removeHook?.();
      removeHook = null;
      later();
      return false;
    });
    env.scheduler.wake(record);
  }

  /** @param {Event} ev */
  const onPointer = (ev) => {
    const to = ev.target;
    const from = /** @type {PointerEvent} */ (ev).relatedTarget;
    if (chainOf(record.canvas).some((a) => holds(a, to) !== holds(a, from))) later();
  };
  /** @param {Event} ev */
  const onState = (ev) => { if (chainOf(record.canvas).some((a) => holds(a, ev.target))) later(); };
  /** @param {Event} ev */
  const onAnimation = (ev) => { if (chainOf(record.canvas).includes(/** @type {Element} */ (ev.target))) animate(); };

  const opts = { capture: true, passive: true };
  for (const type of POINTER_EVENTS) doc.addEventListener(type, onPointer, opts);
  for (const type of STATE_EVENTS) doc.addEventListener(type, onState, opts);
  for (const type of ANIMATION_START) doc.addEventListener(type, onAnimation, opts);
  const onResize = () => {
    win.clearTimeout(settle);
    settle = win.setTimeout(() => { settle = 0; later(); }, RESIZE_SETTLE_MS);
  };
  win.addEventListener('resize', onResize, { passive: true });

  const mo = new win.MutationObserver((batch) => {
    const layers = env.registry.all().map((r) => r.layer?.element).filter(Boolean);
    for (const m of batch) {
      const target = m.target;
      if (m.type === 'attributes' && target === record.canvas && OWN_ATTRIBUTE.test(m.attributeName ?? '')) continue;
      if (target.nodeType === 1 && env.isManagedLayerNode(/** @type {Element} */ (target))) continue;
      if (layers.some((l) => l?.contains(target))) continue;
      // the polyfill's own nodes coming and going (the frame-phase sentinel under <html>, layers being mounted) restyle nothing of the author's
      if (m.type === 'childList' && [...m.addedNodes, ...m.removedNodes].every((n) => n.nodeType === 1 && env.isManagedLayerNode(/** @type {Element} */ (n)))) continue;
      later();
      return;
    }
  });
  mo.observe(doc, { attributes: true, childList: true, subtree: true });

  const offDamage = env.bus.on(BUS.DAMAGE, (/** @type {{record: CanvasRecord, cause: string, drawable: Element|null}} */ e) => {
    if (e.record === record && (DAMAGE_CAUSES.has(e.cause) || (e.cause === 'mutation' && e.drawable === null))) later();
  });
  const offScript = onScriptAnimation(env, (target) => { if (chainOf(record.canvas).includes(target)) animate(); });

  return () => {
    for (const type of POINTER_EVENTS) doc.removeEventListener(type, onPointer, opts);
    for (const type of STATE_EVENTS) doc.removeEventListener(type, onState, opts);
    for (const type of ANIMATION_START) doc.removeEventListener(type, onAnimation, opts);
    win.removeEventListener('resize', onResize);
    win.clearTimeout(settle);
    mo.disconnect();
    offDamage();
    offScript();
    removeHook?.();
    removeHook = null;
    if (frame) win.cancelAnimationFrame(frame);
    frame = 0;
  };
}
