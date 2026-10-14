// Gate runner: one browser, one server, a REAL run and a CONTROL run (a deliberately broken variant that must fail), one JSON line.
//
//   node test/gates/<gate>.mjs [--control-only] [--no-control] [--dpr=1|2] [--chrome=stable|canary] [--bundle-file=/abs/core.js] [--effects-file=/abs/effects.js] [--water-file=/abs/water.js] [--wait-quiet=SECONDS]
//   --wait-quiet waits (up to SECONDS) for the shared machine to be quiet before the run (TEST-PLAN rule 6); a run whose machine load stays above the threshold is labelled so.
//
// A gate is `run(ctx)` -> `{ numbers }`; it calls `ctx.check(name, ok, detail, class)` for every assertion (also throws are failures).
// `ctx.control` is true in the control run. The control bundle (`controlSabotage` option) already carries the sabotage BEFORE the first paint.
// The gate passes only when the real run has no failed assertion AND the control run turned red in EVERY declared check class (`controlClasses`):
// "some check went red" is not enough, each class of check (pixel, hit, typing, ...) must be shown able to fail.
//
// Verdicts (TEST-PLAN rule 1 and 6): PASS | FAIL | NOT USABLE (focus was refused/lost: the run is dropped and never counts).
// `degraded` lists reasons a result must be read with care (focus via a CDP click, machine load above threshold, no control run); `countsForThresholds` is true
// only for a clean, real-focus run without high machine load. A high-load PASS stays reportable but never decides a threshold.
//
// `--bundle-file` serves another core bundle (a mutant, see test/gates/mutants) under the normal bundle URL; `--effects-file` / `--water-file` do the same for the optional
// effects and water bundles (docs/BUNDLES.md). Bundles are snapshotted at start, so a concurrent rebuild of dist/ cannot change a run in flight.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import * as H from '../../harness/index.mjs';
import { controlBundleText, sabotage } from './sabotage.mjs';

export const ROOT = H.PROJECT_ROOT;
export const BUNDLE = '/dist/hic-live-polyfill.iife.js';
export const CONTROL_BUNDLE = '/dist/hic-live-polyfill.control.iife.js';
export const EFFECTS_BUNDLE = '/dist/hic-live-effects.iife.js';
export const WATER_BUNDLE = '/dist/plugins/water.iife.js';
/** `bundle=` value of a fixture URL that also loads the optional effects bundle and the water example plugin (plugins/water), after the core `bundle`. */
export const withEffects = (bundle) => `${bundle},${EFFECTS_BUNDLE},${WATER_BUNDLE}`;
export const RESULTS = resolve(ROOT, '.scratch/results');
const FOCUS_RANK = { real: 0, emulated: 1, 'cdp-click': 2, failed: 3 };

/** Is the macOS session locked? A locked screen has no honest foreground: results are labelled. */
function screenLocked() {
  try {
    return execFileSync('python3', ['-c', 'import Quartz;d=Quartz.CGSessionCopyCurrentDictionary();print(bool(d.get("CGSSessionScreenIsLocked")))'], { encoding: 'utf8', timeout: 5000 }).trim() === 'True';
  } catch { return null; }
}

/** Record the WORST focus mode seen in the run (real < emulated < cdp-click < failed). */
function noteFocus(state, mode) {
  state.calls = (state.calls ?? 0) + 1;
  if ((FOCUS_RANK[mode] ?? 3) >= (FOCUS_RANK[state.mode ?? 'real'] ?? 0)) state.mode = mode;
}

/**
 * Foreground + focus. When the OS refuses to activate the window (locked session) it falls back to a trusted click in the page corner: that run is DEGRADED
 * (`cdp-click`, a click on page content), and a page that still has no focus makes the run `failed` = NOT USABLE.
 */
export async function focusPage(page, state = {}) {
  const r = await page.ensureForeground({ timeout: 2500 });
  if (r.ok) { noteFocus(state, 'real'); return r; }
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 2, y: 2, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 2, y: 2, button: 'left', clickCount: 1 });
  await H.sleep(200);
  const s = await page.focusState();
  const ok = s.hasFocus && s.visibilityState === 'visible';
  noteFocus(state, ok ? 'cdp-click' : 'failed');
  return { ok, mode: ok ? 'cdp-click' : 'failed', state: s };
}

/** Throws-free focus check inside a measured window: a page that lost focus makes the whole run NOT USABLE. */
export async function stillFocused(page, state, what = '') {
  const s = await page.focusState().catch(() => null);
  const ok = !!s && s.hasFocus && s.visibilityState === 'visible';
  if (!ok) { state.lost = (state.lost ?? 0) + 1; state.lostAt = state.lostAt ?? what; }
  return ok;
}

function sha(text) { return createHash('sha256').update(text).digest('hex'); }

/** Snapshot the bundles under test (and the sabotaged control copy of the core) into .scratch/gate-bundles and map them under the standard URLs. */
function prepareBundles(id, bundleFile, kinds, optional = {}) {
  const dir = resolve(ROOT, '.scratch/gate-bundles');
  mkdirSync(dir, { recursive: true });
  const real = resolve(dir, `${id}-${process.pid}.iife.js`);
  copyFileSync(bundleFile, real);
  const text = readFileSync(real, 'utf8');
  const files = { [BUNDLE]: real };
  const tmp = [real];
  const extra = {};
  for (const [url, name, file] of [[EFFECTS_BUNDLE, 'effects', optional.effects], [WATER_BUNDLE, 'water', optional.water]]) {
    const copy = resolve(dir, `${id}-${process.pid}.${name}.iife.js`);
    copyFileSync(file, copy);
    files[url] = copy;
    tmp.push(copy);
    extra[name] = { file, sha256: sha(readFileSync(copy, 'utf8')) };
  }
  if (kinds.length) {
    const control = resolve(dir, `${id}-${process.pid}.control.iife.js`);
    writeFileSync(control, controlBundleText(text, kinds));
    files[CONTROL_BUNDLE] = control;
    tmp.push(control);
  }
  return { files, tmp, info: { file: bundleFile, sha256: sha(text), bytes: text.length, ...extra } };
}

/**
 * The verdict of a gate run (pure, unit-tested). `real` / `control` = `{checks:[{name,ok,cls?,detail?}], numbers, thrown}` or undefined when that phase did not run.
 * A control passes only when it detected something AND every declared class has a red check. A focus that was refused/lost makes the run NOT USABLE (pass:false); a CDP-click focus,
 * machine load above threshold, a locked screen and --no-control only DEGRADE it (reportable, never counted toward a threshold decision).
 */
export function judge({ real, control, controlClasses = [], focus = {}, highLoad = false, screenLocked = false, noControl = false }) {
  const out = { numbers: {}, assertions: [], failed: [], control: { ran: false, detected: false, failed: [], failedClasses: [], missingClasses: [] }, usable: true, degraded: [], pass: false, countsForThresholds: false, verdict: 'FAIL' };
  if (real) {
    out.numbers = real.numbers;
    out.assertions = real.checks;
    out.failed = real.checks.filter((c) => !c.ok).map((c) => c.name);
  }
  if (control) {
    const failedChecks = control.checks.filter((c) => !c.ok);
    const failedClasses = [...new Set(failedChecks.map((c) => c.cls).filter(Boolean))];
    out.control = {
      ran: true, detected: failedChecks.length > 0, failed: failedChecks.map((c) => c.name), failedClasses, missingClasses: controlClasses.filter((c) => !failedClasses.includes(c)),
      details: failedChecks.map((c) => ({ name: c.name, cls: c.cls ?? null, detail: c.detail })), numbers: control.numbers,
    };
  }
  const realOk = real ? real.checks.length > 0 && out.failed.length === 0 : true;
  const controlOk = control ? out.control.detected && out.control.missingClasses.length === 0 : true;
  if (focus.mode === 'failed') { out.usable = false; out.degraded.push('focus:failed'); }
  if (focus.lost) { out.usable = false; out.degraded.push(`focus-lost:${focus.lostAt ?? ''}`); }
  if (focus.mode === 'cdp-click') out.degraded.push('focus:cdp-click');
  if (focus.mode === 'emulated') out.degraded.push('focus:emulated');
  if (highLoad) out.degraded.push('high-load');
  if (screenLocked) out.degraded.push('screen-locked');
  if (noControl) out.degraded.push('no-control');
  out.pass = realOk && controlOk && (!real || !real.thrown) && out.usable;
  out.countsForThresholds = out.pass && out.degraded.length === 0;
  out.verdict = !out.usable ? 'NOT USABLE' : out.pass ? 'PASS' : 'FAIL';
  if (real && real.checks.length === 0) out.failed.push('gate made no assertion');
  if (control && !out.control.detected) out.failed.push('POSITIVE CONTROL DID NOT FAIL: the detector cannot see the broken variant');
  else if (control && out.control.missingClasses.length) out.failed.push(`POSITIVE CONTROL: no check of class [${out.control.missingClasses.join(', ')}] went red (these checks were never shown able to fail)`);
  if (!out.usable) out.failed.push(`NOT USABLE: ${out.degraded.join(', ')} (the run is dropped, it proves nothing)`);
  return out;
}

/** The single entry of a gate script. */
export async function runGate(id, run, { dpr, chrome = 'stable', windowSize, scrollbars, controlClasses = [], controlSabotage = [] } = {}) {
  const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const has = (k) => process.argv.includes(`--${k}`);
  const useDpr = arg('dpr') ? +arg('dpr') : dpr;
  const channel = arg('chrome') ?? chrome;
  const phases = has('control-only') ? ['control'] : has('no-control') ? ['real'] : ['real', 'control'];
  const t0 = Date.now();
  const bundles = prepareBundles(id, arg('bundle-file') ?? resolve(ROOT, 'dist/hic-live-polyfill.iife.js'), controlSabotage, {
    effects: arg('effects-file') ?? resolve(ROOT, 'dist/hic-live-effects.iife.js'), water: arg('water-file') ?? resolve(ROOT, 'dist/plugins/water.iife.js'),
  });
  const srv = await H.startServer({ files: bundles.files });
  const browser = await H.launchChrome({ name: `gate-${id}`, chrome: channel, ...(useDpr ? { dpr: useDpr } : {}), ...(windowSize ? { windowSize } : {}), ...(scrollbars ? { scrollbars } : {}) });
  const result = { gate: id, verdict: 'FAIL', pass: false, usable: true, degraded: [], countsForThresholds: false, numbers: {}, control: { ran: false, detected: false, failed: [], failedClasses: [], missingClasses: [] }, assertions: [], failed: [], load: null, chrome: null, dpr: useDpr ?? null, rafHz: null, focus: {}, screenLocked: screenLocked(), highLoad: false, bundle: bundles.info, noControl: !phases.includes('control'), startedAt: new Date().toISOString() };
  const outcomes = {};
  try {
    result.chrome = browser.version?.Browser ?? null;
    const waitSec = +(arg('wait-quiet') ?? 0);
    result.load = waitSec > 0 ? await H.waitForQuiet({ ownPids: [browser.pid, process.pid], maxWaitMs: waitSec * 1000, pollMs: 5000 }) : H.loadSnapshot({ ownPids: [browser.pid, process.pid] });
    result.highLoad = result.load.highLoad;
    for (const phase of phases) {
      const checks = [];
      let numbers = {};
      let thrown = null;
      const pages = [];
      const control = phase === 'control';
      const bundle = control && controlSabotage.length ? CONTROL_BUNDLE : BUNDLE;
      const ctx = {
        id, control, srv, browser, dpr: useDpr, bundle, effectsBundle: withEffects(bundle), focusState: result.focus,
        check(name, ok, detail, cls) { checks.push({ name, ok: !!ok, detail: detail ?? null, ...(cls ? { cls } : {}) }); return !!ok; },
        async page() { const p = await browser.newPage({ reuseFirst: pages.length === 0 }); pages.push(p); return p; },
        focus: (page) => focusPage(page, result.focus),
        stillFocused: (page, what) => stillFocused(page, result.focus, what),
        note(k, v) { numbers[k] = v; },
        polyUrl: (fixture, params = {}) => H.fixtureUrl(srv, fixture, { mode: 'poly', bundle, params }),
      };
      try {
        const out = await run(ctx);
        numbers = { ...numbers, ...(out?.numbers ?? {}) };
        if (phase === 'real' && !result.rafHz && pages[0]) { try { await focusPage(pages[0], result.focus); result.rafHz = Math.round((await pages[0].measureRaf({ frames: 60 })).hz * 10) / 10; } catch { /* informational */ } }
      } catch (err) {
        thrown = String(err?.stack ?? err).slice(0, 1500);
        checks.push({ name: 'gate ran to completion', ok: false, detail: thrown });
      }
      for (const p of pages) { try { await p.close(); } catch { /* closing the tab is best effort */ } }
      outcomes[phase] = { checks, numbers, thrown };
    }
    Object.assign(result, judge({ real: outcomes.real, control: outcomes.control, controlClasses, focus: result.focus, highLoad: result.highLoad, screenLocked: result.screenLocked, noControl: result.noControl }));
  } catch (err) {
    result.failed.push(`gate setup failed: ${String(err?.stack ?? err).slice(0, 800)}`);
    result.pass = false;
    result.verdict = 'FAIL';
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
    try { await srv.close(); } catch { /* ignore */ }
    for (const f of bundles.tmp) { try { rmSync(f, { force: true }); } catch { /* temp copy */ } }
  }
  result.durationMs = Date.now() - t0;
  mkdirSync(RESULTS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = resolve(RESULTS, `${id}-${stamp}.json`);
  const line = JSON.stringify(result);
  writeFileSync(file, line + '\n');
  console.log(line);
  const rows = (outcomes.real?.checks ?? []).map((c) => `  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : ' :: ' + JSON.stringify(c.detail).slice(0, 300)}`);
  const cl = result.control;
  console.log(`${result.verdict} ${id}  (real: ${outcomes.real ? outcomes.real.checks.filter((c) => c.ok).length + '/' + outcomes.real.checks.length : 'skipped'}; control detected: ${cl.ran ? cl.detected : 'skipped'} classes red [${cl.failedClasses.join(',')}] missing [${cl.missingClasses.join(',')}]${result.degraded.length ? '; DEGRADED: ' + result.degraded.join(',') : ''})  -> ${file}`);
  console.log(rows.join('\n'));
  if (result.failed.length) console.log('first violated: ' + result.failed[0]);
  process.exit(result.pass ? 0 : 1);
}

/** Fixture URL helper with the polyfill bundle. */
export function polyUrl(srv, id, params = {}) {
  return H.fixtureUrl(srv, id, { mode: 'poly', bundle: BUNDLE, params });
}

/** Trusted click on a CSS-px point and wait one frame. */
export async function clickAt(page, x, y) {
  await page.click(x, y);
  await H.sleep(60);
}

export { H, sabotage };
