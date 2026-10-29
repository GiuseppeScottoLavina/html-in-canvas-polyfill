/**
 * PURE text-level CSS rewrites used by the collector, plus the small rule parser the rewrites and the tree-shaker share.
 * Module: snapshot-capture (src/snapshot/capture/*). No DOM, runs in node:test.
 */

import { rewriteSelectorForCanvas } from '../../util/selector-rewrite.js';

/** @typedef {import('../../contracts/types.js').CssBundle} CssBundle */

/**
 * One parsed rule. `style` keeps its raw body (declarations and nested rules), `group` (@media, @layer, ...) has parsed children,
 * `opaque` is any other block at-rule (@font-face, @keyframes, @property), `stmt` is a declaration or a block-less at-rule.
 * @typedef {{k: 'style'|'group'|'opaque'|'stmt', pre: string, body: string, kids: RuleNode[]|null}} RuleNode
 */

const GROUPING = new Set(['media', 'supports', 'layer', 'container', 'scope', 'document', '-moz-document', 'starting-style']);

// ---------------------------------------------------------------------------------------------- lexical skips

/** @param {string} s @param {number} i index of the opening quote @returns {number} index after the closing quote */
export function skipString(s, i) {
  const q = s.charCodeAt(i);
  for (let j = i + 1; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) j++;
    else if (c === q) return j + 1;
  }
  return s.length;
}

/** @param {string} s @param {number} i index of the slash of a comment opener @returns {number} */
function skipComment(s, i) {
  const e = s.indexOf('*/', i + 2);
  return e < 0 ? s.length : e + 2;
}

/** @param {string} s @param {number} i index of '(' @returns {number} index after the matching ')' (quotes and comments inside are skipped) */
export function skipParens(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 40) depth++;
    else if (c === 41) { if (--depth === 0) return j + 1; } else if (c === 34 || c === 39) j = skipString(s, j) - 1;
    else if (c === 47 && s.charCodeAt(j + 1) === 42) j = skipComment(s, j) - 1;
    else if (c === 92) j++;
  }
  return s.length;
}

/** @param {string} s @param {number} i index just AFTER an opening brace @returns {number} index after the matching closing brace */
function skipBlock(s, i) {
  let depth = 1;
  for (let j = i; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 123) depth++;
    else if (c === 125) { if (--depth === 0) return j + 1; } else if (c === 34 || c === 39) j = skipString(s, j) - 1;
    else if (c === 40) j = skipParens(s, j) - 1;
    else if (c === 47 && s.charCodeAt(j + 1) === 42) j = skipComment(s, j) - 1;
    else if (c === 92) j++;
  }
  return s.length;
}

// ---------------------------------------------------------------------------------------------- rule parser

/** @param {string} pre @returns {string} lower-case name of the at-rule that starts the prelude, '' for a style rule */
function atName(pre) {
  const m = /^\s*@([\w-]+)/.exec(pre);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Parse a stylesheet (or the body of a style rule with nested rules) into rule nodes.
 * Never throws; unbalanced input ends the current block at the end of the text.
 * @param {string} css
 * @returns {RuleNode[]}
 */
export function parseRules(css) {
  const n = css.length;
  let i = 0;
  /** @param {number} depth @returns {RuleNode[]} */
  function list(depth) {
    /** @type {RuleNode[]} */
    const nodes = [];
    let start = i;
    /** @param {number} end */
    const stmt = (end) => { if (end > start && css.slice(start, end).trim()) nodes.push({ k: 'stmt', pre: css.slice(start, end), body: '', kids: null }); };
    while (i < n) {
      const c = css.charCodeAt(i);
      if (c === 34 || c === 39) i = skipString(css, i);
      else if (c === 47 && css.charCodeAt(i + 1) === 42) i = skipComment(css, i);
      else if (c === 40) i = skipParens(css, i);
      else if (c === 92) i += 2;
      else if (c === 59) { i++; stmt(i); start = i; } else if (c === 125) {
        if (depth === 0) { i++; start = i; continue; }
        stmt(i);
        return nodes;
      } else if (c === 123) {
        const pre = css.slice(start, i);
        if (/^\s*--[^:{};]*:/.test(pre)) { i = skipBlock(css, i + 1); continue; }
        i++;
        const name = atName(pre);
        if (name && GROUPING.has(name)) {
          const kids = list(depth + 1);
          i++;
          nodes.push({ k: 'group', pre, body: '', kids });
        } else {
          const from = i;
          i = skipBlock(css, i);
          nodes.push({ k: name ? 'opaque' : 'style', pre, body: css.slice(from, Math.max(from, i - 1)), kids: null });
        }
        start = i;
      } else i++;
    }
    stmt(n);
    return nodes;
  }
  return list(0);
}

/** @param {RuleNode[]} nodes @returns {string} */
export function serializeRules(nodes) {
  let out = '';
  for (const node of nodes) {
    if (node.k === 'stmt') out += node.pre;
    else if (node.k === 'group') out += node.pre + '{' + serializeRules(node.kids ?? []) + '}';
    else out += node.pre + '{' + node.body + '}';
  }
  return out;
}

/**
 * Split a selector list at its top-level commas.
 * @param {string} list
 * @returns {string[]} the trimmed complex selectors
 */
export function splitSelectorList(list) {
  /** @type {string[]} */
  const out = [];
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list.charCodeAt(i);
    if (c === 40) i = skipParens(list, i) - 1;
    else if (c === 91) { const e = list.indexOf(']', i); i = e < 0 ? list.length : e; } else if (c === 34 || c === 39) i = skipString(list, i) - 1;
    else if (c === 92) i++;
    else if (c === 44) { out.push(list.slice(start, i).trim()); start = i + 1; }
  }
  const last = list.slice(start).trim();
  if (last || !out.length) out.push(last);
  return out;
}

/**
 * Rewrite the selector list of every style rule (also nested ones and those inside @media/@layer/...).
 * @param {string} css
 * @param {(selectorList: string) => string|null} fn  return null to drop the whole rule
 * @returns {string}
 */
export function mapSelectors(css, fn) {
  return serializeRules(mapNodes(parseRules(css), fn));
}

/** @param {RuleNode[]} nodes @param {(s: string) => string|null} fn @returns {RuleNode[]} */
function mapNodes(nodes, fn) {
  /** @type {RuleNode[]} */
  const out = [];
  for (const node of nodes) {
    if (node.k === 'group') { out.push({ ...node, kids: mapNodes(node.kids ?? [], fn) }); continue; }
    if (node.k !== 'style') { out.push(node); continue; }
    const lead = /^\s*/.exec(node.pre)?.[0] ?? '';
    const next = fn(node.pre.trim());
    if (next === null) continue;
    const body = node.body.includes('{') ? mapSelectors(node.body, fn) : node.body;
    out.push({ ...node, pre: lead + next, body });
  }
  return out;
}

/**
 * Apply `fn` to the parts of `text` that are not inside a string, a comment or (by default) a url(...) argument.
 * @param {string} text
 * @param {(chunk: string) => string} fn
 * @param {{skipUrl?: boolean}} [opts] skipUrl: leave url(...) untouched (default true)
 * @returns {string}
 */
function mapUnprotected(text, fn, opts = {}) {
  const skipUrl = opts.skipUrl !== false;
  let out = '';
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let end = -1;
    if (c === 34 || c === 39) end = skipString(text, i);
    else if (c === 47 && text.charCodeAt(i + 1) === 42) end = skipComment(text, i);
    else if (skipUrl && c === 40 && /url$/i.test(text.slice(Math.max(0, i - 3), i))) end = skipParens(text, i);
    if (end < 0) continue;
    out += fn(text.slice(from, i)) + text.slice(i, end);
    from = end;
    i = end - 1;
  }
  return out + fn(text.slice(from));
}

// ---------------------------------------------------------------------------------------------- exported rewrites

const VIEWPORT_UNIT = /(?<![\w.#-])(-?(?:\d+\.?\d*|\.\d+))(dvw|dvh|dvi|dvb|lvw|lvh|lvi|lvb|svw|svh|svi|svb|vmin|vmax|vw|vh|vi|vb)(?![\w-])/g;
const HAS_VIEWPORT_UNIT = /\d(?:dvw|dvh|dvi|dvb|lvw|lvh|lvi|lvb|svw|svh|svi|svb|vmin|vmax|vw|vh|vi|vb)(?![\w-])/;

/**
 * vw/vh/svw/svh/lvw/lvh/dvw/dvh/vi/vb/vmin/vmax -> px of the given viewport (the SVG image has its own, wrong, viewport).
 * @param {string} css
 * @param {{width: number, height: number}} viewport
 * @returns {string}
 */
export function rewriteViewportUnits(css, viewport) {
  if (!HAS_VIEWPORT_UNIT.test(css)) return css;
  const { width, height } = viewport;
  return mapUnprotected(css, (chunk) => chunk.replace(VIEWPORT_UNIT, (_m, num, unit) => {
    const axis = unit.endsWith('w') || unit.endsWith('i') ? width : unit.endsWith('h') || unit.endsWith('b') ? height : unit === 'vmin' ? Math.min(width, height) : Math.max(width, height);
    return `${+(parseFloat(num) * axis / 100).toFixed(3)}px`;
  }));
}

/** @param {string} sel @returns {string} */
function rootSelector(sel) {
  return mapUnprotected(sel, (chunk) => chunk
    .replace(/(^|[\s>+~,(])(?:html|:root)((?:[.#[:][^\s>+~,]*)?)(?:\s*>\s*|\s+)body(?![\w-])/gi, '$1.hic-root$2')
    .replace(/(^|[\s>+~,(])(?:html|body)(?![\w-])/gi, '$1.hic-root')
    .replace(/(?<![\w\\-]):root(?![\w-])/g, '.hic-root'));
}

/**
 * html|body|:root -> .hic-root (`html body` collapses to one root).
 * @param {string} css
 * @returns {string}
 */
export function rewriteRootSelectors(css) {
  return mapSelectors(css, rootSelector);
}

const LINK_PSEUDO = /(?<![\\:]):(?:any-link|link)(?![\w-])/g;

/** @param {string} sel @returns {string} */
function linkSelector(sel) {
  return mapUnprotected(sel, (chunk) => chunk.replace(LINK_PSEUDO, ':where(a,area)[href]'));
}

/**
 * :link and :any-link -> `:where(a,area)[href]` (the same specificity as the pseudo-class). The inert clone document has no URL, so the browser never matches `:link` there.
 * :visited stays dropped (dropUnclonableSelectors).
 * @param {string} css
 * @returns {string}
 */
export function rewriteLinkPseudos(css) {
  return css.includes('link') ? mapSelectors(css, linkSelector) : css;
}

const INTERACTION = /(?<![\\:]):(focus-visible|focus-within|focus|hover|active|user-invalid|user-valid)(?![\w-])/g;

/** @param {string} sel @returns {string} */
function pseudoSelector(sel) {
  return mapUnprotected(sel, (chunk) => chunk.replace(INTERACTION, (m, name, offset) => {
    const compound = Math.max(chunk.lastIndexOf(' ', offset), chunk.lastIndexOf('>', offset), chunk.lastIndexOf('+', offset), chunk.lastIndexOf('~', offset), chunk.lastIndexOf(',', offset), chunk.lastIndexOf('(', offset));
    return chunk.slice(compound + 1, offset).includes('::') ? m : `.hic-${name}`;
  }));
}

/**
 * :hover/:active/:focus/:focus-visible/:focus-within (and :user-invalid/:user-valid) -> .hic-hover/.hic-active/.hic-focus/.hic-focus-visible/.hic-focus-within/...
 * A pseudo-class that follows a pseudo-element in the same compound is left alone (a class cannot follow ::before).
 * @param {string} css
 * @returns {string}
 */
export function rewriteInteractionPseudos(css) {
  return mapSelectors(css, pseudoSelector);
}

/**
 * Which interaction pseudo-classes occur (CssBundle.pseudo).
 * @param {string} css
 * @returns {CssBundle["pseudo"]}
 */
export function detectPseudos(css) {
  const has = (/** @type {string} */ name) => new RegExp(`(?<![\\\\:]):${name}(?![\\w-])`).test(css);
  const hover = has('hover');
  const layout = hover && hoverChangesLayout(css);
  return { hover, active: has('active'), focus: has('focus'), focusVisible: has('focus-visible'), focusWithin: has('focus-within'), hoverLayout: layout,
    ...(hover && !layout ? { hoverInk: hoverDeclares(css, INK_STABLE), hoverSubjects: hoverSubjects(css) } : {}) };
}
/** properties that change only how a box paints, never its size or position nor anyone else's */
const PAINT_ONLY = /^(?:color|background(?:-[a-z-]+)?|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?-color|outline(?:-[a-z]+)?|box-shadow|text-shadow|text-decoration(?:-[a-z]+)?|text-emphasis-color|opacity|visibility|cursor|fill(?:-opacity)?|stroke(?:-[a-z]+)?|caret-color|accent-color|column-rule-color|-webkit-text-(?:fill|stroke)-color|transition(?:-[a-z]+)?)$/;
const HOVER = /(?<![\\:]):hover(?![\w-])/;

/**
 * PURE. Does any :hover rule (a style rule whose selector, or an enclosing nested rule's, has :hover) declare a property outside PAINT_ONLY (a box, a position, a
 * display, a custom property)? Then a hover change may move other elements.
 * @param {string} css
 * @returns {boolean}
 */
export function hoverChangesLayout(css) {
  return hoverDeclares(css, PAINT_ONLY);
}

/**
 * properties whose change keeps every painted pixel inside the extent the element already paints (its box, its overflow, its shadows and outline as they are): a
 * colour, a background, an opacity. A :hover rule that sets anything else (a shadow, an outline, a text decoration) may paint beyond the reach measured while the
 * element is not hovered (scroll-compose.js hover strips measure rows that were never hovered)
 */
const INK_STABLE = /^(?:color|background(?:-color|-image|-position(?:-[xy])?|-size|-repeat|-origin|-clip|-attachment)?|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?-color|outline-color|text-decoration-color|text-emphasis-color|opacity|visibility|cursor|fill(?:-opacity)?|stroke(?:-opacity)?|caret-color|accent-color|column-rule-color|-webkit-text-(?:fill|stroke)-color|transition(?:-[a-z]+)?)$/;

/**
 * PURE. Does any :hover rule (see hoverChangesLayout) declare a property that `allowed` does not match?
 * @param {string} css @param {RegExp} allowed @returns {boolean}
 */
function hoverDeclares(css, allowed) {
  /** @param {RuleNode[]} nodes @param {boolean} inHover @returns {boolean} */
  const walk = (nodes, inHover) => nodes.some((r) => {
    if (r.k === 'group') return walk(/** @type {RuleNode[]} */ (r.kids), inHover);
    if (r.k !== 'style') return false;
    const hover = inHover || HOVER.test(r.pre);
    const inner = parseRules(r.body);
    if (hover) {
      for (const d of inner) {
        if (d.k !== 'stmt') continue;
        const name = /^\s*(-?-?[\w-]+)\s*:/.exec(d.pre)?.[1]?.toLowerCase();
        if (name && !allowed.test(name)) return true;
      }
    }
    return walk(inner.filter((d) => d.k !== 'stmt'), hover);
  });
  return walk(parseRules(css), false);
}


/**
 * PURE. The compounds whose :hover state some rule tests, :hover and pseudo-elements left out ('li' for `#list li:hover::after`, '*' for a bare `:hover`): an element that
 * matches none of them looks the same hovered or not. null when that cannot be told from the text: :hover inside a functional pseudo-class (:is, :not, :has), or a
 * compound with the nesting selector.
 * @param {string} css @returns {string[]|null}
 */
export function hoverSubjects(css) {
  /** @type {Set<string>} */
  const out = new Set();
  /** @param {RuleNode[]} nodes @returns {boolean} every :hover was understood */
  const walk = (nodes) => nodes.every((r) => {
    if (r.k === 'group') return !HOVER.test(r.pre) && walk(/** @type {RuleNode[]} */ (r.kids));
    if (r.k !== 'style') return true;
    if (HOVER.test(r.pre) && !splitSelectorList(r.pre.trim()).every((sel) => compoundsOf(sel, out))) return false;
    return !r.body.includes('{') || walk(parseRules(r.body).filter((d) => d.k !== 'stmt'));
  });
  return walk(parseRules(css)) ? [...out] : null;
}

/**
 * The :hover compounds of one complex selector into `out`; false when one is not understood.
 * @param {string} sel @param {Set<string>} out @returns {boolean}
 */
function compoundsOf(sel, out) {
  let start = 0;
  /** @param {number} end */
  const take = (end) => {
    const c = sel.slice(start, end).trim();
    if (!HOVER.test(c)) return true;
    if (c.includes('&')) return false;
    let depth = 0;
    for (let i = 0; i < c.length; i++) {
      if (c[i] === '(') depth++;
      else if (c[i] === ')') depth--;
      else if (depth && c.startsWith(':hover', i)) return false;
    }
    out.add(c.replace(/(?<![\\:]):hover(?![\w-])/g, '').replace(/::?(?:before|after|first-line|first-letter|marker|placeholder|selection|backdrop|file-selector-button|[\w-]+\(.*)$/, '').replace(/::[\w-]+$/, '') || '*');
    return true;
  };
  for (let i = 0; i < sel.length; i++) {
    const ch = sel.charCodeAt(i);
    if (ch === 40) i = skipParens(sel, i) - 1;
    else if (ch === 91) { const e = sel.indexOf(']', i); i = e < 0 ? sel.length : e; } else if (ch === 34 || ch === 39) i = skipString(sel, i) - 1;
    else if (ch === 92) i++;
    else if (ch === 32 || ch === 62 || ch === 43 || ch === 126 || ch === 10 || ch === 9) {
      if (!take(i)) return false;
      start = i + 1;
    }
  }
  return take(sel.length);
}

/**
 * Selectors the clone must not carry: :visited (privacy), ::-webkit-scrollbar* (scrollbars are painted by the polyfill, ADR-E).
 * A selector list keeps its other members; a rule whose every selector is dropped disappears.
 * @param {string} css
 * @returns {string}
 */
export function dropUnclonableSelectors(css) {
  const bad = /(?<![\\:])(?::visited(?![\w-])|::-webkit-(?:scrollbar|resizer))/;
  return mapSelectors(css, (list) => {
    if (!bad.test(list)) return list;
    const keep = splitSelectorList(list).filter((s) => !bad.test(s));
    return keep.length ? keep.join(', ') : null;
  });
}

/**
 * The canvas element is a display:contents <div data-hic-root> in the clone, so a compound that matches the canvas and sits before a descendant or child combinator
 * (`canvas .x`, `.chart > .x`, `#c .x`) is replaced by `[data-hic-root]` with the SAME specificity (the shared pure rewriter of util/selector-rewrite.js, ADR-D.3).
 * The subject compound is left alone, like in the live bridge.
 * @param {string} css
 * @param {{matches: (selector: string) => boolean}} canvas  the real canvas (or a stand-in): `matches(compound)` decides which compounds name it
 * @returns {string}
 */
export function rewriteCanvasSelectors(css, canvas) {
  return mapSelectors(css, (list) => rewriteSelectorForCanvas(list, /** @type {Element} */ (canvas), '[data-hic-root]') ?? list);
}

/**
 * Rules written for the shadow root of the canvas: `:host` -> the canvas shell, `:host(x)` -> shell with x. `:host-context()` rules are dropped
 * (the ancestors it asks about are not part of the clone).
 * @param {string} css
 * @returns {string}
 */
export function rewriteHostSelectors(css) {
  if (!css.includes(':host')) return css;
  return mapSelectors(css, (list) => {
    const out = [];
    for (const sel of splitSelectorList(list)) {
      if (sel.includes(':host-context')) continue;
      out.push(sel.replace(/:host\(((?:[^()]|\([^()]*\))*)\)/g, '[data-hic-root]$1').replace(/:host(?![\w-])/g, '[data-hic-root]'));
    }
    return out.length ? out.join(', ') : null;
  });
}
