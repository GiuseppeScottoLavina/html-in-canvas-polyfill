/**
 * The wire format of an ElementImage posted to a dedicated worker (main thread: worker-transfer.js; worker: worker-scope.js).
 * A record replaces the ElementImage in the message: the snapshot's pixels as a transferred ImageBitmap and the numbers the worker needs to draw it and to compute its
 * geometry. Both sides look for ElementImages and OffscreenCanvases at the same SHALLOW positions (the value itself, the items of an array, the data properties of a plain
 * object), in the same order, so a position index names the same object on both sides.
 * Module: api-surface (src/api/*).
 */

/** Marks a record: an own data property of a plain object. */
export const BRAND = '__hicElementImage';

/**
 * @typedef {Object} ImageRecord
 * @property {1} __hicElementImage
 * @property {number} seq  the main thread's count of messages posted to this worker before this one
 * @property {number} canvas  id of the canvas the image belongs to
 * @property {number} element  token of the drawable (geometry updates name it)
 * @property {ImageBitmap} bitmap  border box + ink at `scale` bitmap px per css px
 * @property {number} width @property {number} height  border box, css px
 * @property {number} canvasWidth @property {number} canvasHeight  canvas content box at snapshot time, css px
 * @property {number} scale  bitmap px per css px
 * @property {{left: number, top: number, right: number, bottom: number}} ink
 * @property {string} blend  the drawable's mix-blend-mode
 * @property {Array<{seq: number, index: number, canvas: number}>} log  OffscreenCanvases of managed canvases transferred to this worker, by message and position
 * @property {MessagePort} [port]  the channel the worker sends geometry updates on (first record only)
 */

/** @param {unknown} v @returns {boolean} */
function isPlainObject(v) {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Visit the shallow positions of a message: index 0 is the value itself, then 1.. the array items or the data properties of a plain object, in order (accessors are never
 * invoked). `fn(value, index, set)`: `set(x)` replaces the value at that position (the container is mutated; index 0 cannot be set).
 * @param {unknown} message
 * @param {(value: unknown, index: number, set: ((x: unknown) => void)|null) => void} fn
 */
export function visitShallow(message, fn) {
  fn(message, 0, null);
  if (Array.isArray(message)) {
    for (let i = 0; i < message.length; i++) fn(message[i], i + 1, (x) => { message[i] = x; });
    return;
  }
  if (!isPlainObject(message)) return;
  const o = /** @type {Record<string, unknown>} */ (message);
  let i = 1;
  for (const key of Object.keys(o)) {
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (d && 'value' in d) fn(d.value, i, (x) => { o[key] = x; });
    i++;
  }
}

/** @param {unknown} message @returns {unknown} a copy of the top-level container (array or plain object) that can be rewritten; any other value as it is */
export function shallowCopy(message) {
  if (Array.isArray(message)) return message.slice();
  if (!isPlainObject(message)) return message;
  return Object.assign(Object.create(Object.getPrototypeOf(message)), message);
}

/** @param {unknown} v @returns {v is ImageRecord} */
export function isImageRecord(v) {
  return isPlainObject(v) && /** @type {Record<string, unknown>} */ (v)[BRAND] === 1;
}
