/**
 * PURE. Where WebKit (Safari) puts the thumb of a classic scrollbar: shared by the painter of the clone's bars and the scroll compositor, which moves the thumb tile by the
 * same numbers. Module: snapshot-capture (src/snapshot/capture/*).
 *
 * WebKit computes the thumb in whole css px (ScrollbarThemeComposite::thumbLength / thumbPosition): its length is round(visible / total x track), at least the
 * minimum, and no thumb at all when the minimum does not fit the track; its offset in the track is the scroll offset's share of the free track TRUNCATED, except
 * that an offset under 1 px but above 0 shows as 1 px. Measured on Safari 27.0.1 (macOS, DPR 2), author-styled bars (`::-webkit-scrollbar`): a 300 px track over
 * 2480 px of content shows a 36 px thumb at 0, 1 (from scrollTop 1 to 13), 6, 11 (at 99), 12 (at 100), 40, 72, 121, 181, 242, 263 and 264 px for scrollTop 0, 1-13,
 * 50, 99, 100, 333, 600, 1000, 1500, 2000, 2179 and 2180 (the end); every edge on a whole css px (whole rows of device pixels, the same antialiasing at every offset).
 */

/**
 * @param {number} track  the track's length, css px @param {number} visible  clientHeight @param {number} total  scrollHeight @param {number} offset  scrollTop
 * @param {number} min  the thumb's minimum length, css px
 * @returns {{start: number, length: number}|null}  in the track, css px; null when no thumb shows
 */
export function webkitThumb(track, visible, total, offset, min) {
  const t = Math.floor(track);
  if (!(total > visible) || t <= 0) return null;
  const length = Math.max(Math.round((visible / total) * t), min);
  if (length > t) return null;
  // in single precision, as WebKit computes it (an offset whose exact share is a whole number may land just below it)
  const f = Math.fround;
  const pos = f(f(f(Math.max(0, offset)) * (t - length)) / (total - visible));
  return { start: pos > 0 && pos < 1 ? 1 : Math.min(t - length, Math.trunc(pos)), length };
}
