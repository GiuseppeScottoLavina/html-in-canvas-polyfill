// Metrics 2-4: slider drag (input-to-pixel, pixel updates/s), click/focus-to-pixel, inner scroll (wheel) latency and frames.
// Each probe pass reads the canvas backing store; each traced pass repeats the input without the probe for RunTask / CPU / paint events.
import { H } from '../lib/session.mjs';
import { startProbe, stopProbe, waitFrames } from '../lib/probe.mjs';
import { stat, canvasGeo, toRegion, compareRegion, readSurface, freezePaint } from '../lib/common.mjs';

const F1_SEL = ['#fps-cap', '#name', '#demo-form h1'];

// ---------------------------------------------------------------------------------------------------------------------- slider (F1 #fps-cap)
async function sliderDrag(page, geo, r, { steps = 45, intervalMs = 8 } = {}) {
  const v = +(await page.evaluate('document.getElementById("fps-cap").value'));
  const frac = (v - 15) / 105;
  const y = geo.y + r.y + r.height / 2;
  const x0 = geo.x + r.x + 8 + frac * (r.width - 16);
  const right = geo.x + r.x + r.width + 12, left = geo.x + r.x - 12;
  await page.mouseMove(x0, y); await page.mouseDown(x0, y);
  const a = await H.mouseStream(page, { x: x0, y }, { x: right, y }, { steps, intervalMs, buttons: 1 });
  const b = await H.mouseStream(page, { x: right, y }, { x: left, y }, { steps: steps * 2, intervalMs, buttons: 1 });
  await page.mouseUp(left, y);
  return { cadence: { p50: b.actual.p50, p95: b.actual.p95, ok: a.cadenceOk && b.cadenceOk }, durationMs: a.totalMs + b.totalMs };
}

export async function runSlider(sess, { control = true } = {}) {
  const ref = await sess.refGeometry('f1', '#hic-surface', F1_SEL);
  const r = ref['#fps-cap'];
  const page = await sess.goto('f1');
  const geo = await canvasGeo(page, '#hic-surface');
  const region = toRegion(r, geo);
  const pass = async () => {
    await page.requireForeground('slider');
    // start from 60 every time (a trusted click at the 60 position)
    await startProbe(page, { selector: '#hic-surface', region, band: [Math.floor(region.h * 0.25), Math.ceil(region.h * 0.75)], feature: 'accent', events: ['input'], stateTarget: '#fps-cap' });
    await waitFrames(page, 10);
    const v0 = +(await page.evaluate('document.getElementById("fps-cap").value'));
    const drag = await sliderDrag(page, geo, r);
    await H.sleep(600);
    const run = await stopProbe(page);
    const vf = +(await page.evaluate('document.getElementById("fps-cap").value'));
    return { run, v0, vf, drag };
  };
  const analyse = ({ run, v0, vf, drag }) => {
    const fr = run.frames;
    const evs0 = run.events.filter((e) => e.type === 'input' && e.state).map((e) => +e.state.value);
    // calibration from the two extremes every pass reaches (max and min value): extent at the settled extremes of the drawn thumb
    const vmax = Math.max(v0, ...evs0), vmin = Math.min(vf, ...evs0);
    const valid = fr.map((f) => f.f).filter((x) => x >= 0);
    const emax = valid.length ? Math.max(...valid) : -1, emin = valid.length ? Math.min(...valid) : -1;
    const slope = vmax !== vmin && emax > emin ? (emax - emin) / (vmax - vmin) : NaN;
    const e0 = emin, ef = emax;
    const X = (v) => emin + (v - vmin) * slope;
    const lat = []; let prevV = v0;
    const evs = run.events.filter((e) => e.type === 'input' && e.state);
    for (const ev of evs) {
      const v = +ev.state.value; const dir = Math.sign(v - prevV); prevV = v;
      if (!dir) continue;
      const x = X(v);
      const hit = fr.find((f) => f.t > ev.t && (dir > 0 ? f.f >= x - 3 : f.f <= x + 3));
      lat.push(hit ? hit.t - ev.t : null);
    }
    const t0 = evs[0]?.t ?? 0, t1 = evs[evs.length - 1]?.t ?? 0;
    const during = fr.filter((f) => f.t >= t0 && f.t <= t1 + 50);
    let updates = 0; for (let i = 1; i < during.length; i++) if (during[i].f !== during[i - 1].f) updates++;
    return { latencies: lat, valueChanges: evs.length, pixelUpdatesPerSecond: t1 > t0 ? updates / ((t1 - t0 + 50) / 1000) : 0, framesPerSecond: t1 > t0 ? during.length / ((t1 - t0 + 50) / 1000) : 0,
      calibration: { v0, vf, e0, ef, slopePxPerUnit: slope }, blankFrames: fr.filter((f) => f.alpha < 0.01 || f.content < 0.002).length, cadence: drag.cadence, probeCostP50: stat(fr.map((f) => f.cost)).p50 };
  };
  const passes = [];
  for (let i = 0; i < 2; i++) passes.push(analyse(await pass()));
  const lat = passes.flatMap((p) => p.latencies);
  const timedOut = lat.filter((v) => v === null).length;
  const tr = await sess.traced('slider', async () => { await sliderDrag(page, geo, r); await H.sleep(300); });
  const out = { latencyMs: stat(lat), samples: lat.length, timedOut, pixelUpdatesPerSecond: stat(passes.map((p) => p.pixelUpdatesPerSecond)).mean, probeFramesPerSecond: stat(passes.map((p) => p.framesPerSecond)).mean,
    correct: { calibrated: passes.every((p) => Number.isFinite(p.calibration.slopePxPerUnit) && p.calibration.slopePxPerUnit > 2), allDrawn: timedOut === 0, blankFrames: passes.reduce((a, p) => a + p.blankFrames, 0) },
    passes: passes.map(({ latencies, ...rest }) => rest), traced: { runTask: tr.runTask, paints: tr.paints, cpu: tr.cpu } };
  if (control) {
    await freezePaint(page, true);
    const c = analyse(await pass());
    await freezePaint(page, false);
    const n = c.latencies.length, to = c.latencies.filter((v) => v === null).length;
    out.control = { kind: 'frozen paint handler', samples: n, timedOut: to, fired: !Number.isFinite(c.calibration.slopePxPerUnit) || to >= 0.9 * n };
  }
  console.log(`  slider: p50 ${out.latencyMs.p50} p95 ${out.latencyMs.p95} max ${out.latencyMs.max} n=${lat.length} timeout=${timedOut} updates/s ${out.pixelUpdatesPerSecond?.toFixed(1)} paints/s(traced) ${tr.paints.perSecond.toFixed(1)} RunTask p95 ${tr.runTask.p95?.toFixed(2)} max ${tr.runTask.max?.toFixed(2)} >8.33=${tr.runTask.over8_33ms} busy ${tr.runTask.busyPct?.toFixed(1)}% control=${out.control?.fired}`);
  return out;
}

// --------------------------------------------------------------------------------------------------------------- click / focus (F1 #name)
export async function runClick(sess, { trials = 30 } = {}) {
  const ref = await sess.refGeometry('f1', '#hic-surface', F1_SEL);
  const r = ref['#name'], h1 = ref['#demo-form h1'];
  const page = await sess.goto('f1');
  const geo = await canvasGeo(page, '#hic-surface');
  const region = toRegion({ x: r.x - 5, y: r.y - 5, width: r.width + 10, height: r.height + 10 }, geo);
  const at = (q) => ({ x: geo.x + q.x + q.width / 2, y: geo.y + q.y + q.height / 2 });
  const pIn = at(r), pOut = at(h1);
  await page.click(pOut.x, pOut.y); await H.sleep(300);
  const sample = async (n) => {
    await page.requireForeground('click');
    await startProbe(page, { selector: '#hic-surface', region, feature: 'none', events: ['pointerdown'], diffOn: ['pointerdown'], delta: 24, minFraction: 0.01 });
    await waitFrames(page, 8);
    const focusOk = [], blurOk = [];
    for (let i = 0; i < n; i++) {
      await page.click(pIn.x, pIn.y); await H.sleep(260);
      focusOk.push(await page.evaluate('document.activeElement && document.activeElement.id') === 'name');
      await page.click(pOut.x, pOut.y); await H.sleep(260);
      blurOk.push(await page.evaluate('document.activeElement && document.activeElement.id') !== 'name');
    }
    const run = await stopProbe(page);
    return { run, focusOk, blurOk };
  };
  const { run, focusOk, blurOk } = await sample(trials);
  const d = run.diffs.map((x) => (x.hitT === null ? null : x.hitT - x.t));
  const focusLat = d.filter((_, i) => i % 2 === 0), blurLat = d.filter((_, i) => i % 2 === 1);
  const tr = await sess.traced('click', async () => { for (let i = 0; i < 10; i++) { await page.click(pIn.x, pIn.y); await H.sleep(200); await page.click(pOut.x, pOut.y); await H.sleep(200); } });
  // control: frozen renderer -> no change in the field region after a focus click
  await freezePaint(page, true);
  const c = await sample(4);
  await freezePaint(page, false);
  const cd = c.run.diffs.filter((x) => x.hitT !== null).length;
  const out = { focusLatencyMs: stat(focusLat), blurLatencyMs: stat(blurLat), samples: focusLat.length + blurLat.length, timedOut: d.filter((v) => v === null).length,
    correct: { focusedByClick: focusOk.filter(Boolean).length, blurredByClick: blurOk.filter(Boolean).length, of: trials }, traced: { runTask: tr.runTask, paints: tr.paints, cpu: tr.cpu },
    control: { kind: 'frozen paint handler', clicks: c.run.diffs.length, changed: cd, fired: cd === 0 } };
  console.log(`  click: focus p50 ${out.focusLatencyMs.p50} p95 ${out.focusLatencyMs.p95} max ${out.focusLatencyMs.max}; blur p50 ${out.blurLatencyMs.p50} p95 ${out.blurLatencyMs.p95}; timeouts ${out.timedOut}; focused ${out.correct.focusedByClick}/${trials}; RunTask max ${tr.runTask.max?.toFixed(2)}; control ${out.control.fired}`);
  return out;
}

// ------------------------------------------------------------------------------------------------------------------ inner scroll (F2 #list)
export async function runScroll(sess, { trials = 30 } = {}) {
  const ref = await sess.refGeometry('f2', '#hic-surface', ['#list']);
  const r = ref['#list'];
  const page = await sess.goto('f2');
  await page.evaluate('window.scrollTo(0, 0)');
  const geo = await canvasGeo(page, '#hic-surface');
  const region = toRegion({ x: r.x, y: r.y + 40, width: r.width - 20, height: r.height - 40 }, geo); // below the sticky head, left of the bar
  const p = { x: geo.x + r.x + r.width / 2, y: geo.y + r.y + r.height / 2 };
  const st = () => page.evaluate('document.getElementById("list").scrollTop');
  // A: discrete wheel ticks, one every 220 ms: wheel -> first frame whose list pixels changed
  await page.requireForeground('scroll');
  await startProbe(page, { selector: '#hic-surface', region, feature: 'none', events: ['wheel'], diffOn: ['wheel'], delta: 24, minFraction: 0.02 });
  await waitFrames(page, 8);
  const tops = [];
  for (let i = 0; i < trials; i++) { await page.wheel(p.x, p.y, 0, 100); await H.sleep(220); tops.push(await st()); }
  const runA = await stopProbe(page);
  const lat = runA.diffs.map((x) => (x.hitT === null ? null : x.hitT - x.t));
  const moved = tops.filter((t, i) => t !== (i ? tops[i - 1] : -1)).length;
  // correctness: list region vs the twin scrolled to the same offset (settled)
  await H.sleep(400);
  const top = await st();
  const surf = await readSurface(page, '#hic-surface');
  const twin = await sess.refShot('f2', '#hic-surface', `document.getElementById('list').scrollTop = ${top}`);
  const px = compareRegion(surf, twin.img, toRegion({ x: r.x, y: r.y, width: r.width, height: r.height }, geo));
  px.ok = px.fraction <= 0.03;
  // B: continuous stream (60 ticks of 40 px at 8 ms, then back up): canvas updates/s while the live list moves
  await page.requireForeground('scroll stream');
  await startProbe(page, { selector: '#hic-surface', region, feature: 'hash', events: ['wheel', 'scroll'] });
  await waitFrames(page, 8);
  const sB0 = await st();
  const inj = await H.wheelStream(page, { x: p.x, y: p.y, deltaY: 40, count: 60, intervalMs: 8 });
  await H.wheelStream(page, { x: p.x, y: p.y, deltaY: -40, count: 60, intervalMs: 8 });
  await H.sleep(500);
  const runB = await stopProbe(page);
  const sc = runB.events.filter((e) => e.type === 'scroll');
  const t0 = runB.events[0]?.t ?? 0, t1 = sc.length ? sc[sc.length - 1].t : t0;
  const fr = runB.frames.filter((f) => f.t >= t0 && f.t <= t1 + 30);
  let upd = 0; for (let i = 1; i < fr.length; i++) if (fr[i].f !== fr[i - 1].f) upd++;
  const lastChange = [...runB.frames].reverse().find((f, i, a) => i + 1 < a.length && f.f !== a[i + 1].f);
  const tr = await sess.traced('scroll', async () => { await H.wheelStream(page, { x: p.x, y: p.y, deltaY: 40, count: 60, intervalMs: 8 }); await H.wheelStream(page, { x: p.x, y: p.y, deltaY: -40, count: 60, intervalMs: 8 }); await H.sleep(300); });
  // control: frozen renderer -> wheel moves the live list but the canvas region never changes
  await freezePaint(page, true);
  await startProbe(page, { selector: '#hic-surface', region, feature: 'none', events: ['wheel'], diffOn: ['wheel'], delta: 24, minFraction: 0.02 });
  await waitFrames(page, 8);
  for (let i = 0; i < 4; i++) { await page.wheel(p.x, p.y, 0, 100); await H.sleep(220); }
  const c = await stopProbe(page);
  await freezePaint(page, false);
  const out = { wheelLatencyMs: stat(lat), samples: lat.length, timedOut: lat.filter((v) => v === null).length, liveListMoved: moved, finalPixels: px,
    stream: { scrollEvents: sc.length, canvasUpdatesPerSecond: (t1 > t0) ? upd / ((t1 - t0 + 30) / 1000) : 0, sampledFramesPerSecond: (t1 > t0) ? fr.length / ((t1 - t0 + 30) / 1000) : 0, settleAfterLastScrollMs: lastChange ? Math.max(0, lastChange.t - t1) : null, blankFrames: runB.frames.filter((f) => f.alpha < 0.01 || f.content < 0.002).length, cadenceOk: inj.cadenceOk, startTop: sB0 },
    traced: { runTask: tr.runTask, paints: tr.paints, cpu: tr.cpu },
    control: { kind: 'frozen paint handler', ticks: c.diffs.length, changed: c.diffs.filter((x) => x.hitT !== null).length, fired: c.diffs.every((x) => x.hitT === null) } };
  console.log(`  scroll: wheel p50 ${out.wheelLatencyMs.p50} p95 ${out.wheelLatencyMs.p95} max ${out.wheelLatencyMs.max} timeouts ${out.timedOut}; pixels ${px.fraction} ok=${px.ok}; stream updates/s ${out.stream.canvasUpdatesPerSecond.toFixed(1)}, settle ${out.stream.settleAfterLastScrollMs?.toFixed?.(0)} ms, blank ${out.stream.blankFrames}; RunTask p95 ${tr.runTask.p95?.toFixed(2)} max ${tr.runTask.max?.toFixed(2)} >8.33=${tr.runTask.over8_33ms} busy ${tr.runTask.busyPct?.toFixed(1)}%; control ${out.control.fired}`);
  return out;
}
