/**
 * What the interposer does to the control that the displaced pixels show: find it, focus it, place the caret, activate it, drive a range.
 * Module: gpu-effects (src/effects/**).
 */

const CONTROL_SELECTOR = 'a[href],button,input:not([type=hidden]),select,textarea,summary,label,[tabindex]';
/** input types whose selection can be set from script (setSelectionRange throws for email/number/...) */
const SELECTABLE = new Set(['text', 'search', 'url', 'tel', 'password']);
/** thumb width Chrome gives a default range input when the computed width of the pseudo-element is not usable */
const DEFAULT_THUMB = 16;

/**
 * The interactive element that a pointer at `el` would operate, inside `layerEl`; null when there is none.
 * @param {Element} layerEl
 * @param {Element|null} el
 * @returns {Element|null}
 */
export function controlOf(layerEl, el) {
  const c = el ? el.closest(CONTROL_SELECTOR) : null;
  return c && layerEl.contains(c) ? c : null;
}

/** @param {Element|null} el @returns {el is HTMLInputElement} */
export function isRange(el) {
  return !!el && el.localName === 'input' && /** @type {HTMLInputElement} */ (el).type === 'range';
}

/** @param {Element|null} el @returns {el is HTMLInputElement|HTMLTextAreaElement} */
function isTextControl(el) {
  if (!el) return false;
  if (el.localName === 'textarea') return true;
  return el.localName === 'input' && SELECTABLE.has(/** @type {HTMLInputElement} */ (el).type);
}

/**
 * Controls whose click activation is a real action: buttons, links, checkboxes, radios, labels, summaries.
 * Text fields, selects and ranges are only focused.
 * @param {Element} el
 */
export function isActivatable(el) {
  if (isRange(el) || isTextControl(el) || el.localName === 'select') return false;
  return el.localName !== 'input' || /** @type {HTMLInputElement} */ (el).type !== 'hidden';
}

/**
 * Focus `control` and, for a text field, put the caret where the MAPPED point is (document.caretPositionFromPoint returns the field itself
 * with a character offset for inputs and textareas in Chrome).
 * @param {Document} doc
 * @param {Element} control
 * @param {{x: number, y: number}} clientPoint  the mapped pointer, viewport css px
 */
export function focusControl(doc, control, clientPoint) {
  /** @type {HTMLElement} */ (control).focus();
  if (!isTextControl(control)) return;
  const hit = /** @type {any} */ (doc).caretPositionFromPoint?.(clientPoint.x, clientPoint.y);
  if (hit && hit.offsetNode === control) {
    try { control.setSelectionRange(hit.offset, hit.offset); } catch { /* the control stopped being selectable */ }
  }
}

/**
 * Click-activate a control the way a pointer release over it would. A label forwards the click to its control by itself.
 * @param {Element} control
 */
export function activate(control) {
  /** @type {HTMLElement} */ (control).click();
}

/**
 * A range input being dragged: value from the mapped x, `input` per change, one `change` at the end.
 * @param {Window & typeof globalThis} win
 * @param {HTMLInputElement} input
 */
export function startRangeDrag(win, input) {
  const startValue = input.value;
  let last = startValue;
  const px = parseFloat(win.getComputedStyle(input, '::-webkit-slider-thumb').width);
  const thumb = px > 0 && px <= 48 ? px : DEFAULT_THUMB;
  return {
    /** @param {number} clientX  mapped x, viewport css px */
    move(clientX) {
      const r = input.getBoundingClientRect();
      const span = Math.max(1, r.width - thumb);
      const frac = Math.min(1, Math.max(0, (clientX - r.left - thumb / 2) / span));
      const min = Number(input.min) || 0;
      const max = input.max === '' ? 100 : Number(input.max);
      input.value = String(min + frac * (max - min));
      if (input.value !== last) {
        last = input.value;
        input.dispatchEvent(new win.Event('input', { bubbles: true }));
      }
    },
    end() {
      if (input.value !== startValue) input.dispatchEvent(new win.Event('change', { bubbles: true }));
    },
  };
}
