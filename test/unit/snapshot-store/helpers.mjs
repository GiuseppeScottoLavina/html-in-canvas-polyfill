// Shared by the browser tests of the snapshot-store module (not a test file).

/** @param {number} w @param {number} h @param {string} body svg children @returns {string} a data: URL of a w x h px SVG */
export function svgUrl(w, h, body) {
  return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`);
}

/** Solid-colour tile. @param {number} w @param {number} h @param {string} color */
export const solidUrl = (w, h, color) => svgUrl(w, h, `<rect width="${w}" height="${h}" fill="${color}"/>`);

/** @param {HTMLCanvasElement|OffscreenCanvas} surface @param {number} x @param {number} y @returns {number[]} rgba */
export function pixel(surface, x, y) {
  const ctx = /** @type {CanvasRenderingContext2D} */ (surface.getContext('2d'));
  return [...ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data];
}

/** Colour name -> rgba for the colours used by the tests. */
export const RGBA = { red: [255, 0, 0, 255], lime: [0, 255, 0, 255], blue: [0, 0, 255, 255], black: [0, 0, 0, 255] };

/** @param {HTMLCanvasElement|OffscreenCanvas} surface @param {string} color */
export function fill(surface, color) {
  const ctx = /** @type {CanvasRenderingContext2D} */ (surface.getContext('2d'));
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, surface.width, surface.height);
}

/** @param {HTMLCanvasElement|OffscreenCanvas} surface @returns {Uint8ClampedArray} */
export function allPixels(surface) {
  return /** @type {CanvasRenderingContext2D} */ (surface.getContext('2d')).getImageData(0, 0, surface.width, surface.height).data;
}

/** @param {ArrayLike<number>} a @param {ArrayLike<number>} b @returns {boolean} */
export function samePixels(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Waits (real time) until `fn()` is truthy. @param {() => any} fn @param {number} [ms] @param {string} [what] */
export async function until(fn, ms = 3000, what = 'condition') {
  const t0 = performance.now();
  while (!fn()) {
    if (performance.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((ok) => setTimeout(ok, 4));
  }
}

/**
 * Forces a 2D context loss on a surface with the Chromium conformance recipe (allocation failure, then a context use) and restores a valid size.
 * contextlost / contextrestored are dispatched as tasks: the caller must wait.
 * @param {HTMLCanvasElement|OffscreenCanvas} surface
 */
export function forceContextLoss(surface) {
  const w = surface.width;
  const h = surface.height;
  const ctx = /** @type {CanvasRenderingContext2D} */ (surface.getContext('2d'));
  surface.width = 100000000;
  ctx.fillRect(0, 0, 1, 1);
  surface.width = w;
  surface.height = h;
}

// ---------------------------------------------------------------------------------------------- store rig

/** @typedef {import('/src/contracts/types.js').Rect} Rect */

/**
 * A SnapshotStore wired to a fake canvas record, a fake live layer, a scripted CaptureFn that returns real SVG data: URLs, and a controllable decoder.
 * Surface geometry: border box w x h, ink 4 css px on every side, raster scale `scale` (default 1), so a css point (x, y) of a drawable is surface pixel ((x+4)*scale, (y+4)*scale).
 * @param {{cleanup: (fn: () => any) => void}} t
 * @param {{scale?: number, options?: Record<string, any>, interaction?: {snapshot: () => any}, textOverlay?: any, scrollPlan?: any, caretOf?: any, nextTask?: any, frameRect?: (el: Element) => any, virtualBusy?: boolean}} [cfg]
 * `virtualBusy`: the store's clock (`env.now`) does not see the real time the scripted capture takes, only its `busyMs` (a build's measured synchronous
 * time is then exactly what the test scripts, whatever the machine's speed).
 */
export async function makeRig(t, cfg = {}) {
  const { createBus } = await import('/src/util/bus.js');
  const { DEFAULT_OPTIONS } = await import('/src/api/options.js');
  const { createSnapshotStore } = await import('/src/snapshot/store/store.js');
  const { decodeDataUrl } = await import('/src/snapshot/store/decode.js');
  const { BUS } = await import('/src/contracts/events.js');
  const { fixture } = await import('/test/unit/lib/t.js');
  const scale = cfg.scale ?? 1;
  const INK = 4;
  const bus = createBus();
  const reports = { unsupported: /** @type {any[]} */ ([]), caught: /** @type {any[]} */ ([]) };
  const reporter = {
    unsupported: (/** @type {any} */ e) => { reports.unsupported.push(e); },
    deviation: () => {},
    caught: (/** @type {unknown} */ err, /** @type {string} */ where) => { reports.caught.push({ err, where }); },
    entries: () => [],
  };
  const options = { ...DEFAULT_OPTIONS, maxDpr: 3, maxSnapshotFps: 0, inkMargin: INK, ...cfg.options };
  const host = fixture('');
  /** @type {Element[]} */ const els = [];
  const sizes = new Map();
  const laidOut = new Set();
  const layer = {
    element: host,
    drawableElements: () => els.filter((e) => e.isConnected),
    isLaidOut: (/** @type {Element} */ el) => laidOut.has(el),
    borderBoxSize: (/** @type {Element} */ el) => (laidOut.has(el) ? sizes.get(el) : null),
    frameRect: (/** @type {Element} */ el) => cfg.frameRect?.(el) ?? null,
  };
  const record = /** @type {any} */ ({
    id: 1, canvas: document.createElement('canvas'), state: 'active', frameCap: 0, layer,
    contentBox: { width: 400, height: 300, gridScaleX: scale, gridScaleY: scale },
  });
  let hiddenMs = 0;
  const env = /** @type {any} */ ({
    window, document, options, bus, reporter, now: () => performance.now() - hiddenMs,
    registry: { ownerOfDrawable: () => record, get: () => record, all: () => [record] },
  });

  const calls = /** @type {any[]} */ ([]);
  /** Per-call overrides, consumed in order: {color, complete, caret, unsupported, url, layoutOffset, scrollers}. */
  const script = /** @type {any[]} */ ([]);
  const rig = {
    env, record, reports, calls, script, bus, BUS, options, INK, scale, color: 'red', decodes: 0, deferDecode: false,
    /** @type {Array<{url: string, release: () => void, fail: (e?: any) => void}>} */ pending: [],
  };

  /** @type {import('/src/contracts/types.js').CaptureFn} */
  const capture = (req) => {
    const started = performance.now();
    calls.push(req);
    const o = script.shift() ?? {};
    if (cfg.virtualBusy) {
      try { return scripted(req, o); } finally { hiddenMs += performance.now() - started - (o.busyMs ?? 0); }
    }
    if (o.busyMs) for (const t0 = performance.now(); performance.now() - t0 < o.busyMs;);
    return scripted(req, o);
  };
  /** @param {any} req @param {any} o */
  const scripted = (req, o) => {
    const size = sizes.get(req.element);
    const crop = req.rect ?? { x: -req.ink.left, y: -req.ink.top, width: size.width + req.ink.left + req.ink.right, height: size.height + req.ink.top + req.ink.bottom };
    const widthPx = Math.ceil(crop.width * req.scale - 1e-6);
    const heightPx = Math.ceil(crop.height * req.scale - 1e-6);
    return {
      url: o.url ?? solidUrl(widthPx, heightPx, o.color ?? rig.color), cropCss: crop, widthPx, heightPx, nodes: 10, complete: o.complete ?? true,
      unsupported: o.unsupported ?? [], layoutOffset: o.layoutOffset ?? { x: 1, y: 2 }, caret: o.caret ?? null, scrollers: o.scrollers ?? [],
      timings: { cloneMs: 0.1, cssMs: 0, shakeMs: 0, svgMs: 0, bytes: 1 },
    };
  };
  const decode = (/** @type {string} */ url) => {
    rig.decodes++;
    if (!rig.deferDecode) return decodeDataUrl(url);
    return new Promise((resolve, reject) => {
      rig.pending.push({ url, release: () => decodeDataUrl(url).then(resolve, reject), fail: (e) => reject(e ?? new Error('decode failed')) });
    });
  };
  rig.store = createSnapshotStore(env, capture, { decode, buildsPerDrawable: cfg.buildsPerDrawable ?? 1, interaction: cfg.interaction, textOverlay: cfg.textOverlay, scrollPlan: cfg.scrollPlan, caretOf: cfg.caretOf, nextTask: cfg.nextTask });
  t.cleanup(() => { rig.store.dispose(); });

  /** A drawable of w x h css px (laid out, announced to the store). @param {string} id @param {number} w @param {number} h @param {{announce?: boolean}} [o] */
  rig.add = (id, w, h, o = {}) => {
    const el = document.createElement('div');
    el.id = id;
    el.style.cssText = `width:${w}px;height:${h}px;position:absolute;left:0;top:0`;
    host.append(el);
    els.push(el);
    sizes.set(el, { width: w, height: h });
    laidOut.add(el);
    if (o.announce !== false) bus.emit(BUS.DRAWABLES_CHANGED, { record, added: [el], removed: [] });
    return el;
  };
  rig.setSize = (/** @type {Element} */ el, /** @type {number} */ w, /** @type {number} */ h) => { sizes.set(el, { width: w, height: h }); };
  rig.hide = (/** @type {Element} */ el) => { laidOut.delete(el); };
  rig.show = (/** @type {Element} */ el) => { laidOut.add(el); };
  rig.remove = (/** @type {Element} */ el) => { els.splice(els.indexOf(el), 1); el.remove(); bus.emit(BUS.DRAWABLES_CHANGED, { record, added: [], removed: [el] }); };

  rig.budget = { mainThreadMs: 1000, mainThreadShare: 100, maxInFlight: 2, interaction: false };
  rig.pump = (/** @type {any} */ budget) => rig.store.pump(performance.now(), budget ?? rig.budget);
  /** Damage, pump once, wait for the decode to land. @param {Element} el @param {Rect|null} [rect] @param {string} [cause] */
  rig.damageAndPump = async (el, rect = null, cause = 'input') => {
    rig.store.markDamage(el, rect, /** @type {any} */ (cause));
    const r = rig.pump();
    if (!rig.deferDecode) await until(() => rig.store.hasLanded(), 3000, 'a decoded tile to land');
    return r;
  };
  /** Full cycle: damage, build, decode, commit. Returns the ChangeSet. */
  rig.build = async (/** @type {Element} */ el, /** @type {Rect|null} */ rect = null, /** @type {string} */ cause = 'input') => {
    await rig.damageAndPump(el, rect, cause);
    return rig.store.commitLanded();
  };
  /** Resolves the n-th deferred decode (default: the oldest). */
  rig.release = async (n = 0) => {
    const [p] = rig.pending.splice(n, 1);
    p.release();
    await new Promise((ok) => setTimeout(ok, 30));
  };
  rig.commits = /** @type {any[]} */ ([]);
  rig.versions = /** @type {any[]} */ ([]);
  bus.on(BUS.COMMIT, (e) => rig.commits.push(e));
  bus.on(BUS.SOURCE_VERSION, (e) => rig.versions.push(e));
  /** Surface pixel of a css point of a drawable's CURRENT version. */
  rig.css = (/** @type {Element} */ el, /** @type {number} */ x, /** @type {number} */ y) => {
    const v = rig.store.version(el);
    return pixel(v.surface, (x + INK) * v.scale, (y + INK) * v.scale);
  };
  return rig;
}
