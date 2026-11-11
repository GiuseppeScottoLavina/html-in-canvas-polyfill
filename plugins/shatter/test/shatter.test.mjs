// Node tests of the shatter plugin: the folder contract, the crack geometry (an exact partition of the canvas, fans that are never inside
// out), the mapper of the cracked pane (the inverse of the offsets and of the bending along the cracks), the physics twin, options, uniforms,
// and what the instance does with a recording fake GPU (no GPU object per frame, one pattern per crack, the two impacts, the mappers, the
// impact point, submit wiring, destroy), the actions through the effect handle (plugins/_shared/node-host.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractTest } from '../../_shared/contract-test.mjs';
import { ACTIONS, actionPoint, blockedMapper, CRACK_MS, crackFront, DEMO_FALL_MS, DEMO_PAUSE_MS, FALL_SAMPLES, fillHeader, HEADER_FLOATS, identityMapper, meta, plugin, readOptions } from '../index.js';
import { nodeHandle } from '../../_shared/node-host.mjs';
import { BEVEL, buildShards, crackedLayout, crackedSource, fallTime, HEAL, MAX_POLY, MAX_SHARDS, MAX_VERTICES, MAX_WALL_VERTICES, mulberry32, polygonCentroid, SHARD_FLOATS, shardPoint, SPAN, spiderweb, THICKNESS, VERTEX_FLOATS } from '../shards.js';
import { isNoTarget } from '../../../src/effects/no-target.js';
import { readFileSync } from 'node:fs';
import { HDR_PEAK, SHOULDER_WGSL } from '../../_lib/hdr.js';

contractTest(import.meta.url);

test('meta and the definition agree; the gallery defaults are valid options', () => {
  assert.equal(plugin.type, meta.name);
  assert.equal(plugin.apiVersion, 2);
  const o = readOptions(meta.defaults);
  assert.equal(o.onSubmit, 'invalid');
  assert.equal(o.duration, 1200, 'one way of the fall plays its 1.2 s of physics in real time');
  assert.equal(o.intro, true);
});

/** @param {Float32Array} vertices @param {number} vertexCount */
function fans(vertices, vertexCount) {
  let covered = 0, inverted = 0;
  for (let t = 0; t < vertexCount; t += 3) {
    const v = (/** @type {number} */ k) => vertices.subarray((t + k) * VERTEX_FLOATS, (t + k + 1) * VERTEX_FLOATS);
    const a = ((v(1)[0] - v(0)[0]) * (v(2)[1] - v(0)[1]) - (v(1)[1] - v(0)[1]) * (v(2)[0] - v(0)[0])) / 2;
    covered += a;
    if (!(a > 0)) inverted += 1;
  }
  return { covered, inverted };
}

const CASES = /** @type {const} */ ([[{ x: 240, y: 160 }, 480, 320, 13, 1], [{ x: 5, y: 5 }, 1100, 620, 24, 2], [{ x: 1099, y: 300 }, 1100, 620, 6, 3], [{ x: 581, y: 405 }, 1100, 620, 13, 7]]);

test('the crack pattern: an exact partition of the canvas into at most MAX_SHARDS cells of at most MAX_POLY vertices; no fan is inside out', () => {
  const vertices = new Float32Array(MAX_VERTICES * VERTEX_FLOATS);
  const shards = new Float32Array(MAX_SHARDS * SHARD_FLOATS);
  for (const [impact, w, h, spokes, seed] of CASES) {
    for (let k = 0; k < 25; k += 1) {
      const cells = spiderweb(impact, w, h, spokes, mulberry32(seed * 1000 + k));
      const area = cells.reduce((sum, c) => sum + polygonCentroid(c.poly).area, 0);
      assert.ok(Math.abs(area - w * h) < 1e-6 * w * h, `cells cover ${area} of ${w * h}`);
      assert.ok(cells.every((c) => c.poly.length >= 3 && c.poly.length <= MAX_POLY));
      const built = buildShards(impact, w, h, spokes, seed * 1000 + k, vertices, shards);
      assert.equal(built.shardCount, cells.length, 'every cell became a shard (none dropped)');
      assert.ok(built.shardCount <= MAX_SHARDS);
      const f = fans(vertices, built.vertexCount);
      assert.equal(f.inverted, 0, 'every fan triangle is counter-clockwise (the fan centre sees each edge from inside)');
      assert.ok(Math.abs(f.covered - w * h) < 1e-3 * w * h, `the fans cover ${f.covered} of ${w * h}`);
    }
  }
});

test('the crack pattern looks like broken glass: every spoke runs out from the impact, the inner rings are whole, the outer ones broken', () => {
  const S = 13;
  const cells = spiderweb({ x: 550, y: 310 }, 1100, 620, S, mulberry32(4));
  const ring = (/** @type {number} */ k) => cells.filter((c) => c.ring === k).length;
  assert.equal(ring(0), S, 'one cell per spoke around the impact');
  assert.equal(ring(1), S, 'the first ring is whole');
  const outer = cells.filter((c) => c.ring >= 3).length;
  const rings = Math.max(...cells.map((c) => c.ring));
  assert.ok(outer < S * (rings - 2), `farther out some ring cracks are missing: ${outer} cells where whole rings would give ${S * (rings - 2)}`);
});

test('buildShards: border edges flagged, small offsets away from the impact, the fall starts after the cracks have spread', () => {
  const vertices = new Float32Array(MAX_VERTICES * VERTEX_FLOATS);
  const shards = new Float32Array(MAX_SHARDS * SHARD_FLOATS);
  const impact = { x: 100, y: 80 };
  const { vertexCount, shardCount } = buildShards(impact, 480, 320, 13, 4, vertices, shards);
  let borders = 0;
  for (let t = 0; t < vertexCount; t += 3) {
    const o = t * VERTEX_FLOATS;
    assert.deepEqual([vertices[o + 3], vertices[o + VERTEX_FLOATS + 3], vertices[o + 2 * VERTEX_FLOATS + 3]], [1, 0, 0], 'edge factor: centre 1, outer edge 0');
    const nx = vertices[o + 4], ny = vertices[o + 5];
    assert.ok(Math.abs(Math.hypot(nx, ny) - 1) < 1e-5, 'a unit inward normal');
    assert.ok(nx * (vertices[o] - vertices[o + VERTEX_FLOATS]) + ny * (vertices[o + 1] - vertices[o + VERTEX_FLOATS + 1]) > 0, 'pointing at the fan centre');
    if (vertices[o + 2] % 2 === 1) {
      borders += 1;
      const [bx, by, cx, cy] = [vertices[o + VERTEX_FLOATS], vertices[o + VERTEX_FLOATS + 1], vertices[o + 2 * VERTEX_FLOATS], vertices[o + 2 * VERTEX_FLOATS + 1]];
      assert.ok((Math.abs(bx - cx) < 1e-3 && (bx < 0.01 || bx > 479.99)) || (Math.abs(by - cy) < 1e-3 && (by < 0.01 || by > 319.99)), 'a flagged edge lies on the canvas border');
    }
  }
  assert.ok(borders >= 4);
  for (let id = 0; id < shardCount; id += 1) {
    const s = id * SHARD_FLOATS;
    const off = Math.hypot(shards[s + 2], shards[s + 3]);
    assert.ok(off > 0.5 && off < 6, `the crack offset of a piece is a few px (${off})`);
    assert.ok(shards[s + 7] >= HEAL * SPAN, 'no shard falls before the cracks have spread');
    assert.ok(Math.abs(Math.hypot(shards[s + 8], shards[s + 9], shards[s + 10]) - 1) < 1e-5, 'a unit spin axis');
  }
});

test('the mapper of the cracked pane: the exact inverse of the offsets inside a piece, of the bending near a crack, the identity in the open crack', () => {
  const vertices = new Float32Array(MAX_VERTICES * VERTEX_FLOATS);
  const shards = new Float32Array(MAX_SHARDS * SHARD_FLOATS);
  const W = 480, H = 320;
  const built = buildShards({ x: 200, y: 140 }, W, H, 13, 9, vertices, shards);
  const L = crackedLayout(vertices, built.vertexCount, shards, built.shardCount, 1.6);
  vertices.fill(0); shards.fill(0);   // the next crack reuses the staging arrays: the layout must have its own copy
  let inside = 0, exact = 0, eligible = 0, open = 0;
  for (let y = 0.5; y < H; y += 3) {
    for (let x = 0.5; x < W; x += 3) {
      const p = { x, y };
      const q = crackedSource(L, p);
      assert.ok(Number.isFinite(q.x) && Number.isFinite(q.y));
      if (q.x === p.x && q.y === p.y) { open += 1; continue; }
      // the presented point is the source point moved by the offset of the shard it lies in (bending excluded): within offset + refraction
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      assert.ok(d < 8, `moved by ${d}`);
      if (d > 1e-9) inside += 1;
    }
  }
  // a point deep inside a piece: exactly minus that piece's offset
  for (let id = 0; id < L.shardCount; id += 1) {
    const s = id * SHARD_FLOATS;
    const t = L.first[id];
    const o = t * 3 * VERTEX_FLOATS;
    // a point of the first fan triangle of the piece, near its centre (the centre itself is shared by all of them)
    const cx = 0.8 * L.tri[o] + 0.1 * L.tri[o + VERTEX_FLOATS] + 0.1 * L.tri[o + 2 * VERTEX_FLOATS];
    const cy = 0.8 * L.tri[o + 1] + 0.1 * L.tri[o + VERTEX_FLOATS + 1] + 0.1 * L.tri[o + 2 * VERTEX_FLOATS + 1];
    const de = L.tri[o + 4] * (cx - L.tri[o + VERTEX_FLOATS]) + L.tri[o + 5] * (cy - L.tri[o + VERTEX_FLOATS + 1]);
    if (de < BEVEL + 1) continue;   // too close to the crack: bent
    eligible += 1;
    const p = { x: cx + L.data[s + 2], y: cy + L.data[s + 3] };
    const q = crackedSource(L, p);
    if (Math.abs(q.x - cx) < 1e-9 && Math.abs(q.y - cy) < 1e-9) exact += 1;
  }
  console.log(`cracked mapper: ${inside} moved points, ${open} in open cracks, ${exact} of ${eligible} points away from the cracks mapped home exactly`);
  assert.ok(inside > 10000 && open > 0 && open < inside / 10);
  assert.ok(eligible > 10 && exact === eligible, 'a point of a piece away from its cracks maps exactly to its home');
});

test('shardPoint (the twin of vs_shard): home + offset until the shard falls, then it moves, turns and falls', () => {
  const vertices = new Float32Array(MAX_VERTICES * VERTEX_FLOATS);
  const shards = new Float32Array(MAX_SHARDS * SHARD_FLOATS);
  buildShards({ x: 240, y: 160 }, 480, 320, 13, 5, vertices, shards);
  const home = { x: vertices[VERTEX_FLOATS], y: vertices[VERTEX_FLOATS + 1] };
  const id = Math.floor(vertices[2] / 2);
  const o = { gravity: 2400, focal: 768, width: 480, height: 320 };
  const start = shards[id * SHARD_FLOATS + 7];
  assert.deepEqual(shardPoint(shards, id, home, 0, o), { x: home.x + shards[id * SHARD_FLOATS + 2], y: home.y + shards[id * SHARD_FLOATS + 3] });
  assert.deepEqual(shardPoint(shards, id, home, start, { ...o, k: 0 }), home, 'cracks closed: exactly home');
  const later = shardPoint(shards, id, home, start + 1.2, o);
  assert.ok(later.y > home.y + 300, 'gravity wins after 1.2 s');
});

test('options, the crack front and the uniform header', () => {
  const o = readOptions({ cracks: 500, gravity: 0, onSubmit: 'whenever', edgeColor: '#000', state: 'cracked', impact: { x: 3, y: 4 } });
  assert.equal(o.cracks, 24);
  assert.equal(o.gravity, 0.2);
  assert.equal(o.onSubmit, 'off');
  assert.deepEqual(o.edge, [0, 0, 0]);
  assert.equal(o.state, 'cracked');
  assert.deepEqual(o.impact, { x: 3, y: 4 });
  assert.equal(readOptions({ cracks: 1 }).cracks, 6);
  assert.equal(readOptions({ impact: { x: 'a' } }).impact, null);
  assert.equal(crackFront(0, 500), 0);
  assert.equal(crackFront(1, 500), 700, 'open: past the farthest corner, every piece fully cracked');
  const data = new Float32Array(HEADER_FLOATS);
  const look = { time: 0.4, crack: 1, far: 500, fade: 0.5, flash: 0, debrisT: 0.1, debrisN: 260, alpha: 1 };
  fillHeader(data, { width: 960, height: 640, cssWidth: 480, cssHeight: 320 }, readOptions({}), look, { x: 10, y: 20 });
  assert.deepEqual(Array.from(data.slice(0, 20)), [960, 640, 480, 320, Math.fround(0.4), 2400, 1, 700, 10, 20, Math.fround(0.85), 0.5, 0, 1, Math.fround(0.8), Math.fround(1.6 * 480), Math.fround(0.1), 260, THICKNESS, Math.fround(1.6)]);
});

function fakeGpu() {
  const g = /** @type {any} */ (globalThis);
  g.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
  g.GPUBufferUsage = { UNIFORM: 64, COPY_DST: 8, VERTEX: 32 };
  g.GPUTextureUsage = { TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
  const created = { bindGroup: 0, buffer: 0, texture: 0, pipeline: 0, submit: 0 };
  /** the multisampled textures alive now (the targets of the fall) */
  const live = new Set();
  /** @type {any[]} */ const descriptors = [];
  /** the descriptors of the pipelines the plugin made @type {any[]} */ const pipelines = [];
  /** @type {any[]} */ const writes = [];
  /** @type {any[]} */ const draws = [];
  const pass = { setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, draw: (/** @type {number[]} */ ...a) => draws.push(a), end() {} };
  const device = {
    createShaderModule: () => ({}), createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
    createRenderPipeline: (/** @type {any} */ d) => { created.pipeline += 1; pipelines.push(d); return {}; },
    createBuffer: (/** @type {any} */ d) => { created.buffer += 1; return { size: d.size, destroy() {} }; },
    createTexture: (/** @type {any} */ d) => {
      created.texture += 1;
      const t = { width: d.size[0], height: d.size[1], d, createView: () => ({}), destroy() { live.delete(t); } };
      if (d.sampleCount > 1) live.add(t);
      return t;
    },
    createSampler: () => ({}), createBindGroup: () => { created.bindGroup += 1; return {}; },
    createCommandEncoder: () => ({ beginRenderPass: () => pass, finish: () => ({}) }),
    queue: { writeBuffer: (/** @type {any} */ b, /** @type {number} */ offset, /** @type {Float32Array} */ d) => writes.push({ b, offset, impact: offset === 0 ? [d[8], d[9]] : null, shards: offset === HEADER_FLOATS * 4 ? Float32Array.from(d) : null }), submit: () => { created.submit += 1; } },
  };
  return { device, created, writes, draws, live, descriptors, pipelines, encoder: { beginRenderPass: (/** @type {any} */ d) => { descriptors.push(d); draws.push(['pass', d.depthStencilAttachment ? '3d' : 'flat']); return pass; } } };
}

/**
 * The plugin behind the real effect handle, over the fake GPU. `localPoint` stands for the plugins added after this one (context.localPoint).
 * @param {Record<string, unknown>} options @param {{reducedMotion?: boolean, localPoint?: (point: {x: number, y: number}) => {x: number, y: number}|null}} [o]
 */
async function instance(options, { reducedMotion = false, localPoint, hdr = undefined } = {}) {
  const gpu = fakeGpu();
  const realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, text: async () => '// wgsl' }));
  const field = { localName: 'input', getBoundingClientRect: () => ({ left: 300, top: 100, width: 100, height: 20 }) };
  const source = Object.assign(new EventTarget(), {
    invalid: false,
    querySelectorAll() { return this.invalid ? [field] : []; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 480, height: 320 }),
  });
  const canvas = /** @type {any} */ (Object.assign(new EventTarget(), { clientWidth: 480, clientHeight: 320, clientLeft: 0, clientTop: 0, getBoundingClientRect: () => ({ left: 0, top: 0 }), ownerDocument: { defaultView: { matchMedia: () => ({ matches: false }) } } }));
  /** a pointer press on the canvas, as context.listen hears it @param {number} clientX @param {number} clientY */
  const press = (clientX, clientY) => canvas.dispatchEvent(Object.assign(new Event('pointerdown'), { clientX, clientY }));
  try {
    // `hdr`: the context says so (the node host has no extended range of its own)
    const def = hdr === undefined ? plugin : { ...plugin, create: (/** @type {any} */ c, /** @type {any} */ o) => plugin.create({ ...c, hdr }, o) };
    const h = await nodeHandle(def, { duration: 1000, ...options }, { device: gpu.device, canvas, source, reducedMotion, localPoint });
    const inst = h.inst;
    const sourceTexture = { width: 960, height: 640 };
    const sourceView = {}, destinationView = {};
    const frame = (/** @type {number} */ now) => ({ now, width: 960, height: 640, cssWidth: 480, cssHeight: 320, dpr: 2, sourceReady: true, sourceTexture, sourceView, destinationView, encoder: gpu.encoder });
    return { inst, handle: h.handle, errors: h.errors, gpu, canvas, source, frame, press };
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** crack patterns built (the shards part of the uniform buffer was written) @param {any} gpu */
const patterns = (gpu) => gpu.writes.filter((/** @type {any} */ w) => w.offset === HEADER_FLOATS * 4).length;
/** every pending promise reaction has run (the host's handle adds a few promise steps between the plugin and the page) */
const flush = () => new Promise((resolve) => setImmediate(resolve));
/** @param {any} gpu */
const impactOfGpu = (gpu) => gpu.writes.filter((/** @type {any} */ w) => w.offset === 0).at(-1).impact;
/** @param {any} x */
const impactOf = (x) => impactOfGpu(x.gpu);

test('instance: the first impact cracks (blocked while the cracks run, then the inverse mapper of the pane), the second breaks it', async () => {
  const { inst, gpu, handle, frame } = await instance({});
  inst.render(frame(0));
  const idle = { ...gpu.created };
  assert.equal(inst.captureInputMapper(frame(0)), identityMapper);
  const cracked = handle.trigger('impact', { point: { x: 120, y: 90 } });
  inst.render(frame(10));
  assert.equal(inst.captureInputMapper(frame(10)), blockedMapper, 'the cracks start running: blocked');
  inst.render(frame(10 + CRACK_MS / 2));
  assert.equal(inst.continuous, true);
  inst.render(frame(20 + CRACK_MS));
  assert.equal(await cracked, 'cracked');
  assert.deepEqual(impactOfGpu(gpu), [120, 90], 'at the point of the action');
  assert.equal(inst.continuous, false, 'cracked and still: the host renders only when the page changes');
  const m = inst.captureInputMapper(frame(0));
  assert.ok(m !== identityMapper && m !== blockedMapper, 'the mapper of the cracked pane');
  inst.render(frame(600));
  assert.equal(inst.captureInputMapper(frame(0)), m, 'the same function on every frame of the same pattern: nothing allocated per frame');
  const p = m({ x: 300, y: 200, width: 480, height: 320 });
  assert.ok(!isNoTarget(p) && Math.hypot(p.x - 300, p.y - 200) < 8, 'a point maps to a point a few px away (the piece it lies on)');
  const [base, pane] = gpu.draws.slice(-2);
  assert.deepEqual(base, [3], 'the picture in place, dimmed (seen inside the open cracks)');
  assert.equal(pane[1], 1, 'then the pane: one copy of each shard');
  assert.equal(patterns(gpu), 1, 'one pattern per crack');
  const broken = handle.trigger('impact');
  for (let k = 0; k <= 400; k += 1) {
    inst.render(frame(700 + k * 8.33));
    if (k === 20) assert.equal(inst.captureInputMapper(frame(0)), blockedMapper, 'falling: blocked');
    if (k === 60) {
      const frameDraws = gpu.draws.slice(gpu.draws.findLastIndex((/** @type {any[]} */ d) => d[0] === 'pass'));
      assert.deepEqual(frameDraws[0], ['pass', '3d'], 'falling: one pass with a depth buffer');
      const [backdrop, shadows, faces, walls, debris] = frameDraws.slice(1);
      assert.deepEqual(backdrop, [3], 'the lit backdrop behind the pane');
      assert.equal(shadows[1], 1, 'the shadows: one copy of each face');
      assert.equal(faces[0], shadows[0], 'then the faces, from the same vertices');
      assert.equal(faces[1], 2, 'two faces per shard: the front and the back of the slab');
      assert.ok(walls[0] > faces[0] / 3 && walls[0] % 6 === 0 && walls[1] === 1, `then the walls: one quad per edge (${walls[0]} vertices)`);
      assert.deepEqual(debris, [3, 260], 'and the debris');
      const d = gpu.descriptors.at(-1);
      assert.ok(d.colorAttachments[0].resolveTarget && d.colorAttachments[0].storeOp === 'discard' && d.depthStencilAttachment.depthStoreOp === 'discard',
        'MSAA resolved into the destination; nothing of the multisampled target or the depth is stored');
      assert.equal(gpu.live.size, 2, 'the multisampled colour target and the depth buffer exist while shards fly');
      assert.ok([...gpu.live].every((/** @type {any} */ t) => t.d.sampleCount === FALL_SAMPLES && t.width === 960 && t.height === 640), 'at the backing size, 4 samples');
    }
  }
  assert.equal(await broken, 'intact', 'the second impact breaks the pane, it flies back: intact');
  assert.equal(patterns(gpu), 1, 'the fall breaks the pattern that cracked');
  assert.equal(inst.captureInputMapper(frame(0)), identityMapper, 'back in place, cracks closed: the identity');
  assert.deepEqual(gpu.draws.at(-1), [3], 'and the full-screen passthrough');
  assert.equal(gpu.live.size, 0, 'the targets of the fall are released once it ends');
  assert.deepEqual(gpu.created, { ...idle, texture: idle.texture + 3, submit: idle.submit + 1, bindGroup: idle.bindGroup + 1 },
    'per fall: the freeze (texture, copy, bind group) and the two targets of the fall, once each, nothing per frame');
});

test('instance: the impact point is the last pointer press, else the centre of the invalid field, else the impact option, else the centre', async () => {
  const field = await instance({ onSubmit: 'invalid' });
  field.inst.render(field.frame(0));
  field.source.invalid = true;
  field.source.dispatchEvent(new Event('submit'));
  field.inst.render(field.frame(10));
  field.inst.render(field.frame(20));
  assert.equal(patterns(field.gpu), 1, 'an invalid submit cracks');
  assert.deepEqual(impactOf(field), [350, 110], 'from the centre of the invalid field (keyboard submit)');
  const press = await instance({ onSubmit: 'invalid' });
  press.inst.render(press.frame(0));
  press.press(50, 60);
  press.source.invalid = true;
  press.source.dispatchEvent(new Event('submit'));
  press.inst.render(press.frame(10)); press.inst.render(press.frame(20));
  assert.deepEqual(impactOf(press), [50, 60], 'from the pointer press (the Submit button)');
  const option = await instance({ impact: { x: 400, y: 30 } });
  option.inst.render(option.frame(0));
  option.handle.trigger('crack');
  option.inst.render(option.frame(10)); option.inst.render(option.frame(20));
  assert.deepEqual(impactOf(option), [400, 30], 'the impact option');
  const api = await instance({});
  api.inst.render(api.frame(0));
  api.handle.trigger('out');
  api.inst.render(api.frame(10)); api.inst.render(api.frame(20));
  assert.deepEqual(impactOf(api), [240, 160], 'the canvas centre');
});

/** an invalid submit right after a press at client (x, y) (no press without them); returns where the glass cracked @param {any} x @param {number} [cx] @param {number} [cy] */
function crackAfterPress(x, cx, cy) {
  x.inst.render(x.frame(0));
  if (cx !== undefined && cy !== undefined) x.press(cx, cy);
  x.source.invalid = true;
  x.source.dispatchEvent(new Event('submit'));
  x.inst.render(x.frame(10)); x.inst.render(x.frame(20));
  assert.equal(patterns(x.gpu), 1, 'the invalid submit cracks');
  return impactOf(x);
}

test('instance: with plugins added after it, the press is read through context.localPoint: the glass cracks where the press is seen in its own picture; control: without them, at the press', async () => {
  const DX = 120, DY = 60;
  const shifted = crackAfterPress(await instance({ onSubmit: 'invalid' }, { localPoint: (p) => ({ x: p.x + DX, y: p.y + DY }) }), 50, 60);
  const there = crackAfterPress(await instance({ onSubmit: 'invalid' }), 50 + DX, 60 + DY);
  const here = crackAfterPress(await instance({ onSubmit: 'invalid' }), 50, 60);
  assert.deepEqual(shifted, [50 + DX, 60 + DY], 'the impact is the press as context.localPoint gives it');
  assert.deepEqual(shifted, there, 'the same impact as a press at that point with no plugin after it');
  assert.deepEqual(here, [50, 60], 'control: with no plugin after it the impact is the press itself');
  assert.notDeepEqual(shifted, here, 'control: the impact depends on where the press is');
});

test('instance: a press where a later plugin shows nothing of the glass (context.localPoint gives null) stores no point: the impact comes from the invalid field, as with no press at all; control: a press that is seen decides the impact', async () => {
  const unseen = crackAfterPress(await instance({ onSubmit: 'invalid' }, { localPoint: () => null }), 50, 60);
  const noPress = crackAfterPress(await instance({ onSubmit: 'invalid' }));
  const seen = crackAfterPress(await instance({ onSubmit: 'invalid' }), 50, 60);
  assert.deepEqual(unseen, noPress, 'exactly as with no press');
  assert.deepEqual(unseen, [350, 110], 'the centre of the invalid field');
  assert.deepEqual(seen, [50, 60], 'control: the same press, seen, is the impact');
});

test('instance: submit wiring: invalid cracks, invalid again breaks it, a valid one heals a cracked pane; a submit during a transition does nothing', async () => {
  const { inst, source, frame, gpu } = await instance({ onSubmit: 'invalid' });
  inst.render(frame(0));
  source.dispatchEvent(new Event('submit'));
  assert.equal(inst.continuous, false, 'a valid form does not crack');
  source.invalid = true;
  source.dispatchEvent(new Event('submit'));
  inst.render(frame(10));
  source.dispatchEvent(new Event('submit'));
  inst.render(frame(100));
  assert.equal(patterns(gpu), 1, 'a second submit while the cracks run does nothing');
  inst.render(frame(20 + CRACK_MS));
  const m = inst.captureInputMapper(frame(0));
  assert.ok(m !== identityMapper && m !== blockedMapper, 'cracked');
  source.invalid = false;
  source.dispatchEvent(new Event('submit'));
  assert.equal(inst.continuous, true, 'the form was fixed: the cracks close');
  inst.render(frame(600)); inst.render(frame(600 + CRACK_MS + 10));
  assert.equal(inst.captureInputMapper(frame(0)), identityMapper, 'healed');
  source.invalid = true;
  source.dispatchEvent(new Event('submit'));
  inst.render(frame(1200)); inst.render(frame(1210 + CRACK_MS));
  source.dispatchEvent(new Event('submit'));
  inst.render(frame(1800));
  inst.render(frame(2000));
  assert.equal(inst.captureInputMapper(frame(0)), blockedMapper, 'the second invalid submit breaks the pane');
  assert.deepEqual(gpu.draws.at(-1), [3, 260], 'with debris: one triangle per chip');
});

test('instance: a valid submit while the cracks still run heals them (a fixed form never stays behind cracked glass); settled() reports the end state', async () => {
  const { inst, source, handle, frame } = await instance({ onSubmit: 'invalid' });
  inst.render(frame(0));
  assert.equal(await handle.settled(), 'intact', 'nothing moves: at once');
  source.invalid = true;
  source.dispatchEvent(new Event('submit'));
  inst.render(frame(10));
  inst.render(frame(10 + CRACK_MS / 3));                   // the cracks are a third of the way out
  /** @type {any[]} */ const seen = [];
  handle.settled().then((v) => seen.push(v));
  source.invalid = false;
  source.dispatchEvent(new Event('submit'));                // fixed and submitted again, before the cracks have finished
  assert.equal(inst.continuous, true, 'the cracks turn back');
  inst.render(frame(10 + CRACK_MS / 3 + 50));
  await flush();
  assert.deepEqual(seen, [], 'not settled while they close');
  inst.render(frame(10 + CRACK_MS * 2));
  await flush();
  assert.deepEqual(seen, ['intact'], 'settled after the frame that draws the intact pane');
  assert.equal(inst.captureInputMapper(frame(0)), identityMapper);
  source.invalid = true;
  source.dispatchEvent(new Event('submit'));
  inst.render(frame(2000)); inst.render(frame(2010 + CRACK_MS));
  assert.equal(await handle.settled(), 'cracked');
  handle.remove();
  assert.equal(await handle.settled(), null, 'removed: null');
});

test('instance: reduced motion: nothing cracks; an impact crossfades', async () => {
  const { inst, handle, frame, gpu } = await instance({ reducedMotion: true });
  inst.render(frame(0));
  assert.equal(await handle.trigger('crack'), 'intact', 'no crack: it resolves with the state it rests in');
  inst.render(frame(10));
  assert.equal(inst.captureInputMapper(frame(0)), identityMapper);
  handle.trigger('impact');
  inst.render(frame(20)); inst.render(frame(500));
  assert.deepEqual(gpu.draws.at(-1), [3], 'the full-screen crossfade');
  assert.equal(patterns(gpu), 0, 'no crack pattern');
  assert.equal(inst.captureInputMapper(frame(0)), blockedMapper, 'input blocked while it fades');
});

test('instance: removal resolves the pending trigger null; an unknown action or a bad point rejects', async () => {
  const { inst, handle, frame, errors } = await instance({ onSubmit: 'always' });
  inst.render(frame(0));
  assert.deepEqual([...handle.actions], ['impact', 'crack', 'out', 'in', 'play', 'demo']);
  assert.deepEqual([...ACTIONS], [...(plugin.actions ?? [])]);
  await assert.rejects(handle.trigger('sideways'), /unknown action "sideways" of the plugin "shatter"; its actions are 'impact', 'crack', 'out', 'in', 'play', 'demo'/);
  await assert.rejects(handle.trigger('crack', { point: { x: NaN, y: 2 } }), (e) => e instanceof TypeError && /point/.test(e.message));
  await assert.rejects(handle.trigger('crack', { point: 'centre' }), TypeError);
  assert.equal(inst.continuous, false, 'a rejected action changes nothing');
  const pending = handle.trigger('out');
  handle.remove();
  assert.equal(await pending, null);
  await assert.rejects(handle.trigger('in'), /removed/);
  assert.equal(errors.length, 0);
});

test('actions: crack and out end in their states; in heals; play round-trips; a submit supersedes a pending page trigger; actionPoint', async () => {
  const { inst, handle, source, frame } = await instance({ onSubmit: 'invalid' });
  inst.render(frame(0));
  const crack = handle.trigger('crack');
  inst.render(frame(10)); inst.render(frame(20 + CRACK_MS));
  assert.equal(await crack, 'cracked');
  const heal = handle.trigger('in');
  inst.render(frame(600)); inst.render(frame(610 + CRACK_MS));
  assert.equal(await heal, 'intact', 'in closes the cracks');
  const out = handle.trigger('out');
  for (let k = 0; k <= 200; k += 1) inst.render(frame(1200 + k * 8.33));
  assert.equal(await out, 'gone');
  assert.equal(await handle.settled(), 'gone');
  const back = handle.trigger('in');
  for (let k = 0; k <= 200; k += 1) inst.render(frame(3000 + k * 8.33));
  assert.equal(await back, 'intact');
  const play = handle.trigger('play');
  let rest = 'pending';
  handle.settled().then((v) => { rest = v; });
  for (let k = 0; k <= 400; k += 1) inst.render(frame(5000 + k * 8.33));
  assert.equal(await play, 'intact', 'out, a pause, in');
  assert.equal(rest, 'intact');
  const page = handle.trigger('crack');
  inst.render(frame(9000));
  source.invalid = false;
  source.dispatchEvent(new Event('submit'));                // the form is valid: the running cracks close (the plugin's own 'in')
  assert.equal(await page, null, 'the submit acts through the host (context.trigger): the page trigger is superseded');
  inst.render(frame(9010)); inst.render(frame(9020 + CRACK_MS));
  assert.equal(await handle.settled(), 'intact');
  assert.deepEqual(actionPoint(undefined, 'shatter'), null);
  assert.deepEqual(actionPoint({ x: 1, y: 2, z: 3 }, 'shatter'), { x: 1, y: 2 });
  assert.throws(() => actionPoint({ x: 1 }, 'shatter'), /shatter: `point`/);
});

test('the walls: one quad per edge of every cell, at both faces, with the outward normal of that edge; borders marked', () => {
  const vertices = new Float32Array(MAX_VERTICES * VERTEX_FLOATS);
  const shards = new Float32Array(MAX_SHARDS * SHARD_FLOATS);
  const walls = new Float32Array(MAX_WALL_VERTICES * VERTEX_FLOATS);
  for (const [impact, w, h, spokes, seed] of CASES) {
    const cells = spiderweb(impact, w, h, spokes, mulberry32(seed));
    const built = buildShards(impact, w, h, spokes, seed, vertices, shards, walls);
    const again = buildShards(impact, w, h, spokes, seed, vertices, shards);
    assert.equal(again.vertexCount, built.vertexCount, 'the walls draw no random number: the same pattern with or without them');
    assert.equal(again.wallCount, 0, 'no walls array: none written');
    const edges = cells.reduce((n, c) => n + c.poly.length, 0);
    assert.equal(built.wallCount, edges * 6, 'two triangles per edge of every cell');
    let borders = 0;
    for (let q = 0; q < built.wallCount; q += 6) {
      const at = (/** @type {number} */ k, /** @type {number} */ f) => walls[(q + k) * VERTEX_FLOATS + f];
      const id = Math.floor(at(0, 2) / 2);
      assert.deepEqual([0, 1, 2, 3, 4, 5].map((k) => at(k, 2) - id * 2), [0, 0, 1, 0, 1, 1], 'the front edge, then the back edge of the same shard');
      const ax = at(0, 0), ay = at(0, 1), bx = at(1, 0), by = at(1, 1);
      const len = Math.hypot(bx - ax, by - ay);
      assert.ok(Math.abs(at(1, 7) - len) < 1e-3 && at(0, 6) === 0 && Math.abs(at(1, 6) - len) < 1e-3, 'the length of the edge and the distance along it');
      // outward: the centre of the shard is behind the edge
      const cx = shards[id * SHARD_FLOATS], cy = shards[id * SHARD_FLOATS + 1];
      const nx = at(0, 4), ny = at(0, 5);
      assert.ok(Math.abs(Math.hypot(nx, ny) - 1) < 1e-5 && nx * (cx - ax) + ny * (cy - ay) < 0, 'a unit normal pointing away from the shard');
      if (at(0, 3) === 1) {
        borders += 1;
        const eps = 1e-3 * Math.max(w, h);   // buildShards' tolerance: an edge within it of the border is the border
        const near = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ edge) => (Math.abs(a) < eps && Math.abs(b) < eps) || (Math.abs(a - edge) < eps && Math.abs(b - edge) < eps);
        assert.ok(near(ax, bx, w) || near(ay, by, h), 'a border wall lies on the canvas border');
      }
    }
    assert.ok(borders >= 4, `the canvas border is part of the outer shards (${borders} walls)`);
    // the faces tell a crack (0) from the canvas border (1) and from a seam inside a cell (2)
    for (let t = 0; t < built.vertexCount; t += 3) {
      const o = t * VERTEX_FLOATS, kind = vertices[o + 7], flag = vertices[o + 2] % 2;
      assert.ok(kind === 0 ? flag === 0 : flag === 1, 'kind 0 is exactly the edges that are cracks');
    }
  }
});

test('fallTime: real time on the way out, eased into place on the way back, continuous when a run reverses midway', () => {
  const ta = HEAL * SPAN;
  assert.equal(fallTime(1, 0, 0, 0), 0);
  assert.equal(fallTime(1, 0.5, 0, 0), 0.5 * SPAN, 'out from the pane: g * SPAN');
  assert.equal(fallTime(1, 1, 0, 0), SPAN);
  assert.equal(fallTime(1, 1, 0, 0, 0.66), 0.66, 'a shorter end (the demo)');
  assert.equal(fallTime(-1, 1, 1, SPAN), SPAN, 'in from gone: starts where the way out ended');
  assert.ok(Math.abs(fallTime(-1, HEAL, 1, SPAN) - ta) < 1e-12, 'every shard is home (before any start) when the cracks begin to close');
  assert.equal(fallTime(-1, 0, 1, SPAN), 0);
  // the shards slow down as they arrive: the physics clock runs at a fraction of the way-out rate near HEAL
  const rate = (/** @type {number} */ g) => (fallTime(-1, g + 1e-4, 1, SPAN) - fallTime(-1, g, 1, SPAN)) / 1e-4;
  assert.ok(rate(HEAL + 0.02) < 0.1 * SPAN && rate(0.95) > 1.5 * SPAN, `arrives slowly (${rate(HEAL + 0.02).toFixed(3)} s per g), leaves fast (${rate(0.95).toFixed(2)})`);
  // a reversal midway is continuous: from the time of the last frame, both ways
  const tOut = fallTime(1, 0.6, 0, 0);
  assert.equal(fallTime(-1, 0.6, 0.6, tOut), tOut, 'out, then in at g 0.6: no jump');
  const tIn = fallTime(-1, 0.4, 1, SPAN);
  assert.equal(fallTime(1, 0.4, 0.4, tIn), tIn, 'in, then out at g 0.4: no jump');
  assert.equal(fallTime(1, 1, 0.4, tIn), SPAN);
  assert.equal(fallTime(-1, 0.05, 0.08, 0.1), 0.1 * 0.05 / 0.08, 'reversed before any shard fell: linear back to 0');
  for (let g = 0; g <= 1; g += 0.01) {
    const a = fallTime(-1, g, 1, SPAN), b = fallTime(-1, Math.min(1, g + 0.01), 1, SPAN);
    assert.ok(b >= a, 'monotonic');
  }
});

/** render frames 1000/120 ms apart from `t0` until `done` settles or `ms` pass; returns the time reached @param {any} x @param {number} t0 @param {number} ms */
async function renderFor(x, t0, ms) {
  let now = t0;
  for (; now <= t0 + ms; now += 1000 / 120) { x.inst.render(x.frame(now)); await flush(); }
  return now;
}

test('demo: crack at the submit control, a rest, the break, the stop in the air, the rewind; ends intact in under 4 s, then no work', async () => {
  const x = await instance({ intro: false, duration: 1600 });
  const submit = { getBoundingClientRect: () => ({ left: 100, top: 200, width: 80, height: 30 }) };
  x.source.querySelector = (/** @type {string} */ sel) => (/submit/.test(sel) ? submit : null);
  x.inst.render(x.frame(0));
  const seen = /** @type {string[]} */ ([]);
  const passes = /** @type {string[]} */ ([]);
  let state = /** @type {any} */ ('pending');
  const t0 = Date.now();
  x.handle.trigger('demo').then((v) => { state = v; });
  let now = 10;
  // the cracks run and rest: render through the pause in real time (the pause is a timer)
  for (; state === 'pending' && now < 6000; now += 1000 / 120) {
    x.inst.render(x.frame(now));
    const m = x.inst.captureInputMapper(x.frame(now));
    const kind = m === identityMapper ? 'intact' : m === blockedMapper ? 'moving' : 'cracked';
    if (seen.at(-1) !== kind) seen.push(kind);
    const pass = x.gpu.draws.findLast((/** @type {any[]} */ d) => d[0] === 'pass')[1];
    if (passes.at(-1) !== pass) passes.push(pass);
    await new Promise((r) => setTimeout(r, 1000 / 120 / 4));   // a quarter of real time: the pause (a timer) still passes
  }
  assert.equal(state, 'intact', 'the demo resolves with the state it rests in');
  assert.deepEqual(seen, ['moving', 'cracked', 'moving', 'intact'], 'the cracks run, the pane rests cracked, it breaks and comes back');
  assert.deepEqual(impactOf(x), [140, 215], 'struck at the centre of the submit control');
  assert.deepEqual(passes, ['flat', '3d', 'flat'], 'the shards stay in the air through the hold (not faded out): every frame of the fall draws them');
  const frameMs = now - 10, wallMs = Date.now() - t0;
  assert.ok(frameMs - (wallMs - 0) < 4000 && CRACK_MS + DEMO_PAUSE_MS + 2 * DEMO_FALL_MS + 300 < 4000, `about 4 s at most (${Math.round(CRACK_MS + DEMO_PAUSE_MS + 2 * DEMO_FALL_MS + 300)} ms of animation)`);
  assert.equal(x.inst.continuous, false, 'at rest: the host renders nothing more');
  // the fall plays at the plugin's own duration again
  const out = x.handle.trigger('out');
  const reached = await renderFor(x, now + 100, 1000);
  assert.equal(x.inst.continuous, true, `a full fall (1600 ms) is still running after 1000 ms (${reached - now - 100} ms rendered)`);
  await renderFor(x, reached, 800);
  assert.equal(await out, 'gone');
});

test('the intro joins the pane where the demo strikes, and the demo cracks it from there along the same lines; control: a strike elsewhere draws a new pattern', async () => {
  /** the crack patterns built, in order (the shards part of the uniform buffer) @param {any} x */
  const built = (x) => x.gpu.writes.filter((/** @type {any} */ w) => w.shards).map((/** @type {any} */ w) => w.shards);
  const near = (/** @type {number[]} */ a, /** @type {number[]} */ b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.01;
  // no submit control in this source: the demo strikes right of and below the centre (0.62, 0.6 of the canvas)
  const strike = [480 * 0.62, 320 * 0.6];
  const x = await instance({ intro: true });
  const t = await renderFor(x, 0, 2000);
  assert.equal(await x.handle.settled(), 'intact', 'the intro ends with the pane in place');
  assert.equal(built(x).length, 1, 'the intro flew in along one pattern');
  assert.ok(near(impactOf(x), strike), `the intro joined at the demo's point ${strike}, not at the centre: ${impactOf(x)}`);
  assert.ok(!near(impactOf(x), [240, 160]), 'control: the centre is another point');
  const demo = x.handle.trigger('demo');
  await renderFor(x, t + 10, CRACK_MS + 50);
  const [intro, crack] = built(x);
  assert.ok(crack, 'the demo cracked the pane');
  assert.ok(near(impactOf(x), strike), `the demo cracks from the same point: ${impactOf(x)}`);
  assert.deepEqual(crack, intro, 'along the lines the pane joined at');
  x.press(1, 1);
  assert.equal(await demo, null, 'a press ends the demo');
  // control: a strike at another point after the intro is a new pattern there
  const y = await instance({ intro: true });
  const ty = await renderFor(y, 0, 2000);
  y.handle.trigger('crack', { point: { x: 100, y: 80 } });
  await renderFor(y, ty + 10, CRACK_MS + 50);
  const [introY, other] = built(y);
  assert.deepEqual(introY, intro, 'the same intro (the same seed and point)');
  assert.deepEqual(impactOf(y), [100, 80]);
  assert.notDeepEqual(other, introY, 'elsewhere the cracks are new');
  // a fall from the centre (out with no point) and back: the demo then strikes the centre, along the cracks the pane came back with
  const z = await instance({ intro: false });
  z.inst.render(z.frame(0));
  z.handle.trigger('out');
  let tz = await renderFor(z, 10, 1600);
  z.handle.trigger('in');
  tz = await renderFor(z, tz + 10, 1600);
  assert.equal(await z.handle.settled(), 'intact');
  const demoZ = z.handle.trigger('demo');
  await renderFor(z, tz + 10, CRACK_MS + 50);
  const [fallZ, crackZ] = built(z);
  assert.deepEqual(impactOf(z), [240, 160], 'the demo strikes where the pane came together (the centre), not the submit control');
  assert.deepEqual(crackZ, fallZ, 'along the same lines');
  z.press(1, 1);
  assert.equal(await demoZ, null);
});

test('demo: the user takes over at once (a pointer press or a key on the canvas); a newer action supersedes it; reduced motion does nothing', async () => {
  const x = await instance({ intro: false });
  x.inst.render(x.frame(0));
  const demo = x.handle.trigger('demo');
  await renderFor(x, 10, 200);
  assert.equal(x.inst.continuous, true, 'the cracks of the demo run');
  x.press(10, 10);
  const within = (/** @type {Promise<any>} */ p) => Promise.race([p, new Promise((r) => { setTimeout(() => r('still running'), 500); })]);
  assert.equal(await within(demo), null, 'a press during the demo ends it (superseded)');
  await renderFor(x, 300, CRACK_MS + 100);
  assert.equal(await x.handle.settled(), 'intact', 'and the pane comes back into place: the form is the user\'s');
  const key = await instance({ intro: false });
  key.inst.render(key.frame(0));
  const d2 = key.handle.trigger('demo');
  await renderFor(key, 10, 100);
  key.canvas.dispatchEvent(new Event('keydown'));
  assert.equal(await within(d2), null, 'a key during the demo ends it');
  const sup = await instance({ intro: false });
  sup.inst.render(sup.frame(0));
  const d3 = sup.handle.trigger('demo');
  await renderFor(sup, 10, 100);
  const crack = sup.handle.trigger('crack');
  assert.equal(await d3, null, 'a newer action supersedes the demo');
  await renderFor(sup, 200, CRACK_MS + 50);
  assert.equal(await crack, 'cracked');
  sup.press(5, 5);
  await renderFor(sup, 800, 50);
  assert.equal(await sup.handle.settled(), 'cracked', 'without a demo a press changes nothing');
  const opt = await instance({ intro: false });
  opt.inst.render(opt.frame(0));
  const d4 = opt.handle.trigger('demo');
  await renderFor(opt, 10, 100);
  opt.handle.setOptions({ cracks: 9 });
  assert.equal(await within(d4), null, 'setOptions during the demo ends it');
  await renderFor(opt, 200, CRACK_MS + 50);
  assert.equal(await opt.handle.settled(), 'intact', 'and the pane comes back into place');
  const calm = await instance({ intro: false, reducedMotion: true });
  calm.inst.render(calm.frame(0));
  assert.equal(await calm.handle.trigger('demo'), 'intact', 'reduced motion: it resolves at once with the state it rests in');
  assert.equal(calm.inst.continuous, false, 'nothing moves');
  assert.equal(patterns(calm.gpu), 0);
});

test('extended range: the pipelines whose shader adds light get HDR_PEAK from context.hdr, 1 without it; the shader holds the shared shoulder', async () => {
  /** @param {boolean|undefined} hdr */
  const peaks = async (hdr) => { const { gpu, handle } = await instance({}, { hdr }); handle.remove(); return gpu.pipelines.map((/** @type {any} */ d) => [d.fragment.entryPoint, d.fragment.constants?.HDR_PEAK]); };
  const lit = ['fs_shard', 'fs_debris', 'fs_backdrop', 'fs_wall'];
  const on = await peaks(true);
  assert.equal(on.length, 9);
  for (const [entry, peak] of on) assert.equal(peak, lit.includes(entry) ? HDR_PEAK : undefined, `${entry} with extended range`);
  for (const hdr of [false, undefined]) for (const [entry, peak] of await peaks(hdr)) assert.equal(peak, lit.includes(entry) ? 1 : undefined, `${entry} without (${hdr})`);
  assert.deepEqual([...new Set(on.filter(([, peak]) => peak === undefined).map(([entry]) => entry))].sort(), ['fs_copy', 'fs_full', 'fs_shadow'], 'the passthrough, the frozen copy and the shadows do not read it');
  const code = readFileSync(new URL('../shatter.wgsl', import.meta.url), 'utf8');
  assert.ok(code.includes(SHOULDER_WGSL), 'shatter.wgsl holds SHOULDER_WGSL of plugins/_lib/hdr.js, character for character');
  assert.ok(!code.replace(SHOULDER_WGSL, '').includes('override HDR_PEAK'), 'and declares the constant once');
});
