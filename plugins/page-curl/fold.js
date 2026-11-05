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
//
// The roll is a cone, not only a cylinder (`coneFor`): paper held by a corner and pulled across the page does not roll with one radius
// along the whole fold. Where the held corner lies near one end of the fold the paper rolls widely there and tightly towards the other
// end, as real paper and the page curl of e-book readers do (the cone deformation of Hong, Card and Chen, "Turning pages of 3D electronic
// books", IEEE 3DUI 2006). The cone lies on the page along the fold line, its apex beyond the curled part of the page; the paper wraps
// half way round it and the rest lies flat on the plane that touches the cone along its top line, tilted (the flap rises away from the
// apex). Wrapping a sheet round a cone is an isometry too. A cone of half angle 0 is the cylinder (`k` = 0).

/**
 * @typedef {Object} Fold
 * @property {number} nx  unit direction from the fold towards the held corner (leaf space)
 * @property {number} ny
 * @property {number} ax  a point on the fold axis
 * @property {number} ay
 * @property {number} R   roll radius, px (0: a sharp crease)
 * @property {number} L   how far the corner was pulled from where it rests, px (0: the leaf lies flat)
 * @property {number} [k]   sine of the cone's half angle (0 or absent: a cylinder of radius R)
 * @property {number} [ca]  its cosine
 * @property {number} [wA]  the apex, on the fold axis: a + t wA, with t = (-ny, nx)
 * @property {number} [gs]  +1 or -1: g = gs t, the direction from the apex along the fold line towards the page
 */

/**
 * Where the point (x, y) of the flat leaf is under `fold`. Writes [X, Y, Z] at `out[o]` (leaf space) and returns which part it is on:
 * 0 flat on the book, 1 on the roll, 2 folded over (upside down).
 * @param {number} x @param {number} y @param {Fold} f @param {Float32Array|number[]} out @param {number} [o]
 */
export function foldPoint(x, y, f, out, o = 0) {
  const s = (x - f.ax) * f.nx + (y - f.ay) * f.ny;   // distance from the axis, towards the held corner
  if (f.L <= 0 || s <= 0) { out[o] = x; out[o + 1] = y; out[o + 2] = 0; return 0; }
  if (f.k && f.k > 0) {
    const c = conePoint(x, y, s, f);
    const gx = -f.ny * /** @type {number} */ (f.gs), gy = f.nx * /** @type {number} */ (f.gs);
    out[o] = x + f.nx * c[0] + gx * c[1]; out[o + 1] = y + f.ny * c[0] + gy * c[1]; out[o + 2] = c[2];
    return c[3];
  }
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
  if (f.k && f.k > 0) {
    const b = conePoint(x, y, s, f)[4], k = f.k, ca = /** @type {number} */ (f.ca), gs = /** @type {number} */ (f.gs);
    // the up side's normal at the line of the cone at angle b: g k ca (1 - cos b) - n ca sin b + z (k^2 + ca^2 cos b)
    const ag = k * ca * (1 - Math.cos(b)), an = -ca * Math.sin(b);
    out[o] = f.nx * an - f.ny * gs * ag; out[o + 1] = f.ny * an + f.nx * gs * ag; out[o + 2] = k * k + ca * ca * Math.cos(b);
    return out;
  }
  const phi = f.R > 0 ? Math.min(Math.PI, s / f.R) : Math.PI;
  // the roll turns the surface about the axis: at phi the up-side normal is (-n sin(phi), cos(phi))
  out[o] = -f.nx * Math.sin(phi); out[o + 1] = -f.ny * Math.sin(phi); out[o + 2] = Math.cos(phi);
  return out;
}

const coneOut = [0, 0, 0, 0, 0];
/**
 * A point of the curled part (s > 0) on the cone of `f`: [dn, dg, z, part, b], how far it moves along n and along g, its height, the part
 * (1 roll, 2 flap) and the angle b round the cone (PI on the flap). In the apex's polar frame (rho along g, s along n; r, th) the roll is
 * th < PI k (b = th / k: the arc r dth of the sheet is the arc r k db of the cone); the flap unrolls the rest onto the plane that touches
 * the cone along its top line. Written without the apex's large coordinates, so a far apex (a nearly cylindrical roll) stays exact in
 * 32-bit floats too (page-curl.wgsl cone_point is its twin).
 * @param {number} x @param {number} y @param {number} s @param {Fold} f
 */
function conePoint(x, y, s, f) {
  const k = /** @type {number} */ (f.k), ca = /** @type {number} */ (f.ca);
  const w = -(x - f.ax) * f.ny + (y - f.ay) * f.nx;
  const rho = /** @type {number} */ (f.gs) * (w - /** @type {number} */ (f.wA));
  const r = Math.hypot(rho, s), th = Math.atan2(s, rho);
  const c = coneOut;
  // beyond the apex nothing is curled (coneFor puts the apex beyond the curl): a point there lies on the fold line, by rounding past it
  if (rho <= 0) { c[0] = 0; c[1] = 0; c[2] = 0; c[3] = 0; c[4] = 0; return c; }
  if (th < Math.PI * k) {
    const b = th / k;
    c[0] = r * k * Math.sin(b) - s;
    c[1] = (s * s) / (r + rho) - r * k * k * (1 - Math.cos(b));
    c[2] = r * k * ca * (1 - Math.cos(b)); c[3] = 1; c[4] = b;
  } else {
    const tp = th - Math.PI * k, r1 = r * Math.cos(tp);
    c[0] = -r * Math.sin(tp) - s;
    c[1] = 2 * r * Math.sin(th - (Math.PI * k) / 2) * Math.sin((Math.PI * k) / 2) - 2 * k * k * r1;
    c[2] = 2 * k * ca * r1; c[3] = 2; c[4] = Math.PI;
  }
  return c;
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

/** the curled part of the page (leaf space, s > 0): its corners, as [x0, y0, x1, y1, ...] in `poly` (reused); returns their count */
const poly = new Float64Array(16);
function curledPolygon(/** @type {Fold} */ f, /** @type {number} */ W, /** @type {number} */ H) {
  const P = [0, 0, W, 0, W, H, 0, H];
  let m = 0;
  for (let i = 0; i < 4; i += 1) {
    const x0 = P[2 * i], y0 = P[2 * i + 1], x1 = P[(2 * i + 2) % 8], y1 = P[(2 * i + 3) % 8];
    const s0 = (x0 - f.ax) * f.nx + (y0 - f.ay) * f.ny, s1 = (x1 - f.ax) * f.nx + (y1 - f.ay) * f.ny;
    if (s0 > 0) { poly[2 * m] = x0; poly[2 * m + 1] = y0; m += 1; }
    if ((s0 > 0) !== (s1 > 0)) { const t = s0 / (s0 - s1); poly[2 * m] = x0 + (x1 - x0) * t; poly[2 * m + 1] = y0 + (y1 - y0) * t; m += 1; }
  }
  return m;
}

/** at most this much taper: the roll at the far end of the curl is this fraction of the roll at the held corner */
export const TAPER = 0.3;
/** beyond this distance of the apex the cone is a cylinder (k = 0) */
const FAR_APEX = 2e5;
/** the sharpest cone: half angle about 17 degrees */
const K_MAX = 0.3;

/**
 * Make the roll of `f` (from foldFor) a cone: the roll keeps the radius f.R at the held corner and narrows towards the far end of the curl
 * as much as the held corner is off the middle of the curl (`taper`: the radius at the far end, as a fraction, when the corner lies at one
 * end; 1: always a cylinder). Writes f.k, f.ca, f.wA, f.gs, and the reach of the curl from the apex (`span`: [r0, r1, thEnd], the strip
 * of page-curl.wgsl covers it). Returns f.
 * @param {Fold} f @param {'top'|'bottom'} lead @param {number} W @param {number} H @param {number} taper @param {number[]|Float32Array} [span]
 */
export function coneFor(f, lead, W, H, taper = TAPER, span) {
  f.k = 0; f.ca = 1; f.wA = 0; f.gs = 1;
  if (span) { span[0] = 0; span[1] = 0; span[2] = 0; }
  if (!(f.L > 0) || !(f.R > 0) || !(taper < 1)) return f;
  const cx = W, cy = lead === 'bottom' ? H : 0;
  const tx = -f.ny, ty = f.nx;
  const wC = (cx - f.ax) * tx + (cy - f.ay) * ty, sC = (cx - f.ax) * f.nx + (cy - f.ay) * f.ny;
  const m = curledPolygon(f, W, H);
  // the fold line across the page (the polygon's corners with s = 0) and the whole curl, along the axis
  let e0 = Infinity, e1 = -Infinity, w0 = Infinity, w1 = -Infinity;
  for (let i = 0; i < m; i += 1) {
    const x = poly[2 * i], y = poly[2 * i + 1];
    const w = (x - f.ax) * tx + (y - f.ay) * ty;
    w0 = Math.min(w0, w); w1 = Math.max(w1, w);
    if (Math.abs((x - f.ax) * f.nx + (y - f.ay) * f.ny) < 1e-6 * (W + H)) { e0 = Math.min(e0, w); e1 = Math.max(e1, w); }
  }
  if (!(e1 > e0)) return f;
  // how far off the middle of the fold the corner's foot is (0 in the middle, 1 half way to one end or beyond), eased
  const d0 = Math.max(0, wC - e0), d1 = Math.max(0, e1 - wC);
  const off = Math.min(1, (2 * Math.abs(d1 - d0)) / Math.max(d0 + d1, EPS));
  const q = 1 - (1 - taper) * off * off * (3 - 2 * off);
  f.gs = d1 > d0 ? -1 : 1;                 // g points from the apex towards the page
  // the apex from the corner's foot: beyond the far end of the fold, where the roll narrows to q, and beyond the whole curl; the cone is
  // never sharper than K_MAX
  const far = Math.max(d0, d1), farCurl = f.gs < 0 ? w1 - wC : wC - w0;
  const dA = Math.max(far / Math.max(1 - q, EPS), 1.08 * farCurl + 4, Math.sqrt(Math.max(0, (f.R / K_MAX) ** 2 - sC * sC)));
  if (dA > FAR_APEX) return f;
  f.wA = wC - f.gs * dA;
  const rC = Math.hypot(dA, sC);
  f.k = f.R / rC;                           // the corner's own line of the cone has the roll radius R
  f.ca = Math.sqrt(1 - f.k * f.k);
  if (span) {
    let r0 = Infinity, r1 = 0, te = Math.PI * f.k;
    for (let i = 0; i < m; i += 1) {
      const x = poly[2 * i], y = poly[2 * i + 1];
      const rho = f.gs * ((x - f.ax) * tx + (y - f.ay) * ty - f.wA), s = (x - f.ax) * f.nx + (y - f.ay) * f.ny;
      r0 = Math.min(r0, rho); r1 = Math.max(r1, Math.hypot(rho, s)); te = Math.max(te, Math.atan2(s, rho));
    }
    te += 0.002;
    span[0] = Math.max(0, r0 - 2);
    span[1] = (r1 + 2) / Math.cos(Math.min(1.4, te - Math.PI * f.k) / 2);   // the flap is one wedge: its outer chord must clear the page
    span[2] = te;
  }
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
