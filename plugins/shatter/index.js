/**
 * Shatter (effect plugin ABI v2): an EXAMPLE of the effects extension of html-in-canvas-polyfill, not part of the polyfill.
 * The drawn form cracks from an impact point (the pointer), breaks into glass shards that fall, turn and catch the light, then flies back
 * together. Shader: ./shatter.wgsl; geometry and physics: ./shards.js.
 *
 * A transition plugin: idle, it presents the source unchanged and its input mapper is the identity, so the form is fully usable. While shards
 * crack, move, are gone or fade, its mapper BLOCKS pointer input (../_lib/transition.js): it returns NO_TARGET (the effects ABI value for
 * "no element here") for every point, so the host swallows the press. Keyboard input is not mapped by the host and still reaches the focused field.
 *
 * Triggers: `trigger(canvas, 'out' | 'in' | 'play', point?)` (exported), `handle.setOptions({ state })`, the Shatter button of mountUI, and,
 * with `onSubmit`, the submit of the form inside the source. With prefers-reduced-motion the same triggers crossfade instead.
 */

import { wgsl } from './wgsl.js';
import { buildShards, CRACK_SPEED, MAX_SHARDS, MAX_VERTICES, SHARD_FLOATS, VERTEX_FLOATS } from './shards.js';
import { blockedMapper, clampNumber, createTimeline, DEFAULT_INVALID_SELECTOR, findInvalid, identityMapper, parseColor, sourcePointOnCanvas } from '../_lib/transition.js';

/** @typedef {import('../../src/contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../../src/contracts/types.js').EffectRenderFrame} EffectRenderFrame */

export { NO_TARGET, blockedMapper, createTimeline, identityMapper } from '../_lib/transition.js';

/** What the plugin gallery and the build read (plugins/README.md). */
export const meta = Object.freeze({
  name: 'shatter',
  title: 'Shatter',
  description: 'The form cracks where you click and falls apart in glass shards, then flies back: on an invalid submit or the Shatter button.',
  defaults: Object.freeze({ pieces: 36, gravity: 1, duration: 1400, onSubmit: 'invalid', intro: true }),
  reducedMotion: 'With reduced motion the same triggers crossfade to the backdrop and back; nothing breaks or moves.',
});

/** floats of the per-frame part of the uniform block (shatter.wgsl `Uniforms` up to `shards`) */
export const HEADER_FLOATS = 24;
/** physics seconds one way of the transition plays (g = 1 is SPAN seconds after the impact) */
export const SPAN = 1.6;
/** css px/s^2 at gravity 1 */
export const GRAVITY = 2400;
const HOLD_MS = 300;
/** a pointer press younger than this is the impact point of a submit */
const POINTER_MS = 1500;
/** the clear colour of the host's passthrough: an assembled frame is then identical to the frame without the plugin */
export const HOST_BACKDROP = Object.freeze([0.004, 0.018, 0.034]);
const DEFAULT_EDGE = Object.freeze([0.85, 0.96, 1]);

const lostOn = new WeakSet();
/** @type {WeakMap<HTMLCanvasElement, (action: 'out'|'in'|'play', point?: {x: number, y: number}|null) => Promise<boolean>>} */
const controllers = new WeakMap();

/**
 * Start a transition of the shatter plugin running on `canvas`.
 * @param {HTMLCanvasElement} canvas
 * @param {'out'|'in'|'play'} [action]  out: shatter and stay gone; in: fly back together; play: out, a short pause, in
 * @param {{x: number, y: number}|null} [point]  impact point in canvas css px (default: the last pointer press, else the centre)
 * @returns {Promise<boolean>}  true when that end state is reached; false when superseded, or when no instance runs on the canvas
 */
export function trigger(canvas, action = 'play', point = null) {
  const run = controllers.get(canvas);
  return run ? run(action, point) : Promise.resolve(false);
}

/** @param {Readonly<Record<string, unknown>>} o */
export function readOptions(o) {
  const submit = o.onSubmit;
  return {
    pieces: Math.round(clampNumber(o.pieces, 6, MAX_SHARDS, 36)),
    gravity: clampNumber(o.gravity, 0.2, 3, 1),
    duration: clampNumber(o.duration, 300, 8000, 1400),
    edge: parseColor(o.edgeColor, DEFAULT_EDGE),
    edgeAmount: clampNumber(o.edgeAmount, 0, 1, 0.85),
    backdrop: parseColor(o.backdrop, HOST_BACKDROP),
    onSubmit: submit === 'invalid' || submit === 'valid' || submit === 'always' ? submit : 'off',
    invalidSelector: typeof o.invalidSelector === 'string' && o.invalidSelector ? o.invalidSelector : DEFAULT_INVALID_SELECTOR,
    intro: o.intro === true,
    reducedMotion: typeof o.reducedMotion === 'boolean' ? o.reducedMotion : null,
    state: /** @type {'out'|'in'} */ (o.state === 'out' ? 'out' : 'in'),
    seed: clampNumber(o.seed, 0, 1e6, 7),
  };
}

/**
 * The per-frame part of the uniform block. Writes into `data`, allocates nothing.
 * @param {Float32Array} data
 * @param {{width: number, height: number, cssWidth: number, cssHeight: number}} frame
 * @param {ReturnType<typeof readOptions>} s
 * @param {number} g  0 intact .. 1 gone
 * @param {{x: number, y: number}} impact
 * @param {number} fade
 */
export function fillHeader(data, frame, s, g, impact, fade) {
  const time = g * SPAN;
  data[0] = frame.width; data[1] = frame.height; data[2] = frame.cssWidth; data[3] = frame.cssHeight;
  data[4] = time; data[5] = GRAVITY * s.gravity; data[6] = 1 - smoothstep(0.82, 1, g); data[7] = time * CRACK_SPEED;
  data[8] = impact.x; data[9] = impact.y; data[10] = s.edgeAmount; data[11] = fade;
  data[12] = 0.5 * (1 - smoothstep(0, 0.12, time)); data[13] = 0; data[14] = 0; data[15] = 0;
  data[16] = s.backdrop[0]; data[17] = s.backdrop[1]; data[18] = s.backdrop[2]; data[19] = 1;
  data[20] = s.edge[0]; data[21] = s.edge[1]; data[22] = s.edge[2]; data[23] = 1;
}

/** @param {number} a @param {number} b @param {number} x */
function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** @param {Document} doc */
function injectUiStyle(doc) {
  if (doc.querySelector('style[data-hic-effect-style="shatter"]')) return;
  const style = doc.createElement('style');
  style.dataset.hicEffectStyle = 'shatter';
  style.textContent = `.hic-shatter-ui{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;align-items:end;font-size:11px;font-weight:700}`
    + `.hic-shatter-ui label{display:grid}.hic-shatter-ui input{width:100%;margin:0;accent-color:#bfe9ff}.hic-shatter-ui button{padding:7px 14px;font:inherit;border:0;border-radius:10px;cursor:pointer;color:#06202c;background:#bfe9ff}`;
  (doc.head || doc.documentElement).append(style);
}

/** @type {EffectPluginDefinition} */
export const plugin = Object.freeze({
  type: 'shatter',
  apiVersion: /** @type {const} */ (2),
  version: 1,
  // every pass only writes its destination as a same-format colour attachment (the shard blending never samples it)
  outputCapabilities: Object.freeze({ directCanvasRenderAttachment: /** @type {const} */ (true) }),
  async create(context, initialOptions) {
    const { device, format, canvas, source } = context;
    const module = device.createShaderModule({ code: await wgsl('shatter.wgsl') });
    const g = /** @type {any} */ (globalThis);
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: g.GPUShaderStage.VERTEX | g.GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: g.GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: g.GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    /** @param {string} vs @param {string} fs @param {string} target @param {any} [extra] */
    const pipeline = (vs, fs, target, extra = {}) => device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: vs, buffers: extra.buffers ?? [] },
      fragment: { module, entryPoint: fs, targets: [{ format: target, ...(extra.blend ? { blend: extra.blend } : {}) }] },
      primitive: { topology: 'triangle-list' },
    });
    const full = pipeline('vs_full', 'fs_full', format);
    const glass = pipeline('vs_shard', 'fs_shard', format, {
      buffers: [{ arrayStride: VERTEX_FLOATS * 4, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }, { shaderLocation: 1, offset: 8, format: 'float32x2' }] }],
      blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } },
    });
    const copy = pipeline('vs_full', 'fs_copy', 'rgba8unorm');
    const B = g.GPUBufferUsage;
    const uniforms = device.createBuffer({ size: (HEADER_FLOATS + MAX_SHARDS * SHARD_FLOATS) * 4, usage: B.UNIFORM | B.COPY_DST });
    const vertexBuffer = device.createBuffer({ size: MAX_VERTICES * VERTEX_FLOATS * 4, usage: B.VERTEX | B.COPY_DST });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const header = new Float32Array(HEADER_FLOATS);
    const vertices = new Float32Array(MAX_VERTICES * VERTEX_FLOATS);
    const shardData = new Float32Array(MAX_SHARDS * SHARD_FLOATS);
    const attachment = { view: /** @type {any} */ (null), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } };
    /** @type {{colorAttachments: any[], timestampWrites?: any}} */
    const passDescriptor = { colorAttachments: [attachment], timestampWrites: undefined };
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
    let assembledFrame = true;
    let vertexCount = 0;
    let shatters = 0;
    const impact = { x: 0, y: 0 };
    /** the impact of the next layout, built by the next frame (it needs the frame's css size); null: none pending */
    /** @type {{x: number, y: number}|null} */ let pendingImpact = null;
    let layoutPending = timeline.phase === 'gone';
    /** @type {{x: number, y: number, t: number}} */ const pointer = { x: 0, y: 0, t: -Infinity };
    /** @type {any} */ let lastTexture = null;
    /** @type {any} */ let lastView = null;
    /** @type {any} */ let frozen = null;
    /** @type {any} */ let frozenView = null;
    let useFrozen = false;

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

    /** @param {'out'|'in'|'play'} action @param {{x: number, y: number}|null} [point] */
    function request(action, point = null) {
      if (action !== 'out' && action !== 'in' && action !== 'play') return Promise.reject(new TypeError('shatter: unknown action ' + action));
      if (destroyed) return Promise.resolve(false);
      if (action !== 'in' && timeline.assembled) {
        useFrozen = freeze();
        const recent = performance.now() - pointer.t < POINTER_MS;
        pendingImpact = point ? { x: point.x, y: point.y } : recent ? { x: pointer.x, y: pointer.y } : null;
        layoutPending = true;
      }
      crossfade = s.reducedMotion ?? !!media?.matches;
      const done = timeline.request(action);
      context.requestRender();
      return done;
    }
    controllers.set(canvas, request);
    if (timeline.phase === 'gone' && s.state === 'in') request('in');   // the intro: the shards fly together once the first snapshot is there

    context.listen('pointerdown', (event) => {
      const e = /** @type {PointerEvent} */ (event);
      const r = canvas.getBoundingClientRect();
      pointer.x = e.clientX - r.left - canvas.clientLeft;
      pointer.y = e.clientY - r.top - canvas.clientTop;
      pointer.t = performance.now();
    });
    const onSubmit = () => {
      if (s.onSubmit === 'off' || !timeline.assembled) return;
      const bad = findInvalid(source, s.invalidSelector);
      if ((s.onSubmit === 'invalid' && !bad) || (s.onSubmit === 'valid' && bad)) return;
      const recent = performance.now() - pointer.t < POINTER_MS;
      const at = !recent && bad ? sourcePointOnCanvas(source.getBoundingClientRect(), bad.getBoundingClientRect(), { width: canvas.clientWidth, height: canvas.clientHeight }) : null;
      request('play', at);
    };
    source.addEventListener('submit', onSubmit);
    device.lost?.then?.(() => { if (!destroyed) lostOn.add(canvas); });

    return {
      spatial: true,                      // shards move: the host requires a mapper (identity when assembled, blocking otherwise)
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
        if (layoutPending && !assembledFrame && !crossfade) {
          // once per shatter, not per frame: the cells, their fans and their motion, uploaded to the two preallocated buffers
          impact.x = pendingImpact ? Math.min(frame.cssWidth, Math.max(0, pendingImpact.x)) : frame.cssWidth / 2;
          impact.y = pendingImpact ? Math.min(frame.cssHeight, Math.max(0, pendingImpact.y)) : frame.cssHeight / 2;
          const built = buildShards(impact, frame.cssWidth, frame.cssHeight, s.pieces, s.seed + shatters++, vertices, shardData);
          vertexCount = built.vertexCount;
          device.queue.writeBuffer(vertexBuffer, 0, vertices, 0, vertexCount * VERTEX_FLOATS);
          device.queue.writeBuffer(uniforms, HEADER_FLOATS * 4, shardData);
          layoutPending = false;
          pendingImpact = null;
        }
        fillHeader(header, frame, s, amount, impact, assembledFrame ? 1 : crossfade ? 1 - amount : 1);
        device.queue.writeBuffer(uniforms, 0, header);
        attachment.view = frame.destinationView;
        attachment.clearValue.r = s.backdrop[0]; attachment.clearValue.g = s.backdrop[1]; attachment.clearValue.b = s.backdrop[2];
        passDescriptor.timestampWrites = frame.profiling?.timestampWrites?.('shatter');
        const pass = frame.encoder.beginRenderPass(passDescriptor);
        if (frame.sourceReady) {
          const group = groupFor(useFrozen && frozenView ? frozenView : frame.sourceView);
          if (assembledFrame || crossfade) { pass.setPipeline(full); pass.setBindGroup(0, group); pass.draw(3); }
          else if (amount < 1 && vertexCount > 0) { pass.setPipeline(glass); pass.setBindGroup(0, group); pass.setVertexBuffer(0, vertexBuffer); pass.draw(vertexCount); }
        }
        pass.end();
      },
      // the mapper of the frame just presented: two constant functions, so it is frozen by construction
      captureInputMapper() { return assembledFrame ? identityMapper : blockedMapper; },
      mountUI(root, ui) {
        const doc = root.ownerDocument;
        injectUiStyle(doc);
        const box = doc.createElement('div');
        box.className = 'hic-shatter-ui';
        box.innerHTML = '<button type="button">Shatter</button><label>Pieces<input type="range" min="8" max="64" step="1"></label>';
        const pieces = /** @type {HTMLInputElement} */ (box.querySelector('input'));
        pieces.value = String(readOptions(ui.getOptions()).pieces);
        const button = /** @type {HTMLButtonElement} */ (box.querySelector('button'));
        const onShatter = () => { trigger(canvas, 'play'); };   // the impact: the pointer press on this button
        const onPieces = () => ui.setOptions({ pieces: Number(pieces.value) });
        button.addEventListener('click', onShatter);
        pieces.addEventListener('input', onPieces);
        root.append(box);
        return () => { button.removeEventListener('click', onShatter); pieces.removeEventListener('input', onPieces); box.remove(); };
      },
      destroy() {
        destroyed = true;
        timeline.cancel();
        source.removeEventListener('submit', onSubmit);
        if (controllers.get(canvas) === request) controllers.delete(canvas);
        uniforms.destroy?.();
        vertexBuffer.destroy?.();
        frozen?.destroy?.();
      },
    };
  },
});
