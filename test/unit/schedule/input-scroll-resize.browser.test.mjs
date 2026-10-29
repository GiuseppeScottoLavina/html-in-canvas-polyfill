import { test, assert, fixture, frames, microtasks, sleep } from '/test/unit/lib/t.js';
import { createRig, rect } from './_dom.js';
import { observeInput } from '/src/schedule/observers/input-observer.js';
import { observeScroll } from '/src/schedule/observers/scroll-observer.js';
import { observeCanvasResize } from '/src/schedule/observers/resize-observer.js';
import { observeFrameCap } from '/src/schedule/observers/framecap-observer.js';
import { observeDpr } from '/src/schedule/observers/dpr-observer.js';
import { BUS } from '/src/contracts/events.js';

const FORM = '<div drawable id="d" style="width:200px;padding:10px"><input id="in" style="width:120px;height:24px;margin:8px 0"><button id="b">go</button><div id="sc" style="overflow:auto;height:40px;width:100px"><div style="height:300px">tall</div></div></div>';

test('input event damages the control rect (grown by the ink margin) in the drawable frame, cause input', async t => {
  const rig = createRig({ html: FORM });
  t.cleanup(observeInput(rig.env, rig.record));
  const input = rig.layerEl.querySelector('#in');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(rig.sink.damage.length, 1);
  const d = rig.sink.damage[0];
  assert.equal(d.cause, 'input');
  assert.equal(d.drawable.id, 'd');
  const own = rig.layer.frameRect(input);
  assert.deepEqual(rect(d.rect), rect({ x: own.x - 24, y: own.y - 24, width: own.width + 48, height: own.height + 48 }));
});

test('change, composition events and text-control keydown damage; modifier keys and non-text keydown do not', async t => {
  const rig = createRig({ html: FORM });
  t.cleanup(observeInput(rig.env, rig.record));
  const input = rig.layerEl.querySelector('#in');
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'a' }));
  input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
  assert.equal(rig.sink.damage.length, 3);
  rig.sink.clear();
  input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Shift' }));
  rig.layerEl.querySelector('#b').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
  assert.equal(rig.sink.damage.length, 0);
});

test('selectionchange on the focused text control (and on the document) damages it with cause selection', async t => {
  const rig = createRig({ html: FORM });
  t.cleanup(observeInput(rig.env, rig.record));
  const input = rig.layerEl.querySelector('#in');
  input.value = 'hello';
  input.focus();
  input.setSelectionRange(1, 3);
  await frames(2);
  assert.ok(rig.sink.damage.some(d => d.cause === 'selection' && d.drawable.id === 'd'), `causes: ${rig.sink.causes()}`);
});

// ---- the page text selection (static text, no focused control): the highlight is drawn into the tile, so each change of it must damage it
const TEXT = '<div drawable id="d1" style="width:180px;padding:10px;font:16px/20px sans-serif"><p id="p1" style="margin:0">Touch the interface.</p><p id="p2" style="margin:30px 0 0">Second line here</p></div>'
  + '<div drawable id="d2" style="width:180px;padding:10px;font:16px/20px sans-serif"><p id="p3" style="margin:0">Other drawable text</p></div>';

/** Select `length` characters of the first text node of `#id` from `start` (what a double click on a word does). */
function selectText(id, start, length) {
  const text = document.getElementById(id).firstChild;
  getSelection().setBaseAndExtent(text, start, text, start + length);
}
/** The line boxes of the current selection inside `drawable`, in its frame, grown by the ink margin (24). */
function expectedRect(drawable) {
  const range = getSelection().getRangeAt(0);
  const d = drawable.getBoundingClientRect();
  const rs = [...range.getClientRects()].filter((r) => r.width > 0 && r.bottom > d.top && r.top < d.bottom);
  const x = Math.min(...rs.map((r) => r.left)) - d.left, y = Math.min(...rs.map((r) => r.top)) - d.top;
  const x2 = Math.max(...rs.map((r) => r.right)) - d.left, y2 = Math.max(...rs.map((r) => r.bottom)) - d.top;
  return { x: x - 24, y: y - 24, width: x2 - x + 48, height: y2 - y + 48 };
}
const selectionDamage = (rig) => rig.sink.damage.filter((d) => d.cause === 'selection');

test('selecting a word of the static text (no focused control) damages the word in its drawable, cause selection', async t => {
  const rig = createRig({ html: TEXT });
  t.cleanup(observeInput(rig.env, rig.record));
  t.cleanup(() => getSelection().removeAllRanges());
  /** @type {HTMLElement} */ (document.activeElement)?.blur?.();
  selectText('p1', 0, 5);
  const want = expectedRect(rig.layerEl.querySelector('#d1'));
  await frames(2);
  const got = selectionDamage(rig);
  assert.equal(got.length, 1, `damage: ${JSON.stringify(rig.sink.damage.map((d) => [d.cause, d.drawable?.id]))}`);
  assert.equal(got[0].drawable.id, 'd1');
  assert.deepEqual(rect(got[0].rect), rect(want));
});

test('clearing the static text selection damages where the highlight was (deselection repaints)', async t => {
  const rig = createRig({ html: TEXT });
  t.cleanup(observeInput(rig.env, rig.record));
  t.cleanup(() => getSelection().removeAllRanges());
  selectText('p1', 6, 3);
  const was = expectedRect(rig.layerEl.querySelector('#d1'));
  await frames(2);
  rig.sink.clear();
  getSelection().removeAllRanges();
  await frames(2);
  const got = selectionDamage(rig);
  assert.equal(got.length, 1, `damage: ${rig.sink.causes()}`);
  assert.equal(got[0].drawable.id, 'd1');
  assert.deepEqual(rect(got[0].rect), rect(was));
  rig.sink.clear();
  getSelection().collapse(document.body, 0);
  await frames(2);
  assert.equal(selectionDamage(rig).length, 0, 'nothing of the canvas was or is selected: no damage');
});

test('moving the selection damages the old and the new highlight; a selection across two drawables damages both', async t => {
  const rig = createRig({ html: TEXT });
  t.cleanup(observeInput(rig.env, rig.record));
  t.cleanup(() => getSelection().removeAllRanges());
  selectText('p1', 0, 5);
  const first = expectedRect(rig.layerEl.querySelector('#d1'));
  await frames(2);
  rig.sink.clear();
  selectText('p2', 0, 6);
  const second = expectedRect(rig.layerEl.querySelector('#d1'));
  await frames(2);
  const got = selectionDamage(rig);
  assert.equal(got.length, 1);
  const r = rect(got[0].rect);
  assert.ok(r.y <= Math.round(first.y) && r.y + r.height >= Math.round(second.y + second.height) - 1, `the damage ${JSON.stringify(r)} covers the old ${JSON.stringify(rect(first))} and the new ${JSON.stringify(rect(second))} word`);
  rig.sink.clear();
  getSelection().setBaseAndExtent(document.getElementById('p1').firstChild, 0, document.getElementById('p3').firstChild, 5);
  await frames(2);
  assert.deepEqual(selectionDamage(rig).map((d) => d.drawable.id).sort(), ['d1', 'd2']);
});

test('after the selected text moved, deselection damages where it is drawn now (the old range follows the layout)', async t => {
  const rig = createRig({ html: TEXT });
  t.cleanup(observeInput(rig.env, rig.record));
  t.cleanup(() => getSelection().removeAllRanges());
  selectText('p2', 0, 6);
  await frames(2);
  /** @type {HTMLElement} */ (rig.layerEl.querySelector('#p2')).style.marginTop = '60px';
  const now = expectedRect(rig.layerEl.querySelector('#d1'));
  rig.sink.clear();
  getSelection().removeAllRanges();
  await frames(2);
  const got = selectionDamage(rig);
  assert.equal(got.length, 1);
  const r = rect(got[0].rect);
  assert.ok(r.y + r.height >= Math.round(now.y + now.height) - 1, `the damage ${JSON.stringify(r)} reaches the moved highlight ${JSON.stringify(rect(now))}`);
});

test('a selection outside the layer, and any selection after the observer is disposed, cause no damage', async t => {
  const rig = createRig({ html: TEXT });
  const outside = fixture('<p id="outside">Outside the canvas</p>').querySelector('#outside');
  const stop = observeInput(rig.env, rig.record);
  t.cleanup(() => getSelection().removeAllRanges());
  getSelection().setBaseAndExtent(outside.firstChild, 0, outside.firstChild, 7);
  await frames(2);
  assert.equal(selectionDamage(rig).length, 0);
  stop();
  selectText('p1', 0, 5);
  await frames(2);
  assert.equal(selectionDamage(rig).length, 0);
});

test('events outside the layer are ignored; the disposer removes the listeners', async t => {
  const rig = createRig({ html: FORM });
  const stop = observeInput(rig.env, rig.record);
  document.body.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(rig.sink.damage.length, 0);
  stop();
  rig.layerEl.querySelector('#in').dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(rig.sink.damage.length, 0);
});

test('scroll inside a drawable damages the scroller box in the drawable frame', async t => {
  const rig = createRig({ html: FORM });
  t.cleanup(observeScroll(rig.env, rig.record));
  const sc = rig.layerEl.querySelector('#sc');
  sc.scrollTop = 50;
  await frames(2);
  assert.equal(rig.sink.damage.length, 1);
  const d = rig.sink.damage[0];
  assert.equal(d.cause, 'scroll');
  assert.equal(d.drawable.id, 'd');
  assert.deepEqual(rect(d.rect), rect(rig.layer.frameRect(sc)));
});

test('the pointer entering a scroller inside a drawable asks the compositor to plan it and wakes the scheduler (its plan and pages are built before the first scroll)', async t => {
  const rig = createRig({ html: FORM });
  /** @type {Element[]} */
  const seen = [];
  rig.env.store.scrollSettled = (drawable, el) => { seen.push(el); };
  rig.layer.syncScroll ??= () => {};
  t.cleanup(observeScroll(rig.env, rig.record));
  const sc = rig.layerEl.querySelector('#sc');
  const wakes = rig.sink.wakes;
  sc.firstElementChild.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  assert.deepEqual(seen, [sc], 'the scroller under the pointer is prepared');
  assert.ok(rig.sink.wakes > wakes, 'the post-frame pump that builds the plan runs in the next frame');
  const again = rig.sink.wakes;
  sc.firstElementChild.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  assert.equal(seen.length, 1, 'a scroller already under the pointer is not prepared again');
  assert.equal(rig.sink.wakes, again, 'and wakes nothing');
  rig.layerEl.querySelector('#b').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  assert.equal(rig.sink.wakes, again, 'the pointer over no scroller wakes nothing');
  sc.firstElementChild.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'touch' }));
  assert.deepEqual(seen, [sc, sc], 'a finger landing on the scroller prepares it too');
  assert.equal(rig.sink.wakes, again, 'but wakes nothing: its gesture follows at once, and builds woken at touchstart delayed its first step');
});

/** `(pointer: coarse)` matches (a touch-first device) until the cleanup */
function touchFirst(t) {
  const own = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  const real = window.matchMedia.bind(window);
  window.matchMedia = (q) => (q === '(pointer: coarse)' ? /** @type {any} */ ({ matches: true, media: q }) : real(q));
  t.cleanup(() => { if (own) Object.defineProperty(window, 'matchMedia', own); else delete window.matchMedia; });
}

test('on a touch-first device the scrollers are planned ahead once the canvas is quiet: WARM_MS after its last commit, once per burst of commits', async t => {
  touchFirst(t);
  const rig = createRig({ html: FORM });
  let warms = 0, queued = true;
  rig.env.store.scrollWarm = (record) => { assert.equal(record, rig.record); warms++; return queued; };
  const stop = observeScroll(rig.env, rig.record);
  t.cleanup(stop);
  const wakes = rig.sink.wakes;
  rig.bus.emit(BUS.COMMIT, { record: rig.record, changed: [], removed: [] });
  await sleep(100);
  rig.bus.emit(BUS.COMMIT, { record: rig.record, changed: [], removed: [] });
  rig.bus.emit(BUS.COMMIT, { record: { id: 'other' }, changed: [], removed: [] });
  await sleep(150);
  assert.equal(warms, 0, 'not while commits keep coming');
  await sleep(250);
  assert.equal(warms, 1, 'once, after the last commit');
  assert.equal(rig.sink.wakes, wakes + 1, 'its plan and pages are side builds of the post-frame pump: the scheduler is woken');
  await sleep(400);
  assert.equal(warms, 1, 'and nothing more while the page stays quiet (no timer, no frame)');
  queued = false;
  rig.bus.emit(BUS.COMMIT, { record: rig.record, changed: [], removed: [] });
  await sleep(400);
  assert.equal(warms, 2);
  assert.equal(rig.sink.wakes, wakes + 1, 'nothing queued: nothing woken');
  stop();
  rig.bus.emit(BUS.COMMIT, { record: rig.record, changed: [], removed: [] });
  await sleep(400);
  assert.equal(warms, 2, 'disposed: no timer');
});

test('on a device whose primary pointer is fine (a mouse) nothing is planned ahead: the pointer reaching a scroller plans it before its gesture', async t => {
  const rig = createRig({ html: FORM });
  let warms = 0;
  rig.env.store.scrollWarm = () => { warms++; return true; };
  t.cleanup(observeScroll(rig.env, rig.record));
  rig.bus.emit(BUS.COMMIT, { record: rig.record, changed: [], removed: [] });
  await sleep(400);
  assert.equal(warms, window.matchMedia('(pointer: coarse)').matches ? 1 : 0);
});

test('scroll of the layer itself (not inside a drawable) damages the whole canvas', async t => {
  const rig = createRig({ html: FORM });
  rig.layerEl.style.overflow = 'auto';
  rig.layerEl.style.height = '30px';
  t.cleanup(observeScroll(rig.env, rig.record));
  rig.layerEl.scrollTop = 20;
  await frames(2);
  const d = rig.sink.damage.find(x => x.drawable === null);
  assert.ok(d && d.rect === null && d.cause === 'scroll');
});

test('canvas resize: content box updated synchronously, BUS.RESIZE once, resize damage, no clone work', async t => {
  const rig = createRig({ html: FORM });
  const events = [];
  rig.bus.on(BUS.RESIZE, e => events.push(e));
  t.cleanup(observeCanvasResize(rig.env, rig.record));
  await frames(2);
  assert.equal(events.length, 0, 'the initial observation changes nothing');
  rig.canvas.style.width = '300px';
  await frames(3);
  assert.equal(events.length, 1);
  assert.equal(rig.record.contentBox.width, 300);
  assert.equal(events[0].previous.width, 200);
  assert.deepEqual(rig.sink.causes(), ['resize']);
});

test('canvas resize: the live geometry offsets are re-measured (a drawable centred by auto margins moved while the drawn matrix did not)', async t => {
  const rig = createRig({ html: FORM });
  t.cleanup(observeCanvasResize(rig.env, rig.record));
  await frames(2);
  assert.equal(rig.layer.revalidations, 0, 'the initial observation changes nothing');
  rig.canvas.style.width = '300px';
  await frames(3);
  assert.equal(rig.layer.revalidations, 1);
  await frames(5);
  assert.equal(rig.layer.revalidations, 1, 'nothing more while idle');
});

test('canvas resize announced by the layer itself (a width/height write) is re-measured too', async t => {
  const rig = createRig({ html: FORM });
  const real = rig.layer.syncPresentation;
  rig.layer.syncPresentation = () => {
    const box = real();
    if (box.width !== rig.record.contentBox.width) {
      const previous = rig.record.contentBox;
      rig.record.contentBox = box;
      rig.bus.emit(BUS.RESIZE, { record: rig.record, contentBox: box, previous });
    }
    return box;
  };
  t.cleanup(observeCanvasResize(rig.env, rig.record));
  await frames(2);
  rig.canvas.style.width = '320px';
  await frames(3);
  assert.equal(rig.layer.revalidations, 1);
});

test('canvas resize: when the layer already announced the change during syncPresentation the observer does not announce it twice', async t => {
  const rig = createRig({ html: FORM });
  const events = [];
  rig.bus.on(BUS.RESIZE, e => events.push(e));
  const real = rig.layer.syncPresentation;
  rig.layer.syncPresentation = () => {
    const box = real();
    if (box.width !== rig.record.contentBox.width || box.height !== rig.record.contentBox.height) {
      const previous = rig.record.contentBox;
      rig.record.contentBox = box;
      rig.bus.emit(BUS.RESIZE, { record: rig.record, contentBox: box, previous });
    }
    return box;
  };
  t.cleanup(observeCanvasResize(rig.env, rig.record));
  await frames(2);
  events.length = 0;
  rig.canvas.style.height = '150px';
  await frames(3);
  assert.equal(events.length, 1);
  assert.equal(rig.record.contentBox.height, 150);
});

test('canvas attribute and style changes that do not change the box still re-sync the presentation; polyfill attributes do not', async t => {
  const rig = createRig({ html: FORM });
  t.cleanup(observeCanvasResize(rig.env, rig.record));
  await frames(2);
  const base = rig.layer.syncCalls;
  rig.canvas.setAttribute('data-hic-canvas', '1');
  rig.canvas.setAttribute('framecap', '30');
  rig.canvas.setAttribute('aria-owns', 'x');
  await microtasks();
  assert.equal(rig.layer.syncCalls, base);
  rig.canvas.style.border = '4px solid red';
  await microtasks();
  assert.ok(rig.layer.syncCalls > base);
});

test('no idle timer; a window resize, a class change outside the layer, a stylesheet epoch and hover / focus-within on an ancestor each re-sync the presentation (next frame); changes inside the layer and an unmounted layer do not', async t => {
  const rig = createRig({ html: FORM });
  t.cleanup(observeCanvasResize(rig.env, rig.record));
  await frames(2);
  const base = rig.layer.syncCalls;
  await sleep(1200);
  assert.equal(rig.layer.syncCalls, base, 'idle: nothing runs');
  const count = async (what, fn) => { const n = rig.layer.syncCalls; fn(); await frames(2); assert.ok(rig.layer.syncCalls > n, what); };
  {
    const n = rig.layer.syncCalls;
    window.dispatchEvent(new Event('resize'));
    await frames(2);
    assert.equal(rig.layer.syncCalls, n, 'a window resize is re-checked only once it settled');
    await sleep(160);
    await frames(1);
    assert.ok(rig.layer.syncCalls > n, 'window resize, settled');
  }
  const outside = document.createElement('div');
  document.body.append(outside);
  t.cleanup(() => outside.remove());
  await frames(2);
  await count('a class change outside the canvas (sibling selectors, :has)', () => outside.classList.add('theme-x'));
  await count('a stylesheet epoch', () => rig.bus.emit(BUS.DAMAGE, { record: rig.record, cause: 'stylesheet', drawable: null, rect: null }));
  const ancestor = rig.canvas.parentElement;
  await count('the pointer entering an ancestor of the canvas (:hover)', () => ancestor.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, relatedTarget: document.body })));
  const before = rig.layer.syncCalls;
  rig.layerEl.firstElementChild?.setAttribute('data-x', '1');
  outside.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, relatedTarget: document.body }));
  await frames(2);
  assert.equal(rig.layer.syncCalls, before, 'a mutation inside the layer and a pointer that does not cross an ancestor boundary do not re-sync');
  rig.layer.mounted = false;
  const n = rig.layer.syncCalls;
  window.dispatchEvent(new Event('resize'));
  await sleep(160);
  await frames(2);
  assert.equal(rig.layer.syncCalls, n, 'an unmounted layer is skipped');
});

test('framecap attribute: parsed per API-CONTRACT 7.1, invalid or removed -> defaultFrameCap, applied once at start', async t => {
  const rig = createRig({ html: FORM, canvasAttrs: 'framecap="30"', options: { defaultFrameCap: 5 } });
  t.cleanup(observeFrameCap(rig.env, rig.record));
  assert.deepEqual(rig.sink.caps, [30]);
  rig.canvas.setAttribute('framecap', '60');
  await microtasks();
  rig.canvas.setAttribute('framecap', 'fast');
  await microtasks();
  rig.canvas.removeAttribute('framecap');
  await microtasks();
  rig.canvas.setAttribute('framecap', '99999');
  await microtasks();
  assert.deepEqual(rig.sink.caps, [30, 60, 5, 5, 240]);
});

function fakeDprWindow() {
  const listeners = new Map();
  const queries = [];
  const win = {
    devicePixelRatio: 2,
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
    matchMedia(q) {
      const mql = { q, fn: null, addEventListener(_t, fn) { mql.fn = fn; }, removeEventListener() { mql.fn = null; } };
      queries.push(mql);
      return mql;
    },
  };
  return { win, listeners, queries };
}

test('DPR change: zoom (window resize) and monitor move (media query) update record.dpr, emit BUS.DPR once and damage every canvas', async t => {
  const rig = createRig({ html: FORM });
  const f = fakeDprWindow();
  rig.env.window = f.win;
  const events = [];
  rig.bus.on(BUS.DPR, e => events.push(e.dpr));
  t.cleanup(observeDpr(rig.env));
  assert.equal(f.queries.at(-1).q, '(resolution: 2dppx)');
  f.listeners.get('resize')();
  assert.equal(events.length, 0, 'no change, no event');
  f.win.devicePixelRatio = 1.5;
  f.listeners.get('resize')();
  assert.deepEqual(events, [1.5]);
  assert.equal(rig.record.dpr, 1.5);
  assert.deepEqual(rig.sink.damage.map(d => [d.cause, d.drawable, d.rect]), [['dpr', null, null]]);
  assert.equal(f.queries.at(-1).q, '(resolution: 1.5dppx)', 're-armed on the new ratio');
  f.win.devicePixelRatio = 1;
  f.queries.at(-1).fn();
  assert.deepEqual(events, [1.5, 1]);
  f.listeners.get('resize')();
  assert.deepEqual(events, [1.5, 1], 'the resize that follows the same change is not a second change');
});

test('while the overlay serves a field, its edits wait for a typing pause (one damage after 150 ms, not one per key); caret keys and real selections stay immediate', async t => {
  const rig = createRig({ html: FORM });
  let ok = false;
  rig.env.store.overlayText = () => ok;
  t.cleanup(observeInput(rig.env, rig.record));
  const input = rig.layerEl.querySelector('input');
  input.focus();
  input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  assert.equal(rig.sink.damage.length, 1, 'overlay not known to work: damaged at once');
  rig.sink.clear();
  ok = true;
  for (let i = 0; i < 3; i++) {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }
  assert.equal(rig.sink.damage.length, 1, 'deferred while typing: only the keydown that opened the burst (before any deferral existed) damaged');
  assert.ok(rig.sink.wakes > 0, 'the scheduler is woken for the overlay');
  rig.sink.clear();
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(rig.sink.damage.length, 1, 'a caret key is damaged at once');
  rig.sink.clear();
  await sleep(220);
  assert.equal(rig.sink.damage.length, 1, 'one damage once the typing paused');
  rig.sink.clear();
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
  assert.equal(rig.sink.damage.length, 0, 'the first key after a pause is served by its input event (the overlay worked), no build of its own');
  ok = false;
  input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  rig.sink.clear();
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
  assert.equal(rig.sink.damage.length, 1, 'once the overlay was refused, keys are damaged again');
});

test('a field scrolled by its own deferred typing is re-drawn by the overlay (no scroll build per key); other scrolls of it are damaged', async t => {
  const rig = createRig({ html: FORM });
  let asked = 0;
  rig.env.store.overlayText = () => { asked++; return true; };
  t.cleanup(observeInput(rig.env, rig.record));
  t.cleanup(observeScroll(rig.env, rig.record));
  const input = rig.layerEl.querySelector('input');
  input.focus();
  input.dispatchEvent(new Event('scroll'));
  assert.equal(rig.sink.damage.filter((d) => d.cause === 'scroll').length, 1, 'no typing: the scroll is damaged');
  rig.sink.clear();
  input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  const before = asked;
  input.dispatchEvent(new Event('scroll'));
  assert.equal(rig.sink.damage.filter((d) => d.cause === 'scroll').length, 0, 'typing deferred: no scroll damage');
  assert.equal(asked, before + 1, 'the overlay is asked again at the new offset');
  await sleep(220);
  rig.sink.clear();
  input.dispatchEvent(new Event('scroll'));
  assert.equal(rig.sink.damage.filter((d) => d.cause === 'scroll').length, 1, 'after the typing pause a scroll is damaged again');
});
