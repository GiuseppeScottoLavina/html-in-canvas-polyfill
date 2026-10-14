// One browser tab driven over CDP: evaluate, navigate, foreground/focus, window, screenshots, heap, primitive input.
// Paced (cadence-reporting) input lives in input.mjs; window drags in window.mjs.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { paced, sleep, stats } from './util.mjs';

export class Page {
  /** @param {import('./chrome.mjs').Browser} browser */
  constructor(browser, targetId, sessionId) {
    this.browser = browser; this.conn = browser.conn; this.targetId = targetId; this.sessionId = sessionId;
    this.console = []; this.exceptions = []; this.logEntries = []; this.focusEmulated = false;
  }
  send(method, params) { return this.conn.send(method, params, this.sessionId); }
  on(method, h) { return this.conn.on(method, h, this.sessionId); }

  async init() {
    await Promise.all([this.send('Page.enable'), this.send('Runtime.enable'), this.send('Log.enable')]);
    this.on('Runtime.consoleAPICalled', p => this.console.push({ type: p.type, text: p.args.map(a => a.value ?? a.description ?? a.type).join(' '), ts: p.timestamp }));
    this.on('Runtime.exceptionThrown', p => this.exceptions.push({ text: p.exceptionDetails.exception?.description ?? p.exceptionDetails.text, url: p.exceptionDetails.url, line: p.exceptionDetails.lineNumber }));
    this.on('Log.entryAdded', p => this.logEntries.push(p.entry));
  }

  /** Console errors/warnings + uncaught exceptions + browser Log errors (e.g. 404s). Assert `[]` in every experiment. */
  errors({ includeWarnings = true } = {}) {
    return [
      ...this.console.filter(c => c.type === 'error' || (includeWarnings && c.type === 'warning')).map(c => ({ kind: 'console.' + c.type, text: c.text })),
      ...this.exceptions.map(e => ({ kind: 'exception', text: e.text, url: e.url, line: e.line })),
      ...this.logEntries.filter(l => l.level === 'error' || (includeWarnings && l.level === 'warning')).map(l => ({ kind: 'log.' + l.level, text: l.text, url: l.url })),
    ];
  }
  clearLogs() { this.console.length = 0; this.exceptions.length = 0; this.logEntries.length = 0; }

  async navigate(url, { waitUntil = 'load', timeout = 60000 } = {}) {
    const ev = waitUntil === 'load' ? 'Page.loadEventFired' : waitUntil === 'domcontentloaded' ? 'Page.domContentEventFired' : null;
    const w = ev ? this.conn.waitFor(ev, { sessionId: this.sessionId, timeout }) : null;
    const r = await this.send('Page.navigate', { url });
    if (r.errorText) throw new Error('navigate failed: ' + r.errorText);
    if (w) await w;
    return r;
  }

  /** Evaluate an expression (promises are awaited); returns the JSON value; throws on page exceptions. */
  async evaluate(expression, { awaitPromise = true, returnByValue = true, userGesture = true, timeout } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue, userGesture, ...(timeout ? { timeout } : {}) });
    if (r.exceptionDetails) throw new Error('evaluate failed: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return returnByValue ? r.result.value : r.result;
  }
  /** Evaluate a function with JSON-serialisable args: `page.call((a, b) => a + b, 1, 2)`. */
  call(fn, ...args) { return this.evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`); }
  async waitForFunction(expression, { timeout = 15000, interval = 50 } = {}) {
    const t = Date.now();
    for (;;) {
      const v = await this.evaluate(expression).catch(() => false); if (v) return v;
      if (Date.now() - t > timeout) throw new Error('waitForFunction timeout: ' + expression.slice(0, 160));
      await sleep(interval);
    }
  }

  // ---- foreground / focus -------------------------------------------------------------------------------------
  async focusState() {
    return this.evaluate(`({hasFocus: document.hasFocus(), visibilityState: document.visibilityState, hidden: document.hidden, activeElement: document.activeElement?.tagName ?? null})`);
  }
  /** THROWS unless document.hasFocus() && visibilityState==='visible' (and focus is not emulated unless allowed). Returns the state.
   *  Call before and after every measurement window: focus can be lost silently and rAF/paint stall in hidden tabs. */
  async assertForeground(what = '', { allowEmulated = false } = {}) {
    const s = await this.focusState();
    if (!(s.hasFocus && s.visibilityState === 'visible')) throw new Error(`PAGE NOT FOREGROUND/FOCUSED ${what}: ${JSON.stringify(s)}`);
    if (this.focusEmulated && !allowEmulated) throw new Error(`PAGE FOCUS IS EMULATED ${what} (Emulation.setFocusEmulationEnabled): not an honest measurement`);
    return s;
  }
  async bringToFront() {
    await this.send('Page.bringToFront');
    try { await this.conn.send('Target.activateTarget', { targetId: this.targetId }); } catch { /* best effort */ }
  }
  /** macOS: raise ONLY the Chrome process we spawned (by pid) via System Events; harmless if not permitted. */
  activateProcess() {
    try { execFileSync('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${this.browser.pid}) to true`], { timeout: 5000, stdio: 'ignore' }); return true; } catch { return false; }
  }
  /** Make the page foreground + focused: bringToFront -> osascript(our pid) -> (only if allowEmulation) focus emulation.
   *  @returns {Promise<{ok:boolean,mode:'real'|'emulated'|'failed',state:object}>} ALWAYS record `mode` in results. */
  async ensureForeground({ timeout = 6000, allowEmulation = false } = {}) {
    const t = Date.now(); let tried = 0;
    for (;;) {
      await this.bringToFront();
      if (tried++ === 1) this.activateProcess();
      const s = await this.focusState();
      if (s.hasFocus && s.visibilityState === 'visible') return { ok: true, mode: this.focusEmulated ? 'emulated' : 'real', state: s };
      if (Date.now() - t > timeout) break;
      await sleep(250);
    }
    if (allowEmulation) {
      await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }); this.focusEmulated = true; await sleep(200);
      const s = await this.focusState();
      return { ok: s.hasFocus && s.visibilityState === 'visible', mode: 'emulated', state: s };
    }
    return { ok: false, mode: 'failed', state: await this.focusState() };
  }
  /** ensureForeground that throws loudly (with the state) when not satisfied and real focus is required. */
  async requireForeground(what = '', opts = {}) {
    const r = await this.ensureForeground(opts);
    if (!r.ok) throw new Error(`COULD NOT FOREGROUND/FOCUS PAGE ${what}: ${JSON.stringify(r)}`);
    if (r.mode !== 'real' && !opts.allowEmulation) throw new Error(`focus mode '${r.mode}' is not real ${what}`);
    return r;
  }

  // ---- window / viewport --------------------------------------------------------------------------------------
  async getWindow() { return this.conn.send('Browser.getWindowForTarget', { targetId: this.targetId }); }
  async setWindowBounds(bounds) { const { windowId } = await this.getWindow(); await this.conn.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal', ...bounds } }); }
  async viewport() {
    return this.evaluate(`({innerWidth, innerHeight, outerWidth, outerHeight, dpr: devicePixelRatio, screenW: screen.width, screenH: screen.height, availW: screen.availWidth, availH: screen.availHeight, screenX, screenY, visualViewportScale: visualViewport?.scale ?? 1})`);
  }
  /** REAL window resize so that innerWidth x innerHeight == (w,h); iterates to absorb window chrome. */
  async setInnerSize(w, h) {
    let v = await this.viewport();
    for (let i = 0; i < 3; i++) {
      await this.setWindowBounds({ width: w + v.outerWidth - v.innerWidth, height: h + v.outerHeight - v.innerHeight });
      await sleep(250); v = await this.viewport();
      if (v.innerWidth === w && v.innerHeight === h) break;
    }
    return v;
  }

  // ---- screenshots --------------------------------------------------------------------------------------------
  /** Page.captureScreenshot. clip is CSS px in DOCUMENT coordinates, scale 1 => output is css*dpr device pixels. */
  async screenshot({ file, clip, format = 'png', fromSurface = true, beyondViewport = false } = {}) {
    const r = await this.send('Page.captureScreenshot', { format, fromSurface, ...(beyondViewport ? { captureBeyondViewport: true } : {}), ...(clip ? { clip: { ...clip, scale: clip.scale ?? 1 } } : {}) });
    const buf = Buffer.from(r.data, 'base64');
    if (file) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, buf); }
    return buf;
  }

  // ---- heap / DOM / listeners ---------------------------------------------------------------------------------
  async heapUsage({ gc = false } = {}) { if (gc) { try { await this.send('HeapProfiler.collectGarbage'); } catch { /* best effort */ } } return this.send('Runtime.getHeapUsage'); }
  async perfMetrics() { await this.send('Performance.enable'); const { metrics } = await this.send('Performance.getMetrics'); return Object.fromEntries(metrics.map(m => [m.name, m.value])); }
  /** @returns {Promise<{nodes:number,documents:number,jsEventListeners:number}>} */
  async domCounters() { return this.send('Memory.getDOMCounters'); }
  /** Sample heap/DOM/listener counts `n` times. Returns rows plus first->last growth (the leak signal). */
  async sampleHeap({ n = 10, intervalMs = 500, gc = false } = {}) {
    const rows = []; const t0 = Date.now();
    for (let i = 0; i < n; i++) {
      const h = await this.heapUsage({ gc }); let d = {}; try { d = await this.domCounters(); } catch { /* optional */ }
      rows.push({ t: Date.now() - t0, usedSize: h.usedSize, totalSize: h.totalSize, nodes: d.nodes, jsEventListeners: d.jsEventListeners, documents: d.documents });
      if (i < n - 1) await sleep(intervalMs);
    }
    const f = rows[0], l = rows[rows.length - 1];
    return { rows, growth: { usedSize: l.usedSize - f.usedSize, nodes: l.nodes - f.nodes, jsEventListeners: l.jsEventListeners - f.jsEventListeners, documents: l.documents - f.documents } };
  }

  // ---- CPU profiler (summaries: cpuprofile.mjs) ---------------------------------------------------------------
  async cpuProfileStart({ intervalUs = 200 } = {}) { await this.send('Profiler.enable'); await this.send('Profiler.setSamplingInterval', { interval: intervalUs }); await this.send('Profiler.start'); }
  async cpuProfileStop(file) {
    const { profile } = await this.send('Profiler.stop'); await this.send('Profiler.disable');
    if (file) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(profile)); }
    return profile;
  }

  // ---- primitive trusted input via CDP Input.* ----------------------------------------------------------------
  async mouseMove(x, y, { buttons = 0, modifiers = 0 } = {}) { return this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons, modifiers, button: buttons & 1 ? 'left' : 'none' }); }
  async mouseDown(x, y, { button = 'left', clickCount = 1, modifiers = 0 } = {}) { return this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'left' ? 1 : button === 'right' ? 2 : 4, clickCount, modifiers }); }
  async mouseUp(x, y, { button = 'left', clickCount = 1, modifiers = 0 } = {}) { return this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount, modifiers }); }
  async click(x, y, opts = {}) { await this.mouseMove(x, y); await this.mouseDown(x, y, opts); await this.mouseUp(x, y, opts); }
  /** One wheel event at (x,y); deltaY > 0 scrolls down. */
  async wheel(x, y, deltaX, deltaY, { modifiers = 0 } = {}) { return this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers }); }
  async key(key, { modifiers = 0, type = 'press' } = {}) {
    const d = keyDescriptor(key);
    const base = { modifiers, key: d.key, code: d.code, windowsVirtualKeyCode: d.vk, nativeVirtualKeyCode: d.vk };
    if (type === 'press' || type === 'down') await this.send('Input.dispatchKeyEvent', d.text ? { type: 'keyDown', ...base, text: d.text, unmodifiedText: d.text } : { type: 'rawKeyDown', ...base });
    if (type === 'press' || type === 'up') await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  /** True when the focused element takes text (input, textarea, select, contenteditable). */
  focusedEditable() {
    return this.evaluate(`(() => { const a = document.activeElement; return !!a && (/^(input|textarea|select)$/i.test(a.localName) || a.isContentEditable); })()`);
  }

  /**
   * Trusted typing that REFUSES to type into a page whose focus is not an editable element. Several trusted key events sent to a page without a focused
   * editable make a headless-new Chrome 154 renderer spin at 100 % CPU for good (reproduced on an empty page with no script),
   * which no test can recover from; so the failure is raised BEFORE any key is sent, as an ordinary failed check.
   */
  async typeText(text, { intervalMs = 25 } = {}) {
    if (!(await this.focusedEditable())) throw new Error('typeText: no editable element has focus; not sending trusted keys (a headless Chrome 154 renderer spins on them)');
    for (const ch of text) {
      if (/[a-z0-9 ]/i.test(ch)) await this.key(ch);
      else await this.send('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch, key: ch });
      await sleep(intervalMs);
    }
  }

  /** Install an in-page recorder of event arrival times (what the PAGE really saw; Chrome coalesces pointermove/wheel). */
  async installEventProbe(types = ['keydown', 'pointermove', 'wheel']) {
    return this.evaluate(`(()=>{ const rec = window.__hicProbe = {}; for (const t of ${JSON.stringify(types)}) { rec[t] = []; addEventListener(t, e => rec[t].push([performance.now(), e.timeStamp]), {capture:true, passive:true}); } return true; })()`);
  }
  /** @returns {Promise<Record<string,{n:number,intervalsMs:ReturnType<typeof stats>}>>} page-side arrival gaps per event type */
  async readEventProbe() {
    const rec = await this.evaluate('window.__hicProbe ?? {}'); const out = {};
    for (const [t, arr] of Object.entries(rec)) { const iv = []; for (let i = 1; i < arr.length; i++) iv.push(arr[i][0] - arr[i - 1][0]); out[t] = { n: arr.length, intervalsMs: stats(iv) }; }
    return out;
  }

  /** rAF cadence in the page: p50/p95 interval and implied Hz. The page MUST be foreground/focused. */
  async measureRaf({ frames = 180 } = {}) {
    const ts = await this.evaluate(`new Promise(res => { const a=[]; const f = t => { a.push(t); a.length < ${frames + 1} ? requestAnimationFrame(f) : res(a); }; requestAnimationFrame(f); })`);
    const iv = []; for (let i = 1; i < ts.length; i++) iv.push(ts[i] - ts[i - 1]);
    const s = stats(iv); return { ...s, hz: s.p50 ? 1000 / s.p50 : null, intervals: iv };
  }
  async close() { try { await this.conn.send('Target.closeTarget', { targetId: this.targetId }); } catch { /* already gone */ } }
}

const KEYS = {
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 }, Tab: { key: 'Tab', code: 'Tab', vk: 9 }, Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 }, ' ': { key: ' ', code: 'Space', vk: 32, text: ' ' }, PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 }, PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  End: { key: 'End', code: 'End', vk: 35 }, Home: { key: 'Home', code: 'Home', vk: 36 }, ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 }, ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 }, ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 }, Delete: { key: 'Delete', code: 'Delete', vk: 46 },
};
function keyDescriptor(k) {
  if (KEYS[k]) return KEYS[k];
  if (k.length === 1) {
    const up = k.toUpperCase();
    if (/[a-z]/i.test(k)) return { key: k, code: 'Key' + up, vk: up.charCodeAt(0), text: k };
    if (/[0-9]/.test(k)) return { key: k, code: 'Digit' + k, vk: k.charCodeAt(0), text: k };
    return { key: k, code: '', vk: k.charCodeAt(0), text: k };
  }
  throw new Error('unknown key ' + k);
}
export { paced };
