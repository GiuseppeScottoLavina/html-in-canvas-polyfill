import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaintGate } from '../../../src/schedule/paint-gate.js';

function setup(options = {}, readiness = { ready: true, reason: 'ready' }) {
  const store = { readiness, isPaintReady: () => store.readiness };
  const env = { options: { coherentPaint: true, coherenceMaxWaitMs: 50, paintGateMaxWaitMs: 400, ...options } };
  const record = { paint: { force: true, waitingSince: null, gateReason: null } };
  return { store, env, record, gate: createPaintGate(env, store) };
}

test('a ready canvas is open and carries no wait state', () => {
  const { gate, record } = setup();
  assert.deepEqual(gate.evaluate(record, 10), { open: true, reason: 'ready' });
  assert.equal(record.paint.waitingSince, null);
});

test('a canvas without eligible drawables is open (paint with [])', () => {
  const { gate, record } = setup({}, { ready: true, reason: 'no-drawables' });
  assert.deepEqual(gate.evaluate(record, 0), { open: true, reason: 'no-drawables' });
});

test('first-commit: closed until ready, force stays set, wait clock starts at the first closed evaluation', () => {
  const { gate, record, store } = setup({}, { ready: false, reason: 'first-commit' });
  assert.deepEqual(gate.evaluate(record, 100), { open: false, reason: 'first-commit' });
  assert.equal(record.paint.waitingSince, 100);
  assert.equal(record.paint.gateReason, 'first-commit');
  assert.equal(record.paint.force, true, 'the gate never clears force');
  assert.equal(gate.evaluate(record, 300).open, false);
  assert.equal(record.paint.waitingSince, 100, 'the clock is not restarted by later evaluations');
  store.readiness = { ready: true, reason: 'ready' };
  assert.equal(gate.evaluate(record, 350).open, true);
  assert.equal(record.paint.waitingSince, null);
  assert.equal(record.paint.gateReason, null);
});

test('first-commit times out at paintGateMaxWaitMs and fires anyway', () => {
  const { gate, record } = setup({}, { ready: false, reason: 'first-commit' });
  gate.evaluate(record, 0);
  assert.equal(gate.evaluate(record, 399.9).open, false);
  assert.deepEqual(gate.evaluate(record, 400), { open: true, reason: 'timeout' });
  assert.equal(record.paint.waitingSince, null, 'the wait state is cleared when the gate opens');
});

test('coherence holds for coherenceMaxWaitMs (50), not for the first-commit cap', () => {
  const { gate, record } = setup({}, { ready: false, reason: 'coherence' });
  assert.deepEqual(gate.evaluate(record, 0), { open: false, reason: 'coherence' });
  assert.equal(gate.evaluate(record, 49).open, false);
  assert.deepEqual(gate.evaluate(record, 50), { open: true, reason: 'timeout' });
});

test('coherentPaint:false ignores a coherence hold but never a first-commit hold', () => {
  const off = setup({ coherentPaint: false }, { ready: false, reason: 'coherence' });
  assert.deepEqual(off.gate.evaluate(off.record, 0), { open: true, reason: 'ready' });
  const first = setup({ coherentPaint: false }, { ready: false, reason: 'first-commit' });
  assert.equal(first.gate.evaluate(first.record, 0).open, false);
});

test('each reason has its own clock: a reason change restarts the wait', () => {
  const { gate, record, store } = setup({}, { ready: false, reason: 'first-commit' });
  gate.evaluate(record, 0);
  store.readiness = { ready: false, reason: 'coherence' };
  assert.equal(gate.evaluate(record, 40).open, false);
  assert.equal(record.paint.waitingSince, 40);
  assert.equal(gate.evaluate(record, 89).open, false);
  assert.equal(gate.evaluate(record, 90).open, true);
});
