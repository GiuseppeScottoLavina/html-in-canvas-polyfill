import { test, assert, sleep } from '/test/unit/lib/t.js';
import { getInstalled, installWith } from '/src/api/install.js';
import { HicUnsupportedError } from '/src/contracts/errors.js';
import '/src/native-bridge.js'; // registers the optional native bridge: the native-bridged tests below need it
import { defineFakeNative, diffDescriptors, fakeServices, makeFrame, settle, snapshotDescriptors } from './_page-env.mjs';

/** what a native-mode install may add to the window: the per-window install marker */
const EXTENSION_ADDITIONS = ['added window.Symbol(hic.installed)'];
/** what an install in a native mode adds: the install marker and the frame cap extension's property (never a standard name) */
const NATIVE_ADDITIONS = ['added HTMLCanvasElement.prototype.frameCap', 'added window.Symbol(hic.installed)'];
// an UNVERIFIED Firefox (below MIN_FIREFOX_MAJOR): still refused as a browser
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0';

/** the UA string and the Chromium brand of userAgentData both say Firefox 140 */
function asFirefox(/** @type {any} */ w) {
  Object.defineProperty(w.navigator, 'userAgent', { get: () => FIREFOX, configurable: true });
  Object.defineProperty(w.navigator, 'userAgentData', { get: () => undefined, configurable: true });
}

/** install into a frame window with fake module factories; uninstalls with the test */
function installIn(/** @type {any} */ t, /** @type {any} */ w, /** @type {any} */ options = {}, /** @type {string[]} */ log = [], /** @type {object} */ overrides = {}) {
  const installed = installWith({ window: w, ...options }, fakeServices(log, overrides));
  t.cleanup(() => installed.uninstall());
  return installed;
}

test('polyfill mode on a window without native: install is idempotent, getInstalled finds it, uninstall twice is a no-op', t => {
  const w = makeFrame(t);
  const a = installIn(t, w);
  assert.equal(a.mode, 'polyfill');
  assert.equal(a.native.kind, 'absent');
  assert.equal(installWith({ window: w }, fakeServices()), a, 'second install returns the same object');
  assert.equal(getInstalled(w), a);
  assert.equal(getInstalled(window), null, 'per window');
  a.uninstall();
  a.uninstall();
  assert.equal(getInstalled(w), null);
  const b = installWith({ window: w }, fakeServices());
  assert.notEqual(b, a, 'a fresh install after uninstall');
  b.uninstall();
});

test('G-lifecycle: install + uninstall restore every watched descriptor by identity and the DOM serialisation', async t => {
  const w = makeFrame(t, '<main><canvas id="c" content="drawable" width="40" height="20"><div id="k">kid</div><span>two</span></canvas><p>after</p></main>');
  const before = snapshotDescriptors(w);
  const html = w.document.documentElement.outerHTML;
  const log = /** @type {string[]} */ ([]);
  const installed = installWith({ window: w }, fakeServices(log));
  assert.equal(installed.canvases().length, 1);
  assert.notEqual(w.document.documentElement.outerHTML, html, 'the layer is in the document while installed');
  installed.uninstall();
  assert.deepEqual(diffDescriptors(before, snapshotDescriptors(w)), []);
  assert.equal(w.document.documentElement.outerHTML, html);
  assert.ok(log.indexOf('observers.stop') > -1 && log.indexOf('roots.dispose') > log.indexOf('scheduler.dispose'), `teardown order: ${log.join(',')}`);
  // positive control: a leaked patch must be visible to the comparison
  const leak = w.HTMLCanvasElement.prototype;
  Object.defineProperty(leak, 'requestPaint', { value() {}, configurable: true });
  assert.ok(diffDescriptors(before, snapshotDescriptors(w)).some((l) => l.includes('HTMLCanvasElement.prototype.requestPaint')), 'the comparison notices a leak');
  await settle();
});

test('install mounts the canvases that exist and the ones added later; uninstall restores the children and stops watching', async t => {
  const w = makeFrame(t, '<canvas id="a" content="drawable"><b>one</b></canvas>');
  const installed = installIn(t, w);
  const a = w.document.getElementById('a');
  assert.equal(a.children.length, 0, 'children moved into the layer');
  assert.deepEqual(installed.canvases(), [a]);
  const late = w.document.createElement('canvas');
  late.setAttribute('content', 'drawable');
  late.innerHTML = '<i></i>';
  w.document.body.append(late);
  await settle();
  assert.deepEqual(installed.canvases(), [a, late]);
  installed.uninstall();
  assert.equal(a.children.length, 1);
  assert.equal(late.children.length, 1);
  const after = w.document.createElement('canvas');
  after.setAttribute('content', 'drawable');
  after.innerHTML = '<u></u>';
  w.document.body.append(after);
  await settle();
  assert.equal(after.children.length, 1, 'nothing watches the document after uninstall');
});

test('autoDiscover:false installs without scanning or observing; adopt() manages one canvas', async t => {
  const w = makeFrame(t, '<canvas id="a" content="drawable"><b></b></canvas>');
  const installed = installIn(t, w, { autoDiscover: false });
  assert.deepEqual(installed.canvases(), []);
  installed.adopt(w.document.getElementById('a'));
  assert.equal(installed.canvases().length, 1);
  assert.throws(() => installed.adopt(w.document.body), TypeError);
});

test('refused browser: install throws HicUnsupportedError("browser") with a hint and patches nothing', t => {
  const w = makeFrame(t);
  asFirefox(w);
  const before = snapshotDescriptors(w);
  let error;
  try { installWith({ window: w }, fakeServices()); } catch (e) { error = e; }
  assert.ok(error instanceof HicUnsupportedError, 'HicUnsupportedError');
  assert.equal(error.feature, 'browser');
  assert.equal(error.name, 'NotSupportedError');
  assert.ok(/Chromium/.test(error.hint));
  assert.deepEqual(diffDescriptors(before, snapshotDescriptors(w)), []);
  assert.equal(getInstalled(w), null);
});

test('onUnsupportedBrowser:"warn" warns once, installs nothing and returns an inert refused HicInstalled', async t => {
  const w = makeFrame(t);
  asFirefox(w);
  /** @type {any[][]} */ const warnings = [];
  w.console.warn = (/** @type {any[]} */ ...a) => warnings.push(a);
  const before = snapshotDescriptors(w);
  const first = installWith({ window: w, onUnsupportedBrowser: 'warn' }, fakeServices());
  installWith({ window: w, onUnsupportedBrowser: 'warn' }, fakeServices());
  assert.equal(first.mode, 'refused');
  assert.equal(warnings.length, 1, 'one warning per window');
  assert.ok(/browser/.test(String(warnings[0][0])));
  assert.deepEqual(first.canvases(), []);
  const report = first.report();
  assert.equal(report.mode, 'refused');
  assert.equal(report.unsupported[0].feature, 'browser');
  JSON.stringify(report);
  await assert.rejects(() => first.whenPainted(w.document.createElement('canvas')), /not installed/);
  first.adopt(); first.adoptRoot(); first.uninstall();
  assert.deepEqual(diffDescriptors(before, snapshotDescriptors(w)), []);
  assert.equal(getInstalled(w), null, 'a refused install is not remembered');
});

test('invalid options throw TypeError before anything is touched', t => {
  const w = makeFrame(t);
  const before = snapshotDescriptors(w);
  assert.throws(() => installWith({ window: w, maxDpr: 0 }, fakeServices()), TypeError);
  assert.throws(() => installWith({ window: w, bogus: 1 }, fakeServices()), /unknown option/);
  assert.throws(() => installWith({ window: w, document: /** @type {any} */ ({}) }, fakeServices()), /Document/);
  assert.deepEqual(diffDescriptors(before, snapshotDescriptors(w)), []);
});

test('a real bug in a module factory aborts the install and leaves the window as it was', t => {
  const w = makeFrame(t, '<canvas content="drawable"><b></b></canvas>');
  const before = snapshotDescriptors(w);
  const html = w.document.documentElement.outerHTML;
  assert.throws(() => installWith({ window: w }, fakeServices([], { createScheduler: () => { throw new RangeError('scheduler bug'); } })), /scheduler bug/);
  assert.deepEqual(diffDescriptors(before, snapshotDescriptors(w)), []);
  assert.equal(w.document.documentElement.outerHTML, html);
  assert.equal(getInstalled(w), null);
});

test('report() is JSON-able and describes mode, native state and managed canvases', async t => {
  const w = makeFrame(t, '<canvas content="drawable"><b></b></canvas><canvas popover content="drawable"></canvas>');
  const installed = installIn(t, w);
  const report = installed.report();
  JSON.stringify(report);
  assert.equal(report.mode, 'polyfill');
  assert.equal(report.native.kind, 'absent');
  assert.equal(report.canvases.length, 1);
  assert.equal(report.canvases[0].state, 'active');
  assert.equal(report.unsupported[0].feature, 'top-layer-canvas');
  assert.equal(typeof report.browser.userAgent, 'string');
  assert.equal(report.version, installed.version);
  await settle();
});

test('whenPainted: resolves on the next paint event, immediately after the first one, rejects with TimeoutError otherwise', async t => {
  const w = makeFrame(t, '<canvas id="c" content="drawable"><b></b></canvas>');
  const installed = installIn(t, w);
  const c = w.document.getElementById('c');
  let resolved = false;
  const pending = installed.whenPainted(c, 2000).then(() => { resolved = true; });
  await sleep(10);
  assert.equal(resolved, false);
  c.dispatchEvent(new w.Event('paint'));
  await pending;
  assert.equal(resolved, true);
  const err = await installed.whenPainted(c, 30).then(() => null, (e) => e);
  assert.equal(err?.name, 'TimeoutError', 'a later paint is needed again');
  /** @type {any} */ (installed.report().canvases[0]);
  assert.throws(() => installed.whenPainted(/** @type {any} */ ({}), 10), TypeError);
});

test('adoptRoot: a root created before install is refused with the hint, then managed after adoptRoot', async t => {
  const w = makeFrame(t, '<div id="h"></div>');
  const closed = w.document.getElementById('h').attachShadow({ mode: 'closed' });
  const box = w.document.createElement('div');
  box.innerHTML = '<canvas id="c" content="drawable"><b></b></canvas>';
  closed.append(box);
  const c = box.firstElementChild;
  const installed = installIn(t, w);
  assert.deepEqual(installed.canvases(), []);
  installed.adopt(c);
  assert.deepEqual(installed.canvases(), [], 'refused');
  assert.ok(installed.report().unsupported.some((e) => e.feature === 'shadow-canvas' && /adoptRoot/.test(e.hint ?? '')));
  installed.adoptRoot(closed);
  assert.deepEqual(installed.canvases(), [c]);
  assert.throws(() => installed.adoptRoot(/** @type {any} */ (w.document)), TypeError);
});

test('G-native-first (b): a complete native implementation gives mode native, patches nothing of the standard (only the frameCap extension) and builds no layer', t => {
  const w = makeFrame(t, '<canvas content="drawable"><b></b></canvas>');
  defineFakeNative(w);
  const before = snapshotDescriptors(w);
  const html = w.document.documentElement.outerHTML;
  const installed = installIn(t, w);
  assert.equal(installed.mode, 'native');
  assert.equal(installed.native.kind, 'complete');
  assert.deepEqual(diffDescriptors(before, snapshotDescriptors(w)).sort(), NATIVE_ADDITIONS, 'not one standard descriptor changed: only the install marker and the frameCap extension appear');
  assert.equal(w.document.documentElement.outerHTML, html, 'no layer, no data-hic attribute');
  const canvas = w.document.querySelector('canvas');
  canvas.frameCap = 30;
  assert.equal(canvas.getAttribute('framecap'), '30', 'frameCap reflects the framecap attribute in mode native');
  canvas.removeAttribute('framecap');
  assert.deepEqual(installed.canvases(), []);
  installed.uninstall();
  assert.deepEqual(diffDescriptors(before, snapshotDescriptors(w)), []);
});

test('G-native-first (c): deleting one CORE name throws partial-native, for every CORE name', t => {
  for (const name of ['onpaint', 'content', 'CanvasRenderingContext2D.drawElementImage']) {
    const w = makeFrame(t);
    defineFakeNative(w, { omit: [name] });
    const before = snapshotDescriptors(w);
    let error;
    try { installWith({ window: w }, fakeServices()); } catch (e) { error = e; }
    assert.ok(error instanceof HicUnsupportedError, name);
    assert.equal(error.feature, 'partial-native', name);
    assert.ok(error.message.includes(name), `${name}: the message names the missing member (${error.message})`);
    assert.deepEqual(diffDescriptors(before, snapshotDescriptors(w)), [], name);
  }
});

test('G-native-first (d): every native shape with its core never throws: current, previous and legacy shapes, every secondary name deleted, a stub draw', t => {
  /** @type {Array<[string, any]>} */
  const shapes = [
    ['current (Canary 157)', { shape: 'current' }], ['previous (ElementImage.width/height)', { shape: 'previous' }], ['legacy (Chrome 154)', { shape: 'legacy' }],
    ['inert stub draw', { inert: true }],
    ...['requestPaint', 'captureElementImage', 'getElementTransform', 'updateElementGeometry', 'clearElementGeometry', 'getElementImageDefaultSize', 'ElementImage',
      'OffscreenCanvasRenderingContext2D.drawElementImage', 'OffscreenCanvas.getElementImageDefaultSize'].map((n) => /** @type {[string, any]} */ ([`without ${n}`, { omit: [n] }])),
  ];
  for (const [label, shape] of shapes) {
    for (const mode of ['auto', 'polyfill', 'native-only']) {
      const w = makeFrame(t, '<canvas content="drawable"><b drawable></b></canvas>');
      defineFakeNative(w, shape);
      w.console.warn = () => {};
      const html = w.document.documentElement.outerHTML;
      let installed;
      try { installed = installWith({ window: w, mode }, fakeServices()); } catch (e) { assert.fail(`${label}, mode ${mode}: install threw ${e}`); }
      t.cleanup(() => installed.uninstall());
      assert.ok(installed.mode === 'native' || installed.mode === 'native-bridged', `${label}, mode ${mode}: ${installed.mode}`);
      assert.equal(w.document.documentElement.outerHTML.includes('hic-layer'), false, `${label}: no polyfill layer`);
      if (installed.mode === 'native') assert.equal(w.document.documentElement.outerHTML, html, `${label}: the page is untouched`);
      installed.uninstall();
    }
  }
});

test('G-native-first (d): what a step-aside records: the probe result, the missing names and why, in report().native and report().deviations', t => {
  const w = makeFrame(t);
  defineFakeNative(w, { shape: 'previous', inert: true, omit: ['ElementImage.width'] });
  delete w.ElementImage.prototype.width; // the shape without any size API: nothing for the bridge to build from
  const installed = installIn(t, w);
  const report = installed.report();
  assert.equal(report.mode, 'native');
  assert.equal(report.native.kind, 'partial');
  assert.equal(report.native.probe, 'inert');
  assert.equal(report.native.verified, false);
  assert.ok(report.native.missing.includes('getElementImageDefaultSize'));
  const note = report.deviations.find((d) => d.id === 'native-step-aside');
  assert.ok(note && /probe gave "inert"/.test(note.detail), JSON.stringify(report.deviations));
  const current = makeFrame(t);
  defineFakeNative(current);
  const clean = installIn(t, current).report();
  assert.equal(clean.native.kind, 'complete');
  assert.equal(clean.native.verified, true, 'the fake draw throws like the platform, so the probe confirms it');
  assert.deepEqual(clean.deviations, [], 'a complete, verified native records nothing');
});

test('G-native-first (d): mode "polyfill" over a usable native steps aside with one warning and a report entry instead of throwing', t => {
  const w = makeFrame(t);
  defineFakeNative(w);
  /** @type {string[]} */ const warnings = [];
  w.console.warn = (/** @type {any[]} */ ...a) => warnings.push(a.join(' '));
  const installed = installIn(t, w, { mode: 'polyfill' });
  assert.equal(installed.mode, 'native');
  assert.equal(warnings.length, 1);
  assert.ok(/never replaced/.test(warnings[0]), warnings[0]);
  assert.ok(installed.report().deviations.some((d) => d.id === 'native-step-aside' && /mode "polyfill"/.test(d.detail)));
});

test('G-native-first (d): a bridge that throws on an unexpected native shape is removed and the native implementation is used as found', async t => {
  const { EXT } = await import('/src/contracts/events.js');
  const saved = Object.getOwnPropertyDescriptor(globalThis, EXT.NATIVE_BRIDGE_KEY);
  Object.defineProperty(globalThis, EXT.NATIVE_BRIDGE_KEY, { value: { install() { throw new TypeError('Cannot redefine property: content'); } }, configurable: true });
  t.cleanup(() => { if (saved) Object.defineProperty(globalThis, EXT.NATIVE_BRIDGE_KEY, saved); });
  const w = makeFrame(t);
  defineFakeNative(w, { legacy: true });
  w.console.warn = () => {};
  const before = snapshotDescriptors(w);
  const installed = installIn(t, w);
  assert.equal(installed.mode, 'native');
  assert.ok(installed.report().deviations.some((d) => d.id === 'native-step-aside' && /bridge failed \(TypeError: Cannot redefine/.test(d.detail)));
  assert.deepEqual(diffDescriptors(before, snapshotDescriptors(w)).sort(), NATIVE_ADDITIONS, 'the failed bridge left nothing behind (the native install adds only the marker and the frameCap extension)');
});

test('G-native-first (c): deleting one ADDITIVE name gap-fills it in native-bridged and leaves the native descriptors alone', t => {
  const additive = ['onelementgeometryupdate', 'ElementGeometryUpdateEvent'];
  for (const name of additive) {
    const w = makeFrame(t);
    defineFakeNative(w, { omit: [name] });
    const before = snapshotDescriptors(w);
    const installed = installIn(t, w);
    assert.equal(installed.mode, 'native-bridged', name);
    assert.deepEqual(installed.native.gaps, [name], name);
    const changed = diffDescriptors(before, snapshotDescriptors(w));
    assert.ok(changed.length >= 1 && changed.every((l) => l.startsWith('added ')), `${name}: only additions (${changed.join('; ')})`);
    installed.uninstall();
    assert.deepEqual(diffDescriptors(before, snapshotDescriptors(w)), [], `${name}: uninstall restores`);
  }
});

test('gap-fill of onelementgeometryupdate and ElementGeometryUpdateEvent really works', t => {
  const w = makeFrame(t, '<canvas id="c"></canvas>');
  defineFakeNative(w, { omit: ['onelementgeometryupdate', 'ElementGeometryUpdateEvent'] });
  installIn(t, w);
  const c = w.document.getElementById('c');
  assert.equal(typeof w.ElementGeometryUpdateEvent, 'function');
  const seen = [];
  c.onelementgeometryupdate = (/** @type {any} */ e) => seen.push(e.type);
  assert.equal(typeof c.onelementgeometryupdate, 'function');
  c.dispatchEvent(new w.Event('elementgeometryupdate'));
  assert.deepEqual(seen, ['elementgeometryupdate']);
  const ev = new w.ElementGeometryUpdateEvent('elementgeometryupdate', { elements: [c] });
  assert.equal(ev.elements[0], c);
});

test('mode native-only: complete -> native; absent throws; forcePolyfill overrides even a broken native', t => {
  const absent = makeFrame(t);
  assert.throws(() => installWith({ window: absent, mode: 'native-only' }, fakeServices()), HicUnsupportedError);
  const complete = makeFrame(t);
  defineFakeNative(complete);
  assert.equal(installIn(t, complete, { mode: 'native-only' }).mode, 'native');
  const partial = makeFrame(t, '<canvas content="drawable"><b></b></canvas>');
  defineFakeNative(partial, { omit: ['onpaint'] });
  const installed = installIn(t, partial, { forcePolyfill: true });
  assert.equal(installed.mode, 'polyfill');
});

test('runaway: BUS.RUNAWAY is reported loudly (console.error once, report entry, hicunsupported on the canvas) and the polyfill uninstalls itself', async t => {
  const { BUS } = await import('/src/contracts/events.js');
  const w = makeFrame(t, '<canvas id="c" content="drawable" width="40" height="20"><div>kid</div></canvas>');
  const errors = /** @type {any[][]} */ ([]);
  const realError = w.console.error;
  w.console.error = (/** @type {any[]} */ ...a) => { errors.push(a); };
  t.cleanup(() => { w.console.error = realError; });
  let bus;
  const installed = installIn(t, w, {}, [], { createSnapshotStore: (/** @type {any} */ env) => { bus = env.bus; return { forget() {}, dispose() {} }; } });
  const canvas = w.document.getElementById('c');
  const events = /** @type {any[]} */ ([]);
  canvas.addEventListener('hicunsupported', (/** @type {any} */ e) => events.push(e.detail));
  bus.emit(BUS.RUNAWAY, { commits: 120, windowMs: 3000 });
  assert.equal(getInstalled(w), installed, 'uninstall is deferred one task (the signal comes from inside a commit)');
  await sleep(30);
  assert.equal(getInstalled(w), null, 'the polyfill removed itself');
  assert.equal(events.length, 1);
  assert.equal(events[0].feature, 'runaway');
  assert.ok(errors.some((a) => String(a[0]).includes('unsupported runaway')), 'console.error names the feature');
  const entry = installed.report().unsupported.find((u) => u.feature === 'runaway');
  assert.ok(entry && /uninstalled itself/.test(entry.message), 'the report keeps the entry after the uninstall');
  assert.equal(canvas.querySelectorAll('hic-layer').length, 0, 'no layer is left in the document');
  assert.equal(canvas.children.length, 1, 'the canvas children are back in the canvas');
});
