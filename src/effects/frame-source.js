/**
 * Who calls the effect host's frame hook: the scheduler of a managed canvas, or (native mode, no record) a demand-driven rAF loop.
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
 * Native mode: one rAF per wake while the hook asks for more; the same phase-accumulator pacing as the scheduler's cap gate.
 * @param {HicEnv} env
 * @param {HTMLCanvasElement} canvas
 * @param {FrameHook} hook
 * @returns {FrameSource}
 */
export function rafFrameSource(env, canvas, hook) {
  const win = env.window;
  let raf = 0;
  let nextDue = 0;
  let removed = false;
  const cap = () => {
    const n = Number(canvas.getAttribute(EXT.FRAME_CAP_ATTR));
    return Number.isFinite(n) && n > 0 ? Math.min(n, EXT.FRAME_CAP_MAX) : env.options.defaultFrameCap;
  };
  /** @param {number} t */
  const run = (t) => {
    raf = 0;
    if (removed) return;
    const frameCap = cap();
    const due = frameCap <= 0 || t >= nextDue - 1;
    if (due && frameCap > 0) {
      const period = 1000 / frameCap;
      nextDue = t - nextDue > 2 * period ? t + period : nextDue + period;
    }
    if (hook(t, { frameCap, due })) schedule();
  };
  const schedule = () => { if (!raf && !removed) raf = win.requestAnimationFrame(run); };
  const onPaint = () => schedule();
  canvas.addEventListener('paint', onPaint);
  return {
    wake: schedule,
    remove() { removed = true; canvas.removeEventListener('paint', onPaint); if (raf) win.cancelAnimationFrame(raf); raf = 0; },
  };
}
