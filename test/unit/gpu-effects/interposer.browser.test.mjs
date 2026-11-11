// Interposer logic with a hand-made mapper chain (no GPU): the decisions it takes for a given mapping.
import { test, assert } from '/test/unit/lib/t.js';
import { makeRig } from './lib/rig.mjs';
import { createInterposer } from '/src/effects/interposer.js';
import { createMapperChain } from '/src/effects/input-mapper.js';
import { NO_TARGET } from '/src/effects/no-target.js';

const HTML = `<button data-id="a" style="position:absolute;left:10px;top:10px;width:80px;height:30px;margin:0">A</button>
<button data-id="b" style="position:absolute;left:200px;top:10px;width:80px;height:30px;margin:0">B</button>
<input data-id="t" type="text" value="abcdefghij" style="position:absolute;left:10px;top:100px;width:150px;height:24px;margin:0;box-sizing:border-box;font:14px monospace">`;

function setup(t, mapper, { w = 480, h = 320 } = {}) {
  const rig = makeRig({ w, h, html: HTML });
  const chain = createMapperChain();
  if (mapper) chain.push(1, Array.isArray(mapper) ? mapper : [mapper]);
  const ip = createInterposer(rig.env, rig.record, chain, rig.tracker);
  t.cleanup(() => ip.dispose());
  const clicks = [];
  rig.layerEl.addEventListener('click', (e) => clicks.push(e.target.closest('[data-id]')?.dataset.id ?? 'none'));
  const r = rig.canvas.getBoundingClientRect();
  const fire = (type, x, y, init = {}) => {
    const cx = r.left + x, cy = r.top + y;
    const target = document.elementFromPoint(cx, cy) ?? rig.layerEl;
    const base = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
    const ev = type === 'click'
      ? new MouseEvent('click', { ...base, detail: 1, ...init })
      : new PointerEvent(type, { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: type === 'pointermove' ? -1 : 0, ...init });
    target.dispatchEvent(ev);
    return { target, ev };
  };
  const press = (x, y) => { fire('pointermove', x, y); const d = fire('pointerdown', x, y); fire('pointerup', x, y); fire('click', x, y); return d; };
  return { rig, chain, ip, clicks, fire, press, el: (id) => rig.layerEl.querySelector(`[data-id="${id}"]`) };
}

/** everything the pointer sees comes from 190 px to the right */
const shiftRight = (p) => ({ x: p.x + 190, y: p.y });

test('with a mapping, a press on A activates B (the control drawn there) and the native click on A is swallowed', (t) => {
  const s = setup(t, shiftRight);
  const d = s.press(20, 20); // native A, mapped to (210, 20) = B
  assert.equal(d.target.dataset.id, 'a');
  assert.equal(d.ev.defaultPrevented, true, 'pointerdown default prevented (re-targeted)');
  assert.deepEqual(s.clicks, ['b']);
  assert.equal(document.activeElement, s.el('b'));
});

test('no spatial frame presented: nothing is touched (events pass through, hover untouched)', (t) => {
  const s = setup(t, null);
  const d = s.press(20, 20);
  assert.equal(d.ev.defaultPrevented, false);
  assert.deepEqual(s.clicks, ['a']);
  assert.equal(s.rig.tracker.mapped.length, 0);
  assert.equal(s.ip.stats().passedThrough > 0, true);
  assert.equal(s.ip.stats().remapped, 0);
});

test('mapped and native control are the same: pass through untouched, no preventDefault, click not swallowed', (t) => {
  const s = setup(t, (p) => ({ x: p.x + 3, y: p.y + 2 }));
  const d = s.press(20, 20);
  assert.equal(d.ev.defaultPrevented, false);
  assert.deepEqual(s.clicks, ['a']);
});

test('a press that maps to background blurs the focused field and operates nothing', (t) => {
  const s = setup(t, () => ({ x: 400, y: 250 }));
  s.el('t').focus();
  const d = s.press(20, 20);
  assert.equal(d.ev.defaultPrevented, true);
  assert.deepEqual(s.clicks, []);
  assert.notEqual(document.activeElement, s.el('t'));
});

test('keyboard and script clicks (detail 0) are never swallowed, even right after a re-targeted press', (t) => {
  const s = setup(t, shiftRight);
  s.fire('pointerdown', 20, 20);
  s.fire('pointerup', 20, 20);
  s.el('a').click();
  assert.deepEqual(s.clicks, ['b', 'a'], 'B activated on pointerup, then the script click passes');
  s.fire('click', 20, 20);
  assert.deepEqual(s.clicks, ['b', 'a'], 'the pointer click (detail 1) is swallowed');
});

test('the swallow is one click only: the next gesture is not affected', (t) => {
  const s = setup(t, shiftRight);
  s.press(20, 20);
  s.clicks.length = 0;
  s.fire('click', 300, 20); // stray pointer click later, on nothing re-targeted
  assert.equal(s.clicks.length, 1, 'second click is not swallowed');
});

test('release on a different control than the press: no activation (click semantics)', (t) => {
  const s = setup(t, shiftRight);
  s.fire('pointerdown', 20, 20); // mapped to B
  s.fire('pointerup', 20, 130); // mapped to (210,130): background
  assert.deepEqual(s.clicks, []);
});

test('pointercancel ends the gesture and does not swallow later clicks', (t) => {
  const s = setup(t, shiftRight);
  s.fire('pointerdown', 20, 20);
  s.fire('pointercancel', 20, 20);
  s.fire('click', 20, 20);
  assert.deepEqual(s.clicks, ['a']);
});

test('right button and non-primary pointers are not re-targeted', (t) => {
  const s = setup(t, shiftRight);
  assert.equal(s.fire('pointerdown', 20, 20, { button: 2 }).ev.defaultPrevented, false);
  assert.equal(s.fire('pointerdown', 20, 20, { isPrimary: false, pointerId: 2 }).ev.defaultPrevented, false);
});

test('hover follows the mapped element for pointermove, and a running gesture keeps its frozen mapping', (t) => {
  let dx = 190;
  const m = (p) => ({ x: p.x + dx, y: p.y });
  m.captureGestureSnapshot = () => { const d = dx; return (p) => ({ x: p.x + d, y: p.y }); };
  const s = setup(t, m);
  s.fire('pointermove', 20, 20);
  assert.equal(s.rig.tracker.mapped.at(-1), s.el('b'));
  s.fire('pointerdown', 20, 20);
  dx = 0; // the effect moved on
  s.fire('pointerup', 20, 20);
  assert.deepEqual(s.clicks, ['b'], 'B was activated through the frozen gesture mapper, not through the new mapping (which is A)');
  s.fire('click', 20, 20);
  assert.deepEqual(s.clicks, ['b'], 'native click swallowed');
});

test('canvas css scale is undone: a canvas drawn at 2x css size still maps in content-box units', (t) => {
  const seen = [];
  const s = setup(t, (p) => { seen.push(p); return { x: p.x, y: p.y }; });
  s.rig.layerEl.style.transform = 'scale(2)';
  s.rig.layerEl.style.transformOrigin = '0 0';
  s.fire('pointermove', 100, 40);
  const p = seen.at(-1);
  assert.ok(Math.abs(p.x - 50) < 1 && Math.abs(p.y - 20) < 1, `content-box px, got ${p.x},${p.y}`);
  assert.equal(p.width, 480);
});

test('range drag in isolation: input events per move, one change, value follows mapped x', (t) => {
  const rig = makeRig({ html: '<input data-id="r" type="range" min="0" max="100" value="50" style="position:absolute;left:100px;top:100px;width:200px;height:20px;margin:0;padding:0">' });
  const chain = createMapperChain();
  chain.push(1, [(p) => ({ x: p.x, y: 110 })]);
  const ip = createInterposer(rig.env, rig.record, chain, rig.tracker);
  t.cleanup(() => ip.dispose());
  const range = rig.layerEl.querySelector('input');
  const r = rig.canvas.getBoundingClientRect();
  const ev = (type, x, y) => rig.layerEl.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: r.left + x, clientY: r.top + y, pointerId: 1, isPrimary: true, button: type === 'pointermove' ? -1 : 0 }));
  const log = [];
  range.addEventListener('input', () => log.push('input'));
  range.addEventListener('change', () => log.push('change'));
  ev('pointerdown', 100, 300); // natively on nothing, mapped onto the range
  const v0 = Number(range.value);
  ev('pointermove', 200, 300);
  const v1 = Number(range.value);
  ev('pointermove', 300, 300);
  const v2 = Number(range.value);
  ev('pointerup', 300, 300);
  assert.ok(v0 < 10 && Math.abs(v1 - 50) < 6 && v2 > 90, `${v0} ${v1} ${v2}`);
  assert.deepEqual(log, ['input', 'input', 'input', 'change']);
});

test('the layer cursor follows the mapped element, not the cursor the interposer itself put on the layer', (t) => {
  const s = setup(t, (p) => p);
  s.el('b').style.cursor = 'pointer';
  const plain = document.createElement('div');
  plain.dataset.id = 'plain';
  plain.style.cssText = 'position:absolute;left:300px;top:150px;width:100px;height:60px';
  s.rig.layerEl.append(plain);
  s.fire('pointermove', 240, 25);
  assert.equal(s.rig.layerEl.style.cursor, 'pointer', 'over B: its cursor');
  s.fire('pointermove', 350, 180);
  // the plain box has no cursor of its own; read while the layer carried "pointer", it inherited that value and the pointer cursor stuck
  assert.equal(s.rig.layerEl.style.cursor, 'auto', 'over a box without a cursor: auto, not the inherited pointer');
  s.fire('pointermove', 240, 25);
  assert.equal(s.rig.layerEl.style.cursor, 'pointer', 'back over B');
});

test('dispose removes listeners, hover and cursor', (t) => {
  const s = setup(t, shiftRight);
  s.fire('pointermove', 20, 20);
  assert.equal(s.rig.layerEl.style.cursor, getComputedStyle(s.el('b')).cursor);
  s.ip.dispose();
  const n = s.rig.tracker.mapped.length;
  assert.equal(s.rig.tracker.mapped.at(-1), null);
  const d = s.fire('pointerdown', 20, 20);
  assert.equal(d.ev.defaultPrevented, false);
  assert.equal(s.rig.tracker.mapped.length, n);
  assert.equal(s.rig.layerEl.style.cursor, '');
});

test('NO_TARGET: the press is swallowed (no activation, no click, no focus change) and nothing of the page is hovered', (t) => {
  const s = setup(t, () => NO_TARGET);
  s.el('t').focus();
  s.fire('pointermove', 20, 20);
  assert.equal(s.rig.tracker.mapped.at(-1), s.rig.layerEl, 'hover follows the layer itself: no element of the page');
  assert.equal(s.rig.layerEl.style.cursor, 'default');
  const d = s.press(20, 20); // natively on A
  assert.equal(d.target.dataset.id, 'a');
  assert.equal(d.ev.defaultPrevented, true, 'pointerdown default prevented: no mousedown, focus or selection on A');
  assert.deepEqual(s.clicks, [], 'A was not activated and the native click was swallowed');
  assert.equal(document.activeElement, s.el('t'), 'the focused field keeps the focus');
  s.fire('click', 300, 200);
  assert.equal(s.clicks.length, 1, 'only the click of that gesture was swallowed');
});

test('NO_TARGET with a clamping plugin before it in the chain: never clamped back onto an element', (t) => {
  // plugin 1 clamps into [15, w] x [15, h]: a far-away point becomes (15, 15), which is button A
  const clamp = (p) => ({ x: Math.min(p.width, Math.max(15, p.x)), y: Math.min(p.height, Math.max(15, p.y)) });
  const s = setup(t, [clamp, () => NO_TARGET]);
  const d = s.press(220, 20); // natively on B
  assert.equal(d.ev.defaultPrevented, true);
  assert.deepEqual(s.clicks, [], 'neither A (the clamped point) nor B (the native hit) was activated');
});

test('control of the test above: an unbranded far-away point IS clamped onto A by the plugin before it', (t) => {
  const clamp = (p) => ({ x: Math.min(p.width, Math.max(15, p.x)), y: Math.min(p.height, Math.max(15, p.y)) });
  const s = setup(t, [clamp, () => ({ x: -1e5, y: -1e5 })]);
  s.press(220, 20);
  assert.deepEqual(s.clicks, ['a']);
});

test('a press on a control released where a mapper returns NO_TARGET activates nothing', (t) => {
  let none = false;
  const m = (p) => (none ? NO_TARGET : { x: p.x + 190, y: p.y });
  const s = setup(t, m);
  s.fire('pointerdown', 20, 20); // mapped to B; the gesture keeps this mapper (no captureGestureSnapshot), so flip it before the release
  none = true;
  s.fire('pointerup', 20, 20);
  s.fire('click', 20, 20);
  assert.deepEqual(s.clicks, []);
});

test('a finger: a tap focuses and activates the mapped control when it lifts, not when it lands; a drag (a scroll, a plugin moving a lens) focuses and activates nothing', (t) => {
  const s = setup(t, shiftRight);
  const touch = { pointerType: 'touch' };
  // tap: down and up at the same place
  s.fire('pointerdown', 20, 20, touch);
  assert.notEqual(document.activeElement, s.el('b'), 'not focused while the finger is down');
  s.fire('pointerup', 20, 20, touch);
  s.fire('click', 20, 20);
  assert.deepEqual(s.clicks, ['b'], 'the tap activated B, the native click on A was swallowed');
  assert.equal(document.activeElement, s.el('b'), 'and focused it');
  s.el('b').blur();
  // drag: the finger travels 40 px before it lifts
  s.fire('pointerdown', 20, 20, touch);
  s.fire('pointermove', 40, 30, touch);
  s.fire('pointermove', 60, 20, touch);
  s.fire('pointerup', 60, 20, touch);
  s.fire('click', 60, 20);
  assert.deepEqual(s.clicks, ['b'], 'no activation after a drag, and its native click swallowed');
  assert.notEqual(document.activeElement, s.el('b'), 'no focus after a drag');
  // a small wobble (under the slop) is still a tap
  s.fire('pointerdown', 20, 20, touch);
  s.fire('pointermove', 24, 23, touch);
  s.fire('pointerup', 24, 23, touch);
  assert.equal(document.activeElement, s.el('b'), 'a 5 px wobble still taps');
  // control: a mouse press focuses at once, as before
  s.el('b').blur();
  s.fire('pointerdown', 20, 20);
  assert.equal(document.activeElement, s.el('b'), 'a mouse press focuses on pointerdown (control)');
  s.fire('pointerup', 20, 20);
});

test('a finger hovers like a native one: its press activates the mapped element and hovers nothing, a pan or a drag hovers nothing, a tap hovers the mapped element and it stays after the finger leaves; a mouse hovers at every move (control)', (t) => {
  const s = setup(t, shiftRight);
  const touch = { pointerType: 'touch' };
  const { tracker } = s.rig;
  // a pan across A and the text field (a scroll, or a lens dragged by its handle)
  s.fire('pointerdown', 20, 20, touch);
  assert.deepEqual(tracker.presses, [s.el('b')], 'the press activates B, the element drawn under the finger');
  for (let x = 30; x <= 150; x += 20) s.fire('pointermove', x, 20 + x / 2, touch);
  s.fire('pointerup', 150, 95, touch);
  s.fire('pointerleave', 150, 95, touch);
  assert.deepEqual(tracker.mapped, [], 'no :hover moved during the press, the pan or after it');
  // a tap on A: B (drawn there) is hovered, and stays hovered when the finger's pointerleave follows
  s.fire('pointerdown', 20, 20, touch);
  s.fire('pointerup', 21, 21, touch);
  s.fire('pointerleave', 21, 21, touch);
  assert.deepEqual(tracker.mapped, [s.el('b')], 'the tap hovers B and nothing clears it');
  // a tap where no element is drawn ends that hover, as a native tap on an empty spot does
  s.fire('pointerdown', 300, 300, touch);
  s.fire('pointerup', 300, 300, touch);
  assert.equal(tracker.mapped.at(-1), null);
  // control: a mouse hovers what is drawn under it at every move, and leaving the layer ends it
  s.fire('pointermove', 20, 20);
  assert.equal(tracker.mapped.at(-1), s.el('b'));
  s.fire('pointerleave', 20, 20);
  assert.equal(tracker.mapped.at(-1), null, 'a mouse leaving the layer ends the hover');
});

test('the interposer asks the tracker again when the tracker dropped a mapped hover itself (a tap outside the canvas): the same element is hovered again', (t) => {
  const s = setup(t, shiftRight);
  s.fire('pointermove', 20, 20);
  s.fire('pointermove', 22, 20);
  assert.equal(s.rig.tracker.mapped.length, 1, 'the same element is not set twice');
  s.rig.tracker.current = null;   // the tracker forgot it
  s.fire('pointermove', 24, 20);
  assert.deepEqual(s.rig.tracker.mapped, [s.el('b'), s.el('b')]);
});

/** A drop-down select at B's place (and a list box, a multiple and a disabled select beside it); `opened` records every showPicker() call. */
function withSelects(t) {
  const s = setup(t, shiftRight);
  const add = (id, attrs, left) => {
    const el = Object.assign(document.createElement('select'), { innerHTML: '<option>one</option><option>two</option>' });
    el.dataset.id = id;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.style.cssText = `position:absolute;left:${left}px;top:200px;width:80px;height:24px;margin:0`;
    s.rig.layerEl.append(el);
    return el;
  };
  s.el('b').remove();
  const sel = add('b', {}, 200);
  sel.style.top = '10px';
  add('lb', { size: '3' }, 200);
  add('mu', { multiple: '' }, 290);
  add('di', { disabled: '' }, 380);
  /** @type {string[]} */ const opened = [];
  const real = HTMLSelectElement.prototype.showPicker;
  HTMLSelectElement.prototype.showPicker = function () { opened.push(this.dataset.id); };
  t.cleanup(() => { HTMLSelectElement.prototype.showPicker = real; });
  return { ...s, sel, opened };
}

test('a press drawn on a drop-down select opens its list (showPicker) and focuses it; a mouse release and a finger tap alike', (t) => {
  const s = withSelects(t);
  s.press(20, 20); // native A, mapped to the select at B's place
  assert.deepEqual(s.opened, ['b'], 'the list was asked to open once');
  assert.equal(document.activeElement, s.sel);
  s.sel.blur();
  s.fire('pointerdown', 20, 20, { pointerType: 'touch' });
  assert.deepEqual(s.opened, ['b'], 'not while the finger is down');
  s.fire('pointerup', 20, 20, { pointerType: 'touch' });
  assert.deepEqual(s.opened, ['b', 'b'], 'a tap opens it when the finger lifts');
  assert.equal(document.activeElement, s.sel);
});

test('select, controls: no list for a press released elsewhere, a finger that dragged, a list box, a multiple or a disabled select, or a select under the pointer natively', (t) => {
  const s = withSelects(t);
  s.fire('pointerdown', 20, 20);
  s.fire('pointerup', 20, 130); // released on the background
  s.fire('pointerdown', 20, 20, { pointerType: 'touch' });
  s.fire('pointermove', 60, 20, { pointerType: 'touch' });
  s.fire('pointerup', 60, 20, { pointerType: 'touch' });
  for (const x of [20, 110, 200]) s.press(x, 200); // mapped to the list box, the multiple and the disabled select
  assert.deepEqual(s.opened, [], 'none of them');
  // the select drawn where it is (no mapping that moves it): the native press opens it, the interposer stays out
  const plain = setup(t, (p) => ({ x: p.x, y: p.y }));
  const sel = Object.assign(document.createElement('select'), { innerHTML: '<option>one</option>' });
  sel.style.cssText = 'position:absolute;left:300px;top:250px;width:80px;height:24px;margin:0';
  plain.rig.layerEl.append(sel);
  const d = plain.press(320, 260);
  assert.equal(d.ev.defaultPrevented, false, 'passed through untouched');
  assert.deepEqual(s.opened, []);
});
