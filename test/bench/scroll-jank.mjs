// REPORTED DATA, no thresholds: scroll jank of drawn scrollers under trusted wheel and touch streams, at several CPU throttling rates.
//   node test/bench/scroll-jank.mjs [--cases=a,b] [--rates=1,4,6] [--inputs=wheel,touch] [--reps=N] [--bundle=/dist/...] [--headless] [--out=file] [--profile]
// Per case x rate x input, in a fresh tab: a stream of three gestures with pauses between them (the pauses let the settle tile, the plan and the page builds run, as
// they do between a user's gestures). Measured in the page, per rAF frame: the live scroller's offset and the count of canvas paint events.
//   moveGaps   intervals between consecutive offset changes of the live scroller during a gesture longer than 2 frame intervals (the native scroll stalled)
//   paintGaps  frames in which the scroller moved and the canvas has not been repainted for more than 2 frame intervals (the drawn scroller stuttered)
//   rafGaps    rAF intervals longer than 2 frame intervals during the gestures (a main-thread frame dropped)
// Chrome trace: RunTask > 8.33 / > 16.7 ms on the renderer main thread between marks; each long task attributed by trace slice names and, with --profile, by the
// CPU profile samples inside it (self time per function). Snapshot stats: scroll compositor counters (composed vs fallback steps). Correctness: the settled
// canvas is non-blank. CPU throttling (Emulation.setCPUThrottlingRate) approximates a slower device; it slows the renderer main thread only, not the GPU or raster.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as H from '../harness/index.mjs';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const BUNDLE = arg('bundle', '/dist/hic-live-polyfill.iife.js');
const RATES = arg('rates', '1,4,6').split(',').map(Number);
const INPUTS = arg('inputs', 'wheel,touch').split(',');
const REPS = Number(arg('reps', '1'));
const HEADLESS = process.argv.includes('--headless');
const PROFILE = process.argv.includes('--profile');

const SC = '/test/gates/fixtures/scroll-cadence.html';
/** page path, query, the drawn scroller, a script run before the measurement (refused-scroller variants) */
const CASES = {
  plain: { path: SC, q: { rows: 300 }, scroller: '#list' },
  rounded: { path: SC, q: { rows: 300, round: 1 }, scroller: '#list' },
  hover: { path: SC, q: { rows: 300, hover: 1 }, scroller: '#list' },
  long: { path: SC, q: { rows: 2000 }, scroller: '#list' },
  // refused by the compositor's plan: a canvas inside the list (UNSAFE_TAGS), horizontal overflow
  'refused-canvas': { path: SC, q: { rows: 300 }, scroller: '#list', prep: `(() => { const c = document.createElement('canvas'); c.width = 30; c.height = 10; document.querySelector('#rows li:nth-child(3)').append(c); })()` },
  'refused-hscroll': { path: SC, q: { rows: 300 }, scroller: '#list', prep: `(() => { document.querySelector('#rows li:nth-child(3) span').style.cssText = 'white-space:nowrap;min-width:900px'; })()` },
  f2: { path: '/test/fixtures/f2-scroll/index.html', q: { mode: 'poly' }, scroller: '#list', fixture: true },
  'ex-scroll-and-resize': { path: '/examples/scroll-and-resize/index.html', q: {}, scroller: '#inbox', example: true },
  'ex-plugins': { path: '/examples/plugins/index.html', q: {}, scroller: '#demo-form', example: true },
};
const ONLY = arg('cases', '')?.split(',').filter(Boolean);

/** in-page recorder: per rAF frame [t, scrollTop, paints] and the snapshot scroll stats */
const RECORDER = (sel) => `(() => {
  const s = document.querySelector(${JSON.stringify(sel)});
  const R = window.__jank = { on: false, frames: [], paints: 0 };
  addEventListener('paint', () => { R.paints++; }, true);
  R.start = () => { R.on = true; R.frames = []; const f = (t) => { if (!R.on) return; R.frames.push([t, s.scrollTop, R.paints]); requestAnimationFrame(f); }; requestAnimationFrame(f); };
  R.stop = () => { R.on = false; return R.frames; };
  return !!s;
})()`;
const STATS = `(() => { const c = window.__HIC__?.installed?.report?.().canvases ?? []; return c.map((x) => x.stats?.snapshot?.scroll ?? null); })()`;

/** frame metrics of the recorded frames [t, scrollTop, paints] inside the gesture windows [t0, t1] (performance.now) */
function frameMetrics(frames, windows) {
  const dts = []; for (let i = 1; i < frames.length; i++) dts.push(frames[i][0] - frames[i - 1][0]);
  const iv = H.stats(dts).p50 || 8.33;
  const lim = 2.5 * iv;
  let moves = 0, moveGaps = 0, paintGaps = 0, rafGaps = 0, maxMoveGap = 0, maxPaintGap = 0, maxRaf = 0, unpainted = 0;
  const startLag = [];
  for (const [w0, w1] of windows) {
    const idx = []; for (let i = 1; i < frames.length; i++) if (frames[i][0] >= w0 && frames[i][0] <= w1) idx.push(i);
    const mv = idx.filter((i) => frames[i][1] !== frames[i - 1][1]);
    if (!mv.length) continue;
    moves += mv.length;
    const first = mv[0], last = mv[mv.length - 1];
    for (let k = 1; k < mv.length; k++) { const d = frames[mv[k]][0] - frames[mv[k - 1]][0]; if (d > lim) { moveGaps++; maxMoveGap = Math.max(maxMoveGap, d); } }
    for (let i = first + 1; i <= last; i++) { const d = frames[i][0] - frames[i - 1][0]; maxRaf = Math.max(maxRaf, d); if (d > lim) rafGaps++; }
    // a move in frame m is painted in that frame and counted in the row m + 1
    const painted = (m) => m + 1 < frames.length && frames[m + 1][2] > frames[m][2];
    for (const m of mv) if (!painted(m)) unpainted++;
    // canvas update gaps: between consecutive paints (from the first move to one frame after the last), a gap longer than 2.5 frames over an unpainted move
    const pi = []; for (let i = first + 1; i <= Math.min(frames.length - 1, last + 1); i++) if (frames[i][2] > frames[i - 1][2]) pi.push(i);
    let a = first;
    for (const b of [...pi, Math.min(frames.length - 1, last + 1)]) {
      const d = frames[b][0] - frames[a][0];
      if (d > lim && mv.some((m) => m >= a && m <= b - 1 && !painted(m))) { paintGaps++; maxPaintGap = Math.max(maxPaintGap, d); }
      a = b;
    }
    startLag.push(+((pi.length ? frames[pi[0]][0] : frames[frames.length - 1][0]) - frames[first][0]).toFixed(1));
  }
  return { frameMs: +iv.toFixed(2), moves, moveGaps, maxMoveGap: +maxMoveGap.toFixed(1), paintGaps, maxPaintGap: +maxPaintGap.toFixed(1), unpainted, rafGaps, maxRaf: +maxRaf.toFixed(1), startLag };
}

/** self time per function of the CPU profile samples inside [t0, t1] (trace microseconds) */
function profileSlice(profile, t0, t1) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const agg = new Map();
  let t = profile.startTime;
  for (let i = 0; i < profile.samples.length; i++) {
    t += Math.max(0, profile.timeDeltas[i] ?? 0);
    if (t < t0 || t > t1) continue;
    const cf = byId.get(profile.samples[i]).callFrame;
    const k = `${cf.functionName || '(anon)'}:${cf.url.split('/').pop()}:${cf.lineNumber + 1}`;
    agg.set(k, (agg.get(k) ?? 0) + 1);
  }
  return [...agg].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k} x${n}`);
}

/** inclusive attribution: per long task, the polyfill functions on the stack of its samples (one count per sample) */
function profileStacks(profile, t0, t1, match = /hic-live|src\//) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map(); for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const agg = new Map(); let t = profile.startTime, n = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    t += Math.max(0, profile.timeDeltas[i] ?? 0);
    if (t < t0 || t > t1) continue;
    n++;
    const seen = new Set();
    for (let id = profile.samples[i]; id !== undefined; id = parent.get(id)) {
      const cf = byId.get(id).callFrame; if (!match.test(cf.url) || !cf.functionName) continue;
      const k = `${cf.functionName}:${cf.lineNumber + 1}`; if (seen.has(k)) continue; seen.add(k); agg.set(k, (agg.get(k) ?? 0) + 1);
    }
  }
  return { samples: n, top: [...agg].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, c]) => `${k} ${Math.round((100 * c) / Math.max(1, n))}%`) };
}

async function gesture(page, input, at, dir) {
  if (input === 'wheel') return H.wheelStream(page, { ...at, deltaY: 40 * dir, count: 40, intervalMs: 8 });
  // a touch drag of 500 css px at 1500 px/s with its fling (momentum), through the browser's synthetic gesture path (the compositor scrolls it like a finger)
  return page.send('Input.synthesizeScrollGesture', { x: Math.round(at.x), y: Math.round(at.y), yDistance: -500 * dir, speed: 1500, gestureSourceType: 'touch', preventFling: false });
}

const srv = await H.startServer();
const browser = await H.launchChrome({ name: 'scroll-jank', scrollbars: 'overlay', ...(HEADLESS ? { extraArgs: ['--headless=new'] } : {}) });
const out = { at: new Date().toISOString(), chrome: browser.version?.Browser, bundle: BUNDLE, headless: HEADLESS, pointerPark: browser.pointerPark, runs: [] };
const traceDir = resolve(H.PROJECT_ROOT, '.scratch/results/traces'); mkdirSync(traceDir, { recursive: true });
try {
  const page = await browser.newPage();
  await page.setInnerSize(1400, 880);
  // the examples load the minified bundles: they get the readable ones (function names in the CPU profile), and the core bundle under test
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*.iife.min.js' }] });
  page.on('Fetch.requestPaused', (ev) => {
    const u = new URL(ev.request.url);
    const to = u.pathname === '/dist/hic-live-polyfill.iife.min.js' ? BUNDLE : u.pathname.replace(/\.min\.js$/, '.js');
    page.send('Fetch.continueRequest', { requestId: ev.requestId, url: new URL(to, u).href }).catch(() => {});
  });
  for (let rep = 0; rep < REPS; rep++) for (const [name, c] of Object.entries(CASES)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    for (const rate of RATES) for (const input of INPUTS) {
      const u = new URL(c.path, srv.url);
      for (const [k, v] of Object.entries(c.q)) u.searchParams.set(k, String(v));
      if (!c.example) u.searchParams.set('bundle', BUNDLE);
      page.clearLogs();
      await page.navigate(u.href);
      await page.ensureForeground().catch(() => {});
      if (c.fixture) await page.waitForFunction('window.__HIC_FIXTURE?.ready', { timeout: 20000 });
      await page.waitForFunction(`document.querySelector(${JSON.stringify(c.scroller)}) && (window.__HIC__?.installed?.report?.().canvases?.length ?? 0) > 0`, { timeout: 20000 });
      if (c.prep) await page.evaluate(c.prep);
      await H.sleep(1200);
      if (!(await page.evaluate(RECORDER(c.scroller)))) throw new Error(`${name}: no scroller`);
      // a scroller below the fold is brought into view first (a page scroll, as a user would)
      await page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(c.scroller)}); const r = e.getBoundingClientRect(); if (r.bottom > innerHeight || r.top < 0) e.scrollIntoView({ block: 'center' }); })()`);
      await H.sleep(300);
      const r = await page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(c.scroller)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 200), w: innerWidth, h: innerHeight }; })()`);
      if (r.y > r.h - 20) throw new Error(`${name}: scroller below the viewport`);
      const at = { x: r.x, y: r.y };
      await page.mouseMove(at.x - 30, at.y); await page.mouseMove(at.x, at.y);
      await H.sleep(700);
      await page.send('Emulation.setCPUThrottlingRate', { rate });
      const sc0 = await page.evaluate(STATS);
      const load = H.loadSnapshot({ ownPids: [browser.pid, process.pid] });
      await browser.traceStart();
      if (PROFILE) await page.cpuProfileStart({ intervalUs: 250 });
      const p0 = await page.evaluate('performance.mark("m0"); window.__jank.start(); performance.now()');
      const windows = [];
      for (const dir of [1, 1, -1]) {
        const a = await page.evaluate('performance.now()');
        await gesture(page, input, at, dir);
        await H.sleep(input === 'touch' ? 700 : 150);
        windows.push([a, await page.evaluate('performance.now()')]);
        await H.sleep(350);
      }
      await page.evaluate('performance.mark("m1")');
      const frames = await page.evaluate('window.__jank.stop()');
      const profile = PROFILE ? await page.cpuProfileStop() : null;
      const file = resolve(traceDir, `jank-${name}-${input}-${rate}x-${Date.now()}.json`);
      await browser.traceStop(file);
      await page.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      const sc1 = await page.evaluate(STATS);
      await H.sleep(500);
      const canvasSel = await page.evaluate(`(() => { const c = document.querySelector('canvas[content="drawable"], canvas[layoutsubtree]'); if (!c) return null; if (!c.id) c.id = '__jank_canvas'; return '#' + c.id; })()`);
      let nonBlank = null;
      try { nonBlank = canvasSel ? H.pixelStats(await H.readCanvas(page, canvasSel)).nonBlank : null; } catch { nonBlank = 'unreadable'; }
      const rep_ = H.analyzeTrace(file, { windowMarks: ['m0', 'm1'], thresholdMs: H.FRAME_120, top: 3 });
      const evs = PROFILE ? H.loadTraceEvents(file) : null;
      const m0 = evs?.find((e) => e.name === 'm0' && ['R', 'I', 'i', 'b', 'n'].includes(e.ph));
      const startTs = m0?.ts ?? 0;
      const sDelta = sc0.map((a, i) => (a && sc1[i] ? Object.fromEntries(Object.entries(sc1[i]).filter(([, v]) => typeof v === 'number').map(([k, v]) => [k, v - (a[k] ?? 0)])) : null));
      const fm = frameMetrics(frames, windows);
      const inGesture = (l) => windows.some(([a, b]) => p0 + l.tsMs + l.durMs >= a && p0 + l.tsMs <= b);
      const long = (rep_.longFrames ?? []).map((l) => ({ at: +l.tsMs.toFixed(1), ms: +l.durMs.toFixed(1), gesture: inGesture(l), slices: l.topEvents.slice(0, 4).map(([n, d]) => `${n} ${d}`),
        ...(profile ? { js: profileSlice(profile, startTs + l.tsMs * 1000, startTs + (l.tsMs + l.durMs) * 1000), ours: profileStacks(profile, startTs + l.tsMs * 1000, startTs + (l.tsMs + l.durMs) * 1000).top } : {}) }));
      const run = { name, rate, input, rep, ...fm, runTask: rep_.runTask, long, scroll: sDelta, nonBlank, errors: page.errors({ includeWarnings: false }).slice(0, 3).map((e) => e.text ?? String(e)),
        highLoad: load.highLoad, trace: file, ...(profile ? { ours: profileStacks(profile, startTs, startTs + 1e12).top } : {}) };
      out.runs.push(run);
      const rt = run.runTask ?? {};
      run.longInGesture = { over8_33: long.filter((l) => l.gesture).length, over16_7: long.filter((l) => l.gesture && l.ms > 16.7).length };
      console.log(`${name.padEnd(20)} ${input.padEnd(5)} ${rate}x  moves ${String(fm.moves).padStart(3)} moveGaps ${fm.moveGaps} (max ${fm.maxMoveGap}) paintGaps ${fm.paintGaps} (max ${fm.maxPaintGap}) unpainted ${fm.unpainted} rafGaps ${fm.rafGaps} lag ${fm.startLag.join('/')} | RunTask>8.33 ${rt.over8_33ms} >16.7 ${rt.over16_7ms} (in gestures ${run.longInGesture.over8_33}/${run.longInGesture.over16_7}) max ${rt.max?.toFixed?.(1)} | ${sDelta[0] ? `composed ${sDelta[0].composed} fallbacks ${sDelta[0].fallbacks} plans ${sDelta[0].plans} refusals ${sDelta[0].refusals} pages ${sDelta[0].pages}` : 'no stats'} nonBlank ${nonBlank}${load.highLoad ? ' HIGHLOAD' : ''}`);
      for (const l of long.filter((x) => x.gesture).sort((x, y) => y.ms - x.ms).slice(0, 4)) console.log(`    ${l.ms}ms @${l.at}: ${l.slices.join(', ')}${l.ours ? ' | ' + l.ours.slice(0, 5).join(', ') : ''}`);
    }
  }
} catch (e) { out.error = String(e.stack || e); console.error(out.error); }
finally { await browser.close(); await srv.close(); }
const file = arg('out', resolve(H.PROJECT_ROOT, `.scratch/results/scroll-jank-${out.at.replace(/[:.]/g, '-')}.json`));
mkdirSync(resolve(file, '..'), { recursive: true });
writeFileSync(file, JSON.stringify(out) + '\n');
console.log(out.error ? 'error' : 'ok', file);
