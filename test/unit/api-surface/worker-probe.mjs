// Module worker of worker.browser.test.mjs: the worker bundle's source, then commands from the page. Replies {ok, ...} or {error: name}.
import '/src/worker.js';

/** @type {Map<string, OffscreenCanvas>} */
const canvases = new Map();
let image = null;
self.onmessage = (e) => {
  const d = e.data;
  try {
    if (d.canvas) { canvases.set(d.name, d.canvas); self.postMessage({ ok: true }); return; }
    if (d.image) { image = d.image; self.postMessage({ ok: true, isImage: image instanceof ElementImage, tag: Object.prototype.toString.call(image) }); return; }
    const oc = canvases.get(d.on);
    if (d.cmd === 'draw') {
      const ctx = oc.getContext('2d');
      ctx.reset();
      ctx.drawElementImage(image, ...d.args);
      self.postMessage({ ok: true, px: Array.from(ctx.getImageData(d.at[0], d.at[1], 1, 1).data) });
    } else if (d.cmd === 'size') self.postMessage({ ok: true, size: oc.getElementImageDefaultSize(image) });
    else if (d.cmd === 'clear') { oc.clearElementGeometry(image); self.postMessage({ ok: true }); }
    else if (d.cmd === 'transform') self.postMessage({ ok: true, m: Array.from(oc.getElementTransform(image, new DOMMatrix().translate(5, 6)).toFloat64Array()) });
    else if (d.cmd === 'standalone') new OffscreenCanvas(10, 10).getContext('2d').drawElementImage(image, 0, 0);
    else if (d.cmd === 'close') { image.close(); oc.getContext('2d').drawElementImage(image, 0, 0); }
  } catch (err) {
    self.postMessage({ error: err.name });
  }
};
