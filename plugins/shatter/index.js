/**
 * Shatter (effect plugin ABI v2): an EXAMPLE of the effects extension of html-in-canvas-polyfill, not part of the polyfill.
 * Two impacts. The first cracks the pane: a spiderweb of cracks runs out from the impact point (the pointer, or the invalid field), each
 * piece shifts a few pixels, the picture bends along the broken edges and the pieces catch the light, and the form stays visible AND usable
 * through the cracked glass. The second impact breaks it: the shards fall out in 3D perspective, turning, lit on their faces, with bright
 * edges, motion blur and small debris, leaving the empty backdrop; then they fly back up into place and the cracks close.
 * Shader: ./shatter.wgsl; geometry, physics and the mapper of the cracked pane: ./shards.js.
 *
 * Input: intact, the mapper is the identity. Cracked (and still), it is the exact inverse of the per-shard offsets and of the bending along
 * the cracks (crackedSource): a click lands on the control drawn under the pointer. While the cracks run or close and while shards fall, are
 * gone or fly back, it BLOCKS pointer input: it returns NO_TARGET (the effects ABI value for "no element here") for every point, so the host
 * swallows the press. Keyboard input is not mapped by the host and still reaches the focused field.
 *
 * Triggers: `trigger(canvas, 'impact' | 'crack' | 'out' | 'in' | 'play', point?)` (exported), `handle.setOptions({ state })`, the Strike
 * button of mountUI, and, with `onSubmit`, the submit of the form inside the source. With prefers-reduced-motion nothing cracks or moves: a
 * second impact crossfades to the backdrop and back.
 */

import { wgsl } from './wgsl.js';
import { buildShards, crackedLayout, crackedSource, HEAL, MAX_SHARDS, MAX_VERTICES, SHARD_FLOATS, SPAN, VERTEX_FLOATS } from './shards.js';
import { blockedMapper, clampNumber, createTimeline, DEFAULT_INVALID_SELECTOR, findInvalid, identityMapper, parseColor, sourcePointOnCanvas } from '../_lib/transition.js';

/** @typedef {import('../../src/contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../../src/contracts/types.js').EffectRenderFrame} EffectRenderFrame */

export { NO_TARGET, blockedMapper, createTimeline, identityMapper } from '../_lib/transition.js';

/** What the plugin gallery and the build read (plugins/README.md). */
export const meta = Object.freeze({
  name: 'shatter',
  title: 'Shatter',
  description: 'An invalid submit cracks the glass over the form (still usable through it); a second one shatters it into falling 3D shards that fly back.',
  defaults: Object.freeze({ duration: 1600, onSubmit: 'invalid', intro: true }),
  reducedMotion: 'With reduced motion nothing cracks or falls: the second impact crossfades the form to the backdrop and back.',
});

/** floats of the per-frame part of the uniform block (shatter.wgsl `Uniforms` up to `shards`) */
export const HEADER_FLOATS = 28;
/** css px/s^2 at gravity 1 */
export const GRAVITY = 2400;
/** ms the cracks take to run out from the impact (and to close again when the form heals without falling) */
export const CRACK_MS = 450;
const HOLD_MS = 300;
/** a pointer press younger than this is the impact point of a submit */
const POINTER_MS = 1500;
/** chips of glass that burst out at the first impact, and when the pane breaks */
export const CHIPS_CRACK = 40;
export const CHIPS_FALL = 260;
/** the clear colour of the host's passthrough: an assembled frame is then identical to the frame without the plugin */
export const HOST_BACKDROP = Object.freeze([0.004, 0.018, 0.034]);
const DEFAULT_EDGE = Object.freeze([0.85, 0.96, 1]);
/** the picture inside an open crack: dimmed to this share */
export const CRACK_DIM = 0.5;

const lostOn = new WeakSet();
/** @typedef {'impact'|'crack'|'out'|'in'|'play'} Action */
/** @type {WeakMap<HTMLCanvasElement, (action: Action, point?: {x: number, y: number}|null) => Promise<boolean>>} */
const controllers = new WeakMap();
/** @type {WeakMap<HTMLCanvasElement, () => Promise<'intact'|'cracked'|'gone'|null>>} */
const settlers = new WeakMap();

/**
 * Resolves once nothing of the shatter plugin on `canvas` moves any more, with what the pane then shows: 'intact', 'cracked' or 'gone'
 * (null when no instance runs there or it is removed first). When something moves, it resolves after the frame that draws the end state
 * was rendered; when nothing moves, at once. A deterministic signal for tests and page code (no polling, no timeout).
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<'intact'|'cracked'|'gone'|null>}
 */
export function settled(canvas) {
  const wait = settlers.get(canvas);
  return wait ? wait() : Promise.resolve(null);
}

/**
 * Start a transition of the shatter plugin running on `canvas`.
 * @param {HTMLCanvasElement} canvas
 * @param {Action} [action]  impact: crack an intact pane, or break a cracked one ('play'); crack: crack and stay cracked; out: break and stay
 *   gone; in: fly back and close the cracks (also heals a cracked pane); play: out, a short pause, in
 * @param {{x: number, y: number}|null} [point]  impact point in canvas css px (default: the last pointer press, else the `impact` option, else the centre)
 * @returns {Promise<boolean>}  true when that end state is reached; false when superseded, or when no instance runs on the canvas
 */
export function trigger(canvas, action = 'play', point = null) {
  const run = controllers.get(canvas);
  return run ? run(action, point) : Promise.resolve(false);
}

/** @param {Readonly<Record<string, unknown>>} o */
export function readOptions(o) {
  const submit = o.onSubmit;
  const at = /** @type {any} */ (o.impact);
  return {
    cracks: Math.round(clampNumber(o.cracks, 6, 24, 13)),
    gravity: clampNumber(o.gravity, 0.2, 3, 1),
    duration: clampNumber(o.duration, 300, 8000, 1600),
    edge: parseColor(o.edgeColor, DEFAULT_EDGE),
    edgeAmount: clampNumber(o.edgeAmount, 0, 1, 0.85),
    glint: clampNumber(o.glint, 0, 1, 0.8),
    refraction: clampNumber(o.refraction, 0, 4, 1.6),
    backdrop: parseColor(o.backdrop, HOST_BACKDROP),
    onSubmit: submit === 'invalid' || submit === 'valid' || submit === 'always' ? submit : 'off',
    invalidSelector: typeof o.invalidSelector === 'string' && o.invalidSelector ? o.invalidSelector : DEFAULT_INVALID_SELECTOR,
    intro: o.intro === true,
    reducedMotion: typeof o.reducedMotion === 'boolean' ? o.reducedMotion : null,
    state: /** @type {'out'|'in'|'cracked'} */ (o.state === 'out' || o.state === 'cracked' ? o.state : 'in'),
    impact: at && Number.isFinite(at.x) && Number.isFinite(at.y) ? { x: Number(at.x), y: Number(at.y) } : null,
    seed: clampNumber(o.seed, 0, 1e6, 7),
  };
}

/**
 * How far the cracks have run, css px, for the crack amount c (0 closed, 1 open) on a canvas whose farthest corner is `far` from the impact.
 * @param {number} c @param {number} far
 */
export function crackFront(c, far) {
  const k = Math.min(1, Math.max(0, c));
  return (1 - (1 - k) ** 2.5) * (far + 200);
}

/**
 * The per-frame part of the uniform block. Writes into `data`, allocates nothing.
 * @param {Float32Array} data
 * @param {{width: number, height: number, cssWidth: number, cssHeight: number}} frame
 * @param {ReturnType<typeof readOptions>} s
 * @param {{time: number, crack: number, far: number, fade: number, flash: number, debrisT: number, debrisN: number, ghosts: number, alpha: number}} f
 * @param {{x: number, y: number}} impact
 */
export function fillHeader(data, frame, s, f, impact) {
  data[0] = frame.width; data[1] = frame.height; data[2] = frame.cssWidth; data[3] = frame.cssHeight;
  data[4] = f.time; data[5] = GRAVITY * s.gravity; data[6] = f.alpha; data[7] = crackFront(f.crack, f.far);
  data[8] = impact.x; data[9] = impact.y; data[10] = s.edgeAmount; data[11] = f.fade;
  data[12] = f.flash; data[13] = f.crack; data[14] = s.glint; data[15] = 1.6 * Math.max(frame.cssWidth, frame.cssHeight);
  data[16] = f.debrisT; data[17] = f.debrisN; data[18] = f.ghosts; data[19] = s.refraction;
  data[20] = s.backdrop[0]; data[21] = s.backdrop[1]; data[22] = s.backdrop[2]; data[23] = 1;
  data[24] = s.edge[0]; data[25] = s.edge[1]; data[26] = s.edge[2]; data[27] = 1;
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
  version: 2,
  // every pass only writes its destination as a same-format colour attachment (the shard and debris blending never samples it)
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
    const blend = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } };
    /** @param {string} vs @param {string} fs @param {string} target @param {any} [extra] */
    const pipeline = (vs, fs, target, extra = {}) => device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: vs, buffers: extra.buffers ?? [] },
      fragment: { module, entryPoint: fs, targets: [{ format: target, ...(extra.blend ? { blend: extra.blend } : {}) }] },
      primitive: { topology: 'triangle-list' },
    });
    const full = pipeline('vs_full', 'fs_full', format);
    const glass = pipeline('vs_shard', 'fs_shard', format, {
      buffers: [{ arrayStride: VERTEX_FLOATS * 4, attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x2' }, { shaderLocation: 1, offset: 8, format: 'float32x2' }, { shaderLocation: 2, offset: 16, format: 'float32x4' },
      ] }],
      blend,
    });
    const chips = pipeline('vs_debris', 'fs_debris', format, { blend });
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
    /** the frame values of fillHeader, reused */
    const look = { time: 0, crack: 0, far: 0, fade: 1, flash: 0, debrisT: -1, debrisN: 0, ghosts: 1, alpha: 1 };
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
    const reduced = () => s.reducedMotion ?? !!media?.matches;
    let s = readOptions(initialOptions ?? {});
    const recovering = lostOn.has(canvas);
    lostOn.delete(canvas);
    // two clocks: the cracks (0 intact, 1 cracked) and the fall (0 in the pane, 1 gone)
    const cracks = createTimeline({ duration: CRACK_MS, gone: !recovering && s.state === 'cracked' && !reduced() });
    const fall = createTimeline({ duration: s.duration, hold: HOLD_MS, gone: s.state === 'out' || (s.intro && !recovering) });
    let stateOption = s.state;
    let crossfade = false;
    let destroyed = false;
    /** the fall started from a cracked pane: the cracks stay open until the way back closes them */
    let precracked = false;
    let wasFalling = !fall.assembled;
    /** what the LAST rendered frame showed: 'intact' | 'cracked' | 'moving' (its mapper is fixed by it) */
    let shown = 'intact';
    let vertexCount = 0;
    let strikes = 0;
    const impact = { x: 0, y: 0 };
    let far = 1;
    /** the impact of the next crack pattern, built by the next frame (it needs the frame's css size); null: the default point */
    /** @type {{x: number, y: number}|null} */ let pendingImpact = null;
    let layoutPending = !fall.assembled || cracks.phase === 'gone';
    /** the crack pattern on the pane now (null: intact) and the mapper of its still, cracked state: both made once per crack */
    /** @type {ReturnType<typeof crackedLayout>|null} */ let pattern = null;
    /** @type {((p: {x: number, y: number}) => {x: number, y: number})|null} */ let crackedMapper = null;
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

    const intact = () => fall.assembled && cracks.assembled;
    const cracked = () => fall.assembled && cracks.phase === 'gone';
    /** @param {{x: number, y: number}|null} point */
    const newPattern = (point) => {
      const recent = performance.now() - pointer.t < POINTER_MS;
      pendingImpact = point ? { x: point.x, y: point.y } : recent ? { x: pointer.x, y: pointer.y } : s.impact;
      layoutPending = true;
    };

    /** @param {Action} action @param {{x: number, y: number}|null} [point] */
    function request(action, point = null) {
      if (!['impact', 'crack', 'out', 'in', 'play'].includes(action)) return Promise.reject(new TypeError('shatter: unknown action ' + action));
      if (destroyed) return Promise.resolve(false);
      const calm = reduced();
      let done;
      if (action === 'impact') action = calm || !fall.assembled || cracked() || cracks.animating ? 'play' : 'crack';
      if (action === 'crack') {
        if (calm || !fall.assembled) return Promise.resolve(false);           // nothing cracks with reduced motion, nor while shards fall
        if (intact()) newPattern(point);
        done = cracks.request('out');
      } else if (action === 'in') {
        done = fall.assembled ? cracks.request('in') : fall.request('in');
      } else {
        if (fall.assembled) {
          useFrozen = freeze();
          crossfade = calm;
          precracked = !cracks.assembled && !calm;
          if (precracked) cracks.jump('out');
          else newPattern(point);
        }
        done = fall.request(action);
      }
      context.requestRender();
      return done;
    }
    controllers.set(canvas, request);
    /** @type {((state: 'intact'|'cracked'|'gone'|null) => void)[]} */ const waiters = [];
    const restingState = () => (!fall.assembled ? 'gone' : cracks.phase === 'gone' ? 'cracked' : 'intact');
    const moving = () => cracks.animating || fall.animating;
    const wait = () => (moving() ? new Promise((resolve) => { waiters.push(resolve); }) : Promise.resolve(restingState()));
    settlers.set(canvas, wait);
    if (fall.phase === 'gone' && s.state === 'in') { crossfade = reduced(); request('in'); }   // the intro: the shards fly into place

    context.listen('pointerdown', (event) => {
      const e = /** @type {PointerEvent} */ (event);
      const r = canvas.getBoundingClientRect();
      pointer.x = e.clientX - r.left - canvas.clientLeft;
      pointer.y = e.clientY - r.top - canvas.clientTop;
      pointer.t = performance.now();
    });
    const onSubmit = (/** @type {Event} */ event) => {
      if (s.onSubmit === 'off' || !fall.assembled) return;                       // a submit while shards fall changes nothing
      const bad = findInvalid(source, s.invalidSelector);
      const match = s.onSubmit === 'always' || (s.onSubmit === 'invalid' ? !!bad : !bad);
      // the form was fixed: the glass heals, also while its cracks are still running (they close from where they are)
      if (!match) { if (!cracks.assembled && cracks.phase !== 'in') request('in'); return; }
      if (cracks.animating) return;                                                // a second impact while the cracks run changes nothing
      const recent = performance.now() - pointer.t < POINTER_MS;
      const el = bad ?? /** @type {any} */ (event).submitter;
      const at = !recent && el?.getBoundingClientRect ? sourcePointOnCanvas(source.getBoundingClientRect(), el.getBoundingClientRect(), { width: canvas.clientWidth, height: canvas.clientHeight }) : null;
      request('impact', at);
    };
    source.addEventListener('submit', onSubmit);
    device.lost?.then?.(() => { if (!destroyed) lostOn.add(canvas); });

    return {
      spatial: true,                      // the pieces move: identity intact, the inverse of the offsets cracked, blocking while anything moves
      get continuous() { return cracks.animating || fall.animating; },
      setOptions(next) {
        s = readOptions(next ?? {});
        fall.setDuration(s.duration);
        if (s.state !== stateOption) { stateOption = s.state; request(s.state === 'cracked' ? 'crack' : s.state); }
        context.requestRender();
      },
      render(/** @type {EffectRenderFrame} */ frame) {
        lastTexture = frame.sourceTexture;
        lastView = frame.sourceView;
        const gFall = frame.sourceReady ? fall.advance(frame.now) : fall.g;
        let gCrack = frame.sourceReady ? cracks.advance(frame.now) : cracks.g;
        const falling = !fall.assembled;
        if (wasFalling && !falling) { cracks.jump('in'); gCrack = 0; precracked = false; crossfade = false; }   // back in place, cracks closed
        wasFalling = falling;
        if (!falling && cracks.assembled) { pattern = null; crackedMapper = null; }
        if (gFall >= 1 || !falling) useFrozen = false;
        // how open the cracks are: their own clock, or, during a fall that did not start cracked, the first HEAL of the way out / last of the way back
        const c = falling ? (precracked && fall.phase !== 'in' ? 1 : Math.min(1, gFall / HEAL)) : gCrack;
        if (layoutPending && (falling || c > 0) && !crossfade) {
          // once per crack, not per frame: the cells, their fans and their motion, uploaded to the two preallocated buffers
          const at = pendingImpact ?? { x: frame.cssWidth / 2, y: frame.cssHeight / 2 };
          impact.x = Math.min(frame.cssWidth, Math.max(0, at.x));
          impact.y = Math.min(frame.cssHeight, Math.max(0, at.y));
          far = Math.max(Math.hypot(impact.x, impact.y), Math.hypot(frame.cssWidth - impact.x, impact.y), Math.hypot(impact.x, frame.cssHeight - impact.y), Math.hypot(frame.cssWidth - impact.x, frame.cssHeight - impact.y));
          const built = buildShards(impact, frame.cssWidth, frame.cssHeight, s.cracks, s.seed + strikes++, vertices, shardData);
          vertexCount = built.vertexCount;
          device.queue.writeBuffer(vertexBuffer, 0, vertices, 0, vertexCount * VERTEX_FLOATS);
          device.queue.writeBuffer(uniforms, HEADER_FLOATS * 4, shardData);
          pattern = crackedLayout(vertices, vertexCount, shardData, built.shardCount, s.refraction);
          const frozenPattern = pattern;
          crackedMapper = (p) => crackedSource(frozenPattern, p);
          layoutPending = false;
          pendingImpact = null;
        }
        const time = falling ? gFall * SPAN : 0;
        const breaking = falling && time >= HEAL * SPAN;
        const pane = !crossfade && c > 0 && vertexCount > 0 && pattern !== null;   // the cracked pane is drawn (still, or with its cracks running)
        shown = falling || cracks.animating ? 'moving' : pane ? 'cracked' : 'intact';
        look.time = time;
        look.crack = c;
        look.far = far;
        look.fade = crossfade ? 1 - gFall : pane && !falling ? CRACK_DIM : 1;
        look.flash = falling ? (precracked && fall.phase !== 'in' ? 1.2 * (1 - smoothstep(0, HEAL * 0.8, gFall)) : 0)
          : cracks.phase === 'out' ? 1.5 * (1 - smoothstep(0, 0.6, gCrack)) : 0;
        look.debrisT = breaking ? time - HEAL * SPAN : cracks.phase === 'out' ? gCrack : -1;
        look.debrisN = breaking ? CHIPS_FALL : CHIPS_CRACK;
        look.ghosts = breaking ? 3 : 1;
        look.alpha = 1 - smoothstep(0.82, 1, gFall);
        fillHeader(header, frame, s, look, impact);
        device.queue.writeBuffer(uniforms, 0, header);
        attachment.view = frame.destinationView;
        attachment.clearValue.r = s.backdrop[0]; attachment.clearValue.g = s.backdrop[1]; attachment.clearValue.b = s.backdrop[2];
        passDescriptor.timestampWrites = frame.profiling?.timestampWrites?.('shatter');
        const pass = frame.encoder.beginRenderPass(passDescriptor);
        if (frame.sourceReady) {
          pass.setBindGroup(0, groupFor(useFrozen && frozenView ? frozenView : frame.sourceView));
          if (crossfade || (!falling && !pane)) { pass.setPipeline(full); pass.draw(3); }   // intact (the host's passthrough), or the crossfade
          else {
            if (!falling) { pass.setPipeline(full); pass.draw(3); }                        // the picture in place, dimmed: seen inside the open cracks
            if (gFall < 1) { pass.setPipeline(glass); pass.setVertexBuffer(0, vertexBuffer); pass.draw(vertexCount, look.ghosts); }
            if (look.debrisT >= 0 && gFall < 1) { pass.setPipeline(chips); pass.draw(3, look.debrisN); }
          }
        }
        pass.end();
        if (waiters.length && frame.sourceReady && !moving()) { const state = restingState(); for (const resolve of waiters.splice(0)) resolve(state); }
      },
      // the mapper of the frame just presented: the identity, the mapper of this crack pattern (made once per crack), or blocking
      captureInputMapper() { return shown === 'intact' ? identityMapper : shown === 'cracked' && crackedMapper ? crackedMapper : blockedMapper; },
      mountUI(root, ui) {
        const doc = root.ownerDocument;
        injectUiStyle(doc);
        const box = doc.createElement('div');
        box.className = 'hic-shatter-ui';
        box.innerHTML = '<button type="button">Strike</button><label>Cracks<input type="range" min="6" max="24" step="1"></label>';
        const count = /** @type {HTMLInputElement} */ (box.querySelector('input'));
        count.value = String(readOptions(ui.getOptions()).cracks);
        const button = /** @type {HTMLButtonElement} */ (box.querySelector('button'));
        const onStrike = () => { trigger(canvas, 'impact'); };   // the impact: the pointer press on this button; a second strike breaks the pane
        const onCount = () => ui.setOptions({ cracks: Number(count.value) });
        button.addEventListener('click', onStrike);
        count.addEventListener('input', onCount);
        root.append(box);
        return () => { button.removeEventListener('click', onStrike); count.removeEventListener('input', onCount); box.remove(); };
      },
      destroy() {
        destroyed = true;
        fall.cancel();
        cracks.cancel();
        for (const resolve of waiters.splice(0)) resolve(null);
        if (settlers.get(canvas) === wait) settlers.delete(canvas);
        source.removeEventListener('submit', onSubmit);
        if (controllers.get(canvas) === request) controllers.delete(canvas);
        uniforms.destroy?.();
        vertexBuffer.destroy?.();
        frozen?.destroy?.();
      },
    };
  },
});

