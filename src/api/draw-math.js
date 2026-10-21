/**
 * Pure math of drawElementImage (spec "draw an element"); no DOM access. Matrices are 16-number arrays (util/matrix.js) so the
 * module runs in node:test without a DOMMatrix.
 * Module: api-surface (src/api/*).
 */

import { invertTranslation16, multiply16, scale16, translation16 } from '../util/matrix.js';

/** @typedef {import('../contracts/types.js').RasterSource} RasterSource */
/** @typedef {import('../contracts/types.js').SnapshotVersion} SnapshotVersion */
/** @typedef {import('../contracts/types.js').SourceRectCss} SourceRectCss */

/**
 * @typedef {Object} DrawArgs  normalized arguments of the four overloads
 * @property {unknown} target  Element or ElementImage (not validated here)
 * @property {number} sx @property {number} sy @property {number} sw @property {number} sh  NaN when defaulted
 * @property {number} dx @property {number} dy
 * @property {number} dw @property {number} dh  NaN when defaulted
 * @property {boolean} hasSource  overload 3 or 4
 * @property {boolean} preserveElementGeometry
 */

/**
 * @typedef {Object} ResolvedRects
 * @property {SourceRectCss} src  normalised source rect, css px of the border-box frame
 * @property {number} dx @property {number} dy @property {number} dw @property {number} dh  normalised destination rect (positive size), output bitmap px
 * @property {number} scaleX @property {number} scaleY  output bitmap px per css px of the canvas content box at snapshot time
 * @property {number} kx @property {number} ky  destination px per source css px (the spec's dw/sw, exactly scaleX when dw was omitted)
 * @property {boolean} dwDefaulted @property {boolean} dhDefaulted
 * @property {boolean} degenerate  a source or destination side is zero: nothing is painted and no geometry can be derived
 */

/** Numeric counts of the four overloads. */
const ARITIES = [2, 4, 6, 8];

/**
 * Select the overload by argument count/types. Returns null when any numeric argument is NaN/infinite (spec: return silently). TypeError on a bad arity.
 * Numbers are converted with unary plus (WebIDL ToNumber: a Symbol or BigInt throws TypeError) BEFORE the NaN check, as WebIDL does.
 * @param {unknown[]} args  [element, ...numbers, options?]
 * @returns {DrawArgs|null}
 * @throws TypeError
 */
export function parseDrawArgs(args) {
  if (args.length < 3) throw new TypeError(`Failed to execute 'drawElementImage': 3 arguments required, but only ${args.length} present.`);
  const n = args.length - 1;
  const hasOptions = n % 2 === 1;
  const count = hasOptions ? n - 1 : n;
  if (!ARITIES.includes(count)) throw new TypeError(`Failed to execute 'drawElementImage': no overload takes ${count} numeric arguments.`);
  const nums = args.slice(1, 1 + count).map(v => +(/** @type {any} */ (v)));
  const preserveElementGeometry = hasOptions ? readPreserve(args[args.length - 1]) : false;
  if (nums.some(v => !Number.isFinite(v))) return null;
  const hasSource = count >= 6;
  const off = hasSource ? 4 : 0;
  return {
    target: args[0],
    sx: hasSource ? nums[0] : NaN,
    sy: hasSource ? nums[1] : NaN,
    sw: hasSource ? nums[2] : NaN,
    sh: hasSource ? nums[3] : NaN,
    dx: nums[off],
    dy: nums[off + 1],
    dw: count === 4 || count === 8 ? nums[off + 2] : NaN,
    dh: count === 4 || count === 8 ? nums[off + 3] : NaN,
    hasSource,
    preserveElementGeometry,
  };
}

/** @param {unknown} o DrawElementImageOptions @returns {boolean} */
function readPreserve(o) {
  if (o === undefined || o === null) return false;
  if (typeof o !== 'object' && typeof o !== 'function') throw new TypeError("Failed to execute 'drawElementImage': the options argument is not an object.");
  return Boolean(/** @type {{preserveElementGeometry?: unknown}} */ (o).preserveElementGeometry);
}

/**
 * Apply defaults (sw,sh = version size; dw,dh = sw*scaleX, sh*scaleY), normalise negative sizes WITHOUT mirroring (the rect is flipped to a
 * positive size, the pixels keep their orientation).
 * @param {DrawArgs} args
 * @param {Pick<SnapshotVersion, 'width'|'height'|'canvasWidth'|'canvasHeight'>} version
 * @param {number} outputWidth  context output bitmap width in px
 * @param {number} outputHeight
 * @returns {ResolvedRects}
 */
export function resolveRects(args, version, outputWidth, outputHeight) {
  const scaleX = version.canvasWidth > 0 ? outputWidth / version.canvasWidth : 1;
  const scaleY = version.canvasHeight > 0 ? outputHeight / version.canvasHeight : 1;
  let sx = args.hasSource ? args.sx : 0;
  let sy = args.hasSource ? args.sy : 0;
  let sw = args.hasSource ? args.sw : version.width;
  let sh = args.hasSource ? args.sh : version.height;
  if (sw < 0) { sx += sw; sw = -sw; }
  if (sh < 0) { sy += sh; sh = -sh; }
  const dwDefaulted = Number.isNaN(args.dw);
  const dhDefaulted = Number.isNaN(args.dh);
  let dw = dwDefaulted ? sw * scaleX : args.dw;
  let dh = dhDefaulted ? sh * scaleY : args.dh;
  let dx = args.dx;
  let dy = args.dy;
  if (dw < 0) { dx += dw; dw = -dw; }
  if (dh < 0) { dy += dh; dh = -dh; }
  const degenerate = !(sw > 0 && sh > 0 && dw > 0 && dh > 0);
  return {
    src: { sx, sy, sw, sh },
    dx, dy, dw, dh,
    scaleX, scaleY,
    kx: dwDefaulted ? scaleX : dw / sw,
    ky: dhDefaulted ? scaleY : dh / sh,
    dwDefaulted, dhDefaulted, degenerate,
  };
}

/**
 * Clip the requested source rect to the area the surface covers (border box + ink) and shrink the destination proportionally, so the
 * store is never asked for pixels it does not have and the visible part stays where the spec puts it. null when nothing overlaps.
 * @param {ResolvedRects} r
 * @param {Pick<SnapshotVersion, 'width'|'height'|'ink'>} version
 * @returns {{src: SourceRectCss, dx: number, dy: number, dw: number, dh: number}|null}
 */
export function clipToSurface(r, version) {
  if (r.degenerate) return null;
  const x0 = Math.max(r.src.sx, -version.ink.left);
  const y0 = Math.max(r.src.sy, -version.ink.top);
  const x1 = Math.min(r.src.sx + r.src.sw, version.width + version.ink.right);
  const y1 = Math.min(r.src.sy + r.src.sh, version.height + version.ink.bottom);
  if (!(x1 > x0) || !(y1 > y0)) return null;
  return {
    src: { sx: x0, sy: y0, sw: x1 - x0, sh: y1 - y0 },
    dx: r.dx + (x0 - r.src.sx) * r.kx,
    dy: r.dy + (y0 - r.src.sy) * r.ky,
    dw: (x1 - x0) * r.kx,
    dh: (y1 - y0) * r.ky,
  };
}

/** A requested size this close to the raster (under 1 px and 1 %) is the same picture rounded differently: drawn 1:1. */
const NEAR_PX = 1;
const NEAR_SHARE = 0.01;

/** @param {number} want @param {number} have @returns {boolean} */
const near = (want, have) => Math.abs(want - have) < NEAR_PX && Math.abs(want - have) <= NEAR_SHARE * have;

/**
 * Draws copy surface pixels 1:1 when that is what the call means, because resampling a raster by a factor a hair from 1 blurs every edge by up to half a pixel where the
 * native draw (a vector paint record) stays sharp:
 *   - default size (dw/dh omitted): the destination spans exactly the surface pixels that the store returned, not the fractional `sw * scaleX` (125.625 px at DPR 1.25),
 *     when the canvas grid scale equals the raster scale, or when the destination is within 1 px and 1 % of the raster at a scale within 1 % of it (a content box
 *     210.5 device px high gets a ResizeObserver device-pixel grid of 211 px, y scale 1.25297, rasterised at the device pixel ratio: snapshot/store/surfaces.js
 *     gridRasterScale; resampled by 1.0024, the text of the field test's scroll box at DPR 1.25 was 7.7 % of its pixels away from the page);
 *   - an explicit size within 1 px and 1 % of the raster (the explainer's `el.offsetWidth * devicePixelRatio`: a rounded offsetWidth against a fractional border box at
 *     DPR 1.25 / 1.5 asked for 1472.5 px of a 1473 px raster, and the bilinear resample put the polyfill 2.5 % of the pixels away from native instead of 1.7 %).
 * Only when the source rect was not clipped.
 * @param {ResolvedRects} r
 * @param {{src: SourceRectCss, dw: number, dh: number}} clipped  result of clipToSurface
 * @param {{sw: number, sh: number}} raster  pixel size of the RasterSource
 * @param {number} surfaceScale  SnapshotVersion.scale
 * @returns {{dw: number, dh: number}}
 */
export function snapDefaultSize(r, clipped, raster, surfaceScale) {
  const unclipped = clipped.src.sw === r.src.sw && clipped.src.sh === r.src.sh;
  // a default size is snapped at the raster's own scale, or near it at a scale within 1 % of it; an explicit size when it is near
  const same = (/** @type {boolean} */ defaulted, /** @type {number} */ scale) => defaulted && Math.abs(scale - surfaceScale) < 1e-6;
  const close = (/** @type {boolean} */ defaulted, /** @type {number} */ scale) => !defaulted || Math.abs(scale / surfaceScale - 1) <= NEAR_SHARE;
  const snapW = unclipped && (same(r.dwDefaulted, r.scaleX) || (close(r.dwDefaulted, r.scaleX) && near(clipped.dw, raster.sw)));
  const snapH = unclipped && (same(r.dhDefaulted, r.scaleY) || (close(r.dhDefaulted, r.scaleY) && near(clipped.dh, raster.sh)));
  return { dw: snapW ? raster.sw : clipped.dw, dh: snapH ? raster.sh : clipped.dh };
}

/**
 * @typedef {Object} TransformRects
 * @property {number} sx @property {number} sy @property {number} sw @property {number} sh
 * @property {number} dx @property {number} dy @property {number} dw @property {number} dh
 * @property {number} [kx]  override of dw / sw (pass the exact scale when dw was omitted)
 * @property {number} [ky]
 */

/**
 * M = T_tr^-1 * S^-1 * T_draw * T_tr with T_draw = CTM * translate(dx,dy) * scale(dw/sw,dh/sh) * translate(-sx,-sy) (docs/ARCHITECTURE.md ADR-F), as numbers: no DOMMatrix is created (the draw hot path compares numbers before it allocates).
 * @param {ArrayLike<number>} ctm  16 values
 * @param {TransformRects} r
 * @param {number} scaleX
 * @param {number} scaleY
 * @param {ArrayLike<number>} translation  16 values of the transform-origin translation (pure translation)
 * @returns {number[]}
 */
export function canvasTransformValues(ctm, r, scaleX, scaleY, translation) {
  const kx = r.kx ?? r.dw / r.sw;
  const ky = r.ky ?? r.dh / r.sh;
  let draw = multiply16(ctm, translation16(r.dx, r.dy));
  draw = multiply16(draw, scale16(kx, ky));
  draw = multiply16(draw, translation16(-r.sx, -r.sy));
  return storedTransformValues(draw, scaleX, scaleY, translation);
}

/**
 * M = T_tr^-1 * S^-1 * T_draw * T_tr for an already composed T_draw: the matrix the spec stores for a draw, and what the legacy
 * `getElementTransform(element, drawTransform)` overload returns.
 * @param {ArrayLike<number>} draw  16 values of T_draw
 * @param {number} scaleX
 * @param {number} scaleY
 * @param {ArrayLike<number>} translation  16 values of the transform-origin translation (pure translation)
 * @returns {number[]}
 */
export function storedTransformValues(draw, scaleX, scaleY, translation) {
  const inner = multiply16(multiply16(scale16(1 / scaleX, 1 / scaleY), draw), translation);
  return multiply16(invertTranslation16(translation), inner);
}
