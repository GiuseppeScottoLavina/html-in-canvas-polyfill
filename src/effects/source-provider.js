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
 * Native mode: queue.drawElementImageToTexture / captureElementImage; version() advances on the native paint event.
 * Not exercised against a real native implementation yet (needs Chrome with CanvasDrawElement).
 * @param {HTMLCanvasElement} canvas
 * @param {Element} source
 * @returns {SourceProvider}
 */
export function createNativeSourceProvider(canvas, source) {
  const win = canvas.ownerDocument.defaultView;
  /** @type {number|null} */
  let version = null;
  let counter = 0;
  const onPaint = () => { version = ++counter; };
  canvas.addEventListener('paint', onPaint);
  /** Native has no event before the first paint unless one is requested. */
  /** @type {any} */ (canvas).requestPaint?.();

  const cssSize = () => {
    const el = /** @type {HTMLElement} */ (source);
    return { cssWidth: el.offsetWidth, cssHeight: el.offsetHeight };
  };
  return {
    kind: 'native',
    version: () => version,
    size() {
      const { cssWidth, cssHeight } = cssSize();
      if (version === null || cssWidth <= 0 || cssHeight <= 0) return null;
      const dpr = win?.devicePixelRatio || 1;
      return { width: Math.ceil(cssWidth * dpr), height: Math.ceil(cssHeight * dpr), cssWidth, cssHeight };
    },
    upload(device, texture) {
      device.queue.drawElementImageToTexture({ source }, { texture, size: { width: texture.width, height: texture.height } });
      return version ?? 0;
    },
    dispose() { canvas.removeEventListener('paint', onPaint); },
  };
}
