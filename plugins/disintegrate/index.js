/**
 * Disintegrate (effect plugin ABI v2): an EXAMPLE of the effects extension of html-in-canvas-polyfill, not part of the polyfill.
 * The CONTENT of the page turns to dust and blows away while the page itself stays: text, field borders and fills, buttons, icons, every
 * pixel that differs from the background around it. An organic front sweeps across it (the content heats, goes porous, then is gone), and
 * each eroded cell becomes a grain of dust of its own LIVE colour. A compute pass carries every grain through a three-dimensional curl-noise
 * wind (coherent swirls), seen in perspective: grains that rise towards the viewer grow, cross the screen faster and go out of focus,
 * grains that sink shrink and dim; some leave as flakes that crumble on the way, all are drawn as analytically antialiased, motion-blurred
 * specks. Then the dust flies back and settles into the letters and fields of the page as it is now. Nothing is frozen: a running counter,
 * typed text and a success line are what the dust shows and what re-forms. Shader: ./disintegrate.wgsl.
 *
 * A transition plugin: idle, it presents the source unchanged and its input mapper is the identity, so the form is fully usable. While
 * anything moves, is gone or fades, its mapper BLOCKS pointer input: it returns NO_TARGET (the effects ABI value for "no element here") for
 * every point, so the host swallows the press: nothing is focused or activated (../_lib/transition.js). Keyboard input is not mapped by the
 * host and still reaches the focused field.
 *
 * Actions (the effect handle: `handle.trigger('out' | 'in' | 'play' | 'demo')`, `handle.settled()`; states 'in' and 'out'), also run by
 * the "Turn to dust" button of mountUI and, with `onSubmit`, by the submit of the form inside the source; `handle.setOptions({ state })`
 * sets the end state declaratively. 'demo' is a play that the user can interrupt: a press, a key, a submit or setOptions during it
 * re-forms the page at once.
 * With prefers-reduced-motion the same actions crossfade the content, and 'demo' resolves at once.
 * At rest (assembled or gone, nothing moving) the plugin is not `continuous` and requests no frame: the host renders nothing.
 */

import { wgsl } from './wgsl.js';
import { blockedMapper, clampNumber, createTimeline, DEFAULT_INVALID_SELECTOR, findInvalid, identityMapper, parseColor } from '../_lib/transition.js';
import { injectStyle } from '../_lib/ui.js';
import { hdrConstants } from '../_lib/hdr.js';

/** @typedef {import('../../src/contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../../src/contracts/types.js').EffectRenderFrame} EffectRenderFrame */

export { NO_TARGET, blockedMapper, createTimeline, findInvalid, identityMapper, parseColor } from '../_lib/transition.js';

/**
 * What the plugin gallery and the build read (plugins/README.md).
 * @experimental an example plugin of the effects, an extension of this library, not part of the HTML-in-Canvas standard (docs/STABILITY.md)
 */
export const meta = Object.freeze({
  name: 'disintegrate',
  title: 'Disintegrate',
  description: 'The live content turns to dust of its own colours, swirling away in depth while the page stays, then flies back into its new state. On Submit.',
  defaults: Object.freeze({ onSubmit: 'valid', intro: true }),
  reducedMotion: 'With reduced motion the same actions fade the content into the page and back; nothing moves, and the demo is skipped.',
});

/** floats in the uniform block (disintegrate.wgsl `Uniforms`) */
export const UNIFORM_FLOATS = 40;
/** at most this many dust cells (a 4K canvas at 1.5 css px would be 3.7 million; the cells grow beyond) */
export const MAX_GRAINS = 420000;
/** g at which every pixel of content has eroded; every grain lives from its birth until g = LIFE (all is gone then, none sooner) */
export const SWEEP_END = 0.5;
export const LIFE = 1;
/** css px per texel of the background estimate */
export const BG_CELL = 8;
/** the empty beat of 'play' and 'demo': the dust has dissolved completely, the page shows without its content for this long, then it re-forms */
export const HOLD_MS = 450;
/** ms the way out of 'play' and 'demo' is longer than `duration`: the dust has time to drift away and fade out entirely before the beat */
export const ROUND_EXIT_MS = 400;
/** the clear colour of the host's passthrough: an assembled frame is then identical to the frame without the plugin */
export const HOST_BACKDROP = Object.freeze([0.004, 0.018, 0.034]);
/** the colour of the heat at the eroding front and of the grains that just left it (a warm ember) */
export const GLOW_COLOUR = Object.freeze([1, 0.68, 0.4]);
/** bytes of one grain record (cs_grains writes it, vs_dust reads it as two instance attributes) */
export const GRAIN_BYTES = 24;
/** compute workgroup size of cs_grains */
export const WORKGROUP = 256;
/** where the intro starts on its way back (g): from g = 1 down to here the dust of a way back is faded out or still outside the canvas (every
 *  grain fades in over the last third of its flight), so the intro skips that stretch and its first frame already shows the dust in view and
 *  moving, at the speed of every way back (measured on the gallery form: at g = 0.95 the dust covers 0.25 % of the background, at 0.85 about
 *  7.5 %, 80 % of its peak) */
export const INTRO_FROM = 0.85;
/** ms of the way back when a user takes over a demo (a press or a key re-forms the page at once) */
export const TAKEOVER_MS = 450;
/** ms of exposure of the motion blur (fixed, so that a frame looks the same at every frame cap) */
export const SHUTTER_MS = 5;

/** The actions of `handle.trigger`: out turns the content to dust and leaves it gone, in re-forms it, play does both, demo is a play that
 *  user input interrupts (the gallery runs it when the effect is picked). */
export const ACTIONS = Object.freeze(/** @type {const} */ (['out', 'in', 'play', 'demo']));

/** canvases where a device was lost: the plugin is created again on the new device without replaying its intro */
const lostOn = new WeakSet();

/**
 * The dust grid over the page: square cells of `size` css px, at most MAX_GRAINS (cells grow beyond). PURE.
 * @param {number} cssWidth @param {number} cssHeight @param {number} size
 */
export function dustGrid(cssWidth, cssHeight, size) {
  let cell = size;
  while (Math.ceil(cssWidth / cell) * Math.ceil(cssHeight / cell) > MAX_GRAINS) cell *= 1.1;
  const cols = Math.ceil(cssWidth / cell);
  const rows = Math.ceil(cssHeight / cell);
  return { cell, cols, rows, count: cols * rows };
}

/** The size of the background estimate for a page (texels of BG_CELL css px). PURE. @param {number} cssWidth @param {number} cssHeight */
export const bgSize = (cssWidth, cssHeight) => [Math.max(1, Math.ceil(cssWidth / BG_CELL)), Math.max(1, Math.ceil(cssHeight / BG_CELL))];

/**
 * The sweep across the page: its unit direction and the range of dot(corner, direction) over the corners. PURE.
 * @param {number} angle  degrees (0 = to the right, 90 = down)
 * @param {number} w @param {number} h
 */
export function sweepOf(angle, w, h) {
  const a = (angle * Math.PI) / 180;
  const x = Math.cos(a), y = Math.sin(a);
  const d = [0, x * w, y * h, x * w + y * h];
  const lo = Math.min(...d), hi = Math.max(...d);
  return { x, y, min: lo, span: Math.max(1, hi - lo) };
}

/** @param {Readonly<Record<string, unknown>>} o */
export function readOptions(o) {
  const submit = o.onSubmit;
  return {
    duration: clampNumber(o.duration, 300, 8000, 1800),
    durationIn: clampNumber(o.durationIn, 300, 8000, 1200),
    particleSize: clampNumber(o.particleSize, 1, 4, 1.25),
    wind: clampNumber(o.wind, 0, 2, 1),
    direction: clampNumber(o.direction, -180, 180, -28),
    sweep: clampNumber(o.sweep, -180, 180, 24),
    turbulence: clampNumber(o.turbulence, 0, 2, 1),
    fragments: clampNumber(o.fragments, 0, 1, 0.3),
    sensitivity: clampNumber(o.sensitivity, 0, 1, 0.5),
    depth: clampNumber(o.depth, 0, 1, 0.7),
    glow: clampNumber(o.glow, 0, 1, 0.65),
    glowColor: parseColor(o.glowColor, GLOW_COLOUR),
    focus: clampNumber(o.focus, 0, 2, 1),
    density: clampNumber(o.density, 0.05, 1, 1),
    backdrop: parseColor(o.backdrop, HOST_BACKDROP),
    onSubmit: submit === 'valid' || submit === 'always' ? submit : 'off',
    invalidSelector: typeof o.invalidSelector === 'string' && o.invalidSelector ? o.invalidSelector : DEFAULT_INVALID_SELECTOR,
    intro: o.intro === true,
    /** null: follow prefers-reduced-motion */
    reducedMotion: typeof o.reducedMotion === 'boolean' ? o.reducedMotion : null,
    state: /** @type {'out'|'in'} */ (o.state === 'out' ? 'out' : 'in'),
    seed: clampNumber(o.seed, 0, 1000, 1),
    /** the plugin's controls show a running counter inside the form (it makes the liveness of the dust visible) */
    liveCounter: o.liveCounter === true,
  };
}

/**
 * The uniform block of one frame (layout of `Uniforms` in disintegrate.wgsl). Writes into `data`, allocates nothing.
 * @param {Float32Array} data
 * @param {{width: number, height: number, cssWidth: number, cssHeight: number}} frame
 * @param {ReturnType<typeof readOptions>} s
 * @param {number} g  the dissolve amount
 * @param {{cell: number, cols: number, count?: number}} grid  the dust grid
 * @param {number} fade  1: the source; < 1: the reduced-motion crossfade (share of content still shown)
 * @param {number} [time]  seconds (a function of g)
 * @param {boolean} [turning]  the dust does not fade out towards g = 1 (the plugin always lets it fade: a play's dust leaves entirely before its return)
 */
export function fillUniforms(data, frame, s, g, grid, fade, time = 0, turning = false) {
  const sw = sweepOf(s.sweep, frame.cssWidth, frame.cssHeight);
  const wind = (s.direction * Math.PI) / 180;
  data[0] = frame.width; data[1] = frame.height; data[2] = frame.cssWidth; data[3] = frame.cssHeight;
  data[4] = g; data[5] = fade; data[6] = grid.cell; data[7] = grid.cols;
  data[8] = sw.x; data[9] = sw.y; data[10] = sw.min; data[11] = sw.span;
  data[12] = Math.cos(wind); data[13] = Math.sin(wind);
  data[14] = 0.27 * Math.max(frame.cssWidth, frame.cssHeight) * s.wind; data[15] = s.turbulence;
  data[16] = time; data[17] = s.seed; data[18] = SWEEP_END; data[19] = LIFE;
  data[20] = s.fragments; data[21] = BG_CELL;
  // the colour distance from the background where content starts and where it is full content (sensitivity 0.5: 0.05 .. 0.14)
  data[22] = 0.09 - 0.08 * s.sensitivity; data[23] = data[22] + 0.09;
  data[24] = s.backdrop[0]; data[25] = s.backdrop[1]; data[26] = s.backdrop[2]; data[27] = 1;
  data[28] = turning ? 0 : 1; data[29] = s.depth; data[30] = s.glow; data[31] = 1.8 * Math.max(frame.cssWidth, frame.cssHeight);
  data[32] = s.glowColor[0]; data[33] = s.glowColor[1]; data[34] = s.glowColor[2]; data[35] = s.focus;
  data[36] = grid.count ?? 0; data[37] = SHUTTER_MS / s.duration; data[38] = s.density; data[39] = 0;
}

/** CSS of the plugin UI (mountUI) */
const UI_CSS = `.hic-dis-ui{display:grid;grid-template-columns:auto 1fr 1fr;gap:4px 12px;align-items:end;font-size:11px;font-weight:700}`
    + `.hic-dis-ui label{display:grid}.hic-dis-ui input{width:100%;margin:0;accent-color:#ffb06b}.hic-dis-ui button{padding:7px 14px;font:inherit;border:0;border-radius:10px;cursor:pointer;color:#1b0d02;background:#ffb06b}`
    + `.hic-dis-live{grid-column:1/-1;display:flex;align-items:center;gap:12px;margin-top:4px}.hic-dis-live label{display:flex;align-items:center;gap:6px}.hic-dis-live input{width:15px;height:15px}`
    + `.hic-dis-counter{font:800 40px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.02em;font-variant-numeric:tabular-nums;color:#ffd7a8}.hic-dis-counter[hidden]{display:none}`;

/**
 * The plugin's definition (effect plugin ABI v2).
 * @experimental an example plugin of the effects, an extension of this library, not part of the HTML-in-Canvas standard (docs/STABILITY.md)
 * @type {EffectPluginDefinition}
 */
export const plugin = Object.freeze({
  type: 'disintegrate',
  apiVersion: /** @type {const} */ (2),
  version: 6,
  // every pass that touches the destination only writes it as a same-format colour attachment (the dust's blending never samples it)
  outputCapabilities: Object.freeze({ directCanvasRenderAttachment: /** @type {const} */ (true) }),
  actions: ACTIONS,
  async create(context, initialOptions) {
    const { device, format, canvas, source } = context;
    const module = device.createShaderModule({ code: await wgsl('disintegrate.wgsl') });
    const g = /** @type {any} */ (globalThis);
    const S = g.GPUShaderStage, TU = g.GPUTextureUsage, BU = g.GPUBufferUsage;
    const all = S.VERTEX | S.FRAGMENT | S.COMPUTE;
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: all, buffer: { type: 'uniform' } },
        { binding: 1, visibility: all, sampler: { type: 'filtering' } },
        { binding: 2, visibility: all, texture: { sampleType: 'float' } },   // the live page (the dust reads its pixel)
        { binding: 3, visibility: all, texture: { sampleType: 'float' } },   // the background estimate
      ],
    });
    // the grain records: written by the compute pass, read by the dust pass as its instance vertex buffer
    const grainLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: S.COMPUTE, buffer: { type: 'storage' } }] });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    // premultiplied: the grain's colour times its coverage over the page, plus the light it emits (heat, glints)
    const blend = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
    };
    // extended range (context.hdr): nothing of this effect goes above white (disintegrate.wgsl says why). The shaders that draw the transition
    // read HDR_PEAK and clamp what they write, and one more draw clamps the sum of the grains (`whiten`, made only with extended range)
    const constants = hdrConstants(context);
    /** @param {string} vs @param {string} fs @param {string} target @param {any} [withBlend] @param {string} [topology] @param {any[]} [buffers] @param {boolean} [clamps]  the fragment shader reads HDR_PEAK */
    const pipeline = (vs, fs, target, withBlend, topology = 'triangle-list', buffers = [], clamps = false) => device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: vs, buffers },
      fragment: { module, entryPoint: fs, targets: [{ format: target, ...(withBlend ? { blend: withBlend } : {}) }], ...(clamps ? { constants } : {}) },
      primitive: { topology },
    });
    const full = pipeline('vs_full', 'fs_full', format);
    const base = pipeline('vs_full', 'fs_base', format, undefined, 'triangle-list', [], true);
    const dust = pipeline('vs_dust', 'fs_dust', format, blend, 'triangle-strip', [{
      arrayStride: GRAIN_BYTES, stepMode: 'instance',
      attributes: [{ shaderLocation: 0, offset: 0, format: 'uint32x4' }, { shaderLocation: 1, offset: 16, format: 'uint32x2' }],
    }], true);
    const atMost = { operation: 'min', srcFactor: 'one', dstFactor: 'one' };
    const whiten = constants.HDR_PEAK > 1 ? pipeline('vs_full', 'fs_white', format, { color: atMost, alpha: atMost }) : null;
    const grainsPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout, grainLayout] }),
      compute: { module, entryPoint: 'cs_grains' },
    });
    const down = pipeline('vs_full', 'fs_down', 'rgba8unorm');
    const estimate = pipeline('vs_full', 'fs_bg', 'rgba8unorm');
    const uniforms = device.createBuffer({ size: UNIFORM_FLOATS * 4, usage: BU.UNIFORM | BU.COPY_DST });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const data = new Float32Array(UNIFORM_FLOATS);
    // the pass descriptors are reused: a frame writes their fields, it allocates nothing of its own
    const attachment = { view: /** @type {any} */ (null), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } };
    const passDescriptor = { colorAttachments: [attachment], timestampWrites: /** @type {any} */ (undefined) };
    const computeDescriptor = { timestampWrites: /** @type {any} */ (undefined) };
    const bgAttachment = { view: /** @type {any} */ (null), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } };
    const bgPass = { colorAttachments: [bgAttachment] };

    // the background estimate: the source averaged into cells (down), then the dominant colour around each cell (bg); per size
    /** @type {any} */ let est = null;
    function estimateFor(/** @type {number} */ w, /** @type {number} */ h) {
      const [bw, bh] = bgSize(w, h);
      if (est && est.w === bw && est.h === bh) return est;
      est?.down.destroy?.(); est?.bg.destroy?.();
      const make = () => device.createTexture({ size: [bw, bh], format: 'rgba8unorm', usage: TU.TEXTURE_BINDING | TU.RENDER_ATTACHMENT });
      const t = { w: bw, h: bh, down: make(), bg: make(), downView: /** @type {any} */ (null), bgView: /** @type {any} */ (null), groups: new WeakMap(), version: -1, view: /** @type {any} */ (null) };
      t.downView = t.down.createView(); t.bgView = t.bg.createView();
      est = t;
      return t;
    }
    /** bind groups per source view: [down pass, estimate pass, frame] (the host may replace the source texture on resize) */
    function groupsFor(/** @type {any} */ t, /** @type {any} */ view) {
      let gs = t.groups.get(view);
      if (!gs) {
        const make = (/** @type {any} */ bgView) => device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniforms } }, { binding: 1, resource: sampler }, { binding: 2, resource: view }, { binding: 3, resource: bgView }] });
        gs = { down: make(t.bgView), estimate: make(t.downView), frame: make(t.bgView) };
        t.groups.set(view, gs);
      }
      return gs;
    }
    // the grain records of the current dust grid, made at the first frame that draws dust (none while the page has never moved)
    /** @type {{count: number, buffer: any, group: any}|null} */ let records = null;
    function recordsFor(/** @type {number} */ count) {
      if (records && records.count === count) return records;
      records?.buffer.destroy?.();
      const buffer = device.createBuffer({ size: Math.max(1, count) * GRAIN_BYTES, usage: BU.STORAGE | BU.VERTEX });
      records = { count, buffer, group: device.createBindGroup({ layout: grainLayout, entries: [{ binding: 0, resource: { buffer } }] }) };
      return records;
    }

    const win = /** @type {any} */ (canvas.ownerDocument.defaultView);
    const media = win?.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
    let s = readOptions(initialOptions ?? {});
    const recovering = lostOn.has(canvas);
    lostOn.delete(canvas);
    const timeline = createTimeline({ duration: s.duration, hold: HOLD_MS, gone: s.state === 'out' || (s.intro && !recovering) });
    let stateOption = s.state;
    let crossfade = false;
    let destroyed = false;
    let grid = dustGrid(1, 1, s.particleSize);
    const gridOf = [1, 1, s.particleSize];
    let assembledFrame = true;           // what the LAST rendered frame showed: its mapper is fixed by it
    let optionsSerial = 0, estimated = -1, estimatedAt = -Infinity;
    /** the play in progress: its promise, whether its way back has started, and whether it is a demo (user input interrupts it); a play
     *  runs out (the dust drifts away and fades out entirely), shows the empty page for HOLD_MS, then re-forms. `from`: g when it started
     *  (its way out is the rest of a full one: a play from a page already gone goes straight to the beat) */
    /** @type {{resolve: (done: boolean) => void, back: boolean, start: number, demo: boolean, leg: number, from: number}|null} */ let playing = null;
    /** the intro was asked for and has rendered no frame yet: nothing of the page has been shown */
    let introPending = false;
    const roundOut = () => s.duration + ROUND_EXIT_MS;

    /** the end state: 'out' (dissolved, gone) or 'in' (assembled) */
    const resting = () => (timeline.phase === 'gone' ? 'out' : 'in');
    const inMotion = () => timeline.animating || playing !== null;
    /** @type {((state: string|null) => void)[]} */ const waiters = [];

    /** @param {'out'|'in'|'play'|'demo'} action @param {boolean} [reduced]  prefers-reduced-motion as the host read it */
    function request(action, reduced) {
      if (destroyed) return Promise.resolve(false);
      const calm = s.reducedMotion ?? reduced ?? !!media?.matches;
      // reduced motion: the demo is skipped (it only shows what the effect does); the page stays as it is
      if (action === 'demo' && calm) return Promise.resolve(true);
      crossfade = calm;
      const round = action === 'play' || action === 'demo';
      // a round trip asked for before the intro showed anything (the gallery plays the demo as soon as the effect is added): it starts from
      // the page itself, not from an empty page that would first have to wait for a way out with nothing to take out
      if (round && introPending) timeline.jump('in');
      introPending = false;
      // the way out and the way back have their own lengths (the timeline takes the length of a run when the run starts), so a play is
      // run here as an 'out', the empty beat, then an 'in'
      timeline.setDuration(action === 'in' ? s.durationIn : round ? roundOut() : s.duration);
      if (playing) { const p = playing; playing = null; p.resolve(false); }   // a new request supersedes a play
      const run = timeline.request(round ? 'out' : /** @type {'out'|'in'} */ (action));
      context.requestRender();
      if (!round) return run;
      /** @type {(done: boolean) => void} */ let resolve = () => {};
      const done = new Promise((r) => { resolve = /** @type {(done: boolean) => void} */ (r); });
      const play = { resolve, back: false, start: NaN, demo: action === 'demo', leg: 0, from: timeline.g };
      playing = play;
      run.then((ok) => { if (!ok && playing === play && !play.back) { playing = null; resolve(false); } });
      return done;
    }
    /** the way back of a play: from where the dust is now, at `ms` for a full run; the play's promise follows it */
    function goBack(/** @type {NonNullable<typeof playing>} */ play, /** @type {number} */ ms) {
      play.back = true;
      const leg = ++play.leg;   // a faster way back (a user taking over) replaces this one without ending the play
      timeline.setDuration(ms);
      timeline.request('in').then((ok) => { if (play.leg !== leg) return; if (playing === play) playing = null; play.resolve(ok); });
    }
    // the intro: re-form from dust once the first snapshot is there, from INTRO_FROM (its first frame shows the dust, see render)
    if (timeline.phase === 'gone' && s.state === 'in') { request('in'); introPending = true; }

    const onSubmit = () => {
      if (playing?.demo) { takeOver(); return; }   // a submit during the demo: the user takes over (the page re-forms at once)
      if (s.onSubmit === 'off' || !timeline.assembled) return;
      if (s.onSubmit === 'valid' && findInvalid(source, s.invalidSelector)) return;
      context.trigger('play');   // through the host, like handle.trigger: it supersedes a pending trigger of the page
    };
    // a demo gives way to the user at once: a press (mouse, pen, finger), a key, a submit or new options re-form the page fast, from where
    // the dust is
    function takeOver() {
      const play = playing;
      if (!play || !play.demo || play.back && timeline.phase !== 'in' || destroyed) return;
      goBack(play, TAKEOVER_MS);
      context.requestRender();
    }
    source.addEventListener('submit', onSubmit);
    // passive: the plugin never claims a gesture (it has no handle to grab); the page keeps its scrolling and the form its input
    context.listen('pointerdown', takeOver, { passive: true });
    context.listen('keydown', takeOver);
    device.lost?.then?.(() => { if (!destroyed) lostOn.add(canvas); });

    return {
      spatial: true,                      // pixels move: the host requires a mapper (identity when assembled, blocking otherwise)
      // (also during the empty beat of a play: nothing moves, but its clock runs)
      get continuous() { return timeline.animating || (playing !== null && !playing.back); },
      setOptions(next) {
        s = readOptions(next ?? {});
        optionsSerial += 1;
        if (s.state !== stateOption) { stateOption = s.state; request(s.state); } else takeOver();
        context.requestRender();
      },
      runAction(action, _options, info) {
        return request(/** @type {'out'|'in'|'play'|'demo'} */ (action), info.reducedMotion).then((done) => (done ? resting() : null));
      },
      settled() { return inMotion() ? new Promise((resolve) => { waiters.push(resolve); }) : resting(); },
      render(/** @type {EffectRenderFrame} */ frame) {
        // the intro's clock starts at its first ready frame, as if it had started (1 - INTRO_FROM) of a way back earlier: the same path at the
        // same speed as any way back, without the stretch where its dust is not in view yet (the reduced-motion crossfade starts at 0)
        if (introPending && frame.sourceReady) {
          introPending = false;
          if (!crossfade && timeline.phase === 'in' && timeline.g === 1) timeline.advance(frame.now - (1 - INTRO_FROM) * s.durationIn);
        }
        // the clock of a play's way out starts at its first ready frame (as the timeline's does)
        if (playing && !playing.back && Number.isNaN(playing.start) && frame.sourceReady) playing.start = frame.now;
        let amount = frame.sourceReady ? timeline.advance(frame.now) : timeline.g;
        // a play: the way back starts HOLD_MS after the way out ended (computed from the play's own clock, not from this frame: the same at
        // any frame cap; the way out was the rest of a full one from where the play started), at its own length
        if (playing && !playing.back && timeline.phase === 'gone') {
          const play = playing;
          const backAt = play.start + roundOut() * (1 - play.from) + HOLD_MS;
          if (frame.now >= backAt) {
            goBack(play, s.durationIn);
            timeline.advance(backAt);
            amount = timeline.advance(frame.now);
          }
        }
        if (playing && playing.back && timeline.assembled) playing = null;   // the play ended in this frame (its promise follows the timeline's)
        assembledFrame = timeline.assembled;
        if (gridOf[0] !== frame.cssWidth || gridOf[1] !== frame.cssHeight || gridOf[2] !== s.particleSize) {
          gridOf[0] = frame.cssWidth; gridOf[1] = frame.cssHeight; gridOf[2] = s.particleSize;
          grid = dustGrid(frame.cssWidth, frame.cssHeight, s.particleSize);
        }
        const fade = assembledFrame ? 1 : crossfade ? Math.min(0.999, 1 - amount) : 1;
        fillUniforms(data, frame, s, amount, grid, fade, (amount * s.duration) / 1000);
        device.queue.writeBuffer(uniforms, 0, data);
        attachment.clearValue.r = s.backdrop[0]; attachment.clearValue.g = s.backdrop[1]; attachment.clearValue.b = s.backdrop[2];
        const t = estimateFor(frame.cssWidth, frame.cssHeight);
        // the live page: every frame samples the source as it is now (a counter, typed text keep changing on the dust)
        const gs = groupsFor(t, frame.sourceView);
        const moving = frame.sourceReady && !assembledFrame;
        // the background estimate, when a transition shows the page and the page (or what it is drawn from) changed since the last one
        const version = frame.sourceVersion ?? -1;
        // (the background rarely changes while a counter ticks or text is typed: at most every 250 ms after the first)
        const fresh = t.view !== frame.sourceView || estimated !== optionsSerial || t.version === -1;
        if (moving && (fresh || (t.version !== version && frame.now - estimatedAt >= 250))) {
          t.version = version; t.view = frame.sourceView; estimated = optionsSerial; estimatedAt = frame.now;
          bgAttachment.view = t.downView;
          const p1 = frame.encoder.beginRenderPass(bgPass);
          p1.setPipeline(down); p1.setBindGroup(0, gs.down); p1.draw(3); p1.end();
          bgAttachment.view = t.bgView;
          const p2 = frame.encoder.beginRenderPass(bgPass);
          p2.setPipeline(estimate); p2.setBindGroup(0, gs.estimate); p2.draw(3); p2.end();
          bgAttachment.view = null;
        }
        const withDust = moving && !crossfade && amount > 0 && amount < 1;   // at g = 1 every grain has dissolved: the empty page
        // a measurement harness may ask for timestamps: from the start of the grains' compute pass to the end of the frame's render pass
        const stamps = frame.profiling?.timestampWrites?.('disintegrate');
        computeDescriptor.timestampWrites = stamps && withDust ? { querySet: stamps.querySet, beginningOfPassWriteIndex: stamps.beginningOfPassWriteIndex } : undefined;
        passDescriptor.timestampWrites = stamps && withDust ? { querySet: stamps.querySet, endOfPassWriteIndex: stamps.endOfPassWriteIndex } : stamps;
        // the records exist from the first frame of a transition on (also at g = 0), so that no frame of it creates a GPU object
        const rec = moving && !crossfade ? recordsFor(grid.count) : null;
        if (rec && withDust) {
          // one thread per dust cell: the grains in flight now, each where the flow has carried it
          const cp = frame.encoder.beginComputePass(computeDescriptor);
          cp.setPipeline(grainsPipeline); cp.setBindGroup(0, gs.frame); cp.setBindGroup(1, rec.group);
          cp.dispatchWorkgroups(Math.ceil(grid.count / WORKGROUP));
          cp.end();
        }
        attachment.view = frame.destinationView;
        const pass = frame.encoder.beginRenderPass(passDescriptor);
        if (frame.sourceReady) {
          pass.setBindGroup(0, gs.frame);
          if (assembledFrame) { pass.setPipeline(full); pass.draw(3); }
          else {
            pass.setPipeline(base); pass.draw(3);
            if (rec && withDust) {
              pass.setPipeline(dust); pass.setVertexBuffer(0, rec.buffer); pass.draw(4, grid.count);
              if (whiten) { pass.setPipeline(whiten); pass.draw(3); }
            }
          }
        }
        pass.end();
        attachment.view = null;
        if (waiters.length && frame.sourceReady && !inMotion()) { const state = resting(); for (const resolve of waiters.splice(0)) resolve(state); }
      },
      // the mapper of the frame just presented: two constant functions, so it is frozen by construction
      captureInputMapper() { return assembledFrame ? identityMapper : blockedMapper; },
      mountUI(root, ui) {
        const doc = root.ownerDocument;
        const win2 = /** @type {any} */ (doc.defaultView);
        injectStyle(doc, 'disintegrate', UI_CSS);
        const box = doc.createElement('div');
        box.className = 'hic-dis-ui';
        box.innerHTML = '<button type="button">Turn to dust</button><label>Dust size<input type="range" min="10" max="40" step="1"></label><label>Wind<input type="range" min="0" max="200" step="5"></label>'
          + '<div class="hic-dis-live"><label><input type="checkbox"> Live counter</label><output class="hic-dis-counter" aria-label="A counter that keeps running while the content turns to dust"></output></div>';
        const [size, wind, live] = /** @type {NodeListOf<HTMLInputElement>} */ (box.querySelectorAll('input'));
        const counter = /** @type {HTMLOutputElement} */ (box.querySelector('output'));
        const o = readOptions(ui.getOptions());
        size.value = String(Math.round(o.particleSize * 10));
        wind.value = String(Math.round(o.wind * 100));
        live.checked = o.liveCounter;
        // live content inside the form: a stopwatch that keeps running while the content turns to dust and re-forms
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
        const onBurn = () => { ui.trigger('play'); };
        const onSize = () => ui.setOptions({ particleSize: Number(size.value) / 10 });
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
        if (playing) { const p = playing; playing = null; p.resolve(false); }
        for (const resolve of waiters.splice(0)) resolve(null);
        source.removeEventListener('submit', onSubmit);
        uniforms.destroy?.();
        est?.down.destroy?.(); est?.bg.destroy?.();
        records?.buffer.destroy?.();
      },
    };
  },
});
