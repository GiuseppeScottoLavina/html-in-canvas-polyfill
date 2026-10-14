import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_OPTIONS, resolveOptions } from '../../../src/api/options.js';

test('no options: the defaults, frozen', () => {
  const o = resolveOptions();
  assert.deepEqual({ ...o }, { ...DEFAULT_OPTIONS });
  assert.ok(Object.isFrozen(o));
  assert.ok(Object.isFrozen(o.nodeBudget));
  assert.equal(o.coherentPaint, true);
  assert.equal(o.paintGateMaxWaitMs, 400);
  assert.equal(o.parentFacade, true);
  assert.equal(o.stackingAudit, 'report');
  assert.equal(o.maxTotalSurfaceBytes, 536870912);
});

test('given values override defaults and leave the others alone', () => {
  const o = resolveOptions({ maxDpr: 3, defaultFrameCap: 30, selectorBridge: 'off', trace: true, autoDiscover: false, stackingAudit: 'off' });
  assert.equal(o.maxDpr, 3);
  assert.equal(o.defaultFrameCap, 30);
  assert.equal(o.selectorBridge, 'off');
  assert.equal(o.trace, true);
  assert.equal(o.autoDiscover, false);
  assert.equal(o.stackingAudit, 'off');
  assert.equal(o.inkMargin, DEFAULT_OPTIONS.inkMargin);
});

test('window and document are accepted (they live on the env, not in ResolvedOptions)', () => {
  const o = resolveOptions({ window: /** @type {any} */ ({}), document: /** @type {any} */ ({}) });
  assert.equal('window' in o, false);
  assert.equal('document' in o, false);
});

test('the DEFAULT_OPTIONS object is never mutated by a resolve', () => {
  const before = JSON.stringify(DEFAULT_OPTIONS);
  resolveOptions({ nodeBudget: { soft: 10 }, maxDpr: 1 });
  assert.equal(JSON.stringify(DEFAULT_OPTIONS), before);
});

test('an unknown option name is an error (a typo must not be silent)', () => {
  assert.throws(() => resolveOptions(/** @type {any} */ ({ maxDrp: 2 })), /unknown option "maxDrp"/);
});

test('options must be an object', () => {
  assert.throws(() => resolveOptions(/** @type {any} */ ('auto')), TypeError);
  assert.throws(() => resolveOptions(/** @type {any} */ ([])), TypeError);
});

test('enum options reject unknown values and name the allowed ones', () => {
  for (const [name, bad] of [['mode', 'always'], ['onUnsupportedBrowser', 'ignore'], ['onUnsupportedContent', 'skip'], ['stackingAudit', 'on'], ['selectorBridge', 'yes']]) {
    assert.throws(() => resolveOptions(/** @type {any} */ ({ [name]: bad })), new RegExp(`option "${name}".*must be one of`));
  }
  for (const mode of ['auto', 'polyfill', 'native-only']) assert.equal(resolveOptions({ mode }).mode, mode);
});

test('boolean options reject non-booleans (no truthiness coercion)', () => {
  for (const name of ['legacyNames', 'coherentPaint', 'parentFacade', 'strictResources', 'forcePolyfill', 'trace', 'autoDiscover']) {
    for (const bad of [1, 'true', null, 0]) assert.throws(() => resolveOptions(/** @type {any} */ ({ [name]: bad })), new RegExp(`option "${name}".*boolean`));
    assert.equal(resolveOptions(/** @type {any} */ ({ [name]: false }))[/** @type {'trace'} */ (name)], false);
  }
});

test('numeric options: finite, in range, exclusive minimum where a zero would divide', () => {
  const bad = [NaN, Infinity, '2', null];
  for (const name of ['maxDpr', 'maxSnapshotFps', 'maxSurfacePixels', 'interactionFloorFps', 'inkMargin', 'coherenceMaxWaitMs', 'paintGateMaxWaitMs', 'maxTotalSurfaceBytes', 'defaultFrameCap']) {
    for (const v of bad) assert.throws(() => resolveOptions(/** @type {any} */ ({ [name]: v })), new RegExp(`option "${name}"`), `${name}=${v}`);
  }
  assert.throws(() => resolveOptions({ maxDpr: 0.5 }), /maxDpr.*>= 1/);
  assert.throws(() => resolveOptions({ maxSurfacePixels: 0 }), /maxSurfacePixels.*> 0/);
  assert.throws(() => resolveOptions({ maxTotalSurfaceBytes: -1 }), /maxTotalSurfaceBytes/);
  assert.throws(() => resolveOptions({ inkMargin: -1 }), /inkMargin.*>= 0/);
  assert.equal(resolveOptions({ maxSnapshotFps: 0 }).maxSnapshotFps, 0, '0 = no bound is legal');
  assert.equal(resolveOptions({ coherenceMaxWaitMs: 0 }).coherenceMaxWaitMs, 0);
});

test('defaultFrameCap: 0 (uncapped) or 1..240', () => {
  assert.equal(resolveOptions({ defaultFrameCap: 0 }).defaultFrameCap, 0);
  assert.equal(resolveOptions({ defaultFrameCap: 1 }).defaultFrameCap, 1);
  assert.equal(resolveOptions({ defaultFrameCap: 240 }).defaultFrameCap, 240);
  assert.throws(() => resolveOptions({ defaultFrameCap: 59.5 }), /defaultFrameCap.*integer/, 'the cap is an integer like the framecap attribute');
  assert.throws(() => resolveOptions({ maxSurfacePixels: 0.5 }), /integer/);
  for (const v of [-1, 0.5, 241, 1000]) assert.throws(() => resolveOptions({ defaultFrameCap: v }), /defaultFrameCap.*between 1 and 240/);
});

test('nodeBudget merges per member and keeps soft <= hard <= absolute', () => {
  assert.deepEqual({ ...resolveOptions({ nodeBudget: { soft: 100 } }).nodeBudget }, { soft: 100, hard: 3000, absolute: 20000 });
  assert.deepEqual({ ...resolveOptions({ nodeBudget: { hard: 500, absolute: 900 } }).nodeBudget }, { soft: 350, hard: 500, absolute: 900 });
  assert.throws(() => resolveOptions({ nodeBudget: { soft: 5000 } }), /soft <= hard <= absolute/);
  assert.throws(() => resolveOptions({ nodeBudget: { hard: 10 } }), /soft <= hard <= absolute/);
  assert.throws(() => resolveOptions({ nodeBudget: { soft: 0 } }), /nodeBudget\.soft.*positive/);
  assert.throws(() => resolveOptions(/** @type {any} */ ({ nodeBudget: { soft: 1, bogus: 2 } })), /unknown nodeBudget member "bogus"/);
  assert.throws(() => resolveOptions(/** @type {any} */ ({ nodeBudget: 5 })), /nodeBudget/);
  assert.throws(() => resolveOptions(/** @type {any} */ ({ nodeBudget: [1, 2, 3] })), /nodeBudget/);
});

test('undefined members behave as absent', () => {
  const o = resolveOptions({ maxDpr: undefined, mode: undefined, nodeBudget: undefined });
  assert.equal(o.maxDpr, DEFAULT_OPTIONS.maxDpr);
  assert.equal(o.mode, 'auto');
});
