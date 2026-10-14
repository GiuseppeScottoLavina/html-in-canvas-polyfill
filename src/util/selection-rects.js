/**
 * Where a page text selection (labels, paragraphs, headings) is drawn inside one drawable. Shared by the capture, which paints the highlight into the tile,
 * and the input observer, which damages the old and the new highlight when the selection changes: both must agree on the same rectangles.
 */

/** @typedef {import('../contracts/types.js').Rect} Rect */

/**
 * The line boxes of `range` that overlap `scope`, in the border-box frame of `scope` (origin = its border box top-left, css px; a scaled ancestor is divided out).
 * @param {Range} range
 * @param {Element} scope  the drawable
 * @param {Rect} frame  the border box of `scope` in its own frame ({x: 0, y: 0, width, height})
 * @param {DOMRectList} [clientRects]  range.getClientRects(), when the caller already has them (one read for several drawables)
 * @returns {Rect[]}
 */
export function rangeRectsIn(range, scope, frame, clientRects) {
  if (!range.intersectsNode(scope)) return [];
  const sr = scope.getBoundingClientRect();
  const k = frame.width > 0 && sr.width > 0 ? sr.width / frame.width : 1;
  /** @type {Rect[]} */
  const out = [];
  for (const r of clientRects ?? range.getClientRects()) {
    if (r.width < 0.5 || r.height < 0.5 || r.right < sr.left || r.left > sr.right || r.bottom < sr.top || r.top > sr.bottom) continue;
    out.push({ x: frame.x + (r.left - sr.left) / k, y: frame.y + (r.top - sr.top) / k, width: r.width / k, height: r.height / k });
  }
  return out;
}
