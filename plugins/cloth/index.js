/**
 * Cloth effect plugin (effect plugin ABI v2): an EXAMPLE of the effects extension of html-in-canvas-polyfill, not part of the polyfill.
 * The simulation: ./sim.js. The surface and the input mapper: ./surface.js. Shaders: ./cloth.wgsl.
 *
 * The drawn page is printed on a sheet of fabric that hangs from its top edge in front of a wall. It hangs flat, and then the frame is
 * the page itself, pixel for pixel, and nothing is rendered until something changes. A moving pointer pushes a dent into it that runs off
 * as a wave, a press pokes it, a press that moves takes hold of it and pulls it on a spring; a gust (the actions `gust` and `demo`) billows
 * it; `drop` lets the pins go and it falls away, `in` hangs it again. Released, it swings back and comes to rest on the flat pose exactly.
 *
 * Simulation: particles on a fixed time step (sim.js), on the frame clock; a frame shows the cloth between its last two steps, so the
 * motion is the same at every frame rate. Rendering: a bicubic B-spline surface over the particles, tessellated on the GPU, lit by its
 * real normal (cloth.wgsl). Input: `mapClothPoint` (surface.js) intersects the pointer's line of sight with the triangles that were
 * drawn for the presented frame; the back of the cloth and the wall are NO_TARGET.
 *
 * Gestures. Mouse: a press that does not move is the page's click; once it has moved GRAB_SLOP css px it is the cloth's gesture (the
 * pointer is captured, the form sees no more of it and no click follows), unless it started on a control that is itself dragged (a
 * slider, a text field, a select). Touch: only a finger that lands on the lower edge of the cloth takes hold of it (claimed at its first
 * touchmove, so a tap there still taps); everywhere else a finger scrolls the page.
 */

import { NO_TARGET, isNoTarget } from '../../src/effects/no-target.js';
import { wgsl } from './wgsl.js';
import { clampNum } from '../_lib/number.js';
import { injectStyle } from '../_lib/ui.js';
import { pointerIn } from '../_lib/pointer.js';
import { MAX_STEPS_PER_FRAME, STEP_MS, createCloth, drop, gust, hangFrom, heldPoint, holdAt, layFlat, letGo, lowerSeconds, push, setPins, step, take, wake } from './sim.js';
import { CAMERA, CLOTH, FLAT, GONE, HEAD, S, SUB, castCloth, mapClothPoint, stateLength, writeControlPoints } from './surface.js';

/** @typedef {import('../../src/contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../../src/contracts/types.js').InputMapper} InputMapper */
/** @typedef {import('./sim.js').Cloth} Cloth */

/**
 * What the plugin gallery and the build read (plugins/README.md).
 * @experimental an example plugin of the effects, an extension of this library, not part of the HTML-in-Canvas standard (docs/STABILITY.md)
 */
export const meta = Object.freeze({
  name: 'cloth',
  title: 'Cloth',
  description: 'The live page printed on a sheet of fabric: it hangs from its top edge, takes a push, a pull or a gust, and settles; input is ray-cast through it.',
  defaults: Object.freeze({ weight: 0.5, wind: 0, pins: 'top', sheen: 0.5 }),
  reducedMotion: 'With reduced motion the cloth hangs flat and still: no push, pull, gust or breeze; drop and in crossfade; demo and gust resolve at once.',
  touch: 'Drag the lower edge of the cloth with a finger; elsewhere a finger scrolls the page.',
});

export { NO_TARGET, isNoTarget, mapClothPoint };

/** The actions of `handle.trigger`: demo and gust blow at the cloth, drop lets it fall away, in hangs it again. */
export const ACTIONS = Object.freeze(/** @type {const} */ (['demo', 'gust', 'drop', 'in']));
export const PINS = Object.freeze(['top', 'corners']);
/** floats of the uniform block (cloth.wgsl Globals) */
export const UNIFORM_FLOATS = 28;
const U = Object.freeze({ RES: 0, CSS: 2, GRID: 4, CAMERA: 6, WALL: 7, LIGHT: 8, SHEEN: 11, READY: 12, THROUGH: 13, SHADE: 14, FADE: 15, BACKDROP: 16, MARGIN: 19, BLUR: 20, LINEN: 24 });
/** towards the lamp: up and to the left of the viewer (cloth.wgsl g.light) */
export const LIGHT = Object.freeze((() => { const v = [-0.5, -0.68, 0.54]; const l = Math.hypot(...v); return v.map((x) => x / l); })());
/** mapper states kept alive: the mapper chain keeps the last 3 presented frames, plus the one being written */
const MAPPER_SLOTS = 4;
/** css px of the canvas per texel of the shadow map, and how far the map reaches beyond the canvas (a share of its larger side) */
const SHADOW_PX = 3;
const SHADOW_MARGIN = 0.3;
/** css px a pressed mouse travels before the press is the cloth's gesture and no longer the page's click; a finger's */
export const GRAB_SLOP = 6;
export const TOUCH_SLOP = 8;
/** css px of the cloth's lower edge that a finger can take hold of (measured on the cloth, from its hem) */
export const HEM = 44;
/** the hand lifts the cloth it holds this far off its plane, as a share of the canvas height, over the first LIFT_TRAVEL css px of the drag */
const LIFT = 0.07;
const LIFT_TRAVEL = 70;
/** a moving pointer: css px/s of push per css px of travel (at most HOVER_STEP css px per event count), over a Gaussian of HOVER_RADIUS css px (shares of the canvas height) */
const HOVER_PUSH = 11;
const HOVER_STEP = 48;
const HOVER_RADIUS = 0.075;
/** a press: a poke of this many canvas heights per second, over POKE_RADIUS (a share of the canvas height) */
const POKE = 0.62;
const POKE_RADIUS = 0.06;
/** the demo: one gust of this strength from the left, a little downwards */
export const DEMO_GUST = Object.freeze(/** @type {{direction: number, strength: number}} */ ({ direction: 14, strength: 1.1 }));
/** drop: the pins let go over this many seconds; in: the cloth is hung from this many canvas heights above its place, swung this far towards the viewer (radians) */
export const PEEL_S = 0.32;
const RISE_FROM = 1.12;
const RISE_ANGLE = 0.42;
/** s after which a falling cloth counts as gone even if a particle is still in the frame (it cannot be: nothing holds it) */
const FALL_LIMIT_S = 4;
/** ms of the crossfade that stands for drop and in with reduced motion */
export const FADE_MS = 260;
/** controls that are dragged themselves: a press on one of them never becomes the cloth's gesture */
const DRAGGED = 'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]),textarea,select,[contenteditable]:not([contenteditable=false]),[draggable=true],video[controls],audio[controls]';

const HANGING = 0, DROPPING = 1, DROPPED = 2, RISING = 3;

/** `weight` (0 light .. 1 heavy) as the numbers of the simulation: the air slows a light cloth more, a heavy cloth is stiffer across its folds. PURE. @param {number} weight */
export function fabric(weight) {
  const k = Math.min(1, Math.max(0, weight));
  return { dragN: 5 - 3 * k, dragT: 4.4 - 1.4 * k, bend: 6000 * (1 - k) ** 2 + 600, push: 1.3 - 0.55 * k };
}

/** '#rgb' / '#rrggbb' -> [r, g, b] in 0..1, linear light (else `fallback`). @param {unknown} hex @param {number[]} fallback */
export function parseColor(hex, fallback) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex ?? ''));
  if (!m) return fallback;
  const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
  return [0, 2, 4].map((i) => { const c = parseInt(h.slice(i, i + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
}

/** The direction a gust of `degrees` travels along the cloth: 0 towards the right, 90 downwards. PURE. @param {number} degrees */
export function gustDirection(degrees) {
  const a = (degrees * Math.PI) / 180;
  return { x: Math.cos(a), y: Math.sin(a) };
}

/** @type {WeakMap<Function, Float32Array>} */
const mapperStates = new WeakMap();
/** The state a mapper of this plugin answers from (the frame it was captured for), or undefined; for tests. @param {Function} mapper */
export const stateOf = (mapper) => mapperStates.get(mapper);

/** @param {Float32Array} state @returns {InputMapper} */
function makeMapper(state) {
  /** @type {InputMapper} */
  const mapper = (point) => mapClothPoint(state, point);
  mapper.captureGestureSnapshot = () => {
    const frozen = new Float32Array(state);
    /** @type {InputMapper} */ const still = (point) => mapClothPoint(frozen, point);
    mapperStates.set(still, frozen);
    return still;
  };
  mapperStates.set(mapper, state);
  return mapper;
}

let uiSerial = 0;
/** CSS of the plugin UI (mountUI) and of the cursor while the cloth is held */
const UI_CSS = `
    .hic-cloth-ui { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:4px 12px; align-items:end; }
    .hic-cloth-ui label { display:grid; grid-template-columns:1fr auto; gap:2px 6px; min-width:0; font-size:10px; font-weight:700; }
    .hic-cloth-ui output { color:#ffd9a8; font-variant-numeric:tabular-nums; }
    .hic-cloth-ui input[type=range] { grid-column:1 / -1; width:100%; height:22px; margin:0; accent-color:#ffc27a; cursor:ew-resize; }
    .hic-cloth-ui select, .hic-cloth-ui button { grid-column:1 / -1; min-height:24px; font:inherit; font-size:11px; color:#effcff; background:rgba(1,10,23,.55); border:1px solid rgba(255,214,170,.3); border-radius:8px; padding:2px 8px; }
    .hic-cloth-ui button { cursor:pointer; font-weight:700; }
    [data-hic-cloth-cursor=grabbing], [data-hic-cloth-cursor=grabbing] * { cursor:grabbing !important; }
  `;

const SLIDERS = /** @type {const} */ ([['weight', 'Weight'], ['wind', 'Wind'], ['sheen', 'Sheen']]);

/** @param {any} device @param {string} code @param {string} label */
async function shaderModule(device, code, label) {
  const module = device.createShaderModule({ code, label });
  // a WGSL error would otherwise only show as a blank frame: fail create() with the compiler's message instead
  const info = await module.getCompilationInfo?.();
  const error = info?.messages?.find((/** @type {any} */ m) => m.type === 'error');
  if (error) throw new Error(`${label}:${error.lineNum}: ${error.message}`);
  return module;
}

/**
 * The plugin's definition (effect plugin ABI v2).
 * @experimental an example plugin of the effects, an extension of this library, not part of the HTML-in-Canvas standard (docs/STABILITY.md)
 * @type {EffectPluginDefinition}
 */
export const plugin = Object.freeze({
  type: 'cloth',
  apiVersion: /** @type {const} */ (2),
  version: 1,
  actions: ACTIONS,
  // every pass that touches the destination only writes it as a colour attachment (directly, or as the MSAA resolve); nothing samples it
  outputCapabilities: Object.freeze({ directCanvasRenderAttachment: /** @type {const} */ (true) }),
  async create(context, initialOptions) {
    const { device, format, canvas, source } = context;
    const G = /** @type {any} */ (globalThis);
    const SS = G.GPUShaderStage ?? { VERTEX: 1, FRAGMENT: 2 }, BU = G.GPUBufferUsage, TU = G.GPUTextureUsage ?? { COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
    const module = await shaderModule(device, await wgsl('cloth.wgsl'), 'cloth.wgsl');
    const uniformEntry = { binding: 0, visibility: SS.VERTEX | SS.FRAGMENT, buffer: { type: 'uniform' } };
    const pointsEntry = { binding: 1, visibility: SS.VERTEX, texture: { sampleType: 'unfilterable-float' } };
    const pageEntry = { binding: 2, visibility: SS.FRAGMENT, texture: { sampleType: 'float' } };
    const samplerEntry = { binding: 3, visibility: SS.FRAGMENT, sampler: { type: 'filtering' } };
    const mainLayout = device.createBindGroupLayout({ label: 'hic-cloth', entries: [uniformEntry, pointsEntry, pageEntry, samplerEntry,
      { binding: 4, visibility: SS.FRAGMENT, texture: { sampleType: 'float' } }, { binding: 5, visibility: SS.FRAGMENT, texture: { sampleType: 'float' } }] });
    const flatLayout = device.createBindGroupLayout({ label: 'hic-cloth-flat', entries: [uniformEntry, pageEntry, samplerEntry] });
    const shadowLayout = device.createBindGroupLayout({ label: 'hic-cloth-shadow', entries: [uniformEntry, pointsEntry] });
    const blurLayout = device.createBindGroupLayout({ label: 'hic-cloth-blur', entries: [uniformEntry, samplerEntry, { binding: 6, visibility: SS.FRAGMENT, texture: { sampleType: 'float' } }] });
    const layoutOf = (/** @type {any} */ l) => device.createPipelineLayout({ bindGroupLayouts: [l] });
    const make = (/** @type {any} */ d) => (device.createRenderPipelineAsync ? device.createRenderPipelineAsync(d) : device.createRenderPipeline(d));
    const strip = { topology: 'triangle-strip', cullMode: 'none' };
    const max = { operation: 'max', srcFactor: 'one', dstFactor: 'one' };
    const msaa = { count: 4 };
    // compiled before the first frame, so that the first push does not wait for a pipeline
    const [flatPipe, shadowPipe, blurPipe, clothPipe, wallPipe] = await Promise.all([
      make({ label: 'hic-cloth-flat', layout: layoutOf(flatLayout), vertex: { module, entryPoint: 'vs_full' }, fragment: { module, entryPoint: 'fs_flat', targets: [{ format }] }, primitive: { topology: 'triangle-list' } }),
      make({ label: 'hic-cloth-shadow', layout: layoutOf(shadowLayout), vertex: { module, entryPoint: 'vs_shadow' }, fragment: { module, entryPoint: 'fs_shadow', targets: [{ format: 'rg16float', blend: { color: max, alpha: max } }] }, primitive: strip }),
      make({ label: 'hic-cloth-blur', layout: layoutOf(blurLayout), vertex: { module, entryPoint: 'vs_full' }, fragment: { module, entryPoint: 'fs_blur', targets: [{ format: 'rg16float' }] }, primitive: { topology: 'triangle-list' } }),
      make({ label: 'hic-cloth-sheet', layout: layoutOf(mainLayout), vertex: { module, entryPoint: 'vs_cloth' }, fragment: { module, entryPoint: 'fs_cloth', targets: [{ format }] }, primitive: strip, multisample: msaa,
        depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' } }),
      make({ label: 'hic-cloth-wall', layout: layoutOf(mainLayout), vertex: { module, entryPoint: 'vs_full' }, fragment: { module, entryPoint: 'fs_wall', targets: [{ format }] }, primitive: { topology: 'triangle-list' }, multisample: msaa,
        depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' } }),
    ]);

    const uniforms = device.createBuffer({ label: 'hic-cloth', size: UNIFORM_FLOATS * 4, usage: BU.UNIFORM | BU.COPY_DST });
    const blurUniforms = Array.from({ length: 4 }, () => device.createBuffer({ label: 'hic-cloth-blur', size: UNIFORM_FLOATS * 4, usage: BU.UNIFORM | BU.COPY_DST }));
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const globals = new Float32Array(UNIFORM_FLOATS);

    const doc = canvas.ownerDocument;
    const win = /** @type {any} */ (doc?.defaultView ?? globalThis);
    // prefers-reduced-motion (read now, and by the host at every trigger): the cloth hangs flat and still
    const reducedMotion = !!win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (/** @type {any} */ (doc)?.createElement) injectStyle(doc, 'cloth', UI_CSS);   // the cursor rule (a test fake may have no DOM)

    const o = { weight: 0.5, wind: 0, pins: /** @type {'top'|'corners'} */ ('top'), sheen: 0.5, shadow: 0.85, through: 0.35, backdrop: [0.05, 0.047, 0.052], back: [0.33, 0.31, 0.28] };
    /** @param {Readonly<Record<string, unknown>>|undefined|null} next */
    function readOptions(next) {
      if (!next) return;
      if (next.weight !== undefined) o.weight = clampNum(next.weight, 0, 1, o.weight);
      if (next.wind !== undefined) o.wind = clampNum(next.wind, 0, 1, o.wind);
      if (next.sheen !== undefined) o.sheen = clampNum(next.sheen, 0, 1, o.sheen);
      if (next.shadow !== undefined) o.shadow = clampNum(next.shadow, 0, 1, o.shadow);
      if (next.through !== undefined) o.through = clampNum(next.through, 0, 1, o.through);
      if (next.pins !== undefined) o.pins = next.pins === 'corners' ? 'corners' : 'top';
      if (next.backdrop !== undefined) o.backdrop = parseColor(next.backdrop, o.backdrop);
      if (next.back !== undefined) o.back = parseColor(next.back, o.back);
    }
    readOptions(initialOptions);
    /** the pins as the simulation has them (flat and whole with reduced motion) */
    const pinsNow = () => (reducedMotion ? 'top' : o.pins);

    // ---- the cloth and its clock ------------------------------------------------------------------------------------------------------
    /** @type {Cloth|null} */ let cloth = null;
    let status = HANGING;
    /** frame clock (ms) up to which the cloth has been stepped; NaN while it is asleep (the clock starts with the next frame) */
    let clock = NaN;
    /** performance.now() of the input that woke the cloth: its first frame shows the time since then */
    let wokeAt = NaN;
    /** the cloth's time (s) at which it was dropped */
    let droppedAt = 0;
    /** `in` was asked for while the cloth still falls: it is hung again once it has gone */
    let riseNext = false;
    /** a gust of the demo blows: a press ends it */
    let demoBlows = false;
    /** the crossfade with reduced motion: 0 the page, 1 the wall; its target and the frame time it started from (NaN: at the next frame) */
    const fade = { now: 0, to: 0, from: 0, start: NaN };
    /** @type {((state: string|null) => void)[]} */ const waiters = [];
    let current = new Float32Array(stateLength(1, 1));
    let slots = /** @type {Float32Array[]} */ ([]);
    let mappers = /** @type {InputMapper[]} */ ([]);
    let mapperSlot = 0;
    let shown = /** @type {Float32Array|null} */ (null);
    let serial = 0;
    /** @type {any} */ let pointsTexture = null;
    /** @type {any} */ let pointsView = null;
    /** @type {any} */ let shadowGroup = null;
    const pointsCopy = { texture: /** @type {any} */ (null) };
    const pointsLayout = { offset: HEAD * 4, bytesPerRow: 0, rowsPerImage: 0 };
    const pointsSize = { width: 0, height: 0 };

    /** @param {Cloth} c */
    function applyFabric(c) {
      const f = fabric(o.weight);
      c.dragN = f.dragN; c.dragT = f.dragT; c.bend = f.bend;
      c.wind = reducedMotion || status !== HANGING ? 0 : o.wind;
    }

    /** The cloth of a canvas of this css size; another size is another cloth, hanging as the options say. @param {number} W @param {number} H */
    function ensureCloth(W, H) {
      if (cloth && Math.abs(cloth.width - W) < 0.01 && Math.abs(cloth.height - H) < 0.01) return cloth;
      const c = createCloth(W, H);
      applyFabric(c);
      if (pinsNow() === 'corners' && status !== DROPPED) setPins(c, 'corners');
      else if (c.wind > 0 && status === HANGING) wake(c);
      cloth = c;
      clock = NaN;
      const length = stateLength(c.cols, c.rows);
      if (current.length !== length) {
        current = new Float32Array(length);
        slots = Array.from({ length: MAPPER_SLOTS }, () => new Float32Array(length));
        mappers = slots.map(makeMapper);
        shown = null;
        pointsTexture?.destroy?.();
        const pw = c.nx + 2, ph = c.ny + 2;
        pointsTexture = device.createTexture({ label: 'hic-cloth-points', size: { width: pw, height: ph }, format: 'rgba32float', usage: TU.TEXTURE_BINDING | TU.COPY_DST });
        pointsView = pointsTexture.createView();
        pointsCopy.texture = pointsTexture; pointsLayout.bytesPerRow = pw * 16; pointsLayout.rowsPerImage = ph; pointsSize.width = pw; pointsSize.height = ph;
        shadowGroup = device.createBindGroup({ layout: shadowLayout, entries: [{ binding: 0, resource: { buffer: uniforms } }, { binding: 1, resource: pointsView }] });
        if (sized) sized.groups = new WeakMap();
      }
      return c;
    }
    /** the cloth, before the first frame too (then of the canvas's client size) */
    const theCloth = () => cloth ?? ensureCloth(canvas.clientWidth || 1, canvas.clientHeight || 1);
    /** Something moved the cloth: frames are needed until it rests again. */
    function stir() {
      if (Number.isNaN(clock) && Number.isNaN(wokeAt)) wokeAt = performance.now();
      context.requestRender();
    }
    const moving = () => (!!cloth && !cloth.asleep && status !== DROPPED) || fade.now !== fade.to;
    const stateName = () => (status === DROPPED || status === DROPPING ? 'dropped' : 'hanging');
    /** nothing moves and nothing is about to */
    const still = () => !moving() && !riseNext && (status === HANGING || status === DROPPED);
    /** @returns {string|Promise<string|null>} */
    const wait = () => (still() ? stateName() : new Promise((resolve) => { waiters.push(resolve); }));

    /** The cloth is hung again from above its place. @param {Cloth} c */
    function rise(c) {
      riseNext = false;
      status = RISING;
      fade.now = fade.to = 0;
      hangFrom(c, -RISE_FROM * c.height, RISE_ANGLE, pinsNow(), lowerSeconds(c, RISE_FROM * c.height));
      applyFabric(c);
      clock = NaN;
      stir();
    }

    /** Step the cloth up to the frame time `now` (ms); returns the share of the last step that the frame shows. @param {Cloth} c @param {number} now */
    function advance(c, now) {
      if (c.asleep) { clock = NaN; wokeAt = NaN; return 1; }
      if (Number.isNaN(clock)) {
        // the first frame after a wake shows the time since the input that woke the cloth (when that was just now, on the same clock)
        clock = now - wokeAt >= 0 && now - wokeAt < 100 ? wokeAt : now;
        wokeAt = NaN;
      }
      let n = Math.floor((now - clock) / STEP_MS);
      // a long gap (off-screen, a frame cap of 1) is skipped, not caught up
      if (n > MAX_STEPS_PER_FRAME) { clock += (n - MAX_STEPS_PER_FRAME) * STEP_MS; n = MAX_STEPS_PER_FRAME; }
      for (let i = 0; i < n && !c.asleep; i += 1) step(c);
      clock += n * STEP_MS;
      if (status === DROPPING) {
        let top = Infinity;
        for (let k = 1; k < 3 * c.n; k += 3) if (c.x[k] < top) top = c.x[k];
        if (top > c.height + 2 || c.time - droppedAt > FALL_LIMIT_S) {
          status = DROPPED; c.asleep = true; c.gusts.length = 0; c.grab.on = false;
          fade.now = fade.to = 1;   // the bare wall
          if (riseNext) rise(c);
        }
      } else if (status === RISING && c.asleep) status = HANGING;
      if (c.gusts.length === 0) demoBlows = false;
      if (c.asleep) { clock = NaN; return 1; }
      return Math.min(1, Math.max(0, (now - clock) / STEP_MS));
    }

    // ---- size-dependent GPU resources ------------------------------------------------------------------------------------------------
    /** @type {any} */ let sized = null;
    const blurData = new Float32Array(UNIFORM_FLOATS);
    /** @param {number} w @param {number} h  backing px @param {number} cw @param {number} ch  css px */
    function resources(w, h, cw, ch) {
      if (sized && sized.w === w && sized.h === h && sized.cw === cw && sized.ch === ch) return sized;
      if (sized) for (const t of sized.textures) t.destroy?.();
      const color = device.createTexture({ label: 'hic-cloth-msaa', size: [w, h], format, sampleCount: 4, usage: TU.RENDER_ATTACHMENT });
      const depth = device.createTexture({ label: 'hic-cloth-depth', size: [w, h], format: 'depth24plus', sampleCount: 4, usage: TU.RENDER_ATTACHMENT });
      const margin = Math.ceil(SHADOW_MARGIN * Math.max(cw, ch));
      const sw = Math.max(1, Math.ceil((cw + 2 * margin) / SHADOW_PX)), sh = Math.max(1, Math.ceil((ch + 2 * margin) / SHADOW_PX));
      const map = () => device.createTexture({ label: 'hic-cloth-shadow', size: [sw, sh], format: 'rg16float', usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
      const sharp = map(), tmp = map(), near = map(), wide = map();
      const views = { sharp: sharp.createView(), tmp: tmp.createView(), near: near.createView(), wide: wide.createView() };
      // four blur passes: a narrow Gaussian (1 texel between taps), then a wide one over it (2.5 texels), each across then down
      const plan = [[views.sharp, views.tmp, 1, 0], [views.tmp, views.near, 0, 1], [views.near, views.tmp, 2.5, 0], [views.tmp, views.wide, 0, 2.5]];
      const blurs = plan.map(([src, dst, dx, dy], i) => {
        blurData[U.BLUR] = /** @type {number} */ (dx) / sw; blurData[U.BLUR + 1] = /** @type {number} */ (dy) / sh;
        device.queue.writeBuffer(blurUniforms[i], 0, blurData);
        return { dst, group: device.createBindGroup({ layout: blurLayout, entries: [{ binding: 0, resource: { buffer: blurUniforms[i] } }, { binding: 3, resource: sampler }, { binding: 6, resource: src }] }) };
      });
      sized = { w, h, cw, ch, margin, textures: [color, depth, sharp, tmp, near, wide], colorView: color.createView(), depthView: depth.createView(), views, blurs, groups: new WeakMap() };
      return sized;
    }
    const flatGroups = new WeakMap();
    // reused pass descriptors: a frame writes their views, it allocates nothing of its own
    const flatAttachment = { view: /** @type {any} */ (null), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } };
    const flatPass = { colorAttachments: [flatAttachment] };
    const mapAttachment = { view: /** @type {any} */ (null), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } };
    const mapPass = { colorAttachments: [mapAttachment] };
    const mainAttachment = { view: /** @type {any} */ (null), resolveTarget: /** @type {any} */ (null), loadOp: 'clear', storeOp: 'discard', clearValue: { r: 0, g: 0, b: 0, a: 1 } };
    const depthAttachment = { view: /** @type {any} */ (null), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' };
    const mainPass = { colorAttachments: [mainAttachment], depthStencilAttachment: depthAttachment };

    // ---- the pointer ------------------------------------------------------------------------------------------------------------------
    const hit = { u: 0, v: 0, z: 0, front: true };
    const held = [0, 0, 0];
    /** the press that may become, or is, the cloth's gesture */
    const press = { id: -1, x: 0, y: 0, u: 0, v: 0, z: 0, held: false, touch: false, travel: 0 };
    /** where the pointer last was (canvas css px), for the push of its motion */
    const last = { x: NaN, y: NaN };
    /** the touch that began on the hem: it is claimed at its first move */
    let touchMine = false;
    let swallowClick = false;
    /** @type {Element|null} */ let cursorOn = null;
    /** @type {Element} */ let captureEl = canvas;

    /** A client point on the canvas, as css px of the cloth (through the plugins added after this one), or null. @param {{clientX: number, clientY: number}} e */
    function local(e) {
      const p = pointerIn(context, canvas, e.clientX, e.clientY);
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
      const c = theCloth();
      p.x *= c.width / Math.max(1, canvas.clientWidth); p.y *= c.height / Math.max(1, canvas.clientHeight);
      return p;
    }
    /** What the presented frame shows at the cloth point p: writes `hit`; false on the wall. @param {{x: number, y: number}} p */
    function see(p) {
      const c = /** @type {Cloth} */ (cloth);
      if (!shown || shown[S.MODE] === FLAT) {
        if (p.x < 0 || p.y < 0 || p.x > c.width || p.y > c.height) return false;
        hit.u = p.x / c.width; hit.v = p.y / c.height; hit.z = 0; hit.front = true;
        return true;
      }
      return shown[S.MODE] === CLOTH && castCloth(shown, p.x, p.y, hit);
    }
    const onPage = (/** @type {Event} */ e) => { const path = e.composedPath(); return path.includes(canvas) || path.includes(source); };
    const swallow = (/** @type {Event} */ e) => { if (e.cancelable) e.preventDefault(); e.stopImmediatePropagation(); };
    /** the element of the page that the frame shows at the page point (u, v) @param {number} u @param {number} v */
    function elementAt(u, v) {
      const r = canvas.getBoundingClientRect();
      return doc.elementFromPoint?.(r.left + (canvas.clientLeft || 0) + u * canvas.clientWidth, r.top + (canvas.clientTop || 0) + v * canvas.clientHeight) ?? null;
    }
    /** @param {boolean} on */
    function grabCursor(on) {
      if (on === !!cursorOn) return;
      if (on) { cursorOn = /** @type {Element} */ (doc.documentElement); cursorOn.setAttribute('data-hic-cloth-cursor', 'grabbing'); }
      else { cursorOn?.removeAttribute('data-hic-cloth-cursor'); cursorOn = null; }
    }
    /** where the hand holds the cloth for the pointer at the cloth point p: on its line of sight, lifted off the plane as the drag goes on */
    function holdUnder(/** @type {{x: number, y: number}} */ p) {
      const c = /** @type {Cloth} */ (cloth);
      const D = CAMERA * Math.max(c.width, c.height);
      const z = press.z + LIFT * c.height * (1 - Math.exp(-press.travel / LIFT_TRAVEL));
      const k = (D - z) / D;
      holdAt(c, c.width / 2 + (p.x - c.width / 2) * k, c.height / 2 + (p.y - c.height / 2) * k, z);
    }
    /** a press ends the gusts of a running demo: the user takes over */
    function takeOver() {
      if (demoBlows && cloth) { cloth.gusts.length = 0; demoBlows = false; }
    }
    const interactive = () => !reducedMotion && (status === HANGING || status === RISING);

    /** @param {PointerEvent} e */
    function onDown(e) {
      swallowClick = false;
      if (!e.isPrimary || e.button !== 0 || !onPage(e)) return;
      if (status === DROPPED && !riseNext) {
        // a press on the bare wall hangs the cloth again (through the host, like any trigger)
        Promise.resolve(context.trigger?.('in')).catch(() => {});
        return;
      }
      if (!interactive() || press.id !== -1) return;
      takeOver();
      const p = local(e);
      if (!p || !see(p)) return;
      const c = /** @type {Cloth} */ (cloth);
      const touch = e.pointerType === 'touch';
      // the poke of the press: into the cloth along the line of sight
      push(c, hit.u * c.cols, hit.v * c.rows, POKE_RADIUS * c.height, 0, 0, (hit.front ? -1 : 1) * POKE * c.height * fabric(o.weight).push);
      stir();
      // a press on a control that is dragged itself stays the page's; a finger takes hold only by the hem
      if (touch ? !onHem() : !!elementAt(hit.u, hit.v)?.closest?.(DRAGGED)) return;
      press.id = e.pointerId; press.x = e.clientX; press.y = e.clientY; press.u = hit.u; press.v = hit.v; press.z = hit.z; press.held = false; press.touch = touch; press.travel = 0;
    }
    /** the hit is on the lower edge of the cloth, on its printed side */
    const onHem = () => hit.front && (1 - hit.v) * /** @type {Cloth} */ (cloth).height <= HEM;

    /** @param {PointerEvent} e */
    function onMove(e) {
      if (press.id === e.pointerId) {
        const travel = Math.hypot(e.clientX - press.x, e.clientY - press.y);
        const c = /** @type {Cloth} */ (cloth);
        if (!press.held) {
          if (travel < (press.touch ? TOUCH_SLOP : GRAB_SLOP) || !interactive()) return;
          // the press has become the cloth's gesture: the hand takes the cloth where it was pressed
          press.held = true;
          take(c, press.u * c.cols, press.v * c.rows, 0, 0, 0);
          heldPoint(c, held);
          holdAt(c, held[0], held[1], held[2]);
          press.z = held[2];
          captureEl = /** @type {Element} */ (e.target instanceof win.Element ? e.target : canvas);
          try { captureEl.setPointerCapture(e.pointerId); } catch { /* a synthetic or finished pointer */ }
          grabCursor(true);
          doc.getSelection?.()?.removeAllRanges?.();
        }
        swallow(e);
        press.travel = Math.max(press.travel, travel);
        const p = local(e);
        if (p) holdUnder(p);
        stir();
        return;
      }
      if (e.pointerType === 'touch' || !interactive() || e.buttons !== 0 || !onPage(e)) { last.x = NaN; return; }
      // a moving pointer pushes the cloth where it passes: away from the viewer, and a little along its way
      const p = local(e);
      if (!p || !see(p)) { last.x = NaN; return; }
      const c = /** @type {Cloth} */ (cloth);
      const dx = p.x - last.x, dy = p.y - last.y, d = Math.hypot(dx, dy);
      last.x = p.x; last.y = p.y;
      if (!(d > 0.5) || d > 6 * HOVER_STEP) return;   // the first move, or a jump: a new path
      const k = (HOVER_PUSH * fabric(o.weight).push * Math.min(d, HOVER_STEP)) / d;
      push(c, hit.u * c.cols, hit.v * c.rows, HOVER_RADIUS * c.height, 0.25 * k * dx, 0.25 * k * dy, (hit.front ? -1 : 1) * k * d);
      stir();
    }
    /** @param {PointerEvent} e */
    function onUp(e) {
      if (press.id !== e.pointerId) return;
      press.id = -1;
      if (!press.held) return;
      press.held = false;
      swallow(e);
      swallowClick = e.type === 'pointerup';
      try { captureEl.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      grabCursor(false);
      if (cloth) letGo(cloth);
      stir();
    }
    /** @param {MouseEvent} e */
    function onClick(e) {
      if (!swallowClick || e.detail === 0) return;
      swallowClick = false;
      swallow(e);
    }
    /** while the cloth is held (or a press may still become its gesture) the page selects no text and drags no link; the mouse events of the held gesture stay here */
    const onSelect = (/** @type {Event} */ e) => { if (press.id !== -1 && onPage(e)) e.preventDefault(); };
    const onMouse = (/** @type {Event} */ e) => { if (press.held) e.stopImmediatePropagation(); };
    /** @type {[string, (e: any) => void][]} */
    const documentListeners = reducedMotion ? [['pointerdown', onDown]] : [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onUp], ['click', onClick],
      ['selectstart', onSelect], ['dragstart', onSelect], ['mousemove', onMouse], ['mouseup', onMouse]];
    for (const [type, fn] of documentListeners) doc.addEventListener?.(type, fn, true);
    if (!reducedMotion) {
      // touch: passive unless the finger landed on the hem; then its first move claims the gesture (no scroll, no pointercancel)
      context.listen('touchstart', (event) => {
        const e = /** @type {TouchEvent} */ (event);
        const p = e.touches?.length === 1 && interactive() ? local(e.touches[0]) : null;
        touchMine = !!p && see(p) && onHem();
      }, { passive: true });
      context.listen('touchmove', (event) => { if (touchMine && event.cancelable) event.preventDefault(); }, { passive: false });
      context.listen('pointerleave', () => { last.x = NaN; }, { passive: true });
    }

    // ---- the plugin's controls -------------------------------------------------------------------------------------------------------
    /** @type {Array<() => void>} */ const uiSyncs = [];

    /** @param {Element} root @param {{setOptions: (patch: Record<string, unknown>) => void, trigger: (action: string, options?: Record<string, unknown>) => Promise<unknown>}} ui */
    function mountUI(root, ui) {
      const d = root.ownerDocument;
      injectStyle(d, 'cloth', UI_CSS);
      const id = `hic-cloth-${++uiSerial}`;
      const box = d.createElement('div');
      box.className = 'hic-cloth-ui';
      box.innerHTML = SLIDERS.map(([key, text]) => `<label><span>${text}</span><output></output><input type="range" id="${id}-${key}" data-key="${key}" min="0" max="100" step="1"></label>`).join('')
        + `<label><span>Pins</span><select id="${id}-pins"><option value="top">Top edge</option><option value="corners">Two corners</option></select></label>`
        + `<label><span>Wind</span><button type="button" data-action="gust">Gust</button></label>`
        + `<label><span>Cloth</span><button type="button" data-action="drop"></button></label>`;
      const ranges = /** @type {HTMLInputElement[]} */ ([...box.querySelectorAll('input[type=range]')]);
      const select = /** @type {HTMLSelectElement} */ (box.querySelector('select'));
      const [gustButton, dropButton] = /** @type {HTMLButtonElement[]} */ ([...box.querySelectorAll('button')]);
      const sync = () => {
        for (const r of ranges) {
          const key = /** @type {'weight'|'wind'|'sheen'} */ (r.dataset.key), value = String(Math.round(o[key] * 100));
          if (r.value !== value) r.value = value;
          const out = /** @type {HTMLOutputElement} */ (r.previousElementSibling);
          if (out.textContent !== `${value}%`) out.textContent = `${value}%`;
        }
        if (select.value !== o.pins) select.value = o.pins;
        const text = stateName() === 'dropped' ? 'Hang' : 'Drop';
        if (dropButton.textContent !== text) dropButton.textContent = text;
      };
      const onInput = (/** @type {Event} */ e) => { const r = /** @type {HTMLInputElement} */ (e.target); ui.setOptions({ [String(r.dataset.key)]: Number(r.value) / 100 }); };
      const onPins = () => ui.setOptions({ pins: select.value });
      // the plugin's own triggers go through the host, like the page's: they supersede a pending trigger, and a failure is reported
      const onGust = () => { ui.trigger('gust').catch(() => {}); };
      const onDrop = () => { ui.trigger(stateName() === 'dropped' ? 'in' : 'drop').catch(() => {}); };
      for (const r of ranges) r.addEventListener('input', onInput);
      select.addEventListener('change', onPins);
      gustButton.addEventListener('click', onGust);
      dropButton.addEventListener('click', onDrop);
      uiSyncs.push(sync);
      sync();
      root.append(box);
      return () => {
        for (const r of ranges) r.removeEventListener('input', onInput);
        select.removeEventListener('change', onPins);
        gustButton.removeEventListener('click', onGust);
        dropButton.removeEventListener('click', onDrop);
        const i = uiSyncs.indexOf(sync);
        if (i >= 0) uiSyncs.splice(i, 1);
        box.remove();
      };
    }
    let shownState = stateName();
    const syncUi = () => { shownState = stateName(); for (const sync of uiSyncs) sync(); };

    return {
      spatial: true,
      /** true while the cloth moves (or crossfades): the host then renders every capped frame, and none at rest */
      get continuous() { return moving(); },
      setOptions(next) {
        const before = o.pins;
        readOptions(next);
        if (cloth) {
          applyFabric(cloth);
          if (pinsNow() !== cloth.pins && (status === HANGING || status === RISING) && !reducedMotion) {
            setPins(cloth, pinsNow());
          } else if (cloth.wind > 0 && status === HANGING) wake(cloth);
        }
        if (before !== o.pins || cloth?.wind) stir();
        syncUi();
        context.requestRender();
      },
      runAction(action, options, info) {
        const reduced = reducedMotion || info.reducedMotion;
        const c = theCloth();
        if (action === 'demo' || action === 'gust') {
          let direction = DEMO_GUST.direction, strength = DEMO_GUST.strength;
          if (action === 'gust') {
            direction = options.direction === undefined ? 0 : Number(options.direction);
            strength = options.strength === undefined ? 1 : Number(options.strength);
            if (!Number.isFinite(direction)) throw new TypeError('cloth: `direction` must be a finite number of degrees (0: towards the right, 90: downwards)');
            if (!Number.isFinite(strength)) throw new TypeError('cloth: `strength` must be a finite number (0.1 to 2)');
          }
          // nothing blows at a cloth that is not there, nor with reduced motion: the state it rests in
          if (!reduced && (status === HANGING || status === RISING)) {
            const d = gustDirection(direction);
            gust(c, c.time, d.x, d.y, Math.min(2, Math.max(0.1, strength)));
            demoBlows = action === 'demo';
            stir();
          }
          return wait();
        }
        if (action === 'drop') {
          riseNext = false;
          if (status === HANGING || status === RISING) {
            if (press.held) { press.id = -1; press.held = false; grabCursor(false); }
            if (reduced) {
              status = DROPPED; layFlat(c); c.asleep = true;
              fade.to = 1; fade.from = fade.now; fade.start = NaN;
            } else {
              status = DROPPING; droppedAt = c.time;
              c.wind = 0;
              letGo(c);
              drop(c, PEEL_S);
              // the air under the falling cloth: without it a cloth that hung flat would fall as a board
              gust(c, c.time, 1, 0.35, 0.5);
            }
            context.requestRender();
            stir();
          }
          syncUi();
          return wait();
        }
        // 'in'
        if (status === DROPPING) riseNext = true;
        else if (status === DROPPED) {
          if (reduced) {
            status = HANGING; setPins(c, 'top'); layFlat(c);
            fade.to = 0; fade.from = fade.now; fade.start = NaN;
            context.requestRender();
          } else rise(c);
        }
        syncUi();
        return wait();
      },
      settled: wait,
      render(frame) {
        const W = frame.cssWidth || canvas.clientWidth || frame.width, H = frame.cssHeight || canvas.clientHeight || frame.height;
        const c = ensureCloth(W, H);
        const alpha = advance(c, frame.now);
        if (fade.now !== fade.to) {
          if (Number.isNaN(fade.start)) fade.start = frame.now;
          const k = Math.min(1, (frame.now - fade.start) / FADE_MS);
          fade.now = fade.from + (fade.to - fade.from) * k * k * (3 - 2 * k);
          if (k >= 1) fade.now = fade.to;
        }
        const mode = status === DROPPED || fade.now > 0 ? GONE : c.flat ? FLAT : CLOTH;
        const D = CAMERA * Math.max(W, H);
        current[S.W] = W; current[S.H] = H; current[S.CAMERA] = D; current[S.COLS] = c.cols; current[S.ROWS] = c.rows; current[S.MODE] = mode;
        current[S.SERIAL] = (serial = (serial + 1) % 8388608);
        globals[U.RES] = frame.width; globals[U.RES + 1] = frame.height; globals[U.CSS] = W; globals[U.CSS + 1] = H;
        globals[U.GRID] = c.cols; globals[U.GRID + 1] = c.rows; globals[U.CAMERA] = D; globals[U.WALL] = c.wall;
        globals[U.LIGHT] = LIGHT[0]; globals[U.LIGHT + 1] = LIGHT[1]; globals[U.LIGHT + 2] = LIGHT[2];
        globals[U.SHEEN] = o.sheen; globals[U.READY] = frame.sourceReady ? 1 : 0; globals[U.THROUGH] = o.through; globals[U.SHADE] = o.shadow;
        globals[U.FADE] = fade.now;
        globals[U.BACKDROP] = o.backdrop[0]; globals[U.BACKDROP + 1] = o.backdrop[1]; globals[U.BACKDROP + 2] = o.backdrop[2];
        globals[U.LINEN] = o.back[0]; globals[U.LINEN + 1] = o.back[1]; globals[U.LINEN + 2] = o.back[2];
        const timestampWrites = frame.profiling?.timestampWrites?.('cloth');
        if (mode !== CLOTH) {
          // the page itself (or, once the cloth has gone, the wall): one full-screen pass
          globals[U.MARGIN] = 0;
          device.queue.writeBuffer(uniforms, 0, globals);
          let group = flatGroups.get(frame.sourceView);
          if (!group) {
            group = device.createBindGroup({ layout: flatLayout, entries: [{ binding: 0, resource: { buffer: uniforms } }, { binding: 2, resource: frame.sourceView }, { binding: 3, resource: sampler }] });
            flatGroups.set(frame.sourceView, group);
          }
          flatAttachment.view = frame.destinationView;
          /** @type {any} */ (flatPass).timestampWrites = timestampWrites;
          const pass = frame.encoder.beginRenderPass(flatPass);
          pass.setPipeline(flatPipe); pass.setBindGroup(0, group); pass.draw(3); pass.end();
          flatAttachment.view = null;
        } else {
          writeControlPoints(current, c, alpha);
          device.queue.writeTexture(pointsCopy, current, pointsLayout, pointsSize);
          const r = resources(frame.width, frame.height, W, H);
          globals[U.MARGIN] = r.margin;
          device.queue.writeBuffer(uniforms, 0, globals);
          const columns = 2 * (c.cols * SUB + 1), strips = c.rows * SUB;
          // the cloth as the lamp sees it, and its two blurred copies
          mapAttachment.view = r.views.sharp;
          const lamp = frame.encoder.beginRenderPass(mapPass);
          lamp.setPipeline(shadowPipe); lamp.setBindGroup(0, shadowGroup); lamp.draw(columns, strips); lamp.end();
          for (const b of r.blurs) {
            mapAttachment.view = b.dst;
            const blur = frame.encoder.beginRenderPass(mapPass);
            blur.setPipeline(blurPipe); blur.setBindGroup(0, b.group); blur.draw(3); blur.end();
          }
          mapAttachment.view = null;
          let group = r.groups.get(frame.sourceView);
          if (!group) {
            group = device.createBindGroup({ layout: mainLayout, entries: [
              { binding: 0, resource: { buffer: uniforms } }, { binding: 1, resource: pointsView }, { binding: 2, resource: frame.sourceView },
              { binding: 3, resource: sampler }, { binding: 4, resource: r.views.near }, { binding: 5, resource: r.views.wide },
            ] });
            r.groups.set(frame.sourceView, group);
          }
          mainAttachment.view = r.colorView; mainAttachment.resolveTarget = frame.destinationView; depthAttachment.view = r.depthView;
          /** @type {any} */ (mainPass).timestampWrites = timestampWrites;
          const pass = frame.encoder.beginRenderPass(mainPass);
          pass.setBindGroup(0, group);
          pass.setPipeline(clothPipe); pass.draw(columns, strips);
          pass.setPipeline(wallPipe); pass.draw(3);
          pass.end();
          mainAttachment.view = null; mainAttachment.resolveTarget = null; depthAttachment.view = null;
        }
        if (shownState !== stateName()) syncUi();
        if (waiters.length && still()) { const state = stateName(); for (const resolve of waiters.splice(0)) resolve(state); }
      },
      // called each time a frame is PRESENTED: the state of that frame is copied into one of 4 slots
      captureInputMapper() {
        mapperSlot = (mapperSlot + 1) % MAPPER_SLOTS;
        shown = slots[mapperSlot];
        if (current[S.MODE] === CLOTH) shown.set(current); else shown.set(current.subarray(0, HEAD));
        return mappers[mapperSlot];
      },
      mountUI,
      destroy() {
        for (const resolve of waiters.splice(0)) resolve(null);
        for (const [type, fn] of documentListeners) doc.removeEventListener?.(type, fn, true);
        if (press.held) { try { captureEl.releasePointerCapture(press.id); } catch { /* gone */ } }
        grabCursor(false);
        if (sized) for (const t of sized.textures) t.destroy?.();
        pointsTexture?.destroy?.();
        for (const b of [uniforms, ...blurUniforms]) b.destroy?.();
      },
    };
  },
});
