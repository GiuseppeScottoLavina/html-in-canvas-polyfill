/**
 * Liquid glass effect plugin (effect plugin ABI v2): an EXAMPLE of the effects extension of html-in-canvas-polyfill, not part of the polyfill.
 * Shader: ./liquid-glass.wgsl.
 *
 * A refractive glass lens follows the pointer on a spring (or stays pinned): a flat magnifying centre, a curved rim that bends the
 * picture from outside the lens inward, a little chromatic dispersion on the rim, a specular highlight and a soft shadow.
 * The input mapper (`mapLensPoint`) is the JavaScript twin of the sampling in liquid-glass.wgsl and evaluates the uniform block that was
 * submitted for the presented frame, so a click through the lens reaches the element the user sees there.
 */

import { wgsl } from './wgsl.js';

/** @typedef {import('../../src/contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../../src/contracts/types.js').EffectPluginContext} EffectPluginContext */
/** @typedef {import('../../src/contracts/types.js').InputMapper} InputMapper */
/** @typedef {import('../../src/contracts/types.js').InputPoint} InputPoint */

/** What the plugin gallery and the build read (plugins/README.md). */
export const meta = Object.freeze({
  name: 'liquid-glass',
  title: 'Liquid glass',
  description: 'A refractive glass lens follows the pointer (or stays pinned); clicks through the lens reach what it shows.',
  defaults: Object.freeze({ size: 150, refraction: 0.7, dispersion: 0.5, pinned: false, x: 0.73, y: 0.3 }),
  reducedMotion: 'With reduced motion the lens jumps to the pointer (no spring, no stretch), so nothing animates.',
});

/** floats in the uniform block (liquid-glass.wgsl, struct U) */
export const UNIFORM_FLOATS = 16;
/** the mapper chain keeps the last 3 presented frames, plus the one being written */
const MAPPER_SLOTS = 4;
/** @type {Readonly<Record<string, [number, number]>>} */
const LIMITS = Object.freeze({ size: [60, 280], refraction: [0, 1], dispersion: [0, 1], highlight: [0, 1], aspect: [1, 2.5] });
/** spring: stiffness (1/s^2) and damping ratio; integration substep */
const STIFFNESS = 260;
const DAMPING = 2 * 0.74 * Math.sqrt(STIFFNESS);
const SUBSTEP = 1 / 240;

let uiSerial = 0;

/** @param {unknown} v @param {[number, number]} range @param {number} fallback */
function clampTo(v, [lo, hi], fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/**
 * Signed distance from (dx, dy) to a rounded box of half size (hx, hy) and corner radius r (negative inside); same as sd_box().
 * @param {number} dx @param {number} dy @param {number} hx @param {number} hy @param {number} r
 */
export function sdBox(dx, dy, hx, hy, r) {
  const qx = Math.abs(dx) - hx + r;
  const qy = Math.abs(dy) - hy + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

/**
 * Source point shown at the presented point `point` for the uniform block `s` (lens geometry of one frame). PURE; the twin of the
 * shader: outside the lens the picture is not displaced; inside, the flat centre magnifies by s[11] and the rim adds an outward shift
 * that grows as (1 - t)^2 towards the edge. The green channel is the reference (dispersion only spreads red and blue around it).
 * @param {ArrayLike<number>} s  [2,3] css size, [4,5] centre, [6,7] half size, [8] radius, [9] bevel, [10] refraction, [11] magnification
 * @param {InputPoint} point
 * @returns {{x: number, y: number}}
 */
export function mapLensPoint(s, point) {
  const width = s[2];
  const height = s[3];
  const dx = point.x - s[4];
  const dy = point.y - s[5];
  const hx = s[6];
  const hy = s[7];
  const r = s[8];
  let x = point.x;
  let y = point.y;
  const sd = sdBox(dx, dy, hx, hy, r);
  if (sd < 0) {
    const sx = dx < 0 ? -1 : 1;
    const sy = dy < 0 ? -1 : 1;
    const qx = Math.abs(dx) - hx + r;
    const qy = Math.abs(dy) - hy + r;
    let nx = 0;
    let ny = 0;
    if (qx > 0 && qy > 0) { const l = Math.hypot(qx, qy); nx = (sx * qx) / l; ny = (sy * qy) / l; } else if (qx > qy) nx = sx; else ny = sy;
    const t = Math.min(1, Math.max(0, -sd / s[9]));
    const disp = s[10] * s[9] * 0.9 * (1 - t) * (1 - t);
    x = s[4] + dx / s[11] + nx * disp;
    y = s[5] + dy / s[11] + ny * disp;
  }
  return { x: Math.min(width, Math.max(0, x)), y: Math.min(height, Math.max(0, y)) };
}

/**
 * Lens geometry for a frame: half size stretched along the velocity (a moving lens is squashed like a drop), pill radius, rim width.
 * Writes [4..11] of `u`.
 * @param {Float32Array} u
 * @param {{cx: number, cy: number, vx: number, vy: number, size: number, aspect: number, refraction: number}} lens  css px and css px/s
 */
export function writeLensGeometry(u, lens) {
  const ex = Math.min(0.2, Math.abs(lens.vx) / 2600);
  const ey = Math.min(0.2, Math.abs(lens.vy) / 2600);
  const hx = (lens.size * lens.aspect * 0.5) * (1 + ex - 0.5 * ey);
  const hy = (lens.size * 0.5) * (1 + ey - 0.5 * ex);
  const radius = Math.min(hx, hy);
  u[4] = lens.cx; u[5] = lens.cy; u[6] = hx; u[7] = hy;
  u[8] = radius; u[9] = radius * 0.55; u[10] = lens.refraction; u[11] = 1 + 0.28 * lens.refraction;
}

/** @param {Float32Array} state @returns {InputMapper} */
function makeMapper(state) {
  /** @type {InputMapper} */
  const mapper = (point) => mapLensPoint(state, point);
  mapper.captureGestureSnapshot = () => {
    const frozen = new Float32Array(state);
    return (point) => mapLensPoint(frozen, point);
  };
  return mapper;
}

/** @param {Document} doc */
function injectUiStyle(doc) {
  if (doc.querySelector('style[data-hic-effect-style="liquid-glass"]')) return;
  const style = doc.createElement('style');
  style.dataset.hicEffectStyle = 'liquid-glass';
  style.textContent = `
    .hic-lg-ui { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)) auto; gap:4px 12px; align-items:end; }
    .hic-lg-ui label { display:grid; grid-template-columns:1fr auto; gap:2px 6px; min-width:0; font-size:10px; font-weight:700; }
    .hic-lg-ui output { color:#9cf5ff; font-variant-numeric:tabular-nums; }
    .hic-lg-ui input[type=range] { grid-column:1 / -1; width:100%; height:22px; margin:0; accent-color:#9fd8ff; cursor:ew-resize; }
    .hic-lg-ui label.pin { display:flex; align-items:center; gap:6px; padding-bottom:4px; white-space:nowrap; }
    .hic-lg-ui label.pin input { width:15px; height:15px; margin:0; accent-color:#9fd8ff; }
  `;
  (doc.head || doc.documentElement).append(style);
}

const SLIDERS = /** @type {const} */ ([
  ['size', 'Lens size', 60, 280, 2, (/** @type {number} */ v) => `${Math.round(v)} px`, 1],
  ['refraction', 'Refraction', 0, 100, 1, (/** @type {number} */ v) => `${Math.round(v * 100)}%`, 100],
  ['dispersion', 'Dispersion', 0, 100, 1, (/** @type {number} */ v) => `${Math.round(v * 100)}%`, 100],
]);

/** @type {EffectPluginDefinition} */
export const plugin = Object.freeze({
  type: 'liquid-glass',
  apiVersion: /** @type {const} */ (2),
  version: 1,
  // the pass only writes its destination as a same-format colour attachment (it never samples or reads it)
  outputCapabilities: Object.freeze({ directCanvasRenderAttachment: /** @type {const} */ (true) }),
  async create(context, options) {
    const { device, format } = context;
    const module = device.createShaderModule({ code: await wgsl('liquid-glass.wgsl'), label: 'liquid-glass' });
    const pipeline = device.createRenderPipeline({
      layout: 'auto', label: 'liquid-glass',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    const usage = /** @type {any} */ (globalThis).GPUBufferUsage;
    const uniforms = device.createBuffer({ label: 'liquid-glass', size: UNIFORM_FLOATS * 4, usage: usage.UNIFORM | usage.COPY_DST });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const bindGroups = new WeakMap();
    const u = new Float32Array(UNIFORM_FLOATS);
    const states = Array.from({ length: MAPPER_SLOTS }, () => new Float32Array(UNIFORM_FLOATS));
    const mappers = states.map(makeMapper);
    let slot = 0;
    // render pass descriptor reused every frame (no allocation on the 120 Hz path)
    const attachment = { view: /** @type {any} */ (null), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } };
    const passDescriptor = { colorAttachments: [attachment], timestampWrites: /** @type {any} */ (undefined) };

    const canvas = context.canvas;
    const win = /** @type {any} */ (canvas?.ownerDocument?.defaultView ?? globalThis);
    const reducedMotion = !!win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

    const o = { size: 150, refraction: 0.7, dispersion: 0.5, highlight: 1, aspect: 1.45, pinned: false, x: 0.73, y: 0.3 };
    /** @param {Record<string, unknown>} next */
    function readOptions(next) {
      o.size = clampTo(next.size, LIMITS.size, o.size);
      o.refraction = clampTo(next.refraction, LIMITS.refraction, o.refraction);
      o.dispersion = clampTo(next.dispersion, LIMITS.dispersion, o.dispersion);
      o.highlight = clampTo(next.highlight, LIMITS.highlight, o.highlight);
      o.aspect = clampTo(next.aspect, LIMITS.aspect, o.aspect);
      o.x = clampTo(next.x, [0, 1], o.x);
      o.y = clampTo(next.y, [0, 1], o.y);
      o.pinned = next.pinned === undefined ? o.pinned : !!next.pinned;
    }
    readOptions({ ...meta.defaults, ...(options ?? {}) });

    // the lens: position and target as fractions of the canvas, velocity in fractions per second; it starts at rest at (x, y)
    const lens = { px: o.x, py: o.y, vx: 0, vy: 0, tx: o.x, ty: o.y, w: 1, h: 1 };
    const geometry = { cx: 0, cy: 0, vx: 0, vy: 0, size: 0, aspect: 0, refraction: 0 };
    /** @type {Array<(o: any) => void>} */
    const uiSyncs = [];

    const instance = {
      spatial: true,
      /** true while the lens is moving; the host then renders every capped frame, and stops when it comes to rest */
      continuous: false,
      setOptions,
      render,
      captureInputMapper,
      mountUI,
      destroy() { uniforms.destroy?.(); },
    };

    function wake() {
      instance.continuous = true;
      context.requestRender?.();
    }

    /** @param {Record<string, unknown>} next */
    function setOptions(next) {
      const wasPinned = o.pinned;
      const { x, y } = o;
      readOptions(next ?? {});
      if (o.pinned && (!wasPinned || x !== o.x || y !== o.y)) { lens.tx = o.x; lens.ty = o.y; }
      for (const sync of uiSyncs) sync(o);
      wake();
    }

    /** @param {any} event @returns {{x: number, y: number}|null} pointer as a fraction of the canvas content box */
    function unit(event) {
      if (!canvas?.getBoundingClientRect) return null;
      const r = canvas.getBoundingClientRect();
      const w = Math.max(1, canvas.clientWidth);
      const h = Math.max(1, canvas.clientHeight);
      return { x: (event.clientX - r.left - canvas.clientLeft) / w, y: (event.clientY - r.top - canvas.clientTop) / h };
    }
    context.listen?.('pointermove', (event) => {
      if (o.pinned) return;
      const p = unit(event);
      if (!p) return;
      lens.tx = Math.min(1, Math.max(0, p.x));
      lens.ty = Math.min(1, Math.max(0, p.y));
      wake();
    });
    // leaving the canvas (not just moving between the canvas and its live layer) sends the lens back to its home (x, y)
    context.listen?.('pointerleave', (event) => {
      if (o.pinned) return;
      const p = unit(event);
      if (p && p.x > 0.002 && p.x < 0.998 && p.y > 0.002 && p.y < 0.998) return;
      lens.tx = o.x;
      lens.ty = o.y;
      wake();
    });

    /** Advance the spring by dt seconds (substeps keep it stable at a 15 fps cap). @param {number} dt */
    function step(dt) {
      if (reducedMotion) { lens.px = lens.tx; lens.py = lens.ty; lens.vx = 0; lens.vy = 0; return; }
      let left = dt;
      while (left > 1e-6) {
        const h = Math.min(SUBSTEP, left);
        lens.vx += ((lens.tx - lens.px) * STIFFNESS - lens.vx * DAMPING) * h;
        lens.vy += ((lens.ty - lens.py) * STIFFNESS - lens.vy * DAMPING) * h;
        lens.px += lens.vx * h;
        lens.py += lens.vy * h;
        left -= h;
      }
      const restPx = Math.abs(lens.tx - lens.px) * lens.w + Math.abs(lens.ty - lens.py) * lens.h;
      const speedPx = Math.abs(lens.vx) * lens.w + Math.abs(lens.vy) * lens.h;
      if (restPx < 0.02 && speedPx < 1) { lens.px = lens.tx; lens.py = lens.ty; lens.vx = 0; lens.vy = 0; }
    }

    /** @param {any} frame */
    function render(frame) {
      lens.w = frame.cssWidth;
      lens.h = frame.cssHeight;
      step(Math.min(0.1, Math.max(0, (frame.delta || 0) / 1000)));
      instance.continuous = lens.px !== lens.tx || lens.py !== lens.ty || lens.vx !== 0 || lens.vy !== 0;
      u[0] = frame.width; u[1] = frame.height; u[2] = frame.cssWidth; u[3] = frame.cssHeight;
      geometry.cx = lens.px * frame.cssWidth; geometry.cy = lens.py * frame.cssHeight;
      geometry.vx = lens.vx * frame.cssWidth; geometry.vy = lens.vy * frame.cssHeight;
      geometry.size = o.size; geometry.aspect = o.aspect; geometry.refraction = o.refraction;
      writeLensGeometry(u, geometry);
      u[12] = o.dispersion; u[13] = o.highlight; u[14] = frame.sourceReady ? 1 : 0; u[15] = 0;
      device.queue.writeBuffer(uniforms, 0, u);
      let bindGroup = bindGroups.get(frame.sourceView);
      if (!bindGroup) {
        bindGroup = device.createBindGroup({
          label: 'liquid-glass', layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: uniforms } }, { binding: 1, resource: sampler }, { binding: 2, resource: frame.sourceView }],
        });
        bindGroups.set(frame.sourceView, bindGroup);
      }
      attachment.view = frame.destinationView;
      passDescriptor.timestampWrites = frame.profiling?.timestampWrites?.('liquid-glass');
      const pass = frame.encoder.beginRenderPass(passDescriptor);
      pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.draw(3); pass.end();
      attachment.view = null;
    }

    // called each time a frame is PRESENTED: copy the uniform block of that frame into a slot (no allocation)
    function captureInputMapper() {
      slot = (slot + 1) % MAPPER_SLOTS;
      states[slot].set(u);
      return mappers[slot];
    }

    /** @param {Element} root @param {{getOptions: () => Readonly<Record<string, unknown>>, setOptions: (patch: Record<string, unknown>) => void}} ui */
    function mountUI(root, ui) {
      const doc = root.ownerDocument;
      injectUiStyle(doc);
      const box = doc.createElement('div');
      box.className = 'hic-lg-ui';
      const id = `hic-lg-${++uiSerial}`;
      /** @type {Array<() => void>} */ const offs = [];
      for (const [key, text, min, max, stepValue, format, scale] of SLIDERS) {
        const label = doc.createElement('label');
        label.innerHTML = `<span>${text}</span><output></output><input type="range" id="${id}-${key}" min="${min}" max="${max}" step="${stepValue}">`;
        const range = /** @type {HTMLInputElement} */ (label.querySelector('input'));
        const out = /** @type {HTMLOutputElement} */ (label.querySelector('output'));
        const sync = (/** @type {any} */ opts) => {
          const value = String(Math.round(opts[key] * scale));
          if (range.value !== value) range.value = value;
          const textValue = format(opts[key]);
          if (out.textContent !== textValue) out.textContent = textValue;
        };
        const onInput = () => ui.setOptions({ [key]: Number(range.value) / scale });
        range.addEventListener('input', onInput);
        offs.push(() => range.removeEventListener('input', onInput));
        uiSyncs.push(sync);
        sync(o);
        box.append(label);
      }
      const pin = doc.createElement('label');
      pin.className = 'pin';
      pin.innerHTML = `<input type="checkbox" id="${id}-pinned"> Pin lens`;
      const box2 = /** @type {HTMLInputElement} */ (pin.querySelector('input'));
      const syncPin = (/** @type {any} */ opts) => { if (box2.checked !== opts.pinned) box2.checked = opts.pinned; };
      // pinning keeps the lens where it is now: its current position becomes the pinned (x, y)
      const onPin = () => ui.setOptions(box2.checked ? { pinned: true, x: lens.px, y: lens.py } : { pinned: false });
      box2.addEventListener('change', onPin);
      offs.push(() => box2.removeEventListener('change', onPin));
      uiSyncs.push(syncPin);
      syncPin(o);
      box.append(pin);
      root.append(box);
      const mine = uiSyncs.slice(-SLIDERS.length - 1);
      return () => {
        for (const off of offs) off();
        for (const s of mine) { const i = uiSyncs.indexOf(s); if (i >= 0) uiSyncs.splice(i, 1); }
        box.remove();
      };
    }

    return instance;
  },
});
