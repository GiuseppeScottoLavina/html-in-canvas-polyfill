import { parseRules, serializeRules } from './css-rewrite.js';

// A fixed repertoire makes the filtered sheet reusable across text edits. Characters outside this
// fast path (including combining marks, joiners and other scripts) retain the complete original sheet.
const OTHER_CHAR = /[^\x09\x0a\x0d\x20-\x7e\u00a0\u00ab\u00b0\u00b7\u00bbÀÈÉÌÒÙàèéìòù\u00d7\u00f7\u2010-\u2015\u2018-\u201f\u2022\u2026\u2032\u2033\u2212]/;
const USED = [[0x20, 0x7e], [0xa0, 0xff], [0x2010, 0x2015], [0x2018, 0x201f], [0x2022, 0x2022],
  [0x2026, 0x2026], [0x2032, 0x2033], [0x2212, 0x2212], [0x25cf, 0x25cf], [0x6c34, 0x6c34], [0xfffd, 0xfffd]];
// 0x25cf covers password bullets, 0x6c34 the 'ic' font metric, 0xfffd replacement characters.
// An unmodelled generator can render code points that occur nowhere in the source (counters,
// localized labels, full-width text, emphasis marks). An escaped spelling needs the general path too.
const GENERATED = /@counter-style\b|\blist-item\b|\b(?:text-emphasis(?:-style)?|text-security)\s*:(?!\s*none\b)|\bhyphens\s*:(?!\s*(?:manual|none)\b)|\btext-transform\s*:(?!\s*(?:none|uppercase|lowercase|capitalize)\s*(?:!important\s*)?(?:[;}"]|$))/i;
const CONTENT = /(?:^|[;{])\s*content\s*:\s*([^;}]+)/gi;
const SIMPLE_CONTENT = /^(?:none|normal|(?:"[^"\\]*"|'[^'\\]*')+)(?:\s*!important)?\s*$/i;
const GENERATED_ELEMENT = /<(?:[\w-]+:)?(?:style|q|li|ol|ul|summary|details|math|svg|select|ruby|rp|object|iframe|audio|video|meter|progress)\b/i;
const LOCALIZED_INPUT = /<input\b[^>]*\stype="(?!(?:checkbox|radio|range|text|hidden|email|search|tel|url|button)")/i;
const OTHER_LOCALE = /-webkit-locale\s*:(?!\s*(?:auto\b|"?(?:en|it)(?:-[\w-]+)?"?(?=[\s;}]|$)|&quot;(?:en|it)(?:-[\w-]+)?&quot;))/i;
const OTHER_LANGUAGE = /\s(?:xml:)?lang="(?!(?:en|it)(?:-|")|")/i;
const INLINE_GENERATOR = /\sstyle="[^"]*\\|(?:;|\sstyle=")\s*content\s*:(?!\s*(?:none|normal)\b)|&#/i;

/** @param {string} text */
function unknownCss(text) {
  return OTHER_CHAR.test(text) || text.includes('\\') || GENERATED.test(text) || OTHER_LOCALE.test(text)
    || Array.from(text.matchAll(CONTENT)).some(match => !SIMPLE_CONTENT.test(match[1]));
}

/** @param {import('./css-rewrite.js').RuleNode[]} declarations */
function unusedRange(declarations) {
  declarations = declarations.filter(rule => /^\s*unicode-range\s*:/i.test(rule.pre));
  if (declarations.length !== 1) return false;
  const descriptor = declarations[0].pre.replace(/^\s*unicode-range\s*:/i, '').replace(/;\s*$/, '');
  for (const range of descriptor.split(',')) {
    const m = /^\s*u\+([\da-f]{1,6})(?:-([\da-f]{1,6}))?\s*$/i.exec(range);
    if (!m) return false;
    const lo = parseInt(m[1], 16), hi = parseInt(m[2] || m[1], 16);
    if (lo > hi || hi > 0x10ffff || USED.some(([a, b]) => a <= hi && lo <= b)) return false;
  }
  return true;
}

/**
 * Precompute the simple-text candidate for English and Italian once for this shaken stylesheet. The decision to
 * use it is per serialized tile, after flattening shadows, projecting fields and resolving SVG
 * references. Edits (including another language in the same input) need no invalidation key.
 * @param {string} css
 * @returns {string|null}
 */
export function simpleFontSheet(css) {
  if (!css.includes('unicode-range')) return null;
  let changed = false, uncertain = false;
  /** @param {import('./css-rewrite.js').RuleNode[]} nodes @returns {import('./css-rewrite.js').RuleNode[]} */
  const filter = nodes => {
    // Retain the set of families, weights, styles and metrics used in font matching. Only drop a
    // disjoint member of a composite face with a surviving sibling in exactly the same rule scope.
    const survivors = new Set();
    /** @type {Map<import('./css-rewrite.js').RuleNode, string>} */
    const candidates = new Map();
    for (const node of nodes) {
      if (node.k !== 'opaque' || !/^\s*@font-face\s*$/i.test(node.pre)) continue;
      const declarations = parseRules(node.body);
      const key = serializeRules(declarations.filter(rule => !/^\s*(?:src|unicode-range)\s*:/i.test(rule.pre)));
      if (unusedRange(declarations)) candidates.set(node, key);
      else survivors.add(key);
    }
    return nodes.flatMap(node => {
      if (node.k === 'group') return [{ ...node, kids: filter(node.kids ?? []) }];
      const key = candidates.get(node);
      if (key !== undefined && survivors.has(key)) { changed = true; return []; }
      if (node.k !== 'opaque' || !/^\s*@font-face\s*$/i.test(node.pre)) {
        if (unknownCss(node.pre) || unknownCss('{' + node.body)) uncertain = true;
      }
      return [node];
    });
  };
  const nodes = filter(parseRules(css));
  return changed && !uncertain ? serializeRules(nodes) : null;
}

/** @param {string} markup @param {string} extraCss */
export function simpleFontMarkup(markup, extraCss) {
  return !OTHER_CHAR.test(markup) && !GENERATED.test(markup) && !GENERATED_ELEMENT.test(markup)
    && !LOCALIZED_INPUT.test(markup) && !OTHER_LANGUAGE.test(markup) && !OTHER_LOCALE.test(markup) && !INLINE_GENERATOR.test(markup) && !unknownCss(extraCss);
}
