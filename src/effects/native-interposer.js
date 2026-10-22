/**
 * Pointer remap over a NATIVE implementation: the browser hit-tests the source itself, so instead of re-implementing what a pointer does,
 * the interposer moves the hit-test geometry under the pointer (native-geometry.js) and lets the browser do the rest.
 * Module: gpu-effects (src/effects/**).
 *
 * At every pointer event on the canvas (capture listeners), the pointer p (canvas css px) is mapped through the spatial plugins of the
 * presented frame to m, and the geometry is shifted so that p hits the source point that the effect shows at p. The browser hit-tests the
 * NEXT event with that geometry: hover, `:active`, the cursor, focus, caret placement, text selection and the slider drag are then native.
 * Two cases need help:
 * - the event in hand was hit-tested before its own shift (a jump of the pointer, a press without a move before it, a touch, a picture
 *   that moved under a still pointer). Its intended element comes from a fresh `elementsFromPoint`; at a press whose native control differs
 *   from it, the gesture is re-targeted exactly like the polyfill's interposer does (interposer-controls.js: focus and caret, activation on
 *   release, range drag, the native click swallowed). Hover and the cursor are recomputed in the next frame (HoverSync).
 * - NO_TARGET: the source leaves hit testing (the canvas itself is under the pointer) and a press is swallowed; the focus stays.
 * A gesture keeps the mapper captured at its press (captureGesture), so a drag follows the picture the user pressed on.
 */

import { activate, controlOf, focusControl, isActivatable, isRange, startRangeDrag } from './interposer-controls.js';
import { contentBoxOf, createHoverSync } from './native-geometry.js';
import { isNoTarget } from './no-target.js';

/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').InputPoint} InputPoint */
/** @typedef {import('./native-geometry.js').NativeGeometry} NativeGeometry */
/** @typedef {(p: InputPoint) => {x: number, y: number}} Mapper */
/** @typedef {{pointerId: number, map: Mapper, retargeted: boolean, control: Element|null, drag: ReturnType<typeof startRangeDrag>|null}} Gesture */

const TYPES = /** @type {const} */ (['pointermove', 'pointerdown', 'pointerup', 'pointercancel', 'click']);

/**
 * @param {HicEnv} env
 * @param {HTMLCanvasElement} canvas
 * @param {Element} source
 * @param {import('./input-mapper.js').MapperChain} chain
 * @param {NativeGeometry} geometry
 * @returns {{dispose: () => void, stats: () => {remapped: number, passedThrough: number}}}
 */
export function createNativeInterposer(env, canvas, source, chain, geometry) {
  const win = /** @type {Window & typeof globalThis} */ (env.window);
  const doc = canvas.ownerDocument;
  const hover = createHoverSync(doc);
  const counts = { remapped: 0, passedThrough: 0 };
  /** @type {Gesture|null} */
  let gesture = null;
  let swallowClick = false;

  /** The element of the source at a viewport point, from a fresh hit test (elementFromPoint may answer from its cache). @param {number} x @param {number} y */
  function sourceElementAt(x, y) {
    const top = doc.elementsFromPoint(x, y)[0] ?? null;
    return top && source.contains(top) ? top : null;
  }

  /**
   * Aim the hit-test geometry for the pointer of `e` through `map`.
   * @param {PointerEvent} e
   * @param {Mapper} map
   * @returns {{none: boolean, element: Element|null, changed: boolean}}  none: the mapper returned NO_TARGET; element: what the pointer hits now
   */
  function aim(e, map) {
    const box = contentBoxOf(canvas);
    const x = (e.clientX - box.left) / box.scale;
    const y = (e.clientY - box.top) / box.scale;
    const m = map({ x, y, width: box.width, height: box.height });
    if (isNoTarget(m)) return { none: true, element: null, changed: geometry.park() };
    const changed = geometry.setOffset(x - m.x, y - m.y);
    return { none: false, element: sourceElementAt(e.clientX, e.clientY), changed };
  }

  /** The element the browser hit-tested for `e` (inside the source), or null for the canvas itself. @param {Event} e */
  function nativeElement(e) {
    const first = e.composedPath()[0];
    return first instanceof win.Element && first !== canvas && source.contains(first) ? first : null;
  }

  /** @param {PointerEvent} e */
  function onMove(e) {
    const g = gesture && gesture.pointerId === e.pointerId ? gesture : null;
    if (!g && !chain.active()) {
      counts.passedThrough += 1;
      if (geometry.reset()) hover.poke();
      return;
    }
    const r = aim(e, g ? g.map : (p) => chain.map(p));
    counts.remapped += 1;
    if (g?.drag && !r.none) g.drag.move(e.clientX);
    // hover and the cursor came from the hit test before this shift: recompute them when they show another element than the user sees
    if (!g && r.element !== nativeElement(e)) hover.poke();
  }

  /** @param {PointerEvent} e */
  function onDown(e) {
    swallowClick = false;
    if (!e.isPrimary || e.button !== 0) return;
    if (!chain.active()) { counts.passedThrough += 1; geometry.reset(); return; }
    const map = chain.captureGesture();
    const r = aim(e, map);
    if (r.none) {
      // NO_TARGET: no element of the page is shown here. Swallow the gesture: no mousedown, focus change or selection; no click.
      counts.remapped += 1;
      e.preventDefault();
      hover.poke();
      gesture = { pointerId: e.pointerId, map, retargeted: true, control: null, drag: null };
      return;
    }
    const intended = controlOf(source, r.element);
    const range = isRange(intended);
    if (intended === controlOf(source, nativeElement(e)) && !range) {
      counts.passedThrough += 1;
      gesture = { pointerId: e.pointerId, map, retargeted: false, control: intended, drag: null };
      return;
    }
    counts.remapped += 1;
    e.preventDefault();
    // the layout of the poke also drops the engine's hit-test cache, so the caret lookup below sees the new geometry
    hover.poke();
    if (intended) focusControl(doc, intended, { x: e.clientX, y: e.clientY });
    else if (source.contains(doc.activeElement)) /** @type {HTMLElement} */ (doc.activeElement).blur();
    const drag = range ? startRangeDrag(win, /** @type {HTMLInputElement} */ (intended)) : null;
    if (drag) {
      try { canvas.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
      drag.move(e.clientX);
    }
    gesture = { pointerId: e.pointerId, map, retargeted: true, control: intended, drag };
  }

  /** @param {PointerEvent} e */
  function onUp(e) {
    const g = gesture;
    if (!g || g.pointerId !== e.pointerId) return;
    gesture = null;
    const r = aim(e, g.map);
    if (!g.retargeted) return;
    if (g.drag) {
      if (!r.none) g.drag.move(e.clientX);
      g.drag.end();
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* capture already released */ }
    }
    if (g.control && !g.drag && isActivatable(g.control) && controlOf(source, r.element) === g.control) activate(g.control);
    swallowClick = true;
  }

  /** @param {PointerEvent} e */
  function onCancel(e) {
    if (gesture?.pointerId !== e.pointerId) return;
    gesture = null;
    swallowClick = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* capture already released */ }
  }

  /** A pointer click (detail > 0) after a re-targeted gesture went to the natively hit element: swallowed. @param {MouseEvent} e */
  function onClick(e) {
    if (!swallowClick || e.detail === 0) return;
    swallowClick = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  /** The pointer left the canvas: back to the plain stretch, where focus scrolling, the IME and assistive technology expect the source. */
  const onLeave = () => { if (!gesture) geometry.reset(); };

  /** @type {Record<string, (e: any) => void>} */
  const handlers = { pointermove: onMove, pointerdown: onDown, pointerup: onUp, pointercancel: onCancel, click: onClick };
  for (const type of TYPES) canvas.addEventListener(type, handlers[type], { capture: true });
  canvas.addEventListener('pointerleave', onLeave);

  return {
    dispose() {
      for (const type of TYPES) canvas.removeEventListener(type, handlers[type], { capture: true });
      canvas.removeEventListener('pointerleave', onLeave);
      gesture = null;
      hover.dispose();
    },
    stats: () => ({ ...counts }),
  };
}
