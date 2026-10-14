// Node tests of the disintegrate plugin: the folder contract, the pure math (timeline, particle ages, grid, mappers, options) and what the
// instance does with a recording fake GPU (no GPU object is created per frame, the mapper per frame, triggers, submit wiring, destroy).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { checkPluginFolder } from '../../_shared/contract.mjs';
import { NO_TARGET, blockedMapper, createTimeline, fillUniforms, identityMapper, LIFE, MAX_PARTICLES, meta, parseColor, particleAge, particleGrid, plugin, readOptions, trigger, UNIFORM_FLOATS } from '../index.js';
import { findInvalid, sourcePointOnCanvas } from '../../_lib/transition.js';
import { isNoTarget } from '../../../src/effects/no-target.js';

test('the folder satisfies the plugin contract (plugins/README.md)', async () => {
  assert.deepEqual(await checkPluginFolder(fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')), []);
});

test('meta and the definition agree; the gallery defaults are valid options', () => {
  assert.equal(plugin.type, meta.name);
  assert.equal(plugin.apiVersion, 2);
  const o = readOptions(meta.defaults);
  assert.equal(o.onSubmit, 'valid');
  assert.equal(o.intro, true);
  assert.equal(o.particleSize, meta.defaults.particleSize);
});

test('timeline: the clock starts at the first frame after a request; out is linear and ends gone', async () => {
  const tl = createTimeline({ duration: 1000 });
  assert.equal(tl.assembled, true);
  const done = tl.request('out');
  assert.equal(tl.animating, true);
  assert.equal(tl.advance(5000), 0, 'first frame: g = 0 (the clock starts here)');
  assert.equal(tl.advance(5250), 0.25);
  assert.equal(tl.advance(5500), 0.5);
  assert.equal(tl.advance(6100), 1);
  assert.equal(tl.phase, 'gone');
  assert.equal(tl.animating, false);
  assert.equal(await done, true);
});

test('timeline: reversing midway continues from the current g, at the same speed; the superseded promise resolves false', async () => {
  const tl = createTimeline({ duration: 1000 });
  const out = tl.request('out');
  tl.advance(0); tl.advance(600);
  const back = tl.request('in');
  assert.equal(await out, false);
  assert.equal(tl.advance(1000), 0.6, 'continuous');
  assert.ok(Math.abs(tl.advance(1300) - 0.3) < 1e-9);
  tl.advance(1600);
  assert.equal(tl.g, 0);
  assert.equal(tl.assembled, true);
  assert.equal(await back, true);
});

test('timeline: play = out, hold, in; one promise for the whole round trip', async () => {
  const tl = createTimeline({ duration: 100, hold: 50 });
  let settled = false;
  const p = tl.request('play').then((v) => { settled = true; return v; });
  tl.advance(0); tl.advance(100);
  assert.equal(tl.phase, 'hold');
  assert.equal(tl.animating, true, 'the hold keeps frames coming');
  tl.advance(140);
  assert.equal(tl.phase, 'hold');
  tl.advance(150);
  assert.equal(tl.phase, 'in');
  tl.advance(200);
  assert.equal(tl.g, 0.5);
  await Promise.resolve();
  assert.equal(settled, false);
  tl.advance(250);
  assert.equal(tl.phase, 'idle');
  assert.equal(await p, true);
});

test('timeline: one late frame jumps to the end (any frame cap), a request already satisfied resolves at once, jump and cancel', async () => {
  const tl = createTimeline({ duration: 1000 });
  tl.request('out'); tl.advance(0);
  assert.equal(tl.advance(99999), 1);
  assert.equal(await tl.request('out'), true);
  const gone = createTimeline({ duration: 1000, gone: true });
  assert.equal(gone.phase, 'gone');
  const p = gone.request('in');
  gone.jump('in');
  assert.equal(await p, false);
  assert.equal(gone.assembled, true);
  const q = gone.request('out');
  gone.cancel();
  assert.equal(await q, false);
});

test('particle ages: every particle is home at g = 0 and gone at g = 1, whatever its start (the exact reassembly)', () => {
  for (let i = 0; i <= 1000; i += 1) {
    const start = (i / 1000) * (1 - LIFE);
    assert.equal(particleAge(0, start), 0);
    assert.ok(particleAge(1, start) > 1 - 1e-9, 'gone (alpha is 0 from age 0.8 on, and g = 1 draws no particle at all)');
    const mid = particleAge(0.5, start);
    assert.ok(mid >= 0 && mid <= 1);
  }
});

test('particle grid: cells of particleSize css px in backing px, the whole frame covered, at most MAX_PARTICLES', () => {
  assert.deepEqual(particleGrid(2200, 1240, 2, 3), { cell: 6, cols: 367, rows: 207, count: 75969 });
  const big = particleGrid(7680, 4320, 2, 1.5);
  assert.ok(big.count <= MAX_PARTICLES, `${big.count}`);
  assert.ok(big.cols * big.cell >= 7680 && big.rows * big.cell >= 4320);
  assert.equal(particleGrid(1, 1, 1, 3).count, 1);
});

test('mappers: identity when assembled; blocked returns the NO_TARGET of the effects ABI', () => {
  assert.deepEqual(identityMapper({ x: 3, y: 4 }), { x: 3, y: 4 });
  const b = blockedMapper();
  assert.equal(b, NO_TARGET);
  assert.ok(isNoTarget(b));
});

test('options: colours, clamps, fallbacks', () => {
  assert.deepEqual(parseColor('#ff8000', [0, 0, 0]), [1, 128 / 255, 0]);
  assert.deepEqual(parseColor('#fff', [0, 0, 0]), [1, 1, 1]);
  assert.deepEqual(parseColor([2, -1, 0.5], [0, 0, 0]), [1, 0, 0.5]);
  assert.deepEqual(parseColor('red', [0.1, 0.2, 0.3]), [0.1, 0.2, 0.3]);
  const o = readOptions({ particleSize: 99, wind: 'x', duration: 10, onSubmit: 'sometimes', state: 'out' });
  assert.equal(o.particleSize, 12);
  assert.equal(o.wind, 1);
  assert.equal(o.duration, 300);
  assert.equal(o.onSubmit, 'off');
  assert.equal(o.state, 'out');
  assert.equal(o.reducedMotion, null);
});

test('uniforms: the layout of disintegrate.wgsl', () => {
  const data = new Float32Array(UNIFORM_FLOATS);
  fillUniforms(data, { width: 800, height: 400, cssWidth: 400, cssHeight: 200 }, readOptions({ direction: 0 }), 0.5, { cell: 6, cols: 134 }, 1);
  assert.deepEqual(Array.from(data.slice(0, 10)), [800, 400, 400, 200, 0.5, Math.fround(LIFE), 6, 134, 1, 0]);
  assert.equal(data[10], Math.fround(0.55 * 400));
  assert.equal(data[14], 1);
  assert.equal(data[19], 1);
});

test('findInvalid and the invalid field point on the canvas', () => {
  const field = { localName: 'input' };
  const root = /** @type {any} */ ({ querySelectorAll: (/** @type {string} */ s) => (s.includes(':invalid') ? [{ localName: 'form' }, field] : []) });
  assert.equal(findInvalid(root), field);
  assert.equal(findInvalid(/** @type {any} */ ({ querySelectorAll: () => { throw new SyntaxError('bad'); } }), '!!'), null);
  assert.deepEqual(sourcePointOnCanvas({ left: 10, top: 20, width: 200, height: 100 }, { left: 60, top: 40, width: 20, height: 10 }, { width: 400, height: 200 }), { x: 120, y: 50 });
});

/** A recording fake of the WebGPU objects the plugin touches. */
function fakeGpu() {
  const g = /** @type {any} */ (globalThis);
  g.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
  g.GPUBufferUsage = { UNIFORM: 64, COPY_DST: 8 };
  g.GPUTextureUsage = { TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
  const created = { bindGroup: 0, buffer: 0, texture: 0, pipeline: 0, submit: 0 };
  /** @type {any[]} */ const draws = [];
  const pass = { setPipeline() {}, setBindGroup() {}, draw: (/** @type {number[]} */ ...a) => draws.push(a), end() {} };
  const device = {
    createShaderModule: () => ({}), createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
    createRenderPipeline: () => { created.pipeline += 1; return {}; },
    createBuffer: () => { created.buffer += 1; return { destroy() {} }; },
    createTexture: (/** @type {any} */ d) => { created.texture += 1; return { width: d.size[0], height: d.size[1], createView: () => ({}), destroy() {} }; },
    createSampler: () => ({}), createBindGroup: () => { created.bindGroup += 1; return {}; },
    createCommandEncoder: () => ({ beginRenderPass: () => pass, finish: () => ({}) }),
    queue: { writeBuffer() {}, submit: () => { created.submit += 1; } },
  };
  return { device, created, draws, encoder: { beginRenderPass: () => pass } };
}

/** @param {Record<string, unknown>} options */
async function instance(options) {
  const gpu = fakeGpu();
  const realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, text: async () => '// wgsl' }));
  const source = Object.assign(new EventTarget(), { invalid: false, querySelectorAll() { return this.invalid ? [{ localName: 'input' }] : []; } });
  const canvas = /** @type {any} */ ({ ownerDocument: { defaultView: { matchMedia: () => ({ matches: false }) } } });
  let renders = 0;
  const context = /** @type {any} */ ({ apiVersion: 2, device: gpu.device, format: 'bgra8unorm', canvas, source, requestRender: () => { renders += 1; }, listen: () => () => {}, viewport: () => ({}) });
  try {
    const inst = /** @type {any} */ (await plugin.create(context, { duration: 1000, ...options }));
    const sourceTexture = { width: 800, height: 400 };
    const sourceView = {}, destinationView = {};   // the host keeps its views across frames
    const frame = (/** @type {number} */ now) => ({ now, width: 800, height: 400, cssWidth: 400, cssHeight: 200, dpr: 2, sourceReady: true, sourceTexture, sourceView, destinationView, encoder: gpu.encoder });
    return { inst, gpu, canvas, source, frame, requests: () => renders };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('instance: no GPU object is created per frame, idle or animating; one freeze per transition', async () => {
  const { inst, gpu, canvas, frame } = await instance({});
  inst.render(frame(0));
  const before = { ...gpu.created };
  for (let k = 1; k <= 50; k += 1) inst.render(frame(k * 8));
  assert.deepEqual(gpu.created, before, 'idle frames');
  trigger(canvas, 'out');
  assert.equal(gpu.created.submit, before.submit + 1, 'the freeze copy');
  assert.equal(gpu.created.texture, before.texture + 1, 'the frozen texture, once');
  const afterFreeze = { ...gpu.created };
  for (let k = 51; k <= 200; k += 1) inst.render(frame(k * 8));
  assert.deepEqual(gpu.created, { ...afterFreeze, bindGroup: afterFreeze.bindGroup + 1 }, 'animating frames: only the bind group of the frozen view, once');
});

test('instance: identity mapper when assembled, blocked while it moves; continuous only while animating', async () => {
  const { inst, canvas, frame, gpu } = await instance({});
  inst.render(frame(0));
  assert.equal(inst.continuous, false);
  assert.equal(inst.captureInputMapper(frame(0)), identityMapper);
  const done = trigger(canvas, 'play');
  assert.equal(inst.continuous, true);
  inst.render(frame(10));
  assert.equal(inst.captureInputMapper(frame(10)), blockedMapper, 'g = 0 but the transition has started: blocked');
  inst.render(frame(500));
  assert.equal(gpu.draws.at(-1)[0], 6, 'particles: 6 vertices per instance');
  assert.equal(gpu.draws.at(-1)[1], 134 * 67, 'one instance per cell (3 css px at dpr 2 = 6 backing px)');
  inst.render(frame(1010));
  inst.render(frame(1400));
  inst.render(frame(2400));
  assert.equal(inst.captureInputMapper(frame(2400)), identityMapper);
  assert.equal(gpu.draws.at(-1)[0], 3, 'assembled: the full-screen pass');
  assert.equal(await done, true);
  assert.equal(inst.continuous, false);
});

test('instance: the intro starts dissolved and waits for the first snapshot; state option and reduced motion', async () => {
  const intro = await instance({ intro: true });
  assert.equal(intro.inst.continuous, true);
  intro.inst.render({ ...intro.frame(0), sourceReady: false });
  intro.inst.render(intro.frame(5000));
  intro.inst.render(intro.frame(5500));
  assert.equal(intro.inst.captureInputMapper(intro.frame(5500)), blockedMapper);
  intro.inst.render(intro.frame(6000));
  assert.equal(intro.inst.captureInputMapper(intro.frame(6000)), identityMapper, 'the clock started at the first READY frame');
  const st = await instance({ intro: false });
  st.inst.render(st.frame(0));
  st.inst.setOptions({ duration: 1000, state: 'out' });
  st.inst.render(st.frame(10)); st.inst.render(st.frame(2000));
  assert.equal(st.inst.captureInputMapper(st.frame(2000)), blockedMapper, 'state out: dissolved and staying so');
  st.inst.setOptions({ duration: 1000, state: 'out', particleSize: 4 });
  assert.equal(st.inst.continuous, false, 'an unrelated option does not replay the state');
  const rm = await instance({ reducedMotion: true });
  rm.inst.render(rm.frame(0));
  trigger(rm.canvas, 'out');
  rm.inst.render(rm.frame(10)); rm.inst.render(rm.frame(500));
  assert.equal(rm.gpu.draws.at(-1)[0], 3, 'reduced motion: the full-screen crossfade, no particles');
});

test('instance: submit wiring (valid only by default in the gallery), destroy resolves pending triggers and unhooks', async () => {
  const { inst, source, canvas, frame } = await instance({ onSubmit: 'valid' });
  inst.render(frame(0));
  source.invalid = true;
  source.dispatchEvent(new Event('submit'));
  assert.equal(inst.continuous, false, 'an invalid form does not play');
  source.invalid = false;
  source.dispatchEvent(new Event('submit'));
  assert.equal(inst.continuous, true, 'a valid one does');
  const pending = trigger(canvas, 'out');
  inst.destroy();
  assert.equal(await pending, false);
  assert.equal(await trigger(canvas, 'out'), false, 'no instance on the canvas any more');
  await assert.rejects(Promise.resolve().then(async () => {
    const again = await instance({});
    return trigger(again.canvas, /** @type {any} */ ('sideways'));
  }), /unknown action/);
});
