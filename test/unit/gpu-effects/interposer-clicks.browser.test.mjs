// The clicks of a re-targeted gesture (src/effects/click-guard.js) with a hand-made mapper chain: the native click and dblclick that Chrome fires at the
// element it hit are seen by no listener of the page, and the element drawn under the pointer gets one click, also when it is not a control.
// The native events are modelled as Chrome fires them after a cancelled pointerdown (trusted input on Chrome 157: pointerdown, pointerup, click, and a
// dblclick after the second click; no mousedown or mouseup); the trusted-input check against Chrome's own implementation is gate G-interposer-clicks.
// Found by a library built on the polyfill: a mapper that sends a click on a paragraph to a drawn button delivered the button's click AND the paragraph's.
import { test, assert } from '/test/unit/lib/t.js';
import { makeRig } from './lib/rig.mjs';
import { createInterposer } from '/src/effects/interposer.js';
import { createMapperChain } from '/src/effects/input-mapper.js';

/** B is where the browser hits (left), A where the mapper sends every point (right). */
const AT = 'position:absolute;margin:0;box-sizing:border-box;width:100px;height:40px';
const LAYOUTS = {
  'button-button': `<button id="A" style="${AT};left:300px;top:200px">A</button><button id="B" style="${AT};left:40px;top:40px">B</button>`,
  'div-p': `<div id="A" style="${AT};left:300px;top:200px">A</div><p id="B" style="${AT};left:40px;top:40px">B</p>`,
  'button-form': `<button id="A" type="button" style="${AT};left:300px;top:200px">A</button><form id="B" style="${AT};left:40px;top:40px">B</form>`,
  'p-button': `<p id="A" style="${AT};left:300px;top:200px">A</p><button id="B" style="${AT};left:40px;top:40px">B</button>`,
  'span-in-button': `<button id="AB" style="${AT};left:300px;top:200px"><span id="A" style="display:block;width:100%;height:100%">A</span></button><p id="B" style="${AT};left:40px;top:40px">B</p>`,
  'summary-p': `<details id="D" style="position:absolute;margin:0;left:300px;top:200px;width:150px"><summary id="A" style="height:40px">A</summary>body</details><p id="B" style="${AT};left:40px;top:40px">B</p>`,
  'label-p': `<label id="A" for="K" style="${AT};left:300px;top:200px">A</label><input id="K" type="checkbox" style="position:absolute;margin:0;left:420px;top:10px"><p id="B" style="${AT};left:40px;top:40px">B</p>`,
  'disabled-p': `<button id="A" disabled style="${AT};left:300px;top:200px">A</button><p id="B" style="${AT};left:40px;top:40px">B</p>`,
  'same-p': `<p id="B" style="${AT};left:40px;top:40px;width:300px">B, wide</p>`,
};
const TO_A = () => ({ x: 340, y: 220 });
const OVER_B = [60, 60];

/** @param {any} t @param {keyof typeof LAYOUTS} layout @param {(p: any) => {x: number, y: number}} [mapper] */
function setup(t, layout, mapper = TO_A) {
  const rig = makeRig({ w: 480, h: 320, html: LAYOUTS[layout] });
  const chain = createMapperChain();
  chain.push(1, [mapper]);
  const ip = createInterposer(rig.env, rig.record, chain, rig.tracker);
  t.cleanup(() => ip.dispose());
  /** every click and dblclick, as `${phase}:${type}@${target}` */
  const log = [];
  const name = (/** @type {any} */ e) => e.target.id || e.target.localName;
  const docCapture = (/** @type {Event} */ e) => log.push(`doc-capture:${e.type}@${name(e)}`);
  for (const type of ['click', 'dblclick']) {
    document.addEventListener(type, docCapture, true);
    t.cleanup(() => document.removeEventListener(type, docCapture, true));
    for (const el of rig.layerEl.querySelectorAll('[id]')) el.addEventListener(type, (e) => { if (e.currentTarget === e.target || el.id === 'AB' || el.id === 'D') log.push(`at-${el.id}:${type}@${name(e)}`); });
  }
  const r = rig.canvas.getBoundingClientRect();
  /** a native event at (x, y) of the canvas, at the element the browser hits there */
  const fire = (/** @type {string} */ type, /** @type {number} */ x, /** @type {number} */ y, detail = 1) => {
    const cx = r.left + x, cy = r.top + y;
    const target = document.elementFromPoint(cx, cy) ?? rig.layerEl;
    const base = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy };
    const ev = type === 'click' || type === 'dblclick'
      ? new MouseEvent(type, { ...base, detail })
      : new PointerEvent(type, { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: type === 'pointermove' ? -1 : 0 });
    target.dispatchEvent(ev);
    return { target, ev };
  };
  /** Chrome's sequence for one pointer click (after a cancelled pointerdown: no mousedown, no mouseup) */
  const click = (x = OVER_B[0], y = OVER_B[1], detail = 1) => { fire('pointermove', x, y); const d = fire('pointerdown', x, y); fire('pointerup', x, y); fire('click', x, y, detail); return d; };
  const el = (/** @type {string} */ id) => /** @type {HTMLElement} */ (rig.layerEl.querySelector(`#${id}`));
  return { rig, ip, log, fire, click, el };
}

for (const layout of /** @type {const} */ (['button-button', 'div-p', 'button-form', 'p-button'])) {
  test(`${layout}: a click over B that the mapper sends to A clicks A once; no listener sees a click on B, not even a capture listener on the document`, (t) => {
    const s = setup(t, layout);
    const d = s.click();
    assert.equal(d.target.id, 'B', 'the browser hits B');
    assert.equal(d.ev.defaultPrevented, true, 'the press is re-targeted');
    assert.deepEqual(s.log, ['doc-capture:click@A', 'at-A:click@A']);
  });
}

test('the click goes to the element drawn under the pointer, inside its control: a span in a button (as natively), and the button activates', (t) => {
  const s = setup(t, 'span-in-button');
  s.click();
  assert.deepEqual(s.log, ['doc-capture:click@A', 'at-A:click@A', 'at-AB:click@A']);
});

test('a drawn summary toggles its details once; a drawn label checks its checkbox once; B sees nothing', (t) => {
  let s = setup(t, 'summary-p');
  s.click();
  assert.equal(/** @type {HTMLDetailsElement} */ (s.el('D')).open, true);
  assert.deepEqual(s.log, ['doc-capture:click@A', 'at-A:click@A', 'at-D:click@A']);
  s = setup(t, 'label-p');
  s.click();
  assert.equal(/** @type {HTMLInputElement} */ (s.el('K')).checked, true);
  assert.deepEqual(s.log, ['doc-capture:click@A', 'at-A:click@A', 'doc-capture:click@K', 'at-K:click@K']);
});

test('a drawn disabled button gets no click (as natively), and B none either', (t) => {
  const s = setup(t, 'disabled-p');
  s.click();
  assert.deepEqual(s.log, []);
});

test('a double click: A gets two clicks and one dblclick; the native dblclick on B is seen by no listener', (t) => {
  for (const layout of /** @type {const} */ (['button-button', 'div-p'])) {
    const s = setup(t, layout);
    s.click(OVER_B[0], OVER_B[1], 1);
    s.click(OVER_B[0], OVER_B[1], 2);
    s.fire('dblclick', OVER_B[0], OVER_B[1], 2);
    assert.deepEqual(s.log, ['doc-capture:click@A', 'at-A:click@A', 'doc-capture:click@A', 'at-A:click@A', 'doc-capture:dblclick@A', 'at-A:dblclick@A'], layout);
  }
});

test('the click A gets carries the mapped point and the release modifiers', (t) => {
  const s = setup(t, 'div-p');
  /** @type {MouseEvent|null} */
  let got = null;
  s.el('A').addEventListener('click', (e) => { got = e; });
  s.fire('pointerdown', ...OVER_B);
  const r = s.rig.canvas.getBoundingClientRect();
  s.rig.layerEl.querySelector('#B')?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, composed: true, clientX: r.left + 60, clientY: r.top + 60, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, shiftKey: true }));
  const e = /** @type {MouseEvent} */ (/** @type {unknown} */ (got));
  assert.ok(e, 'A got a click');
  assert.equal(e.clientX, r.left + 340);
  assert.equal(e.clientY, r.top + 220);
  assert.equal(e.shiftKey, true);
  assert.equal(e.button, 0);
});

test('mapper and browser hit the same element without a control (a paragraph): untouched, the native click passes', (t) => {
  const s = setup(t, 'same-p', (p) => ({ x: p.x + 30, y: p.y }));
  const d = s.click();
  assert.equal(d.ev.defaultPrevented, false);
  assert.deepEqual(s.log, ['doc-capture:click@B', 'at-B:click@B']);
});

test('a dblclick after a gesture that was not re-targeted passes; a later native click elsewhere on the page passes', (t) => {
  const s = setup(t, 'same-p', (p) => ({ x: p.x + 30, y: p.y }));
  s.click(); s.click(OVER_B[0], OVER_B[1], 2);
  s.fire('dblclick', ...OVER_B, 2);
  assert.deepEqual(s.log.filter((l) => l.startsWith('at-')), ['at-B:click@B', 'at-B:click@B', 'at-B:dblclick@B']);
  const t2 = setup(t, 'div-p');
  t2.click();
  const outside = document.createElement('button');
  document.body.append(outside);
  t.cleanup(() => outside.remove());
  let seen = 0;
  outside.addEventListener('click', () => { seen += 1; });
  outside.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  assert.equal(seen, 1, 'a click outside the layer is never swallowed');
});

test('dispose removes the window listeners: a re-targeted click armed before it no longer swallows', (t) => {
  const s = setup(t, 'div-p');
  s.fire('pointerdown', ...OVER_B);
  s.fire('pointerup', ...OVER_B);
  s.ip.dispose();
  s.fire('click', ...OVER_B);
  assert.deepEqual(s.log.filter((l) => l.includes('@B')), ['doc-capture:click@B', 'at-B:click@B']);
});
