import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hoverChangesLayout, hoverSubjects, parseRules, serializeRules, splitSelectorList, mapSelectors, rewriteViewportUnits, rewriteRootSelectors, rewriteInteractionPseudos, detectPseudos,
  dropUnclonableSelectors, rewriteCanvasSelectors, rewriteHostSelectors, rewriteLinkPseudos,
} from '../../../src/snapshot/capture/css-rewrite.js';

const vp = { width: 1400, height: 800 };

test('parser round-trips nesting, custom properties with braces, strings and data urls', () => {
  const css = '@import url("a.css");@media (min-width: 10px){.a{color:red}}.b{--x:{a:b};background:url(data:image/png;base64,AA;BB{)}.c{&:hover{color:blue}.d{color:red}}@font-face{font-family:"x;y"}';
  assert.equal(serializeRules(parseRules(css)), css);
  const nodes = parseRules(css);
  assert.deepEqual(nodes.map((n) => n.k), ['stmt', 'group', 'style', 'style', 'opaque']);
});

test('splitSelectorList ignores commas inside functions, attributes and strings', () => {
  assert.deepEqual(splitSelectorList('a, :is(b, c) , [x="1,2"] d'), ['a', ':is(b, c)', '[x="1,2"] d']);
});

test('viewport units become px of the live viewport, also in calc and negative values', () => {
  assert.equal(rewriteViewportUnits('.a{width:50vw;height:100vh;margin:-10vmin;padding:calc(100vw - 20px)}', vp), '.a{width:700px;height:800px;margin:-80px;padding:calc(1400px - 20px)}');
  assert.equal(rewriteViewportUnits('.a{height:100dvh;top:50svh;left:10lvw;width:10vmax}', vp), '.a{height:800px;top:400px;left:140px;width:140px}');
  assert.equal(rewriteViewportUnits('.a{width:1.5vw}', vp), '.a{width:21px}');
});

test('viewport unit rewrite leaves strings, urls and identifiers alone', () => {
  const css = '.a{content:"50vw";background:url(data:image/png;base64,AAA1vwBBB);width:calc(2vw)}.vw{--x:3vh1}';
  const out = rewriteViewportUnits(css, vp);
  assert.ok(out.includes('content:"50vw"'));
  assert.ok(out.includes('base64,AAA1vwBBB'));
  assert.ok(out.includes('width:calc(28px)'));
  assert.ok(out.includes('.vw{--x:3vh1}'));
});

test('root selectors: html, body, :root and html body collapse to .hic-root', () => {
  assert.equal(rewriteRootSelectors('html{a:b}body{c:d}:root{--x:1}'), '.hic-root{a:b}.hic-root{c:d}.hic-root{--x:1}');
  assert.equal(rewriteRootSelectors('html.dark body .x, body > .y{a:b}'), '.hic-root.dark .x, .hic-root > .y{a:b}');
  assert.equal(rewriteRootSelectors('html body p{a:b}'), '.hic-root p{a:b}');
  assert.equal(rewriteRootSelectors('.html-page .body, [data-x=body], .a:not(body){a:b}'), '.html-page .body, [data-x=body], .a:not(.hic-root){a:b}');
  assert.equal(rewriteRootSelectors('@media (min-width:1px){html{a:b}}'), '@media (min-width:1px){.hic-root{a:b}}');
});

test('root rewrite does not touch declarations or url()', () => {
  const css = '.a{font-family:body,html;background:url(body.png)}';
  assert.equal(rewriteRootSelectors(css), css);
});

test('interaction pseudo-classes become classes', () => {
  assert.equal(rewriteInteractionPseudos('a:hover{x:y}'), 'a.hic-hover{x:y}');
  assert.equal(rewriteInteractionPseudos('button:active, input:focus-visible, div:focus-within, p:focus{x:y}'), 'button.hic-active, input.hic-focus-visible, div.hic-focus-within, p.hic-focus{x:y}');
  assert.equal(rewriteInteractionPseudos('.a:not(:hover) > .b:has(:focus){x:y}'), '.a:not(.hic-hover) > .b:has(.hic-focus){x:y}');
  assert.equal(rewriteInteractionPseudos('input:user-invalid{x:y}'), 'input.hic-user-invalid{x:y}');
});

test('pseudo rewrite keeps escaped class names, pseudo-element compounds and attribute values', () => {
  assert.equal(rewriteInteractionPseudos('.hover\\:bg:hover{x:y}'), '.hover\\:bg.hic-hover{x:y}');
  assert.equal(rewriteInteractionPseudos('.x\\:hover{x:y}'), '.x\\:hover{x:y}');
  assert.equal(rewriteInteractionPseudos('a::before:hover{x:y}'), 'a::before:hover{x:y}');
  assert.equal(rewriteInteractionPseudos('[title=":hover"]{x:y}'), '[title=":hover"]{x:y}');
  assert.equal(rewriteInteractionPseudos('.a{color:red;&:hover{color:blue}}'), '.a{color:red;&.hic-hover{color:blue}}');
});

test('detectPseudos reports which interaction pseudo-classes occur', () => {
  assert.deepEqual(detectPseudos('a:hover{} b:focus-visible{}'), { hover: true, active: false, focus: false, focusVisible: true, focusWithin: false, hoverLayout: false, hoverInk: false, hoverSubjects: ['a'] });
  assert.deepEqual(detectPseudos('a{} .x\\:hover{}'), { hover: false, active: false, focus: false, focusVisible: false, focusWithin: false, hoverLayout: false });
  assert.equal(detectPseudos('a:focus-within{}').focus, false);
  assert.equal(detectPseudos('a:focus-within{}').focusWithin, true);
});

test('unclonable selectors: :visited and scrollbar pseudo-elements are dropped, other list members stay', () => {
  assert.equal(dropUnclonableSelectors('a:visited{x:y}'), '');
  assert.equal(dropUnclonableSelectors('a:visited, b{x:y}'), 'b{x:y}');
  assert.equal(dropUnclonableSelectors('.s::-webkit-scrollbar{width:15px}.s::-webkit-scrollbar-thumb:hover{a:b}.t{c:d}'), '.t{c:d}');
  assert.equal(dropUnclonableSelectors('@media (min-width:1px){a:visited{x:y}b{z:w}}'), '@media (min-width:1px){b{z:w}}');
});

test('a compound that names the canvas is replaced by the clone root with the same specificity; the subject is left alone', () => {
  const canvas = { matches: (/** @type {string} */ c) => c === 'canvas' || c === 'canvas.chart' || c === '.chart' || c === '#c' };
  assert.equal(rewriteCanvasSelectors('canvas > .a{x:y}', canvas), '[data-hic-root]:not(hic-pad) > .a{x:y}');
  assert.equal(rewriteCanvasSelectors('canvas.chart .a{x:y}', canvas), '[data-hic-root]:not(hic-pad) .a{x:y}');
  assert.equal(rewriteCanvasSelectors('#c .a, .chart > .b{x:y}', canvas), '[data-hic-root]:not(#hic-pad) .a, [data-hic-root] > .b{x:y}');
  assert.equal(rewriteCanvasSelectors('.canvas, #canvas, canvas-x, canvas{x:y}', canvas), '.canvas, #canvas, canvas-x, canvas{x:y}');
});

test('host selectors map to the canvas shell', () => {
  assert.equal(rewriteHostSelectors(':host{a:b}'), '[data-hic-root]{a:b}');
  assert.equal(rewriteHostSelectors(':host(.x) .y{a:b}'), '[data-hic-root].x .y{a:b}');
  assert.equal(rewriteHostSelectors(':host-context(.dark) .y{a:b}'), '');
});

test('mapSelectors applies to nested style rules', () => {
  const out = mapSelectors('.a{color:red;.b{x:y}}', (s) => s.toUpperCase());
  assert.equal(out, '.A{color:red;.B{x:y}}');
});

test('rewriteLinkPseudos: :link and :any-link become :where(a,area)[href] (same specificity), :visited stays dropped, other pseudo names are untouched', () => {
  assert.equal(rewriteLinkPseudos('a:link{a:b}:any-link{c:d}.x:not(:link) b{e:f}'), 'a:where(a,area)[href]{a:b}:where(a,area)[href]{c:d}.x:not(:where(a,area)[href]) b{e:f}');
  assert.equal(rewriteLinkPseudos('.a::before{content:":link"}.l:linked{a:b}.hover-link{c:d}'), '.a::before{content:":link"}.l:linked{a:b}.hover-link{c:d}');
  assert.equal(dropUnclonableSelectors(rewriteLinkPseudos('a:visited{a:b}a:link, a:visited{c:d}')), 'a:where(a,area)[href]{c:d}');
});

test('detectPseudos: with paint-only :hover rules, hoverInk tells a rule that may paint beyond the element (a shadow, an outline, a decoration) from one that recolours', () => {
  assert.equal(detectPseudos('li:hover{background:#cfdcf8;color:red;border-color:blue;outline-color:red;opacity:.5;transition:background .2s}').hoverInk, false);
  for (const decl of ['box-shadow:0 0 2px red', 'outline:1px solid', 'text-shadow:0 0 1px', 'text-decoration:underline', 'outline-width:2px'])
    assert.equal(detectPseudos(`li:hover{${decl}}`).hoverInk, true, decl);
  assert.equal(detectPseudos('li:hover{padding:2px}').hoverInk, undefined, 'a layout change says nothing more');
});

test('hoverSubjects: the compounds whose hover a rule tests (an element that matches none looks the same hovered or not); null when the text cannot tell', () => {
  assert.deepEqual(hoverSubjects('#list li:hover{background:red}'), ['li']);
  assert.deepEqual(hoverSubjects('ul > li.row:hover span, a:hover::after, :hover{color:red}'), ['li.row', 'a', '*']);
  assert.deepEqual(hoverSubjects('.card:hover .title{color:red} .x{color:blue}'), ['.card'], 'the hovered compound, not the subject');
  assert.deepEqual(hoverSubjects('@media (min-width:1px){tr:hover td{background:red}}'), ['tr'], 'inside a group rule');
  assert.deepEqual(hoverSubjects('li{color:red; b:hover{color:blue}}'), ['b'], 'a rule nested without the nesting selector');
  assert.equal(hoverSubjects('li:not(:hover){opacity:.5}'), null, ':hover inside a functional pseudo-class');
  assert.equal(hoverSubjects('ul:has(li:hover){color:red}'), null);
  assert.equal(hoverSubjects('li{&:hover{color:red}}'), null, 'the nesting selector');
  assert.deepEqual(hoverSubjects('li{color:red}'), []);
});

test('hoverChangesLayout: only paint properties under :hover are paint-only; a box, a display or a custom property is not', () => {
  assert.equal(hoverChangesLayout('li:hover{background:#cfdcf8;color:red;border-color:blue;box-shadow:0 0 2px red;outline:1px solid}'), false);
  assert.equal(hoverChangesLayout('li{padding:4px} li:hover{background-color:red}'), false, 'layout properties outside :hover rules do not count');
  assert.equal(hoverChangesLayout('li:hover{padding:6px}'), true);
  assert.equal(hoverChangesLayout('.m:hover .sub{display:block}'), true);
  assert.equal(hoverChangesLayout('li:hover{--x:1}'), true, 'a custom property can feed anything');
  assert.equal(hoverChangesLayout('li:hover{border:1px solid red}'), true, 'the border shorthand sets a width');
  assert.equal(hoverChangesLayout('@media (min-width:1px){li:hover{transform:scale(1.1)}}'), true, 'inside a group rule');
  assert.equal(hoverChangesLayout('li{&:hover{width:10px}}'), true, 'a nested :hover rule');
  assert.equal(hoverChangesLayout('li:hover{& b{margin:2px}}'), true, 'a rule nested in a :hover rule');
  assert.equal(hoverChangesLayout('li{&:hover{color:red}}'), false);
});
