/**
 * The cloth of the cloth plugin: a grid of particles advanced at a fixed rate (STEP_HZ, independent of the display and of the frame cap)
 * by a position-based solver. PURE: no DOM, no GPU; index.js uploads the positions and surface.js reads the same numbers for the input
 * mapper.
 *
 * Units: positions in CSS px of the canvas (x to the right, y down, z towards the viewer; the cloth at rest lies in the plane z = 0 and
 * covers the canvas), time in seconds, every particle has the mass 1 (forces are accelerations).
 *
 * One step (`step`):
 *   1. forces: gravity, the air (a drag on the motion along the surface normal and a smaller one along the surface, both relative to the
 *      wind), the hand that holds the cloth (a damped spring with a bounded force);
 *   2. the particles move;
 *   3. distance constraints, one pass, the small steps doing the work of iterations (Macklin et al., "Small Steps in Physics Simulation",
 *      2019): the weave (rigid), the shear across each cell (compliant: woven cloth shears easily) and the bending across two cells
 *      (compliant: it sets the width of the folds);
 *   4. the tethers (Kim et al., "Long Range Attachments", 2012): no particle is further from a pin than the cloth between them is long.
 *      One pass of the weave alone would let the cloth stretch under its own weight like rubber; the tethers make the hanging cloth
 *      inextensible exactly, and the flat hanging pose an exact fixed point of the step;
 *   5. the wall behind the cloth, with friction;
 *   6. the velocities follow from the positions.
 */

/** simulation steps per second (fixed time step) */
export const STEP_HZ = 480;
export const STEP_S = 1 / STEP_HZ;
export const STEP_MS = 1000 / STEP_HZ;
/** at most this many steps per rendered frame (125 ms): a longer gap (an off-screen pause, a frame cap of 1) is skipped, not caught up */
export const MAX_STEPS_PER_FRAME = 60;
/** about this many cells, whatever the shape of the canvas; a side has at least MIN_SIDE cells */
export const CELLS = 1040;
export const MIN_SIDE = 12;
export const MAX_SIDE = 72;
/**
 * Gravity, in canvas heights per second squared: a cloth as tall as the canvas swings like a sheet of about 0.75 m (the first mode of a
 * hanging sheet has the period 5.23 sqrt(height / g): 1.45 s), on a phone as on a desktop.
 */
export const GRAVITY = 13;
/** the wall behind the cloth, as a share of the smaller side of the canvas, and the friction of the cloth on it (the share of the sliding lost per step) */
export const WALL_GAP = 0.085;
export const WALL_FRICTION = 0.25;
/** the longest span (in cells, a power of two) that is held to its length (step 4 of `step`) */
export const SPAN_MAX = 32;
/** compliance of the shear diagonals and of the bending, as the dimensionless XPBD term alpha / h^2 (0: rigid) */
export const SHEAR = 6;
/** where the two pins of `corners` hold the cloth: this share of the width in from where the corners hang flat, so that the cloth has slack */
export const CORNER_SLACK = 0.02;
/** s: a pin that is moved (the cloth hung again, the pins changed) follows its place with this time constant */
export const PIN_TAU = 0.11;
/** the hand: natural frequency (rad/s) and the largest acceleration of the spring that holds the cloth, in gravities */
export const GRAB_OMEGA = 90;
export const GRAB_MAX_G = 60;
/** the cloth under the hand: particles within GRAB_REACH cells are held, the nearest ones hardest (a Gaussian of GRAB_SIGMA cells) */
export const GRAB_SIGMA = 0.85;
export const GRAB_REACH = 2.2;
/**
 * Rest. The cloth sleeps once no particle is faster than SLEEP_SPEED css px/s for SLEEP_S seconds. Where it hangs flat when it is still
 * (pinned along its top edge), the last part of the way is taken by the hand: within ASSIST_PX of the flat pose and slower than
 * ASSIST_SPEED it is drawn onto that pose with the time constant ASSIST_TAU, and it is the flat pose exactly when the rest is below SNAP_PX.
 */
export const SLEEP_SPEED = 1.2;
export const SLEEP_S = 0.2;
export const ASSIST_PX = 0.4;
export const ASSIST_SPEED = 8;
export const ASSIST_TAU = 0.045;
export const SNAP_PX = 0.012;
/** how much a displacement towards or away from the viewer counts against one across the canvas (it moves a pixel that much less) */
const DEPTH_SHARE = 0.3;

/** @typedef {'top'|'corners'|'none'} Pins */
/**
 * @typedef {Object} Gust  a front of wind that crosses the cloth
 * @property {number} t0  the time (cloth clock, s) at which its leading edge reaches the cloth
 * @property {number} dx  the direction it travels along the cloth, a unit vector
 * @property {number} dy
 * @property {number} strength
 */
/**
 * @typedef {Object} Cloth
 * @property {number} width  css px @property {number} height
 * @property {number} cols  cells across @property {number} rows  cells down
 * @property {number} nx  particles across (cols + 1) @property {number} ny @property {number} n
 * @property {number} lx  css px between particles at rest @property {number} ly
 * @property {Float64Array} x  positions (3 per particle, row by row from the top)
 * @property {Float64Array} p  positions one step ago
 * @property {Float64Array} v  velocities
 * @property {Float64Array} rest  the flat pose
 * @property {Float64Array} w  inverse mass: 1, or 0 for a particle that is held by a pin
 * @property {Float64Array} pinAt  where each pin is going (3 per particle; read for the particles with w = 0)
 * @property {Float64Array} nrm  surface normals of the last step
 * @property {Pins} pins
 * @property {{a: Int32Array, b: Int32Array, len: Float64Array, weave: number, shear: number, count: number}} links
 * @property {{a: Int32Array, b: Int32Array, len: Float64Array, count: number}} spans
 * @property {{pin: Int32Array, len: Float64Array, per: number}} tethers
 * @property {number} gravity  css px / s^2
 * @property {number} wall  z of the wall (negative)
 * @property {number} dragN  1/s, on the motion along the normal @property {number} dragT  1/s, on all motion
 * @property {number} bend  compliance of the bending (alpha / h^2)
 * @property {number} wind  the breeze, 0..1 @property {Gust[]} gusts
 * @property {{idx: Int32Array, wt: Float64Array, count: number, sum: number, x: number, y: number, z: number, on: boolean}} grab
 * @property {{t0: number, seconds: number, done: number}|null} peel  the pins are letting go, from the left (`drop`)
 * @property {number} time  s of simulated time @property {number} quiet  s for which the cloth has been slow
 * @property {boolean} asleep  nothing moves; `step` does nothing until `wake`
 * @property {boolean} flat  asleep in the flat pose exactly
 * @property {number} speed  the largest speed of a particle at the last step (css px/s) @property {number} away  the largest distance from the flat pose
 */

/**
 * The grid for a canvas of this size: about CELLS cells, as square as the sides allow. PURE.
 * @param {number} width @param {number} height
 */
export function gridOf(width, height) {
  const side = (/** @type {number} */ v) => Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.round(v)));
  const cols = side(Math.sqrt((CELLS * Math.max(1, width)) / Math.max(1, height)));
  return { cols, rows: side(CELLS / cols) };
}

/**
 * A cloth of the size of the canvas, hanging flat and still from its top edge.
 * @param {number} width @param {number} height  css px
 * @returns {Cloth}
 */
export function createCloth(width, height) {
  const { cols, rows } = gridOf(width, height);
  const nx = cols + 1, ny = rows + 1, n = nx * ny;
  const lx = width / cols, ly = height / rows;
  const rest = new Float64Array(3 * n);
  for (let j = 0; j < ny; j += 1) for (let i = 0; i < nx; i += 1) { const k = 3 * (j * nx + i); rest[k] = i * lx; rest[k + 1] = j * ly; }
  // the links, in the order they are solved: down the cloth from the pinned edge (a pass carries the pins' hold towards the hem), across it,
  // the two diagonals of each cell, then the bending across two cells
  /** @type {number[]} */ const a = [];
  /** @type {number[]} */ const b = [];
  /** @type {number[]} */ const len = [];
  const link = (/** @type {number} */ i0, /** @type {number} */ j0, /** @type {number} */ i1, /** @type {number} */ j1) => {
    a.push(j0 * nx + i0); b.push(j1 * nx + i1); len.push(Math.hypot((i1 - i0) * lx, (j1 - j0) * ly));
  };
  for (let j = 0; j < rows; j += 1) for (let i = 0; i < nx; i += 1) link(i, j, i, j + 1);
  for (let j = 0; j < ny; j += 1) for (let i = 0; i < cols; i += 1) link(i, j, i + 1, j);
  const weave = a.length;
  for (let j = 0; j < rows; j += 1) for (let i = 0; i < cols; i += 1) { link(i, j, i + 1, j + 1); link(i + 1, j, i, j + 1); }
  const shear = a.length;
  for (let j = 0; j < rows - 1; j += 1) for (let i = 0; i < nx; i += 1) link(i, j, i, j + 2);
  for (let j = 0; j < ny; j += 1) for (let i = 0; i < cols - 1; i += 1) link(i, j, i + 2, j);
  // the spans, the longest first: two particles of one thread are never further apart than the thread between them is long
  /** @type {number[]} */ const sa = [];
  /** @type {number[]} */ const sb = [];
  /** @type {number[]} */ const sl = [];
  for (let s = SPAN_MAX; s >= 2; s >>= 1) {
    const half = s >> 1;
    for (let i = 0; i < nx; i += 1) for (let j = 0; j + s < ny; j += half) { sa.push(j * nx + i); sb.push((j + s) * nx + i); sl.push(s * ly); }
    for (let j = 0; j < ny; j += 1) for (let i = 0; i + s < nx; i += half) { sa.push(j * nx + i); sb.push(j * nx + i + s); sl.push(s * lx); }
  }
  const reach = Math.ceil(GRAB_REACH) * 2 + 2;
  /** @type {Cloth} */
  const c = {
    width, height, cols, rows, nx, ny, n, lx, ly,
    x: rest.slice(), p: rest.slice(), v: new Float64Array(3 * n), rest, w: new Float64Array(n).fill(1), pinAt: rest.slice(), nrm: new Float64Array(3 * n),
    pins: 'none',
    links: { a: Int32Array.from(a), b: Int32Array.from(b), len: Float64Array.from(len), weave, shear, count: a.length },
    spans: { a: Int32Array.from(sa), b: Int32Array.from(sb), len: Float64Array.from(sl), count: sa.length },
    tethers: { pin: new Int32Array(2 * n).fill(-1), len: new Float64Array(2 * n), per: 0 },
    gravity: GRAVITY * height, wall: -WALL_GAP * Math.min(width, height), dragN: 4, dragT: 2.4, bend: 120, wind: 0, gusts: [],
    grab: { idx: new Int32Array(reach * reach), wt: new Float64Array(reach * reach), count: 0, sum: 0, x: 0, y: 0, z: 0, on: false },
    peel: null, time: 0, quiet: 0, asleep: true, flat: true, speed: 0, away: 0,
  };
  for (let k = 0; k < n; k += 1) c.nrm[3 * k + 2] = 1;
  setPins(c, 'top');
  return c;
}

/**
 * How the cloth is held: 'top' along its whole top edge (it hangs flat), 'corners' by its two top corners, each CORNER_SLACK of the width
 * further in (it sags between them), 'none' not at all (it falls). The pins take hold of the particles where they are and carry them to
 * their places (`step`, PIN_TAU); the tethers are those of the new pins.
 * @param {Cloth} c @param {Pins} pins
 */
export function setPins(c, pins) {
  const { nx, n, tethers } = c;
  c.pins = pins;
  c.peel = null;
  c.w.fill(1);
  tethers.pin.fill(-1);
  tethers.per = pins === 'top' ? 1 : pins === 'corners' ? 2 : 0;
  if (pins === 'top') {
    for (let i = 0; i < nx; i += 1) { c.w[i] = 0; c.pinAt[3 * i] = c.rest[3 * i]; c.pinAt[3 * i + 1] = 0; c.pinAt[3 * i + 2] = 0; }
    // each particle hangs from the pin of its own column
    for (let k = nx; k < n; k += 1) { tethers.pin[k] = k % nx; tethers.len[k] = c.rest[3 * k + 1]; }
  } else if (pins === 'corners') {
    const left = 0, right = nx - 1;
    c.w[left] = 0; c.w[right] = 0;
    c.pinAt[0] = CORNER_SLACK * c.width; c.pinAt[1] = 0; c.pinAt[2] = 0;
    c.pinAt[3 * right] = (1 - CORNER_SLACK) * c.width; c.pinAt[3 * right + 1] = 0; c.pinAt[3 * right + 2] = 0;
    for (let k = 0; k < n; k += 1) {
      if (k === left || k === right) continue;
      const x = c.rest[3 * k], y = c.rest[3 * k + 1];
      tethers.pin[2 * k] = left; tethers.len[2 * k] = Math.hypot(x, y);
      tethers.pin[2 * k + 1] = right; tethers.len[2 * k + 1] = Math.hypot(c.width - x, y);
    }
  }
  wake(c);
}

/** The cloth may move again. @param {Cloth} c */
export function wake(c) {
  c.asleep = false; c.flat = false; c.quiet = 0;
}

/** The flat pose, still, at once. @param {Cloth} c */
export function layFlat(c) {
  c.x.set(c.rest); c.p.set(c.rest); c.v.fill(0);
  c.grab.on = false; c.gusts.length = 0;
  c.asleep = true; c.flat = true; c.quiet = 0; c.speed = 0; c.away = 0;
}

/**
 * A push: the particles around the point (s, t) of the cloth (in cells: 0..cols across, 0..rows down) gain the velocity (dx, dy, dz),
 * falling off as a Gaussian of `radius` css px (measured on the cloth).
 * @param {Cloth} c @param {number} s @param {number} t @param {number} radius @param {number} dx @param {number} dy @param {number} dz
 */
export function push(c, s, t, radius, dx, dy, dz) {
  const { nx, ny, lx, ly, v, w } = c;
  const ri = Math.ceil((2.6 * radius) / lx), rj = Math.ceil((2.6 * radius) / ly);
  const i0 = Math.max(0, Math.floor(s) - ri), i1 = Math.min(nx - 1, Math.ceil(s) + ri);
  const j0 = Math.max(0, Math.floor(t) - rj), j1 = Math.min(ny - 1, Math.ceil(t) + rj);
  const k2 = 1 / (2 * radius * radius);
  for (let j = j0; j <= j1; j += 1) {
    for (let i = i0; i <= i1; i += 1) {
      const k = j * nx + i;
      if (w[k] === 0) continue;
      const g = Math.exp(-(((i - s) * lx) ** 2 + ((j - t) * ly) ** 2) * k2);
      v[3 * k] += dx * g; v[3 * k + 1] += dy * g; v[3 * k + 2] += dz * g;
    }
  }
  wake(c);
}

/**
 * A hand takes the cloth at the point (s, t) (in cells) and holds it at (x, y, z): the particles under it follow that point on a spring
 * (`holdAt` moves it, `letGo` ends it). @param {Cloth} c @param {number} s @param {number} t @param {number} x @param {number} y @param {number} z
 */
export function take(c, s, t, x, y, z) {
  const { nx, ny, grab } = c;
  const r = Math.ceil(GRAB_REACH);
  let count = 0, sum = 0;
  for (let j = Math.max(0, Math.floor(t) - r); j <= Math.min(ny - 1, Math.ceil(t) + r); j += 1) {
    for (let i = Math.max(0, Math.floor(s) - r); i <= Math.min(nx - 1, Math.ceil(s) + r); i += 1) {
      const d2 = (i - s) ** 2 + (j - t) ** 2;
      if (d2 > GRAB_REACH * GRAB_REACH || c.w[j * nx + i] === 0 || count >= grab.idx.length) continue;
      const g = Math.exp(-d2 / (2 * GRAB_SIGMA * GRAB_SIGMA));
      grab.idx[count] = j * nx + i; grab.wt[count] = g; sum += g; count += 1;
    }
  }
  grab.count = count; grab.sum = sum; grab.on = count > 0;
  grab.x = x; grab.y = y; grab.z = z;
  wake(c);
}

/** @param {Cloth} c @param {number} x @param {number} y @param {number} z */
export function holdAt(c, x, y, z) {
  c.grab.x = x; c.grab.y = y; c.grab.z = z;
  if (c.grab.on) wake(c);
}

/** @param {Cloth} c */
export function letGo(c) {
  if (c.grab.on) wake(c);
  c.grab.on = false;
}

/** Where the cloth under the hand is: the weighted centre of the held particles, written to `out`. @param {Cloth} c @param {number[]} out */
export function heldPoint(c, out) {
  const { grab, x } = c;
  let px = 0, py = 0, pz = 0;
  for (let m = 0; m < grab.count; m += 1) { const k = 3 * grab.idx[m], g = grab.wt[m]; px += g * x[k]; py += g * x[k + 1]; pz += g * x[k + 2]; }
  const inv = grab.sum > 0 ? 1 / grab.sum : 0;
  out[0] = px * inv; out[1] = py * inv; out[2] = pz * inv;
  return out;
}

/**
 * A gust: a front of wind that reaches the cloth at the cloth's time `t0` and crosses it along (dx, dy) (a direction on the cloth; a zero
 * vector blows at the whole cloth at once). @param {Cloth} c @param {number} t0 @param {number} dx @param {number} dy @param {number} strength
 */
export function gust(c, t0, dx, dy, strength) {
  const l = Math.hypot(dx, dy);
  c.gusts.push({ t0, dx: l > 1e-9 ? dx / l : 0, dy: l > 1e-9 ? dy / l : 0, strength });
  wake(c);
}

/** how fast a gust crosses the cloth (canvas diagonals per second), how long its front is (a share of the diagonal), and its wind at strength 1 (canvas heights per second) */
export const GUST_SPEED = 2.2;
export const GUST_LENGTH = 0.4;
export const GUST_WIND = 1.2;
/** the breeze of the option `wind` at 1, in canvas heights per second */
export const BREEZE_WIND = 1.7;

/** the seconds a gust takes to cross the cloth and leave it. @param {Gust} g */
export const gustSeconds = (g) => (g.dx === 0 && g.dy === 0 ? 0.55 : (1 + 2 * GUST_LENGTH) / GUST_SPEED);

const wind3 = [0, 0, 0];
/**
 * The wind at the rest place (x, y) of a particle at time t, written to wind3 (css px/s). The breeze blows from the left and away from the
 * wall, in slow swells that travel along the cloth; a gust is one front (a raised cosine) that blows along its direction and away from
 * the wall. PURE apart from wind3.
 * @param {Cloth} c @param {number} x @param {number} y @param {number} t
 */
function windAt(c, x, y, t) {
  let wx = 0, wy = 0, wz = 0;
  const H = c.height, diag = Math.hypot(c.width, c.height);
  if (c.wind > 0) {
    const u = c.wind * BREEZE_WIND * H, kx = (2 * Math.PI) / diag;
    const a = Math.sin(kx * (1.1 * x + 0.35 * y) - 2.3 * t), b = Math.sin(kx * (2.3 * x - 0.6 * y) - 3.7 * t + 1.3), s = Math.sin(0.83 * t + 0.4);
    wz += u * (0.34 + 0.3 * s + 0.26 * a + 0.16 * b);
    wx += u * (0.3 + 0.12 * a);
    wy += u * 0.05 * b;
  }
  for (let m = 0; m < c.gusts.length; m += 1) {
    const g = c.gusts[m];
    let e;
    if (g.dx === 0 && g.dy === 0) {
      const k = (t - g.t0) / 0.55;
      e = k > 0 && k < 1 ? Math.sin(Math.PI * k) ** 2 : 0;
    } else {
      // how far behind the leading edge this particle is, in front lengths (the edge enters at the side the gust comes from)
      const along = x * g.dx + y * g.dy - Math.min(0, g.dx * c.width) - Math.min(0, g.dy * c.height);
      const k = ((t - g.t0) * GUST_SPEED * diag - along) / (2 * GUST_LENGTH * diag);
      e = k > 0 && k < 1 ? Math.sin(Math.PI * k) ** 2 : 0;
    }
    if (e === 0) continue;
    const u = g.strength * GUST_WIND * H * e;
    wz += u; wx += 0.3 * u * g.dx; wy += 0.3 * u * g.dy;
  }
  wind3[0] = wx; wind3[1] = wy; wind3[2] = wz;
}

/** The surface normals at the particles (central differences of their neighbours), into c.nrm. @param {Cloth} c */
function normals(c) {
  const { nx, ny, x, nrm } = c;
  for (let j = 0; j < ny; j += 1) {
    const ju = (j > 0 ? j - 1 : j) * nx, jd = (j < ny - 1 ? j + 1 : j) * nx, row = j * nx;
    for (let i = 0; i < nx; i += 1) {
      const l = 3 * (row + (i > 0 ? i - 1 : i)), r = 3 * (row + (i < nx - 1 ? i + 1 : i)), u = 3 * (ju + i), d = 3 * (jd + i);
      const ax = x[r] - x[l], ay = x[r + 1] - x[l + 1], az = x[r + 2] - x[l + 2];
      const bx = x[d] - x[u], by = x[d + 1] - x[u + 1], bz = x[d + 2] - x[u + 2];
      const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
      const inv = 1 / Math.sqrt(cx * cx + cy * cy + cz * cz + 1e-18);
      const k = 3 * (row + i);
      nrm[k] = cx * inv; nrm[k + 1] = cy * inv; nrm[k + 2] = cz * inv;
    }
  }
}

/**
 * Solve the links k0 .. k1 once: each moves its two particles along the line between them, by their inverse masses, towards its length;
 * `soft` is its compliance (alpha / h^2; 0: rigid).
 * @param {Float64Array} x @param {Float64Array} w @param {Int32Array} a @param {Int32Array} b @param {Float64Array} len
 * @param {number} k0 @param {number} k1 @param {number} soft
 */
function solve(x, w, a, b, len, k0, k1, soft) {
  for (let k = k0; k < k1; k += 1) {
    const i = a[k], j = b[k], i3 = 3 * i, j3 = 3 * j;
    const wi = w[i], wj = w[j], ws = wi + wj;
    if (ws === 0) continue;
    const dx = x[j3] - x[i3], dy = x[j3 + 1] - x[i3 + 1], dz = x[j3 + 2] - x[i3 + 2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 1e-9) continue;
    const s = (d - len[k]) / (d * (ws + soft));
    const si = wi * s, sj = wj * s;
    x[i3] += si * dx; x[i3 + 1] += si * dy; x[i3 + 2] += si * dz;
    x[j3] -= sj * dx; x[j3 + 1] -= sj * dy; x[j3 + 2] -= sj * dz;
  }
}

/**
 * One step of STEP_S seconds. Does nothing while the cloth is asleep.
 * @param {Cloth} c
 */
export function step(c) {
  if (c.asleep) return;
  const h = STEP_S;
  const { n, nx, x, p, v, w, nrm, rest, pinAt, grab, links, spans, tethers } = c;
  const t = c.time;
  if (c.peel) {
    // the pins let go one after the other, from the left: the cloth peels off its edge and falls
    const upto = Math.min(nx, Math.floor(((t - c.peel.t0) / c.peel.seconds) * nx) + 1);
    for (let i = c.peel.done; i < upto; i += 1) {
      w[i] = 1;
      for (let k = i; k < n; k += nx) tethers.pin[k] = -1;
    }
    c.peel.done = Math.max(c.peel.done, upto);
    if (upto >= nx) { c.pins = 'none'; tethers.per = 0; c.peel = null; }
  }
  // ---- 1. forces ----
  normals(c);
  const windy = c.wind > 0 || c.gusts.length > 0;
  const g = c.gravity * h, cn = c.dragN * h, ct = c.dragT * h;
  for (let k = 0, k3 = 0; k < n; k += 1, k3 += 3) {
    if (w[k] === 0) continue;
    let ux = -v[k3], uy = -v[k3 + 1], uz = -v[k3 + 2];
    if (windy) { windAt(c, rest[k3], rest[k3 + 1], t); ux += wind3[0]; uy += wind3[1]; uz += wind3[2]; }
    // the air: the motion through it along the normal is resisted most (a sheet moving face on), the motion along the surface a little
    const un = (ux * nrm[k3] + uy * nrm[k3 + 1] + uz * nrm[k3 + 2]) * cn;
    v[k3] += un * nrm[k3] + ct * ux;
    v[k3 + 1] += un * nrm[k3 + 1] + ct * uy + g;
    v[k3 + 2] += un * nrm[k3 + 2] + ct * uz;
  }
  if (grab.on) {
    // the hand: a damped spring from the cloth under it to where it is held (integrated implicitly, so it is stable however stiff), its
    // force bounded: a hand that pulls beyond what the cloth allows does not stretch it
    let px = 0, py = 0, pz = 0, qx = 0, qy = 0, qz = 0;
    for (let m = 0; m < grab.count; m += 1) {
      const k = 3 * grab.idx[m], gw = grab.wt[m];
      px += gw * x[k]; py += gw * x[k + 1]; pz += gw * x[k + 2];
      qx += gw * v[k]; qy += gw * v[k + 1]; qz += gw * v[k + 2];
    }
    const inv = 1 / grab.sum, om = GRAB_OMEGA, den = 1 + 2 * om * h + om * om * h * h;
    let ax = (om * om * (grab.x - px * inv) - 2 * om * qx * inv) / den;
    let ay = (om * om * (grab.y - py * inv) - 2 * om * qy * inv) / den;
    let az = (om * om * (grab.z - pz * inv) - 2 * om * qz * inv) / den;
    const al = Math.hypot(ax, ay, az), most = GRAB_MAX_G * c.gravity;
    if (al > most) { const s = most / al; ax *= s; ay *= s; az *= s; }
    for (let m = 0; m < grab.count; m += 1) {
      const k = 3 * grab.idx[m], gw = grab.wt[m] * h;
      v[k] += gw * ax; v[k + 1] += gw * ay; v[k + 2] += gw * az;
    }
  }
  // ---- 2. the particles move; a pin goes to its place ----
  const pinK = 1 - Math.exp(-h / PIN_TAU);
  for (let k = 0, k3 = 0; k < n; k += 1, k3 += 3) {
    p[k3] = x[k3]; p[k3 + 1] = x[k3 + 1]; p[k3 + 2] = x[k3 + 2];
    if (w[k] === 0) {
      const dx = pinAt[k3] - x[k3], dy = pinAt[k3 + 1] - x[k3 + 1], dz = pinAt[k3 + 2] - x[k3 + 2];
      if (dx * dx + dy * dy + dz * dz < 1e-10) { x[k3] = pinAt[k3]; x[k3 + 1] = pinAt[k3 + 1]; x[k3 + 2] = pinAt[k3 + 2]; }
      else { x[k3] += pinK * dx; x[k3 + 1] += pinK * dy; x[k3 + 2] += pinK * dz; }
    } else {
      x[k3] += v[k3] * h; x[k3 + 1] += v[k3 + 1] * h; x[k3 + 2] += v[k3 + 2] * h;
    }
  }
  // ---- 3. the links ----
  solve(x, w, links.a, links.b, links.len, 0, links.weave, 0);
  solve(x, w, links.a, links.b, links.len, links.weave, links.shear, SHEAR);
  solve(x, w, links.a, links.b, links.len, links.shear, links.count, c.bend);
  // ---- 4. the spans and the tethers ----
  {
    const { a, b, len, count } = spans;
    for (let k = 0; k < count; k += 1) {
      const i = a[k], j = b[k], i3 = 3 * i, j3 = 3 * j;
      const dx = x[j3] - x[i3], dy = x[j3 + 1] - x[i3 + 1], dz = x[j3 + 2] - x[i3 + 2];
      const d2 = dx * dx + dy * dy + dz * dz, L = len[k];
      if (d2 <= L * L) continue;
      const wi = w[i], wj = w[j], ws = wi + wj;
      if (ws === 0) continue;
      const d = Math.sqrt(d2), s = (d - L) / (d * ws), si = wi * s, sj = wj * s;
      x[i3] += si * dx; x[i3 + 1] += si * dy; x[i3 + 2] += si * dz;
      x[j3] -= sj * dx; x[j3 + 1] -= sj * dy; x[j3 + 2] -= sj * dz;
    }
  }
  if (tethers.per === 1) {
    for (let k = nx; k < n; k += 1) {
      if (tethers.pin[k] < 0) continue;
      const k3 = 3 * k, q = 3 * tethers.pin[k];
      const dx = x[k3] - x[q], dy = x[k3 + 1] - x[q + 1], dz = x[k3 + 2] - x[q + 2];
      const d2 = dx * dx + dy * dy + dz * dz, L = tethers.len[k];
      if (d2 > L * L) { const s = L / Math.sqrt(d2); x[k3] = x[q] + dx * s; x[k3 + 1] = x[q + 1] + dy * s; x[k3 + 2] = x[q + 2] + dz * s; }
    }
  } else if (tethers.per === 2) {
    for (let m = 0; m < 2 * n; m += 1) {
      const pin = tethers.pin[m];
      if (pin < 0) continue;
      const k3 = 3 * (m >> 1), q = 3 * pin;
      const dx = x[k3] - x[q], dy = x[k3 + 1] - x[q + 1], dz = x[k3 + 2] - x[q + 2];
      const d2 = dx * dx + dy * dy + dz * dz, L = tethers.len[m];
      if (d2 > L * L) { const s = L / Math.sqrt(d2); x[k3] = x[q] + dx * s; x[k3 + 1] = x[q + 1] + dy * s; x[k3 + 2] = x[q + 2] + dz * s; }
    }
  }
  // ---- 5. the wall, 6. the velocities; how fast and how far from flat the cloth is ----
  const wall = c.wall, keep = 1 - WALL_FRICTION, ih = 1 / h;
  let fast = 0, far = 0;
  for (let k = 0, k3 = 0; k < n; k += 1, k3 += 3) {
    if (x[k3 + 2] < wall && w[k] !== 0) {
      x[k3 + 2] = wall;
      x[k3] = p[k3] + (x[k3] - p[k3]) * keep; x[k3 + 1] = p[k3 + 1] + (x[k3 + 1] - p[k3 + 1]) * keep;
    }
    const vx = (x[k3] - p[k3]) * ih, vy = (x[k3 + 1] - p[k3 + 1]) * ih, vz = (x[k3 + 2] - p[k3 + 2]) * ih;
    v[k3] = vx; v[k3 + 1] = vy; v[k3 + 2] = vz;
    const s2 = vx * vx + vy * vy + vz * vz;
    if (s2 > fast) fast = s2;
    const ex = x[k3] - rest[k3], ey = x[k3 + 1] - rest[k3 + 1], ez = (x[k3 + 2] - rest[k3 + 2]) * DEPTH_SHARE;
    const e2 = ex * ex + ey * ey + ez * ez;
    if (e2 > far) far = e2;
  }
  c.time = t + h;
  c.speed = Math.sqrt(fast); c.away = Math.sqrt(far);
  for (let m = c.gusts.length - 1; m >= 0; m -= 1) if (c.time > c.gusts[m].t0 + gustSeconds(c.gusts[m])) c.gusts.splice(m, 1);
  rest_(c);
}

/**
 * Coming to rest (see SLEEP_SPEED): only when nothing drives the cloth (no hand, no wind). Pinned along the top it is drawn onto the flat
 * pose over the last fraction of a pixel and ends on it exactly; held otherwise it stops where it hangs.
 * @param {Cloth} c
 */
function rest_(c) {
  if (c.grab.on || c.wind > 0 || c.gusts.length > 0 || c.peel) { c.quiet = 0; return; }
  const h = STEP_S, { x, p, v, rest, n } = c;
  if (c.pins === 'top') {
    if (c.away < ASSIST_PX && c.speed < ASSIST_SPEED) {
      if (c.away < SNAP_PX) { layFlat(c); return; }
      const k = 1 - Math.exp(-h / ASSIST_TAU);
      for (let i = 0; i < 3 * n; i += 1) { const d = (rest[i] - x[i]) * k; x[i] += d; p[i] += d; v[i] *= 1 - k; }
    }
    return;
  }
  if (c.pins === 'none') return;
  c.quiet = c.speed < SLEEP_SPEED ? c.quiet + h : 0;
  if (c.quiet >= SLEEP_S) { v.fill(0); p.set(x); c.asleep = true; c.speed = 0; }
}

/**
 * The pins along the top edge let go one after the other from the left, over `seconds`; then nothing holds the cloth and it falls.
 * @param {Cloth} c @param {number} seconds
 */
export function drop(c, seconds) {
  if (c.pins !== 'top') { setPins(c, 'none'); return; }
  c.peel = { t0: c.time, seconds: Math.max(STEP_S, seconds), done: 0 };
  wake(c);
}

/**
 * The cloth as a rigid sheet that hangs from its top edge at the height y0 (css px; negative: above the canvas), swung by `angle` radians
 * about that edge towards the viewer, still. The pins hold the top edge there and carry it to its place (`step`). For the cloth that is
 * hung again. @param {Cloth} c @param {number} y0 @param {number} angle @param {Pins} [pins]
 */
export function hangFrom(c, y0, angle, pins = 'top') {
  const { n, x, p, v, rest } = c;
  setPins(c, pins);
  const ca = Math.cos(angle), sa = Math.sin(angle);
  for (let k3 = 0; k3 < 3 * n; k3 += 3) {
    x[k3] = rest[k3]; x[k3 + 1] = y0 + rest[k3 + 1] * ca; x[k3 + 2] = rest[k3 + 1] * sa;
  }
  p.set(x); v.fill(0);
  c.grab.on = false; c.gusts.length = 0;
  wake(c);
}

/** The largest relative stretch of a link of the weave (0.01: one percent longer than at rest); for tests and measurements. @param {Cloth} c */
export function stretch(c) {
  const { x, links } = c;
  let most = 0;
  for (let k = 0; k < links.weave; k += 1) {
    const i = 3 * links.a[k], j = 3 * links.b[k];
    const d = Math.hypot(x[j] - x[i], x[j + 1] - x[i + 1], x[j + 2] - x[i + 2]);
    most = Math.max(most, d / links.len[k] - 1);
  }
  return most;
}
