// Walk parity of edge cases the pages do not cover (helpers and the comparison: _walk-parity.mjs).
import { test, assert, frames } from '/test/unit/lib/t.js';
import { appendInlineStyle } from '/src/snapshot/capture/inline-style.js';
import { createTokenCollector } from '/src/snapshot/capture/css-shake.js';
import { cloneDrawable } from '/src/snapshot/capture/clone.js';
import { flushGeometryWrites } from '/src/live/geometry-apply.js';
import { checkCase, mismatch, mountCase, outcome } from './_walk-parity.mjs';
import { cloneDrawable as releasedWalk } from './reference/clone-0.1.0.js';
import { appendInlineStyle as releasedAppend } from './reference/inline-style-0.1.0.js';
import { cleanAttributes } from '/src/snapshot/capture/state-sync.js';
import { cleanAttributes as releasedClean } from './reference/clean-attributes-0.1.0.js';
import { createTokenCollector as releasedTokens } from './reference/tokens-0.1.0.js';

const rows = (n, cls = 'row') => Array.from({ length: n }, (_, i) => `<li class="${cls}"><b>Name ${i % 8}</b><span>#${i + 1} Quarterly numbers and notes</span></li>`).join('');

/** Edge cases the pages do not cover. */
const EDGES = {
  'scroll lab: long list in a scroller, sticky header, rounded, counter, form': {
    css: `#app{box-sizing:border-box;width:600px;height:400px;display:grid;grid-template-columns:260px 1fr;gap:12px;padding:12px;font:14px/1.4 sans-serif;background:#123;color:#eef}
      #list{min-height:0;overflow-y:auto;border:1px solid #9ab;background:#fbfcfe;color:#123;border-radius:10px}#list header{position:sticky;top:0;z-index:1;padding:8px;background:#e6ecf7}
      #list ol{margin:0;padding:0;list-style:none}#list li{display:flex;gap:10px;padding:6px 10px;border-bottom:1px solid #e6eaf2}#counter{font:700 30px/1 monospace}
      .cards{display:flex;flex-wrap:wrap;gap:8px}.card{flex:1 1 90px;min-height:50px;padding:8px;border-radius:10px;background:linear-gradient(135deg,#2f6df6,#7a4ff0)}`,
    inner: `<div id="app" drawable><section id="list"><header>Inbox (300)</header><ol>${rows(300)}</ol></section><section><h2>Lab</h2><div>Ticks: <span id="counter">42</span></div>
      <label>Name <input id="name" value="Ada Lovelace"></label><textarea id="msg">A message that is long enough to wrap and scroll inside its own box
      line two
      line three
      line four
      line five</textarea><div class="cards"><div class="card"><b>12</b> open</div><div class="card"><b>3.4k</b> visitors</div><div class="card">98%</div></div></section></div>`,
  },
  'striped list (sibling selectors) and counters': {
    css: `.l{width:300px;height:380px;overflow:auto;font:12px sans-serif}.l li{height:22px}.l li:nth-child(even){background:#ddf}.l ol{counter-reset:k}.l ol li{counter-increment:k}
      .l ol li::before{content:counter(k) ". "}.l .blk>div{height:18px;border-bottom:1px solid #ccc}`,
    inner: `<div class="l" drawable id="s"><ol>${rows(120, 'r')}</ol><div class="blk">${Array.from({ length: 80 }, (_, i) => `<div>block ${i}</div>`).join('')}</div></div>`,
  },
  'transforms, sticky, absolute, fixed, nested scrollers, overflow clip and hidden': {
    css: `#t{position:relative;width:560px;height:380px;overflow:hidden;font:13px sans-serif}.rot{transform:rotate(7deg);width:120px;height:40px;background:#fc0}
      .tr{translate:10px 4px;scale:1.1;rotate:2deg;width:100px;height:30px;background:#0cf}.abs{position:absolute;right:8px;top:30px;width:60px;height:60px;background:#c0f}
      .fix{position:fixed;left:0;bottom:0;width:30px;height:30px;background:#f00}.outer{height:160px;overflow:auto;border:2px solid #333;border-radius:12px}
      .outer .inner{height:80px;overflow:scroll;margin:6px}.outer .inner div,.outer>div{height:24px}.clip{overflow:clip;height:40px;width:200px}.clip p{margin:0;height:20px}
      .hid{overflow:hidden;height:50px}.hid div{height:30px}.half{width:100.5px;border:0.5px solid #000;overflow:clip;height:20.25px}.st{position:sticky;top:0;background:#eee}`,
    inner: `<div id="t" drawable><div class="rot">rotated</div><div class="tr">translated</div><div class="abs">abs</div><div class="fix">fix</div>
      <div class="outer"><div class="st">sticky</div><div class="inner">${Array.from({ length: 12 }, (_, i) => `<div>inner ${i}</div>`).join('')}</div>${Array.from({ length: 30 }, (_, i) => `<div>outer ${i}</div>`).join('')}</div>
      <div class="clip">${Array.from({ length: 6 }, (_, i) => `<p>clipped ${i}</p>`).join('')}</div><div class="hid" id="h">${Array.from({ length: 6 }, (_, i) => `<div>hidden ${i}</div>`).join('')}</div>
      <div class="half"><div style="height:60px">fractional</div></div><div style="height:30px"><div style="height:90px;width:900px">overflowing visible box</div></div></div>`,
  },
  'shadow DOM with slots, display contents, hidden subtrees, nested drawable, table, inline rows': {
    css: `#sh{width:560px;height:380px;overflow:auto;font:13px sans-serif}.dc{display:contents}.none{display:none}.tbl td{padding:2px 6px}.inl span{display:inline-block;width:18px;height:14px;margin:1px;background:#9cf}
      #nested{width:120px;height:40px;background:#efe}`,
    inner: `<div id="sh" drawable><x-card id="host"><span slot="title">Slotted title</span><p>slotted body</p></x-card><div class="dc"><p>in contents</p><p>more</p></div>
      <div class="none"><p>under display none</p><div style="height:400px;overflow:auto"><div style="height:900px">x</div></div></div><div hidden><p>hidden attr</p></div><p style="display:none">inline none</p>
      <div id="nested" drawable>nested drawable</div><table class="tbl">${Array.from({ length: 40 }, (_, i) => `<tr><td>${i}</td><td>cell ${i}</td><td><input value="v${i}"></td></tr>`).join('')}</table>
      <div class="inl">${Array.from({ length: 200 }, (_, i) => `<span>${i % 10}</span>`).join('')}</div>${Array.from({ length: 60 }, (_, i) => `<p>paragraph ${i} lorem ipsum dolor sit amet</p>`).join('')}</div>`,
    flags: [[true, true, true], [false, false, true]],
    setup(root) {
      const host = root.querySelector('#host');
      const sr = host.attachShadow({ mode: 'open' });
      sr.innerHTML = `<style>.box{border:1px solid #888;border-radius:8px;padding:4px}.list{height:80px;overflow:auto}.list div{height:16px}</style><div class="box"><slot name="title"></slot><slot></slot>
        <div class="list">${Array.from({ length: 60 }, (_, i) => `<div>shadow row ${i}</div>`).join('')}</div></div>`;
    },
  },
  'forms: scrolled inputs, textarea, listbox, checkbox, range, select, contenteditable': {
    css: `#f{width:560px;height:380px;font:13px sans-serif;display:grid;gap:6px;padding:6px}input,textarea,select{font:inherit}`,
    inner: `<form id="f" drawable><input id="long" value="a long value that is wider than the field so its text scrolls inside the box"><textarea rows="2">one
two
three
four
five</textarea><select size="3"><option>A</option><option>B</option><option>C</option><option>D</option><option selected>E</option><option>F</option></select>
      <select><option>menu</option></select><label><input type="checkbox" checked> check</label><input type="range" value="30"><div contenteditable>editable text</div><button>Go</button></form>`,
    setup(root) {
      const long = /** @type {HTMLInputElement} */ (root.querySelector('#long'));
      long.scrollLeft = 60;
    },
  },
};

for (const [name, spec] of Object.entries(EDGES)) {
  test(`walk parity: ${name}`, async (t) => { await checkCase(t, spec); }, { timeout: 60000 });
}


test('appendInlineStyle writes what the released writer wrote', () => {
  const doc = document.implementation.createHTMLDocument('');
  for (const [own, add] of [['', 'width:1px'], ['color: red', 'width:1px!important'], ['color: red;', 'height:2px'], ['color: red ; ', 'a:b'], ['--x: 1px', 'width:var(--x)'], ['', '']]) {
    const a = doc.createElement('div'); const b = doc.createElement('div');
    a.style.cssText = own; b.style.cssText = own;
    appendInlineStyle(a, add); releasedAppend(b, add);
    assert.equal(a.getAttribute('style'), b.getAttribute('style'), `${own} + ${add}`);
  }
});

test('the token collector collects what the released collector collected (repeated class and style values are skipped, not lost)', () => {
  const doc = document.implementation.createHTMLDocument('');
  const host = doc.createElement('div');
  host.innerHTML = '<p class="a b" style="font-family: X; color: var(--c)"></p><p class="a b"></p><p class=" b  c " id="i" data-x="1"></p><svg><foreignObject class="a"></foreignObject></svg>'
    + '<span style="font: 12px Y; width: var(--w)"></span><span style="font-family: X; color: var(--c)"></span><i class="d"></i><i class="a b"></i>';
  const twin = doc.createElement('b'); // a namespaced attribute with the qualified name `class` (or `style`) beside the plain one: both values count
  twin.setAttribute('class', 'e'); twin.setAttributeNS('urn:x', 'class', 'ns-only'); twin.setAttributeNS('urn:x', 'style', 'font-family: Z');
  host.append(twin);
  const now = createTokenCollector(); const before = releasedTokens();
  for (const el of host.querySelectorAll('*')) { now.add(el); before.add(el); }
  const pick = (/** @type {any} */ t) => JSON.stringify({ c: [...t.classes].sort(), i: [...t.ids].sort(), t: [...t.tags].sort(), f: [...t.fonts].sort(), v: [...t.vars].sort(), a: t.hasAttributeSelectorNeed, s: t.signature });
  const a = now.finish(); const b = before.finish();
  assert.equal(pick(a), pick(b));
  assert.equal([...a.classes].sort().join(' '), 'a b c d e ns-only', `positive control: the classes of every element are there (${[...a.classes].sort().join(' ')})`);
  assert.ok(a.fonts.has('z'), 'and the font of the namespaced style');
  assert.deepEqual([...a.vars].sort(), ['--c', '--w']);
});

const LAB = EDGES['scroll lab: long list in a scroller, sticky header, rounded, counter, form'];

test('the parity comparison sees a one-pixel change of a scroll offset or of a row (positive control of the comparison)', async (t) => {
  const c = mountCase(t, LAB);
  await frames(2);
  const el = c.layer.drawableElements()[0];
  const list = /** @type {HTMLElement} */ (c.root.querySelector('#list'));
  const row = /** @type {HTMLElement} */ (c.root.querySelector('#list li:nth-child(40)'));
  list.scrollTop = 300;
  const req = c.request(el, { rect: { x: 0, y: 150, width: 600, height: 60 }, prune: true });
  assert.equal(mismatch(c.env, req, [true, true, true]), null, 'the same state builds the same snapshot');
  const nudged = (/** @type {() => void} */ change, /** @type {() => void} */ undo) => (/** @type {any[]} */ ...a) => { change(); try { return cloneDrawable(...a); } finally { undo(); } };
  assert.ok(mismatch(c.env, req, [true, true, true], nudged(() => { list.scrollTop += 1; }, () => { list.scrollTop -= 1; })), 'a scroll offset 1 px away is seen');
  assert.ok(mismatch(c.env, req, [true, true, true], nudged(() => { row.style.height = '31px'; }, () => { row.style.height = ''; })), 'a row 1 px taller is seen');
});

test('a pruned build measures the drawable a fixed number of times and reads scroll metrics only of boxes that can scroll (the released walk did both per element)', async (t) => {
  const c = mountCase(t, LAB);
  await frames(2);
  const el = c.layer.drawableElements()[0];
  /** @type {HTMLElement} */ (c.root.querySelector('#list')).scrollTop = 1200;
  const proto = Element.prototype;
  const rect = proto.getBoundingClientRect;
  const top = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(proto, 'scrollTop'));
  let drawable = 0, scroll = 0;
  proto.getBoundingClientRect = function () { if (this === el) drawable++; return rect.call(this); };
  Object.defineProperty(proto, 'scrollTop', { ...top, get() { scroll++; return /** @type {any} */ (top.get).call(this); } });
  t.cleanup(() => { proto.getBoundingClientRect = rect; Object.defineProperty(proto, 'scrollTop', top); });
  const req = c.request(el, { rect: { x: 0, y: 150, width: 600, height: 60 }, prune: true });
  const count = (/** @type {any} */ walk) => { drawable = 0; scroll = 0; walk(c.env, req, document.implementation.createHTMLDocument(''), true, true, true); return { drawable, scroll }; };
  const before = count(releasedWalk), now = count(cloneDrawable);
  assert.ok(before.drawable > 30, `positive control: the released walk measured the drawable per row (${before.drawable})`);
  assert.ok(now.drawable <= 5, `the current walk measures it a fixed number of times per build: size, layout offset, frame measurer (${now.drawable})`);
  assert.ok(before.scroll > 15, `positive control: the released walk read scrollTop of every cloned element (${before.scroll})`);
  assert.ok(now.scroll * 4 < before.scroll, `the current walk reads it of the scroll containers and fields only (${now.scroll} vs ${before.scroll})`);
  assert.equal(mismatch(c.env, req, [true, true, true]), null, 'and builds the same snapshot');
});

test('nothing the walk measures outlives a build: mutation, resize, style change, font load, scroll, scaled ancestor and applied geometry between two builds are all seen', async (t) => {
  const c = mountCase(t, LAB);
  await frames(2);
  const el = /** @type {HTMLElement} */ (c.layer.drawableElements()[0]);
  const list = /** @type {HTMLElement} */ (c.root.querySelector('#list'));
  list.scrollTop = 500;
  const req = () => c.request(el, { rect: { x: 0, y: 120, width: 600, height: 80 }, prune: true });
  const face = new FontFace('HicParityFont', 'local("Courier New"), local("Courier"), local("Menlo"), local("DejaVu Sans Mono"), local("Liberation Mono"), local("Noto Sans Mono")');
  const steps = /** @type {Array<[string, () => void | Promise<void>]>} */ ([
    ['mutation: a row inserted at the top', () => { list.querySelector('ol')?.prepend(Object.assign(document.createElement('li'), { textContent: 'new first row' })); }],
    ['resize: the drawable narrower', () => { el.style.width = '540px'; }],
    ['style change: taller rows', () => { list.classList.add('tall'); el.insertAdjacentHTML('afterbegin', '<style>#list.tall li{padding:11px 10px}</style>'); }],
    ['font load: the list switches to a font that loads', async () => { list.style.fontFamily = 'HicParityFont, serif'; document.fonts.add(face); await face.load(); }],
    ['scroll', () => { list.scrollTop = 733; }],
    ['scaled ancestor', () => { /** @type {HTMLElement} */ (c.root.querySelector('.parity-wrap')).style.transform = 'scale(0.8)'; }],
    ['applied geometry', () => { c.layer.setHitTestOrder([el]); c.layer.applyGeometry(el, { transform: new DOMMatrix().scale(1.25), clip: null }, null); flushGeometryWrites(); }],
  ]);
  t.cleanup(() => { document.fonts.delete(face); });
  let previous = outcome(cloneDrawable, c.env, req(), document.implementation.createHTMLDocument(''), [true, true, true]);
  const rowRect = () => JSON.stringify(list.querySelector('li')?.getBoundingClientRect());
  for (const [name, change] of steps) {
    const before = rowRect();
    await change();
    await frames(1);
    const r = req();
    const now = outcome(cloneDrawable, c.env, r, document.implementation.createHTMLDocument(''), [true, true, true]);
    // a scaled ancestor and an applied geometry transform change every client rect the walk reads but not the snapshot: frame rects are in the drawable's own css px,
    // and the stand-ins' lengths are put on the live layout grid (clone.js onLiveGrid), so the float noise of dividing by the scale (which alone made these snapshots
    // differ) is gone. Their positive control is that the measured input changed; a walk that kept the old scale would write every stand-in 0.8 or 1.25 times its
    // length, which the comparison with the released walk below catches.
    if (name === 'scaled ancestor' || name === 'applied geometry') assert.notEqual(rowRect(), before, `positive control: ${name} changes the client rects the walk measures`);
    else assert.notEqual(now, previous, `positive control: ${name} changes the snapshot`);
    assert.equal(mismatch(c.env, r, [true, true, true]), null, `${name}: the same snapshot as the released walk`);
    previous = now;
  }
});

test('cleanAttributes keeps and drops what the released version kept and dropped, namespaced look-alikes included', () => {
  const doc = document.implementation.createHTMLDocument('');
  const make = () => {
    const out = [];
    const host = doc.createElement('div');
    host.innerHTML = '<p class="a" id="i" data-x="1" style="color:red"></p><p onclick="x()" autofocus data-hic-hit="" data-hic-sp="" title="t"></p><button onmouseover="1" disabled>b</button>'
      + '<svg><use xlink:href="#a" href="#b"></use></svg><input autofocus value="v">';
    out.push(...host.querySelectorAll('*'));
    const odd = doc.createElement('div'); // a namespaced attribute whose qualified name equals one that is dropped, before and after it
    odd.setAttributeNS('urn:x', 'onclick', 'ns'); odd.setAttribute('foo', '1'); odd.setAttributeNS(null, 'onclick', 'plain'); odd.setAttributeNS('urn:y', 'p:data-hic-hit', 'ns2'); odd.setAttribute('@click', 'v');
    const odd2 = doc.createElement('div');
    odd2.setAttribute('onclick', 'plain'); odd2.setAttributeNS('urn:x', 'onclick', 'ns'); odd2.setAttribute('data-hic-root', '');
    out.push(odd, odd2);
    return out;
  };
  const a = make(), b = make();
  assert.equal(a[a.length - 2].getAttributeNames().filter((n) => n === 'onclick').length, 2, 'the look-alike case has two attributes named onclick');
  assert.equal(a[a.length - 1].getAttributeNames().filter((n) => n === 'onclick').length, 2, 'in both orders');
  a.forEach((el) => cleanAttributes(el)); b.forEach((el) => releasedClean(el));
  const dump = (/** @type {Element[]} */ els) => els.map((el) => [...el.attributes].map((x) => `${x.namespaceURI ?? ''}|${x.name}=${x.value}`).join(' ')).join('\n');
  assert.equal(dump(a), dump(b));
  assert.ok(!dump(a).includes('onmouseover') && !dump(a).includes('|autofocus') && !dump(a).includes('|data-hic-hit') && dump(a).includes('|data-hic-sp'), 'positive control: handlers, autofocus and polyfill markers are dropped, the spacer marker is kept');
});
