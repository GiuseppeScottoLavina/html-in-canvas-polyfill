/**
 * Element.prototype.checkVisibility for the children of a managed canvas. Natively they are descendants of the canvas and are drawn, so the opacity check
 * (`opacityProperty`, or its old name `checkOpacity`) reports them visible unless they, the canvas or an ancestor of the canvas has opacity 0. Here they live in
 * the layer, whose own opacity is 0 on Chromium and WebKit (layer-style.js), so the platform reported every one of them hidden (libraries that skip elements
 * checkVisibility reports hidden then skipped all the drawn content). The opacity part of the check is redone along the native chain instead: the element and its
 * flat-tree ancestors up to the layer, then the canvas and its ancestors; the layer itself is skipped. Every other part of the check is the platform's own.
 * Module: live (src/live/*).
 */

import { isLayerElement, nativeDom } from './drawables.js';

/** @typedef {import('../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').PatchLedger} PatchLedger */

/**
 * The flat-tree parent: the assigned slot of a slotted node, the host of a shadow root, else the parent node (read with the platform getter: the tree facade
 * reports the canvas as the parent of a relocated child).
 * @param {Node} node
 * @returns {Node|null}
 */
function flatParent(node) {
  const slot = /** @type {Element} */ (node).assignedSlot;
  if (slot) return slot;
  const parent = nativeDom().parentNode.call(node);
  return parent && parent.nodeType === 11 && /** @type {ShadowRoot} */ (parent).host ? /** @type {ShadowRoot} */ (parent).host : parent;
}

/**
 * @param {HicEnv} env
 * @param {PatchLedger} ledger
 * @returns {() => void} stop: the wrapper falls back to the platform result
 */
export function installVisibilityBridge(env, ledger) {
  const win = /** @type {any} */ (env.window);
  const proto = win.Element?.prototype;
  if (!proto || typeof proto.checkVisibility !== 'function') return () => {};
  let live = true;

  /** @param {Element} layer @returns {CanvasRecord|undefined} */
  const recordOf = (layer) => env.registry.all().find((r) => r.layer?.element === layer);

  /** @param {Element} el @returns {boolean} el sits in a managed layer */
  function inLayer(el) {
    for (let n = flatParent(el); n; n = flatParent(n)) if (n.nodeType === 1 && isLayerElement(/** @type {Element} */ (n))) return !!recordOf(/** @type {Element} */ (n));
    return false;
  }

  /** @param {Element} el @returns {boolean|null} an element of the native chain has opacity 0; null: a layer on the way has no record */
  function zeroOpacity(el) {
    /** @type {Node|null} */
    let n = el;
    for (; n; n = flatParent(n)) {
      if (n.nodeType !== 1) continue;
      /** @type {Element} */
      let cur = /** @type {Element} */ (n);
      if (isLayerElement(cur)) {
        const record = recordOf(cur);
        if (!record) return null;
        n = cur = record.canvas;
      }
      if (Number(win.getComputedStyle(cur).opacity) === 0) return true;
    }
    return false;
  }

  ledger.wrap(proto, 'checkVisibility', (original) => /** @this {Element} */ function checkVisibility(/** @type {any} */ options) {
    if (!live || !options || (typeof options !== 'object' && typeof options !== 'function') || !(options.opacityProperty || options.checkOpacity) || !inLayer(this)) {
      return Reflect.apply(original, this, arguments);
    }
    const rest = {
      checkOpacity: false, opacityProperty: false,
      checkVisibilityCSS: !!options.checkVisibilityCSS, visibilityProperty: !!options.visibilityProperty, contentVisibilityAuto: !!options.contentVisibilityAuto,
    };
    if (!Reflect.apply(original, this, [rest])) return false;
    const zero = zeroOpacity(this);
    return zero === null ? Reflect.apply(original, this, arguments) : !zero;
  });
  return () => { live = false; };
}
