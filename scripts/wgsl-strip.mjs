// WGSL as a built plugin carries it (scripts/build.mjs inlines it). Pure, tested in test/unit/gate-tooling/wgsl-strip.test.mjs.

/**
 * Without comments (block comments nest in WGSL), indentation and blank lines. WGSL has no string literals, so `//` and `/*` always start a comment.
 * A comment is a token separator (WGSL counts it as blankspace): where one sat between two tokens on the same line, a space is kept, so `fn/**\/main` stays
 * two tokens and never becomes `fnmain`. A comment with blankspace on either side, or one that spans lines (its line break is kept), needs none, and the
 * output of such source is unchanged. The shaders were up to a third comments (shatter: about 6 KB of 42 KB).
 * @param {string} src @returns {string}
 */
export function stripWgsl(src) {
  let out = '', depth = 0;
  const blank = (/** @type {string|undefined} */ c) => c === undefined || /\s/.test(c);
  for (let i = 0; i < src.length; i++) {
    const two = src.slice(i, i + 2);
    if (two === '/*') { depth++; i++; continue; }
    if (depth && two === '*/') {
      depth--; i++;
      if (!depth && !blank(out.at(-1)) && !blank(src[i + 1])) out += ' ';
      continue;
    }
    if (depth) { if (src[i] === '\n') out += '\n'; continue; }
    if (two === '//') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
    out += src[i];
  }
  return out.split('\n').map((l) => l.trim()).filter(Boolean).join('\n') + '\n';
}

// A WGSL token (after stripWgsl, so no comment): an identifier or keyword, a number (decimal or hexadecimal, with exponent and suffix), or the longest
// operator or punctuation that matches. Blankspace separates tokens and is not one.
const TOKEN = new RegExp([
  '[A-Za-z_][A-Za-z0-9_]*',
  '0[xX](?:[0-9a-fA-F]+\\.?[0-9a-fA-F]*|\\.[0-9a-fA-F]+)(?:[pP][+-]?[0-9]+)?[iufh]?',
  '(?:[0-9]+\\.?[0-9]*|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?[iufh]?',
  '>>=|<<=|->|&&|\\|\\||==|!=|<=|>=|<<|>>|\\+\\+|--|[-+*/%&|^]=',
  '[^\\sA-Za-z0-9_]',
].join('|'), 'y');
const BLANK = /\s+/y;

/**
 * The tokens of comment-free WGSL, in order. Throws on a character that starts no token.
 * @param {string} src @returns {string[]}
 */
export function wgslTokens(src) {
  /** @type {string[]} */ const out = [];
  let i = 0;
  while (i < src.length) {
    BLANK.lastIndex = i;
    if (BLANK.test(src)) { i = BLANK.lastIndex; continue; }
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(src);
    if (!m) throw new Error(`wgslTokens: no token at ${i}: ${JSON.stringify(src.slice(i, i + 20))}`);
    out.push(m[0]);
    i = TOKEN.lastIndex;
  }
  return out;
}

/**
 * stripWgsl, then every blank that separates nothing: the tokens are written one after the other, with one space only where the two would read
 * as other tokens or a comment without it (two words, `x - -1`, `a / *p`, `1 .5`). The result, read as WGSL reads it (comments first), has the
 * source's token stream (checked here: a mismatch throws),
 * so it is the same program; template lists (`array<vec4<f32>>`) do not depend on blankspace. Names are kept: entry points, overrides and
 * bindings are found by name. The shipped shaders lose about a sixth of their stripped bytes (2026-11-11).
 * @param {string} src @returns {string}
 */
export function minifyWgsl(src) {
  const tokens = wgslTokens(stripWgsl(src));
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i - 1], b = tokens[i];
    if (a !== undefined) {
      const joined = wgslTokens(a + b);
      // `/` then `/` or `*` would start a comment, which wgslTokens does not know
      if (joined.length !== 2 || joined[0] !== a || joined[1] !== b || (a.endsWith('/') && /^[/*]/.test(b))) out += ' ';
    }
    out += b;
  }
  const check = wgslTokens(stripWgsl(out));
  if (check.length !== tokens.length || check.some((t, i) => t !== tokens[i])) throw new Error('minifyWgsl: the minified shader reads as other tokens');
  return out + '\n';
}
