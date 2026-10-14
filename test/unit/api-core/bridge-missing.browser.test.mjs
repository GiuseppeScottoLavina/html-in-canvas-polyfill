import { test, assert } from '/test/unit/lib/t.js';
import { installWith } from '/src/api/install.js';
import { defineFakeNative, diffDescriptors, fakeServices, makeFrame, snapshotDescriptors } from './_page-env.mjs';

// This file never loads /src/native-bridge.js: the core must refuse a legacy or nearly complete native implementation loudly, touching nothing.

test('legacy native without the bridge bundle: refused with partial-native and a hint naming the bridge, nothing patched', t => {
  const w = makeFrame(t);
  defineFakeNative(w, { legacy: true });
  const before = snapshotDescriptors(w);
  /** @type {any} */ let error = null;
  try { installWith({ window: w }, fakeServices()); } catch (e) { error = e; }
  assert.ok(error, 'install threw');
  assert.equal(error.name, 'NotSupportedError');
  assert.equal(error.feature, 'partial-native');
  assert.ok(/native bridge is not loaded/.test(error.message), error.message);
  assert.ok(/hic-live-native-bridge/.test(error.hint), error.hint);
  assert.deepEqual(diffDescriptors(before, snapshotDescriptors(w)), []);
});

test('onUnsupportedBrowser "warn": the refusal is reported once and the returned install is inert (mode refused)', t => {
  const w = makeFrame(t);
  defineFakeNative(w, { legacy: true });
  const warnings = [];
  w.console.warn = (/** @type {any[]} */ ...a) => warnings.push(a.join(' '));
  const installed = installWith({ window: w, onUnsupportedBrowser: 'warn' }, fakeServices());
  assert.equal(installed.mode, 'refused');
  assert.equal(installed.report().unsupported[0].feature, 'partial-native');
  assert.equal(warnings.length, 1);
});

test('a complete native implementation needs no bridge', t => {
  const w = makeFrame(t);
  defineFakeNative(w, {});
  const installed = installWith({ window: w }, fakeServices());
  t.cleanup(() => installed.uninstall());
  assert.equal(installed.mode, 'native');
});
