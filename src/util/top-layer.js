/**
 * Elements rendered in the top layer (modal dialog, open popover, fullscreen element).
 * Module: util.
 */

const TOP_LAYER = [':modal', ':popover-open', ':fullscreen'];

/**
 * True for an element that is rendered in the top layer. Natively it is painted in the page's top layer and NOT into the canvas (WPT top-layer-not-painted-in-canvas), and a
 * drawable inside it has no snapshot (WPT error-conditions: drawElementImage and captureElementImage throw InvalidStateError while it is open, and after it closes until the
 * next paint; Chromium "Suppress snapshot generation for drawables in top layer").
 * @param {Element} el @returns {boolean}
 */
export function inTopLayer(el) {
  for (const sel of TOP_LAYER) {
    try { if (el.matches(sel)) return true; } catch { /* selector unknown to this engine */ }
  }
  return false;
}

/**
 * True when `el` or an ancestor of it below its canvas is in the top layer: the walk ends at `stop` (the canvas's layer) or at the first <canvas>, which the parent facade
 * answers as the parent of a top-level child (a canvas that is itself fullscreen or in a modal dialog keeps its snapshots, WPT fullscreen-canvas).
 * @param {Element} el @param {Element} stop @returns {boolean}
 */
export function inTopLayerBelow(el, stop) {
  for (let n = /** @type {Element|null} */ (el); n && n !== stop && n.localName !== 'canvas'; n = n.parentElement) if (inTopLayer(n)) return true;
  return false;
}
