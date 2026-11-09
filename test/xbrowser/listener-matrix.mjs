#!/usr/bin/env node
// The listener matrix (test/unit/live/listener-matrix.mjs) in Firefox and Safari through W3C WebDriver: every combination of a canvas listener's options, what its
// callback does and what happens to the canvas, on the polyfill and on a native element, compared call by call (Chrome runs it in the browser unit tests).
// Positive control: the same page with ?control, where the canvas side drops `once`, must show divergences.
//   node test/xbrowser/listener-matrix.mjs [--engine=firefox,safari]
// One browser at a time; Safari is reported NOT RUN (and fails) when remote automation is not enabled. Exits 1 on any divergence or a control that stayed green.
import { launchEngine } from '../harness/lib/webdriver.mjs';
import { startServer } from '../harness/server.mjs';
import { PROJECT_ROOT, arg } from '../harness/lib/util.mjs';

const engines = (arg('engine') ?? 'firefox,safari').split(',');
const srv = await startServer({ root: PROJECT_ROOT });
let failed = false;
try {
  for (const engine of engines) {
    let s;
    try { s = await launchEngine({ engine }); } catch (e) { console.log(`${engine}: NOT RUN (${String(e.message ?? e).slice(0, 160)})`); failed = true; continue; }
    try {
      for (const control of [false, true]) {
        await s.navigate(`${srv.url}/test/unit/live/listener-matrix.html${control ? '?control' : ''}`);
        await s.waitFor('window.matrixReady === true', { timeoutMs: 30000 });
        const r = JSON.parse(await s.evaluate('window.runMatrix()', { timeoutMs: 600000 }));
        const parts = Object.entries(r).filter(([k]) => k !== 'ua');
        const total = parts.reduce((n, [, v]) => n + v.divergences, 0);
        const ok = control ? total > 0 : total === 0;
        if (!ok) failed = true;
        console.log(`${engine} ${r.ua ?? ''}${control ? ' control' : ''}: ${ok ? 'OK' : 'FAIL'} ${parts.map(([k, v]) => `${k} ${v.divergences}/${v.cases}`).join(', ')}`);
        if (!ok && !control) for (const [k, v] of parts) for (const d of v.first) console.log(`  ${k} ${d.life} ${d.behaviour}\n    native: ${d.native}\n    canvas: ${d.poly}`);
      }
    } finally { await s.close(); }
  }
} finally { await srv.close(); }
console.log(failed ? 'G-listener-matrix (xbrowser): FAIL' : 'G-listener-matrix (xbrowser): OK');
process.exit(failed ? 1 : 0);
