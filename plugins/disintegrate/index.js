/**
 * Disintegrate (effect plugin ABI v2): an EXAMPLE of the effects extension of html-in-canvas-polyfill, not part of the polyfill.
 * The drawn form dissolves into particles made of its own pixels, blown away by wind and noise, then reassembles. Shader: ./disintegrate.wgsl.
 *
 * A transition plugin: idle, it presents the source unchanged and its input mapper is the identity, so the form is fully usable. While pieces
 * move, are gone or fade, its mapper BLOCKS pointer input: it returns NO_TARGET (the effects ABI value for "no element here") for every point,
 * so the host swallows the press: nothing is focused or activated (../_lib/transition.js). Keyboard input is not mapped by the host and still
 * reaches the focused field.
 *
 * Triggers: `trigger(canvas, 'out' | 'in' | 'play')` (exported), `handle.setOptions({ state: 'out' | 'in' })`, the Snap button of mountUI,
 * and, with `onSubmit`, the submit of the form inside the source. With prefers-reduced-motion the same triggers crossfade instead.
 */

import { wgsl } from './wgsl.js';
import { blockedMapper, clampNumber, createTimeline, DEFAULT_INVALID_SELECTOR, findInvalid, identityMapper, parseColor } from '../_lib/transition.js';

/** @typedef {import('../../src/contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../../src/contracts/types.js').EffectRenderFrame} EffectRenderFrame */

export { NO_TARGET, blockedMapper, createTimeline, findInvalid, identityMapper, parseColor } from '../_lib/transition.js';

/** What the plugin gallery and the build read (plugins/README.md). */
export const meta = Object.freeze({
  name: 'disintegrate',
  title: 'Disintegrate',
  description: 'The form turns to dust made of its own pixels and reassembles: on a valid submit or the Snap button. Input is blocked while it plays.',
  defaults: Object.freeze({ particleSize: 3, wind: 1, duration: 1700, onSubmit: 'valid', intro: true }),
  reducedMotion: 'With reduced motion the same triggers crossfade to the backdrop and back; no particle moves.',
});

/** floats in the uniform block (disintegrate.wgsl `Uniforms`) */
export const UNIFORM_FLOATS = 24;
/** the particle grid grows its cells beyond this many particles (a 4K canvas at 1 px particles would be 8 million) */
export const MAX_PARTICLES = 262144;
/** share of the timeline one particle takes from leaving to gone; its start lies in [0, 1 - LIFE] */
export const LIFE = 0.42;
const HOLD_MS = 380;
/** the clear colour of the host's passthrough: an assembled frame is then identical to the frame without the plugin */
export const HOST_BACKDROP = Object.freeze([0.004, 0.018, 0.034]);
const DEFAULT_GLOW = Object.freeze([1, 0.69, 0.42]);

/** canvases where a device was lost: the plugin is created again on the new device without replaying its intro */
const lostOn = new WeakSet();
/** @type {WeakMap<HTMLCanvasElement, (action: 'out'|'in'|'play') => Promise<boolean>>} */
const controllers = new WeakMap();

/**
 * Start a transition of the disintegrate plugin running on `canvas`.
 * @param {HTMLCanvasElement} canvas
 * @param {'out'|'in'|'play'} [action]  out: dissolve and stay gone; in: reassemble; play: out, a short pause, in
 * @returns {Promise<boolean>}  true when that end state is reached; false when superseded, or when no instance runs on the canvas
 */
export function trigger(canvas, action = 'play') {
  const run = controllers.get(canvas);
  return run ? run(action) : Promise.resolve(false);
}

/**
 * The particle grid over the presented frame: square cells of `particleSize` css px (rounded to backing px), at most MAX_PARTICLES. PURE.
 * @param {number} width  backing px
 * @param {number} height
 * @param {number} dpr
 * @param {number} particleSize  css px
 */
export function particleGrid(width, height, dpr, particleSize) {
  let cell = Math.max(1, Math.round(particleSize * dpr));
  while (Math.ceil(width / cell) * Math.ceil(height / cell) > MAX_PARTICLES) cell += 1;
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  return { cell, cols, rows, count: cols * rows };
}

/**
 * Age of one particle (0 on its cell, 1 gone) for the dissolve amount g; `start` is its start_of() in the shader, in [0, 1 - LIFE]. PURE twin
 * of the shader: with any start in that range, g = 0 gives age 0 for EVERY particle (the exact reassembly) and g = 1 gives age 1.
 * @param {number} g @param {number} start @param {number} [life]
 */
export function particleAge(g, start, life = LIFE) {
  return Math.min(1, Math.max(0, (g - start) / life));
}

/** @param {Readonly<Record<string, unknown>>} o */
export function readOptions(o) {
  const submit = o.onSubmit;
  return {
    particleSize: clampNumber(o.particleSize, 1.5, 12, 3),
    wind: clampNumber(o.wind, 0, 2, 1),
    direction: clampNumber(o.direction, -180, 180, -25),
    turbulence: clampNumber(o.turbulence, 0, 2, 1),
    sizeVariation: clampNumber(o.sizeVariation, 0, 1, 0.7),
    duration: clampNumber(o.duration, 300, 8000, 1700),
    glow: parseColor(o.glow, DEFAULT_GLOW),
    glowAmount: clampNumber(o.glowAmount, 0, 1, 0.5),
    backdrop: parseColor(o.backdrop, HOST_BACKDROP),
    onSubmit: submit === 'valid' || submit === 'always' ? submit : 'off',
    invalidSelector: typeof o.invalidSelector === 'string' && o.invalidSelector ? o.invalidSelector : DEFAULT_INVALID_SELECTOR,
    intro: o.intro === true,
    /** null: follow prefers-reduced-motion */
    reducedMotion: typeof o.reducedMotion === 'boolean' ? o.reducedMotion : null,
    state: /** @type {'out'|'in'} */ (o.state === 'out' ? 'out' : 'in'),
    seed: clampNumber(o.seed, 0, 1000, 1),
  };
}

/**
 * The uniform block of one frame (layout of `Uniforms` in disintegrate.wgsl). Writes into `data`, allocates nothing.
 * @param {Float32Array} data
 * @param {{width: number, height: number, cssWidth: number, cssHeight: number}} frame
 * @param {ReturnType<typeof readOptions>} s
 * @param {number} g
 * @param {{cell: number, cols: number}} grid
 * @param {number} fade
 */
export function fillUniforms(data, frame, s, g, grid, fade) {
  const angle = (s.direction * Math.PI) / 180;
  data[0] = frame.width; data[1] = frame.height; data[2] = frame.cssWidth; data[3] = frame.cssHeight;
  data[4] = g; data[5] = LIFE; data[6] = grid.cell; data[7] = grid.cols;
  data[8] = Math.cos(angle); data[9] = Math.sin(angle);
  data[10] = 0.55 * Math.max(frame.cssWidth, frame.cssHeight) * s.wind;
  data[11] = s.turbulence; data[12] = s.sizeVariation; data[13] = s.glowAmount; data[14] = fade; data[15] = s.seed;
  data[16] = s.backdrop[0]; data[17] = s.backdrop[1]; data[18] = s.backdrop[2]; data[19] = 1;
  data[20] = s.glow[0]; data[21] = s.glow[1]; data[22] = s.glow[2]; data[23] = 1;
}

/** @param {Document} doc */
function injectUiStyle(doc) {
  if (doc.querySelector('style[data-hic-effect-style="disintegrate"]')) return;
  const style = doc.createElement('style');
  style.dataset.hicEffectStyle = 'disintegrate';
  style.textContent = `.hic-dis-ui{display:grid;grid-template-columns:auto 1fr 1fr;gap:4px 12px;align-items:end;font-size:11px;font-weight:700}`
    + `.hic-dis-ui label{display:grid}.hic-dis-ui input{width:100%;margin:0;accent-color:#ffb06b}.hic-dis-ui button{padding:7px 14px;font:inherit;border:0;border-radius:10px;cursor:pointer;color:#1b0d02;background:#ffb06b}`;
  (doc.head || doc.documentElement).append(style);
}

/** @type {EffectPluginDefinition} */
export const plugin = Object.freeze({
  type: 'disintegrate',
  apiVersion: /** @type {const} */ (2),
  version: 1,
  // every pass only writes its destination as a same-format colour attachment (the particle blending never samples it)
  outputCapabilities: Object.freeze({ directCanvasRenderAttachment: /** @type {const} */ (true) }),
  async create(context, initialOptions) {
    const { device, format, canvas, source } = context;
    const module = device.createShaderModule({ code: await wgsl('disintegrate.wgsl') });
    const g = /** @type {any} */ (globalThis);
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: g.GPUShaderStage.VERTEX | g.GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: g.GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: g.GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    /** @param {string} vs @param {string} fs @param {string} target @param {any} [blend] */
    const pipeline = (vs, fs, target, blend) => device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: vs },
      fragment: { module, entryPoint: fs, targets: [{ format: target, ...(blend ? { blend } : {}) }] },
      primitive: { topology: 'triangle-list' },
    });
    const full = pipeline('vs_full', 'fs_full', format);
    const particles = pipeline('vs_particle', 'fs_particle', format, {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    });
    const copy = pipeline('vs_full', 'fs_copy', 'rgba8unorm');
    const uniforms = device.createBuffer({ size: UNIFORM_FLOATS * 4, usage: g.GPUBufferUsage.UNIFORM | g.GPUBufferUsage.COPY_DST });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const data = new Float32Array(UNIFORM_FLOATS);
    // the render pass descriptor is reused: a frame writes its fields, it allocates nothing of its own
    const attachment = { view: /** @type {any} */ (null), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } };
    /** @type {{colorAttachments: any[], timestampWrites?: any}} */
    const passDescriptor = { colorAttachments: [attachment], timestampWrites: undefined };
    /** one bind group per texture view: the host may replace the source texture on resize */
    const groups = new WeakMap();
    /** @param {any} view */
    const groupFor = (view) => {
      let group = groups.get(view);
      if (!group) {
        group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniforms } }, { binding: 1, resource: sampler }, { binding: 2, resource: view }] });
        groups.set(view, group);
      }
      return group;
    };

    const win = /** @type {any} */ (canvas.ownerDocument.defaultView);
    const media = win?.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
    let s = readOptions(initialOptions ?? {});
    const recovering = lostOn.has(canvas);
    lostOn.delete(canvas);
    const timeline = createTimeline({ duration: s.duration, hold: HOLD_MS, gone: s.state === 'out' || (s.intro && !recovering) });
    let stateOption = s.state;
    let crossfade = false;
    let destroyed = false;
    let grid = particleGrid(1, 1, 1, s.particleSize);
    let gridOf = [1, 1, 1, s.particleSize];   // width, height, dpr, particleSize the grid was made for
    let assembledFrame = true;           // what the LAST rendered frame showed: its mapper is fixed by it
    /** the source of the last rendered frame: what the user sees right now, frozen when a transition starts */
    /** @type {any} */ let lastTexture = null;
    /** @type {any} */ let lastView = null;
    /** @type {any} */ let frozen = null;
    /** @type {any} */ let frozenView = null;
    let useFrozen = false;

    /** Copy the picture the user sees now into `frozen` (its own command buffer, ordered before the next source upload). */
    function freeze() {
      if (!lastTexture || !lastView) return false;
      const w = lastTexture.width, h = lastTexture.height;
      if (!frozen || frozen.width !== w || frozen.height !== h) {
        frozen?.destroy?.();
        frozen = device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: g.GPUTextureUsage.TEXTURE_BINDING | g.GPUTextureUsage.RENDER_ATTACHMENT });
        frozenView = frozen.createView();
      }
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: frozenView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
      pass.setPipeline(copy); pass.setBindGroup(0, groupFor(lastView)); pass.draw(3); pass.end();
      device.queue.submit([encoder.finish()]);
      return true;
    }

    /** @param {'out'|'in'|'play'} action */
    function request(action) {
      if (action !== 'out' && action !== 'in' && action !== 'play') return Promise.reject(new TypeError('disintegrate: unknown action ' + action));
      if (destroyed) return Promise.resolve(false);
      if (action !== 'in' && timeline.assembled) useFrozen = freeze();
      crossfade = s.reducedMotion ?? !!media?.matches;
      const done = timeline.request(action);
      context.requestRender();
      return done;
    }
    controllers.set(canvas, request);
    if (timeline.phase === 'gone' && s.state === 'in') request('in');   // the intro: reassemble from dust once the first snapshot is there

    const onSubmit = () => {
      if (s.onSubmit === 'off' || !timeline.assembled) return;
      if (s.onSubmit === 'valid' && findInvalid(source, s.invalidSelector)) return;
      request('play');
    };
    source.addEventListener('submit', onSubmit);
    device.lost?.then?.(() => { if (!destroyed) lostOn.add(canvas); });

    return {
      spatial: true,                      // pieces move: the host requires a mapper (identity when assembled, blocking otherwise)
      get continuous() { return timeline.animating; },
      setOptions(next) {
        s = readOptions(next ?? {});
        timeline.setDuration(s.duration);
        if (s.state !== stateOption) { stateOption = s.state; request(s.state); }
        context.requestRender();
      },
      render(/** @type {EffectRenderFrame} */ frame) {
        lastTexture = frame.sourceTexture;
        lastView = frame.sourceView;
        const amount = frame.sourceReady ? timeline.advance(frame.now) : timeline.g;
        if (amount >= 1 || timeline.assembled) useFrozen = false;
        assembledFrame = timeline.assembled;
        if (gridOf[0] !== frame.width || gridOf[1] !== frame.height || gridOf[2] !== frame.dpr || gridOf[3] !== s.particleSize) {
          gridOf = [frame.width, frame.height, frame.dpr, s.particleSize];
          grid = particleGrid(frame.width, frame.height, frame.dpr, s.particleSize);
        }
        const fade = assembledFrame ? 1 : crossfade ? 1 - amount : 1;
        fillUniforms(data, frame, s, amount, grid, fade);
        device.queue.writeBuffer(uniforms, 0, data);
        attachment.view = frame.destinationView;
        attachment.clearValue.r = s.backdrop[0]; attachment.clearValue.g = s.backdrop[1]; attachment.clearValue.b = s.backdrop[2];
        passDescriptor.timestampWrites = frame.profiling?.timestampWrites?.('disintegrate');
        const pass = frame.encoder.beginRenderPass(passDescriptor);
        if (frame.sourceReady) {
          const group = groupFor(useFrozen && frozenView ? frozenView : frame.sourceView);
          if (assembledFrame || crossfade) { pass.setPipeline(full); pass.setBindGroup(0, group); pass.draw(3); }
          else if (amount < 1) { pass.setPipeline(particles); pass.setBindGroup(0, group); pass.draw(6, grid.count); }
        }
        pass.end();
      },
      // the mapper of the frame just presented: two constant functions, so it is frozen by construction
      captureInputMapper() { return assembledFrame ? identityMapper : blockedMapper; },
      mountUI(root, ui) {
        const doc = root.ownerDocument;
        injectUiStyle(doc);
        const box = doc.createElement('div');
        box.className = 'hic-dis-ui';
        box.innerHTML = '<button type="button">Snap</button><label>Particle size<input type="range" min="2" max="10" step="1"></label><label>Wind<input type="range" min="0" max="200" step="5"></label>';
        const [size, wind] = /** @type {NodeListOf<HTMLInputElement>} */ (box.querySelectorAll('input'));
        const o = readOptions(ui.getOptions());
        size.value = String(o.particleSize);
        wind.value = String(Math.round(o.wind * 100));
        const onSnap = () => { trigger(canvas, 'play'); };
        const onSize = () => ui.setOptions({ particleSize: Number(size.value) });
        const onWind = () => ui.setOptions({ wind: Number(wind.value) / 100 });
        const button = /** @type {HTMLButtonElement} */ (box.querySelector('button'));
        button.addEventListener('click', onSnap);
        size.addEventListener('input', onSize);
        wind.addEventListener('input', onWind);
        root.append(box);
        return () => {
          button.removeEventListener('click', onSnap);
          size.removeEventListener('input', onSize);
          wind.removeEventListener('input', onWind);
          box.remove();
        };
      },
      destroy() {
        destroyed = true;
        timeline.cancel();
        source.removeEventListener('submit', onSubmit);
        if (controllers.get(canvas) === request) controllers.delete(canvas);
        uniforms.destroy?.();
        frozen?.destroy?.();
      },
    };
  },
});
