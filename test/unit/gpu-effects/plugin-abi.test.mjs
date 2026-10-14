import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPluginContext, captureMapper, definePlugin, frameFor, validateInstance, withV1Fields } from '../../../src/effects/plugin-abi.js';

const base = () => ({ type: 'demo', apiVersion: 2, version: 1, create() { return { render() {} }; } });

test('definePlugin validates every required field with a TypeError', () => {
  assert.throws(() => definePlugin(null), TypeError);
  assert.throws(() => definePlugin({ ...base(), type: '' }), TypeError);
  assert.throws(() => definePlugin({ ...base(), type: 5 }), TypeError);
  assert.throws(() => definePlugin({ ...base(), apiVersion: 3 }), /apiVersion/);
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

test('a v1 definition is accepted unchanged and keeps its declared version', () => {
  const def = definePlugin({ ...base(), apiVersion: 1 });
  assert.equal(def.apiVersion, 1);
  assert.equal(buildPluginContext(def, { canvas: null }).apiVersion, 1, 'context.apiVersion equals the DECLARED version');
  assert.equal(buildPluginContext(definePlugin(base()), {}).apiVersion, 2);
});

test('v1 frames carry sourceSnapshotSerial = sourceVersion; v2 frames do not', () => {
  const v1 = definePlugin({ ...base(), apiVersion: 1 });
  const v2 = definePlugin(base());
  assert.equal(frameFor(v1, { sourceVersion: 42 }).sourceSnapshotSerial, 42);
  assert.equal('sourceSnapshotSerial' in frameFor(v2, { sourceVersion: 42 }), false);
  assert.equal(withV1Fields({ sourceVersion: null }).sourceSnapshotSerial, null);
});

test('validateInstance: render is required, optional members must be functions, flags booleans', () => {
  const def = definePlugin(base());
  assert.throws(() => validateInstance(null, def), TypeError);
  assert.throws(() => validateInstance({}, def), /render/);
  for (const name of ['resize', 'setOptions', 'captureInputMapper', 'mountUI', 'destroy']) {
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

test('captureMapper hands the frame to the instance (v1 alias for v1 plugins) and checks the result', () => {
  const seen = [];
  const mapper = () => ({ x: 1, y: 2 });
  const inst = { render() {}, spatial: true, captureInputMapper(frame) { seen.push(frame); return mapper; } };
  const v1 = definePlugin({ ...base(), apiVersion: 1 });
  const v2 = definePlugin(base());
  assert.equal(captureMapper(inst, v1, { sourceVersion: 7 }), mapper);
  assert.equal(seen[0].sourceSnapshotSerial, 7);
  captureMapper(inst, v2, { sourceVersion: 8 });
  assert.equal('sourceSnapshotSerial' in seen[1], false);
  assert.throws(() => captureMapper({ ...inst, captureInputMapper: () => 5 }, v2, {}), /must return a function/);
});
