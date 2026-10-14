// Regression tests of the correctness review (M4, M5, m1, m2, m3, m5, m7, m8): the REAL install in the unit-test page.
import { test, assert } from '/test/unit/lib/t.js';
import { install, getInstalled } from '/src/index.js';
import { installWith } from '/src/api/install.js';
import { defaultServices } from '/src/api/compose.js';
import { inst, mk, sleep, frames, thrown } from './_real.mjs';

/** Counts net event listeners and live intervals created after the call; restore() puts the platform back. */
function leakProbe() {
  const proto = EventTarget.prototype;
  const add = proto.addEventListener;
  const remove = proto.removeEventListener;
  const win = window;
  const [setI, clearI] = [win.setInterval, win.clearInterval];
  /** @type {Map<string, number>} */
  const listeners = new Map();
  const ids = new WeakMap();
  let n = 0;
  const key = (/** @type {any} */ target, /** @type {string} */ type, /** @type {any} */ fn, /** @type {any} */ opts) => {
    const f = typeof fn === 'object' && fn ? fn.handleEvent : fn;
    if (!ids.has(target)) ids.set(target, ++n);
    if (!ids.has(f)) ids.set(f, ++n);
    return `${ids.get(target)}|${type}|${ids.get(f)}|${typeof opts === 'boolean' ? opts : !!opts?.capture}`;
  };
  proto.addEventListener = /** @type {any} */ (function (/** @type {any} */ type, /** @type {any} */ fn, /** @type {any} */ opts) {
    if (fn) listeners.set(key(this, type, fn, opts), 1);
    return add.call(this, type, fn, opts);
  });
  proto.removeEventListener = /** @type {any} */ (function (/** @type {any} */ type, /** @type {any} */ fn, /** @type {any} */ opts) {
    if (fn) listeners.delete(key(this, type, fn, opts));
    return remove.call(this, type, fn, opts);
  });
  /** @type {Set<number>} */
  const intervals = new Set();
  win.setInterval = /** @type {any} */ ((/** @type {any[]} */ ...a) => { const id = Reflect.apply(setI, win, a); intervals.add(id); return id; });
  win.clearInterval = (id) => { intervals.delete(/** @type {number} */ (id)); return clearI.call(win, id); };
  return {
    count: () => ({ listeners: listeners.size, intervals: intervals.size }),
    restore() { proto.addEventListener = add; proto.removeEventListener = remove; win.setInterval = setI; win.clearInterval = clearI; },
  };
}

for (const stage of ['createEffects', 'installSelectorBridge', 'startObservers']) {
  test(`M4: a failed install (${stage} throws) leaves no listener or interval behind`, async t => {
    await frames(2);
    const probe = leakProbe();
    t.cleanup(probe.restore);
    const before = probe.count();
    const host = document.createElement('div');
    host.innerHTML = '<canvas content="drawable" width="100" height="50"><div drawable style="width:50px;height:20px">x</div></canvas>';
    document.body.append(host);
    t.cleanup(() => host.remove());
    const services = /** @type {any} */ (defaultServices());
    services[stage] = () => { throw new Error(`injected ${stage}`); };
    assert.throws(() => installWith({}, services), new RegExp(`injected ${stage}`));
    await frames(2);
    assert.equal(getInstalled(window), null);
    assert.deepEqual(probe.count(), before, 'nothing left running');
  });
}

test('M5: captureElementImage(ElementImage) is a TypeError (it would pin a NEWER version than the image passed in)', async t => {
  const i = inst(t);
  const c = await mk(t, i);
  const a = /** @type {HTMLElement} */ (c.querySelector('#a'));
  const img = c.captureElementImage(a);
  const e = thrown(() => /** @type {any} */ (c).captureElementImage(img));
  assert.ok(e instanceof TypeError, `got ${e}`);
  img.close();
});

test('m1: an element of ANOTHER canvas is an InvalidStateError for draw and capture (WPT draw-element-different-canvas; was a TypeError before the 2026-10 revision)', async t => {
  const i = inst(t);
  const c1 = await mk(t, i);
  const c2 = await mk(t, i);
  const other = /** @type {Element} */ (c2.querySelector('#a'));
  assert.equal(thrown(() => /** @type {any} */ (c1.getContext('2d')).drawElementImage(other, 0, 0)).name, 'InvalidStateError');
  assert.equal(thrown(() => c1.captureElementImage(other)).name, 'InvalidStateError');
  assert.equal(thrown(() => c1.updateElementGeometry(other)).name, 'InvalidStateError', 'geometry methods keep InvalidStateError (section 6.1)');
});

test('m2: a NaN canvasTransform or clip is accepted and does not poison later updates', async t => {
  const i = inst(t);
  const c = await mk(t, i);
  const a = /** @type {HTMLElement} */ (c.querySelector('#a'));
  assert.equal(thrown(() => c.updateElementGeometry(a, { canvasTransform: { a: NaN } })), null);
  assert.equal(thrown(() => c.updateElementGeometry(a, { clip: { x: NaN, y: 0, width: 5, height: 5 } })), null);
  assert.ok(Number.isNaN(c.getElementTransform(a).a), 'the stored transform is what the app set');
  assert.equal(thrown(() => c.updateElementGeometry(a, { clip: { x: 0, y: 0, width: 5, height: 5 } })), null, 'a later valid update works');
  assert.equal(thrown(() => c.updateElementGeometry(a, { canvasTransform: { e: 5 } })), null);
  await frames(2);
  assert.equal(c.getElementTransform(a).e, 5);
  assert.deepEqual(i.report().errors, []);
});

test('m3: uninstall removes the paint listeners and the handler state of the canvases', async t => {
  await frames(2);
  const probe = leakProbe();
  t.cleanup(probe.restore);
  const before = probe.count();
  const i = inst(t);
  const c = await mk(t, i);
  let n = 0;
  c.onpaint = () => { n++; };
  c.requestPaint();
  await i.whenPainted(c);
  await frames(2);
  const ran = n;
  assert.ok(ran >= 1);
  i.uninstall();
  c.dispatchEvent(new Event('paint'));
  assert.equal(n, ran, 'the old onpaint handler no longer runs');
  assert.equal(/** @type {any} */ (c).onpaint, undefined, 'onpaint is the platform default again');
  assert.deepEqual(probe.count(), before, 'no listener of the install is left');
});

test('m5: draw on a canvas that is display:none or removed throws InvalidStateError; requestPaint stays a no-op', async t => {
  const i = inst(t);
  const c = await mk(t, i);
  const a = /** @type {HTMLElement} */ (c.querySelector('#a'));
  const ctx = /** @type {any} */ (c.getContext('2d'));
  assert.equal(thrown(() => ctx.drawElementImage(a, 0, 0)), null, 'precondition: drawable');
  c.style.display = 'none';
  assert.equal(thrown(() => ctx.drawElementImage(a, 0, 0))?.name, 'InvalidStateError', 'display:none');
  assert.equal(thrown(() => c.requestPaint()), null);
  c.style.display = '';
  await frames(3);
  const host = /** @type {HTMLElement} */ (c.parentElement);
  c.remove();
  assert.equal(thrown(() => ctx.drawElementImage(a, 0, 0))?.name, 'InvalidStateError', 'detached');
  assert.equal(thrown(() => c.requestPaint()), null);
  host.append(c);
});

test('m7: accessor names and ElementImage shape follow the platform', async t => {
  const i = inst(t);
  const c = await mk(t, i);
  const d = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'content'));
  assert.equal(/** @type {Function} */ (d.get).name, 'get content');
  assert.equal(/** @type {Function} */ (d.set).name, 'set content');
  assert.equal(/** @type {Function} */ (Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'onpaint')?.get).name, 'get onpaint');
  assert.equal(/** @type {Function} */ (Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width')?.set).name, 'set width');
  const EI = /** @type {any} */ (window).ElementImage;
  assert.equal(EI.length, 0);
  assert.equal(Object.getOwnPropertyDescriptor(EI.prototype, 'close')?.enumerable, true, 'close');
  for (const key of ['width', 'height']) assert.equal(key in EI.prototype, false, `${key}: the 2026-10-08 interface has close() only`);
  assert.ok(thrown(() => new EI()) instanceof TypeError);
  c.captureElementImage(/** @type {Element} */ (c.querySelector('#a'))).close();
});

test('m8: options validation uses own properties, integers, and applies to a repeated install()', t => {
  const i = inst(t);
  assert.equal(install(), i, 'idempotent');
  assert.throws(() => install({ bogus: 1 }), /unknown option/);
  assert.throws(() => install({ maxDpr: 'x' }), TypeError);
  for (const bad of ['toString', 'constructor', 'hasOwnProperty']) assert.throws(() => install({ [bad]: 1 }), /unknown option/, bad);
  assert.throws(() => install({ nodeBudget: { toString: 5 } }), /unknown nodeBudget member/);
  assert.throws(() => install({ defaultFrameCap: 1.5 }), /integer/);
  assert.throws(() => install({ maxSurfacePixels: 0.5 }), /integer/);
});

test('m6: removing the canvas inside the frame that painted it raises no ResizeObserver-loop window error', async t => {
  const i = inst(t);
  /** @type {string[]} */
  const errors = [];
  const onError = (/** @type {ErrorEvent} */ e) => { errors.push(e.message); e.preventDefault(); };
  window.addEventListener('error', onError, true);
  t.cleanup(() => window.removeEventListener('error', onError, true));
  const c = await mk(t, i);
  c.remove(); // runs in the microtask checkpoint of the polyfill's own ResizeObserver callback
  await sleep(300);
  assert.deepEqual(errors, []);
});

test('browser m8: a draw without a snapshot throws InvalidStateError whose message names the remedies', async t => {
  const i = inst(t);
  const c = await mk(t, i, { wait: false });
  const e = thrown(() => /** @type {any} */ (c.getContext('2d')).drawElementImage(c.querySelector('#a'), 0, 0));
  assert.equal(e?.name, 'InvalidStateError');
  assert.ok(/paintGateMaxWaitMs/.test(e.message), e.message);
  assert.ok(/split it into several/.test(e.message));
});
