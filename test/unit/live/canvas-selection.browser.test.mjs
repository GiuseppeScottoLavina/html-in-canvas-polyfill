// A double click on the bare canvas selects the nearest word of the live layer text (WPT hit-test/selection).
import { test, assert, fixture } from '/test/unit/lib/t.js';
import { selectWordNear, wordAt, nearestTextPosition } from '/src/live/canvas-selection.js';

test('wordAt: the word around an offset; at a word end, the word before it', () => {
  assert.deepEqual(wordAt('hello world', 0), { start: 0, end: 5 });
  assert.deepEqual(wordAt('hello world', 8), { start: 6, end: 11 });
  assert.deepEqual(wordAt('hello world', 11), { start: 6, end: 11 });
  assert.deepEqual(wordAt('hello world', 5), { start: 0, end: 5 });
});

test('selectWordNear: a point below and right of the text selects the nearest word of the layer text', (t) => {
  const root = fixture('<div id="layer" style="position:absolute;left:0;top:0;width:200px;height:200px;font:16px monospace"><div id="target">hello world</div></div>');
  t.cleanup(() => getSelection().removeAllRanges());
  const layer = root.querySelector('#layer');
  const text = root.querySelector('#target').firstChild;
  getSelection().removeAllRanges();
  assert.equal(selectWordNear(layer, 190, 105), true);
  const sel = getSelection();
  assert.equal(sel.anchorNode, text, 'the selection is in the #target text, as the native double click on the canvas');
  assert.equal(sel.toString(), 'world');
  const r = text.parentElement.getBoundingClientRect();
  assert.equal(selectWordNear(layer, r.left + 2, r.top + 2), true);
  assert.equal(getSelection().toString(), 'hello');
});

test('selectWordNear: no text, or user-select:none, selects nothing', (t) => {
  const root = fixture('<div id="a" style="width:50px;height:50px"></div><div id="b" style="user-select:none">text</div>');
  t.cleanup(() => getSelection().removeAllRanges());
  getSelection().removeAllRanges();
  assert.equal(nearestTextPosition(root.querySelector('#a'), 10, 10), null);
  assert.equal(selectWordNear(root.querySelector('#a'), 10, 10), false);
  assert.equal(selectWordNear(root.querySelector('#b'), 10, 10), false);
  assert.equal(getSelection().anchorNode, null);
});
