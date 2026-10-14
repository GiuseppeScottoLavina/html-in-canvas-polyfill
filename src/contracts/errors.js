/**
 * Error model.
 *
 *  - Spec errors are native types: DOMException 'InvalidStateError' (not drawable, no snapshot, closed ElementImage,
 *    wrong canvas) and TypeError (bad arguments). See docs/API-CONTRACT.md section 6.
 *  - Anything the polyfill cannot do is a HicUnsupportedError: a DOMException named 'NotSupportedError' (code 9, the platform's own
 *    name for "not supported") carrying `feature`, `hint`, `path`.
 */

export class HicUnsupportedError extends DOMException {
  /**
   * @param {string} feature id from contracts/features.js
   * @param {string} message
   * @param {{hint?: string, path?: string}} [extra]
   */
  constructor(feature, message, extra = {}) {
    super(`[hic-live-polyfill] ${message}`, 'NotSupportedError');
    /** @type {string} */
    this.feature = feature;
    /** @type {string|undefined} */
    this.hint = extra.hint;
    /** @type {string|undefined} */
    this.path = extra.path;
  }
}

/** @param {string} message @returns {DOMException} */
export function invalidState(message) {
  return new DOMException(message, 'InvalidStateError');
}

/** @param {string} message @returns {TypeError} */
export function typeError(message) {
  return new TypeError(message);
}
