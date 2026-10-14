import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARK } from '../../../src/contracts/events.js';
import { carriesMark, createPatchLedger } from '../../../src/api/patch.js';

const SAME = ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'];
/** descriptor equality by identity of every field */
function assertSameDescriptor(/** @type {any} */ a, /** @type {any} */ b, /** @type {string} */ what) {
  assert.ok(a && b, `${what}: both exist`);
  for (const k of SAME) assert.equal(a[k], b[k], `${what}: ${k}`);
}

class Base { inherited() { return 'base'; } }
class Target extends Base {
  method(/** @type {number} */ a, /** @type {number} */ b) { return a + b; }
  get acc() { return 'native'; }
  set acc(_v) { /* native setter */ }
}
const ledgerFor = () => createPatchLedger(/** @type {any} */ ({}));

test('define + restoreAll: a data property comes back with the very same function and flags', () => {
  const proto = Target.prototype;
  const before = Object.getOwnPropertyDescriptor(proto, 'method');
  const ledger = ledgerFor();
  const replacement = function () { return 'patched'; };
  ledger.define(proto, 'method', { ...before, value: replacement });
  assert.equal(new Target().method(1, 2), 'patched');
  assert.equal(ledger.isPatched(proto, 'method'), true);
  assert.deepEqual(ledger.restoreAll(), []);
  assertSameDescriptor(Object.getOwnPropertyDescriptor(proto, 'method'), before, 'method');
  assert.equal(new Target().method(1, 2), 3);
  assert.equal(ledger.isPatched(proto, 'method'), false);
});

test('an accessor is restored with the same getter and setter objects', () => {
  const proto = Target.prototype;
  const before = Object.getOwnPropertyDescriptor(proto, 'acc');
  const ledger = ledgerFor();
  ledger.define(proto, 'acc', { get() { return 'patched'; }, set() {}, configurable: true, enumerable: false });
  assert.equal(new Target().acc, 'patched');
  ledger.restoreAll();
  assertSameDescriptor(Object.getOwnPropertyDescriptor(proto, 'acc'), before, 'acc');
});

test('a property that did not exist on the object is deleted again; the inherited one shows through', () => {
  const proto = Target.prototype;
  assert.equal(Object.hasOwn(proto, 'inherited'), false);
  const ledger = ledgerFor();
  ledger.define(proto, 'inherited', { value: () => 'shadow', writable: true, configurable: true });
  assert.equal(new Target().inherited(), 'shadow');
  ledger.restoreAll();
  assert.equal(Object.hasOwn(proto, 'inherited'), false);
  assert.equal(new Target().inherited(), 'base');

  const o = {};
  ledger.define(o, 'fresh', { value: 1, configurable: true });
  ledger.restoreAll();
  assert.deepEqual(Object.getOwnPropertyNames(o), []);
});

test('wrap keeps name and length of the original, calls through, and stamps the replacement', () => {
  const proto = Target.prototype;
  const original = proto.method;
  const ledger = ledgerFor();
  let seen = 0;
  ledger.wrap(proto, 'method', (orig) => function (/** @type {any[]} */ ...args) { seen++; return orig.apply(this, args) * 10; });
  const wrapped = proto.method;
  assert.notEqual(wrapped, original);
  assert.equal(wrapped.name, 'method');
  assert.equal(wrapped.length, 2);
  assert.equal(new Target().method(1, 2), 30);
  assert.equal(seen, 1);
  assert.equal(/** @type {any} */ (wrapped)[MARK.PATCH_SYMBOL], true);
  assert.equal(/** @type {any} */ (original)[MARK.PATCH_SYMBOL], undefined, 'the native function itself is never stamped');
  ledger.restoreAll();
  assert.equal(proto.method, original);
});

test('wrap refuses what is not an own data property holding a function', () => {
  const ledger = ledgerFor();
  assert.throws(() => ledger.wrap(Target.prototype, 'acc', (o) => o), TypeError);
  assert.throws(() => ledger.wrap(Target.prototype, 'inherited', (o) => o), TypeError);
  assert.throws(() => ledger.wrap(Target.prototype, 'nope', (o) => o), TypeError);
});

test('layered patches of one key unwind in reverse order to the first original', () => {
  const o = { f() { return 'orig'; } };
  const original = Object.getOwnPropertyDescriptor(o, 'f');
  const ledger = ledgerFor();
  ledger.wrap(o, 'f', (orig) => function () { return `a(${orig.call(this)})`; });
  ledger.wrap(o, 'f', (orig) => function () { return `b(${orig.call(this)})`; });
  assert.equal(o.f(), 'b(a(orig))');
  assert.deepEqual(ledger.restoreAll(), []);
  assertSameDescriptor(Object.getOwnPropertyDescriptor(o, 'f'), original, 'f');
});

test('a foreign script that re-patched our patch is left alone and reported by name', () => {
  const o = { f() { return 'orig'; } };
  const ledger = ledgerFor();
  ledger.wrap(o, 'f', (orig) => function () { return `ours(${orig.call(this)})`; });
  const ours = o.f;
  o.f = function () { return `foreign(${ours.call(this)})`; };
  const left = ledger.restoreAll();
  assert.equal(left.length, 1);
  assert.match(left[0], /f$/);
  assert.match(o.f(), /^foreign/, 'the foreign patch survives');
});

test('list() tells which entries are still in place', () => {
  const o = { f() {}, g() {} };
  const ledger = ledgerFor();
  ledger.wrap(o, 'f', (orig) => function () { return orig.call(this); });
  ledger.wrap(o, 'g', (orig) => function () { return orig.call(this); });
  Object.defineProperty(o, 'g', { value() {}, configurable: true, writable: true });
  assert.deepEqual(ledger.list().map((e) => [e.key, e.patched]), [['f', true], ['g', false]]);
});

test('a member already stamped by another copy of the library is not patched a second time', () => {
  const o = { f() { return 'orig'; } };
  const first = ledgerFor();
  first.wrap(o, 'f', (orig) => function () { return `first(${orig.call(this)})`; });
  const second = ledgerFor();
  second.wrap(o, 'f', (orig) => function () { return `second(${orig.call(this)})`; });
  assert.equal(o.f(), 'first(orig)');
  assert.deepEqual(second.list(), []);
  second.restoreAll();
  assert.equal(o.f(), 'first(orig)', 'the second ledger restores nothing of the first');
  first.restoreAll();
  assert.equal(o.f(), 'orig');
});

test('carriesMark sees a stamp on a value, a getter or a setter, and nothing else', () => {
  const stamp = (/** @type {Function} */ f) => Object.defineProperty(f, MARK.PATCH_SYMBOL, { value: true });
  assert.equal(carriesMark({ value: stamp(() => 1) }), true);
  assert.equal(carriesMark({ get: stamp(() => 1) }), true);
  assert.equal(carriesMark({ set: stamp((_v) => {}) }), true);
  assert.equal(carriesMark({ value: () => 1 }), false);
  assert.equal(carriesMark({ value: 5 }), false);
  assert.equal(carriesMark(undefined), false);
  assert.equal(carriesMark(null), false);
});

test('restoreAll is idempotent and empties the ledger', () => {
  const o = { f() {} };
  const ledger = ledgerFor();
  ledger.wrap(o, 'f', (orig) => function () { return orig.call(this); });
  ledger.restoreAll();
  assert.deepEqual(ledger.restoreAll(), []);
  assert.deepEqual(ledger.list(), []);
});

test('mutation check: skipping one restore is visible to the descriptor comparison', () => {
  const o = { f() {}, g() {} };
  const before = Object.getOwnPropertyDescriptors(o);
  const ledger = ledgerFor();
  ledger.wrap(o, 'f', (orig) => function () { return orig.call(this); });
  ledger.wrap(o, 'g', (orig) => function () { return orig.call(this); });
  ledger.restoreAll();
  // positive control: re-apply one patch behind the ledger's back and the comparison must notice
  Object.defineProperty(o, 'g', { value() {}, writable: true, configurable: true, enumerable: true });
  const after = Object.getOwnPropertyDescriptors(o);
  assert.equal(after.f.value, before.f.value);
  assert.notEqual(after.g.value, before.g.value);
});

test('regression: install, uninstall, install again patches every property (no stamp is left on a platform getter)', () => {
  const proto = Target.prototype;
  const nativeGet = Object.getOwnPropertyDescriptor(proto, 'acc')?.get;
  const nativeMethod = proto.method;
  /** one "install": keep the platform getter, replace the setter; wrap a method; define a new key */
  const installOnce = (/** @type {any} */ ledger) => {
    const d = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(proto, 'acc'));
    ledger.define(proto, 'acc', { ...d, set() { /* patched setter */ } });
    ledger.wrap(proto, 'method', (/** @type {Function} */ orig) => function (/** @type {any[]} */ ...a) { return orig.apply(this, a) + 1; });
    ledger.define(proto, 'fresh', { value: () => 'fresh', configurable: true });
  };
  for (let round = 0; round < 3; round++) {
    const ledger = ledgerFor();
    installOnce(ledger);
    assert.equal(ledger.isPatched(proto, 'acc'), true, `round ${round}: accessor patched`);
    assert.equal(ledger.isPatched(proto, 'method'), true, `round ${round}: method patched`);
    assert.equal(ledger.isPatched(proto, 'fresh'), true, `round ${round}: new key patched`);
    assert.equal(new Target().method(1, 2), 4, `round ${round}: wrapped method answers`);
    assert.equal(Object.getOwnPropertyDescriptor(proto, 'acc')?.get, nativeGet, `round ${round}: the platform getter was kept as is`);
    assert.equal(/** @type {any} */ (nativeGet)[MARK.PATCH_SYMBOL], undefined, `round ${round}: the platform getter is not stamped`);
    assert.deepEqual(ledger.restoreAll(), []);
    assert.equal(proto.method, nativeMethod);
    assert.equal(carriesMark(Object.getOwnPropertyDescriptor(proto, 'acc')), false, `round ${round}: nothing left stamped after restore`);
    assert.equal(Object.hasOwn(proto, 'fresh'), false);
  }
});
