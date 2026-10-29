/**
 * Where an SVG resource lies relative to the drawable canvases, the rule the native oracle applies to every reference by fragment (snapshot/capture/svg-refs.js).
 * Module: util.
 */

import { MARK } from '../contracts/events.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * True when `el` lies in the subtree of a canvas with content=drawable (its live layer, or the canvas itself before the layer is mounted), in the light tree or through
 * shadow hosts. The nearest canvas decides: the children of a plain canvas inside a drawable one are not rendered.
 * @param {Element} el @returns {boolean}
 */
export function inDrawableCanvas(el) {
  for (let n = /** @type {Node|null} */ (el.parentNode); n; n = n.parentNode ?? /** @type {ShadowRoot} */ (n).host ?? null) {
    if (n.nodeType !== 1) continue;
    const e = /** @type {Element} */ (n);
    if (e.hasAttribute(MARK.LAYER_ATTR)) return true;
    if (e.localName === 'canvas' && e.namespaceURI === 'http://www.w3.org/1999/xhtml') return (e.getAttribute('content') ?? '').toLowerCase() === 'drawable' || e.hasAttribute('layoutsubtree');
  }
  return false;
}

/**
 * A computed filter list (the drawable's own backdrop-filter, which the draw applies through `ctx.filter`) without the url() filters the native oracle ignores: one that is
 * missing, outside every drawable canvas, in another document, or whose feImage loads an image of another origin (it would also TAINT the canvas: `ctx.filter` reads it
 * without CORS). The other functions of the list stay (measured, Canary 159: `url(#outside) invert(1)` inverts). 'none' when nothing is left.
 * @param {Document} doc @param {string} value @returns {string}
 */
export function scopedFilterList(doc, value) {
  if (!value.includes('url(')) return value;
  const here = doc.URL.split('#')[0];
  const kept = value.replace(/url\(\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^)\s]*))\s*\)/g, (whole, a, b, c) => {
    const raw = String(a ?? b ?? c ?? '').replace(/\\(.)/g, '$1');
    let id = '';
    try { const u = new URL(raw, doc.baseURI); if (raw.startsWith('#') || u.href.split('#')[0] === here) id = decodeURIComponent(u.hash.slice(1)); } catch { /* unparsable */ }
    const f = id ? doc.getElementById(id) : null;
    return f && f.localName === 'filter' && f.namespaceURI === SVG_NS && inDrawableCanvas(f) && !foreignImage(doc, f) ? whole : '';
  }).trim().replace(/\s+/g, ' ');
  return kept || 'none';
}

/** @param {Document} doc @param {Element} filter @returns {boolean} a feImage of `filter` loads a URL of another origin (or one that does not parse) */
function foreignImage(doc, filter) {
  const origin = new URL(doc.URL).origin;
  for (const im of Array.from(filter.querySelectorAll('feImage'))) {
    const href = im.getAttribute('href') ?? im.getAttribute('xlink:href') ?? '';
    if (!href || href.startsWith('#') || href.startsWith('data:')) continue;
    try { if (new URL(href, doc.baseURI).origin !== origin) return true; } catch { return true; }
  }
  return false;
}
