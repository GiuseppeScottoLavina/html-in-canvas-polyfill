// What the unit runner says about a hung file: pure, so the wording and its cases are tested in Node (test/unit/runner-selftest/hang.test.mjs).

/**
 * @typedef {object} HangInfo
 * @property {'unresponsive'|'file-timeout'} reason the page did not answer for one test timeout, or the whole file ran past --file-timeout
 * @property {number} silentMs how long the page had not answered when the runner gave up on it (0: it was answering)
 * @property {number} fileTimeoutMs the --file-timeout in force
 * @property {string|null} test the test the page last said it started (from the progress binding, so also known when the page never answers again)
 * @property {string|null} phase 'test' (its body), 'cleanup' (its t.cleanup callbacks and fixture removal) or 'settle' (the task after it)
 * @property {string|null} [body] that test's body result then ('pass', 'fail', 'timeout'; null: the body had not returned), from the progress binding
 * @property {number|null} sinceMs how long before the runner gave up that test had started
 * @property {number|null} browserMs how long the browser process took to answer a browser-level command then (null: no answer within 2 s)
 * @property {number|null} answeredAfterMs how long after the runner gave up the page answered again (null: not within graceMs)
 * @property {number} graceMs how long the runner waited for that
 * @property {{ms:number, test:string|null}[]} longTasks main-thread tasks of a second or more that the page reported, with the test each fell in
 */

const s = (/** @type {number} */ ms) => `${(ms / 1000).toFixed(1)} s`;

/**
 * One line per finding, the first one starting with HUNG: what stopped, where, and what the page and the browser did after, so a hang that cannot be
 * reproduced can still be told apart: a test that never yields, a long stall of the renderer's main thread, or a browser that stopped answering.
 * @param {HangInfo} h
 * @returns {string[]}
 */
export function describeHang(h) {
  const what = h.reason === 'file-timeout' ? `the file ran past its ${s(h.fileTimeoutMs)} limit` : `the page did not answer for ${s(h.silentMs)}`;
  const where = h.test
    ? ` while running "${h.test}" (${{ test: 'its body', cleanup: 'its cleanup', settle: 'the task after it' }[h.phase ?? 'test'] ?? h.phase}${h.sinceMs != null ? `, started ${s(h.sinceMs)} before` : ''})`
    : ' before any test started';
  const lines = [`HUNG: ${what}${where}`];
  lines.push(h.browserMs != null ? `the browser process answered in ${h.browserMs} ms` : 'the browser process did not answer within 2 s either');
  if (h.answeredAfterMs == null) lines.push(`the page did not answer again within ${s(h.graceMs)}: it never yields (an endless loop, or a renderer stuck for good)`);
  else if (h.reason === 'file-timeout' && h.silentMs === 0) lines.push('the page was answering: a test or its cleanup is waiting on something that never comes');
  else lines.push(`the page answered again ${s(h.answeredAfterMs)} later: a stall of its main thread, not an endless loop`);
  for (const t of h.longTasks) lines.push(`main-thread task of ${s(t.ms)}${t.test ? ` in "${t.test}"` : ' outside any test'}`);
  if (h.answeredAfterMs != null && h.silentMs > 0 && !h.longTasks.length) lines.push('no main-thread task of a second or more was reported: the delay was outside the page (the CDP channel or the browser process)');
  return lines;
}

/**
 * @typedef {object} TestRecord what the host page publishes per test (host.js), and what the runner reports
 * @property {string} name
 * @property {string} status 'running' (not finished: its body, its cleanup or the task after it), 'pass', 'fail', 'timeout', 'skip', or 'hung' (set here)
 * @property {string|null} [body] the result of the test's body alone ('pass', 'fail', 'timeout'; null while the body runs), published when the body ends
 * @property {string|null} [phase] for a hung test, the phase the hang names
 * @property {number} ms
 * @property {string} error
 * @property {{type: string, text: string}[]} console
 */

/**
 * The tests of a hung file as the runner reports them: the test the hang names is 'hung', never a pass, whatever the page published after the runner gave up
 * on it (a test that blocked the page past its limit and then returned, or whose cleanup or the task after it never ended, used to be printed `ok` and
 * counted). Its body's result stays apart, as it was when the runner gave up (`h.body`: a body that returned after that had not returned then). A page
 * that never answered again published nothing: the test is added from what the progress binding said.
 * @param {TestRecord[]} tests what the page published (empty when its state could not be read)
 * @param {HangInfo|null} h
 * @returns {TestRecord[]}
 */
export function markHung(tests, h) {
  if (!h?.test) return tests;
  let i = tests.length - 1;
  while (i >= 0 && tests[i].name !== h.test) i -= 1;
  const old = i >= 0 ? tests[i] : { name: h.test, status: 'running', ms: 0, error: '', console: [] };
  const rec = { ...old, status: 'hung', phase: h.phase, body: h.body ?? null };
  return i >= 0 ? tests.map((t, k) => (k === i ? rec : t)) : [...tests, rec];
}

/**
 * The line of a test the hang names, after its HUNG tag.
 * @param {TestRecord} t
 * @returns {string}
 */
export function describeHungTest(t) {
  const body = t.body == null ? 'its body had not returned' : `its body ${{ pass: 'passed', fail: 'failed', timeout: 'timed out' }[t.body] ?? t.body}`;
  const phase = { cleanup: '; its cleanup had not ended', settle: '; the task after it had not ended' }[t.phase ?? ''] ?? '';
  return `${t.name} (${body}${phase} when the runner gave up on the page)`;
}

/**
 * --expect-fail: whether the runner detected what a deliberate failure's file name prefix says. `undefined` for an unknown prefix. A file that failed in
 * another way (a load error for a timeout- file) is NOT a detection: each self-test proves one kind of report.
 * For the three kinds of hang, the test the hang names must not be reported as a pass, and a `phase` given must be the phase the hang names.
 * @param {string} kind fail, timeout, pageerror, loaderror, hung (the page never answers again, its test named), stall (it answers again, with the long task
 *   of that test, at least one test timeout long) or wait (the file ran past --file-timeout while the page kept answering: a promise that never settles)
 * @param {{tests: {name?: string, status: string}[], pageErrors: string[], loadError: string|null, hung: boolean, hang: HangInfo|null}} r
 * @param {number} timeoutMs the runner's --timeout
 * @param {string|null} [phase] 'test', 'cleanup' or 'settle': where the hang must be (the file name's second word, when it is one of these)
 * @returns {boolean|undefined}
 */
export function expectFailMet(kind, r, timeoutMs, phase = null) {
  const h = r.hang;
  const hungThere = () => !!r.hung && !!h?.test && (phase == null || h.phase === phase) && !r.tests.some((t) => t.name === h.test && t.status === 'pass');
  return {
    fail: () => r.tests.some((t) => t.status === 'fail'), timeout: () => r.tests.some((t) => t.status === 'timeout'),
    pageerror: () => r.pageErrors.length > 0, loaderror: () => !!r.loadError,
    hung: () => hungThere() && h?.answeredAfterMs == null,
    stall: () => hungThere() && h?.answeredAfterMs != null && h.longTasks.some((t) => t.test === h.test && t.ms >= timeoutMs),
    wait: () => hungThere() && h?.reason === 'file-timeout' && h.silentMs === 0 && h.answeredAfterMs != null,
  }[kind]?.();
}
