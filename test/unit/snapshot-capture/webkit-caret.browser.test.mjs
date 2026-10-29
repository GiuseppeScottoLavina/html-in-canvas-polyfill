// Safari's caret colour (src/snapshot/capture/webkit-caret.js): the declarations read from the live page, on the cases measured on Safari 27.0.1 (macOS).
// accentCaretOf is engine-independent (it reads declarations only), so it runs here in Chrome; webkitCaretColor itself answers only on macOS WebKit.
import { test, assert, fixture } from '/test/unit/lib/t.js';
import { accentCaretOf, webkitCaretColor } from '/src/snapshot/capture/webkit-caret.js';
import { measureCaret } from '/src/snapshot/capture/caret-overlay.js';
import { engineSkins, registerEngineSkins } from '/src/snapshot/capture/engine-skins.js';

const STYLE = '.mag{color:rgb(200,0,200)} .wrap input{color:rgb(200,0,200)} .ruled{color:rgb(0,0,0)} .cc{caret-color:rgb(0,160,0)} .ccauto{caret-color:auto}'
  + ' @media (min-width: 1px) { .mq{color:rgb(1,2,3)} } @media (max-width: 1px) { .nomq{color:rgb(1,2,3)} }';
const HTML = `
  <input id="a"> <input id="b" style="accent-color:rgb(255,0,0)"> <input id="d" style="caret-color:rgb(0,160,0)"> <input id="e" style="color:rgb(200,0,200)">
  <input id="f" style="caret-color:currentcolor"> <input id="g" style="color:rgb(0,0,0)"> <input id="i" class="ruled">
  <div style="color:rgb(200,0,200)"><input id="h" style="color:inherit"></div> <input id="j" style="color-scheme:dark"> <textarea id="k"></textarea>
  <div id="l" contenteditable>x</div> <div style="color:rgb(200,0,200)"><div id="m" contenteditable>x</div></div>
  <div style="color:rgb(200,0,200)"><input id="n"></div> <div class="mag"><div id="o" contenteditable>x</div></div> <div class="wrap"><input id="p"></div>
  <div class="cc"><input id="q" class="ccauto"></div> <div class="cc"><input id="r"></div> <a href="#x"><span id="s" contenteditable>x</span></a>
  <div class="mq"><div id="t" contenteditable>x</div></div> <div class="nomq"><div id="u" contenteditable>x</div></div>`;
// Safari 27.0.1: accent (true) or the computed colour (false)
const MEASURED = { a: true, b: true, d: false, e: false, f: false, g: false, i: false, h: false, j: true, k: true, l: true, m: false, n: true, o: false, p: false, q: true, r: false, s: true };

test('accentCaretOf follows every measured Safari case (accent for auto unless an author colour or caret-color applies)', () => {
  const root = fixture(`<style>${STYLE}</style>${HTML}`);
  for (const [id, want] of Object.entries(MEASURED)) {
    const el = root.querySelector('#' + id);
    assert.equal(accentCaretOf(el, getComputedStyle(el)), want, `#${id}`);
  }
});

test('rules inside a matching @media count, those of a failing one do not (positive control of the media evaluation)', () => {
  const root = fixture(`<style>${STYLE}</style>${HTML}`);
  assert.equal(accentCaretOf(root.querySelector('#t'), getComputedStyle(root.querySelector('#t'))), false);
  assert.equal(accentCaretOf(root.querySelector('#u'), getComputedStyle(root.querySelector('#u'))), true);
});

test('a rule added later is seen (the rule cache follows the rule count)', () => {
  const root = fixture('<div id="v" class="late" contenteditable>x</div>');
  const v = root.querySelector('#v');
  assert.equal(accentCaretOf(v, getComputedStyle(v)), true);
  const style = document.createElement('style');
  document.head.append(style);
  style.sheet.insertRule('.late{color:rgb(9,9,9)}');
  try { assert.equal(accentCaretOf(v, getComputedStyle(v)), false); } finally { style.remove(); }
});

test('webkitCaretColor answers only on macOS WebKit (Chrome here: null), and measureCaret paints the colour EngineSkins.caretColor gives', () => {
  const root = fixture('<input id="w">');
  const w = root.querySelector('#w');
  w.focus();
  assert.equal(webkitCaretColor(document, w, getComputedStyle(w)), null);
  const box = { x: 0, y: 0, width: w.offsetWidth, height: w.offsetHeight };
  const before = engineSkins();
  registerEngineSkins({ ...(before ?? {}), caretColor: () => 'rgb(1, 2, 3)' });
  try { assert.equal(measureCaret(document, w, box)?.color, 'rgb(1, 2, 3)'); } finally { registerEngineSkins(before); }
  assert.equal(measureCaret(document, w, box)?.color, 'rgb(0, 0, 0)', 'without it: the computed colour');
});
