/**
 * The fluid of the ink plugin: an incompressible 2D flow in a closed box (the canvas), in vorticity and stream function form, and the
 * displacement of the page that it carries. PURE: no DOM, no GPU. index.js uploads the packed field (`pack`) and ink.wgsl evaluates it
 * exactly as `fieldAt` below does (a cubic B-spline over 4 x 4 cells), so the input mapper and the pixels describe the same displacement.
 *
 * The state, on a grid of square-ish cells of about CELL_PX CSS px, with PAD ghost cells on every side:
 *   w      vorticity, 1/s                                  (zero on the walls: free slip)
 *   psi    stream function, CSS px^2/s                     (zero on the walls: nothing flows through them)
 *   dx,dy  displacement of the page, CSS px                (the page point shown at x is the source at x - d(x))
 * One step (STEP_HZ per second, whatever the display rate):
 *   1. psi from w: the Poisson equation  -laplace(psi) = w  by one multigrid V cycle, started from the previous psi;
 *   2. the velocity (u, v) = (d psi/dy, -d psi/dx) at the cell centres, by the derivative of the B-spline of psi. Being the curl of a
 *      smooth stream function, the velocity is divergence free wherever it is evaluated, whatever the accuracy of step 1;
 *   3. w, dx and dy carried along the flow: semi-Lagrangian with a midpoint (RK2) trace and a MacCormack correction, limited to the
 *      values around the departure point; the displacement also gains the path of the step (the page moves with the water);
 *   4. vorticity confinement: the force eps h (N x w) of Fedkiw et al., added as its curl;
 *   5. friction: the vorticity decays (drag of the thin layer) and the displacement relaxes to zero (the page heals); both also lose a
 *      small constant amount per second, so they reach exactly zero in finite time instead of approaching it forever.
 * Where the water moves slower than STICK_PX_S the page does not move at all (the constant loss holds it), so the displacement is exactly
 * zero outside a bounded region (`box`): there the picture is the source, pixel for pixel.
 */

/** ghost cells on each side (the B-spline reads one cell beyond the border, and two at the far border) */
export const PAD = 2;
/** simulation steps per second (fixed time step) */
export const STEP_HZ = 120;
export const STEP_MS = 1000 / STEP_HZ;
export const DT = 1 / STEP_HZ;
/** at most this many steps per rendered frame: a longer gap (an off-screen pause, a frame cap under 15) is skipped, not caught up */
export const MAX_STEPS_PER_FRAME = 8;
/** cells are at least CELL_PX CSS px wide; a large canvas has about MAX_CELLS of them */
export const CELL_PX = 10;
export const MAX_CELLS = 8192;
/** the page holds still where the water moves slower than this, CSS px/s; a displaced page comes home at least this fast */
export const STICK_PX_S = 1.5;
/** the vorticity loses this much per second on top of the drag, 1/s^2: a slow swirl stops in finite time */
export const W_FRICTION = 0.6;
/** the vorticity gradient (1/s per CSS px) under which confinement fades out: it sharpens swirls, not the noise of water nearly at rest */
export const CONFINE_FLOOR = 0.02;
/** sweeps of the multigrid V cycle before and after the coarse correction, and on the coarsest grid */
const SMOOTH = 2;
const COARSEST = 16;

/**
 * @typedef {Object} Level  one grid of the multigrid solver, with one ghost cell on every side
 * @property {number} nx @property {number} ny @property {number} sx  row length, nx + 2
 * @property {Float32Array} p  the unknown @property {Float32Array} b  the right-hand side
 */

/**
 * @typedef {Object} Fluid
 * @property {number} cssWidth @property {number} cssHeight
 * @property {number} gw  interior cells across @property {number} gh  interior cells down
 * @property {number} pw  gw + 2 PAD (row length of every field) @property {number} ph
 * @property {number} cellX  CSS px per cell @property {number} cellY
 * @property {Float32Array} w @property {Float32Array} psi @property {Float32Array} dx @property {Float32Array} dy
 * @property {Float32Array} uc  velocity in cells per step, across @property {Float32Array} vc  down
 * @property {Float32Array[]} tmp  scratch fields
 * @property {Level[]} levels
 * @property {boolean} flowing  the vorticity may be non-zero (otherwise w, psi, uc and vc are exactly zero)
 * @property {boolean} moved  the displacement may be non-zero
 * @property {Int32Array} box  the cells whose displacement may be non-zero, padded grid [x0, y0, x1, y1] inclusive; x0 > x1: none
 * @property {number} maxSpeed  the largest speed at a cell centre in the last step, CSS px/s
 * @property {number} maxShift  the largest displacement after the last step, CSS px
 * @property {number} maxW  the largest |w| of any cell, 1/s
 * @property {Float32Array} ink  per cell, an upper bound of the pigment density that the GPU holds there (`inkAdd`, `inkCarry`)
 * @property {number} maxInk  the largest value of `ink`: 0 when no pigment is left anywhere
 * @property {boolean} traced  the last step moved the water (its departure points are in tmp[3], tmp[4])
 */

/** The grid of a canvas of this CSS size: multiples of 8 cells each way (three coarser grids for the solver). @param {number} cssWidth @param {number} cssHeight */
export function gridOf(cssWidth, cssHeight) {
  const w = Math.max(1, cssWidth), h = Math.max(1, cssHeight);
  const cell = Math.max(CELL_PX, Math.sqrt((w * h) / MAX_CELLS));
  return { gw: Math.max(16, 8 * Math.round(w / cell / 8)), gh: Math.max(16, 8 * Math.round(h / cell / 8)) };
}

/** Fit the cell size to a new CSS size of the same grid. @param {Fluid} f @param {number} cssWidth @param {number} cssHeight */
export function setSize(f, cssWidth, cssHeight) {
  f.cssWidth = Math.max(1, cssWidth); f.cssHeight = Math.max(1, cssHeight);
  f.cellX = f.cssWidth / f.gw; f.cellY = f.cssHeight / f.gh;
}

/** @param {number} cssWidth @param {number} cssHeight @returns {Fluid} */
export function createFluid(cssWidth, cssHeight) {
  const { gw, gh } = gridOf(cssWidth, cssHeight);
  const pw = gw + 2 * PAD, ph = gh + 2 * PAD, n = pw * ph;
  const field = () => new Float32Array(n);
  /** @type {Level[]} */ const levels = [];
  for (let nx = gw, ny = gh; ; nx >>= 1, ny >>= 1) {
    levels.push({ nx, ny, sx: nx + 2, p: new Float32Array((nx + 2) * (ny + 2)), b: new Float32Array((nx + 2) * (ny + 2)) });
    if (nx % 2 || ny % 2 || nx < 4 || ny < 4) break;
  }
  /** @type {Fluid} */
  const f = {
    cssWidth: 1, cssHeight: 1, gw, gh, pw, ph, cellX: 1, cellY: 1,
    w: field(), psi: field(), dx: field(), dy: field(), uc: field(), vc: field(),
    tmp: [field(), field(), field(), field(), field(), field(), field(), field(), field()],
    levels, flowing: false, moved: false, box: Int32Array.of(pw, ph, -1, -1), maxSpeed: 0, maxShift: 0, maxW: 0,
    ink: field(), maxInk: 0, traced: false,
  };
  setSize(f, cssWidth, cssHeight);
  return f;
}

/** At rest: no flow, no displacement. @param {Fluid} f */
export function clear(f) {
  f.w.fill(0); f.psi.fill(0); f.dx.fill(0); f.dy.fill(0); f.uc.fill(0); f.vc.fill(0);
  for (const l of f.levels) l.p.fill(0);
  f.flowing = false; f.moved = false; f.maxSpeed = 0; f.maxShift = 0; f.maxW = 0;
  f.ink.fill(0); f.maxInk = 0; f.traced = false;
  f.box.set([f.pw, f.ph, -1, -1]);
}

/** Nothing moves, nothing is displaced and no pigment is left: every field is exactly zero. @param {Fluid} f */
export const quiet = (f) => !f.flowing && !f.moved && f.maxInk === 0;

/**
 * The ghost cells of a field, mirrored about the walls: `sx` is the sign across the left and right walls (-1: the field is zero on them),
 * `sy` across the top and bottom walls. @param {Fluid} f @param {Float32Array} a @param {number} sx @param {number} sy
 */
export function mirror(f, a, sx, sy) {
  const { pw, gw, gh } = f;
  for (let y = PAD; y < PAD + gh; y += 1) {
    const row = y * pw;
    for (let k = 1; k <= PAD; k += 1) {
      a[row + PAD - k] = sx * a[row + PAD + k - 1];
      a[row + PAD + gw - 1 + k] = sx * a[row + PAD + gw - k];
    }
  }
  for (let k = 1; k <= PAD; k += 1) {
    const top = (PAD - k) * pw, from = (PAD + k - 1) * pw, bottom = (PAD + gh - 1 + k) * pw, fromB = (PAD + gh - k) * pw;
    for (let x = 0; x < pw; x += 1) { a[top + x] = sy * a[from + x]; a[bottom + x] = sy * a[fromB + x]; }
  }
}

// ---- 1. the stream function: multigrid for  -laplace(psi) = w,  psi = 0 on the walls ------------------------------------------------

/** The ghost cells of a level: minus the border cells (the unknown is zero on the wall between them). @param {Level} l */
function levelGhosts(l) {
  const { nx, ny, sx, p } = l;
  for (let j = 1; j <= ny; j += 1) { p[j * sx] = -p[j * sx + 1]; p[j * sx + nx + 1] = -p[j * sx + nx]; }
  const last = (ny + 1) * sx;
  for (let i = 0; i < sx; i += 1) { p[i] = -p[sx + i]; p[last + i] = -p[last - sx + i]; }
}

/** Red-black Gauss-Seidel sweeps. @param {Level} l @param {number} ax  1 / (cell width)^2 @param {number} ay @param {number} sweeps */
function smooth(l, ax, ay, sweeps) {
  const { nx, ny, sx, p, b } = l;
  const inv = 1 / (2 * ax + 2 * ay);
  for (let s = 0; s < 2 * sweeps; s += 1) {
    for (let j = 1; j <= ny; j += 1) {
      const end = j * sx + nx;
      for (let i = j * sx + 1 + ((j + s) & 1); i <= end; i += 2) p[i] = (ax * (p[i - 1] + p[i + 1]) + ay * (p[i - sx] + p[i + sx]) + b[i]) * inv;
    }
    levelGhosts(l);
  }
}

/** One V cycle from level `k` down. @param {Level[]} levels @param {number} k @param {number} ax @param {number} ay */
function vcycle(levels, k, ax, ay) {
  const l = levels[k];
  if (k === levels.length - 1) { smooth(l, ax, ay, COARSEST); return; }
  smooth(l, ax, ay, SMOOTH);
  const c = levels[k + 1];
  const { sx, p, b } = l;
  const d = 2 * ax + 2 * ay;
  // the residual, averaged over the four cells of each coarse cell
  for (let J = 1; J <= c.ny; J += 1) {
    for (let I = 1; I <= c.nx; I += 1) {
      let sum = 0;
      for (let t = 0; t < 4; t += 1) {
        const i = (2 * J - 1 + (t >> 1)) * sx + 2 * I - 1 + (t & 1);
        sum += b[i] - d * p[i] + ax * (p[i - 1] + p[i + 1]) + ay * (p[i - sx] + p[i + sx]);
      }
      c.b[J * c.sx + I] = 0.25 * sum;
    }
  }
  c.p.fill(0);
  vcycle(levels, k + 1, 0.25 * ax, 0.25 * ay);
  // the correction, interpolated bilinearly from the coarse cell centres (weights 9, 3, 3, 1 over 16)
  const cp = c.p, cs = c.sx;
  for (let J = 1; J <= c.ny; J += 1) {
    for (let I = 1; I <= c.nx; I += 1) {
      const q = J * cs + I;
      const m = 0.5625 * cp[q], W = cp[q - 1], E = cp[q + 1], N = cp[q - cs], S = cp[q + cs];
      const i = (2 * J - 1) * sx + 2 * I - 1;
      p[i] += m + 0.1875 * (W + N) + 0.0625 * cp[q - cs - 1];
      p[i + 1] += m + 0.1875 * (E + N) + 0.0625 * cp[q - cs + 1];
      p[i + sx] += m + 0.1875 * (W + S) + 0.0625 * cp[q + cs - 1];
      p[i + sx + 1] += m + 0.1875 * (E + S) + 0.0625 * cp[q + cs + 1];
    }
  }
  levelGhosts(l);
  smooth(l, ax, ay, SMOOTH);
}

/**
 * psi from w: `cycles` V cycles, started from the psi of the previous step. @param {Fluid} f @param {number} [cycles]
 */
export function solve(f, cycles = 1) {
  const { gw, gh, pw, w, psi, levels } = f;
  const l = levels[0];
  for (let y = 0; y < gh; y += 1) {
    const from = (y + PAD) * pw + PAD, to = (y + 1) * l.sx + 1;
    for (let x = 0; x < gw; x += 1) l.b[to + x] = w[from + x];
  }
  const ax = 1 / (f.cellX * f.cellX), ay = 1 / (f.cellY * f.cellY);
  for (let k = 0; k < cycles; k += 1) vcycle(levels, 0, ax, ay);
  for (let y = 0; y < gh; y += 1) {
    const to = (y + PAD) * pw + PAD, from = (y + 1) * l.sx + 1;
    for (let x = 0; x < gw; x += 1) psi[to + x] = l.p[from + x];
  }
  mirror(f, psi, -1, -1);
}

// ---- 2. the velocity ---------------------------------------------------------------------------------------------------------------

/**
 * The velocity at the cell centres and one ring of ghost cells, in cells per step: the derivative of the B-spline of psi there (the
 * central difference one way, weighted 1, 4, 1 over 6 the other way). @param {Fluid} f
 */
function velocity(f) {
  const { pw, gw, gh, psi, uc, vc, cellX, cellY } = f;
  const s = DT / (12 * cellX * cellY);
  let max = 0;
  for (let y = PAD - 1; y <= PAD + gh; y += 1) {
    const end = y * pw + PAD + gw;
    for (let i = y * pw + PAD - 1; i <= end; i += 1) {
      const u = s * (psi[i + pw - 1] - psi[i - pw - 1] + 4 * (psi[i + pw] - psi[i - pw]) + psi[i + pw + 1] - psi[i - pw + 1]);
      const v = -s * (psi[i - pw + 1] - psi[i - pw - 1] + 4 * (psi[i + 1] - psi[i - 1]) + psi[i + pw + 1] - psi[i + pw - 1]);
      uc[i] = u; vc[i] = v;
      const px = u * cellX, py = v * cellY, q = px * px + py * py;
      if (q > max) max = q;
    }
  }
  f.maxSpeed = Math.sqrt(max) * STEP_HZ;
}

// ---- 3. transport ------------------------------------------------------------------------------------------------------------------

/**
 * Carry w, dx and dy along the flow by one step. Each cell traces back to where its water was (a midpoint step through the bilinear
 * velocity), reads the fields there, traces that estimate forward again and corrects by half the difference (MacCormack); the result
 * is limited to the four values around the departure point, so the transport creates no new extremes. The displacement then gains the
 * path of the step. @param {Fluid} f
 */
function transport(f) {
  const { pw, gw, gh, uc, vc, cellX, cellY, tmp } = f;
  const w0 = f.w, x0 = f.dx, y0 = f.dy;
  const [w1, x1, y1, qx, qy, w2, x2, y2] = tmp;
  const lox = PAD - 0.5, hix = PAD + gw - 0.5, loy = PAD - 0.5, hiy = PAD + gh - 0.5;
  for (let y = PAD; y < PAD + gh; y += 1) {
    for (let x = PAD, i = y * pw + PAD; x < PAD + gw; x += 1, i += 1) {
      // the velocity half a step back
      let mx = x - 0.5 * uc[i], my = y - 0.5 * vc[i];
      mx = mx < lox ? lox : mx > hix ? hix : mx; my = my < loy ? loy : my > hiy ? hiy : my;
      let ix = mx | 0, iy = my | 0, tx = mx - ix, ty = my - iy, k = iy * pw + ix;
      const um = (uc[k] + (uc[k + 1] - uc[k]) * tx) * (1 - ty) + (uc[k + pw] + (uc[k + pw + 1] - uc[k + pw]) * tx) * ty;
      const vm = (vc[k] + (vc[k + 1] - vc[k]) * tx) * (1 - ty) + (vc[k + pw] + (vc[k + pw + 1] - vc[k + pw]) * tx) * ty;
      // where this cell's water was a step ago
      let px = x - um, py = y - vm;
      px = px < lox ? lox : px > hix ? hix : px; py = py < loy ? loy : py > hiy ? hiy : py;
      qx[i] = px; qy[i] = py;
      ix = px | 0; iy = py | 0; tx = px - ix; ty = py - iy; k = iy * pw + ix;
      const a = (1 - tx) * (1 - ty), b = tx * (1 - ty), c = (1 - tx) * ty, d = tx * ty;
      w1[i] = a * w0[k] + b * w0[k + 1] + c * w0[k + pw] + d * w0[k + pw + 1];
      x1[i] = a * x0[k] + b * x0[k + 1] + c * x0[k + pw] + d * x0[k + pw + 1];
      y1[i] = a * y0[k] + b * y0[k + 1] + c * y0[k + pw] + d * y0[k + pw + 1];
    }
  }
  mirror(f, w1, -1, -1); mirror(f, x1, -1, 1); mirror(f, y1, 1, -1);
  for (let y = PAD; y < PAD + gh; y += 1) {
    for (let x = PAD, i = y * pw + PAD; x < PAD + gw; x += 1, i += 1) {
      const px = qx[i], py = qy[i];
      // the estimate traced forward again: where it differs from the field before the step, half of the difference is the error
      let rx = 2 * x - px, ry = 2 * y - py;
      rx = rx < lox ? lox : rx > hix ? hix : rx; ry = ry < loy ? loy : ry > hiy ? hiy : ry;
      let ix = rx | 0, iy = ry | 0, tx = rx - ix, ty = ry - iy, k = iy * pw + ix;
      const a = (1 - tx) * (1 - ty), b = tx * (1 - ty), c = (1 - tx) * ty, d = tx * ty;
      let wn = w1[i] + 0.5 * (w0[i] - (a * w1[k] + b * w1[k + 1] + c * w1[k + pw] + d * w1[k + pw + 1]));
      let xn = x1[i] + 0.5 * (x0[i] - (a * x1[k] + b * x1[k + 1] + c * x1[k + pw] + d * x1[k + pw + 1]));
      let yn = y1[i] + 0.5 * (y0[i] - (a * y1[k] + b * y1[k + 1] + c * y1[k + pw] + d * y1[k + pw + 1]));
      // the limiter: within the four values around the departure point
      ix = px | 0; iy = py | 0; k = iy * pw + ix;
      let p = w0[k], q = w0[k + 1], r = w0[k + pw], s = w0[k + pw + 1];
      let lo = p < q ? p : q, hi = p < q ? q : p;
      if (r < lo) lo = r; else if (r > hi) hi = r;
      if (s < lo) lo = s; else if (s > hi) hi = s;
      w2[i] = wn < lo ? lo : wn > hi ? hi : wn;
      p = x0[k]; q = x0[k + 1]; r = x0[k + pw]; s = x0[k + pw + 1];
      lo = p < q ? p : q; hi = p < q ? q : p;
      if (r < lo) lo = r; else if (r > hi) hi = r;
      if (s < lo) lo = s; else if (s > hi) hi = s;
      xn = xn < lo ? lo : xn > hi ? hi : xn;
      p = y0[k]; q = y0[k + 1]; r = y0[k + pw]; s = y0[k + pw + 1];
      lo = p < q ? p : q; hi = p < q ? q : p;
      if (r < lo) lo = r; else if (r > hi) hi = r;
      if (s < lo) lo = s; else if (s > hi) hi = s;
      yn = yn < lo ? lo : yn > hi ? hi : yn;
      // the page moved with the water over this step
      x2[i] = xn + (x - px) * cellX;
      y2[i] = yn + (y - py) * cellY;
    }
  }
  f.w = w2; f.dx = x2; f.dy = y2;
  tmp[5] = w0; tmp[6] = x0; tmp[7] = y0;
  f.traced = true;
}

// ---- 4. vorticity confinement ---------------------------------------------------------------------------------------------------------

/**
 * Vorticity confinement (Fedkiw, Stam and Jensen 2001): the force eps h (N x w), with N the unit vector up the gradient of |w|, gives
 * back the rotation that the transport on a coarse grid smears out. The curl of that force is -div(w V) with V = eps h N: the vorticity
 * is carried up its own gradient at the speed eps h. It is applied in that form, as upwind fluxes through the cell faces (none through
 * the walls), which keep the sum of w (the circulation). Carried up its gradient, the vorticity gathers: a plane flow without friction
 * keeps the vorticity of every drop of water, so its largest |w| never grows, and the result is limited to the largest |w| before the
 * step (`maxW`). Confinement then restores swirls that the grid smeared and cannot feed them, whatever eps.
 * @param {Fluid} f @param {number} eps  1/s
 */
function confine(f, eps) {
  const { pw, gw, gh, w, cellX, cellY, tmp } = f;
  const fx = tmp[0], fy = tmp[1];
  const h = Math.sqrt(cellX * cellY) * eps * DT, ix = 1 / cellX, iy = 1 / cellY, top = f.maxW;
  for (let y = PAD; y < PAD + gh; y += 1) {
    for (let i = y * pw + PAD, end = i + gw; i < end; i += 1) {
      // the face between this cell and the next one across, then the face between this cell and the next one down
      const a = Math.abs(w[i]), up = Math.abs(w[i - pw]), down = Math.abs(w[i + pw]), left = Math.abs(w[i - 1]), right = Math.abs(w[i + 1]);
      let gx = (right - a) * ix, gy = (down - up + Math.abs(w[i + pw + 1]) - Math.abs(w[i - pw + 1])) * 0.25 * iy;
      let v = (h * gx) / (Math.sqrt(gx * gx + gy * gy) + CONFINE_FLOOR);
      fx[i] = v * (v > 0 ? w[i] : w[i + 1]);
      gy = (down - a) * iy; gx = (right - left + Math.abs(w[i + pw + 1]) - Math.abs(w[i + pw - 1])) * 0.25 * ix;
      v = (h * gy) / (Math.sqrt(gx * gx + gy * gy) + CONFINE_FLOOR);
      fy[i] = v * (v > 0 ? w[i] : w[i + pw]);
    }
  }
  // no flux through the walls
  for (let y = PAD; y < PAD + gh; y += 1) { fx[y * pw + PAD - 1] = 0; fx[y * pw + PAD + gw - 1] = 0; }
  for (let x = PAD; x < PAD + gw; x += 1) { fy[(PAD - 1) * pw + x] = 0; fy[(PAD + gh - 1) * pw + x] = 0; }
  for (let y = PAD; y < PAD + gh; y += 1) {
    for (let i = y * pw + PAD, end = i + gw; i < end; i += 1) {
      const v = w[i] - ix * (fx[i] - fx[i - 1]) - iy * (fy[i] - fy[i - pw]);
      w[i] = v > top ? top : v < -top ? -top : v;
    }
  }
}

// ---- 5. friction ---------------------------------------------------------------------------------------------------------------------

/** The drag on the vorticity; `flowing` turns false, and the flow exactly zero, once no cell has any left. @param {Fluid} f @param {number} drag  1/s */
function slow(f, drag) {
  const { pw, gw, gh, w } = f;
  const keep = Math.exp(-drag * DT), loss = W_FRICTION * DT;
  let max = 0;
  for (let y = PAD; y < PAD + gh; y += 1) {
    for (let i = y * pw + PAD, end = i + gw; i < end; i += 1) {
      const v = w[i] * keep;
      if (v > loss) { const r = v - loss; w[i] = r; if (r > max) max = r; } else if (v < -loss) { const r = v + loss; w[i] = r; if (-r > max) max = -r; } else w[i] = 0;
    }
  }
  f.maxW = max;
  if (max > 0) mirror(f, w, -1, -1);
  else {
    f.w.fill(0); f.psi.fill(0); f.uc.fill(0); f.vc.fill(0);
    for (const l of f.levels) l.p.fill(0);
    f.flowing = false; f.maxSpeed = 0;
  }
}

/** The page heals: the displacement relaxes to zero at `heal` per second and at least STICK_PX_S; `box` follows. @param {Fluid} f @param {number} heal  1/s */
function healPage(f, heal) {
  const { pw, gw, gh, dx, dy, box } = f;
  const keep = Math.exp(-heal * DT), loss = STICK_PX_S * DT, loss2 = loss * loss;
  let x0 = pw, y0 = f.ph, x1 = -1, y1 = -1, max = 0;
  for (let y = PAD; y < PAD + gh; y += 1) {
    for (let x = PAD, i = y * pw + PAD; x < PAD + gw; x += 1, i += 1) {
      const a = dx[i] * keep, b = dy[i] * keep, q = a * a + b * b;
      if (q > loss2) {
        const m = Math.sqrt(q), k = (m - loss) / m;
        dx[i] = a * k; dy[i] = b * k;
        if (m > max) max = m;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      } else if (q > 0) { dx[i] = 0; dy[i] = 0; }
    }
  }
  f.maxShift = max;
  f.moved = x1 >= x0;
  if (f.moved) {
    // the ghost cells mirror the border cells
    box[0] = x0 < 2 * PAD ? 0 : x0; box[1] = y0 < 2 * PAD ? 0 : y0; box[2] = x1 >= gw ? pw - 1 : x1; box[3] = y1 >= gh ? f.ph - 1 : y1;
    mirror(f, dx, -1, 1); mirror(f, dy, 1, -1);
  } else { box[0] = pw; box[1] = f.ph; box[2] = -1; box[3] = -1; dx.fill(0); dy.fill(0); }
}

/**
 * One step of DT seconds. @param {Fluid} f
 * @param {{drag: number, heal: number, confine: number}} o  drag: decay of the flow, 1/s; heal: relaxation of the page, 1/s; confine: vorticity confinement, 1/s
 */
export function step(f, o) {
  f.traced = false;
  if (f.flowing) {
    solve(f);
    velocity(f);
    transport(f);
    if (o.confine > 0) { mirror(f, f.w, -1, -1); confine(f, o.confine); }
    slow(f, o.drag);
    healPage(f, o.heal);
  } else if (f.moved) healPage(f, o.heal);
}

// ---- stirring ------------------------------------------------------------------------------------------------------------------------

/**
 * Push the water at (x, y) CSS px: a velocity of (ax, ay) CSS px/s at the centre, falling to zero at `radius` as (1 - r^2/R^2)^3.
 * Added as its curl, a pair of counter-rotating swirls either side of the push. @param {Fluid} f
 * @param {number} x @param {number} y @param {number} ax @param {number} ay @param {number} radius
 */
export function stir(f, x, y, ax, ay, radius) {
  const { w, pw, gw, gh, cellX, cellY } = f;
  const r = Math.max(radius, 2 * Math.max(cellX, cellY));
  const gx = x / cellX - 0.5, gy = y / cellY - 0.5;
  const x0 = Math.max(0, Math.ceil(gx - r / cellX)), x1 = Math.min(gw - 1, Math.floor(gx + r / cellX));
  const y0 = Math.max(0, Math.ceil(gy - r / cellY)), y1 = Math.min(gh - 1, Math.floor(gy + r / cellY));
  const k = -6 / (r * r);
  for (let cy = y0; cy <= y1; cy += 1) {
    const ry = (cy - gy) * cellY;
    for (let cx = x0; cx <= x1; cx += 1) {
      const rx = (cx - gx) * cellX;
      const q = 1 - (rx * rx + ry * ry) / (r * r);
      if (q > 0) { const i = (cy + PAD) * pw + cx + PAD, v = w[i] + k * q * q * (ay * rx - ax * ry); w[i] = v; if (v > f.maxW) f.maxW = v; else if (-v > f.maxW) f.maxW = -v; }
    }
  }
  f.flowing = true;
}

/**
 * Spin the water around (x, y) CSS px: a swirl of vorticity `spin` (1/s; positive turns clockwise on the screen) at the centre, falling
 * to zero at `radius`. @param {Fluid} f @param {number} x @param {number} y @param {number} spin @param {number} radius
 */
export function twirl(f, x, y, spin, radius) {
  const { w, pw, gw, gh, cellX, cellY } = f;
  const r = Math.max(radius, 2 * Math.max(cellX, cellY));
  const gx = x / cellX - 0.5, gy = y / cellY - 0.5;
  const x0 = Math.max(0, Math.ceil(gx - r / cellX)), x1 = Math.min(gw - 1, Math.floor(gx + r / cellX));
  const y0 = Math.max(0, Math.ceil(gy - r / cellY)), y1 = Math.min(gh - 1, Math.floor(gy + r / cellY));
  for (let cy = y0; cy <= y1; cy += 1) {
    const ry = (cy - gy) * cellY;
    for (let cx = x0; cx <= x1; cx += 1) {
      const rx = (cx - gx) * cellX;
      const q = 1 - (rx * rx + ry * ry) / (r * r);
      if (q > 0) { const i = (cy + PAD) * pw + cx + PAD, v = w[i] + spin * q * q * q; w[i] = v; if (v > f.maxW) f.maxW = v; else if (-v > f.maxW) f.maxW = -v; }
    }
  }
  f.flowing = true;
}

/**
 * The velocity of the water at (x, y) CSS px as of the last step, CSS px/s (the cell under the point), written to `out`.
 * @param {Fluid} f @param {number} x @param {number} y @param {{x: number, y: number}} out
 */
export function velocityAt(f, x, y, out) {
  if (!f.flowing) { out.x = 0; out.y = 0; return; }
  const cx = Math.min(f.gw - 1, Math.max(0, Math.floor(x / f.cellX))), cy = Math.min(f.gh - 1, Math.max(0, Math.floor(y / f.cellY)));
  const i = (cy + PAD) * f.pw + cx + PAD;
  out.x = f.uc[i] * f.cellX * STEP_HZ; out.y = f.vc[i] * f.cellY * STEP_HZ;
}

// ---- the pigment, as far as the CPU follows it ------------------------------------------------------------------------------------------
// The pigment lives on the GPU, at a finer resolution than this grid (advect.wgsl); nothing is read back. `ink` is an upper bound of its
// density per cell, kept by the same rules, so the plugin knows when the last of it has faded.

/**
 * Pigment of density `amount` was released along the segment a - b (CSS px), reaching `reach` CSS px from it: raise the bound of every
 * cell that the release can touch. @param {Fluid} f
 * @param {number} ax @param {number} ay @param {number} bx @param {number} by @param {number} reach @param {number} amount
 */
export function inkAdd(f, ax, ay, bx, by, reach, amount) {
  const { ink, pw, gw, gh, cellX, cellY } = f;
  const r = reach + Math.hypot(cellX, cellY);
  const x0 = Math.max(0, Math.floor((Math.min(ax, bx) - r) / cellX)), x1 = Math.min(gw - 1, Math.floor((Math.max(ax, bx) + r) / cellX));
  const y0 = Math.max(0, Math.floor((Math.min(ay, by) - r) / cellY)), y1 = Math.min(gh - 1, Math.floor((Math.max(ay, by) + r) / cellY));
  const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey;
  for (let cy = y0; cy <= y1; cy += 1) {
    const y = (cy + 0.5) * cellY;
    for (let cx = x0; cx <= x1; cx += 1) {
      const x = (cx + 0.5) * cellX;
      const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * ex + (y - ay) * ey) / l2)) : 0;
      const qx = x - ax - t * ex, qy = y - ay - t * ey;
      if (qx * qx + qy * qy < r * r) { const i = (cy + PAD) * pw + cx + PAD, v = ink[i] + amount; ink[i] = v; if (v > f.maxInk) f.maxInk = v; }
    }
  }
}

/**
 * One step of the bound: each cell takes the largest bound among the 3 x 3 cells around where its water was a step ago (after a step
 * that moved the water), then fades as the pigment does: times `keep`, less `loss`, not below zero.
 * @param {Fluid} f @param {number} keep @param {number} loss
 */
export function inkCarry(f, keep, loss) {
  if (f.maxInk === 0) return;
  const { pw, gw, gh, tmp } = f;
  const from = f.ink, to = tmp[8], qx = tmp[3], qy = tmp[4];
  let max = 0;
  for (let y = PAD; y < PAD + gh; y += 1) {
    for (let x = PAD, i = y * pw + PAD; x < PAD + gw; x += 1, i += 1) {
      let m = from[i];
      if (f.traced) {
        const k = ((qy[i] + 0.5) | 0) * pw + ((qx[i] + 0.5) | 0);
        m = Math.max(from[k - pw - 1], from[k - pw], from[k - pw + 1], from[k - 1], from[k], from[k + 1], from[k + pw - 1], from[k + pw], from[k + pw + 1]);
      }
      m = m * keep - loss;
      if (m > 0) { to[i] = m; if (m > max) max = m; } else to[i] = 0;
    }
  }
  f.ink = to; tmp[8] = from; f.maxInk = max;
  if (max === 0) to.fill(0);
}

// ---- what the GPU and the input mapper read -------------------------------------------------------------------------------------------

/** floats per cell of the packed field: dx, dy (CSS px), psi (CSS px^2/s), w (1/s) */
export const CHANNELS = 4;

/** Write the field, ghost cells included, as CHANNELS floats per cell from `offset` of `out`. @param {Fluid} f @param {Float32Array} out @param {number} offset */
export function pack(f, out, offset) {
  const { dx, dy, psi, w } = f;
  for (let i = 0, o = offset, n = f.pw * f.ph; i < n; i += 1, o += 4) { out[o] = dx[i]; out[o + 1] = dy[i]; out[o + 2] = psi[i]; out[o + 3] = w[i]; }
}

const WX = new Float64Array(4), WY = new Float64Array(4), DX = new Float64Array(4), DY = new Float64Array(4);
/** Cubic B-spline weights at fraction t and their derivatives: the same polynomials as bs_w and bs_d in ink.wgsl. @param {number} t @param {Float64Array} w @param {Float64Array} d */
function weights(t, w, d) {
  const t2 = t * t, t3 = t2 * t, o = 1 - t;
  w[0] = (o * o * o) / 6; w[1] = (3 * t3 - 6 * t2 + 4) / 6; w[2] = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6; w[3] = t3 / 6;
  d[0] = -0.5 * o * o; d[1] = 1.5 * t2 - 2 * t; d[2] = -1.5 * t2 + t + 0.5; d[3] = 0.5 * t2;
}

/**
 * The displacement (CSS px) and the gradient of the stream function (per cell) of the B-spline surface over a packed field (row length
 * `pw`, starting at `offset`), at padded grid coordinate (gx, gy), where the centre of cell (i, j) of the padded grid sits at (i, j).
 * Reads cells floor(g) - 1 .. floor(g) + 2, clamped into the padded grid, as field_at in ink.wgsl does.
 * @param {ArrayLike<number>} field @param {number} offset @param {number} pw @param {number} ph @param {number} gx @param {number} gy
 * @returns {{dx: number, dy: number, px: number, py: number}}  px, py: d psi / d gx and d psi / d gy
 */
export function fieldAt(field, offset, pw, ph, gx, gy) {
  const bx = Math.floor(gx), by = Math.floor(gy);
  weights(gx - bx, WX, DX);
  weights(gy - by, WY, DY);
  let dx = 0, dy = 0, px = 0, py = 0;
  for (let b = 0; b < 4; b += 1) {
    const yy = Math.min(ph - 1, Math.max(0, by - 1 + b));
    for (let a = 0; a < 4; a += 1) {
      const xx = Math.min(pw - 1, Math.max(0, bx - 1 + a));
      const o = offset + (yy * pw + xx) * CHANNELS, k = WX[a] * WY[b], psi = field[o + 2];
      dx += k * field[o]; dy += k * field[o + 1];
      px += DX[a] * WY[b] * psi; py += WX[a] * DY[b] * psi;
    }
  }
  return { dx, dy, px, py };
}
