/**
 * Option parsing of the example plugins (plugins/_lib/: bundled into each plugin that imports it). `Number(v)` semantics: `null`, `''` and
 * `false` read as 0, `true` as 1 (unlike clampNumber of transition.js, which accepts only numbers and numeric strings).
 */

/** `v` as a number clamped to [lo, hi]; `fallback` when it is not finite. @param {unknown} v @param {number} lo @param {number} hi @param {number} fallback */
export function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/** clampNum with the range as a pair. @param {unknown} v @param {readonly [number, number]} range @param {number} fallback */
export const clampTo = (v, [lo, hi], fallback) => clampNum(v, lo, hi, fallback);
