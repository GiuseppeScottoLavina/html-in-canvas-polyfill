import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { checkPluginFolder } from '../../_shared/contract.mjs';
import { GLOBALS_LENGTH, RIPPLE_COUNT, plugin as WaterEffectPlugin, mapWaterPoint } from '../index.js';

test('the folder satisfies the plugin contract (plugins/README.md)', async () => {
  assert.deepEqual(await checkPluginFolder(fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')), []);
});

/** Independent copy of the displacement of the original water plugin (its mapPresentedPoint). */
function oracle(state, point) {
  const fastExpNeg = (v) => { const q = Math.max(0, v); const q2 = q * q; return 1 / (1 + q + 0.48 * q2 + 0.235 * q2 * q); };
  const width = Math.max(1, point.width), height = Math.max(1, point.height);
  const time = state[2], intensity = state[4];
  let ux = point.x / width, uy = point.y / height;
  const aspectX = width / height;
  let rx = 0, ry = 0;
  for (let i = 0; i < 4; i += 1) {
    const base = 8 + i * 4;
    const gain = state[base + 3];
    if (!(gain > 0)) continue;
    const dx = (ux - state[base]) * aspectX;
    const dy = uy - state[base + 1];
    const distance = Math.max(Math.hypot(dx, dy), 0.0001);
    const ring = Math.cos((distance - state[base + 2]) * 82);
    const envelope = fastExpNeg(distance * 2.55) * gain;
    rx += (dx / distance / aspectX) * ring * envelope * (0.0105 * intensity);
    ry += (dy / distance) * ring * envelope * (0.0105 * intensity);
  }
  const idleX = Math.sin(uy * 17 + time * 0.46) * (0.00155 * intensity);
  const idleY = Math.cos(ux * 15 - time * 0.4) * (0.00155 * intensity);
  ux = Math.min(0.999, Math.max(0.001, ux + idleX + rx));
  uy = Math.min(0.999, Math.max(0.001, uy + idleY + ry));
  return { x: ux * width, y: uy * height };
}

function state({ time = 1.5, intensity = 1, ripples = [[0.3, 0.4, 0.05, 1], [0.7, 0.6, 0.12, 0.6], [0, 0, 0, 0], [0.5, 0.5, 0.2, 0.3]] } = {}) {
  const s = new Float32Array(GLOBALS_LENGTH);
  s[2] = time; s[4] = intensity;
  ripples.forEach((r, i) => s.set(r, 8 + i * 4));
  return s;
}

test('mapWaterPoint equals the independent oracle on a grid, several sizes and states', () => {
  for (const [w, h] of [[640, 480], [300, 900], [1, 1]]) {
    for (const s of [state(), state({ time: 0 }), state({ intensity: 0.4, time: 7.3 })]) {
      for (let i = 0; i <= 12; i += 1) {
        for (let j = 0; j <= 12; j += 1) {
          const p = { x: (i / 12) * w, y: (j / 12) * h, width: w, height: h };
          const a = mapWaterPoint(s, p);
          const b = oracle(s, p);
          assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9, `${w}x${h} (${p.x},${p.y})`);
        }
      }
    }
  }
});

test('intensity 0 is the identity apart from the border clamp', () => {
  const s = state({ intensity: 0 });
  const p = { x: 200, y: 100, width: 400, height: 300 };
  assert.deepEqual(mapWaterPoint(s, p), { x: 200, y: 100 });
  assert.equal(mapWaterPoint(s, { ...p, x: 0, y: 300 }).x, 0.001 * 400, 'clamped like the shader (0.001 / 0.999)');
  assert.equal(mapWaterPoint(s, { ...p, x: 0, y: 300 }).y, 0.999 * 300);
});

test('a ripple displaces radially: pushes away from its centre where cos(ring) > 0', () => {
  // radius 0 -> ring = cos(distance*82) > 0 within distance < 0.019, so the displacement points away from the centre
  const s = state({ ripples: [[0.5, 0.5, 0, 1], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], intensity: 1, time: 0 });
  const p = { x: 0.52 * 1000, y: 0.5 * 1000, width: 1000, height: 1000 };
  const q = mapWaterPoint(s, p);
  assert.ok(q.x > p.x, `moved away from the centre, got ${q.x} vs ${p.x}`);
  assert.ok(Math.abs(q.y - p.y) < 0.5);
});

test('a ripple with gain 0 does nothing (the shader skips inactive slots)', () => {
  const on = state({ intensity: 1, ripples: [[0.5, 0.5, 0.1, 1], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] });
  const off = state({ intensity: 1, ripples: [[0.5, 0.5, 0.1, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] });
  const p = { x: 520, y: 480, width: 1000, height: 1000 };
  assert.notDeepEqual(mapWaterPoint(on, p), mapWaterPoint(off, p));
  const idleOnly = state({ intensity: 1, ripples: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] });
  assert.deepEqual(mapWaterPoint(off, p), mapWaterPoint(idleOnly, p));
});

test('the plugin definition is ABI v2, spatial plugins only, direct canvas attachment', () => {
  assert.equal(WaterEffectPlugin.type, 'water');
  assert.equal(WaterEffectPlugin.apiVersion, 2);
  assert.equal(WaterEffectPlugin.outputCapabilities?.directCanvasRenderAttachment, true);
  assert.ok(Object.isFrozen(WaterEffectPlugin));
});

/** A GPU device that records what the plugin submits. */
function fakeGpu() {
  const writes = [];
  const device = {
    createShaderModule: () => ({}), createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBuffer: () => ({ destroy() {} }), createSampler: () => ({}), createBindGroup: () => ({}),
    queue: { writeBuffer: (buf, off, data) => writes.push(new Float32Array(data)) },
  };
  const pass = { setPipeline() {}, setBindGroup() {}, draw() {}, end() {} };
  const encoder = { beginRenderPass: () => pass };
  return { device, writes, encoder };
}

async function createWater(options = {}) {
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  const gpu = fakeGpu();
  const listeners = {};
  const win = { matchMedia: () => ({ matches: false }), PointerEvent: class {} };
  const context = {
    apiVersion: 2, device: gpu.device, format: 'bgra8unorm', requestRender() {},
    canvas: { ownerDocument: { defaultView: win }, getBoundingClientRect: () => ({ left: 0, top: 0 }), clientWidth: 100, clientHeight: 100, clientLeft: 0, clientTop: 0 },
    listen: (type, fn) => { listeners[type] = fn; return () => {}; },
    viewport: () => ({}),
  };
  const instance = await WaterEffectPlugin.create(context, { shader: '// wgsl', ...options });
  const frame = (now, extra = {}) => ({ now, width: 200, height: 100, sourceReady: true, sourceView: {}, destinationView: {}, encoder: gpu.encoder, ...extra });
  return { instance, gpu, frame, listeners, win };
}

test('create rejects when the shader cannot be had, as a plugin error (no unhandled rejection)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  try {
    globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
    await assert.rejects(WaterEffectPlugin.create({ device: {}, canvas: {}, listen() {} }, {}), /water\.wgsl fetch 404/);
  } finally { globalThis.fetch = realFetch; }
});

test('the mapper evaluates the very uniform block that was submitted for the frame', async () => {
  const { instance, gpu, frame } = await createWater({ intensity: 1 });
  instance.render(frame(performance.now() + 400));
  const submitted = gpu.writes.at(-1);
  const mapper = instance.captureInputMapper();
  for (const p of [{ x: 20, y: 30 }, { x: 130, y: 60 }, { x: 199, y: 99 }]) {
    const pt = { ...p, width: 200, height: 100 };
    assert.deepEqual(mapper(pt), mapWaterPoint(submitted, pt));
  }
  assert.equal(submitted[0], 200);
  assert.equal(submitted[1], 100);
  assert.equal(submitted[4], 1, 'intensity');
  assert.equal(RIPPLE_COUNT, 4);
});

test('mapper states survive the whole mapper-chain ring (3 presented frames) and a gesture snapshot survives forever', async () => {
  const { instance, frame } = await createWater({ intensity: 1 });
  const t0 = performance.now();
  const probe = { x: 130, y: 40, width: 200, height: 100 };
  instance.render(frame(t0 + 300));
  const first = instance.captureInputMapper();
  const firstResult = { ...first(probe) };
  const snapshot = first.captureGestureSnapshot();
  for (let k = 1; k <= 2; k += 1) { instance.render(frame(t0 + 300 + k * 40)); instance.captureInputMapper(); }
  assert.deepEqual(first(probe), firstResult, 'still describes its own frame after two more presentations (the ring holds three)');
  for (let k = 3; k <= 6; k += 1) { instance.render(frame(t0 + 300 + k * 40)); instance.captureInputMapper(); }
  assert.deepEqual(snapshot(probe), firstResult, 'a gesture snapshot is a copy: later frames cannot move it');
});

test('intensity from options and setOptions reaches the uniform block, clamped to 0..1', async () => {
  const { instance, gpu, frame } = await createWater({ intensity: 5 });
  instance.render(frame(performance.now()));
  assert.equal(gpu.writes.at(-1)[4], 1);
  instance.setOptions({ intensity: 0.25 });
  instance.render(frame(performance.now()));
  assert.equal(gpu.writes.at(-1)[4], 0.25);
  instance.setOptions({ intensity: -3 });
  instance.render(frame(performance.now()));
  assert.equal(gpu.writes.at(-1)[4], 0);
});

test('a pointerdown adds a ripple (non-PointerEvent input is ignored)', async () => {
  const { instance, gpu, frame, listeners, win } = await createWater({ intensity: 1 });
  const t = performance.now() + 5000; // old creation ripples have expired
  instance.render(frame(t));
  const gainsBefore = [11, 15, 19, 23].map((i) => gpu.writes.at(-1)[i]);
  assert.deepEqual(gainsBefore, [0, 0, 0, 0]);
  listeners.pointerdown({ clientX: 50, clientY: 50 });
  instance.render(frame(performance.now() + 5000));
  assert.deepEqual([11, 15, 19, 23].map((i) => gpu.writes.at(-1)[i]), [0, 0, 0, 0], 'not a PointerEvent: ignored');
  const ev = Object.assign(new win.PointerEvent(), { clientX: 50, clientY: 50 });
  listeners.pointerdown(ev);
  instance.render(frame(performance.now() + 20));
  assert.ok([11, 15, 19, 23].some((i) => gpu.writes.at(-1)[i] > 0));
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
