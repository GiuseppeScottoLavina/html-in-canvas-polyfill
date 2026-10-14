/**
 * The frame-end phase: the tick is armed in rAF but RUNS in a ResizeObserver callback, i.e. after app rAF callbacks, style/layout and every earlier-created ResizeObserver (docs/ARCHITECTURE.md ADR-C).
 * Module: schedule (src/schedule/*).
 */

import { MARK } from '../contracts/events.js';

/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */

/**
 * @typedef {Object} FramePhase
 * @property {() => void} arm  request one frame: the rAF ARM callback puts the fixed 1 px sentinel in the page and creates a FRESH ResizeObserver on it (created after every app observer, so its callback is delivered after theirs and after the microtasks they queued)
 * @property {() => void} cancel
 * @property {() => {armed: number, ran: number, fallbacks: number}} stats
 */

const SENTINEL_STYLE = [
  ['position', 'fixed'], ['left', '0'], ['top', '0'], ['width', '1px'], ['height', '1px'], ['margin', '0'], ['padding', '0'], ['border', '0'],
  ['contain', 'strict'], ['visibility', 'hidden'], ['pointer-events', 'none'],
];

/**
 * `run(now)` is the scheduler tick; `now` is the rAF timestamp of the frame. If the RO callback of a frame did not arrive by the next rAF (no layout, unobservable sentinel),
 * that rAF runs the tick directly and counts a fallback (reported once as a `paint-timing` deviation). No timers: a watchdog rAF is requested together with the observer and cancelled by the observer callback,
 * so a normal frame leaves nothing pending.
 * The sentinel is position:fixed, contain:strict, visibility:hidden, pointer-events:none and polyfill-owned (MARK.NODE_ATTR). It stays in the page while ticks follow each other and is removed
 * when a tick ends without re-arming. It is not resized: a fresh observer reports its initial size, which is what delivers the callback.
 * @param {HicEnv} env
 * @param {(now: number) => void} run
 * @returns {FramePhase}
 */
export function createFramePhase(env, run) {
  const win = /** @type {Window & typeof globalThis} */ (env.window);
  const counts = { armed: 0, ran: 0, fallbacks: 0 };
  let wanted = false;
  let rafId = 0;
  /** @type {ResizeObserver|null} */
  let observer = null;
  let observerPending = false;
  let frameTime = 0;
  /** @type {HTMLElement|null} */
  let sentinel = null;
  let fallbackReported = false;

  function ensureSentinel() {
    if (sentinel?.isConnected) return sentinel;
    const el = env.document.createElement('div');
    el.setAttribute(MARK.NODE_ATTR, '');
    for (const [prop, value] of SENTINEL_STYLE) el.style.setProperty(prop, value);
    (env.document.documentElement ?? env.document.body).appendChild(el);
    sentinel = el;
    return el;
  }

  function removeSentinel() {
    sentinel?.remove();
    sentinel = null;
  }

  function dropObserver() {
    observer?.disconnect();
    observer = null;
    observerPending = false;
    if (rafId) win.cancelAnimationFrame(rafId);
    rafId = 0;
  }

  /** @param {number} now */
  function deliver(now) {
    dropObserver();
    wanted = false;
    counts.ran++;
    try {
      run(now);
    } catch (err) {
      env.reporter.caught(err, 'schedule.run');
    } finally {
      if (!wanted) removeSentinel();
    }
  }

  /** @param {number} ts */
  function onFrame(ts) {
    rafId = 0;
    if (!wanted) return;
    if (observerPending) {
      counts.fallbacks++;
      if (!fallbackReported) {
        fallbackReported = true;
        env.reporter.deviation('paint-timing', 'frame-end phase fell back to the rAF phase: the sentinel observer was not delivered in its frame');
      }
      deliver(ts);
      return;
    }
    counts.armed++;
    frameTime = ts;
    observer = new win.ResizeObserver(() => {
      if (observerPending) deliver(frameTime);
    });
    observer.observe(ensureSentinel());
    observerPending = true;
    rafId = win.requestAnimationFrame(onFrame);
  }

  return {
    arm() {
      if (wanted) return;
      wanted = true;
      rafId = win.requestAnimationFrame(onFrame);
    },
    cancel() {
      wanted = false;
      dropObserver();
      removeSentinel();
    },
    stats: () => ({ ...counts }),
  };
}
