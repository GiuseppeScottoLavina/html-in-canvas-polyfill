/**
 * Scroll compositor, store side. A scroll step of an eligible scroller (snapshot/capture/scroll-pages.js) is shown in the very next rendering update without a build:
 * the scrollport of the retained surface is composed from cached PAGES (the port rendered at other offsets, pinned sticky elements hidden) shifted by whole surface
 * pixels, then every pinned element is drawn from its own tile at its live position. A rounded scrollport is composed inside its rounded clip, over a BACKDROP tile
 * (the scroller without its content), from pages and pins rendered with square corners. Pages are built ahead in the post-frame pump (side builds), from the moment
 * the scroller is seen (the pointer over it, or its first scroll event). The snapshot stays the authority: a tile always lands when the scrolling stops.
 *
 * Validity, per scroller: damage that does not reach into the scroller's content box (a counter elsewhere in the drawable) leaves its pages as they are; damage
 * inside the content box (a :hover row, a row updated by script) marks that part of every page captured before it DIRTY; damage that crosses the scroller's edge,
 * has no rect, or touches a pinned element drops the cache. A dirty part is never composed: the step falls back to the plain path, whose tile repairs the pages
 * (its pixels are copied into them), and a page that stays dirty where it is needed is rebuilt. Damage inside the visible port is checked for an obstruction (an
 * element outside the scroller over the port, which a page must not carry) before the next composition. Everything the plan cannot vouch for keeps the plain path.
 * Module: snapshot-store (src/snapshot/store/*).
 */

import { intersectRect } from '../../util/rect.js';
import { subtractRects } from './damage.js';

/** @typedef {import('../../contracts/types.js').Rect} Rect */
/** @typedef {import('../../contracts/types.js').ScrollPlan} ScrollPlan */
/** @typedef {import('./pump.js').Entry} Entry */
/** @typedef {import('./pump.js').Geometry} Geometry */
/** @typedef {HTMLCanvasElement|OffscreenCanvas} Surface */
/** @typedef {{el: Element, top: number, hide: Element[], bars?: 'track'|'thumb', shape?: 'square'|'backdrop', memo?: Map<Element, import('../../contracts/types.js').TailMemo>}} PageRequest */

/** pages kept per scroller (each one scrollport of surface pixels) */
const MAX_PAGES = 4;
/** scrollers with a cache per drawable */
const MAX_SCROLLERS = 2;
/** a refused scroller is planned again only after newer damage and at most this often (a scan of its subtree, a hit-test grid) */
const REPLAN_MS = 1000;
/** consecutive steps a needed page may stay dirty before it is rebuilt instead of waiting for a tile to repair it */
const MAX_MISSES = 2;

/**
 * @typedef {Object} Page
 * @property {number} top  scrollTop the page was rendered at (whole surface pixels)
 * @property {Surface|null} pad  null while it is being built
 * @property {number|null} seq  damage sequence number when its capture read the DOM (null: not captured yet)
 * @property {Rect[]} dirty  stale parts, CONTENT pixels (x: surface px; y: surface px from the scroll origin, i.e. port row + round(offset * scale))
 * @property {number[]} dirtySeq  the damage sequence number of each dirty rect
 * @property {number} misses  steps in a row that needed a dirty part of this page
 */

/**
 * @typedef {Object} Cache  one scroller of one drawable
 * @property {Element} el
 * @property {Geometry} geo
 * @property {ScrollPlan} plan
 * @property {Rect} portPx  the scrollport in surface pixels (snapped)
 * @property {Page[]} pages
 * @property {Map<Element, {pad: Surface|null, w: number, h: number}>} pins
 * @property {{track: {pad: Surface|null, px: Rect}, thumb: {pad: Surface|null, px: Rect, top: number}}|null} bar  classic bar tiles: the track (thumb hidden) and the thumb alone, captured at offset `top`
 * @property {{pad: Surface|null, px: Rect}|null} backdrop  a rounded scroller: its padding box (port and classic bar) without the content (border, background, what is behind the corners)
 * @property {Rect[]} corners  a rounded scroller: the corner squares of its padding box, surface px (the curve and its antialiasing lie inside them)
 * @property {number|null} shown  scrollTop the surface's scrollport shows (null = not known to be one offset)
 * @property {boolean} queued  a composition was promised to the next commit
 * @property {number} last  previous live scrollTop seen (direction of the next page)
 * @property {Rect[]} unverified  damage rects inside the visible port (frame css) not yet checked for an obstruction
 * @property {Map<Element, import('../../contracts/types.js').TailMemo>} memo  layout the page builds measured once (CaptureRequest.scroll.memo); emptied by every change of the content
 */

/**
 * @typedef {Object} ComposeDeps
 * @property {(scroller: Element, drawable: Element) => ScrollPlan|null|Iterator<void, ScrollPlan|null, void>} plan  a plan, or the steps that produce it (one post-frame task each)
 * @property {(entry: Entry, rectCss: Rect, geo: Geometry, scroll: PageRequest) => string|null} capture  data: URL of a crop, null on failure
 * @property {(url: string) => Promise<HTMLImageElement>} decode
 * @property {(w: number, h: number) => Surface} canvas
 * @property {(entry: Entry, run: () => void) => void} schedule  queue a side build for the post-frame pump
 * @property {() => number} [now]
 */

/**
 * css rect of the drawable frame -> whole surface pixels, each edge snapped as the image snaps it: to the nearest surface pixel (an image laid out at device scale), or,
 * with `grid` (ScrollPlan.grid, css px), to the nearest multiple of the grid in the image's layout coordinates (frame + ink) and then scaled (WebKit lays the image out
 * at css scale and snaps every box edge to whole css px before its transform scales it).
 * @param {Rect} r @param {Geometry} geo @param {number} [grid]
 * @returns {Rect}
 */
export function snapPx(r, geo, grid) {
  const s = geo.scale;
  if (grid) {
    const g = (/** @type {number} */ v) => Math.round(v / grid) * grid * s;
    const gx = g(r.x + geo.ink.left), gy = g(r.y + geo.ink.top);
    return { x: gx, y: gy, width: g(r.x + r.width + geo.ink.left) - gx, height: g(r.y + r.height + geo.ink.top) - gy };
  }
  const x0 = Math.round((r.x + geo.ink.left) * s);
  const y0 = Math.round((r.y + geo.ink.top) * s);
  return { x: x0, y: y0, width: Math.round((r.x + r.width + geo.ink.left) * s) - x0, height: Math.round((r.y + r.height + geo.ink.top) * s) - y0 };
}

/** @param {Rect} r @param {Geometry} geo @param {number} [grid] see snapPx @returns {Rect} css rect of the drawable frame -> surface pixels, rounded out (to the grid) */
const outPx = (r, geo, grid) => {
  const s = geo.scale;
  if (grid) {
    const x0 = Math.floor((r.x + geo.ink.left) / grid) * grid * s, y0 = Math.floor((r.y + geo.ink.top) / grid) * grid * s;
    return { x: x0, y: y0, width: Math.ceil((r.x + r.width + geo.ink.left) / grid) * grid * s - x0, height: Math.ceil((r.y + r.height + geo.ink.top) / grid) * grid * s - y0 };
  }
  const x0 = Math.floor((r.x + geo.ink.left) * s);
  const y0 = Math.floor((r.y + geo.ink.top) * s);
  return { x: x0, y: y0, width: Math.ceil((r.x + r.width + geo.ink.left) * s) - x0, height: Math.ceil((r.y + r.height + geo.ink.top) * s) - y0 };
};

/**
 * PURE. The surface row of scroll offset `top`: the offset the image renders, in surface pixels. Without a grid, the nearest surface pixel (Chromium renders a
 * fractional offset); with one, the nearest multiple of the grid (WebKit renders a scroll offset at whole css px: a page asked at 133.333 shows 133, one at 133.5
 * shows 134, measured in Mobile Safari 26.4 at DPR 3).
 * @param {number} top css px @param {number} s scale @param {number} [grid] css px
 * @returns {number}
 */
export function rowOf(top, s, grid) {
  return grid ? Math.round(top / grid) * grid * s : Math.round(top * s);
}

/** @param {Rect} px @param {Geometry} geo @returns {Rect} surface pixels -> css rect of the drawable frame */
const toCss = (px, geo) => ({ x: px.x / geo.scale - geo.ink.left, y: px.y / geo.scale - geo.ink.top, width: px.width / geo.scale, height: px.height / geo.scale });

/** @param {Rect} a @param {Rect} b */
const sameRect = (a, b) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;

/** @param {Rect} a @param {Rect} b */
const meets = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** @param {Rect} outer @param {Rect} inner */
const holds = (outer, inner) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

/** @param {ScrollPlan} plan @returns {Rect} the scroller's padding box: the port and a classic vertical bar's gutter */
const paddingBox = (plan) => (plan.bar ? { ...plan.port, width: plan.port.width + plan.bar.gutter.width } : plan.port);

/** @param {Geometry} a @param {Geometry} b */
const sameGeo = (a, b) => a.scale === b.scale && a.widthPx === b.widthPx && a.heightPx === b.heightPx && a.ink.left === b.ink.left && a.ink.top === b.ink.top;

/** @param {Element} el @returns {number} */
const topOf = (el) => /** @type {HTMLElement} */ (el).scrollTop;

/**
 * PURE. Does a set of pages cover the scrollport at `top`? Rows are surface pixels; a page at `p` shows port row j at view row j + rowOf(p) - rowOf(top).
 * @param {number[]} tops @param {number} top @param {number} rows port height in surface pixels @param {number} s @param {number} [grid] see rowOf
 * @returns {boolean}
 */
export function covers(tops, top, rows, s, grid) {
  const base = rowOf(top, s, grid);
  const spans = tops.map((p) => rowOf(p, s, grid) - base).map((off) => [Math.max(0, off), Math.min(rows, off + rows)]).filter(([a, b]) => b > a).sort((u, v) => u[0] - v[0]);
  let reach = 0;
  for (const [a, b] of spans) {
    if (a > reach) return false;
    reach = Math.max(reach, b);
  }
  return reach >= rows;
}

/**
 * PURE. The corner squares of a rounded port (surface px, one pixel of antialiasing margin), clipped to the port.
 * @param {Rect} portPx @param {NonNullable<ScrollPlan['round']>} round inner radii, css px @param {number} s
 * @returns {Rect[]}
 */
export function cornerSquares(portPx, round, s) {
  const { x, y, width: w, height: h } = portPx;
  const size = (/** @type {{x: number, y: number}} */ r) => ({ w: Math.min(w, Math.ceil(r.x * s) + 1), h: Math.min(h, Math.ceil(r.y * s) + 1) });
  const tl = size(round.tl), tr = size(round.tr), br = size(round.br), bl = size(round.bl);
  return [
    { x, y, width: tl.w, height: tl.h }, { x: x + w - tr.w, y, width: tr.w, height: tr.h },
    { x: x + w - br.w, y: y + h - br.h, width: br.w, height: br.h }, { x, y: y + h - bl.h, width: bl.w, height: bl.h },
  ].filter((r) => r.width > 1 && r.height > 1);
}

/** @param {ComposeDeps} deps */
export function createScrollCompositor(deps) {
  const now = deps.now ?? (() => performance.now());
  /** @type {WeakMap<Entry, Map<Element, Cache>>} */
  const caches = new WeakMap();
  /** @type {WeakMap<Entry, Map<Element, {at: number, seq: number}>>} scrollers without a plan: planned again after newer damage, at most every REPLAN_MS */
  const refused = new WeakMap();
  /** @type {WeakMap<Entry, Set<Element>>} scrollers of a drawable whose plan waits for the pump */
  const planning = new WeakMap();
  /** @type {WeakMap<Entry, number>} side builds in flight per drawable */
  const inFlight = new WeakMap();
  /** damage sequence: pages, dirty parts and tiles are ordered by it */
  let seq = 0;
  /** diagnostics (SnapshotStats.scroll) */
  const counters = { plans: 0, refusals: 0, pages: 0, pins: 0, failed: 0, composed: 0, fallbacks: 0, dropped: 0, droppedGeometry: 0, kept: 0, dirtied: 0, patched: 0, dirtyMisses: 0, obstructed: 0 };

  /** @param {Entry} entry @returns {Map<Element, Cache>} */
  const mapOf = (entry) => {
    let m = caches.get(entry);
    if (!m) caches.set(entry, (m = new Map()));
    return m;
  };

  /** @param {Entry} entry @param {number} d */
  const track = (entry, d) => inFlight.set(entry, (inFlight.get(entry) ?? 0) + d);

  /**
   * Build a crop and keep it as pixels in `slot.pad` if the cache is still the current one when it lands.
   * @param {Entry} entry @param {Cache} cache @param {Rect} px @param {PageRequest} scroll @param {{pad: Surface|null, seq?: number|null}} slot
   */
  function build(entry, cache, px, scroll, slot) {
    deps.schedule(entry, () => {
      if (mapOf(entry).get(cache.el) !== cache) return;
      if ('seq' in slot) slot.seq = seq;
      const url = deps.capture(entry, toCss(px, cache.geo), cache.geo, scroll);
      if (!url) { counters.failed++; drop(entry, cache); return; }
      if ('seq' in slot) counters.pages++; else counters.pins++;
      track(entry, 1);
      deps.decode(url).then((img) => {
        if (mapOf(entry).get(cache.el) === cache) {
          const pad = deps.canvas(px.width, px.height);
          /** @type {CanvasRenderingContext2D} */ (pad.getContext('2d')).drawImage(img, 0, 0, px.width, px.height);
          slot.pad = pad;
        }
        img.src = '';
      }, () => drop(entry, cache)).finally(() => track(entry, -1));
    });
  }

  /** @param {Entry} entry @param {Cache} cache */
  function drop(entry, cache) {
    const m = mapOf(entry);
    if (m.get(cache.el) === cache) m.delete(cache.el);
  }

  /** @param {Cache} c @returns {boolean} the live scroller still has the layout the plan read (fake scrollers of the unit tests have none to check) */
  function sameLayout(c) {
    const h = /** @type {HTMLElement} */ (c.el);
    if (typeof h.scrollHeight !== 'number') return true;
    const client = c.plan.client ?? c.plan.port;
    return Math.abs(h.scrollHeight - c.plan.scrollHeight) < 0.5 && Math.abs(h.clientHeight - client.height) < 0.5 && Math.abs(h.clientWidth - client.width) < 0.5;
  }

  /** @param {Entry} entry @param {Element} el @returns {boolean} a refusal of `el` still stands (no damage since, or too recent) */
  function stillRefused(entry, el) {
    const no = refused.get(entry)?.get(el);
    return !!no && (no.seq === seq || now() - no.at < REPLAN_MS);
  }

  /** @param {Entry} entry @param {Element} el @param {ScrollPlan|null} plan @returns {Cache|null} */
  function install(entry, el, plan) {
    const m = mapOf(entry);
    m.delete(el);
    const geo = /** @type {Geometry} */ (entry.geo);
    const refuse = () => {
      counters.refusals++;
      let r = refused.get(entry);
      if (!r) refused.set(entry, (r = new Map()));
      r.set(el, { at: now(), seq });
      return null;
    };
    if (!plan) return refuse();
    refused.get(entry)?.delete(el);
    const grid = plan.grid;
    // a grid that is not a whole number of surface pixels (WebKit with a reduced or fractional scale) cannot be shifted by whole pixels
    if (grid && !Number.isInteger(grid * geo.scale)) return refuse();
    const portPx = snapPx(plan.port, geo, grid);
    if (portPx.width <= 0 || portPx.height <= 0) return null;
    const live = topOf(el);
    const round = plan.round ?? null;
    // a rounded port on a grid (WebKit) is composed source-over (compose()): exact over opaque pages only
    if (round && grid && !plan.opaque) return refuse();
    const shape = round ? /** @type {const} */ ('square') : undefined;
    const padPx = snapPx(paddingBox(plan), geo, grid);
    /** @type {Cache} */
    const cache = {
      el, geo, plan, portPx, pages: [], pins: new Map(), bar: null, backdrop: round ? { pad: null, px: padPx } : null, corners: round ? cornerSquares(padPx, round, geo.scale) : [],
      shown: null, queued: false, last: live, unverified: [], memo: new Map(),
    };
    if (plan.bar) {
      const b = plan.bar;
      const trackPx = snapPx(b.gutter, geo, grid);
      const thumbPx = snapPx({ x: b.gutter.x + b.thumbX, y: b.gutter.y + b.thumbY(live), width: b.thumbW, height: b.thumbH }, geo, grid);
      cache.bar = { track: { pad: null, px: trackPx }, thumb: { pad: null, px: thumbPx, top: live } };
      build(entry, cache, trackPx, { el, top: live, hide: [], bars: 'track', shape }, cache.bar.track);
      build(entry, cache, thumbPx, { el, top: live, hide: [], bars: 'thumb', shape }, cache.bar.thumb);
    }
    if (cache.backdrop) build(entry, cache, padPx, { el, top: live, hide: [], shape: 'backdrop' }, cache.backdrop);
    for (const p of plan.pinned) {
      const r = entry.record.layer?.frameRect(p);
      if (!r) return null;
      const px = snapPx(r, geo, grid);
      const port = portPx;
      // one device pixel of slack at each edge: the pinned box and the port are snapped each on its own (a 398.4 px header at DPR 1.25 came out 499 px wide in a
      // 498 px port); compose() clips every pinned tile to the port
      if (px.x < port.x - 1 || px.y < port.y - 1 || px.x + px.width > port.x + port.width + 1 || px.y + px.height > port.y + port.height + 1) return refuse();
      const slot = { pad: /** @type {Surface|null} */ (null), w: px.width, h: px.height };
      cache.pins.set(p, slot);
      build(entry, cache, px, { el, top: live, hide: [], shape }, slot);
    }
    if (m.size >= MAX_SCROLLERS) m.delete(/** @type {Element} */ (m.keys().next().value));
    m.set(el, cache);
    return cache;
  }

  /**
   * Pages on a grid of one port height (page k renders the port at k * P, the last one at maxTop): the pages under the port at `top`, one more in the scrolling direction
   * and half a port behind, nearest first. At most MAX_PAGES are kept; the farthest from `top` is evicted.
   * @param {Entry} entry @param {Cache} cache @param {number} top
   */
  function prefetch(entry, cache, top) {
    const s = cache.geo.scale;
    const P = cache.portPx.height / s;
    const dir = top >= cache.last ? 1 : -1;
    cache.last = top;
    const grid = cache.plan.grid;
    // an offset the image renders exactly: a whole surface pixel, or a multiple of the grid (rowOf)
    const at = (/** @type {number} */ k) => { const t = Math.min(cache.plan.maxTop, Math.max(0, k * P)); return grid ? Math.round(t / grid) * grid : Math.round(t * s) / s; };
    const lo = Math.floor((top - (dir > 0 ? P / 2 : P)) / P);
    const hi = Math.floor((top + P + (dir > 0 ? P : P / 2)) / P);
    const want = [];
    for (let k = Math.max(0, lo); k <= hi; k++) want.push(at(k));
    want.sort((a, b) => Math.abs(a - top) - Math.abs(b - top));
    for (const t of [...new Set(want)]) {
      if (cache.pages.some((p) => p.top === t)) continue;
      if (cache.pages.length >= MAX_PAGES) {
        let far = 0;
        for (let i = 1; i < cache.pages.length; i++) if (Math.abs(cache.pages[i].top - top) > Math.abs(cache.pages[far].top - top)) far = i;
        if (Math.abs(cache.pages[far].top - top) <= Math.abs(t - top)) continue;
        cache.pages.splice(far, 1);
      }
      /** @type {Page} */
      const page = { top: t, pad: null, seq: null, dirty: [], dirtySeq: [], misses: 0 };
      cache.pages.push(page);
      build(entry, cache, cache.portPx, { el: cache.el, top: t, hide: cache.plan.pinned, shape: cache.backdrop ? 'square' : undefined, memo: cache.memo }, page);
    }
  }

  /**
   * The pages that compose the port at `top`, farthest first (nearer pages are drawn over them), or null when the clean, decoded pages do not cover it. A page that
   * is needed and dirty is left out; one that stayed so for MAX_MISSES steps is dropped (the next prefetch rebuilds it).
   * @param {Cache} c @param {number} top @param {boolean} count  count the misses (a real step, not a readiness probe)
   * @returns {Page[]|null}
   */
  function usable(c, top, count) {
    for (const pin of c.pins.values()) if (!pin.pad) return null;
    if (c.bar && (!c.bar.track.pad || !c.bar.thumb.pad)) return null;
    if (c.backdrop && !c.backdrop.pad) return null;
    const s = c.geo.scale;
    const grid = c.plan.grid;
    const R = c.portPx;
    const base = rowOf(top, s, grid);
    /** @type {Page[]} */
    const clean = [];
    for (const p of [...c.pages]) {
      if (!p.pad) continue;
      const off = rowOf(p.top, s, grid) - base;
      const y0 = Math.max(0, off), y1 = Math.min(R.height, off + R.height);
      if (y1 <= y0) continue;
      const need = { x: R.x, y: base + y0, width: R.width, height: y1 - y0 };
      if (p.dirty.some((d) => meets(d, need))) {
        if (count && ++p.misses > MAX_MISSES) { c.pages.splice(c.pages.indexOf(p), 1); counters.dirtyMisses++; }
        continue;
      }
      if (count) p.misses = 0;
      clean.push(p);
    }
    if (!covers(clean.map((p) => p.top), top, R.height, s, grid)) return null;
    return clean.sort((a, b) => Math.abs(b.top - top) - Math.abs(a.top - top));
  }

  /**
   * Damage inside the visible port could be an element outside the scroller drawn over it (a page would carry it along); the plan's hit test says. A plan without
   * one (unit tests) trusts the rects.
   * @param {Entry} entry @param {Cache} c @returns {boolean} no obstruction
   */
  function verified(entry, c) {
    if (!c.unverified.length) return true;
    const rects = c.unverified.splice(0);
    if (!c.plan.clear || c.plan.clear(rects)) return true;
    counters.obstructed++;
    drop(entry, c);
    return false;
  }

  return {
    /**
     * A scroll event of `scroller` (inside the drawable of `entry`): prefetch; true when the next commit can show the live offset by composition (the caller then
     * skips the build and asks for the exact tile once the scrolling stops). A scroller without a plan is planned in the next post-frame pump.
     * @param {Entry} entry @param {Element} scroller @returns {boolean}
     */
    serve(entry, scroller) {
      if (!entry.surface || !entry.geo || !entry.version || entry.lost) return false;
      const known = mapOf(entry).get(scroller);
      if (!known || !sameGeo(known.geo, entry.geo) || !sameLayout(known)) { this.prepare(entry, scroller); return false; }
      const top = topOf(scroller);
      prefetch(entry, known, top);
      if (!usable(known, top, false)) return false;
      known.queued = true;
      return true;
    },

    /**
     * `scroller` was seen (the pointer is over it, or it scrolled, or its scrolling settled): plan it and build its first pages in the post-frame pump (side builds,
     * never inside a frame), so its next scroll steps can be composed.
     * @param {Entry} entry @param {Element} scroller
     */
    prepare(entry, scroller) {
      if (!entry.surface || !entry.geo || entry.lost) return;
      const known = mapOf(entry).get(scroller);
      if (known && sameGeo(known.geo, entry.geo) && sameLayout(known)) return;
      let set = planning.get(entry);
      if (!set) planning.set(entry, (set = new Set()));
      if (set.has(scroller) || stillRefused(entry, scroller)) return;
      set.add(scroller);
      counters.plans++;
      /** @param {Iterator<void, ScrollPlan|null, void>|null} steps */
      const step = (steps) => deps.schedule(entry, () => {
        if (!entry.surface || !entry.geo || entry.lost || scroller.isConnected === false) { set.delete(scroller); return; }
        const got = steps ?? deps.plan(scroller, entry.el);
        /** @type {ScrollPlan|null} */
        let plan;
        if (got && typeof (/** @type {any} */ (got).next) === 'function') {
          const it = /** @type {Iterator<void, ScrollPlan|null, void>} */ (got);
          const r = it.next();
          if (!r.done) { step(it); return; }
          plan = r.value;
        } else plan = /** @type {ScrollPlan|null} */ (got);
        set.delete(scroller);
        const c = install(entry, scroller, plan);
        if (c) prefetch(entry, c, topOf(scroller));
      });
      step(null);
    },

    /** @param {Entry} entry @returns {boolean} a composition waits for the next commit */
    queued(entry) {
      for (const c of caches.get(entry)?.values() ?? []) if (c.queued) return true;
      return false;
    },

    /** @param {Entry} entry @returns {boolean} side builds of the drawable are decoding */
    busy: (entry) => (inFlight.get(entry) ?? 0) > 0,

    /** @returns {number} the damage sequence number (a build records it: its tile shows every change up to it) */
    seq: () => seq,

    /**
     * Damage of the drawable (any cause but a caret blink): what it means for each composed scroller. See the file comment.
     * @param {Entry} entry @param {Rect|null} rect @param {string} cause
     */
    damaged(entry, rect, cause) {
      const m = caches.get(entry);
      const n = ++seq;
      for (const c of [...(m?.values() ?? [])]) {
        // its own scrolling (a step that was not composed)
        if (cause === 'scroll' && rect && sameRect(c.plan.frame, rect)) continue;
        // no rect, or one that covers the whole scroller: the scroller itself (or an ancestor) changed, every page may be stale
        if (!rect || holds(rect, c.plan.frame)) { counters.dropped++; drop(entry, c); continue; }
        const top = topOf(c.el);
        const P = c.plan.port;
        const content = intersectRect(rect, { x: P.x, y: P.y - top, width: P.width, height: Math.max(c.plan.scrollHeight, P.height) });
        // pages hold scrollport pixels only: a change that reaches none of the content (a counter beside the list) leaves them as they are
        if (!content) { counters.kept++; continue; }
        // inside the content box: CONTENT pixels of the change, for every page that read the DOM before it (damage rects carry an ink margin; the part outside
        // the content box is none of the pages' business, the scroller clips its content to the port)
        c.memo.clear();
        const px = outPx(content, c.geo, c.plan.grid);
        const d = { x: px.x, y: px.y - c.portPx.y + rowOf(top, c.geo.scale, c.plan.grid), width: px.width, height: px.height };
        for (const p of c.pages) if (p.seq !== null) { p.dirty.push(d); p.dirtySeq.push(n); }
        const visible = intersectRect(rect, P);
        if (visible) c.unverified.push(visible);
        // a pinned element the change reaches is rendered again (no composition until its tile is back)
        for (const [el, pin] of c.pins) {
          const r = entry.record.layer?.frameRect(el);
          if (r && meets(r, rect)) { pin.pad = null; build(entry, c, snapPx(r, c.geo, c.plan.grid), { el: c.el, top, hide: [], shape: c.backdrop ? 'square' : undefined }, pin); }
        }
        counters.dirtied++;
      }
    },

    /**
     * A tile was drawn into `surface`: it shows the scrollport at the offset the build read (`top`, null when unknown) if it covers the port, else the port is mixed.
     * Its pixels are exact for every change before its build (`tileSeq`): they repair the dirty parts of the pages they cover (pinned elements and rounded corners
     * excepted: a page has neither).
     * @param {Entry} entry @param {Rect} cropPx @param {number|null} top @param {Element|null} scroller @param {number|null} tileSeq @param {Surface|null} surface
     */
    tileLanded(entry, cropPx, top, scroller, tileSeq, surface) {
      for (const c of caches.get(entry)?.values() ?? []) {
        const p = c.portPx;
        const inside = cropPx.x <= p.x && cropPx.y <= p.y && cropPx.x + cropPx.width >= p.x + p.width && cropPx.y + cropPx.height >= p.y + p.height;
        const touches = cropPx.x < p.x + p.width && cropPx.x + cropPx.width > p.x && cropPx.y < p.y + p.height && cropPx.y + cropPx.height > p.y;
        if (inside) c.shown = scroller === c.el ? top : topOf(c.el);
        else if (touches) c.shown = null;
        if (scroller === c.el && top !== null && tileSeq !== null && surface && touches) repair(entry, c, cropPx, top, tileSeq, surface);
      }
    },

    /**
     * Compose every cached scroller whose port does not show its live offset (promised, or a tile drew another offset). Returns the css rects written, and the frames of
     * the scrollers that were promised but cannot be composed (the caller damages them: the plain path takes over).
     * @param {Entry} entry @param {() => Surface|null} surfaceOf  the writable surface (asked only when a composition happens)
     * @returns {{dirty: Rect[], fallback: Rect[]}}
     */
    step(entry, surfaceOf) {
      /** @type {Rect[]} */ const dirty = [];
      /** @type {Rect[]} */ const fallback = [];
      for (const c of [...(caches.get(entry)?.values() ?? [])]) {
        const promised = c.queued;
        c.queued = false;
        if (!entry.geo || !sameGeo(c.geo, entry.geo) || !sameLayout(c)) { counters.droppedGeometry++; drop(entry, c); if (promised) fallback.push(c.plan.frame); continue; }
        const top = topOf(c.el);
        if (c.shown === top) continue;
        const pages = verified(entry, c) ? usable(c, top, true) : null;
        const surface = pages ? surfaceOf() : null;
        if (!pages || !surface || !compose(entry, c, surface, top, pages)) {
          if (promised || c.shown !== null) { fallback.push(c.plan.frame); counters.fallbacks++; }
          continue;
        }
        counters.composed++;
        c.shown = top;
        dirty.push(c.plan.bar ? { ...c.plan.port, width: c.plan.port.width + c.plan.bar.gutter.width } : c.plan.port);
      }
      return { dirty, fallback };
    },

    /** @param {Entry} entry @returns {Element[]} scrollers with a cache (the pump records their offsets per build) */
    scrollers: (entry) => [...(caches.get(entry)?.keys() ?? [])],

    stats: () => ({ ...counters }),

    /** @param {Entry} entry */
    forget(entry) {
      caches.delete(entry);
      refused.delete(entry);
      planning.delete(entry);
    },
  };

  /**
   * Copy the parts of a landed tile that repair dirty page pixels. The tile shows content pixel row y at surface row y - base(top) + port.y. A pinned element may
   * have moved by as much as the scroll offset changed since the tile's build: its rect, grown by that, is left out.
   * @param {Entry} entry @param {Cache} c @param {Rect} cropPx @param {number} top @param {number} tileSeq @param {Surface} surface
   */
  function repair(entry, c, cropPx, top, tileSeq, surface) {
    const s = c.geo.scale;
    const R = c.portPx;
    const crop = intersectRect(cropPx, R);
    if (!crop) return;
    /** @type {Rect[]} */
    const out = [...c.corners];
    const drift = Math.ceil(Math.abs(topOf(c.el) - top) * s) + 1;
    for (const el of c.pins.keys()) {
      const r = entry.record.layer?.frameRect(el);
      if (!r) return;
      const px = outPx(r, c.geo, c.plan.grid);
      out.push({ x: px.x, y: px.y - drift, width: px.width, height: px.height + 2 * drift });
    }
    const base = rowOf(top, s, c.plan.grid);
    const shift = base - R.y;
    /** @type {Rect[]} tile pixels that are content, in content pixels */
    const good = subtractRects(crop, out).map((r) => ({ ...r, y: r.y + shift }));
    for (const p of c.pages) {
      if (!p.pad || !p.dirty.length) continue;
      const ctx = /** @type {CanvasRenderingContext2D} */ (p.pad.getContext('2d'));
      const pb = rowOf(p.top, s, c.plan.grid);
      /** @type {Rect[]} */ const keep = [];
      /** @type {number[]} */ const keepSeq = [];
      p.dirty.forEach((d, i) => {
        if (p.dirtySeq[i] > tileSeq) { keep.push(d); keepSeq.push(p.dirtySeq[i]); return; }
        const done = [];
        for (const g of good) {
          const x = intersectRect(d, g);
          if (!x) continue;
          ctx.save();
          ctx.globalCompositeOperation = 'copy';
          ctx.beginPath();
          ctx.rect(x.x - R.x, x.y - pb, x.width, x.height);
          ctx.clip();
          ctx.drawImage(surface, x.x, x.y - shift, x.width, x.height, x.x - R.x, x.y - pb, x.width, x.height);
          ctx.restore();
          done.push(x);
          counters.patched++;
        }
        for (const left of subtractRects(d, done)) { keep.push(left); keepSeq.push(p.dirtySeq[i]); }
      });
      p.dirty = keep;
      p.dirtySeq = keepSeq;
    }
  }

  /** @param {Entry} entry @param {Cache} c @param {Surface} surface @param {number} top @param {Page[]} pages @returns {boolean} */
  function compose(entry, c, surface, top, pages) {
    const ctx = /** @type {CanvasRenderingContext2D|null} */ (surface.getContext('2d'));
    if (!ctx || ctx.isContextLost?.()) return false;
    const R = c.portPx;
    const s = c.geo.scale;
    const grid = c.plan.grid;
    const base = rowOf(top, s, grid);
    /** @type {Array<{pad: Surface, px: Rect}>} */
    const pins = [];
    for (const [el, pin] of c.pins) {
      const r = entry.record.layer?.frameRect(el);
      if (!r || !pin.pad) return false;
      const px = snapPx(r, c.geo, grid);
      if (px.width !== pin.w || px.height !== pin.h) return false;
      pins.push({ pad: pin.pad, px });
    }
    const round = c.plan.round ?? null;
    /** clip to the rounded padding box (exact edges, antialiased like the engine's own clip; on a grid, the box the image snapped to it) */
    const shape = () => {
      if (!round) return;
      const P = paddingBox(c.plan);
      const g = c.geo;
      const box = grid ? snapPx(P, g, grid) : { x: (P.x + g.ink.left) * s, y: (P.y + g.ink.top) * s, width: P.width * s, height: P.height * s };
      const sc = (/** @type {{x: number, y: number}} */ r) => ({ x: r.x * s, y: r.y * s });
      ctx.beginPath();
      ctx.roundRect(box.x, box.y, box.width, box.height, [sc(round.tl), sc(round.tr), sc(round.br), sc(round.bl)]);
      ctx.clip();
    };
    // under the rounded clip on a grid (WebKit): an accelerated WebKit canvas drawing with 'copy' multiplies the source by the clip's coverage and drops the
    // destination (Mobile Safari 26.4: canvases of 200 px and more; 60 px blends like Skia), so the curve of the port came out semi-transparent (alpha 172-192).
    // The opaque pages and pins (install) are drawn source-over the backdrop instead, which blends them by the coverage as 'copy' does in Chromium
    const over = round && grid ? 'source-over' : 'copy';
    ctx.save();
    try {
      ctx.globalCompositeOperation = 'copy';
      if (c.backdrop?.pad) {
        // what lies under the rounded clip (border, background, the parent) where the page does not reach
        for (const q of c.corners) {
          ctx.save(); ctx.beginPath(); ctx.rect(q.x, q.y, q.width, q.height); ctx.clip();
          ctx.drawImage(c.backdrop.pad, c.backdrop.px.x, c.backdrop.px.y);
          ctx.restore();
        }
      }
      for (const p of pages) {
        const off = rowOf(p.top, s, grid) - base;
        const y0 = Math.max(0, off);
        const y1 = Math.min(R.height, off + R.height);
        if (y1 <= y0) continue;
        ctx.save();
        shape();
        ctx.beginPath();
        ctx.rect(R.x, R.y + y0, R.width, y1 - y0);
        ctx.clip();
        ctx.globalCompositeOperation = over;
        ctx.drawImage(/** @type {Surface} */ (p.pad), R.x, R.y + off);
        ctx.restore();
      }
      if (c.bar && c.plan.bar) {
        // the classic bar: its track as captured, then the thumb at the offset (the clone's own geometry, verticalBar)
        const t = c.bar.track;
        ctx.save(); shape(); ctx.beginPath(); ctx.rect(t.px.x, t.px.y, t.px.width, t.px.height); ctx.clip();
        ctx.drawImage(/** @type {Surface} */ (t.pad), t.px.x, t.px.y);
        ctx.restore();
        const h = c.bar.thumb;
        const dy = Math.round((c.plan.bar.thumbY(top) - c.plan.bar.thumbY(h.top)) * s);
        ctx.save(); shape(); ctx.beginPath(); ctx.rect(t.px.x, t.px.y, t.px.width, t.px.height); ctx.clip();
        ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(/** @type {Surface} */ (h.pad), h.px.x, h.px.y + dy);
        ctx.restore();
      }
      for (const { pad, px } of pins) {
        const x0 = Math.max(R.x, px.x), y0 = Math.max(R.y, px.y);
        const x1 = Math.min(R.x + R.width, px.x + px.width), y1 = Math.min(R.y + R.height, px.y + px.height);
        if (x1 <= x0 || y1 <= y0) continue;
        ctx.save();
        shape();
        ctx.beginPath();
        ctx.rect(x0, y0, x1 - x0, y1 - y0);
        ctx.clip();
        ctx.globalCompositeOperation = over;
        ctx.drawImage(pad, px.x, px.y);
        ctx.restore();
      }
    } finally {
      ctx.restore();
    }
    return true;
  }
}
