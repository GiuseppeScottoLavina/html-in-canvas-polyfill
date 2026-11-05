// The module loader (src/loader.js) and the engines on the polyfill path, with the REAL core in frames that identify as Safari 27 and Firefox 156: the engines
// module (src/engines.js) is imported beside the loader's core module on Gecko / WebKit, not on Chromium and not with `engines: false`. The engines register
// themselves on this realm's globalThis when imported, so the cases that must not import them run first; this file holds one module graph (a fresh tab).
import { test, assert } from '/test/unit/lib/t.js';
import { load } from '/src/loader.js';
import { makeFrame } from './_page-env.mjs';

const UA = {
  firefox156: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:156.0) Gecko/20100101 Firefox/156.0',
  safari27: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15',
};
/** @param {any} w @param {string} ua */
const asAgent = (w, ua) => {
  Object.defineProperty(w.navigator, 'userAgent', { get: () => ua, configurable: true });
  Object.defineProperty(w.navigator, 'userAgentData', { get: () => undefined, configurable: true });
};
const requested = (/** @type {string} */ path) => performance.getEntriesByType('resource').filter((e) => new URL(e.name).pathname === path).length;
const SKINS = Symbol.for('hic.engine-skins');

/** load() in a fresh frame that identifies as `ua` (none: this Chromium). @param {any} t @param {string|null} ua @param {object} [opts] */
async function loadIn(t, ua, opts = {}) {
  const w = makeFrame(t, '<canvas content="drawable"><b drawable></b></canvas>');
  if (ua) asAgent(w, ua);
  const r = await load({ ...opts, install: { window: w } });
  t.cleanup(() => r.installed?.uninstall());
  return r;
}

test('Chromium, and Safari / Firefox with engines: false: the polyfill installs without importing the engines', async t => {
  assert.equal(globalThis[SKINS], undefined, 'no engines before');
  for (const [label, ua, opts] of /** @type {Array<[string, string|null, object]>} */ ([['Chromium', null, {}], ['Safari 27, engines: false', UA.safari27, { engines: false }], ['Firefox 156, engines: false', UA.firefox156, { engines: false }]])) {
    const r = await loadIn(t, ua, opts);
    assert.equal(r.status, 'polyfill', `${label}: ${r.status} ${r.reason}`);
    assert.equal(requested('/src/engines.js'), 0, `${label}: the engines module was imported`);
    assert.equal(globalThis[SKINS], undefined, `${label}: the engines registered`);
  }
  assert.equal(requested('/src/loader-core.js'), 1, 'the loader\'s core module, once');
  assert.equal(requested('/src/index.js'), 0, 'never the package entry');
});

test('Safari 27 and Firefox 156 without the option: the engines are imported once and registered by the time install() runs', async t => {
  const safari = await loadIn(t, UA.safari27);
  assert.equal(safari.status, 'polyfill', `${safari.status} ${safari.reason}`);
  assert.equal(requested('/src/engines.js'), 1, 'the engines module, once');
  assert.equal(typeof globalThis[SKINS]?.paintNativeControl, 'function', 'the engines registered');
  const firefox = await loadIn(t, UA.firefox156);
  assert.equal(firefox.status, 'polyfill');
  assert.equal(requested('/src/engines.js'), 1, 'a module is imported once per realm');
});
