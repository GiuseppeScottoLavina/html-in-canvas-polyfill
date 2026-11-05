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
  return { hover, active: has('active'), focus: has('focus'), focusVisible: has('focus-visible'), focusWithin: has('focus-within'), hoverLayout: hover && hoverChangesLayout(css) };
}

/** a sibling combinator or nesting (`&`): the match depends on elements beside the path, or on a parent rule */
const UNSCOPED_COMBINATOR = /[+~&]/;
/** structural, scoping and shadow pseudos: the match depends on the tree outside the drawn subtree, which nothing observes, or on a scope */
const UNSCOPED_PSEUDO = /:(?:has|nth-[\w-]+|first-child|last-child|only-child|first-of-type|last-of-type|only-of-type|empty|host|host-context|scope)(?![\w-])|::(?:slotted|part)\b/i;
const HOVER_ALL = /(?<![\\:]):hover(?![\w-])/g;
/** pseudo-elements, dropped from the neutral form (querySelector matches elements) */
const PSEUDO_ELEMENT = /::[\w-]+(?:\([^()]*\))?|:(?:before|after|first-line|first-letter)(?![\w-])/gi;

/**
 * PURE. `sel` with every pseudo-class replaced by `:is(*)`, except a :not() / :is() / :where() of plain tokens (types, classes, ids, attributes), so that it matches in
 * every state of the element and of the page (:focus, :focus-within, :focus-visible, :active, :checked, :placeholder-shown, :target, :open...): a "no match" then stays
 * true until the DOM changes. A neutral form that kept the state (`.b:hover:focus` as `.b:is(*):focus`) answered "no" while the button had no focus, and that cached
 * answer outlived the focus: the hover that ended later was not repainted.
 * @param {string} sel @returns {string}
 */
function anyState(sel) {
  // strings, escapes and attribute selectors hold no pseudo-class: masked at the same length, so that the matches index `sel`
  const mask = sel.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\\./g, (m) => '_'.repeat(m.length)).replace(/\[[^\]]*\]/g, (m) => '_'.repeat(m.length));
  let out = '';
  let from = 0;
  for (const m of mask.matchAll(/(?<!:):([\w-]+)(\()?/g)) {
    if (m.index < from) continue;
    const end = m[2] ? skipParens(mask, m.index + m[0].length - 1) : m.index + m[0].length;
    const plain = m[2] && /^(?:not|is|where)$/i.test(m[1]) && !mask.slice(m.index, end).slice(m[0].length).includes(':');
    out += sel.slice(from, m.index) + (plain ? sel.slice(m.index, end) : ':is(*)');
    from = end;
  }
  return out + sel.slice(from);
}

/**
 * PURE. The :hover rules of `css` as NEUTRAL selectors: each complex selector that has :hover, with every :hover replaced by `:is(*)`, every other pseudo-class made
 * state-free (anyState) and its pseudo-elements dropped, so that it matches every element the rule styles in some hover state and in any other state. The interaction
 * tracker counts a hover change in a drawn source only when one of them matches the drawable or an element inside it; the ancestors outside it are part of the match (`body:hover .x` gives `body:is(*) .x`, which counts for an `.x` inside).
 * null when some :hover rule cannot be scoped that way, and then every hover change counts (the conservative answer): a :hover inside a functional pseudo-class
 * (`:not(:hover)`, `:is(a:hover, b)`, `:has(:hover)`), a sibling combinator, a structural pseudo-class (it depends on siblings outside the subtree, which no observer
 * watches), `:host`, `:scope`, `::slotted`, `::part`, a :hover rule with nested rules or nested in one, a :hover rule in `@scope`, or :hover in an unknown at-rule.
 * @param {string} css
 * @returns {string[]|null}
 */
export function hoverScope(css) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} sel @returns {boolean} the selector could be made neutral (pushed to `out`) */
  const neutral = (sel) => {
    // strings, escapes and attribute selectors cannot hold a combinator or a pseudo-class
    const bare = sel.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""').replace(/\\./g, '_').replace(/\[[^\]]*\]/g, '[]');
    if (UNSCOPED_COMBINATOR.test(bare) || UNSCOPED_PSEUDO.test(bare)) return false;
    let top = bare;
    for (let prev = ''; prev !== top;) { prev = top; top = top.replace(/\([^()]*\)/g, '()'); }
    // a :hover inside an argument (`:not(:hover)`) cannot be replaced by "any state"
    if ((top.match(HOVER_ALL) ?? []).length !== (bare.match(HOVER_ALL) ?? []).length) return false;
    const n = anyState(mapUnprotected(sel, (chunk) => chunk.replace(HOVER_ALL, ':is(*)').replace(PSEUDO_ELEMENT, '')).trim());
    if (n) out.push(n);
    return !!n;
  };
  /** @param {RuleNode[]} nodes @param {boolean} nested @param {boolean} scoped @returns {boolean} false: some :hover rule cannot be scoped */
  const walk = (nodes, nested, scoped) => nodes.every((r) => {
    if (r.k === 'group') return walk(/** @type {RuleNode[]} */ (r.kids), nested, scoped || atName(r.pre) === 'scope');
    if (r.k === 'opaque') return !HOVER.test(r.pre) && !HOVER.test(r.body);
    if (r.k !== 'style') return true;
    const kids = r.body.includes('{') ? parseRules(r.body).filter((d) => d.k !== 'stmt') : [];
    if (HOVER.test(r.pre)) {
      if (nested || scoped || kids.length) return false;
      if (!splitSelectorList(r.pre.trim()).every((sel) => !HOVER.test(sel) || neutral(sel))) return false;
    }
    return walk(kids, true, scoped);
  });
  return walk(parseRules(css), false, false) ? [...new Set(out)] : null;
}
const IDENT_RE = /^(?:[\w-]|[^\x00-\x7f]|\\(?:[0-9a-fA-F]{1,6}\s?|[^\n]))+/;
/** @param {string} ident @returns {string} CSS identifier with its escapes resolved */
const unescapeIdent = (ident) => (ident.includes('\\') ? ident.replace(/\\([0-9a-fA-F]{1,6})\s?|\\([^\n])/g, (_m, hex, ch) => (hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd) : ch)) : ident);

/**
 * PURE. The tokens an element must carry for a selector WITHOUT sibling combinators to match it: `subject` for the rightmost compound (the element itself), `context` for
 * the compounds left of it (its ancestors). Tokens are `t:<tag>` (lower case), `.<class>` and `#<id>`; arguments of pseudo-classes, attribute selectors and namespaced
 * types add no token (a necessary condition only: a selector whose tokens are all present may still not match).
 * @param {string} sel
 * @returns {{subject: string[], context: string[]}}
 */
export function selectorTokens(sel) {
  /** @type {string[][]} */
  const compounds = [[]];
  const s = sel.trim();
  let i = 0;
  let atStart = true;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '>') {
      while (i < s.length && /[\s>]/.test(s[i])) i++;
      compounds.push([]);
      atStart = true;
      continue;
    }
    const cur = compounds[compounds.length - 1];
    if (c === '.' || c === '#') {
      const m = IDENT_RE.exec(s.slice(i + 1));
      if (m) cur.push(c + unescapeIdent(m[0]));
      i += 1 + (m ? m[0].length : 0);
    } else if (c === '[') {
      let depth = 0;
      for (; i < s.length; i++) { if (s[i] === '"' || s[i] === "'") i = skipString(s, i) - 1; else if (s[i] === '[') depth++; else if (s[i] === ']' && --depth === 0) { i++; break; } }
    } else if (c === ':') {
      i += s[i + 1] === ':' ? 2 : 1;
      const m = IDENT_RE.exec(s.slice(i));
      i += m ? m[0].length : 0;
      if (s[i] === '(') i = skipParens(s, i);
    } else if (c === '*') i++;
    else if (atStart) {
      const m = IDENT_RE.exec(s.slice(i));
      if (!m) { i++; continue; }
      if (s[i + m[0].length] !== '|') cur.push('t:' + unescapeIdent(m[0]).toLowerCase());
      i += m[0].length;
    } else i++;
    if (c === '|') { cur.length = 0; }
    atStart = false;
  }
  const subject = compounds.pop() ?? [];
  return { subject, context: [...new Set(compounds.flat())] };
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
        if (name && !PAINT_ONLY.test(name)) return true;
      }
    }
    return walk(inner.filter((d) => d.k !== 'stmt'), hover);
  });
  return walk(parseRules(css), false);
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
