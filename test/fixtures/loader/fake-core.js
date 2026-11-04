// A stand-in for the classic core (dist/hic-live-polyfill.iife.js) for test/unit/api-core/loader.browser.test.mjs: it defines HicLivePolyfill, installs at once
// unless its <script> has data-hic-manual (as src/iife.js does), and records what happened in window.__fake (runs, installs, manual, the load order).
(function () {
  var w = window;
  var script = document.currentScript;
  var fake = w.__fake || (w.__fake = { runs: 0, installs: 0, manual: [], order: [] });
  fake.runs++;
  fake.order.push('core');
  fake.manual.push(!!(script && script.hasAttribute('data-hic-manual')));
  var installed = null;
  w.HicLivePolyfill = {
    install: function (options) {
      fake.installs++;
      installed = installed || { mode: 'polyfill', native: { kind: 'absent' }, options: options };
      return installed;
    },
    getInstalled: function () { return installed; },
  };
  if (!(script && script.hasAttribute('data-hic-manual'))) w.HicLivePolyfill.install();
})();
