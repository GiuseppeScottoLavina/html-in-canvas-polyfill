// Metric 1: keystroke-to-pixel latency in a text input, content-verified per key.
//   fits:     the field is cleared, a 3-letter nonce typed, then 12 random wide letters per round; key k counts as drawn at the first frame
//             whose rightmost ink column reached the expected text advance (canvas measureText of the live value prefix) minus half a glyph.
//   overflow: the field holds ~28 random letters (text scrolls inside the field); key k counts as drawn at the first frame whose column ink
//             profile best matches the round's first frame shifted by the live input's scrollLeft after key k (states classified by argmin).
// Random letters per round (nonce) make every text state new, so no decoded-image cache can answer a key.
// Pacing: 120 ms (human) and 30 ms (fast typist). 3 rounds x 12 keys = 36 samples per config. A separate traced pass (no probe) gives RunTask.
import { H } from '../lib/session.mjs';
import { startProbe, stopProbe, waitFrames } from '../lib/probe.mjs';
import { nonce, stat, canvasGeo, toRegion, parseRgb, focusControl, compareRegion, readSurface, freezePaint } from '../lib/common.mjs';

const PAGES = {
  explainer: { fixture: 'explainer', canvas: 'canvas', container: '#twin', input: 'name' },
  f1: { fixture: 'f1', canvas: '#hic-surface', container: '#hic-surface', input: 'project' },
};

async function clearAndType(page, id, text, intervalMs = 40) {
  await page.evaluate(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); e.focus(); })()`);
  await H.sleep(200);
  await H.typeKeys(page, text, { intervalMs });
  await H.sleep(600);
}

async function widths(page, id, value) {
  return page.evaluate(`(() => { const e = document.getElementById(${JSON.stringify(id)}); const cs = getComputedStyle(e); const c = document.createElement('canvas').getContext('2d'); c.font = cs.font;
    try { c.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing; } catch {} const v = ${JSON.stringify(value)}; const out = []; for (let i = 0; i <= v.length; i++) out.push(c.measureText(v.slice(0, i)).width); return out; })()`);
}

function matchExtent(run, base, W, nonceLen, dpr) {
  // W[i] = css advance of the first i characters of the value (nonce + typed)
  const keys = run.events.filter((e) => e.type === 'keydown');
  const frames = run.frames;
  const E0 = base;
  const rows = keys.map((ev, k) => {
    const adv = (W[nonceLen + k + 1] - W[nonceLen]) * dpr, glyph = (W[nonceLen + k + 1] - W[nonceLen + k]) * dpr;
    const thr = E0 + adv - 0.5 * glyph;
    const hit = frames.find((f) => f.t > ev.t && f.f >= thr);
    return { k, t: ev.t, latency: hit ? hit.t - ev.t : null, thr };
  });
  const last = rows[rows.length - 1];
  const final = frames[frames.length - 1]?.f ?? -1;
  // reverted: a frame after a key's hit showing less text than that key (an older snapshot drawn over a newer one)
  let reverted = 0;
  for (const r of rows) if (r.latency !== null) { const t1 = r.t + r.latency; if (frames.some((f) => f.t > t1 && f.f < r.thr - 2)) reverted++; }
  return { rows, finalOk: last ? final >= last.thr && final <= last.thr + 60 : false, reverted };
}

function matchShift(run, dpr) {
  const keys = run.events.filter((e) => e.type === 'keydown');
  const frames = run.frames;
  const P0 = frames[0].f; const Wd = P0.length;
  const S0 = run.start.scrollLeft;
  const S = [0, ...keys.map((e) => ((e.stateRaf ?? e.state)?.scrollLeft ?? S0) - S0)].map((s) => Math.round(s * dpr));
  const meanInk = P0.reduce((a, b) => a + b, 0) / Wd || 1;
  const score = (P, d) => { let s = 0, n = 0; for (let x = 0; x + d < Wd - 2; x++) { s += Math.abs(P[x] - P0[x + d]); n++; } return n > 20 ? s / n : Infinity; };
  let unclassified = 0;
  const cls = frames.map((f) => {
    let best = -1, bs = Infinity;
    for (let j = 0; j < S.length; j++) for (const dd of [-1, 0, 1]) { const sc = score(f.f, Math.max(0, S[j] + dd)); if (sc < bs) { bs = sc; best = j; } }
    if (bs > 0.6 * meanInk) { unclassified++; return { t: f.t, j: -1 }; }
    return { t: f.t, j: best };
  });
  const rows = keys.map((ev, k) => { const hit = cls.find((c) => c.t > ev.t && c.j >= k + 1); return { k, t: ev.t, latency: hit ? hit.t - ev.t : null }; });
  const finalOk = cls[cls.length - 1].j === S.length - 1;
  const distinctShifts = new Set(S).size;
  return { rows, finalOk, unclassified, distinctShifts };
}

async function round(sess, P, geo, region, band, bg, mode, intervalMs) {
  const page = sess.page;
  const text = nonce(12);
  await page.requireForeground('typing round');
  const st = await startProbe(page, { selector: P.canvas, region, band, bg, feature: mode === 'fits' ? 'extent' : 'profile', events: ['keydown'], stateTarget: '#' + P.input });
  await waitFrames(page, 12);
  const start = await page.evaluate(`({ scrollLeft: document.getElementById(${JSON.stringify(P.input)}).scrollLeft, value: document.getElementById(${JSON.stringify(P.input)}).value })`);
  const inj = await H.typeKeys(page, text, { intervalMs });
  await H.sleep(700);
  const run = await stopProbe(page);
  run.start = start;
  // drop the frames before the first key except the last 5 (baseline)
  const firstKey = run.events.find((e) => e.type === 'keydown');
  const i0 = Math.max(0, run.frames.findIndex((f) => firstKey && f.t > firstKey.t) - 5);
  run.frames = run.frames.slice(i0);
  const value = await page.evaluate(`document.getElementById(${JSON.stringify(P.input)}).value`);
  const costs = run.frames.map((f) => f.cost);
  const blank = run.frames.filter((f) => f.alpha < 0.01 || f.content < 0.002).length;
  let m;
  if (mode === 'fits') {
    const W = await widths(page, P.input, value);
    const base = run.frames.slice(0, 5).map((f) => f.f).sort((a, b) => a - b)[2];
    m = matchExtent(run, base, W, start.value.length, st.dpr);
  } else m = matchShift(run, st.dpr);
  return { latencies: m.rows.map((r) => r.latency), keys: m.rows.length, eventsSeen: run.events.length, typedOk: value.endsWith(text), finalOk: m.finalOk, reverted: m.reverted ?? 0, unclassified: m.unclassified ?? 0,
    blankFrames: blank, frames: run.frames.length, updates: run.frames.filter((f) => f.changed > 0).length, cadence: { p50: inj.actual.p50, p95: inj.actual.p95, ok: inj.cadenceOk }, probeCostP50: stat(costs).p50 };
}

/** @param {import('../lib/session.mjs').Session} sess */
export async function runTyping(sess, pageId, { configs = [['fits', 120], ['fits', 30], ['overflow', 120], ['overflow', 30]], rounds = 3, control = true } = {}) {
  const P = PAGES[pageId];
  const ref = await sess.refGeometry(P.fixture, P.container, ['#' + P.input]);
  const r = ref['#' + P.input];
  const page = await sess.goto(P.fixture);
  const geo = await canvasGeo(page, P.canvas);
  const inset = { l: r.pad.l + 1, r: r.pad.r + 1, t: r.pad.t, b: r.pad.b };
  const bg = parseRgb(r.bg);
  const focus = await focusControl(page, geo, r, P.input);
  const out = { page: pageId, focus, geo, configs: {} };
  for (const [mode, ms] of configs) {
    await sess.loadCheck(`typing ${pageId} ${mode} ${ms}`);
    await page.requireForeground('typing');
    await page.evaluate(`document.getElementById(${JSON.stringify(P.input)}).focus()`);
    // the caret sits at the right edge while the text scrolls: keep it out of the overflow region
    const region = toRegion(r, geo, mode === 'fits' ? inset : { ...inset, r: inset.r + 5 });
    const band = [0, region.h];
    const rows = [];
    for (let i = 0; i < rounds; i++) {
      if (mode === 'fits') await clearAndType(page, P.input, nonce(3));
      else if (i === 0) await clearAndType(page, P.input, nonce(28), 25);
      rows.push(await round(sess, P, geo, region, band, bg, mode, ms));
    }
    const lat = rows.flatMap((x) => x.latencies);
    const timedOut = lat.filter((v) => v === null).length;
    // traced pass: same typing without the probe
    const tr = await sess.traced(`typing-${pageId}-${mode}-${ms}`, async () => { if (mode === 'fits') await clearAndType(page, P.input, nonce(3)); await H.typeKeys(page, nonce(24), { intervalMs: ms }); await H.sleep(300); }, { selector: P.canvas });
    out.configs[`${mode}@${ms}ms`] = {
      latencyMs: stat(lat), samples: lat.length, timedOut,
      correct: { allKeysDrawn: timedOut === 0, typedOk: rows.every((x) => x.typedOk), finalStateOk: rows.every((x) => x.finalOk), revertedKeys: rows.reduce((a, x) => a + x.reverted, 0), unclassifiedFrames: rows.reduce((a, x) => a + x.unclassified, 0), blankFrames: rows.reduce((a, x) => a + x.blankFrames, 0) },
      cadence: rows.map((x) => x.cadence), probeCostP50Ms: stat(rows.map((x) => x.probeCostP50)).p50, framesWithChange: rows.reduce((a, x) => a + x.updates, 0),
      traced: { runTask: tr.runTask, paints: tr.paints, cpu: tr.cpu, keys: 24 },
    };
    console.log(`  typing ${pageId} ${mode}@${ms}: p50 ${out.configs[`${mode}@${ms}ms`].latencyMs.p50} p95 ${out.configs[`${mode}@${ms}ms`].latencyMs.p95} max ${out.configs[`${mode}@${ms}ms`].latencyMs.max} n=${lat.length} timeout=${timedOut} final=${rows.map((x) => x.finalOk)} RunTask p95 ${tr.runTask.p95?.toFixed?.(2)} max ${tr.runTask.max?.toFixed?.(2)} >8.33=${tr.runTask.over8_33ms}`);
  }
  if (control) {
    // positive control: a frozen renderer (paint events swallowed) must time out on every key, or the matcher is not measuring the canvas
    const region = toRegion(r, geo, inset);
    await clearAndType(page, P.input, nonce(3));
    await freezePaint(page, true);
    const c = await round(sess, P, geo, region, [0, region.h], bg, 'fits', 120);
    await freezePaint(page, false);
    const to = c.latencies.filter((v) => v === null).length;
    out.control = { kind: 'frozen paint handler', keys: c.keys, timedOut: to, fired: to === c.keys };
    console.log(`  typing ${pageId} positive control (frozen renderer): ${to}/${c.keys} keys timed out -> ${out.control.fired ? 'control fires' : 'CONTROL DID NOT FIRE'}`);
    await H.sleep(300);
  }
  // final correctness: blurred input region vs the plain-DOM twin with the same value
  const value = await page.evaluate(`document.getElementById(${JSON.stringify(P.input)}).value`);
  await page.evaluate(`(() => { const e = document.getElementById(${JSON.stringify(P.input)}); e.blur(); e.scrollLeft = 0; })()`);
  await H.sleep(500);
  const surf = await readSurface(page, P.canvas);
  const twin = await sess.refShot(P.fixture, P.container, `(() => { const e = document.getElementById(${JSON.stringify(P.input)}); e.value = ${JSON.stringify(value)}; e.scrollLeft = 0; })()`);
  const region = toRegion({ x: r.x - 3, y: r.y - 3, width: r.width + 6, height: r.height + 6 }, geo);
  out.finalPixels = compareRegion(surf, twin.img, region);
  out.finalPixels.ok = out.finalPixels.fraction <= 0.03 || out.finalPixels.maxDiff <= 48; // <= 48 levels everywhere = anti-aliasing only
  console.log(`  typing ${pageId} final input region vs twin: ${JSON.stringify(out.finalPixels)}`);
  return out;
}
