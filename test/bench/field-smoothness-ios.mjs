// REPORTED DATA, no thresholds of its own: the field test page's scroll smoothness step (examples/field-test/) in Mobile Safari on the iOS SIMULATOR (safaridriver).
// The simulator runs on the Mac's CPU and GPU, so the numbers show WebKit's code paths, not a phone's frame times (see test/bench/scroll-jank-ios.mjs).
//   node test/bench/field-smoothness-ios.mjs [--udid=...] [--touch=timeout,skip] [--core=path] [--out=file]
// Per --touch mode, in a fresh page: every other step is skipped through the page's own buttons, the step runs its scripted scroll and its composed-vs-settled
// pixel jumps, and then its touch part, which WebDriver cannot drive on the simulator: `timeout` leaves it alone until its timeout (shortened to 5 s through
// window.__fieldTestOptions), `skip` presses "I cannot flick here". The report the page builds must validate; the step's checks and numbers are printed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchIosSimulator } from '../harness/lib/webdriver.mjs';
import { startServer } from '../harness/server.mjs';
import { PROJECT_ROOT, arg, sleep } from '../harness/lib/util.mjs';

const UDID = arg('udid') ?? 'DFB90FE1-E3F4-451A-8369-3B50C67BD0A5';
const TOUCH = (arg('touch') ?? 'timeout,skip').split(',');
const q = JSON.stringify;

// --core=<path under the project>: the core bundle under test, served at the bundle paths of the page (as test/bench/scroll-jank-ios.mjs)
const CORE = arg('core');
const srv = await startServer(CORE ? { files: { '/dist/hic-live-polyfill.iife.js': resolve(PROJECT_ROOT, CORE), '/dist/hic-live-polyfill.iife.min.js': resolve(PROJECT_ROOT, CORE) } } : {});
const s = await launchIosSimulator({ udid: UDID });
const out = { at: new Date().toISOString(), udid: UDID, core: CORE ?? null, caps: { browserVersion: s.caps.browserVersion, platformVersion: s.caps.platformVersion }, runs: [] };
const current = () => s.evaluate('window.__fieldTest ? window.__fieldTest.state.current : null');
const button = (action) => s.evaluate(`(() => { const b = document.querySelector(${q(`#ft-step-buttons [data-action="${action}"]`)}); return !!b && !b.disabled; })()`);
const press = async (action, timeoutMs = 20000) => {
  await s.waitFor(`(() => { const b = document.querySelector(${q(`#ft-step-buttons [data-action="${action}"]`)}); return !!b && !b.disabled; })()`, { timeoutMs, what: `button ${action}` });
  await s.evaluate(`document.querySelector(${q(`#ft-step-buttons [data-action="${action}"]`)}).click()`);
};
/** press Skip until the step `id` (or finish) is current */
async function skipUntil(id) {
  for (let i = 0; i < 12; i++) {
    const now = await current();
    if (now === id || now === 'finish') return;
    if (await button('skip')) await press('skip'); else if (await button('continue')) await press('continue'); else await sleep(300);
    await s.waitFor(`window.__fieldTest.state.current !== ${q(now)}`, { timeoutMs: 20000, what: `leaving step ${now}` });
  }
}
try {
  for (const mode of TOUCH) {
    const u = new URL('/examples/field-test/', srv.url); u.searchParams.set('iso', '0'); // not cross-origin isolated, as the published page
    await s.navigate(u.href);
    await s.waitFor('!!window.__fieldTest', { timeoutMs: 20000, what: 'the field test page' });
    await s.evaluate('window.__fieldTestOptions = { touchTimeoutMs: 5000, summaryMs: 3000 }');
    await press('start');
    await s.waitFor("window.__fieldTest.state.current === 'capture'", { timeoutMs: 60000, what: 'the capture step (after the environment)' });
    await skipUntil('smoothness');
    const t0 = Date.now();
    await press('start-smooth');
    await s.waitFor(`!!document.querySelector('#ft-step-buttons [data-action="skip-touch"]')`, { timeoutMs: 120000, intervalMs: 500, what: 'the touch part' });
    if (mode === 'skip') await press('skip-touch');
    await s.waitFor("window.__fieldTest.state.current !== 'smoothness'", { timeoutMs: 60000, intervalMs: 500, what: 'the end of the smoothness step' });
    const stepMs = Date.now() - t0;
    await skipUntil('finish');
    const report = JSON.parse(await s.evaluate('JSON.stringify(window.__fieldTest.buildReport({ crops: false }))'));
    const problems = await s.evaluate(`window.__fieldTest.validate(${JSON.stringify(report)})`);
    const sm = report.scrollSmoothness;
    const why = await s.evaluate('globalThis.__why ? globalThis.__why.join(" ") : null'); // a probe core's trace (--core), when it keeps one
    out.runs.push({ mode, stepMs, problems, why, status: report.steps.smoothness.status, scrollSmoothness: sm, checks: report.checks.filter((c) => c.id.startsWith('smoothness')) });
    console.log(`${mode}: step ${report.steps.smoothness.status} in ${Math.round(stepMs / 1000)} s, report ${problems.length ? 'INVALID ' + problems.join('; ') : 'valid'}`);
    if (sm?.device) console.log(`  device DPR ${sm.device.devicePixelRatio} screen ${sm.device.screen.join('x')} raster scale ${sm.device.rasterScale} canvas ${sm.device.canvas.backingStore.join('x')} mode ${sm.device.polyfillMode}`);
    for (const k of ['round', 'square']) {
      const m = sm?.script?.[k]; if (!m) continue;
      console.log(`  script ${k.padEnd(6)} frame ${m.frameMs} ms moves ${m.moves} painted ${m.paintedShare} paintHz ${m.paintHz} stutters ${m.paintGaps} (max ${m.maxPaintGap}) unpainted ${m.unpainted} lag ${m.startLag.join('/')} | composed ${m.stats.scroll?.composed} fallbacks ${m.stats.scroll?.fallbacks} refusals ${m.stats.scroll?.refusals} clone p50/p95 ${m.stats.cloneMsP50}/${m.stats.cloneMsP95} decode p50/p95 ${m.stats.decodeMsP50}/${m.stats.decodeMsP95} -> ${m.verdict}`);
    }
    if (sm?.pixels) console.log(`  pixels worst ${sm.pixels.worst} composed ${sm.pixels.composedJumps}/${sm.pixels.jumps} repainted ${sm.pixels.repaintedJumps} ${q([...sm.pixels.round.jumps, ...sm.pixels.square.jumps].map((j) => [j.t, j.composed ? 'c' : '-', j.diff]))}`);
    if (why) console.log(`  probe trace ${why.slice(0, 400)}`);
    if (sm?.touch) console.log(`  touch ${sm.touch.outcome} moves ${sm.touch.moves} waited ${sm.touch.waitedMs} ms -> ${sm.touch.verdict}`);
    for (const c of out.runs.at(-1).checks) console.log(`  ${c.verdict.padEnd(7)} ${c.id}: ${c.text}`);
  }
} catch (e) { out.error = String(e.stack || e); console.error(out.error); }
finally { await s.close(); await srv.close(); }
const file = arg('out') ?? resolve(PROJECT_ROOT, `.scratch/results/field-smoothness-ios-${out.at.replace(/[:.]/g, '-')}.json`);
mkdirSync(resolve(file, '..'), { recursive: true });
writeFileSync(file, JSON.stringify(out) + '\n');
console.log(out.error ? 'error' : 'ok', file);
process.exit(out.error || out.runs.some((r) => r.problems.length || r.status !== 'done') ? 1 : 0);
