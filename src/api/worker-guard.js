/**
 * Loud guard for ElementImage crossing a thread boundary (feature worker-element-image).
 * Module: api-surface (src/api/*).
 */

import { HicUnsupportedError } from '../contracts/errors.js';
import { elementImageVersion } from './element-image.js';
import { globalsOf } from './validate.js';
import { createWorkerTransfer } from './worker-transfer.js';

/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').PatchLedger} PatchLedger */

const HINT = 'use elementImage.toImageBitmap() and transfer the ImageBitmap';
/** Interfaces whose postMessage can reach another thread or realm (window.postMessage stays as is). A dedicated Worker takes ElementImages (worker-transfer.js). */
const CARRIERS = ['Worker', 'MessagePort', 'BroadcastChannel', 'ServiceWorker'];

/** @param {unknown} v @returns {boolean} */
function isPlainObject(v) {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Shallow search: the value itself, array items, data properties of a plain object (accessors are never invoked).
 * @param {unknown} v
 * @param {(x: unknown) => boolean} isImage
 * @returns {boolean}
 */
function holdsElementImage(v, isImage) {
  if (isImage(v)) return true;
  if (Array.isArray(v)) return v.some(isImage);
  if (!isPlainObject(v)) return false;
  return Object.values(Object.getOwnPropertyDescriptors(/** @type {object} */ (v))).some((d) => 'value' in d && isImage(d.value));
}

/**
 * Wrap Worker.prototype.postMessage, MessagePort.prototype.postMessage and DedicatedWorkerGlobalScope-free equivalents (window.postMessage is left alone). Worker: every message goes
 * through worker-transfer.js (ElementImages become records the worker bundle reads; the messages are counted). The others: when the message (shallow walk: the value, array items,
 * plain-object property values) or the transfer list holds an ElementImage, throw HicUnsupportedError('worker-element-image', hint: "use elementImage.toImageBitmap() and transfer
 * the ImageBitmap"). Everything else passes through with identical arguments.
 * @param {HicEnv} env
 * @param {PatchLedger} ledger
 * @param {import('../contracts/types.js').GeometryApi} geometry
 */
export function installWorkerGuard(env, ledger, geometry) {
  const win = /** @type {Record<string, any>} */ (/** @type {unknown} */ (globalsOf(env)));
  /** @param {unknown} x */
  const isImage = (x) => elementImageVersion(x) !== null || (typeof win.ElementImage === 'function' && x instanceof win.ElementImage);

  const transfer = createWorkerTransfer(env, geometry);
  for (const name of CARRIERS) {
    const proto = win[name]?.prototype;
    if (!proto || typeof Object.getOwnPropertyDescriptor(proto, 'postMessage')?.value !== 'function') continue;
    if (name === 'Worker') {
      ledger.wrap(proto, 'postMessage', (original) => /** @this {Worker} */ function () { return transfer.post(this, original, arguments, isImage); });
      continue;
    }
    ledger.wrap(proto, 'postMessage', (original) => /** @this {object} */ function () {
      const [message, second] = arguments;
      const transfer = Array.isArray(second) ? second : second?.transfer;
      if (holdsElementImage(message, isImage) || (Array.isArray(transfer) && transfer.some(isImage))) throw refuse(env, name);
      return Reflect.apply(original, this, arguments);
    });
  }
}

/** @param {HicEnv} env @param {string} carrier @returns {HicUnsupportedError} */
function refuse(env, carrier) {
  const message = `An ElementImage cannot be posted to a ${carrier}: only a dedicated Worker running the worker bundle takes one.`;
  env.reporter.unsupported({ feature: 'worker-element-image', message, hint: HINT });
  return new HicUnsupportedError('worker-element-image', message, { hint: HINT });
}
