// The unit runner's account of a hung file (test/unit/lib/hang.mjs): each kind of hang reads differently, and none reads as a pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeHang } from '../lib/hang.mjs';

const base = { reason: /** @type {const} */ ('unresponsive'), silentMs: 5100, fileTimeoutMs: 60000, test: 'weird markup', phase: 'test', sinceMs: 5400, browserMs: 3, answeredAfterMs: 1200, graceMs: 10000, longTasks: [{ ms: 6300, test: 'weird markup' }] };

test('a stall of the main thread: the test, its phase, the browser answering, the page answering again and the long task are named', () => {
  const l = describeHang(base);
  assert.equal(l[0], 'HUNG: the page did not answer for 5.1 s while running "weird markup" (its body, started 5.4 s before)');
  assert.equal(l[1], 'the browser process answered in 3 ms');
  assert.match(l[2], /answered again 1\.2 s later: a stall of its main thread/);
  assert.equal(l[3], 'main-thread task of 6.3 s in "weird markup"');
  assert.equal(l.length, 4);
});

test('a page that never answers again is told apart from a stall (control: the same hang with an answer reads as a stall)', () => {
  const l = describeHang({ ...base, answeredAfterMs: null, longTasks: [] });
  assert.match(l[2], /did not answer again within 10\.0 s: it never yields/);
  assert.ok(!l.some((x) => /stall/.test(x)));
  assert.match(describeHang(base)[2], /stall/);
});

test('an answer without a long task puts the delay outside the page; a browser that does not answer is said so', () => {
  const l = describeHang({ ...base, longTasks: [], browserMs: null });
  assert.equal(l[1], 'the browser process did not answer within 2 s either');
  assert.match(l.at(-1), /outside the page/);
});

test('the file limit with a page that answers, the cleanup phase, and a hang before any test', () => {
  const ft = describeHang({ ...base, reason: 'file-timeout', silentMs: 0, phase: 'cleanup', answeredAfterMs: 2, longTasks: [] });
  assert.equal(ft[0], 'HUNG: the file ran past its 60.0 s limit while running "weird markup" (its cleanup, started 5.4 s before)');
  assert.match(ft[2], /waiting on something that never comes/);
  assert.ok(!ft.some((x) => /outside the page/.test(x)), 'a page that was answering is not a delay outside the page');
  assert.match(describeHang({ ...base, test: null, sinceMs: null })[0], /before any test started$/);
});

test('expect-fail: each prefix needs its own kind of report; a timeout- file that failed to load is not a detected timeout (Windows CI, 2026-11-05)', async () => {
  const { expectFailMet } = await import('../lib/hang.mjs');
  const r = (o) => ({ tests: [], pageErrors: [], loadError: null, hung: false, hang: null, ...o });
  assert.equal(expectFailMet('timeout', r({ tests: [{ status: 'timeout' }] }), 5000), true);
  assert.equal(expectFailMet('timeout', r({ loadError: 'timeout waiting for Page.loadEventFired' }), 5000), false);
  assert.equal(expectFailMet('loaderror', r({ loadError: 'x' }), 5000), true);
  assert.equal(expectFailMet('fail', r({ tests: [{ status: 'running' }] }), 5000), false, 'a test still running is not a detected failure');
  assert.equal(expectFailMet('hung', r({ hung: true, hang: { ...base, answeredAfterMs: null } }), 5000), true);
  assert.equal(expectFailMet('hung', r({ hung: true, hang: base }), 5000), false, 'a page that answered again is a stall, not a hang for good');
  assert.equal(expectFailMet('hung', r({ hung: true, hang: { ...base, test: null, answeredAfterMs: null } }), 5000), false, 'the test must be named');
  assert.equal(expectFailMet('stall', r({ hung: true, hang: base }), 5000), true);
  assert.equal(expectFailMet('stall', r({ hung: true, hang: { ...base, longTasks: [{ ms: 4000, test: 'weird markup' }] } }), 5000), false, 'a task shorter than a test timeout');
  assert.equal(expectFailMet('stall', r({ hung: true, hang: { ...base, longTasks: [{ ms: 6300, test: 'other' }] } }), 5000), false, 'a task of another test');
  assert.equal(expectFailMet('nope', r({}), 5000), undefined);
});

test('a hung test is never a pass: the pass a page published after the runner gave up, and a test the page never published, both read as hung (preview.25: `ok ... (0 ms)` and counted)', async () => {
  const { markHung, describeHungTest } = await import('../lib/hang.mjs');
  const rec = (name, status, body = status) => ({ name, status, body, ms: 0, error: '', console: [] });
  const tests = [rec('a', 'pass'), rec('weird markup', 'pass')];
  // a cleanup that blocked the page and then returned: the page published a pass; the binding said the body had passed when the runner gave up
  const cleanup = markHung(tests, { ...base, phase: 'cleanup', body: 'pass' });
  assert.deepEqual(cleanup.map((t) => [t.name, t.status, t.body, t.phase]), [['a', 'pass', 'pass', undefined], ['weird markup', 'hung', 'pass', 'cleanup']]);
  assert.equal(describeHungTest(cleanup[1]), 'weird markup (its body passed; its cleanup had not ended when the runner gave up on the page)');
  // the task after the test, with a body that failed
  const settle = markHung([rec('weird markup', 'fail')], { ...base, phase: 'settle', body: 'fail' });
  assert.equal(describeHungTest(settle[0]), 'weird markup (its body failed; the task after it had not ended when the runner gave up on the page)');
  // a body that returned only after the runner gave up had not returned then: the published body result is not the one reported
  const body = markHung([rec('weird markup', 'pass')], { ...base, phase: 'test', body: null });
  assert.equal(describeHungTest(body[0]), 'weird markup (its body had not returned when the runner gave up on the page)');
  // a page that never answered again published nothing: the test comes from the progress binding
  assert.deepEqual(markHung([], { ...base, phase: 'cleanup', body: 'pass' }).map((t) => [t.name, t.status, t.body, t.phase]), [['weird markup', 'hung', 'pass', 'cleanup']]);
  // the last test of that name is the one the hang names; the others keep their result
  assert.deepEqual(markHung([rec('weird markup', 'pass'), rec('weird markup', 'running', null)], { ...base, body: null }).map((t) => t.status), ['pass', 'hung']);
  // controls: no hang, or a hang before any test, changes nothing
  assert.equal(markHung(tests, null), tests);
  assert.equal(markHung(tests, { ...base, test: null }), tests);
});

test('expect-fail: a hang is detected only when its test is not reported as a pass and, when the file names one, in that phase; wait- is a page that kept answering', async () => {
  const { expectFailMet, markHung } = await import('../lib/hang.mjs');
  const passed = [{ name: 'weird markup', status: 'pass' }];
  const r = (o) => ({ tests: [], pageErrors: [], loadError: null, hung: true, hang: base, ...o });
  // the preview.25 report of a stall in the cleanup: detected as hung, but its test printed `ok`
  assert.equal(expectFailMet('stall', r({ tests: passed, hang: { ...base, phase: 'cleanup' } }), 5000, 'cleanup'), false);
  assert.equal(expectFailMet('stall', r({ tests: markHung(passed, { ...base, phase: 'cleanup' }), hang: { ...base, phase: 'cleanup' } }), 5000, 'cleanup'), true);
  assert.equal(expectFailMet('stall', r({ hang: { ...base, phase: 'test' } }), 5000, 'settle'), false, 'a hang in another phase');
  assert.equal(expectFailMet('stall', r({ hang: { ...base, phase: 'settle' } }), 5000, 'settle'), true);
  assert.equal(expectFailMet('hung', r({ tests: passed, hang: { ...base, answeredAfterMs: null } }), 5000), false, 'hung, but its test printed `ok`');
  const wait = { ...base, reason: /** @type {const} */ ('file-timeout'), silentMs: 0, phase: 'cleanup', answeredAfterMs: 2, longTasks: [] };
  assert.equal(expectFailMet('wait', r({ hang: wait }), 5000, 'cleanup'), true);
  assert.equal(expectFailMet('wait', r({ tests: passed, hang: wait }), 5000, 'cleanup'), false, 'the preview.25 report: `ok ... (0 ms)`');
  assert.equal(expectFailMet('wait', r({ hang: { ...wait, silentMs: 5100 } }), 5000, 'cleanup'), false, 'a page that stopped answering is not a wait');
  assert.equal(expectFailMet('wait', r({ hang: { ...wait, reason: 'unresponsive' } }), 5000, 'cleanup'), false);
});
