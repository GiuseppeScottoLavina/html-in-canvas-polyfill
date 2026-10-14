/**
 * `filter: url(#id)` that names an SVG <filter> OUTSIDE the drawable: the clone is a separate SVG image document that has no such element, so the filter was dropped (WPT css-filter-reference-on-div).
 * The referenced <filter> elements are copied into the clone as a zero-size hidden <svg>, and so are the targets of `<use href="#id">` (chains included): Chrome draws a <use> whose target is outside
 * the drawable (WPT privacy/svg/svg-use-*: the same-origin image of the target draws, the cross-origin one does not). Masks, markers and paint servers outside the subtree are NOT copied:
 * the platform ignores them for privacy (WPT privacy/svg/*). Images of a copy (feImage / image href) go through the resource cache like every other image: readable ones are inlined, the others
 * (cross-origin without CORS, 404) are removed, as the platform ignores them.
 * Module: snapshot-capture (src/snapshot/capture/*).
 */

import { resolveResource } from './inline-resources.js';

/** @typedef {import('../../contracts/types.js').ResourceCache} ResourceCache */

const SVG_NS = 'http://www.w3.org/2000/svg';
const FILTER_REF = /filter\s*[:=]\s*["']?[^;"'}]*?url\(\s*["']?#([^"')\s]+)/gi;

/** @param {string} text @param {Set<string>} ids */
function collect(text, ids) {
  for (const m of text.matchAll(FILTER_REF)) ids.add(m[1]);
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
  holder.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
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
  for (const image of [copy, ...Array.from(copy.querySelectorAll('feImage, image'))]) {
    if (image.localName !== 'feImage' && image.localName !== 'image') continue;
    const href = image.getAttribute('href') ?? image.getAttribute('xlink:href') ?? '';
    if (!href || href.startsWith('data:') || href.startsWith('#')) continue;
    const r = resolveResource(cache, new URL(href, live.baseURI).href, 'image');
    image.removeAttribute('xlink:href');
    if (r.state === 'ready') image.setAttribute('href', r.url);
    else { image.removeAttribute('href'); state.pending ||= r.state === 'pending'; }
  }
  state.added++;
  return copy;
}
