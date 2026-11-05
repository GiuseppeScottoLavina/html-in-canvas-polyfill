// Node tests of the template plugin: the folder contract, the mapper formula, what render() submits (with a recording fake GPU), and its
// actions through the real effect handle (plugins/_shared/node-host.mjs): shift, and the demo (contract 2: it ends at rest, input takes
// over, reduced motion resolves at once; contract 3: no frame is requested once it ended).
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractTest } from '../../_shared/contract-test.mjs';
import { DEMO_MS, DEMO_SWING, demoOffset, mapOffsetPoint, meta, plugin } from '../index.js';
import { nodeHandle } from '../../_shared/node-host.mjs';

contractTest(import.meta.url);

test('meta and the definition agree', () => {
  assert.equal(plugin.type, meta.name);
  assert.equal(plugin.apiVersion, 2);
});

test('the mapper shifts back by the offset and never leaves the canvas', () => {
  assert.deepEqual(mapOffsetPoint(24, { x: 100, y: 50, width: 400, height: 200 }), { x: 76, y: 50 });
  assert.deepEqual(mapOffsetPoint(24, { x: 10, y: 50, width: 400, height: 200 }), { x: 0, y: 50 });
});

test('a mapper keeps the offset of its own frame after setOptions and later renders', async (t) => {
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  const writes = [];
  const device = {
    createShaderModule: () => ({}), createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }), createBuffer: () => ({ destroy() {} }),
    createSampler: () => ({}), createBindGroup: () => ({}), queue: { writeBuffer: (_b, _o, d) => writes.push(Array.from(d)) },
  };
  const encoder = { beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }) };
  const context = { device, format: 'bgra8unorm', requestRender() {}, listen: () => () => {} };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => '// wgsl' }); // source mode loads offset.wgsl; Node has no server
  t.after(() => { globalThis.fetch = realFetch; });
  const instance = await plugin.create(/** @type {any} */ (context), { offset: 30 });
  const frame = { width: 800, height: 400, cssWidth: 400, cssHeight: 200, sourceReady: true, sourceView: {}, destinationView: {}, encoder };
  instance.render(/** @type {any} */ (frame));
  assert.deepEqual(writes.at(-1), [800, 400, 400, 30]);
  const first = instance.captureInputMapper(/** @type {any} */ (frame));
  instance.setOptions({ offset: 5 });
  instance.render(/** @type {any} */ (frame));
  assert.equal(first({ x: 100, y: 0, width: 400, height: 200 }).x, 70, 'still the offset of the frame it was captured for');
  assert.equal(instance.captureInputMapper(/** @type {any} */ (frame))({ x: 100, y: 0, width: 400, height: 200 }).x, 95);
});

test('the action shift, through the effect handle: it moves the picture and resolves \'still\' with the frame that shows it; superseded or removed: null', async (t) => {
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  const writes = [];
  const device = {
    createShaderModule: () => ({}), createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }), createBuffer: () => ({ destroy() {} }),
    createSampler: () => ({}), createBindGroup: () => ({}), queue: { writeBuffer: (_b, _o, d) => writes.push(Array.from(d)) },
  };
  const encoder = { beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }) };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => '// wgsl' });
  t.after(() => { globalThis.fetch = realFetch; });
  const { handle, inst } = await nodeHandle(plugin, { offset: 10 }, { device, canvas: new EventTarget(), source: {} });
  const frame = { width: 800, height: 400, cssWidth: 400, cssHeight: 200, sourceReady: true, sourceView: {}, destinationView: {}, encoder };
  inst.render(frame);
  assert.deepEqual([...handle.actions], ['shift', 'demo']);
  assert.equal(await handle.settled(), 'still');
  await assert.rejects(handle.trigger('slide'), /its actions are 'shift', 'demo'/);
  const older = handle.trigger('shift', { offset: 40 });
  const newer = handle.trigger('shift', { offset: 60 });
  assert.equal(await older, null, 'superseded by the newer trigger');
  inst.render(frame);
  assert.deepEqual(writes.at(-1), [800, 400, 400, 60]);
  assert.equal(await newer, 'still');
  const pending = handle.trigger('shift', { offset: 5 });
  handle.remove();
  assert.equal(await pending, null);
});

/** a fake GPU device that records the uniform writes, and a frame factory */
function fakeGpu() {
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  const writes = [];
  const device = {
    createShaderModule: () => ({}), createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }), createBuffer: () => ({ destroy() {} }),
    createSampler: () => ({}), createBindGroup: () => ({}), queue: { writeBuffer: (_b, _o, d) => writes.push(Array.from(d)) },
  };
  const encoder = { beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }) };
  const frame = (now) => ({ now, width: 800, height: 400, cssWidth: 400, cssHeight: 200, sourceReady: true, sourceView: {}, destinationView: {}, encoder });
  return { device, writes, frame };
}
/** @param {any} t */
const stubFetch = (t) => { const real = globalThis.fetch; globalThis.fetch = async () => ({ ok: true, text: async () => '// wgsl' }); t.after(() => { globalThis.fetch = real; }); };

test('demoOffset: out and back, at rest at both ends, the swing at the middle, clamped', () => {
  assert.equal(demoOffset(24, 0), 24);
  assert.equal(demoOffset(24, DEMO_MS), 24);
  assert.equal(demoOffset(24, DEMO_MS * 2), 24, 'after the end it stays at rest');
  assert.equal(demoOffset(24, DEMO_MS / 2), 24 + DEMO_SWING);
  assert.equal(demoOffset(190, DEMO_MS / 2), 200, 'never beyond the largest offset');
  assert.ok(DEMO_MS <= 4000, 'a demo lasts at most about 4 s');
});

test('the demo, through the effect handle: it moves, ends at rest with \'still\', and no frame is requested after it ended (zero work at rest)', async (t) => {
  const { device, writes, frame } = fakeGpu();
  stubFetch(t);
  const k = await nodeHandle(plugin, { offset: 10 }, { device, canvas: new EventTarget(), source: {} });
  k.inst.render(frame(0));
  let state;
  const run = k.handle.trigger('demo').then((s) => { state = s; });
  const before = k.requests();
  const shown = [];
  for (let now = 1000; now <= 1000 + DEMO_MS + 40 && state === undefined; now += 16) {
    k.inst.render(frame(now));
    shown.push(writes.at(-1)[3]);
    await Promise.resolve(); await Promise.resolve();
  }
  await run;
  assert.equal(state, 'still');
  assert.ok(Math.max(...shown) > 10 + DEMO_SWING * 0.9, `the picture swung out (${Math.max(...shown)})`);
  assert.equal(shown.at(-1), 10, 'the last frame shows the offset at rest');
  assert.ok(k.requests() - before > DEMO_MS / 16 - 5, 'a frame was requested while it moved');
  const atRest = k.requests();
  k.inst.render(frame(5000));
  assert.equal(k.requests(), atRest, 'a frame at rest requests no other');
  assert.equal(await k.handle.settled(), 'still');
});

test('the demo: user input takes over at once (setOptions, a press on the picture); a newer trigger supersedes it', async (t) => {
  const { device, writes, frame } = fakeGpu();
  stubFetch(t);
  const canvas = new EventTarget();
  const k = await nodeHandle(plugin, { offset: 10 }, { device, canvas, source: {} });
  k.inst.render(frame(0));
  const a = k.handle.trigger('demo');
  k.inst.render(frame(100)); k.inst.render(frame(600));
  assert.ok(writes.at(-1)[3] > 10, 'it is moving');
  k.handle.setOptions({ offset: 30 });
  k.inst.render(frame(616));
  assert.equal(writes.at(-1)[3], 30, 'the next frame shows the user\'s offset, not the demo');
  assert.equal(await a, 'still');
  const b = k.handle.trigger('demo');
  k.inst.render(frame(700)); k.inst.render(frame(1200));
  canvas.dispatchEvent(new Event('pointerdown'));
  k.inst.render(frame(1216));
  assert.equal(writes.at(-1)[3], 30, 'a press ends the demo where the picture rests');
  assert.equal(await b, 'still');
  const c = k.handle.trigger('demo');
  const d = k.handle.trigger('shift', { offset: 50 });
  k.inst.render(frame(1300));
  assert.equal(await c, null, 'superseded');
  assert.equal(await d, 'still');
  assert.equal(writes.at(-1)[3], 50);
});

test('the demo under prefers-reduced-motion: nothing moves and it resolves with the state at rest', async (t) => {
  const { device, writes, frame } = fakeGpu();
  stubFetch(t);
  const k = await nodeHandle(plugin, { offset: 10 }, { device, canvas: new EventTarget(), source: {}, reducedMotion: true });
  k.inst.render(frame(0));
  assert.equal(await k.handle.trigger('demo'), 'still', 'resolved at once, without another frame');
  const before = k.requests();
  k.inst.render(frame(100));
  assert.equal(writes.at(-1)[3], 10, 'the picture did not move');
  assert.equal(k.requests(), before, 'and the frame requests no other');
});
