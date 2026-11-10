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
 * The value of the i-th attribute of `el` (`names` = its getAttributeNames()). By name when no other attribute has the same qualified name (a namespaced one may):
 * getAttribute is several times cheaper than `attributes[i]`, which creates an Attr node.
 * @param {Element} el @param {string[]} names @param {number} i @returns {string}
 */
function valueAt(el, names, i) {
  const name = names[i];
  return names.indexOf(name) === i && names.lastIndexOf(name) === i ? /** @type {string} */ (el.getAttribute(name)) : el.attributes[i].value;
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
  // class and style values already collected: adding them again adds nothing (rows of a list repeat the same few)
  const seenClass = new Set();
  const seenStyle = new Set();
  return {
    add(el) {
      tags.add(el.localName.toLowerCase());
      // the names, then the values of class / id / style only: reading `attributes[i]` creates an Attr node per attribute
      const names = el.getAttributeNames();
      let plain = 0;
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (name === 'class') {
          plain++;
          const v = valueAt(el, names, i);
          if (seenClass.has(v)) continue;
          seenClass.add(v);
          for (const c of v.split(/\s+/)) if (c) classes.add(c);
        } else if (name === 'id') { plain++; ids.add(valueAt(el, names, i)); } else if (name === 'style') {
          plain++;
          const v = valueAt(el, names, i);
          if (seenStyle.has(v)) continue;
          seenStyle.add(v);
          collectVarNames(v, vars);
          if (v.includes('font')) for (const m of v.matchAll(/(?:^|;)\s*font(?:-family)?\s*:([^;]*)/gi)) fonts.add(m[1].trim().toLowerCase());
        }
      }
      if (names.length > plain) attrNeed = true;
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

// ---------------------------------------------------------------------------------------------- selectors that count siblings

/**
 * @typedef {Object} Need  what an element must have for a compound selector to match it: its type, id and class selectors. The rest of the compound is not read, so a
 *   Need admits every element the compound matches, and more
 * @property {string|null} tag  lower case; null = any
 * @property {string|null} id
 * @property {string[]} classes
 */

/**
 * @typedef {Object} Anchor  a compound selector whose match depends on the siblings of the element (one child of a container)
 * @property {Need} child  that element
 * @property {Need} [prev]  a sibling combinator: the compound on its left (an earlier child of the same container)
 * @property {Need|null} parent  the compound a child combinator joins the sibling group to (the container), when there is one
 * @property {boolean} [exact]  a sibling combinator between two compounds made of type, id and class selectors only: two children of which both or neither meet `prev`,
 *   and both or neither `child`, are the same to it
 */

/**
 * @typedef {Object} Structure  the selectors of a CSS bundle that count siblings, by what a pruned clone may then do in a container whose children they can match
 * @property {boolean} global  one of them could not be tied to a container (inside :has(), in a selector argument with a combinator, in a nested rule, in the
 *   prelude of a scope rule, a namespaced type...): no container is folded or truncated
 * @property {Anchor[]} nth  :nth-child() and :nth-of-type(): a merged run of spacers shifts the index of what follows it; children left out after the kept ones do not
 * @property {Anchor[]} back  :nth-last-child(), :nth-last-of-type(), :last-of-type and :only-of-type: both would change the count from the end
 * @property {Anchor[]} sibling  `+` and `~`: a run is merged only of children that are the same to every such selector (`exact`), or not at all; children left out after
 *   the kept ones change nothing before them
 *
 * Not in it, because a clone built with a Structure keeps them as they are by construction (clone.js cloneChildList): :first-child and :first-of-type (a run keeps
 * its first spacer, and nothing is left out before a kept child); :last-child and :only-child (the last child is never merged into a run, and a hidden stand-in
 * follows the kept children when the rest is left out); :empty (a container keeps a child either way).
 */

/** a selector worth parsing: a counting pseudo-class or a sibling combinator somewhere in its text */
const COUNTING = /:(?:nth-|last-of-type|only-of-type)|[+~](?!=)/i;
const NTH = new Set(['nth-child', 'nth-of-type']);
const BACK = new Set(['nth-last-child', 'nth-last-of-type', 'last-of-type', 'only-of-type']);
/** pseudo-classes whose arguments are selectors matched against the element itself */
const SELF_LIST = new Set(['not', 'is', 'where', 'matches', '-webkit-any', '-moz-any']);

/**
 * One complex selector as its compounds, each with the combinator on its left (' ', '>', '+', '~'; null for the first), or null when it is not understood (a column
 * combinator, a leading combinator as in a relative selector).
 * @param {string} sel
 * @returns {Array<{comb: string|null, text: string}>|null}
 */
export function splitCompounds(sel) {
  const s = sel.trim();
  /** @type {Array<{comb: string|null, text: string}>} */
  const out = [];
  let start = 0;
  /** @type {string|null} */
  let comb = null;
  for (let i = 0; i <= s.length; i++) {
    const c = i < s.length ? s.charCodeAt(i) : 32;
    if (c === 40) { i = skipParens(s, i) - 1; continue; }
    if (c === 91) { const e = s.indexOf(']', i); i = e < 0 ? s.length : e; continue; }
    if (c === 34 || c === 39) { i = skipString(s, i) - 1; continue; }
    if (c === 92) { i++; continue; }
    if (c === 124 && s.charCodeAt(i + 1) === 124) return null;
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12 && c !== 62 && c !== 43 && c !== 126) continue;
    const text = s.slice(start, i);
    if (!text) return null;
    out.push({ comb, text });
    // the combinator: white space around at most one of > + ~
    let j = i, sign = ' ';
    for (; j < s.length; j++) {
      const d = s[j];
      if (d === '>' || d === '+' || d === '~') { if (sign !== ' ') return null; sign = d; } else if (!/\s/.test(d)) break;
    }
    if (j >= s.length) { if (sign !== ' ') return null; break; }
    comb = sign;
    start = j;
    i = j - 1;
  }
  return out.length ? out : null;
}

/**
 * One compound selector: what an element needs to match it, whether it counts siblings (`nth`, `back`), and whether it is made of type, id and class selectors only.
 * `global`: it cannot be tied to the element's own container.
 * @param {string} comp
 * @returns {{need: Need, nth: boolean, back: boolean, plain: boolean, global: boolean}}
 */
function readCompound(comp) {
  /** @type {Need} */
  const need = { tag: null, id: null, classes: [] };
  const out = { need, nth: false, back: false, plain: true, global: false };
  const fail = () => { out.global = true; return out; };
  let i = 0;
  const first = comp.charCodeAt(0);
  if (first === 42) i = 1;
  else if (first === 38) return fail();
  else if (first !== 46 && first !== 35 && first !== 91 && first !== 58) {
    const m = IDENT.exec(comp);
    if (!m || comp[m[0].length] === '|') return fail();
    need.tag = unescapeIdent(m[0]).toLowerCase();
    i = m[0].length;
  }
  while (i < comp.length) {
    const ch = comp[i];
    if (ch === '.' || ch === '#') {
      const m = IDENT.exec(comp.slice(i + 1));
      if (!m) return fail();
      if (ch === '.') need.classes.push(unescapeIdent(m[0])); else need.id = unescapeIdent(m[0]);
      i += 1 + m[0].length;
    } else if (ch === '[') {
      const e = comp.indexOf(']', i);
      out.plain = false;
      i = e < 0 ? comp.length : e + 1;
    } else if (ch === ':') {
      const element = comp[i + 1] === ':';
      i += element ? 2 : 1;
      const m = IDENT.exec(comp.slice(i));
      if (!m) return fail();
      const name = m[0].toLowerCase();
      i += m[0].length;
      let args = '';
      if (comp[i] === '(') { const e = skipParens(comp, i); args = comp.slice(i + 1, e - 1); i = e; }
      if (element || name === 'before' || name === 'after' || name === 'first-line' || name === 'first-letter') {
        // a pseudo-element: ::slotted() and ::part() take selectors of other trees
        if (args && COUNTING.test(args)) return fail();
        continue;
      }
      out.plain = false;
      if (NTH.has(name)) out.nth = true;
      else if (BACK.has(name)) out.back = true;
      else if (SELF_LIST.has(name)) {
        for (const arg of splitSelectorList(args)) {
          if (!COUNTING.test(arg)) continue;
          const parts = splitCompounds(arg);
          if (!parts || parts.length !== 1) return fail();
          const inner = readCompound(parts[0].text);
          if (inner.global) return fail();
          out.nth ||= inner.nth;
          out.back ||= inner.back;
        }
      } else if (args && COUNTING.test(args)) return fail();
    } else return fail();
  }
  return out;
}

/** @param {RuleNode[]} nodes @returns {boolean} a counting selector in a nested rule (relative to its parent rule: not tied to a container here) */
function anyCounting(nodes) {
  for (const n of nodes) {
    if (n.k === 'group' ? anyCounting(n.kids ?? []) : n.k === 'style' && (COUNTING.test(n.pre) || (n.body.includes('{') && anyCounting(parseRules(n.body))))) return true;
  }
  return false;
}

/** @param {RuleNode[]} nodes @param {Structure} st */
function collectStructure(nodes, st) {
  for (const n of nodes) {
    if (st.global) return;
    if (n.k === 'group') {
      if (/^\s*@scope\b/i.test(n.pre) && COUNTING.test(n.pre)) { st.global = true; return; }
      collectStructure(n.kids ?? [], st);
      continue;
    }
    if (n.k !== 'style') continue;
    if (n.body.includes('{') && anyCounting(parseRules(n.body))) { st.global = true; return; }
    if (!COUNTING.test(n.pre)) continue;
    for (const sel of splitSelectorList(n.pre)) {
      if (!COUNTING.test(sel)) continue;
      const parts = splitCompounds(sel);
      if (!parts) { st.global = true; return; }
      const read = parts.map((p) => readCompound(p.text));
      if (read.some((r) => r.global)) { st.global = true; return; }
      /** the compound a child combinator joins the sibling group of compound `i` to @param {number} i @returns {Need|null} */
      const parentOf = (i) => {
        let j = i;
        while (j > 0 && (parts[j].comb === '+' || parts[j].comb === '~')) j--;
        return j > 0 && parts[j].comb === '>' ? read[j - 1].need : null;
      };
      for (let i = 0; i < parts.length; i++) {
        const r = read[i];
        if (r.back) st.back.push({ child: r.need, parent: parentOf(i) });
        else if (r.nth) st.nth.push({ child: r.need, parent: parentOf(i) });
        if (parts[i].comb === '+' || parts[i].comb === '~') st.sibling.push({ child: r.need, prev: read[i - 1].need, parent: parentOf(i), exact: r.plain && read[i - 1].plain });
      }
    }
  }
}

const STRUCTURAL = /:(?:nth-|first-|last-|only-|empty)|[+~](?!=)/i;

/** @param {RuleNode[]} nodes @returns {boolean} */
function anyStructural(nodes) {
  for (const n of nodes) {
    if (n.k === 'group' ? anyStructural(n.kids ?? []) : n.k === 'style' && (STRUCTURAL.test(n.pre) || (n.body.includes('{') && anyStructural(parseRules(n.body))))) return true;
  }
  return false;
}

/**
 * Does any selector depend on sibling positions at all (:nth-*, :first/last/only-*, :empty, `+`, `~`)? Without one, a pruned clone merges and leaves out siblings
 * freely, and a wrapper may be added among an element's children (the selection's). With one, structureOf() says what may be done where.
 * @param {string} css
 * @returns {boolean}
 */
export function hasStructuralSelectors(css) {
  if (!lastParse || lastParse.css !== css) lastParse = { css, nodes: parseRules(css) };
  return anyStructural(lastParse.nodes);
}

/** @type {{css: string, structure: Structure}|null} */
let lastStructure = null;

/**
 * The selectors of `css` whose match depends on sibling positions (:nth-*(), :last-of-type, :only-of-type, `+`, `~`), each tied to the containers it can reach.
 * Removing or merging siblings in a pruned clone changes which of those rules match, so the clone builder asks, per container, what it may do there (clone.js).
 * @param {string} css
 * @returns {Structure}
 */
export function structureOf(css) {
  if (lastStructure?.css === css) return lastStructure.structure;
  /** @type {Structure} */
  const st = { global: false, nth: [], back: [], sibling: [] };
  if (COUNTING.test(css)) {
    if (!lastParse || lastParse.css !== css) lastParse = { css, nodes: parseRules(css) };
    collectStructure(lastParse.nodes, st);
  }
  if (st.global) { st.nth = []; st.back = []; st.sibling = []; }
  lastStructure = { css, structure: st };
  return st;
}

/** @param {Need} need @param {Element} el @returns {boolean} `el` has what the compound needs */
export function meets(need, el) {
  if (need.tag !== null && el.localName.toLowerCase() !== need.tag) return false;
  if (need.id !== null && el.id !== need.id) return false;
  for (const c of need.classes) if (!el.classList.contains(c)) return false;
  return true;
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
