/**
 * Ink effect plugin (effect plugin ABI v2): an EXAMPLE of the effects extension of html-in-canvas-polyfill, not part of the polyfill.
 *
 * The live page as wet ink on a thin layer of water. sim.js steps an incompressible 2D fluid on the CPU (vorticity and stream function
 * on cells of about 10 CSS px, 120 steps per second) together with the displacement of the page that the flow carries and that relaxes
 * back to zero; the pointer pushes the water (a pair of swirls either side of its path, swaying as a wake does: gently while it hovers,
 * hard while it is pressed), a pressed pointer or a finger also releases pigment, and a press lets a drop fall that spreads over the water
 * (sim.js bloom). The pigment lives on the GPU at about one texel per CSS px (advect.wgsl: three inks and their age, carried by the same
 * flow); ink.wgsl draws the displaced page (a cubic B-spline of the field per device pixel) under the pigment (a Kubelka-Munk layer in
 * linear light) and the sheen of the moving water.
 *
 * Input: the input mapper (`mapInkPoint`) evaluates the very field that was uploaded for the presented frame (copied into one of four
 * slots) with the same B-spline as the shader, so clicks and typing reach the element the user sees mid-swirl. The pointer and touch
 * listeners are passive: a finger keeps scrolling the page.
 *
 * Zero work at rest: the vorticity and the displacement reach exactly zero in finite time (sim.js) and the pigment is gone INK_LIFE
 * seconds after its release; the instance is `continuous` only until then, and the frame at rest is the source, texel for texel.
 *
 * Actions: 'demo' (one S-shaped stroke across the page), 'stir' (a short stroke at `point`), 'clear' (wipes the ink at once); each
 * resolves 'still' once nothing moves and no pigment is left. With reduced motion nothing flows: a press leaves a tint that fades in place.
 *
 * `plugin` is a plain, frozen definition that `host.addPlugin` validates (docs/guides/EFFECTS-PLUGINS.md).
 */

import { wgsl } from './wgsl.js';
import { stateMapper } from '../_lib/mapper.js';
import { injectStyle } from '../_lib/ui.js';
import { pointerIn } from '../_lib/pointer.js';
import { actionPoint } from '../_lib/action.js';
import { clampNum } from '../_lib/number.js';
import { hdrConstants } from '../_lib/hdr.js';
import { CHANNELS, DT, MAX_STEPS_PER_FRAME, PAD, STEP_MS, bloom, clear, createFluid, fieldAt, gridOf, pack, quiet, setSize, step, stir, velocityAt } from './sim.js';

/** @typedef {import('../../src/contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../../src/contracts/types.js').InputPoint} InputPoint */
/** @typedef {import('./sim.js').Fluid} Fluid */
/** @typedef {{t0: number, ms: number, at: (s: number, out: {x: number, y: number}) => void, has: boolean, x: number, y: number}} Script  a stroke that the plugin draws itself, on the simulation clock */

/**
 * What the plugin gallery and the build read (plugins/README.md).
 * @experimental an example plugin of the effects, an extension of this library, not part of the HTML-in-Canvas standard (docs/STABILITY.md)
 */
export const meta = Object.freeze({
  name: 'ink',
  title: 'Ink',
  description: 'The page as wet ink on water: the pointer stirs a 2D fluid that smears and swirls the live page and releases pigment; the page heals, input follows.',
  defaults: Object.freeze({ intensity: 0.6, flow: 0.5, pigment: 0.7 }),
  reducedMotion: 'Nothing flows and the page never moves: a press leaves a soft tint that fades in place; demo resolves at once.',
  touch: 'Drag a finger sideways to stir the ink, tap for a drop; a vertical drag still scrolls the page.',
});

/** The actions of `handle.trigger`. */
export const ACTIONS = Object.freeze(/** @type {const} */ (['demo', 'stir', 'clear']));

/** Offsets in the uniform block (ink.wgsl Globals), in floats. The mapper state is this block followed by the packed field. */
export const G = Object.freeze({ RES: 0, CSS: 2, GRID: 4, INV_CELL: 6, BOX: 8, INK_BOX: 12, LAYER: 16, MOVED: 17, READY: 18, INKED: 19, LOOK: 20, ABSORB: 24, SCATTER: 36, DROPS: 48 });
export const GLOBALS_LENGTH = 64;
/** Offsets in the uniform block of one pigment step (advect.wgsl Step), in floats; STEP_FLOATS each (256 bytes, the offset alignment of uniform buffers). */
export const S = Object.freeze({ SIZE: 0, CSS: 2, GRID: 4, INV_CELL: 6, DT: 8, LIFE: 9, CAP: 10, LAYER: 11, COUNT: 12, FLOWING: 13, SEG: 16, SHAPE: 32, INK: 48, BLOOM: 64 });
export const STEP_FLOATS = 128;
/** segments of pigment released per step (advect.wgsl), and how many may wait for their step */
export const SEGMENTS_PER_STEP = 4;
const SEGMENT_QUEUE = 64;
/** mapper states kept alive: the mapper chain keeps the last 3 presented frames, plus the one being written */
const MAPPER_SLOTS = 4;

/**
 * How hard the pointer pushes the water. A pressed pointer pushes the water under it towards its own velocity by PRESS_PUSH of the
 * difference per pass (times intensity). A hovering pointer only sets the water under it moving at HOVER_PUSH of its own speed, at most
 * HOVER_WATER CSS px/s (both times intensity): the water it drives never outruns that, however often it passes, so the page under a
 * hover sweep moves by at most 3 CSS px at the defaults (test/ink.test.mjs), and text stays readable.
 */
export const HOVER_PUSH = 0.11;
export const HOVER_WATER = 26;
export const PRESS_PUSH = 0.5;
/** the reach of the push, CSS px, and the fastest pointer it follows, CSS px/s */
export const STIR_RADIUS = 32;
const MAX_POINTER_SPEED = 2400;
/** the integral of the push's profile (1 - t^2)^3 across its diameter, in radii: a pass straight through gives the centre the full push */
const PROFILE_LINE = 32 / 35;
/**
 * The wake of a body that moves through water sheds swirls to alternate sides (a vortex street), about one pair per five body widths.
 * The push sways sideways by WAKE_SWAY of its strength with that period along the path, so a stroke leaves a street and not a
 * straight jet: the swirls that fold the pigment.
 */
export const WAKE_SWAY = 0.4;
export const WAKE_PX = 5 * STIR_RADIUS;
/** a press on a moving pointer: the drop also lands with this speed (CSS px/s at intensity 1) in the direction the pointer was moving */
export const DROP_PUSH = 210;
/**
 * A drop spreads over the water (sim.js `bloom`): within BLOOM_REACH CSS px of where it landed, at the speed scale BLOOM_SPEED CSS px/s
 * at intensity 1 (the fastest water, at 0.45 of the reach, moves at 0.29 of it), for BLOOM_S seconds. Its pigment is released as dense as
 * DROP_DENSITY times `pigment` (a drop is thick: its ink thins as it spreads), above INK_CAP.
 */
export const BLOOM_REACH = 60;
/** around a drop, within WET_REACH x BLOOM_REACH of where it landed and while its pigment lives, the ink ends in a crisp wet edge (ink.wgsl) */
export const WET_REACH = 1.8;
export const BLOOM_SPEED = 1500;
export const DROP_DENSITY = 5;
/** the pigment: the Gaussian radius of the pen and of a drop (CSS px), their reach in radii (advect.wgsl), the density at pigment 1 */
export const PEN_RADIUS = 8;
export const DROP_RADIUS = 13;
/** the edge of a drop: exp(-(d^2 / r^2)^DROP_EDGE / 2), a disc with a soft rim (1 would be a Gaussian) */
export const DROP_EDGE = 4;
export const REACH = 3;
export const INK_DENSITY = 1;
/** no ink gets denser than this, however often the pen passes (a drop may be released denser) */
export const INK_CAP = 1.2;
/**
 * The pigment keeps its full strength until it is INK_HOLD seconds old, then fades, and is gone at INK_LIFE seconds (ink.wgsl,
 * advect.wgsl): a stroke stays whole while it is drawn and folded, and all pigment is gone INK_LIFE after the last release.
 */
export const INK_HOLD = 1.3;
export const INK_LIFE = 2.9;
/** the plugin keeps rendering this long after the last pigment is due to go, ms (the age of a mixture is carried with a filter) */
const INK_SLACK_MS = 150;
/** the pigment texture: about this many texels, at most the device resolution */
export const PIGMENT_TEXELS = 900000;
/** vorticity confinement, 1/s (sim.js) */
export const CONFINE = 3;
/** the hue: successive strokes start this far along the palette (the golden ratio: no two alike), and it drifts once round per HUE_PX of path */
const HUE_STEP = 0.381966;
const HUE_PX = 2600;
/** the demo: one stroke across the page in DEMO_MS; the action stir: a stroke of STIR_PX CSS px in STIR_MS at strength 1 */
export const DEMO_MS = 1300;
export const STIR_PX = 150;
export const STIR_MS = 300;
const GOLDEN_ANGLE = 2.399963;

/**
 * The palettes: three inks each, as [colour of the ink on white paper, colour of the light its particles scatter]. The absorption of an
 * ink is K = ABSORB * -ln(colour) per channel and its scattering S = SCATTER * sheen: over a bright page the ink shows by what it
 * absorbs, over a dark page by what it scatters. Both are strong: a layer of density 0.1 still shows.
 */
export const PALETTES = Object.freeze({
  marbling: Object.freeze([['#2740c9', '#5d86ff'], ['#d3204f', '#ff5c7c'], ['#f2a516', '#ffc04a']]),
  sumi: Object.freeze([['#14161c', '#b99a6e'], ['#b8281f', '#ff7a5c'], ['#1f2f52', '#8fa9e6']]),
  neon: Object.freeze([['#00b7ff', '#35d8ff'], ['#ff2d95', '#ff5cb0'], ['#7bdc00', '#b6ff3d']]),
});
const ABSORB = 2.2;
const SCATTER = 2.6;

let uiSerial = 0;

/** `#rgb` or `#rrggbb` to linear RGB, or null. @param {unknown} value @returns {number[]|null} */
function linearColor(value) {
  const m = typeof value === 'string' ? /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim()) : null;
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
  return [0, 2, 4].map((i) => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
}

/**
 * The absorption and scattering of the three inks of a palette, as the uniform block holds them (3 x vec4 K, then 3 x vec4 S; linear
 * RGB per unit density). `palette` is a name of PALETTES, or up to three entries, each a colour or a pair [ink, sheen]; anything else,
 * and every entry that is not a colour, falls back to 'marbling'. PURE. @param {unknown} palette @returns {Float32Array}
 */
export function inkOptics(palette) {
  const base = PALETTES.marbling;
  const named = typeof palette === 'string' && Object.hasOwn(PALETTES, palette) ? /** @type {any} */ (PALETTES)[palette] : null;
  const list = named ?? (Array.isArray(palette) && palette.length ? palette : base);
  const out = new Float32Array(24);
  for (let i = 0; i < 3; i += 1) {
    const entry = list[i % list.length];
    const pair = Array.isArray(entry) ? entry : [entry, entry];
    const ink = linearColor(pair[0]) ?? /** @type {number[]} */ (linearColor(base[i][0]));
    const sheen = linearColor(pair[1]) ?? linearColor(pair[0]) ?? /** @type {number[]} */ (linearColor(base[i][1]));
    for (let c = 0; c < 3; c += 1) {
      out[i * 4 + c] = ABSORB * Math.log(1 / Math.min(1, Math.max(0.02, ink[c])));
      out[12 + i * 4 + c] = SCATTER * sheen[c];
    }
  }
  return out;
}

/**
 * The shares of the three inks at `phase` along the palette (one turn per unit): two neighbours, cross-faded. PURE.
 * @param {number} phase @param {Float32Array|number[]} out  four numbers from `offset`; the fourth is 0 @param {number} [offset]
 */
export function inkMix(phase, out, offset = 0) {
  const p = (phase - Math.floor(phase)) * 3, i = Math.floor(p) % 3, t = p - Math.floor(p), k = t * t * (3 - 2 * t);
  for (let c = 0; c < 4; c += 1) out[offset + c] = 0;
  out[offset + i] = 1 - k;
  out[offset + ((i + 1) % 3)] = k;
}

/**
 * Source point shown at the presented point `point`, for the mapper state `state` (the uniform block, then the packed field): the same
 * math as fs() in ink.wgsl (the B-spline of the displacement, the clamp to the canvas). PURE.
 * @param {Float32Array} state
 * @param {InputPoint} point  presented point, canvas CSS px, plus the presented size
 * @returns {{x: number, y: number}}
 */
export function mapInkPoint(state, point) {
  if (state[G.MOVED] < 0.5) return { x: point.x, y: point.y };
  const width = Math.max(1, point.width), height = Math.max(1, point.height);
  const u = point.x / width, v = point.y / height;
  const gw = state[G.GRID], gh = state[G.GRID + 1];
  const s = fieldAt(state, GLOBALS_LENGTH, gw + 2 * PAD, gh + 2 * PAD, u * gw - 0.5 + PAD, v * gh - 0.5 + PAD);
  return {
    x: Math.min(1, Math.max(0, u - s.dx / Math.max(1, state[G.CSS]))) * width,
    y: Math.min(1, Math.max(0, v - s.dy / Math.max(1, state[G.CSS + 1]))) * height,
  };
}

/**
 * The stroke of the demo: an S across the page, slow at both ends. PURE.
 * @param {number} s  0..1 of DEMO_MS @param {number} w @param {number} h  CSS px of the canvas @param {{x: number, y: number}} out
 */
export function demoPath(s, w, h, out) {
  const k = s * s * (3 - 2 * s);
  out.x = w * (0.12 + 0.76 * k);
  out.y = h * (0.5 - 0.27 * Math.sin(2 * Math.PI * k));
}

/** The pigment texture of a canvas of this CSS size at this device pixel ratio. PURE. @param {number} w @param {number} h @param {number} dpr */
export function pigmentGrid(w, h, dpr) {
  const scale = Math.min(Math.max(1, dpr), Math.sqrt(PIGMENT_TEXELS / Math.max(1, w * h)));
  return { w: Math.max(8, Math.round(w * scale)), h: Math.max(8, Math.round(h * scale)) };
}

/** CSS of the plugin UI (mountUI) */
// (each colour is light-dark(on a light page, on a dark page): the controls follow the page's color-scheme)
const UI_CSS = `
    .hic-ink-ui { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:4px 12px; align-items:end; }
    .hic-ink-ui label { display:grid; grid-template-columns:1fr auto; gap:2px 6px; min-width:0; font-size:10px; font-weight:700; }
    .hic-ink-ui output { color:light-dark(#006b80, #9cf5ff); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .hic-ink-ui input[type=range] { grid-column:1 / -1; width:100%; height:22px; margin:0; accent-color:light-dark(#2a4fb0, #8fb4ff); cursor:ew-resize; }
  `;
const SLIDERS = /** @type {const} */ ([['intensity', 'Stir'], ['flow', 'Flow'], ['pigment', 'Pigment']]);

/**
 * The two pipelines, compiled asynchronously where the device can.
 * @param {any} device @param {string} format @param {string} picture @param {string} advect @param {Record<string, number>} constants  of the picture (HDR_PEAK)
 */
async function createPipelines(device, format, picture, advect, constants) {
  // the shader modules first: the bundle check stops a fake device at the first other call, and wants to have seen the inlined WGSL by then
  const module = device.createShaderModule({ code: picture, label: 'hic-ink-shader' });
  const advectModule = device.createShaderModule({ code: advect, label: 'hic-ink-advect-shader' });
  const make = (/** @type {any} */ d) => (device.createRenderPipelineAsync ? device.createRenderPipelineAsync(d) : device.createRenderPipeline(d));
  const stage = /** @type {any} */ (globalThis).GPUShaderStage?.FRAGMENT ?? 2;
  const layout = device.createBindGroupLayout({
    label: 'hic-ink-layout',
    entries: [
      { binding: 0, visibility: stage, buffer: { type: 'uniform' } },
      { binding: 1, visibility: stage, sampler: { type: 'filtering' } },
      { binding: 2, visibility: stage, texture: { sampleType: 'float' } },
      // the field is read with textureLoad only (rgba32float is not filterable without an optional feature)
      { binding: 3, visibility: stage, texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } },
      { binding: 4, visibility: stage, texture: { sampleType: 'float' } },
    ],
  });
  const advectLayout = device.createBindGroupLayout({
    label: 'hic-ink-advect-layout',
    entries: [
      { binding: 0, visibility: stage, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: STEP_FLOATS * 4 } },
      { binding: 1, visibility: stage, sampler: { type: 'filtering' } },
      { binding: 2, visibility: stage, texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } },
      { binding: 3, visibility: stage, texture: { sampleType: 'float' } },
    ],
  });
  const [pipeline, advectPipeline] = await Promise.all([
    make({
      label: 'hic-ink-pipeline', layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }], constants }, primitive: { topology: 'triangle-list' },
    }),
    make({
      label: 'hic-ink-advect-pipeline', layout: device.createPipelineLayout({ bindGroupLayouts: [advectLayout] }),
      vertex: { module: advectModule, entryPoint: 'vs' }, fragment: { module: advectModule, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] }, primitive: { topology: 'triangle-list' },
    }),
  ]);
  return { pipeline, layout, advectPipeline, advectLayout };
}

/**
 * A stirred fluid of this CSS size that nothing shows: stepping it lets the engine compile the step before the first stroke needs it
 * (cold, the first step of a 1100 x 620 canvas took 18 ms and the second 5 ms, where a step takes 0.6 ms). @param {number} w @param {number} h
 */
function rehearsal(w, h) {
  const f = createFluid(w, h);
  for (let i = 0; i < 12; i += 1) stir(f, f.cssWidth * (0.2 + 0.05 * i), f.cssHeight * (0.5 + 0.2 * Math.sin(i)), 300, 200 * Math.cos(i), STIR_RADIUS);
  return f;
}
const REHEARSAL = Object.freeze({ drag: 0.2, heal: 1, confine: CONFINE });

/**
 * The plugin's definition (effect plugin ABI v2).
 * @experimental an example plugin of the effects, an extension of this library, not part of the HTML-in-Canvas standard (docs/STABILITY.md)
 * @type {EffectPluginDefinition}
 */
export const plugin = Object.freeze({
  type: 'ink',
  apiVersion: /** @type {const} */ (2),
  version: 1,
  actions: ACTIONS,
  // The picture pass only writes its destination as a same-format colour attachment; it never samples or reads it back.
  outputCapabilities: Object.freeze({ directCanvasRenderAttachment: /** @type {const} */ (true) }),
  async create(context, initialOptions) {
    const { device, format } = context;
    // extended range (context.hdr): the picture's shader reads HDR_PEAK (the sheen of the water may go above white)
    const pipelines = createPipelines(device, format, await wgsl('ink.wgsl'), await wgsl('advect.wgsl'), hdrConstants(context));
    // while the pipelines compile: 60 steps of a small fluid (about 10 ms), so that the first stroke does not meet uncompiled code
    for (let i = 0, f = rehearsal(160, 160); i < 60; i += 1) step(f, REHEARSAL);
    const { pipeline, layout, advectPipeline, advectLayout } = await pipelines;
    const gpu = /** @type {any} */ (globalThis);
    const bufferUsage = gpu.GPUBufferUsage;
    const textureUsage = gpu.GPUTextureUsage ?? { COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
    const uniformBuffer = device.createBuffer({ label: 'hic-ink-globals', size: GLOBALS_LENGTH * 4, usage: bufferUsage.UNIFORM | bufferUsage.COPY_DST });
    const stepBuffer = device.createBuffer({ label: 'hic-ink-steps', size: MAX_STEPS_PER_FRAME * STEP_FLOATS * 4, usage: bufferUsage.UNIFORM | bufferUsage.COPY_DST });
    const sampler = device.createSampler({ label: 'hic-ink-sampler', magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const globals = new Float32Array(GLOBALS_LENGTH);
    const stepData = new Float32Array(STEP_FLOATS);
    const stepOffsets = Uint32Array.from({ length: MAX_STEPS_PER_FRAME }, (_, i) => i * STEP_FLOATS * 4);
    const canvas = context.canvas;
    const win = /** @type {any} */ (canvas.ownerDocument.defaultView);
    // prefers-reduced-motion (read now, and by the host at every trigger): nothing flows, the page never moves, a press leaves a tint
    const reducedMotion = !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    // and, in idle moments after that, 30 steps of a fluid of the canvas's size (the loops of the full grid), at most 3 ms at a time
    let rehearsing = 30;
    {
      const idle = win.requestIdleCallback?.bind(win) ?? ((/** @type {() => void} */ fn) => setTimeout(fn, 50));
      const f = rehearsal(canvas.clientWidth || 1, canvas.clientHeight || 1);
      const some = () => {
        const t = performance.now();
        while (rehearsing > 0 && performance.now() - t < 3) { step(f, REHEARSAL); rehearsing -= 1; }
        if (rehearsing > 0) idle(some);
      };
      idle(some);
    }

    let intensity = clampNum(initialOptions?.intensity, 0, 1, meta.defaults.intensity);
    let flow = clampNum(initialOptions?.flow, 0, 1, meta.defaults.flow);
    let heal = clampNum(initialOptions?.heal, 0, 1, 0.5);
    let pigment = clampNum(initialOptions?.pigment, 0, 1, meta.defaults.pigment);
    let palette = initialOptions?.palette;
    let selectText = initialOptions?.selectText === true;
    globals.set(inkOptics(palette), G.ABSORB);
    globals[G.LOOK] = INK_HOLD; globals[G.LOOK + 1] = INK_LIFE;
    /** the constants of a step: the flow dies by 1/e in 0.3 s (flow 0) to 3 s (flow 1); the page comes home at 1/s (heal 0) to 8/s (heal 1) */
    const params = { drag: 1, heal: 1, confine: CONFINE };
    const tune = () => { params.drag = 1 / (0.3 * 10 ** flow); params.heal = 8 ** heal; };
    tune();

    /** @type {Fluid|null} */ let fluid = null;
    /** the field of the last step, as uploaded (CHANNELS floats per cell) @type {Float32Array} */ let packed = new Float32Array(0);
    /** @type {any} */ let fieldTexture = null;
    /** @type {any} */ let fieldView = null;
    /** the layer of the field texture that holds the newest field */
    let layer = 0;
    /** the two pigment textures (the newest is `pig[cur]`), their views, and the rectangle of each that may hold pigment (texels: x0 y0 x1 y1) */
    let pig = /** @type {any[]} */ ([null, null]);
    let pigViews = /** @type {any[]} */ ([null, null]);
    let pigSize = { w: 0, h: 0 };
    let cur = 0;
    const dirty = [new Int32Array(4), new Int32Array(4)];
    /** CSS px rectangle outside which there is no pigment; empty when x0 > x1 */
    const inkBox = new Float64Array([1, 1, 0, 0]);
    /** some pigment may be left: until `inkUntil` on the simulation clock, the life of the pigment after the last release */
    let inkLive = false, inkUntil = 0;
    /** the pigment textures hold pigment that must go before the next step (it has outlived its life, or the action clear) */
    let wipe = false;
    /** @type {any[]} */ let advectGroups = [null, null];
    let bindGroups = new WeakMap();
    const pigAttachment = { view: /** @type {any} */ (null), loadOp: 'load', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } };
    const pigPass = { colorAttachments: [pigAttachment] };
    const attachment = { view: /** @type {any} */ (null), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } };
    const passDescriptor = { colorAttachments: [attachment], timestampWrites: /** @type {any} */ (undefined) };

    /** something moves or fades: frames are needed until everything is at rest */
    let awake = false;
    /** the simulation clock, ms on the frame time base: the fluid has been stepped up to this time */
    let simClock = 0;
    /** woken by an event, no frame since: the first frame sets the clock's phase (advance) */
    let clockFromEvent = false;
    /** strokes that the plugin draws itself (the demo, the action stir), on the simulation clock @type {Script[]} */
    let scripts = [];
    /** resolves the running demo with null when the user takes over @type {((state: string|null) => void)|null} */
    let demoTakeover = null;
    /** @type {((state: string|null) => void)[]} */ const waiters = [];
    /** pigment waiting for its step: [ax, ay, bx, by, radius, density, the shares of the three inks, the sharpness of a drop], SEGMENT_QUEUE of them in a ring */
    const segments = new Float32Array(SEGMENT_QUEUE * 10);
    let segmentHead = 0, segmentCount = 0;
    /** where the hue is along the palette, and the direction of the last drop */
    let hue = 0, dropAngle = 0.4;
    /** drops so far (the seed of a drop's front and tendrils), and the last four: x, y (CSS px of the fluid), until (simulation clock) */
    let drops = 0;
    const wetDiscs = new Float64Array(12);
    /** the length of all paths so far, CSS px (the phase of the wake's sway) */
    let travel = 0;
    /** mapper states: the uniform block followed by the packed field (reallocated with the fluid) @type {Float32Array[]} */
    let mapperStates = [];
    /** @type {any[]} */ let mappers = [];
    let mapperSlot = 0;
    /** @type {Array<() => void>} */ const uiSyncs = [];
    const point = { x: 0, y: 0 }, water = { x: 0, y: 0 };

    const releasePigment = () => { for (const t of pig) t?.destroy?.(); pig = [null, null]; pigViews = [null, null]; };

    /** The fluid of a canvas of this CSS size, its field texture and its pigment textures. @param {number} cssWidth @param {number} cssHeight @param {number} dpr */
    function ensureFluid(cssWidth, cssHeight, dpr) {
      let f = fluid;
      if (!f || Math.abs(f.cssWidth - cssWidth) >= 0.01 || Math.abs(f.cssHeight - cssHeight) >= 0.01) {
        const grid = gridOf(cssWidth, cssHeight);
        if (f && f.gw === grid.gw && f.gh === grid.gh) setSize(f, cssWidth, cssHeight);
        else {
          f = fluid = createFluid(cssWidth, cssHeight);
          packed = new Float32Array(f.pw * f.ph * CHANNELS);
          fieldTexture?.destroy?.();
          fieldTexture = device.createTexture({ label: 'hic-ink-field', size: { width: f.pw, height: f.ph, depthOrArrayLayers: MAX_STEPS_PER_FRAME }, format: 'rgba32float', usage: textureUsage.TEXTURE_BINDING | textureUsage.COPY_DST });
          fieldView = fieldTexture.createView({ dimension: '2d-array' });
          layer = 0;
          mapperStates = Array.from({ length: MAPPER_SLOTS }, () => new Float32Array(GLOBALS_LENGTH + packed.length));
          mappers = mapperStates.map((s) => stateMapper(s, mapInkPoint));
          segmentCount = 0; scripts = [];
          pigSize = { w: 0, h: 0 };
        }
      }
      const size = pigmentGrid(f.cssWidth, f.cssHeight, dpr);
      if (size.w !== pigSize.w || size.h !== pigSize.h) {
        releasePigment();
        pigSize = size;
        for (let i = 0; i < 2; i += 1) {
          pig[i] = device.createTexture({ label: `hic-ink-pigment-${i}`, size: { width: size.w, height: size.h }, format: 'rgba16float', usage: textureUsage.TEXTURE_BINDING | textureUsage.RENDER_ATTACHMENT });
          pigViews[i] = pig[i].createView();
          dirty[i].set([size.w, size.h, 0, 0]);
        }
        // advectGroups[i] reads pig[i]
        advectGroups = pigViews.map((view, i) => device.createBindGroup({
          label: `hic-ink-advect-bind-group-${i}`, layout: advectLayout,
          entries: [{ binding: 0, resource: { buffer: stepBuffer, size: STEP_FLOATS * 4 } }, { binding: 1, resource: sampler }, { binding: 2, resource: fieldView }, { binding: 3, resource: view }],
        }));
        bindGroups = new WeakMap();
        // new textures are empty: whatever pigment there was is gone
        inkLive = false;
        inkBox.set([1, 1, 0, 0]);
        wipe = false;
      }
      return f;
    }

    /** the fluid (before the first frame: one of the canvas's client size) */
    const currentFluid = () => fluid ?? ensureFluid(canvas.clientWidth || 1, canvas.clientHeight || 1, win.devicePixelRatio || 1);

    /** Something starts to move (input, an action): the simulation clock starts now, and the first frame aligns it to the frames (advance). */
    function wake() {
      if (!awake) { awake = true; simClock = performance.now(); clockFromEvent = true; }
      context.requestRender();
    }

    /** User input during the demo: its stroke stops at once and the demo resolves null; the input takes over. */
    function takeOver() {
      if (!demoTakeover) return;
      scripts = [];
      const resolve = demoTakeover;
      demoTakeover = null;
      resolve(null);
    }

    const calm = () => !awake && !scripts.length && !segmentCount;
    /** @returns {'still'|Promise<string|null>} */
    const wait = () => (calm() ? 'still' : new Promise((resolve) => { waiters.push(resolve); }));

    /**
     * Pigment for the next step: along a - b (CSS px of the fluid), a Gaussian of `radius` across with `density` at its centre, in the
     * inks at `phase` of the palette. @param {number} ax @param {number} ay @param {number} bx @param {number} by @param {number} radius @param {number} density @param {number} phase @param {number} [edge]
     */
    function release(ax, ay, bx, by, radius, density, phase, edge = 1) {
      if (density <= 0) return;
      // a full queue (no frame for a long time): the oldest segment gives way
      if (segmentCount === SEGMENT_QUEUE) { segmentHead = (segmentHead + 1) % SEGMENT_QUEUE; segmentCount -= 1; }
      const o = ((segmentHead + segmentCount) % SEGMENT_QUEUE) * 10;
      segments[o] = ax; segments[o + 1] = ay; segments[o + 2] = bx; segments[o + 3] = by; segments[o + 4] = radius; segments[o + 5] = density;
      inkMix(phase, segments, o + 6);
      segments[o + 9] = edge;
      segmentCount += 1;
    }

    /**
     * The pointer (or a stroke of the plugin) went from a to b (CSS px of the fluid) in `ms`: it pushes the water along its path (pressed:
     * PRESS_PUSH of its speed relative to the water there; hovering: towards the bounded speed of HOVER_PUSH and HOVER_WATER), and, `inked`,
     * releases pigment. With reduced motion only the pigment.
     * @param {number} ax @param {number} ay @param {number} bx @param {number} by @param {number} ms @param {boolean} pressed @param {boolean} inked @param {boolean} still
     */
    function stroke(ax, ay, bx, by, ms, pressed, inked, still) {
      if (intensity <= 0) return;
      const f = currentFluid();
      const dist = Math.hypot(bx - ax, by - ay);
      if (dist <= 0) return;
      const seconds = Math.max(4, ms) / 1000;
      const speed = Math.min(MAX_POINTER_SPEED, dist / seconds);
      const ex = (bx - ax) / dist, ey = (by - ay) / dist;
      if (!still) {
        const n = Math.max(1, Math.ceil((3 * dist) / STIR_RADIUS));
        const gain = ((pressed ? PRESS_PUSH * intensity : 1) * dist) / (n * PROFILE_LINE * STIR_RADIUS);
        const drive = pressed ? speed : Math.min(HOVER_PUSH * speed, HOVER_WATER) * intensity;
        for (let k = 0; k < n; k += 1) {
          const t = (k + 0.5) / n, x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
          const sway = drive * WAKE_SWAY * Math.sin((2 * Math.PI * (travel + dist * t)) / WAKE_PX);
          velocityAt(f, x, y, water);
          stir(f, x, y, (ex * drive - ey * sway - water.x) * gain, (ey * drive + ex * sway - water.y) * gain, STIR_RADIUS);
        }
      }
      travel += dist;
      if (inked && pigment > 0) {
        // a slow pen leaves a broader, denser line; the pen carries two inks side by side, which the wake folds into each other
        const slow = Math.exp(-speed / 500), radius = PEN_RADIUS * (0.8 + 0.5 * slow), density = pigment * INK_DENSITY * (0.55 + 0.45 * slow);
        const ox = -ey * 0.8 * radius, oy = ex * 0.8 * radius;
        release(ax + ox, ay + oy, bx + ox, by + oy, radius, density, hue);
        release(ax - ox, ay - oy, bx - ox, by - oy, radius, density, hue + 1 / 3);
        hue += dist / HUE_PX;
      }
      wake();
    }

    /**
     * A drop of ink at (x, y) CSS px of the fluid: it spreads over the water (a bloom whose front gathers a rim and then breaks up into
     * tendrils), and, landing with the speed (jx, jy) CSS px/s, the water also takes it as a puff (a pair of swirls). The drop is one ink
     * around a core of the next. @param {number} x @param {number} y @param {number} jx @param {number} jy @param {boolean} still
     */
    function drop(x, y, jx, jy, still) {
      if (intensity <= 0) return;
      const f = currentFluid();
      hue += HUE_STEP;
      drops += 1;
      if (!still) {
        wake();
        // its wet edge, in the place of the drop whose pigment goes first
        let at = 0;
        for (let k = 3; k < 12; k += 3) if (wetDiscs[k + 2] < wetDiscs[at + 2]) at = k;
        wetDiscs.set([x, y, simClock + INK_LIFE * 1000 + INK_SLACK_MS], at);
        bloom(f, x, y, BLOOM_SPEED * intensity, BLOOM_REACH, drops);
        if (jx || jy) stir(f, x, y, jx * intensity, jy * intensity, STIR_RADIUS);
      }
      if (pigment > 0) {
        // with reduced motion nothing spreads: the tint stays as dense as a stroke
        const density = pigment * (still ? INK_DENSITY : DROP_DENSITY);
        release(x, y, x, y, DROP_RADIUS, density, hue, DROP_EDGE);
        release(x, y, x, y, 0.5 * DROP_RADIUS, density, hue + 1 / 3, DROP_EDGE);
      }
      wake();
    }

    /** canvas client px -> CSS px of the fluid @param {number} x @param {number} y */
    const toFluid = (x, y) => {
      const f = currentFluid();
      return { x: (x * f.cssWidth) / Math.max(1, canvas.clientWidth), y: (y * f.cssHeight) / Math.max(1, canvas.clientHeight) };
    };
    /** CSS px of the fluid from client px, with the canvas where it is NOW, through the plugins added after this one (null where one of them shows none of this picture) @param {number} cx @param {number} cy */
    const local = (cx, cy) => {
      const p = pointerIn(context, canvas, cx, cy);
      return p && toFluid(p.x, p.y);
    };

    {
      /** @type {{x: number, y: number, t: number}|null} */ let last = null;
      /** a pointer is pressed on the canvas; `own`: the press began on a control of the page (a field, a button, a slider, a link, a label) */
      let pressing = false, own = false;
      const CONTROLS = 'input, textarea, select, button, a[href], label, summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="slider"]';
      const onControl = (/** @type {Event} */ event) => {
        const target = /** @type {any} */ (event.target);
        return !!(target?.closest ? target : target?.parentElement)?.closest?.(CONTROLS);
      };
      /** the direction the pointer last moved in (unit), and when */
      let headX = 0, headY = 0, headT = -1e9;
      /** @param {{x: number, y: number}} a @param {{x: number, y: number}} b @param {number} ms @param {boolean} pressed @param {number} t */
      const move = (a, b, ms, pressed, t) => {
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        // a jump (the pointer came back from elsewhere, a long pause) starts a new path
        if (dist < 0.5 || dist > 250 || ms > 150) return;
        headX = (b.x - a.x) / dist; headY = (b.y - a.y) / dist; headT = t;
        if (reducedMotion) return;
        takeOver();
        stroke(a.x, a.y, b.x, b.y, ms, pressed, pressed, false);
      };
      // passive: the ink never claims a gesture (a finger keeps scrolling the page; the browser then cancels the pointer)
      const passive = { passive: true };
      /** the last pointerdown handled: context.listen listens on the canvas and on the live layer, and one event can reach both @type {Event|null} */
      let lastDown = null;
      context.listen('pointerdown', (event) => {
        if (!(event instanceof win.PointerEvent) || event === lastDown) return;
        lastDown = event;
        const e = /** @type {PointerEvent} */ (event);
        const p = local(e.clientX, e.clientY);
        if (!p) return;
        takeOver();
        pressing = true;
        const t = e.timeStamp || performance.now();
        last = { x: p.x, y: p.y, t };
        // a press on a control of the page is the page's gesture: no drop falls on the field being focused, and a drag from it (a
        // slider, a selection in a field) stirs as a hovering pointer does, without pigment
        own = onControl(event);
        if (own) return;
        // the drop spreads where it lands; a pointer that was moving also throws it the way it was heading
        const moving = t - headT <= 250;
        drop(p.x, p.y, moving ? headX * DROP_PUSH : 0, moving ? headY * DROP_PUSH : 0, reducedMotion);
      }, passive);
      context.listen('pointermove', (event) => {
        if (!(event instanceof win.PointerEvent)) return;
        const e = /** @type {PointerEvent} */ (event);
        // a finger whose touch events arrive is followed by them (they go on while the page scrolls; pointer events stop there)
        if (e.pointerType === 'touch' && fingers.size) return;
        const p = local(e.clientX, e.clientY);
        if (!p) { last = null; return; }
        const t = e.timeStamp || performance.now();
        const prev = last;
        last = { x: p.x, y: p.y, t };
        if (e.buttons === 0) pressing = false;
        if (prev) move(prev, p, t - prev.t, (e.buttons !== 0 || e.pointerType === 'touch') && !own, t);
      }, passive);
      const end = () => { last = null; pressing = false; };
      context.listen('pointerleave', end, passive);
      context.listen('pointercancel', end, passive);
      context.listen('pointerup', () => { pressing = false; }, passive);
      // A pressed pointer that moves over the page stirs it; the browser would also select the text it crosses, and the selection would
      // be drawn into the ink. While a press lasts, a selection that starts outside a text field does not start (option selectText).
      context.listen('selectstart', (event) => {
        if (pressing && !own && !selectText && !reducedMotion && intensity > 0 && !onControl(event)) event.preventDefault();
      });
      // touch events: passive (never preventDefault), and they keep arriving while the finger scrolls the page
      /** @type {Map<number, {x: number, y: number, t: number}>} */ const fingers = new Map();
      const touches = (/** @type {Event} */ e) => /** @type {any} */ (e).changedTouches ?? [];
      context.listen('touchstart', (event) => {
        for (const touch of touches(event)) {
          const p = local(touch.clientX, touch.clientY);
          if (p) fingers.set(touch.identifier, { x: p.x, y: p.y, t: event.timeStamp || performance.now() });
        }
      }, passive);
      context.listen('touchmove', (event) => {
        const t = event.timeStamp || performance.now();
        for (const touch of touches(event)) {
          const prev = fingers.get(touch.identifier);
          const p = local(touch.clientX, touch.clientY);
          if (!p) { fingers.delete(touch.identifier); continue; }
          fingers.set(touch.identifier, { x: p.x, y: p.y, t });
          // the path over the canvas: a finger that scrolls the page stays over the same spot of it and stirs nothing
          if (prev) move(prev, p, t - prev.t, !own, t);
        }
      }, passive);
      const lift = (/** @type {Event} */ event) => { for (const touch of touches(event)) fingers.delete(touch.identifier); };
      context.listen('touchend', lift, passive);
      context.listen('touchcancel', lift, passive);
    }

    /** The strokes of the plugin itself, up to the simulation clock: each draws the piece of its path of this step. */
    function runScripts() {
      for (let i = 0; i < scripts.length; i += 1) {
        const s = scripts[i];
        const k = Math.min(1, (simClock - s.t0) / s.ms);
        if (k < 0) continue;
        s.at(k, point);
        if (s.has) stroke(s.x, s.y, point.x, point.y, STEP_MS, true, true, false);
        else { hue += HUE_STEP; s.has = true; }
        s.x = point.x; s.y = point.y;
        if (k >= 1) { scripts.splice(i, 1); i -= 1; }
      }
    }

    /**
     * One step of the pigment on the GPU, as pass `index` of this frame: the segments due, the ageing, and (when the water moves) the
     * transport by the field of layer `index`; true when it reads that layer. @param {Fluid} f @param {any} encoder @param {number} index @param {boolean} still
     */
    function stepPigment(f, encoder, index, still) {
      const count = Math.min(SEGMENTS_PER_STEP, segmentCount);
      if (!count && !inkLive) return false;
      if (count) { inkLive = true; inkUntil = simClock + INK_LIFE * 1000 + INK_SLACK_MS; }
      const moving = f.traced && !still;
      // the pigment cannot leave this rectangle: it moves no faster than the water (and the filter spreads it by a fraction of a texel)
      if (inkBox[0] <= inkBox[2] && moving) {
        const grow = f.maxSpeed * DT + 0.25;
        inkBox[0] -= grow; inkBox[1] -= grow; inkBox[2] += grow; inkBox[3] += grow;
      }
      stepData[S.SIZE] = pigSize.w; stepData[S.SIZE + 1] = pigSize.h; stepData[S.CSS] = f.cssWidth; stepData[S.CSS + 1] = f.cssHeight;
      stepData[S.GRID] = f.gw; stepData[S.GRID + 1] = f.gh; stepData[S.INV_CELL] = 1 / f.cellX; stepData[S.INV_CELL + 1] = 1 / f.cellY;
      stepData[S.DT] = DT; stepData[S.LIFE] = INK_LIFE; stepData[S.CAP] = INK_CAP; stepData[S.LAYER] = index;
      stepData[S.COUNT] = count; stepData[S.FLOWING] = moving ? 1 : 0;
      stepData.set(f.spread, S.BLOOM);
      for (let i = 0; i < count; i += 1) {
        const o = segmentHead * 10, radius = segments[o + 4], density = segments[o + 5], reach = REACH * radius;
        stepData.set(segments.subarray(o, o + 4), S.SEG + 4 * i);
        stepData[S.SHAPE + 4 * i] = radius; stepData[S.SHAPE + 4 * i + 1] = density; stepData[S.SHAPE + 4 * i + 2] = segments[o + 9];
        stepData.set(segments.subarray(o + 6, o + 9), S.INK + 4 * i);
        const x0 = Math.min(segments[o], segments[o + 2]) - reach - 2, y0 = Math.min(segments[o + 1], segments[o + 3]) - reach - 2;
        const x1 = Math.max(segments[o], segments[o + 2]) + reach + 2, y1 = Math.max(segments[o + 1], segments[o + 3]) + reach + 2;
        if (inkBox[0] > inkBox[2]) { inkBox[0] = x0; inkBox[1] = y0; inkBox[2] = x1; inkBox[3] = y1; } else {
          inkBox[0] = Math.min(inkBox[0], x0); inkBox[1] = Math.min(inkBox[1], y0); inkBox[2] = Math.max(inkBox[2], x1); inkBox[3] = Math.max(inkBox[3], y1);
        }
        segmentHead = (segmentHead + 1) % SEGMENT_QUEUE; segmentCount -= 1;
      }
      inkBox[0] = Math.max(0, inkBox[0]); inkBox[1] = Math.max(0, inkBox[1]); inkBox[2] = Math.min(f.cssWidth, inkBox[2]); inkBox[3] = Math.min(f.cssHeight, inkBox[3]);
      device.queue.writeBuffer(stepBuffer, stepOffsets[index], stepData);
      // the texels that may hold pigment after this step, and those of the target that held some two steps ago (they are written too: zero)
      const sx = pigSize.w / f.cssWidth, sy = pigSize.h / f.cssHeight;
      const x0 = Math.max(0, Math.floor(inkBox[0] * sx) - 2), y0 = Math.max(0, Math.floor(inkBox[1] * sy) - 2);
      const x1 = Math.min(pigSize.w, Math.ceil(inkBox[2] * sx) + 2), y1 = Math.min(pigSize.h, Math.ceil(inkBox[3] * sy) + 2);
      const to = 1 - cur, old = dirty[to];
      const rx0 = Math.min(x0, old[0]), ry0 = Math.min(y0, old[1]), rx1 = Math.max(x1, old[2]), ry1 = Math.max(y1, old[3]);
      old[0] = x0; old[1] = y0; old[2] = x1; old[3] = y1;
      if (rx1 > rx0 && ry1 > ry0) {
        pigAttachment.view = pigViews[to]; pigAttachment.loadOp = 'load';
        const pass = encoder.beginRenderPass(pigPass);
        pass.setPipeline(advectPipeline);
        pass.setBindGroup(0, advectGroups[cur], stepOffsets, index, 1);
        pass.setScissorRect(rx0, ry0, rx1 - rx0, ry1 - ry0);
        pass.draw(3);
        pass.end();
        pigAttachment.view = null;
      }
      cur = to;
      // the last pigment has outlived its life: the textures are emptied, and nothing is read from them until the next release
      if (simClock >= inkUntil) { inkLive = false; inkBox.set([1, 1, 0, 0]); wipe = true; }
      return moving;
    }

    /** Both pigment textures emptied (the pigment has outlived its life, or was wiped). @param {any} encoder */
    function wipePigment(encoder) {
      wipe = false;
      for (let i = 0; i < 2; i += 1) {
        if (!pigViews[i] || dirty[i][2] <= dirty[i][0]) continue;
        pigAttachment.view = pigViews[i]; pigAttachment.loadOp = 'clear';
        encoder.beginRenderPass(pigPass).end();
        dirty[i].set([pigSize.w, pigSize.h, 0, 0]);
      }
      pigAttachment.view = null;
    }

    /** Upload the field as layer `index`. @param {Fluid} f @param {number} index */
    function upload(f, index) {
      pack(f, packed, 0);
      device.queue.writeTexture({ texture: fieldTexture, origin: { x: 0, y: 0, z: index } }, packed, { bytesPerRow: f.pw * CHANNELS * 4, rowsPerImage: f.ph }, { width: f.pw, height: f.ph, depthOrArrayLayers: 1 });
      layer = index;
    }

    /** Advance the simulation to `now` (ms): the plugin's own strokes, fixed steps of the fluid and of the pigment. @param {Fluid} f @param {any} frame */
    function advance(f, frame) {
      const now = frame.now;
      if (clockFromEvent) {
        // The first frame after a wake moves the clock (and what is due on it) by less than a step, from the event's phase to half a
        // step away from the frame times: the frame shows the time since the event (at least one step), and a step boundary never sits
        // on the frame times (a display at the step rate would otherwise alternate between no step and two).
        clockFromEvent = false;
        const shift = now - (Math.max(1, Math.floor((now - simClock) / STEP_MS)) + 0.5) * STEP_MS - simClock;
        simClock += shift;
        for (const s of scripts) s.t0 += shift;
      }
      let n = Math.floor((now - simClock) / STEP_MS);
      // a long gap (off-screen, a low frame cap) is skipped, not caught up: the plugin's own strokes skip it too (their clock is the simulation's)
      if (n > MAX_STEPS_PER_FRAME) {
        const skipped = (n - MAX_STEPS_PER_FRAME) * STEP_MS;
        simClock += skipped; n = MAX_STEPS_PER_FRAME; inkUntil += skipped;
        for (const s of scripts) s.t0 += skipped;
      }
      const still = reducedMotion;
      /** the texture holds the field of the last step, in `layer` */
      let fresh = true;
      for (let i = 0; i < n && awake; i += 1) {
        if (scripts.length) runScripts();
        if (!still) step(f, params);
        // pigment that faded out a moment ago leaves the textures before new pigment enters them
        if (wipe && segmentCount) wipePigment(frame.encoder);
        // the pigment's transport reads the field of this very step, as layer i
        fresh = stepPigment(f, frame.encoder, i, still);
        if (fresh) upload(f, i); else layer = i;
        simClock += STEP_MS;
        if (quiet(f) && !inkLive && !segmentCount && !scripts.length) awake = false;
      }
      // the picture reads the field of the last step
      if (!fresh && f.moved) upload(f, layer);
    }

    function syncUi() { for (const sync of uiSyncs) sync(); }

    return {
      spatial: true,
      /** true while the water moves, the page is displaced or pigment is left: the host renders every capped frame then, and none at rest */
      get continuous() { return awake; },
      setOptions(next) {
        // an option change during the demo is the user's: it takes over (the stroke stops, the demo resolves null)
        takeOver();
        intensity = clampNum(next?.intensity, 0, 1, intensity);
        flow = clampNum(next?.flow, 0, 1, flow);
        heal = clampNum(next?.heal, 0, 1, heal);
        pigment = clampNum(next?.pigment, 0, 1, pigment);
        if (next && 'palette' in next && next.palette !== palette) { palette = next.palette; globals.set(inkOptics(palette), G.ABSORB); }
        if (next?.selectText !== undefined) selectText = next.selectText === true;
        tune();
        syncUi();
        context.requestRender();
      },
      runAction(action, options, info) {
        const still = reducedMotion || info.reducedMotion;
        if (action === 'clear') {
          takeOver();
          scripts = []; segmentCount = 0; wetDiscs.fill(0);
          if (fluid) { clear(fluid); wipe = true; inkLive = false; inkBox.set([1, 1, 0, 0]); }
          awake = false;
          // the frame that shows the clean page resolves it
          context.requestRender();
          return new Promise((resolve) => { waiters.push(resolve); });
        }
        if (action === 'demo') {
          takeOver();
          if (still || intensity <= 0) return wait();
          const f = currentFluid();
          wake();
          scripts.push({ t0: simClock, ms: DEMO_MS, at: (s, out) => demoPath(s, f.cssWidth, f.cssHeight, out), has: false, x: 0, y: 0 });
          return new Promise((resolve) => {
            demoTakeover = resolve;
            waiters.push((state) => { if (demoTakeover === resolve) { demoTakeover = null; resolve(state); } });
          });
        }
        // 'stir'
        const at = actionPoint(options.point, 'ink');
        const strength = options.strength === undefined ? 1 : Number(options.strength);
        if (!Number.isFinite(strength)) throw new TypeError('ink: `strength` must be a finite number (0.1 to 2)');
        const degrees = options.angle === undefined ? NaN : Number(options.angle);
        if (options.angle !== undefined && !Number.isFinite(degrees)) throw new TypeError('ink: `angle` must be a finite number of degrees (0: to the right, 90: down)');
        takeOver();
        if (intensity <= 0) return wait();
        const f = currentFluid();
        const p = at ? toFluid(at.x, at.y) : { x: f.cssWidth / 2, y: f.cssHeight / 2 };
        if (still) { drop(p.x, p.y, 0, 0, true); return wait(); }
        if (Number.isNaN(degrees)) dropAngle += GOLDEN_ANGLE;
        const angle = Number.isNaN(degrees) ? dropAngle : (degrees * Math.PI) / 180;
        const k = Math.min(2, Math.max(0.1, strength));
        const hx = 0.5 * STIR_PX * k * Math.cos(angle), hy = 0.5 * STIR_PX * k * Math.sin(angle);
        const fit = (/** @type {number} */ v, /** @type {number} */ max) => Math.min(max - 1, Math.max(1, v));
        wake();
        scripts.push({
          t0: simClock, ms: STIR_MS * Math.sqrt(k), has: false, x: 0, y: 0,
          at: (s, out) => { const e = s * s * (3 - 2 * s) - 0.5; out.x = fit(p.x + 2 * hx * e, f.cssWidth); out.y = fit(p.y + 2 * hy * e, f.cssHeight); },
        });
        return wait();
      },
      settled: wait,
      render(frame) {
        const f = ensureFluid(frame.cssWidth || canvas.clientWidth || frame.width, frame.cssHeight || canvas.clientHeight || frame.height, frame.dpr || 1);
        if (awake) advance(f, frame);
        if (wipe) wipePigment(frame.encoder);
        const inked = inkLive && inkBox[0] <= inkBox[2];
        globals[G.RES] = frame.width; globals[G.RES + 1] = frame.height;
        globals[G.CSS] = f.cssWidth; globals[G.CSS + 1] = f.cssHeight;
        globals[G.GRID] = f.gw; globals[G.GRID + 1] = f.gh;
        globals[G.INV_CELL] = 1 / f.cellX; globals[G.INV_CELL + 1] = 1 / f.cellY;
        globals[G.BOX] = f.box[0]; globals[G.BOX + 1] = f.box[1]; globals[G.BOX + 2] = f.box[2]; globals[G.BOX + 3] = f.box[3];
        globals[G.INK_BOX] = inkBox[0]; globals[G.INK_BOX + 1] = inkBox[1]; globals[G.INK_BOX + 2] = inkBox[2]; globals[G.INK_BOX + 3] = inkBox[3];
        globals[G.LAYER] = layer;
        globals[G.MOVED] = f.moved ? 1 : 0;
        globals[G.READY] = frame.sourceReady ? 1 : 0;
        globals[G.INKED] = inked ? 1 : 0;
        globals[G.LOOK + 2] = 0;
        for (let k = 0; k < 4; k += 1) {
          const live = inked && simClock < wetDiscs[3 * k + 2];
          if (live) globals[G.LOOK + 2] = 1;
          globals[G.DROPS + 4 * k] = wetDiscs[3 * k]; globals[G.DROPS + 4 * k + 1] = wetDiscs[3 * k + 1]; globals[G.DROPS + 4 * k + 2] = live ? WET_REACH * BLOOM_REACH : 0;
        }
        device.queue.writeBuffer(uniformBuffer, 0, globals);
        let groups = bindGroups.get(frame.sourceView);
        if (!groups) { groups = [null, null]; bindGroups.set(frame.sourceView, groups); }
        if (!groups[cur]) {
          groups[cur] = device.createBindGroup({
            label: 'hic-ink-bind-group', layout,
            entries: [
              { binding: 0, resource: { buffer: uniformBuffer } },
              { binding: 1, resource: sampler },
              { binding: 2, resource: frame.sourceView },
              { binding: 3, resource: fieldView },
              { binding: 4, resource: pigViews[cur] },
            ],
          });
        }
        attachment.view = frame.destinationView;
        passDescriptor.timestampWrites = frame.profiling?.timestampWrites?.('ink');
        const pass = frame.encoder.beginRenderPass(passDescriptor);
        pass.setPipeline(pipeline); pass.setBindGroup(0, groups[cur]); pass.draw(3); pass.end();
        attachment.view = null;
        if (waiters.length && calm()) for (const resolve of waiters.splice(0)) resolve('still');
      },
      captureInputMapper() {
        mapperSlot = (mapperSlot + 1) % MAPPER_SLOTS;
        const s = mapperStates[mapperSlot];
        s.set(globals);
        if (globals[G.MOVED] > 0.5) s.set(packed, GLOBALS_LENGTH);
        return mappers[mapperSlot];
      },
      mountUI(root, ui) {
        const doc = root.ownerDocument;
        injectStyle(doc, 'ink', UI_CSS);
        const box = doc.createElement('div');
        box.className = 'hic-ink-ui';
        const id = `hic-ink-${++uiSerial}`;
        /** @type {Array<() => void>} */ const offs = [];
        /** @type {Array<() => void>} */ const mine = [];
        const values = () => ({ intensity, flow, pigment });
        for (const [key, text] of SLIDERS) {
          const label = doc.createElement('label');
          label.innerHTML = `<span>${text}</span><output></output><input type="range" id="${id}-${key}" min="0" max="100" step="1">`;
          const range = /** @type {HTMLInputElement} */ (label.querySelector('input'));
          const out = /** @type {HTMLOutputElement} */ (label.querySelector('output'));
          const sync = () => {
            const value = String(Math.round(values()[key] * 100));
            if (range.value !== value) range.value = value;
            if (out.textContent !== `${value}%`) out.textContent = `${value}%`;
          };
          const onInput = () => ui.setOptions({ [key]: (Number(range.value) || 0) / 100 });
          range.addEventListener('input', onInput);
          offs.push(() => range.removeEventListener('input', onInput));
          mine.push(sync);
          sync();
          box.append(label);
        }
        uiSyncs.push(...mine);
        root.append(box);
        return () => {
          for (const off of offs) off();
          for (const sync of mine) { const i = uiSyncs.indexOf(sync); if (i >= 0) uiSyncs.splice(i, 1); }
          box.remove();
        };
      },
      destroy() {
        scripts = []; segmentCount = 0; awake = false; rehearsing = 0;
        const demo = demoTakeover;
        demoTakeover = null;
        demo?.(null);
        for (const resolve of waiters.splice(0)) resolve(null);
        uniformBuffer.destroy?.(); stepBuffer.destroy?.();
        fieldTexture?.destroy?.();
        releasePigment();
      },
    };
  },
});
