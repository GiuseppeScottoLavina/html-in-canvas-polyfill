// Node tests of the template plugin: the folder contract, the mapper formula, what render() submits (with a recording fake GPU), and its
// action through the real effect handle (plugins/_shared/node-host.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractTest } from '../../_shared/contract-test.mjs';
import { mapOffsetPoint, meta, plugin } from '../index.js';
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
  const context = { device, format: 'bgra8unorm', requestRender() {} };
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
  assert.deepEqual([...handle.actions], ['shift']);
  assert.equal(await handle.settled(), 'still');
  await assert.rejects(handle.trigger('slide'), /its actions are 'shift'/);
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
