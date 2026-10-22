/**
 * Who calls the effect host's frame hook: the scheduler of a managed canvas, or (native mode, no record) a demand-driven rAF loop plus the
 * canvas's paint event.
 * Module: gpu-effects (src/effects/**).
 */

import { EXT } from '../contracts/events.js';

/** @typedef {import('../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../contracts/types.js').FrameHook} FrameHook */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').Scheduler} Scheduler */

/**
 * @typedef {Object} FrameSource
 * @property {() => void} wake  make sure the hook runs on the next frame even when nothing else is pending
 * @property {() => void} remove
 */

/**
 * Managed canvas: the hook runs inside the scheduler tick, after the commit of the same tick.
 * `Scheduler.wake(record)` arms a tick without damage and without a paint event.
 * @param {Scheduler} scheduler
 * @param {CanvasRecord} record
 * @param {FrameHook} hook
 * @returns {FrameSource}
 */
export function schedulerFrameSource(scheduler, record, hook) {
  const remove = scheduler.addFrameHook(record, hook);
  return {
    wake() { scheduler.wake(record); },
    remove,
  };
}

/**
 * Native mode: the canvas has no scheduler of ours. Frames run from two places, in the same rendering update:
 * - a rAF loop while the hook asks for more (continuous plugins, requestRender, a settle frame);
 * - the canvas's `paint` event, which the browser fires after it painted a changed drawable (and the element image of the source is then
 *   fresh: in the rAF callbacks before it, drawElementImageToTexture still returns the previous paint, measured on Chrome Canary 158).
 * Both call the hook with the frame's time (the rAF timestamp, which equals document.timeline.currentTime in the paint event of the same
 * frame), and `due` is decided ONCE per frame time with the rules of the scheduler's cap gate (a changed cap starts a new phase). The paint event of a frame whose
 * rAF already ran the hook is passed `repeat: true`: the host then uploads the fresh source without rendering that frame again (one render
 * per frame), and the next frame shows it. Requesting a paint per frame instead (canvas.requestPaint()) would make the browser record the drawable again every
 * frame: measured at about 3 ms per frame with 2000 elements in the source.
 * @param {HicEnv} env
 * @param {HTMLCanvasElement} canvas
 * @param {FrameHook} hook
 * @returns {FrameSource}
 */
export function nativeFrameSource(env, canvas, hook) {
  const win = env.window;
  const doc = /** @type {Document|undefined} */ (/** @type {any} */ (win).document);
  let raf = 0;
  let removed = false;
  /** the phase of the cap: the rules of the scheduler's cap gate (schedule/frame-cap.js createCapGate), which the effects bundle cannot import */
  /** @type {{fps: number, nextDue: number}|null} */
  let phase = null;
  /** frame time of the last pacing decision, its result, and whether the hook already ran in that frame */
  let pacedAt = NaN;
  let pacedDue = false;
  let pacedCap = 0;
  let ranAt = NaN;
  /** @param {number} t */
  const pace = (t) => {
    if (t === pacedAt) return;
    pacedAt = t;
    // the framecap attribute by the HTML rules for non-negative integers (as schedule/frame-cap.js parseFrameCap): "30fps" is 30
    const m = /^[\t\n\f\r ]*\+?(\d+)/.exec(canvas.getAttribute(EXT.FRAME_CAP_ATTR) ?? '');
    const fps = (pacedCap = m ? Math.min(Number(m[1]), EXT.FRAME_CAP_MAX) : env.options.defaultFrameCap);
    if (!(fps > 0)) { phase = null; pacedDue = true; return; }
    const interval = 1000 / fps;
    // a changed cap starts a new phase and allows at once; lateness beyond two intervals drops the phase instead of bursting to catch up
    if (!phase || phase.fps !== fps) { phase = { fps, nextDue: t + interval }; pacedDue = true; return; }
    pacedDue = t >= phase.nextDue - Math.min(1, interval * 0.1);
    if (pacedDue) phase.nextDue = t - phase.nextDue > 2 * interval ? t + interval : phase.nextDue + interval;
  };
  /** @param {number} t */
  const run = (t) => {
    if (removed) return;
    pace(t);
    const repeat = ranAt === t;
    ranAt = t;
    if (hook(t, { frameCap: pacedCap, due: pacedDue, repeat })) schedule();
  };
  const schedule = () => { if (!raf && !removed) raf = win.requestAnimationFrame((t) => { raf = 0; run(t); }); };
  const onPaint = () => {
    const t = Number(doc?.timeline?.currentTime);
    run(Number.isFinite(t) ? t : win.performance.now());
  };
  canvas.addEventListener('paint', onPaint);
  return {
    wake: schedule,
    remove() { removed = true; canvas.removeEventListener('paint', onPaint); if (raf) win.cancelAnimationFrame(raf); raf = 0; },
  };
}
