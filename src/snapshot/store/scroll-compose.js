/**
 * Scroll compositor, store side. A scroll step of an eligible scroller (snapshot/capture/scroll-pages.js) is shown in the
 * very next rendering update without a build: the scrollport of the retained surface is composed from cached PAGES (the port rendered at other offsets, pinned sticky
 * elements hidden) shifted by whole surface pixels, then every pinned element is drawn from its own tile at its live position. Pages are built ahead in the post-frame
 * pump (side builds). The snapshot stays the authority: a tile always lands when the scrolling stops, and any damage other than this scroller's own scrolling drops the
 * cache (a stale page is never used). Everything the plan cannot vouch for keeps the plain path.
 * Module: snapshot-store (src/snapshot/store/*).
 */

/** @typedef {import('../../contracts/types.js').Rect} Rect */
/** @typedef {import('../../contracts/types.js').ScrollPlan} ScrollPlan */
/** @typedef {import('./pump.js').Entry} Entry */
/** @typedef {import('./pump.js').Geometry} Geometry */
/** @typedef {HTMLCanvasElement|OffscreenCanvas} Surface */

/** pages kept per scroller (each one scrollport of surface pixels) */
const MAX_PAGES = 4;
/** scrollers with a cache per drawable */
const MAX_SCROLLERS = 2;

/**
 * @typedef {Object} Page
 * @property {number} top  scrollTop the page was rendered at (whole surface pixels)
 * @property {Surface|null} pad  null while it is being built
 */

/**
 * @typedef {Object} Cache  one scroller of one drawable
 * @property {Element} el
 * @property {number} epoch  Entry.scEpoch the cache belongs to
 * @property {Geometry} geo
 * @property {ScrollPlan} plan
 * @property {Rect} portPx  the scrollport in surface pixels (snapped)
 * @property {Page[]} pages
 * @property {Map<Element, {pad: Surface|null, w: number, h: number}>} pins
 * @property {{track: {pad: Surface|null, px: Rect}, thumb: {pad: Surface|null, px: Rect, top: number}}|null} bar  classic bar tiles: the track (thumb hidden) and the thumb alone, captured at offset `top`
 * @property {number|null} shown  scrollTop the surface's scrollport shows (null = not known to be one offset)
 * @property {boolean} queued  a composition was promised to the next commit
 * @property {number} last  previous live scrollTop seen (direction of the next page)
 */

/**
 * @typedef {Object} ComposeDeps
 * @property {(scroller: Element, drawable: Element) => ScrollPlan|null} plan
 * @property {(entry: Entry, rectCss: Rect, geo: Geometry, scroll: {el: Element, top: number, hide: Element[], bars?: 'track'|'thumb'}|null) => string|null} capture  data: URL of a crop, null on failure
 * @property {(url: string) => Promise<HTMLImageElement>} decode
 * @property {(w: number, h: number) => Surface} canvas
 * @property {(entry: Entry, run: () => void) => void} schedule  queue a side build for the post-frame pump
 */

/** @param {Rect} r @param {Geometry} geo @returns {Rect} css rect of the drawable frame -> whole surface pixels */
export function snapPx(r, geo) {
  const s = geo.scale;
  const x0 = Math.round((r.x + geo.ink.left) * s);
  const y0 = Math.round((r.y + geo.ink.top) * s);
  return { x: x0, y: y0, width: Math.round((r.x + r.width + geo.ink.left) * s) - x0, height: Math.round((r.y + r.height + geo.ink.top) * s) - y0 };
}

/** @param {Rect} px @param {Geometry} geo @returns {Rect} surface pixels -> css rect of the drawable frame */
const toCss = (px, geo) => ({ x: px.x / geo.scale - geo.ink.left, y: px.y / geo.scale - geo.ink.top, width: px.width / geo.scale, height: px.height / geo.scale });

/** @param {Rect} a @param {Rect} b */
const sameRect = (a, b) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;

/** @param {Geometry} a @param {Geometry} b */
const sameGeo = (a, b) => a.scale === b.scale && a.widthPx === b.widthPx && a.heightPx === b.heightPx && a.ink.left === b.ink.left && a.ink.top === b.ink.top;

/**
 * PURE. Does a set of pages cover the scrollport at `top`? Rows are surface pixels; a page at `p` shows port row j at view row j + round(p * s) - round(top * s).
 * @param {number[]} tops @param {number} top @param {number} rows port height in surface pixels @param {number} s
 * @returns {boolean}
 */
export function covers(tops, top, rows, s) {
  const base = Math.round(top * s);
  const spans = tops.map((p) => Math.round(p * s) - base).map((off) => [Math.max(0, off), Math.min(rows, off + rows)]).filter(([a, b]) => b > a).sort((u, v) => u[0] - v[0]);
  let reach = 0;
  for (const [a, b] of spans) {
    if (a > reach) return false;
    reach = Math.max(reach, b);
  }
  return reach >= rows;
}

/** @param {ComposeDeps} deps */
export function createScrollCompositor(deps) {
  /** @type {WeakMap<Entry, Map<Element, Cache>>} */
  const caches = new WeakMap();
  /** @type {WeakMap<Entry, {el: Element, epoch: number}>} last scroller that has no plan (not re-planned until the epoch changes) */
  const refused = new WeakMap();
  /** @type {WeakSet<Entry>} drawables whose cold scroller is being planned in the pump */
  const planning = new WeakSet();
  /** @type {WeakMap<Entry, number>} side builds in flight per drawable */
  const inFlight = new WeakMap();
  /** diagnostics (SnapshotStats.scroll) */
  const counters = { plans: 0, refusals: 0, pages: 0, pins: 0, failed: 0, composed: 0, fallbacks: 0, droppedEpoch: 0, droppedGeometry: 0 };

  /** @param {Entry} entry @returns {Map<Element, Cache>} */
  const mapOf = (entry) => {
    let m = caches.get(entry);
    if (!m) caches.set(entry, (m = new Map()));
    return m;
  };

  /** @param {Entry} entry @param {number} d */
  const track = (entry, d) => inFlight.set(entry, (inFlight.get(entry) ?? 0) + d);

  /** Build a crop and keep it as pixels in `slot.pad` if the cache is still the current one when it lands. @param {Entry} entry @param {Cache} cache @param {Rect} px @param {{el: Element, top: number, hide: Element[], bars?: 'track'|'thumb'}|null} scroll @param {{pad: Surface|null}} slot */
  function build(entry, cache, px, scroll, slot) {
    deps.schedule(entry, () => {
      if (mapOf(entry).get(cache.el) !== cache) return;
      const url = deps.capture(entry, toCss(px, cache.geo), cache.geo, scroll);
      if (!url) { counters.failed++; drop(entry, cache); return; }
      if (scroll) counters.pages++; else counters.pins++;
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

  /** @param {Entry} entry @param {Element} el @param {number} epoch @returns {Cache|null} */
  function cacheFor(entry, el, epoch) {
    const m = mapOf(entry);
    const known = m.get(el);
    const geo = /** @type {Geometry} */ (entry.geo);
    if (known && known.epoch === epoch && sameGeo(known.geo, geo)) return known;
    if (known) {
      if (known.epoch !== epoch) counters.droppedEpoch++; else counters.droppedGeometry++;
      m.delete(el);
    }
    const no = refused.get(entry);
    if (no && no.el === el && no.epoch === epoch) return null;
    counters.plans++;
    const plan = deps.plan(el, entry.el);
    if (!plan) { counters.refusals++; refused.set(entry, { el, epoch }); return null; }
    const portPx = snapPx(plan.port, geo);
    if (portPx.width <= 0 || portPx.height <= 0) return null;
    const live = /** @type {HTMLElement} */ (el).scrollTop;
    /** @type {Cache} */
    const cache = { el, epoch, geo, plan, portPx, pages: [], pins: new Map(), bar: null, shown: null, queued: false, last: live };
    if (plan.bar) {
      const b = plan.bar;
      const trackPx = snapPx(b.gutter, geo);
      const thumbPx = snapPx({ x: b.gutter.x + b.thumbX, y: b.gutter.y + b.thumbY(live), width: b.thumbW, height: b.thumbH }, geo);
      cache.bar = { track: { pad: null, px: trackPx }, thumb: { pad: null, px: thumbPx, top: live } };
      build(entry, cache, trackPx, { el, top: live, hide: [], bars: 'track' }, cache.bar.track);
      build(entry, cache, thumbPx, { el, top: live, hide: [], bars: 'thumb' }, cache.bar.thumb);
    }
    for (const p of plan.pinned) {
      const r = entry.record.layer?.frameRect(p);
      if (!r) return null;
      const px = snapPx(r, geo);
      const port = portPx;
      if (px.x < port.x || px.y < port.y || px.x + px.width > port.x + port.width || px.y + px.height > port.y + port.height) { refused.set(entry, { el, epoch }); return null; }
      const slot = { pad: /** @type {Surface|null} */ (null), w: px.width, h: px.height };
      cache.pins.set(p, slot);
      build(entry, cache, px, null, slot);
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
    const at = (/** @type {number} */ k) => Math.round(Math.min(cache.plan.maxTop, Math.max(0, k * P)) * s) / s;
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
      const page = { top: t, pad: null };
      cache.pages.push(page);
      build(entry, cache, cache.portPx, { el: cache.el, top: t, hide: cache.plan.pinned }, page);
    }
  }

  /** @param {Cache} cache @param {number} top @returns {boolean} the port at `top` can be composed now */
  function ready(cache, top) {
    for (const pin of cache.pins.values()) if (!pin.pad) return false;
    if (cache.bar && (!cache.bar.track.pad || !cache.bar.thumb.pad)) return false;
    return covers(cache.pages.filter((p) => p.pad).map((p) => p.top), top, cache.portPx.height, cache.geo.scale);
  }

  return {
    /**
     * A scroll event of `scroller` (inside the drawable of `entry`): plan and prefetch; true when the next commit can show the live offset by composition (the caller then
     * skips the build and asks for the exact tile once the scrolling stops).
     * @param {Entry} entry @param {Element} scroller @param {number} epoch @returns {boolean}
     */
    serve(entry, scroller, epoch) {
      if (!entry.surface || !entry.geo || !entry.version || entry.lost) return false;
      const known = mapOf(entry).get(scroller);
      // a cold scroller takes the plain path; it is planned once the scrolling settles (prepare), never inside a scroll step or right behind it (measured: planning and
      // page builds right after the first wheel tick of a stream made that tick 170-195 ms late)
      if (!known || known.epoch !== epoch || !sameGeo(known.geo, entry.geo)) return false;
      const cache = known;
      const top = /** @type {HTMLElement} */ (scroller).scrollTop;
      prefetch(entry, cache, top);
      if (!ready(cache, top)) return false;
      cache.queued = true;
      return true;
    },

    /**
     * The scrolling of `scroller` settled: plan it and build its first pages in the post-frame pump (side builds), so the next scroll step can be composed.
     * @param {Entry} entry @param {Element} scroller
     */
    prepare(entry, scroller) {
      if (planning.has(entry) || !entry.surface || !entry.geo || entry.lost) return;
      const known = mapOf(entry).get(scroller);
      if (known && known.epoch === entry.scEpoch && sameGeo(known.geo, entry.geo)) return;
      planning.add(entry);
      deps.schedule(entry, () => {
        planning.delete(entry);
        if (!entry.surface || !entry.geo || entry.lost) return;
        const c = cacheFor(entry, scroller, entry.scEpoch);
        if (c) prefetch(entry, c, /** @type {HTMLElement} */ (scroller).scrollTop);
      });
    },

    /** @param {Entry} entry @returns {boolean} a composition waits for the next commit */
    queued(entry) {
      for (const c of caches.get(entry)?.values() ?? []) if (c.queued) return true;
      return false;
    },

    /** @param {Entry} entry @returns {boolean} side builds of the drawable are decoding */
    busy: (entry) => (inFlight.get(entry) ?? 0) > 0,

    /**
     * Does scroll damage of `rect` leave the pages valid? Yes for the composed scroller's own scrolling, and for any scroller whose box does not reach into a composed
     * scrollport (a sibling list, or no cache at all: a refused plan must not be re-planned on every scroll step); no for a scroller nested in a composed one.
     * @param {Entry} entry @param {Rect|null} rect @returns {boolean}
     */
    ownScroll(entry, rect) {
      if (!rect) return false;
      for (const c of caches.get(entry)?.values() ?? []) {
        if (sameRect(c.plan.frame, rect)) continue;
        const p = c.plan.port;
        if (rect.x < p.x + p.width && rect.x + rect.width > p.x && rect.y < p.y + p.height && rect.y + rect.height > p.y) return false;
      }
      return true;
    },

    /**
     * A tile was drawn: it shows the scrollport at the offset the build read (`top`, null when unknown) if it covers the port, else the port is mixed.
     * @param {Entry} entry @param {Rect} cropPx @param {number|null} top @param {Element|null} scroller
     */
    tileLanded(entry, cropPx, top, scroller) {
      for (const c of caches.get(entry)?.values() ?? []) {
        const p = c.portPx;
        const inside = cropPx.x <= p.x && cropPx.y <= p.y && cropPx.x + cropPx.width >= p.x + p.width && cropPx.y + cropPx.height >= p.y + p.height;
        const touches = cropPx.x < p.x + p.width && cropPx.x + cropPx.width > p.x && cropPx.y < p.y + p.height && cropPx.y + cropPx.height > p.y;
        if (inside) c.shown = scroller === c.el ? top : /** @type {HTMLElement} */ (c.el).scrollTop;
        else if (touches) c.shown = null;
      }
    },

    /**
     * Compose every cached scroller whose port does not show its live offset (promised, or a tile drew another offset). Returns the css rects written, and the frames of
     * the scrollers that were promised but cannot be composed (the caller damages them: the plain path takes over).
     * @param {Entry} entry @param {() => Surface|null} surfaceOf  the writable surface (asked only when a composition happens) @param {number} epoch
     * @returns {{dirty: Rect[], fallback: Rect[]}}
     */
    step(entry, surfaceOf, epoch) {
      /** @type {Rect[]} */ const dirty = [];
      /** @type {Rect[]} */ const fallback = [];
      for (const c of [...(caches.get(entry)?.values() ?? [])]) {
        const promised = c.queued;
        c.queued = false;
        if (c.epoch !== epoch || !entry.geo || !sameGeo(c.geo, entry.geo)) { drop(entry, c); if (promised) fallback.push(c.plan.frame); continue; }
        const top = /** @type {HTMLElement} */ (c.el).scrollTop;
        if (c.shown === top) continue;
        const surface = ready(c, top) ? surfaceOf() : null;
        if (!surface || !compose(entry, c, surface, top)) {
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
    },
  };

  /** @param {Entry} entry @param {Cache} c @param {Surface} surface @param {number} top @returns {boolean} */
  function compose(entry, c, surface, top) {
    const ctx = /** @type {CanvasRenderingContext2D|null} */ (surface.getContext('2d'));
    if (!ctx || ctx.isContextLost?.()) return false;
    const R = c.portPx;
    const s = c.geo.scale;
    const base = Math.round(top * s);
    /** @type {Array<{pad: Surface, px: Rect}>} */
    const pins = [];
    for (const [el, pin] of c.pins) {
      const r = entry.record.layer?.frameRect(el);
      if (!r || !pin.pad) return false;
      const px = snapPx(r, c.geo);
      if (px.width !== pin.w || px.height !== pin.h) return false;
      pins.push({ pad: pin.pad, px });
    }
    const pages = c.pages.filter((p) => p.pad).sort((a, b) => Math.abs(b.top - top) - Math.abs(a.top - top));
    ctx.save();
    try {
      ctx.globalCompositeOperation = 'copy';
      for (const p of pages) {
        const off = Math.round(p.top * s) - base;
        const y0 = Math.max(0, off);
        const y1 = Math.min(R.height, off + R.height);
        if (y1 <= y0) continue;
        ctx.save();
        ctx.beginPath();
        ctx.rect(R.x, R.y + y0, R.width, y1 - y0);
        ctx.clip();
        ctx.drawImage(/** @type {Surface} */ (p.pad), R.x, R.y + off);
        ctx.restore();
      }
      if (c.bar && c.plan.bar) {
        // the classic bar: its track as captured, then the thumb at the offset (the clone's own geometry, verticalBar)
        const t = c.bar.track;
        ctx.save(); ctx.beginPath(); ctx.rect(t.px.x, t.px.y, t.px.width, t.px.height); ctx.clip();
        ctx.drawImage(/** @type {Surface} */ (t.pad), t.px.x, t.px.y);
        ctx.restore();
        const h = c.bar.thumb;
        const dy = Math.round((c.plan.bar.thumbY(top) - c.plan.bar.thumbY(h.top)) * s);
        ctx.save(); ctx.beginPath(); ctx.rect(t.px.x, t.px.y, t.px.width, t.px.height); ctx.clip();
        ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(/** @type {Surface} */ (h.pad), h.px.x, h.px.y + dy);
        ctx.restore();
      }
      for (const { pad, px } of pins) {
        const x0 = Math.max(R.x, px.x), y0 = Math.max(R.y, px.y);
        const x1 = Math.min(R.x + R.width, px.x + px.width), y1 = Math.min(R.y + R.height, px.y + px.height);
        if (x1 <= x0 || y1 <= y0) continue;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, y0, x1 - x0, y1 - y0);
        ctx.clip();
        ctx.drawImage(pad, px.x, px.y);
        ctx.restore();
      }
    } finally {
      ctx.restore();
    }
    return true;
  }
}
