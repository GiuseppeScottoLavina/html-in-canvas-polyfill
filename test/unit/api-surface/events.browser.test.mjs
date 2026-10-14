import { test, assert, fixture } from '/test/unit/lib/t.js';
import {
  CanvasPaintEvent, ElementGeometryUpdateEvent, createSchedulerHooks, defineEventGlobals, fireGeometryUpdate,
} from '/src/api/paint-event.js';
import { ElementImage, defineElementImageGlobal } from '/src/api/element-image.js';
import { arrange, createWorld } from './fakes.mjs';

test('CanvasPaintEvent: constructor, defaults, frozen SameObject changedElements, not bubbling or cancelable', () => {
  const a = document.createElement('div');
  const e = new CanvasPaintEvent('paint', { changedElements: [a] });
  assert.ok(e instanceof Event);
  assert.equal(e.type, 'paint');
  assert.deepEqual([e.bubbles, e.cancelable, e.composed, e.isTrusted], [false, false, false, false]);
  assert.equal(e.changedElements.length, 1);
  assert.equal(e.changedElements[0], a);
  assert.ok(Object.isFrozen(e.changedElements));
  assert.equal(e.changedElements, e.changedElements, 'SameObject');
  assert.deepEqual(Array.from(new CanvasPaintEvent('paint').changedElements), []);
  assert.deepEqual(Array.from(new CanvasPaintEvent('paint', { changedElements: new Set([a]) }).changedElements), [a], 'any sequence');
  assert.equal(Object.prototype.toString.call(e), '[object CanvasPaintEvent]');
  assert.throws(() => new CanvasPaintEvent(), TypeError);
  assert.throws(() => new CanvasPaintEvent('paint', { changedElements: 5 }), TypeError);
  assert.throws(() => new CanvasPaintEvent('paint', { changedElements: null }), TypeError);
});

test('the changedElements list is a copy: mutating the source array does not change the event', () => {
  const a = document.createElement('div');
  const source = [a];
  const e = new CanvasPaintEvent('paint', { changedElements: source });
  source.push(document.createElement('p'));
  assert.equal(e.changedElements.length, 1);
});

test('ElementGeometryUpdateEvent mirrors it with `elements`', () => {
  const a = document.createElement('div');
  const e = new ElementGeometryUpdateEvent('elementgeometryupdate', { elements: [a], bubbles: true });
  assert.equal(e.bubbles, true);
  assert.deepEqual(Array.from(e.elements), [a]);
  assert.ok(Object.isFrozen(e.elements));
  assert.throws(() => new ElementGeometryUpdateEvent(), TypeError);
  assert.throws(() => new ElementGeometryUpdateEvent('x', { elements: {} }), TypeError);
});

test('firePaint dispatches one paint event on the canvas with the changed elements, and listeners see it once', async (t) => {
  const { env, canvas, el, record } = await arrange(t, fixture, { patches: [] });
  const events = [];
  canvas.addEventListener('paint', (e) => events.push(e));
  const hooks = createSchedulerHooks(env);
  hooks.firePaint(record, [el]);
  hooks.firePaint(record, []);
  assert.equal(events.length, 2);
  assert.ok(events[0] instanceof CanvasPaintEvent);
  assert.equal(events[0].target, canvas);
  assert.deepEqual(Array.from(events[0].changedElements), [el]);
  assert.deepEqual(Array.from(events[1].changedElements), []);
});

test('fireGeometryUpdate dispatches ElementGeometryUpdateEvent on the canvas', async (t) => {
  const { env, canvas, el } = await arrange(t, fixture, { patches: [] });
  const seen = [];
  canvas.addEventListener('elementgeometryupdate', (e) => seen.push(e));
  fireGeometryUpdate(env, canvas, [el]);
  assert.equal(seen.length, 1);
  assert.ok(seen[0] instanceof ElementGeometryUpdateEvent);
  assert.deepEqual(Array.from(seen[0].elements), [el]);
});

test('event globals and ElementImage are defined only when absent, through the ledger, and removed again', async () => {
  const world = createWorld();
  const hadAll = ['CanvasPaintEvent', 'ElementGeometryUpdateEvent', 'ElementImage'].some((n) => n in window);
  assert.equal(hadAll, false, 'stock browser');
  defineEventGlobals(window, world.ledger);
  defineElementImageGlobal(window, world.ledger);
  assert.equal(window.CanvasPaintEvent, CanvasPaintEvent);
  assert.equal(window.ElementGeometryUpdateEvent, ElementGeometryUpdateEvent);
  assert.equal(window.ElementImage, ElementImage);
  assert.equal(Object.getOwnPropertyDescriptor(window, 'ElementImage').enumerable, false);
  const other = createWorld();
  defineEventGlobals(window, other.ledger);
  assert.equal(other.ledger.list().length, 0, 'an existing global is never replaced');
  assert.deepEqual(world.ledger.restoreAll(), []);
  assert.equal('CanvasPaintEvent' in window, false);
  assert.equal('ElementImage' in window, false);
});
