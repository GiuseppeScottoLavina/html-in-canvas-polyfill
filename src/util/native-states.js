/**
 * Which live elements an engine draws DIFFERENTLY in an interaction state without any page rule asking for it (the widget theme's own hover / pressed look), so a change of
 * that state must repaint them even when no author rule uses :hover / :active (ADR X-12). PURE apart from reading the element's tag and type.
 * Measured (Firefox 157.0.1, macOS): hover changes the border of every themed field and toggle and the face of buttons, selects, colour wells and the range; pressed changes
 * buttons, colour wells, the range and the checked accent of checkbox and radio. Safari 27: see WEBKIT_PRESS_TYPES.
 * Module: util.
 */

const GECKO_FIELD_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'time', 'datetime-local', 'month', 'week', 'checkbox', 'radio', 'range', 'color', 'button', 'submit', 'reset']);
const PRESS_TYPES = new Set(['button', 'submit', 'reset', 'color', 'range']);
/** Safari 27.0.1: pressed push buttons, checkboxes, radios and sliders are drawn darker (lighter in the dark appearance); hover changes nothing. */
const WEBKIT_PRESS_TYPES = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'range']);

/**
 * @param {Element} el @param {'hover'|'active'} state @param {string} engine 'gecko' | 'webkit' | ... @returns {boolean} the engine's theme draws `el` differently in `state`
 */
export function themedStateChange(el, state, engine) {
  const ln = el.localName;
  const type = ln === 'input' ? /** @type {HTMLInputElement} */ (el).type : '';
  if (engine === 'gecko') {
    if (state === 'hover') return ln === 'button' || ln === 'select' || ln === 'textarea' || (ln === 'input' && GECKO_FIELD_TYPES.has(type));
    return ln === 'button' || (ln === 'input' && PRESS_TYPES.has(type));
  }
  if (engine === 'webkit') return state === 'active' && (ln === 'button' || (ln === 'input' && WEBKIT_PRESS_TYPES.has(type)));
  return false;
}

/** Controls whose look depends on the window being key (WebKit macOS draws accent-tinted parts in grey in an inactive window). */
export const WINDOW_STATE_SELECTOR = 'input,button,select,textarea,progress,meter';

const PRESSES_KEY = Symbol.for('hic.native-presses');
/** one map per page, shared by every copy of this module (core and engines bundle): */
/**
 * @type {WeakMap<Element, {x: number, y: number, value: string}|null>} where the last press on an element landed (client px) and the control's value BEFORE the press (a
 * press on a slider track moves the thumb under the pointer right after); null: not known, e.g. a press mapped through an effect
 */
const presses = /** @type {any} */ (globalThis)[PRESSES_KEY] ?? (/** @type {any} */ (globalThis)[PRESSES_KEY] = new WeakMap());

/** @param {Element} el @param {{x: number, y: number}|null} at */
export function notePress(el, at) { presses.set(el, at && { ...at, value: /** @type {HTMLInputElement} */ (el).value ?? '' }); }

/**
 * Was the press on a range input ON its thumb? Safari draws the pressed slider only then (a press on the track keeps the resting look, measured Safari 27.0.1). PURE apart from
 * reading the element's box. Unknown press points count as on the thumb.
 * @param {HTMLInputElement} el @param {number} ratio value position 0-1 (the value at the press wins when known) @param {number} thumbWidth css px @param {boolean} rtl @returns {boolean}
 */
export function pressOnThumb(el, ratio, thumbWidth, rtl) {
  const at = presses.get(el);
  if (!at) return true;
  const min = Number(el.min || 0), max = Number(el.max || 100), v = Number(at.value);
  if (max > min && Number.isFinite(v)) ratio = Math.min(1, Math.max(0, (v - min) / (max - min)));
  const r = el.getBoundingClientRect();
  const k = el.offsetWidth > 0 ? r.width / el.offsetWidth : 1;
  const x0 = r.left + (rtl ? 1 - ratio : ratio) * (r.width - thumbWidth * k);
  return at.x >= x0 && at.x <= x0 + thumbWidth * k;
}
