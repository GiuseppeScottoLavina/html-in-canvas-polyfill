// Node tests of the CRT plugin: the folder contract, the barrel mapper against an independent formula, and what render() does with a
// recording fake GPU (animation only when allowed, reduced motion, no per-frame allocation, per-frame freeze of the mapper).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { checkPluginFolder } from '../../_shared/contract.mjs';
import { NO_TARGET, UNIFORM_FLOATS, bezelWidth, cornerRadius, mapCrtPoint, meta, plugin } from '../index.js';

test('the folder satisfies the plugin contract (plugins/README.md)', async () => {
  assert.deepEqual(await checkPluginFolder(fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')), []);
});

test('meta and the definition agree; ABI v2, direct canvas attachment, frozen', () => {
  assert.equal(plugin.type, meta.name);
  assert.equal(plugin.apiVersion, 2);
  assert.equal(plugin.outputCapabilities?.directCanvasRenderAttachment, true);
  assert.ok(Object.isFrozen(plugin) && Object.isFrozen(meta) && Object.isFrozen(meta.defaults));
});

function state({ w = 1100, h = 620, k = 0.25 } = {}) {
  const s = new Float32Array(UNIFORM_FLOATS);
  s[2] = w; s[3] = h; s[4] = k; s[5] = bezelWidth(w, h); s[6] = cornerRadius(w, h);
  return s;
}

/** Independent formula, in normalised screen coordinates. */
function oracle(w, h, k, p) {
  const b = Math.max(6, 0.035 * Math.min(w, h));
  const sx = w / 2 - b, sy = h / 2 - b;
  const R2 = sx * sx + sy * sy;
  const dx = p.x - w / 2, dy = p.y - h / 2;
  const f = 1 + k * (dx * dx + dy * dy) / R2;
  const ux = (dx / sx) * f / (1 + k * sx * sx / R2);
  const uy = (dy / sy) * f / (1 + k * sy * sy / R2);
  const x = w / 2 + ux * w / 2, y = h / 2 + uy * h / 2;
  // inside the source rectangle with rounded corners of radius 0.06 * min(w, h)
  const r = 0.06 * Math.min(w, h);
  const ex = Math.max(Math.abs(x - w / 2) - (w / 2 - r), 0), ey = Math.max(Math.abs(y - h / 2) - (h / 2 - r), 0);
  const inside = Math.abs(x - w / 2) < w / 2 && Math.abs(y - h / 2) < h / 2 && Math.hypot(ex, ey) < r;
  return inside ? { x, y } : null;
}

test('mapCrtPoint equals the independent formula on a dense grid, several sizes and curvatures', () => {
  for (const [w, h] of [[1100, 620], [480, 320], [300, 600]]) {
    for (const k of [0, 0.1, 0.25, 0.5]) {
      const s = state({ w, h, k });
      for (let i = 0; i <= 60; i += 1) {
        for (let j = 0; j <= 40; j += 1) {
          const p = { x: (i / 60) * w + 0.3, y: (j / 40) * h + 0.2, width: w, height: h };
          const a = mapCrtPoint(s, p);
          const b = oracle(w, h, k, p);
          if (b === null) { assert.equal(a, NO_TARGET, `${w}x${h} k=${k} (${p.x},${p.y}) should be on the bezel`); continue; }
          assert.ok(Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3, `${w}x${h} k=${k} (${p.x},${p.y})`);
        }
      }
    }
  }
});

test('the barrel: the centre is fixed, edge midpoints land on the edges of the source, corners and bezel reach nothing', () => {
  const s = state();
  const b = bezelWidth(1100, 620);
  const at = (x, y) => mapCrtPoint(s, { x, y, width: 1100, height: 620 });
  assert.deepEqual(at(550, 310), { x: 550, y: 310 });
  assert.ok(Math.abs(at(1100 - b - 0.01, 310).x - 1100) < 0.1, 'right edge midpoint');
  assert.ok(Math.abs(at(550, b + 0.01).y) < 0.1, 'top edge midpoint');
  assert.equal(at(b + 5, b + 5), NO_TARGET, 'the screen corner is rounded off by the curvature');
  assert.equal(at(3, 310), NO_TARGET, 'the bezel');
  const mid = at(825, 310);
  assert.ok(mid.x < 825, 'the bulge magnifies the middle of the screen: halfway out, the mapper reaches a point nearer the centre');
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
  const win = { matchMedia: () => ({ matches: reduced }) };
  const context = { apiVersion: 2, device: gpu.device, format: 'bgra8unorm', canvas: { ownerDocument: { defaultView: win } }, requestRender() {}, listen: () => () => {} };
  try {
    const instance = await plugin.create(context, options);
    let now = performance.now();
    const frame = () => { now += 1000 / 120; return { now, delta: 1000 / 120, width: 2200, height: 1240, cssWidth: 1100, cssHeight: 620, sourceReady: true, sourceView: {}, destinationView: {}, encoder: gpu.encoder }; };
    return { instance, gpu, frame };
  } finally { globalThis.fetch = realFetch; }
}

test('flicker animates (continuous) unless it is 0 or the user prefers reduced motion', async () => {
  assert.equal((await create({})).instance.continuous, true);
  const off = await create({ flicker: 0 });
  assert.equal(off.instance.continuous, false);
  off.instance.setOptions({ ...meta.defaults, flicker: 0.4 });
  assert.equal(off.instance.continuous, true, 'setOptions turns the animation back on');
  const reduced = await create({ flicker: 1 }, { reduced: true });
  assert.equal(reduced.instance.continuous, false);
  reduced.instance.render(reduced.frame());
  assert.equal(reduced.gpu.writes.at(-1).copy[10], 0, 'reduced motion: the shader gets flicker 0 (no flicker, bar or static)');
});

test('render writes the geometry the mapper reads; options are clamped to 0..1', async () => {
  const { instance, gpu, frame } = await create({ curvature: 7, scanlines: -2, glow: 0.3 });
  instance.render(frame());
  const u = gpu.writes.at(-1).copy;
  assert.deepEqual([u[0], u[1], u[2], u[3]], [2200, 1240, 1100, 620]);
  assert.equal(u[4], 0.5, 'curvature 1 -> k = 0.5');
  assert.ok(Math.abs(u[5] - bezelWidth(1100, 620)) < 1e-4);
  assert.equal(u[8], 0);
  assert.ok(Math.abs(u[9] - 0.3) < 1e-6);
  const p = { x: 900, y: 120, width: 1100, height: 620 };
  assert.deepEqual(instance.captureInputMapper()(p), mapCrtPoint(u, p));
});

test('the per-frame path reuses its buffers: one Float32Array, one pass descriptor', async () => {
  const { instance, gpu, frame } = await create({});
  for (let k = 0; k < 10; k += 1) { instance.render(frame()); instance.captureInputMapper(); }
  assert.equal(new Set(gpu.writes.map((w) => w.data)).size, 1);
  assert.equal(new Set(gpu.passes).size, 1);
});

test('a mapper keeps the curvature of its own frame after setOptions; a gesture snapshot is a copy', async () => {
  const { instance, frame } = await create({ curvature: 0.5 });
  instance.render(frame());
  const first = instance.captureInputMapper();
  const snapshot = first.captureGestureSnapshot();
  const probe = { x: 950, y: 100, width: 1100, height: 620 };
  const before = first(probe);
  instance.setOptions({ ...meta.defaults, curvature: 1 });
  for (let k = 0; k < 2; k += 1) { instance.render(frame()); instance.captureInputMapper(); }
  assert.deepEqual(first(probe), before);
  for (let k = 0; k < 6; k += 1) { instance.render(frame()); instance.captureInputMapper(); }
  assert.deepEqual(snapshot(probe), before);
  assert.notDeepEqual(instance.captureInputMapper()(probe), before);
});
