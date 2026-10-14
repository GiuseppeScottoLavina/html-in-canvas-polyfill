/* Fixture bootstrap (classic, synchronous). Put
 *     <script src="/test/fixtures/shared/boot.js"></script>
 * at the END of <body>, right after the <canvas content="drawable"> markup.
 *
 * Query parameters
 *   mode=poly|ref|native   (default poly)
 *     ref     plain-DOM reference: the canvas is replaced by a <div> with the same id/class/style, children moved verbatim, NO
 *             polyfill, NO painter. Same page + same CSS => same layout => pixel-comparable with the canvas variants.
 *     poly    canvas[content=drawable] + the polyfill bundle (REQUIRED: ?bundle=...) + the generic painter.
 *     native  canvas[content=drawable] + the browser's own implementation (launch Chrome with
 *             --enable-blink-features=CanvasDrawElement) + the generic painter. A bundle is optional here: giving one tests
 *             the "native-first, polyfill steps aside" path.
 *   bundle=none|<url path>[,<url path>...]  classic (IIFE) polyfill script(s), in this order, loaded with document.write BEFORE anything else so it can patch
 *                           DOM getters first. Default none. A bundle that 404s fails LOUDLY (console.error, red banner,
 *                           window.__HIC_FIXTURE.fatal).
 *   painter=generic|none    generic (default): /test/fixtures/shared/painter.js draws every [drawable] child with
 *                           drawElementImage on `paint` and keeps the backing store at device-pixel size. none: the page draws.
 *   legacy=1                also set the legacy `layoutsubtree` attribute (older native builds, e.g. Chrome 154 behind the flag,
 *                           know `layoutSubtree` but not `content`). Applied automatically in native mode when `content` is not
 *                           a canvas property but `layoutSubtree` is.
 *   cap=N                   set the polyfill-extension attribute framecap=N on the canvas (poly mode only; extension name may change).
 *   iso=0                   (server) omit COOP/COEP headers.
 *
 * window.__HIC_FIXTURE = { mode, bundle, params, errors[], fatal, bundleLoaded, ready, refReady, nativeSupported, legacyAttr }
 *   ready becomes true when the first non-empty frame has been drawn (poly/native) or the reference swap is done (ref).
 */
(function () {
  var q = new URLSearchParams(location.search);
  var mode = q.get('mode') || 'poly';
  var bundle = q.get('bundle') || 'none';
  var me = document.currentScript;
  var base = me ? new URL('.', me.src).href : '/test/fixtures/shared/';
  var canvas = document.querySelector('canvas[content]');
  var F = window.__HIC_FIXTURE = {
    mode: mode, bundle: bundle, params: Object.fromEntries(q), errors: [], fatal: null, bundleLoaded: false, ready: false, refReady: false,
    nativeSupported: typeof CanvasRenderingContext2D !== 'undefined' && typeof CanvasRenderingContext2D.prototype.drawElementImage === 'function',
    legacyAttr: false, bootAt: performance.now(),
  };
  function fatal(msg) {
    F.fatal = F.fatal || msg; F.errors.push(msg); console.error('[hic-fixture] ' + msg);
    var b = document.createElement('div');
    b.style.cssText = 'position:fixed;left:0;top:0;right:0;z-index:2147483647;background:#b00020;color:#fff;font:14px/1.4 monospace;padding:10px';
    b.textContent = 'FIXTURE ERROR: ' + msg; (document.body || document.documentElement).appendChild(b);
  }
  F.fail = fatal;
  F.bundleFailed = function (src) { fatal('bundle failed to load: ' + src); };
  if (!canvas) return fatal('fixture has no canvas[content] element');

  if (mode === 'ref') {
    var d = document.createElement('div');
    for (var i = 0; i < canvas.attributes.length; i++) {
      var a = canvas.attributes[i];
      if (!/^(width|height|content|layoutsubtree|framecap)$/.test(a.name)) d.setAttribute(a.name, a.value);
    }
    d.style.overflow = 'hidden'; // a canvas clips its children to its box; a div would not
    // The native canvas lays its children out at the content-box origin, without margins (WPT containment / canvas-transform-*): so does the polyfill's layer and sizes auto-width children to fit their content (shrink-to-fit, like native).
    d.style.display = 'grid'; d.style.gridTemplate = '100% / 100%'; d.style.alignItems = 'start';
    var s = document.createElement('style'); s.textContent = 'div[data-hic-twin] > * { grid-area: 1 / 1 !important; margin: 0 !important; position: static !important; justify-self: start !important; align-self: start !important; }';
    d.setAttribute('data-hic-twin', ''); (document.head || document.documentElement).appendChild(s);
    while (canvas.firstChild) d.appendChild(canvas.firstChild);
    d.querySelectorAll(':scope > [drawable]').forEach(function (c) { c.removeAttribute('drawable'); });
    canvas.replaceWith(d);
    F.refReady = F.ready = true;
    return;
  }
  if (mode !== 'poly' && mode !== 'native') return fatal('unknown mode=' + mode + ' (poly|ref|native)');
  if (mode === 'poly' && bundle === 'none') return fatal('mode=poly needs ?bundle=<path to the polyfill IIFE build>; use mode=ref or mode=native to run without one');

  var wantLegacy = q.get('legacy') === '1' || (mode === 'native' && !('content' in canvas) && 'layoutSubtree' in canvas);
  if (wantLegacy) { canvas.setAttribute('layoutsubtree', ''); F.legacyAttr = true; }
  if (mode === 'poly' && q.get('cap')) canvas.setAttribute('framecap', q.get('cap'));
  if (bundle !== 'none') {
    // bundle=a.js,b.js loads the scripts in that order (core, then the optional effects bundles); bundleLoaded is set by the last one
    var list = bundle.split(',');
    list.forEach(function (path, i) {
      document.write('<script src="' + path + '"' + (i === list.length - 1 ? ' onload="window.__HIC_FIXTURE.bundleLoaded=true"' : '') + ' onerror="window.__HIC_FIXTURE.bundleFailed(this.src)"><\/script>');
    });
  }
  if ((q.get('painter') || 'generic') === 'generic') document.write('<script type="module" src="' + base + 'painter.js"><\/script>');
})();
