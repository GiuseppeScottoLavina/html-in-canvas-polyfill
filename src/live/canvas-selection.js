/**
 * Word selection by double click on the canvas itself (feature selection-through-canvas).
 * Natively the children of a `content=drawable` canvas are in the canvas's layout, so a double click that hits the canvas (not a drawn child) selects the word of the canvas
 * subtree nearest to the point (WPT hit-test/selection). Here the children live in the layer, so the canvas hit has no text under it: the default action of the trusted `dblclick`
 * is reproduced on the live text of the layer. A double click on a drawn child needs nothing: it hits the live child, which selects natively.
 * Not reproduced: triple click (paragraph) and drag selection that starts on the bare canvas.
 * Module: live (src/live/*).
 */

const MAX_TEXT_NODES = 4000;

/**
 * @param {Text} text @returns {DOMRect[]} the line boxes of a text node
 */
function lineRects(text) {
  const range = text.ownerDocument.createRange();
  range.selectNodeContents(text);
  return Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
}

/** @param {DOMRect} r @param {number} x @param {number} y @returns {number} squared distance from the point to the rect */
function distance2(r, x, y) {
  const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
  const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
  return dx * dx + dy * dy;
}

/**
 * The caret position of the live layer text nearest to a viewport point (the point is clamped into the nearest line box first).
 * @param {Element} layerEl
 * @param {number} x
 * @param {number} y
 * @returns {{node: Text, offset: number}|null}
 */
export function nearestTextPosition(layerEl, x, y) {
  const doc = layerEl.ownerDocument;
  const walker = doc.createTreeWalker(layerEl, NodeFilter.SHOW_TEXT);
  /** @type {{text: Text, rect: DOMRect, d: number}|null} */
  let best = null;
  let n = 0;
  for (let t = /** @type {Text|null} */ (walker.nextNode()); t && n < MAX_TEXT_NODES; t = /** @type {Text|null} */ (walker.nextNode()), n++) {
    if (!/\S/.test(t.data)) continue;
    for (const rect of lineRects(t)) {
      const d = distance2(rect, x, y);
      if (!best || d < best.d) best = { text: t, rect, d };
    }
  }
  if (!best) return null;
  const { text, rect } = best;
  const px = Math.min(Math.max(x, rect.left + 0.5), rect.right - 0.5);
  const py = rect.top + rect.height / 2;
  const d = /** @type {any} */ (doc);
  const pos = typeof d.caretPositionFromPoint === 'function' ? d.caretPositionFromPoint(px, py) : null;
  if (pos && pos.offsetNode === text) return { node: text, offset: pos.offset };
  const range = typeof d.caretRangeFromPoint === 'function' ? d.caretRangeFromPoint(px, py) : null;
  if (range && range.startContainer === text) return { node: text, offset: range.startOffset };
  return { node: text, offset: x >= rect.right ? text.data.length : 0 };
}

/**
 * The word boundaries around `offset` (Intl.Segmenter; a position between a word and a space takes the word before it, as at the end of a line).
 * @param {string} data @param {number} offset @returns {{start: number, end: number}}
 */
export function wordAt(data, offset) {
  const Seg = /** @type {any} */ (Intl).Segmenter;
  /** @type {{segment: string, index: number, isWordLike?: boolean}[]} */
  const segments = Seg ? Array.from(new Seg(undefined, { granularity: 'word' }).segment(data)) : data.split(/(\s+)/).reduce((/** @type {any[]} */ acc, s) => {
    const index = acc.length ? acc[acc.length - 1].index + acc[acc.length - 1].segment.length : 0;
    acc.push({ segment: s, index, isWordLike: /\S/.test(s) });
    return acc;
  }, []);
  const words = segments.filter((s) => s.isWordLike);
  const hit = words.find((s) => offset >= s.index && offset < s.index + s.segment.length)
    ?? words.find((s) => offset === s.index + s.segment.length)
    ?? segments.find((s) => offset >= s.index && offset < s.index + s.segment.length)
    ?? segments[segments.length - 1];
  return hit ? { start: hit.index, end: hit.index + hit.segment.length } : { start: offset, end: offset };
}

/**
 * Select the word of the layer text nearest to a viewport point. Returns false when there is no text or selection is disabled there.
 * @param {Element} layerEl @param {number} x @param {number} y @returns {boolean}
 */
export function selectWordNear(layerEl, x, y) {
  const pos = nearestTextPosition(layerEl, x, y);
  if (!pos) return false;
  const view = layerEl.ownerDocument.defaultView;
  const parent = pos.node.parentElement;
  if (!view || !parent || view.getComputedStyle(parent).userSelect === 'none') return false;
  const { start, end } = wordAt(pos.node.data, pos.offset);
  view.getSelection()?.setBaseAndExtent(pos.node, start, pos.node, end);
  return true;
}

/**
 * Listen for trusted double clicks that hit the canvas itself. A `preventDefault()` on the mousedown or the dblclick and `user-select: none` on the canvas cancel it, as natively.
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} layerEl
 * @returns {() => void} remover
 */
export function installCanvasSelection(canvas, layerEl) {
  const view = canvas.ownerDocument.defaultView;
  if (!view) return () => {};
  const add = view.EventTarget.prototype.addEventListener;
  const remove = view.EventTarget.prototype.removeEventListener;
  let downPrevented = false;
  // Window bubble phase: runs after the author's canvas / document listeners of the same mousedown.
  const onDown = (/** @type {Event} */ ev) => { if (ev.target === canvas) downPrevented = ev.defaultPrevented; };
  const onDouble = (/** @type {Event} */ e) => {
    const ev = /** @type {MouseEvent} */ (e);
    if (ev.target !== canvas || !ev.isTrusted || ev.button !== 0 || ev.defaultPrevented || downPrevented) return;
    if (view.getComputedStyle(canvas).userSelect === 'none') return;
    selectWordNear(layerEl, ev.clientX, ev.clientY);
  };
  add.call(view, 'mousedown', onDown);
  add.call(view, 'dblclick', onDouble);
  return () => {
    remove.call(view, 'mousedown', onDown);
    remove.call(view, 'dblclick', onDouble);
  };
}
