// What the unit runner says about a hung file: pure, so the wording and its cases are tested in Node (test/unit/runner-selftest/hang.test.mjs).

/**
 * @typedef {object} HangInfo
 * @property {'unresponsive'|'file-timeout'} reason the page did not answer for one test timeout, or the whole file ran past --file-timeout
 * @property {number} silentMs how long the page had not answered when the runner gave up on it (0: it was answering)
 * @property {number} fileTimeoutMs the --file-timeout in force
 * @property {string|null} test the test the page last said it started (from the progress binding, so also known when the page never answers again)
 * @property {string|null} phase 'test' (its body), 'cleanup' (its t.cleanup callbacks and fixture removal) or 'settle' (the task after it)
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
