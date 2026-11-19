// Every pipeline of the effects is compiled off the main thread where the browser can. Safari on an iPad compiles a pipeline it has not
// seen in about half a second, one after the other; a pipeline made with the synchronous createRenderPipeline is compiled at its first use,
// on the main thread, and the page froze for the whole compilation (3 s for disintegrate, 1.6 s for page-curl, 0.4 s for crt, measured on
// 1.0.0). With createRenderPipelineAsync awaited in create(), the same compilation is a wait of addPlugin and the page keeps running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePipeline, fullscreenPass, renderPipeline } from '../../../plugins/_lib/gpu.js';
import { createPresenter } from '../../../src/effects/gpu-presenter.js';
import { plugin as crt } from '../../../plugins/crt/index.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../..');

/**
 * The lines of `source` that make a pipeline with the synchronous call, other than the fallback of a ternary on the async one
 * (`device.createRenderPipelineAsync ? device.createRenderPipelineAsync(d) : device.createRenderPipeline(d)`). @param {string} source
 */
export function syncPipelineCalls(source) {
  return source.split('\n').flatMap((line, i) => (/\bcreate(Render|Compute)Pipeline\s*\(/.test(line) && !/\bcreate(Render|Compute)PipelineAsync\s*\?/.test(line) ? [i + 1] : []));
}

/** @param {string} dir @returns {string[]} */
const jsFiles = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  if (statSync(p).isDirectory()) return n === 'test' || n === 'node_modules' ? [] : jsFiles(p);
  return /\.m?js$/.test(n) ? [p] : [];
});

test('the scan finds a synchronous pipeline, and accepts the async call and its fallback (positive controls)', () => {
  assert.deepEqual(syncPipelineCalls('const p = device.createRenderPipeline({ layout });'), [1]);
  assert.deepEqual(syncPipelineCalls('a\nconst c = device.createComputePipeline({ layout });'), [2]);
  assert.deepEqual(syncPipelineCalls('const p = await device.createRenderPipelineAsync({ layout });'), []);
  assert.deepEqual(syncPipelineCalls('return device.createRenderPipelineAsync ? device.createRenderPipelineAsync(d) : Promise.resolve(device.createRenderPipeline(d));'), []);
  assert.deepEqual(syncPipelineCalls('// the synchronous createRenderPipeline would freeze the page'), [], 'a mention without a call');
  // the shapes 1.0.0 had: each is reported
  assert.equal(syncPipelineCalls("const pipe = (o) => device.createRenderPipeline({ primitive: { topology: 'triangle-list' }, ...o });").length, 1);
  assert.equal(syncPipelineCalls('  return device.createRenderPipeline({').length, 1);
});

test('no file of the effects, the plugins or the guide\'s plugin makes a pipeline with the synchronous call', () => {
  const files = [...jsFiles(join(ROOT, 'src')), ...jsFiles(join(ROOT, 'plugins')), join(ROOT, 'test/examples-smoke/wobble-plugin/wobble-plugin.js')];
  const rel = (/** @type {string} */ f) => relative(ROOT, f).split(sep).join('/');   // the same on Windows
  assert.ok(files.some((f) => rel(f) === 'plugins/disintegrate/index.js') && files.some((f) => rel(f) === 'src/effects/gpu-presenter.js'), 'the scan reaches the plugins and the presenter');
  const found = files.flatMap((f) => syncPipelineCalls(readFileSync(f, 'utf8')).map((line) => `${rel(f)}:${line}`));
  assert.deepEqual(found, []);
});

/** A device that records which pipeline calls are made; `async`: whether it has the async members. @param {boolean} async */
function recordingDevice(async) {
  const calls = /** @type {string[]} */ ([]);
  const pipeline = { getBindGroupLayout: () => ({}) };
  /** @type {any} */ const device = {
    createRenderPipeline: () => { calls.push('render'); return pipeline; },
    createComputePipeline: () => { calls.push('compute'); return pipeline; },
    createShaderModule: () => ({}),
    createBuffer: () => ({ destroy() {} }),
    createSampler: () => ({}),
    createBindGroup: () => ({}),
    queue: { writeBuffer() {}, submit() {} },
  };
  if (async) {
    device.createRenderPipelineAsync = async () => { calls.push('render-async'); return pipeline; };
    device.createComputePipelineAsync = async () => { calls.push('compute-async'); return pipeline; };
  }
  return { device, calls, pipeline };
}

test('renderPipeline and computePipeline use the async call where the device has it, the synchronous one otherwise', async () => {
  const withAsync = recordingDevice(true);
  assert.equal(await renderPipeline(withAsync.device, {}), withAsync.pipeline);
  assert.equal(await computePipeline(withAsync.device, {}), withAsync.pipeline);
  assert.deepEqual(withAsync.calls, ['render-async', 'compute-async']);
  const without = recordingDevice(false);
  assert.equal(await renderPipeline(without.device, {}), without.pipeline);
  assert.equal(await computePipeline(without.device, {}), without.pipeline);
  assert.deepEqual(without.calls, ['render', 'compute']);
});

test('fullscreenPass and a plugin built on it (crt) compile their pipeline with the async call', async () => {
  const g = recordingDevice(true);
  const usage = { UNIFORM: 64, COPY_DST: 8 };
  const G = /** @type {any} */ (globalThis);
  const had = G.GPUBufferUsage, realFetch = G.fetch;
  G.GPUBufferUsage = usage;
  G.fetch = async () => ({ ok: true, text: async () => '// wgsl' });   // the source plugin loads its .wgsl (the built one has it inlined)
  try {
    const pass = await fullscreenPass(g.device, 'bgra8unorm', {}, 'probe', 4);
    assert.ok(pass.uniforms && typeof pass.draw === 'function');
    assert.deepEqual(g.calls, ['render-async']);
    const c = recordingDevice(true);
    const canvas = { ownerDocument: null, width: 300, height: 150 };
    const instance = await crt.create(/** @type {any} */ ({ device: c.device, format: 'bgra8unorm', canvas, source: {}, hdr: false, trigger() {}, requestFrame() {} }), {});
    assert.ok(instance && typeof instance.render === 'function');
    assert.deepEqual(c.calls, ['render-async'], 'crt made no pipeline with the synchronous call');
  } finally {
    G.GPUBufferUsage = had;
    G.fetch = realFetch;
  }
});

test('the presenter compiles the passthrough with the async call before it resolves, and renders it with no pipeline made later', async () => {
  const g = recordingDevice(true);
  const textures = [];
  Object.assign(g.device, {
    limits: { maxTextureDimension2D: 8192 }, lost: new Promise(() => {}), addEventListener() {}, destroy() {},
    createTexture: ({ size }) => { const t = { width: size[0], height: size[1], destroy() {}, createView: () => ({}) }; textures.push(t); return t; },
    createCommandEncoder: () => ({ beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }), copyTextureToTexture() {}, finish: () => ({}) }),
  });
  const canvasTexture = { createView: () => ({}) };
  const context = { configure() {}, unconfigure() {}, getCurrentTexture: () => canvasTexture };
  const win = {
    navigator: { gpu: { requestAdapter: async () => ({ requestDevice: async () => g.device }), getPreferredCanvasFormat: () => 'bgra8unorm' } },
    GPUTextureUsage: { RENDER_ATTACHMENT: 16, COPY_DST: 2, COPY_SRC: 1, TEXTURE_BINDING: 4 },
    devicePixelRatio: 1,
  };
  const canvas = { ownerDocument: { defaultView: win }, getContext: () => context, width: 300, height: 150, clientWidth: 320, clientHeight: 200 };
  const p = await createPresenter(/** @type {any} */ (canvas), {});
  assert.deepEqual(g.calls, ['render-async'], 'compiled while createPresenter was pending');
  p.syncSize();
  p.renderChain([], { time: 0, delta: 0 });
  assert.deepEqual(g.calls, ['render-async'], 'the passthrough frame made no pipeline of its own');
});
