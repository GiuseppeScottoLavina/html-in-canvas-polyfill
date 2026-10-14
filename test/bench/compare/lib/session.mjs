// Subjects, browser sessions, load guard, traced windows and per-process CPU / memory for the comparison bench.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import * as H from '../../../harness/index.mjs';

export { H };
export const ROOT = H.PROJECT_ROOT;
export const OUT_DIR = resolve(ROOT, '.scratch/bench-compare');
export const RESULTS_DIR = resolve(ROOT, '.scratch/results');

/** URL paths of the bundles under test (served by the harness server). */
export const OURS_URL = '/dist/hic-live-polyfill.iife.min.js';
export const OURS_DEBUG_URL = '/dist/hic-live-polyfill.iife.js';
export const COMPETITOR_URL = '/bench/competitor-adapted.iife.js';
export const COMPETITOR_FILE = resolve(ROOT, '.scratch/competitor/competitor-adapted.iife.js');

/**
 * Subject = which renderer draws the page. Ours and the competitor run on Chrome stable (no native feature), native on Chrome Canary with
 * --enable-blink-features=CanvasDrawElement and NO bundle.
 */
export const SUBJECTS = {
  ours: { id: 'ours', label: 'ours (hic-live-polyfill)', chrome: 'stable', native: false, bundle: OURS_URL },
  competitor: { id: 'competitor', label: 'competitor (html-in-canvas-polyfill 1.0.1, adapted)', chrome: 'stable', native: false, bundle: COMPETITOR_URL },
  native: { id: 'native', label: 'native (Canary + CanvasDrawElement)', chrome: 'canary', native: true, bundle: null },
};

/** Fixture URL for a subject. `explainer` takes ?mode=poly&bundle= (no bundle = the page's own script on the native API). */
export function pageUrl(srv, subject, fixture, params = {}) {
  if (fixture === 'explainer') {
    const u = new URL('/test/fixtures/explainer/index.html', srv.url);
    u.searchParams.set('mode', subject.native ? 'native' : 'poly');
    if (subject.bundle) u.searchParams.set('bundle', subject.bundle);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    return u.href;
  }
  return H.fixtureUrl(srv, fixture, { mode: subject.native ? 'native' : 'poly', bundle: subject.bundle ?? undefined, params });
}
export function refUrl(srv, fixture, params = {}) {
  if (fixture === 'explainer') return new URL('/test/fixtures/explainer/index.html?mode=ref', srv.url).href;
  return H.fixtureUrl(srv, fixture, { mode: 'ref', params });
}

/** Wait until the page drew something: explainer counts `paint` events, fixtures expose __HIC_FIXTURE.ready. */
export async function waitReady(page, fixture, timeout = 20000) {
  const expr = fixture === 'explainer' ? '(window.__paints || 0) >= 1' : '!!(window.__HIC_FIXTURE && (window.__HIC_FIXTURE.ready || window.__HIC_FIXTURE.fatal))';
  await page.waitForFunction(expr, { timeout });
  if (fixture !== 'explainer') { const f = await page.evaluate('window.__HIC_FIXTURE.fatal'); if (f) throw new Error(`fixture ${fixture} fatal: ${f}`); }
}

/** Load snapshot that ignores our own driver + browser; waits up to `maxWaitMs` for a quiet machine. */
export async function quiet(ownPids, maxWaitMs = 120000) {
  const s = await H.waitForQuiet({ ownPids, maxWaitMs, pollMs: 5000 });
  let uptime = ''; try { uptime = execFileSync('uptime', { encoding: 'utf8' }).trim(); } catch { /* informational */ }
  return { ...s, uptime };
}

export class Session {
  constructor(subject, opts = {}) { this.subject = subject; this.opts = opts; this.loads = []; }

  async open() {
    this.srv = await H.startServer({ files: { [COMPETITOR_URL]: COMPETITOR_FILE } });
    this.browser = await H.launchChrome({ name: `cmp-${this.subject.id}`, chrome: this.subject.chrome, dpr: 2, nativeDrawElement: this.subject.native, windowSize: [1440, 960] });
    this.page = await this.browser.newPage();
    await this.page.requireForeground('session start');
    await this.page.navigate('about:blank');
    await this.page.setInnerSize(1400, 880);
    return this;
  }

  ownPids() { return [process.pid, this.browser.pid]; }
  async loadCheck(label) { const l = await quiet(this.ownPids(), this.opts.quietWaitMs ?? 120000); this.loads.push({ label, ...l }); return l; }

  /** Navigate the main tab to a subject page and wait for its first paint. */
  async goto(fixture, params = {}) {
    const p = this.page;
    p.clearLogs();
    await p.navigate(pageUrl(this.srv, this.subject, fixture, params));
    await p.requireForeground(`goto ${fixture}`);
    await waitReady(p, fixture);
    await H.sleep(400);
    return p;
  }

  /** Plain-DOM twin geometry: css rects relative to `container`, plus computed paddings/borders for text controls. */
  async refGeometry(fixture, container, selectors, params = {}) {
    const ref = await this.browser.newPage({ reuseFirst: false });
    try {
      await ref.navigate(refUrl(this.srv, fixture, params));
      await ref.bringToFront();
      await ref.setInnerSize(1400, 880);
      await ref.waitForFunction(fixture === 'explainer' ? 'window.__ready === true' : '!!(window.__HIC_FIXTURE && window.__HIC_FIXTURE.ready)', { timeout: 10000 });
      await H.sleep(200);
      return await ref.evaluate(`(() => { const c = document.querySelector(${JSON.stringify(container)}).getBoundingClientRect(); const o = { container: { x: c.left, y: c.top, width: c.width, height: c.height } };
        for (const s of ${JSON.stringify(selectors)}) { const e = document.querySelector(s); if (!e) { o[s] = null; continue; } const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
          o[s] = { x: r.left - c.left, y: r.top - c.top, width: r.width, height: r.height, pad: { l: parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth), r: parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth), t: parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth), b: parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth) }, font: cs.font, bg: cs.backgroundColor, color: cs.color }; }
        return o; })()`);
    } finally { await ref.close(); await this.page.bringToFront(); await this.page.requireForeground('after ref geometry'); }
  }

  /** Compositor screenshot of a css rect (viewport coords) in a plain-DOM twin tab with an optional setup expression. */
  async refShot(fixture, selector, setupExpr = null, params = {}) {
    const ref = await this.browser.newPage({ reuseFirst: false });
    try {
      await ref.navigate(refUrl(this.srv, fixture, params));
      await ref.bringToFront();
      await ref.setInnerSize(1400, 880);
      await ref.requireForeground('ref shot');
      await ref.waitForFunction(fixture === 'explainer' ? 'window.__ready === true' : '!!(window.__HIC_FIXTURE && window.__HIC_FIXTURE.ready)', { timeout: 10000 });
      if (setupExpr) await ref.evaluate(setupExpr);
      await ref.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
      await H.sleep(250);
      return await H.screenshotElement(ref, selector);
    } finally { await ref.close(); await this.page.bringToFront(); await this.page.requireForeground('after ref shot'); }
  }

  /** Run `fn` inside a browser trace bracketed by marks m0/m1; returns RunTask stats, paint counts and renderer/GPU CPU of the window. */
  async traced(name, fn, { selector = '#hic-surface', keep = false } = {}) {
    const p = this.page;
    await p.evaluate(`(() => { const c = document.querySelector(${JSON.stringify(selector)}); const P = window.__tp = { n: 0, t: [] }; if (!window.__tpOn) { window.__tpOn = 1; c.addEventListener('paint', () => { window.__tp.n++; window.__tp.t.push(performance.now()); }); } return true; })()`);
    const file = resolve(OUT_DIR, 'traces', `${this.subject.id}-${name}-${Date.now()}.json`);
    mkdirSync(resolve(OUT_DIR, 'traces'), { recursive: true });
    await this.browser.traceStart();
    await H.sleep(150);
    const cpu0 = await this.procCpu();
    const t0 = await p.evaluate('(performance.mark("m0"), performance.now())');
    const out = await fn();
    const t1 = await p.evaluate('(performance.mark("m1"), performance.now())');
    const cpu1 = await this.procCpu();
    const paints = await p.evaluate(`(() => { const t = window.__tp.t.filter(x => x >= ${t0} && x <= ${t1}); return { n: t.length }; })()`);
    await H.sleep(100);
    await this.browser.traceStop(file);
    const a = H.analyzeTrace(file, { windowMarks: ['m0', 'm1'] });
    if (!keep) { try { rmSync(file); } catch { /* best effort */ } }
    const spanS = (t1 - t0) / 1000;
    const cpu = diffCpu(cpu0, cpu1, spanS);
    const rt = a.error ? { error: a.error } : { ...a.runTask, spanMs: a.spanMs, longest: a.longest.slice(0, 5).map((x) => ({ durMs: +x.durMs.toFixed(2), top: x.topEvents.slice(0, 3) })), tasksPerSecond: a.runTask.count / spanS, rafFires: a.rafFires?.n };
    return { out, runTask: rt, paints: { n: paints.n, perSecond: paints.n / spanS }, cpu, spanMs: t1 - t0, traceFile: keep ? file : null };
  }

  /** CPU seconds per process type (SystemInfo.getProcessInfo). */
  async procCpu() {
    try { const { processInfo } = await this.browser.conn.send('SystemInfo.getProcessInfo'); return processInfo.map((x) => ({ type: x.type, id: x.id, cpu: x.cpuTime })); } catch { return null; }
  }

  /** RSS (KB) of our renderer(s) and GPU process via ps (only processes carrying our unique profile dir). */
  rss() {
    const out = execFileSync('ps', ['-axo', 'pid=,rss=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const rows = out.split('\n').filter((l) => l.includes(`--user-data-dir=${this.browser.userDataDir}`) || l.includes(this.browser.userDataDir)).map((l) => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/); return m && { pid: +m[1], rssKB: +m[2], cmd: m[3] }; }).filter(Boolean);
    const renderers = rows.filter((r) => /--type=renderer/.test(r.cmd) && !/--extension-process/.test(r.cmd));
    const gpu = rows.filter((r) => /--type=gpu-process/.test(r.cmd));
    return { rendererMaxKB: Math.max(0, ...renderers.map((r) => r.rssKB)), renderers: renderers.map((r) => ({ pid: r.pid, rssKB: r.rssKB })), gpuKB: gpu.reduce((s, r) => s + r.rssKB, 0) };
  }

  async close() {
    try { await this.browser?.close(); } catch { /* ignore */ }
    try { await this.srv?.close(); } catch { /* ignore */ }
  }
}

/** CPU % per process type over a window (100 % = one core). */
export function diffCpu(a, b, spanS) {
  if (!a || !b) return null;
  const by = {};
  for (const x of b) { const prev = a.find((y) => y.id === x.id); const d = x.cpu - (prev ? prev.cpu : 0); by[x.type] = (by[x.type] ?? 0) + d; }
  const pct = {}; for (const [k, v] of Object.entries(by)) pct[k] = +(100 * v / spanS).toFixed(2);
  return pct;
}

export function keepDir(...p) { const d = resolve(OUT_DIR, ...p); mkdirSync(d, { recursive: true }); return d; }
export const exists = existsSync;
export const fileSize = (f) => statSync(f).size;
