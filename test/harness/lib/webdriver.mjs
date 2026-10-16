// Cross-browser driver layer: W3C WebDriver (classic, HTTP) for Firefox (geckodriver) and Safari (safaridriver). Zero dependencies.
//
//   const s = await launchEngine({ engine: 'firefox' | 'safari', width: 1200, height: 900 });
//   await s.navigate(url); await s.evaluate('1 + 1');            // async expressions are awaited
//   const png = await s.screenshot();                             // viewport PNG (device pixels) -> Buffer
//   await s.click(x, y); await s.typeText('abc'); await s.key(KEYS.Tab); await s.wheel(x, y, 0, 300); await s.setWindowSize(1000, 800);
//   await s.close();                                              // ends the session, kills ONLY the processes this call started, removes the profile
//
// Firefox: a Firefox spawned as a CHILD of this process (geckodriver's normal launch) inherits our macOS privacy context (TCC): it cannot read its
// profile under ~/Downloads ("Profile Missing" dialog) and exits 1 with a profile under /tmp. It is therefore launched through LaunchServices
// (`open -n -a Firefox.app --args --marionette -profile <dir> -no-remote`) with a throwaway profile we create in os.tmpdir(), and geckodriver attaches with
// `--connect-existing`. The Marionette port is fixed per run through the profile's user.js.
// Safari: safaridriver needs `safaridriver --enable` (admin) and Develop > Allow Remote Automation, done once by an administrator of the machine; `probeSafari()` reports it.
// Safari Technology Preview ('stp', optional): its own safaridriver inside the app bundle and its own Develop > Allow Remote Automation; EngineUnavailable when missing.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { PROJECT_ROOT, sleep } from './util.mjs';

export const FIREFOX_APP = '/Applications/Firefox.app';
export const GECKODRIVER = resolve(PROJECT_ROOT, '.scratch/geckodriver-dl/geckodriver');
export const KEYS = Object.freeze({ Tab: '', Enter: '', Backspace: '', PageDown: '', PageUp: '', ArrowDown: '', Escape: '' });

const freePort = () => new Promise((ok, bad) => { const s = createServer(); s.once('error', bad); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const pgrep = (pattern) => (spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).stdout || '').split('\n').map(Number).filter((n) => n > 0 && n !== process.pid);
const killPids = (pids, sig = 'SIGTERM') => { for (const p of pids) { try { process.kill(p, sig); } catch { /* gone */ } } };

class WebDriverError extends Error {
  constructor(method, path, status, value) { super(`WebDriver ${method} ${path} -> HTTP ${status}: ${value?.error ?? ''} ${value?.message ?? JSON.stringify(value).slice(0, 300)}`); this.wd = value; }
}

/** One W3C session over HTTP. */
export class WdSession {
  constructor({ engine, base, id, caps, cleanup }) { Object.assign(this, { engine, base, id, caps, _cleanup: cleanup }); this.closed = false; }

  async cmd(method, path, body, { timeoutMs = 60000 } = {}) {
    const url = `${this.base}/session/${this.id}${path}`;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? (method === 'POST' ? '{}' : undefined) : JSON.stringify(body), signal: ctl.signal });
      const j = await r.json().catch(() => ({ value: null }));
      if (!r.ok) throw new WebDriverError(method, path, r.status, j.value);
      return j.value;
    } finally { clearTimeout(t); }
  }

  get version() { return `${this.caps.browserName} ${this.caps.browserVersion}`; }
  /** Safari, Safari Technology Preview or Mobile Safari (WebKit engines driven by a safaridriver) */
  get webkit() { return this.engine === 'safari' || this.engine === 'stp' || this.engine === 'ios'; }
  navigate(url) { return this.cmd('POST', '/url', { url }); }

  /** Evaluate an expression (a Promise is awaited). Page exceptions come back as a thrown Error with the page stack. */
  async evaluate(expr, { timeoutMs = 30000 } = {}) {
    const script = `const done = arguments[arguments.length - 1];
      Promise.resolve().then(() => (${expr})).then((v) => done({ ok: v === undefined ? null : v }), (e) => done({ err: String(e && (e.stack || e.message) || e) }));`;
    const v = await this.cmd('POST', '/execute/async', { script, args: [] }, { timeoutMs: timeoutMs + 5000 });
    if (v && 'err' in v) throw new Error(`page threw: ${v.err}`);
    return v?.ok ?? null;
  }

  async waitFor(expr, { timeoutMs = 10000, intervalMs = 50, what = expr } = {}) {
    const t0 = Date.now();
    for (;;) {
      const v = await this.evaluate(expr).catch((e) => ({ __err: e.message }));
      if (v && !v.__err) return v;
      if (Date.now() - t0 > timeoutMs) throw new Error(`timeout ${timeoutMs} ms waiting for ${what} (last: ${JSON.stringify(v)})`);
      await sleep(intervalMs);
    }
  }

  /** Viewport screenshot as a PNG Buffer (device pixels in both engines on a DPR-2 display). */
  async screenshot() { return Buffer.from(await this.cmd('GET', '/screenshot'), 'base64'); }

  async actions(list) { await this.cmd('POST', '/actions', { actions: list }); await this.cmd('DELETE', '/actions'); }

  /**
   * Where the page viewport sits in a screenshot, in screenshot pixels {x, y, k} (k = screenshot px per css px). Desktop: the viewport is the screenshot. Mobile Safari: the
   * screenshot is the whole device screen (status bar, toolbars), so a fixed magenta marker at the viewport origin is located in a screenshot.
   */
  async viewportOffset() {
    const { decodePng } = await import('./png.mjs');
    if (this.engine !== 'ios') { const iw = await this.evaluate('innerWidth'); const img = decodePng(await this.screenshot()); return { x: 0, y: 0, k: img.width / iw }; }
    await this.evaluate(`(() => { const m = document.createElement('div'); m.id = '__xb_marker'; m.style.cssText = 'position:fixed;left:0;top:0;width:6px;height:6px;background:#f0f;z-index:2147483647;pointer-events:none'; document.documentElement.appendChild(m); return new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok(true)))); })()`);
    const img = decodePng(await this.screenshot());
    await this.evaluate(`(document.getElementById('__xb_marker')?.remove(), new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok(true)))))`);
    const dpr = await this.evaluate('devicePixelRatio');
    for (let y = 0; y < img.height; y++) for (let x = 0; x < Math.min(img.width, 64); x++) {
      const i = (y * img.width + x) * 4; const d = img.data;
      if (d[i] > 230 && d[i + 1] < 40 && d[i + 2] > 230) return { x, y, k: dpr };
    }
    throw new Error('viewport marker not found in the screenshot');
  }

  /** Trusted touch tap at viewport CSS coordinates (pointerType touch). */
  tap(x, y, { holdMs = 60 } = {}) {
    return this.actions([{ type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' }, actions: [
      { type: 'pointerMove', duration: 0, origin: 'viewport', x: Math.round(x), y: Math.round(y) }, { type: 'pointerDown', button: 0 }, { type: 'pause', duration: holdMs }, { type: 'pointerUp', button: 0 }] }]);
  }

  /** Trusted touch press held for `ms` (the long-press selection gesture). */
  longPress(x, y, ms = 900) { return this.tap(x, y, { holdMs: ms }); }

  /** Trusted touch drag from (x1, y1) to (x2, y2) over `ms` (touch scroll when the start point is in a scroller). */
  swipe(x1, y1, x2, y2, ms = 400) {
    // Mobile Safari's driver hangs on a pointerMove with a duration (measured on the iOS 26.4 simulator): the drag is a series of instant moves with pauses
    const steps = 12, moves = [];
    for (let i = 1; i <= steps; i++) moves.push({ type: 'pointerMove', duration: 0, origin: 'viewport', x: Math.round(x1 + ((x2 - x1) * i) / steps), y: Math.round(y1 + ((y2 - y1) * i) / steps) }, { type: 'pause', duration: Math.round(ms / steps) });
    return this.actions([{ type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' }, actions: [
      { type: 'pointerMove', duration: 0, origin: 'viewport', x: Math.round(x1), y: Math.round(y1) }, { type: 'pointerDown', button: 0 }, { type: 'pause', duration: 50 },
      ...moves, { type: 'pause', duration: 50 }, { type: 'pointerUp', button: 0 }] }]);
  }

  /** Trusted primary click at viewport CSS coordinates. */
  click(x, y) {
    return this.actions([{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [
      { type: 'pointerMove', duration: 0, origin: 'viewport', x: Math.round(x), y: Math.round(y) }, { type: 'pointerDown', button: 0 }, { type: 'pause', duration: 30 }, { type: 'pointerUp', button: 0 }] }]);
  }

  move(x, y) { return this.actions([{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', duration: 0, origin: 'viewport', x: Math.round(x), y: Math.round(y) }] }]); }

  /** Type into the FOCUSED element, one key at a time with a pause between keys (the honest cadence is the driver's; reported by the caller). */
  typeText(text, { intervalMs = 40 } = {}) {
    const acts = [];
    for (const ch of text) { acts.push({ type: 'keyDown', value: ch }, { type: 'keyUp', value: ch }); if (intervalMs) acts.push({ type: 'pause', duration: intervalMs }); }
    return this.actions([{ type: 'key', id: 'kb', actions: acts }]);
  }

  key(k) { return this.typeText(k, { intervalMs: 0 }); }

  /** Trusted wheel at viewport CSS coordinates (WebDriver wheel input source). */
  wheel(x, y, deltaX, deltaY) {
    return this.actions([{ type: 'wheel', id: 'wheel', actions: [{ type: 'scroll', x: Math.round(x), y: Math.round(y), deltaX: Math.round(deltaX), deltaY: Math.round(deltaY), duration: 0, origin: 'viewport' }] }]);
  }

  setWindowSize(width, height) { return this.cmd('POST', '/window/rect', { width, height }); }
  windowRect() { return this.cmd('GET', '/window/rect'); }

  async close() {
    if (this.closed) return; this.closed = true;
    try { await this.cmd('DELETE', '', undefined, { timeoutMs: 15000 }); } catch { /* the browser may already be gone */ }
    await this._cleanup();
  }
}

async function newSession(base, capabilities, timeoutMs = 90000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${base}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ capabilities: { alwaysMatch: capabilities } }) });
      const j = await r.json();
      if (r.ok) return j.value;
      last = j.value;
      if (r.status !== 500 || !/connect|not ready|refused/i.test(String(last?.message))) break;
    } catch (e) { last = e.message; }
    await sleep(300);
  }
  throw new Error(`could not create a WebDriver session at ${base}: ${JSON.stringify(last)}`);
}

async function waitHttp(base, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { const r = await fetch(`${base}/status`); if (r.ok) return; } catch { /* not up */ } await sleep(100); }
  throw new Error(`driver at ${base} did not answer /status in ${timeoutMs} ms`);
}

/** Every process we start is registered here and killed on exit (watchdog), whatever happens to the run. */
const owned = new Set();
let hooked = false;
function own(pids) {
  for (const p of pids) owned.add(p);
  if (hooked) return; hooked = true;
  const reap = () => killPids([...owned], 'SIGKILL');
  process.on('exit', reap);
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { reap(); process.exit(130); });
}

const FIREFOX_PREFS = {
  'browser.shell.checkDefaultBrowser': false, 'browser.startup.homepage_override.mstone': 'ignore', 'browser.aboutwelcome.enabled': false,
  'datareporting.policy.dataSubmissionEnabled': false, 'toolkit.telemetry.reportingpolicy.firstRun': false, 'app.update.disabledForTesting': true,
  'browser.tabs.warnOnClose': false, 'browser.sessionstore.resume_from_crash': false, 'browser.startup.page': 0, 'startup.homepage_welcome_url': 'about:blank',
  'browser.newtabpage.enabled': false, 'browser.download.panel.shown': true, 'browser.uitour.enabled': false, 'extensions.update.enabled': false,
  'dom.disable_open_during_load': false, 'browser.translations.automaticallyPopup': false, 'sidebar.revamp': false, 'sidebar.verticalTabs': false,
};

async function launchFirefox({ app = FIREFOX_APP, prefs = {} } = {}) {
  if (!existsSync(GECKODRIVER)) throw new Error(`geckodriver missing at ${GECKODRIVER}: download the official release into .scratch/geckodriver-dl/ (docs/TEST-PLAN.md, G-xbrowser)`);
  const profile = mkdtempSync(join(tmpdir(), 'hic-xb-firefox-'));
  const mport = await freePort();
  const all = { ...FIREFOX_PREFS, ...prefs, 'marionette.port': mport };
  writeFileSync(join(profile, 'user.js'), Object.entries(all).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n') + '\n');
  const opened = spawnSync('open', ['-n', '-a', app, '--args', '--marionette', '-profile', profile, '-no-remote', 'about:blank'], { encoding: 'utf8' });
  if (opened.status !== 0) throw new Error(`open Firefox failed: ${opened.stderr}`);
  let ffPids = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 30000 && !existsSync(join(profile, 'MarionetteActivePort'))) { ffPids = pgrep(profile); own(ffPids); await sleep(200); }
  ffPids = pgrep(profile); own(ffPids);
  if (!existsSync(join(profile, 'MarionetteActivePort'))) { killPids(ffPids, 'SIGKILL'); rmSync(profile, { recursive: true, force: true }); throw new Error('Firefox did not open Marionette in 30 s'); }
  const dport = await freePort();
  const gd = spawn(GECKODRIVER, ['--port', String(dport), '--connect-existing', '--marionette-port', String(readFileSync(join(profile, 'MarionetteActivePort'), 'utf8').trim())], { stdio: ['ignore', 'ignore', 'pipe'] });
  own([gd.pid]);
  const base = `http://127.0.0.1:${dport}`;
  await waitHttp(base);
  const v = await newSession(base, { browserName: 'firefox' });
  const cleanup = async () => {
    killPids([gd.pid]);
    const pids = pgrep(profile); killPids(pids);
    for (let i = 0; i < 30 && pgrep(profile).length; i++) await sleep(100);
    killPids(pgrep(profile), 'SIGKILL');
    rmSync(profile, { recursive: true, force: true });
  };
  return new WdSession({ engine: 'firefox', base, id: v.sessionId, caps: { ...v.capabilities, profile, pids: pgrep(profile) }, cleanup });
}

const SAFARI_AUTOMATION = 'Safari.app/Contents/MacOS/Safari .*--automation';
export const STP_APP = '/Applications/Safari Technology Preview.app';
const STP_DRIVER = `${STP_APP}/Contents/MacOS/safaridriver`;
const STP_AUTOMATION = 'Safari Technology Preview.app/Contents/MacOS/Safari Technology Preview .*--automation';

/** An optional engine that cannot run on this machine (not installed, or remote automation not enabled): the caller reports it SKIPPED, not failed. */
export class EngineUnavailable extends Error {}

/** Can a safaridriver session be created? Returns {ok, reason}. Never changes a setting. */
export async function probeSafari() {
  const r = spawnSync('which', ['safaridriver'], { encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, reason: 'safaridriver not found' };
  try { const s = await launchSafari(); const version = s.version; await s.close(); return { ok: true, version }; } catch (e) { return { ok: false, reason: e.message }; }
}

/**
 * Safari (the system safaridriver) or Safari Technology Preview (its own safaridriver, an optional engine). Remote automation must have been allowed once by
 * the owner of the machine (Safari: `safaridriver --enable` + Develop > Allow Remote Automation; Technology Preview: its own Develop > Allow Remote Automation).
 * @param {{stp?: boolean}} [o]
 */
async function launchSafari({ stp = false } = {}) {
  const pattern = stp ? STP_AUTOMATION : SAFARI_AUTOMATION;
  if (stp && !existsSync(STP_DRIVER)) throw new EngineUnavailable(`Safari Technology Preview is not installed (${STP_APP})`);
  if (pgrep(pattern).length) throw new Error(`an automation ${stp ? 'Safari Technology Preview' : 'Safari'} is already running (not ours): refusing to start a second one`);
  const port = await freePort();
  const drv = spawn(stp ? STP_DRIVER : 'safaridriver', ['-p', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; drv.stderr.on('data', (d) => { stderr += d; });
  own([drv.pid]);
  const base = `http://127.0.0.1:${port}`;
  await waitHttp(base);
  let v;
  try { v = await newSession(base, { browserName: stp ? 'Safari Technology Preview' : 'safari' }, 30000); } catch (e) {
    killPids([drv.pid]);
    // a refused session can leave the browser it launched behind: stop the automation instance (never a normal window of the owner)
    for (let i = 0; i < 20 && pgrep(pattern).length; i++) { killPids(pgrep(pattern)); await sleep(150); }
    if (stp && /remote automation/i.test(e.message)) {
      throw new EngineUnavailable('remote automation is not allowed in Safari Technology Preview: open it, tick Settings > Advanced > Show features for web developers, then Develop > Allow Remote Automation (once, by the owner of the machine)');
    }
    throw new Error(`${e.message}${stderr ? ' / ' + stderr.trim() : ''}. Run \`safaridriver --enable\` once (admin password) and tick Safari > Settings > Advanced > Show features for web developers, then Develop > Allow Remote Automation.`);
  }
  const safariPids = pgrep(pattern); own(safariPids);
  const cleanup = async () => {
    killPids([drv.pid]);
    for (let i = 0; i < 30 && safariPids.some((p) => pgrep(pattern).includes(p)); i++) await sleep(100);
    killPids(safariPids.filter((p) => pgrep(pattern).includes(p)), 'SIGKILL');
  };
  return new WdSession({ engine: stp ? 'stp' : 'safari', base, id: v.sessionId, caps: { ...v.capabilities, pids: safariPids }, cleanup });
}

/**
 * Mobile Safari in an iOS Simulator through the system safaridriver (`platformName: iOS`, `safari:useSimulator`; needs a full Xcode). The device is booted when it is not,
 * and shut down again on close only when this call booted it. The simulator's Safari must allow remote automation (Settings > Safari > Advanced > Remote Automation, a setting of
 * the simulated device, written once with `defaults` inside it when missing). Screenshots are the whole device screen: `viewportOffset()` finds the page viewport in them.
 * @param {{udid: string}} o
 */
export async function launchIosSimulator({ udid }) {
  const simctl = (...a) => spawnSync('xcrun', ['simctl', ...a], { encoding: 'utf8' });
  const state = simctl('list', 'devices', '-j');
  const dev = Object.values(JSON.parse(state.stdout || '{}').devices ?? {}).flat().find((d) => d.udid === udid);
  if (!dev) throw new EngineUnavailable(`iOS Simulator device ${udid} not found (xcrun simctl list devices)`);
  const booted = dev.state === 'Booted';
  if (!booted) { const b = simctl('boot', udid); if (b.status !== 0 && !/current state: Booted/.test(b.stderr)) throw new Error(`simctl boot failed: ${b.stderr}`); simctl('bootstatus', udid, '-b'); }
  const shutdown = () => { if (!booted) simctl('shutdown', udid); };
  const auto = simctl('spawn', udid, 'defaults', 'read', 'com.apple.mobilesafari', 'RemoteAutomationEnabled');
  if (auto.stdout.trim() !== '1') simctl('spawn', udid, 'defaults', 'write', 'com.apple.mobilesafari', 'RemoteAutomationEnabled', '-bool', 'YES');
  const port = await freePort();
  const drv = spawn('safaridriver', ['-p', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; drv.stderr.on('data', (d) => { stderr += d; });
  own([drv.pid]);
  const base = `http://127.0.0.1:${port}`;
  await waitHttp(base);
  let v;
  try { v = await newSession(base, { browserName: 'Safari', platformName: 'iOS', 'safari:useSimulator': true, 'safari:deviceUDID': udid }, 180000); } catch (e) {
    killPids([drv.pid]); shutdown();
    // measured 2026-10-16 with the safaridriver of Safari 27.0.1 and of Technology Preview 254 (Xcode 27 ships none) and the iOS 27.0 simulator runtime: no session host
    // is offered (the iOS 26.4 and 18.1 runtimes pair), although remote automation and the developer extras were on inside it (com.apple.WebInspector,
    // com.apple.mobilesafari), the system Automation Mode was on and Mobile Safari was running and connected to the simulator's webinspectord: the driver never asks the
    // device to launch Safari. It needs a safaridriver that lists iOS 27 simulators
    if (/session hosts/.test(e.message)) throw new EngineUnavailable(`safaridriver found no Mobile Safari to automate in simulator ${udid} (${e.message.replace(/^.*message":"/, '').replace(/".*$/, '')})`);
    throw new Error(`${e.message}${stderr ? ' / ' + stderr.trim() : ''}`);
  }
  const cleanup = async () => { killPids([drv.pid]); shutdown(); };
  const s = new WdSession({ engine: 'ios', base, id: v.sessionId, caps: { ...v.capabilities, udid, bootedByUs: !booted }, cleanup });
  // measured: the simulator's Safari receives trusted keydown / keypress from WebDriver key actions but inserts no text (the plain DOM alike): typing is not drivable
  s.typeText = async () => false;
  return s;
}

/** @param {{engine:'firefox'|'safari'|'stp', width?:number, height?:number, prefs?:object}} o  'stp' = Safari Technology Preview (optional: EngineUnavailable when it cannot run) */
export async function launchEngine({ engine, width = 1200, height = 900, prefs } = {}) {
  const s = engine === 'firefox' ? await launchFirefox({ prefs }) : engine === 'safari' ? await launchSafari() : engine === 'stp' ? await launchSafari({ stp: true }) : null;
  if (!s) throw new Error(`unknown engine ${engine}`);
  try { await s.setWindowSize(width, height); } catch (e) { await s.close(); throw e; }
  return s;
}
