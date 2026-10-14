/**
 * Pure selector rewriter shared by the live layer (selector bridge: canvas compound -> `hic-layer[data-hic-layer]`) and the snapshot clone (canvas compound -> `[data-hic-root]`).
 * Util: imports nothing. No DOM except `canvas.matches(compound)`.
 *
 * The canvas is never a DOM ancestor of its (relocated) children, so a selector that names it as an ancestor (`canvas .x`, `.chart > .x`) matches nothing.
 * The rewriter substitutes the compound that matches the canvas by one that matches its layer / clone root, keeping the selector's specificity.
 * The subject (last) compound is never replaced: a rule that styles the canvas itself must not restyle the layer.
 */

// ---------------------------------------------------------------------------------------------- tokenizer
/** @typedef {{compounds: string[], combinators: string[]}} Complex */

/** @param {string} text @param {number} i index of an opening quote @returns {number} index of the matching closing quote */
function skipString(text, i) {
  const quote = text[i];
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === quote) return j;
  }
  return text.length - 1;
}

/** @param {string} text @param {number} i index of an opening bracket @returns {number} index of the matching closing bracket */
function skipGroup(text, i) {
  const open = text[i];
  const close = open === '(' ? ')' : ']';
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') j++;
    else if (c === '"' || c === "'") j = skipString(text, j);
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return j;
  }
  return text.length - 1;
}

/** @param {string} selector @returns {string[]} the selector list split at top-level commas */
function splitList(selector) {
  /** @type {string[]} */
  const out = [];
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === '\\') i++;
    else if (c === '"' || c === "'") i = skipString(selector, i);
    else if (c === '(' || c === '[') i = skipGroup(selector, i);
    else if (c === ',') { out.push(selector.slice(start, i).trim()); start = i + 1; }
  }
  out.push(selector.slice(start).trim());
  return out.filter(Boolean);
}

/** @param {string} c @returns {boolean} */
const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/** @param {string} complex @returns {Complex|null} null for constructs that are not plain complex selectors (leading combinator, nesting) */
function tokenize(complex) {
  /** @type {string[]} */
  const compounds = [];
  /** @type {string[]} */
  const combinators = [];
  let cur = '';
  let pending = '';
  const flushCompound = () => { if (cur) { compounds.push(cur); cur = ''; } };
  for (let i = 0; i < complex.length; i++) {
    const c = complex[i];
    if (c === '\\') { cur += c + (complex[++i] ?? ''); continue; }
    if (c === '"' || c === "'") { const end = skipString(complex, i); cur += complex.slice(i, end + 1); i = end; continue; }
    if (c === '(' || c === '[') { const end = skipGroup(complex, i); cur += complex.slice(i, end + 1); i = end; continue; }
    if (c === '>' || c === '+' || c === '~') {
      if (!cur && !compounds.length) return null;
      flushCompound();
      pending = c;
      continue;
    }
    if (isSpace(c)) {
      if (cur) { flushCompound(); pending = pending || ' '; }
      continue;
    }
    if (c === '&') return null;
    if (pending) { combinators.push(pending); pending = ''; }
    cur += c;
  }
  flushCompound();
  if (pending || compounds.length !== combinators.length + 1) return null;
  return { compounds, combinators };
}

// ---------------------------------------------------------------------------------------------- specificity
/** @typedef {[number, number, number]} Spec */

/** @param {Spec} a @param {Spec} b @returns {Spec} the higher of two specificities */
const maxSpec = (a, b) => (a[0] !== b[0] ? (a[0] > b[0] ? a : b) : a[1] !== b[1] ? (a[1] > b[1] ? a : b) : a[2] >= b[2] ? a : b);

/** @param {string} text @param {number} i @returns {number} end index (exclusive) of an identifier starting at i, escapes included */
function identEnd(text, i) {
  let j = i;
  while (j < text.length) {
    if (text[j] === '\\') j += 2;
    else if (/[\w\u0080-\uFFFF-]/.test(text[j])) j++;
    else break;
  }
  return Math.min(j, text.length);
}

/** @param {string} args @returns {Spec} the most specific complex selector of a selector list */
function listSpec(args) {
  /** @type {Spec} */
  let best = [0, 0, 0];
  for (const sel of splitList(args)) {
    const parts = tokenize(sel);
    if (!parts) continue;
    /** @type {Spec} */
    const sum = [0, 0, 0];
    for (const compound of parts.compounds) {
      const s = compoundSpec(compound);
      sum[0] += s[0]; sum[1] += s[1]; sum[2] += s[2];
    }
    best = maxSpec(best, sum);
  }
  return best;
}

const LEGACY_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);
const LIST_PSEUDOS = new Set(['is', 'not', 'has', 'matches', '-webkit-any']);

/** @param {string} compound @returns {Spec} */
export function compoundSpec(compound) {
  /** @type {Spec} */
  const spec = [0, 0, 0];
  for (let i = 0; i < compound.length; i++) {
    const c = compound[i];
    if (c === '*') continue;
    if (c === '\\') { i++; continue; }
    if (c === '#') { spec[0]++; i = identEnd(compound, i + 1) - 1; continue; }
    if (c === '.') { spec[1]++; i = identEnd(compound, i + 1) - 1; continue; }
    if (c === '[') { spec[1]++; i = skipGroup(compound, i); continue; }
    if (c === ':') { i = pseudoSpec(compound, i, spec); continue; }
    if (c === '|') continue;
    const end = identEnd(compound, i);
    spec[2]++;
    i = Math.max(end, i + 1) - 1;
  }
  return spec;
}

/** @param {string} compound @param {number} at index of ':' @param {Spec} spec accumulates @returns {number} index of the last consumed char */
function pseudoSpec(compound, at, spec) {
  const element = compound[at + 1] === ':';
  const start = at + (element ? 2 : 1);
  const end = identEnd(compound, start);
  const name = compound.slice(start, end).toLowerCase();
  let last = end - 1;
  let args = '';
  if (compound[end] === '(') {
    last = skipGroup(compound, end);
    args = compound.slice(end + 1, last);
  }
  if (element || LEGACY_ELEMENTS.has(name)) spec[2]++;
  else if (name === 'where') { /* zero */ } else if (LIST_PSEUDOS.has(name)) {
    const s = listSpec(args);
    spec[0] += s[0]; spec[1] += s[1]; spec[2] += s[2];
  } else if (name.startsWith('nth-') && / of /.test(args)) {
    const s = listSpec(args.slice(args.indexOf(' of ') + 4));
    spec[0] += s[0]; spec[1] += 1 + s[1]; spec[2] += s[2];
  } else spec[1]++;
  return last;
}

/**
 * Pad a replacement compound with :not(#hic-pad) / :not(.hic-pad) / :not(hic-pad) (always true, they only add specificity) until it is at least as specific as `original`.
 * @param {string} replacement
 * @param {string} original
 * @returns {string}
 */
export function padReplacement(replacement, original) {
  const want = compoundSpec(original);
  const have = compoundSpec(replacement);
  return replacement
    + ':not(#hic-pad)'.repeat(Math.max(0, want[0] - have[0]))
    + ':not(.hic-pad)'.repeat(Math.max(0, want[1] - have[1]))
    + ':not(hic-pad)'.repeat(Math.max(0, want[2] - have[2]));
}

// ---------------------------------------------------------------------------------------------- pure rewriter
/**
 * PURE. Split the selector list at top-level commas, each complex selector into compounds at combinators (respect (), [], strings, escapes); replace every compound that sits before a descendant or child combinator
 * and for which canvas.matches(compound) is true by `replacement`.
 * Returns null when nothing changed. Sibling combinators after the canvas, and the subject compound, are left alone (limitation).
 * SPECIFICITY IS PRESERVED: the replacement compound is padded with `:not(.hic-pad)` per missing class-level unit (and `:not(#hic-pad)` per id unit) so `canvas.chart .x` (0,2,1) keeps outranking `.x` after the rewrite. Pure and unit-tested.
 * @param {string} selector
 * @param {Element} canvas
 * @param {string} replacement
 * @returns {string|null}
 */
export function rewriteSelectorForCanvas(selector, canvas, replacement) {
  let changed = false;
  const list = splitList(selector).map((complex) => {
    const parts = tokenize(complex);
    if (!parts) return complex;
    let touched = false;
    const compounds = parts.compounds.map((compound, i) => {
      const before = parts.combinators[i];
      if (before === undefined || before === '+' || before === '~') return compound;
      let hit = false;
      try { hit = canvas.matches(compound); } catch { /* pseudo-element or unsupported syntax: leave it */ }
      if (!hit) return compound;
      touched = true;
      return padReplacement(replacement, compound);
    });
    if (!touched) return complex;
    changed = true;
    return compounds.map((compound, i) => compound + (i < parts.combinators.length ? (parts.combinators[i] === ' ' ? ' ' : ` ${parts.combinators[i]} `) : '')).join('');
  });
  return changed ? list.join(', ') : null;
}
