/**
 * NO_TARGET: what an input mapper returns for an output point that shows no element of the source (a monitor bezel, the space beside a
 * tilted card, a moving fragment of a transition). Docs: docs/guides/EFFECTS-PLUGINS.md section 4, docs/API-CONTRACT.md 7.4.
 * Module: gpu-effects (src/effects/**). A leaf with no imports: the example plugins of plugins/ import it directly.
 *
 * The value is recognised by a registered symbol, not by identity, so that a copy made by another bundle of this file (every plugin
 * bundle inlines it) is the same answer for the host. Its coordinates lie far outside any viewport, so code that does not know the value
 * hit-tests nothing there; the host never hit-tests it: the mapper chain stops at it and the interposer swallows the gesture.
 */

/** The brand of NO_TARGET (Symbol.for: the same symbol in every bundle and realm). */
export const NO_TARGET_KEY = Symbol.for('html-in-canvas-polyfill.effects.no-target');

/** @type {Readonly<{x: number, y: number}>} */
export const NO_TARGET = Object.freeze({ x: -1e5, y: -1e5, [NO_TARGET_KEY]: true });

/** @param {unknown} point @returns {boolean} true when `point` is NO_TARGET (or a copy of it from another bundle) */
export function isNoTarget(point) {
  return !!point && typeof point === 'object' && /** @type {any} */ (point)[NO_TARGET_KEY] === true;
}
