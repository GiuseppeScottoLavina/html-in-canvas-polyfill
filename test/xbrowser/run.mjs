#!/usr/bin/env node
// G-xbrowser: the most important scenarios on desktop Firefox, Safari and (optional) Safari Technology Preview through W3C WebDriver (test/harness/lib/webdriver.mjs), each judged against the
// plain-DOM twin in the SAME engine, each with a positive control (a sabotaged run that must turn every declared check class red).
//   node test/xbrowser/run.mjs [--engine=firefox,safari,stp] [--only=explainer,form,clickEffect,controls,resize,scroll,scrollCompose,unsupported,uninstall,decodeTiming] [--no-control] [--bundle-file=/abs/x.js]
// One browser at a time. Safari is skipped (and reported NOT RUN, which fails the gate) when remote automation is not enabled on the machine.
// Safari Technology Preview ('stp') is OPTIONAL: SKIPPED (the gate still passes) when it is not installed or its remote automation is not allowed. Its native surface
// is read first: absent -> the polyfill scenarios, as on Safari, and the native-flag scenarios are reported SKIPPED with the reason; usable (its HTML-in-Canvas
// internal feature on) -> NATIVE_SCENARIOS (install steps aside, the explainer and the form drawn natively through the bridge against their plain-DOM twins,
// clicks, typing and repaint, uninstall identity, the examples); broken -> the refusal must name the missing core.
// Writes .scratch/results/xbrowser-<engine>-<ts>.json (+ diff PNGs under .scratch/results/xbrowser-<ts>/), prints one table, exits 1 on any failure.
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadavg } from 'node:os';
import { resolve, join } from 'node:path';
import { launchEngine, EngineUnavailable } from '../harness/lib/webdriver.mjs';
import { startServer } from '../harness/server.mjs';
import { encodePng } from '../harness/lib/png.mjs';
import { PROJECT_ROOT, arg, sleep } from '../harness/lib/util.mjs';
import { SCROLLBAR_PROBE_EXPR } from '../harness/lib/env.mjs';
import { watchActivations, foreignActivations, activateApp } from '../harness/lib/os-activation.mjs';
import { parkOsPointer } from '../harness/lib/os-pointer.mjs';
import { RECORDER } from './lib.mjs';
import { SCENARIOS, CONTROL_CLASSES, NATIVE_SURFACE, NATIVE_SCENARIOS } from './scenarios.mjs';

const engines = (arg('engine') ?? 'firefox,safari,stp').split(',');
const OPTIONAL = new Set(['stp']);
const only = arg('only')?.split(',');
const noControl = process.argv.includes('--no-control');
const CORE = '/dist/hic-live-polyfill.iife.js';
/** Firefox / Safari pages load the engines bundle (form-control skins) and the GPU bundle (element textures) with the core (docs/BUNDLES.md). */
const ENGINES = '/dist/hic-live-engines.iife.js';
const BUNDLE = [ENGINES, '/dist/hic-live-gpu.iife.js', CORE].join(',');
const bundleFile = arg('bundle-file');
/** --engines-file: the engines bundle served instead of dist's (the mutant suite's `bundle: 'engines'` mutants) */
const enginesFile = arg('engines-file');
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

/**
 * The platform scrollbar gutter of the current page, css px (0: overlay bars; null: no page to ask). macOS "Show scroll bars: Automatically" switches between overlay
 * and classic bars whenever a pointing device comes or goes (a mouse waking up, a Universal Control link to another Mac dropping), and a classic gutter widens every
 * textarea and listbox: a twin laid out before the switch and a polyfill page laid out after it differ by a gutter (measured 2026-10-16, Safari 27.0.1: the f6
 * progress, meter and colour controls 17 css px to the right, the Universal Control link dropped as the scenario started). Safari cannot be launched with its
 * own scrollbar setting (safaridriver starts it), so the gate measures the gutter around every scenario instead.
 */
const scrollbarGutter = async (s) => (await s.evaluate(SCROLLBAR_PROBE_EXPR).catch(() => null))?.verticalGutterPx ?? null;
/** A scenario whose scrollbars changed while it ran compared pages laid out with different bars; it runs again, at most this often, and fails if they never held. */
const SCROLLBAR_ATTEMPTS = 3;
/**
 * Application activations (macOS): a browser that is not the active application cannot make its window key, so a trusted click into it is swallowed (Safari: the
 * clickEffect field got no focus) and its popup cannot take the activation (Firefox: the inactive scenario). Measured with an own window activating itself every
 * second (test/harness/lib/os-activation.mjs). A scenario during which another application came to the front, or that started with one in front the browser
 * could not displace, ran in another environment than the one it judges: it runs again, at most ACTIVATION_ATTEMPTS times, and then fails as an environment problem.
 */
const ACTIVATION_ATTEMPTS = 3;
/**
 * The OS pointer (macOS): real pointer input reaches the page in both engines (WebDriver input does not move the OS pointer), so a person moving the mouse over
 * the test window changes hover and press looks behind the scenario's back. Measured: Firefox 157 interaction, 3 of 3 runs failed on 11-15 regions with real
 * pointer moves over the window every 0.7 s, 3 of 3 passed without (the intermittent single-region failures of D-rg:press, L-cb-on:hover in full runs came with
 * scrollbar switches, i.e. a mouse in use). The pointer is moved off the browser's windows before each scenario, and a scenario during which it moved runs again
 * (the same attempts as above), then fails as an environment problem.
 */
const activations = watchActivations();

async function runOnce(s, srv, engine, control, scenarios = SCENARIOS) {
  const rows = []; const numbers = {};
  /** the browser's processes (the application among them is the one that must stay in front) */
  const pids = (s.caps?.pids ?? []).map(Number);
  for (const [name, fn] of Object.entries(scenarios)) {
    if (only && !only.includes(name)) continue;
    if (control && !(typeof CONTROL_CLASSES[name] === 'function' || (CONTROL_CLASSES[name] ?? []).length)) continue;
    for (let attempt = 1; ; attempt++) {
      const checks = [];
      /** the attempt's report lines, printed once it is known whether the attempt counts (an attempt disturbed by the environment is run again) */
      const lines = [];
      const ctx = {
        s, srv, bundle: BUNDLE, control, numbers, files, coreFile: bundleFile ? resolve(bundleFile) : null,
        check: (label, ok, data, cls) => { checks.push({ label, ok: !!ok, cls, data }); if (!control) lines.push(`  ${ok ? 'ok  ' : 'FAIL'} [${engine}] ${label}${ok ? '' : ' ' + JSON.stringify(data)?.slice(0, 300)}`); },
        save: (n, img) => writeFileSync(join(pngDir, `${engine}${control ? '-control' : ''}-${n}.png`), encodePng(img)),
      };
      // a test window that lost activation (another app came to the front on this shared machine) draws macOS controls in their inactive look and drops trusted
      // clicks: re-activate it through WebDriver (switch to its own handle) before every scenario and record when it was not active
      try { const h = await s.cmd('GET', '/window'); await s.cmd('POST', '/window', { handle: h }); } catch { /* engines without window switching */ }
      if (!(await s.evaluate('document.hasFocus()').catch(() => true))) numbers[`${name}WindowInactive`] = true;
      // the browser must be the active application: bring it back if another one is in front, and record every activation while the scenario runs
      const watched = activations.available && pids.length > 0;
      if (watched && !pids.includes(activations.front()?.pid ?? -1)) { activateApp(pids); await sleep(600); }
      const parked = watched ? parkOsPointer(pids) : null;
      if (parked?.parked) await sleep(450);   // past one 200 ms pointer sample, so the parking itself is not recorded as a move
      const frontAtStart = activations.front();
      const actMark = activations.mark();
      const barsBefore = await scrollbarGutter(s);
      const t0 = Date.now(); let threw = null;
      try { await fn(ctx); } catch (e) { threw = String(e.stack ?? e).slice(0, 600); if (!control) lines.push(`  FAIL [${engine}] ${name} threw: ${threw}`); }
      /** an attempt that does not count: its lines are printed as such, and the scenario runs again */
      const discard = (why) => { console.log(`  [${engine}]${control ? ' (control)' : ''} ${name}: ${why}, attempt ${attempt} discarded; its checks were:`); for (const l of lines) console.log('  ' + l.replace(/^  (ok  |FAIL)/, '  ($1)')); };
      const barsAfter = await scrollbarGutter(s);
      const foreign = watched ? foreignActivations(activations.since(actMark), pids) : [];
      const inFront = !watched || pids.includes(frontAtStart?.pid ?? -1);
      const moved = watched ? activations.movesSince(actMark) : [];
      if (watched && (foreign.length || !inFront || moved.length)) {
        (numbers.activationChanges ??= []).push({ scenario: name, control, attempt, frontAtStart, foreign, pointerMoves: moved.length, parked, at: new Date().toISOString() });
        const why = `${!inFront ? `another application was in front (${frontAtStart?.name}) and the browser could not take it back` : foreign.length ? `another application came to the front (${foreign.map((a) => a.name).join(', ')})` : `the OS pointer moved (${moved.length} times)`} while the scenario ran (attempt ${attempt} of ${ACTIVATION_ATTEMPTS})`;
        if (attempt < ACTIVATION_ATTEMPTS) { discard(why); continue; }
        console.log(`  [${engine}]${control ? ' (control)' : ''} ${name}: ${why}`);
        checks.unshift({ label: `${name}: the browser stayed the active application and nobody moved the pointer during one of ${ACTIVATION_ATTEMPTS} attempts (another application in front swallows trusted clicks and keeps popups from activating; a moving pointer changes hover and press looks)`, ok: false, cls: 'environment', data: numbers.activationChanges.filter((c) => c.scenario === name) });
      }
      const barsHeld = barsBefore === null || barsAfter === null || barsBefore === barsAfter;
      if (!barsHeld) {
        (numbers.scrollbarChanges ??= []).push({ scenario: name, control, attempt, gutterBefore: barsBefore, gutterAfter: barsAfter, at: new Date().toISOString() });
        const why = `the system scrollbars changed during the scenario (gutter ${barsBefore} -> ${barsAfter} css px; attempt ${attempt} of ${SCROLLBAR_ATTEMPTS})`;
        if (attempt < SCROLLBAR_ATTEMPTS) { discard(why); continue; }
        console.log(`  [${engine}]${control ? ' (control)' : ''} ${name}: ${why}`);
        checks.unshift({ label: `${name}: the system scrollbars held during one of ${SCROLLBAR_ATTEMPTS} attempts (twin and polyfill page laid out with the same bars)`, ok: false, cls: 'environment', data: numbers.scrollbarChanges.filter((c) => c.scenario === name) });
      }
      for (const l of lines) console.log(l);
      if (checks[0]?.cls === 'environment' && !control) console.log(`  FAIL [${engine}] ${checks[0].label}`);
      rows.push({ scenario: name, checks, threw, ms: Date.now() - t0, attempts: attempt, gutter: barsAfter });
      break;
    }
  }
  return { rows, numbers };
}

const report = { gate: 'G-xbrowser', at: new Date().toISOString(), engines: {}, pass: true };
/** URL paths the server maps onto files: the --bundle-file core, the --engines-file engines bundle, and the mutant cores of scrollCompose's control (added while it runs) */
const files = { ...(bundleFile ? { [CORE]: resolve(bundleFile) } : {}), ...(enginesFile ? { [ENGINES]: resolve(enginesFile) } : {}) };
const srv = await startServer({ inject: RECORDER, files });
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
        } else if (kind !== 'absent') scenarios = NATIVE_SCENARIOS;
        else {
          E.nativeFlag = 'SKIPPED: the native HTML-in-Canvas surface is absent (the internal feature is off); the polyfill scenarios run instead. To cover the native-flag mode: Debug menu > WebKit Internal Features > HTML-in-Canvas (docs/SUPPORT-MATRIX.md)';
          console.log(`[${engine}] native-flag scenarios ${E.nativeFlag}`);
        }
      }
      E.real = await runOnce(s, srv, engine, false, scenarios);
      if (!noControl) E.control = await runOnce(s, srv, engine, true, scenarios);
    } finally { await s.close(); }
    E.scenarios = {};
    for (const row of E.real.rows) {
      const ok = !row.threw && row.checks.length > 0 && row.checks.every((c) => c.ok);
      let control = noControl ? 'skipped' : 'n/a';
      // a scenario that only reported a documented skip (class n/a) has nothing to control; a function names the classes from what the real run checked
      const decl = CONTROL_CLASSES[row.scenario];
      const want = row.checks.every((c) => c.cls === 'n/a') ? [] : typeof decl === 'function' ? decl(row) : (decl ?? []);
      if (!noControl && want.length) {
        const cr = E.control.rows.find((r) => r.scenario === row.scenario);
        const red = new Set((cr?.checks ?? []).filter((c) => !c.ok).map((c) => c.cls));
        const missing = cr?.threw ? want : want.filter((c) => !red.has(c));
        control = missing.length ? `DID NOT FAIL: ${missing.join(',')}${cr?.threw ? ' (control threw: ' + cr.threw.slice(0, 120) + ')' : ''}` : `red [${want.join(',')}]`;
      }
      const pass = ok && (noControl || !want.length || control.startsWith('red'));
      E.scenarios[row.scenario] = { pass, control, failed: row.checks.filter((c) => !c.ok).map((c) => c.label), threw: row.threw, ms: row.ms, environment: row.checks.some((c) => !c.ok && c.cls === 'environment') };
      if (!pass) report.pass = false;
    }
    E.numbers = E.real.numbers;
    if (noControl) report.pass = false;
    writeFileSync(join(outRoot, `xbrowser-${engine}-${stamp}.json`), JSON.stringify(E, null, 1));
  }
} finally { await srv.close(); clearTimeout(watchdog); activations.stop(); }

const table = [];
for (const [engine, E] of Object.entries(report.engines)) {
  if (!E.scenarios) { table.push({ engine, scenario: '-', verdict: E.verdict, control: '', first_failure: E.reason?.slice(0, 100) }); continue; }
  for (const [sc, r] of Object.entries(E.scenarios)) table.push({ engine: `${engine} ${E.version.split(' ').pop()}`, scenario: sc, verdict: r.pass ? 'PASS' : 'FAIL', control: r.control.slice(0, 40), first_failure: (r.environment ? 'ENVIRONMENT: ' + r.failed[0] : r.threw ?? r.failed[0] ?? '').slice(0, 90) });
}
console.table(table);
writeFileSync(join(outRoot, `xbrowser-summary-${stamp}.json`), JSON.stringify({ ...report, table }, null, 1));
// the result line of a gate (test/gates/lib/gate.mjs gateRunOutcome): the mutant runner compares the failed checks of a mutant core with those of the clean one
const assertions = Object.entries(report.engines).flatMap(([engine, E]) => (E.real?.rows ?? []).flatMap((row) => row.checks.map((c) => ({ name: `[${engine}] ${c.label}`, ok: c.ok }))));
const usable = Object.entries(report.engines).every(([engine, E]) => (E.verdict === 'SKIPPED' && OPTIONAL.has(engine)) || (E.scenarios && !Object.values(E.scenarios).some((r) => r.environment)));
console.log(JSON.stringify({ gate: 'G-xbrowser', verdict: report.pass ? 'PASS' : 'FAIL', usable, assertions, failed: assertions.filter((a) => !a.ok).map((a) => a.name) }));
console.log(report.pass ? 'G-xbrowser PASS' : 'G-xbrowser FAIL' + (noControl ? ' (--no-control never passes)' : ''));
process.exit(report.pass ? 0 : 1);
