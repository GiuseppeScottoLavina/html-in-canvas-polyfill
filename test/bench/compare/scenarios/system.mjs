// Metrics 5-10: real window resize drag, idle cost, first paint, memory, large-DOM update cost, bundle parse/compile + install.
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { H, pageUrl, refUrl, OUT_DIR } from '../lib/session.mjs';
import { startProbe, stopProbe, waitFrames } from '../lib/probe.mjs';
import { stat, canvasGeo, toRegion, compareRegion, readSurface, nonce } from '../lib/common.mjs';

// ------------------------------------------------------------------------------------------------------------- 5. real window resize (F3)
const RESIZE_SAMPLER = `(() => {
  const c = document.querySelector('#hic-surface'); const GW = 160, GH = 64;
  const sc = document.createElement('canvas'); sc.width = GW; sc.height = GH; const x = sc.getContext('2d', { willReadFrequently: true });
  const R = window.__rs = { frames: [], resize: [], running: true };
  const onR = () => R.resize.push([performance.now(), innerWidth]); addEventListener('resize', onR);
  const ch = new MessageChannel(); let ts = 0;
  ch.port1.onmessage = () => { if (!R.running) return; const a = performance.now(); let h = 2166136261, off = 0, al = 0;
    if (c.width && c.height) { x.clearRect(0, 0, GW, GH); x.drawImage(c, 0, 0, c.width, c.height, 0, 0, GW, GH); const d = x.getImageData(0, 0, GW, GH).data;
      for (let i = 0; i < d.length; i += 4) { h ^= (d[i] >> 2) | ((d[i+1] >> 2) << 6) | ((d[i+2] >> 2) << 12); h = Math.imul(h, 16777619); if (Math.abs(d[i] - d[0]) + Math.abs(d[i+1] - d[1]) + Math.abs(d[i+2] - d[2]) > 30) off++; al += d[i+3]; } off /= GW * GH; al /= GW * GH * 255; }
    const r = c.getBoundingClientRect();
    R.frames.push([ts, h >>> 0, off, al, c.width, Math.round(r.width * devicePixelRatio), performance.now() - a]); };
  const loop = (t) => { if (!R.running) return; ts = t; ch.port2.postMessage(0); requestAnimationFrame(loop); }; requestAnimationFrame(loop);
  R.stop = () => { R.running = false; removeEventListener('resize', onR); return { frames: R.frames, resize: R.resize }; };
  return true; })()`;

export async function runResize(sess, { drags = 30 } = {}) {
  const page = await sess.goto('f3');
  const W0 = 1400, W1 = 900, Hh = 880;
  await page.setInnerSize(W0, Hh); await H.sleep(500);
  await page.requireForeground('resize');
  const conv = [], blank = [], stale = []; let frames = 0, events = 0, cadence = [];
  await page.evaluate(RESIZE_SAMPLER);
  await H.sleep(300);
  for (let i = 0; i < drags; i++) {
    const to = { width: i % 2 ? W0 : W1, height: Hh };
    const fast = i % 3 === 2; // every third drag at 8 ms steps, the others at 16 ms
    const d = await H.dragResize(page, { to, steps: 12, intervalMs: fast ? 8 : 16, settleMs: 700 });
    cadence.push(d.injector.actual.p50);
    events += d.pageSaw.resizeEvents;
  }
  const rec = await page.evaluate('window.__rs.stop()');
  // per drag: the last resize event of the drag, then the first frame from which the canvas hash never changes until the next drag
  const F = rec.frames; frames = F.length;
  const ev = rec.resize;
  const groups = []; let g = [];
  for (let k = 0; k < ev.length; k++) { if (g.length && ev[k][0] - g[g.length - 1][0] > 350) { groups.push(g); g = []; } g.push(ev[k]); }
  if (g.length) groups.push(g);
  for (let gi = 0; gi < groups.length; gi++) {
    const tLast = groups[gi][groups[gi].length - 1][0], tStart = groups[gi][0][0];
    const tNext = gi + 1 < groups.length ? groups[gi + 1][0][0] : Infinity;
    const win = F.filter((f) => f[0] >= tStart - 1 && f[0] < tNext - 12); // the frame that carries the next resize event starts BEFORE it (rAF time = frame start)
    const after = win.filter((f) => f[0] >= tLast);
    if (after.length < 5) continue;
    const fin = after[after.length - 1][1];
    let ci = after.length - 1; while (ci > 0 && after[ci - 1][1] === fin) ci--;
    conv.push(after[ci][0] - tLast);
    blank.push(win.filter((f) => f[3] < 0.01 || f[2] < 0.01 || f[4] === 0).length);
    stale.push(win.filter((f) => Math.abs(f[4] - f[5]) > 1).length);
  }
  // final pixels at the last size vs the twin
  const surf = await readSurface(page, '#hic-surface');
  const geo = await canvasGeo(page, '#hic-surface');
  const twinW = (await page.viewport()).innerWidth;
  const ref = await sess.browser.newPage({ reuseFirst: false });
  let px;
  try {
    await ref.navigate(refUrl(sess.srv, 'f3'));
    await ref.bringToFront(); await ref.setInnerSize(twinW, Hh); await ref.requireForeground('resize ref');
    await ref.waitForFunction('!!(window.__HIC_FIXTURE && window.__HIC_FIXTURE.ready)'); await H.sleep(300);
    const t = await H.screenshotElement(ref, '#hic-surface');
    px = compareRegion(surf, t.img, { x: 0, y: 0, w: Math.min(surf.width, t.img.width), h: Math.min(surf.height, t.img.height) });
    px.ok = px.fraction <= 0.03;
  } finally { await ref.close(); await page.bringToFront(); await page.requireForeground('after resize ref'); }
  const tr = await sess.traced('resize', async () => { for (let i = 0; i < 4; i++) await H.dragResize(page, { to: { width: i % 2 ? W0 : W1, height: Hh }, steps: 12, intervalMs: 16, settleMs: 400 }); });
  const out = { drags: groups.length, convergenceMs: stat(conv), blankFrames: blank.reduce((a, b) => a + b, 0), blankFramesPerDrag: stat(blank), framesWithStaleBacking: stale.reduce((a, b) => a + b, 0), sampledFrames: frames, resizeEvents: events,
    finalPixels: px, injectorStepMsP50: stat(cadence).p50, canvasBacking: [geo.bw, geo.bh], traced: { runTask: tr.runTask, paints: tr.paints, cpu: tr.cpu } };
  console.log(`  resize: ${out.drags} drags, conv p50 ${out.convergenceMs.p50} p95 ${out.convergenceMs.p95} max ${out.convergenceMs.max} ms, blank ${out.blankFrames}/${frames}, final px ${px.fraction} ok=${px.ok}; RunTask p95 ${tr.runTask.p95?.toFixed(2)} max ${tr.runTask.max?.toFixed(2)} >8.33=${tr.runTask.over8_33ms} busy ${tr.runTask.busyPct?.toFixed(1)}%`);
  await page.setInnerSize(1400, 880);
  return out;
}

// ------------------------------------------------------------------------------------------------------------------------- 6. idle cost
export async function runIdle(sess, { seconds = 30 } = {}) {
  const page = await sess.goto('f1');
  const geo = await canvasGeo(page, '#hic-surface');
  const out = {};
  for (const mode of ['nothing-focused', 'input-focused']) {
    await page.requireForeground('idle');
    if (mode === 'input-focused') {
      const r = await page.evaluate('(() => { const c = document.querySelector("#hic-surface").getBoundingClientRect(); const e = document.getElementById("name").getBoundingClientRect(); return { x: e.left - c.left, y: e.top - c.top, width: e.width, height: e.height }; })()');
      await page.click(geo.x + r.x + r.width / 2, geo.y + r.y + r.height / 2);
      // blink check (correctness): the drawn field region shows >= 2 states over 2 s
      await startProbe(page, { selector: '#hic-surface', region: toRegion(r, geo), feature: 'hash' });
      await H.sleep(2200);
      const b = await stopProbe(page);
      out.caretStates = new Set(b.frames.map((f) => f.f)).size;
    } else { await page.evaluate('document.activeElement && document.activeElement.blur()'); }
    await H.sleep(1500);
    const per = [];
    let prev = await sess.procCpu(); let tPrev = performance.now();
    for (let i = 0; i < seconds; i++) {
      await H.sleep(1000);
      const now = await sess.procCpu(); const t = performance.now();
      const d = {}; for (const x of now) { const p = prev.find((y) => y.id === x.id); d[x.type] = (d[x.type] ?? 0) + (x.cpu - (p ? p.cpu : 0)); }
      per.push({ renderer: 100 * (d.renderer ?? 0) / ((t - tPrev) / 1000), gpu: 100 * (d.GPU ?? 0) / ((t - tPrev) / 1000) });
      prev = now; tPrev = t;
    }
    const tr = await sess.traced(`idle-${mode}`, () => H.sleep(10000));
    out[mode] = { rendererCpuPct: stat(per.map((x) => x.renderer)), gpuCpuPct: stat(per.map((x) => x.gpu)), runTaskPerSecond: tr.runTask.tasksPerSecond, busyPct: tr.runTask.busyPct, runTask: tr.runTask, paintsPerSecond: tr.paints.perSecond, cpu: tr.cpu };
    console.log(`  idle ${mode}: renderer CPU p50 ${out[mode].rendererCpuPct.p50}% p95 ${out[mode].rendererCpuPct.p95}%, GPU p50 ${out[mode].gpuCpuPct.p50}%, RunTask/s ${tr.runTask.tasksPerSecond?.toFixed(1)}, busy ${tr.runTask.busyPct?.toFixed(2)}%, paints/s ${tr.paints.perSecond.toFixed(2)}${mode === 'input-focused' ? ', caret states ' + out.caretStates : ''}`);
  }
  out.correct = { caretBlinks: out.caretStates >= 2 };
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------- 7. first paint
const FIRST_PAINT_SAMPLER = `(() => { const R = window.__fp = { frames: [] }; const GW = 64, GH = 40; let sc, x;
  const tick = (ts) => { const c = document.querySelector('canvas'); if (c && c.width && c.height) { if (!sc) { sc = document.createElement('canvas'); sc.width = GW; sc.height = GH; x = sc.getContext('2d', { willReadFrequently: true }); }
      x.clearRect(0, 0, GW, GH); x.drawImage(c, 0, 0, c.width, c.height, 0, 0, GW, GH); const d = x.getImageData(0, 0, GW, GH).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 100) n++;
      R.frames.push([ts, n / (GW * GH)]); } else R.frames.push([ts, 0]);
    if (ts < 4000) requestAnimationFrame(tick); };
  requestAnimationFrame(tick); })();`;

export async function runFirstPaint(sess, { samples = 30, pages = ['explainer', 'f1'] } = {}) {
  const out = {};
  for (const fx of pages) {
    const res = { cold: [], warm: [] };
    for (const kind of ['cold', 'warm']) {
      for (let i = 0; i < samples; i++) {
        let page = sess.page;
        if (kind === 'cold') {
          // new tab = new renderer process for the origin (the old one is closed first); HTTP cache cleared (the server sends no-store anyway)
          const old = sess.page; await old.navigate('about:blank');
          page = await sess.browser.newPage({ reuseFirst: false }); await old.close(); sess.browser.pages = sess.browser.pages.filter((p) => p !== old); sess.page = page;
          await page.send('Network.enable'); await page.send('Network.clearBrowserCache'); await page.send('Network.disable');
          await page.setInnerSize(1400, 880);
        }
        await page.requireForeground('first paint');
        const { identifier } = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: FIRST_PAINT_SAMPLER });
        await page.navigate(pageUrl(sess.srv, sess.subject, fx));
        await H.sleep(2200);
        const fr = await page.evaluate('window.__fp ? window.__fp.frames : []');
        await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
        const nav = await page.evaluate('(() => { const n = performance.getEntriesByType("navigation")[0]; return { dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd }; })()');
        const final = fr.length ? fr[fr.length - 1][1] : 0;
        const hit = final > 0.02 ? fr.find((f) => f[1] >= 0.9 * final) : null;
        res[kind].push({ ms: hit ? hit[0] : null, final, dcl: nav.dcl });
        if (kind === 'warm') await page.navigate('about:blank');
      }
    }
    out[fx] = { coldMs: stat(res.cold.map((x) => x.ms)), warmMs: stat(res.warm.map((x) => x.ms)), coldNoContent: res.cold.filter((x) => x.ms === null).length, warmNoContent: res.warm.filter((x) => x.ms === null).length,
      domContentLoadedMs: stat(res.warm.map((x) => x.dcl)), finalCoverage: stat(res.warm.map((x) => x.final)).p50 };
    console.log(`  first paint ${fx}: cold p50 ${out[fx].coldMs.p50} p95 ${out[fx].coldMs.p95}; warm p50 ${out[fx].warmMs.p50} p95 ${out[fx].warmMs.p95} ms (rAF time of the first frame with >= 90 % of the final canvas coverage; no content: ${out[fx].coldNoContent}/${out[fx].warmNoContent})`);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------------------- 8. memory
export async function runMemory(sess, { samples = 30 } = {}) {
  const out = {};
  for (const [name, fx, params] of [['f1', 'f1', {}], ['f4-1000', 'f4', { nodes: 1000 }]]) {
    const page = await sess.goto(fx, params);
    await H.sleep(2500);
    const heap = [], rss = [], gpu = [], dom = [];
    for (let i = 0; i < samples; i++) {
      const h = await page.heapUsage(); heap.push(h.usedSize / 1048576);
      const r = sess.rss(); rss.push(r.rendererMaxKB / 1024); gpu.push(r.gpuKB / 1024);
      if (i === 0) { try { dom.push(await page.domCounters()); } catch { /* optional */ } }
      await H.sleep(300);
    }
    const gc = await page.heapUsage({ gc: true });
    out[name] = { jsHeapMB: stat(heap), jsHeapAfterGcMB: +(gc.usedSize / 1048576).toFixed(2), rendererRssMB: stat(rss), gpuRssMB: stat(gpu), domCounters: dom[0] ?? null };
    console.log(`  memory ${name}: heap p50 ${out[name].jsHeapMB.p50} MB (after GC ${out[name].jsHeapAfterGcMB}), renderer RSS p50 ${out[name].rendererRssMB.p50} MB, GPU RSS p50 ${out[name].gpuRssMB.p50} MB, DOM nodes ${dom[0]?.nodes}`);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------------- 9. large DOM (F4)
export async function runLargeDom(sess, { sizes = [200, 500, 1000, 2000], updates = 30 } = {}) {
  const out = {};
  for (const n of sizes) {
    const page = await sess.goto('f4', { nodes: n });
    await H.sleep(800);
    await page.requireForeground('large dom');
    const r = await page.evaluate('(() => { const c = document.querySelector("#hic-surface").getBoundingClientRect(); const e = document.querySelector("#root header h1").getBoundingClientRect(); return { x: e.left - c.left, y: e.top - c.top, width: e.width, height: e.height }; })()');
    const geo = await canvasGeo(page, '#hic-surface');
    const region = toRegion(r, geo);
    const mutate = (txt) => page.evaluate(`(() => { window.__cmp.mark('m'); document.querySelector('#root header h1').textContent = ${JSON.stringify(txt)}; return true; })()`);
    await startProbe(page, { selector: '#hic-surface', region, feature: 'none', delta: 24, minFraction: 0.003 });
    await waitFrames(page, 8);
    const texts = [];
    for (let i = 0; i < updates; i++) { const t = `F4 ${n} · ${nonce(6)} ${i}`; texts.push(t); await mutate(t); await H.sleep(160); }
    await H.sleep(300);
    const run = await stopProbe(page);
    const lat = run.diffs.map((x) => (x.hitT === null ? null : x.hitT - x.t));
    // correctness: the last text is what the canvas shows (twin with the same text)
    const surf = await readSurface(page, '#hic-surface');
    const twin = await sess.refShot('f4', '#hic-surface', `document.querySelector('#root header h1').textContent = ${JSON.stringify(texts[texts.length - 1])}`, { nodes: n });
    const px = compareRegion(surf, twin.img, toRegion({ x: r.x - 4, y: r.y - 4, width: r.width + 8, height: r.height + 8 }, geo));
    px.ok = px.fraction <= 0.03;
    // traced: same mutations (marks are harmless without the probe: guarded)
    const tr = await sess.traced(`f4-${n}`, async () => { for (let i = 0; i < updates; i++) { await page.evaluate(`document.querySelector('#root header h1').textContent = ${JSON.stringify(`F4 ${n} · ${nonce(6)} t${i}`)}`); await H.sleep(160); } await H.sleep(200); });
    const idleMsPerS = await sess.traced(`f4-${n}-idle`, () => H.sleep(2000));
    const perUpdateMs = (tr.runTask.totalMs - (idleMsPerS.runTask.totalMs / idleMsPerS.spanMs) * tr.spanMs) / updates;
    out[n] = { latencyMs: stat(lat), samples: lat.length, timedOut: lat.filter((v) => v === null).length, finalPixels: px, mainThreadMsPerUpdate: +perUpdateMs.toFixed(2), runTask: tr.runTask, cpu: tr.cpu, paints: tr.paints };
    console.log(`  large DOM ${n}: update->pixel p50 ${out[n].latencyMs.p50} p95 ${out[n].latencyMs.p95} max ${out[n].latencyMs.max} (timeouts ${out[n].timedOut}); main thread ${out[n].mainThreadMsPerUpdate} ms/update; RunTask p95 ${tr.runTask.p95?.toFixed(2)} max ${tr.runTask.max?.toFixed(2)} >8.33=${tr.runTask.over8_33ms}; px ${px.fraction} ok=${px.ok}`);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------- 10. bundle parse/compile + install
const BUNDLE_PAGE = (bundle) => `<!doctype html><meta charset="utf-8"><title>bundle cost</title>
<script>window.__t0 = performance.now();</script>
${bundle ? `<script src="${bundle}"></script>` : ''}
<script>window.__t1 = performance.now();</script>
<canvas id="c" content="drawable" width="200" height="100"><div drawable id="d" style="width:100px;height:40px">bundle check</div></canvas>
<script>window.__t2 = performance.now(); const c = document.getElementById('c'); c.onpaint = () => { if (!window.__t3) window.__t3 = performance.now(); c.getContext('2d').drawElementImage(document.getElementById('d'), 0, 0); }; c.requestPaint && c.requestPaint();</script>`;

export async function runBundle(sess, { samples = 30 } = {}) {
  const dir = resolve(OUT_DIR, 'pages'); mkdirSync(dir, { recursive: true });
  const bundle = sess.subject.bundle;
  const file = resolve(dir, `bundle-${sess.subject.id}.html`); writeFileSync(file, BUNDLE_PAGE(bundle));
  // serve through the harness server's `files` map is fixed at start: use a data-free route instead (a second server with the page)
  const srv = await H.startServer({ files: { '/bench/bundle.html': file, ...(sess.subject.id === 'competitor' ? { [bundle]: resolve(H.PROJECT_ROOT, '.scratch/competitor/competitor-adapted.iife.js') } : {}) } });
  const page = sess.page; const rows = [];
  try {
    for (let i = 0; i < samples; i++) {
      await page.navigate(new URL('/bench/bundle.html', srv.url).href);
      await H.sleep(250);
      rows.push(await page.evaluate(`(() => { const e = ${JSON.stringify(bundle)} ? performance.getEntriesByType('resource').find((r) => r.name.includes(${JSON.stringify(bundle ?? '###')})) : null;
        const fetchMs = e ? e.responseEnd - e.startTime : 0; return { scriptBlockMs: window.__t1 - window.__t0, fetchMs, execMs: (window.__t1 - window.__t0) - fetchMs, firstPaintEventMs: window.__t3 ? window.__t3 - window.__t0 : null, bytes: e ? e.decodedBodySize : 0 }; })()`));
    }
    // one traced load for the V8 breakdown (compile vs run)
    const f = resolve(OUT_DIR, 'traces', `bundle-${sess.subject.id}.json`); mkdirSync(resolve(OUT_DIR, 'traces'), { recursive: true });
    await sess.browser.traceStart();
    await page.navigate(new URL('/bench/bundle.html', srv.url).href); await H.sleep(400);
    await sess.browser.traceStop(f);
    const ev = H.loadTraceEvents(f);
    const sum = (re) => ev.filter((e) => e.ph === 'X' && re.test(e.name) && (!bundle || JSON.stringify(e.args ?? {}).includes(bundle.split('/').pop()))).reduce((a, e) => a + e.dur / 1000, 0);
    const v8 = { compileMs: +sum(/^v8\.compile$|^V8\.CompileCode|^v8\.parseOnBackground|^V8\.ScriptCompiler/).toFixed(2), evaluateScriptMs: +sum(/^EvaluateScript$|^v8\.run$/).toFixed(2) };
    const out = { bytes: rows[0].bytes, execMs: stat(rows.map((r) => r.execMs)), fetchMs: stat(rows.map((r) => r.fetchMs)), firstPaintEventMs: stat(rows.map((r) => r.firstPaintEventMs)), v8Trace: v8 };
    console.log(`  bundle: ${out.bytes} B, parse+compile+install p50 ${out.execMs.p50} p95 ${out.execMs.p95} max ${out.execMs.max} ms (fetch p50 ${out.fetchMs.p50}); first paint event after script start p50 ${out.firstPaintEventMs.p50} ms; trace ${JSON.stringify(v8)}`);
    return out;
  } finally { await srv.close(); }
}
