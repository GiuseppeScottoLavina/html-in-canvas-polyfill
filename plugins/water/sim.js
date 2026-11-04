/**
 * The water surface of the water plugin: a height field on a grid of square-ish cells over the canvas, advanced by the wave equation
 * at a fixed rate (STEP_HZ, independent of the display and of the frame cap), with reflecting walls and a damping that brings it back to
 * a flat, still surface. PURE: no DOM, no GPU; index.js uploads `h` as an r32float texture and water.wgsl evaluates it exactly as
 * `surfaceAt` below does (a cubic B-spline over 4 x 4 cells), so the input mapper and the pixels describe the same surface.
 *
 * Units: positions and heights in CSS px of the canvas; the field stores heights per cell, with PAD ghost cells on every side that mirror
 * the border cells (a wall: no slope across the edge).
 */

/** ghost cells on each side (the B-spline reads one cell beyond the border, and two at the far border) */
export const PAD = 2;
/** simulation steps per second (fixed time step) */
export const STEP_HZ = 120;
export const STEP_MS = 1000 / STEP_HZ;
/** at most this many steps per rendered frame: a longer gap (an off-screen pause, a frame cap of 1) is skipped, not caught up */
export const MAX_STEPS_PER_FRAME = 20;
/** at most this many interior cells (the cost of a step and of the upload); cells are at least MIN_CELL_PX wide */
export const MAX_CELLS = 65536;
export const MIN_CELL_PX = 3;
/** speed of the ripples, CSS px per second */
export const WAVE_SPEED_PX_S = 270;
/** velocity damping per step, and the viscosity (damps short ripples faster than long waves, as in real water): a strong drop is flat
 * again (below the thresholds of `quiet`) about 1.5 s later, the rain of the action demo about 2 s after its last drop */
export const DAMPING = 0.987;
export const VISCOSITY = 0.06;
/** css px of displacement per unit slope at intensity 1 (the refraction through the water onto the page below) */
export const REFRACT_PX = 30;
/** the same for the light: the caustics focus as if the page lay this deep */
export const CAUSTIC_PX = 64;

/**
 * @typedef {Object} Field
 * @property {number} cssWidth
 * @property {number} cssHeight
 * @property {number} gw  interior cells across
 * @property {number} gh  interior cells down
 * @property {number} pw  gw + 2 PAD (row length of h and v)
 * @property {number} ph
 * @property {number} cellX  css px per cell
 * @property {number} cellY
 * @property {number} c2  (wave speed in cells per step)^2
 * @property {Float32Array} h  heights, css px, pw x ph (ghost cells included)
 * @property {Float32Array} v  vertical velocity, css px per step
 * @property {Float32Array} lap  the Laplacian of h of the previous step (its change is the Laplacian of v: the viscosity)
 */

/** The grid of a canvas of this css size. @param {number} cssWidth @param {number} cssHeight */
export function gridOf(cssWidth, cssHeight) {
  const w = Math.max(1, cssWidth), h = Math.max(1, cssHeight);
  const cell = Math.max(MIN_CELL_PX, Math.sqrt((w * h) / MAX_CELLS));
  return { gw: Math.max(8, Math.round(w / cell)), gh: Math.max(8, Math.round(h / cell)) };
}

/** Fit the cell size to a new css size of the same grid (a fraction of a pixel of resize keeps the ripples). @param {Field} f @param {number} cssWidth @param {number} cssHeight */
export function setSize(f, cssWidth, cssHeight) {
  f.cssWidth = Math.max(1, cssWidth); f.cssHeight = Math.max(1, cssHeight);
  f.cellX = f.cssWidth / f.gw; f.cellY = f.cssHeight / f.gh;
  // stable for c2 <= 0.45 with this viscosity (the 9-point Laplacian, symplectic Euler): cells under 3.4 px slow the ripples down a little
  const c = WAVE_SPEED_PX_S / (STEP_HZ * Math.max(f.cellX, f.cellY));
  f.c2 = Math.min(0.45, c * c);
}

/** @param {number} cssWidth @param {number} cssHeight @returns {Field} */
export function createField(cssWidth, cssHeight) {
  const { gw, gh } = gridOf(cssWidth, cssHeight);
  const pw = gw + 2 * PAD, ph = gh + 2 * PAD;
  const f = { cssWidth: 1, cssHeight: 1, gw, gh, pw, ph, cellX: 1, cellY: 1, c2: 0, h: new Float32Array(pw * ph), v: new Float32Array(pw * ph), lap: new Float32Array(pw * ph) };
  setSize(f, cssWidth, cssHeight);
  return f;
}

/** Copy the border cells into the ghost cells (mirrored about the wall). @param {Field} f */
export function mirror(f) {
  const { h, pw, ph, gw, gh } = f;
  for (let y = PAD; y < PAD + gh; y += 1) {
    const row = y * pw;
    for (let k = 1; k <= PAD; k += 1) {
      h[row + PAD - k] = h[row + PAD + k - 1];
      h[row + PAD + gw - 1 + k] = h[row + PAD + gw - k];
    }
  }
  for (let k = 1; k <= PAD; k += 1) {
    h.copyWithin((PAD - k) * pw, (PAD + k - 1) * pw, (PAD + k) * pw);
    h.copyWithin((PAD + gh - 1 + k) * pw, (PAD + gh - k) * pw, (PAD + gh - k + 1) * pw);
  }
  void ph;
}

/**
 * One step of the damped wave equation (symplectic Euler: the velocity from the isotropic 9-point Laplacian, then the height), then the
 * walls. @param {Field} f
 */
export function step(f) {
  const { h, v, lap, pw, gw, gh, c2 } = f;
  const nu = VISCOSITY, damping = DAMPING;
  for (let y = PAD; y < PAD + gh; y += 1) {
    let i = y * pw + PAD;
    const end = i + gw;
    for (; i < end; i += 1) {
      const l = (4 * (h[i - 1] + h[i + 1] + h[i - pw] + h[i + pw]) + h[i - pw - 1] + h[i - pw + 1] + h[i + pw - 1] + h[i + pw + 1] - 20 * h[i]) / 6;
      v[i] = (v[i] + c2 * l + nu * (l - lap[i])) * damping;
      lap[i] = l;
    }
  }
  for (let y = PAD; y < PAD + gh; y += 1) {
    let i = y * pw + PAD;
    const end = i + gw;
    for (; i < end; i += 1) h[i] += v[i];
  }
  mirror(f);
}

/**
 * Add a smooth bump (raised cosine) of `amplitude` css px (negative: a dent, as a drop makes) and `radius` css px at (x, y) css px.
 * The ghost cells are refreshed by the next `step` or `mirror`. @param {Field} f
 * @param {number} x @param {number} y @param {number} radius @param {number} amplitude
 */
export function stamp(f, x, y, radius, amplitude) {
  const { h, pw, gw, gh, cellX, cellY } = f;
  const r = Math.max(radius, 1.5 * Math.max(cellX, cellY));
  const gx = x / cellX - 0.5, gy = y / cellY - 0.5;
  const rx = r / cellX, ry = r / cellY;
  const x0 = Math.max(0, Math.floor(gx - rx)), x1 = Math.min(gw - 1, Math.ceil(gx + rx));
  const y0 = Math.max(0, Math.floor(gy - ry)), y1 = Math.min(gh - 1, Math.ceil(gy + ry));
  for (let cy = y0; cy <= y1; cy += 1) {
    const dy = (cy - gy) * cellY;
    for (let cx = x0; cx <= x1; cx += 1) {
      const dx = (cx - gx) * cellX;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < r) h[(cy + PAD) * pw + cx + PAD] += amplitude * (0.5 + 0.5 * Math.cos((Math.PI * d) / r));
    }
  }
}

/** Flat and still. @param {Field} f */
export function clear(f) { f.h.fill(0); f.v.fill(0); f.lap.fill(0); }

/** what a pixel cannot show: a shift of the page (css px) and a change of the caustic focus (relative) at intensity 1 */
export const QUIET_SHIFT_PX = 0.06;
export const QUIET_FOCUS = 0.006;

/**
 * The surface is visibly flat and still at `intensity` (0..1): the refraction moves no pixel by more than QUIET_SHIFT_PX, the caustics
 * change no focus by more than QUIET_FOCUS, and the velocity would not change that within a few steps. The caller then clears the field: the last steps of a ripple are below what a pixel shows.
 * @param {Field} f @param {number} [intensity]
 */
export function quiet(f, intensity = 1) {
  const { h, v, pw, gw, gh, cellX, cellY } = f;
  const cell = Math.min(cellX, cellY);
  const k = Math.max(1e-3, intensity);
  const gradLimit = (QUIET_SHIFT_PX * cell) / (REFRACT_PX * k);
  const lapLimit = (QUIET_FOCUS * cell * cell) / (CAUSTIC_PX * k);
  const vLimit = gradLimit * 0.25;
  for (let y = PAD; y < PAD + gh; y += 1) {
    let i = y * pw + PAD;
    const end = i + gw;
    for (; i < end; i += 1) {
      const c = h[i];
      if (c !== c) { clear(f); return true; }   // NaN (cannot happen with the stable constants above): reset to flat rather than run forever
      const gx = h[i + 1] - c, gy = h[i + pw] - c;
      if (gx > gradLimit || -gx > gradLimit || gy > gradLimit || -gy > gradLimit) return false;
      const lap = h[i - 1] + h[i + 1] + h[i - pw] + h[i + pw] - 4 * c;
      if (lap > lapLimit || -lap > lapLimit) return false;
      const s = v[i];
      if (s > vLimit || -s > vLimit) return false;
    }
  }
  return true;
}

/**
 * Cubic B-spline weights at fraction t, and their first and second derivatives. The same polynomials as bspline() in water.wgsl.
 * @param {number} t @param {Float64Array} w @param {Float64Array} d @param {Float64Array} [dd]
 */
function weights(t, w, d, dd) {
  const t2 = t * t, t3 = t2 * t, o = 1 - t;
  w[0] = (o * o * o) / 6; w[1] = (3 * t3 - 6 * t2 + 4) / 6; w[2] = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6; w[3] = t3 / 6;
  d[0] = -0.5 * o * o; d[1] = 1.5 * t2 - 2 * t; d[2] = -1.5 * t2 + t + 0.5; d[3] = 0.5 * t2;
  if (dd) { dd[0] = o; dd[1] = 3 * t - 2; dd[2] = 1 - 3 * t; dd[3] = t; }
}
const WX = new Float64Array(4), WY = new Float64Array(4), DX = new Float64Array(4), DY = new Float64Array(4);

/**
 * Height and gradient (per cell) of the B-spline surface over `field` (a padded grid of row length `pw` starting at `offset`), at padded
 * grid coordinate (gx, gy), where cell centre (i, j) of the padded grid sits at (i, j). Reads cells floor(g) - 1 .. floor(g) + 2, clamped
 * into the padded grid (the shader's textureLoad clamps the same way).
 * @param {ArrayLike<number>} field @param {number} offset @param {number} pw @param {number} ph @param {number} gx @param {number} gy
 * @returns {{h: number, hx: number, hy: number}}
 */
export function surfaceAt(field, offset, pw, ph, gx, gy) {
  const bx = Math.floor(gx), by = Math.floor(gy);
  weights(gx - bx, WX, DX);
  weights(gy - by, WY, DY);
  let h = 0, hx = 0, hy = 0;
  for (let b = 0; b < 4; b += 1) {
    const yy = Math.min(ph - 1, Math.max(0, by - 1 + b));
    for (let a = 0; a < 4; a += 1) {
      const xx = Math.min(pw - 1, Math.max(0, bx - 1 + a));
      const val = field[offset + yy * pw + xx];
      h += WX[a] * WY[b] * val;
      hx += DX[a] * WY[b] * val;
      hy += WX[a] * DY[b] * val;
    }
  }
  return { h, hx, hy };
}

/**
 * The ambient swell (option `ambient`): three long plane waves, analytic (no simulation): slope at (x, y) css px, time t s, for an
 * amplitude of `amp` css px. The same waves as ambient() in water.wgsl.
 * @param {number} x @param {number} y @param {number} t @param {number} amp
 */
export function ambientSlope(x, y, t, amp) {
  let sx = 0, sy = 0;
  for (const [kx, ky, w, a, p] of AMBIENT_WAVES) {
    const c = Math.cos(kx * x + ky * y - w * t + p) * a * amp;
    sx += c * kx; sy += c * ky;
  }
  return { x: sx, y: sy };
}

/** [kx, ky (rad per css px), angular speed (rad/s), relative amplitude, phase]: wavelengths 300, 190 and 130 px, from three directions */
export const AMBIENT_WAVES = Object.freeze([
  Object.freeze([0.019622, 0.007141, 0.76, 1.0, 0.0]),
  Object.freeze([-0.020143, 0.025003, 0.96, 0.55, 1.9]),
  Object.freeze([0.019610, -0.042028, 1.25, 0.32, 4.1]),
]);
