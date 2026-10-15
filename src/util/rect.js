/** Pure rectangle helpers shared by modules. */

/** @typedef {import('../contracts/types.js').Rect} Rect */

/** @param {Rect|null} a @param {Rect|null} b @returns {Rect|null} bounding union; null only when both are null */
export function unionRect(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** @param {Rect} a @param {Rect} b @returns {Rect|null} null when the intersection is empty */
export function intersectRect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  return x2 > x && y2 > y ? { x, y, width: x2 - x, height: y2 - y } : null;
}

/** @param {Rect} r @param {number} by @returns {Rect} grown by `by` on every side */
export function inflateRect(r, by) {
  return { x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by };
}

/** @param {Rect} r @param {number} scale @returns {Rect} grid-aligned (floor origin, ceil far edge) after scaling by `scale` */
export function roundOutRect(r, scale = 1) {
  const x = Math.floor(r.x * scale);
  const y = Math.floor(r.y * scale);
  return { x, y, width: Math.ceil((r.x + r.width) * scale) - x, height: Math.ceil((r.y + r.height) * scale) - y };
}

/**
 * Does the last ResizeObserver entry report exactly the content box already measured (css px, physical width / height)? A different or fractional rounding just answers false.
 * @param {ResizeObserverEntry[]} entries @param {{width: number, height: number}|null|undefined} box @returns {boolean}
 */
export function sameContentRect(entries, box) {
  const r = entries[entries.length - 1]?.contentRect;
  return !!r && !!box && r.width === box.width && r.height === box.height;
}
