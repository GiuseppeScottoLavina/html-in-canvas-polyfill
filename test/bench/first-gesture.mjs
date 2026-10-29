// REPORTED DATA, no thresholds: how the START of a touch scroll gesture over a drawn inner scroller is shown, gesture by gesture, from the first one on a fresh page.
//   node test/bench/first-gesture.mjs [--engine=ios|chrome] [--pages=inbox,mobile] [--gestures=N] [--slop=FRAMES] [--rates=1,4,6] [--input=touch|synth] [--reps=N]
//                                      [--core=path] [--quiet-ms=MS] [--udid=...] [--out=file]
// ios     the iOS Simulator (safaridriver). WebDriver cannot touch there, so the page gets what Mobile Safari dispatches for a finger that starts a pan: pointerover,
//         pointerenter, pointerdown and touchstart at the contact, `--slop` frames later pointercancel, pointerout and pointerleave, then the scroll steps (scrollTop set in
//         requestAnimationFrame: a drag at constant speed, then a decaying fling). No OS input.
// chrome  headless Chrome, CPU throttled at each of --rates, a real touch through the browser's input pipeline (no OS input): --input=touch sends touchStart, `--slop`
//         frames of rest, then touchMoves of 12 css px per frame and touchEnd (the browser scrolls it and flings); --input=synth uses Input.synthesizeScrollGesture.
// Before the first gesture the page rests `--quiet-ms` (default 1500 ms; 0: no rest) after its first paint; between gestures 1500 ms.
// Per gesture, from the first scroll event of the scroller:
//   firstMs      to the first canvas paint            composedMs  to the first paint the scroll compositor composed (null: none in the gesture)
//   plain        paints built (not composed) before the first composed one        frames  animation frames before the first composed paint
//   composed / paints / moves                                                     drops   animation frame intervals > 1.5 frames in the first 250 ms
//   ourMs        main-thread time of the polyfill in the first 250 ms (only with a probe build that records window.__hicProbe; null otherwise)
// Quiet cost, before the first gesture: scheduler frames and snapshot tiles from the first paint to the gesture, then the frames in the last 1000 ms of the rest
// (a page at rest must tick 0 times), the scroll compositor's page builds, and the retained bytes of its pages (pageBytes).
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_ROOT, arg, sleep, stats } from '../harness/lib/util.mjs';
import { startServer } from '../harness/server.mjs';

const ENGINE = arg('engine') ?? 'ios';
const GESTURES = Number(arg('gestures') ?? 4);
const SLOP = Number(arg('slop') ?? 3);
const QUIET = Number(arg('quiet-ms') ?? 1500);
const REPS = Number(arg('reps') ?? 1);
const RATES = (arg('rates') ?? (ENGINE === 'chrome' ? '1,4,6' : '1')).split(',').map(Number);
const INPUT = arg('input') ?? 'touch';
const CORE = arg('core');
const BUNDLE = ['/dist/hic-live-engines.iife.js', '/dist/hic-live-gpu.iife.js', '/dist/hic-live-polyfill.iife.js'].join(',');
const PAGES = {
  inbox: { path: '/examples/scroll-and-resize/index.html', q: {}, scroller: '#inbox' },
  mobile: { path: '/test/fixtures/mobile/index.html', q: { mode: 'poly', bundle: BUNDLE }, scroller: '#list', fixture: true },
  // two lists without :hover rules (the field test's lists are alike): the rounded one, and the square one
  round2: { path: '/test/fixtures/mobile/scroll-compose.html', q: { mode: 'poly', bundle: BUNDLE }, scroller: '#round', fixture: true },
  square2: { path: '/test/fixtures/mobile/scroll-compose.html', q: { mode: 'poly', bundle: BUNDLE }, scroller: '#square', fixture: true },
  cadence: { path: '/test/gates/fixtures/scroll-cadence.html', q: { rows: 300, bundle: '/dist/hic-live-polyfill.iife.js' }, scroller: '#list' },
  round: { path: '/test/gates/fixtures/scroll-cadence.html', q: { rows: 300, round: 1, bundle: '/dist/hic-live-polyfill.iife.js' }, scroller: '#list' },
};
const ONLY = (arg('pages') ?? (ENGINE === 'chrome' ? 'cadence,inbox' : 'inbox,mobile')).split(',');

/** in-page recorder: rAF frames [t, scrollTop], paints [t, scrollTop, composed, tiles, pages], scroll events; the gesture emulation of Mobile Safari */
const RECORDER = (sel) => `(() => {
  const s = document.querySelector(${JSON.stringify(sel)});
  if (!s) return false;
  const snap = () => { const c = window.__HIC__?.installed?.report?.().canvases?.[0]?.stats; const sc = c?.snapshot?.scroll ?? {}; return [sc.composed ?? 0, c?.snapshot?.tiles ?? 0, sc.pages ?? 0, c?.scheduler?.frames ?? 0]; };
  const R = window.__fg = { frames: [], paints: [], scrolls: [], touches: [], snap };
  R.t0 = performance.now();
  R.s0 = snap();
  addEventListener('paint', () => { R.paints.push([performance.now(), s.scrollTop, ...snap()]); }, true);
  s.addEventListener('scroll', () => { R.scrolls.push([performance.now(), s.scrollTop]); }, { passive: true });
  const f = (t) => { R.frames.push([t, s.scrollTop]); requestAnimationFrame(f); };
  requestAnimationFrame(f);
  R.point = (dir) => { const r = s.getBoundingClientRect(); const x = r.left + r.width / 2, y = dir > 0 ? r.top + r.height * 0.75 : r.top + r.height * 0.35; return { x, y, w: innerWidth, h: innerHeight }; };
  // Mobile Safari's events for a finger that starts a pan, then the scroll steps from requestAnimationFrame (no OS input)
  R.gesture = (o) => new Promise((ok) => {
    const { x, y } = R.point(o.dir);
    const t = document.elementFromPoint(x, y) ?? s;
    const pe = (type, bubbles = true) => t.dispatchEvent(new PointerEvent(type, { bubbles, cancelable: true, composed: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, width: 20, height: 20, pressure: 0.5 }));
    const g = { at: performance.now() };
    R.touches.push(g.at);
    pe('pointerover'); pe('pointerenter', false); pe('pointerdown');
    try { const touch = new Touch({ identifier: 7, target: t, clientX: x, clientY: y }); t.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, composed: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] })); } catch { /* no Touch constructor */ }
    let n = 0, v = 0;
    const f = () => {
      n++;
      if (n <= o.slop) { requestAnimationFrame(f); return; }
      if (n === o.slop + 1) { pe('pointercancel'); pe('pointerout'); pe('pointerleave', false); }
      const k = n - o.slop - 1;
      const step = k < o.dragFrames ? o.drag : (v = k === o.dragFrames ? o.fling : v * 0.95);
      if (step < 0.5) { g.end = performance.now(); ok(g); return; }
      s.scrollTop += step * o.dir;
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  return true;
})()`;

/** per gesture window [a, b] (performance.now): the metrics of the file comment */
function gestureMetrics(R, a, b, composed0) {
  const sc = R.scrolls.filter(([t]) => t >= a && t <= b);
  if (!sc.length) return { moves: 0 };
  const first = sc[0][0];
  const ps = R.paints.filter(([t]) => t >= first && t <= b + 300);
  // the compositor's count when the gesture began (a composition fires no paint event when nothing moved: the last paint before the gesture may be older)
  let prevComposed = composed0;
  let plain = 0, composedAt = null, composed = 0;
  for (const p of ps) {
    const c = p[2] > prevComposed;
    prevComposed = p[2];
    if (c) { composed++; if (composedAt === null) composedAt = p[0]; } else if (composedAt === null) plain++;
  }
  const fr = R.frames.filter(([t]) => t >= first && t <= b);
  const dts = []; for (let i = 1; i < R.frames.length; i++) dts.push(R.frames[i][0] - R.frames[i - 1][0]);
  const iv = stats(dts).p50 || 16.7;
  let drops = 0; for (let i = 1; i < fr.length; i++) if (fr[i][0] - first <= 250 && fr[i][0] - fr[i - 1][0] > 1.5 * iv) drops++;
  const frames = composedAt === null ? null : R.frames.filter(([t]) => t >= first && t < composedAt).length;
  const probe = R.probe ? R.probe.filter(([, t]) => t >= first && t <= first + 250).reduce((s, [, , d]) => s + d, 0) : null;
  const moves = fr.filter((f, i) => i > 0 && f[1] !== fr[i - 1][1]).length;
  return {
    firstMs: ps.length ? +(ps[0][0] - first).toFixed(1) : null, composedMs: composedAt === null ? null : +(composedAt - first).toFixed(1), plain, frames, composed, paints: ps.length, moves, drops,
    ourMs: probe === null ? null : +probe.toFixed(1), touchToScrollMs: (() => { const t = R.touches.filter((x) => x >= a && x <= first).at(-1); return t === undefined ? null : +(first - t).toFixed(1); })(),
  };
}

/** quiet cost from the recorder's start (the page loaded and painted) to `until` (the first gesture), and the frames in its last second */
function quietMetrics(R, until, pageBytes) {
  const [s0, s1] = R.snapAt;
  return { frames: s1[3] - R.s0[3], tiles: s1[1] - R.s0[1], lastSecondFrames: s1[3] - s0[3], pages: s1[2] - R.s0[2], pageBytes,
    // polyfill main-thread time from the page's start to the first gesture, and in the rest's last second (probe builds)
    ourMs: R.probe ? +R.probe.filter(([, t]) => t < until).reduce((s, [, , d]) => s + d, 0).toFixed(1) : null,
    lastSecondMs: R.probe ? +R.probe.filter(([, t]) => t >= until - 1000 && t < until).reduce((s, [, , d]) => s + d, 0).toFixed(1) : null };
}

const SCROLL_STATS = `(() => window.__HIC__?.installed?.report?.().canvases?.[0]?.stats?.snapshot?.scroll ?? null)()`;
const PAGE_BYTES = `(() => window.__HIC__?.installed?.report?.().canvases?.[0]?.stats?.snapshot?.scroll?.bytes ?? null)()`;

/** the probe build's records [kind, start, ms] and the run's recorder, read back */
const READ = `(() => { const R = window.__fg; return { frames: R.frames, paints: R.paints, scrolls: R.scrolls, touches: R.touches, t0: R.t0, s0: R.s0, snapAt: R.snapAt, probe: window.__hicProbe ?? null }; })()`;

const srv = await startServer(CORE ? { files: { '/dist/hic-live-polyfill.iife.js': resolve(PROJECT_ROOT, CORE), '/dist/hic-live-polyfill.iife.min.js': resolve(PROJECT_ROOT, CORE) } } : {});
const out = { at: new Date().toISOString(), engine: ENGINE, core: CORE ?? null, slop: SLOP, quietMs: QUIET, input: INPUT, runs: [] };

/** @param {(expr: string, opts?: object) => Promise<any>} ev @param {(g: object) => Promise<void>} drive  one gesture */
async function measure(ev, drive, name, rate) {
  const gestures = [];
  // the rest before the first gesture: frames in its last second (--quiet-ms=0: none, the first gesture starts right after the first paint, while the page may still
  // be planning ahead)
  await sleep(Math.max(0, QUIET - 1000));
  const s0 = await ev('window.__fg.snap()');
  if (QUIET > 0) await sleep(1000);
  const s1 = await ev('window.__fg.snap()');
  await ev(`(window.__fg.snapAt = [${JSON.stringify(s0)}, ${JSON.stringify(s1)}], true)`);
  const pageBytes = await ev(PAGE_BYTES);
  const quietUntil = await ev('performance.now()');
  for (let i = 0; i < GESTURES; i++) {
    const dir = [1, 1, -1, -1, 1, -1][i % 6];
    const a = await ev('performance.now()');
    const c0 = (await ev(SCROLL_STATS)) ?? {};
    await drive({ dir, slop: SLOP, drag: 10, dragFrames: 6, fling: 26 });
    const b = await ev('performance.now()');
    await sleep(1500);
    const c1 = await ev(SCROLL_STATS);
    // the scroll compositor's counters over the gesture and the rest after it (plans, refusals, drops...)
    gestures.push([a, b, Object.fromEntries(Object.entries(c1 ?? {}).filter(([k, v]) => typeof v === 'number' && v !== (c0[k] ?? 0)).map(([k, v]) => [k, v - (c0[k] ?? 0)])), c0.composed ?? 0]);
  }
  const R = await ev(READ);
  const per = gestures.map(([a, b, d, k]) => ({ ...gestureMetrics(R, a, b, k), scroll: d }));
  const quiet = quietMetrics(R, quietUntil, pageBytes);
  const run = { name, rate, quiet, gestures: per, ...(process.argv.includes('--raw') ? { raw: { paints: R.paints, scrolls: R.scrolls, touches: R.touches, probe: R.probe, windows: gestures } } : {}) };
  out.runs.push(run);
  console.log(`${name.padEnd(8)} ${String(rate).padStart(2)}x  quiet: frames ${quiet.frames} tiles ${quiet.tiles} lastSecondFrames ${quiet.lastSecondFrames} (${quiet.lastSecondMs} ms) pages ${quiet.pages} pageBytes ${quiet.pageBytes} ourMs ${quiet.ourMs}`);
  per.forEach((g, i) => console.log(`   g${i + 1}: plain ${g.plain} frames ${g.frames} firstMs ${g.firstMs} composedMs ${g.composedMs} composed ${g.composed}/${g.paints} moves ${g.moves} drops ${g.drops} ourMs ${g.ourMs}${g.touchToScrollMs !== null ? ' touch->scroll ' + g.touchToScrollMs : ''} | ${JSON.stringify(g.scroll)}`));
}

try {
  if (ENGINE === 'ios') {
    const { launchIosSimulator } = await import('../harness/lib/webdriver.mjs');
    const s = await launchIosSimulator({ udid: arg('udid') ?? 'DFB90FE1-E3F4-451A-8369-3B50C67BD0A5' });
    out.caps = { browserVersion: s.caps.browserVersion, platformVersion: s.caps.platformVersion };
    try {
      for (let rep = 0; rep < REPS; rep++) for (const [name, p] of Object.entries(PAGES)) {
        if (!ONLY.includes(name)) continue;
        const u = new URL(p.path, srv.url); u.searchParams.set('iso', '0'); for (const [k, v] of Object.entries(p.q)) u.searchParams.set(k, v);
        await s.navigate(u.href);
        await s.waitFor(`!!(window.__HIC__ && window.__HIC__.installed && window.__HIC__.installed.report().canvases.length && window.__HIC__.installed.report().canvases[0].stats.paintFired)`, { timeoutMs: 20000 });
        if (p.fixture) await s.evaluate(`(document.querySelector(${JSON.stringify(p.scroller)}).scrollIntoView({ block: 'center' }), true)`);
        await s.evaluate(RECORDER(p.scroller));
        await measure((e, o) => s.evaluate(e, o), (g) => s.evaluate(`window.__fg.gesture(${JSON.stringify(g)})`, { timeoutMs: 20000 }), name, 1);
      }
    } finally { await s.close(); }
  } else {
    const H = await import('../harness/index.mjs');
    const browser = await H.launchChrome({ name: 'first-gesture', scrollbars: 'overlay', extraArgs: ['--headless=new'] });
    out.chrome = browser.version?.Browser;
    try {
      const page = await browser.newPage();
      await page.setInnerSize(1400, 880);
      for (let rep = 0; rep < REPS; rep++) for (const [name, p] of Object.entries(PAGES)) {
        if (!ONLY.includes(name)) continue;
        for (const rate of RATES) {
          const u = new URL(p.path, srv.url); for (const [k, v] of Object.entries(p.q)) u.searchParams.set(k, v);
          await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
          await page.navigate(u.href);
          await page.waitForFunction(`!!(window.__HIC__?.installed?.report?.().canvases?.[0]?.stats?.paintFired)`, { timeout: 20000 });
          await page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(p.scroller)}); const r = e.getBoundingClientRect(); if (r.bottom > innerHeight || r.top < 0) e.scrollIntoView({ block: 'center' }); return true; })()`);
          await page.evaluate(RECORDER(p.scroller));
          await page.send('Emulation.setCPUThrottlingRate', { rate });
          const ev = (e) => page.evaluate(e);
          await measure(ev, async (g) => {
            const pt = await page.evaluate(`window.__fg.point(${g.dir})`);
            await page.evaluate('(window.__fg.touches.push(performance.now()), true)');
            if (INPUT === 'synth') {
              await page.send('Input.synthesizeScrollGesture', { x: Math.round(pt.x), y: Math.round(pt.y), yDistance: -400 * g.dir, speed: 1500, gestureSourceType: 'touch', preventFling: false });
              await sleep(900);
              return;
            }
            await H.touchDrag(page, { x: pt.x, y: pt.y, dir: g.dir, restMs: 16.7 * g.slop });
            await sleep(900);
          }, name, rate);
          await page.send('Emulation.setCPUThrottlingRate', { rate: 1 });
        }
      }
    } finally { await browser.close(); }
  }
} catch (e) { out.error = String(e.stack || e); console.error(out.error); }
finally { await srv.close(); }
const file = arg('out') ?? resolve(PROJECT_ROOT, `.scratch/results/first-gesture-${ENGINE}-${out.at.replace(/[:.]/g, '-')}.json`);
mkdirSync(resolve(file, '..'), { recursive: true });
writeFileSync(file, JSON.stringify(out) + '\n');
console.log(out.error ? 'error' : 'ok', file);
