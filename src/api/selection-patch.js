/**
 * A selection or range over the children of a managed canvas (`getSelection().selectAllChildren(canvas)`, `range.selectNodeContents(canvas)`).
 * Module: api-core.
 *
 * The children of a `content=drawable` canvas live in its layer, so in the document tree the canvas has no child: a selection of its children would be collapsed
 * on the canvas and select nothing, while natively it selects the whole subtree (WPT privacy/visited-link/visited-link-custom-selection-color-ignored). The two
 * methods that take "the children of a node" select the children of the layer instead: the same nodes, in the same order. Offsets of the other methods (setStart,
 * collapse, ...) are left alone: a boundary point (canvas, n) has no child list to count in. The selection's boundary nodes are then the layer element.
 */

/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').PatchLedger} PatchLedger */

/**
 * @param {HicEnv} env
 * @param {PatchLedger} ledger
 */
export function installSelectionPatches(env, ledger) {
  const win = /** @type {any} */ (env.window);
  /**
   * The layer of a managed canvas whose children live there (else the node itself). A selection's drawables are damaged at once: the selectionchange event that the
   * input observer listens to comes a task later, after the paint of this rendering update may have used the unselected snapshot.
   * @param {unknown} node @param {boolean} selects  the page selection changes (not a detached Range) @returns {unknown}
   */
  const children = (node, selects) => {
    if (!(node instanceof win.HTMLCanvasElement)) return node;
    const record = env.registry.get(/** @type {HTMLCanvasElement} */ (node));
    const layer = record?.layer;
    if (!record || !layer?.isMounted()) return node;
    if (selects) queueMicrotask(() => env.scheduler.damage(record, 'selection', null, null));
    return layer.element;
  };
  if (typeof win.Selection?.prototype?.selectAllChildren === 'function') {
    ledger.wrap(win.Selection.prototype, 'selectAllChildren', (original) => /** @this {Selection} */ function (/** @type {unknown[]} */ ...args) {
      if (args.length) args[0] = children(args[0], true);
      return original.apply(this, args);
    });
  }
  if (typeof win.Range?.prototype?.selectNodeContents === 'function') {
    ledger.wrap(win.Range.prototype, 'selectNodeContents', (original) => /** @this {Range} */ function (/** @type {unknown[]} */ ...args) {
      if (args.length) args[0] = children(args[0], false);
      return original.apply(this, args);
    });
  }
}
