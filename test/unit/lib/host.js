// Page side of the runner: imports ?file=, runs its tests, publishes window.__unit for the runner to poll.
import { registry, beginTest, endTest } from '/test/unit/lib/t.js';

const q = new URLSearchParams(location.search);
const file = q.get('file') ?? '';
const defaultTimeout = Number(q.get('timeout') ?? 5000);
const filter = q.get('filter') ?? '';

/** @type {{state:string, loadError:string|null, tests:any[], current:string|null}} */
const U = (/** @type {any} */ (window).__unit = { state: 'loading', loadError: null, tests: [], current: null });

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
    const rec = { name: def.name, status: 'pass', ms: 0, error: '', console: /** @type {any[]} */ ([]) };
    U.tests.push(rec);
    if (def.skip) { rec.status = 'skip'; continue; }
    U.current = def.name; consoleBuf = []; uncaught = [];
    const t0 = performance.now();
    const ctx = beginTest();
    try {
      await withTimeout(Promise.resolve().then(() => def.fn(ctx)), def.timeout ?? defaultTimeout);
    } catch (e) {
      const err = /** @type {any} */ (e);
      rec.status = err?.isTimeout ? 'timeout' : 'fail';
      rec.error = String(err?.stack ?? err);
    }
    try { await endTest(); } catch (e) { if (rec.status === 'pass') { rec.status = 'fail'; rec.error = 'cleanup failed: ' + String(/** @type {any} */ (e)?.stack ?? e); } }
    await new Promise(r => setTimeout(r, 0)); // let queued uncaught errors/rejections surface
    if (uncaught.length && rec.status === 'pass') { rec.status = 'fail'; rec.error = 'uncaught error during test:\n' + uncaught.join('\n'); }
    rec.ms = Math.round(performance.now() - t0);
    rec.console = consoleBuf;
  }
}
U.current = null;
U.state = 'done';
