#!/usr/bin/env node
// G-hang-stress: the polyfill must never be able to hang a page, and the test harness must never hang on a stuck renderer.
//
//   npm run build && npm run test:stress
//   node scripts/check-hang-stress.mjs [--loads=30] [--throttle=1] [--no-control]
//
// Real run: `loads` fresh tabs of examples/basic in HEADLESS Chrome (one browser, one tab at a time), cycling three scenarios
//   typing   click the drawn field, require focus on the live input, type 11 trusted keys, require the value AND a live main thread
//   idle     load and wait (the "stalls at idle right after loading" report)
//   misfocus click that misses the field, then Page.typeText: it must REFUSE (no editable focus) and leave the page alive
// Every CDP command is bounded (15 s); the first command that gets no answer is a HANG: the browser is SIGKILLed at once (own PIDs only) and the gate fails with the count.
// Positive control (the gate fails unless it turns red; up to 4 launches because the spin is probabilistic): the same kind of page with the polyfill absent, five raw trusted keys and NO focused editable (the exact
// sequence the guard refuses above). A headless Chrome 154 renderer spins on it, a bounded command times out, and the watchdog reports the hang. If Chrome stops
// spinning, the control stays green and the gate says so, because the guard and this control are then obsolete.
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

/** The control: returns true when the stuck renderer was detected by the bounded watchdog. */
async function controlTurnsRed() {
  const server = await startServer({ files: { '/ctl/': resolve(ROOT, 'test/examples-smoke/hang-control.html') } });
  const browser = await launch('hang-ctl');
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

const result = { script: 'scripts/check-hang-stress.mjs', startedAt: new Date().toISOString(), loads: LOADS, throttle: THROTTLE, boundMs: BOUND_MS, done: 0, hangs: 0, problems: [], control: null, pass: false };
const server = await startServer();
let browser = await launch('hang-stress');
console.log(`Chrome ${browser.version?.Browser} (headless), ${LOADS} loads of examples/basic, CPU throttle ${THROTTLE}x`);
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
    for (let attempt = 1; attempt <= 4 && !result.control; attempt++) result.control = await controlTurnsRed(); // the spin is probabilistic (about 5 in 8 launches), so up to 4 launches
    console.log(`${result.control ? 'ok  ' : 'FAIL'} control (five keys, no focused editable, no polyfill) -> a stuck renderer is detected by the bounded watchdog`);
    if (!result.control) result.problems.push('control did not turn red: the stuck-renderer watchdog is untested (did Chrome stop spinning? then this guard is obsolete)');
  }
} finally { await browser.close().catch(() => {}); await server.close().catch(() => {}); }
result.pass = result.hangs === 0 && result.problems.length === 0;
mkdirSync(resolve(ROOT, '.scratch/results'), { recursive: true });
const file = resolve(ROOT, '.scratch/results', `hang-stress-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify(result, null, 1));
for (const p of result.problems) console.log('  x', p);
console.log(`${result.pass ? 'G-hang-stress: OK' : 'G-hang-stress: FAILED'}  ${result.done} loads, ${result.hangs} hangs  results: ${file}`);
process.exit(result.pass ? 0 : 1);
