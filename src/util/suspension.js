/**
 * Run `suspend` when a canvas leaves the document (state 'suspended') and `resume` when it comes back.
 * ResizeObservers use it to stop watching a detached canvas at once: a removed observed element reports a size change at depth 0, which can never be delivered in the
 * running frame, and the browser then raises the window error "ResizeObserver loop completed with undelivered notifications" (the registry's MutationObserver runs
 * before that check, in the same microtask checkpoint).
 */

import { BUS } from '../contracts/events.js';

/** @typedef {import('../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */

/**
 * @param {HicEnv} env
 * @param {CanvasRecord} record
 * @param {() => void} suspend
 * @param {() => void} resume
 * @returns {() => void} unsubscribe
 */
export function onCanvasSuspension(env, record, suspend, resume) {
  return env.bus.on(BUS.CANVAS_STATE, (/** @type {{record: CanvasRecord, state: string, previous?: string}} */ e) => {
    if (e.record !== record) return;
    if (e.state === 'suspended') suspend();
    else if (e.state === 'active' && e.previous === 'suspended') resume();
  });
}
