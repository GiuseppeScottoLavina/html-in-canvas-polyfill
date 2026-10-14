/**
 * Disintegrate (effect plugin ABI v2): an EXAMPLE of the effects extension of html-in-canvas-polyfill, not part of the polyfill.
 * The drawn form burns away like paper: a ragged front sweeps out from the Submit button (or a side), scorching the form ahead of it with a
 * thin glowing edge and the air above it shimmering; behind it the form breaks into flakes that lift off in 3D, tumble, catch the light and
 * burn from their rims, and every pixel of text, border or control they lose becomes an ember. All of it samples the LIVE page every frame:
 * a running counter keeps counting and typed text keeps appearing on the flying flakes and embers. A camera above the page sees what rises
 * towards it larger and out of focus. Then it all plays in reverse, showing the form's new state. Shader: ./disintegrate.wgsl.
 *
 * A transition plugin: idle, it presents the source unchanged and its input mapper is the identity, so the form is fully usable. While pieces
 * move, are gone or fade, its mapper BLOCKS pointer input: it returns NO_TARGET (the effects ABI value for "no element here") for every point,
 * so the host swallows the press: nothing is focused or activated (../_lib/transition.js). Keyboard input is not mapped by the host and still
 * reaches the focused field.
 *
 * Triggers: `trigger(canvas, 'out' | 'in' | 'play', point?)` (exported), `handle.setOptions({ state: 'out' | 'in' })`, the Burn button of
 * mountUI, and, with `onSubmit`, the submit of the form inside the source. With prefers-reduced-motion the same triggers crossfade instead.
 */

import { wgsl } from './wgsl.js';
import { blockedMapper, clampNumber, createTimeline, DEFAULT_INVALID_SELECTOR, findInvalid, identityMapper, parseColor, sourcePointOnCanvas } from '../_lib/transition.js';

/** @typedef {import('../../src/contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../../src/contracts/types.js').EffectRenderFrame} EffectRenderFrame */

export { NO_TARGET, blockedMapper, createTimeline, findInvalid, identityMapper, parseColor } from '../_lib/transition.js';

/** What the plugin gallery and the build read (plugins/README.md). */
export const meta = Object.freeze({
  name: 'disintegrate',
  title: 'Disintegrate',
  description: 'The live form burns from the Submit button into 3D flakes and embers that keep showing it as it changes (a counter, typing), then re-forms in its new state.',
  defaults: Object.freeze({ duration: 3200, flakeSize: 28, onSubmit: 'valid', intro: true }),
  reducedMotion: 'With reduced motion the same triggers crossfade to the backdrop and back; nothing burns or moves.',
});

/** floats in the uniform block (disintegrate.wgsl `Uniforms`) */
export const UNIFORM_FLOATS = 40;
/** the camera's distance, in canvas sizes; how far flakes rise towards it, in canvas sizes; blur per css px out of the page plane */
export const CAMERA = Object.freeze({ distance: 2.4, lift: 0.34, dof: 0.012 });
const LIGHT = (() => { const v = [-0.3, -0.42, 1]; const l = Math.hypot(...v); return v.map((x) => x / l); })();
/** the ember grid grows its cells beyond this many embers (a 4K canvas at 1.5 px embers would be 3.7 million) */
export const MAX_PARTICLES = 262144;
/** g at which the front has crossed the whole canvas; then the last flakes still live LIFE, their last embers PLIFE */
export const FRONT_END = 0.45;
/** share of the timeline a flake lives from lifting off to gone */
export const LIFE = 0.5;
/** share of the timeline an ember lives */
export const PLIFE = 0.16;
/** the age at which a flake is consumed (FLAKE_END in disintegrate.wgsl): its last embers are born then */
export const FLAKE_END = 0.75;
const HOLD_MS = 250;
/** a pointer press younger than this is the origin of the fire of a submit */
const POINTER_MS = 1500;
/** the clear colour of the host's passthrough: an assembled frame is then identical to the frame without the plugin */
export const HOST_BACKDROP = Object.freeze([0.004, 0.018, 0.034]);
const DEFAULT_GLOW = Object.freeze([1, 0.62, 0.3]);

/** canvases where a device was lost: the plugin is created again on the new device without replaying its intro */
const lostOn = new WeakSet();
/** @type {WeakMap<HTMLCanvasElement, (action: 'out'|'in'|'play', point?: {x: number, y: number}|null) => Promise<boolean>>} */
const controllers = new WeakMap();

/**
 * Start a transition of the disintegrate plugin running on `canvas`.
 * @param {HTMLCanvasElement} canvas
 * @param {'out'|'in'|'play'} [action]  out: burn away and stay gone; in: re-form; play: out, a short pause, in
 * @param {{x: number, y: number}|null} [point]  where the fire starts, canvas css px (default: the last pointer press, else the `from` side)
 * @returns {Promise<boolean>}  true when that end state is reached; false when superseded, or when no instance runs on the canvas
 */
export function trigger(canvas, action = 'play', point = null) {
  const run = controllers.get(canvas);
  return run ? run(action, point) : Promise.resolve(false);
}

/**
 * The ember grid over the presented frame: square cells of `particleSize` css px (rounded to backing px), at most MAX_PARTICLES. PURE.
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
 * The flake grid (one Voronoi seed per cell of `flake` css px). PURE.
 * @param {number} cssWidth @param {number} cssHeight @param {number} flake
 */
export function flakeGrid(cssWidth, cssHeight, flake) {
  const cols = Math.max(1, Math.ceil(cssWidth / flake));
  const rows = Math.max(1, Math.ceil(cssHeight / flake));
  return { cols, rows, count: cols * rows };
}

/**
 * The origin of the fire in canvas css px: the point given (clamped to the canvas), else just outside a side of the canvas. Writes `out`. PURE.
 * @param {'left'|'right'|'top'|'bottom'} from @param {{x: number, y: number}|null} point @param {number} w @param {number} h
 * @param {{x: number, y: number}} [out]
 */
export function originFor(from, point, w, h, out = { x: 0, y: 0 }) {
  if (point) { out.x = Math.min(w, Math.max(0, point.x)); out.y = Math.min(h, Math.max(0, point.y)); }
  else if (from === 'right') { out.x = w * 1.08; out.y = h * 0.55; }
  else if (from === 'top') { out.x = w * 0.4; out.y = -h * 0.12; }
  else if (from === 'bottom') { out.x = w * 0.6; out.y = h * 1.12; }
  else { out.x = -w * 0.08; out.y = h * 0.45; }
  return out;
}

/**
 * How far the front travels: the distance from the origin to the nearest point of the canvas rectangle, and from there to its farthest corner. PURE.
 * @param {{x: number, y: number}} o @param {number} w @param {number} h
 */
export function frontSpan(o, w, h) {
  const dx = Math.max(0, -o.x, o.x - w), dy = Math.max(0, -o.y, o.y - h);
  const dmin = Math.hypot(dx, dy);
  const dmax = Math.max(Math.hypot(o.x, o.y), Math.hypot(o.x - w, o.y), Math.hypot(o.x, o.y - h), Math.hypot(o.x - w, o.y - h));
  return { dmin, dspan: Math.max(1, dmax - dmin) };
}

/**
 * The timing the shader relies on, as numbers (the twin of its age formulas). PURE.
 * @param {number} g  the dissolve amount
 * @param {number} gc  when a flake lifts, in [0, FRONT_END]
 * @returns {{flake: number, lastEmberBorn: number, lastEmberGone: number}}  the flake's age (0 on the paper, 1 gone) and when its embers end
 */
export function flakeTiming(g, gc) {
  const born = Math.min(gc + FLAKE_END * LIFE, 1 - PLIFE);
  return { flake: Math.min(1, Math.max(0, (g - gc) / LIFE)), lastEmberBorn: born, lastEmberGone: born + PLIFE };
}

/** @param {Readonly<Record<string, unknown>>} o */
export function readOptions(o) {
  const submit = o.onSubmit;
  const from = o.from;
  return {
    particleSize: clampNumber(o.particleSize, 1.5, 12, 2.5),
    flakeSize: clampNumber(o.flakeSize, 8, 64, 28),
    wind: clampNumber(o.wind, 0, 2, 1),
    direction: clampNumber(o.direction, -180, 180, -70),
    turbulence: clampNumber(o.turbulence, 0, 2, 1),
    duration: clampNumber(o.duration, 300, 8000, 3200),
    glow: parseColor(o.glow, DEFAULT_GLOW),
    glowAmount: clampNumber(o.glowAmount, 0, 1, 0.9),
    density: clampNumber(o.density, 0, 1, 0.5),
    backdrop: parseColor(o.backdrop, HOST_BACKDROP),
    from: /** @type {'left'|'right'|'top'|'bottom'} */ (from === 'right' || from === 'top' || from === 'bottom' ? from : 'left'),
    onSubmit: submit === 'valid' || submit === 'always' ? submit : 'off',
    invalidSelector: typeof o.invalidSelector === 'string' && o.invalidSelector ? o.invalidSelector : DEFAULT_INVALID_SELECTOR,
    intro: o.intro === true,
    /** null: follow prefers-reduced-motion */
    reducedMotion: typeof o.reducedMotion === 'boolean' ? o.reducedMotion : null,
    state: /** @type {'out'|'in'} */ (o.state === 'out' ? 'out' : 'in'),
    seed: clampNumber(o.seed, 0, 1000, 1),
    /** the plugin's controls show a running counter inside the form (it makes the liveness of the flakes visible) */
    liveCounter: o.liveCounter === true,
  };
}

/**
 * The uniform block of one frame (layout of `Uniforms` in disintegrate.wgsl). Writes into `data`, allocates nothing.
 * @param {Float32Array} data
 * @param {{width: number, height: number, cssWidth: number, cssHeight: number}} frame
 * @param {ReturnType<typeof readOptions>} s
 * @param {number} g
 * @param {{cell: number, cols: number}} grid  the ember grid
 * @param {{cols: number}} flakes  the flake grid
 * @param {{x: number, y: number}} origin  css px
 * @param {number} fade
 * @param {number} [time]  seconds since this phase of the transition started
 */
export function fillUniforms(data, frame, s, g, grid, flakes, origin, fade, time = 0) {
  const angle = (s.direction * Math.PI) / 180;
  const dx = Math.max(0, -origin.x, origin.x - frame.cssWidth), dy = Math.max(0, -origin.y, origin.y - frame.cssHeight);
  const dmin = Math.hypot(dx, dy);
  const ox = Math.max(Math.abs(origin.x), Math.abs(origin.x - frame.cssWidth)), oy = Math.max(Math.abs(origin.y), Math.abs(origin.y - frame.cssHeight));
  data[0] = frame.width; data[1] = frame.height; data[2] = frame.cssWidth; data[3] = frame.cssHeight;
  data[4] = g; data[5] = LIFE; data[6] = grid.cell; data[7] = grid.cols;
  data[8] = origin.x; data[9] = origin.y; data[10] = dmin; data[11] = Math.max(1, Math.hypot(ox, oy) - dmin);   // = frontSpan, without an object
  data[12] = Math.cos(angle); data[13] = Math.sin(angle);
  data[14] = 0.4 * Math.max(frame.cssWidth, frame.cssHeight) * s.wind; data[15] = s.turbulence;
  data[16] = s.flakeSize; data[17] = flakes.cols; data[18] = s.glowAmount; data[19] = fade;
  data[20] = s.seed; data[21] = FRONT_END; data[22] = PLIFE; data[23] = s.density;
  data[24] = s.backdrop[0]; data[25] = s.backdrop[1]; data[26] = s.backdrop[2]; data[27] = 1;
  data[28] = s.glow[0]; data[29] = s.glow[1]; data[30] = s.glow[2]; data[31] = 1;
  const size = Math.max(frame.cssWidth, frame.cssHeight);
  data[32] = time; data[33] = CAMERA.distance * size; data[34] = CAMERA.lift * size; data[35] = CAMERA.dof;
  data[36] = LIGHT[0]; data[37] = LIGHT[1]; data[38] = LIGHT[2]; data[39] = 0;
}

/** @param {Document} doc */
function injectUiStyle(doc) {
  if (doc.querySelector('style[data-hic-effect-style="disintegrate"]')) return;
  const style = doc.createElement('style');
  style.dataset.hicEffectStyle = 'disintegrate';
  style.textContent = `.hic-dis-ui{display:grid;grid-template-columns:auto 1fr 1fr;gap:4px 12px;align-items:end;font-size:11px;font-weight:700}`
    + `.hic-dis-ui label{display:grid}.hic-dis-ui input{width:100%;margin:0;accent-color:#ffb06b}.hic-dis-ui button{padding:7px 14px;font:inherit;border:0;border-radius:10px;cursor:pointer;color:#1b0d02;background:#ffb06b}`
    + `.hic-dis-live{grid-column:1/-1;display:flex;align-items:center;gap:12px;margin-top:4px}.hic-dis-live label{display:flex;align-items:center;gap:6px}.hic-dis-live input{width:15px;height:15px}`
    + `.hic-dis-counter{font:800 40px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.02em;font-variant-numeric:tabular-nums;color:#ffd7a8}.hic-dis-counter[hidden]{display:none}`;
  (doc.head || doc.documentElement).append(style);
}

/** @type {EffectPluginDefinition} */
export const plugin = Object.freeze({
  type: 'disintegrate',
  apiVersion: /** @type {const} */ (2),
  version: 2,
  // every pass only writes its destination as a same-format colour attachment (the blending of flakes and embers never samples it)
  outputCapabilities: Object.freeze({ directCanvasRenderAttachment: /** @type {const} */ (true) }),
  async create(context, initialOptions) {
    const { device, format, canvas, source } = context;
    const module = device.createShaderModule({ code: await wgsl('disintegrate.wgsl') });
    const g = /** @type {any} */ (globalThis);
    const S = g.GPUShaderStage;
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: S.VERTEX | S.FRAGMENT | S.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: S.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: S.VERTEX | S.FRAGMENT | S.COMPUTE, texture: { sampleType: 'float' } },   // embers read their live pixel
      ],
    });
    // the embers: written by cs_embers once per phase of a transition, read by vs_ember every frame
    const emberWrite = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: S.COMPUTE, buffer: { type: 'storage' } }] });
    const emberRead = device.createBindGroupLayout({ entries: [{ binding: 1, visibility: S.VERTEX, buffer: { type: 'read-only-storage' } }] });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const blend = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
    /** @param {string} vs @param {string} fs @param {string} target @param {any} [withBlend] @param {any} [withLayout] */
    const pipeline = (vs, fs, target, withBlend, withLayout = pipelineLayout) => device.createRenderPipeline({
      layout: withLayout,
      vertex: { module, entryPoint: vs },
      fragment: { module, entryPoint: fs, targets: [{ format: target, ...(withBlend ? { blend: withBlend } : {}) }] },
      primitive: { topology: 'triangle-list' },
    });
    const full = pipeline('vs_full', 'fs_full', format);
    const paper = pipeline('vs_full', 'fs_base', format);
    const flakes = pipeline('vs_flake', 'fs_flake', format, blend);
    const embers = pipeline('vs_ember', 'fs_ember', format, blend, device.createPipelineLayout({ bindGroupLayouts: [layout, emberRead] }));
    const birth = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout, emberWrite] }), compute: { module, entryPoint: 'cs_embers' } });
    /** @type {any} */ let emberBuffer = null;
    /** @type {any} */ let emberWriteGroup = null;
    /** @type {any} */ let emberReadGroup = null;
    /** what the embers in emberBuffer were made from: recomputed when any of it changes */
    const made = { view: /** @type {any} */ (null), version: -1, x: NaN, y: NaN, grid: /** @type {any} */ (null), flakes: /** @type {any} */ (null), options: -1 };
    let optionsSerial = 0;
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
    let flakeCells = flakeGrid(1, 1, s.flakeSize);
    const gridOf = [1, 1, 1, s.particleSize, s.flakeSize];   // width, height, dpr, particleSize, flakeSize the grids were made for
    let assembledFrame = true;           // what the LAST rendered frame showed: its mapper is fixed by it
    /** where the fire of the current transition starts (css px); `set` false: just outside the `from` side */
    const origin = { x: 0, y: 0, set: false };
    const fire = { x: 0, y: 0 };
    /** @type {{x: number, y: number, t: number}} */ const pointer = { x: 0, y: 0, t: -Infinity };
    /**
     * Make the embers of this picture, origin and grid with one compute pass ahead of the frame's render pass, when anything they depend on
     * changed (a new phase of the transition, a page update during the way back, a resize, new options). Allocates only when the grid grows.
     * @param {any} encoder @param {any} group @param {any} view @param {number} version
     */
    function makeEmbers(encoder, group, view, version) {
      if (made.view === view && made.version === version && made.x === fire.x
        && made.y === fire.y && made.grid === grid && made.flakes === flakeCells && made.options === optionsSerial) return;
      if (!emberBuffer || emberBuffer.size < grid.count * 32) {
        emberBuffer?.destroy?.();
        emberBuffer = device.createBuffer({ size: Math.max(32, grid.count * 32), usage: g.GPUBufferUsage.STORAGE });
        emberWriteGroup = device.createBindGroup({ layout: emberWrite, entries: [{ binding: 0, resource: { buffer: emberBuffer } }] });
        emberReadGroup = device.createBindGroup({ layout: emberRead, entries: [{ binding: 1, resource: { buffer: emberBuffer } }] });
      }
      const pass = encoder.beginComputePass();
      pass.setPipeline(birth); pass.setBindGroup(0, group); pass.setBindGroup(1, emberWriteGroup);
      pass.dispatchWorkgroups(Math.ceil(grid.count / 64));
      pass.end();
      made.view = view; made.version = version; made.x = fire.x; made.y = fire.y;
      made.grid = grid; made.flakes = flakeCells; made.options = optionsSerial;
    }

    /** @param {'out'|'in'|'play'} action @param {{x: number, y: number}|null} [point] */
    function request(action, point = null) {
      if (action !== 'out' && action !== 'in' && action !== 'play') return Promise.reject(new TypeError('disintegrate: unknown action ' + action));
      if (destroyed) return Promise.resolve(false);
      if (action !== 'in' && timeline.assembled) {
        const recent = performance.now() - pointer.t < POINTER_MS;
        const at = point ?? (recent ? pointer : null);
        origin.set = !!at;
        if (at) { origin.x = at.x; origin.y = at.y; }
      }
      crossfade = s.reducedMotion ?? !!media?.matches;
      const done = timeline.request(action);
      context.requestRender();
      return done;
    }
    controllers.set(canvas, request);
    if (timeline.phase === 'gone' && s.state === 'in') request('in');   // the intro: re-form from ash once the first snapshot is there

    context.listen('pointerdown', (event) => {
      const e = /** @type {PointerEvent} */ (event);
      const r = canvas.getBoundingClientRect();
      pointer.x = e.clientX - r.left - canvas.clientLeft;
      pointer.y = e.clientY - r.top - canvas.clientTop;
      pointer.t = performance.now();
    });
    const onSubmit = (/** @type {Event} */ event) => {
      if (s.onSubmit === 'off' || !timeline.assembled) return;
      if (s.onSubmit === 'valid' && findInvalid(source, s.invalidSelector)) return;
      // the fire starts where the user pressed (the Submit button), else at the button that submitted (the Enter key), else at the side
      const submitter = /** @type {any} */ (event).submitter;
      const recent = performance.now() - pointer.t < POINTER_MS;
      const at = !recent && submitter?.getBoundingClientRect
        ? sourcePointOnCanvas(source.getBoundingClientRect(), submitter.getBoundingClientRect(), { width: canvas.clientWidth, height: canvas.clientHeight }) : null;
      request('play', at);
    };
    source.addEventListener('submit', onSubmit);
    device.lost?.then?.(() => { if (!destroyed) lostOn.add(canvas); });

    return {
      spatial: true,                      // pieces move: the host requires a mapper (identity when assembled, blocking otherwise)
      get continuous() { return timeline.animating; },
      setOptions(next) {
        s = readOptions(next ?? {});
        optionsSerial += 1;
        timeline.setDuration(s.duration);
        if (s.state !== stateOption) { stateOption = s.state; request(s.state); }
        context.requestRender();
      },
      render(/** @type {EffectRenderFrame} */ frame) {
        const amount = frame.sourceReady ? timeline.advance(frame.now) : timeline.g;
        assembledFrame = timeline.assembled;
        if (gridOf[0] !== frame.width || gridOf[1] !== frame.height || gridOf[2] !== frame.dpr || gridOf[3] !== s.particleSize || gridOf[4] !== s.flakeSize) {
          gridOf[0] = frame.width; gridOf[1] = frame.height; gridOf[2] = frame.dpr; gridOf[3] = s.particleSize; gridOf[4] = s.flakeSize;
          grid = particleGrid(frame.width, frame.height, frame.dpr, s.particleSize);
          flakeCells = flakeGrid(frame.cssWidth, frame.cssHeight, s.flakeSize);
        }
        originFor(s.from, origin.set ? origin : null, frame.cssWidth, frame.cssHeight, fire);
        const fade = assembledFrame ? 1 : crossfade ? 1 - amount : 1;
        // the time of the shimmer: a function of g (so a frame at a given instant is the same at any frame cap)
        fillUniforms(data, frame, s, amount, grid, flakeCells, fire, fade, (amount * s.duration) / 1000);
        device.queue.writeBuffer(uniforms, 0, data);
        attachment.view = frame.destinationView;
        attachment.clearValue.r = s.backdrop[0]; attachment.clearValue.g = s.backdrop[1]; attachment.clearValue.b = s.backdrop[2];
        passDescriptor.timestampWrites = frame.profiling?.timestampWrites?.('disintegrate');
        // the live page: every frame samples the source as it is now (a counter, typed text keep changing on the flakes and embers)
        const picture = frame.sourceView;
        const group = groupFor(picture);
        const burning = frame.sourceReady && !assembledFrame && !crossfade && amount < 1;
        if (burning) makeEmbers(frame.encoder, group, picture, frame.sourceVersion ?? -1);
        const pass = frame.encoder.beginRenderPass(passDescriptor);
        if (frame.sourceReady) {
          pass.setBindGroup(0, group);
          if (assembledFrame || crossfade) { pass.setPipeline(full); pass.draw(3); }
          else if (burning) {
            pass.setPipeline(paper); pass.draw(3);
            pass.setPipeline(flakes); pass.draw(6, flakeCells.count);
            pass.setPipeline(embers); pass.setBindGroup(1, emberReadGroup); pass.draw(3, grid.count);
          }
        }
        pass.end();
      },
      // the mapper of the frame just presented: two constant functions, so it is frozen by construction
      captureInputMapper() { return assembledFrame ? identityMapper : blockedMapper; },
      mountUI(root, ui) {
        const doc = root.ownerDocument;
        const win2 = /** @type {any} */ (doc.defaultView);
        injectUiStyle(doc);
        const box = doc.createElement('div');
        box.className = 'hic-dis-ui';
        box.innerHTML = '<button type="button">Burn</button><label>Flake size<input type="range" min="10" max="48" step="2"></label><label>Wind<input type="range" min="0" max="200" step="5"></label>'
          + '<div class="hic-dis-live"><label><input type="checkbox"> Live counter</label><output class="hic-dis-counter" aria-label="A counter that keeps running while the form burns"></output></div>';
        const [size, wind, live] = /** @type {NodeListOf<HTMLInputElement>} */ (box.querySelectorAll('input'));
        const counter = /** @type {HTMLOutputElement} */ (box.querySelector('output'));
        const o = readOptions(ui.getOptions());
        size.value = String(o.flakeSize);
        wind.value = String(Math.round(o.wind * 100));
        live.checked = o.liveCounter;
        // live content inside the form: a stopwatch that keeps running while the form burns, so the flakes show it changing
        let timer = 0, t0 = 0;
        const show = () => {
          const t = (performance.now() - t0) / 1000;
          counter.value = `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}`;
        };
        const sync = () => {
          if (timer) { win2?.clearInterval?.(timer); timer = 0; }
          counter.hidden = !live.checked;
          if (live.checked) { t0 = performance.now(); show(); timer = win2?.setInterval?.(show, 50) ?? 0; }
        };
        const onBurn = () => { trigger(canvas, 'play'); };   // the fire starts at the pointer press on this button
        const onSize = () => ui.setOptions({ flakeSize: Number(size.value) });
        const onWind = () => ui.setOptions({ wind: Number(wind.value) / 100 });
        const onLive = () => { ui.setOptions({ liveCounter: live.checked }); sync(); };
        const button = /** @type {HTMLButtonElement} */ (box.querySelector('button'));
        button.addEventListener('click', onBurn);
        size.addEventListener('input', onSize);
        wind.addEventListener('input', onWind);
        live.addEventListener('change', onLive);
        root.append(box);
        sync();
        return () => {
          if (timer) win2?.clearInterval?.(timer);
          button.removeEventListener('click', onBurn);
          size.removeEventListener('input', onSize);
          wind.removeEventListener('input', onWind);
          live.removeEventListener('change', onLive);
          box.remove();
        };
      },
      destroy() {
        destroyed = true;
        timeline.cancel();
        source.removeEventListener('submit', onSubmit);
        if (controllers.get(canvas) === request) controllers.delete(canvas);
        uniforms.destroy?.();
        emberBuffer?.destroy?.();
      },
    };
  },
});
