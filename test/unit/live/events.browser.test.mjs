import { test, assert } from '/test/unit/lib/t.js';
import { setup, page } from '/test/unit/live/lib.mjs';

// references to the native methods taken before anything else runs, as a library loaded before the polyfill keeps them
const NATIVE_PREVENT = Event.prototype.preventDefault;
const NATIVE_RETURN_VALUE_SET = /** @type {(this: Event, v: boolean) => void} */ (Object.getOwnPropertyDescriptor(Event.prototype, 'returnValue')?.set);

const KIDS = '<button id="btn">go</button><div id="d" drawable><span id="in">x</span></div>';

test('canvas listeners receive events of relocated descendants with currentTarget and composedPath of the canvas', async (t) => {
  const { managed } = setup({ t });
  const { canvas, root } = page(KIDS);
  const r = managed(canvas);
  const log = [];
  canvas.addEventListener('click', function (ev) {
    log.push({ phase: ev.eventPhase, target: ev.target.id, current: ev.currentTarget, self: this, path: ev.composedPath() });
  });
  const rootSeen = [];
  root.addEventListener('click', (ev) => rootSeen.push(ev.composedPath()));
  canvas.querySelector('#in').click();
  assert.equal(log.length, 1);
  assert.equal(log[0].target, 'in');
  assert.equal(log[0].current, canvas);
  assert.equal(log[0].self, canvas);
  assert.ok(log[0].path.includes(canvas) && !log[0].path.includes(r.layer.element), 'layer replaced by the canvas');
  assert.ok(rootSeen[0].includes(canvas) && !rootSeen[0].includes(r.layer.element), 'later listeners see the canvas too');
  assert.equal(Object.getOwnPropertyDescriptor(Event.prototype, 'currentTarget').get.call(new Event('x')), null);
  canvas.click();
  assert.equal(log.length, 2, 'events aimed at the canvas itself still arrive once');
});

test('capture, once, removeEventListener, signal and stopImmediatePropagation', async (t) => {
  const { managed } = setup({ t });
  const { canvas } = page(KIDS);
  managed(canvas);
  const order = [];
  canvas.addEventListener('click', () => order.push('capture'), true);
  canvas.addEventListener('click', () => order.push('bubble'));
  canvas.querySelector('#btn').addEventListener('click', () => order.push('target'));
  canvas.querySelector('#btn').click();
  assert.deepEqual(order, ['capture', 'target', 'bubble']);

  let once = 0;
  canvas.addEventListener('keydown', () => once++, { once: true });
  const kd = () => canvas.querySelector('#btn').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
  kd(); kd();
  assert.equal(once, 1);

  let removed = 0;
  const fn = () => removed++;
  canvas.addEventListener('input', fn);
  canvas.removeEventListener('input', fn);
  canvas.querySelector('#btn').dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(removed, 0);

  const ac = new AbortController();
  let aborted = 0;
  canvas.addEventListener('change', () => aborted++, { signal: ac.signal });
  const change = () => canvas.querySelector('#btn').dispatchEvent(new Event('change', { bubbles: true }));
  change(); ac.abort(); change();
  assert.equal(aborted, 1);

  const stops = [];
  canvas.addEventListener('focusin', (e) => { stops.push(1); e.stopImmediatePropagation(); });
  canvas.addEventListener('focusin', () => stops.push(2));
  canvas.querySelector('#btn').dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  assert.deepEqual(stops, [1]);

  let dup = 0;
  const same = () => dup++;
  canvas.addEventListener('pointerup', same);
  canvas.addEventListener('pointerup', same);
  canvas.querySelector('#btn').dispatchEvent(new Event('pointerup', { bubbles: true }));
  assert.equal(dup, 1, 'the same listener registered twice runs once');

  let objectCalls = 0;
  canvas.addEventListener('dblclick', { handleEvent(ev) { objectCalls += ev.currentTarget === canvas ? 1 : 0; } });
  canvas.querySelector('#btn').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  assert.equal(objectCalls, 1);
});

test('on* handler properties of the canvas see descendant events', async (t) => {
  const { managed } = setup({ t });
  const { canvas } = page(KIDS);
  managed(canvas);
  const calls = [];
  canvas.onclick = function (ev) { calls.push([this === canvas, ev.currentTarget === canvas, ev.target.id]); };
  assert.equal(typeof canvas.onclick, 'function');
  canvas.querySelector('#in').click();
  canvas.click();
  assert.deepEqual(calls, [[true, true, 'in'], [true, true, 'c']]);
  canvas.onclick = null;
  canvas.querySelector('#in').click();
  assert.equal(calls.length, 2);
});

test('inline on* attribute handlers and listeners survive an unmount/mount cycle', async (t) => {
  const { managed } = setup({ t });
  const { canvas } = page(KIDS);
  window.__inline = 0;
  canvas.setAttribute('onclick', 'window.__inline++');
  const r = managed(canvas);
  t.cleanup(() => { delete window.__inline; });
  let n = 0;
  canvas.addEventListener('click', () => n++);
  canvas.querySelector('#in').click();
  assert.equal(n, 1);
  assert.equal(window.__inline, 1, 'attribute handler present at mount is bridged');
  r.layer.unmount();
  canvas.querySelector('#in').click();
  assert.equal(n, 2, 'natively registered listener is back on the real ancestor');
  r.layer.mount();
  canvas.querySelector('#in').click();
  assert.equal(n, 3);
  assert.equal(Object.hasOwn(canvas, 'addEventListener'), true);
  r.layer.unmount();
  assert.equal(Object.hasOwn(canvas, 'addEventListener'), false);
});

test('after an unmount/mount cycle the canvas listeners still run in their registration order, each with its passive flag', async (t) => {
  const { managed } = setup({ t });
  const { canvas } = page(KIDS);
  const r = managed(canvas);
  const inner = /** @type {Element} */ (canvas.querySelector('#in'));
  /** @type {string[]} */ const log = [];
  canvas.addEventListener('touchstart', () => log.push('1 active'));
  canvas.addEventListener('touchstart', (ev) => { log.push('2 passive'); ev.preventDefault(); }, { passive: true });
  canvas.addEventListener('touchstart', () => log.push('3 active'));
  r.layer.unmount();
  r.layer.mount();
  const ev = new Event('touchstart', { bubbles: true, cancelable: true });
  inner.dispatchEvent(ev);
  assert.deepEqual(log, ['1 active', '2 passive', '3 active']);
  assert.equal(ev.defaultPrevented, false, 'the passive one is still passive');
});

test('bridge does not double deliver or swallow errors', async (t) => {
  const { managed } = setup({ t });
  const { canvas } = page(KIDS);
  managed(canvas);
  let n = 0;
  canvas.addEventListener('click', () => n++);
  const errors = [];
  const original = window.reportError;
  window.reportError = (e) => errors.push(e.message);
  t.cleanup(() => { window.reportError = original; });
  canvas.addEventListener('click', () => { throw new Error('listener boom'); });
  canvas.addEventListener('click', () => n++);
  canvas.querySelector('#in').click();
  assert.equal(n, 2, 'a throwing listener does not stop the next one');
  assert.deepEqual(errors, ['listener boom']);
});

/** The layer's own forwarders: its addEventListener / removeEventListener calls from now on, per type. @param {any} layerEl */
function spyForwarders(layerEl) {
  /** @type {{op: string, type: string, passive: boolean|undefined, capture: boolean}[]} */ const calls = [];
  const add = layerEl.addEventListener, rem = layerEl.removeEventListener;
  layerEl.addEventListener = function (/** @type {string} */ type, /** @type {any} */ fn, /** @type {any} */ o) { calls.push({ op: 'add', type, passive: typeof o === 'object' ? o.passive : undefined, capture: typeof o === 'object' ? !!o.capture : !!o }); return add.call(this, type, fn, o); };
  layerEl.removeEventListener = function (/** @type {string} */ type, /** @type {any} */ fn, /** @type {any} */ o) { calls.push({ op: 'remove', type, passive: undefined, capture: typeof o === 'object' ? !!o.capture : !!o }); return rem.call(this, type, fn, o); };
  /** the forwarders of `type` registered now: adds minus removes */
  const live = (/** @type {string} */ type) => calls.filter((c) => c.type === type).reduce((n, c) => n + (c.op === 'add' ? 1 : -1), 0);
  return { calls, live, restore: () => { delete layerEl.addEventListener; delete layerEl.removeEventListener; } };
}

/** A cancelable touchstart (or wheel) dispatched at a descendant of the canvas; true when a listener prevented its default. @param {Element} el @param {string} type */
function prevented(el, type = 'touchstart') {
  const ev = type === 'wheel' ? new WheelEvent('wheel', { bubbles: true, cancelable: true }) : new Event(type, { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
}

test('every canvas listener has its own forwarder on the layer, exactly as passive as the listener: a passive touch listener gives a passive one (its preventDefault ignored, as natively); a non-passive one adds a non-passive one (preventDefault works), and removing it removes its forwarder only; capture and once keep working', async (t) => {
  const { managed } = setup({ t });
  const { canvas } = page(KIDS);
  const r = managed(canvas);
  const spy = spyForwarders(r.layer.element);
  t.cleanup(spy.restore);
  const inner = /** @type {Element} */ (canvas.querySelector('#in'));
  const seen = [];
  const passiveOne = (/** @type {Event} */ ev) => { seen.push('passive'); ev.preventDefault(); };
  canvas.addEventListener('touchstart', passiveOne, { passive: true });
  assert.deepEqual(spy.calls.map((c) => [c.op, c.type, c.passive]), [['add', 'touchstart', true]], 'a passive canvas listener: a passive forwarder');
  assert.equal(prevented(inner), false, 'its preventDefault is ignored, as for a passive listener natively');
  const active = (/** @type {Event} */ ev) => { seen.push('active'); ev.preventDefault(); };
  canvas.addEventListener('touchstart', active);
  assert.equal(spy.live('touchstart'), 2, 'one forwarder per listener');
  assert.deepEqual(spy.calls.at(-1), { op: 'add', type: 'touchstart', passive: false, capture: false }, 'a listener with passive left out (the canvas is not the window, document or body: false there) gets a non-passive one');
  assert.equal(prevented(inner), true, 'and preventDefault from the non-passive canvas listener works');
  canvas.removeEventListener('touchstart', active);
  assert.equal(spy.live('touchstart'), 1, 'removing it removes its forwarder');
  assert.equal(spy.calls.at(-1)?.op, 'remove');
  assert.equal(prevented(inner), false, 'the passive one is left, passive');
  canvas.addEventListener('touchstart', () => seen.push('second passive'), { passive: true });
  assert.deepEqual(spy.calls.at(-1), { op: 'add', type: 'touchstart', passive: true, capture: false }, 'a second passive listener: a second passive forwarder');
  // capture and once, through a passive forwarder of their own
  const order = [];
  canvas.addEventListener('touchmove', () => order.push('capture'), { capture: true, passive: true });
  canvas.addEventListener('touchmove', () => order.push('bubble'), { passive: true });
  canvas.addEventListener('touchmove', () => order.push('once'), { passive: true, once: true });
  inner.addEventListener('touchmove', () => order.push('target'));
  inner.dispatchEvent(new Event('touchmove', { bubbles: true, cancelable: true }));
  inner.dispatchEvent(new Event('touchmove', { bubbles: true, cancelable: true }));
  assert.deepEqual(order, ['capture', 'target', 'bubble', 'once', 'capture', 'target', 'bubble']);
  assert.ok(spy.calls.filter((c) => c.type === 'touchmove' && c.op === 'add').every((c) => c.passive === true), 'the touchmove forwarders (capture and bubble) are passive');
  assert.equal(prevented(inner), false, 'two passive listeners: still passive');
  canvas.removeEventListener('touchstart', passiveOne, { passive: true });
  assert.ok(seen.includes('passive') && seen.includes('active') && seen.includes('second passive'));
});

test('a passive canvas listener next to a non-passive one that cancels nothing cannot cancel, as on a native element: preventDefault(), Event.prototype.preventDefault.call, returnValue = false and the native method or setter saved before the polyfill ran are ignored in either order, capture and bubble, for a handleEvent object and a once listener; the non-passive one still cancels, an event dispatched from inside the passive listener stays cancelable, and the Event prototype is left as it was', async (t) => {
  const { managed } = setup({ t });
  const { canvas } = page(KIDS);
  managed(canvas);
  const inner = /** @type {Element} */ (canvas.querySelector('#in'));
  const proto = Object.getOwnPropertyDescriptors(Event.prototype);
  /** @type {Record<string, (ev: Event) => void>} */
  const tries = {
    method: (ev) => ev.preventDefault(),
    prototype: (ev) => Event.prototype.preventDefault.call(ev),
    returnValue: (ev) => { ev.returnValue = false; },
    savedMethod: (ev) => NATIVE_PREVENT.call(ev),
    savedSetter: (ev) => NATIVE_RETURN_VALUE_SET.call(ev, false),
  };
  /** the same listeners on a native element and on the canvas: whether the event was cancelled, and what defaultPrevented read inside the passive listener @param {EventTarget} target @param {Element} at @param {{type: string, capture: boolean, first: 'passive'|'active', how: string, object?: boolean, once?: boolean, activeCancels?: boolean}} c */
  const run = (target, at, c) => {
    let inside = null;
    const passiveFn = (/** @type {Event} */ ev) => { tries[c.how](ev); inside = ev.defaultPrevented; };
    const passive = c.object ? { handleEvent: passiveFn } : passiveFn;
    const active = (/** @type {Event} */ ev) => { if (c.activeCancels) ev.preventDefault(); };
    const add = { passive: () => target.addEventListener(c.type, passive, { capture: c.capture, passive: true, once: c.once }), active: () => target.addEventListener(c.type, active, c.capture) };
    if (c.first === 'passive') { add.passive(); add.active(); } else { add.active(); add.passive(); }
    const cancelled = prevented(at, c.type);
    target.removeEventListener(c.type, passive, c.capture);
    target.removeEventListener(c.type, active, c.capture);
    return { cancelled, inside };
  };
  const ref = document.createElement('div');
  const refChild = ref.appendChild(document.createElement('span'));
  document.body.append(ref);
  t.cleanup(() => ref.remove());
  const cases = [];
  for (const type of ['touchstart', 'wheel', 'click']) for (const capture of [false, true]) for (const first of /** @type {const} */ (['passive', 'active'])) for (const how of Object.keys(tries)) cases.push({ type, capture, first, how });
  cases.push({ type: 'touchstart', capture: false, first: 'active', how: 'method', object: true }, { type: 'wheel', capture: true, first: 'passive', how: 'method', once: true });
  for (const c of cases) {
    const native = run(ref, refChild, c);
    assert.deepEqual(native, { cancelled: false, inside: false }, `native reference ${JSON.stringify(c)}`);
    assert.deepEqual(run(canvas, inner, c), native, `canvas ${JSON.stringify(c)}`);
  }
  for (const first of /** @type {const} */ (['passive', 'active'])) {
    const c = { type: 'touchstart', capture: false, first, how: 'method', activeCancels: true };
    assert.deepEqual(run(canvas, inner, c), run(ref, refChild, c), `the non-passive listener cancels (${first} first)`);
    assert.equal(run(canvas, inner, c).cancelled, true);
  }
  // an event dispatched synchronously from inside the passive listener keeps its own cancelability
  let nested = null;
  const passiveOuter = () => {
    const ev = new Event('keydown', { cancelable: true });
    inner.addEventListener('keydown', (e) => e.preventDefault(), { once: true });
    inner.dispatchEvent(ev);
    nested = ev.defaultPrevented;
  };
  const harmless = () => {};
  canvas.addEventListener('touchstart', passiveOuter, { passive: true });
  canvas.addEventListener('touchstart', harmless);
  assert.equal(prevented(inner), false);
  assert.equal(nested, true, 'the nested event was cancelled');
  canvas.removeEventListener('touchstart', passiveOuter);
  canvas.removeEventListener('touchstart', harmless);
  for (const name of ['preventDefault', 'returnValue']) assert.deepEqual(Object.getOwnPropertyDescriptor(Event.prototype, name), proto[name], `Event.prototype.${name} restored`);
  const plain = new Event('x', { cancelable: true });
  plain.preventDefault();
  assert.equal(plain.defaultPrevented, true, 'outside a listener preventDefault works as before');
});

test('mixed passive and non-passive canvas listeners run in the native order; stopImmediatePropagation in a passive one stops the later ones; a later one removed during the dispatch does not run; on a native element the same', async (t) => {
  const { managed } = setup({ t });
  const { canvas } = page(KIDS);
  managed(canvas);
  const inner = /** @type {Element} */ (canvas.querySelector('#in'));
  const ref = document.createElement('div');
  const refChild = ref.appendChild(document.createElement('span'));
  document.body.append(ref);
  t.cleanup(() => ref.remove());
  /** the order in which four listeners (active, passive, passive, active) ran @param {EventTarget} target @param {Element} at @param {'order'|'stop'|'remove'} mode */
  const run = (target, at, mode) => {
    /** @type {string[]} */ const log = [];
    const ev = new Event('touchstart', { bubbles: true, cancelable: true });
    const c = () => log.push('c passive');
    const a = () => { log.push('a passive'); if (mode === 'stop') ev.stopImmediatePropagation(); if (mode === 'remove') target.removeEventListener('touchstart', c); };
    const b = () => log.push('b active');
    const d = () => log.push('d active');
    target.addEventListener('touchstart', b);
    target.addEventListener('touchstart', a, { passive: true });
    target.addEventListener('touchstart', c, { passive: true });
    target.addEventListener('touchstart', d);
    at.dispatchEvent(ev);
    for (const fn of [a, b, c, d]) target.removeEventListener('touchstart', fn);
    return log;
  };
  for (const mode of /** @type {const} */ (['order', 'stop', 'remove'])) {
    const native = run(ref, refChild, mode);
    assert.ok(native.length >= 2, `native reference ${mode}: ${native}`);
    assert.deepEqual(run(canvas, inner, mode), native, mode);
  }
});
