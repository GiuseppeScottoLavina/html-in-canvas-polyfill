// Node tests of the shatter plugin: the folder contract, the crack geometry (an exact partition of the canvas, fans that are never inside
// out), the mapper of the cracked pane (the inverse of the offsets and of the bending along the cracks), the physics twin, options, uniforms,
// and what the instance does with a recording fake GPU (no GPU object per frame, one pattern per crack, the two impacts, the mappers, the
// impact point, submit wiring, destroy), the actions through the effect handle (plugins/_shared/node-host.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractTest } from '../../_shared/contract-test.mjs';
import { ACTIONS, actionPoint, blockedMapper, CRACK_MS, crackFront, fillHeader, HEADER_FLOATS, identityMapper, meta, plugin, readOptions } from '../index.js';
import { nodeHandle } from '../../_shared/node-host.mjs';
import { BEVEL, buildShards, crackedLayout, crackedSource, HEAL, MAX_POLY, MAX_SHARDS, MAX_VERTICES, mulberry32, polygonCentroid, SHARD_FLOATS, shardPoint, SPAN, spiderweb, VERTEX_FLOATS } from '../shards.js';
import { isNoTarget } from '../../../src/effects/no-target.js';

contractTest(import.meta.url);

test('meta and the definition agree; the gallery defaults are valid options', () => {
  assert.equal(plugin.type, meta.name);
  assert.equal(plugin.apiVersion, 2);
  const o = readOptions(meta.defaults);
  assert.equal(o.onSubmit, 'invalid');
  assert.equal(o.duration, 1600);
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
  const look = { time: 0.4, crack: 1, far: 500, fade: 0.5, flash: 0, debrisT: 0.1, debrisN: 260, ghosts: 3, alpha: 1 };
  fillHeader(data, { width: 960, height: 640, cssWidth: 480, cssHeight: 320 }, readOptions({}), look, { x: 10, y: 20 });
  assert.deepEqual(Array.from(data.slice(0, 20)), [960, 640, 480, 320, Math.fround(0.4), 2400, 1, 700, 10, 20, Math.fround(0.85), 0.5, 0, 1, Math.fround(0.8), Math.fround(1.6 * 480), Math.fround(0.1), 260, 3, Math.fround(1.6)]);
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
  const device = {
    createShaderModule: () => ({}), createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
    createRenderPipeline: () => { created.pipeline += 1; return {}; },
    createBuffer: (/** @type {any} */ d) => { created.buffer += 1; return { size: d.size, destroy() {} }; },
    createTexture: (/** @type {any} */ d) => { created.texture += 1; return { width: d.size[0], height: d.size[1], createView: () => ({}), destroy() {} }; },
    createSampler: () => ({}), createBindGroup: () => { created.bindGroup += 1; return {}; },
    createCommandEncoder: () => ({ beginRenderPass: () => pass, finish: () => ({}) }),
    queue: { writeBuffer: (/** @type {any} */ b, /** @type {number} */ offset, /** @type {Float32Array} */ d) => writes.push({ b, offset, impact: offset === 0 ? [d[8], d[9]] : null }), submit: () => { created.submit += 1; } },
  };
  return { device, created, writes, draws, encoder: { beginRenderPass: () => pass } };
}

/** The plugin behind the real effect handle, over the fake GPU. @param {Record<string, unknown>} options @param {{reducedMotion?: boolean}} [o] */
async function instance(options, { reducedMotion = false } = {}) {
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
    const h = await nodeHandle(plugin, { duration: 1000, ...options }, { device: gpu.device, canvas, source, reducedMotion });
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
    if (k === 60) assert.equal(gpu.draws.at(-2)[1], 3, 'three copies per shard while it falls (the motion blur)');
  }
  assert.equal(await broken, 'intact', 'the second impact breaks the pane, it flies back: intact');
  assert.equal(patterns(gpu), 1, 'the fall breaks the pattern that cracked');
  assert.equal(inst.captureInputMapper(frame(0)), identityMapper, 'back in place, cracks closed: the identity');
  assert.deepEqual(gpu.draws.at(-1), [3], 'and the full-screen passthrough');
  assert.deepEqual(gpu.created, { ...idle, texture: idle.texture + 1, submit: idle.submit + 1, bindGroup: idle.bindGroup + 1 }, 'only the freeze (texture, copy, bind group), once');
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
  assert.deepEqual([...handle.actions], ['impact', 'crack', 'out', 'in', 'play']);
  assert.deepEqual([...ACTIONS], [...(plugin.actions ?? [])]);
  await assert.rejects(handle.trigger('sideways'), /unknown action "sideways" of the plugin "shatter"; its actions are 'impact', 'crack', 'out', 'in', 'play'/);
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
