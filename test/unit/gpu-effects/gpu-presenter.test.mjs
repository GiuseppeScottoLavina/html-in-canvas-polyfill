// The presenter's intermediate textures follow the chain: one per stage that writes before the canvas, at most two (ping-pong), none for a single stage that renders into
// the canvas. A recording stand-in device (no GPU needed) counts the textures made and destroyed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPresenter } from '../../../src/effects/gpu-presenter.js';

function fakeGpu() {
  /** @type {{label: string, width: number, height: number, destroyed: boolean}[]} */
  const textures = [];
  const device = {
    limits: { maxTextureDimension2D: 8192 },
    lost: new Promise(() => {}),
    addEventListener() {},
    createTexture({ label, size }) {
      const t = { label, width: size[0], height: size[1], destroyed: false, destroy() { t.destroyed = true; }, createView: () => ({ of: t }) };
      textures.push(t);
      return t;
    },
    createCommandEncoder: () => ({ copyTextureToTexture() {}, finish: () => ({}) }),
    createShaderModule: () => ({}),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createSampler: () => ({}),
    createBindGroup: () => ({}),
    queue: { submit() {} },
    destroy() {},
  };
  const canvasTexture = { label: 'canvas', destroyed: false, createView: () => ({ of: canvasTexture }) };
  const context = { configure() {}, unconfigure() {}, getCurrentTexture: () => canvasTexture };
  const win = {
    navigator: { gpu: { requestAdapter: async () => ({ requestDevice: async () => device }), getPreferredCanvasFormat: () => 'bgra8unorm' } },
    GPUTextureUsage: { RENDER_ATTACHMENT: 16, COPY_DST: 2, COPY_SRC: 1, TEXTURE_BINDING: 4 },
    devicePixelRatio: 1,
  };
  const css = { width: 320, height: 200 };
  const canvas = { ownerDocument: { defaultView: win }, getContext: () => context, width: 300, height: 150, get clientWidth() { return css.width; }, get clientHeight() { return css.height; } };
  const mids = () => textures.filter((t) => /^hic-mid/.test(t.label) && !t.destroyed);
  const made = () => textures.filter((t) => /^hic-mid/.test(t.label)).length;
  return { canvas, css, mids, made };
}

/** @param {boolean[]} direct per stage, its directCanvasRenderAttachment @param {Array<[any, any]>} log (source, destination) per render */
const chain = (direct, log) => direct.map((d) => ({
  def: { outputCapabilities: { directCanvasRenderAttachment: d } },
  instance: { render: (/** @type {any} */ f) => log.push([f.sourceTexture, f.destinationTexture]) },
}));

test('intermediate textures: as many as the chain writes before the canvas (0, 1 or 2), kept across frames, refitted when the chain or the size changes', async () => {
  const g = fakeGpu();
  const p = await createPresenter(/** @type {any} */ (g.canvas), {});
  const cases = [
    { direct: [false], need: 1 }, // one stage that cannot render into the canvas: its output is copied
    { direct: [true, true], need: 1 }, // two stages, the last one renders into the canvas
    { direct: [false, false], need: 2 }, // positive control: two stages that both write a target need the ping-pong pair
    { direct: [true, true, true], need: 2 },
    { direct: [true], need: 0 }, // a single stage that renders into the canvas
    { direct: [false], need: 1 },
  ];
  for (const { direct, need } of cases) {
    const log = [];
    const stages = chain(direct, log);
    assert.equal(p.renderChain(stages, /** @type {any} */ ({})), null);
    const made = g.made();
    for (let i = 0; i < 3; i++) assert.equal(p.renderChain(stages, /** @type {any} */ ({})), null);
    assert.equal(g.mids().length, need, `${direct.length} stage(s), last ${direct.at(-1) ? 'direct' : 'not direct'}: ${need} intermediate texture(s)`);
    assert.equal(g.made(), made, 'no texture made while the chain is unchanged');
    for (const [src, dst] of log) assert.notEqual(src, dst, 'no stage reads the texture it writes');
    assert.ok(g.mids().every((t) => t.width === 320 && t.height === 200), 'full size');
  }
  // a resize drops the targets and the next frame makes them at the new size
  g.css.width = 640;
  assert.equal(p.syncSize(), true);
  assert.equal(g.mids().length, 0);
  p.renderChain(chain([false, false], []), /** @type {any} */ ({}));
  assert.deepEqual(g.mids().map((t) => t.width), [640, 640]);
  p.dispose();
  assert.equal(g.mids().length, 0, 'dispose destroys them');
});
