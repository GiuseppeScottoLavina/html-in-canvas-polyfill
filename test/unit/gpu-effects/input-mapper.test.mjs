import test from 'node:test';
import assert from 'node:assert/strict';
import { createMapperChain } from '../../../src/effects/input-mapper.js';

const P = (x, y) => ({ x, y, width: 100, height: 50 });
/** x -> x*k, y unchanged */
const scaleX = (k) => (p) => ({ x: p.x * k, y: p.y });
/** x -> x+d */
const shiftX = (d) => (p) => ({ x: p.x + d, y: p.y });

test('no frame presented: identity, inactive', () => {
  const c = createMapperChain();
  assert.deepEqual(c.map(P(3, 4)), { x: 3, y: 4 });
  assert.equal(c.active(), false);
  assert.equal(c.depth(), 0);
});

test('mappers are walked in reverse: the LAST plugin is undone first', () => {
  const c = createMapperChain();
  // plugin 1 shifts by 10, plugin 2 doubles. Output = double(shift(source)), so source = shift^-1(double^-1(out)):
  // the chain maps the presented point through plugin 2's mapper first, then plugin 1's.
  c.push(1, [shiftX(10), scaleX(2)]);
  assert.deepEqual(c.map(P(5, 1)), { x: 20, y: 1 }); // scaleX(2) first -> 10, then +10
  c.clear();
  c.push(2, [scaleX(2), shiftX(10)]);
  assert.deepEqual(c.map(P(5, 1)), { x: 30, y: 1 }); // +10 first -> 15, then *2
});

test('the presented size is handed to every mapper unchanged', () => {
  const c = createMapperChain();
  const seen = [];
  c.push(1, [(p) => { seen.push([p.width, p.height]); return p; }, (p) => { seen.push([p.width, p.height]); return { x: p.x + 1, y: p.y }; }]);
  c.map(P(0, 0));
  assert.deepEqual(seen, [[100, 50], [100, 50]]);
});

test('ring keeps the last 3 presented frames; age selects an older one', () => {
  const c = createMapperChain();
  for (let i = 1; i <= 5; i += 1) c.push(i, [shiftX(i)]);
  assert.equal(c.depth(), 3);
  assert.equal(c.map(P(0, 0)).x, 5);
  assert.equal(c.map(P(0, 0), 1).x, 4);
  assert.equal(c.map(P(0, 0), 2).x, 3);
  assert.equal(c.map(P(0, 0), 9).x, 3, 'an age past the ring clamps to the oldest kept frame');
});

test('active() follows the NEWEST frame only', () => {
  const c = createMapperChain();
  c.push(1, [shiftX(1)]);
  assert.equal(c.active(), true);
  c.push(2, []);
  assert.equal(c.active(), false, 'a newest frame without a spatial plugin is not active');
  assert.deepEqual(c.map(P(7, 7)), { x: 7, y: 7 });
});

test('captureGesture freezes the frame at the call and honours captureGestureSnapshot', () => {
  const c = createMapperChain();
  let shift = 10;
  const live = (p) => ({ x: p.x + shift, y: p.y });
  live.captureGestureSnapshot = () => { const frozen = shift; return (p) => ({ x: p.x + frozen, y: p.y }); };
  c.push(1, [live]);
  const gesture = c.captureGesture();
  shift = 99; // the plugin recycles its state for a later frame
  assert.equal(gesture(P(0, 0)).x, 10, 'the gesture mapper kept the state of pointerdown');
  assert.equal(c.map(P(0, 0)).x, 99, 'the live chain follows the recycled state');
  c.push(2, [shiftX(1)]);
  assert.equal(gesture(P(0, 0)).x, 10, 'a newer presented frame does not move a running gesture');
});

test('a mapper that returns a non-finite point is a TypeError, not a silent NaN click', () => {
  const c = createMapperChain();
  c.push(1, [() => ({ x: NaN, y: 0 })]);
  assert.throws(() => c.map(P(1, 1)), TypeError);
  c.clear();
  c.push(2, [() => undefined]);
  assert.throws(() => c.map(P(1, 1)), TypeError);
});

test('push copies the mapper list', () => {
  const c = createMapperChain();
  const list = [shiftX(1)];
  c.push(1, list);
  list.push(shiftX(100));
  assert.equal(c.map(P(0, 0)).x, 1);
});
