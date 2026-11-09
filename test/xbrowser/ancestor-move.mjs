#!/usr/bin/env node
// The ancestor-move matrix (test/unit/schedule/ancestor-move-*.browser.test.mjs, docs/TEST-PLAN.md G-ancestor-move) in Firefox and Safari through W3C WebDriver:
// the same unit files, on the unit runner's own host page, as Chrome runs them in the browser unit tests. The browsers differ in what a shadow tree inherits (the
// language), so the cases that depend on it are judged against what the drawable computes in each. Every test must pass and each file must define its fixed
// number of tests (EXPECTED), so that a smaller matrix cannot pass.
//   node test/xbrowser/ancestor-move.mjs [--engine=firefox,safari]
// One browser at a time; Safari is reported NOT RUN (and fails) when remote automation is not enabled. Exits 1 on any failure.
import { launchEngine } from '../harness/lib/webdriver.mjs';
import { startServer } from '../harness/server.mjs';
import { PROJECT_ROOT, arg } from '../harness/lib/util.mjs';

const engines = (arg('engine') ?? 'firefox,safari').split(',');
const EXPECTED = { canvas: 16, ancestor: 12, preset: 4, 'shadow-canvas': 16, 'shadow-ancestor': 12, 'shadow-host': 9 };
const srv = await startServer({ root: PROJECT_ROOT });
let failed = false;
try {
  for (const engine of engines) {
    let s;
    try { s = await launchEngine({ engine }); } catch (e) { console.log(`${engine}: NOT RUN (${String(e.message ?? e).slice(0, 160)})`); failed = true; continue; }
    try {
      const summary = [];
      for (const [part, count] of Object.entries(EXPECTED)) {
        await s.navigate(`${srv.url}/test/unit/lib/host.html?file=/test/unit/schedule/ancestor-move-${part}.browser.test.mjs&timeout=8000`);
        await s.waitFor(`window.__unit && window.__unit.state === 'done'`, { timeoutMs: 300000, intervalMs: 500, what: `${part}: the unit host finished` });
        const u = JSON.parse(await s.evaluate(`JSON.stringify({ loadError: window.__unit.loadError,
          tests: window.__unit.tests.map((t) => ({ name: t.name, status: t.status, error: String(t.error).replace(/\\s+/g, ' ').slice(0, 300) })) })`));
        const passed = u.tests.filter((t) => t.status === 'pass').length;
        summary.push(`${part} ${passed}/${u.tests.length}`);
        if (u.loadError) { failed = true; console.log(`  ${part}: load error ${String(u.loadError).slice(0, 300)}`); continue; }
        if (u.tests.length !== count) { failed = true; console.log(`  ${part}: ${u.tests.length} tests, expected ${count}`); }
        for (const t of u.tests) if (t.status !== 'pass') { failed = true; console.log(`  ${t.status.toUpperCase()} ${t.name}\n      ${t.error}`); }
      }
      console.log(`${engine}: ${summary.join(', ')}`);
    } finally { await s.close(); }
  }
} finally { await srv.close(); }
console.log(failed ? 'G-ancestor-move (xbrowser): FAIL' : 'G-ancestor-move (xbrowser): OK');
process.exit(failed ? 1 : 0);
