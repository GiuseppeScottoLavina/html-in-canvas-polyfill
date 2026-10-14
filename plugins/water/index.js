/**
 * Water ripple effect plugin (effect plugin ABI v2): an EXAMPLE of the effects extension of html-in-canvas-polyfill, not part of the polyfill.
 * Shader: ./water.wgsl.
 *
 * The input mapper (`mapWaterPoint`) is the JS twin of the displacement in water.wgsl: same constants, same fast_exp_neg, same clamp.
 * It evaluates the uniform block that was submitted for the presented frame, so it describes exactly those pixels. The test
 * test/water-gpu.browser.test.mjs checks the twin against the pixels the GPU actually produced.
 *
 * The module has no dependency: `plugin` is a plain, frozen definition that `host.addPlugin` validates (docs/guides/EFFECTS-PLUGINS.md).
 */

import { wgsl } from './wgsl.js';

/** @typedef {import('../../src/contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../../src/contracts/types.js').EffectPluginContext} EffectPluginContext */
/** @typedef {import('../../src/contracts/types.js').EffectPluginInstance} EffectPluginInstance */
/** @typedef {import('../../src/contracts/types.js').InputMapper} InputMapper */
/** @typedef {import('../../src/contracts/types.js').InputPoint} InputPoint */

/** What the plugin gallery and the build read (plugins/README.md). */
export const meta = Object.freeze({
  name: 'water',
  title: 'Water',
  description: 'Ripples that follow the pointer; clicks and typing are remapped through the displacement.',
  defaults: Object.freeze({ intensity: 0.28 }),
  reducedMotion: 'No reduced-motion mode of its own: ripples appear only where the pointer moves or presses.',
});

export const RIPPLE_COUNT = 4;
/** floats in the uniform block: resolution(2) time ready | params(4) | ripples(4 x vec4) */
export const GLOBALS_LENGTH = 8 + RIPPLE_COUNT * 4;
/** mapper states kept alive: the mapper chain keeps the last 3 presented frames, plus the one being written */
const MAPPER_SLOTS = 4;
const DEFAULT_INTENSITY = 0.28;
const RIPPLE_LIFETIME_S = 3.2;
const CLEAR = { r: 0.004, g: 0.018, b: 0.034, a: 1 };

let uiSerial = 0;

/** @param {unknown} v */
function clamp01(v) { return Math.min(1, Math.max(0, Number(v) || 0)); }

/** The reciprocal-cubic stand-in for exp(-x), shared with the shader. @param {number} value */
function fastExpNeg(value) {
  const q = Math.max(0, Number(value) || 0);
  const q2 = q * q;
  return 1 / (1 + q + 0.48 * q2 + 0.235 * q2 * q);
}

/**
 * Source point shown at the presented point `point`, for the uniform block `state` (same math as fs() in water.wgsl).
 * @param {Float32Array} state  layout of the uniform block: [2] time, [4] intensity, [8 + 4i ..] ripple x, y, radius, gain
 * @param {InputPoint} point  presented point, canvas css px, plus the presented size
 * @returns {{x: number, y: number}}
 */
export function mapWaterPoint(state, point) {
  const width = Math.max(1, point.width);
  const height = Math.max(1, point.height);
  const time = state[2];
  const intensity = state[4];
  let ux = point.x / width;
  let uy = point.y / height;
  const aspectX = width / height;
  let rx = 0;
  let ry = 0;
  for (let i = 0; i < RIPPLE_COUNT; i += 1) {
    const base = 8 + i * 4;
    const gain = state[base + 3];
    if (!(gain > 0)) continue;
    const dx = (ux - state[base]) * aspectX;
    const dy = uy - state[base + 1];
    const distance = Math.max(Math.hypot(dx, dy), 0.0001);
    const ring = Math.cos((distance - state[base + 2]) * 82);
    const envelope = fastExpNeg(distance * 2.55) * gain;
    rx += ((dx / distance) / aspectX) * ring * envelope * (0.0105 * intensity);
    ry += (dy / distance) * ring * envelope * (0.0105 * intensity);
  }
  const idleX = Math.sin(uy * 17 + time * 0.46) * (0.00155 * intensity);
  const idleY = Math.cos(ux * 15 - time * 0.4) * (0.00155 * intensity);
  ux = Math.min(0.999, Math.max(0.001, ux + idleX + rx));
  uy = Math.min(0.999, Math.max(0.001, uy + idleY + ry));
  return { x: ux * width, y: uy * height };
}

/**
 * @typedef {Object} Ripple
 * @property {number} x  0..1 of the canvas
 * @property {number} y
 * @property {number} time  start, seconds on the plugin clock (a delayed ripple starts in the future)
 * @property {number} strength
 */

/**
 * The uniform block of one frame.
 * @param {Float32Array} globals
 * @param {{width: number, height: number, sourceReady: boolean}} frame
 * @param {Ripple[]} ripples
 * @param {number} time
 * @param {number} intensity
 */
function fillGlobals(globals, frame, ripples, time, intensity) {
  globals[0] = frame.width; globals[1] = frame.height; globals[2] = time; globals[3] = frame.sourceReady ? 1 : 0;
  globals[4] = intensity; globals[5] = 0; globals[6] = 0; globals[7] = 0;
  for (let i = 0; i < RIPPLE_COUNT; i += 1) {
    const ripple = ripples[i];
    const base = 8 + i * 4;
    const age = time - ripple.time;
    const active = age >= 0 && age < RIPPLE_LIFETIME_S && ripple.strength > 0;
    globals[base] = ripple.x; globals[base + 1] = ripple.y;
    globals[base + 2] = active ? age * 0.18 : 0;
    globals[base + 3] = active ? fastExpNeg(age * 1.05) * ripple.strength : 0;
  }
}

/**
 * One mapper per state slot. captureGestureSnapshot copies the tiny numeric program, so a drag keeps one mapping while the slot is reused.
 * @param {Float32Array} state
 * @returns {InputMapper}
 */
function makeMapper(state) {
  /** @type {InputMapper} */
  const mapper = (point) => mapWaterPoint(state, point);
  mapper.captureGestureSnapshot = () => {
    const frozen = new Float32Array(state);
    return (point) => mapWaterPoint(frozen, point);
  };
  return mapper;
}

/**
 * Ripples from the pointer: a drop where it goes down, a faster pointer makes a stronger ripple.
 * @param {EffectPluginContext} context
 * @param {(x: number, y: number, strength: number) => void} drop
 * @param {boolean} reducedMotion
 */
function listenPointer(context, drop, reducedMotion) {
  const canvas = context.canvas;
  const win = /** @type {any} */ (canvas.ownerDocument.defaultView);
  let last = { x: 0.5, y: 0.5, t: performance.now() };
  let lastDrop = 0;
  /** @param {PointerEvent} e */
  const unit = (e) => {
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    return { x: (e.clientX - r.left - canvas.clientLeft) / w, y: (e.clientY - r.top - canvas.clientTop) / h, w, h };
  };
  context.listen('pointermove', (event) => {
    if (reducedMotion || !(event instanceof win.PointerEvent)) return;
    const now = performance.now();
    const { x, y, w, h } = unit(/** @type {PointerEvent} */ (event));
    const dt = Math.max(8, now - last.t);
    const dx = x - last.x;
    const dy = y - last.y;
    const speed = Math.hypot(dx * w, dy * h) / dt;
    if (now - lastDrop > 24 && Math.abs(dx) + Math.abs(dy) > 0.002) {
      drop(x, y, Math.min(1.55, 0.34 + speed * 0.48));
      lastDrop = now;
    }
    last = { x, y, t: now };
  });
  context.listen('pointerdown', (event) => {
    if (!(event instanceof win.PointerEvent)) return;
    const { x, y } = unit(/** @type {PointerEvent} */ (event));
    drop(x, y, 1.4);
  });
}

/** @param {Document} doc */
function injectUiStyle(doc) {
  if (doc.querySelector('style[data-hic-effect-style="water"]')) return;
  const style = doc.createElement('style');
  style.dataset.hicEffectStyle = 'water';
  style.textContent = `
    .hic-water-control { display:grid; grid-template-columns:1fr auto; gap:6px 10px; align-items:center; padding-top:2px; color:rgba(224,247,255,.62); font-size:9px; font-weight:700; }
    .hic-water-control > span { grid-column:1; }
    .hic-water-control output { grid-column:2; color:#9cf5ff; text-align:right; font-variant-numeric:tabular-nums; }
    .hic-water-control input[type=range] { grid-column:1 / -1; width:100%; height:28px; margin:0; padding:3px 0; border:0; border-radius:0; background:transparent; box-shadow:none; accent-color:#79efff; cursor:ew-resize; }
  `;
  (doc.head || doc.documentElement).append(style);
}

/**
 * The plugin-owned intensity slider.
 * @param {Element} root
 * @param {{ getOptions: () => Readonly<Record<string, unknown>>, setOptions: (patch: Record<string, unknown>) => void }} ui
 * @param {(range: HTMLInputElement|null, output: HTMLOutputElement|null) => void} bind  hands the live controls to the plugin (null on dispose)
 */
function mountIntensityUi(root, ui, bind) {
  const doc = root.ownerDocument;
  injectUiStyle(doc);
  const id = `hic-water-intensity-${++uiSerial}`;
  const label = doc.createElement('label');
  label.className = 'hic-water-control';
  label.htmlFor = id;
  label.innerHTML = `<span>Water plugin · intensity</span><input id="${id}" type="range" min="0" max="100" step="1"><output for="${id}"></output>`;
  const range = /** @type {HTMLInputElement} */ (label.querySelector('input'));
  const output = /** @type {HTMLOutputElement} */ (label.querySelector('output'));
  const percent = Math.round(clamp01(ui.getOptions().intensity) * 100);
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

/**
 * @param {any} device
 * @param {string} code
 * @param {string} format
 */
function createPipeline(device, code, format) {
  const module = device.createShaderModule({ code, label: 'hic-water-effect-shader' });
  return device.createRenderPipeline({
    label: 'hic-water-effect-pipeline', layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
}

/** @type {EffectPluginDefinition} */
export const plugin = Object.freeze({
  type: 'water',
  apiVersion: 2,
  version: 2,
  // The pass only writes its destination as a same-format colour attachment; it never samples or reads it back.
  outputCapabilities: Object.freeze({ directCanvasRenderAttachment: /** @type {const} */ (true) }),
  async create(context, initialOptions) {
    const shader = initialOptions?.shader;
    const code = typeof shader === 'string' && shader !== '' ? shader : await wgsl('water.wgsl');
    const { device, format } = context;
    const pipeline = createPipeline(device, code, format);
    const usage = /** @type {any} */ (globalThis).GPUBufferUsage;
    const uniformBuffer = device.createBuffer({ label: 'hic-water-effect-globals', size: GLOBALS_LENGTH * 4, usage: usage.UNIFORM | usage.COPY_DST });
    const sampler = device.createSampler({ label: 'hic-water-effect-sampler', magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const bindGroups = new WeakMap();
    const globals = new Float32Array(GLOBALS_LENGTH);
    const mapperStates = Array.from({ length: MAPPER_SLOTS }, () => new Float32Array(GLOBALS_LENGTH));
    const mappers = mapperStates.map(makeMapper);
    let mapperSlot = 0;
    const start = performance.now();
    const win = /** @type {any} */ (context.canvas.ownerDocument.defaultView);
    const reducedMotion = !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    /** @type {Ripple[]} */
    const ripples = Array.from({ length: RIPPLE_COUNT }, () => ({ x: 0.5, y: 0.5, time: -100, strength: 0 }));
    let rippleIndex = 0;
    let intensity = clamp01(initialOptions?.intensity ?? DEFAULT_INTENSITY);
    /** @type {HTMLInputElement|null} */ let uiRange = null;
    /** @type {HTMLOutputElement|null} */ let uiOutput = null;

    const elapsed = (/** @type {number} */ now = performance.now()) => (now - start) / 1000;
    /** @param {number} x @param {number} y @param {number} strength @param {number} [delay] */
    function addRipple(x, y, strength, delay = 0) {
      ripples[rippleIndex++ % RIPPLE_COUNT] = {
        x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)),
        time: elapsed() + delay, strength: Math.min(2, Math.max(0.08, strength)),
      };
      context.requestRender();
    }
    listenPointer(context, addRipple, reducedMotion);
    addRipple(0.68, 0.34, 0.75);
    addRipple(0.24, 0.76, 0.5, 0.28);

    function syncUi() {
      const percent = Math.round(intensity * 100);
      if (uiRange && uiRange.value !== String(percent)) uiRange.value = String(percent);
      if (uiOutput && uiOutput.textContent !== `${percent}%`) uiOutput.textContent = `${percent}%`;
    }

    return {
      spatial: true,
      continuous: true,
      setOptions(next) {
        intensity = clamp01(next?.intensity ?? intensity);
        syncUi();
      },
      render(frame) {
        fillGlobals(globals, frame, ripples, elapsed(frame.now), intensity);
        device.queue.writeBuffer(uniformBuffer, 0, globals);
        let bindGroup = bindGroups.get(frame.sourceView);
        if (!bindGroup) {
          bindGroup = device.createBindGroup({
            label: 'hic-water-effect-bind-group', layout: pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: uniformBuffer } }, { binding: 1, resource: sampler }, { binding: 2, resource: frame.sourceView }],
          });
          bindGroups.set(frame.sourceView, bindGroup);
        }
        const timestampWrites = frame.profiling?.timestampWrites('water');
        const pass = frame.encoder.beginRenderPass({
          colorAttachments: [{ view: frame.destinationView, loadOp: 'clear', storeOp: 'store', clearValue: CLEAR }],
          ...(timestampWrites ? { timestampWrites } : {}),
        });
        pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.draw(3); pass.end();
      },
      captureInputMapper() {
        mapperSlot = (mapperSlot + 1) % MAPPER_SLOTS;
        mapperStates[mapperSlot].set(globals);
        return mappers[mapperSlot];
      },
      mountUI(root, ui) {
        return mountIntensityUi(root, ui, (range, output) => {
          uiRange = range;
          uiOutput = output;
          syncUi();
        });
      },
      destroy() { uniformBuffer.destroy?.(); },
    };
  },
});
