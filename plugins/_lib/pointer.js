/**
 * Where the pointer is in the picture a plugin rendered (plugins/_lib/: bundled into each plugin that imports it).
 * A plugin that reacts to the pointer (a drop under it, a lens that follows it, a card that tilts towards it) reads the pointer through this: with another
 * plugin added after it, the user sees this plugin's picture moved by that one (tilted, curved, refracted), and the reaction belongs under the pointer as seen.
 */

/**
 * A client point as canvas-relative CSS pixels of the content box, through the plugins after this one (EffectPluginContext.localPoint).
 * @param {{localPoint?: (point: {x: number, y: number}) => {x: number, y: number}|null}} context
 * @param {HTMLCanvasElement} canvas
 * @param {number} clientX @param {number} clientY
 * @returns {{x: number, y: number}|null}  null where a later plugin shows nothing of this plugin's picture
 */
export function pointerIn(context, canvas, clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const p = { x: clientX - r.left - canvas.clientLeft, y: clientY - r.top - canvas.clientTop };
  // (an event without a position, such as one a script dispatched: the point as it is, not finite, as without any plugin after this one)
  return typeof context.localPoint === 'function' && Number.isFinite(p.x) && Number.isFinite(p.y) ? context.localPoint(p) : p;
}
