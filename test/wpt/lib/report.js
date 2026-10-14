// Appended to the upstream testharnessreport.js stub: collects every subtest result into window.__WPT for the CDP runner.
(function () {
  'use strict';
  if (typeof add_result_callback !== 'function' || window !== window.top) return;
  const R = window.__WPT = { done: false, harnessStatus: null, harnessMessage: null, tests: [] };
  const clip = s => (s == null ? null : String(s).slice(0, 600));
  add_result_callback(t => { R.tests.push({ name: clip(t.name), status: t.status, message: clip(t.message) }); });
  add_completion_callback((tests, status) => {
    R.harnessStatus = status.status; R.harnessMessage = clip(status.message); R.done = true;
  });
})();
