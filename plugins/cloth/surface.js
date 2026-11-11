/**
 * The surface of the cloth plugin, and its input mapper. PURE: no DOM, no GPU.
 *
 * The particles of the simulation (sim.js) are the control points of a uniform bicubic B-spline surface: smooth (continuous curvature, so
 * no cell of the grid shows in the shading), inside the convex hull of its control points, and exactly the flat page when the particles
 * lie on their grid. A ring of ghost points (each the mirror image of the first inner point in the border point) lets the surface end on
 * the border particles' rows: its corners are the corner particles, its top edge the pinned row.
 *
 * cloth.wgsl draws that surface as triangles: SUB x SUB quads per cell, each split along the same diagonal, with the page coordinates
 * interpolated in perspective. `castCloth` intersects the line of sight of a presented point with the very same triangles (the same
 * control points as 32-bit floats, the same tessellation, the same diagonal, the same perspective) and returns the nearest one: the
 * input mapper is the twin of the rasteriser, not an approximation of the surface.
 *
 * The state of one frame, a Float32Array: HEAD floats (S below), then the control points with their ghost ring, 4 floats each (x, y, z,
 * unused), row by row; index.js uploads that part as an rgba32float texture.
 */

import { NO_TARGET } from '../../src/effects/no-target.js';

/** @typedef {import('../../src/contracts/types.js').InputPoint} InputPoint */

/** quads per cell and side that the surface is drawn with (cloth.wgsl SUB) */
export const SUB = 4;
/** offsets in the head of a state */
export const S = Object.freeze({ W: 0, H: 1, CAMERA: 2, COLS: 3, ROWS: 4, MODE: 5, SERIAL: 6 });
export const HEAD = 8;
/** S.MODE: the frame shows the page unchanged (the cloth flat at rest), the cloth, or nothing of the page (the cloth has fallen away) */
export const FLAT = 0;
export const CLOTH = 1;
export const GONE = 2;
/** the camera looks at the middle of the canvas from this many times its larger side away (css px: CAMERA * max(W, H)) */
export const CAMERA = 1.6;

/** floats of the state of a cloth of cols x rows cells @param {number} cols @param {number} rows */
export const stateLength = (cols, rows) => HEAD + (cols + 3) * (rows + 3) * 4;

/** the four cubic B-spline weights at t in 0..1, into out[o..o+3] @param {number} t @param {Float64Array|number[]} out @param {number} o */
export function weights(t, out, o = 0) {
  const t2 = t * t, t3 = t2 * t, u = 1 - t;
  out[o] = (u * u * u) / 6; out[o + 1] = (3 * t3 - 6 * t2 + 4) / 6; out[o + 2] = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6; out[o + 3] = t3 / 6;
}

/** the weights at the SUB + 1 places k / SUB a cell is drawn at */
const TABLE = (() => { const w = new Float64Array(4 * (SUB + 1)); for (let k = 0; k <= SUB; k += 1) weights(k / SUB, w, 4 * k); return w; })();

/**
 * Write the control points of a frame into `state` (after its head): the particles at the share `alpha` of the way from where they were
 * one step ago (`p`) to where they are (`x`), then the ghost ring.
 * @param {Float32Array} state @param {{x: Float64Array, p: Float64Array, nx: number, ny: number}} c @param {number} alpha  0..1
 */
export function writeControlPoints(state, c, alpha) {
  const { x, p, nx, ny } = c;
  const pw = nx + 2, ph = ny + 2;
  for (let j = 0; j < ny; j += 1) {
    let o = HEAD + 4 * ((j + 1) * pw + 1), k = 3 * j * nx;
    for (let i = 0; i < nx; i += 1, o += 4, k += 3) {
      state[o] = p[k] + (x[k] - p[k]) * alpha; state[o + 1] = p[k + 1] + (x[k + 1] - p[k + 1]) * alpha; state[o + 2] = p[k + 2] + (x[k + 2] - p[k + 2]) * alpha;
    }
  }
  // ghosts, from the 32-bit values the surface is evaluated with: left and right of each row, then the rows above and below
  for (let j = 1; j <= ny; j += 1) {
    const l = HEAD + 4 * j * pw, r = l + 4 * (pw - 1);
    for (let a = 0; a < 3; a += 1) { state[l + a] = 2 * state[l + 4 + a] - state[l + 8 + a]; state[r + a] = 2 * state[r - 4 + a] - state[r - 8 + a]; }
  }
  const top = HEAD, bottom = HEAD + 4 * (ph - 1) * pw, row = 4 * pw;
  for (let o = 0; o < row; o += 1) {
    if ((o & 3) === 3) continue;
    state[top + o] = 2 * state[top + row + o] - state[top + 2 * row + o];
    state[bottom + o] = 2 * state[bottom - row + o] - state[bottom - 2 * row + o];
  }
}

/**
 * The point of the surface at the cell coordinates (s, t) (0..cols across, 0..rows down), written to out (x, y, z).
 * @param {Float32Array} state @param {number} s @param {number} t @param {number[]|Float64Array} out
 */
export function surfacePoint(state, s, t, out) {
  const cols = state[S.COLS], rows = state[S.ROWS], pw = cols + 3;
  const ci = Math.min(cols - 1, Math.max(0, Math.floor(s))), cj = Math.min(rows - 1, Math.max(0, Math.floor(t)));
  weights(s - ci, WX); weights(t - cj, WY);
  let x = 0, y = 0, z = 0;
  for (let j = 0; j < 4; j += 1) {
    let o = HEAD + 4 * ((cj + j) * pw + ci);
    const wy = WY[j];
    for (let i = 0; i < 4; i += 1, o += 4) { const w = wy * WX[i]; x += w * state[o]; y += w * state[o + 1]; z += w * state[o + 2]; }
  }
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}
const WX = new Float64Array(4), WY = new Float64Array(4);

/**
 * What `castCloth` keeps per state: the vertices of the drawn triangles as the camera sees them (screen x, y and 1 / distance), each
 * computed when a line of sight first needs it, and the screen box of every cell. Valid for one content of the state (its S.SERIAL).
 * @typedef {{serial: number, stamp: number, cols: number, rows: number, at: Float32Array, seen: Uint32Array, box: Float32Array}} Sight
 */
/** @type {WeakMap<Float32Array, Sight>} */
const sights = new WeakMap();
let stamps = 0;

/** @param {Float32Array} state @returns {Sight} */
function sightOf(state) {
  const cols = state[S.COLS], rows = state[S.ROWS];
  let g = sights.get(state);
  if (!g || g.cols !== cols || g.rows !== rows) {
    const vertices = (cols * SUB + 1) * (rows * SUB + 1);
    g = { serial: NaN, stamp: 0, cols, rows, at: new Float32Array(3 * vertices), seen: new Uint32Array(vertices), box: new Float32Array(4 * cols * rows) };
    sights.set(state, g);
  }
  if (g.serial === state[S.SERIAL]) return g;
  g.serial = state[S.SERIAL];
  g.stamp = (stamps += 1);
  // The screen box of each cell: its patch lies inside the convex hull of its 4 x 4 control points, and so does what the camera sees of it.
  const W = state[S.W], H = state[S.H], D = state[S.CAMERA], cx = W / 2, cy = H / 2, pw = cols + 3, ph = rows + 3;
  const px = PROJ.length >= 2 * pw * ph ? PROJ : (PROJ = new Float32Array(2 * pw * ph));
  for (let k = 0, o = HEAD; k < pw * ph; k += 1, o += 4) {
    const f = D / (D - state[o + 2]);
    px[2 * k] = cx + (state[o] - cx) * f; px[2 * k + 1] = cy + (state[o + 1] - cy) * f;
  }
  const box = g.box;
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let b = 0; b < 4; b += 1) {
        let k = 2 * ((j + b) * pw + i);
        for (let a = 0; a < 4; a += 1, k += 2) {
          const x = px[k], y = px[k + 1];
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      const o = 4 * (j * cols + i);
      box[o] = x0; box[o + 1] = y0; box[o + 2] = x1; box[o + 3] = y1;
    }
  }
  return g;
}
let PROJ = new Float32Array(0);

/**
 * The vertices of cell (ci, cj) as the camera sees them, computed once per state. A vertex on the border between two cells belongs to
 * the cell after it, as in cloth.wgsl (the last column and row to the last cell).
 * @param {Float32Array} state @param {Sight} g @param {number} ci @param {number} cj
 */
function seeCell(state, g, ci, cj) {
  const { cols, rows, at, seen, stamp } = g;
  const W = state[S.W], H = state[S.H], D = state[S.CAMERA], cx = W / 2, cy = H / 2, pw = cols + 3, fw = cols * SUB + 1;
  for (let b = 0; b <= SUB; b += 1) {
    const gy = cj * SUB + b;
    for (let a = 0; a <= SUB; a += 1) {
      const gx = ci * SUB + a, v = gy * fw + gx;
      if (seen[v] === stamp) continue;
      seen[v] = stamp;
      const vi = Math.min(cols - 1, Math.floor(gx / SUB)), vj = Math.min(rows - 1, Math.floor(gy / SUB));
      const wx = 4 * (gx - vi * SUB), wy = 4 * (gy - vj * SUB);
      let x = 0, y = 0, z = 0;
      for (let n = 0; n < 4; n += 1) {
        let o = HEAD + 4 * ((vj + n) * pw + vi);
        const wn = TABLE[wy + n];
        for (let m = 0; m < 4; m += 1, o += 4) { const w = wn * TABLE[wx + m]; x += w * state[o]; y += w * state[o + 1]; z += w * state[o + 2]; }
      }
      const inv = 1 / (D - z), f = D * inv;
      at[3 * v] = cx + (x - cx) * f; at[3 * v + 1] = cy + (y - cy) * f; at[3 * v + 2] = inv;
    }
  }
}

/**
 * @typedef {Object} Hit  what a line of sight meets first
 * @property {number} u  the page point, 0..1 across @property {number} v  0..1 down
 * @property {number} z  css px towards the viewer @property {boolean} front  the printed side faces the viewer
 */

/**
 * The first triangle of the drawn cloth that the line of sight through the presented point (px, py) meets (css px of the cloth's own
 * size state[S.W] x state[S.H]); false where it meets none (the wall shows). PURE: it reads `state` and a cache that only depends on it.
 * @param {Float32Array} state @param {number} px @param {number} py @param {Hit} hit  written when it returns true
 */
export function castCloth(state, px, py, hit) {
  const g = sightOf(state);
  const { cols, rows, at, box } = g;
  const fw = cols * SUB + 1, D = state[S.CAMERA];
  let best = 0, bu = 0, bv = 0, bfront = false;
  for (let cj = 0, c = 0; cj < rows; cj += 1) {
    for (let ci = 0; ci < cols; ci += 1, c += 4) {
      if (px < box[c] || px > box[c + 2] || py < box[c + 1] || py > box[c + 3]) continue;
      seeCell(state, g, ci, cj);
      for (let b = 0; b < SUB; b += 1) {
        const gy = cj * SUB + b;
        for (let a = 0; a < SUB; a += 1) {
          const gx = ci * SUB + a;
          // the quad's corners: top left, top right, bottom left, bottom right; drawn as the triangles (tl, bl, tr) and (tr, bl, br)
          const tl = 3 * (gy * fw + gx), tr = tl + 3, bl = tl + 3 * fw, br = bl + 3;
          const x1 = at[bl], y1 = at[bl + 1], x2 = at[tr], y2 = at[tr + 1];
          // quick reject: outside the box of the quad
          const xa = at[tl], ya = at[tl + 1], xb = at[br], yb = at[br + 1];
          if ((px < xa && px < x1 && px < x2 && px < xb) || (px > xa && px > x1 && px > x2 && px > xb) || (py < ya && py < y1 && py < y2 && py < yb) || (py > ya && py > y1 && py > y2 && py > yb)) continue;
          for (let half = 0; half < 2; half += 1) {
            // (tl, bl, tr) or (tr, bl, br): both wind the same way on screen; e < 0 where the printed side faces the viewer
            const p0 = half === 0 ? tl : tr, p2 = half === 0 ? tr : br;
            const x0 = at[p0], y0 = at[p0 + 1], xc = at[p2], yc = at[p2 + 1];
            const e = (x1 - x0) * (yc - y0) - (xc - x0) * (y1 - y0);
            if (e === 0) continue;
            const w1 = ((px - x0) * (yc - y0) - (xc - x0) * (py - y0)) / e, w2 = ((x1 - x0) * (py - y0) - (px - x0) * (y1 - y0)) / e, w0 = 1 - w1 - w2;
            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
            // 1 / distance is linear on screen, as the depth the GPU compares; the nearest triangle wins
            const i0 = w0 * at[p0 + 2], i1 = w1 * at[bl + 2], i2 = w2 * at[p2 + 2], inv = i0 + i1 + i2;
            if (inv <= best) continue;
            best = inv;
            // the page coordinates, interpolated in perspective. In fine cells: p0 is (gx, gy) or (gx + 1, gy), bl is (gx, gy + 1), p2 is (gx + 1, gy) or (gx + 1, gy + 1)
            bu = (i0 * (gx + half) + i1 * gx + i2 * (gx + 1)) / inv;
            bv = (i0 * gy + i1 * (gy + 1) + i2 * (gy + half)) / inv;
            bfront = e < 0;
          }
        }
      }
    }
  }
  if (best === 0) return false;
  hit.u = bu / (cols * SUB); hit.v = bv / (rows * SUB); hit.z = D - 1 / best; hit.front = bfront;
  return true;
}

const HIT = { u: 0, v: 0, z: 0, front: true };

/**
 * The input mapper formula: the page point that the presented point shows. The identity while the cloth hangs flat at rest (the frame is
 * the page); on the cloth, the page point of the nearest triangle on the line of sight where its printed side faces the viewer;
 * NO_TARGET on the back of the cloth and where the wall shows. PURE.
 * @param {Float32Array} state  the state of the presented frame @param {InputPoint} point  canvas css px, plus the presented size
 * @returns {{x: number, y: number}}
 */
export function mapClothPoint(state, point) {
  const mode = state[S.MODE];
  if (mode === FLAT) return { x: point.x, y: point.y };
  if (mode === GONE) return NO_TARGET;
  const width = Math.max(1, point.width), height = Math.max(1, point.height);
  if (!castCloth(state, (point.x * state[S.W]) / width, (point.y * state[S.H]) / height, HIT) || !HIT.front) return NO_TARGET;
  return { x: HIT.u * width, y: HIT.v * height };
}
