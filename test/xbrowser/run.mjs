#!/usr/bin/env node
// G-xbrowser: the most important scenarios on desktop Firefox, Safari and (optional) Safari Technology Preview through W3C WebDriver (test/harness/lib/webdriver.mjs), each judged against the
// plain-DOM twin in the SAME engine, each with a positive control (a sabotaged run that must turn every declared check class red).
//   node test/xbrowser/run.mjs [--engine=firefox,safari,stp] [--only=explainer,form,clickEffect,controls,resize,scroll,unsupported,uninstall,decodeTiming] [--no-control] [--bundle-file=/abs/x.js]
// One browser at a time. Safari is skipped (and reported NOT RUN, which fails the gate) when remote automation is not enabled on the machine.
// Safari Technology Preview ('stp') is OPTIONAL: SKIPPED (the gate still passes) when it is not installed or its remote automation is not allowed. Its native surface
// is read first: absent -> the polyfill scenarios, as on Safari; usable (its HTML-in-Canvas feature flag on) -> the native scenario (the examples step aside and
// draw natively); broken -> the refusal must name the missing core.
// Writes .scratch/results/xbrowser-<engine>-<ts>.json (+ diff PNGs under .scratch/results/xbrowser-<ts>/), prints one table, exits 1 on any failure.
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadavg } from 'node:os';
import { resolve, join } from 'node:path';
import { launchEngine, EngineUnavailable } from '../harness/lib/webdriver.mjs';
import { startServer } from '../harness/server.mjs';
import { encodePng } from '../harness/lib/png.mjs';
import { PROJECT_ROOT, arg, sleep } from '../harness/lib/util.mjs';
import { RECORDER } from './lib.mjs';
import { SCENARIOS, CONTROL_CLASSES, NATIVE_SURFACE, nativeExamples } from './scenarios.mjs';

const engines = (arg('engine') ?? 'firefox,safari,stp').split(',');
const OPTIONAL = new Set(['stp']);
const only = arg('only')?.split(',');
const noControl = process.argv.includes('--no-control');
const CORE = '/dist/hic-live-polyfill.iife.js';
/** Firefox / Safari pages load the engines bundle (form-control skins) and the GPU bundle (element textures) with the core (docs/BUNDLES.md). */
const BUNDLE = ['/dist/hic-live-engines.iife.js', '/dist/hic-live-gpu.iife.js', CORE].join(',');
const bundleFile = arg('bundle-file');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outRoot = resolve(PROJECT_ROOT, '.scratch/results'); const pngDir = join(outRoot, `xbrowser-${stamp}`);
mkdirSync(pngDir, { recursive: true });
const WATCHDOG_MS = 15 * 60000;
const watchdog = setTimeout(() => { console.error('G-xbrowser WATCHDOG: run exceeded 15 min, killing our browsers'); process.exit(3); }, WATCHDOG_MS);

/** macOS: is the login session's screen locked? (the window server key is present only while locked) */
const screenLocked = () => /CGSSessionScreenIsLocked/.test(spawnSync('ioreg', ['-n', 'Root', '-d1'], { encoding: 'utf8' }).stdout ?? '');

/** A browser whose rendering updates are suspended (Safari behind a locked screen, a hidden window) cannot run any scenario: detect it up front. */
async function renderingAlive(s, srv) {
  await s.navigate(new URL('/test/fixtures/explainer/index.html?mode=ref', srv.url).href);
  return s.evaluate('new Promise((ok) => { requestAnimationFrame(() => requestAnimationFrame(() => ok(true))); setTimeout(() => ok(false), 3000); })');
}

async function waitLoad() {
  for (let i = 0; i < 12 && loadavg()[0] >= 6; i++) await sleep(5000);
  return +loadavg()[0].toFixed(2);
}

async function runOnce(s, srv, engine, control, scenarios = SCENARIOS) {
  const rows = []; const numbers = {};
  for (const [name, fn] of Object.entries(scenarios)) {
    if (only && !only.includes(name)) continue;
    if (control && !(CONTROL_CLASSES[name] ?? []).length) continue;
    const checks = [];
    const ctx = {
      s, srv, bundle: BUNDLE, control, numbers,
      check: (label, ok, data, cls) => { checks.push({ label, ok: !!ok, cls, data }); if (!control) console.log(`  ${ok ? 'ok  ' : 'FAIL'} [${engine}] ${label}${ok ? '' : ' ' + JSON.stringify(data)?.slice(0, 300)}`); },
      save: (n, img) => writeFileSync(join(pngDir, `${engine}${control ? '-control' : ''}-${n}.png`), encodePng(img)),
    };
    // a test window that lost activation (another app came to the front on this shared machine) draws macOS controls in their inactive look and drops trusted
    // clicks: re-activate it through WebDriver (switch to its own handle) before every scenario and record when it was not active
    try { const h = await s.cmd('GET', '/window'); await s.cmd('POST', '/window', { handle: h }); } catch { /* engines without window switching */ }
    if (!(await s.evaluate('document.hasFocus()').catch(() => true))) numbers[`${name}WindowInactive`] = true;
    const t0 = Date.now(); let threw = null;
    try { await fn(ctx); } catch (e) { threw = String(e.stack ?? e).slice(0, 600); if (!control) console.log(`  FAIL [${engine}] ${name} threw: ${threw}`); }
    rows.push({ scenario: name, checks, threw, ms: Date.now() - t0 });
  }
  return { rows, numbers };
}

const report = { gate: 'G-xbrowser', at: new Date().toISOString(), engines: {}, pass: true };
const srv = await startServer({ inject: RECORDER, files: bundleFile ? { [CORE]: resolve(bundleFile) } : {} });
try {
  for (const engine of engines) {
    const load = await waitLoad();
    let s;
    try { s = await launchEngine({ engine, width: 1200, height: 900 }); } catch (e) {
      if (OPTIONAL.has(engine) && e instanceof EngineUnavailable) { report.engines[engine] = { verdict: 'SKIPPED', reason: e.message }; console.log(`[${engine}] SKIPPED (optional engine): ${e.message}`); continue; }
      report.engines[engine] = { verdict: 'NOT RUN', reason: e.message }; report.pass = false; console.log(`[${engine}] NOT RUN: ${e.message}`); continue;
    }
    const E = report.engines[engine] = { version: s.version, platform: s.caps.platformName, loadAtStart: load, screenLocked: screenLocked() };
    if (!(await renderingAlive(s, srv).catch(() => false))) {
      E.verdict = 'NOT USABLE'; E.reason = `requestAnimationFrame never fired in ${engine} (screen locked: ${E.screenLocked}); Safari suspends rendering behind the lock screen, unlock and rerun`;
      report.pass = false; console.log(`[${engine}] ${E.reason}`); await s.close(); continue;
    }
    let scenarios = SCENARIOS;
    try {
      console.log(`[${engine}] ${s.version}`);
      if (engine === 'stp') {
        await s.navigate(new URL('/test/fixtures/explainer/index.html?mode=ref', srv.url).href);
        E.nativeSurface = await s.evaluate(NATIVE_SURFACE);
        const kind = E.nativeSurface.native.kind;
        console.log(`[${engine}] native HTML-in-Canvas: ${kind} (present: ${E.nativeSurface.native.present.join(', ') || 'none'}) -> ${E.nativeSurface.decision.mode}`);
        if (kind === 'broken') {
          const ok = E.nativeSurface.decision.mode === 'refused' && /without its core/.test(E.nativeSurface.decision.refusal?.message ?? '');
          scenarios = { nativeRefusal: (ctx) => ctx.check('native broken: the refusal names the missing core (API-CONTRACT 2)', ok, E.nativeSurface.decision, 'surface') };
        } else if (kind !== 'absent') scenarios = { nativeExamples };
      }
      E.real = await runOnce(s, srv, engine, false, scenarios);
      if (!noControl) E.control = await runOnce(s, srv, engine, true, scenarios);
    } finally { await s.close(); }
    E.scenarios = {};
    for (const row of E.real.rows) {
      const ok = !row.threw && row.checks.length > 0 && row.checks.every((c) => c.ok);
      let control = noControl ? 'skipped' : 'n/a';
      const want = CONTROL_CLASSES[row.scenario] ?? [];
      if (!noControl && want.length) {
        const cr = E.control.rows.find((r) => r.scenario === row.scenario);
        const red = new Set((cr?.checks ?? []).filter((c) => !c.ok).map((c) => c.cls));
        const missing = cr?.threw ? want : want.filter((c) => !red.has(c));
        control = missing.length ? `DID NOT FAIL: ${missing.join(',')}${cr?.threw ? ' (control threw: ' + cr.threw.slice(0, 120) + ')' : ''}` : `red [${want.join(',')}]`;
      }
      const pass = ok && (noControl || !want.length || control.startsWith('red'));
      E.scenarios[row.scenario] = { pass, control, failed: row.checks.filter((c) => !c.ok).map((c) => c.label), threw: row.threw, ms: row.ms };
      if (!pass) report.pass = false;
    }
    E.numbers = E.real.numbers;
    if (noControl) report.pass = false;
    writeFileSync(join(outRoot, `xbrowser-${engine}-${stamp}.json`), JSON.stringify(E, null, 1));
  }
} finally { await srv.close(); clearTimeout(watchdog); }

const table = [];
for (const [engine, E] of Object.entries(report.engines)) {
  if (!E.scenarios) { table.push({ engine, scenario: '-', verdict: E.verdict, control: '', first_failure: E.reason?.slice(0, 100) }); continue; }
  for (const [sc, r] of Object.entries(E.scenarios)) table.push({ engine: `${engine} ${E.version.split(' ').pop()}`, scenario: sc, verdict: r.pass ? 'PASS' : 'FAIL', control: r.control.slice(0, 40), first_failure: (r.threw ?? r.failed[0] ?? '').slice(0, 90) });
}
console.table(table);
writeFileSync(join(outRoot, `xbrowser-summary-${stamp}.json`), JSON.stringify({ ...report, table }, null, 1));
console.log(report.pass ? 'G-xbrowser PASS' : 'G-xbrowser FAIL' + (noControl ? ' (--no-control never passes)' : ''));
process.exit(report.pass ? 0 : 1);
