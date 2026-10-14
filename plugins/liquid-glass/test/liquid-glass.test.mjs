// Node tests of the liquid-glass plugin: the folder contract, the lens mapper against an independent formula, and what render() does
// with a recording fake GPU (spring, pinning, reduced motion, frame cap, no per-frame allocation, per-frame freeze of the mapper).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { checkPluginFolder } from '../../_shared/contract.mjs';
import { UNIFORM_FLOATS, mapLensPoint, meta, plugin, sdBox, writeLensGeometry } from '../index.js';

test('the folder satisfies the plugin contract (plugins/README.md)', async () => {
  assert.deepEqual(await checkPluginFolder(fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')), []);
});

test('meta and the definition agree; ABI v2, direct canvas attachment, frozen', () => {
  assert.equal(plugin.type, meta.name);
  assert.equal(plugin.apiVersion, 2);
  assert.equal(plugin.outputCapabilities?.directCanvasRenderAttachment, true);
  assert.ok(Object.isFrozen(plugin) && Object.isFrozen(meta) && Object.isFrozen(meta.defaults));
});

/** Independent formula: a pill lens (radius = half height), written from the description, not from index.js. */
function oracle({ w, h, cx, cy, hx, hy, refraction }, p) {
  const r = Math.min(hx, hy);
  const bevel = r * 0.55;
  const mag = 1 + 0.28 * refraction;
  const dx = p.x - cx, dy = p.y - cy;
  // distance to a rounded box, by the nearest point on the inner segment / rectangle
  const ix = Math.max(-(hx - r), Math.min(hx - r, dx));
  const iy = Math.max(-(hy - r), Math.min(hy - r, dy));
  const inner = Math.abs(dx) <= hx - r && Math.abs(dy) <= hy - r;
  const dist = inner ? -Math.min(hx - Math.abs(dx), hy - Math.abs(dy)) : Math.hypot(dx - ix, dy - iy) - r;
  if (dist >= 0) return { x: Math.min(w, Math.max(0, p.x)), y: Math.min(h, Math.max(0, p.y)) };
  let nx, ny;
  if (inner) { if (hx - Math.abs(dx) < hy - Math.abs(dy)) { nx = Math.sign(dx) || 1; ny = 0; } else { nx = 0; ny = Math.sign(dy) || 1; } }
  else { const l = Math.hypot(dx - ix, dy - iy); nx = (dx - ix) / l; ny = (dy - iy) / l; }
  const t = Math.min(1, -dist / bevel);
  const disp = refraction * bevel * 0.9 * (1 - t) ** 2;
  return { x: Math.min(w, Math.max(0, cx + dx / mag + nx * disp)), y: Math.min(h, Math.max(0, cy + dy / mag + ny * disp)) };
}

function state({ w = 800, h = 500, cx = 400, cy = 250, size = 150, aspect = 1.45, refraction = 0.7, vx = 0, vy = 0 } = {}) {
  const s = new Float32Array(UNIFORM_FLOATS);
  s[2] = w; s[3] = h;
  writeLensGeometry(s, { cx, cy, vx, vy, size, aspect, refraction });
  return s;
}

test('mapLensPoint equals the independent formula on a dense grid, for several lenses', () => {
  for (const o of [{}, { cx: 120, cy: 90, size: 200, refraction: 1 }, { size: 80, aspect: 1, refraction: 0.3 }, { cx: 790, cy: 10 }]) {
    const s = state(o);
    const lens = { w: s[2], h: s[3], cx: s[4], cy: s[5], hx: s[6], hy: s[7], refraction: s[10] };
    for (let i = 0; i <= 80; i += 1) {
      for (let j = 0; j <= 50; j += 1) {
        const p = { x: i * 10 + 0.37, y: j * 10 + 0.61, width: 800, height: 500 };
        const a = mapLensPoint(s, p);
        const b = oracle(lens, p);
        assert.ok(Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3, `${JSON.stringify(o)} at ${p.x},${p.y}: ${a.x},${a.y} vs ${b.x},${b.y}`);
      }
    }
  }
});

test('the lens: identity outside, fixed centre, magnifying flat zone, rim that samples from outside the lens', () => {
  const s = state({ refraction: 1 });
  const at = (x, y) => mapLensPoint(s, { x, y, width: 800, height: 500 });
  assert.deepEqual(at(50, 40), { x: 50, y: 40 }, 'outside the lens nothing moves');
  const c = at(400, 250);
  assert.ok(Math.abs(c.x - 400) < 1e-9 && Math.abs(c.y - 250) < 1e-9, 'the centre shows itself');
  const flat = at(420, 250);
  assert.ok(Math.abs(flat.x - (400 + 20 / 1.28)) < 1e-6, 'flat zone: magnified by 1.28');
  const hy = s[7];
  const rim = at(400, 250 - hy + 0.5);
  assert.ok(rim.y < 250 - hy, `the rim shows the picture above the lens (y ${rim.y} < ${250 - hy})`);
  assert.ok(sdBox(0, 0, 10, 5, 5) < 0 && sdBox(20, 0, 10, 5, 5) > 0);
});

test('refraction 0 is the identity everywhere (up to the canvas clamp)', () => {
  const s = state({ refraction: 0 });
  for (const [x, y] of [[400, 250], [450, 280], [400, 180]]) assert.deepEqual(mapLensPoint(s, { x, y, width: 800, height: 500 }), { x, y });
});

test('a moving lens stretches along its velocity', () => {
  const rest = state();
  const moving = state({ vx: 2000 });
  assert.ok(moving[6] > rest[6] && moving[7] < rest[7], 'wider and flatter while moving sideways');
});

/** A GPU device that records what the plugin submits. */
function fakeGpu() {
  const writes = [];
  const passes = [];
  const device = {
    createShaderModule: () => ({}), createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBuffer: () => ({ destroy() {} }), createSampler: () => ({}), createBindGroup: () => ({}),
    queue: { writeBuffer: (_b, _o, data) => writes.push({ data, copy: new Float32Array(data) }) },
  };
  const encoder = { beginRenderPass: (d) => { passes.push(d); return { setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }; } };
  return { device, writes, passes, encoder };
}

async function create(options = {}, { reduced = false } = {}) {
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => '// wgsl' });
  const gpu = fakeGpu();
  const listeners = {};
  let renders = 0;
  const win = { matchMedia: () => ({ matches: reduced }) };
  const canvas = { ownerDocument: { defaultView: win }, getBoundingClientRect: () => ({ left: 0, top: 0 }), clientWidth: 800, clientHeight: 500, clientLeft: 0, clientTop: 0 };
  const context = { apiVersion: 2, device: gpu.device, format: 'bgra8unorm', canvas, requestRender: () => { renders += 1; }, listen: (type, fn) => { listeners[type] = fn; return () => {}; } };
  try {
    const instance = await plugin.create(context, options);
    let now = 1000;
    const sourceView = {};
    const frame = (delta = 1000 / 120) => { now += delta; return { now, delta, width: 1600, height: 1000, cssWidth: 800, cssHeight: 500, sourceReady: true, sourceView, destinationView: {}, encoder: gpu.encoder }; };
    return { instance, gpu, listeners, frame, renders: () => renders };
  } finally { globalThis.fetch = realFetch; }
}

test('a pinned lens starts at rest at (x, y) and the host is not kept busy', async () => {
  const { instance, gpu, frame } = await create({ pinned: true, x: 0.25, y: 0.5 });
  instance.render(frame());
  const u = gpu.writes.at(-1).copy;
  assert.deepEqual([u[4], u[5]], [200, 250]);
  assert.equal(instance.continuous, false, 'nothing moves: no continuous rendering');
});

test('the lens follows the pointer on a spring: it overshoots a little, settles, and then stops asking for frames', async () => {
  const { instance, gpu, listeners, frame, renders } = await create({ x: 0.5, y: 0.5 });
  instance.render(frame());
  listeners.pointermove({ clientX: 600, clientY: 250 });
  assert.equal(instance.continuous, true);
  assert.ok(renders() > 0, 'a pointer move asks the host for a frame');
  let maxX = 0;
  for (let k = 0; k < 240 && instance.continuous; k += 1) { instance.render(frame()); maxX = Math.max(maxX, gpu.writes.at(-1).copy[4]); }
  const u = gpu.writes.at(-1).copy;
  assert.equal(u[4], 600, 'settled exactly on the pointer');
  assert.ok(maxX > 600 && maxX < 640, `a small overshoot (${maxX})`);
  assert.equal(instance.continuous, false, 'at rest: the host may sleep');
});

test('the spring takes the same time at a 15 fps cap as at 120 fps (it integrates frame.delta)', async () => {
  const positions = [];
  for (const fps of [120, 15]) {
    const { instance, gpu, listeners, frame } = await create({ x: 0.5, y: 0.5 });
    instance.render(frame());
    listeners.pointermove({ clientX: 600, clientY: 250 });
    for (let elapsed = 0; elapsed < 200; elapsed += 1000 / fps) instance.render(frame(1000 / fps));
    positions.push(gpu.writes.at(-1).copy[4]);
  }
  assert.ok(Math.abs(positions[0] - positions[1]) < 6, `after 200 ms: ${positions[0].toFixed(1)} at 120 fps, ${positions[1].toFixed(1)} at 15 fps`);
});

test('prefers-reduced-motion: the lens jumps to the pointer, no spring, no stretch, never continuous', async () => {
  const { instance, gpu, listeners, frame } = await create({ x: 0.5, y: 0.5 }, { reduced: true });
  listeners.pointermove({ clientX: 100, clientY: 100 });
  instance.render(frame());
  const u = gpu.writes.at(-1).copy;
  assert.deepEqual([u[4], u[5]], [100, 100]);
  assert.equal(u[7], 75, 'half height = size / 2, not stretched');
  assert.equal(instance.continuous, false);
});

test('pinning keeps the lens where it is; the pointer no longer moves it; leaving the canvas sends an unpinned lens home', async () => {
  const { instance, gpu, listeners, frame } = await create({ x: 0.5, y: 0.5 });
  instance.setOptions({ ...meta.defaults, pinned: true, x: 0.5, y: 0.5 });
  listeners.pointermove({ clientX: 700, clientY: 400 });
  for (let k = 0; k < 60; k += 1) instance.render(frame());
  assert.deepEqual([gpu.writes.at(-1).copy[4], gpu.writes.at(-1).copy[5]], [400, 250]);
  instance.setOptions({ ...meta.defaults, pinned: false, x: 0.5, y: 0.5 });
  listeners.pointermove({ clientX: 700, clientY: 400 });
  for (let k = 0; k < 240; k += 1) instance.render(frame());
  assert.deepEqual([gpu.writes.at(-1).copy[4], gpu.writes.at(-1).copy[5]], [700, 400]);
  listeners.pointerleave({ clientX: 400, clientY: 250 });
  for (let k = 0; k < 20; k += 1) instance.render(frame());
  assert.equal(gpu.writes.at(-1).copy[4], 700, 'a leave inside the canvas (to its live layer) does not move the lens');
  listeners.pointerleave({ clientX: 900, clientY: 250 });
  for (let k = 0; k < 240; k += 1) instance.render(frame());
  assert.deepEqual([gpu.writes.at(-1).copy[4], gpu.writes.at(-1).copy[5]], [400, 250], 'home');
});

test('the per-frame path reuses its buffers: one Float32Array, one pass descriptor, no new object per frame', async () => {
  const { instance, gpu, listeners, frame } = await create({});
  listeners.pointermove({ clientX: 600, clientY: 300 });
  for (let k = 0; k < 10; k += 1) { instance.render(frame()); instance.captureInputMapper(); }
  assert.equal(new Set(gpu.writes.map((w) => w.data)).size, 1, 'the same uniform array every frame');
  assert.equal(new Set(gpu.passes).size, 1, 'the same render pass descriptor every frame');
  assert.equal(new Set(gpu.passes.map((p) => p.colorAttachments[0])).size, 1);
});

test('a mapper describes the frame it was captured for; a gesture snapshot is a copy', async () => {
  const { instance, listeners, frame } = await create({ x: 0.5, y: 0.5 });
  instance.render(frame());
  const first = instance.captureInputMapper();
  const probe = { x: 430, y: 250, width: 800, height: 500 };
  const before = first(probe);
  const snapshot = first.captureGestureSnapshot();
  listeners.pointermove({ clientX: 100, clientY: 100 });
  for (let k = 0; k < 2; k += 1) { instance.render(frame()); instance.captureInputMapper(); }
  assert.deepEqual(first(probe), before, 'still the first frame after two more presentations (the host keeps three)');
  for (let k = 0; k < 6; k += 1) { instance.render(frame()); instance.captureInputMapper(); }
  assert.deepEqual(snapshot(probe), before, 'the gesture snapshot never changes');
  assert.notDeepEqual(instance.captureInputMapper()(probe), before, 'while the newest mapper follows the moved lens');
});

test('options are clamped; setOptions reaches the uniform block', async () => {
  const { instance, gpu, frame } = await create({ size: 9999, refraction: -1, dispersion: 3 });
  instance.render(frame());
  let u = gpu.writes.at(-1).copy;
  assert.equal(u[7], 140, 'size clamped to 280');
  assert.equal(u[10], 0);
  assert.equal(u[12], 1);
  instance.setOptions({ size: 100, refraction: 0.5, dispersion: 0.25, highlight: 0 });
  instance.render(frame());
  u = gpu.writes.at(-1).copy;
  assert.deepEqual([u[7], u[10], u[12], u[13]], [50, 0.5, 0.25, 0]);
});
