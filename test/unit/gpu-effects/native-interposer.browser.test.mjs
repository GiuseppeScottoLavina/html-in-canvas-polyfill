// The native interposer (src/effects/native-interposer.js) over an EMULATED native implementation: a positioned box stands for the canvas, and its
// updateElementGeometry / clearElementGeometry move the source with a CSS transform (the hit test of the next event follows it, as in a browser
// that implements HTML-in-Canvas). Synthetic events are dispatched at what the hit test finds at that moment. The real browser is exercised with
// trusted input on Chrome Canary by test/native-effects/run.mjs.
import { test, assert } from '/test/unit/lib/t.js';
import { createNativeInterposer } from '/src/effects/native-interposer.js';
import { createHoverSync, createNativeGeometry, hoverSyncPokes } from '/src/effects/native-geometry.js';
import { createMapperChain } from '/src/effects/input-mapper.js';
import { NO_TARGET } from '/src/effects/no-target.js';

const W = 480, H = 320;
const HTML = `<button data-id="a" style="position:absolute;left:10px;top:10px;width:80px;height:30px;margin:0">A</button>
<button data-id="b" style="position:absolute;left:200px;top:10px;width:80px;height:30px;margin:0">B</button>
<input data-id="t" type="text" value="abcdefghij" style="position:absolute;left:10px;top:100px;width:150px;height:24px;margin:0;box-sizing:border-box;font:14px monospace">
<input data-id="r" type="range" min="0" max="100" value="50" style="position:absolute;left:200px;top:100px;width:200px;height:20px;margin:0;padding:0">`;

/** everything the pointer sees comes from 190 px to the right */
const shiftRight = (p) => ({ x: p.x + 190, y: p.y });

function setup(t, mapper, { interposer = true } = {}) {
  const box = document.createElement('div');
  box.style.cssText = `position:fixed;left:30px;top:40px;width:${W}px;height:${H}px;overflow:hidden;background:#eee`;
  const source = document.createElement('div');
  source.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px;transform-origin:0 0`;
  source.innerHTML = HTML;
  box.append(source);
  document.body.append(box);
  // the emulated native geometry: canvasTransform maps the source's border box into the canvas (css px); a cleared source is not hit-tested
  box.updateElementGeometry = (el, o) => { const m = o.canvasTransform; el.style.transform = `matrix(${m.a},0,0,${m.d},${m.e},${m.f})`; el.style.pointerEvents = ''; };
  box.clearElementGeometry = (el) => { el.style.pointerEvents = 'none'; };
  const geometry = createNativeGeometry(/** @type {any} */ (box), source);
  geometry.setFill(1, 1);
  const chain = createMapperChain();
  if (mapper) chain.push(1, [mapper]);
  const env = { window };
  const ip = interposer ? createNativeInterposer(/** @type {any} */ (env), /** @type {any} */ (box), source, chain, geometry) : null;
  t.cleanup(() => { ip?.dispose(); geometry.dispose(); box.remove(); document.activeElement?.blur?.(); });
  const clicks = [];
  box.addEventListener('click', (e) => clicks.push(e.target.closest('[data-id]')?.dataset.id ?? 'none'));
  /** dispatch at what the hit test finds NOW (the browser hit-tests before dispatch), with a default action for pointerdown like the browser's */
  const fire = (type, x, y, init = {}) => {
    const cx = 30 + x, cy = 40 + y;
    const target = document.elementsFromPoint(cx, cy)[0] ?? box;
    const base = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy };
    const ev = type === 'click'
      ? new MouseEvent('click', { ...base, detail: 1, ...init })
      : new PointerEvent(type, { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: type === 'pointermove' ? -1 : 0, ...init });
    target.dispatchEvent(ev);
    if (type === 'pointerdown' && !ev.defaultPrevented) {
      const ctl = target.closest('button,input');
      if (ctl) ctl.focus(); else document.activeElement?.blur?.();
    }
    return { target, ev };
  };
  /** down, up and the click the browser sends to the element it hit at the press */
  const press = (x, y) => { const d = fire('pointerdown', x, y); fire('pointerup', x, y); d.target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 30 + x, clientY: 40 + y, detail: 1 })); return d; };
  return { box, source, geometry, chain, ip, clicks, fire, press, el: (id) => source.querySelector(`[data-id="${id}"]`) };
}

test('a move aims the hit-test geometry: the press that follows at the same point is hit natively on the control drawn there (nothing re-targeted)', (t) => {
  const s = setup(t, shiftRight);
  s.fire('pointermove', 20, 20);
  assert.equal(s.source.style.transform, 'matrix(1, 0, 0, 1, -190, 0)', 'offset = pointer - mapped point');
  const d = s.press(20, 20);
  assert.equal(d.target.dataset.id, 'b', 'the browser itself hits B, the control drawn under the pointer');
  assert.equal(d.ev.defaultPrevented, false, 'native handling: focus, :active, caret are the browser\'s');
  assert.deepEqual(s.clicks, ['b']);
  assert.equal(document.activeElement, s.el('b'));
  assert.equal(s.ip.stats().passedThrough >= 1, true);
});

test('control: without the interposer the same press lands on A (the DOM position)', (t) => {
  const s = setup(t, shiftRight, { interposer: false });
  s.fire('pointermove', 20, 20);
  const d = s.press(20, 20);
  assert.equal(d.target.dataset.id, 'a');
  assert.deepEqual(s.clicks, ['a']);
});

test('a press without a move before it (a touch, a jump) is re-targeted: B focused and activated, the native click on A swallowed', (t) => {
  const s = setup(t, shiftRight);
  const d = s.press(20, 20);
  assert.equal(d.target.dataset.id, 'a', 'hit with the geometry of before the press');
  assert.equal(d.ev.defaultPrevented, true);
  assert.deepEqual(s.clicks, ['b'], 'B activated by the interposer, the native click on A swallowed');
  assert.equal(document.activeElement, s.el('b'));
  assert.equal(s.ip.stats().remapped >= 1, true);
});

test('re-targeted press on a text field: focus and the caret at the mapped point', (t) => {
  const s = setup(t, (p) => ({ x: p.x - 190, y: p.y }));
  const d = s.press(10 + 190 + 4 + 8.4 * 3, 112); // natively on the range's row, mapped into the text field after "abc"
  assert.equal(d.ev.defaultPrevented, true);
  const field = s.el('t');
  assert.equal(document.activeElement, field);
  assert.ok(field.selectionStart >= 2 && field.selectionStart <= 4, `caret near offset 3, got ${field.selectionStart}`);
});

test('a range is always driven by the interposer: input per move along the mapped x, one change', (t) => {
  const s = setup(t, (p) => ({ x: p.x, y: p.y - 200 }));
  const range = s.el('r');
  const log = [];
  range.addEventListener('input', () => log.push('input'));
  range.addEventListener('change', () => log.push('change'));
  s.fire('pointerdown', 210, 310);
  const v0 = Number(range.value);
  s.fire('pointermove', 300, 310);
  const v1 = Number(range.value);
  s.fire('pointermove', 390, 310);
  const v2 = Number(range.value);
  s.fire('pointerup', 390, 310);
  assert.ok(v0 < v1 && v1 < v2, `value follows the mapped x: ${v0} ${v1} ${v2}`);
  assert.equal(log.filter((x) => x === 'change').length, 1);
  assert.ok(log.filter((x) => x === 'input').length >= 2);
});

test('NO_TARGET: the source leaves hit testing, the press is swallowed and the focus stays', (t) => {
  const s = setup(t, () => NO_TARGET);
  s.el('t').focus();
  s.fire('pointermove', 20, 20);
  assert.equal(s.source.style.pointerEvents, 'none', 'clearElementGeometry: the canvas itself is under the pointer');
  const d = s.press(20, 20);
  assert.equal(d.target, s.box);
  assert.equal(d.ev.defaultPrevented, true);
  assert.deepEqual(s.clicks, [], 'nothing activated, no click');
  assert.equal(document.activeElement, s.el('t'));
});

test('no spatial frame presented: plain stretch, events pass through untouched', (t) => {
  const s = setup(t, null);
  s.fire('pointermove', 20, 20);
  const d = s.press(20, 20);
  assert.equal(d.ev.defaultPrevented, false);
  assert.deepEqual(s.clicks, ['a']);
  assert.equal(s.ip.stats().remapped, 0);
  assert.equal(s.source.style.transform, 'matrix(1, 0, 0, 1, 0, 0)');
});

test('a gesture keeps the mapper of its press; leaving the canvas restores the plain stretch', (t) => {
  const s = setup(t, shiftRight);
  s.fire('pointermove', 20, 20);
  s.fire('pointerdown', 20, 20);
  s.chain.push(2, [(p) => ({ x: p.x + 5, y: p.y })]); // a newer frame while the button is held
  s.fire('pointermove', 30, 20);
  assert.equal(s.source.style.transform, 'matrix(1, 0, 0, 1, -190, 0)', 'the frozen mapping of the press, not the newer frame');
  s.fire('pointerup', 30, 20);
  s.box.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 1 }));
  assert.equal(s.source.style.transform, 'matrix(1, 0, 0, 1, 0, 0)');
});

test('hover: a move whose native target differs from the drawn element pokes one layout of the hover sync element; dispose removes it', (t) => {
  const s = setup(t, shiftRight);
  s.fire('pointermove', 20, 20); // natively A, drawn B
  const sync = document.documentElement.querySelector(':scope > hic-hover-sync');
  assert.ok(sync, 'the hover sync element exists, outside the body');
  assert.equal(hoverSyncPokes(document), 1);
  s.fire('pointermove', 21, 20); // natively B now, drawn B: no poke
  assert.equal(hoverSyncPokes(document), 1);
  s.ip.dispose();
  assert.equal(document.documentElement.querySelector(':scope > hic-hover-sync'), null);
  assert.equal(hoverSyncPokes(document), null);
});

test('hover sync: inert for the page (no box, no hit test, no a11y, no shadow root to read), one element shared by every host, no mutation records for a poke', async (t) => {
  // an author rule that would give every element a box, if it could
  const style = document.createElement('style');
  style.textContent = 'html > * { display: block !important; visibility: visible !important; width: 50px !important; height: 50px !important; position: static !important; pointer-events: auto !important; }';
  document.head.append(style);
  const records = [];
  const mo = new MutationObserver((list) => records.push(...list));
  mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  t.cleanup(() => { mo.disconnect(); style.remove(); });
  const a = createHoverSync(document);
  const b = createHoverSync(document);
  a.poke();
  b.poke();
  a.poke();
  const els = document.querySelectorAll('hic-hover-sync');
  assert.equal(els.length, 1, 'one element for the document');
  const el = /** @type {HTMLElement} */ (els[0]);
  assert.equal(el.parentNode, document.documentElement);
  assert.equal(el.shadowRoot, null, 'its shadow root is closed');
  assert.equal(el.getAttribute('aria-hidden'), 'true');
  const r = el.getBoundingClientRect();
  assert.deepEqual([r.width, r.height, r.left, r.top], [0, 0, 0, 0], 'no box, whatever the page styles');
  assert.equal(getComputedStyle(el).visibility, 'hidden');
  assert.equal(getComputedStyle(el).pointerEvents, 'none');
  assert.equal(document.elementsFromPoint(0, 0).includes(el), false, 'never hit-tested');
  assert.equal(hoverSyncPokes(document), 3);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(records.map((m) => `${m.type}:${[...m.addedNodes].map((n) => n.nodeName).join()}`), ['childList:HIC-HOVER-SYNC'], 'only the append is seen');
  a.dispose();
  a.dispose(); // a second dispose of the same user changes nothing
  assert.ok(el.isConnected, 'kept while another host uses it');
  b.dispose();
  assert.equal(el.isConnected, false, 'removed by the last dispose');
  // positive control: the observer does see a change of an attribute of an element of the page
  document.body.dataset.hoverSyncControl = '1';
  delete document.body.dataset.hoverSyncControl;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(records.some((m) => m.type === 'attributes' && m.target === document.body), 'the observer sees attribute changes');
  assert.ok(records.some((m) => m.type === 'childList' && [...m.removedNodes].includes(el)), 'and the removal');
});
