/**
 * Holographic card effect plugin (effect plugin ABI v2): an EXAMPLE of the effects extension of html-in-canvas-polyfill, not part of the polyfill.
 * Shader: ./holo-card.wgsl.
 *
 * The drawn HTML becomes a collectible card that tilts towards the pointer in perspective (on a spring), with an iridescent foil that
 * shifts with the viewing angle, sparkles and a star field at other depths (parallax), and a specular glare that follows the pointer.
 * The input mapper (`mapCardPoint`) is the JavaScript twin of the projection in holo-card.wgsl: it intersects the ray through the
 * presented point with the tilted card plane of the presented frame, so a click on the tilted picture reaches the element the user sees.
 */

import { NO_TARGET } from '../../src/effects/no-target.js';
import { wgsl } from './wgsl.js';
import { stateMapper } from '../_lib/mapper.js';
import { clampTo } from '../_lib/number.js';
import { fullscreenPass } from '../_lib/gpu.js';
import { springSubsteps } from '../_lib/spring.js';
import { injectStyle } from '../_lib/ui.js';

/** @typedef {import('../../src/contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../../src/contracts/types.js').InputMapper} InputMapper */
/** @typedef {import('../../src/contracts/types.js').InputPoint} InputPoint */

/** What the plugin gallery and the build read (plugins/README.md). */
export const meta = Object.freeze({
  name: 'holo-card',
  title: 'Holo card',
  description: 'The form becomes a holographic card that tilts towards the pointer; clicks are mapped through the 3D perspective.',
  defaults: Object.freeze({ tilt: 14, foil: 0.6, glare: 0.6, idle: true }),
  reducedMotion: 'With reduced motion the card stays flat (no tilt, no sway, no shimmer); the glare still follows the pointer.',
});

/** floats in the uniform block (holo-card.wgsl, struct U) */
export const UNIFORM_FLOATS = 24;
/** what the mapper returns for a point beside the card: the NO_TARGET of the effects ABI, so the host swallows a press there */
export { NO_TARGET };
const MAPPER_SLOTS = 4;
const MAX_TILT = 30;
const STIFFNESS = 180;
const DAMPING = 2 * 0.62 * Math.sqrt(STIFFNESS);

let uiSerial = 0;

/**
 * Write the card pose into the uniform block: basis of the card rotated by rx about x then ry about y (radians), camera distance,
 * scale and corner radius for a canvas of css size w x h. [4..6] x axis, [7] distance, [8..10] y axis, [11] scale, [12..14] normal, [15] radius.
 * @param {Float32Array} u @param {number} rx @param {number} ry @param {number} scale @param {number} w @param {number} h
 */
export function writeCardPose(u, rx, ry, scale, w, h) {
  const ca = Math.cos(rx), sa = Math.sin(rx), cb = Math.cos(ry), sb = Math.sin(ry);
  u[4] = cb; u[5] = 0; u[6] = -sb; u[7] = 2 * Math.max(w, h);
  u[8] = sb * sa; u[9] = ca; u[10] = cb * sa; u[11] = scale;
  u[12] = sb * ca; u[13] = -sa; u[14] = cb * ca; u[15] = 0.045 * Math.min(w, h);
}

/**
 * Source point shown at the presented point `point` for the uniform block `s`, or NO_TARGET beside the card. PURE; the twin of fs() in
 * holo-card.wgsl: the eye is D css px in front of the canvas centre, the card plane passes through the centre with normal n, and the
 * intersection, expressed in the card's own axes and divided by the card scale, is the source point.
 * @param {ArrayLike<number>} s  [2,3] css size, [4..15] the pose written by writeCardPose
 * @param {InputPoint} point
 * @returns {{x: number, y: number}}
 */
export function mapCardPoint(s, point) {
  const cx = s[2] / 2;
  const cy = s[3] / 2;
  const D = s[7];
  const dx = point.x - cx;
  const dy = point.y - cy;
  const t = (D * s[14]) / (dx * s[12] + dy * s[13] + D * s[14]);
  const lx = t * dx;
  const ly = t * dy;
  const lz = -D + t * D;
  const x = cx + (lx * s[4] + ly * s[5] + lz * s[6]) / s[11];
  const y = cy + (lx * s[8] + ly * s[9] + lz * s[10]) / s[11];
  const r = s[15];
  const ax = Math.abs(x - cx) - cx + r;
  const ay = Math.abs(y - cy) - cy + r;
  const sd = Math.min(Math.max(ax, ay), 0) + Math.hypot(Math.max(ax, 0), Math.max(ay, 0)) - r;
  return sd < 0 && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : NO_TARGET;
}


/** CSS of the plugin UI (mountUI) */
const UI_CSS = `
    .hic-holo-ui { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)) auto; gap:4px 12px; align-items:end; }
    .hic-holo-ui label { display:grid; grid-template-columns:1fr auto; gap:2px 6px; min-width:0; font-size:10px; font-weight:700; }
    .hic-holo-ui output { color:#ffc8f4; font-variant-numeric:tabular-nums; }
    .hic-holo-ui input[type=range] { grid-column:1 / -1; width:100%; height:22px; margin:0; accent-color:#e7a6ff; cursor:ew-resize; }
    .hic-holo-ui label.idle { display:flex; align-items:center; gap:6px; padding-bottom:4px; white-space:nowrap; }
    .hic-holo-ui label.idle input { width:15px; height:15px; margin:0; accent-color:#e7a6ff; }
  `;

const SLIDERS = /** @type {const} */ ([
  ['tilt', 'Tilt', 0, MAX_TILT, 1, (/** @type {number} */ v) => `${Math.round(v)}°`, 1],
  ['foil', 'Foil', 0, 100, 1, (/** @type {number} */ v) => `${Math.round(v * 100)}%`, 100],
  ['glare', 'Glare', 0, 100, 1, (/** @type {number} */ v) => `${Math.round(v * 100)}%`, 100],
]);

/** @type {EffectPluginDefinition} */
export const plugin = Object.freeze({
  type: 'holo-card',
  apiVersion: /** @type {const} */ (2),
  version: 1,
  // the pass only writes its destination as a same-format colour attachment (it never samples or reads it)
  outputCapabilities: Object.freeze({ directCanvasRenderAttachment: /** @type {const} */ (true) }),
  async create(context, options) {
    const { device, format } = context;
    const module = device.createShaderModule({ code: await wgsl('holo-card.wgsl'), label: 'holo-card' });
    const gpu = fullscreenPass(device, format, module, 'holo-card', UNIFORM_FLOATS);
    const u = new Float32Array(UNIFORM_FLOATS);
    const states = Array.from({ length: MAPPER_SLOTS }, () => new Float32Array(UNIFORM_FLOATS));
    const mappers = states.map((s) => stateMapper(s, mapCardPoint));
    let slot = 0;
    const canvas = context.canvas;
    const win = /** @type {any} */ (canvas?.ownerDocument?.defaultView ?? globalThis);
    const reducedMotion = !!win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const start = performance.now();

    const o = { tilt: 14, foil: 0.6, glare: 0.6, idle: true, scale: 0.86 };
    /** @param {Record<string, unknown>} next */
    function readOptions(next) {
      o.tilt = clampTo(next.tilt, [0, MAX_TILT], o.tilt);
      o.foil = clampTo(next.foil, [0, 1], o.foil);
      o.glare = clampTo(next.glare, [0, 1], o.glare);
      o.scale = clampTo(next.scale, [0.5, 1], o.scale);
      o.idle = next.idle === undefined ? o.idle : !!next.idle;
    }
    readOptions({ ...meta.defaults, ...(options ?? {}) });

    // the pointer, -1..1 from the canvas centre; `hover` while it is over the canvas. The pose springs towards it.
    const pose = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, hover: false, started: false };
    /** @type {Array<(o: any) => void>} */
    const uiSyncs = [];

    const instance = {
      spatial: true,
      /** true while the card moves (spring, idle sway); the host then renders every capped frame */
      continuous: false,
      setOptions,
      render,
      captureInputMapper,
      mountUI,
      destroy() { gpu.uniforms.destroy?.(); },
    };
    const swaying = () => o.idle && !pose.hover && !reducedMotion;
    instance.continuous = swaying();

    function wake() {
      instance.continuous = true;
      context.requestRender?.();
    }

    /** @param {Record<string, unknown>} next */
    function setOptions(next) {
      readOptions(next ?? {});
      for (const sync of uiSyncs) sync(o);
      wake();
    }

    /** @param {any} event @returns {{x: number, y: number}|null} */
    function unitPoint(event) {
      if (!canvas?.getBoundingClientRect) return null;
      const r = canvas.getBoundingClientRect();
      const w = Math.max(1, canvas.clientWidth);
      const h = Math.max(1, canvas.clientHeight);
      return { x: ((event.clientX - r.left - canvas.clientLeft) / w) * 2 - 1, y: ((event.clientY - r.top - canvas.clientTop) / h) * 2 - 1 };
    }
    context.listen?.('pointermove', (event) => {
      const p = unitPoint(event);
      if (!p) return;
      pose.hover = true;
      pose.tx = Math.min(1, Math.max(-1, p.x));
      pose.ty = Math.min(1, Math.max(-1, p.y));
      wake();
    });
    context.listen?.('pointerleave', (event) => {
      const p = unitPoint(event);
      if (p && Math.abs(p.x) < 0.996 && Math.abs(p.y) < 0.996) return;   // moving between the canvas and its live layer
      pose.hover = false;
      pose.tx = 0;
      pose.ty = 0;
      wake();
    });

    /** @param {number} dt seconds @param {number} time seconds */
    function step(dt, time) {
      if (swaying()) { pose.tx = 0.62 * Math.sin(time * 0.61); pose.ty = 0.5 * Math.sin(time * 0.83 + 1.1); }
      // the first frame starts at the target (no swing in from flat)
      if (reducedMotion || !pose.started) {
        pose.started = true;
        pose.x = pose.tx; pose.y = pose.ty; pose.vx = 0; pose.vy = 0;
        return;
      }
      springSubsteps(pose, dt, STIFFNESS, DAMPING);
      if (Math.abs(pose.tx - pose.x) + Math.abs(pose.ty - pose.y) < 1e-4 && Math.abs(pose.vx) + Math.abs(pose.vy) < 1e-3) {
        pose.x = pose.tx; pose.y = pose.ty; pose.vx = 0; pose.vy = 0;
      }
    }

    /** @param {any} frame */
    function render(frame) {
      const time = (frame.now - start) / 1000;
      step(Math.min(0.1, Math.max(0, (frame.delta || 0) / 1000)), time);
      instance.continuous = swaying() || pose.x !== pose.tx || pose.y !== pose.ty || pose.vx !== 0 || pose.vy !== 0;
      // with reduced motion the card stays flat (no tilt); the glare still follows the pointer
      const tilt = reducedMotion ? 0 : (o.tilt * Math.PI) / 180;
      u[0] = frame.width; u[1] = frame.height; u[2] = frame.cssWidth; u[3] = frame.cssHeight;
      // tilt towards the pointer: the side under the pointer comes towards the viewer
      writeCardPose(u, -tilt * pose.y, tilt * pose.x, o.scale, frame.cssWidth, frame.cssHeight);
      u[16] = o.foil; u[17] = o.glare; u[18] = 0.5 + 0.5 * pose.x; u[19] = 0.5 + 0.5 * pose.y;
      u[20] = reducedMotion ? 0 : time % 600; u[21] = frame.sourceReady ? 1 : 0;
      u[22] = reducedMotion ? 0 : pose.x * (o.tilt / 14); u[23] = reducedMotion ? 0 : pose.y * (o.tilt / 14);
      gpu.draw(frame, u);
    }

    function captureInputMapper() {
      slot = (slot + 1) % MAPPER_SLOTS;
      states[slot].set(u);
      return mappers[slot];
    }

    /** @param {Element} root @param {{setOptions: (patch: Record<string, unknown>) => void}} ui */
    function mountUI(root, ui) {
      const doc = root.ownerDocument;
      injectStyle(doc, 'holo-card', UI_CSS);
      const box = doc.createElement('div');
      box.className = 'hic-holo-ui';
      const id = `hic-holo-${++uiSerial}`;
      /** @type {Array<() => void>} */ const offs = [];
      /** @type {Array<(o: any) => void>} */ const mine = [];
      for (const [key, text, min, max, stepValue, fmt, scale] of SLIDERS) {
        const label = doc.createElement('label');
        label.innerHTML = `<span>${text}</span><output></output><input type="range" id="${id}-${key}" min="${min}" max="${max}" step="${stepValue}">`;
        const range = /** @type {HTMLInputElement} */ (label.querySelector('input'));
        const out = /** @type {HTMLOutputElement} */ (label.querySelector('output'));
        const sync = (/** @type {any} */ opts) => {
          const value = String(Math.round(opts[key] * scale));
          if (range.value !== value) range.value = value;
          const textValue = fmt(opts[key]);
          if (out.textContent !== textValue) out.textContent = textValue;
        };
        const onInput = () => ui.setOptions({ [key]: Number(range.value) / scale });
        range.addEventListener('input', onInput);
        offs.push(() => range.removeEventListener('input', onInput));
        mine.push(sync);
        sync(o);
        box.append(label);
      }
      const idle = doc.createElement('label');
      idle.className = 'idle';
      idle.innerHTML = `<input type="checkbox" id="${id}-idle"> Idle sway`;
      const check = /** @type {HTMLInputElement} */ (idle.querySelector('input'));
      const syncIdle = (/** @type {any} */ opts) => { if (check.checked !== opts.idle) check.checked = opts.idle; };
      const onIdle = () => ui.setOptions({ idle: check.checked });
      check.addEventListener('change', onIdle);
      offs.push(() => check.removeEventListener('change', onIdle));
      mine.push(syncIdle);
      syncIdle(o);
      box.append(idle);
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
