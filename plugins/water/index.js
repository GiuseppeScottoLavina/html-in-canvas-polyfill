/**
 * Water effect plugin (effect plugin ABI v2): an EXAMPLE of the effects extension of html-in-canvas-polyfill, not part of the polyfill.
 *
 * A height-field water surface over the HTML drawn in the canvas: sim.js advances the wave equation on the CPU (a grid of cells of about
 * 3 CSS px, 120 steps per second, reflecting walls, damping and viscosity that bring it back to a flat surface); the field is uploaded as
 * an r32float texture, and water.wgsl evaluates it per device pixel as a cubic B-spline: refraction of the page from the surface normals,
 * caustics, Fresnel reflection of a sky, a window light and a sun, absorption.
 *
 * Input: the pointer and taps make drops, a moving pointer a wake. The listeners are passive: a finger keeps scrolling the page. The input
 * mapper (`mapWaterPoint`) evaluates the very uniform block and height field that were submitted for the presented frame (copied into one
 * of four slots) with the same B-spline as the shader, so clicks and typing reach the field the user sees.
 *
 * Zero work at rest: the instance is `continuous` only while the surface moves; once it is flat (below what a pixel shows) the field is
 * cleared and the host stops rendering. The option `ambient` (a gentle swell) makes it continuous on purpose.
 *
 * Actions: 'drop' (a drop at `point`) and 'demo' (a short rain, then calm) resolve 'calm' once the surface is still. User input during the
 * demo stops the rain at once and resolves the demo with null. With reduced motion both resolve 'calm' at once and nothing moves.
 *
 * `plugin` is a plain, frozen definition that `host.addPlugin` validates (docs/guides/EFFECTS-PLUGINS.md).
 */

import { wgsl } from './wgsl.js';
import { stateMapper } from '../_lib/mapper.js';
import { injectStyle } from '../_lib/ui.js';
import { actionPoint } from '../_lib/action.js';
import { CAUSTIC_PX, MAX_STEPS_PER_FRAME, PAD, REFRACT_PX, STEP_MS, ambientSlope, clear, createField, gridOf, mirror, quiet, setSize, stamp, step, surfaceAt } from './sim.js';

/** @typedef {import('../../src/contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../../src/contracts/types.js').InputPoint} InputPoint */
/** @typedef {import('./sim.js').Field} Field */
/** @typedef {{t: number, x: number, y: number, radius: number, depth: number}} RainDrop  t: ms; x, y: 0..1 of the canvas; css px */

/** What the plugin gallery and the build read (plugins/README.md). */
export const meta = Object.freeze({
  name: 'water',
  title: 'Water',
  description: 'A water surface over the live page: drops, wakes, refraction, caustics and reflections; clicks and typing are remapped through it.',
  defaults: Object.freeze({ intensity: 0.5 }),
  reducedMotion: 'Still water: the surface keeps its reflection and tint; no ripple starts and nothing animates; drop and demo resolve at once.',
});

/** The actions of `handle.trigger`: drop lets a drop fall, demo plays a short rain. */
export const ACTIONS = Object.freeze(/** @type {const} */ (['drop', 'demo']));

/** Offsets in the uniform block (water.wgsl Globals), in floats. The mapper state is this block followed by the padded height field. */
export const G = Object.freeze({ RES: 0, CSS: 2, K: 4, INV_CELL: 6, GRID: 8, TIME: 10, INTENSITY: 11, LIGHT: 12, AMBIENT: 13, ACTIVE: 14, READY: 15, REFRACT: 16, CAUSTIC: 17 });
export const GLOBALS_LENGTH = 20;
/** mapper states kept alive: the mapper chain keeps the last 3 presented frames, plus the one being written */
const MAPPER_SLOTS = 4;
const DEFAULT_INTENSITY = 0.5;
/** css px of the ambient swell at `ambient: 1` */
export const AMBIENT_PX = 2.6;
const CLEAR_COLOR = { r: 0.004, g: 0.018, b: 0.034, a: 1 };
/** a tap or a press: a dent of this radius and depth (css px); the action drop scales the depth by its strength */
export const DROP_RADIUS = 13;
export const DROP_DEPTH = 6;
/** the wake of a moving pointer: dents along its path, deeper when it moves faster (up to WAKE_FAST css px per ms) */
const WAKE_RADIUS = 9;
const WAKE_DEPTH = 2;
const WAKE_FAST = 1.6;
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
 * The rain of the action demo: a first large drop, then a shower that thins out; the last drop falls at 1.9 s. Deterministic. PURE.
 * @returns {RainDrop[]}
 */
export function demoRain() {
  const rnd = random(DEMO_SEED);
  /** @type {RainDrop[]} */ const rain = [{ t: 0, x: 0.5, y: 0.44, radius: 20, depth: 6.5 }];
  const n = 30;
  for (let i = 1; i <= n; i += 1) {
    const k = i / n;
    rain.push({ t: 100 + 1500 * k ** 1.3, x: 0.06 + 0.88 * rnd(), y: 0.08 + 0.84 * rnd(), radius: 6 + 8 * rnd(), depth: (2.2 + 2.8 * rnd()) * (1 - 0.7 * k) });
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

/** @param {any} device @param {string} code @param {string} format */
function createPipeline(device, code, format) {
  const stage = /** @type {any} */ (globalThis).GPUShaderStage?.FRAGMENT ?? 2;
  const layout = device.createBindGroupLayout({
    label: 'hic-water-effect-layout',
    entries: [
      { binding: 0, visibility: stage, buffer: { type: 'uniform' } },
      { binding: 1, visibility: stage, sampler: { type: 'filtering' } },
      { binding: 2, visibility: stage, texture: { sampleType: 'float' } },
      // the height field is read with textureLoad only: r32float needs no filtering (it is not filterable without an optional feature)
      { binding: 3, visibility: stage, texture: { sampleType: 'unfilterable-float' } },
    ],
  });
  const module = device.createShaderModule({ code, label: 'hic-water-effect-shader' });
  const pipeline = device.createRenderPipeline({
    label: 'hic-water-effect-pipeline',
    layout: device.createPipelineLayout({ label: 'hic-water-effect-pipeline-layout', bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  return { pipeline, layout };
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
    const { pipeline, layout } = createPipeline(device, code, format);
    const gpu = /** @type {any} */ (globalThis);
    const bufferUsage = gpu.GPUBufferUsage;
    const textureUsage = gpu.GPUTextureUsage ?? { COPY_DST: 2, TEXTURE_BINDING: 4 };
    const uniformBuffer = device.createBuffer({ label: 'hic-water-effect-globals', size: GLOBALS_LENGTH * 4, usage: bufferUsage.UNIFORM | bufferUsage.COPY_DST });
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

    /** @type {Field|null} */ let field = null;
    /** @type {any} */ let fieldTexture = null;
    /** @type {any} */ let fieldView = null;
    let bindGroups = new WeakMap();
    /** the surface moves: frames are needed until it is flat again */
    let awake = false;
    /** the field changed since its last upload */
    let dirty = false;
    /** the simulation clock, ms on the performance.now() time base: the field has been stepped up to this time */
    let simClock = 0;
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
      field = f;
      fieldTexture?.destroy?.();
      fieldTexture = device.createTexture({ label: 'hic-water-effect-height-field', size: { width: f.pw, height: f.ph }, format: 'r32float', usage: textureUsage.TEXTURE_BINDING | textureUsage.COPY_DST });
      fieldView = fieldTexture.createView();
      bindGroups = new WeakMap();
      mapperStates = Array.from({ length: MAPPER_SLOTS }, () => new Float32Array(GLOBALS_LENGTH + f.pw * f.ph));
      mappers = mapperStates.map((s) => stateMapper(s, mapWaterPoint));
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

    /** A dent at (x, y) css px of the field. @param {number} x @param {number} y @param {number} radius @param {number} depth */
    function dent(x, y, radius, depth) {
      stamp(currentField(), x, y, radius, -depth);
      dirty = true;
      wake();
    }

    /** User input during the demo: the rain stops at once and the demo resolves null; the input takes over. */
    function takeOver() {
      rain = [];
      const resolve = demoTakeover;
      demoTakeover = null;
      resolve?.(null);
    }

    const calm = () => !awake && !rain.length;
    /** @returns {'calm'|Promise<string|null>} */
    const wait = () => (calm() ? 'calm' : new Promise((resolve) => { waiters.push(resolve); }));

    /** canvas client px -> css px of the field @param {number} x @param {number} y */
    const toField = (x, y) => {
      const f = currentField();
      return { x: (x * f.cssWidth) / Math.max(1, canvas.clientWidth), y: (y * f.cssHeight) / Math.max(1, canvas.clientHeight) };
    };

    if (!reducedMotion) {
      /** @type {{x: number, y: number, t: number}|null} */ let last = null;
      /** @param {PointerEvent} e */
      const local = (e) => {
        const r = canvas.getBoundingClientRect();
        return toField(e.clientX - r.left - canvas.clientLeft, e.clientY - r.top - canvas.clientTop);
      };
      // passive: the water never claims a gesture (a finger keeps scrolling the page; the browser then cancels the pointer)
      const passive = { passive: true };
      context.listen('pointerdown', (event) => {
        if (!(event instanceof win.PointerEvent)) return;
        const e = /** @type {PointerEvent} */ (event);
        const p = local(e);
        takeOver();
        dent(p.x, p.y, DROP_RADIUS, DROP_DEPTH);
        last = { x: p.x, y: p.y, t: e.timeStamp || performance.now() };
      }, passive);
      context.listen('pointermove', (event) => {
        if (!(event instanceof win.PointerEvent)) return;
        const e = /** @type {PointerEvent} */ (event);
        const p = local(e);
        const t = e.timeStamp || performance.now();
        const prev = last;
        last = { x: p.x, y: p.y, t };
        if (!prev) return;
        const dist = Math.hypot(p.x - prev.x, p.y - prev.y);
        const dt = t - prev.t;
        // a jump (the pointer came back from elsewhere, a long pause) starts a new path
        if (dist < 0.75 || dist > 220 || dt > 150) return;
        // a drag (a pressed button, a finger) stirs harder than a hovering mouse
        const pressed = e.buttons !== 0 || e.pointerType === 'touch' ? 1 : 0.7;
        const depth = WAKE_DEPTH * pressed * Math.min(1, dist / Math.max(4, dt) / WAKE_FAST) ** 0.8;
        if (depth < 0.02) return;
        takeOver();
        const spacing = WAKE_RADIUS * 0.5;
        const n = Math.ceil(dist / spacing);
        const f = currentField();
        for (let i = 1; i <= n; i += 1) {
          const k = i / n;
          stamp(f, prev.x + (p.x - prev.x) * k, prev.y + (p.y - prev.y) * k, WAKE_RADIUS, (-depth * dist) / n / spacing);
        }
        dirty = true;
        wake();
      }, passive);
      const end = () => { last = null; };
      context.listen('pointerleave', end, passive);
      context.listen('pointercancel', end, passive);
    }

    function syncUi() {
      const percent = Math.round(intensity * 100);
      if (uiRange && uiRange.value !== String(percent)) uiRange.value = String(percent);
      if (uiOutput && uiOutput.textContent !== `${percent}%`) uiOutput.textContent = `${percent}%`;
    }

    /** Advance the simulation to `now` (ms): the due drops of the rain, fixed steps, and the check for a flat surface. @param {Field} f @param {number} now */
    function advance(f, now) {
      let n = Math.floor((now - simClock) / STEP_MS);
      // a long gap (off-screen, a frame cap of 1) is skipped, not caught up
      if (n > MAX_STEPS_PER_FRAME) { simClock = now - MAX_STEPS_PER_FRAME * STEP_MS; n = MAX_STEPS_PER_FRAME; }
      for (let i = 0; i < n && awake; i += 1) {
        while (rain.length && rain[0].t <= simClock) {
          const d = /** @type {RainDrop} */ (rain.shift());
          stamp(f, d.x * f.cssWidth, d.y * f.cssHeight, d.radius, -d.depth);
        }
        step(f);
        simClock += STEP_MS;
        dirty = true;
        sinceCheck += 1;
        if (sinceCheck >= 4) {
          sinceCheck = 0;
          if (!rain.length && quiet(f, intensity)) { clear(f); awake = false; }
        }
      }
    }

    return {
      spatial: true,
      /** true while the surface moves (or with the ambient swell): the host renders every capped frame then, and none at rest */
      get continuous() { return awake || ambient > 0; },
      setOptions(next) {
        intensity = clamp01(next?.intensity, intensity);
        light = clamp01(next?.light, light);
        if (!reducedMotion) ambient = clamp01(next?.ambient, ambient);
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
          dent(p.x, p.y, DROP_RADIUS * 1.15, DROP_DEPTH * Math.min(2, Math.max(0.08, strength)));
        }
        return wait();
      },
      settled: wait,
      render(frame) {
        const f = ensureField(frame.cssWidth || canvas.clientWidth || frame.width, frame.cssHeight || canvas.clientHeight || frame.height);
        if (awake) advance(f, frame.now);
        const active = awake ? 1 : 0;
        if (active && dirty) {
          mirror(f);
          device.queue.writeTexture({ texture: fieldTexture }, f.h, { bytesPerRow: f.pw * 4, rowsPerImage: f.ph }, { width: f.pw, height: f.ph });
        }
        if (active || calm()) dirty = false;
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
        globals[G.CAUSTIC] = CAUSTIC_PX * intensity;
        if (waiters.length && calm()) for (const resolve of waiters.splice(0)) resolve('calm');
        device.queue.writeBuffer(uniformBuffer, 0, globals);
        let bindGroup = bindGroups.get(frame.sourceView);
        if (!bindGroup) {
          bindGroup = device.createBindGroup({
            label: 'hic-water-effect-bind-group', layout,
            entries: [
              { binding: 0, resource: { buffer: uniformBuffer } },
              { binding: 1, resource: sampler },
              { binding: 2, resource: frame.sourceView },
              { binding: 3, resource: fieldView },
            ],
          });
          bindGroups.set(frame.sourceView, bindGroup);
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
        const demo = demoTakeover;
        demoTakeover = null;
        demo?.(null);
        for (const resolve of waiters.splice(0)) resolve(null);
        uniformBuffer.destroy?.();
        fieldTexture?.destroy?.();
      },
    };
  },
});
