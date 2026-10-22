/**
 * Where the host reads source pixels.
 * Module: gpu-effects (src/effects/**).
 */

import { BUS } from '../contracts/events.js';
import { inflateRect, unionRect } from '../util/rect.js';

/** @typedef {import('../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').Rect} Rect */
/** @typedef {import('../contracts/types.js').SnapshotVersion} SnapshotVersion */
/** @typedef {import('../contracts/types.js').SourceProvider} SourceProvider */

/** css px kept around a dirty rect so pixel snapping and anti-aliased edges are never left stale */
const DIRTY_MARGIN_CSS = 2;
/** above this share of the texture a partial copy is not worth its bookkeeping */
const PARTIAL_MAX_SHARE = 0.6;

/**
 * Polyfill mode: reads the newest SnapshotVersion of `source`; partial uploads of the dirty rect via copyExternalImageToTexture of the 2D surface.
 *
 * Partial uploads need to know what changed since the last upload, across every version the host skipped. The provider unions the
 * `dirty` rect (css px, border-box frame; null = everything) that the store puts on each SnapshotVersion and announces with
 * BUS.SOURCE_VERSION. A version without `dirty`, a replaced surface, a restored surface or a new texture all fall back to a full copy.
 * @param {HicEnv} env
 * @param {CanvasRecord} record
 * @param {Element} source
 * @returns {SourceProvider}
 */
export function createStoreSourceProvider(env, record, source) {
  /** @type {Rect|null} */
  let pendingDirty = null;
  let pendingFull = true;
  /** @type {unknown} */ let lastSurface = null;
  /** @type {unknown} */ let lastTexture = null;
  let lastVersion = 0;
  /** newest version id announced on the bus; a version nobody announced cannot be trusted to have a known dirty rect */
  let announced = 0;

  const offVersion = env.bus.on(BUS.SOURCE_VERSION, (/** @type {{record: CanvasRecord, version: SnapshotVersion}} */ e) => {
    if (e.record !== record || e.version.element.deref() !== source) return;
    announced = Math.max(announced, e.version.id);
    const dirty = /** @type {Rect|null|undefined} */ (/** @type {any} */ (e.version).dirty);
    if (!dirty) pendingFull = true;
    else pendingDirty = unionRect(pendingDirty, dirty);
  });
  const offRestored = env.bus.on(BUS.SURFACE_RESTORED, (/** @type {{record: CanvasRecord, element: Element}} */ e) => {
    if (e.record === record && e.element === source) pendingFull = true;
  });

  /** @param {SnapshotVersion} v */
  function fullRaster(v) {
    return env.store.rasterSource(v, { sx: 0, sy: 0, sw: v.width, sh: v.height });
  }

  return {
    kind: 'store',
    version() { return env.store.version(source)?.id ?? null; },
    size() {
      const v = env.store.version(source);
      const r = v && fullRaster(v);
      if (!v || !r) return null;
      return { width: Math.max(1, Math.round(r.sw)), height: Math.max(1, Math.round(r.sh)), cssWidth: v.width, cssHeight: v.height };
    },
    upload(device, texture, onlyDirty) {
      const v = env.store.version(source);
      const full = v && fullRaster(v);
      if (!v || !full) return 0;
      const fx = Math.round(full.sx);
      const fy = Math.round(full.sy);
      const fw = Math.min(texture.width, Math.round(full.sw));
      const fh = Math.min(texture.height, Math.round(full.sh));
      let copy = { x: 0, y: 0, w: fw, h: fh };
      const partialOk = onlyDirty && !pendingFull && announced === v.id && lastTexture === texture && lastSurface === v.surface;
      if (partialOk) {
        const part = dirtyCopy(env, v, pendingDirty, { fx, fy, fw, fh });
        if (part === 'none') copy = { x: 0, y: 0, w: 0, h: 0 };
        else if (part) copy = part;
      }
      if (copy.w > 0 && copy.h > 0) {
        device.queue.copyExternalImageToTexture(
          { source: full.source, origin: { x: fx + copy.x, y: fy + copy.y } },
          { texture, origin: { x: copy.x, y: copy.y } },
          [copy.w, copy.h],
        );
      }
      pendingDirty = null;
      pendingFull = false;
      lastSurface = v.surface;
      lastTexture = texture;
      lastVersion = v.id;
      return lastVersion;
    },
    dispose() { offVersion(); offRestored(); },
  };
}

/**
 * The texture-space rect to copy for `dirty`, or 'none' when it falls outside the surface, or null when a full copy is cheaper.
 * @param {HicEnv} env
 * @param {SnapshotVersion} v
 * @param {Rect|null} dirty
 * @param {{fx: number, fy: number, fw: number, fh: number}} f full crop origin and size in surface px
 * @returns {{x: number, y: number, w: number, h: number}|'none'|null}
 */
function dirtyCopy(env, v, dirty, f) {
  if (!dirty) return 'none';
  const grown = inflateRect(dirty, DIRTY_MARGIN_CSS);
  const r = env.store.rasterSource(v, { sx: grown.x, sy: grown.y, sw: grown.width, sh: grown.height });
  if (!r) return 'none';
  const x0 = Math.max(0, Math.floor(r.sx) - f.fx);
  const y0 = Math.max(0, Math.floor(r.sy) - f.fy);
  const x1 = Math.min(f.fw, Math.ceil(r.sx + r.sw) - f.fx);
  const y1 = Math.min(f.fh, Math.ceil(r.sy + r.sh) - f.fy);
  if (x1 <= x0 || y1 <= y0) return 'none';
  if ((x1 - x0) * (y1 - y0) > PARTIAL_MAX_SHARE * f.fw * f.fh) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Native mode: GPUQueue.drawElementImageToTexture of the browser's own element image of `source`.
 * VERSION: advances on the canvas's `paint` event when its changedElements name the source (or a drawable inside it, or one around it):
 * the browser fires paint after it painted a changed drawable (typing, hover, the caret blink, a resize). The first paint after creation
 * always counts (one is requested), and so does a paint of a build without changedElements. A paint that another script requested for
 * nothing (changedElements empty) does not. The host uploads in the paint event itself (frame-source.js nativeFrameSource): there the
 * element image is fresh.
 * SIZE: the texture is getElementImageDefaultSize(source) (grid px of the canvas bitmap, rounded up); the css size is the border box of the
 * source from a ResizeObserver (fractional, and unaffected by the hit-test transform of native-geometry.js; offsetWidth/Height before its
 * first report). A change of the default size (the canvas bitmap was resized) is a new version too.
 * PARTIAL UPLOADS: none. The native paint event says which drawables changed, not where, so every new version is one full draw. The cost
 * is on the GPU side; the call itself takes about 0.08 ms of main thread (Chrome Canary 158, M1 Max).
 * @param {HicEnv} env
 * @param {HTMLCanvasElement} canvas
 * @param {Element} source
 * @returns {SourceProvider}
 */
export function createNativeSourceProvider(env, canvas, source) {
  const win = /** @type {Window & typeof globalThis} */ (env.window);
  const c = /** @type {any} */ (canvas);
  /** @type {number|null} */
  let version = null;
  let counter = 0;
  /** @type {{width: number, height: number}|null} */
  let border = null;
  let lastSize = '';
  const related = (/** @type {unknown} */ el) => el instanceof win.Element && (el === source || source.contains(el) || el.contains(source));
  const onPaint = (/** @type {Event} */ e) => {
    const changed = /** @type {any} */ (e).changedElements;
    if (version !== null && changed && typeof changed.length === 'number' && !Array.prototype.some.call(changed, related)) return;
    version = ++counter;
  };
  canvas.addEventListener('paint', onPaint);
  // there is no paint event before the next change unless one is requested
  c.requestPaint?.();
  const ro = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver((entries) => {
    const box = entries[entries.length - 1]?.borderBoxSize?.[0];
    if (box) border = { width: box.inlineSize, height: box.blockSize };
  }) : null;
  ro?.observe(source, { box: 'border-box' });

  /** grid px of the element image, or null before the first paint */
  const gridSize = () => {
    try {
      const s = c.getElementImageDefaultSize(source);
      return s && s.width > 0 && s.height > 0 ? { width: Math.ceil(s.width), height: Math.ceil(s.height) } : null;
    } catch { return null; }
  };
  return {
    kind: 'native',
    version() {
      if (version === null) return null;
      const g = gridSize();
      const key = g ? `${g.width}x${g.height}` : '';
      if (lastSize && key && key !== lastSize) { lastSize = key; version = ++counter; }
      return version;
    },
    size() {
      const g = gridSize();
      const el = /** @type {HTMLElement} */ (source);
      const css = border ?? { width: el.offsetWidth, height: el.offsetHeight };
      if (version === null || !g || css.width <= 0 || css.height <= 0) return null;
      return { width: g.width, height: g.height, cssWidth: css.width, cssHeight: css.height };
    },
    upload(device, texture) {
      try {
        device.queue.drawElementImageToTexture({ source }, { texture, size: { width: texture.width, height: texture.height } });
      } catch (error) {
        // no element image yet (InvalidStateError before the first paint, or the source left the canvas): nothing uploaded
        if (/** @type {any} */ (error)?.name === 'InvalidStateError') return 0;
        throw error;
      }
      lastSize = `${texture.width}x${texture.height}`;
      return version ?? 0;
    },
    dispose() { canvas.removeEventListener('paint', onPaint); ro?.disconnect(); },
  };
}
