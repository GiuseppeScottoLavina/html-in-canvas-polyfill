// Node tests of the shatter plugin: the folder contract, the shard geometry (an exact partition of the canvas), the physics twin, options,
// uniforms, and what the instance does with a recording fake GPU (no GPU object per frame, one layout per shatter, the impact point, the
// mapper per frame, submit wiring, destroy).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { checkPluginFolder } from '../../_shared/contract.mjs';
import { blockedMapper, fillHeader, HEADER_FLOATS, identityMapper, meta, plugin, readOptions, SPAN, trigger } from '../index.js';
import { buildShards, CRACK_HOLD, CRACK_SPEED, impactSeeds, MAX_POLY, MAX_SHARDS, MAX_VERTICES, mulberry32, polygonCentroid, SHARD_FLOATS, shardPoint, VERTEX_FLOATS, voronoiCell } from '../shards.js';
import { createTimeline } from '../../_lib/transition.js';

test('the folder satisfies the plugin contract (plugins/README.md)', async () => {
  assert.deepEqual(await checkPluginFolder(fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')), []);
});

test('meta and the definition agree; the gallery defaults are valid options', () => {
  assert.equal(plugin.type, meta.name);
  assert.equal(plugin.apiVersion, 2);
  const o = readOptions(meta.defaults);
  assert.equal(o.onSubmit, 'invalid');
  assert.equal(o.pieces, 36);
  assert.equal(o.intro, true);
});

/** @param {number[][]} poly */
const area = (poly) => polygonCentroid(poly).area;

test('Voronoi cells: an exact partition of the canvas, each cell convex, holding its own seed, at most MAX_POLY vertices', () => {
  for (const [impact, w, h, n, seed] of /** @type {const} */ ([[{ x: 240, y: 160 }, 480, 320, 36, 1], [{ x: 5, y: 5 }, 1100, 620, 64, 2], [{ x: 1099, y: 300 }, 1100, 620, 12, 3]])) {
    const seeds = impactSeeds(impact, w, h, n, mulberry32(seed));
    assert.equal(seeds.length, n);
    let total = 0;
    for (let i = 0; i < n; i += 1) {
      const poly = voronoiCell(seeds, i, w, h);
      assert.ok(poly.length >= 3 && poly.length <= MAX_POLY, `cell ${i}: ${poly.length} vertices`);
      total += area(poly);
      for (let k = 0; k < poly.length; k += 1) {      // convex: every turn has the same sign; and the seed is on the inner side of every edge
        const [a, b, c] = [poly[k], poly[(k + 1) % poly.length], poly[(k + 2) % poly.length]];
        assert.ok((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) >= -1e-6);
        assert.ok((b[0] - a[0]) * (seeds[i].y - a[1]) - (b[1] - a[1]) * (seeds[i].x - a[0]) >= -1e-6);
      }
    }
    assert.ok(Math.abs(total - w * h) < 1e-6 * w * h, `cells cover ${total} of ${w * h}`);
  }
});

test('seeds cluster around the impact (radial cracks): the nearest third of the canvas area holds most seeds', () => {
  const seeds = impactSeeds({ x: 550, y: 310 }, 1100, 620, 40, mulberry32(9));
  const near = seeds.filter((s) => Math.hypot(s.x - 550, s.y - 310) < 300).length;
  assert.ok(near >= 25, `${near} of 40 seeds within 300 px`);
});

test('buildShards: fans with the edge factor, border edges flagged, motion that starts after the crack front', () => {
  const vertices = new Float32Array(MAX_VERTICES * VERTEX_FLOATS);
  const shards = new Float32Array(MAX_SHARDS * SHARD_FLOATS);
  const impact = { x: 100, y: 80 };
  const { vertexCount, shardCount } = buildShards(impact, 480, 320, 30, 4, vertices, shards);
  assert.equal(shardCount, 30);
  assert.equal(vertexCount % 3, 0);
  let covered = 0, borders = 0;
  for (let t = 0; t < vertexCount; t += 3) {
    const v = (/** @type {number} */ k) => vertices.subarray((t + k) * VERTEX_FLOATS, (t + k + 1) * VERTEX_FLOATS);
    assert.deepEqual([v(0)[3], v(1)[3], v(2)[3]], [1, 0, 0], 'centre 1, outer edge 0');
    const [ax, ay, bx, by, cx, cy] = [v(0)[0], v(0)[1], v(1)[0], v(1)[1], v(2)[0], v(2)[1]];
    covered += ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
    if (v(1)[2] % 2 === 1) {
      borders += 1;
      assert.ok((bx === cx && (bx < 0.01 || bx > 479.99)) || (Math.abs(by - cy) < 1e-3 && (by < 0.01 || by > 319.99)), 'a flagged edge lies on the canvas border');
    }
  }
  assert.ok(Math.abs(covered - 480 * 320) < 0.5, `the fans cover ${covered} px^2`);
  assert.ok(borders >= 4);
  for (let id = 0; id < shardCount; id += 1) {
    const s = id * SHARD_FLOATS;
    const dist = Math.hypot(shards[s] - impact.x, shards[s + 1] - impact.y);
    assert.ok(Math.abs(shards[s + 5] - (CRACK_HOLD + dist / CRACK_SPEED)) < 1e-6, 'start = crack hold + distance / crack speed');
  }
});

test('shardPoint (the twin of vs_shard): exactly home until the shard starts, then it moves and falls', () => {
  const vertices = new Float32Array(MAX_VERTICES * VERTEX_FLOATS);
  const shards = new Float32Array(MAX_SHARDS * SHARD_FLOATS);
  buildShards({ x: 240, y: 160 }, 480, 320, 20, 5, vertices, shards);
  const home = { x: vertices[4], y: vertices[5] };
  const id = Math.floor(vertices[6] / 2);
  const start = shards[id * SHARD_FLOATS + 5];
  assert.deepEqual(shardPoint(shards, id, home, 0, 2400), home);
  assert.deepEqual(shardPoint(shards, id, home, start, 2400), home);
  const later = shardPoint(shards, id, home, start + 1.5, 2400);
  assert.ok(later.y > home.y + 500, 'gravity wins after 1.5 s');
});

test('timeline (shared with disintegrate, plugins/_lib/transition.js): play round trip and a mid-way reversal', async () => {
  const tl = createTimeline({ duration: 100, hold: 10 });
  const p = tl.request('play');
  tl.advance(0); tl.advance(50);
  assert.equal(tl.g, 0.5);
  tl.advance(100); tl.advance(110); tl.advance(210);
  assert.equal(await p, true);
  assert.equal(tl.assembled, true);
});

test('options and the uniform header', () => {
  const o = readOptions({ pieces: 500, gravity: 0, onSubmit: 'whenever', edgeColor: '#000' });
  assert.equal(o.pieces, MAX_SHARDS);
  assert.equal(o.gravity, 0.2);
  assert.equal(o.onSubmit, 'off');
  assert.deepEqual(o.edge, [0, 0, 0]);
  const data = new Float32Array(HEADER_FLOATS);
  fillHeader(data, { width: 960, height: 640, cssWidth: 480, cssHeight: 320 }, readOptions({}), 0.5, { x: 10, y: 20 }, 1);
  assert.deepEqual(Array.from(data.slice(0, 12)), [960, 640, 480, 320, Math.fround(0.5 * SPAN), 2400, 1, Math.fround(0.5 * SPAN * CRACK_SPEED), 10, 20, Math.fround(0.85), 1]);
  fillHeader(data, { width: 960, height: 640, cssWidth: 480, cssHeight: 320 }, readOptions({}), 1, { x: 10, y: 20 }, 1);
  assert.equal(data[6], 0, 'every shard faded at g = 1');
});

function fakeGpu() {
  const g = /** @type {any} */ (globalThis);
  g.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
  g.GPUBufferUsage = { UNIFORM: 64, COPY_DST: 8, VERTEX: 32 };
  g.GPUTextureUsage = { TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
  const created = { bindGroup: 0, buffer: 0, texture: 0, pipeline: 0, submit: 0 };
  /** @type {any[]} */ const writes = [];
  /** @type {any[]} */ const draws = [];
  const pass = { setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, draw: (/** @type {number[]} */ ...a) => draws.push(a), end() {} };
  /** @type {any[]} */ const buffers = [];
  const device = {
    createShaderModule: () => ({}), createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
    createRenderPipeline: () => { created.pipeline += 1; return {}; },
    createBuffer: (/** @type {any} */ d) => { created.buffer += 1; const b = { size: d.size, destroy() {} }; buffers.push(b); return b; },
    createTexture: (/** @type {any} */ d) => { created.texture += 1; return { width: d.size[0], height: d.size[1], createView: () => ({}), destroy() {} }; },
    createSampler: () => ({}), createBindGroup: () => { created.bindGroup += 1; return {}; },
    createCommandEncoder: () => ({ beginRenderPass: () => pass, finish: () => ({}) }),
    queue: { writeBuffer: (/** @type {any} */ b, /** @type {number} */ offset, /** @type {Float32Array} */ d) => writes.push({ b, offset, impact: offset === 0 ? [d[8], d[9]] : null }), submit: () => { created.submit += 1; } },
  };
  return { device, created, writes, draws, buffers, encoder: { beginRenderPass: () => pass } };
}

/** @param {Record<string, unknown>} options */
async function instance(options) {
  const gpu = fakeGpu();
  const realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, text: async () => '// wgsl' }));
  const field = { localName: 'input', getBoundingClientRect: () => ({ left: 300, top: 100, width: 100, height: 20 }) };
  const source = Object.assign(new EventTarget(), {
    invalid: false,
    querySelectorAll() { return this.invalid ? [field] : []; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 480, height: 320 }),
  });
  const canvas = /** @type {any} */ ({ clientWidth: 480, clientHeight: 320, clientLeft: 0, clientTop: 0, getBoundingClientRect: () => ({ left: 0, top: 0 }), ownerDocument: { defaultView: { matchMedia: () => ({ matches: false }) } } });
  /** @type {Record<string, Function>} */ const listeners = {};
  const context = /** @type {any} */ ({ apiVersion: 2, device: gpu.device, format: 'bgra8unorm', canvas, source, requestRender() {}, listen: (/** @type {string} */ type, /** @type {Function} */ fn) => { listeners[type] = fn; return () => {}; }, viewport: () => ({}) });
  try {
    const inst = /** @type {any} */ (await plugin.create(context, { duration: 1000, ...options }));
    const sourceTexture = { width: 960, height: 640 };
    const sourceView = {}, destinationView = {};
    const frame = (/** @type {number} */ now) => ({ now, width: 960, height: 640, cssWidth: 480, cssHeight: 320, dpr: 2, sourceReady: true, sourceTexture, sourceView, destinationView, encoder: gpu.encoder });
    return { inst, gpu, canvas, source, frame, listeners };
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** the shards part of the uniform buffer was written: one layout @param {any} gpu */
const layouts = (gpu) => gpu.writes.filter((/** @type {any} */ w) => w.offset === HEADER_FLOATS * 4).length;

test('instance: no GPU object per frame, one layout per shatter, identity when assembled and blocked while shards move', async () => {
  const { inst, gpu, canvas, frame } = await instance({});
  inst.render(frame(0));
  const idle = { ...gpu.created };
  for (let k = 1; k <= 30; k += 1) inst.render(frame(k * 8));
  assert.deepEqual(gpu.created, idle);
  assert.equal(inst.captureInputMapper(frame(0)), identityMapper);
  const done = trigger(canvas, 'play');
  for (let k = 0; k <= 300; k += 1) {
    inst.render(frame(300 + k * 8.33));
    if (k === 10) assert.equal(inst.captureInputMapper(frame(0)), blockedMapper);
  }
  assert.equal(layouts(gpu), 1, 'the shards were built once');
  assert.deepEqual(gpu.created, { ...idle, texture: idle.texture + 1, submit: idle.submit + 1, bindGroup: idle.bindGroup + 1 }, 'only the freeze (texture, copy, bind group), once');
  assert.equal(await done, true);
  assert.equal(inst.captureInputMapper(frame(0)), identityMapper);
  assert.equal(gpu.draws.at(-1)[0], 3, 'assembled: the full-screen pass');
});

test('instance: the impact is the last pointer press, else the centre of the invalid field, else the canvas centre', async () => {
  /** @param {any} x */
  const impactOf = (x) => x.gpu.writes.filter((/** @type {any} */ w) => w.offset === 0).at(-1).impact;
  const field = await instance({ onSubmit: 'invalid' });
  field.inst.render(field.frame(0));
  field.source.invalid = true;
  field.source.dispatchEvent(new Event('submit'));
  field.inst.render(field.frame(10));
  assert.equal(layouts(field.gpu), 1, 'an invalid submit shatters');
  assert.deepEqual(impactOf(field), [350, 110], 'from the centre of the invalid field (keyboard submit)');
  const press = await instance({ onSubmit: 'invalid' });
  press.inst.render(press.frame(0));
  press.listeners.pointerdown({ clientX: 50, clientY: 60 });
  press.source.invalid = true;
  press.source.dispatchEvent(new Event('submit'));
  press.inst.render(press.frame(10));
  assert.deepEqual(impactOf(press), [50, 60], 'from the pointer press (the Submit button)');
  const api = await instance({});
  api.inst.render(api.frame(0));
  trigger(api.canvas, 'out');
  api.inst.render(api.frame(10));
  assert.deepEqual(impactOf(api), [240, 160], 'the canvas centre');
  const valid = await instance({ onSubmit: 'invalid' });
  valid.inst.render(valid.frame(0));
  valid.source.dispatchEvent(new Event('submit'));
  assert.equal(valid.inst.continuous, false, 'a valid form does not shatter');
});

test('instance: destroy resolves the pending trigger and unhooks the canvas', async () => {
  const { inst, canvas, frame } = await instance({ onSubmit: 'always' });
  inst.render(frame(0));
  const pending = trigger(canvas, 'out');
  inst.destroy();
  assert.equal(await pending, false);
  assert.equal(await trigger(canvas, 'in'), false);
});
