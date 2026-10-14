/**
 * WebKit box-shadow fallback for the 'transform' scale mode.
 * Module: snapshot-capture (src/snapshot/capture/*).
 *
 * Measured in WebKit (Safari 27 lineage, Playwright WebKit 26.5): inside an SVG image, an OUTER box-shadow under a CSS `transform: scale(s)` is painted clipped and
 * shifted (WebKit draws the shape off-clip and brings the shadow back with a device-space offset that ignores the scale): a focus ring `0 0 0 3px` came out as a box
 * over the right half of the field and beyond it. A blurred box-shadow is not painted at all, even at scale 1. `zoom` paints shadows right but sets text 7 % narrower
 * `outline` and `filter: drop-shadow()` paint right under the scale, so the clone carries the outer shadows as those:
 * - a single spread-only ring (no offset, no blur) becomes an outline of the same width and colour (the outline follows border-radius like the spread does);
 * - other outer shadows become drop-shadow(x y blur/2 color) when the element has no filter and is positioned (a filter makes a containing block for absolute
 *   descendants: never on a static element), else they are dropped (they were mispainted, never right);
 * inset shadows stay (not painted under the scale either, but never misplaced).
 */

/** @typedef {{color: string, x: number, y: number, blur: number, spread: number, inset: boolean}} Shadow */

/** @param {string} value a computed box-shadow @returns {Shadow[]} (empty for none or an unparsable value) */
export function parseShadows(value) {
  if (!value || value === 'none') return [];
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { parts.push(value.slice(start, i)); start = i + 1; }
  }
  parts.push(value.slice(start));
  /** @type {Shadow[]} */
  const out = [];
  for (const part of parts) {
    const color = /(?:rgba?|hsla?|color|oklch|oklab|lab|lch)\([^)]*\)|#[0-9a-f]{3,8}\b|\b(?:transparent|currentcolor|[a-z]+)\b(?![\d(])/i.exec(part.replace(/\binset\b/, ''));
    const lengths = [...part.matchAll(/(-?[\d.]+)px/g)].map((m) => Number(m[1]));
    if (lengths.length < 2) return [];
    out.push({ color: color ? color[0] : 'currentcolor', x: lengths[0], y: lengths[1], blur: lengths[2] ?? 0, spread: lengths[3] ?? 0, inset: /\binset\b/.test(part) });
  }
  return out;
}

/** @param {Shadow} s @returns {string} */
const css = (s) => `${s.color} ${s.x}px ${s.y}px ${s.blur}px ${s.spread}px${s.inset ? ' inset' : ''}`;

/**
 * The inline declarations that replace the outer shadows, or '' when there is nothing to change.
 * @param {{boxShadow: string, outlineStyle: string, filter: string, position: string}} cs computed values of the live element
 * @returns {string}
 */
export function webkitShadowStyle(cs) {
  const all = parseShadows(cs.boxShadow);
  const outer = all.filter((s) => !s.inset);
  if (!outer.length) return '';
  const inset = all.filter((s) => s.inset);
  let decl = `box-shadow:${inset.length ? inset.map(css).join(', ') : 'none'}!important;`;
  const ring = outer.length === 1 && !outer[0].x && !outer[0].y && !outer[0].blur && outer[0].spread > 0 ? outer[0] : null;
  if (ring && cs.outlineStyle === 'none') return `${decl}outline:${ring.spread}px solid ${ring.color}!important;outline-offset:0px!important;`;
  if ((!cs.filter || cs.filter === 'none') && cs.position && cs.position !== 'static') {
    decl += `filter:${outer.map((s) => `drop-shadow(${s.color} ${s.x}px ${s.y}px ${s.blur / 2}px)`).join(' ')}!important;`;
  }
  return decl;
}
