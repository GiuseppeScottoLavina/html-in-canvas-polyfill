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

/**
 * The SYSTEM classic bar of macOS WebKit (an unstyled scroller under "Show scroll bars: Always", or with a mouse attached), drawn by AppKit: a lane (pill) inset 3 css px
 * from every edge of the gutter, and the knob (pill) in it. Measured on Safari 27.0.1 (macOS, DPR 2), plain-DOM screenshots of 523 knobs: 19 content heights from 372 to
 * 31000 px, clients of 300 and 120 px, 5 to 23 offsets each, light and dark, square, rounded and bordered scrollers, regular (17 px) and thin (13 px) bars:
 * - the knob's length is the lane's share of the visible content, floor(lane x visible / total), at least MIN (20 px, 16 px thin);
 * - its offset in the lane is the scroll offset's share of the free lane, with the knob's UNROUNDED length, v x (lane - max(MIN, lane x visible / total)), cut to 1/256 px
 *   and then rounded UP to a whole css px (offsets 1/256 above a whole px move the knob, 1/262 do not: 50 offsets measured within 1/100 px of a whole one);
 * - every edge on a whole css px; no fade, no change while scrolling or under the WebDriver pointer.
 * The lane is always the client height less 6; the gutter of a bar that is neither regular nor thin was not measured (WEBKIT_SYSTEM_MIN has no entry for it).
 */

/** The knob's minimum length per gutter width (css px) of the system bar: regular 17 px, thin (`scrollbar-width: thin`) 13 px. */
export const WEBKIT_SYSTEM_MIN = /** @type {Readonly<Record<number, number>>} */ (Object.freeze({ 17: 20, 13: 16 }));
/** The lane's inset from every edge of the gutter, css px. */
export const WEBKIT_SYSTEM_INSET = 3;

/**
 * PURE. Where AppKit puts the knob of WebKit's system classic bar (see above).
 * @param {number} lane  the lane's length, css px (the client height less 2 x WEBKIT_SYSTEM_INSET) @param {number} visible  clientHeight @param {number} total  scrollHeight
 * @param {number} offset  scrollTop @param {number} min  the knob's minimum length (WEBKIT_SYSTEM_MIN)
 * @returns {{start: number, length: number}|null}  in the lane, css px; null when nothing scrolls or the knob does not fit the lane
 */
export function webkitSystemKnob(lane, visible, total, offset, min) {
  if (!(total > visible) || !(lane > 0)) return null;
  const exact = Math.max(min, (lane * visible) / total);
  if (exact > lane) return null;
  const free = lane - exact, x = (Math.min(Math.max(0, offset), total - visible) / (total - visible)) * free;
  return { start: Math.min(Math.ceil(free), Math.ceil(Math.floor(x * 256) / 256)), length: Math.floor(exact) };
}
