/**
 * Holographic card effect plugin (effect plugin ABI v2): an EXAMPLE of the effects extension of html-in-canvas-polyfill, not part of the polyfill.
 * Shader: ./holo-card.wgsl.
 *
 * The drawn HTML becomes a collectible card that tilts towards the pointer in perspective (on a spring), with a thin-film iridescent
 * foil that shifts with the viewing angle, glitter flakes that glint when they mirror the light, a star field at another depth (parallax),
 * and a specular glare of a small lamp that hangs in front of the pointer.
 *
 * Touch: a finger on the card tilts it while it rests or moves there, passively, so the page keeps scrolling under it (the card never
 * claims the gesture). Option `motion` (opt-in, the "Tilt with device" control of mountUI on touch devices) tilts it with the device
 * instead (DeviceOrientationEvent; iOS asks for permission on that tap). The action 'demo' sweeps the tilt so that the foil and the glare
 * travel over the card, then lets it come to rest.
 * The input mapper (`mapCardPoint`) is the JavaScript twin of the projection in holo-card.wgsl: it intersects the ray through the
 * presented point with the tilted card plane of the presented frame, so a click on the tilted picture reaches the element the user sees.
 */

import { NO_TARGET } from '../../src/effects/no-target.js';
import { wgsl } from './wgsl.js';
import { stateMapper } from '../_lib/mapper.js';
import { clampTo } from '../_lib/number.js';
import { fullscreenPass } from '../_lib/gpu.js';
import { hdrConstants } from '../_lib/hdr.js';
import { springSubsteps } from '../_lib/spring.js';
import { injectStyle } from '../_lib/ui.js';
import { pointerIn } from '../_lib/pointer.js';

/** @typedef {import('../../src/contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../../src/contracts/types.js').InputMapper} InputMapper */
/** @typedef {import('../../src/contracts/types.js').InputPoint} InputPoint */

/**
 * What the plugin gallery and the build read (plugins/README.md).
 * @experimental an example plugin of the effects, an extension of this library, not part of the HTML-in-Canvas standard (docs/STABILITY.md)
 */
export const meta = Object.freeze({
  name: 'holo-card',
  title: 'Holo card',
  description: 'The form becomes a holographic card that tilts towards the pointer, a finger or the device; clicks are mapped through the 3D perspective.',
  defaults: Object.freeze({ tilt: 14, foil: 0.6, glare: 0.6, idle: true }),
  reducedMotion: 'With reduced motion the card stays flat (no tilt, no sway, no shimmer, no demo); the glare still follows the pointer.',
  continuous: 'With Idle sway on the card sways at rest, redrawn 30 times a second; with it off or with reduced motion nothing renders at rest.',
  touch: 'Touch the card to tilt it towards your finger; the page still scrolls.',
});

/** floats in the uniform block (holo-card.wgsl, struct U) */
export const UNIFORM_FLOATS = 24;
/** what the mapper returns for a point beside the card: the NO_TARGET of the effects ABI, so the host swallows a press there */
export { NO_TARGET };
const MAPPER_SLOTS = 4;
const MAX_TILT = 30;
/** the idle sway alone is slow (at most ~5 degrees a second): it is redrawn this many times a second, not at the display rate */
export const SWAY_HZ = 30;
/** after an interaction the card renders every frame for this long (the spring settles onto the sway), then at SWAY_HZ */
const SETTLE_S = 0.8;
/** The actions of `handle.trigger`: demo sweeps the tilt over the card and resolves 'rest' once the card has come to rest. */
export const ACTIONS = Object.freeze(/** @type {const} */ (['demo']));
export const DEMO_MS = 3200;
/** degrees of device tilt (from where it was held when the motion started) that give the full card tilt */
export const MOTION_RANGE = 24;
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


/**
 * The pointer target of the demo at fraction `f` (0..1) of it: a figure-eight sweep whose amplitude rises and falls with a smooth window,
 * so it starts and ends at the rest target `rest` (x, y in -1..1). PURE.
 * @param {number} f @param {{x: number, y: number}} rest
 * @returns {{x: number, y: number}}
 */
export function demoTarget(f, rest) {
  const g = Math.min(1, Math.max(0, f));
  const smooth = (/** @type {number} */ e0, /** @type {number} */ e1, /** @type {number} */ x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  const w = smooth(0, 0.16, g) * smooth(1, 0.84, g);
  const a = 2 * Math.PI * g;
  // a figure eight: right then left, up and down twice, so the glare crosses the card along both diagonals
  return { x: rest.x * (1 - w) + w * 0.95 * Math.sin(a), y: rest.y * (1 - w) + w * 0.7 * Math.sin(2 * a) };
}

/**
 * The card target (-1..1) for a device orientation: gamma and beta in degrees relative to where the device was held, turned into screen
 * axes by the screen orientation angle, MOTION_RANGE degrees for the full tilt. PURE.
 * @param {number} gamma @param {number} beta @param {number} angle  screen.orientation.angle (0, 90, 180, 270 or -90)
 * @returns {{x: number, y: number}}
 */
export function motionTarget(gamma, beta, angle) {
  const a = ((Math.round(angle / 90) % 4) + 4) % 4;
  const [x, y] = a === 0 ? [gamma, beta] : a === 1 ? [beta, -gamma] : a === 2 ? [-gamma, -beta] : [-beta, gamma];
  const clamp = (/** @type {number} */ v) => Math.min(1, Math.max(-1, v / MOTION_RANGE));
  return { x: clamp(x), y: clamp(y) };
}

/** CSS of the plugin UI (mountUI) */
// (each colour is light-dark(on a light page, on a dark page): the controls follow the page's color-scheme)
const UI_CSS = `
    .hic-holo-ui { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)) auto; gap:4px 12px; align-items:end; }
    .hic-holo-ui label { display:grid; grid-template-columns:1fr auto; gap:2px 6px; min-width:0; font-size:10px; font-weight:700; }
    .hic-holo-ui output { color:light-dark(#8a1f6e, #ffc8f4); font-variant-numeric:tabular-nums; }
    .hic-holo-ui input[type=range] { grid-column:1 / -1; width:100%; height:22px; margin:0; accent-color:light-dark(#7a1fa0, #e7a6ff); cursor:ew-resize; }
    .hic-holo-ui .toggles { display:flex; flex-direction:column; gap:2px; }
    .hic-holo-ui label.toggle { display:flex; align-items:center; gap:6px; padding-bottom:4px; white-space:nowrap; }
    .hic-holo-ui label.toggle input { width:15px; height:15px; margin:0; accent-color:light-dark(#7a1fa0, #e7a6ff); }
  `;

const SLIDERS = /** @type {const} */ ([
  ['tilt', 'Tilt', 0, MAX_TILT, 1, (/** @type {number} */ v) => `${Math.round(v)}°`, 1],
  ['foil', 'Foil', 0, 100, 1, (/** @type {number} */ v) => `${Math.round(v * 100)}%`, 100],
  ['glare', 'Glare', 0, 100, 1, (/** @type {number} */ v) => `${Math.round(v * 100)}%`, 100],
]);

/**
 * The plugin's definition (effect plugin ABI v2).
 * @experimental an example plugin of the effects, an extension of this library, not part of the HTML-in-Canvas standard (docs/STABILITY.md)
 * @type {EffectPluginDefinition}
 */
export const plugin = Object.freeze({
  type: 'holo-card',
  apiVersion: /** @type {const} */ (2),
  version: 2,
  actions: ACTIONS,
  // the pass only writes its destination as a same-format colour attachment (it never samples or reads it)
  outputCapabilities: Object.freeze({ directCanvasRenderAttachment: /** @type {const} */ (true) }),
  async create(context, options) {
    const { device, format } = context;
    const module = device.createShaderModule({ code: await wgsl('holo-card.wgsl'), label: 'holo-card' });
    const gpu = fullscreenPass(device, format, module, 'holo-card', UNIFORM_FLOATS, hdrConstants(context));
    const u = new Float32Array(UNIFORM_FLOATS);
    const states = Array.from({ length: MAPPER_SLOTS }, () => new Float32Array(UNIFORM_FLOATS));
    const mappers = states.map((s) => stateMapper(s, mapCardPoint));
    let slot = 0;
    const canvas = context.canvas;
    const win = /** @type {any} */ (canvas?.ownerDocument?.defaultView ?? globalThis);
    const reducedMotion = !!win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const start = performance.now();

    const o = { tilt: 14, foil: 0.6, glare: 0.6, idle: true, scale: 0.86, motion: false };
    /** @param {Record<string, unknown>} next */
    function readOptions(next) {
      o.tilt = clampTo(next.tilt, [0, MAX_TILT], o.tilt);
      o.foil = clampTo(next.foil, [0, 1], o.foil);
      o.glare = clampTo(next.glare, [0, 1], o.glare);
      o.scale = clampTo(next.scale, [0.5, 1], o.scale);
      o.idle = next.idle === undefined ? o.idle : !!next.idle;
      o.motion = next.motion === undefined ? o.motion : !!next.motion;
    }
    readOptions({ ...meta.defaults, ...(options ?? {}) });

    // the pointer, -1..1 from the canvas centre; `hover` while it (or a finger) is over the canvas. The pose springs towards it.
    const pose = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, hover: false, started: false };
    // the demo: its start (frame clock, s), where its sweep starts and ends, and the resolve of its action
    const demo = { active: false, pending: false, settling: false, start: 0, from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, done: /** @type {((state: string|null) => void)|null} */ (null) };
    /** @type {((state: string|null) => void)[]} */ const settleWaiters = [];
    // device tilt: the latest reading turned into a target, and the reference it is measured from (it drifts towards how the device is held)
    const motion = { on: false, x: 0, y: 0, g0: NaN, b0: NaN, at: 0 };
    /** @type {Array<(o: any) => void>} */
    const uiSyncs = [];

    const instance = {
      spatial: true,
      /** true while the card moves (spring, idle sway, the demo); the host then renders every capped frame */
      continuous: false,
      setOptions,
      render,
      captureInputMapper,
      mountUI,
      runAction,
      settled,
      destroy() {
        clearTimeout(swayTimer);
        stopMotion();
        endDemo(null);
        for (const resolve of settleWaiters.splice(0)) resolve(null);
        gpu.uniforms.destroy?.();
      },
    };
    const swaying = () => o.idle && !pose.hover && !motion.on && !reducedMotion;
    instance.continuous = swaying();

    let swayTimer = /** @type {any} */ (0);
    /** frame clock (s) until which the card renders every frame; NaN: from the next frame on */
    let fastUntil = NaN;
    function wake() {
      fastUntil = NaN;
      instance.continuous = true;
      context.requestRender?.();
    }

    /** @param {Record<string, unknown>} next */
    function setOptions(next) {
      interrupt();   // the user changed something: the demo ends
      readOptions(next ?? {});
      syncMotion();
      for (const sync of uiSyncs) sync(o);
      wake();
    }

    /** @param {string|null} state */
    function endDemo(state) {
      demo.active = false;
      demo.pending = false;
      demo.settling = false;
      const done = demo.done;
      demo.done = null;
      done?.(state);
    }

    /** the user takes over: the demo ends at once (its action resolves null) */
    function interrupt() { if (demo.active || demo.pending || demo.settling) endDemo(null); }

    /** @param {string} _action  'demo' @param {unknown} _options @param {{reducedMotion?: boolean}} [info] */
    function runAction(_action, _options, info) {
      endDemo(null);
      if (reducedMotion || info?.reducedMotion) return 'rest';   // the card stays flat: nothing to show
      demo.pending = true;
      return new Promise((resolve) => { demo.done = resolve; wake(); });
    }

    function moving() { return pose.x !== pose.tx || pose.y !== pose.ty || pose.vx !== 0 || pose.vy !== 0; }
    /** nothing moves but the declared idle sway */
    const atRest = () => !demo.active && !demo.pending && !demo.settling && (!moving() || swaying());
    function settled() {
      if (atRest()) return 'rest';
      return new Promise((resolve) => { settleWaiters.push(resolve); wake(); });
    }

    /**
     * -1..1 over the canvas content box. Through the plugins added after this one (the card tilts towards the pointer as the user sees the card; null where one
     * of them shows none of it), except `onCanvas`: the point on the canvas itself (has the pointer left it?).
     * @param {number} x @param {number} y  viewport css px @param {boolean} [onCanvas] @returns {{x: number, y: number}|null}
     */
    function unitAt(x, y, onCanvas) {
      if (!canvas?.getBoundingClientRect) return null;
      const p = pointerIn(onCanvas ? {} : context, canvas, x, y);
      return p && { x: (p.x / Math.max(1, canvas.clientWidth)) * 2 - 1, y: (p.y / Math.max(1, canvas.clientHeight)) * 2 - 1 };
    }
    /** @param {{x: number, y: number}|null} p */
    function follow(p) {
      if (!p) return;
      interrupt();
      pose.hover = true;
      pose.tx = Math.min(1, Math.max(-1, p.x));
      pose.ty = Math.min(1, Math.max(-1, p.y));
      wake();
    }
    function release() {
      pose.hover = false;
      pose.tx = motion.on ? motion.x : 0;
      pose.ty = motion.on ? motion.y : 0;
      wake();
    }
    context.listen?.('pointermove', (/** @type {any} */ event) => {
      if (event.pointerType === 'touch') return;   // a finger: the touch listeners below (they keep working while the page scrolls)
      follow(unitAt(event.clientX, event.clientY));
    });
    context.listen?.('pointerleave', (/** @type {any} */ event) => {
      if (event.pointerType === 'touch') return;
      const p = unitAt(event.clientX, event.clientY, true);
      if (p && Math.abs(p.x) < 0.996 && Math.abs(p.y) < 0.996) return;   // moving between the canvas and its live layer
      release();
    });
    // a finger tilts the card where it touches, PASSIVELY: the browser may scroll the page meanwhile (touchmove keeps coming while it
    // scrolls, pointer events stop at pointercancel), and the card never calls preventDefault, so it never blocks a scroll or a tap
    /** @param {any} event */
    const onTouch = (event) => { const t = event.touches?.[0]; if (t) follow(unitAt(t.clientX, t.clientY)); };
    /** @param {any} event */
    const onTouchEnd = (event) => { if (!event.touches?.length) release(); };
    context.listen?.('touchstart', onTouch, { passive: true });
    context.listen?.('touchmove', onTouch, { passive: true });
    context.listen?.('touchend', onTouchEnd, { passive: true });
    context.listen?.('touchcancel', onTouchEnd, { passive: true });

    // device tilt (option `motion`): DeviceOrientationEvent on the window; the reference follows how the device is held over ~3 s
    /** @param {any} event */
    function onOrientation(event) {
      if (typeof event.gamma !== 'number' || typeof event.beta !== 'number') return;
      const now = performance.now();
      if (!Number.isFinite(motion.g0)) { motion.g0 = event.gamma; motion.b0 = event.beta; motion.at = now; }
      const k = 1 - Math.exp(-Math.max(0, now - motion.at) / 3000);
      motion.at = now;
      motion.g0 += (event.gamma - motion.g0) * k;
      motion.b0 += (event.beta - motion.b0) * k;
      const angle = Number(win.screen?.orientation?.angle ?? win.orientation ?? 0) || 0;
      const m = motionTarget(event.gamma - motion.g0, event.beta - motion.b0, angle);
      // a dead band: sensor noise does not keep the card (and the host) awake
      if (Math.abs(m.x - motion.x) + Math.abs(m.y - motion.y) < 0.01) return;
      motion.x = m.x; motion.y = m.y;
      if (pose.hover || demo.active) return;
      pose.tx = motion.x; pose.ty = motion.y;
      wake();
    }
    function syncMotion() {
      const want = o.motion && !reducedMotion && typeof win.addEventListener === 'function';
      if (want === motion.on) return;
      if (want) { motion.on = true; motion.g0 = NaN; win.addEventListener('deviceorientation', onOrientation); }
      else stopMotion();
    }
    function stopMotion() {
      if (!motion.on) return;
      motion.on = false;
      win.removeEventListener?.('deviceorientation', onOrientation);
      motion.x = 0; motion.y = 0;
      if (!pose.hover) { pose.tx = 0; pose.ty = 0; }
    }
    syncMotion();

    /** the idle sway at `time` seconds of the frame clock (since create) @param {number} time */
    const sway = (time) => ({ x: 0.62 * Math.sin(time * 0.61), y: 0.5 * Math.sin(time * 0.83 + 1.1) });

    /** @param {number} dt seconds @param {number} time seconds */
    function step(dt, time) {
      if (demo.pending) {
        demo.pending = false; demo.active = true; demo.start = time;
        demo.from = swaying() ? sway(time) : { x: pose.tx, y: pose.ty };
        demo.to = swaying() ? sway(time + DEMO_MS / 1000) : demo.from;
      }
      if (demo.active) {
        const f = (time - demo.start) / (DEMO_MS / 1000);
        if (f >= 1) { demo.active = false; demo.settling = true; }
        else {
          // the sweep starts where the card was and ends where it will rest (the sway's position then, or where it was), without a jump
          const target = demoTarget(f, { x: demo.from.x + (demo.to.x - demo.from.x) * f, y: demo.from.y + (demo.to.y - demo.from.y) * f });
          pose.tx = target.x; pose.ty = target.y;
        }
      }
      if (!demo.active && swaying()) { const r = sway(time); pose.tx = r.x; pose.ty = r.y; }
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

    /**
     * After a frame: the demo has come to rest once the spring has caught up with the rest target (the last 0.4 % is snapped, a
     * hundredth of a degree), or, with the idle sway on, half a second after the sweep ended (the sway is declared continuous).
     * @param {number} time seconds
     */
    function afterFrame(time) {
      if (demo.settling) {
        if (swaying()) { if (time >= demo.start + DEMO_MS / 1000 + 0.5) endDemo('rest'); }
        else if (Math.abs(pose.tx - pose.x) + Math.abs(pose.ty - pose.y) < 0.004 && Math.abs(pose.vx) + Math.abs(pose.vy) < 0.05) {
          pose.x = pose.tx; pose.y = pose.ty; pose.vx = 0; pose.vy = 0;
          endDemo('rest');
        }
      }
      if (settleWaiters.length && atRest()) for (const resolve of settleWaiters.splice(0)) resolve('rest');
    }

    /** @param {any} frame */
    function render(frame) {
      const time = (frame.now - start) / 1000;
      step(Math.min(0.1, Math.max(0, (frame.delta || 0) / 1000)), time);
      if (Number.isNaN(fastUntil)) fastUntil = time + SETTLE_S;
      const busy = demo.active || demo.pending || demo.settling;
      // the idle sway alone, once the spring has caught up with it: a frame every 1/SWAY_HZ s from a timer instead of every display frame
      const slow = swaying() && !busy && time >= fastUntil;
      instance.continuous = !slow && (swaying() || busy || moving());
      clearTimeout(swayTimer);
      // (the timer fires 6 ms early: the frame it asks for lands on the display frame at 1/SWAY_HZ s, not one display frame later)
      swayTimer = slow ? setTimeout(() => { swayTimer = 0; context.requestRender?.(); }, 1000 / SWAY_HZ - 6) : 0;
      // with reduced motion the card stays flat (no tilt); the glare still follows the pointer
      const tilt = reducedMotion ? 0 : (o.tilt * Math.PI) / 180;
      u[0] = frame.width; u[1] = frame.height; u[2] = frame.cssWidth; u[3] = frame.cssHeight;
      // tilt towards the pointer: the side under the pointer comes towards the viewer
      writeCardPose(u, -tilt * pose.y, tilt * pose.x, o.scale, frame.cssWidth, frame.cssHeight);
      u[16] = o.foil; u[17] = o.glare; u[18] = 0.5 + 0.5 * pose.x; u[19] = 0.5 + 0.5 * pose.y;
      u[20] = reducedMotion ? 0 : time % 600; u[21] = frame.sourceReady ? 1 : 0;
      u[22] = reducedMotion ? 0 : pose.x * (o.tilt / 14); u[23] = reducedMotion ? 0 : pose.y * (o.tilt / 14);
      gpu.draw(frame, u);
      afterFrame(time);
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
      /** @param {string} cls @param {string} key @param {string} text @param {(on: boolean) => Promise<boolean>|boolean} [allow] */
      const toggle = (cls, key, text, allow) => {
        const label = doc.createElement('label');
        label.className = `toggle ${cls}`;
        label.innerHTML = `<input type="checkbox" id="${id}-${key}"> ${text}`;
        const check = /** @type {HTMLInputElement} */ (label.querySelector('input'));
        const sync = (/** @type {any} */ opts) => { if (check.checked !== opts[key]) check.checked = opts[key]; };
        const onChange = async () => {
          const on = check.checked;
          const ok = allow ? await allow(on) : true;
          if (!ok) { check.checked = !on; return; }
          ui.setOptions({ [key]: on });
        };
        check.addEventListener('change', onChange);
        offs.push(() => check.removeEventListener('change', onChange));
        mine.push(sync);
        sync(o);
        toggles.append(label);
      };
      const toggles = doc.createElement('div');
      toggles.className = 'toggles';
      box.append(toggles);
      toggle('idle', 'idle', 'Idle sway');
      // on a touch device with orientation sensors: tilt with the device. iOS grants the sensor only from a tap (this change event)
      const view = /** @type {any} */ (doc.defaultView ?? win);
      const Orientation = view.DeviceOrientationEvent;
      if (Orientation && view.matchMedia?.('(pointer: coarse)')?.matches) {
        toggle('motion', 'motion', 'Tilt with device', async (on) => {
          if (!on || typeof Orientation.requestPermission !== 'function') return true;
          try { return (await Orientation.requestPermission()) === 'granted'; } catch { return false; }
        });
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
