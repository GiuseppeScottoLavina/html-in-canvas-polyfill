import { test, assert, fixture, frames, microtasks, sleep } from '/test/unit/lib/t.js';

test('passes: sync assertions', () => {
  assert.equal(1 + 1, 2);
  assert.deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] });
  assert.ok('x');
  assert.throws(() => { throw new TypeError('boom'); }, /boom/);
});

test('passes: async with frames and microtasks', async () => {
  const n = await new Promise(ok => requestAnimationFrame(() => ok(1)));
  await frames(2); await microtasks(); await sleep(5);
  assert.equal(n, 1);
  await assert.rejects(async () => { throw new RangeError('nope'); }, RangeError);
});

test('fixture mounts, lays out, and is removed after the test', async t => {
  const el = fixture('<p id="p" style="width:40px;height:10px">hi</p>');
  assert.equal(el.querySelector('#p').getBoundingClientRect().width, 40);
  t.cleanup(() => { globalThis.__cleanedUp = true; });
});

test('previous fixture was cleaned up and cleanup ran', () => {
  assert.equal(document.querySelectorAll('[id^=fixture-]').length, 0);
  assert.equal(globalThis.__cleanedUp, true);
});

test('console.error is captured and reported but does not fail', () => { console.error('selftest: expected console error'); });

test.skip('skipped test is reported as skipped', () => { throw new Error('must not run'); });

test('assert helpers reject wrong values', () => {
  assert.throws(() => assert.equal(1, 2), /expected 2, got 1/);
  assert.throws(() => assert.deepEqual({ a: 1 }, { a: 2 }));
  assert.throws(() => assert.throws(() => {}), /expected function to throw/);
});
