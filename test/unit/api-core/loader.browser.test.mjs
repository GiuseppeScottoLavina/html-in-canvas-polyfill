// The loader (src/api/loader.js): (1) it decides exactly as install() does on the native-detect matrix, (2) the classic fetcher's mechanics on stand-in bundles
// (test/fixtures/loader/): one request and one install for concurrent calls, the timeout and a late bundle that never installs, a 404, a CSP-blocked script, the order
// engines / bridge before the core. The real core on the polyfill path: loader-esm.browser.test.mjs here, and G-bundle (scripts/check-bundle.mjs) on the built files.
import { test, assert, sleep } from '/test/unit/lib/t.js';
import { installWith } from '/src/api/install.js';
import { createLoad, scriptFetcher } from '/src/api/loader.js';
import { EXT } from '/src/contracts/events.js';
import '/src/native-bridge.js'; // registers the bridge on this page: install() bridges a legacy or fillable native only with it
import { defineFakeNative, fakeServices, makeFrame } from './_page-env.mjs';

const BRIDGE_KEY = EXT.NATIVE_BRIDGE_KEY;
const SLOT = Symbol.for('hic.loader');
const UA = {
  firefox140: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0',
  firefox156: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:156.0) Gecko/20100101 Firefox/156.0',
  safari27: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15',
};
/** @param {any} w @param {string} ua */
const asAgent = (w, ua) => {
  Object.defineProperty(w.navigator, 'userAgent', { get: () => ua, configurable: true });
  Object.defineProperty(w.navigator, 'userAgentData', { get: () => undefined, configurable: true });
};
/** a frame's value as plain JSON (deepEqual compares prototypes, and the frame's arrays are of another realm) @param {unknown} v */
const plain = (v) => JSON.parse(JSON.stringify(v));
/** @param {any} w */
const quiet = (w) => { const warnings = /** @type {string[]} */ ([]); w.console.warn = (/** @type {any[]} */ ...a) => warnings.push(a.join(' ')); return warnings; };

/** Run with the page's bridge registration removed (install() then steps aside in mode native, as on a page without the bridge bundle). @param {() => any} fn */
async function withoutBridge(fn) {
  const kept = Object.getOwnPropertyDescriptor(globalThis, BRIDGE_KEY);
  delete (/** @type {any} */ (globalThis))[BRIDGE_KEY];
  try { return await fn(); } finally { if (kept) Object.defineProperty(globalThis, BRIDGE_KEY, kept); }
}

/** install()'s answer on a fresh frame: its mode, or the refusal it throws. @param {any} t @param {(w: any) => void} setup @param {object} opts */
function installAnswer(t, setup, opts) {
  const w = makeFrame(t, '<canvas content="drawable"><b drawable></b></canvas>');
  setup(w);
  quiet(w);
  try {
    const installed = installWith({ window: w, ...opts }, fakeServices());
    const mode = installed.mode;
    installed.uninstall();
    return { mode, feature: null, message: null };
  } catch (e) {
    return { mode: 'refused', feature: /** @type {any} */ (e).feature, message: /** @type {any} */ (e).message };
  }
}

/** load()'s answer on a fresh frame, with a fetcher that records what it was asked for and installs with fake services. */
async function loadAnswer(/** @type {any} */ t, /** @type {(w: any) => void} */ setup, /** @type {object} */ opts, /** @type {object} */ loadOpts = {}) {
  const w = makeFrame(t, '<canvas content="drawable"><b drawable></b></canvas>');
  setup(w);
  const warnings = quiet(w);
  /** @type {Array<{bridge: boolean, engines: boolean}>} */ const fetched = [];
  const load = createLoad({ check() {}, fetch: async (_w, need) => { fetched.push(need); return { install: (/** @type {any} */ o) => installWith(o, fakeServices()) }; } });
  const r = await load({ ...loadOpts, install: { window: w, ...opts } });
  t.cleanup(() => r.installed?.uninstall());
  return { r, fetched, warnings };
}

/** @type {Array<[string, (w: any) => void, object, 'native'|'native-bridged'|'polyfill'|'refused']>} label, window shape, install options, the mode install() gives */
const MATRIX = [
  ['absent', () => {}, {}, 'polyfill'],
  ['complete (Chrome 157)', (w) => defineFakeNative(w), {}, 'native'],
  ['partial without a buildable gap', (w) => defineFakeNative(w, { omit: ['requestPaint'] }), {}, 'native'],
  ['partial, fillable (ElementImage.width/height, no size getter)', (w) => defineFakeNative(w, { shape: 'previous' }), {}, 'native-bridged'],
  ['legacy (Chrome 154 + flag)', (w) => defineFakeNative(w, { shape: 'legacy' }), {}, 'native-bridged'],
  ['inert stub draw (unverified complete)', (w) => defineFakeNative(w, { inert: true }), {}, 'native'],
  ['broken: no onpaint', (w) => defineFakeNative(w, { omit: ['onpaint'] }), {}, 'refused'],
  ['broken: no 2D drawElementImage', (w) => defineFakeNative(w, { omit: ['CanvasRenderingContext2D.drawElementImage'] }), {}, 'refused'],
  ['gate refused: Firefox 140', (w) => asAgent(w, UA.firefox140), {}, 'refused'],
  ['gate refused with a complete native', (w) => { asAgent(w, UA.firefox140); defineFakeNative(w); }, {}, 'native'],
  ['forcePolyfill over a complete native', (w) => defineFakeNative(w), { forcePolyfill: true }, 'polyfill'],
  ['forcePolyfill over a broken native', (w) => defineFakeNative(w, { omit: ['onpaint'] }), { forcePolyfill: true }, 'polyfill'],
  ['forcePolyfill on a refused browser', (w) => asAgent(w, UA.firefox140), { forcePolyfill: true }, 'refused'],
  ['mode polyfill over a complete native (steps aside)', (w) => defineFakeNative(w), { mode: 'polyfill' }, 'native'],
  ['native-only, absent', () => {}, { mode: 'native-only' }, 'refused'],
  ['native-only, complete', (w) => defineFakeNative(w), { mode: 'native-only' }, 'native'],
  ['native-only, broken', (w) => defineFakeNative(w, { omit: ['onpaint'] }), { mode: 'native-only' }, 'refused'],
  ['native-only wins over forcePolyfill', (w) => defineFakeNative(w), { mode: 'native-only', forcePolyfill: true }, 'native'],
];

test('the decision equals install()\'s on the native-detect matrix: the mode, the refusal text, and a download only where install() runs the polyfill or the bridge', async t => {
  for (const [label, setup, opts, want] of MATRIX) {
    const expected = installAnswer(t, setup, opts);
    assert.equal(expected.mode, want, `${label}: install() gives ${expected.mode} (the matrix row is stale)`);
    const { r, fetched, warnings } = await loadAnswer(t, setup, opts);
    assert.equal(r.status, expected.mode, `${label}: load() status`);
    assert.equal(r.mode, expected.mode, `${label}: load() mode`);
    assert.ok(Object.isFrozen(r), `${label}: the result is frozen`);
    assert.ok(r.native && typeof r.native.kind === 'string', `${label}: the NativeState is reported`);
    const downloads = expected.mode === 'polyfill' || expected.mode === 'native-bridged';
    assert.equal(fetched.length, downloads ? 1 : 0, `${label}: fetched ${JSON.stringify(fetched)}`);
    if (downloads) {
      assert.equal(fetched[0].bridge, expected.mode === 'native-bridged', `${label}: the bridge is fetched exactly for native-bridged`);
      assert.ok(r.installed && r.installed.mode === expected.mode, `${label}: installed is install()'s own HicInstalled`);
    } else {
      assert.equal(r.installed, null, `${label}: nothing installed, never a stand-in HicInstalled`);
    }
    if (expected.mode === 'refused') {
      assert.equal(r.error.feature, expected.feature, `${label}: the refusal feature`);
      assert.equal(r.error.message, expected.message, `${label}: the refusal text is install()'s`);
      assert.equal(`[hic-live-polyfill] ${r.reason}`, expected.message, `${label}: reason`);
      assert.equal(warnings.length, 1, `${label}: one warning`);
    } else {
      assert.equal(r.reason, undefined, label);
    }
  }
});

test('without the bridge: install() steps aside in mode native, and so does load({bridge: false}) without downloading anything', async t => {
  for (const [label, setup] of /** @type {Array<[string, (w: any) => void]>} */ ([['legacy', (w) => defineFakeNative(w, { shape: 'legacy' })], ['fillable partial', (w) => defineFakeNative(w, { shape: 'previous' })]])) {
    const expected = await withoutBridge(() => installAnswer(t, setup, {}));
    assert.equal(expected.mode, 'native', label);
    const { r, fetched } = await loadAnswer(t, setup, {}, { bridge: false });
    assert.equal(r.status, 'native', label);
    assert.equal(r.installed, null, label);
    assert.equal(fetched.length, 0, label);
  }
});

test('the engines bundle is asked for on Firefox and Safari on the polyfill path, not on Chromium, not with engines: false, never on a native path', async t => {
  /** @type {Array<[string, (w: any) => void, object, boolean]>} */
  const rows = [
    ['Chromium', () => {}, {}, false],
    ['Firefox 156', (w) => asAgent(w, UA.firefox156), {}, true],
    ['Safari 27', (w) => asAgent(w, UA.safari27), {}, true],
    ['Firefox 156, engines: false', (w) => asAgent(w, UA.firefox156), { engines: false }, false],
  ];
  for (const [label, setup, loadOpts, engines] of rows) {
    const { r, fetched } = await loadAnswer(t, setup, {}, loadOpts);
    assert.equal(r.status, 'polyfill', label);
    assert.equal(fetched.length, 1, label);
    assert.equal(fetched[0].engines, engines, label);
  }
  const { fetched } = await loadAnswer(t, (w) => { asAgent(w, UA.firefox156); defineFakeNative(w); }, {});
  assert.equal(fetched.length, 0, 'a native Firefox downloads nothing');
});

test('options: an invalid install option is install()\'s TypeError (status error, nothing fetched); an invalid loader option too; an existing install is returned as is', async t => {
  const typo = await loadAnswer(t, () => {}, { maxDprr: 2 });
  assert.equal(typo.r.status, 'error');
  assert.equal(typo.r.mode, null);
  assert.ok(typo.r.error instanceof TypeError && /unknown option "maxDprr"/.test(typo.r.error.message), String(typo.r.error));
  assert.equal(typo.fetched.length, 0);
  assert.equal(typo.r.native?.kind, 'absent', 'the NativeState is still reported');
  const typoNative = await loadAnswer(t, (w) => defineFakeNative(w), { mode: 'bogus' });
  assert.equal(typoNative.r.status, 'error', 'on a native browser too: install() would throw there as well');
  for (const bad of [{ timeout: -1 }, { timeout: Infinity }, { engines: true }, { core: 1 }, { nonce: 3 }, { extra: 1 }]) {
    const { r, fetched } = await loadAnswer(t, () => {}, {}, bad);
    assert.equal(r.status, 'error', JSON.stringify(bad));
    assert.ok(r.error instanceof TypeError, JSON.stringify(bad));
    assert.equal(fetched.length, 0);
  }
  const w = makeFrame(t);
  const installed = installWith({ window: w }, fakeServices());
  t.cleanup(() => installed.uninstall());
  let asked = 0;
  const r = await createLoad({ check() {}, fetch: async () => { asked++; return { install: () => installed }; } })({ install: { window: w } });
  assert.equal(r.status, 'polyfill');
  assert.equal(r.installed, installed, 'the window\'s existing HicInstalled');
  assert.equal(asked, 0, 'nothing fetched');
  const again = makeFrame(t);
  const second = installWith({ window: again }, fakeServices());
  t.cleanup(() => second.uninstall());
  assert.throws(() => installWith({ window: again, maxDprr: 2 }, fakeServices()), TypeError);
  const typoAgain = await createLoad({ check() {}, fetch: async () => { asked++; return { install: () => second }; } })({ install: { window: again, maxDprr: 2 } });
  assert.equal(typoAgain.status, 'error', 'an invalid option over an existing install is install()\'s TypeError too');
  assert.ok(typoAgain.error instanceof TypeError);
});

// ---------------------------------------------------------------------------------------------- the classic fetcher on stand-in bundles
const FIX = `${location.origin}/test/fixtures/loader`;
/** @param {any} w @param {string} name @returns {number} Resource Timing entries of a fixture in the frame */
const requests = (w, name) => w.performance.getEntriesByType('resource').filter((/** @type {any} */ e) => new URL(e.name).pathname === `/test/fixtures/loader/${name}`).length;
/** @param {any} [defaults] */
const classic = (defaults = {}) => createLoad(scriptFetcher({ core: `${FIX}/fake-core.js`, engines: `${FIX}/fake-engines.js`, bridge: `${FIX}/fake-bridge.js`, ...defaults }));

test('10 concurrent load() calls: one promise, one request, one run of the core under data-hic-manual, one install, the same frozen result', async t => {
  const w = makeFrame(t);
  const load = classic();
  const promises = Array.from({ length: 10 }, () => load({ install: { window: w } }));
  assert.ok(promises.every((p) => p === promises[0]), 'one promise');
  const results = await Promise.all(promises);
  assert.ok(results.every((r) => r === results[0]), 'one result');
  assert.equal(results[0].status, 'polyfill');
  assert.equal(results[0].installed, w.HicLivePolyfill.getInstalled());
  assert.equal(requests(w, 'fake-core.js'), 1, 'one request (Resource Timing)');
  assert.deepEqual(plain([w.__fake.runs, w.__fake.installs, w.__fake.manual]), [1, 1, [true]]);
  assert.equal(w.document.querySelectorAll('script[data-hic-manual]').length, 1);
  assert.equal(await load({ install: { window: w } }), results[0], 'a later call gets the same result');
  // control: the counters see a second download when the shared slot is removed
  delete w[SLOT];
  delete w.HicLivePolyfill;
  await load({ install: { window: w } });
  assert.equal(requests(w, 'fake-core.js'), 2, 'control: a second load without the slot is a second request');
});

test('timeout: the core arrives after the timeout -> status error (TimeoutError), and the late core runs but is never installed', async t => {
  const w = makeFrame(t);
  const r = await classic({ core: `${FIX}/fake-core.js?delay=700` })({ install: { window: w }, timeout: 100 });
  assert.equal(r.status, 'error');
  assert.equal(r.mode, null);
  assert.equal(r.installed, null);
  assert.equal(r.error?.name, 'TimeoutError');
  assert.equal(r.native?.kind, 'absent');
  for (let i = 0; i < 100 && !w.__fake; i++) await sleep(20);
  assert.ok(w.__fake, 'the late core arrived and ran');
  await sleep(50);
  assert.deepEqual(plain([w.__fake.runs, w.__fake.installs, w.__fake.manual]), [1, 0, [true]], 'it never installed: data-hic-manual, and the loader had settled');
  assert.equal(await classic()({ install: { window: w } }), r, 'later calls share the settled result');
});

test('timeout control: the same delayed core within the timeout installs', async t => {
  const w = makeFrame(t);
  const r = await classic({ core: `${FIX}/fake-core.js?delay=300` })({ install: { window: w }, timeout: 5000 });
  assert.equal(r.status, 'polyfill');
  assert.equal(w.__fake.installs, 1);
});

test('a 404 settles with status error (NetworkError) and installs nothing', async t => {
  const w = makeFrame(t);
  const r = await classic({ core: `${FIX}/missing-core.js` })({ install: { window: w } });
  assert.equal(r.status, 'error');
  assert.equal(r.error?.name, 'NetworkError');
  assert.ok(r.reason?.includes('missing-core.js'), r.reason);
  assert.equal(w.HicLivePolyfill, undefined);
  assert.equal(r.installed, null);
});

/** A frame whose document has a Content-Security-Policy. @param {any} t @param {string} policy */
async function cspFrame(t, policy) {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  t.cleanup(() => frame.remove());
  const loaded = new Promise((ok) => frame.addEventListener('load', ok, { once: true }));
  frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><body></body>`;
  await loaded;
  const w = /** @type {any} */ (frame.contentWindow);
  w.__violations = [];
  w.document.addEventListener('securitypolicyviolation', (/** @type {any} */ e) => w.__violations.push(e.blockedURI));
  return w;
}

test('CSP: a policy that does not allow the core\'s URL -> status error; the same policy with the loader\'s nonce -> polyfill', async t => {
  const blocked = await cspFrame(t, "script-src 'nonce-t1'");
  const r = await classic()({ install: { window: blocked } });
  assert.equal(r.status, 'error');
  assert.equal(r.error?.name, 'NetworkError');
  assert.equal(blocked.HicLivePolyfill, undefined);
  await sleep(20);
  assert.ok(blocked.__violations.some((/** @type {string} */ u) => u.endsWith('/fake-core.js')), `a CSP violation names the core: ${blocked.__violations}`);
  const allowed = await cspFrame(t, "script-src 'nonce-t1'");
  const ok = await classic()({ install: { window: allowed }, nonce: 't1' });
  assert.equal(ok.status, 'polyfill', 'control: the nonce lets the same policy load the core');
  assert.equal(allowed.__fake.installs, 1);
});

test('order: the engines bundle (Firefox) and the bridge (a legacy native) run before the core, each fetched once; a bundle already present is not fetched', async t => {
  const ff = makeFrame(t);
  asAgent(ff, UA.firefox156);
  const a = await classic()({ install: { window: ff } });
  assert.equal(a.status, 'polyfill');
  assert.deepEqual(plain(ff.__fake.order), ['engines', 'core']);
  assert.deepEqual([...ff.document.querySelectorAll('script')].map((/** @type {HTMLScriptElement} */ s) => s.async), [false, false], 'in insertion order');
  const legacy = makeFrame(t);
  defineFakeNative(legacy, { shape: 'legacy' });
  await classic()({ install: { window: legacy } });
  assert.deepEqual(plain(legacy.__fake.order), ['bridge', 'core']);
  const present = makeFrame(t);
  asAgent(present, UA.firefox156);
  present[Symbol.for('hic.engine-skins')] = {};
  await classic()({ install: { window: present } });
  assert.deepEqual(plain(present.__fake.order), ['core'], 'the engines key was already registered');
  assert.equal(requests(present, 'fake-engines.js'), 0);
});

test('no default URL (a loader without src) and no option -> status error naming the option', async t => {
  const w = makeFrame(t);
  const r = await createLoad(scriptFetcher({ core: null, engines: null, bridge: null }))({ install: { window: w } });
  assert.equal(r.status, 'error');
  assert.ok(/pass the "core" option/.test(r.reason ?? ''), r.reason);
});
