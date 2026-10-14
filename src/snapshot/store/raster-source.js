/**
 * PURE: css source rect -> surface pixel rect.
 * Module: snapshot-store (src/snapshot/store/*).
 */

/** @typedef {import('../../contracts/types.js').RasterSource} RasterSource */
/** @typedef {import('../../contracts/types.js').SnapshotVersion} SnapshotVersion */
/** @typedef {import('../../contracts/types.js').SourceRectCss} SourceRectCss */

const EPS = 1e-6;

/** Removes float noise (1234 / 2.5 * 2.5) so a default-size draw stays a 1:1 pixel copy. @param {number} n */
const snap = (n) => (Math.abs(n - Math.round(n)) < EPS ? Math.round(n) : n);

/**
 * sx*s, sy*s offset by the ink margin; clipped to the surface; null when there is no overlap (or the rect is empty / not finite).
 * The result can be SMALLER than the request when the request reaches past the surface: the caller shrinks its destination by the same ratio.
 * @param {SnapshotVersion} v
 * @param {SourceRectCss} r
 * @returns {RasterSource|null}
 */
export function rasterSourceFor(v, r) {
  if (![r.sx, r.sy, r.sw, r.sh].every(Number.isFinite) || r.sw <= 0 || r.sh <= 0) return null;
  const surface = v.surface;
  const x0 = Math.max(0, snap((r.sx + v.ink.left) * v.scale));
  const y0 = Math.max(0, snap((r.sy + v.ink.top) * v.scale));
  const x1 = Math.min(surface.width, snap((r.sx + r.sw + v.ink.left) * v.scale));
  const y1 = Math.min(surface.height, snap((r.sy + r.sh + v.ink.top) * v.scale));
  if (x1 <= x0 || y1 <= y0) return null;
  return { source: surface, sx: x0, sy: y0, sw: x1 - x0, sh: y1 - y0 };
}
