/**
 * Ancestor-dependent state of the clone: the custom properties the page defines ABOVE the canvas and the attribute-only shell chain that stands for those ancestors.
 * Module: snapshot-capture (src/snapshot/capture/*).
 */

import { cleanAttributes } from './state-sync.js';
import { setInlineStyle } from './inline-style.js';

const VAR_REF = /var\(\s*(--[^\s,)]+)/g;
/** Attributes that could make the image document fetch something; a link keeps its href (`:any-link` rules, the UA link colour). */
const LOADING_ATTRS = ['src', 'srcset', 'poster', 'data', 'action', 'formaction', 'ping', 'background'];

/**
 * PURE. Adds the custom property names that `var()` references in `text` to `into`.
 * @param {string} text
 * @param {Set<string>} into
 */
export function collectVarNames(text, into) {
  if (!text.includes('var(')) return;
  for (const m of text.matchAll(VAR_REF)) into.add(m[1]);
}

/**
 * Ancestors of the canvas from the outermost to the canvas parent. html and body are not part of it: the clone root stands for both.
 * @param {Element} canvas
 * @param {Document} live
 * @returns {Element[]}
 */
export function canvasAncestors(canvas, live) {
  /** @type {Element[]} */
  const out = [];
  for (let cur = canvas.parentElement; cur && cur !== live.body && cur !== live.documentElement; cur = cur.parentElement) out.push(cur);
  return out.reverse();
}

/**
 * A <canvas> ancestor (the outer canvas of a nested one) cannot stay a canvas in the clone: its children are fallback content that is not rendered (WPT nested-content-drawable-canvas drew nothing).
 * @param {Document} doc @param {Element} source @returns {Element}
 */
function standInForCanvas(doc, source) {
  const stand = doc.createElement('hic-canvas');
  for (const a of Array.from(source.attributes)) stand.setAttribute(a.name, a.value);
  return stand;
}

/**
 * An attribute-only `display:contents` stand-in of an ancestor of the canvas: it carries tag, class, id and attributes so selectors written for the ancestor chain
 * (`.app.theme-dark .card`, `main > .content .x`, `[data-mode=dark] .y`) match, and it paints nothing. Its own inline style is dropped: the custom properties and the inherited
 * text properties of the whole chain reach the clone root as computed values (inheritCustomProperties, clone.js).
 * @param {Document} doc  inert document
 * @param {Element} source  the live ancestor
 * @returns {Element}
 */
export function ancestorShell(doc, source) {
  const shell = source.localName === 'canvas' ? standInForCanvas(doc, source) : doc.importNode(source, false);
  cleanAttributes(shell);
  for (const name of LOADING_ATTRS) shell.removeAttribute(name);
  shell.removeAttribute('style');
  shell.setAttribute('data-hic-shell', '');
  setInlineStyle(shell, 'display:contents!important');
  return shell;
}

/**
 * Give the clone root the computed value of every custom property the clone refers to: whatever an ancestor, a rule that cannot be matched in the clone (`:has()`, sibling
 * combinators) or a registered property resolved for the layer is then seen by the clone through ordinary inheritance. Empty values (not defined above the canvas) are skipped.
 * @param {Element} root  clone root
 * @param {CSSStyleDeclaration} layerStyle  computed style of the layer element (the position of the canvas in the live tree)
 * @param {Iterable<string>} names
 */
export function inheritCustomProperties(root, layerStyle, names) {
  const style = /** @type {HTMLElement} */ (root).style;
  for (const name of names) {
    const value = layerStyle.getPropertyValue(name).trim();
    if (value) style.setProperty(name, value);
  }
}
