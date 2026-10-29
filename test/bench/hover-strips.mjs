// REPORTED DATA, no thresholds: the scroll compositor's hover strips (src/snapshot/store/scroll-compose.js) on pages other than the G-scroll-cadence fixture.
//   node test/bench/hover-strips.mjs [--cases=inbox,table,grid,sections,desc,underline] [--rates=1,4] [--dpr=2] [--bundle=/dist/hic-live-polyfill.iife.js] [--out=file]
// Per case and CPU throttling rate, in a fresh tab: the mouse rests over the scroller, then a trusted wheel stream (60 steps of 40 px down, 60 up, 8 ms apart) scrolls
// it under the still pointer. Reported: the moved rAF frames, the compositor's composed steps, fallbacks, steps whose hovered rows no strip could fill (and those
// whose strip was still being built), strips built and used (stats.snapshot.scroll), and a pixel check: canvas copies taken inside paint handlers (the first 6
// once the list moves, then every 9th, 14 at most) each compared with the plain-DOM twin of the same page put in the state (scroll offset, hovered element) of one of
// the frames just before (the twin: the same page with the polyfill's scripts not loaded and the canvas turned into a box of its size; overlay scrollbars hidden).
// Cases: inbox = examples/scroll-and-resize as shipped; the others are test/bench/fixtures/hover-probe.html (see its header).
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as H from '../harness/index.mjs';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const BUNDLE = arg('bundle', '/dist/hic-live-polyfill.iife.js');
const RATES = arg('rates', '1,4').split(',').map(Number);
const DPR = Number(arg('dpr', '2'));
const PROBE = '/test/bench/fixtures/hover-probe.html';
const CASES = {
  inbox: { path: '/examples/scroll-and-resize/index.html', q: {}, scroller: '#inbox', example: true },
  table: { path: PROBE, q: { case: 'table' }, scroller: '#sc' },
  grid: { path: PROBE, q: { case: 'grid' }, scroller: '#sc' },
  sections: { path: PROBE, q: { case: 'sections' }, scroller: '#sc' },
  desc: { path: PROBE, q: { case: 'desc' }, scroller: '#sc' },
  underline: { path: PROBE, q: { case: 'underline' }, scroller: '#sc' },
};
const ONLY = arg('cases', '').split(',').filter(Boolean);
const TOLERANCE = 6;
/**
 * Every awaited step has STEP_MS: a hidden tab gets no frames, and a screenshot, an input event or a paint wait sent to it waits for ever (a run hung with every
 * process idle when the twin tab was used from behind the measured one). A step that stalls ends the run with its name; a watchdog ends it when no step completes
 * for WATCHDOG_MS whatever is awaited.
 */
const STEP_MS = 60000;
const WATCHDOG_MS = 90000;
let lastStep = { at: Date.now(), label: 'start' };
/** @template T @param {string} label @param {Promise<T>} p @returns {Promise<T>} */
function step(label, p) {
  lastStep = { at: Date.now(), label };
  let timer;
  return Promise.race([p, new Promise((_, no) => { timer = setTimeout(() => no(new Error(`stalled for ${STEP_MS / 1000} s: ${label}`)), STEP_MS); })]).finally(() => { clearTimeout(timer); lastStep = { at: Date.now(), label: label + ' (done)' }; });
}
const MAX_FRACTION = 0.004;

/** in-page: the deepest hovered element below the scroller as an index path, per rAF frame and per sampled paint */
const RECORDER = (sel) => `(() => {
  const sc = document.querySelector(${JSON.stringify(sel)});
  const canvas = document.querySelector('canvas[content="drawable"], canvas[layoutsubtree]');
  const path = () => { let h = null; for (const e of sc.querySelectorAll(':hover')) h = e; if (!h) return null; const p = []; for (let e = h; e && e !== sc; e = e.parentElement) p.unshift(Array.prototype.indexOf.call(e.parentElement.children, e)); return p; };
  const R = window.__hs = { on: false, frames: [], samples: [], paints: 0 };
  canvas.addEventListener('paint', () => {
    R.paints++;
    if (!R.on) return;
    const early = R.early < 6 && sc.scrollTop !== R.top0;
    if (early) R.early++;
    if (!early && (R.paints % 9 || R.samples.length >= 14)) return;
    const copy = new OffscreenCanvas(canvas.width, canvas.height);
    copy.getContext('2d').drawImage(canvas, 0, 0);
    R.samples.push({ t: performance.now(), top: sc.scrollTop, path: path(), copy });
  });
  R.start = () => { Object.assign(R, { on: true, frames: [], samples: [], early: 0, top0: sc.scrollTop }); const f = (t) => { if (!R.on) return; R.frames.push([t, sc.scrollTop, path()]); requestAnimationFrame(f); }; requestAnimationFrame(f); };
  R.stop = () => { R.on = false; return R.frames; };
  R.png = async (i) => { const b = await R.samples[i].copy.convertToBlob({ type: 'image/png' }); return await new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(b); }); };
  const cr = canvas.getBoundingClientRect(), cs = getComputedStyle(canvas), r = sc.getBoundingClientRect();
  // the scroller in device px of the canvas bitmap
  const k = canvas.width / (cr.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth));
  return { k, x: (r.left - cr.left - parseFloat(cs.paddingLeft) - parseFloat(cs.borderLeftWidth)) * k, y: (r.top - cr.top - parseFloat(cs.paddingTop) - parseFloat(cs.borderTopWidth)) * k, w: r.width * k, h: r.height * k, left: r.left, top: r.top, width: r.width, height: r.height };
})()`;
const STATS = `window.__HIC__.installed.report().canvases[0].stats.snapshot.scroll`;
/** the twin: the canvas becomes a box of its content size holding its children; no scrollbar is drawn (the polyfill draws no overlay bar) */
const TWINIFY = `(() => {
  const c = document.querySelector('canvas[content="drawable"], canvas[layoutsubtree]');
  const cs = getComputedStyle(c);
  const d = document.createElement('div');
  d.id = c.id; d.className = c.className;
  d.style.cssText = 'display:block;box-sizing:content-box;width:' + cs.width + ';height:' + cs.height + ';padding:' + cs.padding + ';border:' + cs.border + ';background:' + cs.backgroundColor;
  d.append(...c.childNodes); c.replaceWith(d);
  const st = document.createElement('style'); st.textContent = '* { scrollbar-width: none !important; }'; document.head.append(st);
  return true;
})()`;

const srv = await H.startServer();
const browser = await H.launchChrome({ name: 'hover-strips', scrollbars: 'overlay', dpr: DPR });
const watchdog = setInterval(() => {
  if (Date.now() - lastStep.at < WATCHDOG_MS) return;
  console.error(`WATCHDOG: no step completed for ${WATCHDOG_MS / 1000} s, last: ${lastStep.label}`);
  browser.close().catch(() => {}).finally(() => process.exit(2));
}, 5000);
const out = { at: new Date().toISOString(), chrome: browser.version?.Browser, bundle: BUNDLE, dpr: DPR, runs: [] };
try {
  const page = await browser.newPage();
  const twin = await browser.newPage();
  await step('page.setInnerSize', page.setInnerSize(1400, 880));
  await step('twin.setInnerSize', twin.setInnerSize(1400, 880));
  // the examples load the minified core: they get the bundle under test; the twin gets no polyfill script at all
  await step('page.send', page.send('Fetch.enable', { patterns: [{ urlPattern: '*hic-live-*.js' }] }));
  page.on('Fetch.requestPaused', (ev) => {
    const u = new URL(ev.request.url);
    const to = u.pathname === '/dist/hic-live-polyfill.iife.min.js' ? BUNDLE : u.pathname;
    page.send('Fetch.continueRequest', { requestId: ev.requestId, url: new URL(to, u).href }).catch(() => {});
  });
  await step('twin.send', twin.send('Fetch.enable', { patterns: [{ urlPattern: '*hic-live-*.js' }] }));
  twin.on('Fetch.requestPaused', (ev) => { twin.send('Fetch.fulfillRequest', { requestId: ev.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }], body: '' }).catch(() => {}); });
  for (const [name, c] of Object.entries(CASES)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    for (const rate of RATES) {
      const u = new URL(c.path, srv.url);
      for (const [k, v] of Object.entries(c.q)) u.searchParams.set(k, String(v));
      const tu = new URL(u);
      if (!c.example) u.searchParams.set('bundle', BUNDLE);
      await step('page.navigate', page.navigate(u.href));
      await step('page.ensureForeground', page.ensureForeground().catch(() => {}));
      await step('page.waitForFunction', page.waitForFunction(`(window.__HIC__?.installed?.report?.().canvases?.length ?? 0) > 0 && document.querySelector(${JSON.stringify(c.scroller)})`, { timeout: 20000 }));
      await H.sleep(1200);
      const geo = await step('page.evaluate', page.evaluate(RECORDER(c.scroller)));
      // the pointer rests over the middle of the scroller (the middle column of a grid), 200 css px below its top at most
      const at = { x: geo.left + geo.width / 2, y: geo.top + Math.min(geo.height / 2, 200) };
      await step('page.mouseMove', page.mouseMove(at.x - 30, at.y));
      await step('page.mouseMove', page.mouseMove(at.x, at.y));
      await H.sleep(900);
      await step('page.send', page.send('Emulation.setCPUThrottlingRate', { rate }));
      const s0 = await step('page.evaluate', page.evaluate(STATS));
      await step('page.evaluate', page.evaluate('window.__hs.start()'));
      await step('H.wheelStream', H.wheelStream(page, { ...at, deltaY: 40, count: 60, intervalMs: 8 }));
      await step('H.wheelStream', H.wheelStream(page, { ...at, deltaY: -40, count: 60, intervalMs: 8 }));
      await H.sleep(400);
      const frames = await step('page.evaluate', page.evaluate('window.__hs.stop()'));
      await step('page.send', page.send('Emulation.setCPUThrottlingRate', { rate: 1 }));
      const s1 = await step('page.evaluate', page.evaluate(STATS));
      const d = Object.fromEntries(Object.entries(s1).map(([k, v]) => [k, v - (s0[k] ?? 0)]));
      let moved = 0;
      for (let i = 1; i < frames.length; i++) if (frames[i][1] !== frames[i - 1][1]) moved++;
      // pixel check against the twin in the state of the sample or of a frame just before it
      const samples = await step('page.evaluate', page.evaluate('window.__hs.samples.map((s) => ({ t: s.t, top: s.top, path: s.path }))'));
      // the twin is used in front: a tab behind another gets no frames (its screenshots and input events never complete)
      await step('twin.ensureForeground', twin.ensureForeground());
      await step('twin.navigate', twin.navigate(tu.href));
      await step('twin.waitForFunction', twin.waitForFunction(`document.readyState === 'complete' && document.querySelector(${JSON.stringify(c.scroller)})`, { timeout: 20000 }));
      await step('twin.evaluate', twin.evaluate(TWINIFY));
      await H.sleep(300);
      const tgeo = await step('twin.evaluate', twin.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(c.scroller)}).getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`));
      const shots = new Map();
      const twinMisses = [];
      const twinAt = async (top, path) => {
        const key = `${top}|${path ? path.join('.') : '-'}`;
        if (shots.has(key)) return shots.get(key);
        await step('twin.evaluate', twin.evaluate(`document.querySelector(${JSON.stringify(c.scroller)}).scrollTop = ${top}`));
        let ok = false;
        const want = JSON.stringify(path);
        const hovered = `(() => { const sc = document.querySelector(${JSON.stringify(c.scroller)}); let h = null; for (const e of sc.querySelectorAll(':hover')) h = e; if (!h) return null; const p = []; for (let e = h; e && e !== sc; e = e.parentElement) p.unshift(Array.prototype.indexOf.call(e.parentElement.children, e)); return JSON.stringify(p); })()`;
        // first the pointer where it rested on the polyfill's page (relative to the scroller): the same hit at the same offset
        await step('twin.mouseMove', twin.mouseMove(tgeo.left + (at.x - geo.left) - 1, tgeo.top + (at.y - geo.top)));
        await step('twin.mouseMove', twin.mouseMove(tgeo.left + (at.x - geo.left), tgeo.top + (at.y - geo.top)));
        await H.sleep(60);
        if (String(await step('twin.evaluate', twin.evaluate(hovered))) === String(path ? want : null)) ok = true;
        else if (!path) { await step('twin.mouseMove', twin.mouseMove(tgeo.left + tgeo.width + 200, tgeo.top + 20)); ok = true; } else {
          // the hover lagged the offset: the element of the path, under the pointer's column, a few heights inside it until the twin hovers exactly that element
          const box = await step('twin.evaluate', twin.evaluate(`(() => { let e = document.querySelector(${JSON.stringify(c.scroller)}); for (const i of ${want}) e = e.children[i]; const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; })()`));
          const x = tgeo.left + (at.x - geo.left);
          for (const f of [0.5, 0.25, 0.75, 0.1, 0.9]) {
            const y = Math.min(tgeo.top + tgeo.height - 2, Math.max(tgeo.top + 2, box.top + (box.bottom - box.top) * f));
            await step('twin.mouseMove', twin.mouseMove(x, y));
            await H.sleep(60);
            const got = await step('twin.evaluate', twin.evaluate(hovered));
            if (got === want) { ok = true; break; }
          }
        }
        if (!ok) twinMisses.push(key);
        await H.sleep(200);
        const shot = ok ? (await step('H.screenshotElement', H.screenshotElement(twin, c.scroller))).img : null;
        shots.set(key, shot);
        return shot;
      };
      const checks = [];
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        const png = await step('page.evaluate', page.evaluate(`window.__hs.png(${i})`));
        const full = H.decodePng(Buffer.from(png.split(',')[1], 'base64'));
        const crop = H.cropImage(full, Math.round(geo.x), Math.round(geo.y), Math.min(full.width - Math.round(geo.x), Math.round(geo.w)), Math.min(full.height - Math.round(geo.y), Math.round(geo.h)));
        const seen = new Set();
        const cands = [[s.top, s.path], ...frames.filter((f) => f[0] <= s.t && f[0] >= s.t - 45).map((f) => [f[1], f[2]])].filter(([t, p]) => { const k = `${t}|${JSON.stringify(p)}`; return !seen.has(k) && seen.add(k); });
        let best = null;
        for (const [top, path] of cands) {
          const img = await twinAt(top, path);
          if (!img) continue;
          const w = Math.min(img.width, crop.width), h = Math.min(img.height, crop.height);
          if (Math.abs(img.width - crop.width) > 1 || Math.abs(img.height - crop.height) > 1) continue;
          const r = H.compareImages(H.cropImage(crop, 0, 0, w, h), H.cropImage(img, 0, 0, w, h), { tolerance: TOLERANCE, diffImage: false });
          const f = r.sizeMatch ? r.fraction : 1;
          if (!best || f < best.fraction) best = { top, path, fraction: f };
        }
        checks.push(best ? best.fraction : null);
      }
      const bad = checks.filter((f) => f === null || f > MAX_FRACTION).length;
      const run = { name, rate, frames: frames.length, moved, scroll: d, composedShare: moved ? d.composed / moved : 0, samples: checks.length, pixelMisses: bad, worst: Math.max(0, ...checks.filter((f) => f !== null)), twinMisses: twinMisses.length };
      out.runs.push(run);
      console.log(`${name.padEnd(10)} ${rate}x  moved ${String(moved).padStart(3)}  composed ${String(d.composed).padStart(3)} (${(run.composedShare * 100).toFixed(0)} %)  fallbacks ${d.fallbacks}  unfilled ${d.unfilled ?? '-'} (late ${d.late ?? '-'})  strips ${d.strips ?? '-'} used ${d.stripsUsed ?? '-'}  pixels ${checks.length - bad}/${checks.length} ok (worst ${(run.worst * 100).toFixed(2)} %)${twinMisses.length ? `  twin misses ${twinMisses.length}` : ''}`);
    }
  }
} catch (e) { out.error = String(e.stack || e); console.error(out.error); }
finally { clearInterval(watchdog); await browser.close(); await srv.close(); }
const file = arg('out', resolve(H.PROJECT_ROOT, `.scratch/results/hover-strips-${out.at.replace(/[:.]/g, '-')}.json`));
mkdirSync(resolve(file, '..'), { recursive: true });
writeFileSync(file, JSON.stringify(out, null, 2));
console.log('ok', file);
