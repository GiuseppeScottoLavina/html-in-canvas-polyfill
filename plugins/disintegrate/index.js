/**
 * Disintegrate (effect plugin ABI v2): an EXAMPLE of the effects extension of html-in-canvas-polyfill, not part of the polyfill.
 * The CONTENT of the page turns to dust and blows away while the page itself stays: text, field borders and fills, buttons, icons, every
 * pixel that differs from the background around it. A diagonal sweep erodes it (porous first, then gone), each eroded pixel becomes a
 * grain of dust of its own LIVE colour, carried by the wind in swirls and streaks, some leaving as fragments that crumble on the way. Then
 * the dust flies back and settles into the letters and fields of the page as it is now. Nothing is frozen: a running counter, typed text
 * and a success line are what the dust shows and what re-forms. Shader: ./disintegrate.wgsl.
 *
 * A transition plugin: idle, it presents the source unchanged and its input mapper is the identity, so the form is fully usable. While
 * anything moves, is gone or fades, its mapper BLOCKS pointer input: it returns NO_TARGET (the effects ABI value for "no element here") for
 * every point, so the host swallows the press: nothing is focused or activated (../_lib/transition.js). Keyboard input is not mapped by the
 * host and still reaches the focused field.
 *
 * Triggers: `trigger(canvas, 'out' | 'in' | 'play')` (exported), `handle.setOptions({ state: 'out' | 'in' })`, the Burn button of mountUI,
 * and, with `onSubmit`, the submit of the form inside the source. With prefers-reduced-motion the same triggers crossfade the content.
 */

import { wgsl } from './wgsl.js';
import { blockedMapper, clampNumber, createTimeline, DEFAULT_INVALID_SELECTOR, findInvalid, identityMapper, parseColor } from '../_lib/transition.js';
import { injectStyle } from '../_lib/ui.js';

/** @typedef {import('../../src/contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../../src/contracts/types.js').EffectRenderFrame} EffectRenderFrame */

export { NO_TARGET, blockedMapper, createTimeline, findInvalid, identityMapper, parseColor } from '../_lib/transition.js';

/** What the plugin gallery and the build read (plugins/README.md). */
export const meta = Object.freeze({
  name: 'disintegrate',
  title: 'Disintegrate',
  description: 'The live content of the form turns to dust of its own colours and blows away while the page stays, then flies back into its new state. On Submit.',
  defaults: Object.freeze({ onSubmit: 'valid', intro: true }),
  reducedMotion: 'With reduced motion the same triggers fade the content into the page and back; nothing moves.',
});

/** floats in the uniform block (disintegrate.wgsl `Uniforms`) */
export const UNIFORM_FLOATS = 32;
/** at most this many dust cells (a 4K canvas at 1.5 css px would be 3.7 million; the cells grow beyond) */
export const MAX_GRAINS = 420000;
/** g at which every pixel of content has eroded; every grain lives from its birth until g = LIFE (all is gone then, none sooner) */
export const SWEEP_END = 0.5;
export const LIFE = 1;
/** css px per texel of the background estimate */
export const BG_CELL = 8;
/** the pause between the way out and the way back of 'play': none, the last part of the way out is the pause (no content is left on the page
 *  and the dust still drifts), so no frame of the transition is a still one */
export const HOLD_MS = 0;
/** the clear colour of the host's passthrough: an assembled frame is then identical to the frame without the plugin */
export const HOST_BACKDROP = Object.freeze([0.004, 0.018, 0.034]);

/** canvases where a device was lost: the plugin is created again on the new device without replaying its intro */
const lostOn = new WeakSet();
/** @type {WeakMap<HTMLCanvasElement, (action: 'out'|'in'|'play') => Promise<boolean>>} */
const controllers = new WeakMap();

/**
 * Start a transition of the disintegrate plugin running on `canvas`.
 * @param {HTMLCanvasElement} canvas
 * @param {'out'|'in'|'play'} [action]  out: turn to dust and stay gone; in: re-form; play: out, a short pause, in
 * @returns {Promise<boolean>}  true when that end state is reached; false when superseded, or when no instance runs on the canvas
 */
export function trigger(canvas, action = 'play') {
  const run = controllers.get(canvas);
  return run ? run(action) : Promise.resolve(false);
}

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
    particleSize: clampNumber(o.particleSize, 1, 4, 1.5),
    wind: clampNumber(o.wind, 0, 2, 1),
    direction: clampNumber(o.direction, -180, 180, -28),
    sweep: clampNumber(o.sweep, -180, 180, 24),
    turbulence: clampNumber(o.turbulence, 0, 2, 1),
    fragments: clampNumber(o.fragments, 0, 1, 0.3),
    sensitivity: clampNumber(o.sensitivity, 0, 1, 0.5),
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
 * @param {{cell: number, cols: number}} grid  the dust grid
 * @param {number} fade  1: the source; < 1: the reduced-motion crossfade (share of content still shown)
 * @param {number} [time]  seconds (a function of g)
 * @param {boolean} [turning]  the dust turns back at g = 1 (play): it does not fade there
 */
export function fillUniforms(data, frame, s, g, grid, fade, time = 0, turning = false) {
  const sw = sweepOf(s.sweep, frame.cssWidth, frame.cssHeight);
  const wind = (s.direction * Math.PI) / 180;
  data[0] = frame.width; data[1] = frame.height; data[2] = frame.cssWidth; data[3] = frame.cssHeight;
  data[4] = g; data[5] = fade; data[6] = grid.cell; data[7] = grid.cols;
  data[8] = sw.x; data[9] = sw.y; data[10] = sw.min; data[11] = sw.span;
  data[12] = Math.cos(wind); data[13] = Math.sin(wind);
  data[14] = 0.32 * Math.max(frame.cssWidth, frame.cssHeight) * s.wind; data[15] = s.turbulence;
  data[16] = time; data[17] = s.seed; data[18] = SWEEP_END; data[19] = LIFE;
  data[20] = s.fragments; data[21] = BG_CELL;
  // the colour distance from the background where content starts and where it is full content (sensitivity 0.5: 0.05 .. 0.14)
  data[22] = 0.09 - 0.08 * s.sensitivity; data[23] = data[22] + 0.09;
  data[24] = s.backdrop[0]; data[25] = s.backdrop[1]; data[26] = s.backdrop[2]; data[27] = 1;
  data[28] = turning ? 0 : 1; data[29] = 0; data[30] = 0; data[31] = 0;
}

/** CSS of the plugin UI (mountUI) */
const UI_CSS = `.hic-dis-ui{display:grid;grid-template-columns:auto 1fr 1fr;gap:4px 12px;align-items:end;font-size:11px;font-weight:700}`
    + `.hic-dis-ui label{display:grid}.hic-dis-ui input{width:100%;margin:0;accent-color:#ffb06b}.hic-dis-ui button{padding:7px 14px;font:inherit;border:0;border-radius:10px;cursor:pointer;color:#1b0d02;background:#ffb06b}`
    + `.hic-dis-live{grid-column:1/-1;display:flex;align-items:center;gap:12px;margin-top:4px}.hic-dis-live label{display:flex;align-items:center;gap:6px}.hic-dis-live input{width:15px;height:15px}`
    + `.hic-dis-counter{font:800 40px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.02em;font-variant-numeric:tabular-nums;color:#ffd7a8}.hic-dis-counter[hidden]{display:none}`;

/** @type {EffectPluginDefinition} */
export const plugin = Object.freeze({
  type: 'disintegrate',
  apiVersion: /** @type {const} */ (2),
  version: 3,
  // every pass that touches the destination only writes it as a same-format colour attachment (the dust's blending never samples it)
  outputCapabilities: Object.freeze({ directCanvasRenderAttachment: /** @type {const} */ (true) }),
  async create(context, initialOptions) {
    const { device, format, canvas, source } = context;
    const module = device.createShaderModule({ code: await wgsl('disintegrate.wgsl') });
    const g = /** @type {any} */ (globalThis);
    const S = g.GPUShaderStage, TU = g.GPUTextureUsage;
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: S.VERTEX | S.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: S.VERTEX | S.FRAGMENT, texture: { sampleType: 'float' } },   // the live page (the dust reads its pixel)
        { binding: 3, visibility: S.VERTEX | S.FRAGMENT, texture: { sampleType: 'float' } },   // the background estimate
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const blend = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
    };
    /** @param {string} vs @param {string} fs @param {string} target @param {any} [withBlend] @param {string} [topology] */
    const pipeline = (vs, fs, target, withBlend, topology = 'triangle-list') => device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: vs },
      fragment: { module, entryPoint: fs, targets: [{ format: target, ...(withBlend ? { blend: withBlend } : {}) }] },
      primitive: { topology },
    });
    const full = pipeline('vs_full', 'fs_full', format);
    const base = pipeline('vs_full', 'fs_base', format);
    const dust = pipeline('vs_dust', 'fs_dust', format, blend, 'triangle-strip');
    const down = pipeline('vs_full', 'fs_down', 'rgba8unorm');
    const estimate = pipeline('vs_full', 'fs_bg', 'rgba8unorm');
    const uniforms = device.createBuffer({ size: UNIFORM_FLOATS * 4, usage: g.GPUBufferUsage.UNIFORM | g.GPUBufferUsage.COPY_DST });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const data = new Float32Array(UNIFORM_FLOATS);
    // the render pass descriptors are reused: a frame writes their fields, it allocates nothing of its own
    const attachment = { view: /** @type {any} */ (null), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } };
    const passDescriptor = { colorAttachments: [attachment], timestampWrites: /** @type {any} */ (undefined) };
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
    /** a 'play' runs out and back: the dust turns at g = 1 at full strength (it fades only when a transition ends gone, or starts from it) */
    let turning = false;
    /** the play in progress: its promise, and whether its way back has started */
    /** @type {{resolve: (done: boolean) => void, back: boolean, start: number}|null} */ let playing = null;

    /** @param {'out'|'in'|'play'} action */
    function request(action) {
      if (action !== 'out' && action !== 'in' && action !== 'play') return Promise.reject(new TypeError('disintegrate: unknown action ' + action));
      if (destroyed) return Promise.resolve(false);
      crossfade = s.reducedMotion ?? !!media?.matches;
      // a play turns at g = 1 at full strength; an 'out' fades the dust as it ends gone, an 'in' from gone fades it in
      turning = action === 'play';
      // the way out and the way back have their own lengths (the timeline takes the length of a run when the run starts), so a play is
      // run here as an 'out' followed at once by an 'in'
      timeline.setDuration(action === 'in' ? s.durationIn : s.duration);
      if (playing) { const p = playing; playing = null; p.resolve(false); }   // a new request supersedes a play
      const run = timeline.request(action === 'play' ? 'out' : action);
      context.requestRender();
      if (action !== 'play') return run;
      /** @type {(done: boolean) => void} */ let resolve = () => {};
      const done = new Promise((r) => { resolve = /** @type {(done: boolean) => void} */ (r); });
      const play = { resolve, back: false, start: NaN };
      playing = play;
      run.then((ok) => { if (!ok && playing === play) { playing = null; resolve(false); } });
      return done;
    }
    controllers.set(canvas, request);
    if (timeline.phase === 'gone' && s.state === 'in') request('in');   // the intro: re-form from dust once the first snapshot is there

    const onSubmit = (/** @type {Event} */ event) => {
      if (s.onSubmit === 'off' || !timeline.assembled) return;
      if (s.onSubmit === 'valid' && findInvalid(source, s.invalidSelector)) return;
      request('play');
    };
    source.addEventListener('submit', onSubmit);
    device.lost?.then?.(() => { if (!destroyed) lostOn.add(canvas); });

    return {
      spatial: true,                      // pixels move: the host requires a mapper (identity when assembled, blocking otherwise)
      get continuous() { return timeline.animating; },
      setOptions(next) {
        s = readOptions(next ?? {});
        optionsSerial += 1;
        if (s.state !== stateOption) { stateOption = s.state; request(s.state); }
        context.requestRender();
      },
      render(/** @type {EffectRenderFrame} */ frame) {
        // the clock of a play's way out starts at its first ready frame (as the timeline's does)
        if (playing && !playing.back && Number.isNaN(playing.start) && frame.sourceReady) playing.start = frame.now;
        let amount = frame.sourceReady ? timeline.advance(frame.now) : timeline.g;
        // a play: the way back starts the instant the way out ended (not at this later frame: the same at any frame cap), at its own length
        if (playing && !playing.back && timeline.phase === 'gone') {
          const play = playing;
          play.back = true;
          timeline.setDuration(s.durationIn);
          timeline.request('in').then((ok) => { if (playing === play) playing = null; play.resolve(ok); });
          timeline.advance(Math.min(frame.now, play.start + s.duration));
          amount = timeline.advance(frame.now);
        }
        assembledFrame = timeline.assembled;
        if (gridOf[0] !== frame.cssWidth || gridOf[1] !== frame.cssHeight || gridOf[2] !== s.particleSize) {
          gridOf[0] = frame.cssWidth; gridOf[1] = frame.cssHeight; gridOf[2] = s.particleSize;
          grid = dustGrid(frame.cssWidth, frame.cssHeight, s.particleSize);
        }
        const fade = assembledFrame ? 1 : crossfade ? Math.min(0.999, 1 - amount) : 1;
        fillUniforms(data, frame, s, amount, grid, fade, (amount * s.duration) / 1000, turning);
        device.queue.writeBuffer(uniforms, 0, data);
        attachment.clearValue.r = s.backdrop[0]; attachment.clearValue.g = s.backdrop[1]; attachment.clearValue.b = s.backdrop[2];
        passDescriptor.timestampWrites = frame.profiling?.timestampWrites?.('disintegrate');
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
        attachment.view = frame.destinationView;
        const pass = frame.encoder.beginRenderPass(passDescriptor);
        if (frame.sourceReady) {
          pass.setBindGroup(0, gs.frame);
          if (assembledFrame) { pass.setPipeline(full); pass.draw(3); }
          else {
            pass.setPipeline(base); pass.draw(3);
            if (!crossfade && amount > 0) { pass.setPipeline(dust); pass.draw(4, grid.count); }
          }
        }
        pass.end();
        attachment.view = null;
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
        const onBurn = () => { trigger(canvas, 'play'); };
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
        source.removeEventListener('submit', onSubmit);
        if (controllers.get(canvas) === request) controllers.delete(canvas);
        uniforms.destroy?.();
        est?.down.destroy?.(); est?.bg.destroy?.();
      },
    };
  },
});
