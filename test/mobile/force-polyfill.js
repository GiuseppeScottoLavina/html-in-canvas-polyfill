/* G-mobile on a browser with a usable NATIVE HTML-in-Canvas (Chromium 158 on Android ships it without a flag): the polyfill steps aside there by design, so to run
 * the polyfill's own path on that real engine this classic script, loaded right AFTER the core bundle, replaces the auto-install with install({ forcePolyfill: true })
 * (the documented test-only override, src/api/native-detect.js decideMode). window.__HIC__.installed follows the new instance. Not for pages: tests only. */
(function () {
  var h = window.__HIC__;
  if (!h || !h.installed || h.installed.mode === 'polyfill' || !window.HicLivePolyfill) return;
  h.installed.uninstall();
  window.HicLivePolyfill.install({ forcePolyfill: true });
})();
