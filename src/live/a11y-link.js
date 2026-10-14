/**
 * Accessibility parentage: the canvas aria-owns its top-level logical children (docs/ARCHITECTURE.md ADR-M).
 * Module: live (src/live/*).
 */

import { MARK } from '../contracts/events.js';

/** @typedef {import('../contracts/types.js').CanvasRecord} CanvasRecord */

/**
 * @typedef {Object} A11yLink
 * @property {(topLevel: Element[]) => void} update  give every top-level logical child an id (MARK.OWNS_ID_PREFIX + n) when it has none and rewrite the canvas aria-owns = author tokens + these ids
 * @property {() => string|null} authorValue  the aria-owns value the author set (null: none), for clones of the canvas
 * @property {() => void} dispose  restore the author's aria-owns attribute (or remove it) and remove generated ids
 */

const OWNS = 'aria-owns';
/** Children that never reach the accessibility tree. */
const INERT_TAGS = new Set(['script', 'style', 'template', 'link', 'meta', 'noscript', 'base', 'title']);

/** @param {string|null|undefined} value @returns {string[]} */
const tokens = (value) => (value ?? '').split(/\s+/).filter(Boolean);

/**
 * The layer itself gets role="presentation". Probe: aria-owns the LAYER keeps parentage but the children lose their listitem roles, aria-owns the CHILDREN resolves them (measured on Chrome 154).
 * aria-owns writes are filtered out of the mutation observers (own write).
 * @param {CanvasRecord} record
 * @param {HTMLElement} layerEl
 * @returns {A11yLink}
 */
export function createA11yLink(record, layerEl) {
  const canvas = record.canvas;
  /** @type {string|null} */
  let author = canvas.getAttribute(OWNS);
  /** @type {string|null} */
  let lastWritten = author;
  /** @type {Map<Element, string>} generated ids */
  const generated = new Map();
  /** @type {Element[]} */
  let owned = [];
  let counter = 0;

  /** @param {Element} el @returns {string} */
  function ensureId(el) {
    if (el.id) return el.id;
    const root = /** @type {Document|ShadowRoot} */ (layerEl.getRootNode());
    const scope = typeof root.getElementById === 'function' ? root : layerEl.ownerDocument;
    let id;
    do { id = `${MARK.OWNS_ID_PREFIX}${record.id}-${++counter}`; } while (scope.getElementById(id));
    el.id = id;
    generated.set(el, id);
    return id;
  }

  function releaseGenerated(/** @type {Set<Element>} */ keep) {
    for (const [el, id] of [...generated]) {
      if (keep.has(el)) continue;
      generated.delete(el);
      if (el.getAttribute('id') === id) el.removeAttribute('id');
    }
  }

  function write() {
    const ids = owned.map(ensureId);
    const merged = [...tokens(author), ...ids.filter((id) => !tokens(author).includes(id))];
    const next = merged.length ? merged.join(' ') : null;
    lastWritten = next;
    if (next === null) canvas.removeAttribute(OWNS);
    else if (canvas.getAttribute(OWNS) !== next) canvas.setAttribute(OWNS, next);
    observer.takeRecords();
  }

  let deferred = false;
  let disposed = false;
  /**
   * While the document is still loading, the link (aria-owns on the canvas, generated ids on id-less children) is written after `load` + one task: a server-rendered page hydrates
   * before that (React hydrateRoot reported the polyfill's attributes as a hydration mismatch). The accessibility tree only misses the
   * list structure during page load.
   */
  function scheduleWrite() {
    const doc = canvas.ownerDocument;
    const win = doc.defaultView;
    if (doc.readyState === 'complete' || !win) { write(); return; }
    if (deferred) return;
    deferred = true;
    win.addEventListener('load', () => win.setTimeout(() => { deferred = false; if (!disposed) write(); }, 0), { once: true });
  }

  const observer = new MutationObserver(() => {
    const now = canvas.getAttribute(OWNS);
    if (now === lastWritten) return;
    author = now;
    scheduleWrite();
  });
  observer.observe(canvas, { attributes: true, attributeFilter: [OWNS] });

  return {
    update(topLevel) {
      owned = topLevel.filter((el) => !INERT_TAGS.has(el.localName) && !el.hasAttribute(MARK.NODE_ATTR));
      releaseGenerated(new Set(owned));
      scheduleWrite();
    },
    authorValue: () => author,
    dispose() {
      disposed = true;
      observer.disconnect();
      releaseGenerated(new Set());
      if (author === null) canvas.removeAttribute(OWNS);
      else canvas.setAttribute(OWNS, author);
    },
  };
}
