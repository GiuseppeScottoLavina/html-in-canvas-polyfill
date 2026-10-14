// Node tests of the glitch plugin: the folder contract, the block generator, the mapper against an independent port of the shader's
// block loop, the frame function (bursts, ambient micro-glitches, reduced motion, the same picture at every frame cap), the triggers
// and the render path (no allocation per frame).
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractTest } from '../../_shared/contract-test.mjs';
import {
  AMBIENT_CYCLE_MS, BURST_MS, HEADER_FLOATS, MAX_BLOCKS, PATTERN_MS, UNIFORM_FLOATS, fillBlocks, fillGlitchFrame, hash01, mapGlitchPoint, meta, plugin,
} from '../index.js';

const W = 480;
const H = 320;

contractTest(import.meta.url);

test('meta and the definition agree', () => {
  assert.equal(plugin.type, meta.name);
  assert.equal(plugin.apiVersion, 2);
  assert.deepEqual(meta.defaults, { mode: 'ambient', intensity: 0.35 });
});

test('the hash is deterministic and spreads over [0, 1)', () => {
  assert.equal(hash01(3, 4), hash01(3, 4));
  const v = Array.from({ length: 4000 }, (_, i) => hash01(7, i));
  assert.ok(v.every((x) => x >= 0 && x < 1));
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  assert.ok(Math.abs(mean - 0.5) < 0.03, `mean ${mean}`);
});

test('blocks: whole pixels, inside the page, at most MAX_BLOCKS, reproducible, different per pattern', () => {
  for (const level of [0.1, 0.5, 1]) {
    for (let pattern = 0; pattern < 30; pattern += 1) {
      const a = new Float32Array(UNIFORM_FLOATS);
      const n = fillBlocks(a, W, H, level, 9, pattern, true);
      assert.ok(n >= 3 && n <= MAX_BLOCKS, `${n} blocks`);
      for (let i = 0; i < n; i += 1) {
        const b = Array.from(a.slice(HEADER_FLOATS + i * 8, HEADER_FLOATS + i * 8 + 8));
        assert.ok(b.every(Number.isInteger), `whole pixels: ${b}`);
        assert.ok(b[0] >= 0 && b[1] >= 0 && b[2] <= W && b[3] <= H && b[2] > b[0] && b[3] > b[1], `inside: ${b}`);
        assert.ok(b[6] === 0 || b[6] === 1);
      }
      const again = new Float32Array(UNIFORM_FLOATS);
      fillBlocks(again, W, H, level, 9, pattern, true);
      assert.deepEqual(again, a);
    }
  }
  const p0 = new Float32Array(UNIFORM_FLOATS);
  const p1 = new Float32Array(UNIFORM_FLOATS);
  fillBlocks(p0, W, H, 1, 9, 0, true);
  fillBlocks(p1, W, H, 1, 9, 1, true);
  assert.notDeepEqual(p0, p1);
  assert.equal(fillBlocks(p0, W, H, 0, 9, 0, true), 0, 'level 0: no block');
  const noSort = new Float32Array(UNIFORM_FLOATS);
  const n = fillBlocks(noSort, W, H, 1, 9, 0, false);
  for (let i = 0; i < n; i += 1) assert.equal(noSort[HEADER_FLOATS + i * 8 + 6], 0, 'sort off: no streak');
});

/**
 * Independent port of glitch.wgsl (written from the shader): instance 0 draws the page, instance i block i - 1 on top, so the last block
 * whose rectangle covers the point decides; a shift block samples the page at the wrapped, shifted point, a sort streak at the point.
 */
function shaderSource(u, x, y) {
  let shown = null;
  const n = Math.min(16, Math.trunc(u[8]));
  for (let i = 0; i < n; i += 1) {
    const [x0, y0, x1, y1] = u.slice(12 + 8 * i, 12 + 8 * i + 4);
    if (x >= x0 && y >= y0 && x < x1 && y < y1) shown = u.slice(12 + 8 * i + 4, 12 + 8 * i + 8);
  }
  if (!shown || shown[2] >= 0.5) return { x, y };
  const qx = x - shown[0], qy = y - shown[1];
  return { x: qx - Math.floor(qx / u[2]) * u[2], y: qy - Math.floor(qy / u[3]) * u[3] };
}

/** @param {Partial<import('../index.js').GlitchFrameParams>} o */
const params = (o) => ({
  width: W, height: H, cssWidth: W, cssHeight: H, now: 0, ready: true, mode: 'ambient', intensity: 0.35, seed: 1,
  burstAt: -1, burstSerial: 1, reduced: false, split: true, sort: true, noise: true, ...o,
});

test('the mapper is the shader\'s layering: identity outside the displaced blocks, the wrapped inverse offset of the top block inside (every pixel, 12 frames)', () => {
  let moved = 0;
  for (let k = 0; k < 12; k += 1) {
    const u = new Float32Array(UNIFORM_FLOATS);
    fillGlitchFrame(u, params({ now: 1000 + k * PATTERN_MS, burstAt: 1000, intensity: 1 }));
    for (let y = 0.5; y < H; y += 1) {
      for (let x = 0.5; x < W; x += 1) {
        const m = mapGlitchPoint(u, { x, y, width: W, height: H });
        const s = shaderSource(u, x, y);
        assert.ok(m.x === s.x && m.y === s.y, `${x},${y}: ${JSON.stringify(m)} vs ${JSON.stringify(s)}`);
        if (m.x !== x || m.y !== y) moved += 1;
      }
    }
  }
  assert.ok(moved > 20000, `${moved} displaced pixels`);
});

test('the mapper scales between the presented size and the page size of its frame', () => {
  const u = new Float32Array(UNIFORM_FLOATS);
  fillGlitchFrame(u, params({ now: 0, burstAt: 0, intensity: 1 }));
  for (let i = 0; i < 200; i += 1) {
    const x = (i * 37) % W + 0.5;
    const y = (i * 53) % H + 0.5;
    const a = mapGlitchPoint(u, { x, y, width: W, height: H });
    const b = mapGlitchPoint(u, { x: 2 * x, y: 2 * y, width: 2 * W, height: 2 * H });
    assert.ok(Math.abs(b.x - 2 * a.x) < 1e-9 && Math.abs(b.y - 2 * a.y) < 1e-9);
  }
});

test('a burst: blocks for BURST_MS, a clean pattern every fifth, the envelope fades, then nothing moves', () => {
  const u = new Float32Array(UNIFORM_FLOATS);
  const counts = [];
  for (let e = 0; e < BURST_MS; e += PATTERN_MS) { fillGlitchFrame(u, params({ mode: 'burst', now: 5000 + e, burstAt: 5000 })); counts.push(u[8]); }
  assert.equal(counts[3], 0);
  assert.equal(counts[8], 0);
  assert.ok(counts.filter((c) => c > 0).length >= 8);
  assert.equal(fillGlitchFrame(u, params({ mode: 'burst', now: 5000 + BURST_MS, burstAt: 5000 })), false, 'burst mode is still once the burst ended');
  assert.equal(u[8], 0);
  assert.equal(u[5], 0, 'no split in burst mode at rest');
});

test('ambient: subtle layers always, a micro-glitch once per cycle, and identity between them', () => {
  const u = new Float32Array(UNIFORM_FLOATS);
  let glitched = 0, frames = 0;
  for (let now = 0; now < 10 * AMBIENT_CYCLE_MS; now += 1000 / 120) {
    assert.equal(fillGlitchFrame(u, params({ now })), true, 'ambient animates');
    assert.ok(u[5] > 0 && u[5] < 1 && u[6] > 0 && u[6] < 0.2, 'faint split and grain');
    frames += 1;
    if (u[8] > 0) glitched += 1;
  }
  const share = glitched / frames;
  assert.ok(share > 0.03 && share < 0.12, `micro-glitches ${(share * 100).toFixed(1)}% of the time`);
});

test('the same instant gives the same uniform block at every frame cap', () => {
  const at = (fps) => {
    const u = new Float32Array(UNIFORM_FLOATS);
    const out = new Map();
    for (let i = 0; i <= fps; i += 1) {
      const now = 2000 + (i * 1000) / fps;
      fillGlitchFrame(u, params({ now, burstAt: 2000, intensity: 0.8 }));
      if ([2000, 2200, 2400, 3000].includes(Math.round(now * 1000) / 1000)) out.set(Math.round(now), Array.from(u));
    }
    return out;
  };
  const ref = at(120);
  for (const fps of [60, 30, 15]) for (const [k, v] of at(fps)) assert.deepEqual(v, ref.get(k), `${fps} fps at ${k} ms`);
});

test('prefers-reduced-motion: no block ever moves, no grain animation, a burst is one steady colour frame', () => {
  const u = new Float32Array(UNIFORM_FLOATS);
  for (let now = 0; now < 4 * AMBIENT_CYCLE_MS; now += 10) {
    const moving = fillGlitchFrame(u, params({ now, reduced: true, burstAt: 1000, intensity: 1 }));
    assert.equal(u[8], 0);
    assert.equal(u[4], 0);
    assert.equal(moving, false, 'a steady picture: no next frame needed');
    if (now >= 1000 && now < 1000 + BURST_MS) assert.ok(u[10] > 0 && u[5] >= 6, 'the burst is a steady colour change');
    else assert.equal(u[10], 0);
  }
});

// ------------------------------------------------------------------------------------------------ the instance, with a recording fake GPU
function fakeEnv({ reduced = false } = {}) {
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  const writes = [];
  const passes = [];
  const device = {
    createShaderModule: () => ({}), createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }), createBuffer: () => ({ destroy() {} }),
    createSampler: () => ({}), createBindGroup: () => ({}), queue: { writeBuffer: (_b, _o, d) => writes.push(d) },
  };
  const encoder = { beginRenderPass: (d) => { passes.push(d); return { setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }; } };
  const source = new EventTarget();
  const canvas = { ownerDocument: { defaultView: { matchMedia: () => ({ matches: reduced }) } } };
  let renders = 0;
  const context = { device, format: 'bgra8unorm', canvas, source, requestRender() { renders += 1; }, listen: () => () => {} };
  const frame = (now) => ({ now, width: W, height: H, cssWidth: W, cssHeight: H, sourceReady: true, sourceView: {}, destinationView: {}, encoder });
  return { context, writes, passes, source, frame, renders: () => renders };
}

async function created(t, env, options) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => '// wgsl' }); // source mode loads glitch.wgsl; Node has no server
  t.after(() => { globalThis.fetch = realFetch; });
  return plugin.create(/** @type {any} */ (env.context), options);
}

test('triggers: an `invalid` event in the page and a change of the `trigger` option start a burst on the next frame (not the initial value)', async (t) => {
  const env = fakeEnv();
  const inst = await created(t, env, { mode: 'burst', intensity: 1, trigger: 0 });
  inst.render(env.frame(100));
  assert.equal(env.writes.at(-1)[8], 0, 'burst mode at rest; the initial trigger value is not a trigger');
  env.source.dispatchEvent(new Event('invalid'));
  inst.render(env.frame(200));
  assert.ok(env.writes.at(-1)[8] > 0, 'the burst started on this frame');
  inst.render(env.frame(200 + BURST_MS + 1));
  assert.equal(env.writes.at(-1)[8], 0);
  await new Promise((r) => setTimeout(r, 260));   // the triggers are debounced (one burst per validation pass)
  inst.setOptions({ mode: 'burst', intensity: 1, trigger: 1 });
  inst.render(env.frame(2000));
  assert.ok(env.writes.at(-1)[8] > 0);
  inst.destroy();
});

test('a mapper keeps the blocks of its own frame (frozen slots; the gesture snapshot copies)', async (t) => {
  const env = fakeEnv();
  const inst = await created(t, env, { mode: 'burst', intensity: 1 });
  env.source.dispatchEvent(new Event('invalid'));
  inst.render(env.frame(0));
  const first = inst.captureInputMapper(/** @type {any} */ ({}));
  const gesture = first.captureGestureSnapshot();
  const probe = Array.from({ length: 400 }, (_, i) => ({ x: (i * 37) % W + 0.5, y: (i * 53) % H + 0.5, width: W, height: H }));
  const before = probe.map((p) => first(p));
  for (let k = 1; k <= 3; k += 1) { inst.render(env.frame(k * PATTERN_MS)); inst.captureInputMapper(/** @type {any} */ ({})); }
  assert.deepEqual(probe.map((p) => first(p)), before);
  assert.deepEqual(probe.map((p) => gesture(p)), before);
  assert.ok(before.some((m, i) => m.x !== probe[i].x || m.y !== probe[i].y), 'the first frame displaced something');
});

test('the render path allocates nothing per frame: one uniform array, one pass descriptor; ambient asks for frames, burst mode at rest does not', async (t) => {
  const env = fakeEnv();
  const inst = await created(t, env, { mode: 'ambient' });
  for (let k = 0; k < 50; k += 1) inst.render(env.frame(k * 8));
  assert.equal(new Set(env.writes).size, 1);
  assert.equal(new Set(env.passes).size, 1);
  assert.ok(env.renders() >= 50);
  const quiet = fakeEnv();
  const still = await created(t, quiet, { mode: 'burst' });
  still.render(quiet.frame(0));
  const n = quiet.renders();
  still.render(quiet.frame(8));
  assert.equal(quiet.renders(), n, 'nothing moves: no frame requested');
});

test('prefers-reduced-motion, the instance: a burst asks for no frame while it lasts, then one frame that ends it', async (t) => {
  const env = fakeEnv({ reduced: true });
  const inst = await created(t, env, { mode: 'ambient', intensity: 1 });
  inst.render(env.frame(0));
  const atRest = env.renders();
  inst.render(env.frame(16));
  assert.equal(env.renders(), atRest, 'ambient with reduced motion is still');
  env.source.dispatchEvent(new Event('invalid'));
  const triggered = env.renders();
  inst.render(env.frame(100));
  inst.render(env.frame(116));
  assert.equal(env.renders(), triggered, 'no frame requested during the steady burst');
  assert.ok(env.writes.at(-1)[10] > 0 && env.writes.at(-1)[8] === 0, 'colour only, no block');
  await new Promise((r) => setTimeout(r, BURST_MS + 30));
  assert.equal(env.renders(), triggered + 1, 'one frame at the end of the burst');
  inst.render(env.frame(100 + BURST_MS + 5));
  assert.equal(env.writes.at(-1)[10], 0);
  inst.destroy();
});
