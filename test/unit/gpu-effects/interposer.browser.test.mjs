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
