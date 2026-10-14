import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTokenCollector, shakeCss } from '../../../src/snapshot/capture/css-shake.js';

/** minimal element stand-in for the token collector */
const el = (localName, attrs = {}) => ({ localName, attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })) });
const tokensOf = (...els) => { const c = createTokenCollector(); els.forEach((e) => c.add(e)); return c.finish(); };

test('rules survive when the rightmost compound can match, die otherwise', () => {
  const t = tokensOf(el('div', { class: 'card big' }), el('span', { id: 'x' }));
  const css = '.card{a:b}.nope{a:b}div.card{a:b}p.card{a:b}.card .inner{a:b}.card span{a:b}#x{a:b}#y{a:b}.card.gone{a:b}';
  assert.equal(shakeCss(css, t), '.card{a:b}div.card{a:b}.card span{a:b}#x{a:b}');
});

test('universal, pseudo-element-only, :is() and nesting forms are kept', () => {
  const t = tokensOf(el('div'));
  const css = '*{a:b}::selection{a:b}*::before{a:b}:is(.x,.y){a:b}:where(.z){a:b}.q{&:hover{a:b}}.gone{a:b}';
  assert.equal(shakeCss(css, t), '*{a:b}::selection{a:b}*::before{a:b}:is(.x,.y){a:b}:where(.z){a:b}');
});

test('a selector list is kept when any member can match', () => {
  const t = tokensOf(el('div', { class: 'b' }));
  assert.equal(shakeCss('.a, .b{x:y}.a, .c{x:y}', t), '.a, .b{x:y}');
});

test('escaped class names are compared unescaped', () => {
  const t = tokensOf(el('div', { class: 'hover:bg-blue md:w-1/2 a' }));
  assert.equal(shakeCss('.hover\\:bg-blue{x:y}.md\\:w-1\\/2{x:y}.w-\\31 0{x:y}', t), '.hover\\:bg-blue{x:y}.md\\:w-1\\/2{x:y}');
});

test('attribute selectors need an element with attributes; class, id and style attribute selectors always stay', () => {
  const bare = tokensOf(el('div'));
  assert.equal(shakeCss('[data-x]{a:b}input[type=text]{a:b}[class*=col]{a:b}', bare), '[class*=col]{a:b}');
  const withAttr = tokensOf(el('input', { type: 'text' }));
  assert.equal(shakeCss('[data-x]{a:b}input[type=text]{a:b}', withAttr), '[data-x]{a:b}input[type=text]{a:b}');
});

test('media, layer and supports blocks are shaken recursively; empty ones disappear, layer blocks stay', () => {
  const t = tokensOf(el('div', { class: 'a' }));
  const css = '@media (min-width:1px){.a{x:y}.b{x:y}}@media (min-width:2px){.b{x:y}}@layer base{.b{x:y}}@supports (display:grid){.a{x:y}}';
  assert.equal(shakeCss(css, t), '@media (min-width:1px){.a{x:y}}@layer base{}@supports (display:grid){.a{x:y}}');
});

test('@font-face is kept only when a kept rule names the family, also through custom properties', () => {
  const t = tokensOf(el('div', { class: 'a' }));
  const faces = '@font-face{font-family:"Inter";src:url(data:x)}@font-face{font-family:Unused;src:url(data:y)}@font-face{font-family:Mono;src:url(data:z)}';
  const out = shakeCss(`${faces}.a{font-family:Inter,sans-serif}.b{font-family:Unused}.b{--f:Mono}`, t);
  assert.ok(out.includes('"Inter"'));
  assert.ok(!out.includes('Unused'));
  assert.ok(!out.includes('Mono'));
  const t2 = tokensOf(el('div', { class: 'a hic-root' }));
  assert.ok(shakeCss(`${faces}.hic-root{--f:Mono}.a{font-family:var(--f)}`, t2).includes('Mono'));
});

test('inline style fonts keep their @font-face', () => {
  const t = tokensOf(el('div', { style: 'color:red;font-family: Inter, serif' }));
  assert.ok(shakeCss('@font-face{font-family:Inter;src:url(d)}', t).includes('Inter'));
  assert.equal(shakeCss('@font-face{font-family:Inter;src:url(d)}', tokensOf(el('div'))), '');
});

test('@keyframes survive only when an animation of a kept rule names them', () => {
  const t = tokensOf(el('div', { class: 'a' }));
  const out = shakeCss('@keyframes spin{to{x:y}}@keyframes unused{to{x:y}}.a{animation:spin 1s}', t);
  assert.ok(out.includes('spin') && !out.includes('unused'));
});

test('shaking a 100 KB sheet keeps only what the tile uses', () => {
  let css = '';
  for (let i = 0; i < 2000; i++) css += `.c${i}{color:red;margin:${i}px}`;
  const out = shakeCss(css, tokensOf(el('div', { class: 'c5 c1999' })));
  assert.equal(out, '.c5{color:red;margin:5px}.c1999{color:red;margin:1999px}');
});

test('signature depends on every set and is stable', () => {
  const a = tokensOf(el('div', { class: 'a b' }));
  assert.equal(a.signature, tokensOf(el('div', { class: 'b a' })).signature);
  assert.notEqual(a.signature, tokensOf(el('div', { class: 'a' })).signature);
  assert.notEqual(a.signature, tokensOf(el('span', { class: 'a b' })).signature);
  assert.notEqual(a.signature, tokensOf(el('div', { class: 'a b', id: 'x' })).signature);
});
