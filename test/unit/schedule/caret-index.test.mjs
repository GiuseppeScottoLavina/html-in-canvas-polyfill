import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caretAfterEdit, selectionApiMissing } from '../../../src/util/caret-index.js';

test('caretAfterEdit: the caret ends where the edit ended (insert, delete, replace, repeated chars)', () => {
  assert.equal(caretAfterEdit('ada@x.example', 'adaX@x.example'), 4);
  assert.equal(caretAfterEdit('', 'a'), 1);
  assert.equal(caretAfterEdit('abc', 'ab'), 2);
  assert.equal(caretAfterEdit('abc', 'bc'), 0);
  assert.equal(caretAfterEdit('aaa', 'aaaa'), 4, 'ambiguous repeat: the end (the browser cannot be asked)');
  assert.equal(caretAfterEdit('1234', '1235'), 4);
  assert.equal(caretAfterEdit('hello', 'hello'), 5);
});

test('selectionApiMissing: only inputs whose selectionStart is null', () => {
  assert.equal(selectionApiMissing(null), false);
  assert.equal(selectionApiMissing(/** @type {any} */ ({ nodeName: 'TEXTAREA', selectionStart: null, value: '' })), false);
  assert.equal(selectionApiMissing(/** @type {any} */ ({ nodeName: 'INPUT', type: 'text', selectionStart: 0, value: '' })), false);
  assert.equal(selectionApiMissing(/** @type {any} */ ({ nodeName: 'INPUT', type: 'email', selectionStart: null, value: 'a@b' })), true);
  assert.equal(selectionApiMissing(/** @type {any} */ ({ nodeName: 'INPUT', type: 'number', selectionStart: null, value: '1' })), true);
  assert.equal(selectionApiMissing(/** @type {any} */ ({ nodeName: 'INPUT', type: 'checkbox', selectionStart: null, value: 'on' })), false);
});
