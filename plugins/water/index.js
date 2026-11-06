/**
 * Water effect plugin (effect plugin ABI v2): an EXAMPLE of the effects extension of html-in-canvas-polyfill, not part of the polyfill.
 *
 * A height-field water surface over the HTML drawn in the canvas: sim.js advances the wave equation on the CPU (a grid of cells of about
 * 3 CSS px, 120 steps per second, reflecting walls, damping and viscosity that bring it back to a flat surface); a moving pointer stirs a
 * wake into it and a tap drops a pebble into it (a train of impulses). The field is uploaded as an r32float texture, and water.wgsl
 * evaluates it per device pixel as a cubic B-spline: refraction of the page from the surface normals, caustics computed as light is (a
 * refracted mesh of the surface), Fresnel reflection of a sky, a window light and a sun, absorption.
 *
 * Input: the pointer and taps make pebbles, a moving pointer a wake. The listeners are passive: a finger keeps scrolling the page. The
 * input mapper (`mapWaterPoint`) evaluates the very uniform block and height field that were submitted for the presented frame (copied
 * into one of four slots) with the same B-spline as the shader, so clicks and typing reach the field the user sees.
 *
 * Zero work at rest: the instance is `continuous` only while the surface moves; once it is flat (below what a pixel shows) the field is
 * cleared and the host stops rendering. The option `ambient` (a gentle swell) makes it continuous on purpose.
 *
 * Actions: 'drop' (a pebble at `point`; with `swell: true` one broad swell) and 'demo' (a short rain, then calm) resolve 'calm' once the surface is still. User input during the
 * demo (the pointer, setOptions) stops the rain at once and resolves the demo with null. With reduced motion both resolve 'calm' at once and nothing moves.
 *
 * `plugin` is a plain, frozen definition that `host.addPlugin` validates (docs/guides/EFFECTS-PLUGINS.md).
 */

import { wgsl } from './wgsl.js';
import { stateMapper } from '../_lib/mapper.js';
import { injectStyle } from '../_lib/ui.js';
import { actionPoint } from '../_lib/action.js';
import { CAUSTIC_DEPTH_PX, MAX_STEPS_PER_FRAME, PAD, REFRACT_PX, STEP_MS, ambientSlope, clear, createField, gridOf, mirror, quiet, setSize, stamp, step, surfaceAt, swell } from './sim.js';

/** @typedef {import('../../src/contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../../src/contracts/types.js').InputPoint} InputPoint */
/** @typedef {import('./sim.js').Field} Field */
/** @typedef {{t: number, x: number, y: number, depth: number}} RainDrop  t: ms; x, y: 0..1 of the canvas; depth: css px */
/** @typedef {{t: number, x: number, y: number, r: number, a: number}} Impulse  a stamp due at t ms (the simulation clock), css px of the field */

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
export const G = Object.freeze({ RES: 0, CSS: 2, K: 4, INV_CELL: 6, GRID: 8, TIME: 10, INTENSITY: 11, LIGHT: 12, AMBIENT: 13, ACTIVE: 14, READY: 15, REFRACT: 16, CAUSTIC: 17, CAUSTICS: 18, BOX: 20 });
export const GLOBALS_LENGTH = 24;
/** mapper states kept alive: the mapper chain keeps the last 3 presented frames, plus the one being written */
const MAPPER_SLOTS = 4;
const DEFAULT_INTENSITY = 0.5;
/** css px of the ambient swell at `ambient: 1` */
export const AMBIENT_PX = 2.6;
const CLEAR_COLOR = { r: 0.004, g: 0.018, b: 0.034, a: 1 };
/** a tap's strength: the action drop scales a tap's pebble by its strength / 1.2 (DROP_DEPTH: the reference, at 1.2) */
export const DROP_DEPTH = 4;
/**
 * A tap drops a pebble on the wake field, as the wakes are made, so that a tap speaks the wakes' language (their waves, their caustics,
 * their cost, which the number of taps does not change). A smooth crater of POND_RADIUS css px and POND_DEPTH css px at a tap's strength,
 * then the water that rushes back: a rebound in the middle (the jet of a drop, the 'plop') and two smaller swings. Each impulse rings out
 * as a ring that the wave equation carries outwards: a few separated rings, about 2 s. [ms after the impact, radius (share of
 * POND_RADIUS), height (share of POND_DEPTH; negative: a dip)]
 */
export const POND_RADIUS = 22;
export const POND_DEPTH = 12;
export const POND_IMPULSES = Object.freeze(Array.from({ length: 4 }, (_, k) => Object.freeze([k * 90, Math.max(0.45, 1 - 0.18 * k), (k % 2 ? 1 : -1) * 0.65 ** k])));
/** the rain of the demo on the pond: raindrops of this share of a tap's pebble in size, and in depth */
export const POND_RAIN = Object.freeze([0.65, 0.6]);
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
 * math as fs() in water.wgsl (the B-spline gradient times the refraction, the ambient swell, the clamp). PURE.
 * @param {Float32Array} state
 * @param {InputPoint} point  presented point, canvas css px, plus the presented size
 * @returns {{x: number, y: number}}
 */
export function mapWaterPoint(state, point) {
  const width = Math.max(1, point.width);
  const height = Math.max(1, point.height);
  const u = point.x / width;
  const v = point.y / height;
  const cssW = Math.max(1, state[G.CSS]), cssH = Math.max(1, state[G.CSS + 1]);
  let dx = 0, dy = 0;
  if (state[G.ACTIVE] > 0.5) {
    const gw = state[G.GRID], gh = state[G.GRID + 1];
    const s = surfaceAt(state, GLOBALS_LENGTH, gw + 2 * PAD, gh + 2 * PAD, u * gw - 0.5 + PAD, v * gh - 0.5 + PAD);
    dx = state[G.K] * s.hx;
    dy = state[G.K + 1] * s.hy;
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
/** The caustic texture of a canvas of css size (w, h): one texel per css px (water.wgsl light_grid). @param {number} w @param {number} h */
export function lightGrid(w, h) {
  return { w: Math.max(1, Math.ceil(Math.fround(w) - 0.01)), h: Math.max(1, Math.ceil(Math.fround(h) - 0.01)) };
}

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
      // the sunlight on the page, one texel per css px (r16float, filtered)
      { binding: 4, visibility: stage, texture: { sampleType: 'float' } },
    ],
  });
  const pipeline = make({
    label: 'hic-water-effect-pipeline',
    layout: device.createPipelineLayout({ label: 'hic-water-effect-pipeline-layout', bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  // the caustics pass: the surface (the field) in the vertex stage, the light added up per texel of the page
  const both = stage | (/** @type {any} */ (globalThis).GPUShaderStage?.VERTEX ?? 1);
  const causticLayout = device.createBindGroupLayout({
    label: 'hic-water-effect-caustic-layout',
    entries: [
      { binding: 0, visibility: both, buffer: { type: 'uniform' } },
      { binding: 1, visibility: both, sampler: { type: 'filtering' } },
      { binding: 3, visibility: both, texture: { sampleType: 'unfilterable-float' } },
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
  const [p0, p1] = await Promise.all([pipeline, causticPipeline]);
  return { pipeline: p0, layout, causticPipeline: p1, causticLayout };
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
    const { pipeline, layout, causticPipeline, causticLayout } = await createPipeline(device, code, format);
    const gpu = /** @type {any} */ (globalThis);
    const bufferUsage = gpu.GPUBufferUsage;
    const textureUsage = gpu.GPUTextureUsage ?? { COPY_DST: 2, TEXTURE_BINDING: 4 };
    const uniformBuffer = device.createBuffer({ label: 'hic-water-effect-globals', size: GLOBALS_LENGTH * 4, usage: bufferUsage.UNIFORM | bufferUsage.COPY_DST });
    /**
     * The caustic texture (lightGrid of the field's css size) and its 4x multisampled target, held only while caustics can show (`lit()`):
     * from the first frame on, so that a first tap allocates nothing, and made at once when an option change turns them on. While they
     * cannot show (light 0, intensity 0, reduced motion) the picture binds a 1 x 1 texture that it never samples.
     */
    let lightTargets = { w: 0, h: 0, tex: /** @type {any} */ (null), ms: /** @type {any} */ (null), view: /** @type {any} */ (null), viewMs: /** @type {any} */ (null) };
    /** @param {number} w @param {number} h */
    const ensureLightTargets = (w, h) => {
      if (lightTargets.w === w && lightTargets.h === h) return;
      releaseLightTargets();
      const tex = device.createTexture({ label: 'hic-water-effect-caustics', size: { width: w, height: h }, format: 'r16float', usage: textureUsage.TEXTURE_BINDING | textureUsage.RENDER_ATTACHMENT });
      const ms = device.createTexture({ label: 'hic-water-effect-caustics-ms', size: { width: w, height: h }, format: 'r16float', sampleCount: 4, usage: textureUsage.RENDER_ATTACHMENT });
      lightTargets = { w, h, tex, ms, view: tex.createView(), viewMs: ms.createView() };
      bindGroups = new WeakMap();
    };
    const releaseLightTargets = () => {
      if (!lightTargets.tex) return;
      lightTargets.tex.destroy?.(); lightTargets.ms.destroy?.();
      lightTargets = { w: 0, h: 0, tex: null, ms: null, view: null, viewMs: null };
      bindGroups = new WeakMap();
    };
    /** binding 4 while there is no caustic texture (never sampled then: caustics_on is 0) @type {{tex: any, view: any}|null} */
    let unlit = null;
    const lightView = () => {
      if (lightTargets.view) return lightTargets.view;
      if (!unlit) {
        const tex = device.createTexture({ label: 'hic-water-effect-caustics-none', size: { width: 1, height: 1 }, format: 'r16float', usage: textureUsage.TEXTURE_BINDING });
        unlit = { tex, view: tex.createView() };
      }
      return unlit.view;
    };
    /** Hold the caustic textures exactly while caustics can show, at the size of the field `f`. @param {Field} f */
    const fitLight = (f) => {
      if (!lit()) { releaseLightTargets(); return; }
      const g = lightGrid(f.cssWidth, f.cssHeight);
      ensureLightTargets(g.w, g.h);
    };
    /** @type {any} */ let causticBindGroup = null;

    const sampler = device.createSampler({ label: 'hic-water-effect-sampler', magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const globals = new Float32Array(GLOBALS_LENGTH);
    const canvas = context.canvas;
    const win = /** @type {any} */ (canvas.ownerDocument.defaultView);
    // prefers-reduced-motion (read now, and by the host at every trigger): still water. Nothing starts a ripple; the surface keeps its
    // reflection and tint (a static picture, rendered only when the page or an option changes), and the mapper is the identity.
    const reducedMotion = !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const start = performance.now();

    let intensity = clamp01(initialOptions?.intensity, DEFAULT_INTENSITY);
    let light = clamp01(initialOptions?.light, 1);
    let ambient = reducedMotion ? 0 : clamp01(initialOptions?.ambient, 0);
    /** caustics can show: some light on water that can move (reduced motion keeps it still and the swell off) */
    const lit = () => !reducedMotion && light > 0 && intensity > 0;
    /** impulses of pebbles still to come, on the simulation clock @type {Impulse[]} */
    let impulses = [];

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
    /** woken by an event, no frame since: the first frame sets the clock's phase (advance) */
    let clockFromEvent = false;
    let sinceCheck = 0;
    /** drops of the running demo, on the simulation clock @type {RainDrop[]} */
    let rain = [];
    /** resolves the running demo with null when the user takes over @type {((state: string|null) => void)|null} */
    let demoTakeover = null;
    /** @type {((state: string|null) => void)[]} */ const waiters = [];
    /** mapper states: the uniform block followed by the field (reallocated with the field) @type {Float32Array[]} */
    let mapperStates = [];
    /** @type {any[]} */ let mappers = [];
    let mapperSlot = 0;
    /** @type {HTMLInputElement|null} */ let uiRange = null;
    /** @type {HTMLOutputElement|null} */ let uiOutput = null;

    /** The field of a canvas of this css size: the same grid follows a resize of a fraction of a cell; another grid starts flat. @param {number} cssWidth @param {number} cssHeight */
    function ensureField(cssWidth, cssHeight) {
      if (field && Math.abs(field.cssWidth - cssWidth) < 0.01 && Math.abs(field.cssHeight - cssHeight) < 0.01) return field;
      const grid = gridOf(cssWidth, cssHeight);
      if (field && field.gw === grid.gw && field.gh === grid.gh) { setSize(field, cssWidth, cssHeight); return field; }
      const f = createField(cssWidth, cssHeight);
      // flat: its box is empty (a new field counts as written everywhere), so a first pebble steps its own region, not the grid
      clear(f);
      field = f;
      fieldTexture?.destroy?.();
      fieldTexture = device.createTexture({ label: 'hic-water-effect-height-field', size: { width: f.pw, height: f.ph }, format: 'r32float', usage: textureUsage.TEXTURE_BINDING | textureUsage.COPY_DST });
      fieldView = fieldTexture.createView();
      // made with the field, so that a first tap creates nothing
      causticBindGroup = device.createBindGroup({
        label: 'hic-water-effect-caustic-bind-group', layout: causticLayout,
        entries: [{ binding: 0, resource: { buffer: uniformBuffer } }, { binding: 1, resource: sampler }, { binding: 3, resource: fieldView }],
      });
      fieldLive = false;
      bindGroups = new WeakMap();
      mapperStates = Array.from({ length: MAPPER_SLOTS }, () => new Float32Array(GLOBALS_LENGTH + f.pw * f.ph));
      mappers = mapperStates.map((s) => stateMapper(s, mapWaterPoint));
      dirty = true;
      return f;
    }

    /** the field (before the first frame: one of the canvas's client size) */
    const currentField = () => field ?? ensureField(canvas.clientWidth || 1, canvas.clientHeight || 1);

    /** The surface starts to move (input, an action): the simulation clock starts now, and the first frame aligns it to the frames (advance). */
    function wake() {
      if (!awake) { awake = true; simClock = performance.now(); clockFromEvent = true; sinceCheck = 0; }
      context.requestRender();
    }

    /**
     * A pebble at (x, y) css px of the field, at `born` ms: its impulses, due on the simulation clock. @param {number} x @param {number} y
     * @param {number} depth  a tap's is DROP_DEPTH @param {number} [born] @param {number} [size]  of a tap's pebble (the rain's are smaller)
     */
    function addDrop(x, y, depth, born = performance.now(), size = 1) {
      currentField();
      const k = depth / DROP_DEPTH;
      for (const [dt, r, a] of POND_IMPULSES) impulses.push({ t: born + dt * size, x, y, r: r * POND_RADIUS * size, a: a * POND_DEPTH * k });
      impulses.sort((p, q) => p.t - q.t);
      wake();
    }

    /** User input during the demo: the rain stops at once and the demo resolves null; the input takes over. */
    function takeOver() {
      rain = [];
      const resolve = demoTakeover;
      demoTakeover = null;
      resolve?.(null);
    }

    const calm = () => !awake && !rain.length && !impulses.length;
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
      if (clockFromEvent) {
        // The first frame after a wake moves the clock (and what is due on it) by less than a step, from the event's phase to half a step
        // away from the frame times: the frame shows the time since the event (at least one step, so the first frame shows it at once), and a
        // step boundary never sits on the frame times. On the event's phase, a tap delivered just after a frame left every later frame a jitter
        // away from a boundary, and a 120 Hz display then alternated 0 and 2 steps per frame (the water at 60 Hz with double steps;
        // plugins/water/test/water-math.test.mjs measures it).
        clockFromEvent = false;
        const shift = now - (Math.max(1, Math.floor((now - simClock) / STEP_MS)) + 0.5) * STEP_MS - simClock;
        simClock += shift;
        for (const d of rain) d.t += shift;
        for (const p of impulses) p.t += shift;
      }
      let n = Math.floor((now - simClock) / STEP_MS);
      // a long gap (off-screen, a frame cap of 1) is skipped, not caught up: the pebbles and the rain skip it too (their clock is the simulation's)
      if (n > MAX_STEPS_PER_FRAME) {
        // whole steps, so the phase of the steps to the frames stays where it is
        const skipped = (n - MAX_STEPS_PER_FRAME) * STEP_MS;
        simClock += skipped; n = MAX_STEPS_PER_FRAME;
        for (const d of rain) d.t += skipped;
        for (const p of impulses) p.t += skipped;
      }
      for (let i = 0; i < n && awake; i += 1) {
        while (rain.length && rain[0].t <= simClock) {
          const d = /** @type {RainDrop} */ (rain.shift());
          // the rain is raindrops, not pebbles: smaller and lighter (POND_RAIN)
          addDrop(d.x * f.cssWidth, d.y * f.cssHeight, d.depth * POND_RAIN[1], d.t, POND_RAIN[0]);
        }
        while (impulses.length && impulses[0].t <= simClock) {
          const p = /** @type {Impulse} */ (impulses.shift());
          stamp(f, p.x, p.y, p.r, p.a);
          fieldLive = true;
        }
        if (fieldLive) { step(f); dirty = true; }
        simClock += STEP_MS;
        sinceCheck += 1;
        if (sinceCheck >= 4) {
          sinceCheck = 0;
          if (fieldLive && quiet(f, intensity)) { clear(f); fieldLive = false; }
          if (!fieldLive && !rain.length && !impulses.length) awake = false;
        }
      }
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
        // the caustic textures follow at once: made before the next tap when the light comes on, released when it goes off
        if (field) fitLight(field);
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
        // the cells of the field that may be non-zero (sim.js box): the shader skips the B-spline elsewhere, where it would read only zeros
        globals[G.BOX] = f.box[0]; globals[G.BOX + 1] = f.box[1]; globals[G.BOX + 2] = f.box[2]; globals[G.BOX + 3] = f.box[3];
        // the light moves only while the surface does; still water lights the page uniformly (1) and needs no pass
        const caustics = (active > 0 || ambient > 0) && light > 0 && intensity > 0;
        globals[G.CAUSTICS] = caustics ? 1 : 0;
        if (waiters.length && calm()) for (const resolve of waiters.splice(0)) resolve('calm');
        device.queue.writeBuffer(uniformBuffer, 0, globals);
        // the caustic textures follow the field's size from the first frame on, so that a first tap allocates nothing
        fitLight(f);
        let bindGroup = bindGroups.get(frame.sourceView);
        if (!bindGroup) {
          bindGroup = device.createBindGroup({
            label: 'hic-water-effect-bind-group', layout,
            entries: [
              { binding: 0, resource: { buffer: uniformBuffer } },
              { binding: 1, resource: sampler },
              { binding: 2, resource: frame.sourceView },
              { binding: 3, resource: fieldView },
              { binding: 4, resource: lightView() },
            ],
          });
          bindGroups.set(frame.sourceView, bindGroup);
        }
        if (caustics) {
          const mesh = causticMesh(f.cssWidth, f.cssHeight, CAUSTIC_DEPTH_PX);
          const cp = frame.encoder.beginRenderPass({
            colorAttachments: [{ view: lightTargets.viewMs, resolveTarget: lightTargets.view, loadOp: 'clear', storeOp: 'discard', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
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
        s.set(globals);
        if (globals[G.ACTIVE] > 0.5 && field) s.set(field.h, GLOBALS_LENGTH);
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
        impulses = [];
        const demo = demoTakeover;
        demoTakeover = null;
        demo?.(null);
        for (const resolve of waiters.splice(0)) resolve(null);
        uniformBuffer.destroy?.();
        fieldTexture?.destroy?.();
        releaseLightTargets();
        unlit?.tex.destroy?.();
      },
    };
  },
});
