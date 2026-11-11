// The WGSL a built plugin inlines (scripts/wgsl-strip.mjs): comments and the blanks between tokens go, and no two tokens are ever joined.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minifyWgsl, stripWgsl, wgslTokens } from '../../../scripts/wgsl-strip.mjs';
import { WGSL_FILES } from './lib/wgsl-files.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('a comment between two tokens keeps them apart: fn/**/main, let/**/x, a nested comment (control: the same source without the comment)', () => {
  assert.equal(stripWgsl('fn/**/main() {}'), 'fn main() {}\n');
  assert.equal(stripWgsl('let/**/x = 1;'), 'let x = 1;\n');
  assert.equal(stripWgsl('a/* outer /* inner */ still */b'), 'a b\n');
  assert.equal(stripWgsl('fn main() {}'), 'fn main() {}\n');
});

test('no space where none is needed: a comment beside blankspace, at a line edge, spanning lines, or a line comment', () => {
  assert.equal(stripWgsl('a /* c */ b'), 'a  b\n', 'the blankspace around it is kept as it was');
  assert.equal(stripWgsl('a/* c */ b'), 'a b\n');
  assert.equal(stripWgsl('/* lead */x;'), 'x;\n');
  assert.equal(stripWgsl('x;/* trail */'), 'x;\n');
  assert.equal(stripWgsl('a/* l1\nl2 */b'), 'a\nb\n', 'its line break is the separator');
  assert.equal(stripWgsl('  x = 1; // note\n\n  y = 2;\n'), 'x = 1;\ny = 2;\n');
});

/** Reference: every comment replaced by one space (nesting-aware), then split into tokens. */
function referenceTokens(/** @type {string} */ src) {
  let out = '', depth = 0;
  for (let i = 0; i < src.length; i++) {
    const two = src.slice(i, i + 2);
    if (two === '/*') { depth++; i++; out += ' '; continue; }
    if (depth && two === '*/') { depth--; i++; continue; }
    if (depth) continue;
    if (two === '//') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
    out += src[i];
  }
  return out.split(/\s+/).filter(Boolean);
}

test('every shipped shader keeps its tokens: the stripped WGSL is the source\'s token stream, without a comment', () => {
  /** @type {string[]} */ const files = [];
  const walk = (/** @type {string} */ d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (n !== 'node_modules') walk(p); } else if (n.endsWith('.wgsl')) files.push(p); } };
  walk(join(ROOT, 'plugins'));
  assert.ok(files.length >= 10, `found ${files.length} .wgsl files`);
  for (const f of files) {
    const src = readFileSync(f, 'utf8'), out = stripWgsl(src);
    assert.deepEqual(out.split(/\s+/).filter(Boolean), referenceTokens(src), f);
    assert.ok(!/\/\*|\/\//.test(out), `${f}: no comment left`);
  }
});

// ---- minifyWgsl: the shaders as the build inlines them ----

test('minifyWgsl drops every blank that separates nothing, and keeps one where two tokens or a comment would form (control: the joins it refuses)', () => {
  assert.equal(minifyWgsl('fn main ( ) -> f32 { return 1.0 ; } // done\n'), 'fn main()->f32{return 1.0;}\n');
  assert.equal(minifyWgsl('@vertex fn vs ( @builtin ( vertex_index ) i : u32 ) { }'), '@vertex fn vs(@builtin(vertex_index)i:u32){}\n');
  // each pair below reads as other tokens, or as a comment, without its space
  for (const [src, out, joined] of [['x - -1;', 'x- -1;', ['x', '--', '1', ';']], ['a & &b;', 'a& &b;', ['a', '&&', 'b', ';']], ['a > = b;', 'a> =b;', ['a', '>=', 'b', ';']],
    ['1 .5;', '1 .5;', ['1.5', ';']], ['1 u;', '1 u;', ['1u', ';']], ['let x;', 'let x;', ['letx', ';']], ['array<vec4<f32> >', 'array<vec4<f32> >', ['array', '<', 'vec4', '<', 'f32', '>>']]]) {
    assert.equal(minifyWgsl(src), out + '\n', src);
    assert.deepEqual(wgslTokens(out.replace(/ /g, '')), joined, `control: ${src} without its space`);
  }
  assert.equal(minifyWgsl('a / *p;'), 'a/ *p;\n');
  assert.deepEqual(wgslTokens(stripWgsl('a/*p;')), ['a'], 'control: `a/*p;` is `a` and an open comment');
});

test('wgslTokens reads numbers, operators and words as WGSL does', () => {
  assert.deepEqual(wgslTokens('0x1.8p3f 1e-3 .5h 2u 3i 4.0 a>>=b c<<=d e->f'), ['0x1.8p3f', '1e-3', '.5h', '2u', '3i', '4.0', 'a', '>>=', 'b', 'c', '<<=', 'd', 'e', '->', 'f']);
});

test('every shipped shader, minified, keeps its tokens and loses bytes; the browser test compiles the same list (WGSL_FILES = the files on disk)', () => {
  /** @type {string[]} */ const files = [];
  const walk = (/** @type {string} */ d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (n !== 'node_modules') walk(p); } else if (n.endsWith('.wgsl')) files.push(p); } };
  walk(join(ROOT, 'plugins'));
  assert.deepEqual(files.map((f) => f.slice(ROOT.length + 1).split('\\').join('/')).sort(), [...WGSL_FILES].sort());
  for (const f of files) {
    const src = readFileSync(f, 'utf8'), min = minifyWgsl(src), stripped = stripWgsl(src);
    assert.deepEqual(wgslTokens(stripWgsl(min)), wgslTokens(referenceTokens(src).join(' ')), f);
    assert.ok(min.length < 0.9 * stripped.length, `${f}: ${stripped.length} -> ${min.length} bytes`);
  }
});
