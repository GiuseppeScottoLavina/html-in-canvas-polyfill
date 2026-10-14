// Tiny test API for browser unit tests. Imported by test files as '/test/unit/lib/t.js' and by host.js (same module instance).
// Runs inside the page: no Node APIs here.

/** @typedef {{name:string, fn:(t:TestContext)=>any, timeout:number|null, skip:boolean}} TestDef */
/** @typedef {{cleanup:(fn:()=>any)=>void}} TestContext */

/** @type {TestDef[]} */
export const registry = [];
/** @type {Array<()=>any>|null} cleanups of the running test */
let activeCleanups = null;

/**
 * @param {string} name
 * @param {(t:TestContext)=>any} fn
 * @param {{timeout?:number}} [opts] per-test timeout in ms (default: the runner's --timeout)
 */
export function test(name, fn, opts = {}) { registry.push({ name, fn, timeout: opts.timeout ?? null, skip: false }); }
/** Registered but not run; reported as skipped. */
test.skip = (/** @type {string} */ name, /** @type {any} */ fn) => { registry.push({ name, fn, timeout: null, skip: true }); };

/** Used by host.js around each test. */
export function beginTest() { activeCleanups = []; return /** @type {TestContext} */ ({ cleanup: fn => { activeCleanups?.push(fn); } }); }
export async function endTest() {
  const fns = activeCleanups ?? []; activeCleanups = null;
  const errors = [];
  for (const fn of fns.reverse()) { try { await fn(); } catch (e) { errors.push(e); } }
  if (errors.length) throw errors[0];
}

export class AssertionError extends Error {
  /** @param {string} message */
  constructor(message) { super(message); this.name = 'AssertionError'; }
}

/** @param {unknown} v */
const show = v => { try { return typeof v === 'string' ? JSON.stringify(v) : (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)); } catch { return String(v); } };

/** @param {any} a @param {any} b */
function deepEq(a, b, seen = new Set()) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (seen.has(a)) return true;
  seen.add(a);
  if (a instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Map || a instanceof Set) return a.size === b.size && deepEq([...a], [...b], seen);
  if (ArrayBuffer.isView(a)) return a.length === b.length && deepEq(Array.from(a), Array.from(b), seen);
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => Object.hasOwn(b, k) && deepEq(a[k], b[k], seen));
}

/** @param {unknown} err @param {RegExp|string|Function|undefined} m @param {string} what */
function matches(err, m, what) {
  if (m === undefined) return;
  const msg = String(/** @type {any} */ (err)?.message ?? err);
  if (m instanceof RegExp ? !m.test(msg) : typeof m === 'string' ? !msg.includes(m) : !(err instanceof /** @type {any} */ (m)))
    throw new AssertionError(`${what}: wrong error: ${msg}`);
}

export const assert = {
  /** @param {unknown} v @param {string} [msg] */
  ok(v, msg) { if (!v) throw new AssertionError(msg ?? `expected truthy, got ${show(v)}`); },
  /** @param {unknown} a @param {unknown} b @param {string} [msg] */
  equal(a, b, msg) { if (!Object.is(a, b)) throw new AssertionError(msg ?? `expected ${show(b)}, got ${show(a)}`); },
  /** @param {unknown} a @param {unknown} b @param {string} [msg] */
  notEqual(a, b, msg) { if (Object.is(a, b)) throw new AssertionError(msg ?? `expected value to differ from ${show(b)}`); },
  /** @param {unknown} a @param {unknown} b @param {string} [msg] */
  deepEqual(a, b, msg) { if (!deepEq(a, b)) throw new AssertionError(msg ?? `deepEqual failed: got ${show(a)}, expected ${show(b)}`); },
  /** @param {string} msg @returns {never} */
  fail(msg) { throw new AssertionError(msg); },
  /** @param {()=>any} fn @param {RegExp|string|Function} [m] message regexp/substring or error class */
  throws(fn, m) {
    try { fn(); } catch (e) { matches(e, m, 'throws'); return; }
    throw new AssertionError('expected function to throw');
  },
  /** @param {Promise<any>|(()=>Promise<any>)} p @param {RegExp|string|Function} [m] */
  async rejects(p, m) {
    try { await (typeof p === 'function' ? p() : p); } catch (e) { matches(e, m, 'rejects'); return; }
    throw new AssertionError('expected promise to reject');
  },
};

let fixtureSeq = 0;
/**
 * Mounts HTML in a fresh container attached to document.body; removed automatically when the test ends.
 * @param {string} html @param {Partial<CSSStyleDeclaration>} [style] container style
 * @returns {HTMLElement}
 */
export function fixture(html, style = {}) {
  const el = document.createElement('div');
  el.id = `fixture-${++fixtureSeq}`;
  Object.assign(el.style, style);
  el.innerHTML = html;
  document.body.append(el);
  activeCleanups?.push(() => el.remove());
  return el;
}

/** Resolves after `n` animation frames (the rendering update has run n times). */
export function frames(n = 1) {
  return new Promise(ok => { const step = () => (--n <= 0 ? ok(undefined) : requestAnimationFrame(step)); requestAnimationFrame(step); });
}
/** Drains the microtask queue (and one macrotask turn). */
export const microtasks = () => new Promise(ok => setTimeout(ok, 0));
/** @param {number} ms */
export const sleep = ms => new Promise(ok => setTimeout(ok, ms));
