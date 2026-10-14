/**
 * drawElementImage on CanvasRenderingContext2D and OffscreenCanvasRenderingContext2D (spec "draw an element").
 * One ctx.drawImage from the store's retained surface, then the geometry step. Never reads layout: every number comes from the SnapshotVersion,
 * including the layoutOffset that the layer receives through GeometryApi, so N draws per frame are N cache hits (ADR-F).
 * Module: api-surface (src/api/*).
 */

import { invalidState } from '../contracts/errors.js';
import { IDENTITY16, matrixFrom, matrixInit, matrixValues } from '../util/matrix.js';
import { canvasTransformValues, clipToSurface, parseDrawArgs, resolveRects, snapDefaultSize } from './draw-math.js';
import { enqueueGeometry, offscreenPlaceholder } from './offscreen-patch.js';
import { assertTargetType, defineMethod, globalsOf, resolveElement } from './validate.js';

/** @typedef {import('../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../contracts/types.js').GeometryApi} GeometryApi */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').PatchLedger} PatchLedger */
/** @typedef {import('./draw-math.js').ResolvedRects} ResolvedRects */
/** @typedef {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} Context2D */

const NO_ORIGIN = IDENTITY16;

/**
 * The HTMLCanvasElement whose content box the context draws for.
 * @param {Context2D} ctx
 * @param {boolean} offscreen
 * @returns {HTMLCanvasElement}
 * @throws InvalidStateError for an OffscreenCanvas without a placeholder (WPT draw-element-different-canvas)
 */
function canvasOf(ctx, offscreen) {
  const owner = ctx.canvas;
  if (!offscreen) return /** @type {HTMLCanvasElement} */ (owner);
  const placeholder = offscreenPlaceholder(/** @type {OffscreenCanvas} */ (owner));
  if (!placeholder) throw invalidState('drawElementImage needs an OffscreenCanvas transferred from a content="drawable" canvas (no placeholder canvas).');
  return placeholder;
}

/**
 * Spec step 6: canvasTransform = S^-1 * T_draw * S (the border box maps to the canvas with no transform-origin, WPT get-element-transform) and canvasClip = the source rect, then update (queued for an OffscreenCanvas).
 * @param {HicEnv} env
 * @param {GeometryApi} geometry
 * @param {Context2D} ctx
 * @param {boolean} offscreen
 * @param {CanvasRecord} record
 * @param {Element} element
 * @param {ResolvedRects} r
 * @returns {DOMMatrix} the matrix that is stored (applied at once, or by the queued microtask)
 */
function updateGeometry(env, geometry, ctx, offscreen, record, element, r) {
  const ctm = ctx.getTransform();
  const values = canvasTransformValues(matrixValues(ctm), { ...r.src, dx: r.dx, dy: r.dy, dw: r.dw, dh: r.dh, kx: r.kx, ky: r.ky },
    r.scaleX, r.scaleY, NO_ORIGIN);
  const is2D = ctm.is2D;
  const options = {
    canvasTransform: matrixInit(values, is2D),
    clip: { x: r.src.sx, y: r.src.sy, width: r.src.sw, height: r.src.sh },
    preserveHitTestOrder: false,
  };
  if (offscreen) enqueueGeometry(env, geometry, record, { kind: 'update', element, options });
  else geometry.update(record, element, options);
  return matrixFrom(values, is2D);
}

/**
 * @param {HicEnv} env
 * @param {GeometryApi} geometry
 * @param {Context2D} ctx
 * @param {boolean} offscreen
 * @param {Function} drawImage  the platform drawImage captured at install
 * @param {Function} ctor  the interface the receiver must be an instance of
 * @param {unknown[]} args
 * @returns {DOMMatrix|undefined}  the stored transform for canvases activated by the legacy layoutsubtree attribute, else undefined
 */
function drawElement(env, geometry, ctx, offscreen, drawImage, ctor, args) {
  if (!(ctx instanceof ctor)) throw new TypeError('Illegal invocation');
  if (args.length < 3) parseDrawArgs(args);
  assertTargetType(env, args[0]);
  const parsed = parseDrawArgs(args);
  if (!parsed) return undefined;
  const canvas = canvasOf(ctx, offscreen);
  const { record, element, version } = resolveElement(env, canvas, parsed.target, 'snapshot');
  if (!version) return undefined;
  const r = resolveRects(parsed, version, ctx.canvas.width, ctx.canvas.height);
  const clipped = clipToSurface(r, version);
  let raster = clipped && env.store.rasterSource(version, clipped.src);
  if (clipped && raster) {
    const size = snapDefaultSize(r, clipped, raster, version.scale);
    raster = isolatedSource(ctx, raster, size) ?? raster;
    Reflect.apply(drawImage, ctx, [raster.source, raster.sx, raster.sy, raster.sw, raster.sh, clipped.dx, clipped.dy, size.dw, size.dh]);
  }
  const stored = !parsed.preserveElementGeometry && !r.degenerate
    ? updateGeometry(env, geometry, ctx, offscreen, record, element, r)
    : null;
  if (!record.legacy) return undefined;
  return withLegacyOrigin(stored ?? geometry.get(record, element), version.translation);
}

/** @type {OffscreenCanvas|HTMLCanvasElement|null} */
let scratch = null;

/**
 * A smoothed draw that scales samples past the source rect (bilinear taps, mip levels: allowed for drawImage by the HTML filtering rule) into the surface's transparent ink margin, so the last
 * row/column of the element turns partly transparent (WPT captureElementImage, canvas grid 2x by 0.5x: alpha 191). A native element image has no pixels beyond its rect. Copy the source rect
 * 1:1 into a scratch canvas first (one GPU blit): its edges clamp to the element's own pixels. null: a 1:1 or unsmoothed draw, drawn directly.
 * @param {Context2D} ctx @param {import('../contracts/types.js').RasterSource} raster @param {{dw: number, dh: number}} size
 * @returns {import('../contracts/types.js').RasterSource|null}
 */
function isolatedSource(ctx, raster, size) {
  if (!ctx.imageSmoothingEnabled || (Math.abs(Math.abs(size.dw) - raster.sw) < 1e-6 && Math.abs(Math.abs(size.dh) - raster.sh) < 1e-6)) return null;
  const w = Math.ceil(raster.sw); const h = Math.ceil(raster.sh);
  if (!scratch) scratch = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
  if (scratch.width !== w || scratch.height !== h) { scratch.width = w; scratch.height = h; }
  const sctx = /** @type {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D|null} */ (scratch.getContext('2d'));
  if (!sctx) return null;
  sctx.clearRect(0, 0, w, h);
  sctx.drawImage(raster.source, raster.sx, raster.sy, raster.sw, raster.sh, 0, 0, w, h);
  return { source: scratch, sx: 0, sy: 0, sw: w, sh: h };
}

/**
 * The pre-2026-09 stored matrix T_tr^-1 * M * T_tr: legacy `layoutsubtree` callers assign the return value of drawElementImage to `style.transform` (transform-origin applies), the standard's canvas transform has no origin.
 * @param {DOMMatrix} m
 * @param {DOMMatrixReadOnly} origin  translation to the element's transform origin, taken with the snapshot
 * @returns {DOMMatrix}
 */
function withLegacyOrigin(m, origin) {
  return origin.inverse().multiply(m).multiply(origin);
}

/**
 * Four overloads (api/draw-math.js), snapshot resolution (api/validate.js), one ctx.drawImage from store.rasterSource, then geometry unless preserveElementGeometry (queued microtask for Offscreen).
 * The geometry step passes the version's layoutOffset to record.layer.applyGeometry and never measures layout (ADR-F): a game drawing N elements per frame costs N cache hits / no-ops, not N layouts.
 * Default-size draws pick the source rect from the SURFACE pixel size (fractional DPR 1.25/1.5: no resampling blur). When the canvas was activated by the legacy `layoutsubtree` attribute (record.legacy) the call RETURNS the DOMMatrix of the stored canvas transform
 * (legacy apps pipe it into element.style.transform; the polyfill's !important geometry rule wins, the result is identical); otherwise undefined as in the standard.
 * A draw whose source or destination rect is empty paints nothing and leaves the geometry alone (no scale can be derived from it).
 * @param {HicEnv} env
 * @param {PatchLedger} ledger
 * @param {GeometryApi} geometry
 */
export function installContext2DPatches(env, ledger, geometry) {
  const win = globalsOf(env);
  /** @type {Array<[Function|undefined, boolean]>} */
  const interfaces = [[win.CanvasRenderingContext2D, false], [win.OffscreenCanvasRenderingContext2D, true]];
  for (const [ctor, offscreen] of interfaces) {
    if (!ctor) continue;
    const proto = ctor.prototype;
    const drawImage = /** @type {Function} */ (/** @type {any} */ (proto).drawImage);
    defineMethod(ledger, proto, 'drawElementImage', 3, /** @this {Context2D} */ function (/** @type {unknown[]} */ ...args) {
      return drawElement(env, geometry, this, offscreen, drawImage, ctor, args);
    });
  }
}
