// Selecting the children of a managed canvas (selectAllChildren, selectNodeContents) selects its drawables, whose nodes live in the layer
// (WPT privacy/visited-link/visited-link-custom-selection-color-ignored).
import { test, assert } from '/test/unit/lib/t.js';
import { inst, mk, sleep } from './_real.mjs';

test('getSelection().selectAllChildren(canvas) and range.selectNodeContents(canvas) select the drawables (their text), as natively', async (t) => {
  const i = inst(t);
  const c = await mk(t, i);
  const sel = /** @type {Selection} */ (getSelection());
  t.cleanup(() => sel.removeAllRanges());
  sel.selectAllChildren(c);
  assert.equal(sel.isCollapsed, false);
  assert.equal(sel.toString().trim(), 'hi');
  assert.ok(sel.getRangeAt(0).intersectsNode(/** @type {Node} */ (c.querySelector('#g'))));
  const range = document.createRange();
  range.selectNodeContents(c);
  assert.equal(range.toString().trim(), 'hi');
});

test('the selected drawable is drawn with the selection: the ::selection background of its text', async (t) => {
  const i = inst(t);
  const style = document.createElement('style');
  style.textContent = '#a::selection, #g::selection { background-color: rgb(0, 255, 0); color: rgb(0, 255, 0); }';
  document.head.append(style);
  t.cleanup(() => style.remove());
  const c = await mk(t, i, { inner: '<div id="a" drawable style="width:100px;height:50px;background:rgb(0,0,255);color:rgb(0,0,255);font:20px/20px sans-serif"><span id="g">hello</span></div>' });
  const sel = /** @type {Selection} */ (getSelection());
  t.cleanup(() => sel.removeAllRanges());
  c.onpaint = () => /** @type {any} */ (c.getContext('2d')).drawElementImage(c.querySelector('#a'), 0, 0);
  sel.selectAllChildren(c);
  await sleep(500);
  const px = Array.from(/** @type {CanvasRenderingContext2D} */ (c.getContext('2d')).getImageData(2, 10, 1, 1).data);
  assert.deepEqual(px, [0, 255, 0, 255], 'the selection background');
});

test('positive control: an unmanaged canvas and other nodes are passed through unchanged (a canvas without content=drawable keeps its own children)', async (t) => {
  inst(t);
  const host = document.createElement('div');
  host.innerHTML = '<canvas>fallback</canvas><p>text</p>';
  document.body.append(host);
  t.cleanup(() => host.remove());
  const range = document.createRange();
  range.selectNodeContents(/** @type {Node} */ (host.querySelector('canvas')));
  assert.equal(range.startContainer, host.querySelector('canvas'));
  assert.equal(range.toString(), 'fallback');
  range.selectNodeContents(/** @type {Node} */ (host.querySelector('p')));
  assert.equal(range.toString(), 'text');
});
