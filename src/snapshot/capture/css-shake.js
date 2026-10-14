/**
 * PURE per-tile CSS tree-shaking: only rules and @font-face that the pruned subtree can use (docs/ARCHITECTURE.md ADR-D.3/D.8).
 * Module: snapshot-capture (src/snapshot/capture/*).
 */

import { collectVarNames } from './custom-props.js';
import { parseRules, serializeRules, splitSelectorList, skipParens, skipString } from './css-rewrite.js';

/** @typedef {import('./css-rewrite.js').RuleNode} RuleNode */

/**
 * @typedef {Object} ShakeTokens
 * @property {ReadonlySet<string>} classes
 * @property {ReadonlySet<string>} ids
 * @property {ReadonlySet<string>} tags
 * @property {ReadonlySet<string>} fonts  lower-case text of the font / font-family declarations found in inline styles
 * @property {boolean} hasAttributeSelectorNeed  conservative flag: rules whose rightmost compound has an attribute selector are kept
 * @property {string} signature  stable hash of the sets; cache key together with CssBundle.key
 * @property {ReadonlySet<string>} vars  custom property names that inline styles refer to with var() (not part of the signature: they do not change which rules are kept)
 */

/**
 * @typedef {Object} TokenCollector
 * @property {(el: Element) => void} add
 * @property {() => ShakeTokens} finish
 */

/** @param {string} text @returns {string} 53-bit hash as hex */
function hash(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/**
 * Accumulates the tokens of the elements that end up in the serialised clone (the clone builder feeds it while it builds).
 * @returns {TokenCollector}
 */
export function createTokenCollector() {
  const classes = new Set();
  const ids = new Set();
  const tags = new Set();
  const fonts = new Set();
  const vars = new Set();
  let attrNeed = false;
  return {
    add(el) {
      tags.add(el.localName.toLowerCase());
      const attrs = el.attributes;
      let plain = 0;
      for (let i = 0; i < attrs.length; i++) {
        const a = attrs[i];
        const name = a.name;
        if (name === 'class') {
          plain++;
          for (const c of a.value.split(/\s+/)) if (c) classes.add(c);
        } else if (name === 'id') { plain++; ids.add(a.value); } else if (name === 'style') {
          plain++;
          const v = a.value;
          collectVarNames(v, vars);
          if (v.includes('font')) for (const m of v.matchAll(/(?:^|;)\s*font(?:-family)?\s*:([^;]*)/gi)) fonts.add(m[1].trim().toLowerCase());
        }
      }
      if (attrs.length > plain) attrNeed = true;
    },
    finish() {
      const sig = hash([[...classes].sort().join(' '), [...ids].sort().join(' '), [...tags].sort().join(' '), [...fonts].sort().join('|'), attrNeed ? 1 : 0].join('\n'));
      return { classes, ids, tags, fonts, vars, hasAttributeSelectorNeed: attrNeed, signature: sig };
    },
  };
}

// ---------------------------------------------------------------------------------------------- selector matching

const IDENT = /^(?:[\w-]|[^\x00-\x7f]|\\(?:[0-9a-fA-F]{1,6}\s?|[^\n]))+/;

/** @param {string} ident @returns {string} CSS identifier with its escapes resolved */
function unescapeIdent(ident) {
  return ident.includes('\\')
    ? ident.replace(/\\([0-9a-fA-F]{1,6})\s?|\\([^\n])/g, (_m, hex, ch) => (hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd) : ch))
    : ident;
}

/** @param {string} sel one complex selector @returns {string} its rightmost compound */
function rightmostCompound(sel) {
  const s = sel.trim();
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 40) i = skipParens(s, i) - 1;
    else if (c === 91) { const e = s.indexOf(']', i); i = e < 0 ? s.length : e; } else if (c === 34 || c === 39) i = skipString(s, i) - 1;
    else if (c === 92) i++;
    else if (c === 32 || c === 9 || c === 10 || c === 13 || c === 62 || c === 43 || c === 126) start = i + 1;
  }
  return s.slice(start);
}

/**
 * Can the rightmost compound of `sel` match an element described by the tokens?
 * @param {string} sel
 * @param {ShakeTokens} t
 * @returns {boolean}
 */
function selectorMayMatch(sel, t) {
  const comp = rightmostCompound(sel);
  if (!comp || comp.includes('&')) return true;
  let i = 0;
  const first = comp.charCodeAt(0);
  if (first === 42) i = 1;
  else if (first !== 46 && first !== 35 && first !== 91 && first !== 58) {
    const m = IDENT.exec(comp);
    if (!m) return true;
    if (comp[m[0].length] === '|') return true;
    if (!t.tags.has(unescapeIdent(m[0]).toLowerCase())) return false;
    i = m[0].length;
  }
  while (i < comp.length) {
    const ch = comp[i];
    if (ch === '.' || ch === '#') {
      const m = IDENT.exec(comp.slice(i + 1));
      if (!m) return true;
      if (!(ch === '.' ? t.classes : t.ids).has(unescapeIdent(m[0]))) return false;
      i += 1 + m[0].length;
    } else if (ch === '[') {
      const e = comp.indexOf(']', i);
      const name = /^\[\s*([\w-]+)/.exec(comp.slice(i, e < 0 ? undefined : e + 1))?.[1]?.toLowerCase();
      if (name !== 'class' && name !== 'id' && name !== 'style' && !t.hasAttributeSelectorNeed) return false;
      i = e < 0 ? comp.length : e + 1;
    } else if (ch === ':') {
      i += comp[i + 1] === ':' ? 2 : 1;
      const m = IDENT.exec(comp.slice(i));
      i += m ? m[0].length : 0;
      if (comp[i] === '(') i = skipParens(comp, i);
    } else return true;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------- shaking

/** @type {{css: string, nodes: RuleNode[]}|null} */
let lastParse = null;

/** @param {string} body @returns {{fonts: string, anims: string}} lower-case declaration values relevant for @font-face / @keyframes retention */
function declarationText(body) {
  let fonts = '';
  let anims = '';
  for (const m of body.matchAll(/(?:^|[;{}\s])(font-family|font|animation-name|animation|--[\w-]+)\s*:\s*([^;}]*)/gi)) {
    const name = m[1].toLowerCase();
    const value = m[2].toLowerCase();
    if (name === 'animation-name' || name === 'animation') anims += ' ' + value;
    else if (name.startsWith('--')) { fonts += ' ' + value; anims += ' ' + value; } else fonts += ' ' + value;
  }
  return { fonts, anims };
}

const STRUCTURAL = /:(?:nth-|first-|last-|only-|empty)|[+~](?!=)/;

/** @param {RuleNode[]} nodes @returns {boolean} */
function anyStructural(nodes) {
  for (const n of nodes) {
    if (n.k === 'group' ? anyStructural(n.kids ?? []) : n.k === 'style' && (STRUCTURAL.test(n.pre) || (n.body.includes('{') && anyStructural(parseRules(n.body))))) return true;
  }
  return false;
}

/**
 * Does any selector depend on sibling positions (:nth-*, :first/last/only-*, :empty, `+`, `~`)? Then removing or merging siblings in a pruned clone would change which rules match.
 * @param {string} css
 * @returns {boolean}
 */
export function hasStructuralSelectors(css) {
  if (!lastParse || lastParse.css !== css) lastParse = { css, nodes: parseRules(css) };
  return anyStructural(lastParse.nodes);
}

/**
 * Keep a style rule when the rightmost compound of ANY selector of it can match (class/id/tag token present; `*`, :root/.hic-root, attribute selectors, pseudo-elements-only and unknown forms are kept);
 * keep @media/@supports/@layer/@container blocks recursively; keep @keyframes used by a kept rule; keep an @font-face only when its family appears in a kept rule's font/font-family value (or a custom property, which could carry it through var()).
 * Output is cached per (bundle key, tokens.signature) by the caller. Measured motivation: a 96 KB base64 font costs ~2.6 ms per tile (docs/ARCHITECTURE ADR-D.8).
 * @param {string} css
 * @param {ShakeTokens} tokens
 * @returns {string}
 */
export function shakeCss(css, tokens) {
  if (!lastParse || lastParse.css !== css) lastParse = { css, nodes: parseRules(css) };
  let fontText = [...tokens.fonts].join(' ');
  let animText = '';
  /** @param {RuleNode[]} nodes @returns {RuleNode[]} */
  const pass1 = (nodes) => {
    /** @type {RuleNode[]} */
    const out = [];
    for (const node of nodes) {
      if (node.k === 'group') {
        const kids = pass1(node.kids ?? []);
        if (kids.length || /^\s*@layer/i.test(node.pre)) out.push({ ...node, kids });
      } else if (node.k === 'style') {
        if (!splitSelectorList(node.pre).some((s) => selectorMayMatch(s, tokens))) continue;
        const d = declarationText(node.body);
        fontText += d.fonts;
        animText += d.anims;
        out.push(node);
      } else out.push(node);
    }
    return out;
  };
  /** @param {RuleNode[]} nodes @returns {RuleNode[]} */
  const pass2 = (nodes) => {
    /** @type {RuleNode[]} */
    const out = [];
    for (const node of nodes) {
      if (node.k === 'group') { out.push({ ...node, kids: pass2(node.kids ?? []) }); continue; }
      if (node.k === 'opaque') {
        const at = /^\s*@([\w-]+)\s*([^{]*)/.exec(node.pre);
        if (at?.[1].toLowerCase() === 'font-face') {
          const family = /font-family\s*:\s*([^;}]*)/i.exec(node.body)?.[1];
          const name = family?.replace(/["']/g, '').trim().toLowerCase();
          if (name && !fontText.includes(name)) continue;
        } else if (at?.[1].toLowerCase().endsWith('keyframes') && !animText.includes(at[2].trim().replace(/["']/g, '').toLowerCase())) continue;
      }
      out.push(node);
    }
    return out;
  };
  return serializeRules(pass2(pass1(lastParse.nodes)));
}
