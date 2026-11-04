// Safari's caret colour (src/snapshot/capture/webkit-caret.js): the declarations read from the live page, on the cases measured on Safari 27.0.1 (macOS).
// accentCaretOf is engine-independent (it reads declarations only), so it runs here in Chrome; webkitCaretColor itself answers only on macOS WebKit.
import { test, assert, fixture } from '/test/unit/lib/t.js';
import { accentCaretOf, resetCaretRules, webkitCaretColor } from '/src/snapshot/capture/webkit-caret.js';
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

test('CSSOM edits that keep the rule count are seen after resetCaretRules (setProperty, delete + insert, replaceSync); without it the cache answers as before (control)', () => {
  const root = fixture('<div id="x1" class="e1" contenteditable>x</div><div id="x2" class="e2" contenteditable>x</div><div id="x3" class="e3" contenteditable>x</div>');
  const ask = (/** @type {string} */ id) => { const el = root.querySelector('#' + id); return accentCaretOf(el, getComputedStyle(el)); };
  const style = document.createElement('style');
  style.textContent = '.e1{background:white} .e2{background:white}';
  document.head.append(style);
  const sheet = new CSSStyleSheet();
  sheet.replaceSync('.e3{background:white}');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  try {
    assert.deepEqual([ask('x1'), ask('x2'), ask('x3')], [true, true, true], 'no author colour: the accent');
    /** @type {CSSStyleRule} */ (style.sheet.cssRules[0]).style.setProperty('color', 'rgb(9, 9, 9)');
    style.sheet.deleteRule(1);
    style.sheet.insertRule('.e2{color:rgb(9, 9, 9)}', 1);
    sheet.replaceSync('.e3{color:rgb(9, 9, 9)}');
    assert.deepEqual([ask('x1'), ask('x2'), ask('x3')], [true, true, true], 'control: the rule count did not change, the cache still answers the old rules');
    resetCaretRules();
    assert.deepEqual([ask('x1'), ask('x2'), ask('x3')], [false, false, false], 'after the reset the author colours count');
  } finally {
    style.remove();
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
  }
});

test('a media condition that changes its result rebuilds the rule list without a reset (prefers-color-scheme, a viewport query: matchMedia answers)', () => {
  // the page cannot change its own viewport or colour scheme here: matchMedia answers a query of its own (the module reads only matchMedia(q).matches)
  const Q = '(min-width: 1.23456px)';
  const mql = { matches: true };
  const real = window.matchMedia;
  window.matchMedia = /** @type {any} */ ((/** @type {string} */ q) => (q === Q ? mql : real.call(window, q)));
  const style = document.createElement('style');
  style.textContent = `@media ${Q} { .w1 { color: rgb(9, 9, 9) } }`;
  document.head.append(style);
  try {
    const root = fixture('<div id="y" class="w1" contenteditable>x</div>');
    const y = root.querySelector('#y');
    const ask = () => accentCaretOf(y, getComputedStyle(y));
    assert.equal(ask(), false, 'the query matches: the rule applies (author colour)');
    mql.matches = false;
    assert.equal(ask(), true, 'it no longer matches: the accent');
    mql.matches = true;
    assert.equal(ask(), false, 'matches again');
  } finally {
    window.matchMedia = real;
    style.remove();
  }
});

test('the core\'s stylesheet damage reaches EngineSkins.stylesChanged (a real install, an inserted rule)', async (t) => {
  const { inst } = await import('../api-core/_real.mjs');
  const before = engineSkins();
  let calls = 0;
  registerEngineSkins({ ...(before ?? {}), stylesChanged: () => { calls++; } });
  t.cleanup(() => registerEngineSkins(before));
  const i = inst(t);
  const host = fixture('<canvas content="drawable" width="50" height="20"><div drawable style="width:50px;height:20px">x</div></canvas>');
  const canvas = /** @type {HTMLCanvasElement} */ (host.querySelector('canvas'));
  canvas.onpaint = () => {};
  canvas.requestPaint();
  await i.whenPainted(canvas);
  const style = document.createElement('style');
  document.head.append(style);
  t.cleanup(() => style.remove());
  await new Promise((r) => setTimeout(r, 50));
  const n0 = calls;
  style.sheet.insertRule('.zz{color:red}');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(calls > n0, `stylesChanged was called (${n0} -> ${calls})`);
});
