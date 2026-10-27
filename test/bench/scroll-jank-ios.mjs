// REPORTED DATA, no thresholds: scroll jank of a drawn inner scroller in Mobile Safari on the iOS SIMULATOR (safaridriver). The simulator runs on the Mac's CPU and GPU:
// it is not a phone (recent iPhones have a similar single-core speed, older ones are slower; raster and compositing differ), so the numbers show WebKit's code paths
// and their relative costs, not a device's frame times.
//   node test/bench/scroll-jank-ios.mjs [--udid=...] [--pages=mobile,inbox] [--modes=script,drag] [--load=MS] [--reps=N] [--core=path] [--out=file]
// Modes: oracle  jumps of the scroller: the first canvas paint after each (composed when the compositor serves it) vs the settled canvas at that offset;
//        script  a momentum-like scroll driven from requestAnimationFrame (scrollTop += v, v decaying), no OS input;
//        drag    a real flick: an OS mouse drag over the Simulator window (test/bench/sim-pointer.py, Quartz) that the Simulator turns into a touch with momentum.
//                It moves the Mac's pointer: run it only on an unattended machine.
// --load=MS busy-waits MS ms in every animation frame (a crude stand-in for a slower CPU: it takes main-thread time, it does not slow the polyfill's own work).
// Metrics as test/bench/scroll-jank.mjs (rAF frames [t, scrollTop, paints]; canvas update gaps > 2.5 frame intervals while the scroller moves), plus the snapshot
// stats (clone / decode percentiles, tiles) of the run.
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { launchIosSimulator } from '../harness/lib/webdriver.mjs';
import { startServer } from '../harness/server.mjs';
import { PROJECT_ROOT, arg, sleep, stats } from '../harness/lib/util.mjs';

const UDID = arg('udid') ?? 'DFB90FE1-E3F4-451A-8369-3B50C67BD0A5';
const MODES = (arg('modes') ?? 'script').split(',');
const LOAD = Number(arg('load') ?? 0);
const REPS = Number(arg('reps') ?? 1);
const BUNDLE = arg('bundle') ?? ['/dist/hic-live-engines.iife.js', '/dist/hic-live-gpu.iife.js', '/dist/hic-live-polyfill.iife.js'].join(',');
const PAGES = {
  mobile: { path: '/test/fixtures/mobile/index.html', q: { mode: 'poly', bundle: BUNDLE }, scroller: '#list', fixture: true },
  inbox: { path: '/examples/scroll-and-resize/index.html', q: {}, scroller: '#inbox' },
};
const only = (arg('pages') ?? 'mobile,inbox').split(',');
const PY = resolve(PROJECT_ROOT, 'test/bench/sim-pointer.py');
const py = (...a) => { const r = spawnSync('python3', [PY, ...a.map(String)], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(`sim-pointer ${a[0]}: ${r.stderr}`); return r.stdout.trim(); };

const RECORDER = (sel, load) => `(() => {
  const s = document.querySelector(${JSON.stringify(sel)});
  const R = window.__jank = { on: false, frames: [], paints: 0, downs: [] };
  addEventListener('paint', () => { R.paints++; }, true);
  R.start = () => { R.on = true; R.frames = []; const f = (t) => { if (!R.on) return; if (${load} > 0) { const e = performance.now() + ${load}; while (performance.now() < e); } R.frames.push([t, s.scrollTop, R.paints]); requestAnimationFrame(f); }; requestAnimationFrame(f); };
  R.stop = () => { R.on = false; return R.frames; };
  R.script = (v0, dir) => new Promise((ok) => { let v = v0; const f = () => { s.scrollTop += v * dir; v *= 0.95; if (v < 0.5) return ok(performance.now()); requestAnimationFrame(f); }; requestAnimationFrame(f); });
  // oracle: the first canvas paint after a jump of the scroller (a composed frame when the compositor serves it) against the settled canvas at the same offset (the exact tile)
  R.oracle = async (offsets) => {
    const canvas = document.querySelector('canvas[content="drawable"], canvas[layoutsubtree]');
    const composed = () => window.__HIC__.installed.report().canvases[0].stats.snapshot.scroll?.composed ?? 0;
    const shots = [];
    const grab = () => { const c = new OffscreenCanvas(canvas.width, canvas.height); const x = c.getContext('2d'); x.drawImage(canvas, 0, 0); shots.push(c); return x.getImageData(0, 0, c.width, c.height).data; };
    R.shot = async (i) => { const b = await shots[i].convertToBlob({ type: 'image/png' }); return await new Promise((ok) => { const f = new FileReader(); f.onload = () => ok(f.result); f.readAsDataURL(b); }); };
    const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
    const out = [];
    for (const t of offsets) {
      await wait(700);
      const c0 = composed();
      const painted = new Promise((ok) => canvas.addEventListener('paint', () => ok(grab()), { once: true }));
      s.scrollTop = t;
      const a = await painted;
      const wasComposed = composed() > c0;
      await wait(700);
      const b = grab();
      let n = 0, ink = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (let i = 0; i < a.length; i += 4) {
        if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3])) > 16) {
          n++; const p = i / 4, x = p % canvas.width, y = (p - x) / canvas.width; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
        if (b[i + 3] > 0) ink++;
      }
      out.push({ t, live: s.scrollTop, composed: wasComposed, diff: +(n / (a.length / 4)).toFixed(5), ink: +(ink / (a.length / 4)).toFixed(3), ...(n ? { box: [x0, y0, x1, y1], size: [canvas.width, canvas.height] } : {}) });
    }
    return out;
  };
  R.calibrate = () => { const o = document.createElement('div'); o.id = '__cal'; o.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:transparent;touch-action:none';
    o.addEventListener('pointerdown', (e) => { R.downs.push([e.clientX, e.clientY]); e.preventDefault(); }); document.documentElement.append(o); };
  return !!s;
})()`;

/** as test/bench/scroll-jank.mjs frameMetrics */
function frameMetrics(frames, windows) {
  const dts = []; for (let i = 1; i < frames.length; i++) dts.push(frames[i][0] - frames[i - 1][0]);
  const iv = stats(dts).p50 || 16.7;
  const lim = 2.5 * iv;
  let moves = 0, moveGaps = 0, paintGaps = 0, rafGaps = 0, maxPaintGap = 0, maxRaf = 0, unpainted = 0;
  const startLag = [];
  let paintsIn = 0, spanIn = 0;
  for (const [w0, w1] of windows) {
    const idx = []; for (let i = 1; i < frames.length; i++) if (frames[i][0] >= w0 && frames[i][0] <= w1) idx.push(i);
    const mv = idx.filter((i) => frames[i][1] !== frames[i - 1][1]);
    if (!mv.length) continue;
    moves += mv.length;
    const first = mv[0], last = mv[mv.length - 1];
    for (let k = 1; k < mv.length; k++) if (frames[mv[k]][0] - frames[mv[k - 1]][0] > lim) moveGaps++;
    for (let i = first + 1; i <= last; i++) { const d = frames[i][0] - frames[i - 1][0]; maxRaf = Math.max(maxRaf, d); if (d > lim) rafGaps++; }
    const painted = (m) => m + 1 < frames.length && frames[m + 1][2] > frames[m][2];
    for (const m of mv) if (!painted(m)) unpainted++;
    const pi = []; for (let i = first + 1; i <= Math.min(frames.length - 1, last + 1); i++) if (frames[i][2] > frames[i - 1][2]) pi.push(i);
    let a = first;
    for (const b of [...pi, Math.min(frames.length - 1, last + 1)]) {
      const d = frames[b][0] - frames[a][0];
      if (d > lim && mv.some((m) => m >= a && m <= b - 1 && !painted(m))) { paintGaps++; maxPaintGap = Math.max(maxPaintGap, d); }
      a = b;
    }
    paintsIn += pi.length; spanIn += frames[Math.min(frames.length - 1, last + 1)][0] - frames[first][0];
    startLag.push(+((pi.length ? frames[pi[0]][0] : frames[frames.length - 1][0]) - frames[first][0]).toFixed(1));
  }
  return { frameMs: +iv.toFixed(2), moves, moveGaps, paintGaps, maxPaintGap: +maxPaintGap.toFixed(1), unpainted, paintHz: spanIn ? Math.round((1000 * paintsIn) / spanIn) : 0, rafGaps, maxRaf: +maxRaf.toFixed(1), startLag };
}

const STATS = `(() => { const c = window.__HIC__?.installed?.report?.().canvases?.[0]?.stats?.snapshot; return c ? { tiles: c.tiles, commits: c.commits, cloneMsP50: c.cloneMsP50, cloneMsP95: c.cloneMsP95, decodeMsP50: c.decodeMsP50, decodeMsP95: c.decodeMsP95, decodeMainMsP95: c.decodeMainMsP95, nodesLast: c.nodesLast, scroll: c.scroll } : null; })()`;

// --core=<path under the project>: the core bundle under test, served at the bundle paths of the pages (the examples load the minified one)
const CORE = arg('core');
const srv = await startServer(CORE ? { files: { '/dist/hic-live-polyfill.iife.js': resolve(PROJECT_ROOT, CORE), '/dist/hic-live-polyfill.iife.min.js': resolve(PROJECT_ROOT, CORE) } } : {});
const s = await launchIosSimulator({ udid: UDID });
const out = { at: new Date().toISOString(), udid: UDID, load: LOAD, core: CORE ?? null, bundle: BUNDLE, caps: { browserVersion: s.caps.browserVersion, platformVersion: s.caps.platformVersion }, runs: [] };
try {
  if (MODES.includes('drag')) spawnSync('open', ['-a', 'Simulator']);
  for (let rep = 0; rep < REPS; rep++) for (const [name, p] of Object.entries(PAGES)) {
    if (!only.includes(name)) continue;
    for (const mode of MODES) {
      const u = new URL(p.path, srv.url); u.searchParams.set('iso', '0'); for (const [k, v] of Object.entries(p.q)) u.searchParams.set(k, v);
      await s.navigate(u.href);
      await s.waitFor(`!!(window.__HIC__ && window.__HIC__.installed && window.__HIC__.installed.report().canvases.length)`, { timeoutMs: 20000 }).catch(async (e) => {
        throw new Error(`${e.message}; page: ${JSON.stringify(await s.evaluate('({ hic: window.__HIC__ ? { mode: window.__HIC__.installed?.mode, error: String(window.__HIC__.error?.message ?? "") } : null, fixture: window.__HIC_FIXTURE ? { ready: window.__HIC_FIXTURE.ready, fatal: window.__HIC_FIXTURE.fatal } : null, url: location.href })').catch((x) => String(x)))}`);
      });
      await sleep(1500);
      await s.evaluate(RECORDER(p.scroller, LOAD));
      let toScreen = null;
      if (mode === 'drag') {
        await sleep(800);
        spawnSync('open', ['-a', 'Simulator']);
        let b = null;
        for (let i = 0; i < 40 && !b; i++) { b = JSON.parse(py('bounds')); if (!b) await sleep(500); }
        if (!b) throw new Error(`no Simulator window on screen (${py('windows')})`);
        await s.evaluate('window.__jank.calibrate()');
        const pts = [[b.x + b.width * 0.35, b.y + b.height * 0.35], [b.x + b.width * 0.65, b.y + b.height * 0.6]];
        for (const [x, y] of pts) { py('click', x, y); await sleep(400); }
        const downs = await s.evaluate('(document.getElementById("__cal").remove(), window.__jank.downs)');
        if (downs.length < 2) throw new Error(`calibration: ${downs.length} touches reached the page`);
        const [[c1x, c1y], [c2x, c2y]] = downs.slice(-2);
        const kx = (pts[1][0] - pts[0][0]) / (c2x - c1x), ky = (pts[1][1] - pts[0][1]) / (c2y - c1y);
        toScreen = (x, y) => [pts[0][0] + (x - c1x) * kx, pts[0][1] + (y - c1y) * ky];
        out.calibration = { b, downs, kx, ky };
      }
      const sc = (name === 'mobile') ? await s.evaluate(`(() => { document.querySelector(${JSON.stringify(p.scroller)}).scrollIntoView({ block: 'center' }); return true; })()`) : null;
      void sc;
      await sleep(600);
      const st0 = await s.evaluate(STATS);
      const windows = [];
      await s.evaluate('window.__jank.start()');
      await sleep(300);
      if (mode === 'oracle') {
        await s.evaluate('window.__jank.stop()');
        const res = await s.evaluate('window.__jank.oracle([100, 130, 400, 437, 800, 851, 20, 61, 1203, 1170])', { timeoutMs: 60000 });
        const worst = Math.max(...res.map((x) => x.diff));
        out.runs.push({ name, mode, rep, oracle: res, worst });
        // --dump: the first composed frame that differs and its settled canvas, as PNG files next to the results
        const k = res.findIndex((x) => x.diff > 0);
        if (process.argv.includes('--dump') && k >= 0) for (const [j, tag] of [[2 * k, 'composed'], [2 * k + 1, 'settled']]) writeFileSync(resolve(PROJECT_ROOT, `.scratch/results/oracle-${name}-${tag}.png`), Buffer.from((await s.evaluate(`window.__jank.shot(${j})`)).split(',')[1], 'base64'));
        console.log(`${name.padEnd(8)} oracle composed ${res.filter((x) => x.composed).length}/${res.length} worst diff ${(worst * 100).toFixed(3)} % ${JSON.stringify(res)}`);
        continue;
      }
      for (const dir of [1, 1, -1]) {
        const a = await s.evaluate('performance.now()');
        if (mode === 'script') {
          await s.evaluate(`window.__jank.script(40, ${dir})`);
        } else {
          const r = await s.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(p.scroller)}).getBoundingClientRect(); return { x: r.left + r.width / 2, top: r.top, bottom: r.bottom }; })()`);
          const span = Math.min(140, (r.bottom - r.top) * 0.6);
          const y1 = dir > 0 ? r.bottom - 15 : r.top + 15 + 30, y2 = dir > 0 ? y1 - span : y1 + span;
          const [sx, sy1] = toScreen(r.x, y1); const [, sy2] = toScreen(r.x, y2);
          py('drag', sx, sy1, sx, sy2, 70, 8);
          await sleep(2200);
        }
        windows.push([a, await s.evaluate('performance.now()')]);
        await sleep(500);
      }
      const frames = await s.evaluate('window.__jank.stop()');
      const st1 = await s.evaluate(STATS);
      const fm = frameMetrics(frames, windows);
      const why = await s.evaluate('window.__why ?? null');
      const run = { name, mode, rep, load: LOAD, ...fm, why, top: frames.at(-1)?.[1], stats: { before: st0, after: st1 }, tiles: (st1?.tiles ?? 0) - (st0?.tiles ?? 0) };
      out.runs.push(run);
      console.log(`${name.padEnd(8)} ${mode.padEnd(6)} load ${LOAD} composed ${(st1?.scroll?.composed ?? 0) - (st0?.scroll?.composed ?? 0)}  frame ${fm.frameMs}ms moves ${fm.moves} paintGaps ${fm.paintGaps} (max ${fm.maxPaintGap}) unpainted ${fm.unpainted} paintHz ${fm.paintHz} rafGaps ${fm.rafGaps} (max ${fm.maxRaf}) lag ${fm.startLag.join('/')} | tiles ${run.tiles} clone p50/p95 ${st1?.cloneMsP50?.toFixed?.(1)}/${st1?.cloneMsP95?.toFixed?.(1)} decode p50/p95 ${st1?.decodeMsP50?.toFixed?.(1)}/${st1?.decodeMsP95?.toFixed?.(1)} nodes ${st1?.nodesLast}${why ? ' why ' + JSON.stringify(why).slice(0, 300) : ''}`);
    }
  }
} catch (e) { out.error = String(e.stack || e); console.error(out.error); }
finally { if (MODES.includes('drag')) { try { py('park'); } catch { /* best effort */ } } await s.close(); await srv.close(); }
const file = arg('out') ?? resolve(PROJECT_ROOT, `.scratch/results/scroll-jank-ios-${out.at.replace(/[:.]/g, '-')}.json`);
mkdirSync(resolve(file, '..'), { recursive: true });
writeFileSync(file, JSON.stringify(out) + '\n');
console.log(out.error ? 'error' : 'ok', file);
