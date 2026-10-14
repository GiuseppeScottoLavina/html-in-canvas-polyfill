/**
 * DOMMatrix helpers (pure). The arithmetic runs on plain 16-number arrays in DOMMatrix order (m11, m12, m13, m14, m21, ... m44:
 * column-major, the order of toFloat64Array() and of the CSS matrix3d() list), so the hot paths allocate no DOMMatrix and the maths
 * is testable without a DOM. A DOMMatrix is only read (toFloat64Array) or created (`matrixFrom`) at the edges.
 * Module: shared util (used by api, live and effects).
 */

/** @typedef {import('../contracts/types.js').Rect} Rect */
/** @typedef {number[]} Values16  column-major 4x4 */


/** @type {ReadonlyArray<number>} */
export const IDENTITY16 = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** @param {DOMMatrixReadOnly} m @returns {Values16} the 16 values of m (a copy) */
export function matrixValues(m) {
  return Array.from(m.toFloat64Array());
}

/**
 * New DOMMatrix from 16 values. With is2D the matrix is created 2D (only a..f are taken), otherwise 3D (is2D false even if the values are planar).
 * @param {ArrayLike<number>} v
 * @param {boolean} is2D
 * @returns {DOMMatrix}
 */
export function matrixFrom(v, is2D) {
  return new DOMMatrix(is2D ? [v[0], v[1], v[4], v[5], v[12], v[13]] : Array.from(v));
}

/**
 * Plain DOMMatrixInit object for 16 values (no DOMMatrix is allocated). 2D init carries only a..f; 3D carries m11..m44 and `is2D: false`.
 * @param {ArrayLike<number>} v
 * @param {boolean} is2D
 * @returns {DOMMatrixInit}
 */
export function matrixInit(v, is2D) {
  if (is2D) return { a: v[0], b: v[1], c: v[4], d: v[5], e: v[12], f: v[13], is2D: true };
  return {
    m11: v[0], m12: v[1], m13: v[2], m14: v[3], m21: v[4], m22: v[5], m23: v[6], m24: v[7],
    m31: v[8], m32: v[9], m33: v[10], m34: v[11], m41: v[12], m42: v[13], m43: v[14], m44: v[15], is2D: false,
  };
}

/** @param {number} x @param {number} y @param {number} [z] @returns {Values16} */
export function translation16(x, y, z = 0) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

/** @param {number} x @param {number} y @param {number} [z] @returns {Values16} */
export function scale16(x, y, z = 1) {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}

/**
 * a * b (DOMMatrix.multiply order: the point is transformed by b first, then by a).
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {Values16}
 */
export function multiply16(a, b) {
  /** @type {Values16} */
  const out = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

/**
 * Inverse of a pure translation matrix (only m41/m42/m43 are read).
 * @param {ArrayLike<number>} t
 * @returns {Values16}
 */
export function invertTranslation16(t) {
  return translation16(-t[12], -t[13], -t[14]);
}

/** @param {ArrayLike<number>} a @param {ArrayLike<number>} b @returns {boolean} element-wise equality (NaN equals NaN) */
export function values16Equal(a, b) {
  for (let i = 0; i < 16; i++) if (a[i] !== b[i] && !(a[i] !== a[i] && b[i] !== b[i])) return false;
  return true;
}
