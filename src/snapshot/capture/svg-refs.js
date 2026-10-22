/**
 * `filter: url(#id)` that names an SVG <filter> OUTSIDE the drawable: the clone is a separate SVG image document that has no such element, so the filter was dropped (WPT css-filter-reference-on-div).
 * The referenced <filter> elements are copied into the clone as a zero-size hidden <svg>, and so are the targets of `<use href="#id">` (chains included): Chrome draws a <use> whose target is outside
 * the drawable (WPT privacy/svg/svg-use-*: the same-origin image of the target draws, the cross-origin one does not). Markers and paint servers outside the subtree are NOT copied:
 * the platform ignores them for privacy (WPT privacy/svg/*). A mask outside the subtree masks its element away entirely (measured on the native oracle: the element is not drawn), so it
 * becomes an empty <mask> of the same id. Images of a copy (`<image href>`) go through the resource cache like every other image: readable ones are inlined, the others
 * (cross-origin without CORS, 404) are removed, as the platform ignores them. The feImage of every filter of the clone (copied or inside the drawable) is settled by settleFilterImages.
 * Module: snapshot-capture (src/snapshot/capture/*).
 */

import { resolveResource } from './inline-resources.js';
import { appendInlineStyle, setInlineStyle } from './inline-style.js';

/** @typedef {import('../../contracts/types.js').ResourceCache} ResourceCache */

const SVG_NS = 'http://www.w3.org/2000/svg';
const FILTER_REF = /filter\s*[:=]\s*["']?[^;"'}]*?url\(\s*["']?#([^"')\s]+)/gi;
/** `mask: url(#id)`, `mask-image` (also -webkit-) in CSS text, and the `mask` attribute written as `mask:` by the caller. */
const MASK_REF = /mask(?:-image)?\s*[:=]\s*["']?[^;"'}]*?url\(\s*["']?#([^"')\s]+)/gi;

/** @param {string} text @param {Set<string>} ids @param {RegExp} [re] */
function collect(text, ids, re = FILTER_REF) {
  for (const m of text.matchAll(re)) ids.add(m[1]);
}

/**
 * Copy the filters that the clone refers to by fragment but does not contain.
 * @param {Document} live
 * @param {Element} root  clone root
 * @param {string} css  the stylesheet text of the clone
 * @param {ResourceCache} cache  feImage images are inlined as data: URLs from it (same-origin and CORS images draw, the others are dropped)
 * @returns {{added: number, pending: boolean}} elements added, and whether an image of a filter is still loading
 */
export function addReferencedFilters(live, root, css, cache) {
  const none = { added: 0, pending: false };
  if (!/url\(\s*["']?#/i.test(css) && !root.querySelector('[style*="#"], [filter*="#"]')) return none;
  /** @type {Set<string>} */
  const ids = new Set();
  collect(css, ids);
  for (const el of Array.from(root.querySelectorAll('[style*="#"], [filter*="#"]'))) {
    collect(el.getAttribute('style') ?? '', ids);
    const attr = el.getAttribute('filter');
    if (attr) collect(`filter:${attr}`, ids);
  }
  const holder = hiddenHolder(root.ownerDocument);
  const state = { added: 0, pending: false };
  for (const id of ids) {
    if (present(root, holder, id)) continue;
    const target = live.getElementById(id);
    if (!target || target.namespaceURI !== SVG_NS || target.localName !== 'filter') continue;
    holder.appendChild(copyOf(live, root.ownerDocument, target, cache, state));
  }
  if (state.added) root.appendChild(holder);
  return state;
}

/**
 * Copy the targets of `<use href="#id">` that are outside the clone (breadth first, so a chain `use -> g > use -> g` copies both; ids already present stop cycles).
 * Runs inside the clone phase: every copied element is handed to `onElement` (the CSS shake token collector), so author rules that style the target (`#link { fill: green }`) are kept.
 * @param {Document} live
 * @param {Element} root  clone root
 * @param {ResourceCache} cache
 * @param {(el: Element) => void} onElement
 * @returns {{added: number, pending: boolean}}
 */
export function addUseTargets(live, root, cache, onElement) {
  /** @type {Element[]} */
  const queue = Array.from(root.querySelectorAll('use'));
  const state = { added: 0, pending: false };
  if (!queue.length) return state;
  const holder = hiddenHolder(root.ownerDocument);
  for (let i = 0; i < queue.length; i++) {
    const id = useTarget(queue[i]);
    if (!id || present(root, holder, id)) continue;
    const target = live.getElementById(id);
    if (!target || target.namespaceURI !== SVG_NS) continue;
    const copy = copyOf(live, root.ownerDocument, target, cache, state);
    holder.appendChild(copy);
    for (const el of [copy, ...Array.from(copy.querySelectorAll('*'))]) {
      onElement(el);
      if (el.localName === 'use') queue.push(el);
    }
  }
  if (state.added) root.appendChild(holder);
  return state;
}

/** @param {Document} doc @returns {Element} zero-size hidden <svg> that holds the copies */
function hiddenHolder(doc) {
  const holder = doc.createElementNS(SVG_NS, 'svg');
  holder.setAttribute('width', '0');
  holder.setAttribute('height', '0');
  setInlineStyle(holder, 'position:absolute;width:0;height:0;overflow:hidden');
  holder.setAttribute('aria-hidden', 'true');
  return holder;
}

/** @param {Element} root @param {Element} holder @param {string} id @returns {boolean} */
function present(root, holder, id) {
  const sel = `[id="${CSS.escape(id)}"]`;
  return !!(root.ownerDocument.getElementById(id) || root.querySelector(sel) || holder.querySelector(sel));
}

/** @param {Element} use @returns {string|null} the fragment id a <use> points at */
function useTarget(use) {
  const href = use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? '';
  return href.startsWith('#') && href.length > 1 ? href.slice(1) : null;
}

/**
 * Deep copy of an out-of-subtree SVG element with its images inlined from the resource cache (unreadable ones removed).
 * @param {Document} live @param {Document} doc @param {Element} target @param {ResourceCache} cache @param {{added: number, pending: boolean}} state
 * @returns {Element}
 */
function copyOf(live, doc, target, cache, state) {
  const copy = /** @type {Element} */ (doc.importNode(target, true));
  for (const image of [copy, ...Array.from(copy.querySelectorAll('image'))]) {
    if (image.localName !== 'image') continue;
    const href = hrefOf(image);
    if (!href || href.startsWith('data:') || href.startsWith('#')) continue;
    const abs = absolute(href, live.baseURI);
    const r = abs ? resolveResource(cache, abs, 'image') : null;
    image.removeAttribute('xlink:href');
    if (r?.state === 'ready') image.setAttribute('href', r.url);
    else { image.removeAttribute('href'); state.pending ||= r?.state === 'pending'; }
  }
  state.added++;
  return copy;
}

/** @param {Element} el @returns {string} */
const hrefOf = (el) => el.getAttribute('href') ?? el.getAttribute('xlink:href') ?? '';

/** @param {string} href @param {string} base @returns {string|null} the absolute URL, null when it does not parse */
function absolute(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

/**
 * A mask reference whose target is outside the drawable: the platform does not draw the masked element (measured on the native oracle; WPT privacy/svg/svg-mask-*), so the clone gets an
 * EMPTY <mask> of that id, which masks everything away. A reference to an id that exists nowhere is left alone (the element is drawn unmasked, as in the page).
 * @param {Document} live
 * @param {Element} root  clone root
 * @param {string} css  the stylesheet text of the clone
 * @returns {number} masks added
 */
export function addOutsideMasks(live, root, css) {
  const marked = root.querySelectorAll('[mask], [style*="#"]');
  if (!marked.length && !/mask[^;{}]*url\(\s*["']?#/i.test(css)) return 0;
  /** @type {Set<string>} */
  const ids = new Set();
  collect(css, ids, MASK_REF);
  for (const el of Array.from(marked)) {
    collect(el.getAttribute('style') ?? '', ids, MASK_REF);
    const attr = el.getAttribute('mask');
    if (attr) collect(`mask:${attr}`, ids, MASK_REF);
  }
  const holder = hiddenHolder(root.ownerDocument);
  for (const id of ids) {
    if (present(root, holder, id) || !live.getElementById(id)) continue;
    const mask = root.ownerDocument.createElementNS(SVG_NS, 'mask');
    mask.setAttribute('id', id);
    holder.appendChild(mask);
  }
  if (holder.firstChild) root.appendChild(holder);
  return holder.childElementCount;
}

/**
 * The feImage elements of the clone (inside the drawable or copied from outside it): a readable image is inlined as a data: URL; one that is still loading is left out until it lands
 * (`pending`); a same-origin image that does not load (404) leaves the primitive empty, the filter still applies; a cross-origin image without CORS, or a URL that does not parse,
 * makes the platform ignore the WHOLE filter (measured on the native oracle; WPT privacy/filtered-*-ignored: the element is drawn unfiltered), so that <filter> is removed from the
 * clone and its references draw unfiltered, as references to a missing filter do.
 * @param {Element} root  clone root
 * @param {string} base  base URL of the live document
 * @param {ResourceCache} cache
 * @returns {{pending: boolean, ignored: Array<{feature: string, message: string, hint?: string, path: string}>}}
 */
export function settleFilterImages(root, base, cache) {
  const out = { pending: false, ignored: /** @type {Array<{feature: string, message: string, hint?: string, path: string}>} */ ([]) };
  for (const image of Array.from(root.querySelectorAll('feImage'))) {
    const href = hrefOf(image);
    if (!href || href.startsWith('data:') || href.startsWith('#')) continue;
    image.removeAttribute('xlink:href');
    image.removeAttribute('href');
    const abs = absolute(href, base);
    const r = abs ? resolveResource(cache, abs, 'image') : null;
    if (r?.state === 'ready') image.setAttribute('href', r.url);
    else if (r?.state === 'pending') out.pending = true;
    else if (!r || r.error.feature === 'cross-origin-resource') {
      const filter = image.closest('filter');
      const id = filter?.getAttribute('id') ?? '';
      filter?.remove();
      out.ignored.push({ feature: r ? r.error.feature : 'resource-fetch-failed', message: `${r ? r.error.message : `invalid feImage URL ${href}`}: filter #${id} is not applied`, hint: r?.error.hint, path: `filter#${id}` });
    }
  }
  return out;
}

/**
 * The mask images of SVG CONTENT (an element inside an <svg>, not the outer <svg> box): Chromium's read-back-allowed rendering ignores a mask image there that it may not read
 * (WPT privacy/svg/svg-mask-on-svg-content-ignored, from Chromium "Disallow SVG masks on SVG content in readback-allowed mode": the element is drawn UNMASKED), while a CSS box with
 * such a mask is masked away (inline-resources.js TRANSPARENT_MASK, WPT privacy/box-mask-*). So when one of its layers is not readable (cross-origin without CORS, failed, or still
 * loading) its mask-image becomes the computed list with that layer `none`; the readable layers are kept as data: URLs. A mask that is entirely readable is left to the stylesheet.
 * @param {Element} src  live element @param {Element} clone @param {CSSStyleDeclaration} cs  computed style of src @param {ResourceCache} cache
 */
export function svgContentMask(src, clone, cs, cache) {
  if (src.namespaceURI !== SVG_NS || src.parentElement?.namespaceURI !== SVG_NS) return;
  const value = cs.maskImage || /** @type {any} */ (cs).webkitMaskImage || 'none';
  if (value === 'none' || !value.includes('url(')) return;
  let unreadable = false;
  const out = value.replace(/url\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g, (/** @type {string} */ whole, /** @type {string} */ raw) => {
    const url = raw.replace(/\\(.)/g, '$1');
    if (url.startsWith('data:') || url.startsWith('#')) return whole;
    const abs = absolute(url, src.ownerDocument.baseURI);
    const r = abs ? resolveResource(cache, abs, 'image') : null;
    if (r?.state === 'ready') return `url("${r.url}")`;
    unreadable = true;
    return 'none';
  });
  if (unreadable) appendInlineStyle(clone, `mask-image:${out}!important;-webkit-mask-image:${out}!important`);
}
