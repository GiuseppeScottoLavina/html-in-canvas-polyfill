/**
 * Frame cap gate (phase accumulator) and the pure cap arithmetic shared by the scheduler and the framecap observer.
 * Module: schedule (src/schedule/**).
 */

import { EXT } from '../contracts/events.js';

/** @typedef {import('../contracts/types.js').ResolvedOptions} ResolvedOptions */

/**
 * @typedef {Object} CapGate
 * @property {(recordId: number, now: number, fps: number) => boolean} allow  true when a frame may be produced now; advances the phase
 * @property {(recordId: number) => number|null} nextDueAt
 * @property {(recordId: number) => void} reset
 */

/** A frame this much earlier than its due time still counts (rAF timestamps are vsync-aligned; this only absorbs float noise and tiny jitter). */
const EARLY_TOLERANCE_MS = 1;
/** Lateness beyond this many intervals drops the accumulated phase instead of bursting to catch up. */
const RESYNC_AFTER_INTERVALS = 2;

/**
 * fps 0 = always allowed. Phase accumulator: nextDue += 1000/fps, resynchronised after > 2 intervals of lateness (a 60 fps cap on a 120 Hz display = every second rAF,
 * not every 2.5th as "now - last >= interval" would give). A changed fps starts a new phase and allows at once, so a runtime cap change is effective on the next frame.
 * @returns {CapGate}
 */
export function createCapGate() {
  /** @type {Map<number, {fps: number, nextDue: number}>} */
  const phases = new Map();
  return {
    allow(recordId, now, fps) {
      if (!(fps > 0)) {
        phases.delete(recordId);
        return true;
      }
      const interval = 1000 / fps;
      const phase = phases.get(recordId);
      if (!phase || phase.fps !== fps) {
        phases.set(recordId, { fps, nextDue: now + interval });
        return true;
      }
      const tolerance = Math.min(EARLY_TOLERANCE_MS, interval * 0.1);
      if (now < phase.nextDue - tolerance) return false;
      phase.nextDue = now - phase.nextDue > RESYNC_AFTER_INTERVALS * interval ? now + interval : phase.nextDue + interval;
      return true;
    },
    nextDueAt(recordId) {
      return phases.get(recordId)?.nextDue ?? null;
    },
    reset(recordId) {
      phases.delete(recordId);
    },
  };
}

/**
 * min(frameCap, maxSnapshotFps) for build starts; frameCap for paint/effect frames; interactionFloorFps raises a finite cap for input-driven damage
 * (it never turns an uncapped canvas into a capped one and never lifts maxSnapshotFps, which is a load guard independent of the cap).
 * @param {number} frameCap  0 = uncapped
 * @param {ResolvedOptions} options
 * @param {'paint'|'build'} kind
 * @param {boolean} interaction
 * @returns {number} fps, 0 = uncapped
 */
export function effectiveFps(frameCap, options, kind, interaction) {
  let fps = frameCap > 0 ? frameCap : 0;
  if (fps > 0 && interaction && options.interactionFloorFps > fps) fps = options.interactionFloorFps;
  if (kind === 'build' && options.maxSnapshotFps > 0) fps = fps > 0 ? Math.min(fps, options.maxSnapshotFps) : options.maxSnapshotFps;
  return fps;
}

/**
 * Value of the `framecap` attribute (API-CONTRACT 7.1): HTML "rules for parsing non-negative integers" (leading digits, trailing junk ignored), 0 = uncapped,
 * above EXT.FRAME_CAP_MAX clamps; missing or not a non-negative integer -> `fallback`.
 * @param {string|null|undefined} value
 * @param {number} fallback  options.defaultFrameCap
 * @returns {number}
 */
export function parseFrameCap(value, fallback) {
  if (value == null) return fallback;
  const m = /^[\t\n\f\r ]*\+?(\d+)/.exec(value);
  if (!m) return fallback;
  return Math.min(Number(m[1]), EXT.FRAME_CAP_MAX);
}

/**
 * Normalises a cap passed to Scheduler.setFrameCap: NaN/negative/0 -> 0 (uncapped), otherwise rounded and clamped to [FRAME_CAP_MIN, FRAME_CAP_MAX].
 * @param {number} fps
 * @returns {number}
 */
export function clampFrameCap(fps) {
  if (!(fps >= 0.5)) return 0;
  return Math.min(Math.max(Math.round(fps), EXT.FRAME_CAP_MIN), EXT.FRAME_CAP_MAX);
}
