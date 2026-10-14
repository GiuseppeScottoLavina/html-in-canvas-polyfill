/**
 * input/change/selectionchange/keydown/compositionupdate -> damage of the control.
 * Module: schedule (src/schedule/observers/*).
 */

import { getRectMemory } from './damage-rect.js';
import { isTextEditing } from './interaction-tracker.js';

/** @typedef {import('../../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../../contracts/types.js').Damage} Damage */
/** @typedef {import('../../contracts/types.js').DamageCause} DamageCause */
/** @typedef {import('../../contracts/types.js').HicEnv} HicEnv */

const VALUE_EVENTS = ['input', 'change', 'compositionstart', 'compositionupdate', 'compositionend'];
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'Dead']);
/** keys that edit the value (an input event follows): while the field's overlay works they need no damage of their own */
const EDIT_KEYS = new Set(['Backspace', 'Delete']);
/** ms without an edit after which a field whose overlay shows the typing gets its snapshot (optimization 1: one build per typing pause, not per key) */
const TYPING_SETTLE_MS = 150;
/** @type {WeakMap<CanvasRecord, Map<Element, number>>} per canvas: the fields whose snapshot waits for the typing to pause */
const DEFERRED = new WeakMap();

/**
 * The field's typing is shown by the text overlay and its snapshot waits for a pause (scroll-observer.js: the field's own scrolling that follows the caret is drawn by the overlay too).
 * @param {CanvasRecord} record @param {Element} control @returns {boolean}
 */
export function typingDeferred(record, control) {
  return !!DEFERRED.get(record)?.has(control);
}

/**
 * Capture listeners on the layer + document selectionchange (only when the active element is inside the layer). Damage rect = the control's own frame rect grown by the ink margin (the caret and the focus ring stay inside it;
 * a control whose box changes size is reported by the mutation observer through its attributes). Keydown on a text control damages the caret/selection too: arrow keys move it without any other event, and the damage lands
 * before the browser has applied the key, but the build that serves it only starts at the frame end.
 * Remembering the control's box here (memory.own) lets later hover or class damage on the same element stay local.
 * @param {HicEnv} env
 * @param {CanvasRecord} record
 * @returns {() => void}
 */
export function observeInput(env, record) {
  const found = record.layer;
  if (!found) return () => {};
  const layer = found;
  const root = layer.element;
  const memory = getRectMemory(env);

  /** @param {Element|null} control @param {DamageCause} cause @param {boolean} [urgent] */
  function damageControl(control, cause, urgent = false) {
    if (!control || control.nodeType !== 1 || !root.contains(control)) return;
    const drawable = layer.nearestDrawable(control);
    if (!drawable) return;
    env.scheduler.damage(record, cause, drawable, memory.own(layer, control), urgent);
  }

  /** @type {Map<Element, number>} fields whose overlay shows the typing: their snapshot waits for a pause */
  const deferred = new Map();
  DEFERRED.set(record, deferred);
  /** @type {WeakSet<Element>} fields whose last overlay request was accepted (store.overlayText true) */
  const overlaid = new WeakSet();
  /** @param {Element} control */
  const defer = (control) => {
    env.window.clearTimeout(deferred.get(control));
    deferred.set(control, env.window.setTimeout(() => { deferred.delete(control); damageControl(control, 'input'); }, TYPING_SETTLE_MS));
  };

  /** @param {Event} ev */
  const onValue = (ev) => {
    const target = /** @type {Element} */ (ev.target);
    // optimistic text overlay (store.overlayText): the next frame shows the typed value before its snapshot lands; never during an IME composition. When the field's
    // last overlay worked, the snapshot is built once the typing pauses (the overlay is the picture meanwhile; a failing overlay damages the field at once in the store)
    if (ev.type === 'input' && !(/** @type {InputEvent} */ (ev)).isComposing && target.nodeType === 1 && root.contains(target)) {
      const drawable = layer.nearestDrawable(target);
      if (drawable && env.store.overlayText?.(drawable, target)) {
        overlaid.add(target);
        env.scheduler.wake(record);
        defer(target);
        return;
      }
      overlaid.delete(target);
    }
    // a value change of a control that has no caret (checkbox, radio, select, color...) is a discrete action: built at once (optimization 5). Not a range: its drag is a
    // stream of rAF-aligned input events, so an in-task build would land inside the rendering update (measured: a task > 8.33 ms in the slider drag, no latency gain)
    const discrete = target.nodeType === 1 && !isTextEditing(target) && /** @type {HTMLInputElement} */ (target).type !== 'range';
    damageControl(target, 'input', (ev.type === 'input' || ev.type === 'change') && discrete);
  };
  /** @param {KeyboardEvent} ev */
  const onKey = (ev) => {
    const target = /** @type {Element} */ (ev.target);
    if (MODIFIER_KEYS.has(ev.key) || target.nodeType !== 1 || !isTextEditing(target)) return;
    // a key that edits the value is followed by an input event, which serves it (overlay, or damage when the overlay does not work): no build of its own while the
    // typing is deferred, nor for the first key after a pause when the field's overlay worked (release-candidate fix: that key cost one build per pause)
    if ((deferred.has(target) || overlaid.has(target)) && (ev.key.length === 1 || EDIT_KEYS.has(ev.key))) return;
    damageControl(target, 'input');
  };
  /** @param {Event} ev */
  const onSelection = (ev) => {
    const target = /** @type {Element|Document} */ (ev.target);
    // Chrome fires selectionchange on the text control itself (reaches us in the capture phase) and on the document for ordinary selections.
    const control = target.nodeType === 1 ? /** @type {Element} */ (target) : record.root.activeElement;
    // the caret that follows the typing is drawn by the overlay; a real selection (non-collapsed) is built at once
    if (control && deferred.has(control) && collapsed(control)) return;
    damageControl(control, 'selection');
  };

  const capture = { capture: true, passive: true };
  for (const type of VALUE_EVENTS) root.addEventListener(type, onValue, capture);
  root.addEventListener('keydown', /** @type {EventListener} */ (onKey), capture);
  root.addEventListener('selectionchange', onSelection, capture);
  env.document.addEventListener('selectionchange', onSelection, capture);
  return () => {
    for (const t of deferred.values()) env.window.clearTimeout(t);
    deferred.clear();
    if (DEFERRED.get(record) === deferred) DEFERRED.delete(record);
    for (const type of VALUE_EVENTS) root.removeEventListener(type, onValue, capture);
    root.removeEventListener('keydown', /** @type {EventListener} */ (onKey), capture);
    root.removeEventListener('selectionchange', onSelection, capture);
    env.document.removeEventListener('selectionchange', onSelection, capture);
  };
}

/** @param {Element} el @returns {boolean} the field's selection is a caret */
function collapsed(el) {
  try { const c = /** @type {HTMLInputElement} */ (el); return c.selectionStart === c.selectionEnd; } catch { return true; }
}
