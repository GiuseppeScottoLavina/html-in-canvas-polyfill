/**
 * `filter: url(#id)` that names an SVG <filter> OUTSIDE the drawable: the clone is a separate SVG image document that has no such element, so the filter was dropped (WPT css-filter-reference-on-div).
 * The referenced <filter> and <clipPath> elements are copied into the clone as a zero-size hidden <svg>, and so are the targets of `<use href="#id">` (chains included): Chrome draws a <use> whose
 * target is outside the drawable (WPT privacy/svg/svg-use-*: the same-origin image of the target draws, the cross-origin one does not), and applies an outside clip path. Markers and paint
 * servers outside the subtree are NOT copied, and are removed from the copies: the platform ignores them for privacy (WPT privacy/svg/*). A mask outside the subtree masks its element away
 * entirely (measured on the native oracle: the element is not drawn), so it becomes an empty <mask> of the same id. Images of a copy (`<image href>`) go through the resource cache like every
 * other image: readable ones are inlined, the others (cross-origin without CORS, 404) are removed, as the platform ignores them. The feImage of every filter of the clone (copied or inside the
 * drawable) is settled by settleFilterImages.
 * A <use> of an EXTERNAL document (`href="icons.svg#a"`, or the whole document without a fragment) cannot load inside the SVG image either: a same-origin document is fetched
 * through the resource cache and its target copied in like an outside target, every reference inside it resolved against that document (addUseTargets); a cross-origin one draws nothing,
 * as the platform never loads a cross-origin <use> (WHATWG HTML PR 12554, read-back-allowed rendering: "SVG elements (e.g., use, pattern, feImage)" that refer to CORS-cross-origin content
 * are invisible; WPT privacy/svg/svg-use-ignored).
 * Module: snapshot-capture (src/snapshot/capture/*).
 */

import { resolveResource } from './inline-resources.js';
import { appendInlineStyle, setInlineStyle } from './inline-style.js';

/** @typedef {import('../../contracts/types.js').ResourceCache} ResourceCache */

const SVG_NS = 'http://www.w3.org/2000/svg';
/** `filter: url(#id)` and `clip-path: url(#id)` in CSS text, and the attributes written as `filter:` / `clip-path:` by the caller. */
const FILTER_REF = /(?:filter|clip-path)\s*[:=]\s*["']?[^;"'}]*?url\(\s*["']?#([^"')\s]+)/gi;
/** `mask: url(#id)`, `mask-image` (also -webkit-) in CSS text, and the `mask` attribute written as `mask:` by the caller. */
const MASK_REF = /mask(?:-image)?\s*[:=]\s*["']?[^;"'}]*?url\(\s*["']?#([^"')\s]+)/gi;

/** @param {string} text @param {Set<string>} ids @param {RegExp} [re] */
function collect(text, ids, re = FILTER_REF) {
  for (const m of text.matchAll(re)) ids.add(m[1]);
}

/**
 * Copy the filters and clip paths that the clone refers to by fragment but does not contain (the native oracle applies a clip path outside the drawable, as it does a filter).
 * @param {Document} live
 * @param {Element} root  clone root
 * @param {string} css  the stylesheet text of the clone
 * @param {ResourceCache} cache  feImage images are inlined as data: URLs from it (same-origin and CORS images draw, the others are dropped)
 * @returns {{added: number, pending: boolean}} elements added, and whether an image of a filter is still loading
 */
export function addReferencedDefs(live, root, css, cache) {
  const none = { added: 0, pending: false };
  const sel = '[style*="#"], [filter*="#"], [clip-path*="#"]';
  if (!/url\(\s*["']?#/i.test(css) && !root.querySelector(sel)) return none;
  /** @type {Set<string>} */
  const ids = new Set();
  collect(css, ids);
  for (const el of Array.from(root.querySelectorAll(sel))) {
    collect(el.getAttribute('style') ?? '', ids);
    for (const name of ['filter', 'clip-path']) {
      const attr = el.getAttribute(name);
      if (attr) collect(`${name}:${attr}`, ids);
    }
  }
  const holder = hiddenHolder(root.ownerDocument);
  const state = { added: 0, pending: false };
  for (const id of ids) {
    if (present(root, holder, id)) continue;
    const target = live.getElementById(id);
    if (!target || target.namespaceURI !== SVG_NS || (target.localName !== 'filter' && target.localName !== 'clipPath')) continue;
    holder.appendChild(copyOf(live, root.ownerDocument, target, cache, state));
  }
  if (state.added) root.appendChild(holder);
  return state;
}

/**
 * Copy the targets of `<use href="#id">` that are outside the clone (breadth first, so a chain `use -> g > use -> g` copies both; ids already present stop cycles).
 * Runs inside the clone phase: every copied page element is handed to `onElement` (the CSS shake token collector), so author rules that style the target (`#link { fill: green }`) are kept.
 * A copy follows the read-back rules of the native oracle (Chrome Canary 158): the paint servers and markers of a copy are outside the drawable, so they are ignored (the paint
 * falls back to its fallback colour, or none) and its masks mask their element away; its clip paths and filters apply.
 * The elements of an EXTERNAL document refer to that document only: their ids and classes get the prefix `hic-u<n>-` of their document (so neither the page's references nor its
 * class and id rules reach them, and theirs never reach the page), every `#id` reference inside them is rebased the same way and its element copied from the same document, and the
 * document's own <style> rules are returned as `css`, rewritten to those names and held to its elements (the page's rules do not apply to an external <use>, the document's do;
 * its @media rules do not apply: measured on the native oracle and in the page).
 * @param {Document} live
 * @param {Element} root  clone root
 * @param {ResourceCache} cache
 * @param {(el: Element) => void} onElement
 * @returns {{added: number, pending: boolean, css: string}}
 */
export function addUseTargets(live, root, cache, onElement) {
  /** @type {Element[]} */
  const queue = Array.from(root.querySelectorAll('use'));
  const state = { added: 0, pending: false, css: '' };
  if (!queue.length) return state;
  const holder = hiddenHolder(root.ownerDocument);
  /** @type {Map<string, ExtDoc|null>} external document URL -> its parsed document (null: never read, nothing to draw) */
  const docs = new Map();
  /** @type {ExtDoc[]} */
  const byIndex = [];
  /** @param {ExtDoc} d @param {Element} target @returns {string} id of the target's copy */
  const ensure = (d, target) => {
    const id = target.id ? `hic-u${d.n}-${target.id}` : `hic-u${d.n}`;
    if (present(root, holder, id)) return id;
    const copy = copyOf(live, root.ownerDocument, target, cache, state, d.url);
    /** @type {Set<string>} */
    const refs = new Set();
    settleCopy(copy, d, refs);
    copy.setAttribute('id', id);
    holder.appendChild(copy);
    queue.push(...(copy.localName === 'use' ? [copy] : []), ...Array.from(copy.querySelectorAll('use')));
    for (const ref of refs) {
      const el = d.doc.getElementById(ref);
      if (el && !PAINT.has(el.localName)) ensure(d, el);
    }
    return id;
  };
  for (let i = 0; i < queue.length; i++) {
    const use = queue[i];
    const href = hrefOf(use);
    if (!href || href.startsWith('data:')) continue;
    if (!href.startsWith('#')) {
      const abs = absolute(href, live.baseURI);
      const url = abs ? new URL(abs) : null;
      if (url) url.hash = '';
      const key = url?.href ?? href;
      let d = docs.get(key);
      if (d === undefined) {
        const doc = url ? externalDoc(live, url.href, cache, state) : null;
        d = doc ? { n: byIndex.length, url: key, doc } : null;
        docs.set(key, d);
        if (d) { byIndex.push(d); state.css += documentCss(d, (ref) => { const el = d?.doc.getElementById(ref); if (d && el && !PAINT.has(el.localName)) ensure(d, el); }); }
      }
      const fragment = abs ? decodeURIComponent(new URL(abs).hash.slice(1)) : '';
      const target = d ? (fragment ? d.doc.getElementById(fragment) : d.doc.documentElement) : null;
      use.removeAttribute('xlink:href');
      if (d && target && target.namespaceURI === SVG_NS) use.setAttribute('href', `#${ensure(d, target)}`);
      else use.removeAttribute('href');
      continue;
    }
    const id = href.slice(1);
    if (!id || present(root, holder, id)) continue;
    const own = /^hic-u(\d+)-(.+)$/.exec(id);
    const d = own ? byIndex[Number(own[1])] : null;
    if (d) {
      const target = d.doc.getElementById(own?.[2] ?? '');
      if (target && target.namespaceURI === SVG_NS) ensure(d, target);
      continue;
    }
    const target = live.getElementById(id);
    if (!target || target.namespaceURI !== SVG_NS) continue;
    const copy = copyOf(live, root.ownerDocument, target, cache, state);
    settleCopy(copy, null, new Set());
    holder.appendChild(copy);
    for (const el of [copy, ...Array.from(copy.querySelectorAll('*'))]) {
      onElement(el);
      if (el.localName === 'use') queue.push(el);
    }
  }
  if (state.added) root.appendChild(holder);
  return state;
}

/** @typedef {{n: number, url: string, doc: Document}} ExtDoc */

/** Paint servers and markers: the platform ignores them outside the drawable (WPT privacy/svg/*). */
const PAINT = new Set(['linearGradient', 'radialGradient', 'pattern', 'marker']);
/** `url(#id)` in an attribute or a declaration */
const URL_REF = /url\(\s*(["']?)#([^"')\s]+)\1\s*\)/g;

/**
 * Apply the read-back rules to a copy of an element outside the drawable: its paint servers and markers are removed (their references then fall back, as on the native oracle),
 * its masks are emptied (they mask their element away). In a copy of an external document `ext`, every id and class gets the document's prefix (plus the class `hic-u<n>`),
 * `<style>` elements are removed (documentCss scopes them), every `url(#id)` and `href="#id"` points to the prefixed id (the ids are added to `refs` so their elements are
 * copied too), and a <use> of another document gets an absolute URL.
 * @param {Element} copy @param {ExtDoc|null} ext @param {Set<string>} refs
 */
function settleCopy(copy, ext, refs) {
  for (const el of [copy, ...Array.from(copy.querySelectorAll('*'))]) {
    if (PAINT.has(el.localName) || (ext && el.localName === 'style')) { el.remove(); continue; }
    if (el.localName === 'mask') el.replaceChildren();
    if (!ext) continue;
    const p = `hic-u${ext.n}-`;
    if (el.id) el.id = p + el.id;
    const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    el.setAttribute('class', [...cls.map((c) => p + c), `hic-u${ext.n}`].join(' '));
    for (const a of Array.from(el.attributes)) {
      if (a.value.includes('url(')) el.setAttribute(a.name, rebaseUrls(a.value, p, refs));
    }
    const href = hrefOf(el);
    if (!href || href.startsWith('data:')) continue;
    el.removeAttribute('xlink:href');
    if (href.startsWith('#')) { refs.add(href.slice(1)); el.setAttribute('href', `#${p}${href.slice(1)}`); }
    else el.setAttribute('href', absolute(href, ext.url) ?? '');
  }
}

/** @param {string} text @param {string} prefix @param {Set<string>} refs @returns {string} text with every `url(#id)` pointing to `#<prefix><id>` (ids added to refs) */
function rebaseUrls(text, prefix, refs) {
  return text.replace(URL_REF, (_m, _q, id) => { refs.add(id); return `url("#${prefix}${id}")`; });
}

/**
 * The <style> rules of an external document as they apply to its copies: each selector's ids and classes prefixed as settleCopy renames them, the subject held to the
 * document's elements (`:is(selector):where(.hic-u<n>)`), every `url(#id)` rebased (`onRef` copies its element). Grouping rules (@media and the like) are left out.
 * @param {ExtDoc} d @param {(id: string) => void} onRef @returns {string}
 */
function documentCss(d, onRef) {
  const text = Array.from(d.doc.getElementsByTagNameNS(SVG_NS, 'style'), (s) => s.textContent ?? '').join('\n');
  if (!text.trim()) return '';
  const sheet = new CSSStyleSheet();
  try { sheet.replaceSync(text); } catch { return ''; }
  const p = `hic-u${d.n}-`;
  /** @type {Set<string>} */
  const refs = new Set();
  let out = '';
  for (const rule of Array.from(sheet.cssRules)) {
    if (!(rule instanceof CSSStyleRule)) continue;
    const sel = rule.selectorText.replace(/\[[^\]]*\]|"[^"]*"|'[^']*'|([.#])(-?[_a-zA-Z\u00a0-\uffff][-\w\u00a0-\uffff]*)/g, (m, sig, name) => (sig ? `${sig}${p}${name}` : m));
    out += `:is(${sel}):where(.hic-u${d.n}){${rebaseUrls(rule.style.cssText, p, refs)}}`;
  }
  for (const id of refs) onRef(id);
  return out;
}

/**
 * A SAME-ORIGIN SVG document an external <use> refers to, parsed. A cross-origin document is never read (the platform does not load it); one still loading sets state.pending;
 * one that fails to load or parse gives null (its <use> elements draw nothing).
 * @param {Document} live @param {string} url  without fragment @param {ResourceCache} cache @param {{pending: boolean}} state
 * @returns {Document|null}
 */
function externalDoc(live, url, cache, state) {
  if (new URL(url).origin !== (live.location?.origin ?? new URL(live.URL).origin)) return null;
  const r = resolveResource(cache, url, 'svg');
  if (r.state === 'pending') state.pending = true;
  if (r.state !== 'ready') return null;
  const parsed = new DOMParser().parseFromString(textOfDataUrl(r.url), 'image/svg+xml');
  return parsed.querySelector('parsererror') ? null : parsed;
}

/** @param {string} dataUrl @returns {string} the text a data: URL carries */
function textOfDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const body = dataUrl.slice(comma + 1);
  if (!dataUrl.slice(0, comma).includes(';base64')) return decodeURIComponent(body);
  return new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0)));
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

/**
 * Deep copy of an out-of-subtree SVG element with its images inlined from the resource cache (unreadable ones removed).
 * @param {Document} live @param {Document} doc @param {Element} target @param {ResourceCache} cache @param {{added: number, pending: boolean}} state
 * @param {string} [base]  base URL of the target's document (the live document's by default)
 * @returns {Element}
 */
function copyOf(live, doc, target, cache, state, base = live.baseURI) {
  const copy = /** @type {Element} */ (doc.importNode(target, true));
  for (const image of [copy, ...Array.from(copy.querySelectorAll('image'))]) {
    if (image.localName !== 'image') continue;
    const href = hrefOf(image);
    if (!href || href.startsWith('data:') || href.startsWith('#')) continue;
    const abs = absolute(href, base);
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
