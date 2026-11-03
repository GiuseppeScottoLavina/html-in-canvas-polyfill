// The mobile gate's verdicts (test/mobile/verdict.mjs): a scenario that reported only documented skips (class n/a) is SKIP, shown apart from PASS and not counted as one,
// and it does not fail the gate; a scenario with a real check keeps PASS / FAIL with its control.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdicts, verdictLabel, gateFailed, tally } from '../../mobile/verdict.mjs';

const controlClasses = { touchScroll: ['pixel', 'hit'], explainer: ['pixel', 'hit'], keyboard: ['hit'] };
const row = (scenario, checks, threw = null) => ({ scenario, checks, threw, ms: 1 });
const skipRow = (scenario) => row(scenario, [{ label: `${scenario}: not drivable here: skipped, documented`, ok: true, cls: 'n/a' }]);

test('a scenario with only n/a rows is SKIP: not PASS, and not a gate failure', () => {
  const v = verdicts({ rows: [skipRow('touchScroll'), skipRow('keyboard')] }, { rows: [] }, { controlClasses });
  for (const k of ['touchScroll', 'keyboard']) {
    assert.equal(verdictLabel(v[k]), 'SKIP', k);
    assert.equal(v[k].pass, false, `${k} is not counted as a pass`);
    assert.equal(v[k].skip, true);
    assert.equal(v[k].control, 'n/a');
  }
  assert.equal(gateFailed(v), false);
  assert.deepEqual(tally(v), { PASS: 0, SKIP: 2, FAIL: 0 });
});

test('positive control: a real check with its control red is PASS, and a failing one FAIL (the gate fails)', () => {
  const real = { rows: [row('explainer', [{ label: 'pixels', ok: true, cls: 'pixel' }, { label: 'tap', ok: true, cls: 'hit' }]), row('keyboard', [{ label: 'opened', ok: false, cls: 'hit' }])] };
  const control = { rows: [row('explainer', [{ label: 'pixels', ok: false, cls: 'pixel' }, { label: 'tap', ok: false, cls: 'hit' }]), row('keyboard', [{ label: 'opened', ok: false, cls: 'hit' }])] };
  const v = verdicts(real, control, { controlClasses });
  assert.equal(verdictLabel(v.explainer), 'PASS'); assert.equal(v.explainer.pass, true); assert.equal(v.explainer.control, 'red [pixel,hit]');
  assert.equal(verdictLabel(v.keyboard), 'FAIL'); assert.equal(v.keyboard.pass, false);
  assert.equal(gateFailed(v), true);
  assert.deepEqual(tally(v), { PASS: 1, SKIP: 0, FAIL: 1 });
});

test('an n/a row next to a real check does not make the scenario a skip; a thrown or empty scenario is FAIL, never SKIP', () => {
  const mixed = row('touchScroll', [{ label: 'note', ok: true, cls: 'n/a' }, { label: 'scrolled', ok: true, cls: 'pixel' }]);
  const v = verdicts({ rows: [mixed, row('explainer', [], 'Error: boom'), row('keyboard', [])] }, { rows: [row('touchScroll', [{ label: 'scrolled', ok: false, cls: 'pixel' }])] }, { controlClasses });
  assert.equal(verdictLabel(v.touchScroll), 'FAIL', 'its control did not turn hit red'); assert.match(v.touchScroll.control, /DID NOT FAIL: hit/);
  assert.equal(verdictLabel(v.explainer), 'FAIL');
  assert.equal(verdictLabel(v.keyboard), 'FAIL');
  const thrownSkip = verdicts({ rows: [row('keyboard', [{ label: 'skipped', ok: true, cls: 'n/a' }], 'Error: after the skip')] }, null, { controlClasses });
  assert.equal(verdictLabel(thrownSkip.keyboard), 'FAIL');
});

test('--no-control: a skip stays SKIP, a real scenario without its control is not a pass', () => {
  const v = verdicts({ rows: [skipRow('touchScroll'), row('explainer', [{ label: 'pixels', ok: true, cls: 'pixel' }])] }, null, { noControl: true, controlClasses });
  assert.equal(verdictLabel(v.touchScroll), 'SKIP');
  assert.equal(v.explainer.control, 'skipped');
});
