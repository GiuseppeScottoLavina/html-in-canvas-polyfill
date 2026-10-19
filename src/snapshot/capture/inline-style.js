/**
 * Inline styles of clone nodes written through the CSSOM.
 * Module: snapshot-capture (src/snapshot/capture/*).
 *
 * `setAttribute('style', ...)` on a node of the inert clone document is a CSP `style-src` violation on pages without 'unsafe-inline' (console error per call);
 * assigning `style.cssText` is not, and serialises to the same style attribute.
 */

/**
 * Replace the whole inline style of `el`.
 * @param {Element} el
 * @param {string} cssText
 */
export function setInlineStyle(el, cssText) {
  /** @type {HTMLElement} */ (el).style.cssText = cssText;
}

/**
 * Append declarations to the inline style of `el` (later declarations win like in the attribute form).
 * @param {Element} el
 * @param {string} cssText
 */
export function appendInlineStyle(el, cssText) {
  const style = /** @type {HTMLElement} */ (el).style;
  const own = style.cssText;
  style.cssText = `${own}${own && !own.trimEnd().endsWith(';') ? ';' : ''}${cssText}`;
}
