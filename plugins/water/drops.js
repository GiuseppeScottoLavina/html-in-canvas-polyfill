/**
 * The drops of the water plugin: the exact linear response of deep water to a drop, with the dispersion of real capillary-gravity waves.
 * PURE: no DOM, no GPU.
 *
 * A drop leaves a small crater with a raised rim (the initial surface h0(r), zero volume). Linear water waves are a superposition of
 * plane waves, each running at its own speed: omega(k)^2 = g k + (sigma / rho) k^3 (deep water: gravity and surface tension), damped
 * by the viscosity of water (2 nu k^2) and a film on the surface. For an axisymmetric start the surface at a later time is the
 * Cauchy-Poisson integral (Lamb, Hydrodynamics, art. 255):
 *
 *     h(r, t) = integral over k of  H0(k) cos(omega(k) t) exp(-gamma(k) t) J0(k r) k dk,     H0 = the Hankel transform of h0.
 *
 * That is why one drop rings out as a TRAIN of rings that grows: short capillary ripples run ahead, longer waves follow, the number of
 * crests grows as the train spreads and the centre calms down; the ring does not travel unchanged as the plain wave equation would.
 *
 * Every drop has the same shape (only its amplitude and place differ), so the profile is tabulated once: a table of the profile h(r)
 * and its derivatives (h, dh/dr, d2h/dr2, (dh/dr)/r) over r = 0 .. TABLE_R css px (one sample per TABLE_DR) at ROWS_PER_S instants a
 * second, computed row by row as the drops age (each row once, about 0.3 ms) and stored as half floats (an rgba16float texture, which
 * the GPU filters bilinearly in r and t). The input mapper reads the same half floats and interpolates them the same way.
 *
 * Units: css px, seconds. The water is real water (g, sigma / rho and nu of water at 20 C) at SCALE css px per cm.
 */

/** css px per cm: the canvas shows real water at this scale (a 1100 px canvas is a basin 1 m across) */
export const SCALE = 11;
/** gravity, surface tension over density and the kinematic viscosity of water, in css px and seconds */
export const GRAVITY = 981 * SCALE;
export const TENSION = 72.8 * SCALE ** 3;
export const VISCOSITY = 0.01 * SCALE ** 2;
/** the damping of a surface film (1/s, all wavelengths): with the viscosity it brings a drop to rest in under 2 s */
export const FILM_DAMPING = 1.2;
/** the radius of the crater a drop leaves, css px (the profile h0 = -(1 - r^2/a^2) exp(-r^2/a^2): a crater with a raised rim) */
export const DROP_A = 6;
/** the table: radius (css px), sample spacing (css px), rows a second, rows (its duration) */
export const TABLE_R = 560;
export const TABLE_DR = 1;
export const TABLE_W = Math.round(TABLE_R / TABLE_DR);
export const ROWS_PER_S = 120;
export const TABLE_ROWS = 240;
/**
 * The wavenumbers of the integral, up to where H0 has faded (exp(-12) of its peak). Spaced by 2 pi / (2 TABLE_R): a discrete sum over k
 * repeats in r with that period, so the ripples that run beyond the table come back as ghost rings, and they need longer than the
 * table's duration to do so (measured against a six times finer spacing: below 1e-6 of the largest slope over the 2 s of the table).
 */
const K_MAX = 7 / DROP_A;
const DK = (2 * Math.PI) / (2 * TABLE_R);
export const K_COUNT = Math.ceil(K_MAX / DK);
/** the table fades out over the last 12 % of its radius (the leading capillary ripples there are far below a pixel), and over its last
 * 0.3 s (only the strongest drops at full intensity still show a little then: they fade instead of stopping) */
const FADE_FROM = 0.88 * TABLE_R;
const FADE_ROWS = 0.3 * ROWS_PER_S;
/** the half floats store the profile times this power of two (exact): its values (at most 1) then use the normal range of a half float,
 * whose subnormals below 6e-5 would lose the faint tail of a ring (water.wgsl divides by it, data holds the profile itself) */
export const TABLE_SCALE = 256;
/** a sample of a row is "in the ring" above this share of the row's largest slope or curvature: outside, the GPU skips the drop */
export const RING_SHARE = 0.004;

/** omega and gamma of wavenumber k (rad/s, 1/s) @param {number} k */
export function dispersion(k) {
  return { omega: Math.sqrt(GRAVITY * k + TENSION * k * k * k), gamma: 2 * VISCOSITY * k * k + FILM_DAMPING };
}

/** J0(x) and J1(x)/x (rational approximations, absolute error below 1e-7; J1(x)/x is 1/2 at 0) @param {number} x @param {Float64Array} out */
function bessel(x, out) {
  const ax = Math.abs(x);
  if (ax < 8) {
    const y = x * x;
    out[0] = (57568490574.0 + y * (-13362590354.0 + y * (651619640.7 + y * (-11214424.18 + y * (77392.33017 + y * -184.9052456)))))
      / (57568490411.0 + y * (1029532985.0 + y * (9494680.718 + y * (59272.64853 + y * (267.8532712 + y)))));
    out[1] = (72362614232.0 + y * (-7895059235.0 + y * (242396853.1 + y * (-2972611.439 + y * (15704.48260 + y * -30.16036606)))))
      / (144725228442.0 + y * (2300535178.0 + y * (18583304.74 + y * (99447.43394 + y * (376.9991397 + y)))));
    return;
  }
  const z = 8 / ax, y = z * z;
  const s = Math.sqrt(0.636619772 / ax);
  const x0 = ax - 0.785398164;
  const p0 = 1 + y * (-0.1098628627e-2 + y * (0.2734510407e-4 + y * (-0.2073370639e-5 + y * 0.2093887211e-6)));
  const q0 = -0.1562499995e-1 + y * (0.1430488765e-3 + y * (-0.6911147651e-5 + y * (0.7621095161e-6 - y * 0.934935152e-7)));
  out[0] = s * (Math.cos(x0) * p0 - z * Math.sin(x0) * q0);
  const x1 = ax - 2.356194491;
  const p1 = 1 + y * (0.183105e-2 + y * (-0.3516396496e-4 + y * (0.2457520174e-5 + y * -0.240337019e-6)));
  const q1 = 0.04687499995 + y * (-0.2002690873e-3 + y * (0.8449199096e-5 + y * (-0.88228987e-6 + y * 0.105787412e-6)));
  out[1] = (s * (Math.cos(x1) * p1 - z * Math.sin(x1) * q1)) / ax;
}

/** float32 -> IEEE half (round to nearest even) @param {number} v */
export function toHalf(v) {
  F32[0] = v;
  const x = U32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let half = mant >>> shift;
    const rest = mant & ((1 << shift) - 1), mid = 1 << (shift - 1);
    if (rest > mid || (rest === mid && (half & 1))) half += 1;
    return sign | half;
  }
  let half = (e << 10) | (mant >>> 13);
  const rest = mant & 0x1fff;
  if (rest > 0x1000 || (rest === 0x1000 && (half & 1))) half += 1;
  return sign | half;
}
const F32 = new Float32Array(1), U32 = new Uint32Array(F32.buffer);

/** IEEE half -> number @param {number} h */
export function fromHalf(h) {
  const sign = h & 0x8000 ? -1 : 1, e = (h >>> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return sign * m * 2 ** -24;
  if (e === 0x1f) return m ? NaN : sign * Infinity;
  return sign * (1 + m / 1024) * 2 ** (e - 15);
}

/**
 * @typedef {Object} DropTable
 * @property {number} rows  rows computed so far (0 .. TABLE_ROWS)
 * @property {number} bessel  radii whose Bessel terms are computed so far (0 .. TABLE_W)
 * @property {Uint16Array} half  TABLE_W x TABLE_ROWS x 4 halfs: h, dh/dr, d2h/dr2, (dh/dr)/r of a drop of unit depth, times TABLE_SCALE
 * @property {Float32Array} data  the same values, decoded (what the mapper reads)
 * @property {Float32Array} slope  per row: the largest |dh/dr|
 * @property {Float32Array} curv  per row: the largest curvature (|d2h/dr2| or |(dh/dr)/r|)
 * @property {Float32Array} inner  per row: the ring, css px: below `inner` and beyond `outer` the drop is below RING_SHARE of its row
 * @property {Float32Array} outer
 * @property {Float32Array} j0  J0(k r) for every (r, k), and J1(k r)/(k r)
 * @property {Float32Array} j1x
 * @property {Float64Array} k  the wavenumbers, and their weights H0(k) k dk; omega, gamma
 * @property {Float64Array} weight
 * @property {Float64Array} omega
 * @property {Float64Array} gamma
 */

/** The empty table: no Bessel term and no row yet (prepareTable and computeRow compute them). @returns {DropTable} */
export function createDropTable() {
  const n = K_COUNT;
  const k = new Float64Array(n), weight = new Float64Array(n), omega = new Float64Array(n), gamma = new Float64Array(n);
  const a = DROP_A;
  for (let j = 0; j < n; j += 1) {
    const kj = (j + 0.5) * DK;
    k[j] = kj;
    // h0(r) = -(1 - r^2/a^2) exp(-r^2/a^2): its Hankel transform is -(a^4 / 8) k^2 exp(-k^2 a^2 / 4) (a crater of depth 1, zero volume)
    const d = dispersion(kj);
    omega[j] = d.omega; gamma[j] = d.gamma;
    // an impulse (the drop's momentum) of the shape h0: the surface starts flat and the crater opens, as at an impact; sin(omega t) / omega
    weight[j] = (-(a ** 4 / 8) * kj * kj * Math.exp((-kj * kj * a * a) / 4) * kj * DK) / d.omega;
  }
  // normalised so that a drop of depth 1 opens a crater 1 css px deep at its deepest (within the first 60 ms)
  let deepest = 0;
  for (let t = 0; t < 0.06; t += 0.0002) {
    let h = 0;
    for (let j = 0; j < n; j += 1) h += weight[j] * Math.sin(omega[j] * t) * Math.exp(-gamma[j] * t);
    deepest = Math.max(deepest, -h);
  }
  for (let j = 0; j < n; j += 1) weight[j] /= deepest;
  const j0 = new Float32Array(TABLE_W * n), j1x = new Float32Array(TABLE_W * n);
  return {
    rows: 0, bessel: 0, half: new Uint16Array(TABLE_W * TABLE_ROWS * 4), data: new Float32Array(TABLE_W * TABLE_ROWS * 4),
    slope: new Float32Array(TABLE_ROWS), curv: new Float32Array(TABLE_ROWS), inner: new Float32Array(TABLE_ROWS), outer: new Float32Array(TABLE_ROWS),
    j0, j1x, k, weight, omega, gamma,
  };
}

const C = new Float64Array(K_COUNT), CK = new Float64Array(K_COUNT);
const B2 = new Float64Array(2);

/** The Bessel terms of `count` more radii (about 200 wavenumbers each). @param {DropTable} tb @param {number} count */
function besselRadii(tb, count) {
  const n = K_COUNT, end = Math.min(TABLE_W, tb.bessel + count);
  for (let i = tb.bessel; i < end; i += 1) {
    const r = i * TABLE_DR;
    for (let j = 0; j < n; j += 1) { bessel(tb.k[j] * r, B2); tb.j0[i * n + j] = B2[0]; tb.j1x[i * n + j] = B2[1]; }
  }
  tb.bessel = end;
}

/**
 * Advance the table until `deadline` (performance.now() ms): the Bessel terms first, then the rows, in slices of about 0.4 ms, so that a
 * page can fill it in idle time before the first drop needs it. Returns true once the table is complete.
 * @param {DropTable} tb @param {number} deadline
 */
export function prepareTable(tb, deadline) {
  while (tb.rows < TABLE_ROWS) {
    if (tb.bessel < TABLE_W) besselRadii(tb, 24); else computeRow(tb);
    if (performance.now() >= deadline) break;
  }
  return tb.rows >= TABLE_ROWS;
}

/** Compute the next row of the table. @param {DropTable} tb */
export function computeRow(tb) {
  const row = tb.rows;
  if (row >= TABLE_ROWS) return;
  if (tb.bessel < TABLE_W) besselRadii(tb, TABLE_W);
  const t = row / ROWS_PER_S, n = K_COUNT;
  const left = (TABLE_ROWS - 1 - row) / FADE_ROWS, fade = left >= 1 ? 1 : left * left * (3 - 2 * left);
  for (let j = 0; j < n; j += 1) {
    C[j] = fade * tb.weight[j] * Math.sin(tb.omega[j] * t) * Math.exp(-tb.gamma[j] * t);
    CK[j] = C[j] * tb.k[j] * tb.k[j];
  }
  const base = row * TABLE_W * 4;
  let slope = 0, curv = 0;
  for (let i = 0; i < TABLE_W; i += 1) {
    let h = 0, bsum = 0, qsum = 0;
    const o = i * n;
    for (let j = 0; j < n; j += 1) { const c0 = tb.j0[o + j]; h += C[j] * c0; bsum += CK[j] * c0; qsum += CK[j] * tb.j1x[o + j]; }
    const r = i * TABLE_DR;
    // dh/dr = r q, q = -(sum c k^2 J1(kr)/(kr)); d2h/dr2 = -(sum c k^2 J0) + (sum c k^2 J1(kr)/(kr))
    let q = -qsum, hr = r * q, hrr = -bsum + qsum;
    // the fade at the far end of the table (the leading ripples there are far below a pixel; this keeps the edge invisible)
    if (r > FADE_FROM) { const s = (TABLE_R - r) / (TABLE_R - FADE_FROM); const w = s * s * (3 - 2 * s); h *= w; hr *= w; hrr *= w; q *= w; }
    const p = base + i * 4;
    const vals = [h, hr, hrr, q];
    for (let c = 0; c < 4; c += 1) { const hv = toHalf(vals[c] * TABLE_SCALE); tb.half[p + c] = hv; tb.data[p + c] = fromHalf(hv) / TABLE_SCALE; }
    slope = Math.max(slope, Math.abs(tb.data[p + 1]));
    curv = Math.max(curv, Math.abs(tb.data[p + 2]), Math.abs(tb.data[p + 3]));
  }
  tb.slope[row] = slope; tb.curv[row] = curv;
  // the ring of this row: where the slope or the curvature exceeds RING_SHARE of the row's largest
  let inner = TABLE_R, outer = 0;
  for (let i = 0; i < TABLE_W; i += 1) {
    const p = base + i * 4;
    if (Math.abs(tb.data[p + 1]) > RING_SHARE * slope || Math.abs(tb.data[p + 2]) > RING_SHARE * curv || Math.abs(tb.data[p + 3]) > RING_SHARE * curv) {
      inner = Math.min(inner, i * TABLE_DR); outer = i * TABLE_DR;
    }
  }
  tb.inner[row] = Math.max(0, inner - 2 * TABLE_DR); tb.outer[row] = Math.min(TABLE_R, outer + 2 * TABLE_DR);
  tb.rows = row + 1;
}

/**
 * The profile of a drop of unit depth at distance r css px and fractional row `row` (age x ROWS_PER_S), interpolated bilinearly as the
 * GPU's filtering sampler does (texel centres, clamp to edge). Writes h, dh/dr, d2h/dr2, (dh/dr)/r into `out`.
 * @param {Float32Array} data @param {number} r @param {number} row @param {Float64Array} out
 */
export function profileAt(data, r, row, out) {
  const x = Math.min(TABLE_W - 1, Math.max(0, r / TABLE_DR)), y = Math.min(TABLE_ROWS - 1, Math.max(0, row));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(TABLE_W - 1, x0 + 1), y1 = Math.min(TABLE_ROWS - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const a = (y0 * TABLE_W + x0) * 4, b = (y0 * TABLE_W + x1) * 4, c = (y1 * TABLE_W + x0) * 4, d = (y1 * TABLE_W + x1) * 4;
  for (let i = 0; i < 4; i += 1) {
    out[i] = (data[a + i] * (1 - fx) + data[b + i] * fx) * (1 - fy) + (data[c + i] * (1 - fx) + data[d + i] * fx) * fy;
  }
}

/** floats per source in the uniform block: x, y (css px), row, depth (css px); inner, outer (css px), 0, 0 */
export const SOURCE_FLOATS = 8;
/** sources the shader evaluates at most (drops and their mirror images in the walls) */
export const MAX_SOURCES = 96;

const P = new Float64Array(4);
/**
 * The drops' surface at (x, y) css px: height, slope (per css px) and Hessian (xx, yy, xy per css px^2), summed over `count` sources
 * of `state` from `offset` (SOURCE_FLOATS each). The same sum as drops() in water.wgsl. @param {Float32Array} data the table
 * @param {ArrayLike<number>} state @param {number} offset @param {number} count @param {number} x @param {number} y
 */
export function dropsAt(data, state, offset, count, x, y) {
  let h = 0, sx = 0, sy = 0, hxx = 0, hyy = 0, hxy = 0;
  for (let s = 0; s < count; s += 1) {
    const o = offset + s * SOURCE_FLOATS;
    const dx = x - state[o], dy = y - state[o + 1];
    const d2 = dx * dx + dy * dy, inner = state[o + 4], outer = state[o + 5];
    if (d2 > outer * outer || d2 < inner * inner) continue;
    const r = Math.sqrt(d2);
    if (r < inner || r > outer) continue;
    profileAt(data, r, state[o + 2], P);
    const amp = state[o + 3];
    const nx = r > 1e-4 ? dx / r : 0, ny = r > 1e-4 ? dy / r : 0;
    h += amp * P[0];
    sx += amp * P[1] * nx; sy += amp * P[1] * ny;
    // Hessian of a radial function: h'' n n^T + (h'/r)(I - n n^T)
    const rad = amp * P[2], tan = amp * P[3];
    hxx += rad * nx * nx + tan * (1 - nx * nx);
    hyy += rad * ny * ny + tan * (1 - ny * ny);
    hxy += (rad - tan) * nx * ny;
  }
  return { h, sx, sy, hxx, hyy, hxy };
}

/**
 * The drops are evaluated once per CSS pixel into two rgba16float textures (water.wgsl fs_drops), which the picture samples bilinearly:
 * the grid of a canvas of css size (w, h) has ceil(w) x ceil(h) texels (water.wgsl drop_grid). @param {number} w @param {number} h
 */
export function dropGrid(w, h) {
  return { w: Math.max(1, Math.ceil(Math.fround(w) - 0.01)), h: Math.max(1, Math.ceil(Math.fround(h) - 0.01)) };
}

const S00 = [0, 0], S10 = [0, 0], S01 = [0, 0], S11 = [0, 0];
/**
 * The drops' slope at (x, y) css px as the picture sees it: dropsAt at the four texel centres of the grid around the point, rounded to
 * half floats as the texture stores them, interpolated bilinearly (clamped to the edge texels) as the GPU's sampler does.
 * @param {Float32Array} data @param {ArrayLike<number>} state @param {number} offset @param {number} count
 * @param {number} x @param {number} y @param {number} cssW @param {number} cssH
 * @param {Map<number, number[]>} [cache]  texels already evaluated for this very state (a mapper maps many points of one frame)
 */
export function dropsSlope(data, state, offset, count, x, y, cssW, cssH, cache) {
  const g = dropGrid(cssW, cssH);
  const sx = cssW / g.w, sy = cssH / g.h;
  const tx = Math.min(g.w - 1, Math.max(0, x / sx - 0.5)), ty = Math.min(g.h - 1, Math.max(0, y / sy - 0.5));
  const i0 = Math.floor(tx), j0 = Math.floor(ty), i1 = Math.min(g.w - 1, i0 + 1), j1 = Math.min(g.h - 1, j0 + 1);
  const fx = tx - i0, fy = ty - j0;
  const at = (/** @type {number} */ i, /** @type {number} */ j, /** @type {number[]} */ out) => {
    const known = cache?.get(j * g.w + i);
    if (known) { out[0] = known[0]; out[1] = known[1]; return; }
    const d = dropsAt(data, state, offset, count, (i + 0.5) * sx, (j + 0.5) * sy);
    out[0] = fromHalf(toHalf(d.sx)); out[1] = fromHalf(toHalf(d.sy));
    cache?.set(j * g.w + i, [out[0], out[1]]);
  };
  at(i0, j0, S00); at(i1, j0, S10); at(i0, j1, S01); at(i1, j1, S11);
  return {
    sx: (S00[0] * (1 - fx) + S10[0] * fx) * (1 - fy) + (S01[0] * (1 - fx) + S11[0] * fx) * fy,
    sy: (S00[1] * (1 - fx) + S10[1] * fx) * (1 - fy) + (S01[1] * (1 - fx) + S11[1] * fx) * fy,
  };
}
