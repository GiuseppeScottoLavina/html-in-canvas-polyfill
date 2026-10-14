/* Generic painter, the pattern from the HTML-in-Canvas explainer:
 *   ResizeObserver(device-pixel-content-box) -> canvas.width/height   (the backing store follows the device pixels)
 *   canvas 'paint' event                     -> ctx.drawElementImage(child, 0, 0, destW, destH) for every [drawable] child
 * It works unchanged on the native implementation and on a polyfill. Counters live in window.__HIC_DRAW:
 *   { paints, resizes, errors[], lastBacking:[w,h], lastDrawMs, paintTimes[], ready }
 * Wait on `paints` increasing, never on sleeps alone. Any failure is loud (console.error + __HIC_FIXTURE.fail).
 */
const F = window.__HIC_FIXTURE;
const D = window.__HIC_DRAW = { paints: 0, resizes: 0, errors: [], lastBacking: null, lastDrawMs: 0, paintTimes: [], ready: false };
const canvas = document.querySelector('canvas[content], canvas[layoutsubtree]');
const geomDone = new WeakSet();

function fail(msg) { D.errors.push(msg); F?.fail?.(msg); }

function drawables() {
  const kids = [...canvas.children];
  const marked = kids.filter(k => k.hasAttribute('drawable'));
  return marked.length ? marked : kids; // legacy native (layoutsubtree) draws children without the attribute
}

function draw() {
  const t0 = performance.now();
  try {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const css = canvas.getBoundingClientRect();
    const sx = css.width ? canvas.width / css.width : 1, sy = css.height ? canvas.height / css.height : 1;
    for (const el of drawables()) {
      ctx.drawElementImage(el, 0, 0, el.offsetWidth * sx, el.offsetHeight * sy);
      // Chrome 154 (flag) does not make a drawn child hit-testable from drawElementImage alone (E6 probe: `updateElementGeometry(el, {})` does it,
      // verified again at DPR 2). Native mode only; the polyfill owns geometry itself.
      if (F?.mode === 'native' && !geomDone.has(el) && typeof canvas.updateElementGeometry === 'function') { canvas.updateElementGeometry(el, {}); geomDone.add(el); }
    }
    D.paints++; D.paintTimes.push(t0);
    if (D.paintTimes.length > 5000) D.paintTimes.splice(0, 2500);
    D.lastDrawMs = performance.now() - t0;
    if (!D.ready) { D.ready = true; if (F) F.ready = true; }
  } catch (e) { fail('painter draw failed: ' + (e?.message ?? e)); }
}

function fit(entry) {
  let w, h;
  const box = entry?.devicePixelContentBoxSize?.[0];
  if (box) { w = box.inlineSize; h = box.blockSize; }
  else { const r = canvas.getBoundingClientRect(); w = Math.round(r.width * devicePixelRatio); h = Math.round(r.height * devicePixelRatio); }
  w = Math.max(1, w); h = Math.max(1, h);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; D.resizes++; D.lastBacking = [w, h]; canvas.requestPaint?.(); }
}

if (!canvas) fail('painter: no canvas');
else if (typeof CanvasRenderingContext2D.prototype.drawElementImage !== 'function') {
  fail('painter: ctx.drawElementImage is missing. mode=native needs Chrome launched with --enable-blink-features=CanvasDrawElement (launchChrome({nativeDrawElement:true})); mode=poly needs a bundle that installs the API.');
} else {
  try { new ResizeObserver(es => fit(es[es.length - 1])).observe(canvas, { box: 'device-pixel-content-box' }); }
  catch { new ResizeObserver(() => fit(null)).observe(canvas); }
  fit(null);
  canvas.addEventListener('paint', draw);
  canvas.requestPaint?.();
}
