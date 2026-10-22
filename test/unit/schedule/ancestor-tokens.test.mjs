import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ancestorTokens } from '../../../src/schedule/observers/mutation-observer.js';

const tokens = (sel) => { const out = new Set(); ancestorTokens(sel, out); return [...out].sort(); };

test('a token in the subject compound only styles that element: not an ancestor token (WPT onpaint: `.color-change` restyles the canvas\'s ancestor alone)', () => {
  assert.deepEqual(tokens('.color-change'), []);
  assert.deepEqual(tokens('div, canvas'), []);
  assert.deepEqual(tokens(':root.dark'), []);
  assert.deepEqual(tokens('#d.x[data-y]'), []);
});

test('every class, id and attribute name before the last combinator is an ancestor token, whatever the combinator and white space', () => {
  assert.deepEqual(tokens('.wrap.on #d'), ['.on', '.wrap']);
  assert.deepEqual(tokens('html[data-theme="dark"] #d'), ['[data-theme']);
  assert.deepEqual(tokens('.x  >  .y'), ['.x']);
  assert.deepEqual(tokens('#a + .b ~ .c'), ['#a', '.b']);
  assert.deepEqual(tokens('section > .c, .d ~ .e'), ['.d'], 'each selector of a list on its own');
  assert.deepEqual(tokens('[DATA-Mode] .k'), ['[data-mode'], 'attribute names are case-insensitive');
});

test('tokens inside parentheses of the subject compound count (:is, :not, :has can test ancestors or relatives); escapes are undone; strings are skipped', () => {
  assert.deepEqual(tokens('#d:is(.a .b)'), ['.a', '.b']);
  assert.deepEqual(tokens('a:not(.q)'), ['.q']);
  assert.deepEqual(tokens('.p:has(> .b)'), ['.b']);
  assert.deepEqual(tokens('.md\\:flex .z'), ['.md:flex']);
  assert.deepEqual(tokens('[title="a .b, c"] .t'), ['.b', '[title'], 'a string never splits the list (its text may add a token: more, never fewer)');
});
