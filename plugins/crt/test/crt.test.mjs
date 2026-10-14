// Node tests of the CRT plugin: the folder contract, the barrel mapper against an independent formula, the presets, and what render()
// does with a recording fake GPU (animation only when allowed, reduced motion, the uniform block, no per-frame allocation, per-frame
// freeze of the mapper).
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractTest } from '../../_shared/contract-test.mjs';
import { fakeGpu } from '../../_shared/fake-gpu.mjs';
import { NO_TARGET, UNIFORM_FLOATS, bezelWidth, cornerRadius, mapCrtPoint, meta, plugin, presetOf, presets } from '../index.js';

contractTest(import.meta.url);

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


async function create(options = {}, { reduced = false } = {}) {
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => '// wgsl' });
  const gpu = fakeGpu();
  const win = { matchMedia: () => ({ matches: reduced }) };
  const context = { apiVersion: 2, device: gpu.device, format: 'bgra8unorm', canvas: { ownerDocument: { defaultView: win } }, requestRender() {}, listen: () => () => {} };
  try {
    const instance = await plugin.create(context, options);
    let now = performance.now();
    const frame = (/** @type {any} */ extra = {}) => { now += 1000 / 120; return { now, delta: 1000 / 120, width: 2200, height: 1240, cssWidth: 1100, cssHeight: 620, sourceReady: true, sourceView: {}, destinationView: {}, encoder: gpu.encoder, ...extra }; };
    return { instance, gpu, frame };
  } finally { globalThis.fetch = realFetch; }
}

test('the arcade preset is the default; only the flicker animates, and never with reduced motion', async () => {
  assert.equal(meta.defaults, presets.arcade);
  assert.deepEqual(Object.keys(presets), ['arcade', 'monitor']);
  assert.ok(Object.isFrozen(presets) && Object.isFrozen(presets.arcade) && Object.isFrozen(presets.monitor));
  assert.ok(presets.arcade.scanlines >= 0.7 && presets.arcade.mask >= 0.6 && presets.arcade.glow >= 0.6 && presets.arcade.warmth > 0, 'thick scanlines, a visible mask, strong glow, warm phosphor');
  assert.equal(/** @type {any} */ (meta.defaults).interlace, undefined, 'no interlace option any more');
  assert.equal((await create({})).instance.continuous, true, 'the default flicker animates');
  const still = await create({ flicker: 0 });
  assert.equal(still.instance.continuous, false, 'flicker 0: rendered only when the form or an option changes');
  still.instance.setOptions({ flicker: 0.4 });
  assert.equal(still.instance.continuous, true, 'setOptions turns the animation back on');
  const reduced = await create({ flicker: 1 }, { reduced: true });
  assert.equal(reduced.instance.continuous, false);
  reduced.instance.render(reduced.frame());
  assert.equal(reduced.gpu.writes.at(-1).copy[10], 0, 'reduced motion: the shader gets flicker 0 (no flicker, bar or static)');
});

test('presets: {preset} applies a named set, explicit options win over it, presetOf names the current set', async () => {
  const { instance, gpu, frame } = await create({});
  instance.render(frame());
  let u = gpu.writes.at(-1).copy;
  assert.ok(Math.abs(u[13] - presets.arcade.mask) < 1e-6 && Math.abs(u[14] - presets.arcade.warmth) < 1e-6, 'mask and warmth reach the uniform block');
  instance.setOptions({ preset: 'monitor' });
  instance.render(frame());
  u = gpu.writes.at(-1).copy;
  assert.ok(Math.abs(u[8] - presets.monitor.scanlines) < 1e-6 && Math.abs(u[13] - presets.monitor.mask) < 1e-6);
  instance.setOptions({ preset: 'arcade', glow: 0.2 });
  instance.render(frame());
  u = gpu.writes.at(-1).copy;
  assert.ok(Math.abs(u[9] - 0.2) < 1e-6 && Math.abs(u[8] - presets.arcade.scanlines) < 1e-6, 'the explicit glow wins over the preset');
  instance.setOptions({ preset: 'no-such-preset' });
  instance.render(frame());
  assert.ok(Math.abs(gpu.writes.at(-1).copy[9] - 0.2) < 1e-6, 'an unknown preset changes nothing');
  assert.equal(presetOf(presets.arcade), 'arcade');
  assert.equal(presetOf(presets.monitor), 'monitor');
  assert.equal(presetOf({ ...presets.arcade, glow: 0.2 }), '');
  assert.equal(gpu.textures.length, 0, 'one pass, no extra textures');
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

test('the effect changes no geometry: mask, warmth, scanlines, glow and flicker leave the mapper as it is', async () => {
  const a = await create({});
  const b = await create({ mask: 0, warmth: 0, scanlines: 0, glow: 0, flicker: 0, misconvergence: 0 });
  a.instance.render(a.frame()); b.instance.render(b.frame());
  const ma = a.instance.captureInputMapper(), mb = b.instance.captureInputMapper();
  for (const p of [{ x: 900, y: 120 }, { x: 550, y: 310 }, { x: 30, y: 600 }, { x: 3, y: 3 }]) {
    const q = { ...p, width: 1100, height: 620 };
    assert.deepEqual(ma(q), mb(q));
  }
});
