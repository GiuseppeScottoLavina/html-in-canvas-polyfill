/**
 * CRT monitor effect plugin (effect plugin ABI v2): an EXAMPLE of the effects extension of html-in-canvas-polyfill, not part of the polyfill.
 * Shader: ./crt.wgsl.
 *
 * The drawn HTML is shown on a curved CRT screen: barrel curvature inside a bezel, scanlines that follow the glass, an aperture-grille
 * mask, phosphor glow, slight red/blue misconvergence, vignette, and (unless the user prefers reduced motion) a gentle flicker, a
 * rolling bar and faint static. The input mapper (`mapCrtPoint`) is the JavaScript twin of the barrel formula and of the screen mask in
 * crt.wgsl, so a click on the curved picture reaches the element the user sees there, and a click on the bezel reaches nothing.
 */

import { NO_TARGET } from '../../src/effects/no-target.js';
import { wgsl } from './wgsl.js';

/** @typedef {import('../../src/contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../../src/contracts/types.js').InputMapper} InputMapper */
/** @typedef {import('../../src/contracts/types.js').InputPoint} InputPoint */

/** What the plugin gallery and the build read (plugins/README.md). */
export const meta = Object.freeze({
  name: 'crt',
  title: 'CRT monitor',
  description: 'A curved CRT screen with scanlines, phosphor glow and flicker; clicks are mapped through the barrel distortion.',
  defaults: Object.freeze({ curvature: 0.5, scanlines: 0.6, glow: 0.55, flicker: 0.5 }),
  reducedMotion: 'With reduced motion the flicker, the rolling bar and the static stop; the curved screen stays.',
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
    .hic-crt-ui output { color:#b6ffbf; font-variant-numeric:tabular-nums; }
    .hic-crt-ui input[type=range] { grid-column:1 / -1; width:100%; height:22px; margin:0; accent-color:#8dffa0; cursor:ew-resize; }
  `;
  (doc.head || doc.documentElement).append(style);
}

const SLIDERS = /** @type {const} */ ([['curvature', 'Curvature'], ['scanlines', 'Scanlines'], ['glow', 'Glow'], ['flicker', 'Flicker']]);

/** @type {EffectPluginDefinition} */
export const plugin = Object.freeze({
  type: 'crt',
  apiVersion: /** @type {const} */ (2),
  version: 1,
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

    const o = { curvature: 0.5, scanlines: 0.6, glow: 0.55, flicker: 0.5, misconvergence: 0.5 };
    /** @param {Record<string, unknown>} next */
    function readOptions(next) {
      o.curvature = unit(next.curvature, o.curvature);
      o.scanlines = unit(next.scanlines, o.scanlines);
      o.glow = unit(next.glow, o.glow);
      o.flicker = unit(next.flicker, o.flicker);
      o.misconvergence = unit(next.misconvergence, o.misconvergence);
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
      u[8] = o.scanlines; u[9] = o.glow; u[10] = animated() ? o.flicker : 0; u[11] = o.misconvergence * MAX_MIS;
      u[12] = ((frame.now - start) / 1000) % 600; u[13] = 0; u[14] = 0; u[15] = 0;
      device.queue.writeBuffer(uniforms, 0, u);
      let bindGroup = bindGroups.get(frame.sourceView);
      if (!bindGroup) {
        bindGroup = device.createBindGroup({
          label: 'crt', layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: uniforms } }, { binding: 1, resource: sampler }, { binding: 2, resource: frame.sourceView }],
        });
        bindGroups.set(frame.sourceView, bindGroup);
      }
      attachment.view = frame.destinationView;
      passDescriptor.timestampWrites = frame.profiling?.timestampWrites?.('crt');
      const pass = frame.encoder.beginRenderPass(passDescriptor);
      pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.draw(3); pass.end();
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
      for (const [key, text] of SLIDERS) {
        const label = doc.createElement('label');
        label.innerHTML = `<span>${text}</span><output></output><input type="range" id="${id}-${key}" min="0" max="100" step="1">`;
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
