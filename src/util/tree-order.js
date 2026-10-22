/**
 * Shadow-including tree order (DOM standard): a shadow root comes right after its host and before the host's children. `compareDocumentPosition` cannot order nodes of
 * different trees (a canvas in a shadow root against one in the light DOM): it answers DISCONNECTED with an arbitrary order. The paint events of canvases fire in reverse
 * shadow-including tree order (WPT onpaint-post-tree-order-shadow-dom).
 */

/** @param {Node} node @returns {Node[]} the shadow-including ancestors of `node` and `node`, root first */
function chain(node) {
  /** @type {Node[]} */
  const out = [];
  for (let cur = /** @type {Node|null} */ (node); cur; cur = cur.parentNode ?? /** @type {ShadowRoot} */ (cur).host ?? null) out.push(cur);
  return out.reverse();
}

/**
 * Comparator: negative when `a` precedes `b` in shadow-including tree order.
 * @param {Node} a @param {Node} b @returns {number}
 */
export function shadowIncludingOrder(a, b) {
  if (a === b) return 0;
  const ca = chain(a);
  const cb = chain(b);
  let i = 0;
  while (i < ca.length && i < cb.length && ca[i] === cb[i]) i++;
  if (i === 0) return a.compareDocumentPosition(b) & 4 ? -1 : 1;
  if (i === ca.length) return -1;
  if (i === cb.length) return 1;
  const x = ca[i];
  const y = cb[i];
  if (x.nodeType === 11) return -1;
  if (y.nodeType === 11) return 1;
  return x.compareDocumentPosition(y) & 4 ? -1 : 1;
}
