// Node tests of the disintegrate plugin (dust): the folder contract, the timeline, the timing invariants, the dust grid and the background
// estimate's size, the sweep, options, the uniform layout of disintegrate.wgsl, and a fake GPU: no GPU object per frame, nothing frozen
// (the live page is sampled), the background estimate made when a transition starts and again only when the page changes, the draws
// (the page, then one grain per dust cell), the mappers, the actions through the effect handle (plugins/_shared/node-host.mjs), submit
// wiring, reduced motion, destroy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractTest } from '../../_shared/contract-test.mjs';
import { readFileSync } from 'node:fs';
import { ACTIONS, BG_CELL, GLOW_COLOUR, GRAIN_BYTES, HOLD_MS, LIFE, MAX_GRAINS, NO_TARGET, SHUTTER_MS, SWEEP_END, TAKEOVER_MS, UNIFORM_FLOATS, WORKGROUP, blockedMapper, bgSize, createTimeline, dustGrid, fillUniforms, identityMapper, meta, parseColor, plugin, readOptions, sweepOf } from '../index.js';
import { nodeHandle } from '../../_shared/node-host.mjs';
import { findInvalid, sourcePointOnCanvas } from '../../_lib/transition.js';
import { isNoTarget } from '../../../src/effects/no-target.js';

contractTest(import.meta.url);

test('meta and the definition agree; the gallery defaults are valid options', () => {
  assert.equal(plugin.type, meta.name);
  assert.equal(plugin.apiVersion, 2);
  const o = readOptions(meta.defaults);
  assert.equal(o.onSubmit, 'valid');
  assert.equal(o.intro, true);
  assert.equal(o.duration, 1800, 'about 1.5 s of dust leaving plus the drift while no content is left');
  assert.equal(o.durationIn, 1200);
  assert.deepEqual([o.particleSize, o.depth, o.glow, o.focus, o.density], [1.25, 0.7, 0.65, 1, 1]);
  assert.deepEqual(o.glowColor, [...GLOW_COLOUR]);
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
  const d = readOptions({ depth: 5, glow: -2, glowColor: '#00ff00', focus: 9 });
  assert.deepEqual([d.depth, d.glow, d.focus], [1, 0, 2]);
  assert.deepEqual(d.glowColor, [0, 1, 0]);
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
  assert.equal(data[14], Math.fround(0.27 * 400));
  assert.deepEqual([data[16], data[18], data[19], data[21]], [Math.fround(0.9), Math.fround(SWEEP_END), LIFE, BG_CELL]);
  assert.ok(data[22] > 0 && data[23] > data[22], 'content thresholds');
  assert.equal(data[27], 1);
  assert.equal(data[28], 0, 'a play turns at full strength');
  assert.deepEqual([data[29], data[30], data[31]], [Math.fround(0.7), Math.fround(0.65), Math.fround(1.8 * 400)], 'depth, glow, the camera distance');
  assert.deepEqual(Array.from(data.slice(32, 36)), [...GLOW_COLOUR, 1].map(Math.fround), 'the colour of the heat, the defocus');
  fillUniforms(data, { width: 800, height: 400, cssWidth: 400, cssHeight: 200 }, readOptions({ duration: 2000 }), 0.5, { cell: 1.5, cols: 267, count: 36000 }, 1);
  assert.equal(data[28], 1, 'otherwise the dust fades as the transition ends gone');
  assert.equal(data[36], 36000, 'the dust cells (the compute threads that do work)');
  assert.equal(data[37], Math.fround(SHUTTER_MS / 2000), 'the exposure of the motion blur, in units of g: fixed in ms, so the same at every frame cap');
  assert.equal(data[38], 1, 'the share of cells that stay visible in flight');
  const wgsl2 = readFileSync(new URL('../disintegrate.wgsl', import.meta.url), 'utf8');
  assert.match(wgsl2, new RegExp(`@workgroup_size\\(${WORKGROUP}\\)`), 'the dispatch size of index.js is the workgroup of cs_grains');
  assert.match(wgsl2, /let base = i \* 6u;/, `a record is ${GRAIN_BYTES / 4} words`);
});

/** A recording fake of the WebGPU objects the plugin touches. */
function fakeGpu() {
  const g = /** @type {any} */ (globalThis);
  g.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  g.GPUBufferUsage = { UNIFORM: 64, COPY_DST: 8, STORAGE: 128, VERTEX: 32 };
  g.GPUTextureUsage = { TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
  const created = { bindGroup: 0, buffer: 0, texture: 0, pipeline: 0, submit: 0 };
  /** @type {any[]} */ const draws = [];
  /** @type {number} */ let estimates = 0;
  /** @type {any[]} */ const writes = [];
  /** @type {number[]} */ const dispatches = [];
  /** @type {any[]} */ const buffers = [];
  const pass = { setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, draw: (/** @type {number[]} */ ...a) => draws.push(a), end() {} };
  const computePass = { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups: (/** @type {number} */ n) => dispatches.push(n), end() {} };
  const device = {
    createShaderModule: () => ({}), createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
    createRenderPipeline: () => { created.pipeline += 1; return {}; },
    createComputePipeline: () => { created.pipeline += 1; return {}; },
    createBuffer: (/** @type {any} */ d) => { created.buffer += 1; const b = { size: d.size, usage: d.usage, destroyed: false, destroy() { b.destroyed = true; } }; buffers.push(b); return b; },
    createTexture: (/** @type {any} */ d) => { created.texture += 1; return { width: d.size[0], height: d.size[1], createView: () => ({}), destroy() {} }; },
    createSampler: () => ({}), createBindGroup: () => { created.bindGroup += 1; return {}; },
    queue: { writeBuffer: (/** @type {any} */ _b, /** @type {number} */ _o, /** @type {Float32Array} */ d) => writes.push(d), submit: () => { created.submit += 1; } },
  };
  const encoder = {
    beginRenderPass: (/** @type {any} */ d) => { if (d.depthStencilAttachment === undefined && d.colorAttachments[0].loadOp === 'clear' && d.timestampWrites === undefined && !('timestampWrites' in d)) estimates += 0.5; return pass; },
    beginComputePass: () => computePass,
  };
  return { device, created, draws, writes, encoder, dispatches, buffers, estimates: () => estimates };
}

/** The plugin behind the real effect handle, over the fake GPU. @param {Record<string, unknown>} options @param {{reducedMotion?: boolean}} [o] */
async function instance(options, { reducedMotion = false } = {}) {
  const gpu = fakeGpu();
  const realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, text: async () => '// wgsl' }));
  const source = Object.assign(new EventTarget(), { invalid: false, querySelectorAll() { return this.invalid ? [{ localName: 'input' }] : []; } });
  const canvas = /** @type {any} */ (Object.assign(new EventTarget(), { clientWidth: 400, clientHeight: 200, clientLeft: 0, clientTop: 0, getBoundingClientRect: () => ({ left: 0, top: 0 }), ownerDocument: { defaultView: { matchMedia: () => ({ matches: false }) } } }));
  try {
    const h = await nodeHandle(plugin, { duration: 1000, durationIn: 1000, ...options }, { device: gpu.device, canvas, source, reducedMotion });
    const inst = h.inst;
    const sourceTexture = { width: 800, height: 400 };
    const sourceView = {}, destinationView = {};   // the host keeps its views across frames
    const frame = (/** @type {number} */ now, version = 1) => ({ now, width: 800, height: 400, cssWidth: 400, cssHeight: 200, dpr: 2, sourceReady: true, sourceVersion: version, sourceTexture, sourceView, destinationView, encoder: gpu.encoder });
    return { inst, handle: h.handle, errors: h.errors, gpu, canvas, source, frame, requests: h.requests, press: (type = 'pointerdown') => canvas.dispatchEvent(new Event(type)) };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('instance: no GPU object per frame; nothing frozen; the background estimate when a transition starts, and again only when the page changes (at most every 250 ms)', async () => {
  const { inst, gpu, handle, frame } = await instance({});
  inst.render(frame(0));
  const before = { ...gpu.created };
  for (let k = 1; k <= 50; k += 1) inst.render(frame(k * 8));
  assert.deepEqual(gpu.created, before, 'idle frames');
  assert.equal(gpu.estimates(), 0, 'idle: no estimate');
  handle.trigger('play');
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
  const { inst, handle, frame, gpu } = await instance({});
  inst.render(frame(0));
  assert.equal(inst.continuous, false);
  assert.equal(inst.captureInputMapper(frame(0)), identityMapper);
  const done = handle.trigger('play');
  assert.equal(inst.continuous, true);
  inst.render(frame(10));
  assert.equal(inst.captureInputMapper(frame(10)), blockedMapper, 'g = 0 but the transition has started: blocked');
  inst.render(frame(300));
  const grid = dustGrid(400, 200, 1.25);
  assert.deepEqual(gpu.draws.slice(-2), [[3], [4, grid.count]], 'the page (full screen), then one grain (4-vertex strip) per dust cell');
  assert.equal(gpu.dispatches.at(-1), Math.ceil(grid.count / WORKGROUP), 'the grains of the frame: one compute thread per dust cell');
  const records = gpu.buffers.filter((b) => b.size === grid.count * GRAIN_BYTES);
  assert.equal(records.length, 1, 'one record buffer for the grid (storage for the compute pass, vertex buffer for the dust)');
  assert.equal(records[0].usage, 128 | 32);
  inst.render(frame(1010));
  inst.render(frame(1500));
  inst.render(frame(2100));
  assert.equal(inst.captureInputMapper(frame(2100)), identityMapper);
  assert.deepEqual(gpu.draws.at(-1), [3], 'assembled: the full-screen pass');
  assert.equal(await done, 'in', 'the play ends assembled');
  assert.equal(inst.continuous, false);
});

test('instance: the way out and the way back have their own lengths (play: out, no pause, in)', async () => {
  const { inst, handle, frame } = await instance({ duration: 1000, durationIn: 400 });
  inst.render(frame(0));
  const done = handle.trigger('play');
  inst.render(frame(100));            // the clock starts here
  inst.render(frame(1100));           // the way out ends: the way back starts at once
  inst.render(frame(1300));
  assert.equal(inst.captureInputMapper(frame(1300)), blockedMapper, 'half way back');
  inst.render(frame(1510));
  assert.equal(inst.captureInputMapper(frame(1510)), identityMapper, 'back after 400 ms');
  assert.equal(await done, 'in');
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
  rm.handle.trigger('out');
  rm.inst.render(rm.frame(10)); rm.inst.render(rm.frame(500));
  assert.deepEqual(rm.gpu.draws.at(-1), [3], 'reduced motion: the page only (the content fades), no dust');
  assert.ok(rm.gpu.writes.at(-1)[5] < 1, 'the crossfade');
});

test('instance: submit wiring (valid only by default in the gallery); a submit supersedes a pending trigger; removal resolves it null', async () => {
  const { inst, handle, source, frame, errors } = await instance({ onSubmit: 'valid' });
  inst.render(frame(0));
  /** @type {any[]} */ const runs = [];
  const run = inst.runAction;
  inst.runAction = (/** @type {any[]} */ ...a) => { runs.push(a); return run(...a); };   // what the host calls
  source.invalid = true;
  source.dispatchEvent(new Event('submit'));
  assert.equal(inst.continuous, false, 'an invalid form does not play');
  source.invalid = false;
  source.dispatchEvent(new Event('submit'));
  assert.equal(inst.continuous, true, 'a valid one plays');
  assert.deepEqual(runs.map((a) => [a[0], a[2]]), [['play', { reducedMotion: false }]], 'the submit plays through the host (context.trigger), like handle.trigger');
  const pageRun = handle.trigger('in');
  assert.equal(runs.length, 2);
  inst.render(frame(10)); inst.render(frame(2000));
  assert.equal(await pageRun, 'in', 'a page trigger supersedes the play of the submit');
  const pending = handle.trigger('out');
  handle.remove();
  assert.equal(await pending, null, 'removed: the pending trigger resolves null');
  await assert.rejects(handle.trigger('out'), /removed/);
  assert.equal(errors.length, 0);
  const again = await instance({});
  assert.deepEqual([...again.handle.actions], ['out', 'in', 'play', 'demo']);
  assert.deepEqual([...ACTIONS], [...(plugin.actions ?? [])]);
  await assert.rejects(again.handle.trigger('sideways'), /unknown action "sideways" of the plugin "disintegrate"; its actions are 'out', 'in', 'play', 'demo'/);
});

test('actions: out ends \'out\', in ends \'in\'; settled() waits for the end state, at once at rest; the host\'s reduced-motion reading crossfades', async () => {
  const { inst, handle, frame } = await instance({});
  inst.render(frame(0));
  assert.equal(await handle.settled(), 'in', 'at rest: at once');
  const out = handle.trigger('out');
  let rest = 'pending';
  handle.settled().then((v) => { rest = v; });
  inst.render(frame(10)); inst.render(frame(600));
  await Promise.resolve();
  assert.equal(rest, 'pending', 'still moving');
  inst.render(frame(1020));
  assert.equal(await out, 'out');
  await Promise.resolve();
  assert.equal(rest, 'out', 'settled() resolved with the frame that drew the end state');
  const back = handle.trigger('in');
  inst.render(frame(1100)); inst.render(frame(2200));
  assert.equal(await back, 'in');
  const calm = await instance({}, { reducedMotion: true });
  calm.inst.render(calm.frame(0));
  const fade = calm.handle.trigger('out');
  calm.inst.render(calm.frame(10)); calm.inst.render(calm.frame(500));
  assert.deepEqual(calm.gpu.draws.at(-1), [3], 'prefers-reduced-motion as the host read it: the page only, no dust');
  assert.ok(calm.gpu.writes.at(-1)[5] < 1, 'the crossfade');
  calm.inst.render(calm.frame(1100));
  assert.equal(await fade, 'out', 'the crossfade ends in the same state');
});

/** frames every 8.33 ms from `from` to `to` (ms) @param {any} it @param {number} from @param {number} to */
function run(it, from, to) { for (let now = from; now <= to; now += 8.33) it.inst.render(it.frame(now)); }
/** the promise chain of the host's handle settles */
const flush = () => new Promise((r) => setTimeout(r, 0));

test('demo: out and back in (a play), resolves with the state it rests in, then nothing moves: not continuous, no frame requested, no compute', async () => {
  const it = await instance({ duration: 1000, durationIn: 800 });
  it.inst.render(it.frame(0));
  let state = /** @type {any} */ ('pending');
  it.handle.trigger('demo').then((v) => { state = v; });
  assert.equal(it.inst.continuous, true);
  run(it, 10, 900);
  assert.equal(it.inst.captureInputMapper(it.frame(900)), blockedMapper, 'on its way out');
  assert.ok(it.gpu.dispatches.length > 50, 'the dust moved');
  run(it, 908, 1830);
  await flush();
  assert.equal(state, 'in', 'out (1000 ms) and back (800 ms): it rests assembled');
  assert.equal(it.inst.captureInputMapper(it.frame(1830)), identityMapper);
  // zero work at rest: the host renders only while a plugin is continuous or asks for a frame
  const asked = it.requests(), dispatched = it.gpu.dispatches.length;
  assert.equal(it.inst.continuous, false, 'at rest: not continuous');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(it.requests(), asked, 'at rest: no frame requested (no timer, no loop)');
  run(it, 1840, 4840);   // what the host would render if anything else asked
  assert.equal(it.gpu.dispatches.length, dispatched, 'at rest: no compute pass');
  assert.deepEqual(it.gpu.draws.at(-1), [3], 'at rest: the passthrough');
  assert.equal(it.requests(), asked);
});

test('demo: user input takes over at once: a press, a key, a submit or new options during it re-forms the page fast, from where the dust is; the demo resolves \'in\'', async () => {
  for (const type of ['pointerdown', 'keydown', 'submit', 'setOptions']) {
    const it = await instance({ duration: 2000, durationIn: 2000 });
    it.inst.render(it.frame(0));
    let state = /** @type {any} */ ('pending');
    it.handle.trigger('demo').then((v) => { state = v; });
    run(it, 10, 610);                                    // g = 0.3 on its way out
    const asked = it.requests();
    if (type === 'submit') it.source.dispatchEvent(new Event('submit'));
    else if (type === 'setOptions') it.handle.setOptions({ duration: 2000, durationIn: 2000, wind: 1.5 });
    else it.press(type);
    assert.ok(it.requests() > asked, `${type}: a frame is requested at once`);
    run(it, 618, 618 + TAKEOVER_MS * 0.3 + 20);         // the way back from g = 0.3 at TAKEOVER_MS per full run
    await flush();
    assert.equal(state, 'in', `${type}: re-formed within ${TAKEOVER_MS} ms x 0.3, not after the demo's 2 s way out and 2 s way back`);
    assert.equal(it.inst.captureInputMapper(it.frame(1000)), identityMapper, 'the form is usable again');
    assert.equal(it.inst.continuous, false);
  }
  // also on its way back: the remaining way is run faster
  const back = await instance({ duration: 400, durationIn: 4000 });
  back.inst.render(back.frame(0));
  let st = /** @type {any} */ ('pending');
  back.handle.trigger('demo').then((v) => { st = v; });
  run(back, 10, 1210);                                   // out in 400 ms, then 800 ms of the 4 s way back: g = 0.8
  back.press();
  run(back, 1218, 1218 + TAKEOVER_MS * 0.8 + 20);
  await flush();
  assert.equal(st, 'in');
});

test('play (not a demo) ignores user input; a press at rest does nothing; reduced motion: the demo resolves at once and nothing moves', async () => {
  const it = await instance({ duration: 1000, durationIn: 1000 });
  it.inst.render(it.frame(0));
  const asked0 = it.requests();
  it.press();
  assert.equal(it.requests(), asked0, 'at rest a press asks for nothing');
  let state = /** @type {any} */ ('pending');
  it.handle.trigger('play').then((v) => { state = v; });
  run(it, 10, 310);
  it.press();
  run(it, 318, 900);
  await flush();
  assert.equal(state, 'pending', 'a play is not interrupted by a press: it is the page\'s transition (the press is swallowed)');
  run(it, 908, 2100);
  await flush();
  assert.equal(state, 'in');
  const calm = await instance({}, { reducedMotion: true });
  calm.inst.render(calm.frame(0));
  const asked = calm.requests();
  assert.equal(await calm.handle.trigger('demo'), 'in', 'resolves at once with the state at rest');
  assert.equal(calm.inst.continuous, false, 'nothing moves');
  assert.ok(calm.requests() <= asked + 1, 'no frame requested by the plugin (the host asks for one at every trigger)');
  calm.inst.render(calm.frame(10));
  assert.deepEqual(calm.gpu.draws.at(-1), [3], 'the passthrough: the page as it was');
  assert.equal(calm.gpu.dispatches.length, 0, 'no grain computed');
});
