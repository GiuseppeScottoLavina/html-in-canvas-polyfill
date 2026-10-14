/**
 * GeometryState operations: updateElementGeometry / clearElementGeometry / getElementTransform and the drawn-element list.
 * The state is the spec's: per element a canvas transform and a canvas clip (null = unset), plus the ordered "list of drawn elements".
 * Every call compares NUMBERS with the stored values before it allocates a DOM object or touches the live layer, so drawing N elements
 * per frame with unchanged geometry costs N comparisons (docs/ARCHITECTURE.md ADR-F).
 * Module: api-surface (src/api/*).
 */

import { matrixFrom, matrixInit, values16Equal } from '../util/matrix.js';
import { geometryOptionsValues } from './validate.js';

/** @typedef {import('../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../contracts/types.js').ElementGeometry} ElementGeometry */
/** @typedef {import('../contracts/types.js').GeometryApi} GeometryApi */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */

/** @typedef {{values: number[]|null, is2D: boolean, clip: number[]|null}} Signature  numbers behind an ElementGeometry, for allocation-free comparison */

/** @type {WeakMap<ElementGeometry, Signature>} */
const signatures = new WeakMap();

/** @param {number[]} a @param {number[]} b @returns {boolean} */
function sameClip(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/**
 * Plain, detached options object for GeometryApi.update from parsed values (OffscreenCanvas batches copy the author's options at call time).
 * @param {ReturnType<typeof geometryOptionsValues>} v
 * @returns {{canvasTransform?: DOMMatrixInit, clip?: DOMRectInit, preserveHitTestOrder: boolean}}
 */
export function geometryOptionsFromValues(v) {
  return {
    preserveHitTestOrder: v.preserveHitTestOrder,
    ...(v.transform ? { canvasTransform: matrixInit(v.transform.values, v.transform.is2D) } : {}),
    ...(v.clip ? { clip: { ...v.clip } } : {}),
  };
}

/**
 * Implements GeometryApi. Mutates record.geometry, calls record.layer.applyGeometry / setHitTestOrder. Never requires a snapshot.
 * An element that is in the drawn list with a null transform is passed to the layer as `{transform: null, clip: null}` (identity: hit-tested at the canvas origin, WPT);
 * `applyGeometry(el, null)` is only called when the element leaves the list.
 * @param {HicEnv} env
 * @returns {GeometryApi}
 */
export function createGeometryApi(env) {
  return {
    update(record, el, opts) {
      const o = geometryOptionsValues(opts);
      const { byElement, order } = record.geometry;
      let changed = false;
      let geometry = byElement.get(el);
      /** @type {Signature|undefined} */
      let sig = geometry && signatures.get(geometry);
      if (!geometry || !sig) {
        geometry = { transform: null, clip: null };
        sig = { values: null, is2D: true, clip: null };
        signatures.set(geometry, sig);
        byElement.set(el, geometry);
        changed = true;
      }
      if (o.transform && (!sig.values || sig.is2D !== o.transform.is2D || !values16Equal(sig.values, o.transform.values))) {
        geometry.transform = matrixFrom(o.transform.values, o.transform.is2D);
        sig.values = o.transform.values;
        sig.is2D = o.transform.is2D;
        changed = true;
      }
      if (o.clip) {
        const c = [o.clip.x, o.clip.y, o.clip.width, o.clip.height];
        if (!sig.clip || !sameClip(sig.clip, c)) {
          geometry.clip = new DOMRect(c[0], c[1], c[2], c[3]);
          sig.clip = c;
          changed = true;
        }
      }
      const index = order.indexOf(el);
      const orderChanged = !(o.preserveHitTestOrder && index >= 0) && (index < 0 || index !== order.length - 1);
      if (orderChanged) {
        if (index >= 0) order.splice(index, 1);
        order.push(el);
      }
      if (!changed && !orderChanged) return;
      if (changed) record.layer?.applyGeometry(el, geometry, env.store.version(el)?.layoutOffset ?? null);
      if (orderChanged) record.layer?.setHitTestOrder(order.slice());
    },

    clear(record, el) {
      resetGeometry(record, el);
    },

    get(record, el) {
      const transform = record.geometry.byElement.get(el)?.transform;
      return transform ? DOMMatrix.fromMatrix(transform) : new DOMMatrix();
    },
  };
}

/**
 * Spec "reset drawable element state" for geometry: clip/transform null, removed from the drawn list.
 * @param {CanvasRecord} record
 * @param {Element} el
 * @returns {boolean} the element had geometry or was in the drawn list
 */
export function resetGeometry(record, el) {
  const { byElement, order } = record.geometry;
  const had = byElement.delete(el);
  const index = order.indexOf(el);
  if (index >= 0) order.splice(index, 1);
  if (!had && index < 0) return false;
  record.layer?.applyGeometry(el, null);
  if (index >= 0) record.layer?.setHitTestOrder(order.slice());
  return true;
}
