/**
 * Starts the per-canvas observers when a canvas is mounted and stops them on unmount; global observers once.
 * Module: schedule (src/schedule/observers/*).
 */

import { BUS } from '../../contracts/events.js';
import { installAnimationHooks, observeAnimations } from './animation-observer.js';
import { observeChildCanvases } from './canvas-child-observer.js';
import { observeDpr } from './dpr-observer.js';
import { observeFrameCap } from './framecap-observer.js';
import { observeInput } from './input-observer.js';
import { observeMutations } from './mutation-observer.js';
import { observeCanvasResize } from './resize-observer.js';
import { observeScroll } from './scroll-observer.js';
import { observeStylesheets } from './stylesheet-observer.js';
import { observeVideos } from './video-observer.js';

/** @typedef {import('../../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../../contracts/types.js').InteractionTracker} InteractionTracker */
/** @typedef {import('../../contracts/types.js').PatchLedger} PatchLedger */
/** @typedef {import('./interaction-tracker.js').TrackerControl} TrackerControl */

/** Per-canvas observers, started in this order. */
const PER_CANVAS = [observeFrameCap, observeCanvasResize, observeMutations, observeScroll, observeInput, observeAnimations, observeVideos];

/**
 * Subscribes to BUS.CANVAS_MOUNTED/UNMOUNTING; returns the disposer. Every observer publishes damage ONLY through env.scheduler.damage. Canvases that are already active are started at once.
 * `ledger` (third argument, optional) lets the stylesheet observer wrap CSSStyleSheet/CSSStyleDeclaration methods (and adoptedStyleSheets) and the animation hooks wrap element.animate / animation.play; without it only <style>/<link> mutations, load events and fonts are watched.
 * One observer failing to start is reported and does not stop the others.
 * @param {HicEnv} env
 * @param {InteractionTracker} tracker  also driven through its attach/detach when it is a TrackerControl
 * @param {PatchLedger} [ledger]
 * @returns {() => void}
 */
export function startObservers(env, tracker, ledger) {
  const control = /** @type {Partial<TrackerControl>} */ (tracker);
  /** @type {Map<CanvasRecord, Array<() => void>>} */
  const running = new Map();
  /** @type {Array<() => void>} */
  const globals = [];

  /** @param {string} what @param {() => () => void} start @returns {() => void} */
  function safely(what, start) {
    try {
      return start();
    } catch (err) {
      env.reporter.caught(err, `observers.${what}`);
      return () => {};
    }
  }

  /** @param {CanvasRecord} record */
  function begin(record) {
    if (running.has(record) || !record.layer) return;
    const stops = PER_CANVAS.map((observe) => safely(observe.name, () => observe(env, record)));
    stops.push(safely('tracker.attach', () => {
      control.attach?.(record);
      return () => control.detach?.(record);
    }));
    running.set(record, stops);
  }

  /** @param {CanvasRecord} record */
  function end(record) {
    const stops = running.get(record);
    if (!stops) return;
    running.delete(record);
    for (const stop of stops.reverse()) stop();
  }

  globals.push(safely('dpr', () => observeDpr(env)));
  if (ledger) globals.push(safely('stylesheets', () => observeStylesheets(env, ledger)), safely('canvas-children', () => observeChildCanvases(env, ledger)), safely('animation-hooks', () => installAnimationHooks(env, ledger)));
  globals.push(env.bus.on(BUS.CANVAS_MOUNTED, (/** @type {{record: CanvasRecord}} */ e) => begin(e.record)));
  globals.push(env.bus.on(BUS.CANVAS_UNMOUNTING, (/** @type {{record: CanvasRecord}} */ e) => end(e.record)));
  for (const record of env.registry.all()) if (record.state === 'active') begin(record);

  return () => {
    for (const record of [...running.keys()]) end(record);
    for (const stop of globals.reverse()) stop();
    control.dispose?.();
  };
}
