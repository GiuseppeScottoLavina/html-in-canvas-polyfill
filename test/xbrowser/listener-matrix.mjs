#!/usr/bin/env node
// The listener matrix (test/unit/live/listener-matrix.mjs) in Firefox and Safari through W3C WebDriver: every combination of a canvas listener's options, what its
// callback does and what happens to the canvas, on the polyfill and on a native element, compared call by call (Chrome runs it in the browser unit tests).
// Each part runs twice: as it is (0 divergences required) and as its positive control, with a canvas that drops `once` (divergences required); its number of
// cases is fixed (EXPECTED), so that a smaller matrix cannot pass.
//   node test/xbrowser/listener-matrix.mjs [--engine=firefox,safari]
// One browser at a time; Safari is reported NOT RUN (and fails) when remote automation is not enabled. Exits 1 on any divergence or a control that stayed green.
import { launchEngine } from '../harness/lib/webdriver.mjs';
import { startServer } from '../harness/server.mjs';
import { PROJECT_ROOT, arg } from '../harness/lib/util.mjs';

const engines = (arg('engine') ?? 'firefox,safari').split(',');
const EXPECTED = { base: 1440, remount: 1728, reinstall: 1728, pairs: 4352, 'pairs-life': 6528, handlers: 960 };
const srv = await startServer({ root: PROJECT_ROOT });
let failed = false;
try {
  for (const engine of engines) {
    let s;
    try { s = await launchEngine({ engine }); } catch (e) { console.log(`${engine}: NOT RUN (${String(e.message ?? e).slice(0, 160)})`); failed = true; continue; }
    try {
      await s.navigate(`${srv.url}/test/unit/live/listener-matrix.html`);
      await s.waitFor('window.matrixReady === true', { timeoutMs: 30000 });
      const r = JSON.parse(await s.evaluate('window.runMatrix()', { timeoutMs: 600000 }));
      const parts = Object.entries(r).filter(([k]) => k !== 'ua');
      const bad = [];
      for (const [k, v] of parts) {
        if (v.cases !== EXPECTED[k]) bad.push(`${k}: ${v.cases} cases, expected ${EXPECTED[k]}`);
        if (v.divergences) bad.push(`${k}: ${v.divergences} divergences`);
        if (!v.control) bad.push(`${k}: its control (once dropped) did not diverge`);
      }
      if (parts.length !== Object.keys(EXPECTED).length) bad.push(`${parts.length} parts, expected ${Object.keys(EXPECTED).length}`);
      if (bad.length) failed = true;
      console.log(`${engine} ${r.ua ?? ''}: ${bad.length ? 'FAIL' : 'OK'} ${parts.map(([k, v]) => `${k} ${v.divergences}/${v.cases} (control ${v.control})`).join(', ')}`);
      for (const b of bad) console.log(`  ${b}`);
      for (const [k, v] of parts) for (const d of v.first) console.log(`  ${k} ${d.life} ${d.behaviour}\n    native: ${d.native}\n    canvas: ${d.poly}`);
    } finally { await s.close(); }
  }
} finally { await srv.close(); }
console.log(failed ? 'G-listener-matrix (xbrowser): FAIL' : 'G-listener-matrix (xbrowser): OK');
process.exit(failed ? 1 : 0);
