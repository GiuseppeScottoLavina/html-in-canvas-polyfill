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
