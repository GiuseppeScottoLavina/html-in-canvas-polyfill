/**
 * Scroll synchronisation of the live scrollers (Chromium, docs/ARCHITECTURE.md ADR-E "Scroll").
 *
 * During a precise scroll (trackpad, a wheel without smooth scrolling) of a composited scroller, Chromium's compositor lets impl latency take priority: it draws the
 * scroll at once without waiting for the main frame, and it does not send the next main frame while a committed one waits to be drawn. Content painted by the main
 * thread that follows the scroll offset, as the canvas does, then gets a new offset in every second frame only (measured on Chrome 155 and Canary 158 at 120 Hz: 61
 * scroller updates per second with a canvas drawn per update, 116 without; the same 61 for a plain page that changes any style per scroll event). A scroller with a
 * main-thread repaint reason makes the compositor wait for the main frame instead (tree priority "new content"), which is what the scrollers inside a native drawable
 * get: 116 updates per second. While a live scroller inside a drawable scrolls it carries MARK.SCROLL_ATTR, and a rule of the polyfill sheet gives it such a reason
 * (background-needs-repaint-on-scroll): a transparent inset box-shadow, which keeps the background in the border-box space, and a transparent local-attachment image.
 * Both paint nothing, the layer is invisible, and neither the attribute nor the polyfill sheet reaches a snapshot. The author's own values are kept in the rule.
 * Module: live (src/live/*).
 */

import { MARK } from '../contracts/events.js';
import { currentEngine } from '../util/engine.js';

/** @typedef {import('../contracts/types.js').GeometryRules} GeometryRules */
/** @typedef {{boxShadow: string, backgroundImage: string, backgroundAttachment: string}} ScrollAuthorStyle */

const SYNC_SHADOW = 'inset 0 0 0 0 transparent';
const SYNC_IMAGE = 'linear-gradient(transparent, transparent)';
/** form controls scroll their own text: their look must stay readable by the text overlay (capture/text-overlay.js reads the field's box-shadow) */
const SKIP = new Set(['input', 'textarea', 'select']);

/** @param {string} v a computed list value @returns {string[]} its top-level comma-separated items */
export function splitList(v) {
  /** @type {string[]} */
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { out.push(v.slice(start, i).trim()); start = i + 1; }
  }
  out.push(v.slice(start).trim());
  return out.filter(Boolean);
}

/**
 * PURE. The declarations that give a scroller with these computed values a main-thread repaint reason, keeping what the author wrote; null when it already has one
 * (an inset shadow and a local-attachment image of its own).
 * @param {ScrollAuthorStyle} cs
 * @returns {Record<string, string>|null}
 */
export function syncDeclarations(cs) {
  const inset = / inset/.test(` ${cs.boxShadow}`);
  const images = cs.backgroundImage && cs.backgroundImage !== 'none' ? splitList(cs.backgroundImage) : [];
  const attachments = splitList(cs.backgroundAttachment || 'scroll');
  const at = (/** @type {number} */ i) => attachments[i % attachments.length] ?? 'scroll';
  const local = images.some((img, i) => img !== 'none' && at(i) === 'local');
  if (inset && local) return null;
  /** @type {Record<string, string>} */
  const decl = {};
  if (!inset) decl['box-shadow'] = !cs.boxShadow || cs.boxShadow === 'none' ? SYNC_SHADOW : `${cs.boxShadow}, ${SYNC_SHADOW}`;
  if (!local) {
    decl['background-image'] = [...images, SYNC_IMAGE].join(', ');
    decl['background-attachment'] = [...images.map((_, i) => at(i)), 'local'].join(', ');
  }
  return decl;
}

/**
 * @param {Document|ShadowRoot} root  tree scope of the layer: a scroller in another scope (an author shadow root) is left alone
 * @param {() => GeometryRules|null} rules  the scroll rules of that root's polyfill sheet (null while unmounted)
 * @returns {{mark: (el: Element) => void, unmark: (el: Element) => void, author: (el: Element) => ScrollAuthorStyle|null, clear: () => void}}
 */
export function createScrollSync(root, rules) {
  /** @type {Map<Element, {key: string|null, author: ScrollAuthorStyle}>} */
  const marked = new Map();
  let seq = 0;

  /** @param {Element} el */
  function unmark(el) {
    const m = marked.get(el);
    if (!m) return;
    marked.delete(el);
    if (m.key === null) return;
    rules()?.remove(m.key);
    if (el.getAttribute(MARK.SCROLL_ATTR) === m.key) el.removeAttribute(MARK.SCROLL_ATTR);
  }

  return {
    mark(el) {
      if (marked.has(el) || SKIP.has(el.localName) || currentEngine().engine !== 'chromium' || el.getRootNode() !== root) return;
      const r = rules();
      const view = el.ownerDocument.defaultView;
      if (!r || !view) return;
      const cs = view.getComputedStyle(el);
      const author = { boxShadow: cs.boxShadow, backgroundImage: cs.backgroundImage, backgroundAttachment: cs.backgroundAttachment };
      const decl = syncDeclarations(author);
      const key = decl ? `s${++seq}` : null;
      marked.set(el, { key, author });
      if (!key || !decl) return;
      r.set(key, decl);
      el.setAttribute(MARK.SCROLL_ATTR, key);
    },
    unmark,
    author: (el) => (marked.get(el)?.key ? /** @type {{author: ScrollAuthorStyle}} */ (marked.get(el)).author : null),
    clear() {
      for (const el of [...marked.keys()]) unmark(el);
    },
  };
}
