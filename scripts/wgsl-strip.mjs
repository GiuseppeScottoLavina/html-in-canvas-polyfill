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
