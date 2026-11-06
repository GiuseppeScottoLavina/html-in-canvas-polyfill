// Page side of the runner: imports ?file=, runs its tests, publishes window.__unit for the runner to poll.
import { registry, beginTest, endTest } from '/test/unit/lib/t.js';

const q = new URLSearchParams(location.search);
const file = q.get('file') ?? '';
const defaultTimeout = Number(q.get('timeout') ?? 5000);
const filter = q.get('filter') ?? '';

/** @type {{state:string, loadError:string|null, tests:any[], current:string|null}} */
const U = (/** @type {any} */ (window).__unit = { state: 'loading', loadError: null, tests: [], current: null });

// Progress for the runner over a CDP binding (Runtime.addBinding): a binding call reaches the runner at once, so it still knows which test is running, and in
// which phase, when the page then blocks its main thread for good and answers nothing more. The binding is taken off the global object, as tests see it.
/** @type {((s: string) => void) | null} */
const progressBinding = typeof (/** @type {any} */ (window).__unitProgress) === 'function' ? /** @type {any} */ (window).__unitProgress : null;
try { delete (/** @type {any} */ (window).__unitProgress); } catch { /* stays reachable, harmless */ }
/** @param {object} m */
const progress = (m) => { try { progressBinding?.(JSON.stringify(m)); } catch { /* the runner is gone */ } };
/** @type {{name:string, t0:number}[]} start time of every test, to say which one a long task fell in: the last one started before the task ended (a task
 * starts before the test it runs, in the runner's own code) */
const starts = [];
const testAt = (/** @type {number} */ t) => { let name = null; for (const s of starts) { if (s.t0 <= t) name = s.name; else break; } return name; };
// Main-thread tasks of a second or more go to the runner when they end: a page that stopped answering and then answered again says what blocked it, and a
// stall of the CDP channel shows no such task.
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (e.duration >= 1000) progress({ ev: 'longtask', ms: Math.round(e.duration), test: testAt(e.startTime + e.duration) });
  }).observe({ type: 'longtask', buffered: true });
} catch { /* no long-task timing in this browser */ }

/** @type {{type:string,text:string}[]} */
let consoleBuf = [];
for (const type of /** @type {const} */ (['error', 'warn'])) {
  const orig = console[type].bind(console);
  console[type] = (/** @type {any[]} */ ...a) => { consoleBuf.push({ type, text: a.map(x => (x instanceof Error ? x.stack : String(x))).join(' ') }); orig(...a); };
}

/** @type {string[]} uncaught errors seen while a test runs; they fail that test */
let uncaught = [];
addEventListener('error', e => { uncaught.push(String(e.error?.stack ?? e.message)); });
addEventListener('unhandledrejection', e => { uncaught.push('unhandled rejection: ' + String(e.reason?.stack ?? e.reason)); });

/** @param {string} name */
function selected(name) {
  if (!filter) return true;
  const hay = `${file} > ${name}`.toLowerCase();
  const m = /^\/(.+)\/$/.exec(filter);
  return m ? new RegExp(m[1], 'i').test(hay) : hay.includes(filter.toLowerCase());
}

/** @param {Promise<any>} p @param {number} ms */
function withTimeout(p, ms) {
  let id = 0;
  const t = new Promise((_, bad) => { id = setTimeout(() => bad(Object.assign(new Error(`timeout after ${ms} ms`), { isTimeout: true })), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(id));
}

try {
  await import(file);
} catch (e) {
  U.loadError = String(/** @type {any} */ (e)?.stack ?? e);
}

if (!U.loadError) {
  if (!registry.length) U.loadError = 'test file registered no tests';
  for (const def of registry) {
    if (!selected(def.name)) continue;
    // 'running' until the test ends, its cleanup and the task after it included: a page that stops answering, or a cleanup that never ends, is never read as
    // a pass. The body's own result is published as soon as the body ends (`body`), apart from the test's.
    const rec = { name: def.name, status: 'running', body: /** @type {string|null} */ (null), ms: 0, error: '', console: /** @type {any[]} */ ([]) };
    U.tests.push(rec);
    if (def.skip) { rec.status = 'skip'; continue; }
    U.current = def.name; consoleBuf = []; uncaught = [];
    const t0 = performance.now();
    starts.push({ name: def.name, t0 });
    progress({ ev: 'start', name: def.name });
    const ctx = beginTest();
    let status = 'pass';
    try {
      await withTimeout(Promise.resolve().then(() => def.fn(ctx)), def.timeout ?? defaultTimeout);
    } catch (e) {
      const err = /** @type {any} */ (e);
      status = err?.isTimeout ? 'timeout' : 'fail';
      rec.error = String(err?.stack ?? err);
    }
    rec.body = status;
    progress({ ev: 'phase', phase: 'cleanup', body: status });
    try { await endTest(); } catch (e) { if (status === 'pass') { status = 'fail'; rec.error = 'cleanup failed: ' + String(/** @type {any} */ (e)?.stack ?? e); } }
    progress({ ev: 'phase', phase: 'settle', body: rec.body });
    await new Promise(r => setTimeout(r, 0)); // let queued uncaught errors/rejections surface
    if (uncaught.length && status === 'pass') { status = 'fail'; rec.error = 'uncaught error during test:\n' + uncaught.join('\n'); }
    rec.ms = Math.round(performance.now() - t0);
    rec.console = consoleBuf;
    rec.status = status;
  }
}
U.current = null;
U.state = 'done';
progress({ ev: 'done' });
