/**
 * Per-drawable damage tracker: union rects, epochs, generations (monotonic commits) and the reclaim of dropped results.
 * Module: snapshot-store (src/snapshot/store/*). Pure: elements are only map keys, so node:test can drive it with plain objects.
 */

import { intersectRect, unionRect } from '../../util/rect.js';

/** @typedef {import('../../contracts/types.js').DamageCause} DamageCause */
/** @typedef {import('../../contracts/types.js').Rect} Rect */

/**
 * Causes after which a build that started earlier shows a layout that no longer exists: they bump the epoch and widen to the whole drawable.
 * A 'mutation' without a rect is structural too (the observer could not bound it).
 */
const STRUCTURAL = new Set(['resize', 'dpr', 'stylesheet', 'content-attr', 'forced']);

/** Returned by reclaim() when a whole-drawable request was re-marked (null means "fully covered" there). */
export const WHOLE_RECT = Object.freeze({ x: -1e9, y: -1e9, width: 2e9, height: 2e9 });

/**
 * @typedef {Object} Tile  a taken build: rect null = whole drawable
 * @property {Rect|null} rect
 * @property {number} epoch
 * @property {string[]} causes
 */

/**
 * @typedef {Object} ElState
 * @property {number} epoch
 * @property {number} hard  epoch of the last structural cause other than a DOM 'mutation' (resize, dpr, stylesheet, ...): a whole tile older than it is dropped
 * @property {number} gen          last generation handed out
 * @property {number} lastCommitted
 * @property {boolean} takenSinceBump  an epoch bump only matters to builds taken before it
 * @property {{whole: boolean, rect: Rect|null, causes: Set<string>, since: number, scroll: Rect|null, others: Rect|null}|null} pending  `scroll` / `others`: the union of the 'scroll' rects and of every other cause's rects
 * @property {Map<number, Tile>} inflight  taken, not yet committed or reclaimed
 * @property {Array<Tile & {gen: number}>} committedTiles  kept only while an older generation is still unresolved
 */

/**
 * The parts of `r` that no rect of `covers` touches (each cover splits a piece into at most 4).
 * @param {Rect} r
 * @param {Rect[]} covers
 * @returns {Rect[]}
 */
export function subtractRects(r, covers) {
  /** @type {Rect[]} */
  let pieces = [r];
  for (const c of covers) {
    /** @type {Rect[]} */
    const next = [];
    for (const p of pieces) {
      const i = intersectRect(p, c);
      if (!i) { next.push(p); continue; }
      if (i.y > p.y) next.push({ x: p.x, y: p.y, width: p.width, height: i.y - p.y });
      if (i.y + i.height < p.y + p.height) next.push({ x: p.x, y: i.y + i.height, width: p.width, height: p.y + p.height - i.y - i.height });
      if (i.x > p.x) next.push({ x: p.x, y: i.y, width: i.x - p.x, height: i.height });
      if (i.x + i.width < p.x + p.width) next.push({ x: i.x + i.width, y: i.y, width: p.x + p.width - i.x - i.width, height: i.height });
    }
    pieces = next;
  }
  return pieces;
}

export class DamageTracker {
  constructor() {
    /** @type {WeakMap<object, ElState>} */
    this.states = new WeakMap();
  }

  /** @param {object} el @returns {ElState} */
  #state(el) {
    let s = this.states.get(el);
    if (!s) {
      s = { epoch: 1, hard: 1, gen: 0, lastCommitted: 0, takenSinceBump: false, pending: null, inflight: new Map(), committedTiles: [] };
      this.states.set(el, s);
    }
    return s;
  }

  /** @param {ElState} s @param {Rect|null} rect null = whole @param {Iterable<string>} causes @param {number} now */
  #addPending(s, rect, causes, now) {
    const p = s.pending ?? (s.pending = { whole: false, rect: null, causes: new Set(), since: now, scroll: null, others: null });
    if (rect === null) { p.whole = true; p.rect = null; } else if (!p.whole) p.rect = unionRect(p.rect, rect);
    const list = [...causes];
    for (const c of list) p.causes.add(c);
    if (rect && list.length === 1 && list[0] === 'scroll') p.scroll = unionRect(p.scroll, rect); else if (rect) p.others = unionRect(p.others, rect);
  }

  /** Mark damage; structural causes bump the epoch and widen to the whole drawable. @param {Element} el @param {Rect|null} rect @param {DamageCause} cause @param {number} now */
  mark(el, rect, cause, now) {
    const s = this.#state(el);
    const structural = STRUCTURAL.has(cause) || (cause === 'mutation' && rect === null);
    if (structural && s.takenSinceBump) { s.epoch++; s.takenSinceBump = false; }
    if (structural && cause !== 'mutation') s.hard = s.epoch;
    this.#addPending(s, structural ? null : rect, [cause], now);
  }

  /**
   * Take the pending damage for a build start and clear it. `shape` may widen/round the rect (ink margin, whole-pixel grid, full tile above 55 %);
   * the SHAPED rect is what is recorded as in flight, because that is what the tile will cover.
   * @param {Element} el
   * @param {(rect: Rect|null) => Rect|null} [shape]
   * @returns {{rect: Rect|null, epoch: number, generation: number, causes: string[]}|null}
   */
  take(el, shape) {
    const s = this.states.get(el);
    if (!s?.pending) return null;
    const raw = s.pending.whole ? null : s.pending.rect;
    const rect = shape ? shape(raw) : raw;
    const generation = ++s.gen;
    const causes = [...s.pending.causes];
    s.inflight.set(generation, { rect, epoch: s.epoch, causes });
    s.pending = null;
    s.takenSinceBump = true;
    return { rect, epoch: s.epoch, generation, causes };
  }

  /** @param {object} el @param {string} cause @returns {boolean} the pending damage includes `cause` */
  hasPendingCause(el, cause) {
    return !!this.states.get(el)?.pending?.causes.has(cause);
  }

  /**
   * Scroll damage, alone or with changes that lie inside the scrolled boxes (the rows a stationary pointer hovers as they pass under it): a build of it costs what
   * the scroll alone costs.
   * @param {object} el @param {ReadonlySet<string>} riders causes that may ride along @param {number} [slack] css px by which a rider may reach past the scrolled box (its ink margin: the tile grows by it anyway)
   * @returns {boolean}
   */
  pendingScroll(el, riders, slack = 0) {
    const p = this.states.get(el)?.pending;
    if (!p || p.whole || !p.scroll || !p.causes.has('scroll')) return false;
    for (const c of p.causes) if (c !== 'scroll' && !riders.has(c)) return false;
    const o = p.others;
    const b = p.scroll;
    return !o || (o.x >= b.x - slack && o.y >= b.y - slack && o.x + o.width <= b.x + b.width + slack && o.y + o.height <= b.y + b.height + slack);
  }

  /**
   * True when a landed result may be committed: newer than the last commit and not from before a structural change. A WHOLE tile from before a DOM mutation may stand in:
   * it is a complete picture (no seam) of a state newer than the one shown, and the pending damage rebuilds the latest state. Dropping it starved a drawable that changes size at
   * 60 Hz (a counter in proportional digits): every build was superseded before it landed and nothing was ever drawn. Resize, dpr and the other causes keep dropping it (geometry).
   * The store does not let it stand in when the paint that follows must show the DOM as it is now (requestPaint(), first paint).
   * @param {Element} el @param {number} epoch @param {number} generation @param {boolean} [standIn] the result is a whole-drawable tile that may stand in for a newer DOM state @returns {boolean}
   */
  accepts(el, epoch, generation, standIn = false) {
    const s = this.states.get(el);
    return !!s && generation > s.lastCommitted && (epoch >= s.epoch || (standIn && epoch >= s.hard));
  }

  /**
   * Invariant: EVERY dropped result re-damages its rect. A landed result rejected by accepts() may cover a region that newer, non-overlapping tiles do not (checkbox in tile 5, typed field in tile 6, tile 5 lands second).
   * Re-marks `rect` minus the rects already committed or in flight with a newer generation of the CURRENT epoch (tiles of an older epoch show a layout that is gone);
   * a whole-drawable request (rect null) is re-marked whole unless a newer whole tile exists. Also settles `generation` (it is no longer in flight).
   * Returns the rect that was re-marked (WHOLE_RECT for a whole request) or null when fully covered.
   * @param {Element} el @param {Rect|null} rect @param {number} generation @returns {Rect|null}
   */
  reclaim(el, rect, generation) {
    const s = this.states.get(el);
    if (!s) return null;
    const mine = s.inflight.get(generation);
    s.inflight.delete(generation);
    /** @type {Array<Rect|null>} */
    const newer = [];
    for (const [g, t] of s.inflight) if (g > generation && t.epoch === s.epoch) newer.push(t.rect);
    for (const t of s.committedTiles) if (t.gen > generation && t.epoch === s.epoch) newer.push(t.rect);
    this.#prune(s);
    if (newer.includes(null)) return null;
    const again = rect === null ? WHOLE_RECT : subtractRects(rect, /** @type {Rect[]} */ (newer)).reduce((acc, p) => unionRect(acc, p), /** @type {Rect|null} */ (null));
    if (!again) return null;
    this.#addPending(s, rect === null ? null : again, mine?.causes ?? ['forced'], 0);
    return again;
  }

  /** @param {Element} el @param {number} generation */
  committed(el, generation) {
    const s = this.states.get(el);
    if (!s) return;
    const t = s.inflight.get(generation);
    s.inflight.delete(generation);
    if (t) s.committedTiles.push({ gen: generation, rect: t.rect, epoch: t.epoch, causes: t.causes });
    if (generation > s.lastCommitted) s.lastCommitted = generation;
    this.#prune(s);
  }

  /** Committed tiles matter only while an older generation is still unresolved. @param {ElState} s */
  #prune(s) {
    if (!s.inflight.size) { s.committedTiles.length = 0; return; }
    const oldest = Math.min(...s.inflight.keys());
    s.committedTiles = s.committedTiles.filter((t) => t.gen > oldest);
  }

  /** @param {Element} el @returns {boolean} */
  hasPending(el) {
    return !!this.states.get(el)?.pending;
  }

  /** `now` of the first damage in the pending record, or null. @param {Element} el @returns {number|null} */
  pendingSince(el) {
    return this.states.get(el)?.pending?.since ?? null;
  }

  /** @param {Element} el */
  forget(el) {
    this.states.delete(el);
  }
}
