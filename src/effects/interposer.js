/**
 * Pointer remap + re-targeting on the live layer.
 * Module: gpu-effects (src/effects/**).
 *
 * Verified fact (Chrome 154): preventDefault on pointerdown suppresses mousedown, focus and caret placement on the natively hit element
 * but `click` still fires and a checkbox still toggles, so a re-targeted gesture must also swallow the click that follows its pointerup.
 * Pointer events themselves are NOT stopped: plugin listeners (water ripples) and page code keep seeing them, with the native target.
 * A mapper that returns NO_TARGET (no element is shown at that point) gets a swallowed gesture: no focus change, no activation, no click,
 * and nothing of the page is hovered.
 * A finger hovers as on a page without effects (interaction-tracker.js): a press activates the element drawn under it but hovers nothing, a pan or a drag (a scroll,
 * a lens moved by its handle) moves no :hover across what it passes, and a tap leaves the element drawn where it landed under :hover until the next tap. Mouse and pen
 * hover what is drawn under them at every move.
 */

import { invalidState } from '../contracts/errors.js';
import { activate, controlOf, focusControl, isActivatable, isRange, openPicker, startRangeDrag } from './interposer-controls.js';
import { isNoTarget } from './no-target.js';

/** @typedef {import('../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').InteractionTracker} InteractionTracker */
/** @typedef {import('../contracts/types.js').InputPoint} InputPoint */
/** @typedef {(p: InputPoint) => {x: number, y: number}} Mapper */
/** @typedef {{left: number, top: number, sx: number, sy: number, width: number, height: number}} LayerFrame */
/** @typedef {{pointerId: number, map: Mapper, retargeted: boolean, control: Element|null, drag: ReturnType<typeof startRangeDrag>|null, tap?: {x: number, y: number, point: {x: number, y: number}}|null, finger?: {x: number, y: number, moved: boolean}}} Gesture */

/** css px a finger may travel and still tap: beyond it the press is a drag (a scroll, or a plugin's own gesture) and focuses or activates nothing */
const TAP_SLOP = 10;

const TYPES = /** @type {const} */ (['pointermove', 'pointerdown', 'pointerup', 'pointercancel', 'click']);

/**
 * Capture listeners for pointermove/down/up/click; map through chain.captureGesture(); intended element = layer.elementAtPoint(mapped); hover/active follow it through tracker.setMappedTarget, the layer cursor is set from its computed cursor;
 * re-target focus, click activation, range drag (value updates on every pointermove of the gesture), touch (implicit capture stays on the natively hit element: the gesture is re-implemented from the mapped target) and caret placement (feature interposer-retarget).
 * @param {HicEnv} env
 * @param {CanvasRecord} record
 * @param {import('./input-mapper.js').MapperChain} chain
 * @param {InteractionTracker} tracker
 * @returns {{dispose: () => void, stats: () => {remapped: number, passedThrough: number}}}
 */
export function createInterposer(env, record, chain, tracker) {
  const layer = record.layer;
  if (!layer) throw invalidState('the interposer needs the live layer of a managed canvas');
  const layerEl = layer.element;
  const win = /** @type {Window & typeof globalThis} */ (env.window);
  const counts = { remapped: 0, passedThrough: 0 };
  /** @type {Gesture|null} */
  let gesture = null;
  let swallowClick = false;
  /** @type {Element|null} */
  let shown = null;
  let cursor = '';

  /** The layer sits exactly over the canvas content box; css transforms of the canvas are undone by the size ratio. @returns {LayerFrame} */
  function frameOf() {
    const r = layerEl.getBoundingClientRect();
    const box = record.contentBox;
    const width = box && box.width > 0 ? box.width : r.width;
    const height = box && box.height > 0 ? box.height : r.height;
    return { left: r.left, top: r.top, sx: r.width > 0 ? width / r.width : 1, sy: r.height > 0 ? height / r.height : 1, width, height };
  }

  /**
   * @param {PointerEvent} e
   * @param {Mapper} map
   * @returns {{point: {x: number, y: number}|null, element: Element|null}}  `point` in viewport css px; null when the mapper returned NO_TARGET
   */
  function resolve(e, map) {
    const f = frameOf();
    const m = map({ x: (e.clientX - f.left) * f.sx, y: (e.clientY - f.top) * f.sy, width: f.width, height: f.height });
    if (isNoTarget(m)) return { point: null, element: null };
    const point = { x: f.left + m.x / f.sx, y: f.top + m.y / f.sy };
    return { point, element: layer?.elementAtPoint(point) ?? null };
  }

  /**
   * Hover/:active chains and the layer cursor follow `el` (null = the native pointer again). For NO_TARGET they follow the layer itself:
   * no element of the page is hovered.
   * @param {Element|null} el  @param {boolean} [none]  the mapper returned NO_TARGET
   */
  function follow(el, none = false) {
    const next = none ? layerEl : el;
    // the tracker forgets a mapped hover by itself when a finger taps outside the canvas
    if (next === shown && (tracker.mappedTarget?.(record) ?? null) === next) return;
    shown = next;
    tracker.setMappedTarget(record, next);
    setCursor(none ? 'default' : el ? cursorOf(el) : '');
  }

  /**
   * The cursor `el` has without the one this interposer put on the layer: an element without a cursor of its own inherits the
   * layer's, so reading it while the layer carries the previous target's cursor would keep that cursor everywhere.
   * @param {Element} el
   */
  function cursorOf(el) {
    if (!cursor) return win.getComputedStyle(el).cursor;
    layerEl.style.removeProperty('cursor');
    const value = win.getComputedStyle(el).cursor;
    layerEl.style.setProperty('cursor', cursor);
    return value;
  }

  /** @param {string} value */
  function setCursor(value) {
    if (value === cursor) return;
    cursor = value;
    if (value) layerEl.style.setProperty('cursor', value);
    else layerEl.style.removeProperty('cursor');
  }

  /** A finger moves no :hover: only its gesture is followed (the slider it drags, how far it travelled). @param {PointerEvent} e @param {Gesture|null} g */
  function onFingerMove(e, g) {
    if (!g) { counts.passedThrough += 1; return; }
    if (g.finger && Math.hypot(e.clientX - g.finger.x, e.clientY - g.finger.y) > TAP_SLOP) g.finger.moved = true;
    if (g.tap && Math.hypot(e.clientX - g.tap.x, e.clientY - g.tap.y) > TAP_SLOP) g.tap = null;
    if (g.drag) { const { point } = resolve(e, g.map); if (point) g.drag.move(point.x); }
    counts.remapped += 1;
  }

  /** @param {PointerEvent} e */
  function onMove(e) {
    const g = gesture && gesture.pointerId === e.pointerId ? gesture : null;
    if (e.pointerType === 'touch') { onFingerMove(e, g); return; }
    if (!g && !chain.active()) { counts.passedThrough += 1; follow(null); return; }
    const { point, element } = resolve(e, g ? g.map : (p) => chain.map(p));
    follow(element, !point);
    if (g?.drag && point) g.drag.move(point.x);
    if (g?.tap && Math.hypot(e.clientX - g.tap.x, e.clientY - g.tap.y) > TAP_SLOP) g.tap = null;
    counts.remapped += 1;
  }

  /** @param {PointerEvent} e */
  function onDown(e) {
    swallowClick = false;
    if (!e.isPrimary || e.button !== 0) return;
    if (!chain.active()) { counts.passedThrough += 1; follow(null); return; }
    const map = chain.captureGesture();
    const { point, element } = resolve(e, map);
    const finger = e.pointerType === 'touch' ? { x: e.clientX, y: e.clientY, moved: false } : undefined;
    // a finger's press activates what is drawn under it and hovers nothing (its tap does, in onUp)
    if (finger) tracker.setMappedPress?.(record, point ? element : layerEl);
    else follow(element, !point);
    if (!point) {
      // NO_TARGET: what the user sees there is not an element of the page. Swallow the gesture: no mousedown, focus change or text
      // selection on the natively hit element, no activation on pointerup, no click; the focused element keeps the focus.
      counts.remapped += 1;
      e.preventDefault();
      gesture = { pointerId: e.pointerId, map, retargeted: true, control: null, drag: null, finger };
      return;
    }
    const intended = controlOf(layerEl, element);
    const first = e.composedPath()[0];
    const range = isRange(intended);
    if (intended === controlOf(layerEl, first instanceof Element ? first : null) && !range) {
      counts.passedThrough += 1;
      gesture = { pointerId: e.pointerId, map, retargeted: false, control: intended, drag: null, finger };
      return;
    }
    counts.remapped += 1;
    e.preventDefault();
    // a finger moves the focus when it lifts without having travelled, as on a page without effects: a press that becomes a scroll or a plugin's
    // drag (a lens moved across a field) focuses nothing, and on a phone it would raise the keyboard (a range is dragged from the press)
    const tap = e.pointerType === 'touch' && !range ? { x: e.clientX, y: e.clientY, point } : null;
    if (!tap) focusAt(intended, point);
    const drag = range ? startRangeDrag(win, /** @type {HTMLInputElement} */ (intended)) : null;
    if (drag) {
      try { layerEl.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
      drag.move(point.x);
    }
    gesture = { pointerId: e.pointerId, map, retargeted: true, control: intended, drag, tap, finger };
  }

  /** @param {Element|null} intended @param {{x: number, y: number}} point */
  function focusAt(intended, point) {
    const doc = layerEl.ownerDocument;
    if (intended) focusControl(doc, intended, point);
    else if (layerEl.contains(doc.activeElement)) /** @type {HTMLElement} */ (doc.activeElement).blur();
  }

  /** @param {PointerEvent} e */
  function onUp(e) {
    const g = gesture;
    if (!g || g.pointerId !== e.pointerId) return;
    gesture = null;
    // a finger that lifted without travelling tapped: the element drawn there takes the :hover, and keeps it until the next tap (the tracker ends it for a tap elsewhere)
    if (g.finger && !g.finger.moved && !g.drag) { const at = resolve(e, g.map); follow(at.element, !at.point); }
    if (!g.retargeted) return;
    const { point, element } = resolve(e, g.map);
    if (g.drag) {
      if (point) g.drag.move(point.x);
      g.drag.end();
      try { layerEl.releasePointerCapture(e.pointerId); } catch { /* capture already released */ }
    }
    // a finger: a tap (it did not travel) focuses, then activates; a drag does neither
    const touch = g.tap !== undefined && e.pointerType === 'touch' && !g.drag;
    if (touch && !g.tap) { swallowClick = true; return; }
    if (g.tap) focusAt(g.control, g.tap.point);
    // Click semantics: the release must land on the control the press started on.
    if (g.control && !g.drag && isActivatable(g.control) && controlOf(layerEl, element) === g.control) activate(g.control);
    else if (g.control && !g.drag && controlOf(layerEl, element) === g.control) openPicker(g.control);
    swallowClick = true;
  }

  /** @param {PointerEvent} e */
  function onCancel(e) {
    if (gesture?.pointerId !== e.pointerId) return;
    gesture = null;
    swallowClick = false;
    try { layerEl.releasePointerCapture(e.pointerId); } catch { /* capture already released */ }
  }

  /** A native click detail > 0 comes from a pointer; keyboard and script clicks (including our own activation) have detail 0 and pass. @param {MouseEvent} e */
  function onClick(e) {
    if (!swallowClick || e.detail === 0) return;
    swallowClick = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  /** @type {Record<string, (e: any) => void>} */
  const handlers = { pointermove: onMove, pointerdown: onDown, pointerup: onUp, pointercancel: onCancel, click: onClick };
  for (const type of TYPES) layerEl.addEventListener(type, handlers[type], { capture: true });
  // a finger's pointerleave follows its pointerup: the hover of its tap stays
  const onLeave = (/** @type {PointerEvent} */ e) => { if (!gesture && e.pointerType !== 'touch') follow(null); };
  layerEl.addEventListener('pointerleave', onLeave);

  return {
    dispose() {
      for (const type of TYPES) layerEl.removeEventListener(type, handlers[type], { capture: true });
      layerEl.removeEventListener('pointerleave', onLeave);
      gesture = null;
      follow(null);
    },
    stats: () => ({ ...counts }),
  };
}
