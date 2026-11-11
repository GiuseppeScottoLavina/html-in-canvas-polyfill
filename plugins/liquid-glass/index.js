/**
 * Liquid glass effect plugin (effect plugin ABI v2): an EXAMPLE of the effects extension of html-in-canvas-polyfill, not part of the polyfill.
 * Shader: ./liquid-glass.wgsl.
 *
 * A slab of glass with a superellipse (squircle) outline floats over the live HTML. Its surface is a height field: a flat top with a
 * gentle dome (it magnifies) and an elliptic bevel that turns vertical at the edge. The view ray is refracted by Snell's law at the real
 * surface normal and travels through the glass thickness to the content below; red and blue have their own refractive indices
 * (dispersion), the surface reflects by Fresnel (Schlick), a key and a rim light leave specular highlights, the slab casts a soft drop
 * shadow and darkens its inner rim, and an optional frost blurs what it shows.
 * The lens follows a mouse or pen on a spring, a finger drags it (with inertia, a jelly stretch along its velocity and a press swell),
 * and `handle.trigger('demo')` glides it over the content. The input mapper (`mapLensPoint`) is the JavaScript twin of the sampling in
 * liquid-glass.wgsl and evaluates the uniform block that was submitted for the presented frame, so a click through the lens reaches the
 * element the user sees there.
 */

import { wgsl } from './wgsl.js';
import { stateMapper } from '../_lib/mapper.js';
import { clampTo } from '../_lib/number.js';
import { fullscreenPass } from '../_lib/gpu.js';
import { hdrConstants } from '../_lib/hdr.js';
import { springSubsteps } from '../_lib/spring.js';
import { injectStyle } from '../_lib/ui.js';
import { pointerIn } from '../_lib/pointer.js';

/** @typedef {import('../../src/contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../../src/contracts/types.js').EffectPluginContext} EffectPluginContext */
/** @typedef {import('../../src/contracts/types.js').InputMapper} InputMapper */
/** @typedef {import('../../src/contracts/types.js').InputPoint} InputPoint */

/**
 * What the plugin gallery and the build read (plugins/README.md).
 * @experimental an example plugin of the effects, an extension of this library, not part of the HTML-in-Canvas standard (docs/STABILITY.md)
 */
export const meta = Object.freeze({
  name: 'liquid-glass',
  title: 'Liquid glass',
  description: 'A slab of refractive glass over the live page: drag it with a finger, or it follows the mouse; clicks through it reach what it shows.',
  defaults: Object.freeze({ size: 150, refraction: 0.75, dispersion: 0.5, frost: 0, pinned: false, x: 0.73, y: 0.3 }),
  touch: 'Drag the glass with a finger; tap through it to use the form.',
  reducedMotion: 'With reduced motion the lens jumps to the pointer or the finger (no spring, no inertia, no stretch) and the demo resolves at once: nothing animates.',
});

/** floats in the uniform block (liquid-glass.wgsl, struct U) */
export const UNIFORM_FLOATS = 20;
/** the mapper chain keeps the last 3 presented frames, plus the one being written */
const MAPPER_SLOTS = 4;
/** @type {Readonly<Record<string, [number, number]>>} */
const LIMITS = Object.freeze({ size: [60, 280], refraction: [0, 1], dispersion: [0, 1], frost: [0, 1], highlight: [0, 1], shadow: [0, 1], aspect: [1, 2.5] });

/** The glass (the same numbers are in liquid-glass.wgsl; lengths are fractions of the smaller half size m). */
export const GLASS = Object.freeze({
  ior: 1.5,          // crown glass: the index of the green channel, the one the mapper follows
  spread: 0.1,       // dispersion 1: red and blue indices down to 1.4 and up to 1.6 (glass dispersion, exaggerated so that it is seen)
  bevel: 0.45,       // width of the curved rim
  bevelHeight: 1.4,  // height of the rim per unit of refraction, relative to its width (an elliptic quarter)
  dome: 0.36,        // height of the magnifying dome per unit of refraction
  fade: 0.95,        // depth over which the dome fades in from the edge (it ends before the middle line of the slab: no crease)
});

/**
 * The springs the lens follows, one per pointer kind: `stiffness` (1/s^2) sets how closely it keeps up, `damping` (the damping ratio) how much it overshoots.
 * mouse: a mouse or pen (and the demo); finger: a finger dragging the lens, stiffer so that the lens stays under it. The README gives the lag they measure.
 */
export const SPRINGS = Object.freeze({
  mouse: Object.freeze({ stiffness: 600, damping: 0.74 }),
  finger: Object.freeze({ stiffness: 1300, damping: 0.9 }),
});
/** @param {{stiffness: number, damping: number}} s @returns {{k: number, c: number}} */
const springOf = (s) => ({ k: s.stiffness, c: 2 * s.damping * Math.sqrt(s.stiffness) });
const FOLLOW = springOf(SPRINGS.mouse);
const DRAG = springOf(SPRINGS.finger);
/**
 * The jelly stretch follows the velocity on an underdamped spring: it wobbles once when the lens stops. Its stiffness keeps the ratio it had to the mouse spring's
 * (420 to 260, the ratio of the earlier springs): a jelly slower than the lens it follows rebounds at full stretch when the lens stops.
 */
const JELLY_K = (420 / 260) * SPRINGS.mouse.stiffness;
const JELLY = { k: JELLY_K, c: 2 * 0.32 * Math.sqrt(JELLY_K), gain: 1 / 2600, max: 0.24 };
/** the swell while a finger holds the lens */
const PRESS = { k: 520, c: 2 * 0.55 * Math.sqrt(520), scale: 1.07 };
/** a flick carries the lens on by its release velocity times this time (s) */
const FLICK_S = 0.16;
/** extra hit margin around the lens for a finger (CSS px) */
const TOUCH_SLOP = 10;
/** the demo: its length (s) and the most places it visits */
const DEMO_S = 3.2;
const DEMO_STOPS = 4;
/** what the demo looks for in the drawn HTML (any page): fields first, then headings, buttons and text */
const DEMO_SELECTOR = 'input:not([type=hidden]),textarea,select,button,h1,h2,h3,p,label,li,img';

let uiSerial = 0;

/**
 * Signed distance (negative inside) from the local point (lx, ly) to a rounded box of half size (hx, hy) whose corners are superellipse
 * quarters |x|^4 + |y|^4 = r^4 with r = min(hx, hy) (a squircle when hx = hy), and the gradient of that distance into `g`.
 * The twin of sd_squircle() in liquid-glass.wgsl.
 * @param {number} lx @param {number} ly @param {number} hx @param {number} hy @param {number[]} [g]
 */
export function sdSquircle(lx, ly, hx, hy, g) {
  const r = Math.min(hx, hy);
  const qx = Math.abs(lx) - hx + r;
  const qy = Math.abs(ly) - hy + r;
  const sx = lx < 0 ? -1 : 1;
  const sy = ly < 0 ? -1 : 1;
  if (qx > 0 && qy > 0) {
    const x2 = qx * qx;
    const y2 = qy * qy;
    const l4 = Math.sqrt(Math.sqrt(x2 * x2 + y2 * y2));
    const l3 = l4 * l4 * l4;
    if (g) { g[0] = (sx * x2 * qx) / l3; g[1] = (sy * y2 * qy) / l3; }
    return l4 - r;
  }
  if (qx > qy) { if (g) { g[0] = sx; g[1] = 0; } return qx - r; }
  if (g) { g[0] = 0; g[1] = sy; }
  return qy - r;
}

const GRAD = [0, 0];
/** @typedef {{sd: number, gl: number, nx: number, ny: number, nz: number, t: number}} Surface */
/** @type {Surface} */
const SURFACE = { sd: 0, gl: 1, nx: 0, ny: 0, nz: 1, t: 0 };
const BEND = { x: 0, y: 0 };

/**
 * The glass at the presented point (px, py) for the uniform block `s`: the signed distance `sd` (local units), the screen length of its
 * gradient `gl` (sd / gl is the distance in CSS px), the unit surface normal (nx, ny, nz) in screen space (z towards the viewer) and the
 * thickness `t` (CSS px). The twin of surface() in liquid-glass.wgsl. Writes into `out` (no allocation).
 * @param {ArrayLike<number>} s  [4,5] centre, [6,7] rest half size, [8,9,10] inverse deformation [[a, b], [b, c]], [11] refraction
 * @param {number} px @param {number} py @param {Surface} out
 */
export function lensSurface(s, px, py, out) {
  const dx = px - s[4];
  const dy = py - s[5];
  const a = s[8];
  const b = s[9];
  const c = s[10];
  const lx = a * dx + b * dy;
  const ly = b * dx + c * dy;
  const hx = s[6];
  const hy = s[7];
  const g = GRAD;
  const sd = sdSquircle(lx, ly, hx, hy, g);
  out.sd = sd;
  out.gl = Math.hypot(a * g[0] + b * g[1], b * g[0] + c * g[1]);
  const m = Math.min(hx, hy);
  const k = s[11];
  const bevel = GLASS.bevel * m;
  const hb = k * GLASS.bevelHeight * bevel;
  const dome = k * GLASS.dome * m;
  const r2 = hx * hx + hy * hy;
  // the rim: an elliptic quarter of width `bevel` and height `hb`, vertical at the edge (e = 1), flat where the top begins (e = 0)
  const e = Math.min(1, Math.max(0, 1 + sd / bevel));
  const w = Math.sqrt(1 - e * e);
  // the dome: a paraboloid P over the whole slab, faded in from the edge (tau, a smoothstep of the depth -sd), so that the glass is 0
  // thick at its edge and the picture is continuous across it. These numbers keep the picture free of folds (every point of the page
  // is shown once) for aspects 1 to 2.5 and any refraction.
  const p = Math.max(0, 1 - (lx * lx + ly * ly) / r2);
  const fade = GLASS.fade * m;
  const x = Math.min(1, Math.max(0, -sd / fade));
  const tau = x * x * (3 - 2 * x);
  const dtau = (6 * x * (1 - x)) / fade;   // d tau / d depth; the depth grows against grad sd
  const dx2 = dome * (-tau * ((2 * lx) / r2) - p * dtau * g[0]);
  const dy2 = dome * (-tau * ((2 * ly) / r2) - p * dtau * g[1]);
  // the normal (-grad z, 1) of z = hb sqrt(1 - e^2) + dome P tau, scaled by bevel w so that it stays finite where the rim is vertical
  // (grad sd is not a unit vector in the corners, so it is not normalised)
  const bw = Math.max(bevel * w, 1e-4 * bevel);
  const nx = g[0] * e * hb - bw * dx2;
  const ny = g[1] * e * hb - bw * dy2;
  // local slopes to screen slopes: a normal transforms by the inverse transpose of the deformation (here symmetric: the same matrix)
  const sxn = a * nx + b * ny;
  const syn = b * nx + c * ny;
  const l = Math.hypot(sxn, syn, bw);
  out.nx = sxn / l; out.ny = syn / l; out.nz = bw / l;
  out.t = hb * w + dome * p * tau;
  return out;
}

/**
 * Where the view ray through a surface point reaches the content below: refraction by Snell's law at the normal (index `ior`, from air;
 * the viewer looks straight down), then straight on through the thickness. The offset (CSS px) goes into `out`. The twin of bend() in
 * liquid-glass.wgsl.
 * @param {{nx: number, ny: number, nz: number, t: number}} q @param {number} ior @param {{x: number, y: number}} out
 */
export function bendThrough(q, ior, out) {
  const eta = 1 / ior;
  const cos = q.nz;
  const f = eta * cos - Math.sqrt(1 - eta * eta * (1 - cos * cos));
  const tz = -eta + f * q.nz;
  out.x = ((f * q.nx) / -tz) * q.t;
  out.y = ((f * q.ny) / -tz) * q.t;
  return out;
}

/**
 * Source point shown at the presented point `point` for the uniform block `s` (lens geometry of one frame); the twin of the shader:
 * outside the lens (sd >= 0, where its anti-aliased edge has coverage 0.5 and less) the picture is not displaced; inside, it is where the
 * green channel's refracted ray lands (dispersion only spreads red and blue around it). Clamped to the canvas.
 * @param {ArrayLike<number>} s  [2,3] css size, [4..11] the lens (lensSurface)
 * @param {InputPoint} point
 * @returns {{x: number, y: number}}
 */
export function mapLensPoint(s, point) {
  const q = lensSurface(s, point.x, point.y, SURFACE);
  let x = point.x;
  let y = point.y;
  if (q.sd < 0) {
    const o = bendThrough(q, GLASS.ior, BEND);
    x += o.x;
    y += o.y;
  }
  return { x: Math.min(s[2], Math.max(0, x)), y: Math.min(s[3], Math.max(0, y)) };
}

/**
 * Lens geometry of a frame into [4..11] of `u`: the centre, the rest half size (`size` high, `size * aspect` wide) and the inverse of the
 * deformation: a stretch by (1 + e) along the jelly vector (jx, jy) of length e, a squash by 1 / (1 + 0.6 e) across it, times the press
 * swell. A lens at rest has the identity.
 * @param {Float32Array} u
 * @param {{cx: number, cy: number, size: number, aspect: number, refraction: number, jx?: number, jy?: number, press?: number}} lens  CSS px
 */
export function writeLensGeometry(u, lens) {
  const jx = lens.jx ?? 0;
  const jy = lens.jy ?? 0;
  const p = lens.press ?? 1;
  const len = Math.hypot(jx, jy);
  const e = Math.min(JELLY.max, len);
  let a = 1 / p;
  let b = 0;
  let c = 1 / p;
  if (e > 1e-6) {
    const ux = jx / len;
    const uy = jy / len;
    const along = 1 / ((1 + e) * p);
    const across = (1 + 0.6 * e) / p;
    a = along * ux * ux + across * uy * uy;
    b = (along - across) * ux * uy;
    c = along * uy * uy + across * ux * ux;
  }
  u[4] = lens.cx; u[5] = lens.cy; u[6] = lens.size * lens.aspect * 0.5; u[7] = lens.size * 0.5;
  u[8] = a; u[9] = b; u[10] = c; u[11] = lens.refraction;
}

/**
 * Up to `n` places of `root` worth showing through the lens (fields, headings, buttons, text) as fractions of `root`'s box, kept in
 * [0.1, 0.9] so that the lens stays on the canvas; picked far from each other (farthest point first, fields count double) and ordered
 * as a tour that starts near `from`. Generic: it reads only the layout of the drawn HTML.
 * @param {Element|null|undefined} root @param {{x: number, y: number}} from  fraction of the canvas @param {number} [n]
 * @returns {{x: number, y: number}[]}
 */
export function demoStops(root, from, n = DEMO_STOPS) {
  const box = root?.getBoundingClientRect?.();
  if (!root || !box || !(box.width > 0) || !(box.height > 0)) return [];
  /** @type {{x: number, y: number, w: number}[]} */
  const found = [];
  for (const el of root.querySelectorAll(DEMO_SELECTOR)) {
    const r = el.getBoundingClientRect();
    if (!(r.width > 4 && r.height > 4)) continue;
    const x = (r.left + r.width / 2 - box.left) / box.width;
    const y = (r.top + r.height / 2 - box.top) / box.height;
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) continue;
    const weight = /^(input|textarea|select)$/i.test(el.localName) ? 2 : /^h[1-3]$/i.test(el.localName) ? 1.5 : 1;
    found.push({ x: Math.min(0.9, Math.max(0.1, x)), y: Math.min(0.9, Math.max(0.1, y)), w: weight });
    if (found.length >= 400) break;
  }
  /** @type {{x: number, y: number}[]} */
  const picked = [];
  while (picked.length < n && found.length) {
    let best = -1;
    let score = -1;
    for (let i = 0; i < found.length; i += 1) {
      const f = found[i];
      let near = Math.hypot(f.x - from.x, f.y - from.y);
      for (const p of picked) near = Math.min(near, Math.hypot(f.x - p.x, f.y - p.y));
      if (near * f.w > score) { score = near * f.w; best = i; }
    }
    if (score < 0.12) break;   // what is left is next to a place already picked
    const [f] = found.splice(best, 1);
    picked.push({ x: f.x, y: f.y });
  }
  /** @type {{x: number, y: number}[]} */
  const tour = [];
  let at = from;
  while (picked.length) {
    let best = 0;
    for (let i = 1; i < picked.length; i += 1) if (Math.hypot(picked[i].x - at.x, picked[i].y - at.y) < Math.hypot(picked[best].x - at.x, picked[best].y - at.y)) best = i;
    [at] = picked.splice(best, 1);
    tour.push(at);
  }
  return tour;
}

/**
 * The point at time `t` in [0, 1] (eased in and out, so the tour starts and ends at rest) of a uniform Catmull-Rom spline through
 * `points` (at least 2).
 * @param {{x: number, y: number}[]} points @param {number} t @param {{x: number, y: number}} out
 */
export function tourPoint(points, t, out) {
  const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
  const segs = points.length - 1;
  const f = Math.min(segs - 1e-9, Math.max(0, e * segs));
  const i = Math.floor(f);
  const v = f - i;
  const p0 = points[Math.max(0, i - 1)];
  const p1 = points[i];
  const p2 = points[i + 1];
  const p3 = points[Math.min(segs, i + 2)];
  const v2 = v * v;
  const v3 = v2 * v;
  const cr = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ c, /** @type {number} */ d) => 0.5 * (2 * b + (c - a) * v + (2 * a - 5 * b + 4 * c - d) * v2 + (3 * b - a - 3 * c + d) * v3);
  out.x = cr(p0.x, p1.x, p2.x, p3.x);
  out.y = cr(p0.y, p1.y, p2.y, p3.y);
  return out;
}

/** CSS of the plugin UI (mountUI) */
const UI_CSS = `
    .hic-lg-ui { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)) auto; gap:4px 12px; align-items:end; }
    .hic-lg-ui label { display:grid; grid-template-columns:1fr auto; gap:2px 6px; min-width:0; font-size:10px; font-weight:700; }
    .hic-lg-ui output { color:#9cf5ff; font-variant-numeric:tabular-nums; white-space:nowrap; }
    .hic-lg-ui input[type=range] { grid-column:1 / -1; width:100%; height:22px; margin:0; accent-color:#9fd8ff; cursor:ew-resize; }
    .hic-lg-ui label.pin { display:flex; align-items:center; gap:6px; padding-bottom:4px; white-space:nowrap; }
    .hic-lg-ui label.pin input { width:15px; height:15px; margin:0; accent-color:#9fd8ff; }
    @media (max-width: 560px) { .hic-lg-ui { grid-template-columns:repeat(2, minmax(0, 1fr)); } }
  `;

const SLIDERS = /** @type {const} */ ([
  ['size', 'Lens size', 60, 280, 2, (/** @type {number} */ v) => `${Math.round(v)} px`, 1],
  ['refraction', 'Refraction', 0, 100, 1, (/** @type {number} */ v) => `${Math.round(v * 100)}%`, 100],
  ['dispersion', 'Dispersion', 0, 100, 1, (/** @type {number} */ v) => `${Math.round(v * 100)}%`, 100],
  ['frost', 'Frost', 0, 100, 1, (/** @type {number} */ v) => `${Math.round(v * 100)}%`, 100],
]);

/**
 * The plugin's definition (effect plugin ABI v2).
 * @experimental an example plugin of the effects, an extension of this library, not part of the HTML-in-Canvas standard (docs/STABILITY.md)
 * @type {EffectPluginDefinition}
 */
export const plugin = Object.freeze({
  type: 'liquid-glass',
  apiVersion: /** @type {const} */ (2),
  version: 2,
  actions: Object.freeze(['demo']),
  // the pass only writes its destination as a same-format colour attachment (it never samples or reads it)
  outputCapabilities: Object.freeze({ directCanvasRenderAttachment: /** @type {const} */ (true) }),
  async create(context, options) {
    const { device, format } = context;
    const module = device.createShaderModule({ code: await wgsl('liquid-glass.wgsl'), label: 'liquid-glass' });
    const gpu = fullscreenPass(device, format, module, 'liquid-glass', UNIFORM_FLOATS, hdrConstants(context));
    const u = new Float32Array(UNIFORM_FLOATS);
    const states = Array.from({ length: MAPPER_SLOTS }, () => new Float32Array(UNIFORM_FLOATS));
    const mappers = states.map((s) => stateMapper(s, mapLensPoint));
    let slot = 0;

    const canvas = context.canvas;
    const source = context.source;
    const win = /** @type {any} */ (canvas?.ownerDocument?.defaultView ?? globalThis);
    const reducedQuery = win.matchMedia?.('(prefers-reduced-motion: reduce)');
    const reduced = () => !!reducedQuery?.matches;

    const o = { size: 150, refraction: 0.75, dispersion: 0.5, frost: 0, highlight: 1, shadow: 1, aspect: 1.45, pinned: false, x: 0.73, y: 0.3 };
    /** @param {Record<string, unknown>} next */
    function readOptions(next) {
      for (const key of /** @type {const} */ (['size', 'refraction', 'dispersion', 'frost', 'highlight', 'shadow', 'aspect'])) o[key] = clampTo(next[key], LIMITS[key], o[key]);
      o.x = clampTo(next.x, [0, 1], o.x);
      o.y = clampTo(next.y, [0, 1], o.y);
      o.pinned = next.pinned === undefined ? o.pinned : !!next.pinned;
    }
    readOptions({ ...meta.defaults, ...(options ?? {}) });

    // the lens: position and target as fractions of the canvas, velocity in fractions per second; it starts at rest at (x, y)
    const lens = { x: o.x, y: o.y, vx: 0, vy: 0, tx: o.x, ty: o.y, w: 1, h: 1 };
    // the jelly vector (a stretch along its direction by its length) and the press swell (x), each on its own spring
    const jelly = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0 };
    const press = { x: 1, y: 0, vx: 0, vy: 0, tx: 1, ty: 0 };
    /** a finger dragging the lens: touch identifier, grab offset (lens centre minus finger, fractions), its last samples */
    /** @type {{id: number, ox: number, oy: number, samples: {x: number, y: number, t: number}[]}|null} */
    let drag = null;
    let spring = FOLLOW;
    /** the demo tour while it plays */
    /** @type {{t: number, points: {x: number, y: number}[], resolve: (state: string|null) => void}|null} */
    let demo = null;
    let demoDone = false;
    /** @type {((state: string) => void)[]} */
    const waiters = [];
    const geometry = { cx: 0, cy: 0, size: 0, aspect: 0, refraction: 0, jx: 0, jy: 0, press: 1 };
    const tour = { x: 0, y: 0 };
    /** @type {Array<(o: any) => void>} */
    const uiSyncs = [];

    const still = () => lens.x === lens.tx && lens.y === lens.ty && lens.vx === 0 && lens.vy === 0
      && jelly.x === 0 && jelly.y === 0 && jelly.vx === 0 && jelly.vy === 0 && press.x === press.tx && press.vx === 0;
    const moving = () => !!demo || !still();
    const restingState = () => (o.pinned ? 'pinned' : 'free');

    const instance = {
      spatial: true,
      /** true while anything moves; the host then renders every capped frame, and stops when it comes to rest */
      continuous: false,
      setOptions,
      render,
      captureInputMapper,
      mountUI,
      runAction,
      settled: () => (moving() ? new Promise((resolve) => { waiters.push(resolve); }) : restingState()),
      destroy() {
        endDemo(null);
        gpu.uniforms.destroy?.();
      },
    };

    function wake() {
      instance.continuous = true;
      context.requestRender?.();
    }

    /** @param {string|null} state */
    function endDemo(state) {
      const d = demo;
      demo = null;
      demoDone = false;
      d?.resolve(state);
    }

    /** @param {Record<string, unknown>} next */
    function setOptions(next) {
      const wasPinned = o.pinned;
      const { x, y } = o;
      endDemo(null);   // the page took over
      readOptions(next ?? {});
      if (o.pinned && (!wasPinned || x !== o.x || y !== o.y)) { lens.tx = o.x; lens.ty = o.y; spring = FOLLOW; }
      for (const sync of uiSyncs) sync(o);
      wake();
    }

    /**
     * `demo`: the lens glides over places of the drawn page (fields, headings, text) and comes back where it rests. Resolves with the
     * state it rests in ('free' or 'pinned') once it is at rest; null when the user or the page took over (a pointer move or press, a
     * finger on the glass, setOptions) or the plugin went away.
     * @param {string} action @param {Readonly<Record<string, unknown>>} _options @param {{reducedMotion: boolean}} info
     */
    function runAction(action, _options, info) {
      endDemo(null);
      if (action !== 'demo' || info?.reducedMotion || reduced()) return restingState();
      const home = { x: lens.tx, y: lens.ty };
      let stops = demoStops(source, home);
      if (stops.length < 2) stops = [{ x: 0.25, y: 0.35 }, { x: 0.5, y: 0.68 }, { x: 0.78, y: 0.4 }];
      drag = null;
      press.tx = 1;
      spring = FOLLOW;
      return new Promise((resolve) => {
        demo = { t: 0, points: [{ x: lens.x, y: lens.y }, ...stops, home], resolve };
        wake();
      });
    }

    /**
     * As a fraction of the canvas content box. Through the plugins added after this one (the lens belongs under the pointer as the user sees the glass; null where
     * one of them shows none of it), except `onCanvas`: the point on the canvas itself (has the pointer left it?).
     * @param {{clientX: number, clientY: number}} event @param {boolean} [onCanvas] @returns {{x: number, y: number}|null}
     */
    function unit(event, onCanvas) {
      if (!canvas?.getBoundingClientRect) return null;
      const p = pointerIn(onCanvas ? {} : context, canvas, event.clientX, event.clientY);
      return p && { x: p.x / Math.max(1, canvas.clientWidth), y: p.y / Math.max(1, canvas.clientHeight) };
    }

    // mouse and pen: the lens follows the pointer, a hover magnifier (a click lands where its centre shows; nothing to grab)
    context.listen?.('pointermove', (event) => {
      const e = /** @type {PointerEvent} */ (event);
      if (e.pointerType === 'touch' || o.pinned || drag) return;
      const p = unit(e);
      if (!p) return;
      endDemo(null);   // user input takes over from the demo at once
      spring = FOLLOW;
      lens.tx = Math.min(1, Math.max(0, p.x));
      lens.ty = Math.min(1, Math.max(0, p.y));
      wake();
    });
    // a press anywhere (mouse, pen or finger) takes over from the demo; passive: it never blocks the page
    context.listen?.('pointerdown', () => endDemo(null), { passive: true });
    // leaving the canvas (not just moving between the canvas and its live layer) sends the lens back to its home (x, y)
    context.listen?.('pointerleave', (event) => {
      const e = /** @type {PointerEvent} */ (event);
      if (e.pointerType === 'touch' || o.pinned || drag || demo) return;
      const p = unit(e, true);
      if (p && p.x > 0.002 && p.x < 0.998 && p.y > 0.002 && p.y < 0.998) return;
      lens.tx = o.x;
      lens.ty = o.y;
      wake();
    });

    // touch: a finger that lands on the lens drags it. The gesture is claimed at its first touchmove (preventDefault), not at touchstart,
    // so a tap on the lens stays a native tap (focus, caret, click) that the host maps through the lens; anywhere else the page scrolls.
    /** @param {TouchList|undefined} list @param {number} id */
    const touchOf = (list, id) => { for (let i = 0; i < (list?.length ?? 0); i += 1) if (list?.[i]?.identifier === id) return list[i]; return null; };
    context.listen?.('touchstart', (event) => {
      const e = /** @type {TouchEvent} */ (event);
      const t = e.changedTouches?.[0];
      if (drag || o.pinned || !t || (e.touches?.length ?? 1) > 1 || !(u[2] > 0)) return;
      const p = unit(t);
      if (!p) return;
      const q = lensSurface(u, p.x * u[2], p.y * u[3], SURFACE);
      if (q.sd / Math.max(q.gl, 1e-6) > TOUCH_SLOP) return;
      endDemo(null);
      drag = { id: t.identifier, ox: lens.x - p.x, oy: lens.y - p.y, samples: [{ x: p.x, y: p.y, t: e.timeStamp }] };
      spring = DRAG;
      lens.tx = lens.x; lens.ty = lens.y;
      if (!reduced()) press.tx = PRESS.scale;
      wake();
    }, { passive: false });
    context.listen?.('touchmove', (event) => {
      const e = /** @type {TouchEvent} */ (event);
      const t = drag ? touchOf(e.changedTouches, drag.id) : null;
      if (!drag || !t) return;
      if (e.cancelable) e.preventDefault();   // the gesture is the lens's: no scroll, no zoom
      const p = unit(t);
      if (!p) return;
      drag.samples.push({ x: p.x, y: p.y, t: e.timeStamp });
      if (drag.samples.length > 8) drag.samples.shift();
      lens.tx = Math.min(1, Math.max(0, p.x + drag.ox));
      lens.ty = Math.min(1, Math.max(0, p.y + drag.oy));
      wake();
    }, { passive: false });
    /** @param {Event} event */
    const release = (event) => {
      const e = /** @type {TouchEvent} */ (event);
      if (!drag || !touchOf(e.changedTouches, drag.id)) return;
      const s = drag.samples;
      drag = null;
      press.tx = 1;
      spring = FOLLOW;
      // a flick: the finger's velocity over its samples of the last 100 ms carries the lens on, then the spring settles it
      const last = s[s.length - 1];
      const first = s.find((q) => last.t - q.t < 100) ?? last;
      const dt = (last.t - first.t) / 1000;
      if (event.type === 'touchend' && dt > 0.008 && e.timeStamp - last.t < 80 && !reduced()) {
        lens.tx = Math.min(0.97, Math.max(0.03, lens.tx + ((last.x - first.x) / dt) * FLICK_S));
        lens.ty = Math.min(0.97, Math.max(0.03, lens.ty + ((last.y - first.y) / dt) * FLICK_S));
      }
      wake();
    };
    context.listen?.('touchend', release);
    context.listen?.('touchcancel', release);

    /** Advance the springs by dt seconds (substeps keep them stable at a 15 fps cap). @param {number} dt */
    function step(dt) {
      if (demo) {
        demo.t += dt;
        tourPoint(demo.points, Math.min(1, demo.t / DEMO_S), tour);
        lens.tx = tour.x;
        lens.ty = tour.y;
      }
      if (reduced()) {
        lens.x = lens.tx; lens.y = lens.ty; lens.vx = 0; lens.vy = 0;
        jelly.x = 0; jelly.y = 0; jelly.vx = 0; jelly.vy = 0;
        press.x = press.tx; press.vx = 0;
      } else {
        springSubsteps(lens, dt, spring.k, spring.c);
        const restPx = Math.abs(lens.tx - lens.x) * lens.w + Math.abs(lens.ty - lens.y) * lens.h;
        const speedPx = Math.abs(lens.vx) * lens.w + Math.abs(lens.vy) * lens.h;
        if (restPx < 0.02 && speedPx < 1) { lens.x = lens.tx; lens.y = lens.ty; lens.vx = 0; lens.vy = 0; }
        jelly.tx = lens.vx * lens.w * JELLY.gain;
        jelly.ty = lens.vy * lens.h * JELLY.gain;
        springSubsteps(jelly, dt, JELLY.k, JELLY.c);
        if (jelly.tx === 0 && jelly.ty === 0 && Math.hypot(jelly.x, jelly.y) < 2e-4 && Math.hypot(jelly.vx, jelly.vy) < 4e-3) { jelly.x = 0; jelly.y = 0; jelly.vx = 0; jelly.vy = 0; }
        springSubsteps(press, dt, PRESS.k, PRESS.c);
        if (Math.abs(press.x - press.tx) < 2e-4 && Math.abs(press.vx) < 4e-3) { press.x = press.tx; press.vx = 0; }
        press.y = 0; press.vy = 0;
      }
      demoDone = !!demo && demo.t >= DEMO_S && still();
    }

    /** @param {any} frame */
    function render(frame) {
      lens.w = frame.cssWidth;
      lens.h = frame.cssHeight;
      step(Math.min(0.1, Math.max(0, (frame.delta || 0) / 1000)));
      u[0] = frame.width; u[1] = frame.height; u[2] = frame.cssWidth; u[3] = frame.cssHeight;
      geometry.cx = lens.x * frame.cssWidth; geometry.cy = lens.y * frame.cssHeight;
      geometry.jx = jelly.x; geometry.jy = jelly.y; geometry.press = press.x;
      geometry.size = o.size; geometry.aspect = o.aspect; geometry.refraction = o.refraction;
      writeLensGeometry(u, geometry);
      u[12] = o.dispersion; u[13] = o.frost; u[14] = o.highlight; u[15] = frame.sourceReady ? 1 : 0;
      u[16] = o.shadow; u[17] = 0; u[18] = 0; u[19] = 0;
      gpu.draw(frame, u);
      // the frame that shows the end state is encoded: the demo and the settled() waiters resolve now
      if (demoDone) endDemo(restingState());
      instance.continuous = moving();
      if (!instance.continuous) for (const resolve of waiters.splice(0)) resolve(restingState());
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
      injectStyle(doc, 'liquid-glass', UI_CSS);
      const box = doc.createElement('div');
      box.className = 'hic-lg-ui';
      const id = `hic-lg-${++uiSerial}`;
      /** @type {Array<() => void>} */ const offs = [];
      /** @type {Array<(o: any) => void>} */ const mine = [];
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
        mine.push(sync);
        sync(o);
        box.append(label);
      }
      const pin = doc.createElement('label');
      pin.className = 'pin';
      pin.innerHTML = `<input type="checkbox" id="${id}-pinned"> Pin lens`;
      const box2 = /** @type {HTMLInputElement} */ (pin.querySelector('input'));
      const syncPin = (/** @type {any} */ opts) => { if (box2.checked !== opts.pinned) box2.checked = opts.pinned; };
      // pinning keeps the lens where it is now: its current position becomes the pinned (x, y)
      const onPin = () => ui.setOptions(box2.checked ? { pinned: true, x: lens.x, y: lens.y } : { pinned: false });
      box2.addEventListener('change', onPin);
      offs.push(() => box2.removeEventListener('change', onPin));
      mine.push(syncPin);
      syncPin(o);
      box.append(pin);
      root.append(box);
      uiSyncs.push(...mine);
      return () => {
        for (const off of offs) off();
        for (const s of mine) { const i = uiSyncs.indexOf(s); if (i >= 0) uiSyncs.splice(i, 1); }
        box.remove();
      };
    }

    return instance;
  },
});
