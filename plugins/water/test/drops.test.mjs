// The drops of the water plugin (drops.js): the tabulated Cauchy-Poisson profile against an independent evaluation of the integral; the
// physics it must show (it starts flat and opens a crater of the asked depth, it carries no volume, it disperses: the train of crests
// grows and its wavelengths spread, which the plain wave equation of the wakes does not do: the control); the half floats the GPU reads;
// the interpolation the mapper shares with the GPU's sampler; the ring culling; the mirror images that make the walls reflect.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DROP_A, FILM_DAMPING, GRAVITY, K_COUNT, VISCOSITY, RING_SHARE, ROWS_PER_S, SOURCE_FLOATS, TABLE_DR, TABLE_ROWS, TABLE_W, TENSION, computeRow, createDropTable,
  dispersion, dropGrid, dropsAt, dropsSlope, fromHalf, prepareTable, profileAt, toHalf,
} from '../drops.js';
import { DROP_DEPTH, G, SOURCES_OFFSET, UNIFORM_LENGTH, plugin as WaterEffectPlugin } from '../index.js';
import { PAD, STEP_HZ, createField, mirror, step } from '../sim.js';

const TABLE = createDropTable();
prepareTable(TABLE, Infinity);
const row = (/** @type {number} */ n, /** @type {number} */ c) => Array.from({ length: TABLE_W }, (_, i) => TABLE.data[(n * TABLE_W + i) * 4 + c]);

// ---- an independent oracle: J0 by its integral (1/pi) int_0^pi cos(x sin t) dt (Simpson), the integral over k on a 4x finer grid ----
function j0(/** @type {number} */ x) {
  const n = 2 * Math.ceil(Math.abs(x) + 24); let s = 0;
  for (let i = 0; i <= n; i += 1) { const t = (Math.PI * i) / n; s += (i === 0 || i === n ? 1 : i % 2 ? 4 : 2) * Math.cos(x * Math.sin(t)); }
  return (s * (Math.PI / n)) / 3 / Math.PI;
}
const a = DROP_A;
const ks = []; { const dk = Math.PI / (2 * 560) / 2; for (let k = dk / 2; k < 7 / a; k += dk) ks.push([k, dk]); }
/** h(r, t) of a drop of unit impulse (unnormalised): sum of H0(k)/omega sin(omega t) exp(-gamma t) J0(k r) k dk */
function oracleH(/** @type {number} */ r, /** @type {number} */ t) {
  let h = 0;
  for (const [k, dk] of ks) {
    const w = Math.sqrt(GRAVITY * k + TENSION * k ** 3), g = 2 * VISCOSITY * k * k + FILM_DAMPING;
    h += (-(a ** 4 / 8) * k * k * Math.exp((-k * k * a * a) / 4) / w) * Math.sin(w * t) * Math.exp(-g * t) * j0(k * r) * k * dk;
  }
  return h;
}

test('the table equals an independent evaluation of the Cauchy-Poisson integral (another Bessel function, a 4x finer wavenumber grid), up to its normalisation', () => {
  // the normalisation: the deepest crater within 60 ms is 1 css px
  let deepest = 0;
  for (let t = 0; t < 0.06; t += 0.0002) deepest = Math.max(deepest, -oracleH(0, t));
  for (const n of [6, 30, 60, 120]) {
    const t = n / ROWS_PER_S, h = row(n, 0);
    const max = Math.max(...h.map(Math.abs));
    let worst = 0;
    for (let r = 0; r < 260; r += 13) worst = Math.max(worst, Math.abs(h[r / TABLE_DR] - oracleH(r, t) / deepest));
    assert.ok(worst < 0.01 * max + 2e-4, `row ${n} (${Math.round(t * 1000)} ms): worst ${worst.toExponential(2)} of a largest |h| ${max.toExponential(2)}`);
  }
});

test('the derivatives in the table are those of its heights (dh/dr, d2h/dr2, (dh/dr)/r against finite differences)', () => {
  for (const n of [12, 48, 120]) {
    const h = row(n, 0), hr = row(n, 1), hrr = row(n, 2), q = row(n, 3);
    const scale = Math.max(...hr.map(Math.abs)), scale2 = Math.max(...hrr.map(Math.abs));
    for (let i = 4; i < 400; i += 7) {
      const fd = (h[i + 1] - h[i - 1]) / (2 * TABLE_DR), fd2 = (h[i + 1] - 2 * h[i] + h[i - 1]) / (TABLE_DR * TABLE_DR);
      assert.ok(Math.abs(fd - hr[i]) < 0.03 * scale, `row ${n} r ${i}: dh/dr ${hr[i]} vs ${fd}`);
      assert.ok(Math.abs(fd2 - hrr[i]) < 0.06 * scale2, `row ${n} r ${i}: d2h/dr2 ${hrr[i]} vs ${fd2}`);
      assert.ok(Math.abs(q[i] * i * TABLE_DR - hr[i]) < 2e-3 * scale + 1e-6, `row ${n} r ${i}: (dh/dr)/r`);
    }
  }
});

test('a drop starts flat, opens a crater 1 css px deep at its deepest, carries no volume, and rings out to a flat surface by the end of the table', () => {
  assert.ok(row(0, 0).every((v) => v === 0), 'flat at the impact');
  let deepest = 0;
  for (let n = 0; n < 8; n += 1) deepest = Math.min(deepest, TABLE.data[n * TABLE_W * 4]);
  assert.ok(deepest < -0.9 && deepest > -1.0001, `the crater: ${deepest} css px`);
  for (const n of [12, 60, 120]) {
    const h = row(n, 0);
    let vol = 0, abs = 0;
    for (let i = 0; i < TABLE_W; i += 1) { const ring = 2 * Math.PI * Math.max(0.25, i) * TABLE_DR * TABLE_DR; vol += h[i] * ring; abs += Math.abs(h[i]) * ring; }
    assert.ok(Math.abs(vol) < 0.02 * abs, `row ${n}: no volume (${vol.toExponential(2)} of ${abs.toExponential(2)})`);
  }
  const last = TABLE_ROWS - 1;
  assert.equal(TABLE.slope[last], 0, 'the last row is flat (the fade)');
  assert.ok(TABLE.slope[ROWS_PER_S] < 0.05 * TABLE.slope[12], 'a second later the slopes are below 5 % of those at 0.1 s');
});

/** crests of a radial profile: local maxima above 5 % of its largest |h|, beyond the first 3 px */
function crests(/** @type {number[]} */ h) {
  const max = Math.max(...h.map(Math.abs));
  const at = [];
  for (let i = 3; i < h.length - 1; i += 1) if (h[i] > h[i - 1] && h[i] >= h[i + 1] && h[i] > 0.05 * max) at.push(i);
  return at;
}

test('dispersion: a drop rings out as a train that grows, its wavelengths spread (the short capillary ripples run ahead); control: the plain wave equation keeps one ring of the same shape', () => {
  const early = crests(row(30, 0)), late = crests(row(90, 0));
  assert.ok(late.length >= early.length + 3, `crests at 0.25 s: ${early.length}, at 0.75 s: ${late.length}`);
  const gaps = late.slice(1).map((r, i) => r - late[i]);
  assert.ok(gaps.at(-1) < 0.8 * gaps[0], `at 0.75 s the outer crests are closer together than the inner ones (${gaps.join(', ')} px)`);
  // capillary-gravity water: the group speed is smallest at about 4.4 cm, and larger for shorter waves (capillary) and for longer ones
  const cg = (/** @type {number} */ k) => (dispersion(k * 1.0001).omega - dispersion(k).omega) / (k * 0.0001);
  const kMin = Math.sqrt(GRAVITY / TENSION) * 0.39;
  assert.ok(cg(4 * kMin) > cg(kMin) && cg(kMin / 3) > cg(kMin), 'the group speed has its minimum between the gravity and the capillary range');
  // control: the drop of preview.23 (a crater with a crown, on the wave equation of the wakes)
  const f = createField(800, 800);
  const r0 = 24, depth = 10;
  for (let cy = 0; cy < f.gh; cy += 1) for (let cx = 0; cx < f.gw; cx += 1) {
    const dx = (cx + 0.5) * f.cellX - 400, dy = (cy + 0.5) * f.cellY - 400, s2 = (dx * dx + dy * dy) / (r0 * r0);
    if (s2 < 1) f.h[(cy + PAD) * f.pw + cx + PAD] -= depth * Math.cos(2.5 * Math.PI * Math.sqrt(s2)) * (1 - s2) ** 2;
  }
  mirror(f);
  const profile = () => { const y = Math.round(400 / f.cellY - 0.5) + PAD, x0 = Math.round(400 / f.cellX - 0.5) + PAD; return Array.from({ length: f.gw / 2 - 2 }, (_, i) => f.h[y * f.pw + x0 + i]); };
  for (let i = 0; i < STEP_HZ / 4; i += 1) step(f);
  const wEarly = crests(profile()).length;
  for (let i = 0; i < STEP_HZ / 2; i += 1) step(f);
  const wLate = crests(profile()).length;
  assert.ok(wLate <= wEarly + 1, `control: the wave equation's ring keeps its crests (${wEarly} at 0.25 s, ${wLate} at 0.75 s): no dispersion`);
});

test('half floats: exact for representable values, round to nearest even, signed zero, overflow to infinity; Math.f16round agrees where it exists', () => {
  for (const v of [0, 1, -2, 0.5, 65504, 2 ** -14, 2 ** -24, 1 + 2 ** -10]) assert.equal(fromHalf(toHalf(v)), v);
  assert.equal(fromHalf(toHalf(1 + 2 ** -11)), 1, 'a tie rounds to even');
  assert.equal(fromHalf(toHalf(1 + 3 * 2 ** -11)), 1 + 2 * 2 ** -10, 'a tie rounds to even (up)');
  assert.equal(fromHalf(toHalf(70000)), Infinity);
  assert.ok(Object.is(fromHalf(toHalf(-0)), -0));
  const f16 = /** @type {any} */ (Math).f16round;
  if (typeof f16 === 'function') {
    let s = 7;
    for (let i = 0; i < 2000; i += 1) { s = (s * 16807) % 2147483647; const v = ((s / 2147483647) - 0.5) * 10 ** ((i % 9) - 6); assert.equal(fromHalf(toHalf(v)), f16(v), `${v}`); }
  }
});

test('profileAt interpolates the table bilinearly with clamped edges, as the GPU sampler does; prepareTable in slices equals computeRow', () => {
  const out = new Float64Array(4);
  const r = 37.3, t = 41.6, x0 = 37, y0 = 41, fx = 0.3, fy = 0.6;
  const v = (/** @type {number} */ i, /** @type {number} */ j, /** @type {number} */ c) => TABLE.data[(j * TABLE_W + i) * 4 + c];
  profileAt(TABLE.data, r, t, out);
  for (let c = 0; c < 4; c += 1) {
    const e = (v(x0, y0, c) * (1 - fx) + v(x0 + 1, y0, c) * fx) * (1 - fy) + (v(x0, y0 + 1, c) * (1 - fx) + v(x0 + 1, y0 + 1, c) * fx) * fy;
    assert.ok(Math.abs(out[c] - e) < 1e-9 * Math.max(1, Math.abs(e)), `channel ${c}`);
  }
  profileAt(TABLE.data, 1e6, 1e6, out);
  assert.equal(out[0], TABLE.data[((TABLE_ROWS - 1) * TABLE_W + TABLE_W - 1) * 4], 'clamped to the last texel');
  const sliced = createDropTable();
  let tasks = 0;
  while (!prepareTable(sliced, performance.now() + 1)) tasks += 1;
  const direct = createDropTable();
  for (let n = 0; n < TABLE_ROWS; n += 1) computeRow(direct);
  assert.ok(tasks > 5, `it really ran in slices (${tasks})`);
  assert.deepEqual(sliced.half, direct.half);
  assert.deepEqual(sliced.half, TABLE.half);
  assert.ok(K_COUNT > 100);
});

test('the ring culling loses nothing above RING_SHARE of a row; dropsSlope is the bilinear interpolation of the half-float texels of the css-pixel grid', () => {
  for (const n of [5, 40, 100, 200]) {
    const hr = row(n, 1), hrr = row(n, 2), q = row(n, 3);
    for (let i = 0; i < TABLE_W; i += 1) {
      if (i * TABLE_DR >= TABLE.inner[n] && i * TABLE_DR <= TABLE.outer[n]) continue;
      assert.ok(Math.abs(hr[i]) <= RING_SHARE * TABLE.slope[n] && Math.abs(hrr[i]) <= RING_SHARE * TABLE.curv[n] && Math.abs(q[i]) <= RING_SHARE * TABLE.curv[n], `row ${n} r ${i}`);
    }
  }
  // two sources, then the slope the picture sees at a point between texel centres
  const state = new Float32Array(SOURCES_OFFSET + 2 * SOURCE_FLOATS);
  state.set([120, 90, 40.5, 5, TABLE.inner[40], TABLE.outer[41], 0, 0], SOURCES_OFFSET);
  state.set([180, 130, 22.25, 3, TABLE.inner[22], TABLE.outer[23], 0, 0], SOURCES_OFFSET + SOURCE_FLOATS);
  const cssW = 300.4, cssH = 200;
  const g = dropGrid(cssW, cssH);
  assert.deepEqual(g, { w: 301, h: 200 });
  const sx = cssW / g.w, sy = cssH / g.h;
  const x = 141.37, y = 101.81;
  const tx = x / sx - 0.5, ty = y / sy - 0.5, i0 = Math.floor(tx), j0 = Math.floor(ty), fx = tx - i0, fy = ty - j0;
  const tex = (/** @type {number} */ i, /** @type {number} */ j) => { const d = dropsAt(TABLE.data, state, SOURCES_OFFSET, 2, (i + 0.5) * sx, (j + 0.5) * sy); return [fromHalf(toHalf(d.sx)), fromHalf(toHalf(d.sy))]; };
  const [a00, a10, a01, a11] = [tex(i0, j0), tex(i0 + 1, j0), tex(i0, j0 + 1), tex(i0 + 1, j0 + 1)];
  const want = [0, 1].map((c) => (a00[c] * (1 - fx) + a10[c] * fx) * (1 - fy) + (a01[c] * (1 - fx) + a11[c] * fx) * fy);
  const got = dropsSlope(TABLE.data, state, SOURCES_OFFSET, 2, x, y, cssW, cssH);
  assert.ok(Math.abs(got.sx - want[0]) < 1e-12 && Math.abs(got.sy - want[1]) < 1e-12, JSON.stringify({ got, want }));
  assert.ok(Math.hypot(got.sx, got.sy) > 1e-3, 'the point is on a ring (a real check)');
});

test('the walls reflect the drops: mirror images make the slope across a wall zero; control: the drop alone has a slope there', async () => {
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  const writes = [];
  const device = {
    createShaderModule: () => ({}), createRenderPipeline: () => ({}), createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
    createBuffer: () => ({ destroy() {} }), createSampler: () => ({}), createBindGroup: () => ({}),
    createTexture: (/** @type {any} */ d) => ({ d, createView: () => ({}), destroy() {} }),
    queue: { writeBuffer: (/** @type {any} */ b, /** @type {any} */ o, /** @type {Float32Array} */ data) => writes.push(new Float32Array(data)), writeTexture() {} },
  };
  const win = { matchMedia: () => ({ matches: false }), PointerEvent: class { constructor(/** @type {any} */ o) { Object.assign(this, o); } } };
  /** @type {Record<string, Function>} */ const listeners = {};
  const canvas = { ownerDocument: { defaultView: win }, getBoundingClientRect: () => ({ left: 0, top: 0 }), clientWidth: 400, clientHeight: 300, clientLeft: 0, clientTop: 0 };
  const inst = await WaterEffectPlugin.create(/** @type {any} */ ({ apiVersion: 2, device, format: 'bgra8unorm', requestRender() {}, canvas, listen: (/** @type {string} */ t, /** @type {Function} */ fn) => { listeners[t] = fn; return () => {}; } }), { shader: '//', intensity: 1 });
  const t0 = performance.now();
  listeners.pointerdown(new win.PointerEvent({ clientX: 18, clientY: 150, timeStamp: t0 }));
  const pass = { setPipeline() {}, setBindGroup() {}, draw() {}, end() {} };
  inst.render(/** @type {any} */ ({ now: t0 + 300, width: 400, height: 300, cssWidth: 400, cssHeight: 300, sourceReady: true, sourceView: {}, destinationView: {}, encoder: { beginRenderPass: () => pass } }));
  const u = writes.at(-1);
  assert.equal(u.length, UNIFORM_LENGTH);
  const n = u[G.DROPS];
  assert.ok(n >= 2, `the drop and its image in the left wall (${n} sources)`);
  assert.equal(u[SOURCES_OFFSET + SOURCE_FLOATS], -18, 'the image: mirrored across x = 0');
  let alone = 0, mirrored = 0, near = 0;
  for (let y = 60; y <= 240; y += 4) {
    alone = Math.max(alone, Math.abs(dropsAt(TABLE.data, u, SOURCES_OFFSET, 1, 0, y).sx));
    mirrored = Math.max(mirrored, Math.abs(dropsAt(TABLE.data, u, SOURCES_OFFSET, n, 0, y).sx));
    near = Math.max(near, Math.abs(dropsAt(TABLE.data, u, SOURCES_OFFSET, n, 6, y).sx));
  }
  assert.ok(alone > 1e-3, `control: the drop alone slopes across the wall (${alone})`);
  assert.ok(mirrored < 1e-6 * DROP_DEPTH + 1e-7 && near > 1e-3, `with its image the slope across the wall is zero (${mirrored}; beside it ${near})`);
  inst.destroy();
});
