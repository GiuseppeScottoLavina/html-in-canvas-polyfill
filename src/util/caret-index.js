/**
 * Caret index of text inputs whose selection API is unavailable (type email, number: selectionStart is null in every engine, setSelectionRange throws).
 * The engine knows the caret but does not expose it, so it is derived from what the user did (leaf module, importing only util):
 * - a press on the control: the caret goes where the pointer is (`x`, local css px of the border box; resolved by the caret measurement with the control's font);
 * - an edit (`input`): the caret follows the edit, from the diff of the old and new value (end of the common suffix), so it self-corrects on every keystroke;
 * - ArrowLeft/Right +-1, Home/End/ArrowUp/ArrowDown (and Meta/Ctrl + Left/Right) to the start/end;
 * - a focus without a press (Tab, script) or a value written by script: the end of the value.
 * Approximate by nature (no word-wise moves, no selection highlight: the selection is invisible to script); types with a selection API keep the native one.
 */

import { boxScale } from './box-scale.js';

/** @typedef {{value: string, index: number, x: number|null}} CaretState */

/** text-entry input types (a checkbox or a range also has selectionStart null, but no caret) */
const TEXT_ENTRY = new Set(['text', 'search', 'url', 'tel', 'password', 'email', 'number']);

/** @type {WeakMap<Element, CaretState>} */
const states = new WeakMap();

/** @param {Element|null|undefined} el @returns {el is HTMLInputElement} an input that is a text field whose caret script cannot read */
export function selectionApiMissing(el) {
  if (!el || el.nodeName !== 'INPUT' || !TEXT_ENTRY.has(/** @type {HTMLInputElement} */ (el).type)) return false;
  try {
    return /** @type {HTMLInputElement} */ (el).selectionStart === null && typeof (/** @type {HTMLInputElement} */ (el).value) === 'string';
  } catch {
    return true;
  }
}

/** @param {string} a @param {string} b @returns {number} caret index in `b` after editing `a` into `b` (end of what changed) */
export function caretAfterEdit(a, b) {
  let prefix = 0;
  const max = Math.min(a.length, b.length);
  while (prefix < max && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return b.length - suffix;
}

/** @param {HTMLInputElement} el @returns {CaretState} */
function stateOf(el) {
  let s = states.get(el);
  if (!s || s.value !== el.value) {
    s = { value: el.value, index: el.value.length, x: null };
    states.set(el, s);
  }
  return s;
}

/**
 * Feed one event seen on (or inside) the drawable's layer: pointerdown, focusin, keydown, input. Ignores every target with a working selection API.
 * @param {Event} ev
 */
export function noteCaretEvent(ev) {
  const el = /** @type {Element|null} */ (ev.target);
  if (!selectionApiMissing(el)) return;
  const value = el.value;
  const prev = states.get(el);
  switch (ev.type) {
    case 'pointerdown': {
      const pe = /** @type {PointerEvent} */ (ev);
      if (pe.button !== 0) return;
      noteCaretPoint(el, pe.clientX);
      return;
    }
    case 'focusin':
      if (!prev || prev.x === null) states.set(el, { value, index: value.length, x: null });
      return;
    case 'input':
      states.set(el, { value, index: prev && prev.value !== value ? caretAfterEdit(prev.value, value) : (prev?.index ?? value.length), x: null });
      return;
    case 'keydown': {
      const ke = /** @type {KeyboardEvent} */ (ev);
      const s = stateOf(el);
      const line = ke.metaKey || ke.ctrlKey;
      if (ke.shiftKey || ke.altKey) return;
      if (ke.key === 'Home' || ke.key === 'ArrowUp' || (line && ke.key === 'ArrowLeft')) set(s, 0);
      else if (ke.key === 'End' || ke.key === 'ArrowDown' || (line && ke.key === 'ArrowRight')) set(s, value.length);
      else if (ke.key === 'ArrowLeft') set(s, s.x === null ? s.index - 1 : null);
      else if (ke.key === 'ArrowRight') set(s, s.x === null ? s.index + 1 : null);
    }
  }
}

/** @param {CaretState} s @param {number|null} index */
function set(s, index) {
  if (index === null) return;
  s.index = Math.max(0, Math.min(s.value.length, index));
  s.x = null;
}

/**
 * The caret goes where a press at viewport x `clientX` puts it (the interposer calls this with the MAPPED point when it focuses the control itself).
 * @param {HTMLInputElement} el @param {number} clientX
 */
export function noteCaretPoint(el, clientX) {
  const r = el.getBoundingClientRect();
  const k = 1 / boxScale(el, r).x;
  states.set(el, { value: el.value, index: el.value.length, x: (clientX - r.left) * k });
}

/**
 * The caret of `el` for the measurement: `{index}` or, after a press not yet resolved, `{x}` (local css px). `resolve` turns x into an index once
 * (the caller measures text); later reads return that index until the next event.
 * @param {HTMLInputElement} el
 * @param {(x: number) => number} resolve
 * @returns {number}
 */
export function fallbackCaretIndex(el, resolve) {
  const s = stateOf(el);
  if (s.x !== null) set(s, resolve(s.x));
  return s.index;
}
