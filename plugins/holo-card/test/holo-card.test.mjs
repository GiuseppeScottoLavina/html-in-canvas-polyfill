// Node tests of the holo-card plugin: the folder contract, the perspective mapper against an independent projection, and what render()
// does with a recording fake GPU (tilt spring, idle sway, reduced motion, frame cap, no per-frame allocation, per-frame mapper freeze).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { checkPluginFolder } from '../../_shared/contract.mjs';
import { NO_TARGET, UNIFORM_FLOATS, mapCardPoint, meta, plugin, writeCardPose } from '../index.js';

test('the folder satisfies the plugin contract (plugins/README.md)', async () => {
  assert.deepEqual(await checkPluginFolder(fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')), []);
});

test('meta and the definition agree; ABI v2, direct canvas attachment, frozen', () => {
  assert.equal(plugin.type, meta.name);
  assert.equal(plugin.apiVersion, 2);
  assert.equal(plugin.outputCapabilities?.directCanvasRenderAttachment, true);
  assert.ok(Object.isFrozen(plugin) && Object.isFrozen(meta) && Object.isFrozen(meta.defaults));
});

function pose(rx, ry, { w = 1100, h = 620, scale = 0.86 } = {}) {
  const s = new Float32Array(UNIFORM_FLOATS);
  s[2] = w; s[3] = h;
  writeCardPose(s, rx, ry, scale, w, h);
  return s;
}

/**
 * Independent check, in the FORWARD direction: put a source point on the card (scale, rotate about the centre with matrices), project
 * it to the screen with a pinhole camera D px in front, then the mapper of that screen point must give the source point back.
 */
function project(rx, ry, { w = 1100, h = 620, scale = 0.86 }, src) {
  const D = 2 * Math.max(w, h);
  const v = [(src.x - w / 2) * scale, (src.y - h / 2) * scale, 0];
  const rotX = ([x, y, z]) => [x, y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
  const rotY = ([x, y, z]) => [x * Math.cos(ry) + z * Math.sin(ry), y, -x * Math.sin(ry) + z * Math.cos(ry)];
  const [x, y, z] = rotY(rotX(v));
  const f = D / (D + z);   // the eye is at z = -D, the canvas at z = 0
  return { x: w / 2 + x * f, y: h / 2 + y * f };
}

test('mapCardPoint inverts the forward projection of the card (rotation + perspective) on a grid of source points', () => {
  for (const [rx, ry] of [[0, 0], [0.3, -0.2], [-0.5, 0.45], [0.2, 0.52]]) {
    const s = pose(rx, ry);
    for (let i = 1; i < 20; i += 1) {
      for (let j = 1; j < 12; j += 1) {
        const src = { x: (i / 20) * 1100, y: (j / 12) * 620 };
        const screen = project(rx, ry, { w: 1100, h: 620, scale: 0.86 }, src);
        const back = mapCardPoint(s, { ...screen, width: 1100, height: 620 });
        assert.ok(Math.abs(back.x - src.x) < 1e-3 && Math.abs(back.y - src.y) < 1e-3, `rx=${rx} ry=${ry} src ${src.x},${src.y} -> ${back.x},${back.y}`);
      }
    }
  }
});

test('flat card: a plain scale about the centre; beside the card the mapper reaches nothing', () => {
  const s = pose(0, 0);
  const at = (x, y) => mapCardPoint(s, { x, y, width: 1100, height: 620 });
  const c = at(550, 310);
  assert.ok(Math.abs(c.x - 550) < 1e-9 && Math.abs(c.y - 310) < 1e-9);
  const q = at(550 + 86, 310);
  assert.ok(Math.abs(q.x - 650) < 1e-4, 'scale 0.86 (stored as f32)');
  assert.equal(at(20, 20), NO_TARGET, 'the background beside the card');
});

test('tilt towards the pointer: the side under the pointer comes closer (drawn larger)', () => {
  const s = pose(0, 0.4);   // the pose the plugin writes for a pointer on the right
  const right = project(0, 0.4, { w: 1100, h: 620, scale: 0.86 }, { x: 1000, y: 310 });
  const left = project(0, 0.4, { w: 1100, h: 620, scale: 0.86 }, { x: 100, y: 310 });
  assert.ok(right.x - 550 > 550 - left.x, 'the right half is wider on screen');
  assert.ok(Number.isFinite(mapCardPoint(s, { x: 0, y: 0, width: 1100, height: 620 }).x));
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
  const win = { matchMedia: () => ({ matches: reduced }) };
  const canvas = { ownerDocument: { defaultView: win }, getBoundingClientRect: () => ({ left: 0, top: 0 }), clientWidth: 1100, clientHeight: 620, clientLeft: 0, clientTop: 0 };
  const context = { apiVersion: 2, device: gpu.device, format: 'bgra8unorm', canvas, requestRender() {}, listen: (type, fn) => { listeners[type] = fn; return () => {}; } };
  try {
    const instance = await plugin.create(context, options);
    let now = performance.now();
    const frame = (delta = 1000 / 120) => { now += delta; return { now, delta, width: 2200, height: 1240, cssWidth: 1100, cssHeight: 620, sourceReady: true, sourceView: {}, destinationView: {}, encoder: gpu.encoder }; };
    return { instance, gpu, listeners, frame };
  } finally { globalThis.fetch = realFetch; }
}

/** rotation about y written into the block: ex = (cos ry, 0, -sin ry) */
const ryOf = (u) => Math.atan2(-u[6], u[4]);

test('the card tilts towards the pointer on a spring, settles exactly, then stops asking for frames', async () => {
  const { instance, gpu, listeners, frame } = await create({ tilt: 20, idle: false });
  instance.render(frame());
  assert.equal(instance.continuous, false, 'no idle sway, no pointer: at rest');
  listeners.pointermove({ clientX: 1100, clientY: 310 });
  assert.equal(instance.continuous, true);
  for (let k = 0; k < 400 && instance.continuous; k += 1) instance.render(frame());
  assert.ok(Math.abs(ryOf(gpu.writes.at(-1).copy) - (20 * Math.PI) / 180) < 1e-6, 'full tilt towards the right edge');
  assert.equal(instance.continuous, false);
});

test('the spring takes the same time at a 15 fps cap as at 120 fps', async () => {
  const angles = [];
  for (const fps of [120, 15]) {
    const { instance, gpu, listeners, frame } = await create({ tilt: 20, idle: false });
    instance.render(frame());
    listeners.pointermove({ clientX: 1100, clientY: 310 });
    for (let elapsed = 0; elapsed < 200; elapsed += 1000 / fps) instance.render(frame(1000 / fps));
    angles.push(ryOf(gpu.writes.at(-1).copy));
  }
  assert.ok(Math.abs(angles[0] - angles[1]) < 0.02, `after 200 ms: ${angles[0].toFixed(3)} at 120 fps, ${angles[1].toFixed(3)} at 15 fps`);
});

test('idle sway animates while the pointer is away; leaving the canvas brings it back', async () => {
  const { instance, gpu, listeners, frame } = await create({ idle: true });
  instance.render(frame(500));
  assert.equal(instance.continuous, true);
  listeners.pointermove({ clientX: 550, clientY: 310 });
  for (let k = 0; k < 400 && instance.continuous; k += 1) instance.render(frame());
  assert.equal(instance.continuous, false, 'the pointer is over the card: it settles flat under a centred pointer');
  assert.ok(Math.abs(ryOf(gpu.writes.at(-1).copy)) < 1e-9);
  listeners.pointerleave({ clientX: 1200, clientY: 310 });
  instance.render(frame());
  assert.equal(instance.continuous, true, 'away again: swaying');
});

test('prefers-reduced-motion: the card stays flat, nothing is continuous, the glare still follows the pointer', async () => {
  const { instance, gpu, listeners, frame } = await create({ idle: true, tilt: 30 }, { reduced: true });
  listeners.pointermove({ clientX: 1100, clientY: 0 });
  instance.render(frame());
  const u = gpu.writes.at(-1).copy;
  assert.equal(ryOf(u), 0);
  assert.deepEqual([u[4], u[9], u[14]], [1, 1, 1], 'identity rotation');
  assert.deepEqual([u[18], u[19]], [1, 0], 'glare at the pointer');
  assert.equal(u[20], 0, 'no shimmer over time');
  assert.equal(instance.continuous, false);
});

test('the per-frame path reuses its buffers: one Float32Array, one pass descriptor', async () => {
  const { instance, gpu, frame } = await create({});
  for (let k = 0; k < 10; k += 1) { instance.render(frame()); instance.captureInputMapper(); }
  assert.equal(new Set(gpu.writes.map((w) => w.data)).size, 1);
  assert.equal(new Set(gpu.passes).size, 1);
});

test('a mapper describes the pose of its own frame; a gesture snapshot is a copy', async () => {
  const { instance, frame } = await create({ idle: true, tilt: 25 });
  instance.render(frame(300));
  const first = instance.captureInputMapper();
  const snapshot = first.captureGestureSnapshot();
  const probe = { x: 900, y: 120, width: 1100, height: 620 };
  const before = first(probe);
  for (let k = 0; k < 2; k += 1) { instance.render(frame(300)); instance.captureInputMapper(); }
  assert.deepEqual(first(probe), before);
  for (let k = 0; k < 6; k += 1) { instance.render(frame(300)); instance.captureInputMapper(); }
  assert.deepEqual(snapshot(probe), before);
  assert.notDeepEqual(instance.captureInputMapper()(probe), before, 'the sway moved the card since');
});

test('options are clamped; setOptions reaches the uniform block', async () => {
  const { instance, gpu, frame } = await create({ foil: 4, glare: -1, tilt: 99 });
  instance.render(frame());
  let u = gpu.writes.at(-1).copy;
  assert.deepEqual([u[16], u[17]], [1, 0]);
  instance.setOptions({ ...meta.defaults, foil: 0.25, glare: 0.5 });
  instance.render(frame());
  u = gpu.writes.at(-1).copy;
  assert.deepEqual([u[16], u[17]], [0.25, 0.5]);
});
