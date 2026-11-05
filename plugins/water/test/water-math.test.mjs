import test from 'node:test';
import assert from 'node:assert/strict';
import { contractTest } from '../../_shared/contract-test.mjs';
import { ACTIONS, AMBIENT_PX, DROP_DEPTH, G, dropDepth, GLOBALS_LENGTH, SOURCES_OFFSET, UNIFORM_LENGTH, demoRain, mapWaterPoint, meta, plugin as WaterEffectPlugin } from '../index.js';
import { AMBIENT_WAVES, CAUSTIC_PX, PAD, REFRACT_PX, STEP_HZ, clear, createField, mirror, quiet, stamp, step, surfaceAt } from '../sim.js';
import { nodeHandle } from '../../_shared/node-host.mjs';
import { ROWS_PER_S, SOURCE_FLOATS, TABLE_ROWS, createDropTable, dropsAt, prepareTable } from '../drops.js';

/** a complete drop table (deterministic: the plugin computes the very same rows) */
const TABLE = createDropTable();
prepareTable(TABLE, Infinity);

contractTest(import.meta.url);

// ---- an independent oracle: the centred cubic B-spline basis, its gradient by central differences, the ambient waves by central differences ----
const B3 = (t) => { const a = Math.abs(t); return a < 1 ? 2 / 3 - a * a + (a * a * a) / 2 : a < 2 ? ((2 - a) ** 3) / 6 : 0; };
/** height of the B-spline surface at padded grid coordinate (gx, gy) */
function oracleHeight(field, offset, pw, gx, gy) {
  let h = 0;
  for (let j = Math.floor(gy) - 1; j <= Math.floor(gy) + 2; j += 1) for (let i = Math.floor(gx) - 1; i <= Math.floor(gx) + 2; i += 1) h += field[offset + j * pw + i] * B3(gx - i) * B3(gy - j);
  return h;
}
const ambientHeight = (x, y, t, amp) => AMBIENT_WAVES.reduce((s, [kx, ky, w, a, p]) => s + Math.sin(kx * x + ky * y - w * t + p) * a * amp, 0);
function oracle(state, point) {
  const W = point.width, H = point.height, cssW = state[G.CSS], cssH = state[G.CSS + 1];
  const gw = state[G.GRID], gh = state[G.GRID + 1], pw = gw + 2 * PAD;
  const u = point.x / W, v = point.y / H;
  let dx = 0, dy = 0;
  if (state[G.ACTIVE] > 0.5) {
    const e = 1e-4, gx = u * gw - 0.5 + PAD, gy = v * gh - 0.5 + PAD;
    const hx = (oracleHeight(state, UNIFORM_LENGTH, pw, gx + e, gy) - oracleHeight(state, UNIFORM_LENGTH, pw, gx - e, gy)) / (2 * e);
    const hy = (oracleHeight(state, UNIFORM_LENGTH, pw, gx, gy + e) - oracleHeight(state, UNIFORM_LENGTH, pw, gx, gy - e)) / (2 * e);
    // per cell -> per css px, times the refraction at this intensity
    dx = state[G.REFRACT] * hx * (gw / cssW);
    dy = state[G.REFRACT] * hy * (gh / cssH);
  }
  if (state[G.AMBIENT] > 0) {
    const e = 1e-3, x = u * cssW, y = v * cssH, t = state[G.TIME], a = state[G.AMBIENT];
    dx += (state[G.REFRACT] * (ambientHeight(x + e, y, t, a) - ambientHeight(x - e, y, t, a))) / (2 * e);
    dy += (state[G.REFRACT] * (ambientHeight(x, y + e, t, a) - ambientHeight(x, y - e, t, a))) / (2 * e);
  }
  return { x: Math.min(0.999, Math.max(0.001, u + dx / cssW)) * W, y: Math.min(0.999, Math.max(0.001, v + dy / cssH)) * H };
}

/** A mapper state over a field with random dents, laid out as render() writes it. */
function stateOf(cssW, cssH, { intensity = 1, ambient = 0, time = 1.7, seed = 1, steps = 30 } = {}) {
  const f = createField(cssW, cssH);
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < 6; i += 1) stamp(f, rnd() * cssW, rnd() * cssH, 6 + 14 * rnd(), -2 - 6 * rnd());
  for (let i = 0; i < steps; i += 1) step(f);
  mirror(f);
  const state = new Float32Array(UNIFORM_LENGTH + f.pw * f.ph);
  const refract = REFRACT_PX * intensity;
  state[G.CSS] = cssW; state[G.CSS + 1] = cssH; state[G.K] = refract / f.cellX; state[G.K + 1] = refract / f.cellY;
  state[G.INV_CELL] = 1 / f.cellX; state[G.INV_CELL + 1] = 1 / f.cellY; state[G.GRID] = f.gw; state[G.GRID + 1] = f.gh;
  state[G.TIME] = time; state[G.INTENSITY] = intensity; state[G.AMBIENT] = ambient; state[G.ACTIVE] = 1; state[G.REFRACT] = refract;
  state.set(f.h, UNIFORM_LENGTH);
  return { state, field: f };
}

test('mapWaterPoint equals the independent oracle (B-spline basis, numeric gradient) on a grid, several sizes, intensities and the ambient swell', () => {
  let moved = 0;
  for (const [w, h] of [[640, 480], [300, 900], [1100, 620]]) {
    for (const o of [{}, { intensity: 0.35, seed: 7 }, { ambient: AMBIENT_PX, seed: 3, time: 12.5 }]) {
      const { state } = stateOf(w, h, o);
      for (let i = 0; i <= 16; i += 1) {
        for (let j = 0; j <= 16; j += 1) {
          const p = { x: (i / 16) * w, y: (j / 16) * h, width: w, height: h };
          const a = mapWaterPoint(state, p);
          const b = oracle(state, p);
          assert.ok(Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3, `${w}x${h} ${JSON.stringify(o)} (${p.x},${p.y}): ${a.x},${a.y} vs ${b.x},${b.y}`);
          if (Math.hypot(a.x - p.x, a.y - p.y) > 0.5) moved += 1;
        }
      }
    }
  }
  assert.ok(moved > 200, `the states really displace (${moved} points moved by more than 0.5 px)`);
});

test('intensity 0 and a flat field (ACTIVE 0) map to the identity, up to the border clamp of the shader', () => {
  const { state } = stateOf(400, 300, { intensity: 0 });
  const p = { x: 200, y: 100, width: 400, height: 300 };
  assert.deepEqual(mapWaterPoint(state, p), { x: 200, y: 100 });
  assert.equal(mapWaterPoint(state, { ...p, x: 0, y: 300 }).x, 0.001 * 400, 'clamped like the shader (0.001 / 0.999)');
  assert.ok(Math.abs(mapWaterPoint(state, { ...p, x: 0, y: 300 }).y - 0.999 * 300) < 1e-9);
  const { state: flat } = stateOf(400, 300, { intensity: 1 });
  assert.notDeepEqual(mapWaterPoint(flat, { ...p, x: 210 }), { x: 210, y: 100 }, 'control: this field displaces');
  flat[G.ACTIVE] = 0;
  assert.deepEqual(mapWaterPoint(flat, p), { x: 200, y: 100 }, 'ACTIVE 0: the field is not read');
});

test('a dent is a diverging lens: points beside it map further out (the page looks smaller there)', () => {
  const f = createField(400, 400);
  stamp(f, 200, 200, 20, -6);
  mirror(f);
  const state = new Float32Array(UNIFORM_LENGTH + f.pw * f.ph);
  state[G.CSS] = 400; state[G.CSS + 1] = 400; state[G.GRID] = f.gw; state[G.GRID + 1] = f.gh;
  state[G.K] = REFRACT_PX / f.cellX; state[G.K + 1] = REFRACT_PX / f.cellY; state[G.ACTIVE] = 1;
  state.set(f.h, UNIFORM_LENGTH);
  const right = mapWaterPoint(state, { x: 210, y: 200, width: 400, height: 400 });
  const above = mapWaterPoint(state, { x: 200, y: 190, width: 400, height: 400 });
  assert.ok(right.x > 212 && Math.abs(right.y - 200) < 0.01, `right of the dent: ${JSON.stringify(right)}`);
  assert.ok(above.y < 188 && Math.abs(above.x - 200) < 0.01, `above it: ${JSON.stringify(above)}`);
});

test('surfaceAt: the B-spline reproduces a linear field exactly (height and gradient), so the grid leaves no pattern', () => {
  const pw = 12, ph = 10;
  const lin = new Float32Array(pw * ph).map((_, i) => 0.5 * (i % pw) - 0.25 * Math.floor(i / pw) + 3);
  for (const [gx, gy] of [[3.2, 4.7], [5.5, 5.5], [7.99, 3.01]]) {
    const s = surfaceAt(lin, 0, pw, ph, gx, gy);
    assert.ok(Math.abs(s.hx - 0.5) < 1e-6 && Math.abs(s.hy + 0.25) < 1e-6, JSON.stringify(s));
    assert.ok(Math.abs(s.h - (0.5 * gx - 0.25 * gy + 3)) < 1e-5);
  }
});

test('the wave equation: a drop becomes a ring that travels at about the wave speed, the walls mirror, and the surface comes back to rest', () => {
  const f = createField(600, 600);
  assert.ok(f.gw * f.gh <= 65536 && f.cellX >= 2.99, `grid ${f.gw}x${f.gh}, cell ${f.cellX}`);
  stamp(f, 300, 300, 12, -6);
  const at = (x, y) => f.h[(Math.round(y / f.cellY - 0.5) + PAD) * f.pw + Math.round(x / f.cellX - 0.5) + PAD];
  for (let i = 0; i < STEP_HZ / 4; i += 1) step(f);   // 0.25 s
  let best = 0, where = 0;
  for (let r = 0; r < 250; r += 1) { const v = Math.abs(at(300 + r, 300)); if (v > best) { best = v; where = r; } }
  const speed = Math.sqrt(f.c2) * f.cellX * STEP_HZ;
  assert.ok(where > 0.5 * speed * 0.25 && where < 1.3 * speed * 0.25 + 12, `the ring is at ${where} px after 0.25 s (wave speed ${speed.toFixed(0)} px/s)`);
  for (let k = 1; k <= PAD; k += 1) {
    const row = (PAD + 5) * f.pw;
    assert.equal(f.h[row + PAD - k], f.h[row + PAD + k - 1], 'left wall mirrored');
    assert.equal(f.h[(PAD + f.gh - 1 + k) * f.pw + PAD + 5], f.h[(PAD + f.gh - k) * f.pw + PAD + 5], 'bottom wall mirrored');
  }
  assert.equal(quiet(f), false, 'still moving');
  let steps = 0;
  while (!quiet(f) && steps < STEP_HZ * 8) { step(f); steps += 1; }
  assert.ok(steps < STEP_HZ * 3, `at rest ${(steps / STEP_HZ).toFixed(2)} s later`);
  clear(f);
  assert.ok(f.h.every((v) => v === 0) && f.v.every((v) => v === 0) && f.lap.every((v) => v === 0), 'cleared: exactly flat and still');
});

test('the simulation is stable for every cell size it uses (noise stays bounded and dies out)', () => {
  for (const [w, h] of [[200, 150], [390, 700], [1100, 620], [2400, 1600]]) {
    const f = createField(w, h);
    let s = 9;
    for (let i = 0; i < f.h.length; i += 1) { s = (s * 16807) % 2147483647; f.h[i] = (s / 2147483647 - 0.5) * 4; }
    mirror(f);
    for (let i = 0; i < STEP_HZ * 4; i += 1) step(f);
    let max = 0;
    for (const v of f.h) max = Math.max(max, Math.abs(v));
    assert.ok(Number.isFinite(max) && max < 0.5, `${w}x${h} (c2 ${f.c2.toFixed(2)}): max |h| ${max} after 4 s`);
  }
});

test('quiet() is a visibility threshold: a ripple that moves the page by 0.2 px is not quiet, one of 0.02 px is; NaN resets to flat', () => {
  const f = createField(400, 400);
  // a raised cosine of radius r and height a has a largest slope of a * pi / (2 r): this one moves the page by 0.2 px at intensity 1
  const a = ((0.2 / REFRACT_PX) * 2 * 40) / Math.PI;
  stamp(f, 200, 200, 40, a);
  mirror(f);
  assert.equal(quiet(f), false);
  clear(f);
  stamp(f, 200, 200, 40, a / 10);
  mirror(f);
  assert.equal(quiet(f), true);
  f.h[(PAD + 3) * f.pw + PAD + 3] = NaN;
  assert.equal(quiet(f), true);
  assert.ok(f.h.every((v) => v === 0), 'a broken field is reset rather than run forever');
  assert.ok(CAUSTIC_PX > REFRACT_PX, 'the light focuses deeper than the view refracts');
});

test('the plugin definition: ABI v2, spatial, direct canvas attachment, the actions drop and demo', () => {
  assert.equal(WaterEffectPlugin.type, 'water');
  assert.equal(WaterEffectPlugin.apiVersion, 2);
  assert.equal(WaterEffectPlugin.outputCapabilities?.directCanvasRenderAttachment, true);
  assert.deepEqual([...ACTIONS], ['drop', 'demo']);
  assert.deepEqual([...(WaterEffectPlugin.actions ?? [])], ['drop', 'demo']);
  assert.ok(Object.isFrozen(WaterEffectPlugin));
  assert.equal(meta.defaults.intensity, 0.5);
});

/** A GPU device that records what the plugin submits. */
function fakeGpu() {
  const writes = [];
  const textures = [];
  const tables = [];
  const created = [];
  const device = {
    createShaderModule: () => ({}), createRenderPipeline: () => ({}), createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
    createBuffer: () => ({ destroy() {} }), createSampler: () => ({}), createBindGroup: () => ({}),
    createTexture: (d) => { const t = { d, destroyed: false, createView: () => ({}), destroy() { t.destroyed = true; } }; created.push(t); return t; },
    queue: {
      writeBuffer: (buf, off, data) => writes.push(new Float32Array(data)),
      // the height field (r32float) is recorded in `textures`; the drop table's rows (rgba16float) in `tables`
      writeTexture: (dst, data, layout, size) => (dst.texture?.d?.format === 'rgba16float' ? tables : textures).push({ data: dst.texture?.d?.format === 'rgba16float' ? data : new Float32Array(data), layout, size }),
    },
  };
  const pass = { setPipeline() {}, setBindGroup() {}, draw() {}, end() {} };
  const encoder = { beginRenderPass: () => pass };
  return { device, writes, textures, tables, created, encoder };
}

const W = 400, H = 300;
async function createWater(options = {}, { reduced = false } = {}) {
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  const gpu = fakeGpu();
  const listeners = {};
  const listenOptions = {};
  let renders = 0;
  const win = { matchMedia: (q) => ({ matches: reduced && q === '(prefers-reduced-motion: reduce)' }), PointerEvent: class { constructor(o) { Object.assign(this, o); } } };
  const rect = { left: 0, top: 0 };   // where the canvas is in the viewport (a test scrolls the page by moving it)
  const context = {
    apiVersion: 2, device: gpu.device, format: 'bgra8unorm', requestRender() { renders += 1; },
    canvas: { ownerDocument: { defaultView: win }, getBoundingClientRect: () => ({ ...rect }), clientWidth: W, clientHeight: H, clientLeft: 0, clientTop: 0 },
    listen: (type, fn, o) => { listeners[type] = fn; listenOptions[type] = o; return () => {}; },
    viewport: () => ({}),
  };
  const instance = await WaterEffectPlugin.create(context, { shader: '// wgsl', ...options });
  const frame = (now) => ({ now, width: W * 2, height: H * 2, cssWidth: W, cssHeight: H, dpr: 2, sourceReady: true, sourceView: {}, destinationView: {}, encoder: gpu.encoder });
  const pointer = (type, x, y, extra = {}) => listeners[type](new win.PointerEvent({ clientX: x, clientY: y, buttons: 0, pointerType: 'mouse', timeStamp: performance.now(), ...extra }));
  /** render frames at 120 Hz from `t` until `done()` or `maxMs`; returns the frame time reached */
  const run = (t, maxMs, done = () => false) => { let now = t; for (; now <= t + maxMs && !done(); now += 1000 / 120) instance.render(frame(now)); return now; };
  /** a touch event with one finger (id 1) at client (x, y) */
  const touch = (type, x, y, t = performance.now()) => listeners[type]({ type, timeStamp: t, changedTouches: [{ identifier: 1, clientX: x, clientY: y }] });
  return { instance, gpu, frame, listeners, listenOptions, win, pointer, touch, rect, run, renders: () => renders };
}

test('at rest nothing works: not continuous, settled at once, the field is never uploaded, the mapper is the identity, no frame requested', async () => {
  const w = await createWater({ intensity: 1 });
  assert.equal(w.instance.continuous, false);
  assert.equal(await w.instance.settled(), 'calm');
  w.instance.render(w.frame(performance.now()));
  w.instance.render(w.frame(performance.now() + 500));
  assert.equal(w.gpu.textures.length, 0, 'a flat field is not uploaded');
  assert.equal(w.gpu.writes.at(-1)[G.ACTIVE], 0);
  assert.equal(w.instance.continuous, false, 'rendering a frame (the page changed) does not wake it');
  const m = w.instance.captureInputMapper();
  assert.deepEqual(m({ x: 123, y: 45, width: W, height: H }), { x: 123, y: 45 });
  assert.equal(w.renders(), 0, 'it never asked for a frame');
});

test('a pointerdown makes a drop: continuous, a drop source in the uniform block (not in the field), the table rows it needs uploaded; it comes back to rest by itself, then continuous is false again; the listeners are passive', async () => {
  const w = await createWater({ intensity: 1 });
  for (const type of ['pointerdown', 'pointermove', 'touchstart', 'touchmove', 'touchend', 'touchcancel']) assert.equal(w.listenOptions[type]?.passive, true, `${type} is passive: a finger keeps scrolling`);
  w.listeners.pointerdown({ clientX: 200, clientY: 150 });
  assert.equal(w.instance.continuous, false, 'not a PointerEvent: ignored');
  const t0 = performance.now();
  w.pointer('pointerdown', 200, 150);
  assert.equal(w.instance.continuous, true);
  assert.ok(w.renders() >= 1, 'it asked for a frame');
  let settledState = 'pending';
  w.instance.settled().then((s) => { settledState = s; });
  w.instance.render(w.frame(t0 + 100));
  const u = w.gpu.writes.at(-1);
  assert.equal(u.length, UNIFORM_LENGTH);
  assert.equal(u[G.DROPS], 1, 'one source: the drop (no wall is within its reach yet)');
  const o = SOURCES_OFFSET;
  assert.deepEqual([u[o], u[o + 1], u[o + 3]], [200, 150, DROP_DEPTH], 'at the point, of the drop depth');
  assert.ok(Math.abs(u[o + 2] - 0.1 * ROWS_PER_S) < 0.5, `its age, in rows of the table (${u[o + 2]})`);
  assert.ok(u[o + 4] < u[o + 5], 'its ring');
  assert.equal(u[G.ACTIVE], 0, 'the field is not touched: no upload of it');
  assert.equal(w.gpu.textures.length, 0);
  assert.ok(w.gpu.tables.length >= 1 && w.gpu.tables[0].size.height >= 13, 'the rows of the table up to its age are uploaded');
  const end = w.run(t0 + 110, 6000, () => !w.instance.continuous);
  await new Promise((r) => setImmediate(r));
  assert.ok(end - t0 < 2400, `at rest ${Math.round(end - t0)} ms after the drop (intensity 1)`);
  assert.equal(settledState, 'calm');
  assert.equal(w.gpu.writes.at(-1)[G.DROPS], 0, 'the last frame shows a flat surface');
  const writes = w.gpu.writes.length, tables = w.gpu.tables.length;
  w.instance.render(w.frame(end + 100));
  assert.equal(w.gpu.tables.length, tables, 'no upload at rest');
  assert.equal(w.gpu.writes.length, writes + 1);
});

test('a long gap between frames (a frame cap of 1, a pause) is skipped by the drops as by the field: a drop is shown at most 167 ms older per frame; the rain skips it too', async () => {
  const w = await createWater({ intensity: 1 });
  const t0 = performance.now();
  w.pointer('pointerdown', 200, 150);
  w.instance.render(w.frame(t0 + 1000));
  const row = w.gpu.writes.at(-1)[SOURCES_OFFSET + 2];
  assert.ok(row > 0.15 * ROWS_PER_S && row <= (1000 / 6 / 1000) * ROWS_PER_S + 1.5, `after a 1 s gap the drop is ${((row / ROWS_PER_S) * 1000).toFixed(0)} ms old (at most 167 ms of water time per frame)`);
  w.instance.render(w.frame(t0 + 1000 + 1000 / 120));
  assert.ok(Math.abs(w.gpu.writes.at(-1)[SOURCES_OFFSET + 2] - row - 1) < 0.05, 'then it ages one row per frame of 120 Hz');
  // the rain: the drops due within a skipped gap fall later, one by one, not all at once
  const r = await createWater({ intensity: 1 });
  const t1 = performance.now();
  r.instance.runAction('demo', {}, { reducedMotion: false });
  r.instance.render(r.frame(t1 + 1200));
  assert.ok(r.gpu.writes.at(-1)[G.DROPS] <= 6, `after a 1.2 s gap only the rain of the first 167 ms has fallen (${r.gpu.writes.at(-1)[G.DROPS]} sources)`);
});

test('the mapper evaluates the very uniform block, field and drop table that were submitted for the frame', async () => {
  const w = await createWater({ intensity: 1 });
  const t0 = performance.now();
  w.pointer('pointerdown', 150, 120);
  w.pointer('pointerdown', 260, 160);
  // and a wake (the field) across them
  for (let i = 0; i <= 6; i += 1) w.pointer('pointermove', 100 + 30 * i, 140, { timeStamp: t0 + 10 * i });
  w.instance.render(w.frame(t0 + 120));
  const field = w.gpu.created.find((t) => t.d.format === 'r32float').d.size;
  const submitted = new Float32Array(UNIFORM_LENGTH + field.width * field.height);
  submitted.set(w.gpu.writes.at(-1));
  submitted.set(w.gpu.textures.at(-1).data, UNIFORM_LENGTH);
  assert.equal(submitted[G.ACTIVE], 1, 'the field is in use');
  assert.equal(submitted[G.DROPS], 2, 'and two drops');
  const mapper = w.instance.captureInputMapper();
  let moved = 0, byDrops = 0;
  const fieldOnly = new Float32Array(submitted);
  fieldOnly[G.DROPS] = 0;
  for (let x = 100; x <= 320; x += 10) {
    for (let y = 80; y <= 220; y += 10) {
      const pt = { x, y, width: W, height: H };
      assert.deepEqual(mapper(pt), mapWaterPoint(submitted, pt, TABLE.data));
      if (Math.hypot(mapper(pt).x - x, mapper(pt).y - y) > 0.3) moved += 1;
      const f = mapWaterPoint(fieldOnly, pt, TABLE.data);
      if (Math.hypot(mapper(pt).x - f.x, mapper(pt).y - f.y) > 0.3) byDrops += 1;
    }
  }
  assert.ok(moved > 10 && byDrops > 10, `the wake and the drops displace (${moved} probes; ${byDrops} by the drops)`);
  assert.equal(submitted[G.RES], W * 2);
  assert.equal(submitted[G.CSS], W);
  assert.equal(submitted[G.INTENSITY], 1);
});

test('mapper states survive the whole mapper-chain ring (3 presented frames) and a gesture snapshot survives forever', async () => {
  const w = await createWater({ intensity: 1 });
  const t0 = performance.now();
  w.pointer('pointerdown', 200, 150);
  const probe = { x: 214, y: 150, width: W, height: H };
  w.instance.render(w.frame(t0 + 60));
  const first = w.instance.captureInputMapper();
  const firstResult = { ...first(probe) };
  assert.ok(Math.abs(firstResult.x - probe.x) > 0.3, 'the probe is displaced');
  const snapshot = first.captureGestureSnapshot();
  for (let k = 1; k <= 2; k += 1) { w.instance.render(w.frame(t0 + 60 + k * 40)); w.instance.captureInputMapper(); }
  assert.deepEqual(first(probe), firstResult, 'still describes its own frame after two more presentations (the ring holds three)');
  for (let k = 3; k <= 6; k += 1) { w.instance.render(w.frame(t0 + 60 + k * 40)); w.instance.captureInputMapper(); }
  assert.deepEqual(snapshot(probe), firstResult, 'a gesture snapshot is a copy: later frames cannot move it');
  assert.notDeepEqual(w.instance.captureInputMapper()(probe), firstResult, 'control: the newest mapper describes another surface');
});

test('a moving pointer leaves a wake along its path; a faster stroke and a drag stir harder; a jump does not', async () => {
  const depthAfter = async (moves, extra = {}) => {
    const w = await createWater({ intensity: 1 });
    for (const [x, y, t] of moves) w.pointer('pointermove', x, y, { timeStamp: t, ...extra });
    w.instance.render(w.frame(performance.now()));
    const data = w.gpu.textures.at(-1)?.data;
    return data ? -Math.min(...data) : 0;
  };
  const slow = await depthAfter([[100, 150, 1000], [130, 150, 1100], [160, 150, 1200]]);
  const fast = await depthAfter([[100, 150, 1000], [130, 150, 1010], [160, 150, 1020]]);
  const drag = await depthAfter([[100, 150, 1000], [130, 150, 1010], [160, 150, 1020]], { buttons: 1 });
  const jump = await depthAfter([[20, 20, 1000], [380, 280, 1010]]);
  assert.ok(fast > 0.5, `a fast stroke dents the surface (${fast} px)`);
  assert.ok(fast > slow * 1.5 && slow > 0, `faster is stronger: ${fast} vs ${slow}`);
  assert.ok(drag > fast * 1.2, `a drag stirs harder than a hover: ${drag} vs ${fast}`);
  assert.equal(jump, 0, 'a jump of the pointer starts a new path');
});

test('a finger that scrolls the page keeps stirring the water: touch moves (which go on during the scroll) are followed with the canvas where it is now; control: pointer events alone stop at pointercancel', async () => {
  // the finger moves up 200 px over 400 ms and the page scrolls with it: the canvas moves up by the same amount, so the finger stays over one spot of the canvas
  const scroll = async (withTouch) => {
    const w = await createWater({ intensity: 1 });
    const t0 = performance.now();
    if (withTouch) w.touch('touchstart', 200, 250, t0);
    w.pointer('pointermove', 200, 250, { pointerType: 'touch', buttons: 1, timeStamp: t0 });
    w.listeners.pointercancel({});   // the browser takes the gesture for scrolling
    let now = t0;
    for (let i = 1; i <= 25; i += 1) {
      now = t0 + i * 16;
      w.rect.top = -8 * i;
      if (withTouch) w.touch('touchmove', 200, 250 - 8 * i, now);
      // pointer events of that finger have stopped: these are ignored either way (they would double the touch moves)
      w.pointer('pointermove', 200, 250 - 8 * i, { pointerType: 'touch', buttons: 1, timeStamp: now });
    }
    if (withTouch) w.touch('touchend', 200, 50, now);
    w.instance.render(w.frame(now));
    const data = w.gpu.textures.at(-1)?.data;
    return { continuous: w.instance.continuous, depth: data ? -Math.min(...data) : 0 };
  };
  const finger = await scroll(true);
  const control = await scroll(false);
  assert.ok(finger.continuous && finger.depth > 1, `the scrolling finger stirred the water under it (${finger.depth.toFixed(2)} px deep)`);
  assert.equal(control.continuous, false, 'control: without touch moves, nothing stirs once the scroll has started');
});

test('touch moves and the pointer moves of the same finger are not both counted', async () => {
  const depth = async (pointerToo) => {
    const w = await createWater({ intensity: 1 });
    const t0 = performance.now();
    w.touch('touchstart', 100, 150, t0);
    for (let i = 1; i <= 6; i += 1) {
      w.touch('touchmove', 100 + 20 * i, 150, t0 + 16 * i);
      if (pointerToo) w.pointer('pointermove', 100 + 20 * i, 150, { pointerType: 'touch', buttons: 1, timeStamp: t0 + 16 * i });
    }
    w.instance.render(w.frame(t0 + 100));
    return -Math.min(...w.gpu.textures.at(-1).data);
  };
  const touchOnly = await depth(false);
  const both = await depth(true);
  assert.ok(touchOnly > 0.5 && Math.abs(both - touchOnly) < 1e-6, `the same wake (${touchOnly} vs ${both})`);
});

test('intensity, light and ambient from options and setOptions reach the uniform block, clamped to 0..1; ambient makes it continuous on purpose', async () => {
  const w = await createWater({ intensity: 5, light: -1 });
  w.instance.render(w.frame(performance.now()));
  assert.equal(w.gpu.writes.at(-1)[G.INTENSITY], 1);
  assert.equal(w.gpu.writes.at(-1)[G.LIGHT], 0);
  assert.equal(w.gpu.writes.at(-1)[G.REFRACT], REFRACT_PX);
  assert.equal(w.gpu.writes.at(-1)[G.CAUSTIC], CAUSTIC_PX);
  w.instance.setOptions({ intensity: 0.25, light: 0.5 });
  w.instance.render(w.frame(performance.now()));
  assert.equal(w.gpu.writes.at(-1)[G.INTENSITY], 0.25);
  assert.equal(w.gpu.writes.at(-1)[G.LIGHT], 0.5);
  assert.equal(w.instance.continuous, false);
  w.instance.setOptions({ ambient: 0.5 });
  assert.equal(w.instance.continuous, true, 'the ambient swell is continuous by declaration');
  w.instance.render(w.frame(performance.now()));
  assert.ok(Math.abs(w.gpu.writes.at(-1)[G.AMBIENT] - 0.5 * AMBIENT_PX) < 1e-6);
  w.instance.setOptions({ ambient: 0 });
  assert.equal(w.instance.continuous, false);
  const rm = await createWater({ ambient: 1 }, { reduced: true });
  assert.equal(rm.instance.continuous, false, 'reduced motion: no swell');
});

test('a resize by a fraction of a cell keeps the ripples; another grid starts flat with a new texture', async () => {
  const w = await createWater({ intensity: 1 });
  const t0 = performance.now();
  for (let i = 0; i <= 6; i += 1) w.pointer('pointermove', 120 + 30 * i, 150, { timeStamp: t0 + 10 * i });
  w.instance.render(w.frame(t0 + 20));
  const texturesBefore = w.gpu.created.length;
  const fieldTexture = w.gpu.created.find((t) => t.d.format === 'r32float');
  w.instance.render({ ...w.frame(t0 + 40), cssWidth: W + 0.3 });
  assert.equal(w.gpu.created.length, texturesBefore, 'the same grid');
  assert.ok(w.gpu.textures.at(-1).data.some((v) => v < -0.3), 'the ripple is still there');
  w.instance.render({ ...w.frame(t0 + 60), cssWidth: W * 2, width: W * 4 });
  assert.equal(w.gpu.created.length, texturesBefore + 1, 'a new grid, a new texture');
  assert.ok(fieldTexture.destroyed, 'the old texture is destroyed');
  assert.equal(w.gpu.created.at(-1).d.format, 'r32float', 'the new one is the field');
});

test('prefers-reduced-motion: still water; no ripple from the pointer, not continuous, the mapper is the identity; control: without it the pointer stirs', async () => {
  const calm = await createWater({ intensity: 1 }, { reduced: true });
  assert.equal(calm.listeners.pointerdown, undefined, 'no pointer listener at all');
  calm.instance.render(calm.frame(performance.now()));
  assert.equal(calm.instance.continuous, false);
  assert.equal(calm.gpu.writes.at(-1)[G.ACTIVE], 0);
  assert.deepEqual(calm.instance.captureInputMapper()({ x: 60, y: 40, width: W, height: H }), { x: 60, y: 40 });
  const moving = await createWater({ intensity: 1 });
  moving.pointer('pointerdown', 50, 50);
  assert.equal(moving.instance.continuous, true, 'control: the pointer starts ripples');
});

test('create rejects when the shader cannot be had, as a plugin error (no unhandled rejection)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  try {
    globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
    await assert.rejects(WaterEffectPlugin.create({ device: {}, canvas: {}, listen() {} }, {}), /water\.wgsl fetch 404/);
  } finally { globalThis.fetch = realFetch; }
});

test('a failed shader fetch is not cached: the next create (e.g. after a device loss) tries again', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return calls === 1 ? { ok: false, status: 503 } : { ok: true, text: async () => '// wgsl' }; };
  try {
    globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
    const gpu = fakeGpu();
    const win = { matchMedia: () => ({ matches: false }), PointerEvent: class {} };
    const ctx = { device: gpu.device, format: 'bgra8unorm', requestRender() {}, listen() { return () => {}; }, canvas: { ownerDocument: { defaultView: win } } };
    await assert.rejects(WaterEffectPlugin.create(ctx, {}), /503/);
    const inst = await WaterEffectPlugin.create(ctx, {});
    assert.equal(typeof inst.render, 'function');
    assert.equal(calls, 2);
  } finally { globalThis.fetch = realFetch; }
});

/** the plugin behind the real handle of the host, over a fake GPU; the test renders the frames */
async function handleOf({ reducedMotion = false } = {}) {
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  const gpu = fakeGpu();
  const win = { matchMedia: () => ({ matches: reducedMotion }), PointerEvent: class {} };
  const canvas = Object.assign(new EventTarget(), { ownerDocument: { defaultView: win }, getBoundingClientRect: () => ({ left: 0, top: 0 }), clientWidth: W, clientHeight: H, clientLeft: 0, clientTop: 0 });
  const h = await nodeHandle(WaterEffectPlugin, { shader: '// wgsl', ...meta.defaults }, { device: gpu.device, canvas, source: {}, reducedMotion });
  const frame = (now) => ({ now, width: W, height: H, cssWidth: W, cssHeight: H, sourceReady: true, sourceView: {}, destinationView: {}, encoder: gpu.encoder });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { ...h, gpu, frame, flush };
}

test('the action drop, through the effect handle: a drop at the point at once, of the depth its strength asks; it resolves \'calm\' at rest; bad options reject; reduced motion starts none', async () => {
  const w = await handleOf();
  assert.deepEqual([...w.handle.actions], ['drop', 'demo']);
  assert.equal(await w.handle.settled(), 'calm', 'calm at once: nothing moves after creation');
  await assert.rejects(w.handle.trigger('drop', { point: { x: 'left' } }), /water: `point`/);
  await assert.rejects(w.handle.trigger('drop', { strength: NaN }), /strength/);
  const t0 = performance.now();
  let state = 'pending';
  w.handle.trigger('drop', { point: { x: 300, y: 75 }, strength: 1.5 }).then((v) => { state = v; });
  w.inst.render(w.frame(t0 + 10));
  const u = w.gpu.writes.at(-1), o = SOURCES_OFFSET;
  assert.ok(u[G.DROPS] >= 1);
  assert.deepEqual([u[o], u[o + 1]], [300, 75], 'the drop is at the point');
  assert.ok(Math.abs(u[o + 3] - dropDepth(1.5)) < 1e-5, `of the depth of strength 1.5 (${u[o + 3]})`);
  assert.equal(dropDepth(1.2), DROP_DEPTH, 'the default strength is a tap\'s drop');
  assert.ok(Math.abs(dropDepth(2) / DROP_DEPTH - 2 / 1.2) < 1e-12 && dropDepth(5) === dropDepth(2) && dropDepth(0) === dropDepth(0.08), 'in proportion to the strength, clamped to 0.08 .. 2');
  let now = t0 + 10;
  for (; now < t0 + 600; now += 1000 / 120) w.inst.render(w.frame(now));
  await w.flush();
  assert.equal(state, 'pending', 'still moving after 0.6 s');
  for (; now < t0 + 6000 && state === 'pending'; now += 1000 / 120) { w.inst.render(w.frame(now)); await w.flush(); }
  assert.equal(state, 'calm');
  assert.ok(now - t0 < 2400, `calm ${Math.round(now - t0)} ms after the drop`);
  const pending = w.handle.trigger('drop');
  w.handle.remove();
  assert.equal(await pending, null, 'removed: null');
  const still = await handleOf({ reducedMotion: true });
  assert.equal(await still.handle.trigger('drop', { point: { x: 10, y: 10 } }), 'calm', 'reduced motion (as the host read it): no ripple, calm at once');
  still.inst.render(still.frame(t0 + 100));
  assert.equal(still.gpu.textures.length + still.gpu.tables.length, 0, 'nothing to upload: the surface stayed flat');
  assert.equal(still.gpu.writes.at(-1)[G.DROPS], 0);
  still.handle.remove();
});

test('the action demo: a short rain (the last drop by 1.7 s), then calm; it resolves \'calm\' within about 4 s (the default intensity) and the instance is at rest; reduced motion resolves at once', async () => {
  const rain = demoRain();
  assert.ok(rain.length >= 20 && rain.at(-1).t <= 1700 && rain.every((d, i) => i === 0 || d.t >= rain[i - 1].t), 'sorted, the last drop by 1.7 s');
  assert.deepEqual(demoRain(), rain, 'deterministic');
  const w = await handleOf();
  const t0 = performance.now();
  let state = 'pending';
  w.handle.trigger('demo').then((v) => { state = v; });
  assert.equal(w.inst.continuous, true);
  let now = t0;
  let dropsBy800 = 0;
  for (; now < t0 + 7000 && state === 'pending'; now += 1000 / 120) {
    w.inst.render(w.frame(now));
    if (now - t0 < 800) dropsBy800 = rain.filter((d) => d.t <= now - t0).length;
    await w.flush();
  }
  assert.equal(state, 'calm');
  assert.ok(now - t0 < 4200, `the demo ends at rest ${Math.round(now - t0)} ms after it started`);
  assert.ok(dropsBy800 > 8, `it rains (${dropsBy800} drops in the first 0.8 s)`);
  assert.equal(w.inst.continuous, false, 'at rest afterwards: no more frames');
  w.handle.remove();
  const rm = await handleOf({ reducedMotion: true });
  assert.equal(await rm.handle.trigger('demo'), 'calm', 'reduced motion: at once');
  assert.equal(rm.inst.continuous, false);
  rm.handle.remove();
});

test('user input during the demo (a tap, setOptions) takes over at once: the rain stops and the demo resolves null', async () => {
  const atRest = async (interrupt) => {
    const w = await createWater({ ...meta.defaults });
    const t0 = performance.now();
    let state = 'pending';
    w.instance.runAction('demo', {}, { reducedMotion: false }).then((v) => { state = v; });
    let now = t0;
    for (; now < t0 + 300; now += 1000 / 120) w.instance.render(w.frame(now));
    if (interrupt) w.pointer('pointerdown', 40, 40, { pointerType: 'touch', buttons: 1 });
    await new Promise((r) => setImmediate(r));
    const early = state;
    for (; now < t0 + 8000 && w.instance.continuous; now += 1000 / 120) w.instance.render(w.frame(now));
    await new Promise((r) => setImmediate(r));
    return { early, state, ms: now - t0 };
  };
  const tapped = await atRest(true);
  const w = await createWater({ ...meta.defaults });
  const demo = w.instance.runAction('demo', {}, { reducedMotion: false });
  w.instance.render(w.frame(performance.now() + 20));
  w.instance.setOptions({ intensity: 0.7 });
  assert.equal(await demo, null, 'setOptions during the demo takes over too');
  assert.equal(typeof meta.touch, 'string', 'meta.touch: the hint the gallery shows on a touch screen');
  assert.equal(meta.continuous, undefined, 'not continuous by design: it settles to zero frames');
  const control = await atRest(false);
  assert.equal(tapped.early, null, 'the demo resolved null at the tap');
  assert.equal(control.state, 'calm', 'control: undisturbed, it resolves calm');
  assert.ok(tapped.ms < control.ms - 300, `the rain stopped: at rest after ${Math.round(tapped.ms)} ms, the whole demo after ${Math.round(control.ms)} ms`);
});

test('destroy: a pending demo and every waiter resolve null, the field texture is destroyed', async () => {
  const w = await createWater({ intensity: 1 });
  const demo = w.instance.runAction('demo', {}, { reducedMotion: false });
  const waiting = w.instance.settled();
  w.instance.render(w.frame(performance.now() + 20));
  w.instance.destroy();
  assert.equal(await demo, null);
  assert.equal(await waiting, null);
  assert.ok(w.gpu.created.every((t) => t.destroyed));
});
