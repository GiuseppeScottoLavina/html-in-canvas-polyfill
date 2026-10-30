import { test, assert, fixture, frames } from '/test/unit/lib/t.js';
import { boxScale, layoutSize } from '/src/util/box-scale.js';
import { setup, page } from '/test/unit/live/lib.mjs';

// A fractional border box (Chrome for Android lays a size-3 listbox out 52.524 css px high at DPR 2.625; a css height reproduces it at any DPR): offsetHeight is rounded,
// so offsetHeight / rect height is not 1 although nothing is transformed. The scale the polyfill uses must come from fractional sizes.

test('boxScale is exactly 1 on an untransformed box of fractional size, where the rounded offset size is not (positive control)', () => {
  const root = fixture('<div id="a" style="width:120.6px;height:52.6px"></div>');
  const a = root.querySelector('#a');
  const r = a.getBoundingClientRect();
  assert.ok(Math.abs(r.height - 52.6) < 0.02 && a.offsetHeight === 53, `precondition: fractional box ${r.height}, offsetHeight ${a.offsetHeight}`);
  assert.ok(Math.abs(a.offsetHeight / r.height - 1) > 5e-3 && Math.abs(a.offsetWidth / r.width - 1) > 2e-3, 'control: the rounded idiom reads a scale that is not there');
  assert.deepEqual(boxScale(a), { x: 1, y: 1 });
  const l = layoutSize(a);
  assert.ok(Math.abs(l.width - 120.6) < 1 / 64 && Math.abs(l.height - 52.6) < 1 / 64, `the layout size is fractional (1/64 px grid): ${JSON.stringify(l)}`);
});

test('boxScale reads the transform on the element and its ancestors, per axis; 1 for a box without size', () => {
  const root = fixture('<div style="transform:scale(1.5, 0.5);transform-origin:0 0"><div id="a" style="width:52.6px;height:30.3px;padding:2px;border:1px solid"></div><span id="i">inline</span><div id="z" style="width:0;height:0"></div></div>');
  const s = boxScale(root.querySelector('#a'));
  assert.ok(Math.abs(s.x - 1.5) < 1e-4 && Math.abs(s.y - 0.5) < 1e-4, JSON.stringify(s));
  const i = boxScale(root.querySelector('#i'));
  assert.ok(Math.abs(i.x - 1.5) < 0.05, `inline box: the offset size fallback ${JSON.stringify(i)}`);
  assert.deepEqual(boxScale(root.querySelector('#z')), { x: 1, y: 1 });
});

const OPTS = Array.from({ length: 20 }, (_, i) => `<option${i === 17 ? ' selected' : ''}>Option ${i + 1}</option>`).join('');
const LISTBOX = `<select size="3" style="height:52.6px">${OPTS}</select>`;

test('a listbox select of fractional height moved from the canvas is scrolled to its selected option exactly as the engine scrolls the same select (positive control: the rounded scale)', async (t) => {
  const twinRoot = fixture(LISTBOX);
  const twin = twinRoot.querySelector('select');
  await frames(2);
  assert.ok(twin.scrollTop > 200, `precondition: the engine scrolled its own select to the 18th option (${twin.scrollTop})`);
  const { managed } = setup({ t });
  const { root, canvas } = page(`<div drawable>${LISTBOX}</div>`);
  const sel = root.querySelector('select');
  assert.equal(sel.scrollTop, 0, 'precondition: fallback content has no box');
  managed(canvas);
  const r = sel.getBoundingClientRect();
  assert.ok(sel.offsetHeight !== r.height, `precondition: a fractional box (${r.height}, offsetHeight ${sel.offsetHeight})`);
  assert.ok(Math.abs(sel.scrollTop - twin.scrollTop) < 0.01, `polyfill ${sel.scrollTop} vs engine ${twin.scrollTop}`);
  // control: the scroll the rounded idiom (offsetHeight / rect height) asks for is off by more than a css px here
  const o = sel.options[17].getBoundingClientRect();
  const rounded = (o.bottom - r.top + sel.scrollTop) * (sel.offsetHeight / r.height) - sel.clientTop - sel.clientHeight; // its option bottom at scroll 0, as mount measured it
  assert.ok(Math.abs(rounded - twin.scrollTop) > 1, `control: the rounded scale asks for ${rounded} against the engine's ${twin.scrollTop}`);
});
