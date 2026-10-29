// Safari's caret colour rule (src/snapshot/capture/webkit-caret.js): the cases measured on Safari 27.0.1, macOS (sampled at a blink-on phase).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webkitAccentCaret } from '../../../src/snapshot/capture/webkit-caret.js';

/**
 * A chain from the caret's element up: each entry { caret?: string[], author?: boolean, ua?: boolean }.
 * @returns {[(i: number) => string[]|null, (i: number) => {author: boolean, ua: boolean}|null]}
 */
const chain = (...nodes) => [
  (i) => (i < nodes.length ? nodes[i].caret ?? [] : null),
  (i) => (i < nodes.length ? { author: !!nodes[i].author, ua: !!nodes[i].ua } : null),
];
const accent = (nodes, caretIsColor = true) => webkitAccentCaret(...chain(...nodes), caretIsColor);

const INPUT = { ua: true };
const BODY = {}, HTML = {};

test('auto caret of a UA-coloured field is the accent (measured: default input, textarea, dark input, accent-color set)', () => {
  assert.equal(accent([INPUT, BODY, HTML]), true);
  assert.equal(accent([INPUT, { author: true }, BODY, HTML]), true, 'an author colour on an ancestor stops at the input, whose colour the UA sheet sets');
});

test('an author colour on the element or inherited from an ancestor gives the text colour (measured: inline, rule, color: inherit, contenteditable in a coloured block)', () => {
  assert.equal(accent([{ ua: true, author: true }, BODY, HTML]), false, 'input with an author colour (positive control of the UA stop)');
  assert.equal(accent([{}, { author: true }, BODY, HTML]), false, 'contenteditable inheriting an author colour');
  assert.equal(accent([{}, BODY, HTML]), true, 'contenteditable with the initial colour');
  assert.equal(accent([{}, { ua: true }, { author: true }, HTML]), true, 'contenteditable inside a link: the UA link colour stops the inheritance');
});

test('an explicit caret-color is painted as computed; auto, initial and inherited auto give the accent', () => {
  assert.equal(accent([INPUT, BODY], false), false, 'computed caret differs from the text colour');
  assert.equal(accent([{ ua: true, caret: ['currentcolor'] }, BODY]), false, 'caret-color: currentcolor (measured black)');
  assert.equal(accent([{ ua: true, caret: ['rgb(0, 0, 0)'] }, BODY]), false, 'an explicit colour equal to the text colour');
  assert.equal(accent([{ ua: true, caret: ['auto'] }, { caret: ['rgb(0, 160, 0)'] }]), true, 'auto on the input beats an inherited colour (measured accent)');
  assert.equal(accent([{ ua: true, caret: ['inherit'] }, { caret: ['auto'] }]), true, 'inherit passes to the parent');
  assert.equal(accent([{ ua: true }, { caret: ['currentcolor'] }]), false, 'inherited currentcolor');
  assert.equal(accent([{ ua: true, caret: ['initial'] }]), true);
  assert.equal(accent([{ ua: true, caret: ['auto', 'rgb(0, 0, 0)'] }]), false, 'tied declarations that disagree keep the computed colour');
});
