/**
 * Patch ledger: every prototype/instance patch is recorded with its original descriptor so uninstall restores it exactly.
 * Module: api-core. Implemented.
 */

import { MARK } from '../contracts/events.js';

/** @typedef {import('../contracts/types.js').PatchLedger} PatchLedger */

/**
 * @typedef {Object} Entry
 * @property {object} target
 * @property {PropertyKey} key
 * @property {PropertyDescriptor|undefined} original  descriptor before the patch (undefined = no own property existed)
 * @property {PropertyDescriptor} installed           descriptor read back after the patch; compared on restore to detect a foreign re-patch
 */

const MARK_SYMBOL = MARK.PATCH_SYMBOL;

/** @param {unknown} fn @returns {boolean} */
function isMarkedFunction(fn) {
  return typeof fn === 'function' && /** @type {any} */ (fn)[MARK_SYMBOL] === true;
}

/**
 * True when any function of the descriptor carries the polyfill symbol (also used by native-detect: a stamped member is never "native").
 * @param {PropertyDescriptor|undefined|null} d
 * @returns {boolean}
 */
export function carriesMark(d) {
  return !!d && (isMarkedFunction(d.value) || isMarkedFunction(d.get) || isMarkedFunction(d.set));
}

/**
 * Stamp the functions the polyfill created. A function that is part of the ORIGINAL descriptor (the platform getter of an accessor whose setter is
 * replaced, an unchanged value) is never stamped: the stamp would stay on the shared platform function after restoreAll() and make every later
 * install see the property as already patched and skip it.
 * @param {PropertyDescriptor} d  the descriptor about to be defined
 * @param {PropertyDescriptor|undefined} original  the descriptor being replaced
 */
function stampDescriptor(d, original) {
  const kept = original ? [original.value, original.get, original.set] : [];
  for (const fn of [d.value, d.get, d.set]) {
    if (typeof fn !== 'function' || isMarkedFunction(fn) || kept.includes(fn)) continue;
    Object.defineProperty(fn, MARK_SYMBOL, { value: true, configurable: true });
  }
}

/** @param {PropertyDescriptor|undefined} a @param {PropertyDescriptor|undefined} b */
function sameDescriptor(a, b) {
  if (!a || !b) return a === b;
  return a.value === b.value && a.get === b.get && a.set === b.set
    && a.enumerable === b.enumerable && a.configurable === b.configurable && a.writable === b.writable;
}

/** @param {object} target @param {PropertyKey} key @returns {string} */
function label(target, key) {
  const t = /** @type {any} */ (target);
  const ctor = typeof t.constructor === 'function' ? t.constructor : null;
  const owner = ctor && ctor.prototype === target ? `${ctor.name}.prototype` : (ctor?.name || 'object');
  return `${owner}.${String(key)}`;
}

/**
 * Create an empty ledger. A property that already carries the polyfill symbol and was NOT installed through this ledger (another copy of
 * the library) is never patched a second time; layering several patches of one key through ONE ledger is allowed and unwinds in reverse order.
 * @param {Window} _win
 * @returns {PatchLedger}
 */
export function createPatchLedger(_win) {
  /** @type {Entry[]} */
  let entries = [];

  /** @param {object} target @param {PropertyKey} key */
  const ownsCurrent = (target, key) => {
    const current = Object.getOwnPropertyDescriptor(target, key);
    return entries.some((e) => e.target === target && e.key === key && sameDescriptor(e.installed, current));
  };

  /** @type {PatchLedger['define']} */
  function define(target, key, descriptor) {
    const original = Object.getOwnPropertyDescriptor(target, key);
    if (carriesMark(original) && !ownsCurrent(target, key)) return;
    const next = { ...descriptor };
    stampDescriptor(next, original);
    Object.defineProperty(target, key, next);
    const installed = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(target, key));
    entries.push({ target, key, original, installed });
  }

  /** @type {PatchLedger['wrap']} */
  function wrap(target, key, wrapper) {
    const current = Object.getOwnPropertyDescriptor(target, key);
    if (!current || typeof current.value !== 'function') throw new TypeError(`cannot wrap ${label(target, key)}: not an own data property holding a function`);
    if (carriesMark(current) && !ownsCurrent(target, key)) return;
    const original = current.value;
    const replacement = wrapper(original);
    // Introspection of the patched method (name, length) stays that of the original.
    Object.defineProperty(replacement, 'name', { value: original.name, configurable: true });
    Object.defineProperty(replacement, 'length', { value: original.length, configurable: true });
    define(target, key, { ...current, value: replacement });
  }

  return {
    define,
    wrap,
    isPatched: (target, key) => carriesMark(Object.getOwnPropertyDescriptor(target, key)),
    list: () => entries.map((e) => ({ target: e.target, key: e.key, patched: sameDescriptor(Object.getOwnPropertyDescriptor(e.target, e.key), e.installed) })),
    restoreAll() {
      const left = [];
      for (const e of entries.reverse()) {
        if (!sameDescriptor(Object.getOwnPropertyDescriptor(e.target, e.key), e.installed)) { left.push(label(e.target, e.key)); continue; }
        if (e.original) Object.defineProperty(e.target, e.key, e.original);
        else Reflect.deleteProperty(e.target, e.key);
      }
      entries = [];
      return left;
    },
  };
}
