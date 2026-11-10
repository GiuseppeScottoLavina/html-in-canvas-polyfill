// Shared by prune-structure-*.browser.test.mjs: the matrix of selectors that count siblings against pruned clones (docs/TEST-PLAN.md, G-prune-structure).
// A page's CSS may hold selectors whose match depends on sibling positions. A damage-pruned clone replaces the children outside its tile by spacers, merges runs of
// them and leaves trailing ones out; where a selector can see that, it must not (clone.js siblingRules). The oracle is the selectors themselves: every element of the
// pruned clone (kept or spacer) must match exactly the selectors its live element matches. Pixels are compared as well (the pruned tile against the full one).
import { assert } from '/test/unit/lib/t.js';
import { mount, rasterize, diffFraction, inkFraction } from './_support.mjs';

/** a small deterministic generator (mulberry32) @param {number} seed */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (/** @type {number} */ n) => Math.floor(next() * n), pick: (/** @type {any[]} */ list) => list[Math.floor(next() * list.length)], chance: (/** @type {number} */ p) => next() < p };
}

export const BASE = '.l{width:200px;font:12px/20px sans-serif}.l div,.l p,.l section,.l h3{margin:0;min-height:20px;background:#fafafa}.g{padding-left:8px}';

let serial = 0;
/**
 * Rows of a container: block children with ids (the clone keeps them: they pair a clone element with its live one), a mix of types and classes.
 * @param {ReturnType<typeof rng>} r @param {number} n @param {{tags?: string[], nested?: number}} [o]
 */
export function rows(r, n, o = {}) {
  const tags = o.tags ?? ['div', 'div', 'div', 'p', 'section'];
  let html = '';
  for (let i = 0; i < n; i++) {
    const tag = r.pick(tags);
    const cls = ['c', ...(r.chance(0.3) ? ['a'] : []), ...(r.chance(0.25) ? ['b'] : []), ...(r.chance(0.12) ? ['k'] : [])].join(' ');
    const attr = r.chance(0.12) ? ' data-x="1"' : '';
    if (o.nested && r.chance(o.nested)) html += `<div id="e${serial++}" class="g ${cls}"${attr}>${rows(r, 10 + r.int(6), { tags })}</div>`;
    else html += `<${tag} id="e${serial++}" class="${cls}"${attr}><span>row ${i}</span></${tag}>`;
  }
  return html;
}

/** The elements of a capture result's clone that carry an id, by id. @param {{url: string}} result @returns {Map<string, Element>} */
export function cloneElements(result) {
  const svg = decodeURIComponent(result.url.slice(result.url.indexOf(',') + 1));
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('the clone does not parse');
  /** @type {Map<string, Element>} */
  const out = new Map();
  for (const el of doc.querySelectorAll('[id]')) if (/^e\d+$/.test(el.id)) out.set(el.id, el);
  return out;
}

/**
 * Every clone element with an id matches exactly the selectors its live element matches. Returns the mismatches (empty: parity).
 * @param {{url: string}} result @param {string[]} selectors
 * @returns {string[]}
 */
export function mismatches(result, selectors) {
  const bad = [];
  for (const [id, clone] of cloneElements(result)) {
    const live = document.getElementById(id);
    if (!live) { bad.push(`${id}: no live element`); continue; }
    // a hidden stand-in (the tail left out) takes no part: it paints nothing and takes no room
    if (/display:\s*none/.test(clone.getAttribute('style') ?? '') && !/display:\s*none/.test(live.getAttribute('style') ?? '')) continue;
    for (const sel of selectors) if (clone.matches(sel) !== live.matches(sel)) bad.push(`${id} ${clone.hasAttribute('data-hic-sp') ? '(spacer) ' : ''}${sel}: clone ${clone.matches(sel)}, live ${live.matches(sel)}`);
  }
  return bad;
}

/** spacers and hidden stand-ins in a clone @param {{url: string}} result */
export function shape(result) {
  const svg = decodeURIComponent(result.url.slice(result.url.indexOf(',') + 1));
  return { spacers: (svg.match(/data-hic-sp=/g) ?? []).length, ids: cloneElements(result).size, bytes: svg.length };
}

/**
 * One case: `html` in a drawable `.l` with `css`, a crop of 80 px at `y`. The pruned capture against the selectors, and (with `pixels`) against the full tile.
 * @param {string} html @param {string} css @param {string[]} selectors @param {number} y @param {{pixels?: boolean, height?: number}} [o]
 */
export async function runCase(html, css, selectors, y, o = {}) {
  const m = mount(`<div class="l" id="e${serial++}" drawable>${html}</div>`, { css: BASE + css, height: o.height ?? 4000 });
  const el = /** @type {HTMLElement} */ (m.layerEl.firstElementChild);
  const total = el.offsetHeight;
  const rect = { x: 0, y: Math.max(0, Math.min(y, total - 80)), width: 200, height: 80 };
  const pruned = m.capture(m.request(el, { rect, prune: true }));
  // every style rule of the page counts, not only this case's (a test that runs several cases leaves their sheets in the page until it ends)
  // (not :has(): a spacer has no descendants, so a rule that asks for one no longer matches it; its size is pinned and its margin comes from the live gap)
  const all = new Set(selectors);
  for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) if (/** @type {CSSStyleRule} */ (rule).selectorText) all.add(/** @type {CSSStyleRule} */ (rule).selectorText); } catch { /* a sheet of another origin */ } }
  const bad = mismatches(pruned, [...all].filter((sel) => { try { document.querySelector(sel); return !/hic-|::|:has\(/.test(sel); } catch { return false; } }));
  let diff = 0;
  if (o.pixels) {
    const full = await rasterize(m.capture(m.request(el, { rect })));
    assert.ok(inkFraction(full) > 0.5, 'the full tile has content');
    diff = diffFraction(await rasterize(pruned), full);
  }
  return { bad, diff, pruned, total, children: el.children.length, live: el.querySelectorAll('[id]').length + 1, ...shape(pruned), el, m };
}
