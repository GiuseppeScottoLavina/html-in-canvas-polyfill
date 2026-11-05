// The WGSL a built plugin inlines (scripts/wgsl-strip.mjs): comments, indentation and blank lines go, and no two tokens are ever joined.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripWgsl } from '../../../scripts/wgsl-strip.mjs';

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
