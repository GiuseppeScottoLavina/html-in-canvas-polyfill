// Native mode without a browser: the source provider (versions from paint events, sizes, the upload) and the hit-test geometry, over fakes
// of the standard API. The real thing is exercised on Chrome Canary by test/native-effects/run.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeSourceProvider } from '../../../src/effects/source-provider.js';
import { createNativeGeometry } from '../../../src/effects/native-geometry.js';

class FakeElement {
  constructor(name, parent = null) { this.name = name; this.parent = parent; this.offsetWidth = 400; this.offsetHeight = 240; }
  contains(other) { for (let n = other; n; n = n.parent) if (n === this) return true; return false; }
}

function rig({ grid = { width: 800, height: 480 } } = {}) {
  const listeners = new Map();
  let size = grid;
  let paintRequests = 0;
  const canvas = {
    addEventListener: (t, l) => listeners.set(t, l),
    removeEventListener: (t) => listeners.delete(t),
    requestPaint: () => { paintRequests += 1; },
    getElementImageDefaultSize: () => { if (!size) throw Object.assign(new Error('no snapshot'), { name: 'InvalidStateError' }); return size; },
  };
  const source = new FakeElement('source');
  const inner = new FakeElement('inner', source);
  const other = new FakeElement('other');
  const env = { window: { Element: FakeElement } };
  const provider = createNativeSourceProvider(env, /** @type {any} */ (canvas), /** @type {any} */ (source));
  const draws = [];
  let fail = null;
  const device = { queue: { drawElementImageToTexture: (s, d) => { if (fail) throw fail; draws.push({ source: s.source, size: d.size }); } } };
  return {
    provider, source, inner, other, draws, device, listeners,
    paintRequests: () => paintRequests,
    paint: (changed) => listeners.get('paint')?.(changed === undefined ? {} : { changedElements: changed }),
    setGrid: (g) => { size = g; },
    failWith: (e) => { fail = e; },
  };
}

test('native provider: no version before the first paint, which it requests; any first paint counts', () => {
  const r = rig();
  assert.equal(r.paintRequests(), 1, 'one paint is requested at creation');
  assert.equal(r.provider.version(), null);
  assert.equal(r.provider.size(), null);
  r.paint([]);
  assert.equal(r.provider.version(), 1, 'the first paint is a version even when it names nothing');
});

test('native provider: a later paint is a version only when it names the source, a drawable inside it, or one around it', () => {
  const r = rig();
  r.paint([r.source]);
  const v1 = r.provider.version();
  r.paint([]);
  assert.equal(r.provider.version(), v1, 'a paint requested for nothing is not a change of the source');
  r.paint([r.other]);
  assert.equal(r.provider.version(), v1, 'another drawable changed');
  r.paint([r.other, r.inner]);
  const v2 = r.provider.version();
  assert.ok(v2 > v1, 'a drawable inside the source changed');
  r.paint(undefined);
  assert.ok(r.provider.version() > v2, 'a build without changedElements: every paint counts');
});

test('native provider: size is the element image default size (rounded up) and the css border box', () => {
  const r = rig({ grid: { width: 800.4, height: 480 } });
  r.paint([r.source]);
  assert.deepEqual(r.provider.size(), { width: 801, height: 480, cssWidth: 400, cssHeight: 240 });
});

test('native provider: upload draws the whole element image into the texture; a resized bitmap is a new version', () => {
  const r = rig();
  r.paint([r.source]);
  const v = r.provider.version();
  const texture = { width: 800, height: 480 };
  assert.equal(r.provider.upload(r.device, texture, true), v);
  assert.deepEqual(r.draws, [{ source: r.source, size: { width: 800, height: 480 } }], 'one full draw (no partial upload on native)');
  assert.equal(r.provider.version(), v, 'unchanged size: same version');
  r.setGrid({ width: 1200, height: 720 });
  assert.ok(r.provider.version() > v, 'the default size changed after the upload: the texture is stale');
});

test('native provider: no element image yet (InvalidStateError) uploads nothing; other errors propagate; dispose removes the listener', () => {
  const r = rig();
  r.paint([r.source]);
  r.failWith(Object.assign(new Error('no snapshot'), { name: 'InvalidStateError' }));
  assert.equal(r.provider.upload(r.device, { width: 800, height: 480 }, true), 0);
  r.failWith(new TypeError('bad'));
  assert.throws(() => r.provider.upload(r.device, { width: 800, height: 480 }, true), TypeError);
  r.provider.dispose();
  assert.equal(r.listeners.size, 0);
});

function geometryRig() {
  const calls = [];
  const canvas = {
    updateElementGeometry: (el, o) => calls.push(['update', o.canvasTransform]),
    clearElementGeometry: () => calls.push(['clear']),
  };
  return { calls, g: createNativeGeometry(/** @type {any} */ (canvas), /** @type {any} */ ({})) };
}

test('native geometry: canvasTransform = translate(offset) * scale(fill), applied only when it changes', () => {
  const { calls, g } = geometryRig();
  g.setFill(1, 1);
  assert.deepEqual(calls, [['update', { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }]], 'the identity fill is applied too: it makes the source hit-testable');
  g.setFill(1, 1);
  assert.equal(calls.length, 1);
  assert.equal(g.setOffset(10, -4), true);
  g.setFill(2, 0.5);
  assert.deepEqual(calls.slice(1), [['update', { a: 1, b: 0, c: 0, d: 1, e: 10, f: -4 }], ['update', { a: 2, b: 0, c: 0, d: 0.5, e: 10, f: -4 }]]);
  assert.equal(g.setOffset(10, -4), false, 'the same offset again changes nothing');
  assert.equal(g.reset(), true);
  assert.deepEqual(calls.at(-1), ['update', { a: 2, b: 0, c: 0, d: 0.5, e: 0, f: 0 }]);
});

test('native geometry: park takes the source out of hit testing until the next offset; dispose clears it', () => {
  const { calls, g } = geometryRig();
  g.setFill(1, 1);
  assert.equal(g.park(), true);
  assert.equal(g.park(), false);
  g.setFill(3, 3);
  assert.deepEqual(calls.at(-1), ['clear'], 'a parked source stays out of hit testing when the fill changes');
  assert.equal(g.setOffset(0, 0), true, 'parked -> the same offset still re-enters hit testing');
  assert.deepEqual(calls.at(-1), ['update', { a: 3, b: 0, c: 0, d: 3, e: 0, f: 0 }]);
  g.dispose();
  assert.deepEqual(calls.at(-1), ['clear']);
});
