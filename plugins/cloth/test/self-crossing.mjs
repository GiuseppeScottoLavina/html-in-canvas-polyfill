// Test helper of the cloth plugin (not a test file): where the drawn sheet passes through itself. The surface of a presented state is
// tessellated as cloth.wgsl draws it (SUB x SUB quads per cell, from the B-spline), and every edge of that grid is tested against the
// triangles near it (a uniform grid of buckets): an edge that crosses a triangle further than `gap` drawn quads away from it on the cloth
// is a place where one part of the sheet has gone through another, and there the part that should be hidden shows.
import { S, SUB, surfacePoint } from '../surface.js';

/**
 * The drawn vertices of a state (3 floats each, row by row), (cols * SUB + 1) x (rows * SUB + 1).
 * @param {Float32Array} state @returns {{V: Float64Array, fw: number, fh: number}}
 */
export function drawnSurface(state) {
  const cols = state[S.COLS], rows = state[S.ROWS], fw = cols * SUB + 1, fh = rows * SUB + 1, V = new Float64Array(3 * fw * fh), out = [0, 0, 0];
  for (let gy = 0; gy < fh; gy += 1) for (let gx = 0; gx < fw; gx += 1) { surfacePoint(state, gx / SUB, gy / SUB, out); V.set(out, 3 * (gy * fw + gx)); }
  return { V, fw, fh };
}

/** Does the segment p q cross the triangle a b c (indices of vertices of V)? Moller-Trumbore, strictly inside both. @param {Float64Array} V @param {number} p @param {number} q @param {number} a @param {number} b @param {number} c */
function crosses(V, p, q, a, b, c) {
  const px = V[3 * p], py = V[3 * p + 1], pz = V[3 * p + 2];
  const dx = V[3 * q] - px, dy = V[3 * q + 1] - py, dz = V[3 * q + 2] - pz;
  const ax = V[3 * a], ay = V[3 * a + 1], az = V[3 * a + 2];
  const e1x = V[3 * b] - ax, e1y = V[3 * b + 1] - ay, e1z = V[3 * b + 2] - az, e2x = V[3 * c] - ax, e2y = V[3 * c + 1] - ay, e2z = V[3 * c + 2] - az;
  const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(det) < 1e-12) return false;
  const f = 1 / det, sx = px - ax, sy = py - ay, sz = pz - az;
  const u = f * (sx * hx + sy * hy + sz * hz);
  if (u <= 0 || u >= 1) return false;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = f * (dx * qx + dy * qy + dz * qz);
  if (v <= 0 || u + v >= 1) return false;
  const t = f * (e2x * qx + e2y * qy + e2z * qz);
  return t > 0 && t < 1;
}

/**
 * The edges of a grid mesh that cross one of its triangles more than `gap` quads away on the grid: [{gx, gy, ox, oy}] (the edge's first
 * vertex, the triangle's quad). The quads (gx, gy) are drawn as the triangles (tl, bl, tr) and (tr, bl, br), as cloth.wgsl draws them.
 * @param {{V: Float64Array|Float32Array|number[], fw: number, fh: number}} mesh @param {number} [gap]
 * @returns {{gx: number, gy: number, ox: number, oy: number}[]}
 */
export function selfCrossings({ V: V0, fw, fh }, gap = SUB) {
  const V = V0 instanceof Float64Array ? V0 : Float64Array.from(V0);
  const quads = (fw - 1) * (fh - 1);
  // the bucket size: about two quads
  let span = 0;
  for (let k = 0; k + 3 < 3 * fw; k += 3) span += Math.hypot(V[k + 3] - V[k], V[k + 4] - V[k + 1], V[k + 5] - V[k + 2]);
  const size = Math.max(1, (2 * span) / (fw - 1));
  const box = new Float64Array(6 * quads);
  for (let gy = 0, q = 0; gy < fh - 1; gy += 1) for (let gx = 0; gx < fw - 1; gx += 1, q += 1) {
    const v = [gy * fw + gx, gy * fw + gx + 1, (gy + 1) * fw + gx, (gy + 1) * fw + gx + 1];
    for (let a = 0; a < 3; a += 1) {
      let lo = Infinity, hi = -Infinity;
      for (const i of v) { lo = Math.min(lo, V[3 * i + a]); hi = Math.max(hi, V[3 * i + a]); }
      box[6 * q + a] = Math.floor(lo / size); box[6 * q + 3 + a] = Math.floor(hi / size);
    }
  }
  /** @type {Map<number, number[]>} */ const buckets = new Map();
  const key = (/** @type {number} */ i, /** @type {number} */ j, /** @type {number} */ k) => ((i + 4096) * 8192 + (j + 4096)) * 8192 + (k + 4096);
  for (let q = 0; q < quads; q += 1) {
    for (let i = box[6 * q]; i <= box[6 * q + 3]; i += 1) for (let j = box[6 * q + 1]; j <= box[6 * q + 4]; j += 1) for (let k = box[6 * q + 2]; k <= box[6 * q + 5]; k += 1) {
      const b = key(i, j, k);
      const list = buckets.get(b);
      if (list) list.push(q); else buckets.set(b, [q]);
    }
  }
  const out = [];
  const seen = new Int32Array(quads).fill(-1);
  let stamp = 0;
  const edge = (/** @type {number} */ p, /** @type {number} */ q, /** @type {number} */ gx, /** @type {number} */ gy) => {
    stamp += 1;
    const lo = [0, 0, 0], hi = [0, 0, 0];
    for (let a = 0; a < 3; a += 1) { lo[a] = Math.floor(Math.min(V[3 * p + a], V[3 * q + a]) / size); hi[a] = Math.floor(Math.max(V[3 * p + a], V[3 * q + a]) / size); }
    for (let i = lo[0]; i <= hi[0]; i += 1) for (let j = lo[1]; j <= hi[1]; j += 1) for (let k = lo[2]; k <= hi[2]; k += 1) {
      for (const t of buckets.get(key(i, j, k)) ?? []) {
        if (seen[t] === stamp) continue;
        seen[t] = stamp;
        const ox = t % (fw - 1), oy = (t - ox) / (fw - 1);
        if (Math.abs(ox - gx) <= gap && Math.abs(oy - gy) <= gap) continue;
        const tl = oy * fw + ox, tr = tl + 1, bl = tl + fw, br = bl + 1;
        if (crosses(V, p, q, tl, bl, tr) || crosses(V, p, q, tr, bl, br)) { out.push({ gx, gy, ox, oy }); return; }
      }
    }
  };
  for (let gy = 0; gy < fh; gy += 1) for (let gx = 0; gx < fw; gx += 1) {
    const v = gy * fw + gx;
    if (gx < fw - 1) edge(v, v + 1, gx, gy);
    if (gy < fh - 1) edge(v, v + fw, gx, gy);
  }
  return out;
}
