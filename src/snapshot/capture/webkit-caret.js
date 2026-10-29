/**
 * Safari's caret colour for `caret-color: auto` on macOS (engines bundle; caret-overlay.js asks it through EngineSkins.caretColor).
 * Module: snapshot-capture (src/snapshot/capture/*).
 *
 * Measured on Safari 27.0.1 (macOS, sampled from the page at a blink-on phase, Display P3 readback compared with swatches of the same colours):
 * - `caret-color: auto` paints the system accent (-apple-system-control-accent, rgb(0, 122, 255) with the default accent), not the text colour, unless the element's
 *   colour comes from an author declaration: on the element itself (inline, a rule, `color: inherit`) or inherited from an ancestor whose colour does. A colour set by the
 *   UA sheet (input, textarea, select, button, mark, a link) does not count and stops the inheritance (an input inside an author-coloured block keeps the accent caret;
 *   a contenteditable span inside a link too). `accent-color` does not change it. The dark appearance paints the same accent.
 * - an explicit caret-color is painted as computed, `currentcolor` included (no accent).
 * The computed caret-color of `auto` reads as the text colour in Safari (getComputedStyle and the typed OM alike), so `auto` and the origin of the colour are read
 * from the declarations: inline styles and the page's style rules that match the element or its ancestors (live `matches`, so :hover / :focus rules count).
 * Firefox paints `auto` in the text colour (measured on Firefox 157 by a screen capture: its WebDriver screenshot draws no caret), as the core already does.
 */

import { currentEngine } from '../../util/engine.js';

/** caret-color values that make the nearest declaration the parent's: the property is inherited and the UA sheet does not declare it */
const PASS = /^(?:inherit|unset|revert|revert-layer)$/;

/**
 * PURE. Does Safari paint this caret in the system accent? The chain runs from the caret's element (0) up to the root; each accessor returns null past the root.
 * @param {(i: number) => string[]|null} caretAt  the winning author `caret-color` declarations of the i-th element (several when they tie: all must be auto)
 * @param {(i: number) => {author: boolean, ua: boolean}|null} colorAt  an author declaration sets its `color`; the UA sheet does (input, textarea, select, button, mark, a link)
 * @param {boolean} caretIsColor  the computed caret-color equals the computed color (else the caret-color was set to another colour: it is painted as computed)
 * @returns {boolean}
 */
export function webkitAccentCaret(caretAt, colorAt, caretIsColor) {
  if (!caretIsColor) return false;
  for (let i = 0, v; (v = caretAt(i)); i++) {
    const own = v.filter((x) => !PASS.test(x));
    if (own.length) { if (own.some((x) => x !== 'auto' && x !== 'initial')) return false; break; }
  }
  for (let i = 0, c; (c = colorAt(i)); i++) {
    if (c.author) return false;
    if (c.ua) break;
  }
  return true;
}

/** @typedef {{sel: string, value: string, important: boolean}} Decl */

/** @type {WeakMap<Document|ShadowRoot, {sig: string, color: Decl[], caret: Decl[]}>} */
const ruleCache = new WeakMap();
/** @type {WeakMap<CSSStyleSheet, number>} */
const sheetIds = new WeakMap();
let nextSheet = 0;

/**
 * The author style rules of a tree that declare color or caret-color (media and supports conditions evaluated, imported sheets followed, other group rules entered), cached until a
 * sheet is added, removed or replaced or its rule count changes.
 * @param {Document|ShadowRoot} root @returns {{color: Decl[], caret: Decl[]}}
 */
function rulesOf(root) {
  const win = (root.ownerDocument ?? /** @type {Document} */ (root)).defaultView;
  const sheets = [...root.styleSheets, ...(root.adoptedStyleSheets ?? [])].filter((s) => !s.disabled);
  const count = (/** @type {CSSStyleSheet} */ s) => { try { return s.cssRules.length; } catch { return -1; } };
  const sig = sheets.map((s) => { if (!sheetIds.has(s)) sheetIds.set(s, nextSheet++); return `${sheetIds.get(s)}:${count(s)}`; }).join(',');
  const hit = ruleCache.get(root);
  if (hit && hit.sig === sig) return hit;
  const out = { sig, color: /** @type {Decl[]} */ ([]), caret: /** @type {Decl[]} */ ([]) };
  const media = (/** @type {string} */ q) => !q || !!win?.matchMedia(q).matches;
  /** @param {CSSRuleList|undefined} list */
  const walk = (list) => {
    for (const r of Array.from(list ?? [])) {
      if (r instanceof CSSStyleRule) {
        for (const [prop, into] of /** @type {const} */ ([['color', out.color], ['caret-color', out.caret]])) {
          const value = r.style.getPropertyValue(prop);
          if (value) into.push({ sel: r.selectorText, value, important: r.style.getPropertyPriority(prop) === 'important' });
        }
      } else if (r instanceof CSSImportRule) { if (media(r.media.mediaText)) try { walk(r.styleSheet?.cssRules); } catch { /* cross-origin */ } } else if (r instanceof CSSMediaRule) { if (media(r.media.mediaText)) walk(r.cssRules); } else if (r instanceof CSSSupportsRule) { if (CSS.supports(r.conditionText)) walk(r.cssRules); } else if (r instanceof CSSGroupingRule) walk(r.cssRules);
    }
  };
  for (const s of sheets) { if (media(s.media.mediaText)) try { walk(s.cssRules); } catch { /* cross-origin: not readable */ } }
  ruleCache.set(root, out);
  return out;
}

/** @param {Element} el @param {string} sel @returns {boolean} */
const matches = (el, sel) => { try { return el.matches(sel); } catch { return false; } };

/**
 * The declarations of `prop` that win on `el`: the !important rules, else the inline value, else the matching rules (all of them: the cascade order between rules is
 * not resolved, so they must agree).
 * @param {Element} el @param {Decl[]} rules @param {string} prop @returns {string[]}
 */
function winning(el, rules, prop) {
  const mine = rules.filter((r) => matches(el, r.sel));
  const style = /** @type {HTMLElement} */ (el).style;
  const inline = style?.getPropertyValue(prop);
  const strong = mine.filter((r) => r.important);
  if (strong.length || (inline && style.getPropertyPriority(prop))) return [...strong.map((r) => r.value), ...(inline && style.getPropertyPriority(prop) ? [inline] : [])];
  return inline ? [inline] : mine.map((r) => r.value);
}

/**
 * DOM side of webkitAccentCaret: the declarations on `el` and its ancestors (across shadow roots to the host), read lazily (the colour walk stops at the first author or
 * UA colour; the caret-color walk matches only the few rules that declare it).
 * @param {Element} el @param {CSSStyleDeclaration} cs @returns {boolean}
 */
export function accentCaretOf(el, cs) {
  /** @type {Element[]} */
  const chain = [el];
  /** @param {number} i @returns {Element|null} */
  const nth = (i) => {
    while (chain.length <= i) {
      const n = chain[chain.length - 1];
      const up = n.parentElement ?? /** @type {ShadowRoot} */ (n.getRootNode()).host ?? null;
      if (!up) return null;
      chain.push(up);
    }
    return chain[i];
  };
  const rules = (/** @type {Element} */ n) => rulesOf(/** @type {Document|ShadowRoot} */ (n.getRootNode()));
  return webkitAccentCaret(
    (i) => { const n = nth(i); return n ? winning(n, rules(n).caret, 'caret-color') : null; },
    (i) => {
      const n = nth(i);
      if (!n) return null;
      const author = winning(n, rules(n).color, 'color').some((v) => v !== 'revert');
      return { author, ua: /^(?:input|textarea|select|button|mark)$/.test(n.localName) || matches(n, ':any-link') };
    },
    cs.caretColor === cs.color);
}

/** @type {WeakMap<Document, string>} */
const accents = new WeakMap();

/** @param {Document} doc @returns {string} the system accent as a computed colour */
function accentOf(doc) {
  let c = accents.get(doc);
  if (!c) {
    const probe = doc.createElement('div');
    probe.style.cssText = 'position:absolute;width:0;height:0;visibility:hidden;color:-apple-system-control-accent';
    doc.documentElement.appendChild(probe);
    c = probe.style.color ? getComputedStyle(probe).color : 'rgb(0, 122, 255)';
    probe.remove();
    accents.set(doc, c);
  }
  return c;
}

/**
 * The caret colour Safari on macOS paints for `el`, or null to keep the computed one (other engines, iOS, an explicit caret-color, an author text colour).
 * @param {Document} doc @param {Element} el @param {CSSStyleDeclaration} cs @returns {string|null}
 */
export function webkitCaretColor(doc, el, cs) {
  const e = currentEngine();
  return e.engine === 'webkit' && e.os === 'desktop' && accentCaretOf(el, cs) ? accentOf(doc) : null;
}
