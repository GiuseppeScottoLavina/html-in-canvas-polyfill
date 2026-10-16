/**
 * Option parsing of plugin actions (handle.trigger(action, options)), shared by the example plugins (plugins/_lib/: bundled into each
 * plugin that imports it). PURE.
 */

/**
 * The `point` option of an action: absent (null), or {x, y} in canvas CSS px with finite numbers.
 * @param {unknown} point
 * @param {string} plugin  the plugin's name, for the message
 * @returns {{x: number, y: number}|null}
 * @throws TypeError
 */
export function actionPoint(point, plugin) {
  if (point === undefined || point === null) return null;
  const p = /** @type {any} */ (point);
  if (typeof p !== 'object' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new TypeError(`${plugin}: \`point\` must be {x, y} in canvas CSS px (finite numbers)`);
  return { x: p.x, y: p.y };
}
