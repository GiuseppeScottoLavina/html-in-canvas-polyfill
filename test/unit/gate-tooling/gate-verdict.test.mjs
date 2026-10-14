// The gate runner's verdict logic (test/gates/lib/gate.mjs `judge`): focus loss is NOT USABLE, degraded runs never count toward thresholds, a control must turn EVERY declared class red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge } from '../../gates/lib/gate.mjs';

const ok = (name, cls) => ({ name, ok: true, cls });
const bad = (name, cls) => ({ name, ok: false, cls });
const real = (checks) => ({ checks, numbers: {}, thrown: null });

test('a clean real + control run passes and counts toward thresholds', () => {
  const j = judge({ real: real([ok('a', 'pixel')]), control: real([bad('a', 'pixel'), bad('b', 'hit')]), controlClasses: ['pixel', 'hit'], focus: { mode: 'real' } });
  assert.equal(j.verdict, 'PASS'); assert.equal(j.pass, true); assert.equal(j.countsForThresholds, true); assert.deepEqual(j.degraded, []);
});

test('a control that never turned a declared class red fails the gate, naming the class', () => {
  const j = judge({ real: real([ok('a', 'pixel')]), control: real([bad('a', 'pixel'), ok('b', 'hit')]), controlClasses: ['pixel', 'hit'], focus: { mode: 'real' } });
  assert.equal(j.pass, false); assert.deepEqual(j.control.missingClasses, ['hit']); assert.match(j.failed.join(), /class \[hit\]/);
});

test('a control that detected nothing fails', () => {
  const j = judge({ real: real([ok('a')]), control: real([ok('a')]), focus: { mode: 'real' } });
  assert.equal(j.pass, false); assert.match(j.failed.join(), /POSITIVE CONTROL DID NOT FAIL/);
});

test('focus failed or lost makes the run NOT USABLE and pass false', () => {
  for (const focus of [{ mode: 'failed' }, { mode: 'real', lost: 1, lostAt: 'typing' }]) {
    const j = judge({ real: real([ok('a')]), focus });
    assert.equal(j.verdict, 'NOT USABLE'); assert.equal(j.pass, false); assert.equal(j.usable, false);
  }
});

test('cdp-click focus, high machine load, a locked screen and --no-control degrade a pass but it never counts toward thresholds', () => {
  const j = judge({ real: real([ok('a')]), focus: { mode: 'cdp-click' }, highLoad: true, screenLocked: true, noControl: true });
  assert.equal(j.verdict, 'PASS'); assert.equal(j.countsForThresholds, false);
  assert.deepEqual(j.degraded.sort(), ['focus:cdp-click', 'high-load', 'no-control', 'screen-locked']);
});

test('a failed real check or a thrown run fails; a run without any assertion fails', () => {
  assert.equal(judge({ real: real([bad('x', 'pixel')]), focus: { mode: 'real' } }).pass, false);
  assert.equal(judge({ real: { checks: [ok('a')], numbers: {}, thrown: 'boom' }, focus: { mode: 'real' } }).pass, false);
  const none = judge({ real: real([]), focus: { mode: 'real' } });
  assert.equal(none.pass, false); assert.match(none.failed.join(), /no assertion/);
});
