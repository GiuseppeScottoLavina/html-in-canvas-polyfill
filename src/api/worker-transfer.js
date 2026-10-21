/**
 * ElementImage to a dedicated Worker (feature worker-element-image): Worker.prototype.postMessage replaces each ElementImage at a shallow position of the message by a record
 * (worker-wire.js) that carries the snapshot as a transferred ImageBitmap; the worker runs the worker bundle (hic-live-worker, worker-scope.js), which turns the records back
 * into ElementImages that its OffscreenCanvas 2D contexts draw. An ElementImage in the transfer list is detached (closed) here, as a transfer detaches it. The worker sends the
 * geometry of its draws (and its update/clearElementGeometry calls) back on a MessageChannel: they are applied as for a main-thread OffscreenCanvas (one microtask batch, one
 * elementgeometryupdate per worker turn). Which canvas a transferred OffscreenCanvas belongs to is told by message number and position (the worker counts its messages too).
 * Module: api-surface (src/api/*).
 */

import { matrixInit } from '../util/matrix.js';
import { elementImageVersion } from './element-image.js';
import { enqueueGeometry, offscreenPlaceholder } from './offscreen-patch.js';
import { BRAND, shallowCopy, visitShallow } from './worker-wire.js';

/** @typedef {import('../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../contracts/types.js').GeometryApi} GeometryApi */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('./worker-wire.js').ImageRecord} ImageRecord */

/**
 * One geometry operation sent by the worker.
 * @typedef {{kind: 'update', canvas: number, element: number, values: number[], is2D: boolean, clip: {x: number, y: number, width: number, height: number}|null} | {kind: 'clear', canvas: number, element: number}} WorkerOp
 */

/** @typedef {{seq: number, log: Array<{seq: number, index: number, canvas: number}>, sent: number, port: MessagePort|null}} WorkerState */

/**
 * @param {HicEnv} env
 * @param {GeometryApi} geometry
 * @returns {{post: (worker: Worker, original: Function, args: IArguments|unknown[], isImage: (x: unknown) => boolean) => unknown}}
 */
export function createWorkerTransfer(env, geometry) {
  /** @type {WeakMap<object, WorkerState>} */
  const workers = new WeakMap();
  /** @type {WeakMap<Element, number>} */
  const tokens = new WeakMap();
  /** @type {Map<number, WeakRef<Element>>} */
  const elements = new Map();
  let nextToken = 1;

  /** @param {Element} el @returns {number} */
  const tokenOf = (el) => {
    let t = tokens.get(el);
    if (t === undefined) {
      t = nextToken++;
      tokens.set(el, t);
      elements.set(t, new WeakRef(el));
    }
    return t;
  };

  /** @param {number} id @returns {CanvasRecord|undefined} */
  const recordById = (id) => env.registry.all().find((r) => r.id === id);

  /** @param {WorkerOp[]} ops */
  function applyOps(ops) {
    for (const op of Array.isArray(ops) ? ops : []) {
      const record = recordById(op.canvas);
      const element = elements.get(op.element)?.deref();
      if (!record || !element) continue;
      if (op.kind === 'clear') enqueueGeometry(env, geometry, record, { kind: 'clear', element });
      else enqueueGeometry(env, geometry, record, { kind: 'update', element, options: { canvasTransform: matrixInit(op.values, op.is2D), ...(op.clip ? { clip: op.clip } : {}), preserveHitTestOrder: false } });
    }
  }

  /** @param {object} worker @returns {WorkerState} */
  const stateOf = (worker) => {
    let st = workers.get(worker);
    if (!st) workers.set(worker, (st = { seq: 0, log: [], sent: 0, port: null }));
    return st;
  };

  /**
   * The record of one ElementImage, or null when it has no pixels to send (closed, or its element is gone).
   * @param {unknown} image @param {WorkerState} st @param {Transferable[]} transfer
   * @returns {ImageRecord|null}
   */
  function recordOf(image, st, transfer) {
    const info = elementImageVersion(image);
    const v = info?.version;
    const el = v?.element.deref();
    if (!info || !v || !el || !info.record) return null;
    const ink = v.ink;
    const src = env.store.rasterSource(v, { sx: -ink.left, sy: -ink.top, sw: v.width + ink.left + ink.right, sh: v.height + ink.top + ink.bottom });
    if (!src) return null;
    const w = Math.max(1, Math.round(src.sw));
    const h = Math.max(1, Math.round(src.sh));
    const oc = new OffscreenCanvas(w, h);
    oc.getContext('2d')?.drawImage(src.source, src.sx, src.sy, src.sw, src.sh, 0, 0, w, h);
    const bitmap = oc.transferToImageBitmap();
    transfer.push(bitmap);
    /** @type {ImageRecord} */
    const record = {
      [BRAND]: 1, seq: st.seq, canvas: info.record.id, element: tokenOf(el), bitmap, width: v.width, height: v.height, canvasWidth: v.canvasWidth, canvasHeight: v.canvasHeight,
      scale: w / (v.width + ink.left + ink.right), ink: { ...ink }, blend: v.blend ?? 'normal', log: st.log.slice(st.sent),
    };
    st.sent = st.log.length;
    if (!st.port) {
      const channel = new MessageChannel();
      st.port = channel.port1;
      st.port.onmessage = (e) => applyOps(e.data);
      record.port = channel.port2;
      transfer.push(channel.port2);
    }
    return record;
  }

  return {
    post(worker, original, args, isImage) {
      const st = stateOf(worker);
      // a message that is not delivered (a throw anywhere below) leaves the state as it was: no logged canvases, no offered channel
      const before = { log: st.log.length, sent: st.sent, port: st.port };
      /** @type {Transferable[]} */
      const extra = [];
      try {
        const out = deliver(st, worker, original, args, isImage, extra);
        st.seq++;
        return out;
      } catch (err) {
        st.log.length = before.log;
        st.sent = before.sent;
        if (!before.port && st.port) { st.port.close(); st.port = null; }
        for (const x of extra) /** @type {{close?: () => void}} */ (x).close?.();
        throw err;
      }
    },
  };

  /**
   * @param {WorkerState} st @param {object} worker @param {Function} original @param {IArguments|unknown[]} args @param {(x: unknown) => boolean} isImage
   * @param {Transferable[]} extra  receives the bitmaps and the channel port created for the message
   * @returns {unknown}
   */
  function deliver(st, worker, original, args, isImage, extra) {
    const [message, second] = args;
    const options = second !== null && typeof second === 'object' && !Array.isArray(second) ? second : null;
    const transfer = /** @type {unknown[]} */ (Array.isArray(second) ? second : Array.isArray(options?.transfer) ? options.transfer : []);
    /** @type {unknown[]} */
    const images = [];
    visitShallow(message, (x, index) => {
      if (isImage(x)) images.push(x);
      else if (typeof OffscreenCanvas === 'function' && x instanceof OffscreenCanvas) {
        const canvas = offscreenPlaceholder(x);
        const record = canvas && env.registry.get(canvas);
        if (record) st.log.push({ seq: st.seq, index, canvas: record.id });
      }
    });
    const transferred = transfer.filter(isImage);
    if (!images.length && !transferred.length) return Reflect.apply(original, worker, args);
    if (transferred.some((x) => !images.includes(x))) throw new DOMException('An ElementImage in the transfer list must also be in the message (as the message or one of its items).', 'DataCloneError');
    /** @type {Map<unknown, ImageRecord>} */
    const records = new Map();
    for (const image of images) {
      if (records.has(image)) continue;
      const r = recordOf(image, st, extra);
      if (!r) throw new DOMException('The ElementImage is closed or its element is gone.', 'DataCloneError');
      records.set(image, r);
    }
    const copy = shallowCopy(message);
    let top = copy;
    visitShallow(copy, (x, index, set) => {
      const r = records.get(x);
      if (!r) return;
      if (set) set(r); else if (index === 0) top = r;
    });
    const list = [...transfer.filter((x) => !isImage(x)), ...extra];
    const out = Reflect.apply(original, worker, [top, options ? { ...options, transfer: list } : list]);
    for (const image of transferred) /** @type {{close: () => void}} */ (image).close();
    return out;
  }
}
