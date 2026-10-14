import { test, assert } from '/test/unit/lib/t.js';
import { createPatchLedger } from '/src/api/patch.js';
import { installDevicePixelBox, supportsDevicePixelBox } from '/src/api/ro-dpcb.js';
import { layerCss, LAYER_CSS } from '/src/live/layer-style.js';
import { scaleMode } from '/src/snapshot/capture/svg-builder.js';

/** A window double shaped like Safari 27: observe() rejects the box, entries have no devicePixelContentBoxSize. */
function safariLike() {
  const calls = [];
  class ResizeObserver { observe(target, options) { if (options?.box === 'device-pixel-content-box') throw new TypeError('Type error'); calls.push(options); } disconnect() {} }
  class ResizeObserverEntry { constructor(w, h) { this.contentBoxSize = [{ inlineSize: w, blockSize: h }]; this.contentRect = { width: w, height: h }; } }
  return { win: { ResizeObserver, ResizeObserverEntry, devicePixelRatio: 2, document }, calls };
}

test('Chrome path: the device-pixel-content-box is native, nothing is patched, the layer sheet and the scale mode are unchanged', () => {
  assert.equal(supportsDevicePixelBox(window), true);
  const ledger = createPatchLedger(window);
  const before = Object.getOwnPropertyDescriptor(ResizeObserver.prototype, 'observe');
  installDevicePixelBox({ window }, ledger);
  assert.equal(Object.getOwnPropertyDescriptor(ResizeObserver.prototype, 'observe').value, before.value);
  ledger.restoreAll();
  assert.equal(layerCss(), LAYER_CSS, 'opacity:0 stays on Chromium');
  assert.equal(scaleMode(), 'zoom');
});

test('Safari-like engine: observe() accepts the box (observed as content-box) and entries report contentBox x dpr, restored on uninstall', () => {
  const { win, calls } = safariLike();
  assert.equal(supportsDevicePixelBox(win), false);
  const ledger = createPatchLedger(win);
  installDevicePixelBox({ window: win }, ledger);
  const ro = new win.ResizeObserver();
  ro.observe(document.body, { box: 'device-pixel-content-box' });
  ro.observe(document.body);
  assert.deepEqual(calls, [{ box: 'content-box' }, undefined]);
  const entry = new win.ResizeObserverEntry(400.25, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(entry.devicePixelContentBoxSize)), [{ inlineSize: 801, blockSize: 400 }]);
  ledger.restoreAll();
  assert.equal('devicePixelContentBoxSize' in win.ResizeObserverEntry.prototype, false);
  assert.throws(() => new win.ResizeObserver().observe(document.body, { box: 'device-pixel-content-box' }), TypeError);
});
