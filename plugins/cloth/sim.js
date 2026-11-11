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
 *   3. constraints, one pass, the small steps doing the work of iterations (Macklin et al., "Small Steps in Physics Simulation", 2019):
 *      the weave, thread by thread, each thread solved as a whole (`thread`: a tridiagonal system), so that it is rigid whatever load it
 *      carries; the shear across each cell (compliant: woven cloth shears easily); the bending of each thread over three particles
 *      (compliant: it sets the width of the folds);
 *   4. the tethers (Kim et al., "Long Range Attachments", 2012): no particle is further from a pin than the cloth between them is long.
 *      They rarely act (the threads already hold), and make the flat hanging pose an exact fixed point of the step;
 *   5. the wall behind the cloth, with friction;
 *   6. the cloth against itself (`collide`), last, so that every step ends with no part of the sheet through another;
 *   7. the velocities follow from the positions.
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
/** compliance of the shear diagonals and of the bending, as the dimensionless XPBD term alpha / h^2 (0: rigid) */
export const SHEAR = 60;
/** how much of the push that would keep a compressed link at its length the link gives (`thread`): threads buckle, they are not rods */
export const SQUASH = 0.25;
/** where the two pins of `corners` hold the cloth: this share of the width in from where the corners hang flat, so that the cloth has slack */
export const CORNER_SLACK = 0.02;
/** s: a pin that is moved (the cloth hung again, the pins changed) follows its place with this time constant */
export const PIN_TAU = 0.11;
/**
 * the hand: natural frequency (rad/s) and the largest acceleration of the spring that holds the cloth, in gravities. The bound is what
 * lets the cloth keep its layers apart (`collide`): in one step the hand moves what it holds by at most GRAB_MAX_G g h^2 beyond where it
 * was going (4.2 css px on a canvas 620 px tall, a sixth of the gap); twice that pressed a crumpled patch through itself under a fast flick.
 */
export const GRAB_OMEGA = 250;
export const GRAB_MAX_G = 120;
/** s over which the hand leans into the pull, and how far at most (a share of the canvas height) */
export const GRAB_LEAN = 0.2;
export const GRAB_REACH_PX = 0.25;
/** the cloth under the hand: particles within GRAB_REACH cells are held, the nearest ones hardest (a Gaussian of GRAB_SIGMA cells) */
export const GRAB_SIGMA = 0.85;
export const GRAB_REACH = 2.2;
/**
 * Rest. The cloth sleeps once no particle is faster than SLEEP_SPEED css px/s for SLEEP_S seconds. Where it hangs flat when it is still
 * (pinned along its top edge), the last part of the way is taken by the hand: within ASSIST_PX of the flat pose and slower than
 * ASSIST_SPEED it is drawn onto that pose with the time constant ASSIST_TAU, and it is the flat pose exactly when the rest is below SNAP_PX.
 */
export const SLEEP_SPEED = 3;
export const SLEEP_S = 0.2;
export const ASSIST_PX = 0.4;
export const ASSIST_SPEED = 20;
export const ASSIST_TAU = 0.045;
export const SNAP_PX = 0.012;
/** held by its corners or by a hand: a particle slower than STICK_SPEED css px/s keeps the share STICK of its speed per step */
export const STICK_SPEED = 14;
export const STICK = 0.9;
/** how much a displacement towards or away from the viewer counts against one across the canvas (it moves a pixel that much less) */
const DEPTH_SHARE = 0.4;
/**
 * The cloth against itself (`collide`): two particles that are not the two ends of one link of the weave stay at least SELF_GAP times the
 * larger spacing of the grid apart, and the two ends of a link at least SELF_LINK times its length (a thread buckles before it is squashed
 * that far). A part of the sheet then cannot pass through another: a particle is never in a cell of another part (each point of a cell is
 * within 0.71 of the spacing of one of its corners), and neither is a link, whose middle is half a spacing from its two ends (a link
 * through the middle of a cell has its ends 0.87 of the spacing from the corners); the drawn surface, an average of the particles, keeps
 * its layers apart too. The cloth is then about one spacing thick where it lies over itself (26 css px on a canvas of 1100 x 620).
 */
export const SELF_GAP = 1;
export const SELF_LINK = 0.6;

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
 * @property {{pin: Int32Array, len: Float64Array, per: number}} tethers
 * @property {number} gravity  css px / s^2
 * @property {number} wall  z of the wall (negative)
 * @property {number} dragN  1/s, on the motion along the normal @property {number} dragT  1/s, on all motion
 * @property {number} bend  compliance of the bending (`flatten`)
 * @property {number} wind  the breeze, 0..1 @property {Gust[]} gusts
 * @property {{idx: Int32Array, wt: Float64Array, count: number, sum: number, x: number, y: number, z: number, ox: number, oy: number, oz: number, on: boolean}} grab
 * @property {{t0: number, seconds: number, done: number}|null} peel  the pins are letting go, from the left (`drop`)
 * @property {{t0: number, seconds: number, from: Float64Array, to: Float64Array}|null} lower  the pins are coming down to their places (`hangFrom`)
 * @property {number} time  s of simulated time @property {number} quiet  s for which the cloth has been slow
 * @property {boolean} asleep  nothing moves; `step` does nothing until `wake`
 * @property {boolean} flat  asleep in the flat pose exactly
 * @property {number} speed  the largest speed of a particle at the last step (css px/s) @property {number} away  the largest distance from the flat pose
 * @property {{gap: number, calm: number, on: boolean, col: Int32Array, row: Int32Array, mask: number, cell: Int32Array, start: Int32Array, next: Int32Array, order: Int32Array, seen: Int32Array, at: Int32Array}} self
 *   the cloth against itself (`collide`): the least distance of two particles, how far a particle can move from its place before two can be that close, whether it acts (always, but for a test's control), the column and row of each particle, the buckets
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
  // the links: the weave down the cloth and across it (solved thread by thread, `thread`; listed for `stretch`), the two diagonals of each
  // cell, then the pairs two cells apart on one thread, whose middle particle the bending acts on
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
  const reach = Math.ceil(GRAB_REACH) * 2 + 2;
  let buckets = 1024;
  while (buckets < 2 * n) buckets *= 2;
  const col = new Int32Array(n), row = new Int32Array(n);
  for (let k = 0; k < n; k += 1) { col[k] = k % nx; row[k] = (k - col[k]) / nx; }
  /** @type {Cloth} */
  const c = {
    width, height, cols, rows, nx, ny, n, lx, ly,
    x: rest.slice(), p: rest.slice(), v: new Float64Array(3 * n), rest, w: new Float64Array(n).fill(1), pinAt: rest.slice(), nrm: new Float64Array(3 * n),
    pins: 'none',
    links: { a: Int32Array.from(a), b: Int32Array.from(b), len: Float64Array.from(len), weave, shear, count: a.length },
    tethers: { pin: new Int32Array(2 * n).fill(-1), len: new Float64Array(2 * n), per: 0 },
    gravity: GRAVITY * height, wall: -WALL_GAP * Math.min(width, height), dragN: 3.5, dragT: 3.7, bend: 2100, wind: 0, gusts: [],
    grab: { idx: new Int32Array(reach * reach), wt: new Float64Array(reach * reach), count: 0, sum: 0, x: 0, y: 0, z: 0, ox: 0, oy: 0, oz: 0, on: false },
    peel: null, lower: null, time: 0, quiet: 0, asleep: true, flat: true, speed: 0, away: 0,
    self: { gap: SELF_GAP * Math.max(lx, ly), calm: 0.5 * Math.min((1 - SELF_LINK) * Math.min(lx, ly), Math.hypot(lx, ly) - SELF_GAP * Math.max(lx, ly)), on: true, col, row, mask: buckets - 1, cell: new Int32Array(n), start: new Int32Array(buckets + 1), next: new Int32Array(buckets), order: new Int32Array(n), seen: new Int32Array(n), at: new Int32Array(2 * n) },
  };
  for (let k = 0; k < n; k += 1) c.nrm[3 * k + 2] = 1;
  setPins(c, 'top');
  layFlat(c);
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
  c.peel = null; c.lower = null;
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
      // a cloth with slack stays in its plane as long as nothing disturbs it: a faint, uneven breath of air lets it fold
      c.v[3 * k + 2] += 0.03 * c.height * Math.sin(12.9898 * k + 4.1) * Math.sin(0.37 * k);
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
  grab.x = x; grab.y = y; grab.z = z; grab.ox = 0; grab.oy = 0; grab.oz = 0;
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
    // uneven, as moving air is: eddies that travel with the front, and more of it where the cloth hangs free
    const eddy = 1 + 0.5 * Math.sin((6.3 * (1.7 * x + 0.6 * y)) / diag + 5 * t) + 0.32 * Math.sin((6.3 * (3.1 * x - 1.3 * y)) / diag - 7.3 * t + 1.7);
    const u = g.strength * GUST_WIND * H * e * eddy * (0.55 + 0.9 * (y / H));
    wz += u; wx += 0.5 * u * g.dx; wy += 0.5 * u * g.dy;
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

const TX = new Float64Array(MAX_SIDE), TY = new Float64Array(MAX_SIDE), TZ = new Float64Array(MAX_SIDE);
const TD = new Float64Array(MAX_SIDE), TE = new Float64Array(MAX_SIDE), TR = new Float64Array(MAX_SIDE);
/**
 * One thread of the weave, solved as a whole: the particles first, first + stride, ... are a chain of `links` links of the length `len`,
 * and the corrections that bring every link to its length at once (to first order: one Newton step of all its constraints together)
 * are the solution of a tridiagonal system, here by elimination. A link then pulls on its neighbours along their own directions with
 * the tension the whole thread needs: the cloth swings as a hanging sheet does and does not stretch under its weight, which one pass
 * over the links one by one cannot give (their stretch grows with the load each of them carries). Against compression a link gives way
 * (SQUASH).
 * @param {Float64Array} x @param {Float64Array} w @param {number} first @param {number} stride @param {number} links @param {number} len
 */
function thread(x, w, first, stride, links, len) {
  // the unit vector of each link, and by how much it is too long (negated: the right-hand side)
  let free = 0;
  for (let k = 0, i = first; k < links; k += 1, i += stride) {
    const a = 3 * i, b = a + 3 * stride;
    const dx = x[b] - x[a], dy = x[b + 1] - x[a + 1], dz = x[b + 2] - x[a + 2];
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz), inv = l > 1e-9 ? 1 / l : 0;
    TX[k] = dx * inv; TY[k] = dy * inv; TZ[k] = dz * inv; TR[k] = len - l;
    free += w[i] + w[i + stride];
  }
  if (free === 0) return;
  // the system: on the diagonal the inverse masses of a link's two particles; beside it the particle it shares with the next link
  for (let k = 0, i = first; k < links; k += 1, i += stride) {
    const wb = w[i + stride];
    TD[k] = w[i] + wb;
    if (TD[k] === 0) { TD[k] = 1; TR[k] = 0; }
    TE[k] = k < links - 1 ? -wb * (TX[k] * TX[k + 1] + TY[k] * TY[k + 1] + TZ[k] * TZ[k + 1]) : 0;
  }
  for (let k = 1; k < links; k += 1) { const f = TE[k - 1] / TD[k - 1]; TD[k] -= f * TE[k - 1]; TR[k] -= f * TR[k - 1]; }
  TR[links - 1] /= TD[links - 1];
  for (let k = links - 2; k >= 0; k -= 1) TR[k] = (TR[k] - TE[k] * TR[k + 1]) / TD[k];
  // a thread pulls, it hardly pushes: a link that the solution asks to push (TR > 0) gives only the share SQUASH of it. Rigid in
  // compression, a row of links can stand as an arch, and the cloth could not be gathered at all.
  for (let k = 0; k < links; k += 1) if (TR[k] > 0) TR[k] *= SQUASH;
  // each particle moves by the pull of the link before it and of the link after it
  let px = 0, py = 0, pz = 0;
  for (let k = 0, i = first; k <= links; k += 1, i += stride) {
    const m = k < links ? TR[k] : 0, qx = m * TX[k], qy = m * TY[k], qz = m * TZ[k], wi = w[i], a = 3 * i;
    if (k < links) { x[a] += wi * (px - qx); x[a + 1] += wi * (py - qy); x[a + 2] += wi * (pz - qz); px = qx; py = qy; pz = qz; }
    else { x[a] += wi * px; x[a + 1] += wi * py; x[a + 2] += wi * pz; }
  }
}

/**
 * Bending, for the links k0 .. k1 (each spans two cells of one thread): the particle in the middle and its two neighbours are drawn towards
 * a straight, evenly spaced line (the second difference of the thread towards zero), by the share 6 / (6 + soft) per step. Unlike a
 * distance across the two cells, this resists the shortest buckle of the grid (a zigzag from particle to particle) most, so the grid of
 * the simulation never shows as wrinkles one cell wide.
 * @param {Float64Array} x @param {Float64Array} w @param {Int32Array} a @param {Int32Array} b @param {number} k0 @param {number} k1 @param {number} soft
 */
function flatten(x, w, a, b, k0, k1, soft) {
  for (let k = k0; k < k1; k += 1) {
    const i = a[k], j = b[k], m = (i + j) >> 1, i3 = 3 * i, j3 = 3 * j, m3 = 3 * m;
    const wi = w[i], wj = w[j], wm = w[m], ws = wi + wj + 4 * wm;
    if (ws === 0) continue;
    const s = 1 / (ws + soft), si = wi * s, sj = wj * s, sm = 2 * wm * s;
    const cx = x[i3] + x[j3] - 2 * x[m3], cy = x[i3 + 1] + x[j3 + 1] - 2 * x[m3 + 1], cz = x[i3 + 2] + x[j3 + 2] - 2 * x[m3 + 2];
    x[i3] -= si * cx; x[i3 + 1] -= si * cy; x[i3 + 2] -= si * cz;
    x[j3] -= sj * cx; x[j3 + 1] -= sj * cy; x[j3 + 2] -= sj * cz;
    x[m3] += sm * cx; x[m3 + 1] += sm * cy; x[m3 + 2] += sm * cz;
  }
}

/** the hash of the column (i, j) of `collide` (masked to a bucket there) @param {number} i @param {number} j */
const bucket = (i, j) => Math.imul(i, 73856093) ^ Math.imul(j, 19349663);
/** a column and the 4 columns around it that come after it (down, then across): with them every two neighbouring columns meet once */
const AHEAD = Int32Array.from([0, 0, 1, 0, -1, 1, 0, 1, 1, 1]);

/**
 * The cloth against itself, once (SELF_GAP, SELF_LINK): every two particles closer than self.gap (the two ends of a link: closer than
 * SELF_LINK times its length) are moved apart along the line between them, by their inverse masses, to that distance. The particles are
 * sorted into columns of the gap across and down the canvas, whatever their depth (the cloth is a sheet: a column holds one or two
 * particles, and a few more where it lies in folds), by counting into a table of buckets (a hash of the column); each particle looks into
 * its own column (at the particles after it) and into the 4 columns after it, so that each pair is solved once.
 * @param {Cloth} c
 */
function collide(c) {
  const { x, w, n, self } = c;
  const { gap, col, row, mask, cell, start, next, order, seen, at } = self;
  const inv = 1 / gap, gap2 = gap * gap, across = SELF_LINK * c.lx, down = SELF_LINK * c.ly;
  start.fill(0);
  for (let k = 0, k3 = 0; k < n; k += 1, k3 += 3) {
    const i = Math.floor(x[k3] * inv), j = Math.floor(x[k3 + 1] * inv);
    at[2 * k] = i; at[2 * k + 1] = j;
    const b = bucket(i, j) & mask;
    cell[k] = b; start[b + 1] += 1;
  }
  for (let b = 0; b <= mask; b += 1) { start[b + 1] += start[b]; next[b] = start[b]; }
  for (let k = 0; k < n; k += 1) { order[next[cell[k]]] = k; next[cell[k]] += 1; }
  seen.fill(-1);
  for (let k = 0, k3 = 0; k < n; k += 1, k3 += 3) {
    const i = at[2 * k], j = at[2 * k + 1], ck = col[k], rk = row[k], wk = w[k];
    for (let a = 0; a < AHEAD.length; a += 2) {
      const own = a === 0, b = own ? cell[k] : bucket(i + AHEAD[a], j + AHEAD[a + 1]) & mask;
      for (let o = start[b], end = start[b + 1]; o < end; o += 1) {
        const m = order[o];
        // in its own column a particle meets those after it; a bucket that two columns share is read once per particle
        if ((own && m <= k) || m === k || seen[m] === k) continue;
        seen[m] = k;
        const m3 = 3 * m, dx = x[m3] - x[k3], dy = x[m3 + 1] - x[k3 + 1], dz = x[m3 + 2] - x[k3 + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= gap2 || d2 < 1e-12) continue;
        const ws = wk + w[m], link = Math.abs(col[m] - ck) + Math.abs(row[m] - rk) === 1, least = !link ? gap : row[m] === rk ? across : down;
        if (ws === 0 || d2 >= least * least) continue;
        const d = Math.sqrt(d2), s = (least - d) / (d * ws), sk = wk * s, sm = w[m] * s;
        x[k3] -= sk * dx; x[k3 + 1] -= sk * dy; x[k3 + 2] -= sk * dz;
        x[m3] += sm * dx; x[m3 + 1] += sm * dy; x[m3 + 2] += sm * dz;
      }
    }
  }
}

/**
 * One step of STEP_S seconds. Does nothing while the cloth is asleep.
 * @param {Cloth} c
 */
export function step(c) {
  if (c.asleep) return;
  const h = STEP_S;
  const { n, nx, x, p, v, w, nrm, rest, pinAt, grab, links, tethers } = c;
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
  if (c.lower) {
    // the pins come down to their places: a smooth step in time (no speed at either end)
    const k = Math.min(1, (t + h - c.lower.t0) / c.lower.seconds), e = k * k * (3 - 2 * k), { from, to } = c.lower;
    for (let i = 0; i < nx; i += 1) {
      if (w[i] !== 0) continue;
      const i3 = 3 * i;
      pinAt[i3] = from[i3] + (to[i3] - from[i3]) * e; pinAt[i3 + 1] = from[i3 + 1] + (to[i3 + 1] - from[i3 + 1]) * e; pinAt[i3 + 2] = from[i3 + 2] + (to[i3 + 2] - from[i3 + 2]) * e;
      x[i3] = pinAt[i3]; x[i3 + 1] = pinAt[i3 + 1]; x[i3 + 2] = pinAt[i3 + 2];
    }
    if (k >= 1) c.lower = null;
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
    // a spring alone would hold the cloth short of the hand by the weight that hangs from it: the hand leans into the pull until the
    // cloth is where it holds it (the error, integrated over GRAB_LEAN seconds, bounded)
    const ex = grab.x - px * inv, ey = grab.y - py * inv, ez = grab.z - pz * inv, lean = h / GRAB_LEAN, far = GRAB_REACH_PX * c.height;
    grab.ox += ex * lean; grab.oy += ey * lean; grab.oz += ez * lean;
    const ol = Math.hypot(grab.ox, grab.oy, grab.oz);
    if (ol > far) { const k = far / ol; grab.ox *= k; grab.oy *= k; grab.oz *= k; }
    let ax = (om * om * (ex + grab.ox) - 2 * om * qx * inv) / den;
    let ay = (om * om * (ey + grab.oy) - 2 * om * qy * inv) / den;
    let az = (om * om * (ez + grab.oz) - 2 * om * qz * inv) / den;
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
  for (let i = 0; i < nx; i += 1) thread(x, w, i, nx, c.rows, c.ly);
  for (let j = 0; j < c.ny; j += 1) thread(x, w, j * nx, 1, c.cols, c.lx);
  solve(x, w, links.a, links.b, links.len, links.weave, links.shear, SHEAR);
  flatten(x, w, links.a, links.b, links.shear, links.count, c.bend);
  // ---- 4. the tethers ----
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
  // ---- 5. the wall ----
  const wall = c.wall, keep = 1 - WALL_FRICTION, ih = 1 / h, sticky = c.pins === 'corners' || c.grab.on;
  for (let k = 0, k3 = 0; k < n; k += 1, k3 += 3) {
    if (x[k3 + 2] < wall && w[k] !== 0) {
      x[k3 + 2] = wall;
      x[k3] = p[k3] + (x[k3] - p[k3]) * keep; x[k3 + 1] = p[k3 + 1] + (x[k3 + 1] - p[k3 + 1]) * keep;
    }
  }
  // ---- 6. the cloth against itself, last, so that every step ends with its layers apart: only once two particles can have come that
  // close (on the flat cloth the ends of a link are their length apart, any other two at least a cell's diagonal, and no particle has
  // moved further from its place than `away` / DEPTH_SHARE and this step) ----
  if (c.self.on && c.away / DEPTH_SHARE + c.speed * h > c.self.calm) collide(c);
  // ---- 7. the velocities; how fast and how far from flat the cloth is ----
  let fast = 0, far = 0;
  for (let k = 0, k3 = 0; k < n; k += 1, k3 += 3) {
    const vx = (x[k3] - p[k3]) * ih, vy = (x[k3 + 1] - p[k3 + 1]) * ih, vz = (x[k3 + 2] - p[k3 + 2]) * ih;
    const s2 = vx * vx + vy * vy + vz * vz;
    // a cloth that hangs in folds comes to rest by the friction of its threads: what only creeps, stops
    const hold = sticky && s2 < STICK_SPEED * STICK_SPEED ? STICK : 1;
    v[k3] = vx * hold; v[k3 + 1] = vy * hold; v[k3 + 2] = vz * hold;
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
 * Coming to rest (see SLEEP_SPEED): only when no wind drives the cloth. Pinned along the top, with no hand on it, it is drawn onto the flat
 * pose over the last fraction of a pixel and ends on it exactly; held by its corners or by a hand that keeps still, it stops where it hangs.
 * @param {Cloth} c
 */
function rest_(c) {
  if (c.wind > 0 || c.gusts.length > 0 || c.peel || c.lower) { c.quiet = 0; return; }
  const h = STEP_S, { x, p, v, rest, n } = c;
  if (c.pins === 'top' && !c.grab.on) {
    if (c.away < ASSIST_PX && c.speed < ASSIST_SPEED) {
      if (c.away < SNAP_PX) { layFlat(c); return; }
      const k = 1 - Math.exp(-h / ASSIST_TAU);
      for (let i = 0; i < 3 * n; i += 1) { const d = (rest[i] - x[i]) * k; x[i] += d; p[i] += d; v[i] *= 1 - k; }
    }
    return;
  }
  if (c.pins === 'none' && !c.grab.on) return;
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
 * The cloth as a rigid sheet that hangs from its pins at the height y0 (css px; negative: above the canvas), swung by `angle` radians
 * about its top edge towards the viewer, still; the pins then come down to their places over `seconds` (`step`). For the cloth that is
 * hung again. The pins must not fall faster than the cloth does, or they overtake it and it folds over them: `lowerSeconds` is the
 * shortest time that keeps it taut. @param {Cloth} c @param {number} y0 @param {number} angle @param {Pins} pins @param {number} seconds
 */
export function hangFrom(c, y0, angle, pins, seconds) {
  const { n, x, p, v, rest, pinAt } = c;
  v.fill(0);
  setPins(c, pins);
  const ca = Math.cos(angle), sa = Math.sin(angle);
  for (let k3 = 0; k3 < 3 * n; k3 += 3) {
    // (the pins of `corners` hold their particles a little inside the sheet: the sheet is hung by its corners as it is, and gathers as they come down)
    x[k3] = rest[k3]; x[k3 + 1] = y0 + rest[k3 + 1] * ca; x[k3 + 2] = rest[k3 + 1] * sa;
  }
  p.set(x);
  c.lower = { t0: c.time, seconds: Math.max(STEP_S, seconds), from: x.slice(0, 3 * c.nx), to: pinAt.slice(0, 3 * c.nx) };
  c.grab.on = false; c.gusts.length = 0;
  wake(c);
}

/** The shortest time in which pins may come down `distance` css px on their smooth way (`step`) without falling faster than the cloth: their largest acceleration stays under 0.8 g. @param {Cloth} c @param {number} distance */
export const lowerSeconds = (c, distance) => Math.sqrt((6 * Math.abs(distance)) / (0.8 * c.gravity));

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
