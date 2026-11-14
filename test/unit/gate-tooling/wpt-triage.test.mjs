// The WPT triage (test/wpt/triage.mjs): what counts as a file the oracle passes at the pinned build when Canary has drifted past it, which tests
// `--update-expectations` lists as stable, which subject runs it rebuilds the lists from, and the gate's check of those lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { triage, gateFailures, updateExpectations, subjectRunRefusal, driftCount } from '../../wpt/triage.mjs';
import { selectTests, selectionOf } from '../../wpt/run.mjs';
import { listTests } from '../../wpt/lib/inventory.mjs';

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
// a subject run as runConfig saves it (role, selection, the bundle injected), and the state it is checked against: the inventory and the bundle in dist
const HASH = 'a'.repeat(64);
const subject = (/** @type {any} */ run) => ({ ...run, config: { ...run.config, id: 'B', role: 'subject' }, selection: 'full', polyfillSha256s: [HASH] });
const current = (/** @type {any} */ run) => ({ inventory: Object.keys(run.tests), bundleSha256: HASH });

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
  const out = updateExpectations(exp, subject(B), current(B));
  assert.ok(!out.stable.includes('ref.html'));
  assert.deepEqual(out.stable, ['ok.html', 'ref-new-fail.html', 'th-timeout.html', 'th.html']);
  assert.ok(updateExpectations({ tests: {} }, subject(B), current(B)).stable.includes('ref.html'), 'control: without the declaration the same run lists it');
});

test('--update-expectations refuses a subset run (--only, --filter, also reused), which would drop every test it did not run from the lists', () => {
  const exp = { tests: {}, pass: ['ref.html', 'th.html'], partial: {}, stable: ['ref.html', 'th.html'] };
  const B = { ...subject(doc('Chrome/157', { 'ref.html': { type: 'reftest', pass: true, stable: true, result: { status: 'PASS', subtests: [sub('', 'PASS')] } } })), selection: 'subset' };
  assert.throws(() => updateExpectations(exp, B, current(B)), /was a subset/);
  const full = updateExpectations(exp, { ...B, selection: 'full' }, current(B));
  assert.deepEqual(full.pass, ['ref.html'], 'control: a full run rebuilds the lists from what it ran');
  assert.deepEqual(exp.pass, ['ref.html', 'th.html'], 'the expectations passed in are not changed');
});

test('--update-expectations refuses every subject run that does not stand for the vendored tests and the bundle in dist, and keeps a full one of that bundle', () => {
  const exp = { tests: {}, pass: ['th.html'], partial: {}, stable: ['th.html'] };
  const good = subject(B);
  assert.equal(subjectRunRefusal(good, current(B)), null, 'control: a full run of the subject with the bundle in dist');
  assert.deepEqual(updateExpectations(exp, good, current(B)).pass, Object.keys(B.tests).sort(), 'control: the lists come from it');
  const { selection: _, ...unmarked } = good;
  const cases = /** @type {Array<[string, any, any, RegExp]>} */ ([
    ['a subset marked as one (--only, --filter, --no-privacy)', { ...good, selection: 'subset' }, current(B), /was a subset/],
    ['a run saved without its selection (run.mjs before this check)', unmarked, current(B), /records no selection/],
    ['a full run that misses a test of the inventory', good, { ...current(B), inventory: [...Object.keys(B.tests), 'new.html'] }, /1 not run \(new\.html\)/],
    ['a run of a test the inventory no longer has', good, { ...current(B), inventory: Object.keys(B.tests).slice(1) }, /1 not in the inventory \(ref\.html\)/],
    ['the control saved under the name B (run.mjs --config=C --name=B)', { ...good, config: { ...good.config, id: 'C', role: 'control' } }, current(B), /not one of the subject configuration B \(it is C, role control\)/],
    ['a run of another bundle (rebuilt since, or --polyfill)', good, { ...current(B), bundleSha256: 'b'.repeat(64) }, /did not inject the bundle that is in dist now \(sha256 bbbbbbbbbbbbbbbb; the run injected aaaaaaaaaaaaaaaa\)/],
    ['a run during which the bundle was rebuilt', { ...good, polyfillSha256s: [HASH, 'c'.repeat(64)] }, current(B), /injected aaaaaaaaaaaaaaaa, cccccccccccccccc/],
    ['a run that recorded no bundle', { ...good, polyfillSha256s: [] }, current(B), /none it recorded/],
    ['no bundle in dist', good, { ...current(B), bundleSha256: null }, /is not built/],
  ]);
  for (const [what, run, cur, why] of cases) {
    assert.throws(() => updateExpectations(exp, run, cur), why, what);
    assert.deepEqual(exp.pass, ['th.html'], `${what}: the expectations passed in are unchanged`);
  }
});

test('the runner records the selection of every run it makes, and the gate writes expectations.json and the report only after the checks', () => {
  const all = listTests();
  assert.equal(selectionOf(all), 'full');
  assert.equal(selectionOf(selectTests({})), 'full', 'control: no option selects every test');
  assert.equal(selectionOf(selectTests({ only: all[0].id })), 'subset', '--only');
  assert.equal(selectionOf(selectTests({ filter: 'offscreen' })), 'subset', '--filter');
  assert.ok(all.some((t) => t.privacy), 'the inventory has privacy tests');
  assert.equal(selectionOf(selectTests({ noPrivacy: true })), 'subset', '--no-privacy');
  assert.equal(selectionOf([...all].reverse()), 'full', 'the order does not matter');
  const run = readFileSync(new URL('../../wpt/run.mjs', import.meta.url), 'utf8');
  // runConfig, which both the gate and the standalone runner call, records the selection and the bundle; the gate no longer sets it after the fact
  assert.match(run, /const doc = \{[^\n]*selection: selectionOf\(tests\)/);
  assert.match(run, /doc\.polyfillSha256s = \[\.\.\.injected\]/);
  assert.match(readFileSync(new URL('../../wpt/lib/session.mjs', import.meta.url), 'utf8'), /readFileSync\(this\.polyfillFile, 'utf8'\);\n\s*this\.injected\.add\(/, 'the hash is of the source as it is injected');
  const gate = readFileSync(new URL('../../wpt/gate.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(gate, /doc\.selection =/);
  assert.match(gate, /updateExpectations\(expectations, docs\.B, current\)/);
  const write = gate.indexOf('writeFileSync(EXPECTATIONS');
  assert.ok(write > gate.indexOf('gateFailures(docs'), 'expectations.json is written after the gate has checked the new lists');
  assert.match(gate.slice(gate.lastIndexOf('\n', write), write), /else if \(rewrite\)/, 'and only when no check failed');
  assert.match(gate, /subjectRunRefusal\(docs\.B, current\)/, 'the report is refused for a subject run the lists would refuse');
  assert.match(gate, /if \(rewrite && failures\.length\) notReported\.push\(/, 'nor triaged with new lists that are not written');
  assert.match(readFileSync(new URL('../../wpt/report.mjs', import.meta.url), 'utf8'), /sha256 \$\{bundleHash\(docs\.B\)\}/, 'the report gives the bundle the run injected');
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
