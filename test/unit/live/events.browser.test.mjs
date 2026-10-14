import { test, assert } from '/test/unit/lib/t.js';
import { setup, page } from '/test/unit/live/lib.mjs';

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
