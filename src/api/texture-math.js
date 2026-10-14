/**
 * PURE texture upload rectangle rules shared by WebGL, WebGL2 and WebGPU variants (docs/API-CONTRACT.md 5.3).
 * Module: api-surface (src/api/*).
 */

/**
 * @typedef {Object} UploadPlan
 * @property {{sx: number, sy: number, sw: number, sh: number}} sourceCss  source rect in the border-box frame (css px)
 * @property {number} width   destination width in texels (integer)
 * @property {number} height
 * @property {boolean} resample  the surface pixel size of the source rect differs from (width, height): go through a scratch 2D canvas
 */

/** Absorbs the floating-point noise of products such as 100.5 * (126 / 100.5) before ceil/floor. */
const EPS = 1e-9;

/**
 * @param {string} name @param {unknown} v
 * @returns {number|undefined}  undefined when absent
 * @throws TypeError when present but not a finite number
 */
function optionalNumber(name, v) {
  if (v === undefined) return undefined;
  const n = +(/** @type {any} */ (v));
  if (!Number.isFinite(n)) throw new TypeError(`texture config: ${name} must be a finite number`);
  return n;
}

/**
 * @param {string} name @param {unknown} v
 * @returns {number|undefined}  integer texel count, undefined when absent
 */
function optionalTexels(name, v) {
  const n = optionalNumber(name, v);
  if (n === undefined) return undefined;
  if (n < 0) throw new TypeError(`texture config: ${name} must not be negative`);
  return Math.trunc(n);
}

/**
 * Default destination size = ceil(ElementImage.width), ceil(ElementImage.height) (grid px; issue 174 tells apps to preallocate exactly that); config.width/height override; config.swidth/sheight/sx/sy select the source rect.
 * A sub-rect without explicit width/height keeps the same grid scale (ceil of swidth * ElementImage.width / border-box width).
 * `resample` is true whenever the surface pixels covering the source rect (rounded out to whole pixels at `surfaceScale`) are not (width x height): canvas grid scale < 1,
 * above maxDpr, fractional sizes that round differently, an explicit config size. The WPT element-image-fractional-size decides rounding when it disagrees with ceil.
 * @param {{width: number, height: number}} elementImageSize  grid px (ElementImage.width/height)
 * @param {{width: number, height: number, scaleX: number, scaleY: number}} snapshotCss  border box css px and the canvas grid scale at snapshot time (scale only used when the border box is empty)
 * @param {{sx?: number, sy?: number, swidth?: number, sheight?: number, width?: number, height?: number}} config
 * @param {number} surfaceScale  surface px per css px (SnapshotVersion.scale)
 * @returns {UploadPlan}
 * @throws TypeError on a non-finite member or a negative size
 */
export function planUpload(elementImageSize, snapshotCss, config, surfaceScale) {
  const sx = optionalNumber('sx', config.sx) ?? 0;
  const sy = optionalNumber('sy', config.sy) ?? 0;
  const sw = optionalNumber('swidth', config.swidth) ?? snapshotCss.width;
  const sh = optionalNumber('sheight', config.sheight) ?? snapshotCss.height;
  if (sw < 0 || sh < 0) throw new TypeError('texture config: swidth/sheight must not be negative');
  const gridX = snapshotCss.width > 0 ? elementImageSize.width / snapshotCss.width : snapshotCss.scaleX;
  const gridY = snapshotCss.height > 0 ? elementImageSize.height / snapshotCss.height : snapshotCss.scaleY;
  const naturalW = sw === snapshotCss.width ? elementImageSize.width : sw * gridX;
  const naturalH = sh === snapshotCss.height ? elementImageSize.height : sh * gridY;
  const width = optionalTexels('width', config.width) ?? Math.max(0, Math.ceil(naturalW - EPS));
  const height = optionalTexels('height', config.height) ?? Math.max(0, Math.ceil(naturalH - EPS));
  const surfaceW = Math.ceil((sx + sw) * surfaceScale - EPS) - Math.floor(sx * surfaceScale + EPS);
  const surfaceH = Math.ceil((sy + sh) * surfaceScale - EPS) - Math.floor(sy * surfaceScale + EPS);
  return { sourceCss: { sx, sy, sw, sh }, width, height, resample: surfaceW !== width || surfaceH !== height };
}

/**
 * Where the requested source rect lands inside a (width x height) destination once it is clipped to the area the surface covers (border box + ink):
 * texels outside the surface stay transparent, the visible part keeps its place. null when nothing overlaps or a side is empty.
 * @param {UploadPlan} plan
 * @param {{width: number, height: number, ink: {left: number, top: number, right: number, bottom: number}}} version
 * @returns {{src: {sx: number, sy: number, sw: number, sh: number}, dx: number, dy: number, dw: number, dh: number, whole: boolean}|null}
 *   `whole` = the rect is not clipped
 */
export function clipPlanToSurface(plan, version) {
  const { sx, sy, sw, sh } = plan.sourceCss;
  if (!(sw > 0 && sh > 0 && plan.width > 0 && plan.height > 0)) return null;
  const kx = plan.width / sw;
  const ky = plan.height / sh;
  const x0 = Math.max(sx, -version.ink.left);
  const y0 = Math.max(sy, -version.ink.top);
  const x1 = Math.min(sx + sw, version.width + version.ink.right);
  const y1 = Math.min(sy + sh, version.height + version.ink.bottom);
  if (!(x1 > x0) || !(y1 > y0)) return null;
  return {
    src: { sx: x0, sy: y0, sw: x1 - x0, sh: y1 - y0 },
    dx: (x0 - sx) * kx,
    dy: (y0 - sy) * ky,
    dw: (x1 - x0) * kx,
    dh: (y1 - y0) * ky,
    whole: x0 === sx && y0 === sy && x1 === sx + sw && y1 === sy + sh,
  };
}
