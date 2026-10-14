/**
 * CRT monitor effect plugin (effect plugin ABI v2): an EXAMPLE of the effects extension of html-in-canvas-polyfill, not part of the polyfill.
 * Shader: ./crt.wgsl.
 *
 * The drawn HTML is shown on a curved CRT screen with the look of an old bar arcade monitor (the default `arcade` preset): barrel
 * curvature inside a bezel, thick dark scanlines whose beams widen on bright content, a visible RGB slot mask, strong phosphor glow and
 * bloom, a slightly warm phosphor, slight red/blue misconvergence, a vignette, a reflection on the glass, and (unless the user prefers
 * reduced motion) a gentle flicker, a rolling bar and faint static. The input mapper (`mapCrtPoint`) is the JavaScript twin of the barrel
 * formula and of the screen mask in crt.wgsl, so a click on the curved picture reaches the element the user sees there, and a click on the
 * bezel reaches nothing.
 */

import { NO_TARGET } from '../../src/effects/no-target.js';
import { wgsl } from './wgsl.js';

/** @typedef {import('../../src/contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../../src/contracts/types.js').InputMapper} InputMapper */
/** @typedef {import('../../src/contracts/types.js').InputPoint} InputPoint */

/**
 * Named sets of options. `arcade` (the default, `meta.defaults`): an old bar arcade monitor. `monitor`: a sharper, cleaner computer monitor.
 * Options not in a preset keep their value when the preset is applied.
 */
export const presets = Object.freeze({
  arcade: Object.freeze({ curvature: 0.5, scanlines: 0.8, mask: 0.7, glow: 0.7, warmth: 0.6, flicker: 0.3, misconvergence: 0.4 }),
  monitor: Object.freeze({ curvature: 0.3, scanlines: 0.35, mask: 0.25, glow: 0.3, warmth: 0.1, flicker: 0, misconvergence: 0.15 }),
});

/** What the plugin gallery and the build read (plugins/README.md). */
export const meta = Object.freeze({
  name: 'crt',
  title: 'CRT monitor',
  description: 'An old arcade monitor: curved glass, thick scanlines, an RGB shadow mask, phosphor glow and bloom; clicks are mapped through the curvature.',
  defaults: presets.arcade,
  reducedMotion: 'With reduced motion the flicker, the rolling bar and the static stop; the curved screen, the scanlines, the mask and the glow stay.',
});

/** floats in the uniform block (crt.wgsl, struct U) */
export const UNIFORM_FLOATS = 16;
/** what the mapper returns for a point on the bezel: the NO_TARGET of the effects ABI, so the host swallows a press there */
export { NO_TARGET };
const MAPPER_SLOTS = 4;
/** barrel strength at curvature 1 */
const MAX_K = 0.5;
/** red / blue misconvergence at misconvergence 1, CSS px */
const MAX_MIS = 1.4;
/** the options, in the order of the controls */
const KEYS = /** @type {const} */ (['curvature', 'scanlines', 'mask', 'glow', 'warmth', 'flicker', 'misconvergence']);

let uiSerial = 0;

/** @param {unknown} v @param {number} fallback */
const unit = (v, fallback) => { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback; };

/** Bezel width (CSS px) for a canvas of css size w x h. @param {number} w @param {number} h */
export const bezelWidth = (w, h) => Math.max(6, 0.035 * Math.min(w, h));
/** Corner radius of the screen, in source CSS px. @param {number} w @param {number} h */
export const cornerRadius = (w, h) => 0.06 * Math.min(w, h);

/**
 * Source point shown at the presented point `point` for the uniform block `s`, or NO_TARGET on the bezel. PURE; the twin of fs() in
 * crt.wgsl. The screen is the canvas minus the bezel, with half size (sx, sy); d is the point relative to the centre and r2 = |d|^2 / |s|^2
 * (1 at the screen corner). The radial barrel q' = (d / s) (1 + k r2) / (1 + k s^2 / |s|^2) keeps the midpoint of every edge on the
 * edge of the source, and the bulged point spans the whole source. Green is the reference colour (misconvergence moves red and blue only).
 * @param {ArrayLike<number>} s  [2,3] css size, [4] k, [5] bezel, [6] corner radius
 * @param {InputPoint} point
 * @returns {{x: number, y: number}}
 */
export function mapCrtPoint(s, point) {
  const hx = s[2] / 2;
  const hy = s[3] / 2;
  const k = s[4];
  const sx = hx - s[5];
  const sy = hy - s[5];
  const dx = point.x - hx;
  const dy = point.y - hy;
  const s2 = sx * sx + sy * sy;
  const bulge = 1 + (k * (dx * dx + dy * dy)) / s2;
  const x = hx + ((dx / sx) * bulge / (1 + (k * sx * sx) / s2)) * hx;
  const y = hy + ((dy / sy) * bulge / (1 + (k * sy * sy) / s2)) * hy;
  const r = s[6];
  const ax = Math.abs(x - hx) - hx + r;
  const ay = Math.abs(y - hy) - hy + r;
  const sd = Math.min(Math.max(ax, ay), 0) + Math.hypot(Math.max(ax, 0), Math.max(ay, 0)) - r;
  return sd < 0 ? { x, y } : NO_TARGET;
}

/** @param {Float32Array} state @returns {InputMapper} */
function makeMapper(state) {
  /** @type {InputMapper} */
  const mapper = (point) => mapCrtPoint(state, point);
  mapper.captureGestureSnapshot = () => {
    const frozen = new Float32Array(state);
    return (point) => mapCrtPoint(frozen, point);
  };
  return mapper;
}

/** @param {Document} doc */
function injectUiStyle(doc) {
  if (doc.querySelector('style[data-hic-effect-style="crt"]')) return;
  const style = doc.createElement('style');
  style.dataset.hicEffectStyle = 'crt';
  style.textContent = `
    .hic-crt-ui { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:4px 12px; }
    .hic-crt-ui label { display:grid; grid-template-columns:1fr auto; gap:2px 6px; min-width:0; font-size:10px; font-weight:700; }
    .hic-crt-ui output { color:#ffcf7a; font-variant-numeric:tabular-nums; }
    .hic-crt-ui input[type=range] { grid-column:1 / -1; width:100%; height:22px; margin:0; accent-color:#ffb347; cursor:ew-resize; }
    .hic-crt-ui label.preset { grid-template-columns:auto; }
    .hic-crt-ui select { width:100%; height:22px; margin:0; padding:0 4px; font:inherit; font-weight:700; color:#ffcf7a; background:#14161c; border:1px solid #5a4a30; border-radius:4px; }
  `;
  (doc.head || doc.documentElement).append(style);
}

const LABELS = /** @type {Record<string, string>} */ ({ curvature: 'Curvature', scanlines: 'Scanlines', mask: 'Mask', glow: 'Glow', warmth: 'Warmth', flicker: 'Flicker', misconvergence: 'Convergence' });
/** the sliders of mountUI (misconvergence is an option without a slider) */
const SLIDERS = KEYS.filter((k) => k !== 'misconvergence');

/** The name of the preset whose values `o` has, or '' when the options were changed by hand. @param {Record<string, number>} o */
export function presetOf(o) {
  for (const [name, values] of Object.entries(presets)) if (Object.entries(values).every(([k, v]) => Math.abs((o[k] ?? NaN) - v) < 1e-6)) return name;
  return '';
}

/** @type {EffectPluginDefinition} */
export const plugin = Object.freeze({
  type: 'crt',
  apiVersion: /** @type {const} */ (2),
  version: 2,
  // the pass only writes its destination as a same-format colour attachment (it never samples or reads it)
  outputCapabilities: Object.freeze({ directCanvasRenderAttachment: /** @type {const} */ (true) }),
  async create(context, options) {
    const { device, format } = context;
    const module = device.createShaderModule({ code: await wgsl('crt.wgsl'), label: 'crt' });
    const pipeline = device.createRenderPipeline({
      layout: 'auto', label: 'crt',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    const usage = /** @type {any} */ (globalThis).GPUBufferUsage;
    const uniforms = device.createBuffer({ label: 'crt', size: UNIFORM_FLOATS * 4, usage: usage.UNIFORM | usage.COPY_DST });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const bindGroups = new WeakMap();
    const u = new Float32Array(UNIFORM_FLOATS);
    const states = Array.from({ length: MAPPER_SLOTS }, () => new Float32Array(UNIFORM_FLOATS));
    const mappers = states.map(makeMapper);
    let slot = 0;
    const attachment = { view: /** @type {any} */ (null), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } };
    const passDescriptor = { colorAttachments: [attachment], timestampWrites: /** @type {any} */ (undefined) };
    const win = /** @type {any} */ (context.canvas?.ownerDocument?.defaultView ?? globalThis);
    const reducedMotion = !!win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const start = performance.now();

    /** @type {Record<string, number>} */
    const o = { ...meta.defaults };
    /** @param {Record<string, unknown>} next */
    function readOptions(next) {
      const preset = typeof next.preset === 'string' ? /** @type {Record<string, number>|undefined} */ (/** @type {any} */ (presets)[next.preset]) : undefined;
      for (const key of KEYS) o[key] = unit(next[key] !== undefined ? next[key] : preset?.[key], o[key]);
    }
    readOptions({ ...meta.defaults, ...(options ?? {}) });
    /** @type {Array<(o: any) => void>} */
    const uiSyncs = [];

    const instance = {
      spatial: true,
      /** animated (flicker, rolling bar, static) only while flicker > 0 and the user does not prefer reduced motion */
      continuous: false,
      setOptions,
      render,
      captureInputMapper,
      mountUI,
      destroy() { uniforms.destroy?.(); },
    };
    const animated = () => !reducedMotion && o.flicker > 0;
    instance.continuous = animated();

    /** @param {Record<string, unknown>} next */
    function setOptions(next) {
      readOptions(next ?? {});
      instance.continuous = animated();
      for (const sync of uiSyncs) sync(o);
      context.requestRender?.();
    }

    /** @param {any} frame */
    function render(frame) {
      u[0] = frame.width; u[1] = frame.height; u[2] = frame.cssWidth; u[3] = frame.cssHeight;
      u[4] = o.curvature * MAX_K; u[5] = bezelWidth(frame.cssWidth, frame.cssHeight); u[6] = cornerRadius(frame.cssWidth, frame.cssHeight); u[7] = frame.sourceReady ? 1 : 0;
      u[8] = o.scanlines; u[9] = o.glow; u[10] = !reducedMotion && o.flicker > 0 ? o.flicker : 0; u[11] = o.misconvergence * MAX_MIS;
      u[12] = ((frame.now - start) / 1000) % 600; u[13] = o.mask; u[14] = o.warmth; u[15] = 0;
      device.queue.writeBuffer(uniforms, 0, u);
      let group = bindGroups.get(frame.sourceView);
      if (!group) {
        group = device.createBindGroup({
          label: 'crt', layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: uniforms } }, { binding: 1, resource: sampler }, { binding: 2, resource: frame.sourceView }],
        });
        bindGroups.set(frame.sourceView, group);
      }
      attachment.view = frame.destinationView;
      passDescriptor.timestampWrites = frame.profiling?.timestampWrites?.('crt');
      const pass = frame.encoder.beginRenderPass(passDescriptor);
      pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.draw(3); pass.end();
      attachment.view = null;
    }

    function captureInputMapper() {
      slot = (slot + 1) % MAPPER_SLOTS;
      states[slot].set(u);
      return mappers[slot];
    }

    /** @param {Element} root @param {{setOptions: (patch: Record<string, unknown>) => void}} ui */
    function mountUI(root, ui) {
      const doc = root.ownerDocument;
      injectUiStyle(doc);
      const box = doc.createElement('div');
      box.className = 'hic-crt-ui';
      const id = `hic-crt-${++uiSerial}`;
      /** @type {Array<() => void>} */ const offs = [];
      /** @type {Array<(o: any) => void>} */ const mine = [];
      // the preset picker: Arcade (the default) or Monitor; "Custom" while the sliders differ from both
      const presetLabel = doc.createElement('label');
      presetLabel.className = 'preset';
      presetLabel.innerHTML = `<span>Preset</span><select id="${id}-preset"><option value="arcade">Arcade</option><option value="monitor">Monitor</option><option value="" disabled>Custom</option></select>`;
      const select = /** @type {HTMLSelectElement} */ (presetLabel.querySelector('select'));
      const syncPreset = (/** @type {any} */ opts) => { const name = presetOf(opts); if (select.value !== name) select.value = name; };
      const onPreset = () => { const values = /** @type {any} */ (presets)[select.value]; if (values) ui.setOptions({ ...values }); };
      select.addEventListener('change', onPreset);
      offs.push(() => select.removeEventListener('change', onPreset));
      mine.push(syncPreset);
      syncPreset(o);
      box.append(presetLabel);
      for (const key of SLIDERS) {
        const label = doc.createElement('label');
        label.innerHTML = `<span>${LABELS[key]}</span><output></output><input type="range" id="${id}-${key}" min="0" max="100" step="1">`;
        const range = /** @type {HTMLInputElement} */ (label.querySelector('input'));
        const out = /** @type {HTMLOutputElement} */ (label.querySelector('output'));
        const sync = (/** @type {any} */ opts) => {
          const value = String(Math.round(opts[key] * 100));
          if (range.value !== value) range.value = value;
          if (out.textContent !== `${value}%`) out.textContent = `${value}%`;
        };
        const onInput = () => ui.setOptions({ [key]: Number(range.value) / 100 });
        range.addEventListener('input', onInput);
        offs.push(() => range.removeEventListener('input', onInput));
        mine.push(sync);
        sync(o);
        box.append(label);
      }
      uiSyncs.push(...mine);
      root.append(box);
      return () => {
        for (const off of offs) off();
        for (const s of mine) { const i = uiSyncs.indexOf(s); if (i >= 0) uiSyncs.splice(i, 1); }
        box.remove();
      };
    }

    return instance;
  },
});
