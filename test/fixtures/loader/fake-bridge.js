// A stand-in for the native bridge (test/unit/api-core/loader.browser.test.mjs): records its place in the load order and registers on the bridge key.
(function () {
  var fake = window.__fake || (window.__fake = { runs: 0, installs: 0, manual: [], order: [] });
  fake.order.push('bridge');
  window[Symbol.for('hic.native-bridge')] = { install: function () {} };
})();
