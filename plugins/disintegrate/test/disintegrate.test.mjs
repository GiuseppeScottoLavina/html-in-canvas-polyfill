// Node tests of the disintegrate plugin (dust): the folder contract, the timeline, the timing invariants, the dust grid and the background
// estimate's size, the sweep, options, the uniform layout of disintegrate.wgsl, and a fake GPU: no GPU object per frame, nothing frozen
// (the live page is sampled), the background estimate made when a transition starts and again only when the page changes, the draws
// (the page, then one grain per dust cell), the mappers, triggers, submit wiring, reduced motion, destroy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { checkPluginFolder } from '../../_shared/contract.mjs';
import { readFileSync } from 'node:fs';
import { BG_CELL, HOLD_MS, LIFE, MAX_GRAINS, NO_TARGET, SWEEP_END, UNIFORM_FLOATS, blockedMapper, bgSize, createTimeline, dustGrid, fillUniforms, identityMapper, meta, parseColor, plugin, readOptions, sweepOf, trigger } from '../index.js';
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
  assert.equal(o.duration, 1800, 'about 1.5 s of dust leaving plus the drift while no content is left');
  assert.equal(o.durationIn, 1200);
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

test('timing: every pixel of content has eroded by SWEEP_END; a grain lives from its birth to g = LIFE = 1, so the page is whole at g = 0 and empty of content at g = 1', () => {
  assert.ok(SWEEP_END < LIFE && LIFE === 1);
  assert.equal(HOLD_MS, 0, 'no still frame: the end of the way out is the pause');
  const wgsl = readFileSync(new URL('../disintegrate.wgsl', import.meta.url), 'utf8');
  assert.match(wgsl, /let a = \(u\.g - t\) \/ max\(u\.life - t, 1e-3\);/, 'the age of a grain runs from its birth to u.life');
  assert.match(wgsl, /\* u\.sweep_end;/, 'erosion ends at u.sweep_end');
  assert.match(wgsl, /fn fs_bg/, 'the background estimate');
});

test('dust grid and background estimate: cells of particleSize css px over the whole page, at most MAX_GRAINS; the estimate in BG_CELL texels', () => {
  assert.deepEqual(dustGrid(1100, 620, 1.5), { cell: 1.5, cols: 734, rows: 414, count: 303876 });
  const big = dustGrid(3840, 2160, 1);
  assert.ok(big.count <= MAX_GRAINS && big.cols * big.cell >= 3840 && big.rows * big.cell >= 2160, `${big.count}`);
  assert.equal(dustGrid(1, 1, 3).count, 1);
  assert.deepEqual(bgSize(1100, 620), [Math.ceil(1100 / BG_CELL), Math.ceil(620 / BG_CELL)]);
});

test('the sweep: a unit direction and the range it crosses the page in', () => {
  const s = sweepOf(0, 400, 200);
  assert.deepEqual([s.x, s.min, s.span], [1, 0, 400]);
  const d = sweepOf(45, 400, 200);
  assert.ok(Math.abs(Math.hypot(d.x, d.y) - 1) < 1e-12);
  assert.ok(Math.abs(d.span - (400 + 200) * Math.SQRT1_2) < 1e-9);
  const back = sweepOf(180, 400, 200);
  assert.ok(Math.abs(back.min + 400) < 1e-9 && Math.abs(back.span - 400) < 1e-9);
});

test('mappers: identity when assembled; blocked returns the NO_TARGET of the effects ABI', () => {
  assert.deepEqual(identityMapper({ x: 3, y: 4 }), { x: 3, y: 4 });
  const b = blockedMapper();
  assert.equal(b, NO_TARGET);
  assert.ok(isNoTarget(b));
});

test('options: colours, clamps, fallbacks', () => {
  assert.deepEqual(parseColor('#ff8000', [0, 0, 0]), [1, 128 / 255, 0]);
  assert.deepEqual(parseColor('red', [0.1, 0.2, 0.3]), [0.1, 0.2, 0.3]);
  const o = readOptions({ particleSize: 99, wind: 'x', duration: 10, onSubmit: 'sometimes', state: 'out', fragments: 3, sensitivity: -1 });
  assert.equal(o.particleSize, 4);
  assert.equal(o.wind, 1);
  assert.equal(o.duration, 300);
  assert.equal(o.fragments, 1);
  assert.equal(o.sensitivity, 0);
  assert.equal(o.onSubmit, 'off');
  assert.equal(o.state, 'out');
  assert.equal(o.reducedMotion, null);
  assert.equal(o.liveCounter, false);
});

test('uniforms: the layout of disintegrate.wgsl', () => {
  const wgsl = readFileSync(new URL('../disintegrate.wgsl', import.meta.url), 'utf8');
  const struct = /struct Uniforms \{([\s\S]*?)\n\}/.exec(wgsl)?.[1] ?? '';
  const floats = [...struct.matchAll(/: (f32|vec2<f32>|vec4<f32>)/g)].reduce((n, m) => n + (m[1] === 'f32' ? 1 : m[1] === 'vec2<f32>' ? 2 : 4), 0);
  assert.equal(floats, UNIFORM_FLOATS, 'the struct has as many floats as index.js writes');
  const data = new Float32Array(UNIFORM_FLOATS);
  fillUniforms(data, { width: 800, height: 400, cssWidth: 400, cssHeight: 200 }, readOptions({ sweep: 0, direction: 0 }), 0.5, { cell: 1.5, cols: 267 }, 1, 0.9, true);
  assert.deepEqual(Array.from(data.slice(0, 8)), [800, 400, 400, 200, 0.5, 1, 1.5, 267]);
  assert.deepEqual(Array.from(data.slice(8, 12)), [1, 0, 0, 400], 'the sweep: to the right, across 400 css px');
  assert.deepEqual([data[12], data[13]], [1, 0], 'wind direction 0: to the right');
  assert.equal(data[14], Math.fround(0.32 * 400));
  assert.deepEqual([data[16], data[18], data[19], data[21]], [Math.fround(0.9), Math.fround(SWEEP_END), LIFE, BG_CELL]);
  assert.ok(data[22] > 0 && data[23] > data[22], 'content thresholds');
  assert.equal(data[27], 1);
  assert.equal(data[28], 0, 'a play turns at full strength');
  fillUniforms(data, { width: 800, height: 400, cssWidth: 400, cssHeight: 200 }, readOptions({}), 0.5, { cell: 1.5, cols: 267 }, 1);
  assert.equal(data[28], 1, 'otherwise the dust fades as the transition ends gone');
});

/** A recording fake of the WebGPU objects the plugin touches. */
function fakeGpu() {
  const g = /** @type {any} */ (globalThis);
  g.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  g.GPUBufferUsage = { UNIFORM: 64, COPY_DST: 8, STORAGE: 128 };
  g.GPUTextureUsage = { TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
  const created = { bindGroup: 0, buffer: 0, texture: 0, pipeline: 0, submit: 0 };
  /** @type {any[]} */ const draws = [];
  /** @type {number} */ let estimates = 0;
  /** @type {any[]} */ const writes = [];
  const pass = { setPipeline() {}, setBindGroup() {}, draw: (/** @type {number[]} */ ...a) => draws.push(a), end() {} };
  const device = {
    createShaderModule: () => ({}), createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
    createRenderPipeline: () => { created.pipeline += 1; return {}; },
    createBuffer: (/** @type {any} */ d) => { created.buffer += 1; return { size: d.size, destroy() {} }; },
    createTexture: (/** @type {any} */ d) => { created.texture += 1; return { width: d.size[0], height: d.size[1], createView: () => ({}), destroy() {} }; },
    createSampler: () => ({}), createBindGroup: () => { created.bindGroup += 1; return {}; },
    queue: { writeBuffer: (/** @type {any} */ _b, /** @type {number} */ _o, /** @type {Float32Array} */ d) => writes.push(d), submit: () => { created.submit += 1; } },
  };
  const encoder = {
    beginRenderPass: (/** @type {any} */ d) => { if (d.depthStencilAttachment === undefined && d.colorAttachments[0].loadOp === 'clear' && d.timestampWrites === undefined && !('timestampWrites' in d)) estimates += 0.5; return pass; },
  };
  return { device, created, draws, writes, encoder, estimates: () => estimates };
}

/** @param {Record<string, unknown>} options */
async function instance(options) {
  const gpu = fakeGpu();
  const realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, text: async () => '// wgsl' }));
  const source = Object.assign(new EventTarget(), { invalid: false, querySelectorAll() { return this.invalid ? [{ localName: 'input' }] : []; } });
  const canvas = /** @type {any} */ ({ clientWidth: 400, clientHeight: 200, clientLeft: 0, clientTop: 0, getBoundingClientRect: () => ({ left: 0, top: 0 }), ownerDocument: { defaultView: { matchMedia: () => ({ matches: false }) } } });
  let renders = 0;
  const context = /** @type {any} */ ({ apiVersion: 2, device: gpu.device, format: 'bgra8unorm', canvas, source, requestRender: () => { renders += 1; }, listen: () => () => {}, viewport: () => ({}) });
  try {
    const inst = /** @type {any} */ (await plugin.create(context, { duration: 1000, durationIn: 1000, ...options }));
    const sourceTexture = { width: 800, height: 400 };
    const sourceView = {}, destinationView = {};   // the host keeps its views across frames
    const frame = (/** @type {number} */ now, version = 1) => ({ now, width: 800, height: 400, cssWidth: 400, cssHeight: 200, dpr: 2, sourceReady: true, sourceVersion: version, sourceTexture, sourceView, destinationView, encoder: gpu.encoder });
    return { inst, gpu, canvas, source, frame, requests: () => renders };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('instance: no GPU object per frame; nothing frozen; the background estimate when a transition starts, and again only when the page changes (at most every 250 ms)', async () => {
  const { inst, gpu, canvas, frame } = await instance({});
  inst.render(frame(0));
  const before = { ...gpu.created };
  for (let k = 1; k <= 50; k += 1) inst.render(frame(k * 8));
  assert.deepEqual(gpu.created, before, 'idle frames');
  assert.equal(gpu.estimates(), 0, 'idle: no estimate');
  trigger(canvas, 'play');
  assert.equal(gpu.created.submit, before.submit, 'no copy of the picture: the transition samples the live page');
  inst.render(frame(500));
  assert.equal(gpu.estimates(), 1, 'the estimate of the page when the transition starts');
  const afterFirst = { ...gpu.created };
  for (let k = 1; k <= 20; k += 1) inst.render(frame(500 + k * 8.33));
  assert.equal(gpu.estimates(), 1, 'the page did not change: the same estimate');
  inst.render(frame(700, 2));
  assert.equal(gpu.estimates(), 1, 'changed within 250 ms of the last estimate: not yet');
  inst.render(frame(760, 2));
  assert.equal(gpu.estimates(), 2, 'changed (a counter, typing): estimated again');
  for (let k = 1; k <= 300; k += 1) inst.render(frame(760 + k * 8.33, 2));
  assert.deepEqual(gpu.created, afterFirst, 'animating frames create nothing');
  assert.equal(new Set(gpu.writes.filter((w) => w.length === UNIFORM_FLOATS)).size, 1, 'one uniform array for every frame');
});

test('instance: identity mapper when assembled, blocked while it moves; continuous only while animating; the page then the dust drawn', async () => {
  const { inst, canvas, frame, gpu } = await instance({});
  inst.render(frame(0));
  assert.equal(inst.continuous, false);
  assert.equal(inst.captureInputMapper(frame(0)), identityMapper);
  const done = trigger(canvas, 'play');
  assert.equal(inst.continuous, true);
  inst.render(frame(10));
  assert.equal(inst.captureInputMapper(frame(10)), blockedMapper, 'g = 0 but the transition has started: blocked');
  inst.render(frame(300));
  const grid = dustGrid(400, 200, 1.5);
  assert.deepEqual(gpu.draws.slice(-2), [[3], [4, grid.count]], 'the page (full screen), then one grain (4-vertex strip) per dust cell');
  inst.render(frame(1010));
  inst.render(frame(1500));
  inst.render(frame(2100));
  assert.equal(inst.captureInputMapper(frame(2100)), identityMapper);
  assert.deepEqual(gpu.draws.at(-1), [3], 'assembled: the full-screen pass');
  assert.equal(await done, true);
  assert.equal(inst.continuous, false);
});

test('instance: the way out and the way back have their own lengths (play: out, no pause, in)', async () => {
  const { inst, canvas, frame } = await instance({ duration: 1000, durationIn: 400 });
  inst.render(frame(0));
  const done = trigger(canvas, 'play');
  inst.render(frame(100));            // the clock starts here
  inst.render(frame(1100));           // the way out ends: the way back starts at once
  inst.render(frame(1300));
  assert.equal(inst.captureInputMapper(frame(1300)), blockedMapper, 'half way back');
  inst.render(frame(1510));
  assert.equal(inst.captureInputMapper(frame(1510)), identityMapper, 'back after 400 ms');
  assert.equal(await done, true);
});

test('instance: the intro starts dissolved and waits for the first snapshot; state option and reduced motion', async () => {
  const intro = await instance({ intro: true });
  assert.equal(intro.inst.continuous, true);
  intro.inst.render({ ...intro.frame(0), sourceReady: false });
  intro.inst.render(intro.frame(5000));
  intro.inst.render(intro.frame(5500));
  assert.equal(intro.inst.captureInputMapper(intro.frame(5500)), blockedMapper);
  intro.inst.render(intro.frame(6100));
  assert.equal(intro.inst.captureInputMapper(intro.frame(6100)), identityMapper, 'the clock started at the first READY frame');
  const st = await instance({ intro: false });
  st.inst.render(st.frame(0));
  st.inst.setOptions({ duration: 1000, state: 'out' });
  st.inst.render(st.frame(10)); st.inst.render(st.frame(2000));
  assert.equal(st.inst.captureInputMapper(st.frame(2000)), blockedMapper, 'state out: dissolved and staying so');
  st.inst.setOptions({ duration: 1000, state: 'out', particleSize: 3 });
  assert.equal(st.inst.continuous, false, 'an unrelated option does not replay the state');
  const rm = await instance({ reducedMotion: true });
  rm.inst.render(rm.frame(0));
  trigger(rm.canvas, 'out');
  rm.inst.render(rm.frame(10)); rm.inst.render(rm.frame(500));
  assert.deepEqual(rm.gpu.draws.at(-1), [3], 'reduced motion: the page only (the content fades), no dust');
  assert.ok(rm.gpu.writes.at(-1)[5] < 1, 'the crossfade');
});

test('instance: submit wiring (valid only by default in the gallery), destroy resolves pending triggers', async () => {
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
