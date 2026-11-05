/**
 * Water effect plugin (effect plugin ABI v2): an EXAMPLE of the effects extension of html-in-canvas-polyfill, not part of the polyfill.
 *
 * A water surface over the HTML drawn in the canvas, made of two linear parts that add up:
 *   - the wakes: sim.js advances the wave equation on the CPU (a grid of cells of about 3 CSS px, 120 steps per second, reflecting walls,
 *     damping and viscosity that bring it back to a flat surface); the field is uploaded as an r32float texture, and water.wgsl
 *     evaluates it per device pixel as a cubic B-spline;
 *   - the drops: drops.js tabulates the exact response of capillary-gravity water to a drop (the Cauchy-Poisson integral: a train of
 *     rings whose short ripples run ahead), and water.wgsl sums the drops and their mirror images in the walls once per CSS pixel;
 * then refraction of the page from the surface normals, caustics, Fresnel reflection of a sky, a window light and a sun, absorption.
 *
 * Input: the pointer and taps make drops, a moving pointer a wake. The listeners are passive: a finger keeps scrolling the page. The input
 * mapper (`mapWaterPoint`) evaluates the very uniform block (with the drop sources) and height field that were submitted for the
 * presented frame (copied into one of four slots), with the same B-spline, the same drop texels and the same interpolation as the shader,
 * so clicks and typing reach the field the user sees.
 *
 * Zero work at rest: the instance is `continuous` only while the surface moves; once it is flat (below what a pixel shows) the field is
 * cleared and the host stops rendering. The option `ambient` (a gentle swell) makes it continuous on purpose.
 *
 * Actions: 'drop' (a drop at `point`) and 'demo' (a short rain, then calm) resolve 'calm' once the surface is still. User input during the
 * demo (the pointer, setOptions) stops the rain at once and resolves the demo with null. With reduced motion both resolve 'calm' at once and nothing moves.
 *
 * `plugin` is a plain, frozen definition that `host.addPlugin` validates (docs/guides/EFFECTS-PLUGINS.md).
 */

import { wgsl } from './wgsl.js';
import { stateMapper } from '../_lib/mapper.js';
import { injectStyle } from '../_lib/ui.js';
import { actionPoint } from '../_lib/action.js';
import { CAUSTIC_DEPTH_PX, CAUSTIC_PX, MAX_STEPS_PER_FRAME, PAD, QUIET_FOCUS, QUIET_SHIFT_PX, REFRACT_PX, STEP_MS, ambientSlope, clear, createField, gridOf, mirror, quiet, setSize, stamp, step, surfaceAt, swell } from './sim.js';
import { DROP_FADE_MS, MAX_DROPS, MAX_SOURCES, ROWS_PER_S, SOURCE_FLOATS, TABLE_ROWS, TABLE_W, computeRow, createDropTable, dropGrid, dropsSlope, prepareTable } from './drops.js';

/** @typedef {import('../../src/contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../../src/contracts/types.js').InputPoint} InputPoint */
/** @typedef {import('./sim.js').Field} Field */
/** @typedef {{t: number, x: number, y: number, depth: number}} RainDrop  t: ms; x, y: 0..1 of the canvas; depth: css px */
/** @typedef {{x: number, y: number, born: number, depth: number, fading?: number}} Drop  css px of the field; born, fading (when it began to fade): ms (performance.now() time base) */

/** What the plugin gallery and the build read (plugins/README.md). */
export const meta = Object.freeze({
  name: 'water',
  title: 'Water',
  description: 'A water surface over the live page: drops, wakes, refraction, caustics and reflections; clicks and typing are remapped through it.',
  defaults: Object.freeze({ intensity: 0.5 }),
  reducedMotion: 'Still water: the surface keeps its reflection and tint; no ripple starts and nothing animates; drop and demo resolve at once.',
  touch: 'Tap the water for a drop; a finger still scrolls the page.',
});

/** The actions of `handle.trigger`: drop lets a drop fall, demo plays a short rain. */
export const ACTIONS = Object.freeze(/** @type {const} */ (['drop', 'demo']));

/** Offsets in the uniform block (water.wgsl Globals), in floats. The mapper state is this block followed by the padded height field. */
export const G = Object.freeze({ RES: 0, CSS: 2, K: 4, INV_CELL: 6, GRID: 8, TIME: 10, INTENSITY: 11, LIGHT: 12, AMBIENT: 13, ACTIVE: 14, READY: 15, REFRACT: 16, CAUSTIC: 17, DROPS: 18, CAUSTICS: 19 });
export const GLOBALS_LENGTH = 20;
/** the uniform block: the globals, then MAX_SOURCES drop sources (drops.js SOURCE_FLOATS each); the mapper state appends the field */
export const SOURCES_OFFSET = GLOBALS_LENGTH;
export const UNIFORM_LENGTH = GLOBALS_LENGTH + MAX_SOURCES * SOURCE_FLOATS;
/** mapper states kept alive: the mapper chain keeps the last 3 presented frames, plus the one being written */
const MAPPER_SLOTS = 4;
const DEFAULT_INTENSITY = 0.5;
/** css px of the ambient swell at `ambient: 1` */
export const AMBIENT_PX = 2.6;
const CLEAR_COLOR = { r: 0.004, g: 0.018, b: 0.034, a: 1 };
/** a tap or a press: a drop whose crater is this deep (css px, drops.js); the action drop scales it by its strength / 1.2 */
export const DROP_DEPTH = 4;
/**
 * The drops of `drops: 'pond'` (the default): a pebble on the wake field, as the wakes are made, so that a tap speaks the wakes'
 * language (their waves, their caustics, their constant cost). A smooth crater of POND_RADIUS css px and POND_DEPTH css px at a tap's
 * strength, then the water that rushes back: a rebound in the middle (the jet of a drop, the 'plop') and a smaller second dip. Each
 * impulse rings out as a ring that the wave equation carries outwards: a few separated rings, about 2.5 s. [ms after the impact,
 * radius (share of POND_RADIUS), height (share of POND_DEPTH; negative: a dip)]
 */
export const POND_RADIUS = 22;
export const POND_DEPTH = 12;
export const POND_IMPULSES = Object.freeze(Array.from({ length: 4 }, (_, k) => Object.freeze([k * 90, Math.max(0.45, 1 - 0.18 * k), (k % 2 ? 1 : -1) * 0.65 ** k])));
/** the rain of the demo on the pond: raindrops of this share of a tap's pebble in size, and in depth */
export const POND_RAIN = Object.freeze([0.65, 0.6]);
/** the kinds of drop (option `drops`) */
export const DROP_KINDS = Object.freeze(['pond', 'exact']);
/** The depth of the drop of the action at `strength` (0.08 to 2), in proportion: a tap's drop at the default 1.2. @param {number} strength */
export const dropDepth = (strength) => (DROP_DEPTH * Math.min(2, Math.max(0.08, strength))) / 1.2;
/** the swell of the action drop with `swell: true`: a crater with a crown this wide and deep (css px) on the wake field */
export const SWELL_RADIUS = 24;
export const SWELL_DEPTH = 10;
/** the wake of a moving pointer: dents along its path, deeper when it moves faster (WAKE_DEPTH at WAKE_FAST css px per ms, at most twice that for a flick) */
const WAKE_RADIUS = 28;
const WAKE_DEPTH = 3;
const WAKE_FAST = 0.8;
/** a finger that scrolls the page stirs one spot: each touch move adds at most this share of a wake dent there */
const SCROLL_STIR = 0.22;
const DEMO_SEED = 0x5eed;

let uiSerial = 0;

/** @param {unknown} v @param {number} fallback */
function clamp01(v, fallback) {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/**
 * Source point shown at the presented point `point`, for the mapper state `state` (the uniform block, then the height field): the same
 * math as fs() in water.wgsl (the B-spline gradient times the refraction, the drops, the ambient swell, the clamp). PURE.
 * @param {Float32Array} state
 * @param {InputPoint} point  presented point, canvas css px, plus the presented size
 * @param {Float32Array|null} [table]  the drop table (drops.js; its rows never change once computed); none: no drop is evaluated
 * @param {Map<number, number[]>} [cache]  the drop texels already evaluated for this very state
 * @returns {{x: number, y: number}}
 */
export function mapWaterPoint(state, point, table = null, cache = undefined) {
  const width = Math.max(1, point.width);
  const height = Math.max(1, point.height);
  const u = point.x / width;
  const v = point.y / height;
  const cssW = Math.max(1, state[G.CSS]), cssH = Math.max(1, state[G.CSS + 1]);
  let dx = 0, dy = 0;
  if (state[G.ACTIVE] > 0.5) {
    const gw = state[G.GRID], gh = state[G.GRID + 1];
    const s = surfaceAt(state, UNIFORM_LENGTH, gw + 2 * PAD, gh + 2 * PAD, u * gw - 0.5 + PAD, v * gh - 0.5 + PAD);
    dx = state[G.K] * s.hx;
    dy = state[G.K + 1] * s.hy;
  }
  if (state[G.DROPS] > 0.5 && table) {
    const d = dropsSlope(table, state, SOURCES_OFFSET, state[G.DROPS], u * cssW, v * cssH, cssW, cssH, cache);
    dx += state[G.REFRACT] * d.sx;
    dy += state[G.REFRACT] * d.sy;
  }
  if (state[G.AMBIENT] > 0) {
    const a = ambientSlope(u * cssW, v * cssH, state[G.TIME], state[G.AMBIENT]);
    dx += state[G.REFRACT] * a.x;
    dy += state[G.REFRACT] * a.y;
  }
  return { x: Math.min(0.999, Math.max(0.001, u + dx / cssW)) * width, y: Math.min(0.999, Math.max(0.001, v + dy / cssH)) * height };
}

/** A small deterministic PRNG (mulberry32). @param {number} seed */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The rain of the action demo: a first large drop, then a shower that thins out; the last drop falls at 1.4 s. Deterministic. PURE.
 * @returns {RainDrop[]}
 */
export function demoRain() {
  const rnd = random(DEMO_SEED);
  /** @type {RainDrop[]} */ const rain = [{ t: 0, x: 0.5, y: 0.44, depth: DROP_DEPTH }];
  const n = 30;
  for (let i = 1; i <= n; i += 1) {
    const k = i / n;
    rain.push({ t: 100 + 1300 * k ** 1.3, x: 0.06 + 0.88 * rnd(), y: 0.08 + 0.84 * rnd(), depth: DROP_DEPTH * (0.45 + 0.5 * rnd()) * (1 - 0.5 * k) });
  }
  return rain;
}

/** CSS of the plugin UI (mountUI) */
const UI_CSS = `
    .hic-water-control { display:grid; grid-template-columns:1fr auto; gap:6px 10px; align-items:center; padding-top:2px; color:rgba(224,247,255,.62); font-size:9px; font-weight:700; }
    .hic-water-control > span { grid-column:1; }
    .hic-water-control output { grid-column:2; color:#9cf5ff; text-align:right; font-variant-numeric:tabular-nums; }
    .hic-water-control input[type=range] { grid-column:1 / -1; width:100%; height:28px; margin:0; padding:3px 0; border:0; border-radius:0; background:transparent; box-shadow:none; accent-color:#79efff; cursor:ew-resize; }
  `;

/**
 * The plugin-owned intensity slider.
 * @param {Element} root
 * @param {{ getOptions: () => Readonly<Record<string, unknown>>, setOptions: (patch: Record<string, unknown>) => void }} ui
 * @param {(range: HTMLInputElement|null, output: HTMLOutputElement|null) => void} bind  hands the live controls to the plugin (null on dispose)
 */
function mountIntensityUi(root, ui, bind) {
  const doc = root.ownerDocument;
  injectStyle(doc, 'water', UI_CSS);
  const id = `hic-water-intensity-${++uiSerial}`;
  const label = doc.createElement('label');
  label.className = 'hic-water-control';
  label.htmlFor = id;
  label.innerHTML = `<span>Water plugin · intensity</span><input id="${id}" type="range" min="0" max="100" step="1"><output for="${id}"></output>`;
  const range = /** @type {HTMLInputElement} */ (label.querySelector('input'));
  const output = /** @type {HTMLOutputElement} */ (label.querySelector('output'));
  const percent = Math.round(clamp01(ui.getOptions().intensity, DEFAULT_INTENSITY) * 100);
  range.value = String(percent);
  output.textContent = `${percent}%`;
  root.append(label);
  bind(range, output);
  const onInput = () => ui.setOptions({ intensity: (Number(range.value) || 0) / 100 });
  range.addEventListener('input', onInput);
  return () => {
    range.removeEventListener('input', onInput);
    label.remove();
    bind(null, null);
  };
}

/** The caustic mesh (water.wgsl vs_caustics): a vertex every MESH_PX css px over the canvas and a margin, one strip per row.
 * @param {number} cssW @param {number} cssH @param {number} depth  CAUSTIC_DEPTH_PX */
export function causticMesh(cssW, cssH, depth) {
  const margin = Math.ceil(0.1 * depth + 16);
  return { margin, columns: Math.ceil((Math.fround(cssW) + 2 * margin) / MESH_PX), rows: Math.ceil((Math.fround(cssH) + 2 * margin) / MESH_PX) };
}
/** css px between the vertices of the caustic mesh (water.wgsl MESH_PX) */
export const MESH_PX = 2;

/**
 * The pipelines, compiled asynchronously where the device can (createRenderPipelineAsync: WebKit compiled the caustic pipeline at its
 * first draw otherwise, a 70 ms stall at the first tap on the iPad).
 * @param {any} device @param {string} code @param {string} format
 */
async function createPipeline(device, code, format) {
  const make = (/** @type {any} */ d) => (device.createRenderPipelineAsync ? device.createRenderPipelineAsync(d) : device.createRenderPipeline(d));
  const module = device.createShaderModule({ code, label: 'hic-water-effect-shader' });
  const stage = /** @type {any} */ (globalThis).GPUShaderStage?.FRAGMENT ?? 2;
  const layout = device.createBindGroupLayout({
    label: 'hic-water-effect-layout',
    entries: [
      { binding: 0, visibility: stage, buffer: { type: 'uniform' } },
      { binding: 1, visibility: stage, sampler: { type: 'filtering' } },
      { binding: 2, visibility: stage, texture: { sampleType: 'float' } },
      // the height field is read with textureLoad only: r32float needs no filtering (it is not filterable without an optional feature)
      { binding: 3, visibility: stage, texture: { sampleType: 'unfilterable-float' } },
      // the drops of this frame and the sunlight on the page, one texel per css px (rgba16float, r16float, filtered)
      { binding: 5, visibility: stage, texture: { sampleType: 'float' } },
      { binding: 6, visibility: stage, texture: { sampleType: 'float' } },
    ],
  });
  const pipeline = make({
    label: 'hic-water-effect-pipeline',
    layout: device.createPipelineLayout({ label: 'hic-water-effect-pipeline-layout', bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  // the drops pass: the globals (sources), the sampler and the drop table (rgba16float, filtered bilinearly in r and t)
  const dropsLayout = device.createBindGroupLayout({
    label: 'hic-water-effect-drops-layout',
    entries: [
      { binding: 0, visibility: stage, buffer: { type: 'uniform' } },
      { binding: 1, visibility: stage, sampler: { type: 'filtering' } },
      { binding: 4, visibility: stage, texture: { sampleType: 'float' } },
    ],
  });
  const dropsPipeline = make({
    label: 'hic-water-effect-drops-pipeline',
    layout: device.createPipelineLayout({ label: 'hic-water-effect-drops-pipeline-layout', bindGroupLayouts: [dropsLayout] }),
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs_drops', targets: [{ format: 'rgba16float' }] },
    primitive: { topology: 'triangle-list' },
  });
  // the caustics pass: the surface (the field, the drops) in the vertex stage, the light added up per texel of the page
  const both = stage | (/** @type {any} */ (globalThis).GPUShaderStage?.VERTEX ?? 1);
  const causticLayout = device.createBindGroupLayout({
    label: 'hic-water-effect-caustic-layout',
    entries: [
      { binding: 0, visibility: both, buffer: { type: 'uniform' } },
      { binding: 1, visibility: both, sampler: { type: 'filtering' } },
      { binding: 3, visibility: both, texture: { sampleType: 'unfilterable-float' } },
      { binding: 5, visibility: both, texture: { sampleType: 'float' } },
    ],
  });
  const add = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };
  const causticPipeline = make({
    label: 'hic-water-effect-caustic-pipeline',
    layout: device.createPipelineLayout({ label: 'hic-water-effect-caustic-pipeline-layout', bindGroupLayouts: [causticLayout] }),
    vertex: { module, entryPoint: 'vs_caustics' },
    fragment: { module, entryPoint: 'fs_caustics', targets: [{ format: 'r16float', blend: { color: add, alpha: add } }] },
    primitive: { topology: 'triangle-strip' },
    // 4 samples a texel: a focused triangle thinner than a texel still lands its light (a single sample would draw the lines dotted)
    multisample: { count: 4 },
  });
  const [p0, p1, p2] = await Promise.all([pipeline, dropsPipeline, causticPipeline]);
  return { pipeline: p0, layout, dropsPipeline: p1, dropsLayout, causticPipeline: p2, causticLayout };
}

/** @type {EffectPluginDefinition} */
export const plugin = Object.freeze({
  type: 'water',
  apiVersion: 2,
  version: 4,
  actions: ACTIONS,
  // The pass only writes its destination as a same-format colour attachment; it never samples or reads it back.
  outputCapabilities: Object.freeze({ directCanvasRenderAttachment: /** @type {const} */ (true) }),
  async create(context, initialOptions) {
    const shader = initialOptions?.shader;
    const code = typeof shader === 'string' && shader !== '' ? shader : await wgsl('water.wgsl');
    const { device, format } = context;
    const { pipeline, layout, dropsPipeline, dropsLayout, causticPipeline, causticLayout } = await createPipeline(device, code, format);
    const gpu = /** @type {any} */ (globalThis);
    const bufferUsage = gpu.GPUBufferUsage;
    const textureUsage = gpu.GPUTextureUsage ?? { COPY_DST: 2, TEXTURE_BINDING: 4 };
    const uniformBuffer = device.createBuffer({ label: 'hic-water-effect-globals', size: UNIFORM_LENGTH * 4, usage: bufferUsage.UNIFORM | bufferUsage.COPY_DST });
    // the profile of a drop (drops.js): rows are computed as drops age and uploaded once each; they never change afterwards
    const table = createDropTable();
    let uploadedRows = 0;
    const tableTexture = device.createTexture({ label: 'hic-water-effect-drop-table', size: { width: TABLE_W, height: TABLE_ROWS }, format: 'rgba16float', usage: textureUsage.TEXTURE_BINDING | textureUsage.COPY_DST });
    const tableView = tableTexture.createView();
    /** the drop texture and the caustic texture (drops.js dropGrid of the field's css size: one texel per css px); 1 x 1 until the water moves */
    let dropTargets = { w: 0, h: 0, a: /** @type {any} */ (null), b: /** @type {any} */ (null), ms: /** @type {any} */ (null), viewA: /** @type {any} */ (null), viewB: /** @type {any} */ (null), viewMs: /** @type {any} */ (null) };
    /** @param {number} w @param {number} h */
    const ensureDropTargets = (w, h) => {
      if (dropTargets.w === w && dropTargets.h === h) return;
      dropTargets.a?.destroy?.(); dropTargets.b?.destroy?.();
      const make = (/** @type {string} */ label, /** @type {string} */ fmt) => device.createTexture({ label, size: { width: w, height: h }, format: fmt, usage: textureUsage.TEXTURE_BINDING | textureUsage.RENDER_ATTACHMENT });
      const a = make('hic-water-effect-drops', 'rgba16float'), b = make('hic-water-effect-caustics', 'r16float');
      dropTargets.ms?.destroy?.();
      const ms = device.createTexture({ label: 'hic-water-effect-caustics-ms', size: { width: w, height: h }, format: 'r16float', sampleCount: 4, usage: textureUsage.RENDER_ATTACHMENT });
      dropTargets = { w, h, a, b, ms, viewA: a.createView(), viewB: b.createView(), viewMs: ms.createView() };
      bindGroups = new WeakMap();
      causticBindGroup = null;
    };
    /** @type {any} */ let dropsBindGroup = null;
    /** @type {any} */ let causticBindGroup = null;

    const sampler = device.createSampler({ label: 'hic-water-effect-sampler', magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const globals = new Float32Array(UNIFORM_LENGTH);
    const canvas = context.canvas;
    const win = /** @type {any} */ (canvas.ownerDocument.defaultView);
    // prefers-reduced-motion (read now, and by the host at every trigger): still water. Nothing starts a ripple; the surface keeps its
    // reflection and tint (a static picture, rendered only when the page or an option changes), and the mapper is the identity.
    const reducedMotion = !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const start = performance.now();

    let intensity = clamp01(initialOptions?.intensity, DEFAULT_INTENSITY);
    let light = clamp01(initialOptions?.light, 1);
    let ambient = reducedMotion ? 0 : clamp01(initialOptions?.ambient, 0);
    /** 'pond' (impulses on the wake field) or 'exact' (drops.js: the analytic response of capillary-gravity water) */
    let dropKind = DROP_KINDS.includes(/** @type {any} */ (initialOptions?.drops)) ? /** @type {string} */ (initialOptions?.drops) : 'pond';
    /** impulses of pond drops still to come, on the simulation clock @type {{t: number, x: number, y: number, r: number, a: number}[]} */
    let impulses = [];
    /** the table of the drops is filled in idle time, in slices of a few ms, starting a moment after create (about 90 ms of work in all,
     * once): the first drop then finds it ready. A drop that comes earlier computes the rows it needs at once. */
    /** @type {{idle: boolean, id: number}|null} */ let prefetch = null;
    const idle = (/** @type {() => void} */ fn, /** @type {number} */ delay) => {
      prefetch = win.requestIdleCallback && !delay ? { idle: true, id: win.requestIdleCallback(fn, { timeout: 500 }) } : { idle: false, id: win.setTimeout(fn, delay || 20) };
    };
    const cancelIdle = () => {
      if (prefetch?.idle) win.cancelIdleCallback(prefetch.id); else if (prefetch) win.clearTimeout(prefetch.id);
      prefetch = null;
    };
    const fill = () => { prefetch = null; if (!prepareTable(table, performance.now() + 3)) idle(fill, 0); };
    // the first rows now (a few ms, mostly the first run of the code): a drop right after the plugin is added (the gallery's demo on
    // selection) then finds them, and the rest follows in idle time
    if (!reducedMotion) { for (let i = 0; i < 3; i += 1) computeRow(table); }
    if (!reducedMotion && win.setTimeout) idle(fill, 100);

    /** @type {Field|null} */ let field = null;
    /** @type {any} */ let fieldTexture = null;
    /** @type {any} */ let fieldView = null;
    let bindGroups = new WeakMap();
    /** the surface moves: frames are needed until it is flat again */
    let awake = false;
    /** the field holds a wake (it is not flat): it is stepped, uploaded and read only then */
    let fieldLive = false;
    /** the field changed since its last upload */
    let dirty = false;
    /** the simulation clock, ms on the performance.now() time base: the field has been stepped up to this time */
    let simClock = 0;
    let sinceCheck = 0;
    /** drops of the running demo, on the simulation clock @type {RainDrop[]} */
    let rain = [];
    /** drops that still ring @type {Drop[]} */
    let drops = [];
    /** resolves the running demo with null when the user takes over @type {((state: string|null) => void)|null} */
    let demoTakeover = null;
    /** @type {((state: string|null) => void)[]} */ const waiters = [];
    /** mapper states: the uniform block followed by the field (reallocated with the field) @type {Float32Array[]} */
    let mapperStates = [];
    /** @type {any[]} */ let mappers = [];
    /** the drop texels a mapper has evaluated, per mapper state (a slot's is cleared when the slot is rewritten; a gesture snapshot gets its own) */
    let texelCaches = new WeakMap();
    const texelCache = (/** @type {Float32Array} */ state) => { let c = texelCaches.get(state); if (!c) { c = new Map(); texelCaches.set(state, c); } return c; };
    let mapperSlot = 0;
    /** @type {HTMLInputElement|null} */ let uiRange = null;
    /** @type {HTMLOutputElement|null} */ let uiOutput = null;

    /** The field of a canvas of this css size: the same grid follows a resize of a fraction of a cell; another grid starts flat. @param {number} cssWidth @param {number} cssHeight */
    function ensureField(cssWidth, cssHeight) {
      if (field && Math.abs(field.cssWidth - cssWidth) < 0.01 && Math.abs(field.cssHeight - cssHeight) < 0.01) return field;
      const grid = gridOf(cssWidth, cssHeight);
      if (field && field.gw === grid.gw && field.gh === grid.gh) { setSize(field, cssWidth, cssHeight); return field; }
      const f = createField(cssWidth, cssHeight);
      field = f;
      fieldTexture?.destroy?.();
      fieldTexture = device.createTexture({ label: 'hic-water-effect-height-field', size: { width: f.pw, height: f.ph }, format: 'r32float', usage: textureUsage.TEXTURE_BINDING | textureUsage.COPY_DST });
      fieldView = fieldTexture.createView();
      causticBindGroup = null;
      fieldLive = false;
      bindGroups = new WeakMap();
      mapperStates = Array.from({ length: MAPPER_SLOTS }, () => new Float32Array(UNIFORM_LENGTH + f.pw * f.ph));
      mappers = mapperStates.map((s) => stateMapper(s, (state, point) => mapWaterPoint(state, point, table.data, texelCache(state))));
      dirty = true;
      return f;
    }

    /** the field (before the first frame: one of the canvas's client size) */
    const currentField = () => field ?? ensureField(canvas.clientWidth || 1, canvas.clientHeight || 1);

    /** The surface starts to move (input, an action): the simulation clock starts now. */
    function wake() {
      if (!awake) { awake = true; simClock = performance.now(); sinceCheck = 0; }
      context.requestRender();
    }

    /** A drop at (x, y) css px of the field, born at `born` ms. @param {number} x @param {number} y @param {number} depth @param {number} [born] */
    function addDrop(x, y, depth, born = performance.now(), size = 1) {
      currentField();
      if (dropKind === 'pond') {
        const k = depth / DROP_DEPTH;
        for (const [dt, r, a] of POND_IMPULSES) impulses.push({ t: born + dt * size, x, y, r: r * POND_RADIUS * size, a: a * POND_DEPTH * k });
        impulses.sort((p, q) => p.t - q.t);
      } else drops.push({ x, y, born, depth });
      wake();
    }

    /** User input during the demo: the rain stops at once and the demo resolves null; the input takes over. */
    function takeOver() {
      rain = [];
      const resolve = demoTakeover;
      demoTakeover = null;
      resolve?.(null);
    }

    const calm = () => !awake && !rain.length && !drops.length && !impulses.length;
    /** @returns {'calm'|Promise<string|null>} */
    const wait = () => (calm() ? 'calm' : new Promise((resolve) => { waiters.push(resolve); }));

    /** canvas client px -> css px of the field @param {number} x @param {number} y */
    const toField = (x, y) => {
      const f = currentField();
      return { x: (x * f.cssWidth) / Math.max(1, canvas.clientWidth), y: (y * f.cssHeight) / Math.max(1, canvas.clientHeight) };
    };

    if (!reducedMotion) {
      /** @type {{x: number, y: number, t: number}|null} */ let last = null;
      /** canvas css px of the field, from client px, with the canvas where it is NOW (it moves while the page scrolls) @param {number} cx @param {number} cy */
      const local = (cx, cy) => {
        const r = canvas.getBoundingClientRect();
        return toField(cx - r.left - canvas.clientLeft, cy - r.top - canvas.clientTop);
      };
      /**
       * A wake from (a) to (b), canvas css px of the field; `travel` is how far the pointer or finger moved over the screen (more than a -> b while the page
       * scrolls under a finger: the canvas moves with it), `dt` ms. A path along the canvas leaves dents along it; a finger that scrolls the page stays over
       * nearly the same spot of the canvas and stirs it there, as long as it moves.
       * @param {{x: number, y: number}} a @param {{x: number, y: number}} b @param {number} travel @param {number} dt @param {number} pressed
       */
      const wakeAlong = (a, b, travel, dt, pressed) => {
        const along = Math.hypot(b.x - a.x, b.y - a.y);
        const dist = Math.max(along, travel);
        // a jump (the pointer came back from elsewhere, a long pause) starts a new path
        if (dist < 0.75 || dist > 220 || dt > 150) return;
        const depth = WAKE_DEPTH * pressed * Math.min(2, (dist / Math.max(4, dt) / WAKE_FAST) ** 0.5);
        if (depth < 0.02) return;
        takeOver();
        const spacing = WAKE_RADIUS * 0.5;
        const n = Math.max(1, Math.ceil(along / spacing));
        // on one spot (a finger scrolling the page) a stamp stays shallow: the stirring goes on at every event while the finger moves
        const each = along < spacing ? Math.min((depth * dist) / spacing, depth * SCROLL_STIR) : (depth * dist) / n / spacing;
        const f = currentField();
        for (let i = 1; i <= n; i += 1) {
          const k = i / n;
          stamp(f, a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, WAKE_RADIUS, -each);
        }
        fieldLive = true;
        dirty = true;
        wake();
      };
      // passive: the water never claims a gesture (a finger keeps scrolling the page; the browser then cancels the pointer)
      const passive = { passive: true };
      /** the last pointerdown handled: context.listen listens on the canvas and on the live layer, and where the layer lies inside the
       * canvas (the polyfill) one event reaches both, which made every tap two drops on the same spot @type {Event|null} */
      let lastDown = null;
      context.listen('pointerdown', (event) => {
        if (!(event instanceof win.PointerEvent) || event === lastDown) return;
        lastDown = event;
        const e = /** @type {PointerEvent} */ (event);
        const p = local(e.clientX, e.clientY);
        takeOver();
        addDrop(p.x, p.y, DROP_DEPTH);
        last = { x: p.x, y: p.y, t: e.timeStamp || performance.now() };
      }, passive);
      context.listen('pointermove', (event) => {
        if (!(event instanceof win.PointerEvent)) return;
        const e = /** @type {PointerEvent} */ (event);
        // a finger whose touch events arrive is followed by them (they go on while the page scrolls; pointer events stop there)
        if (e.pointerType === 'touch' && fingers.size) return;
        const p = local(e.clientX, e.clientY);
        const t = e.timeStamp || performance.now();
        const prev = last;
        last = { x: p.x, y: p.y, t };
        if (!prev) return;
        // a drag (a pressed button, a finger) stirs harder than a hovering mouse
        wakeAlong(prev, p, 0, t - prev.t, e.buttons !== 0 || e.pointerType === 'touch' ? 1 : 0.8);
      }, passive);
      const end = () => { last = null; };
      context.listen('pointerleave', end, passive);
      context.listen('pointercancel', end, passive);
      // touch events: passive (never preventDefault), and they keep arriving while the finger scrolls the page
      /** @type {Map<number, {x: number, y: number, cx: number, cy: number, t: number}>} */ const fingers = new Map();
      const touches = (/** @type {Event} */ e) => /** @type {any} */ (e).changedTouches ?? [];
      context.listen('touchstart', (event) => {
        for (const touch of touches(event)) {
          const p = local(touch.clientX, touch.clientY);
          fingers.set(touch.identifier, { x: p.x, y: p.y, cx: touch.clientX, cy: touch.clientY, t: event.timeStamp || performance.now() });
        }
      }, passive);
      context.listen('touchmove', (event) => {
        const t = event.timeStamp || performance.now();
        for (const touch of touches(event)) {
          const prev = fingers.get(touch.identifier);
          const p = local(touch.clientX, touch.clientY);
          fingers.set(touch.identifier, { x: p.x, y: p.y, cx: touch.clientX, cy: touch.clientY, t });
          if (prev) wakeAlong(prev, p, Math.hypot(touch.clientX - prev.cx, touch.clientY - prev.cy), t - prev.t, 1);
        }
      }, passive);
      const lift = (/** @type {Event} */ event) => { for (const touch of touches(event)) fingers.delete(touch.identifier); };
      context.listen('touchend', lift, passive);
      context.listen('touchcancel', lift, passive);
    }

    function syncUi() {
      const percent = Math.round(intensity * 100);
      if (uiRange && uiRange.value !== String(percent)) uiRange.value = String(percent);
      if (uiOutput && uiOutput.textContent !== `${percent}%`) uiOutput.textContent = `${percent}%`;
    }

    /** Advance the simulation to `now` (ms): the due drops of the rain, fixed steps, and the check for a flat surface. @param {Field} f @param {number} now */
    function advance(f, now) {
      let n = Math.floor((now - simClock) / STEP_MS);
      // a long gap (off-screen, a frame cap of 1) is skipped, not caught up: the drops and the rain skip it too (their clock is the simulation's)
      if (n > MAX_STEPS_PER_FRAME) {
        const skipped = now - MAX_STEPS_PER_FRAME * STEP_MS - simClock;
        simClock += skipped; n = MAX_STEPS_PER_FRAME;
        for (const d of drops) d.born += skipped;
        for (const d of rain) d.t += skipped;
        for (const p of impulses) p.t += skipped;
      }
      for (let i = 0; i < n && awake; i += 1) {
        while (rain.length && rain[0].t <= simClock) {
          const d = /** @type {RainDrop} */ (rain.shift());
          // on the pond the rain is raindrops, not pebbles: smaller and lighter (POND_RAIN)
          addDrop(d.x * f.cssWidth, d.y * f.cssHeight, d.depth * (dropKind === 'pond' ? POND_RAIN[1] : 1), d.t, dropKind === 'pond' ? POND_RAIN[0] : 1);
        }
        while (impulses.length && impulses[0].t <= simClock) {
          const p = /** @type {{t: number, x: number, y: number, r: number, a: number}} */ (impulses.shift());
          stamp(f, p.x, p.y, p.r, p.a);
          fieldLive = true;
        }
        if (fieldLive) { step(f); dirty = true; }
        simClock += STEP_MS;
        sinceCheck += 1;
        if (sinceCheck >= 4) {
          sinceCheck = 0;
          if (fieldLive && quiet(f, intensity)) { clear(f); fieldLive = false; }
          if (!fieldLive && !rain.length && !drops.length && !impulses.length) awake = false;
        }
      }
    }

    /**
     * The sources of this frame (drops.js dropsAt): every drop that still shows, at its age, and its mirror images in the walls of the
     * canvas that its ring reaches (the walls reflect, as they do for the field). A drop whose ring has faded below what a pixel shows
     * (QUIET_SHIFT_PX, QUIET_FOCUS) is forgotten. Rows of the table that the frame needs are computed and uploaded first.
     * @param {Field} f @param {number} now
     */
    function writeSources(f, now) {
      const k = Math.max(1e-3, intensity);
      const slopeLimit = QUIET_SHIFT_PX / (REFRACT_PX * k), curvLimit = QUIET_FOCUS / (CAUSTIC_PX * k);
      let need = 0;
      drops = drops.filter((d) => {
        const row = Math.max(0, ((now - d.born) / 1000) * ROWS_PER_S);
        if (row >= TABLE_ROWS - 1) return false;   // the table has faded to flat by its last row
        need = Math.max(need, Math.min(TABLE_ROWS - 1, Math.floor(row) + 1));
        return true;
      });
      while (table.rows <= need) computeRow(table);
      if (table.rows > uploadedRows) {
        const rows = table.rows - uploadedRows;
        device.queue.writeTexture({ texture: tableTexture, origin: { x: 0, y: uploadedRows } }, table.half, { offset: uploadedRows * TABLE_W * 8, bytesPerRow: TABLE_W * 8, rowsPerImage: rows }, { width: TABLE_W, height: rows });
        uploadedRows = table.rows;
      }
      // a burst: beyond MAX_DROPS the oldest drops fade out (they are the weakest: a drop's ring loses most of its height in its first
      // second), so that the cost of a frame is bounded whatever the number of taps
      for (let i = 0; i < drops.length - MAX_DROPS; i += 1) drops[i].fading ??= now;
      /** the depth of a drop now, with its fade @param {Drop} d */
      const depthOf = (d) => {
        if (d.fading === undefined) return d.depth;
        const s = Math.min(1, Math.max(0, (now - d.fading) / DROP_FADE_MS));
        return d.depth * (1 - s * s * (3 - 2 * s));
      };
      drops = drops.filter((d) => {
        const r0 = Math.floor(Math.max(0, ((now - d.born) / 1000) * ROWS_PER_S));
        const depth = depthOf(d);
        if (d.fading !== undefined && depth <= 0) return false;
        return r0 < 2 * ROWS_PER_S / 10 || depth * table.slope[r0] > slopeLimit || depth * table.curv[r0] > curvLimit;
      });
      const W = f.cssWidth, H = f.cssHeight;
      let n = 0;
      const put = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ row, /** @type {number} */ depth, /** @type {number} */ inner, /** @type {number} */ outer) => {
        if (n >= MAX_SOURCES) return;
        const o = SOURCES_OFFSET + n * SOURCE_FLOATS;
        globals[o] = x; globals[o + 1] = y; globals[o + 2] = row; globals[o + 3] = depth; globals[o + 4] = inner; globals[o + 5] = outer; globals[o + 6] = 0; globals[o + 7] = 0;
        n += 1;
      };
      /** @type {number[][]} */ const images = [];
      for (const d of drops) {
        const row = Math.max(0, ((now - d.born) / 1000) * ROWS_PER_S);
        const r0 = Math.floor(row), r1 = Math.min(TABLE_ROWS - 1, r0 + 1);
        const inner = Math.min(table.inner[r0], table.inner[r1]), outer = Math.max(table.outer[r0], table.outer[r1]);
        const depth = depthOf(d);
        put(d.x, d.y, row, depth, inner, outer);
        for (const ix of [-1, 0, 1]) {
          for (const iy of [-1, 0, 1]) {
            if (!ix && !iy) continue;
            const x = ix < 0 ? -d.x : ix > 0 ? 2 * W - d.x : d.x, y = iy < 0 ? -d.y : iy > 0 ? 2 * H - d.y : d.y;
            const gap = Math.hypot(Math.max(0, -x, x - W), Math.max(0, -y, y - H));
            if (gap < outer) images.push([x, y, row, depth, inner, outer]);
          }
        }
      }
      for (const im of images) put(im[0], im[1], im[2], im[3], im[4], im[5]);
      globals[G.DROPS] = n;
    }

    return {
      spatial: true,
      /** true while the surface moves (or with the ambient swell): the host renders every capped frame then, and none at rest */
      get continuous() { return awake || ambient > 0; },
      setOptions(next) {
        // an option change during the demo is the user's: it takes over (the rain stops, the demo resolves null)
        if (rain.length || demoTakeover) takeOver();
        intensity = clamp01(next?.intensity, intensity);
        light = clamp01(next?.light, light);
        if (!reducedMotion) ambient = clamp01(next?.ambient, ambient);
        if (DROP_KINDS.includes(/** @type {any} */ (next?.drops))) dropKind = /** @type {string} */ (next?.drops);
        syncUi();
      },
      runAction(action, options, info) {
        const still = reducedMotion || info.reducedMotion;
        if (action === 'demo') {
          takeOver();
          if (still) return 'calm';
          wake();
          const t0 = simClock;
          rain = demoRain().map((d) => ({ ...d, t: t0 + d.t }));
          return new Promise((resolve) => {
            demoTakeover = resolve;
            waiters.push((state) => { if (demoTakeover === resolve) { demoTakeover = null; resolve(state); } });
          });
        }
        // 'drop'
        const at = actionPoint(options.point, 'water');
        const strength = options.strength === undefined ? 1.2 : Number(options.strength);
        if (!Number.isFinite(strength)) throw new TypeError('water: `strength` must be a finite number (0.08 to 2)');
        takeOver();
        if (!still) {
          const f = currentField();
          const p = at ? toField(at.x, at.y) : { x: f.cssWidth / 2, y: f.cssHeight / 2 };
          if (options.swell === true) {
            // a swell on the wake field: one broad ring, as one piece (SWELL_RADIUS, SWELL_DEPTH at the default strength)
            swell(f, p.x, p.y, SWELL_RADIUS, (SWELL_DEPTH * Math.min(2, Math.max(0.08, strength))) / 1.2);
            fieldLive = true; dirty = true; wake();
          } else addDrop(p.x, p.y, dropDepth(strength));
        }
        return wait();
      },
      settled: wait,
      render(frame) {
        const f = ensureField(frame.cssWidth || canvas.clientWidth || frame.width, frame.cssHeight || canvas.clientHeight || frame.height);
        if (awake) advance(f, frame.now);
        if (drops.length) writeSources(f, frame.now); else globals[G.DROPS] = 0;
        const active = fieldLive ? 1 : 0;
        if (active && dirty) {
          mirror(f);
          device.queue.writeTexture({ texture: fieldTexture }, f.h, { bytesPerRow: f.pw * 4, rowsPerImage: f.ph }, { width: f.pw, height: f.ph });
        }
        dirty = false;
        const refract = REFRACT_PX * intensity;
        globals[G.RES] = frame.width; globals[G.RES + 1] = frame.height;
        globals[G.CSS] = f.cssWidth; globals[G.CSS + 1] = f.cssHeight;
        globals[G.K] = refract / f.cellX; globals[G.K + 1] = refract / f.cellY;
        globals[G.INV_CELL] = 1 / f.cellX; globals[G.INV_CELL + 1] = 1 / f.cellY;
        globals[G.GRID] = f.gw; globals[G.GRID + 1] = f.gh;
        globals[G.TIME] = (frame.now - start) / 1000;
        globals[G.INTENSITY] = intensity;
        globals[G.LIGHT] = light;
        globals[G.AMBIENT] = ambient * AMBIENT_PX;
        globals[G.ACTIVE] = active;
        globals[G.READY] = frame.sourceReady ? 1 : 0;
        globals[G.REFRACT] = refract;
        globals[G.CAUSTIC] = CAUSTIC_DEPTH_PX;
        // the light moves only while the surface does; still water lights the page uniformly (1) and needs no pass
        const caustics = (active > 0 || globals[G.DROPS] > 0 || ambient > 0) && light > 0 && intensity > 0;
        globals[G.CAUSTICS] = caustics ? 1 : 0;
        if (waiters.length && calm()) for (const resolve of waiters.splice(0)) resolve('calm');
        device.queue.writeBuffer(uniformBuffer, 0, globals);
        // the drop and caustic textures follow the field's size from the first frame on, so that a first tap allocates nothing
        { const g = dropGrid(f.cssWidth, f.cssHeight); ensureDropTargets(g.w, g.h); }
        let bindGroup = bindGroups.get(frame.sourceView);
        if (!bindGroup) {
          bindGroup = device.createBindGroup({
            label: 'hic-water-effect-bind-group', layout,
            entries: [
              { binding: 0, resource: { buffer: uniformBuffer } },
              { binding: 1, resource: sampler },
              { binding: 2, resource: frame.sourceView },
              { binding: 3, resource: fieldView },
              { binding: 5, resource: dropTargets.viewA },
              { binding: 6, resource: dropTargets.viewB },
            ],
          });
          bindGroups.set(frame.sourceView, bindGroup);
        }
        if (globals[G.DROPS] > 0) {
          dropsBindGroup ??= device.createBindGroup({
            label: 'hic-water-effect-drops-bind-group', layout: dropsLayout,
            entries: [{ binding: 0, resource: { buffer: uniformBuffer } }, { binding: 1, resource: sampler }, { binding: 4, resource: tableView }],
          });
          const dp = frame.encoder.beginRenderPass({
            colorAttachments: [{ view: dropTargets.viewA, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
          });
          dp.setPipeline(dropsPipeline); dp.setBindGroup(0, dropsBindGroup); dp.draw(3); dp.end();
        }
        if (caustics) {
          causticBindGroup ??= device.createBindGroup({
            label: 'hic-water-effect-caustic-bind-group', layout: causticLayout,
            entries: [{ binding: 0, resource: { buffer: uniformBuffer } }, { binding: 1, resource: sampler }, { binding: 3, resource: fieldView }, { binding: 5, resource: dropTargets.viewA }],
          });
          const mesh = causticMesh(f.cssWidth, f.cssHeight, CAUSTIC_DEPTH_PX);
          const cp = frame.encoder.beginRenderPass({
            colorAttachments: [{ view: dropTargets.viewMs, resolveTarget: dropTargets.viewB, loadOp: 'clear', storeOp: 'discard', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
          });
          cp.setPipeline(causticPipeline); cp.setBindGroup(0, causticBindGroup); cp.draw(2 * (mesh.columns + 1), mesh.rows); cp.end();
        }
        const timestampWrites = frame.profiling?.timestampWrites('water');
        const pass = frame.encoder.beginRenderPass({
          colorAttachments: [{ view: frame.destinationView, loadOp: 'clear', storeOp: 'store', clearValue: CLEAR_COLOR }],
          ...(timestampWrites ? { timestampWrites } : {}),
        });
        pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.draw(3); pass.end();
      },
      captureInputMapper() {
        mapperSlot = (mapperSlot + 1) % MAPPER_SLOTS;
        const s = mapperStates[mapperSlot];
        texelCaches.get(s)?.clear();
        s.set(globals);
        if (globals[G.ACTIVE] > 0.5 && field) s.set(field.h, UNIFORM_LENGTH);
        return mappers[mapperSlot];
      },
      mountUI(root, ui) {
        return mountIntensityUi(root, ui, (range, output) => {
          uiRange = range;
          uiOutput = output;
          syncUi();
        });
      },
      destroy() {
        rain = [];
        drops = [];
        impulses = [];
        cancelIdle();
        const demo = demoTakeover;
        demoTakeover = null;
        demo?.(null);
        for (const resolve of waiters.splice(0)) resolve(null);
        uniformBuffer.destroy?.();
        fieldTexture?.destroy?.();
        tableTexture.destroy?.();
        dropTargets.a?.destroy?.(); dropTargets.b?.destroy?.(); dropTargets.ms?.destroy?.();
      },
    };
  },
});
