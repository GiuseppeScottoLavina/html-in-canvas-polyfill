/**
 * transferControlToOffscreen link bookkeeping, OffscreenCanvas.updateElementGeometry / clearElementGeometry (microtask batch + elementgeometryupdate).
 * A main-thread OffscreenCanvas has no layout of its own: every call resolves against the placeholder HTMLCanvasElement it was transferred from.
 * Module: api-surface (src/api/*).
 */

import { invalidState } from '../contracts/errors.js';
import { elementTransformOf } from './canvas-patch.js';
import { fireGeometryUpdate } from './paint-event.js';
import { geometryOptionsFromValues } from './geometry.js';
import { defineMethod, geometryOptionsValues, globalsOf, resolveElement } from './validate.js';

/** @typedef {import('../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../contracts/types.js').GeometryApi} GeometryApi */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').PatchLedger} PatchLedger */

/** @typedef {{kind: 'update', element: Element, options: Parameters<GeometryApi['update']>[2]} | {kind: 'clear', element: Element}} GeometryOp */

/** @type {WeakMap<OffscreenCanvas, WeakRef<HTMLCanvasElement>>} */
const placeholders = new WeakMap();

/** @type {WeakMap<CanvasRecord, GeometryOp[]>} batches waiting for their microtask */
const batches = new WeakMap();

/**
 * The HTMLCanvasElement an OffscreenCanvas was transferred from, or null (no placeholder or collected).
 * @param {OffscreenCanvas} oc
 * @returns {HTMLCanvasElement|null}
 */
export function offscreenPlaceholder(oc) {
  return placeholders.get(oc)?.deref() ?? null;
}

/**
 * Queue one geometry operation of an OffscreenCanvas; every operation of the same microtask is applied in call order, then ONE
 * `elementgeometryupdate` event lists the affected elements that still exist (spec: the update is asynchronous for offscreen canvases).
 * @param {HicEnv} env
 * @param {GeometryApi} geometry
 * @param {CanvasRecord} record
 * @param {GeometryOp} op
 */
export function enqueueGeometry(env, geometry, record, op) {
  const open = batches.get(record);
  if (open) { open.push(op); return; }
  /** @type {GeometryOp[]} */
  const batch = [op];
  batches.set(record, batch);
  globalsOf(env).queueMicrotask(() => {
    batches.delete(record);
    flushBatch(env, geometry, record, batch);
  });
}

/** @param {HicEnv} env @param {GeometryApi} geometry @param {CanvasRecord} record @param {GeometryOp[]} batch */
function flushBatch(env, geometry, record, batch) {
  if (record.state === 'disposed' || !record.layer) return;
  /** @type {Set<Element>} */
  const touched = new Set();
  for (const op of batch) {
    const el = op.element;
    if (record.layer.nearestDrawable(el) !== el) { touched.delete(el); continue; }
    try {
      if (op.kind === 'update') geometry.update(record, el, op.options);
      else geometry.clear(record, el);
      touched.add(el);
    } catch (err) {
      env.reporter.caught(err, 'offscreen-geometry');
    }
  }
  if (touched.size) fireGeometryUpdate(env, record.canvas, [...touched]);
}

/**
 * @param {OffscreenCanvas} oc
 * @returns {HTMLCanvasElement}
 * @throws InvalidStateError when the OffscreenCanvas was not transferred from a canvas
 */
function placeholderOrThrow(oc) {
  const canvas = placeholders.get(oc)?.deref();
  if (!canvas) throw invalidState('This OffscreenCanvas has no placeholder canvas; use transferControlToOffscreen() on a content="drawable" canvas.');
  return canvas;
}

/**
 * Records record.offscreen links; batches geometry updates per canvas in one microtask, then dispatches ElementGeometryUpdateEvent on the placeholder canvas.
 * @param {HicEnv} env
 * @param {PatchLedger} ledger
 * @param {GeometryApi} geometry
 */
export function installOffscreenPatches(env, ledger, geometry) {
  const win = globalsOf(env);
  ledger.wrap(win.HTMLCanvasElement.prototype, 'transferControlToOffscreen', (original) => /** @this {HTMLCanvasElement} */ function () {
    const oc = /** @type {OffscreenCanvas} */ (Reflect.apply(original, this, []));
    placeholders.set(oc, new WeakRef(this));
    env.registry.get(this)?.offscreen.add(oc);
    return oc;
  });
  if (typeof win.OffscreenCanvas !== 'function') return;
  const proto = win.OffscreenCanvas.prototype;

  defineMethod(ledger, proto, 'updateElementGeometry', 1, /** @this {OffscreenCanvas} */ function (/** @type {unknown} */ target, /** @type {unknown} */ options = {}) {
    const canvas = placeholderOrThrow(this);
    const values = geometryOptionsValues(options);
    const { record, element } = resolveElement(env, canvas, target, 'eligible');
    enqueueGeometry(env, geometry, record, { kind: 'update', element, options: geometryOptionsFromValues(values) });
  });

  // Native OffscreenCanvas has only the two-argument overload (IDL: getElementTransform((Element or ElementImage), DOMMatrix draw_transform)).
  defineMethod(ledger, proto, 'getElementTransform', 2, /** @this {OffscreenCanvas} */ function (/** @type {unknown} */ target, /** @type {unknown} */ drawTransform) {
    if (arguments.length < 2) throw new TypeError(`Failed to execute 'getElementTransform' on 'OffscreenCanvas': 2 arguments required, but only ${arguments.length} present.`);
    return elementTransformOf(env, geometry, placeholderOrThrow(this), target, drawTransform);
  });

  defineMethod(ledger, proto, 'clearElementGeometry', 1, /** @this {OffscreenCanvas} */ function (/** @type {unknown} */ target) {
    const canvas = placeholderOrThrow(this);
    const { record, element } = resolveElement(env, canvas, target, 'eligible');
    enqueueGeometry(env, geometry, record, { kind: 'clear', element });
  });
}
