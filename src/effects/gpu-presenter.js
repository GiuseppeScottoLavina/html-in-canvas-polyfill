/**
 * WebGPU device, canvas context, source/ping-pong textures, one submit per frame.
 * Module: gpu-effects (src/effects/**).
 */

import { HicUnsupportedError, invalidState } from '../contracts/errors.js';
import { withV1Fields } from './plugin-abi.js';

/** @typedef {import('../contracts/types.js').EffectHostOptions} EffectHostOptions */
/** @typedef {import('../contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../contracts/types.js').EffectPluginInstance} EffectPluginInstance */
/** @typedef {import('../contracts/types.js').EffectPresentationFrame} EffectPresentationFrame */
/** @typedef {import('../contracts/types.js').EffectViewport} EffectViewport */
/** @typedef {import('../contracts/types.js').SourceProvider} SourceProvider */

/** @typedef {{instance: EffectPluginInstance, def: EffectPluginDefinition, slot?: any}} ChainStage */

/**
 * @typedef {Object} PresenterHooks
 * @property {() => {width: number, height: number}} [cssSize]  canvas content box, css px (default: clientWidth/clientHeight)
 * @property {() => number} [devicePixelRatio]
 * @property {(info: {reason: string, message: string}) => void} [onLost]  the device was lost (not called after dispose())
 * @property {(error: unknown) => void} [onError]  uncaptured GPU error
 * @property {number} [extraCanvasUsage]  GPUTextureUsage bits added to the canvas configuration (tests add COPY_SRC for readback)
 */

/**
 * @typedef {Object} Presenter
 * @property {any} adapter @property {any} device @property {string} format
 * @property {any} context  the GPUCanvasContext
 * @property {() => EffectViewport} viewport
 * @property {() => boolean} syncSize  apply css size * min(dpr, maxDpr) to the canvas backing store; true when it changed (the bitmap was cleared: render now)
 * @property {(provider: SourceProvider) => number} uploadSource  returns the version uploaded (0 = nothing to upload yet)
 * @property {() => boolean} sourceReady
 * @property {(plugins: ChainStage[], frame: EffectPresentationFrame) => ({plugin: ChainStage, error: unknown, acquired: boolean}|null)} renderChain  null = submitted; otherwise the plugin whose render() threw and NOTHING was submitted. `acquired`: the canvas texture of this frame was already taken (then the canvas would present an empty frame unless something is drawn again)
 * @property {(keepContext?: boolean) => void} dispose  keepContext: do not unconfigure the canvas (a replacement presenter already configured it)
 */

/** Same dark blue as the water pass clear, so a plugin-less passthrough looks like the water without ripples. */
const CLEAR = { r: 0.004, g: 0.018, b: 0.034, a: 1 };

const PASSTHROUGH_WGSL = /* wgsl */ `
@group(0) @binding(0) var s : sampler;
@group(0) @binding(1) var tx : texture_2d<f32>;
struct V { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> }
@vertex fn vs(@builtin(vertex_index) i : u32) -> V {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var o : V;
  o.pos = vec4<f32>(p[i], 0.0, 1.0);
  o.uv = vec2<f32>((p[i].x + 1.0) * 0.5, (1.0 - p[i].y) * 0.5);
  return o;
}
@fragment fn fs(v : V) -> @location(0) vec4<f32> {
  let c = textureSample(tx, s, v.uv);
  return vec4<f32>(mix(vec3<f32>(${CLEAR.r}, ${CLEAR.g}, ${CLEAR.b}), c.rgb, c.a), 1.0);
}`;

/**
 * @param {string} message
 * @returns {HicUnsupportedError}
 */
function noWebGpu(message) {
  return new HicUnsupportedError('effect-plugins', message, { hint: 'Keep the 2D drawElementImage path (draw the source on a 2D canvas) when createHost rejects.' });
}

/**
 * Acquire adapter/device (options.powerPreference), configure canvas.getContext("webgpu") (InvalidStateError on a conflicting context), size the canvas to css*min(dpr,maxDpr). Rejects HicUnsupportedError("effect-plugins") without WebGPU.
 * @param {HTMLCanvasElement} canvas
 * @param {EffectHostOptions} options
 * @param {PresenterHooks} [hooks]
 * @returns {Promise<Presenter>}
 */
export async function createPresenter(canvas, options, hooks = {}) {
  const win = /** @type {any} */ (canvas.ownerDocument.defaultView ?? globalThis);
  const gpu = win.navigator?.gpu;
  if (!gpu) throw noWebGpu('WebGPU is not available in this browser, so effect plugins cannot run');
  const context = /** @type {any} */ (canvas.getContext('webgpu'));
  if (!context) throw invalidState('canvas-context-conflict: the canvas already has another context type; effects need a canvas without a 2D/WebGL context');
  const adapter = await gpu.requestAdapter(options.powerPreference ? { powerPreference: options.powerPreference } : undefined);
  if (!adapter) throw noWebGpu('WebGPU is present but no adapter was returned');
  const device = await adapter.requestDevice();
  const format = gpu.getPreferredCanvasFormat();
  const USAGE = win.GPUTextureUsage;
  context.configure({ device, format, alphaMode: 'opaque', usage: USAGE.RENDER_ATTACHMENT | USAGE.COPY_DST | (hooks.extraCanvasUsage ?? 0) });

  let disposed = false;
  /** @type {EffectViewport} */
  let vp = { width: 1, height: 1, cssWidth: 1, cssHeight: 1, dpr: 1 };
  let ready = false;
  const mid = /** @type {{texture: any, view: any}[]} */ ([]);
  let src = makeSource(1, 1);
  /** @type {{stage: ChainStage, pipeline: any, sampler: any, groups: WeakMap<object, any>}|null} */
  let pass = null;

  device.lost.then((/** @type {{reason: string, message: string}} */ info) => { if (!disposed) hooks.onLost?.(info); });
  device.addEventListener('uncapturederror', (/** @type {any} */ e) => { if (!disposed) hooks.onError?.(e.error); });

  /** @param {number} w @param {number} h */
  function makeSource(w, h) {
    const texture = device.createTexture({ label: 'hic-source', size: [w, h], format: 'rgba8unorm', usage: USAGE.TEXTURE_BINDING | USAGE.COPY_DST | USAGE.RENDER_ATTACHMENT });
    return { texture, view: texture.createView() };
  }

  function dropMid() {
    for (const m of mid) m.texture.destroy();
    mid.length = 0;
  }

  /** Two same-format targets for chains of more than one stage, or a last stage that cannot render into the canvas. */
  function ensureMid() {
    if (mid.length === 2) return;
    for (let i = 0; i < 2; i += 1) {
      const texture = device.createTexture({ label: `hic-mid-${i}`, size: [vp.width, vp.height], format, usage: USAGE.RENDER_ATTACHMENT | USAGE.TEXTURE_BINDING | USAGE.COPY_SRC });
      mid.push({ texture, view: texture.createView() });
    }
  }

  function passthroughStage() {
    if (pass) return pass.stage;
    const module = device.createShaderModule({ label: 'hic-passthrough', code: PASSTHROUGH_WGSL });
    const pipeline = device.createRenderPipeline({
      label: 'hic-passthrough', layout: 'auto',
      vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] }, primitive: { topology: 'triangle-list' },
    });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const groups = new WeakMap();
    /** @type {EffectPluginInstance} */
    const instance = {
      render(frame) {
        let group = groups.get(frame.sourceView);
        if (!group) {
          group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: sampler }, { binding: 1, resource: frame.sourceView }] });
          groups.set(frame.sourceView, group);
        }
        const p = frame.encoder.beginRenderPass({ colorAttachments: [{ view: frame.destinationView, loadOp: 'clear', storeOp: 'store', clearValue: CLEAR }] });
        p.setPipeline(pipeline); p.setBindGroup(0, group); p.draw(3); p.end();
      },
    };
    const def = /** @type {EffectPluginDefinition} */ ({ type: 'passthrough', apiVersion: 2, version: 1, outputCapabilities: { directCanvasRenderAttachment: true }, create: () => instance });
    pass = { stage: { instance, def }, pipeline, sampler, groups };
    return pass.stage;
  }

  /** @type {Presenter} */
  const presenter = {
    adapter, device, format, context,
    viewport: () => vp,
    syncSize() {
      const css = hooks.cssSize?.() ?? { width: canvas.clientWidth, height: canvas.clientHeight };
      const dpr = hooks.devicePixelRatio?.() ?? (win.devicePixelRatio || 1);
      let scale = Math.max(0.25, Math.min(dpr, options.maxDpr ?? 2.5));
      const maxDim = device.limits.maxTextureDimension2D;
      scale = Math.min(scale, maxDim / Math.max(1, css.width, css.height));
      const w = Math.max(1, Math.round(css.width * scale));
      const h = Math.max(1, Math.round(css.height * scale));
      const changed = canvas.width !== w || canvas.height !== h;
      if (changed) { canvas.width = w; canvas.height = h; dropMid(); }
      vp = { width: w, height: h, cssWidth: css.width, cssHeight: css.height, dpr: css.width > 0 ? w / css.width : scale };
      return changed;
    },
    sourceReady: () => ready,
    uploadSource(provider) {
      const size = provider.size();
      if (!size) return 0;
      if (src.texture.width !== size.width || src.texture.height !== size.height) {
        src.texture.destroy();
        src = makeSource(size.width, size.height);
      }
      const version = provider.upload(device, src.texture, true);
      ready = version !== 0;
      return version;
    },
    renderChain(plugins, frame) {
      const stages = plugins.length > 0 ? plugins : [passthroughStage()];
      const last = stages[stages.length - 1];
      const lastDirect = last.def.outputCapabilities?.directCanvasRenderAttachment === true;
      if (stages.length > 1 || !lastDirect) ensureMid();
      const encoder = device.createCommandEncoder();
      let input = src;
      let inputReady = ready;
      /** @type {any} */ let canvasTexture = null;
      for (let i = 0; i < stages.length; i += 1) {
        const stage = stages[i];
        let out = mid[i % 2];
        if (i === stages.length - 1 && lastDirect) {
          canvasTexture = context.getCurrentTexture();
          out = { texture: canvasTexture, view: canvasTexture.createView() };
        }
        const renderFrame = {
          ...vp, ...frame, sourceReady: inputReady, encoder,
          sourceTexture: input.texture, sourceView: input.view, destinationTexture: out.texture, destinationView: out.view,
        };
        try {
          stage.instance.render(stage.def.apiVersion === 1 ? withV1Fields(renderFrame) : renderFrame);
        } catch (error) {
          return { plugin: stage, error, acquired: canvasTexture !== null };
        }
        input = out;
        inputReady = true;
      }
      if (!canvasTexture) {
        canvasTexture = context.getCurrentTexture();
        encoder.copyTextureToTexture({ texture: input.texture }, { texture: canvasTexture }, [vp.width, vp.height]);
      }
      device.queue.submit([encoder.finish()]);
      return null;
    },
    dispose(keepContext = false) {
      if (disposed) return;
      disposed = true;
      dropMid();
      src.texture.destroy();
      if (!keepContext) { try { context.unconfigure(); } catch { /* context already gone */ } }
      device.destroy();
    },
  };
  presenter.syncSize();
  return presenter;
}
