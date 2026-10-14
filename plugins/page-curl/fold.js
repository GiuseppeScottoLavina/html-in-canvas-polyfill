// The shape of the curling page, as pure math (no DOM, no GPU): index.js drives it, page-curl.wgsl draws it, the tests check it.
//
// The page is a sheet bound along one edge (the edge opposite the grabbed corner: the left edge for a right-hand corner, the right edge
// for a left-hand one). The reader holds a corner; the paper folds over along a straight line and rolls around a cylinder of radius R
// lying on that line: the part between the bound edge and the fold stays flat, the roll lifts, and the part beyond it lies flat again,
// back side up, 2R above the page, with the held corner exactly under the finger. Rolling a sheet around a cylinder is an isometry (the
// paper never stretches), so every distance along the sheet is kept; test/page-curl.test.mjs checks it.
//
// "Leaf space": x from the bound edge (0) to the opposite edge (W), y from the top (0) to the bottom (H), z towards the reader. For a
// sheet bound on the right, page x = W - leaf x (index.js `mirror` = -1).

/**
 * @typedef {Object} Fold
 * @property {number} nx  unit direction from the fold towards the held corner (leaf space)
 * @property {number} ny
 * @property {number} ax  a point on the fold axis
 * @property {number} ay
 * @property {number} R   roll radius, px (0: a sharp crease)
 * @property {number} L   how far the corner was pulled from where it rests, px (0: the leaf lies flat)
 */

/**
 * Where the point (x, y) of the flat leaf is under `fold`. Writes [X, Y, Z] at `out[o]` (leaf space) and returns which part it is on:
 * 0 flat on the book, 1 on the roll, 2 folded over (upside down).
 * @param {number} x @param {number} y @param {Fold} f @param {Float32Array|number[]} out @param {number} [o]
 */
export function foldPoint(x, y, f, out, o = 0) {
  const s = (x - f.ax) * f.nx + (y - f.ay) * f.ny;   // distance from the axis, towards the held corner
  if (f.L <= 0 || s <= 0) { out[o] = x; out[o + 1] = y; out[o + 2] = 0; return 0; }
  const R = f.R;
  if (R > 0 && s < Math.PI * R) {
    const phi = s / R;
    const back = s - R * Math.sin(phi);
    out[o] = x - f.nx * back; out[o + 1] = y - f.ny * back; out[o + 2] = R * (1 - Math.cos(phi));
    return 1;
  }
  const back = 2 * s - Math.PI * R;
  out[o] = x - f.nx * back; out[o + 1] = y - f.ny * back; out[o + 2] = 2 * R;
  return 2;
}

/**
 * The unit normal of the side of the leaf that faces up when it lies flat (the front of a leaf on the right), at the point (x, y). Writes
 * [nx, ny, nz] at `out[o]`.
 * @param {number} x @param {number} y @param {Fold} f @param {Float32Array|number[]} out @param {number} [o]
 */
export function foldNormal(x, y, f, out, o = 0) {
  const s = (x - f.ax) * f.nx + (y - f.ay) * f.ny;
  if (f.L <= 0 || s <= 0) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 1; return out; }
  const phi = f.R > 0 ? Math.min(Math.PI, s / f.R) : Math.PI;
  // the roll turns the surface about the axis: at phi the up-side normal is (-n sin(phi), cos(phi))
  out[o] = -f.nx * Math.sin(phi); out[o + 1] = -f.ny * Math.sin(phi); out[o + 2] = Math.cos(phi);
  return out;
}

const EPS = 1e-6;

/**
 * Keep the held corner where a bound sheet can put it: no farther from the spine end of its own edge than the width of the page, and no
 * farther from the other spine end than the page's diagonal (the two tears a real page would suffer). Writes `out` (leaf space).
 * @param {{x: number, y: number}} p  wanted corner position, leaf space
 * @param {'top'|'bottom'} lead  which corner is held
 * @param {number} W @param {number} H @param {{x: number, y: number}} out
 */
export function constrainCorner(p, lead, W, H, out) {
  let x = p.x, y = p.y;
  const ey = lead === 'bottom' ? H : 0;      // the spine end of the held corner's edge
  const oy = lead === 'bottom' ? 0 : H;      // the other spine end
  let dx = x, dy = y - ey, d = Math.hypot(dx, dy);
  if (d > W) { x = dx * W / d; y = ey + dy * W / d; }
  const diag = Math.hypot(W, H);
  dx = x; dy = y - oy; d = Math.hypot(dx, dy);
  if (d > diag) { x = dx * diag / d; y = oy + dy * diag / d; }
  out.x = x; out.y = y;
  return out;
}

/**
 * The fold that puts the held corner at `p` (leaf space; constrain it first) with a roll of radius at most `maxR`. The roll is never so wide
 * that it would lift the bound edge, and it closes as the leaf comes down on the other side. Writes `f`.
 * @param {{x: number, y: number}} p @param {'top'|'bottom'} lead @param {number} W @param {number} H @param {number} maxR @param {Fold} f
 */
export function foldFor(p, lead, W, H, maxR, f) {
  const cx = W, cy = lead === 'bottom' ? H : 0;
  const dx = cx - p.x, dy = cy - p.y;
  const L = Math.hypot(dx, dy);
  f.L = L;
  if (L < EPS) { f.nx = 1; f.ny = 0; f.ax = W; f.ay = cy; f.R = 0; return f; }
  const nx = dx / L, ny = dy / L;
  // the bound edge (x = 0) must stay flat: for both of its ends, distance from the axis <= 0, i.e. L + PI R <= 2 dot(C - end, n)
  const room = 2 * Math.min(cx * nx + cy * ny, cx * nx + (cy - H) * ny) - L;
  let R = Math.min(maxR, L / Math.PI, Math.max(0, room) / Math.PI);
  // near the end of a turn the leaf is almost flat on the other side: the roll closes smoothly onto it
  R = Math.min(R, Math.max(0, 2 * W - L) * 0.25);
  const dc = (L + Math.PI * R) / 2;
  f.nx = nx; f.ny = ny; f.ax = cx - nx * dc; f.ay = cy - ny * dc; f.R = R;
  return f;
}

/**
 * The camera of the effect: it looks straight down at the page from `distance` CSS px, so the plane z = 0 lands exactly on the page
 * (the flat page is drawn one to one) and a lifted point lands farther from the centre. PURE.
 * @param {number} X @param {number} Y @param {number} Z @param {number} W @param {number} H @param {number} distance @param {{x: number, y: number}} out
 */
export function project(X, Y, Z, W, H, distance, out) {
  const k = distance / Math.max(1, distance - Z);
  out.x = W / 2 + (X - W / 2) * k;
  out.y = H / 2 + (Y - H / 2) * k;
  return out;
}

/** The point at height Z that `project` puts at (x, y). PURE. @param {number} x @param {number} y @param {number} Z @param {number} W @param {number} H @param {number} distance @param {{x: number, y: number}} out */
export function unproject(x, y, Z, W, H, distance, out) {
  const k = Math.max(1, distance - Z) / distance;
  out.x = W / 2 + (x - W / 2) * k;
  out.y = H / 2 + (y - H / 2) * k;
  return out;
}

/** Seconds of one step of the spring: the simulation advances in fixed steps on the frame clock, so a pose depends only on the time. */
export const SPRING_STEP = 1 / 240;

/**
 * One fixed step of a damped spring pulling `state.x` towards `goal` (semi-implicit Euler).
 * @param {{x: number, v: number}} state @param {number} goal @param {number} omega rad/s @param {number} zeta
 */
export function springStep(state, goal, omega, zeta) {
  const a = omega * omega * (goal - state.x) - 2 * zeta * omega * state.v;
  state.v += a * SPRING_STEP;
  state.x += state.v * SPRING_STEP;
  return state;
}
