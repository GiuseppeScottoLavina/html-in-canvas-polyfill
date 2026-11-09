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
  // the bridge's methods stay while the canvas is managed, mounted or not (a listener added or removed while unmounted is seen); a dispose restores them
  assert.equal(Object.hasOwn(canvas, 'addEventListener'), true, 'still bridged while unmounted');
  r.layer.dispose();
  assert.equal(Object.hasOwn(canvas, 'addEventListener'), false, 'restored by the dispose');
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

test('a registration ends on the current mount, whichever mount made it: abort, removeEventListener and once after unmount/mount cycles leave no call and no forwarder on the layer; a new registration of the same function is called once and ended by its own signal only', async (t) => {
  const { managed } = setup({ t });
  const { canvas } = page(KIDS);
  const r = managed(canvas);
  const inner = /** @type {Element} */ (canvas.querySelector('#in'));
  const layer = /** @type {any} */ (r.layer.element);
  const spy = spyForwarders(layer);
  t.cleanup(spy.restore);
  const fire = (/** @type {string} */ type) => inner.dispatchEvent(new Event(type, { bubbles: true }));
  const cycle = (n = 1) => { for (let i = 0; i < n; i++) { r.layer.unmount(); r.layer.mount(); } };
  /** a counted listener of a fresh type @param {string} type @param {any} [options] */
  const counted = (type, options) => { const c = { n: 0, fn: () => { c.n++; } }; canvas.addEventListener(type, c.fn, options); fire(type); assert.equal(c.n, 1, `${type}: active before the action`); return c; };
  const cases = [
    ['abort on the same mount', (/** @type {AbortController} */ ac) => ac.abort()],
    ['abort while unmounted, then mount', (ac) => { r.layer.unmount(); ac.abort(); r.layer.mount(); }],
    ['abort after a remount', (ac) => { cycle(); ac.abort(); }],
    ['abort after three remounts', (ac) => { cycle(3); ac.abort(); }],
  ];
  for (const [i, [name, act]] of cases.entries()) for (const capture of [false, true]) {
    const type = `x${i}${capture ? 'c' : ''}`;
    const ac = new AbortController();
    const c = counted(type, { signal: ac.signal, capture, passive: true });
    /** @type {any} */ (act)(ac);
    fire(type); cycle(); fire(type);
    assert.equal(c.n, 1, `${name}${capture ? ' (capture)' : ''}: no call after the abort`);
    assert.equal(spy.live(type), 0, `${name}${capture ? ' (capture)' : ''}: no forwarder left on the layer`);
  }
  // removeEventListener and once after a remount
  const rm = counted('xr');
  cycle(); canvas.removeEventListener('xr', rm.fn); fire('xr'); cycle(); fire('xr');
  assert.equal(rm.n, 1, 'removeEventListener after a remount');
  assert.equal(spy.live('xr'), 0);
  let once = 0;
  canvas.addEventListener('xo', () => once++, { once: true });
  cycle(); fire('xo'); fire('xo'); cycle(); fire('xo');
  assert.equal(once, 1, 'once after a remount');
  assert.equal(spy.live('xo'), 0);
  // the same function registered again with a new signal after the first was aborted: one call per event, ended by its own signal; the old signal ends nothing
  const ac1 = new AbortController(), ac2 = new AbortController();
  const again = counted('xa', { signal: ac1.signal });
  cycle(); ac1.abort();
  canvas.addEventListener('xa', again.fn, { signal: ac2.signal });
  fire('xa');
  assert.equal(again.n, 2, 'registered again: exactly one call');
  cycle(); fire('xa');
  assert.equal(again.n, 3, 'still one call after a remount');
  ac2.abort(); fire('xa'); cycle(); fire('xa');
  assert.equal(again.n, 3, 'its own signal ends it');
  assert.equal(spy.live('xa'), 0);
  // a registration ended by removeEventListener takes its abort watcher off its signal, and aborting that signal later ends nothing, not even a new registration
  // of the same function (natively the same)
  const ac3 = new AbortController(), ac4 = new AbortController();
  /** @type {string[]} */ const unwatched = [];
  const sigRemove = ac3.signal.removeEventListener;
  ac3.signal.removeEventListener = function (/** @type {any[]} */ ...args) { unwatched.push(args[0]); return sigRemove.apply(this, /** @type {any} */ (args)); };
  const later = counted('xl', { signal: ac3.signal });
  cycle(); canvas.removeEventListener('xl', later.fn);
  assert.deepEqual(unwatched, ['abort'], 'its abort watcher is removed from the signal');
  canvas.addEventListener('xl', later.fn, { signal: ac4.signal });
  ac3.abort(); fire('xl');
  assert.equal(later.n, 2, 'aborting the old signal does not end the new registration');
  ac4.abort(); fire('xl');
  assert.equal(later.n, 2);
  // control: a remount alone keeps a registration, called once per event
  const kept = counted('xk', { signal: new AbortController().signal });
  cycle(2); fire('xk');
  assert.equal(kept.n, 2, 'a remount without abort keeps exactly one call');
  assert.equal(spy.live('xk'), 1, 'control: the spy sees the forwarder of the current mount');
  r.layer.unmount();
  assert.equal(spy.live('xk'), 0, 'unmount removes the forwarders it registered');
});

test('a once canvas listener runs once across the two routes (an event of a relocated child and one aimed at the canvas, in either order, capture and bubble), as on a native element; a nested dispatch inside it does not run it again; registered again it runs once more', async (t) => {
  const { managed } = setup({ t });
  const { canvas } = page(KIDS);
  managed(canvas);
  const inner = /** @type {Element} */ (canvas.querySelector('#in'));
  const ref = document.createElement('div');
  const refChild = ref.appendChild(document.createElement('span'));
  document.body.append(ref);
  t.cleanup(() => ref.remove());
  /** the calls after each of four dispatches, alternating the routes @param {EventTarget} target @param {Element} child @param {string} type @param {boolean} capture @param {boolean} childFirst */
  const run = (target, child, type, capture, childFirst) => {
    let n = 0;
    target.addEventListener(type, () => { n++; }, { once: true, capture, passive: true });
    /** @type {number[]} */ const seen = [];
    for (let i = 0; i < 4; i++) { const at = (i % 2 === 0) === childFirst ? child : target; at.dispatchEvent(new Event(type, { bubbles: true })); seen.push(n); }
    return seen;
  };
  let k = 0;
  for (const capture of [false, true]) for (const childFirst of [true, false]) {
    const type = `once${k++}`;
    const native = run(ref, refChild, type, capture, childFirst);
    assert.deepEqual(native, [1, 1, 1, 1], `native reference ${type}`);
    assert.deepEqual(run(canvas, inner, type, capture, childFirst), native, `canvas: capture ${capture}, ${childFirst ? 'child' : 'canvas'} first`);
  }
  // a nested dispatch from inside the once listener, by either route, does not run it again
  for (const nestAt of [inner, canvas]) for (const firstAt of [inner, canvas]) {
    let n = 0;
    const type = `oncenest${k++}`;
    canvas.addEventListener(type, () => { n++; nestAt.dispatchEvent(new Event(type, { bubbles: true })); }, { once: true });
    firstAt.dispatchEvent(new Event(type, { bubbles: true }));
    assert.equal(n, 1, `first at ${firstAt === canvas ? 'canvas' : 'child'}, nested at ${nestAt === canvas ? 'canvas' : 'child'}`);
  }
  // the same function registered again after it ran: once more, by either route
  let again = 0;
  const fn = () => { again++; };
  canvas.addEventListener('onceagain', fn, { once: true });
  canvas.dispatchEvent(new Event('onceagain'));
  canvas.addEventListener('onceagain', fn, { once: true });
  inner.dispatchEvent(new Event('onceagain', { bubbles: true }));
  inner.dispatchEvent(new Event('onceagain', { bubbles: true }));
  canvas.dispatchEvent(new Event('onceagain'));
  assert.equal(again, 2);
});

test('a once canvas listener: removeEventListener before it ran leaves no registration on the canvas or the layer; it runs once across an unmount/mount cycle (the canvas route while unmounted, the child route after); a dispose removes the polyfill\'s own listeners from the canvas', async (t) => {
  const { managed } = setup({ t });
  const { canvas } = page(KIDS);
  /** the canvas's native registrations, as the bridge makes them: adds minus removes per function */
  /** @type {Map<any, number>} */ const live = new Map();
  const add = canvas.addEventListener, rem = canvas.removeEventListener;
  canvas.addEventListener = function (/** @type {string} */ type, /** @type {any} */ fn, /** @type {any} */ o) { live.set(fn, (live.get(fn) ?? 0) + 1); return add.call(this, type, fn, o); };
  canvas.removeEventListener = function (/** @type {string} */ type, /** @type {any} */ fn, /** @type {any} */ o) { if (live.has(fn)) live.set(fn, live.get(fn) - 1); return rem.call(this, type, fn, o); };
  t.cleanup(() => { delete canvas.addEventListener; delete canvas.removeEventListener; });
  const r = managed(canvas);
  const inner = /** @type {Element} */ (canvas.querySelector('#in'));
  const spy = spyForwarders(/** @type {any} */ (r.layer.element));
  t.cleanup(spy.restore);
  // the registrations the polyfill made on the canvas for one addEventListener call (a once registration the browser consumed is not removed through the spy,
  // so each step counts only its own)
  /** @param {string} type @param {any} fn @param {any} options */
  const addOwn = (type, fn, options) => { const before = new Set(live.keys()); canvas.addEventListener(type, fn, options); return [...live.keys()].filter((k) => !before.has(k) && k !== fn); };
  const left = (/** @type {any[]} */ fns) => fns.filter((k) => (live.get(k) ?? 0) > 0).length;
  // removed before it ran
  let removed = 0;
  const f = () => { removed++; };
  const fGuards = addOwn('onceremove', f, { once: true });
  assert.equal(left(fGuards), 1, 'control: one guard of the polyfill is on the canvas');
  canvas.removeEventListener('onceremove', f);
  inner.dispatchEvent(new Event('onceremove', { bubbles: true }));
  canvas.dispatchEvent(new Event('onceremove'));
  assert.equal(removed, 0);
  assert.equal(left(fGuards), 0, 'no guard left on the canvas');
  assert.equal(spy.live('onceremove'), 0, 'no forwarder left on the layer');
  // the child route, then the canvas route: the listener's own native registration goes with the guard
  const g = () => {};
  const gGuards = addOwn('oncechild', g, { once: true });
  inner.dispatchEvent(new Event('oncechild', { bubbles: true }));
  assert.equal(live.get(g), 0, 'its native registration is removed');
  assert.equal(left(gGuards), 0, 'and its guard');
  // across an unmount/mount cycle: while unmounted the children are the canvas's own and their events reach it natively
  let cycled = 0;
  canvas.addEventListener('oncecycle', () => { cycled++; }, { once: true });
  r.layer.unmount();
  inner.dispatchEvent(new Event('oncecycle', { bubbles: true }));
  r.layer.mount();
  inner.dispatchEvent(new Event('oncecycle', { bubbles: true }));
  canvas.dispatchEvent(new Event('oncecycle'));
  assert.equal(cycled, 1, 'ran once while unmounted, never again after the mount');
  assert.equal(spy.live('oncecycle'), 0);
  // a dispose (uninstall) leaves no listener of the polyfill on the canvas: the user's own registration stays
  let hCalls = 0;
  const h = () => { hCalls++; };
  const hGuards = addOwn('oncedispose', h, { once: true });
  assert.equal(left(hGuards), 1, 'control: its guard is on the canvas');
  r.layer.dispose();
  assert.equal(left(hGuards), 0, 'no guard after the dispose');
  assert.equal(live.get(h), 1, "the user's own registration is untouched");
  // a reinstall (a new layer for the same canvas) sets the guard again: the once listener, still pending, runs once across the two routes
  const r2 = managed(canvas);
  canvas.dispatchEvent(new Event('oncedispose'));
  /** @type {Element} */ (canvas.querySelector('#in')).dispatchEvent(new Event('oncedispose', { bubbles: true }));
  assert.equal(hCalls, 1, 'after a dispose and a new mount: once, the canvas route first');
  assert.ok(r2.layer);
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
