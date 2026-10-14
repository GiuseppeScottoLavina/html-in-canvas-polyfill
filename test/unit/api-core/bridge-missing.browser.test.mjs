import { test, assert } from '/test/unit/lib/t.js';
import { installWith } from '/src/api/install.js';
import { defineFakeNative, diffDescriptors, fakeServices, makeFrame, snapshotDescriptors } from './_page-env.mjs';

// This file never loads /src/native-bridge.js: the core must step aside for a legacy or nearly complete native implementation, never throw, touching nothing.

test('legacy native without the bridge bundle: used as found (mode native), one warning naming the bridge, a report entry, nothing patched', t => {
  const w = makeFrame(t);
  defineFakeNative(w, { legacy: true });
  /** @type {string[]} */ const warnings = [];
  w.console.warn = (/** @type {any[]} */ ...a) => warnings.push(a.join(' '));
  const before = snapshotDescriptors(w);
  const installed = installWith({ window: w }, fakeServices());
  t.cleanup(() => installed.uninstall());
  assert.equal(installed.mode, 'native');
  assert.equal(installed.native.kind, 'legacy');
  assert.equal(warnings.length, 1);
  assert.ok(/hic-live-native-bridge/.test(warnings[0]), warnings[0]);
  assert.ok(installed.report().deviations.some((d) => d.id === 'native-step-aside' && /layoutsubtree/.test(d.detail)));
  assert.deepEqual(installed.report().unsupported, []);
  assert.deepEqual(diffDescriptors(before, snapshotDescriptors(w)).filter((l) => l !== 'added window.Symbol(hic.installed)'), []);
});

test('a native that lacks only bridgeable names, without the bridge: used as found, silently (no console output), the gaps are reported', t => {
  const w = makeFrame(t);
  defineFakeNative(w, { omit: ['onelementgeometryupdate'] });
  /** @type {string[]} */ const out = [];
  w.console.warn = w.console.error = (/** @type {any[]} */ ...a) => out.push(a.join(' '));
  const installed = installWith({ window: w }, fakeServices());
  t.cleanup(() => installed.uninstall());
  assert.equal(installed.mode, 'native');
  assert.deepEqual(installed.native.gaps, ['onelementgeometryupdate']);
  assert.deepEqual(out, []);
  assert.ok(installed.report().deviations.some((d) => d.id === 'native-step-aside' && /onelementgeometryupdate/.test(d.detail)));
});

test('a complete native implementation needs no bridge', t => {
  const w = makeFrame(t);
  defineFakeNative(w, {});
  const installed = installWith({ window: w }, fakeServices());
  t.cleanup(() => installed.uninstall());
  assert.equal(installed.mode, 'native');
});
