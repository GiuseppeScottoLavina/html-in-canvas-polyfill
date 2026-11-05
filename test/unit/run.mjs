#!/usr/bin/env node
// Browser unit-test runner. See test/unit/README.md.
import { readdirSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { startServer, launchChrome, sleep, PROJECT_ROOT } from '../harness/index.mjs';
import { describeHang } from './lib/hang.mjs';

const UNIT_DIR = resolve(PROJECT_ROOT, 'test/unit');
const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    filter: { type: 'string' }, module: { type: 'string', multiple: true }, headed: { type: 'boolean', default: false },
    timeout: { type: 'string', default: '5000' }, 'file-timeout': { type: 'string', default: '60000' },
    'expect-fail': { type: 'boolean', default: false }, chrome: { type: 'string', default: 'stable' },
    quiet: { type: 'boolean', default: false }, list: { type: 'boolean', default: false },
  },
});

/** Files: explicit positionals, else test/unit/[<module>/]**.browser.test.mjs (or **.expect-fail.mjs with --expect-fail); `--module plugins` (and no --module) adds plugins/**. */
function discover() {
  const suffix = opt['expect-fail'] ? '.expect-fail.mjs' : '.browser.test.mjs';
  /** @type {string[]} */ const out = [];
  const walk = (/** @type {string} */ d) => {
    for (const n of readdirSync(d).sort()) {
      const p = resolve(d, n);
      if (statSync(p).isDirectory()) { if (n !== 'lib' && n !== 'node_modules') walk(p); } else if (n.endsWith(suffix)) out.push(p);
    }
  };
  if (positionals.length) return positionals.map(p => resolve(p));
  for (const m of opt.module?.length ? opt.module : ['', 'plugins']) walk(m === 'plugins' ? resolve(PROJECT_ROOT, 'plugins') : resolve(UNIT_DIR, m));
  return out;
}

const files = discover();
/** repo-relative with forward slashes on every platform: it is also the URL path the host page imports */
const relPath = (/** @type {string} */ f) => relative(PROJECT_ROOT, f).split(sep).join('/');
if (opt.list) { for (const f of files) console.log(relPath(f)); process.exit(0); }
if (!files.length) { console.error('no test files found'); process.exit(1); }

const say = (/** @type {string} */ s) => { if (!opt.quiet) console.log(s); };
const indent = (/** @type {string} */ s, pad = '      ') => s.split('\n').map(l => pad + l).join('\n');
const trimStack = (/** @type {string} */ s) => s.replace(/http:\/\/127\.0\.0\.1:\d+/g, '');

/** the host page's progress binding (host.js): test start, phase, end of file, and main-thread tasks of a second or more */
const PROGRESS_BINDING = '__unitProgress';
/** how long a hung page is given to answer again, which tells a stall from a page that never yields */
const HANG_GRACE_MS = 10000;

/** Runs one file in a fresh tab; never throws for test-level problems. */
async function runFile(browser, srv, file) {
  const rel = relPath(file);
  const page = await browser.newPage({ reuseFirst: false });
  const res = { rel, tests: [], loadError: null, pageErrors: [], hung: false, /** @type {import('./lib/hang.mjs').HangInfo|null} */ hang: null, /** @type {number[]} */ stalls: [] };
  /** what the page last said through the binding; `at` is the runner's clock when that test started */
  const prog = { test: /** @type {string|null} */ (null), phase: /** @type {string|null} */ (null), at: 0, /** @type {{ms:number, test:string|null}[]} */ longTasks: [] };
  page.on('Runtime.bindingCalled', (/** @type {any} */ p) => {
    if (p.name !== PROGRESS_BINDING) return;
    let m; try { m = JSON.parse(p.payload); } catch { return; }
    if (m.ev === 'start') Object.assign(prog, { test: String(m.name), phase: 'test', at: Date.now() });
    else if (m.ev === 'phase') prog.phase = String(m.phase);
    else if (m.ev === 'done') Object.assign(prog, { test: null, phase: null });
    else if (m.ev === 'longtask' && prog.longTasks.length < 20) prog.longTasks.push({ ms: Number(m.ms), test: m.test ?? null });
  });
  try {
    await page.send('Runtime.addBinding', { name: PROGRESS_BINDING });
    const q = new URLSearchParams({ file: '/' + rel, timeout: opt.timeout, filter: opt.filter ?? '' });
    const at = srv.requests.length;
    await page.navigate(`${srv.url}/test/unit/lib/host.html?${q}`, { timeout: 30000 }).catch(e => {
      // the navigation itself failed: say what the server answered and what the browser printed, so a platform problem can be read from a CI log
      const served = srv.requests.slice(at).map((/** @type {any} */ x) => `${x.status} ${x.url.split('?')[0]}`).join(', ') || 'no request reached the server';
      res.loadError = `${e.message} (server: ${served}; browser stderr: ${browser.getStderr().trim().split('\n').slice(-6).join(' | ') || 'empty'})`;
    });
    const deadline = Date.now() + Number(opt['file-timeout']);
    // a page counts as hung once it has not answered for as long as one test may run (--timeout): a test blocking the main thread that long is broken, while a
    // shorter stall recovers. A single 2 s probe used to decide, and on the Windows runner one stall of a few seconds failed a whole file (twice in a test that
    // passes in milliseconds, 2026-10-29/30); a stall that recovered is reported
    let stalledSince = 0;
    while (!res.loadError) {
      const st = await Promise.race([page.evaluate('window.__unit?.state ?? "loading"'), sleep(2000).then(() => 'hung')]).catch(() => 'hung');
      if (st === 'done') break;
      if (st === 'hung') stalledSince ||= Date.now() - 2000;
      else if (stalledSince) { res.stalls.push(Date.now() - stalledSince); stalledSince = 0; }
      const unresponsive = !!stalledSince && Date.now() - stalledSince >= Number(opt.timeout);
      if (unresponsive || Date.now() > deadline) {
        res.hung = true;
        res.hang = await diagnoseHang(browser, page, prog, unresponsive ? 'unresponsive' : 'file-timeout', stalledSince ? Date.now() - stalledSince : 0);
        break;
      }
      await sleep(50);
    }
    const snap = await Promise.race([page.evaluate('JSON.stringify(window.__unit ?? null)'), sleep(3000).then(() => null)]).catch(() => null);
    const u = snap ? JSON.parse(snap) : null;
    if (u) { res.tests = u.tests; res.loadError ??= u.loadError; if (res.hang) res.hang.test ??= u.current; }
    else if (!res.loadError && !res.hung) res.loadError = 'host page did not initialise';
    // CDP exceptions also cover module-load failures and uncaught errors outside any test.
    res.pageErrors = page.exceptions.map(e => trimStack(e.text ?? ''));
    res.consoleOutside = page.console.filter(c => c.type === 'error').length;
  } finally { await page.close(); }
  return res;
}

/**
 * After the runner gave up on a page: does the browser process answer, does the page answer again within HANG_GRACE_MS, and which long tasks did it report.
 * The file is a failure whatever the answers; they only say what kind of hang it was.
 * @returns {Promise<import('./lib/hang.mjs').HangInfo>}
 */
async function diagnoseHang(browser, page, prog, reason, silentMs) {
  const at = Date.now();
  const test = prog.test, phase = prog.phase, sinceMs = prog.test ? at - prog.at : null;
  const browserMs = await browser.conn.send('Target.getTargets', {}, undefined, 2000).then(() => Date.now() - at, () => null);
  let answeredAfterMs = null;
  while (Date.now() - at < HANG_GRACE_MS) {
    const ok = await Promise.race([page.evaluate('1').then(() => true), sleep(1000).then(() => false)]).catch(() => false);
    if (ok) { answeredAfterMs = Date.now() - at; break; }
  }
  // a long task is reported by an observer callback queued after the task; give it the time to run
  if (answeredAfterMs != null) await sleep(300);
  return { reason, silentMs, fileTimeoutMs: Number(opt['file-timeout']), test, phase, sinceMs, browserMs, answeredAfterMs, graceMs: HANG_GRACE_MS, longTasks: [...prog.longTasks] };
}

function report(r) {
  say(`\n${r.rel}`);
  if (r.hung && opt.quiet) console.log(`\n${r.rel}`);
  for (const t of r.tests) {
    // a test still running when the page stopped answering: never "ok", and printed even with --quiet
    if (t.status === 'running') { console.log(`  RUN  ${t.name} (had not finished when the runner gave up on the page)`); continue; }
    const tag = { pass: 'ok  ', fail: 'FAIL', timeout: 'TIME', skip: 'skip' }[t.status];
    say(`  ${tag} ${t.name}${t.status === 'skip' ? '' : ` (${t.ms} ms)`}`);
    if (t.error) console.log(indent(trimStack(t.error)));
    for (const c of t.console) console.log(indent(`console.${c.type}: ${trimStack(c.text).split('\n')[0]}`, '      '));
  }
  if (r.hung) for (const [i, l] of describeHang(r.hang).entries()) console.log(i ? `        ${l}` : `  ${l}`);
  for (const ms of r.stalls) console.log(`  note: the page did not answer for ${(ms / 1000).toFixed(1)} s and recovered`);
  if (r.loadError) console.log(indent(`LOAD ERROR: ${trimStack(r.loadError)}`, '  '));
  for (const e of r.pageErrors) console.log(indent(`PAGE ERROR: ${e}`, '  '));
}

const count = (/** @type {any[]} */ rs, /** @type {string} */ s) => rs.reduce((n, r) => n + r.tests.filter((/** @type {any} */ t) => t.status === s).length, 0);
const problem = (/** @type {any} */ r) => r.tests.some((/** @type {any} */ t) => t.status === 'fail' || t.status === 'timeout') || r.loadError || r.hung || r.pageErrors.length > 0;

/**
 * --expect-fail: file name prefix says what the runner must detect: fail-*, timeout-*, pageerror-*, loaderror-*, hung-* (a page that never answers again,
 * with the test it hung in named), stall-* (hung too, but diagnosed as a stall: the page answers again and reports the long task of that test).
 */
function expectationMet(/** @type {any} */ r) {
  const kind = r.rel.split('/').pop().split('-')[0];
  const h = r.hang;
  const hit = {
    fail: r.tests.some((/** @type {any} */ t) => t.status === 'fail'), timeout: r.tests.some((/** @type {any} */ t) => t.status === 'timeout'),
    pageerror: r.pageErrors.length > 0, loaderror: !!r.loadError,
    hung: !!r.hung && !!h?.test && h.answeredAfterMs == null,
    stall: !!r.hung && !!h?.test && h.answeredAfterMs != null && h.longTasks.some((/** @type {any} */ t) => t.test === h.test && t.ms >= Number(opt.timeout)),
  }[kind];
  if (hit === undefined) throw new Error(`expect-fail file needs a fail-/timeout-/pageerror-/loaderror-/hung-/stall- prefix: ${r.rel}`);
  return hit;
}

const srv = await startServer();
const browser = await launchChrome({
  name: 'unit', chrome: opt.chrome, windowSize: [1000, 800], dpr: 1,
  extraArgs: opt.headed ? [] : ['--headless=new', '--hide-scrollbars'],
});
const stop = async () => { await browser.close().catch(() => {}); await srv.close().catch(() => {}); };
process.once('SIGINT', async () => { await stop(); process.exit(130); });
const t0 = Date.now();
/** @type {any[]} */ const results = [];
try {
  for (const f of files) { const r = await runFile(browser, srv, f); results.push(r); report(r); }
} finally { await stop(); }

const total = results.reduce((n, r) => n + r.tests.length, 0);
const failedFiles = results.filter(problem);
let ok;
if (opt['expect-fail']) {
  const unmet = results.filter(r => !expectationMet(r));
  for (const r of unmet) console.log(`NOT DETECTED: ${r.rel} should have been reported as a problem`);
  ok = unmet.length === 0;
  console.log(`unit(expect-fail): ${results.length - unmet.length}/${results.length} deliberate failures detected - ${ok ? 'OK' : 'FAILED'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
} else {
  ok = failedFiles.length === 0 && total > 0;
  if (total === 0) console.log('no tests ran (check --filter)');
  console.log(`unit: ${count(results, 'pass')} passed, ${count(results, 'fail')} failed, ${count(results, 'timeout')} timed out, ${count(results, 'skip')} skipped in ${results.length} files` +
    `, ${results.reduce((n, r) => n + r.pageErrors.length, 0)} page errors (${((Date.now() - t0) / 1000).toFixed(1)} s) - ${ok ? 'OK' : 'FAILED'}`);
}
process.exit(ok ? 0 : 1);
