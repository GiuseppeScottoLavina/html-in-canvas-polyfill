/**
 * The transition logic shared by the disintegrate and shatter plugins, without GPU or DOM: the out/in timeline, the input mappers, option
 * parsing and the form-validity probe. PURE module (no state outside the objects it returns), so Node tests exercise it directly.
 * plugins/_lib/ holds runtime code that more than one plugin uses; a plugin imports it like a file of its own folder and the build
 * bundles it into each plugin (plugins/README.md).
 */

import { NO_TARGET } from '../../src/effects/no-target.js';

export { NO_TARGET };

/** The mapper of an assembled frame: the presented picture IS the source. @param {{x: number, y: number}} p */
export const identityMapper = (p) => ({ x: p.x, y: p.y });

/** The mapper of a frame where pieces are moving, dissolved or faded: no element is under the pointer (the host swallows the press). */
export const blockedMapper = () => NO_TARGET;

/** @param {unknown} v @param {number} lo @param {number} hi @param {number} fallback */
export function clampNumber(v, lo, hi, fallback) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/**
 * `#rgb`, `#rrggbb` or `[r, g, b]` (0..1) to an sRGB triple 0..1.
 * @param {unknown} value
 * @param {readonly number[]} fallback
 * @returns {number[]}
 */
export function parseColor(value, fallback) {
  if (Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return value.slice(0, 3).map((n) => Math.min(1, Math.max(0, n)));
  }
  if (typeof value === 'string') {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
    if (m) {
      const hex = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
      return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    }
  }
  return fallback.slice();
}

/**
 * @typedef {'idle'|'out'|'gone'|'hold'|'in'} Phase
 *   idle: assembled (the picture is the source, input passes); out: dissolving; gone: fully dissolved, waiting; hold: the pause of 'play'; in: reassembling
 */

/**
 * The out/in timeline. `g` is the dissolve amount: 0 assembled, 1 fully gone; it moves linearly with time (each shader eases on its own).
 * A request supersedes the previous one from the CURRENT `g`, so reversing midway is continuous. The clock starts at the first `advance`
 * after a request (the first frame that renders it), which keeps a transition the same length whatever the frame cap.
 * @param {{duration: number, hold?: number, gone?: boolean}} o  duration (ms) of a full 0 -> 1 or 1 -> 0 run; hold (ms) between out and in of 'play'
 */
export function createTimeline(o) {
  /** @type {Phase} */ let phase = o.gone ? 'gone' : 'idle';
  let g = o.gone ? 1 : 0;
  let from = g, to = g, t0 = NaN, length = 0, holdUntil = NaN;
  let duration = Math.max(1, o.duration);
  const hold = Math.max(0, o.hold ?? 0);
  let playing = false;
  /** @type {((done: boolean) => void)|null} */ let settle = null;

  /** @param {boolean} done */
  const finish = (done) => { const s = settle; settle = null; playing = false; s?.(done); };
  /** @param {0|1} target */
  const head = (target) => {
    to = target; from = g; t0 = NaN; length = duration * Math.abs(to - from);
    phase = to === 1 ? 'out' : 'in';
  };

  return {
    get phase() { return phase; },
    get g() { return g; },
    /** true while frames must be rendered without a source change (out, hold, in) */
    get animating() { return phase === 'out' || phase === 'in' || phase === 'hold'; },
    /** the frame shows the source unchanged: input maps through the identity */
    get assembled() { return phase === 'idle'; },
    /** @param {number} ms */
    setDuration(ms) { duration = Math.max(1, ms); },
    /**
     * @param {'out'|'in'|'play'} action  out: dissolve and stay gone; in: reassemble; play: out, hold, in
     * @returns {Promise<boolean>}  true when the requested end state is reached, false when superseded or cancelled
     */
    request(action) {
      finish(false);
      const promise = new Promise((resolve) => { settle = /** @type {(done: boolean) => void} */ (resolve); });
      playing = action === 'play';
      const target = action === 'in' ? 0 : 1;
      if (g === target && (phase === 'idle' || phase === 'gone')) {
        if (playing) { phase = 'hold'; holdUntil = NaN; } else finish(true);
      } else head(target);
      return promise;
    },
    /** Jump to an end state without animation (reduced work after a device loss, tests). @param {'in'|'out'} state */
    jump(state) {
      finish(false);
      g = state === 'out' ? 1 : 0; from = to = g;
      phase = g === 1 ? 'gone' : 'idle';
    },
    /** Move the clock to `now` (ms) and return g. @param {number} now @returns {number} */
    advance(now) {
      if (phase === 'hold') {
        if (Number.isNaN(holdUntil)) holdUntil = now + hold;
        if (now < holdUntil) return g;
        head(0);
        t0 = holdUntil;
      }
      if (phase !== 'out' && phase !== 'in') return g;
      if (Number.isNaN(t0)) t0 = now;
      const k = length > 0 ? Math.min(1, Math.max(0, (now - t0) / length)) : 1;
      g = from + (to - from) * k;
      if (k >= 1) {
        g = to;
        if (to === 1) {
          if (playing) { phase = 'hold'; holdUntil = NaN; return this.advance(now); }
          phase = 'gone';
          finish(true);
        } else {
          phase = 'idle';
          finish(true);
        }
      }
      return g;
    },
    cancel() { finish(false); },
  };
}

/** What counts as an invalid field after a submit: native constraint validation, ARIA, or the class many form scripts toggle. */
export const DEFAULT_INVALID_SELECTOR = ':invalid, [aria-invalid="true"], .invalid';

/**
 * The first invalid field inside `root` (the form or the drawable around it), or null. Reads the DOM; fires no event.
 * @param {Element} root
 * @param {string} selector
 * @returns {Element|null}
 */
export function findInvalid(root, selector = DEFAULT_INVALID_SELECTOR) {
  try {
    for (const el of root.querySelectorAll(selector)) if (el.localName !== 'form' && el.localName !== 'fieldset') return el;
  } catch { /* an invalid selector option: treat as "nothing invalid" */ }
  return null;
}

/**
 * A point of an element of the source, in canvas CSS px: the host stretches the source over the canvas content box.
 * @param {{left: number, top: number, width: number, height: number}} sourceRect
 * @param {{left: number, top: number, width: number, height: number}} elementRect
 * @param {{width: number, height: number}} canvasCss
 */
export function sourcePointOnCanvas(sourceRect, elementRect, canvasCss) {
  const sx = sourceRect.width > 0 ? canvasCss.width / sourceRect.width : 1;
  const sy = sourceRect.height > 0 ? canvasCss.height / sourceRect.height : 1;
  return {
    x: (elementRect.left + elementRect.width / 2 - sourceRect.left) * sx,
    y: (elementRect.top + elementRect.height / 2 - sourceRect.top) * sy,
  };
}
