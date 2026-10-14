/**
 * framecap attribute -> Scheduler.setFrameCap.
 * Module: schedule (src/schedule/observers/*).
 */

import { EXT } from '../../contracts/events.js';
import { parseFrameCap } from '../frame-cap.js';

/** @typedef {import('../../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../../contracts/types.js').HicEnv} HicEnv */

/**
 * Attribute observer on the canvas; parse per API-CONTRACT 7.1 (invalid -> options.defaultFrameCap). Scheduler.setFrameCap is the single place that stores the cap,
 * so the attribute, the `frameCap` property (which writes the attribute) and direct calls all end up there. A change is effective on the next tick (the attribute observer is a microtask).
 * @param {HicEnv} env
 * @param {CanvasRecord} record
 * @returns {() => void}
 */
export function observeFrameCap(env, record) {
  const canvas = record.canvas;
  const apply = () => env.scheduler.setFrameCap(record, parseFrameCap(canvas.getAttribute(EXT.FRAME_CAP_ATTR), env.options.defaultFrameCap));
  apply();
  const mo = new /** @type {Window & typeof globalThis} */ (env.window).MutationObserver(apply);
  mo.observe(canvas, { attributes: true, attributeFilter: [EXT.FRAME_CAP_ATTR] });
  return () => mo.disconnect();
}
