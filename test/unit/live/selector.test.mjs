import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteSelectorForCanvas, compoundSpec, padReplacement, structuralTwins } from '../../../src/live/selector-bridge.js';
import { correctionTransform } from '../../../src/live/geometry-apply.js';

/** A canvas stand-in: <canvas id="app" class="chart big" data-x="1" lang="en"> */
const canvas = {
  matches(compound) {
    const known = new Set(['canvas', 'canvas.chart', '.chart', '#app', '.chart.big', 'canvas.chart[data-x]', '[data-x]', '*', ':is(canvas, .zzz)', 'canvas#app.chart', '[data-x="a, b"]']);
    if (compound.includes('::')) throw new SyntaxError('pseudo-element');
    return known.has(compound);
  },
};
const L = 'hic-layer[data-hic-layer="3"]';
const rw = (sel) => rewriteSelectorForCanvas(sel, canvas, L);

test('descendant and child combinators after the canvas compound are rewritten', () => {
  assert.equal(rw('canvas .x'), `${L} .x`);
  assert.equal(rw('#app > .x'), `${L}:not(#hic-pad) > .x`);
  assert.equal(rw('.stack canvas > .x'), `.stack ${L} > .x`);
  assert.equal(rw('.stack>canvas>.x'), `.stack > ${L} > .x`);
});

test('the subject compound and sibling combinators are never rewritten', () => {
  assert.equal(rw('canvas'), null);
  assert.equal(rw('.x canvas'), null);
  assert.equal(rw('canvas + .x'), null);
  assert.equal(rw('canvas ~ .x'), null);
  assert.equal(rw('.a canvas.chart'), null);
});

test('selector lists: only the matching parts change', () => {
  assert.equal(rw('.a .b, canvas .x, p > span'), `.a .b, ${L} .x, p > span`);
  assert.equal(rw('.a .b, p > span'), null);
});

test('specificity is preserved by padding (never below the layer base)', () => {
  assert.equal(rw('canvas.chart .x'), `${L} .x`, '(0,1,1) equals the base');
  assert.equal(rw('canvas#app.chart .x'), `${L}:not(#hic-pad) .x`, '(1,1,1): one id unit');
  assert.equal(rw('.chart.big .x'), `${L}:not(.hic-pad) .x`, '(0,2,0): one class unit');
  assert.equal(padReplacement(L, 'canvas'), L);
  assert.equal(padReplacement(L, 'canvas.chart[data-x]'), `${L}:not(.hic-pad)`);
  assert.equal(padReplacement(L, '.chart.big[data-x]'), `${L}:not(.hic-pad):not(.hic-pad)`);
  assert.equal(padReplacement(L, '#app'), `${L}:not(#hic-pad)`);
  assert.equal(padReplacement(L, '*'), L, 'never below the base');
  assert.equal(padReplacement('[data-hic-root]', 'canvas.chart'), '[data-hic-root]:not(hic-pad)');
  // the padded replacement really ties the original: (id, class, type) of both sides are equal
  const padded = padReplacement(L, 'canvas#app.chart[data-x]');
  assert.deepEqual(compoundSpec(padded), compoundSpec('canvas#app.chart[data-x]'));
});

test('compound specificity: ids, classes, attributes, pseudos, :is/:not/:where, nth-child of', () => {
  assert.deepEqual(compoundSpec('canvas'), [0, 0, 1]);
  assert.deepEqual(compoundSpec('*'), [0, 0, 0]);
  assert.deepEqual(compoundSpec('canvas.chart[data-x]#app'), [1, 2, 1]);
  assert.deepEqual(compoundSpec('.a:hover'), [0, 2, 0]);
  assert.deepEqual(compoundSpec('a::before'), [0, 0, 2]);
  assert.deepEqual(compoundSpec(':is(.a, #b)'), [1, 0, 0]);
  assert.deepEqual(compoundSpec(':where(#b, .a).c'), [0, 1, 0]);
  assert.deepEqual(compoundSpec(':not(.a.b)'), [0, 2, 0]);
  assert.deepEqual(compoundSpec(':nth-child(2n + 1 of .x)'), [0, 2, 0]);
  assert.deepEqual(compoundSpec('.a\\:b'), [0, 1, 0]);
  assert.deepEqual(compoundSpec('[title="a b)"]'), [0, 1, 0]);
});

test('parser respects strings, parentheses, brackets, escapes and odd spacing', () => {
  assert.equal(rw('[data-x="a, b"] .x'), `${L} .x`, 'comma inside a string does not split the list');
  assert.equal(rw('canvas:not(.a, .b) .x'), null, 'compound is not a known canvas compound');
  assert.equal(rw(':is(canvas, .zzz) .x'), `${L} .x`);
  assert.equal(rw('canvas\n  >\n  .x'), `${L} > .x`);
  assert.equal(rw('canvas  .x   .y'), `${L} .x .y`);
  assert.equal(rw('> .x'), null, 'leading combinator (nesting) is left alone');
  assert.equal(rw('canvas::before .x'), null, 'a pseudo-element compound never matches');
  assert.equal(rw(''), null);
  assert.equal(rw('.a\\:b canvas .x'), `.a\\:b ${L} .x`, 'escaped colon stays in its compound');
});

test('correctionTransform: translate(-e) matrix(M) and matrix3d with the perspective row kept', () => {
  const m2 = { is2D: true, a: 1.5, b: 0, c: 0, d: 2, e: 40, f: -3.25 };
  assert.equal(correctionTransform(m2, { x: 10, y: 20.5 }), 'translate(-10px, -20.5px) matrix(1.5, 0, 0, 2, 40, -3.25)');
  assert.equal(correctionTransform(m2, { x: 0, y: 0 }), 'translate(0px, 0px) matrix(1.5, 0, 0, 2, 40, -3.25)');
  const m3 = { is2D: false };
  const cells = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -0.002, 5, 6, 7, 1];
  ['m11', 'm12', 'm13', 'm14', 'm21', 'm22', 'm23', 'm24', 'm31', 'm32', 'm33', 'm34', 'm41', 'm42', 'm43', 'm44'].forEach((k, i) => { m3[k] = cells[i]; });
  assert.equal(correctionTransform(m3, { x: 1, y: 2 }), 'translate(-1px, -2px) matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -0.002, 5, 6, 7, 1)');
  assert.equal(correctionTransform({ ...m2, e: NaN }, { x: 0, y: 0 }), null, 'an unrestricted-double NaN has no CSS form: null, never a throw');
});

test('structuralTwins: end-counting pseudo-classes become blind to the live layer, others yield nothing', () => {
  const N = ':not(:where(hic-layer))';
  assert.deepEqual(structuralTwins('.p > :last-child'), [{ twin: `.p > :nth-last-child(1 of ${N})`, relaxed: '.p > :is(*)' }]);
  assert.equal(structuralTwins('li:nth-last-child(2n+1)')[0].twin, `li:nth-last-child(2n+1 of ${N})`);
  assert.equal(structuralTwins('.a:nth-last-child(1 of .x)')[0].twin, '.a:nth-last-child(1 of .x)', 'an explicit "of" list is kept');
  assert.match(structuralTwins(':only-child')[0].twin, /^:not\(:nth-child\(n\+2 of/);
  assert.deepEqual(structuralTwins('.a:first-child, .b:nth-child(2)'), []);
  assert.deepEqual(structuralTwins('.a, .b:last-child').map((t) => t.relaxed), ['.b:is(*)'], 'only the members that count from the end');
  assert.deepEqual(structuralTwins('a[title="x,:last-child"]:last-child, b').length, 1, 'commas inside brackets and strings do not split');
});
