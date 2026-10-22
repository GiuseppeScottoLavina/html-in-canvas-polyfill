/**
 * The HTML-in-Canvas surface inside a dedicated worker (the worker bundle, src/worker.js): ElementImages posted by the main thread (worker-transfer.js) arrive as records
 * (worker-wire.js) and are turned back into ElementImage objects before the page's own message listeners run; OffscreenCanvasRenderingContext2D.drawElementImage draws their
 * pixels with the four overloads of the main thread (draw-math.js), and the OffscreenCanvas geometry calls (updateElementGeometry, clearElementGeometry,
 * getElementImageDefaultSize, the two-argument getElementTransform of the 2026-10-07 draft) work on them. Geometry goes back to the main thread on the channel of the first
 * record, one message per worker turn. An OffscreenCanvas is known to belong to a canvas by the main thread's log (message number and position); a standalone one, or one of
 * another canvas, throws InvalidStateError as natively.
 * Module: api-surface (src/api/*).
 */

import { invalidState } from '../contracts/errors.js';
import { IDENTITY16, matrixFrom, matrixValues, multiply16, scale16 } from '../util/matrix.js';
import { defaultSizeOf } from './element-image.js';
import { canvasTransformValues, clipToSurface, parseDrawArgs, resolveRects, storedTransformValues } from './draw-math.js';
import { geometryOptionsValues, matrixInitValues } from './validate.js';
import { isImageRecord, visitShallow } from './worker-wire.js';

/** @typedef {import('./worker-wire.js').ImageRecord} ImageRecord */
/** @typedef {{record: ImageRecord, closed: boolean}} ImageState */

const CREATE = Symbol('hic.create-worker-element-image');
const INSTALLED = Symbol.for('hic.worker-scope');
/** CSS mix-blend-mode -> globalCompositeOperation (as context2d-patch.js). */
const BLEND = new Set(['multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity']);

/**
 * Install into a dedicated worker's global scope; a no-op elsewhere (a window, a second call).
 * @param {any} scope  the worker global
 * @returns {boolean} installed now
 */
export function installWorkerScope(scope) {
  const OC = scope.OffscreenCanvas;
  const Ctx = scope.OffscreenCanvasRenderingContext2D;
  if (typeof scope.importScripts !== 'function' || typeof OC !== 'function' || typeof Ctx !== 'function' || scope[INSTALLED]) return false;
  Object.defineProperty(scope, INSTALLED, { value: true });

  /** @type {WeakMap<object, ImageState>} */
  const states = new WeakMap();
  /** @type {WeakMap<object, number>} OffscreenCanvas -> canvas id */
  const owners = new WeakMap();
  /** @type {Map<string, object>} `${message}:${position}` -> an OffscreenCanvas not identified yet */
  const pending = new Map();
  /** @type {WeakMap<object, object>} message data that IS a record -> its ElementImage */
  const replaced = new WeakMap();
  /** @type {MessagePort|null} */
  let port = null;
  /** @type {object[]} */
  let ops = [];
  let seq = 0;

  class ElementImage {
    /** @param {unknown[]} args */
    constructor(...args) { if (args[0] !== CREATE) throw new TypeError('Illegal constructor'); }
    close() {
      const st = stateOf(this);
      if (st.closed) return;
      st.closed = true;
      st.record.bitmap.close?.();
    }
  }
  Object.defineProperty(ElementImage.prototype, Symbol.toStringTag, { value: 'ElementImage', configurable: true });
  if (!('ElementImage' in scope)) Object.defineProperty(scope, 'ElementImage', { value: ElementImage, writable: true, configurable: true });

  /** @param {unknown} img @returns {ImageState} */
  function stateOf(img) {
    const st = typeof img === 'object' && img !== null ? states.get(img) : undefined;
    if (!st) throw new TypeError("The provided value is not of type 'ElementImage'.");
    return st;
  }

  /** @param {ImageRecord} r @param {number} mine  this worker's number of the message that carries it @returns {object} */
  function hydrate(r, mine) {
    const offset = mine - r.seq;
    for (const e of r.log ?? []) {
      const key = `${e.seq + offset}:${e.index}`;
      const oc = pending.get(key);
      if (oc) { owners.set(oc, e.canvas); pending.delete(key); }
    }
    if (r.port) port = r.port;
    const img = new ElementImage(CREATE);
    states.set(img, { record: r, closed: false });
    return img;
  }

  /** Runs before the page's own listeners (capture, registered first): records become ElementImages, OffscreenCanvases are numbered. @param {MessageEvent} e */
  function onMessage(e) {
    if (e.target !== scope) return;
    const mine = seq++;
    const data = dataOf(e);
    visitShallow(data, (x, index) => { if (x instanceof OC) pending.set(`${mine}:${index}`, /** @type {object} */ (x)); });
    visitShallow(data, (x, index, set) => {
      if (!isImageRecord(x)) return;
      const img = hydrate(x, mine);
      if (set) set(img); else if (index === 0 && data && typeof data === 'object') replaced.set(data, img);
    });
  }
  const dataDesc = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(scope.MessageEvent.prototype, 'data'));
  /** @param {MessageEvent} e @returns {unknown} */
  const dataOf = (e) => dataDesc.get?.call(e);
  Object.defineProperty(scope.MessageEvent.prototype, 'data', {
    configurable: true, enumerable: dataDesc.enumerable,
    get() { const raw = dataOf(this); return (raw && typeof raw === 'object' && replaced.get(raw)) || raw; },
  });
  scope.addEventListener('message', onMessage, true);
  scope.addEventListener('messageerror', () => { seq++; }, true);

  /** @param {object} op */
  function send(op) {
    if (!port) return;
    if (!ops.length) queueMicrotask(() => { const batch = ops; ops = []; port?.postMessage(batch); });
    ops.push(op);
  }

  /**
   * The image and its record, checked against the OffscreenCanvas it is used with (spec: InvalidStateError for a closed image or another canvas).
   * @param {object} canvas @param {unknown} image @returns {ImageRecord}
   */
  function recordFor(canvas, image) {
    const st = stateOf(image);
    if (st.closed) throw invalidState('The ElementImage is closed.');
    if (owners.get(canvas) !== st.record.canvas) throw invalidState('The ElementImage belongs to another canvas, or this OffscreenCanvas was not transferred from its canvas.');
    return st.record;
  }

  const drawImage = Ctx.prototype.drawImage;
  /** @this {OffscreenCanvasRenderingContext2D} @param {...unknown} args */
  function drawElementImage(...args) {
    if (!(this instanceof Ctx)) throw new TypeError('Illegal invocation');
    const parsed = parseDrawArgs(args);
    stateOf(args[0]);
    if (!parsed) return undefined;
    const r = recordFor(this.canvas, parsed.target);
    const rects = resolveRects(parsed, r, this.canvas.width, this.canvas.height);
    const clipped = clipToSurface(rects, r);
    if (clipped) {
      const k = r.scale;
      const op = this.globalCompositeOperation;
      if (BLEND.has(r.blend)) this.globalCompositeOperation = /** @type {GlobalCompositeOperation} */ (r.blend);
      else if (r.blend === 'plus-lighter') this.globalCompositeOperation = 'lighter';
      try {
        drawImage.call(this, r.bitmap, (clipped.src.sx + r.ink.left) * k, (clipped.src.sy + r.ink.top) * k, clipped.src.sw * k, clipped.src.sh * k, clipped.dx, clipped.dy, clipped.dw, clipped.dh);
      } finally {
        this.globalCompositeOperation = op;
      }
    }
    if (parsed.preserveElementGeometry || rects.degenerate) return undefined;
    const ctm = this.getTransform();
    const values = canvasTransformValues(matrixValues(ctm), { ...rects.src, dx: rects.dx, dy: rects.dy, dw: rects.dw, dh: rects.dh, kx: rects.kx, ky: rects.ky }, rects.scaleX, rects.scaleY, IDENTITY16);
    send({ kind: 'update', canvas: r.canvas, element: r.element, values, is2D: ctm.is2D, clip: { x: rects.src.sx, y: rects.src.sy, width: rects.src.sw, height: rects.src.sh } });
    return undefined;
  }

  /** @param {object} target @param {string} name @param {number} length @param {Function} fn */
  const define = (target, name, length, fn) => {
    if (name in target) return;
    Object.defineProperty(fn, 'name', { value: name });
    Object.defineProperty(fn, 'length', { value: length });
    Object.defineProperty(target, name, { value: fn, writable: true, configurable: true, enumerable: true });
  };
  define(Ctx.prototype, 'drawElementImage', 3, drawElementImage);
  define(OC.prototype, 'getElementImageDefaultSize', 1, /** @this {OffscreenCanvas} */ function (/** @type {unknown} */ image) {
    return defaultSizeOf(recordFor(this, image), this);
  });
  define(OC.prototype, 'updateElementGeometry', 1, /** @this {OffscreenCanvas} */ function (/** @type {unknown} */ image, /** @type {unknown} */ options = {}) {
    const v = geometryOptionsValues(options);
    const r = recordFor(this, image);
    const t = v.transform ?? { values: Array.from(IDENTITY16), is2D: true };
    send({ kind: 'update', canvas: r.canvas, element: r.element, values: t.values, is2D: t.is2D, clip: v.clip ?? null });
  });
  define(OC.prototype, 'clearElementGeometry', 1, /** @this {OffscreenCanvas} */ function (/** @type {unknown} */ image) {
    const r = recordFor(this, image);
    send({ kind: 'clear', canvas: r.canvas, element: r.element });
  });
  // Deprecated: the two-argument getElementTransform of the 2026-10-07 draft (as on the main thread, offscreen-patch.js); M = S^-1 * D * S with S the grid scale.
  define(OC.prototype, 'getElementTransform', 2, /** @this {OffscreenCanvas} */ function (/** @type {unknown} */ image, /** @type {unknown} */ drawTransform) {
    if (arguments.length < 2) throw new TypeError(`Failed to execute 'getElementTransform' on 'OffscreenCanvas': 2 arguments required, but only ${arguments.length} present.`);
    const r = recordFor(this, image);
    const draw = matrixInitValues(drawTransform);
    const sx = r.canvasWidth > 0 ? this.width / r.canvasWidth : 1;
    const sy = r.canvasHeight > 0 ? this.height / r.canvasHeight : 1;
    return matrixFrom(storedTransformValues(multiply16(draw.values, scale16(sx, sy)), sx, sy, IDENTITY16), draw.is2D);
  });
  return true;
}
