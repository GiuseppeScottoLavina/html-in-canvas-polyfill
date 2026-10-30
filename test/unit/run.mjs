#!/usr/bin/env node
// Browser unit-test runner. See test/unit/README.md.
import { readdirSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { startServer, launchChrome, sleep, PROJECT_ROOT } from '../harness/index.mjs';

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

/** Runs one file in a fresh tab; never throws for test-level problems. */
async function runFile(browser, srv, file) {
  const rel = relPath(file);
  const page = await browser.newPage({ reuseFirst: false });
  const res = { rel, tests: [], loadError: null, pageErrors: [], hung: false, /** @type {number[]} */ stalls: [] };
  try {
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
      if ((stalledSince && Date.now() - stalledSince >= Number(opt.timeout)) || Date.now() > deadline) { res.hung = true; break; }
      await sleep(50);
    }
    const snap = await Promise.race([page.evaluate('JSON.stringify(window.__unit ?? null)'), sleep(3000).then(() => null)]).catch(() => null);
    const u = snap ? JSON.parse(snap) : null;
    if (u) { res.tests = u.tests; res.loadError ??= u.loadError; res.current = u.current; }
    else if (!res.loadError && !res.hung) res.loadError = 'host page did not initialise';
    // CDP exceptions also cover module-load failures and uncaught errors outside any test.
    res.pageErrors = page.exceptions.map(e => trimStack(e.text ?? ''));
    res.consoleOutside = page.console.filter(c => c.type === 'error').length;
  } finally { await page.close(); }
  return res;
}

function report(r) {
  say(`\n${r.rel}`);
  for (const t of r.tests) {
    const tag = { pass: 'ok  ', fail: 'FAIL', timeout: 'TIME', skip: 'skip' }[t.status];
    say(`  ${tag} ${t.name}${t.status === 'skip' ? '' : ` (${t.ms} ms)`}`);
    if (t.error) console.log(indent(trimStack(t.error)));
    for (const c of t.console) console.log(indent(`console.${c.type}: ${trimStack(c.text).split('\n')[0]}`, '      '));
  }
  if (r.hung) console.log(`  HUNG: page unresponsive or file timeout${r.current ? ` while running "${r.current}"` : ''}`);
  for (const ms of r.stalls) console.log(`  note: the page did not answer for ${(ms / 1000).toFixed(1)} s and recovered`);
  if (r.loadError) console.log(indent(`LOAD ERROR: ${trimStack(r.loadError)}`, '  '));
  for (const e of r.pageErrors) console.log(indent(`PAGE ERROR: ${e}`, '  '));
}

const count = (/** @type {any[]} */ rs, /** @type {string} */ s) => rs.reduce((n, r) => n + r.tests.filter((/** @type {any} */ t) => t.status === s).length, 0);
const problem = (/** @type {any} */ r) => r.tests.some((/** @type {any} */ t) => t.status === 'fail' || t.status === 'timeout') || r.loadError || r.hung || r.pageErrors.length > 0;

/** --expect-fail: file name prefix says what the runner must detect: fail-*, timeout-*, pageerror-*, loaderror-*, hung-*. */
function expectationMet(/** @type {any} */ r) {
  const kind = r.rel.split('/').pop().split('-')[0];
  const hit = {
    fail: r.tests.some((/** @type {any} */ t) => t.status === 'fail'), timeout: r.tests.some((/** @type {any} */ t) => t.status === 'timeout'),
    pageerror: r.pageErrors.length > 0, loaderror: !!r.loadError, hung: !!r.hung,
  }[kind];
  if (hit === undefined) throw new Error(`expect-fail file needs a fail-/timeout-/pageerror-/loaderror-/hung- prefix: ${r.rel}`);
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
