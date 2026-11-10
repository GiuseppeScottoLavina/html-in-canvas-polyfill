// structureOf (css-shake.js): the selectors of a bundle whose match depends on sibling positions, each tied to the containers it can reach, and the ones that cannot
// be tied to any (global). The clone builder's use of it is tested in the browser (prune-structure-*.browser.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasStructuralSelectors, meets, splitCompounds, structureOf } from '../../../src/snapshot/capture/css-shake.js';

const need = (tag = null, classes = [], id = null) => ({ tag, id, classes });
const el = (localName, cls = '', id = '') => ({ localName, id, classList: { contains: (c) => cls.split(' ').includes(c) } });

test('splitCompounds: compounds and the combinator on their left; parentheses, brackets, strings and escapes are not split', () => {
  assert.deepEqual(splitCompounds('ul > li + li ~ li a'), [{ comb: null, text: 'ul' }, { comb: '>', text: 'li' }, { comb: '+', text: 'li' }, { comb: '~', text: 'li' }, { comb: ' ', text: 'a' }]);
  assert.deepEqual(splitCompounds('a>b+c~d'), [{ comb: null, text: 'a' }, { comb: '>', text: 'b' }, { comb: '+', text: 'c' }, { comb: '~', text: 'd' }]);
  assert.deepEqual(splitCompounds('li:nth-child(2n + 1) [data-x="a + b"]'), [{ comb: null, text: 'li:nth-child(2n + 1)' }, { comb: ' ', text: '[data-x="a + b"]' }]);
  assert.deepEqual(splitCompounds('.a\\+b + .c'), [{ comb: null, text: '.a\\+b' }, { comb: '+', text: '.c' }]);
  assert.deepEqual(splitCompounds('  .a  '), [{ comb: null, text: '.a' }]);
  assert.equal(splitCompounds('col || td'), null, 'a column combinator');
  assert.equal(splitCompounds('> li'), null, 'a relative selector');
  assert.equal(splitCompounds('a + > b'), null, 'two combinators');
  assert.equal(splitCompounds('a +'), null, 'a trailing combinator');
});

test('no counting selector: nothing to tie; :first-child, :last-child, :only-child and :empty are not counted (the clone keeps them by construction)', () => {
  for (const css of ['.a{x:y}', 'li:first-child{x:y}', 'li:last-child{x:y}.b:only-child{x:y}', 'p:empty{x:y}', 'p:first-of-type{x:y}', 'p::first-line{x:y}p:first-letter{x:y}', 'a[href~="x"]{x:y}', '.w{width:calc(1px + 2px)}']) {
    assert.deepEqual(structureOf(css), { global: false, nth: [], back: [], sibling: [] }, css);
  }
  assert.equal(hasStructuralSelectors('li:last-child{x:y}'), true, 'the whole-bundle test still sees them');
  assert.equal(hasStructuralSelectors('.a{x:y}'), false);
});

test(':nth-child() and :nth-of-type() are tied to the child they select and to the parent a child combinator names', () => {
  assert.deepEqual(structureOf('.row:nth-child(even){x:y}').nth, [{ child: need(null, ['row']), parent: null }]);
  assert.deepEqual(structureOf('.t > tbody > tr:nth-of-type(odd) > *{x:y}').nth, [{ child: need('tr'), parent: need('tbody') }]);
  assert.deepEqual(structureOf('UL LI:Nth-Child(3) a{x:y}').nth, [{ child: need('li'), parent: null }], 'type selectors and pseudo-class names in any case');
  assert.deepEqual(structureOf('#list > .i.j:nth-child(2n of .k){x:y}').nth, [{ child: need(null, ['i', 'j']), parent: need(null, [], 'list') }]);
  assert.deepEqual(structureOf('@media (min-width: 10px){@layer a{td:nth-child(2){x:y}}}').nth, [{ child: need('td'), parent: null }], 'inside group rules');
  assert.deepEqual(structureOf('.a, li:nth-child(2), .b{x:y}').nth, [{ child: need('li'), parent: null }], 'one selector of a list');
});

test('counts from the end are kept apart: :nth-last-child(), :nth-last-of-type(), :last-of-type, :only-of-type', () => {
  const st = structureOf('li:nth-last-child(2){x:y}p:last-of-type{x:y}.c > b:only-of-type{x:y}i:nth-last-of-type(1){x:y}');
  assert.deepEqual(st.back, [{ child: need('li'), parent: null }, { child: need('p'), parent: null }, { child: need('b'), parent: need(null, ['c']) }, { child: need('i'), parent: null }]);
  assert.deepEqual(st.nth, []);
});

test('sibling combinators: both compounds, the parent of the group, and whether type, id and class selectors alone tell the children apart', () => {
  assert.deepEqual(structureOf('li + li{x:y}').sibling, [{ child: need('li'), prev: need('li'), parent: null, exact: true }]);
  assert.deepEqual(structureOf('.stack > * + *{x:y}').sibling, [{ child: need(), prev: need(), parent: need(null, ['stack']), exact: true }]);
  assert.deepEqual(structureOf('h2.t ~ p#x{x:y}').sibling, [{ child: need('p', [], 'x'), prev: need('h2', ['t']), parent: null, exact: true }]);
  assert.deepEqual(structureOf('.s > :not([hidden]) ~ :not([hidden]){x:y}').sibling, [{ child: need(), prev: need(), parent: need(null, ['s']), exact: false }]);
  assert.deepEqual(structureOf('li:first-child + li{x:y}').sibling, [{ child: need('li'), prev: need('li'), parent: null, exact: false }], 'a pseudo-class on either side');
  assert.deepEqual(structureOf('.a[x] + .b{x:y}').sibling[0].exact, false, 'an attribute selector');
  assert.deepEqual(structureOf('.a + .b::before{x:y}').sibling, [{ child: need(null, ['b']), prev: need(null, ['a']), parent: null, exact: true }], 'a pseudo-element changes nothing');
  assert.deepEqual(structureOf('ul > .a + .b ~ .c span{x:y}').sibling, [
    { child: need(null, ['b']), prev: need(null, ['a']), parent: need('ul'), exact: true }, { child: need(null, ['c']), prev: need(null, ['b']), parent: need('ul'), exact: true }]);
  const both = structureOf('.a + li:nth-child(2){x:y}');
  assert.deepEqual([both.nth, both.sibling], [[{ child: need('li'), parent: null }], [{ child: need('li'), prev: need(null, ['a']), parent: null, exact: false }]]);
});

test(':not(), :is() and :where() around a counting pseudo-class count for the element itself', () => {
  assert.deepEqual(structureOf('li:not(:nth-child(1)){x:y}').nth, [{ child: need('li'), parent: null }]);
  assert.deepEqual(structureOf('.c > :is(.a, .b:nth-last-child(2)){x:y}').back, [{ child: need(), parent: need(null, ['c']) }]);
  assert.deepEqual(structureOf('li:not(:last-child){x:y}'), { global: false, nth: [], back: [], sibling: [] }, ':last-child is kept by construction, negated or not');
  assert.deepEqual(structureOf('li:where(:last-of-type){x:y}').back, [{ child: need('li'), parent: null }]);
});

test('what cannot be tied to a container makes the structure global', () => {
  for (const css of ['ul:has(> li:nth-child(2)){x:y}', 'a:has(+ b){x:y}', 'li:not(.a + .b){x:y}', ':is(ul > li:nth-child(2)){x:y}', '.a{&:nth-child(2){x:y}}', '.a{.b + &{x:y}}', '@scope (.a) to (.b + .c){p{x:y}}',
    'svg|rect:nth-child(2){x:y}', '::slotted(li:nth-child(2)){x:y}', ':host(:nth-child(2)){x:y}', 'col || td:nth-child(2){x:y}', '&:nth-child(2){x:y}', ':host-context(.a ~ .b){x:y}']) {
    assert.deepEqual(structureOf(css), { global: true, nth: [], back: [], sibling: [] }, css);
  }
  assert.equal(structureOf('ul:has(> li){x:y}li:nth-child(2){x:y}').global, false, ':has() without a counting selector inside is not');
});

test('meets: the type (any case), the id and every class', () => {
  assert.equal(meets(need('li', ['a', 'b']), el('li', 'b c a')), true);
  assert.equal(meets(need('li', ['a', 'b']), el('li', 'a')), false);
  assert.equal(meets(need('li'), el('LI')), true);
  assert.equal(meets(need('li'), el('ol')), false);
  assert.equal(meets(need(null, [], 'x'), el('p', '', 'x')), true);
  assert.equal(meets(need(null, [], 'x'), el('p', '', 'y')), false);
  assert.equal(meets(need(), el('anything')), true);
});
