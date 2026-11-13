// The WPT triage (test/wpt/triage.mjs): what counts as a file the oracle passes at the pinned build when Canary has drifted past it, which tests
// `--update-expectations` lists as stable, and the gate's check of those lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triage, gateFailures, updateExpectations, driftCount } from '../../wpt/triage.mjs';

const sub = (/** @type {string} */ name, /** @type {string} */ status) => ({ name, status });
/** @param {string} type @param {string} status @param {Array<{name: string, status: string}>} subtests @param {boolean} [stable] */
const file = (type, status, subtests, stable = true) => ({ type, pass: subtests.length > 0 && subtests.every((s) => s.status === 'PASS') && (type !== 'testharness' || status === 'OK'), stable, result: { status, subtests } });
const doc = (/** @type {string} */ version, /** @type {Record<string, any>} */ tests) => ({ config: { version }, tests });

const PINNED = 'Chrome/159.0.8128.2';
const baseline = { build: PINNED, pass: { 'ref.html': ['reftest'], 'th.html': ['a'], 'th-timeout.html': ['a'] } };
// Canary now fails the reftest and both testharness subtests that the pinned build passed; one testharness file still runs to the end (OK), the other times out.
const A = doc('Chrome/159.0.8154.2', {
  'ref.html': file('reftest', 'FAIL', [sub('reftest', 'FAIL')]),
  'th.html': file('testharness', 'OK', [sub('a', 'FAIL')]),
  'th-timeout.html': file('testharness', 'TIMEOUT', [sub('a', 'TIMEOUT')]),
  'ref-new-fail.html': file('reftest', 'FAIL', [sub('reftest', 'FAIL')]),
  'ok.html': file('testharness', 'OK', [sub('a', 'PASS')]),
});
const B = doc('Chrome/157', Object.fromEntries(Object.keys(A.tests).map((id) => [id, file(A.tests[id].type, 'OK', [sub(A.tests[id].result.subtests[0].name, 'PASS')])])));

test('oracle drift: a reftest the pinned build passed counts as a file the oracle passes there; a testharness file that timed out and a reftest the baseline does not list do not', () => {
  const r = triage({ A, B, C: undefined }, { tests: {} }, baseline);
  assert.equal(r.drift?.subtests.length, 3, 'the three subtests the pinned build passed are substituted');
  assert.equal(r.counts.subtests.P, 4, 'subtests at the pinned build: ref, th, th-timeout, ok');
  // ref.html (reftest, comparison FAIL, its one subtest from the baseline), th.html (OK) and ok.html; not th-timeout.html (TIMEOUT), not ref-new-fail.html
  assert.equal(r.counts.files.P, 3);
  assert.equal(r.counts.files.A, 1, 'the oracle as it ran passes only ok.html');
});

test('without drift the file count is the oracle as it ran', () => {
  const r = triage({ A: { ...A, config: { version: PINNED } }, B, C: undefined }, { tests: {} }, baseline);
  assert.equal(r.drift, null);
  assert.equal(r.counts.files.P, 1);
});

test('--update-expectations never lists a test that declares unstableByDesign as stable, whatever the run did, and lists every other stable one', () => {
  const exp = { tests: { 'ref.html': { category: 'impossible', reason: 'paint-timing', note: 'a race', unstableByDesign: true } }, stable: [] };
  const out = updateExpectations(exp, B);
  assert.ok(!out.stable.includes('ref.html'));
  assert.deepEqual(out.stable, ['ok.html', 'ref-new-fail.html', 'th-timeout.html', 'th.html']);
  assert.ok(updateExpectations({ tests: {} }, B).stable.includes('ref.html'), 'control: without the declaration the same run lists it');
});

test('--update-expectations refuses a subset run (--only, --filter, also reused), which would drop every test it did not run from the lists', () => {
  const exp = { tests: {}, pass: ['ref.html', 'th.html'], partial: {}, stable: ['ref.html', 'th.html'] };
  const B = { selection: 'subset', tests: { 'ref.html': { type: 'reftest', pass: true, stable: true, result: { status: 'PASS', subtests: [sub('', 'PASS')] } } } };
  assert.throws(() => updateExpectations(exp, B), /needs a run of every test/);
  const full = updateExpectations(exp, { ...B, selection: 'full' });
  assert.deepEqual(full.pass, ['ref.html'], 'control: a full run rebuilds the lists from what it ran');
  assert.deepEqual(exp.pass, ['ref.html', 'th.html'], 'the expectations passed in are not changed');
});

test('the gate: a stable test that changed between repetitions fails it; a stable list that names a test declared unstableByDesign is refused', () => {
  const subject = doc('Chrome/157', { ...B.tests, 'ok.html': { ...B.tests['ok.html'], stable: false } });
  const exp = { tests: {}, stable: ['ok.html'] };
  const fails = gateFailures({ A, B: subject, C: undefined }, exp, triage({ A, B: subject, C: undefined }, exp, baseline));
  assert.ok(fails.includes('(iii) unstable between repetitions: ok.html'), fails.join('\n'));
  const declared = { tests: { 'ok.html': { unstableByDesign: true } }, stable: ['ok.html'] };
  const f2 = gateFailures({ A, B, C: undefined }, declared, triage({ A, B, C: undefined }, declared, baseline));
  assert.ok(f2.some((f) => /lists ok\.html as stable and declares it unstableByDesign/.test(f)), f2.join('\n'));
});

test('the drift sentence agrees in number', () => {
  assert.equal(driftCount(1, 'that the pinned build passed'), '1 subtest that the pinned build passed fails');
  assert.equal(driftCount(3, 'that the pinned build passed'), '3 subtests that the pinned build passed fail');
});
