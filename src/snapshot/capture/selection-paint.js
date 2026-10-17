/**
 * The colours the engine paints a text selection with (feature caret-selection): the background under the selected glyphs and the colour of the glyphs.
 * Module: snapshot-capture (src/snapshot/capture/*).
 *
 * Measured in Chrome 155 (macOS and Linux):
 *  - Without an author `::selection` rule the background is the system colour Highlight, translucent (rgba(128,188,254,0.6) on macOS, rgba(0,65,198,0.8) on Linux),
 *    composited over the backdrop. The glyphs are painted in HighlightText where the platform paints a selection foreground (util/engine.js selectionForegroundOf:
 *    #ffffff on Linux, on dark and on light controls alike); on macOS they keep their own colour.
 *  - With an author `::selection` rule on the element or on an ancestor (highlight inheritance) the background is that rule's background-color (transparent when the
 *    rule sets none: no Highlight then) and the glyphs are its color (the element's own colour when the rule sets none), on every platform.
 * getComputedStyle(el, '::selection') cannot tell "no rule" apart: for an element no rule matches it reports the colour of some other element (measured, Chrome 155),
 * so the rules are found in the CSSOM (document and shadow-root sheets, adopted sheets, `@import`, `@media` and `@supports` evaluated, nesting resolved). Sheets whose cssRules
 * throw (cross-origin without CORS) are not seen: their `::selection` rules are not honoured.
 */

import { splitSelectorList } from './css-rewrite.js';
import { measuringContext, parseColor } from './caret-overlay.js';
import { currentSelectionForeground } from '../../util/engine.js';

/**
 * @typedef {Object} SelectionPaint
 * @property {string} background  a CSS colour, possibly translucent or transparent
 * @property {string|null} foreground  the glyph colour, or null: the glyphs keep their own colour
 */

/**
 * @typedef {Object} SelectionPainter
 * @property {(el: Element) => SelectionPaint} paint  the selection colours of the text whose parent element is `el`
 */

/**
 * A system colour as the engine resolves it, read through a canvas (a DOM probe would mutate the live page). Canvas serialises an opaque colour as #rrggbb.
 * @param {Document} doc @param {string} name  e.g. 'Highlight', 'HighlightText' @returns {string|null} an rgb()/rgba() colour
 */
export function systemColor(doc, name) {
  const ctx = measuringContext(doc);
  if (!ctx) return null;
  const saved = ctx.fillStyle;
  ctx.fillStyle = '#000';
  ctx.fillStyle = name;
  const v = String(ctx.fillStyle);
  ctx.fillStyle = saved;
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v);
  if (hex) return `rgb(${parseInt(hex[1], 16)}, ${parseInt(hex[2], 16)}, ${parseInt(hex[3], 16)})`;
  return parseColor(v) ? v : null;
}

/**
 * The originating selectors of the author `::selection` rules reachable from `sheets`: `p::selection` -> `p`, `.a ::selection` -> `.a *`, `::selection` -> `*`.
 * @param {Window} win @param {Iterable<CSSStyleSheet>} sheets @returns {string[]}
 */
function selectionSelectors(win, sheets) {
  /** @type {string[]} */
  const out = [];
  /** @param {CSSRuleList|CSSRule[]} rules @param {string|null} parent  the resolved selector of the enclosing style rule (CSS nesting) */
  const walk = (rules, parent) => {
    for (const rule of Array.from(rules)) {
      const r = /** @type {any} */ (rule);
      if (r.styleSheet) { walkSheet(r.styleSheet, r.media); continue; } // @import
      if (r.media && r.media.mediaText && !win.matchMedia(r.media.mediaText).matches) continue; // @media
      if (typeof r.conditionText === 'string' && rule.constructor?.name === 'CSSSupportsRule' && !(/** @type {any} */ (win)).CSS?.supports(r.conditionText)) continue;
      let self = parent;
      if (typeof r.selectorText === 'string') {
        self = splitSelectorList(r.selectorText).map((s) => resolveNested(s, parent)).join(', ');
        if (/::selection/i.test(r.selectorText)) {
          for (const s of splitSelectorList(self)) {
            if (!/::selection/i.test(s)) continue;
            const origin = s.replace(/::selection/gi, '');
            out.push(!origin.trim() || /[\s>+~]$/.test(origin) ? `${origin}*` : origin);
          }
        }
      }
      if (r.cssRules) walk(r.cssRules, self);
    }
  };
  /** @param {CSSStyleSheet} sheet @param {MediaList} [media] */
  const walkSheet = (sheet, media) => {
    if (sheet.disabled || (media && media.mediaText && !win.matchMedia(media.mediaText).matches)) return;
    let rules = null;
    try { rules = sheet.cssRules; } catch { return; }
    if (rules) walk(rules, null);
  };
  for (const sheet of sheets) walkSheet(sheet, sheet.media);
  return out;
}

/** A nested selector made absolute against its parent rule's selector. @param {string} s @param {string|null} parent @returns {string} */
function resolveNested(s, parent) {
  if (parent === null) return s;
  return s.includes('&') ? s.replaceAll('&', `:is(${parent})`) : `:is(${parent}) ${s}`;
}

/** @param {Document|ShadowRoot} scope @returns {CSSStyleSheet[]} */
function sheetsOf(scope) {
  return [...Array.from(scope.styleSheets ?? []), ...Array.from(/** @type {any} */ (scope).adoptedStyleSheets ?? [])];
}

/**
 * A painter for one capture: the CSSOM is read once (lazily, when a selection is drawn), the colours are memoised per element.
 * @param {Document} doc  the live document
 * @param {boolean} [foreground]  the platform paints a selection foreground (default: util/engine.js currentSelectionForeground)
 * @returns {SelectionPainter}
 */
export function createSelectionPainter(doc, foreground = currentSelectionForeground()) {
  const win = /** @type {Window} */ (doc.defaultView ?? window);
  /** @type {Map<Node, string[]>} */
  const selectors = new Map();
  /** @type {Map<Element, SelectionPaint>} */
  const memo = new Map();
  /** @type {SelectionPaint|null} */
  let system = null;
  /** @param {Element} el @returns {string[]} */
  const selectorsFor = (el) => {
    const scope = el.getRootNode();
    let list = selectors.get(scope);
    if (!list) {
      list = selectionSelectors(win, scope === doc ? sheetsOf(doc) : [...sheetsOf(doc), ...sheetsOf(/** @type {ShadowRoot} */ (scope))]);
      selectors.set(scope, list);
    }
    return list;
  };
  /** @param {Element} el @returns {boolean} an author ::selection rule applies to el or, through highlight inheritance, to an ancestor */
  const authored = (el) => selectorsFor(el).some((s) => { try { return !!el.closest(s); } catch { return false; } });
  return {
    paint(el) {
      let p = memo.get(el);
      if (p) return p;
      if (authored(el)) {
        const cs = win.getComputedStyle(el, '::selection');
        p = { background: cs.backgroundColor, foreground: cs.color };
      } else {
        system ??= { background: systemColor(doc, 'Highlight') ?? 'rgba(0, 0, 0, 0)', foreground: foreground ? systemColor(doc, 'HighlightText') : null };
        p = system;
      }
      memo.set(el, p);
      return p;
    },
  };
}

/**
 * The colour behind `el` when it is solid: its own and its ancestors' background colours composited down to the first opaque one, or null when a background image
 * (gradient, picture) lies on the way or no opaque colour is found within 12 levels (the canvas content beneath shows through).
 * @param {Window} win @param {Element} el @returns {number[]|null} rgb
 */
export function solidBackdrop(win, el) {
  /** @type {number[][]} */
  const layers = [];
  for (let n = /** @type {Element|null} */ (el), i = 0; n && i < 12; n = n.parentElement, i++) {
    const cs = win.getComputedStyle(n);
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
    const c = parseColor(cs.backgroundColor);
    if (c && c[3] > 0) {
      layers.push(c);
      if (c[3] >= 1) return layers.reduceRight((under, l) => under.map((u, k) => u * (1 - l[3]) + l[k] * l[3]), [0, 0, 0]);
    }
  }
  return null;
}

/**
 * `color` composited over the opaque `under` as an opaque rgb(); null when the colour cannot be parsed.
 * @param {number[]} under rgb @param {string} color @returns {string|null}
 */
export function compositeOver(under, color) {
  const c = parseColor(color);
  if (!c) return null;
  return `rgb(${under.map((u, k) => Math.round(u * (1 - c[3]) + c[k] * c[3])).join(',')})`;
}
