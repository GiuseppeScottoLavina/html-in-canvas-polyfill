// The gate runner's verdict logic (test/gates/lib/gate.mjs `judge`): focus loss is NOT USABLE, degraded runs never count toward thresholds, a control must turn EVERY declared class red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, gateRunOutcome, hangVerdict } from '../../gates/lib/gate.mjs';

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

test('pointer input the harness did not send makes the run NOT USABLE, named first as an environment problem (the real checks it may have broken come after)', () => {
  const foreignPointer = [{ phase: 'real', type: 'mousemove', x: 822, y: 543 }];
  const j = judge({ real: real([bad('hover pixels', 'pixel')]), focus: { mode: 'real' }, foreignPointer });
  assert.equal(j.verdict, 'NOT USABLE'); assert.equal(j.pass, false); assert.equal(j.usable, false); assert.equal(j.countsForThresholds, false);
  assert.deepEqual(j.degraded, ['foreign-pointer:1']);
  assert.match(j.failed[0], /^ENVIRONMENT: pointer input the harness did not send/);
  // and a clean run with an empty guard record is untouched
  assert.equal(judge({ real: real([ok('a')]), focus: { mode: 'real' }, foreignPointer: [] }).verdict, 'PASS');
});

test('a gate process without a result line is NOT RUN with a reason that is never empty (killed at the runner timeout, crashed, not spawned)', () => {
  const killed = gateRunOutcome({ stdout: '', stderr: '', status: null, signal: 'SIGTERM', error: Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT' }) });
  assert.ok(killed.notRun && /killed by SIGTERM at the runner timeout/.test(killed.notRun) && /no result line/.test(killed.notRun), killed.notRun);
  const silent = gateRunOutcome({ stdout: null, stderr: null, status: 1, signal: null });
  assert.ok(silent.notRun && /exit 1/.test(silent.notRun), silent.notRun);
  const broken = gateRunOutcome({ stdout: '{"gate":"G-x","verdict":"PA', stderr: '', status: 1, signal: null });
  assert.match(broken.notRun, /malformed result line/);
  const partial = gateRunOutcome({ stdout: '{"gate":"G-x","verdict":"PASS"}\n', stderr: '', status: 0, signal: null });
  assert.match(partial.notRun, /malformed result line/);
  const res = gateRunOutcome({ stdout: 'log\n{"gate":"G-x","verdict":"PASS","assertions":[],"failed":[]}\nPASS G-x', stderr: '', status: 0, signal: null });
  assert.equal(res.gate, 'G-x'); assert.equal(res.notRun, undefined);
});

test('a gate past its watchdog fails naming what it still waits for; behind a locked screen it is NOT USABLE instead', () => {
  const h = hangVerdict({ minutes: 10, pending: ['Runtime.evaluate'], screenLocked: false });
  assert.equal(h.verdict, 'FAIL'); assert.equal(h.pass, false); assert.equal(h.usable, true);
  assert.match(h.reason, /did not finish within 10 min \(CDP calls still waiting: Runtime.evaluate; screen locked: false\)/);
  const l = hangVerdict({ minutes: 10, pending: [], screenLocked: true });
  assert.equal(l.verdict, 'NOT USABLE'); assert.equal(l.usable, false); assert.match(l.reason, /waiting: none; screen locked: true.*unlock and rerun/);
});
