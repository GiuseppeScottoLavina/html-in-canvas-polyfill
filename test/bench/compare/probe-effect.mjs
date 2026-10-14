#!/usr/bin/env node
// Does the latency probe (per-frame readback of the output canvas) change the cost of the page under test? Same typing, traced, on a fresh
// page and again after 4 s of probe sampling. Run per subject:  node test/bench/compare/probe-effect.mjs --subject=ours
import { Session, SUBJECTS, H } from './lib/session.mjs';
import { startProbe, stopProbe } from './lib/probe.mjs';
import { canvasGeo, nonce } from './lib/common.mjs';
const sid = process.argv.find((a) => a.startsWith('--subject='))?.slice(10) ?? 'ours';
const sess = new Session(SUBJECTS[sid]);
try {
  await sess.open();
  for (const withProbe of [false, true]) {
    const page = await sess.goto('f1');
    const geo = await canvasGeo(page, '#hic-surface');
    const p = await page.evaluate('(() => { const c = document.querySelector("#hic-surface").getBoundingClientRect(); const e = document.getElementById("project").getBoundingClientRect(); return { x: e.left - c.left, y: e.top - c.top, w: e.width, h: e.height }; })()');
    await page.click(geo.x + p.x + p.w / 2, geo.y + p.y + p.h / 2); await H.sleep(300);
    if (withProbe) { await startProbe(page, { selector: '#hic-surface', region: { x: Math.round(p.x * 2), y: Math.round(p.y * 2), w: Math.round(p.w * 2), h: Math.round(p.h * 2) }, feature: 'hash' }); await H.typeKeys(page, nonce(10), { intervalMs: 120 }); await H.sleep(2500); await stopProbe(page); }
    const tr = await sess.traced(`probe-effect-${withProbe}`, async () => { await H.typeKeys(page, nonce(24), { intervalMs: 120 }); await H.sleep(300); });
    console.log(`${sid} ${withProbe ? 'AFTER 4 s of probe readback' : 'fresh page            '}: RunTask p95 ${tr.runTask.p95.toFixed(2)} max ${tr.runTask.max.toFixed(2)} >8.33=${tr.runTask.over8_33ms} busy ${tr.runTask.busyPct.toFixed(1)}% renderer CPU ${tr.cpu?.renderer}% GPU ${tr.cpu?.GPU}%`);
  }
} finally { await sess.close(); }
