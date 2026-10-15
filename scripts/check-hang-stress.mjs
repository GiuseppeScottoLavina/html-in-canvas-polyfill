#!/usr/bin/env node
// G-hang-stress: the polyfill must never be able to hang a page, and the test harness must never hang on a stuck renderer.
//
//   npm run build && npm run test:stress
//   node scripts/check-hang-stress.mjs [--loads=30] [--throttle=1] [--no-control] [--no-probe]
//
// Real run: `loads` fresh tabs of examples/basic in HEADLESS Chrome (one browser, one tab at a time), cycling three scenarios
//   typing   click the drawn field, require focus on the live input, type 11 trusted keys, require the value AND a live main thread
//   idle     load and wait (the "stalls at idle right after loading" report)
//   misfocus click that misses the field, then Page.typeText: it must REFUSE (no editable focus) and leave the page alive
// Every CDP command is bounded (15 s); the first command that gets no answer is a HANG: the browser is SIGKILLed at once (own PIDs only) and the gate fails with the count.
// Watchdog control (the gate fails unless it turns red): a page that blocks its main thread for good (test/examples-smoke/hang-busy.html). A bounded command must time out, the
// watchdog must report the hang, and the kill must leave no process of that browser behind. It does not depend on any Chrome bug, so the gate can always fail.
// Chrome spin probe (informational, never fails the gate; up to 4 launches because the spin is probabilistic): five raw trusted keys on a page with no polyfill and NO focused
// editable, the exact sequence the misfocus guard refuses. Headless Chrome 154 spins a renderer on it; when the probe cannot reproduce that, the result says "not applicable on this
// Chrome (bug fixed upstream)" with the version, and the guard only keeps typing honest.
// Result: .scratch/results/hang-stress-<timestamp>.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as H from '../test/harness/index.mjs';
import { startServer } from '../examples/serve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOADS = +H.arg('loads', 30);
const THROTTLE = +H.arg('throttle', 1);
const BOUND_MS = 15000;
const SCENARIOS = ['typing', 'idle', 'misfocus'];

const launch = async (name) => {
  const browser = await H.launchChrome({ name, chrome: 'stable', windowSize: [1100, 900], dpr: 1, extraArgs: ['--headless=new', '--hide-scrollbars'] });
  browser.conn.sendTimeoutMs = BOUND_MS;
  return browser;
};
const sleep = H.sleep;

/** One load of examples/basic. Returns null when fine, else a problem string. A CdpTimeoutError propagates (= hang). */
async function oneLoad(browser, server, scenario) {
  const page = await browser.newPage({ reuseFirst: false });
  try {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
    if (THROTTLE > 1) await page.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    await page.navigate(`${server.url}/examples/basic/`);
    await sleep(300);
    const ready = await page.waitForFunction(`!!window.__HIC__ && !!document.querySelector('canvas') && document.querySelector('canvas').width > 0`, { timeout: 10000 }).catch(() => null);
    if (!ready) return 'the example did not become ready';
    if (scenario === 'idle') { await sleep(1200); await page.evaluate('performance.now()'); return null; }
    const c = await page.evaluate(`(() => { const r = document.getElementById('name').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (scenario === 'misfocus') {
      await page.click(4, 4); await sleep(100);
      const refused = await page.typeText('hello world').then(() => false, (e) => /no editable/.test(e.message));
      await page.evaluate('performance.now()');
      return refused ? null : 'typeText did not refuse to type without a focused editable';
    }
    await page.click(c.x, c.y); await sleep(150);
    const focused = await page.evaluate(`document.activeElement && document.activeElement.id`);
    if (focused !== 'name') return `the click did not focus the live input (activeElement: ${focused})`;
    await page.typeText('hello world');
    const value = await page.evaluate(`document.getElementById('name').value`);
    return value === 'hello world' ? null : `typed text did not arrive (value: ${JSON.stringify(value)})`;
  } finally { await page.close().catch(() => {}); }
}

/**
 * Watchdog control: a page that never yields again. Returns {detected, cleaned, ms}: a bounded command timed out (the watchdog reports the hang) and the SIGKILL left no process
 * of that browser.
 */
async function watchdogControl() {
  const server = await startServer({ files: { '/busy/': resolve(ROOT, 'test/examples-smoke/hang-busy.html') } });
  const browser = await launch('hang-watchdog');
  browser.conn.sendTimeoutMs = 4000;
  const t0 = Date.now();
  let detected = false;
  try {
    const page = await browser.newPage({ reuseFirst: false });
    await page.navigate(`${server.url}/busy/`);
    await sleep(600);
    for (let i = 0; i < 3; i++) { await page.evaluate('performance.now()'); await sleep(250); }
  } catch (e) { detected = e instanceof H.CdpTimeoutError; }
  const ms = Date.now() - t0;
  browser.kill();
  const report = await browser.close().catch(() => null);
  await server.close().catch(() => {});
  return { detected, cleaned: !!report && report.remaining.length === 0, ms };
}

/** Chrome spin probe: true when this Chrome still spins a renderer on raw trusted keys with no focused editable (the bounded watchdog reports it). */
async function chromeStillSpins() {
  const server = await startServer({ files: { '/ctl/': resolve(ROOT, 'test/examples-smoke/hang-control.html') } });
  const browser = await launch('hang-probe');
  browser.conn.sendTimeoutMs = 4000;
  try {
    const page = await browser.newPage({ reuseFirst: false });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false }); // as every example run does: the spin is far more likely with it
    await page.navigate(`${server.url}/ctl/`);
    await sleep(300);
    for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: 4, y: 4, button: 'left', clickCount: 1 });
    for (const ch of 'hello') { await page.key(ch); await sleep(25); }
    for (let i = 0; i < 20; i++) { await page.evaluate('performance.now()'); await sleep(250); } // the spin can start seconds after the keys
    return false;
  } catch (e) { return e instanceof H.CdpTimeoutError; }
  finally { browser.kill(); await browser.close().catch(() => {}); await server.close().catch(() => {}); }
}

const result = { script: 'scripts/check-hang-stress.mjs', startedAt: new Date().toISOString(), loads: LOADS, throttle: THROTTLE, boundMs: BOUND_MS, done: 0, hangs: 0, problems: [], control: null, chromeSpin: null, pass: false };
const server = await startServer();
let browser = await launch('hang-stress');
const chrome = browser.version?.Browser ?? 'Chrome (unknown version)';
result.chrome = chrome;
console.log(`${chrome} (headless), ${LOADS} loads of examples/basic, CPU throttle ${THROTTLE}x`);
try {
  for (let i = 0; i < LOADS; i++) {
    const scenario = SCENARIOS[i % SCENARIOS.length];
    try {
      const problem = await oneLoad(browser, server, scenario);
      if (problem) result.problems.push(`load ${i} (${scenario}): ${problem}`);
      result.done++;
    } catch (e) {
      if (!(e instanceof H.CdpTimeoutError)) { result.problems.push(`load ${i} (${scenario}): ${e.message}`); result.done++; continue; }
      result.hangs++; result.problems.push(`load ${i} (${scenario}): HANG ${e.message}`);
      browser.kill(); await browser.close().catch(() => {}); browser = await launch('hang-stress');
    }
  }
  if (!process.argv.includes('--no-control')) {
    result.control = await watchdogControl();
    const ok = result.control.detected && result.control.cleaned;
    console.log(`${ok ? 'ok  ' : 'FAIL'} watchdog control (a page that never yields) -> the bounded watchdog reports the hang (${result.control.ms} ms) and the kill leaves no process`);
    if (!result.control.detected) result.problems.push('watchdog control did not turn red: a page that blocks its main thread was not reported as a hang');
    else if (!result.control.cleaned) result.problems.push('watchdog control: processes of the killed browser survived');
  }
  if (!process.argv.includes('--no-probe')) {
    let spins = false;
    for (let attempt = 1; attempt <= 4 && !spins; attempt++) spins = await chromeStillSpins(); // the spin is probabilistic (about 5 in 8 launches on Chrome 154), so up to 4 launches
    result.chromeSpin = spins ? 'reproduced' : 'not applicable';
    console.log(spins
      ? `info Chrome spin probe: reproduced on ${chrome} (raw keys with no focused editable spin the renderer); the misfocus guard is still needed`
      : `n/a  Chrome spin probe: not applicable on this Chrome (bug fixed upstream): ${chrome} did not spin in 4 launches; the misfocus guard stays as a harness rule`);
  }
} finally { await browser.close().catch(() => {}); await server.close().catch(() => {}); }
result.pass = result.hangs === 0 && result.problems.length === 0;
mkdirSync(resolve(ROOT, '.scratch/results'), { recursive: true });
const file = resolve(ROOT, '.scratch/results', `hang-stress-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify(result, null, 1));
for (const p of result.problems) console.log('  x', p);
console.log(`${result.pass ? 'G-hang-stress: OK' : 'G-hang-stress: FAILED'}  ${result.done} loads, ${result.hangs} hangs  results: ${file}`);
process.exit(result.pass ? 0 : 1);
