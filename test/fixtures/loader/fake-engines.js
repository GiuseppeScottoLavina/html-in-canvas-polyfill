// A stand-in for the engines bundle (test/unit/api-core/loader.browser.test.mjs): records its place in the load order and registers on the engines key.
(function () {
  var fake = window.__fake || (window.__fake = { runs: 0, installs: 0, manual: [], order: [] });
  fake.order.push('engines');
  window[Symbol.for('hic.engine-skins')] = {};
})();
