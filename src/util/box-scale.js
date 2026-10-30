/**
 * Layout size and transform scale of an element from FRACTIONAL sizes. Module: util.
 *
 * offsetWidth / offsetHeight are rounded to whole css px, while getBoundingClientRect and the computed size are fractional, so their ratio is not 1 on an untransformed box
 * whose size is fractional. Measured on Chrome 156 for Android (DPR 2.625): a size-3 listbox is 52.524 css px high (137.875 device px) with offsetHeight 53, the ratio was
 * taken for a scale of 1.009, and the listbox was scrolled 34.78 px instead of Chrome's 34 (the options drawn 2 device px too high).
 */

/** @typedef {import('../contracts/types.js').Size} Size */

/** @param {string} value @returns {number} */
const px = (value) => parseFloat(value) || 0;

/** @param {Element} el @returns {CSSStyleDeclaration} */
const styleOf = (el) => (el.ownerDocument.defaultView ?? window).getComputedStyle(el);

/**
 * Used border-box size in css px before any transform, from the computed style (fractional). null for boxes whose width/height resolve to a keyword (inline).
 * @param {Element} el
 * @param {CSSStyleDeclaration} [style]
 * @returns {Size|null}
 */
export function layoutSize(el, style = styleOf(el)) {
  const w = parseFloat(style.width);
  const h = parseFloat(style.height);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  if (style.boxSizing === 'border-box') return { width: w, height: h };
  return {
    width: w + px(style.paddingLeft) + px(style.paddingRight) + px(style.borderLeftWidth) + px(style.borderRightWidth),
    height: h + px(style.paddingTop) + px(style.paddingBottom) + px(style.borderTopWidth) + px(style.borderBottomWidth),
  };
}

/**
 * Viewport px per layout css px of `el` on each axis (the transforms on it and its ancestors, axis-aligned): its bounding box against its fractional layout size. Exactly 1
 * within float noise (the bounding box is float32); the rounded offset size is used only when the computed size is a keyword (an inline box). 1 when nothing is measurable.
 * @param {Element} el
 * @param {{width: number, height: number}} [r]  el's bounding box, when the caller has it
 * @param {CSSStyleDeclaration} [style]
 * @returns {{x: number, y: number}}
 */
export function boxScale(el, r = el.getBoundingClientRect(), style = styleOf(el)) {
  const size = layoutSize(el, style), h = /** @type {HTMLElement} */ (el);
  const k = (/** @type {number} */ v, /** @type {number} */ l) => { const q = v > 0 && l > 0 ? v / l : 1; return Math.abs(q - 1) < 1e-4 ? 1 : q; };
  return { x: k(r.width, size?.width ?? h.offsetWidth), y: k(r.height, size?.height ?? h.offsetHeight) };
}
