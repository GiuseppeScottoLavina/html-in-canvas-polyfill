#!/usr/bin/env node
// Harness self-test: exercises every helper against tiny built-in fixtures (no polyfill needed) in a REAL headed Chrome and
// PROVES the positive controls fire (blank detector, non-blank test, cadence reporter, trace parser...).
//
//   node test/harness/selftest.mjs [--only=env,input,...,pointer] [--skip=pixel] [--chrome=stable|canary] [--keep-profile]
//
// Writes .scratch/selftest/<timestamp>/selftest.json (+ diff PNGs, traces) and prints PASS/FAIL per check and the environment.
// Exit code 1 when any gating check fails. `info` rows are measurements, not gates.
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from './server.mjs';
import { launchChrome } from './lib/chrome.mjs';
import { environmentFacts } from './lib/env.mjs';
import { SCRATCH_DIR, arg } from './lib/util.mjs';
import { waitForQuiet, loadSnapshot } from './lib/load.mjs';

const only = arg('only')?.split(','), skip = arg('skip')?.split(',') ?? [], chrome = arg('chrome') ?? 'stable';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(SCRATCH_DIR, 'selftest', stamp); mkdirSync(outDir, { recursive: true });

const R = { startedAt: new Date().toISOString(), outDir, environment: {}, checks: [], info: {}, sections: {} };
let section = '-';
const short = v => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > 230 ? s.slice(0, 230) + '...' : s; };
const check = (name, ok, detail) => { R.checks.push({ section, name, verdict: ok ? 'pass' : 'fail', detail }); console.log(`${ok ? 'PASS' : 'FAIL'} [${section}] ${name}${detail !== undefined ? '  ' + short(detail) : ''}`); return ok; };
const info = (name, data) => { (R.info[section] ??= {})[name] = data; console.log(`INFO [${section}] ${name}  ${short(data)}`); };
const ctx = { check, info, outDir, R, chrome };

const SECTIONS = [
  ['env', './selftest/env.mjs'], ['input', './selftest/input.mjs'], ['trace', './selftest/trace.mjs'], ['window', './selftest/window.mjs'],
  ['pixel', './selftest/pixel.mjs'], ['blank', './selftest/blank.mjs'], ['latency', './selftest/latency.mjs'], ['fixtures', './selftest/fixtures.mjs'], ['pointer', './selftest/pointer.mjs'],
];
const wanted = name => (!only || only.includes(name)) && !skip.includes(name);

R.loadBefore = await waitForQuiet({ maxWaitMs: Number(arg('waitquiet') ?? 60000) });
console.log('LOAD before', JSON.stringify({ loadAvg: R.loadBefore.loadAvg, highLoad: R.loadBefore.highLoad, busy: R.loadBefore.busyProcesses }));
const srv = await startServer();
ctx.srv = srv;
let browser;
try {
  browser = await launchChrome({ name: 'selftest', chrome });
  ctx.browser = browser;
  ctx.page = await browser.newPage();
  const fg = await ctx.page.requireForeground('selftest start');
  await ctx.page.navigate(`${srv.url}/test/harness/selftest-fixture/app.html`);
  R.environment.main = await environmentFacts(browser, ctx.page);
  R.environment.focusMode = fg.mode;
  console.log('ENVIRONMENT', JSON.stringify({ chrome: R.environment.main.chrome, dpr: R.environment.main.viewport.dpr, viewport: `${R.environment.main.viewport.innerWidth}x${R.environment.main.viewport.innerHeight}`,
    refreshHz: +R.environment.main.rafMeasured.impliedHz.toFixed(1), rafP50: +R.environment.main.rafMeasured.p50Ms.toFixed(2), focus: fg.mode, scrollbar: R.environment.main.scrollbar, mac: R.environment.main.mac }));
  for (const [name, file] of SECTIONS) {
    if (!wanted(name)) continue;
    section = name; const t0 = Date.now();
    try { await (await import(file)).run(ctx); }
    catch (e) { check('section completed without exception', false, String(e?.stack ?? e).slice(0, 900)); }
    R.sections[name] = { ms: Date.now() - t0 };
    // every section leaves the main tab on the interaction fixture for the next one
    await ctx.page.evaluate('0').catch(() => {});
  }
  section = 'console';
  check('main page: no unexpected console errors', ctx.page.errors().filter(e => !/expected-test-error/.test(e.text)).length === 0, ctx.page.errors());
} catch (e) {
  check('selftest setup', false, String(e?.stack ?? e));
} finally {
  if (browser) R.browserClose = await browser.close();
  section = 'shutdown';
  check('spawned Chrome terminated, no stragglers, profile removed', !!R.browserClose && R.browserClose.remaining.length === 0 && R.browserClose.profileRemoved === true, R.browserClose);
  await srv.close();
  R.loadAfter = loadSnapshot({}); R.highLoad = R.loadBefore.highLoad || R.loadAfter.highLoad;
  R.finishedAt = new Date().toISOString();
  const failed = R.checks.filter(c => c.verdict === 'fail');
  R.summary = { checks: R.checks.length, passed: R.checks.length - failed.length, failed: failed.length };
  writeFileSync(resolve(outDir, 'selftest.json'), JSON.stringify(R, null, 2));
  copyFileSync(resolve(outDir, 'selftest.json'), resolve(SCRATCH_DIR, 'selftest-latest.json'));
  console.log(`\nLOAD highLoad=${R.highLoad}`);
  console.log(`\n${failed.length ? 'FAILED' : 'ALL PASSED'}: ${R.summary.passed}/${R.summary.checks} checks   (details: ${outDir}/selftest.json)`);
  for (const f of failed) console.log(`  FAIL [${f.section}] ${f.name}`);
  process.exit(failed.length ? 1 : 0);
}
