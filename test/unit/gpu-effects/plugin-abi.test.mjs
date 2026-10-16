import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPluginContext, captureMapper, definePlugin, validateInstance } from '../../../src/effects/plugin-abi.js';

const base = () => ({ type: 'demo', apiVersion: 2, version: 1, create() { return { render() {} }; } });

test('definePlugin validates every required field with a TypeError', () => {
  assert.throws(() => definePlugin(null), TypeError);
  assert.throws(() => definePlugin({ ...base(), type: '' }), TypeError);
  assert.throws(() => definePlugin({ ...base(), type: 5 }), TypeError);
  assert.throws(() => definePlugin({ ...base(), apiVersion: 3 }), /apiVersion/);
  assert.throws(() => definePlugin({ ...base(), apiVersion: 1 }), /apiVersion.*must be 2/, 'ABI v1 is not accepted');
  assert.throws(() => definePlugin({ ...base(), apiVersion: undefined }), /apiVersion/);
  assert.throws(() => definePlugin({ ...base(), version: NaN }), /version/);
  assert.throws(() => definePlugin({ ...base(), version: '1' }), /version/);
  assert.throws(() => definePlugin({ ...base(), create: undefined }), /create/);
});

test('definePlugin freezes a copy and is idempotent', () => {
  const src = base();
  const def = definePlugin(src);
  assert.ok(Object.isFrozen(def));
  assert.notEqual(def, src);
  src.type = 'changed';
  assert.equal(def.type, 'demo', 'later edits of the input do not reach the definition');
  assert.equal(definePlugin(def), def);
});

test('output capabilities: only directCanvasRenderAttachment: true is accepted', () => {
  assert.equal(definePlugin({ ...base(), outputCapabilities: { directCanvasRenderAttachment: true } }).outputCapabilities?.directCanvasRenderAttachment, true);
  assert.equal(definePlugin({ ...base(), outputCapabilities: {} }).outputCapabilities, undefined);
  assert.throws(() => definePlugin({ ...base(), outputCapabilities: { directCanvasRenderAttachment: false } }), TypeError);
  assert.throws(() => definePlugin({ ...base(), outputCapabilities: { somethingElse: true } }), /unknown output capability/);
  assert.throws(() => definePlugin({ ...base(), outputCapabilities: 3 }), TypeError);
});

test('the plugin context carries apiVersion 2', () => {
  assert.equal(buildPluginContext(definePlugin(base()), {}).apiVersion, 2);
});

test('validateInstance: render is required, optional members must be functions, flags booleans', () => {
  const def = definePlugin(base());
  assert.throws(() => validateInstance(null, def), TypeError);
  assert.throws(() => validateInstance({}, def), /render/);
  for (const name of ['resize', 'setOptions', 'captureInputMapper', 'mountUI', 'settled', 'destroy']) {
    assert.throws(() => validateInstance({ render() {}, [name]: 1 }, def), new RegExp(name));
  }
  assert.throws(() => validateInstance({ render() {}, continuous: 'yes' }, def), /continuous/);
  const ok = { render() {}, resize() {}, destroy() {}, continuous: true };
  assert.equal(validateInstance(ok, def), ok);
});

test('a spatial instance without captureInputMapper is rejected (pointer input could not follow the pixels)', () => {
  const def = definePlugin(base());
  assert.throws(() => validateInstance({ render() {}, spatial: true }, def), /captureInputMapper/);
  assert.throws(() => validateInstance({ render() {}, spatial: true, captureInputMapper: 1 }, def), TypeError);
  assert.doesNotThrow(() => validateInstance({ render() {}, spatial: true, captureInputMapper() { return () => ({ x: 0, y: 0 }); } }, def));
  assert.doesNotThrow(() => validateInstance({ render() {}, spatial: false }, def));
});

test('captureMapper hands the frame to the instance unchanged and checks the result', () => {
  const seen = [];
  const mapper = () => ({ x: 1, y: 2 });
  const inst = { render() {}, spatial: true, captureInputMapper(frame) { seen.push(frame); return mapper; } };
  const v2 = definePlugin(base());
  const frame = { sourceVersion: 8 };
  assert.equal(captureMapper(inst, v2, frame), mapper);
  assert.equal(seen[0], frame);
  assert.throws(() => captureMapper({ ...inst, captureInputMapper: () => 5 }, v2, {}), /must return a function/);
});

test('actions: a non-empty list of unique lowercase words, frozen in a copy; anything else is a TypeError', () => {
  const list = ['out', 'in', 'play'];
  const def = definePlugin({ ...base(), actions: list });
  assert.deepEqual([...(def.actions ?? [])], ['out', 'in', 'play']);
  assert.ok(Object.isFrozen(def.actions));
  list.push('later');
  assert.equal(def.actions?.length, 3, 'later edits of the input do not reach the definition');
  assert.equal(definePlugin(base()).actions, undefined, 'no actions: the field is absent');
  assert.throws(() => definePlugin({ ...base(), actions: [] }), /non-empty array/);
  assert.throws(() => definePlugin({ ...base(), actions: 'play' }), /non-empty array/);
  assert.throws(() => definePlugin({ ...base(), actions: ['Play'] }), /lowercase word/);
  assert.throws(() => definePlugin({ ...base(), actions: ['play', 3] }), /lowercase word/);
  assert.throws(() => definePlugin({ ...base(), actions: ['two words'] }), /lowercase word/);
  assert.throws(() => definePlugin({ ...base(), actions: ['play', 'play'] }), /twice/);
});

test('an instance of a definition with actions must provide runAction and settled; runAction without declared actions is a TypeError', () => {
  const withActions = definePlugin({ ...base(), actions: ['burst'] });
  assert.throws(() => validateInstance({ render() {} }, withActions), /declares the actions burst and must provide runAction/);
  assert.throws(() => validateInstance({ render() {}, runAction() { return null; } }, withActions), /settled/);
  assert.throws(() => validateInstance({ render() {}, settled() { return null; } }, withActions), /runAction/);
  assert.throws(() => validateInstance({ render() {}, runAction: 1, settled() { return null; } }, withActions), /runAction/);
  assert.doesNotThrow(() => validateInstance({ render() {}, runAction() { return null; }, settled() { return null; } }, withActions));
  assert.throws(() => validateInstance({ render() {}, runAction() { return null; } }, definePlugin(base())), /declares no `actions`/);
});
