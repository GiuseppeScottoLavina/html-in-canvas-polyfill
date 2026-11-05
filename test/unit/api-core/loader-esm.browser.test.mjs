// The module loader (src/loader.js) with the REAL core on the polyfill path (the runner disables the browser's own implementation): ten concurrent calls import the
// loader's core module (src/loader-core.js, not the package entry) once and install once, mode polyfill, whenPainted works; on Chromium the engines are not imported.
// One window per file: the load is shared per window, so this file holds one such test. The engines on Gecko / WebKit: loader-esm-engines.browser.test.mjs.
import { test, assert } from '/test/unit/lib/t.js';
import { load } from '/src/loader.js';

test('10 concurrent load() calls: the loader\'s core module imported once (not the package entry, not the engines), one install in mode polyfill, the same result, whenPainted resolves', async t => {
  assert.equal(window[Symbol.for('hic.installed')], undefined, 'nothing installed before');
  const requested = (/** @type {string} */ path) => performance.getEntriesByType('resource').filter((e) => new URL(e.name).pathname === path).length;
  const imported = () => requested('/src/loader-core.js');
  assert.equal(imported(), 0, 'the core is not loaded with the loader');
  const results = await Promise.all(Array.from({ length: 10 }, () => load()));
  const r = results[0];
  t.cleanup(() => r.installed?.uninstall());
  assert.ok(results.every((x) => x === r), 'one result');
  assert.equal(r.status, 'polyfill', `${r.status}: ${r.reason}`);
  assert.equal(r.mode, 'polyfill');
  assert.equal(r.native.kind, 'absent');
  assert.equal(imported(), 1, 'one request for the loader\'s core module');
  assert.equal(requested('/src/index.js'), 0, 'the package entry is not imported');
  assert.equal(requested('/src/engines.js'), 0, 'Chromium: the engines are not imported');
  assert.equal(window[Symbol.for('hic.engine-skins')], undefined, 'Chromium: no engines registered');
  assert.equal(typeof globalThis[Symbol.for('hic.gpu-patches')]?.installTexturePatches, 'function', 'the GPU bundle is registered, as with the package entry');
  const { getInstalled } = await import('/src/index.js');
  assert.equal(getInstalled(), r.installed, 'the live HicInstalled is the package entry\'s');
  const host = document.createElement('div');
  host.innerHTML = '<canvas content="drawable" width="80" height="40"><div drawable style="width:40px;height:20px;background:rgb(0,128,0)">x</div></canvas>';
  document.body.append(host);
  t.cleanup(() => host.remove());
  const canvas = /** @type {HTMLCanvasElement} */ (host.firstElementChild);
  canvas.requestPaint();
  await r.installed.whenPainted(canvas, 8000);
  assert.equal(await load(), r, 'a later call shares the result');
  assert.equal(await load({ install: {}, bridge: false }), r, 'the valid options of a later call are ignored: the load is shared');
  await assert.rejects(load({ install: {}, core: '/x.js' }), /classic-loader option/, 'an invalid option of a later call rejects, as install() throws');
}, { timeout: 30000 });

test('the classic-only options are a TypeError in the module loader (load() rejects), checked before anything is imported', async t => {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  t.cleanup(() => frame.remove());
  const w = /** @type {any} */ (frame.contentWindow);
  for (const bad of [{ core: '/dist/hic-live-polyfill.iife.js' }, { engines: '/dist/hic-live-engines.iife.js' }, { bridge: '/x.js' }, { nonce: 'n' }]) {
    await assert.rejects(load({ install: { window: w }, ...bad }), /classic-loader option/, JSON.stringify(bad));
  }
  assert.equal(w[Symbol.for('hic.installed')], undefined);
  assert.equal(w[Symbol.for('hic.loader')], undefined, 'the frame\'s load was not taken');
});
