// The module loader (src/loader.js) with the REAL core on the polyfill path (the runner disables the browser's own implementation): ten concurrent calls import the
// package entry once and install once, mode polyfill, whenPainted works. One window per file: the load is shared per window, so this file holds one such test.
import { test, assert } from '/test/unit/lib/t.js';
import { load } from '/src/loader.js';

test('10 concurrent load() calls: the package entry imported once, one install in mode polyfill, the same result, whenPainted resolves', async t => {
  assert.equal(window[Symbol.for('hic.installed')], undefined, 'nothing installed before');
  const imported = () => performance.getEntriesByType('resource').filter((e) => new URL(e.name).pathname === '/src/index.js').length;
  assert.equal(imported(), 0, 'the package entry is not loaded with the loader');
  const results = await Promise.all(Array.from({ length: 10 }, () => load()));
  const r = results[0];
  t.cleanup(() => r.installed?.uninstall());
  assert.ok(results.every((x) => x === r), 'one result');
  assert.equal(r.status, 'polyfill', `${r.status}: ${r.reason}`);
  assert.equal(r.mode, 'polyfill');
  assert.equal(r.native.kind, 'absent');
  assert.equal(imported(), 1, 'one request for the package entry');
  const { getInstalled } = await import('/src/index.js');
  assert.equal(getInstalled(), r.installed, 'the live HicInstalled');
  const host = document.createElement('div');
  host.innerHTML = '<canvas content="drawable" width="80" height="40"><div drawable style="width:40px;height:20px;background:rgb(0,128,0)">x</div></canvas>';
  document.body.append(host);
  t.cleanup(() => host.remove());
  const canvas = /** @type {HTMLCanvasElement} */ (host.firstElementChild);
  canvas.requestPaint();
  await r.installed.whenPainted(canvas, 8000);
  assert.equal(await load(), r, 'a later call shares the result');
  const urls = await load({ install: {}, core: '/x.js' });
  assert.equal(urls, r, 'later options are ignored: the load is shared');
}, { timeout: 30000 });

test('the classic-only options are a TypeError in the module loader (status error), checked before anything is imported', async t => {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  t.cleanup(() => frame.remove());
  const w = /** @type {any} */ (frame.contentWindow);
  const r = await load({ install: { window: w }, core: '/dist/hic-live-polyfill.iife.js' });
  assert.equal(r.status, 'error');
  assert.ok(r.error instanceof TypeError && /classic-loader option/.test(r.error.message), String(r.error));
  assert.equal(w[Symbol.for('hic.installed')], undefined);
});
