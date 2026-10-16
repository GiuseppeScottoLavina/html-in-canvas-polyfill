// Android Emulator driver of the mobile gate (test/mobile/run.mjs): the emulator is started headless from an existing AVD, Chrome is driven through the Chrome DevTools
// Protocol over `adb forward ... localabstract:chrome_devtools_remote`, the page reaches the Mac's test server through `adb reverse`. Zero dependencies.
//
//   const s = await launchAndroid({ avd, avdHome, serverPorts }); await s.navigate(url); await s.evaluate('1 + 1'); const old = await openPackage(s, STOCK_CHROME); await old.close(); await s.close();
//
// Input: `tap` / `swipe` are CDP touch events (trusted, pointerType touch, routed by the compositor like a finger: gesture scroll, click, focus); `osTap`, `longPress`,
// `typeText` and `rotate` go through the OS (`adb shell input` taps / swipes and the IME, `settings put system user_rotation`). `close()` stops only what this call started.
//
// Browser: the newest installed of BROWSERS (Chromium's ChromePublic.apk `org.chromium.chrome`, installed from a Chromium snapshot with `adb install`, and the image's own
// Chrome `com.android.chrome`), or `pkg`. Both serve the same DevTools socket name, so only one runs at a time (`openPackage` stops the other). Their first-run screens
// (sign-in, notifications) are dismissed through the OS (uiautomator), never with command-line flags.
//
// STAND-IN (only when no installed browser is >= 130): the system image's own Chrome is 124 (no Play sign-in to update it), below the gate's 130 and without shipped anchor
// positioning. With `standIn`, Chrome runs with `--enable-blink-features=CSSAnchorPositioning` (debug command-line file) and the tab reports a Chromium 130 user agent (CDP
// override), so the polyfill path can be exercised on a real Android Chromium engine. Every result of such a run is labelled stand-in; it is NOT a verification of Chrome >= 130.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { sleep } from '../harness/lib/util.mjs';

const SDK = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), 'Library/Android/sdk');
const ADB = join(SDK, 'platform-tools/adb');
const EMULATOR = join(SDK, 'emulator/emulator');
export const STOCK_CHROME = 'com.android.chrome';
export const CHROMIUM = 'org.chromium.chrome';
const BROWSERS = [CHROMIUM, STOCK_CHROME];
const FLAGS_FILE = '/data/local/tmp/chrome-command-line';
export const STAND_IN_MAJOR = 130;

const freePort = () => new Promise((ok, bad) => { const s = createServer(); s.once('error', bad); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

export class AndroidUnavailable extends Error {}

/** One CDP call on the browser endpoint. @param {number} cdpPort @param {string} method @param {object} params */
async function browserCall(cdpPort, method, params) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  try {
    await new Promise((ok, bad) => { ws.addEventListener('open', ok); ws.addEventListener('error', bad); });
    return await new Promise((ok, bad) => {
      const t = setTimeout(() => bad(new Error(`CDP ${method} timed out`)), 15000);
      ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id === 1) { clearTimeout(t); if (m.error) bad(new Error(`CDP ${method}: ${m.error.message}`)); else ok(m.result); } });
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally { try { ws.close(); } catch { /* gone */ } }
}

/** A new tab of our own: `PUT /json/new` (Chrome 124), else `Target.createTarget` (Chromium 158 answers /json/new with "Could not create new page"). @param {number} cdpPort */
async function newTab(cdpPort) {
  const r = await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' });
  const text = await r.text();
  try { const t = JSON.parse(text); if (t.webSocketDebuggerUrl) return t; } catch { /* not JSON */ }
  const { targetId } = await browserCall(cdpPort, 'Target.createTarget', { url: 'about:blank' });
  return { id: targetId, webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/${targetId}` };
}
/** @param {number} cdpPort @param {string} id */
async function closeTab(cdpPort, id) {
  try { await browserCall(cdpPort, 'Target.closeTarget', { targetId: id }); } catch { try { await fetch(`http://127.0.0.1:${cdpPort}/json/close/${id}`); } catch { /* gone */ } }
}

/** @param {string} serial @param {string[]} args */
function adb(serial, ...args) {
  const r = spawnSync(ADB, ['-s', serial, ...args], { encoding: 'utf8', timeout: 60000 });
  return (r.stdout ?? '').replace(/\r/g, '').trim();
}

class AndroidSession {
  constructor(o) { Object.assign(this, o); this.engine = 'android'; this.webkit = false; this.closed = false; this.nextId = 0; this.pending = new Map(); this.events = []; }

  get version() { return `${this.pkg === CHROMIUM ? 'Chromium' : 'Chrome'} ${this.chromeVersion} (${this.pkg})${this.standIn ? ` (stand-in: UA ${STAND_IN_MAJOR}, anchor flag)` : ''}`; }

  send(method, params = {}) {
    return new Promise((ok, bad) => {
      const id = ++this.nextId;
      const t = setTimeout(() => { this.pending.delete(id); bad(new Error(`CDP ${method} timed out`)); }, 60000);
      this.pending.set(id, (m) => { clearTimeout(t); if (m.error) bad(new Error(`CDP ${method}: ${m.error.message}`)); else ok(m.result); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async navigate(url) {
    this.events = this.events.filter((e) => e !== 'load');
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 300 && !this.events.includes('load'); i++) await sleep(50);
  }

  async evaluate(expr, { timeoutMs = 30000 } = {}) {
    const r = await Promise.race([
      this.send('Runtime.evaluate', { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true }),
      sleep(timeoutMs).then(() => { throw new Error(`evaluate timed out after ${timeoutMs} ms`); }),
    ]);
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value ?? null;
  }

  async waitFor(expr, { timeoutMs = 10000, intervalMs = 100 } = {}) {
    const t0 = Date.now();
    for (;;) {
      const v = await this.evaluate(expr).catch(() => null);
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) throw new Error(`timeout ${timeoutMs} ms waiting for ${expr}`);
      await sleep(intervalMs);
    }
  }

  /** The layout viewport as a PNG (device pixels). */
  async screenshot() { return Buffer.from((await this.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'); }
  async viewportOffset() { return { x: 0, y: 0, k: await this.evaluate('devicePixelRatio') }; }

  /** A finger tap at viewport css coordinates (CDP touch: trusted pointerdown/touchstart/pointerup/touchend/click on the target). */
  async tap(x, y, { holdMs = 60 } = {}) {
    await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await sleep(holdMs);
    await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  /** A finger drag (touch scroll when it starts in a scroller). */
  async swipe(x1, y1, x2, y2, ms = 400) {
    const steps = Math.max(4, Math.round(ms / 16));
    await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y: y1 }] });
    for (let i = 1; i <= steps; i++) {
      await this.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x1 + ((x2 - x1) * i) / steps, y: y1 + ((y2 - y1) * i) / steps }] });
      await sleep(ms / steps);
    }
    await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  /** Where the viewport sits on the screen, from an OS tap at a known screen point in the page's left margin (the toolbar hides on scroll: measured before each OS gesture). */
  async calibrate() {
    await this.evaluate(`(window.__xbCal = null, addEventListener('touchstart', (e) => { window.__xbCal = [e.touches[0].clientX, e.touches[0].clientY]; }, { capture: true, once: true }), true)`);
    const dpr = await this.evaluate('devicePixelRatio');
    const sx = 3, sy = 1200;
    adb(this.serial, 'shell', 'input', 'tap', String(sx), String(sy));
    const c = await this.waitFor('window.__xbCal', { timeoutMs: 5000 });
    return { left: sx - c[0] * dpr, top: sy - c[1] * dpr, dpr };
  }

  /** An OS-level touch (adb input tap) at viewport css coordinates. */
  async osTap(x, y) { const c = await this.calibrate(); await sleep(400); adb(this.serial, 'shell', 'input', 'tap', String(Math.round(c.left + x * c.dpr)), String(Math.round(c.top + y * c.dpr))); }

  /** An OS-level long press (selection gesture) at viewport css coordinates. */
  async longPress(x, y, ms = 900) {
    const c = await this.calibrate(); await sleep(400);
    const px = String(Math.round(c.left + x * c.dpr)), py = String(Math.round(c.top + y * c.dpr));
    adb(this.serial, 'shell', 'input', 'swipe', px, py, px, py, String(ms));
  }

  /** Type through the IME into the focused field (adb input text: real key events from the input method). */
  async typeText(text) { adb(this.serial, 'shell', 'input', 'text', text.replace(/ /g, '%s')); return true; }

  /** Landscape or portrait through the OS rotation setting. */
  async rotate(landscape) {
    adb(this.serial, 'shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
    adb(this.serial, 'shell', 'settings', 'put', 'system', 'user_rotation', landscape ? '1' : '0');
    return true;
  }

  async hideKeyboard() { adb(this.serial, 'shell', 'input', 'keyevent', '111'); }

  async close() {
    if (this.closed) return; this.closed = true;
    try { this.ws.close(); } catch { /* gone */ }
    await closeTab(this.cdpPort, this.targetId);
    adb(this.serial, 'forward', '--remove', `tcp:${this.cdpPort}`);
    adb(this.serial, 'reverse', '--remove-all');
    if (this.standIn) { adb(this.serial, 'shell', 'rm', '-f', FLAGS_FILE); adb(this.serial, 'shell', 'am', 'clear-debug-app'); }
    if (!this.ownEmulator) return;
    adb(this.serial, 'shell', 'settings', 'put', 'system', 'user_rotation', '0');
    adb(this.serial, 'emu', 'kill');
    for (let i = 0; i < 60 && this.emulator.exitCode === null; i++) await sleep(500);
    if (this.emulator.exitCode === null) this.emulator.kill('SIGKILL');
  }
}

/** The installed version of a browser package, or null. @param {string} serial @param {string} pkg */
function versionOf(serial, pkg) { return /versionName=([\d.]+)/.exec(adb(serial, 'shell', 'dumpsys', 'package', pkg))?.[1] ?? null; }

/** The installed browsers, newest first. @param {string} serial */
export function installedBrowsers(serial) {
  return BROWSERS.map((pkg) => ({ pkg, version: versionOf(serial, pkg) })).filter((b) => b.version).map((b) => ({ ...b, major: Number(b.version.split('.')[0]) })).sort((a, b) => b.major - a.major);
}

/** Labels of the first-run and permission screens a fresh browser profile shows (sign-in, terms, notifications); tapped through the OS until DevTools answers. */
const FIRST_RUN_BUTTONS = /^(Stay signed out|Use without an account|No thanks|No, thanks|Accept & continue|Not now|Skip|Got it)$/i;
/** Tap one first-run button found in the current window (uiautomator dump), if any. @param {string} serial @returns {boolean} */
function dismissFirstRun(serial) {
  adb(serial, 'shell', 'uiautomator', 'dump', '/data/local/tmp/hic-ui.xml');
  const xml = adb(serial, 'shell', 'cat', '/data/local/tmp/hic-ui.xml');
  for (const m of xml.matchAll(/<node [^>]*?text="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)) {
    if (!FIRST_RUN_BUTTONS.test(m[1].replace(/&amp;/g, '&'))) continue;
    adb(serial, 'shell', 'input', 'tap', String((+m[2] + +m[4]) >> 1), String((+m[3] + +m[5]) >> 1));
    return true;
  }
  return false;
}

/** The emulator's top resumed activity. @param {string} serial */
const topActivity = (serial) => /topResumedActivity=\S+ \S+ (\S+)/.exec(adb(serial, 'shell', 'dumpsys', 'activity', 'activities'))?.[1] ?? '';

/**
 * Open a tab of our own in `pkg` on a booted emulator and attach CDP (any other known browser is stopped first: they share the DevTools socket name).
 * @param {{serial: string, pkg: string, serverPorts: number[], standIn?: boolean}} o
 */
async function openBrowser({ serial, pkg, serverPorts, standIn = false }) {
  const chromeVersion = versionOf(serial, pkg);
  if (!chromeVersion) throw new AndroidUnavailable(`${pkg} is not installed on the AVD`);
  const major = Number(chromeVersion.split('.')[0]);
  for (const b of BROWSERS) adb(serial, 'shell', 'am', 'force-stop', b);
  standIn = standIn && major < STAND_IN_MAJOR && pkg === STOCK_CHROME;
  if (standIn) {
    adb(serial, 'shell', `echo "_ --enable-blink-features=CSSAnchorPositioning --disable-fre --no-default-browser-check --no-first-run" > ${FLAGS_FILE}`);
    adb(serial, 'shell', 'am', 'set-debug-app', '--persistent', pkg);
  } else { adb(serial, 'shell', 'rm', '-f', FLAGS_FILE); adb(serial, 'shell', 'am', 'clear-debug-app'); }
  for (const p of serverPorts) adb(serial, 'reverse', `tcp:${p}`, `tcp:${p}`);
  adb(serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'about:blank', '-n', `${pkg}/com.google.android.apps.chrome.Main`);
  const cdpPort = await freePort();
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500);
    adb(serial, 'forward', `tcp:${cdpPort}`, 'localabstract:chrome_devtools_remote');
    try { target = await newTab(cdpPort); } catch { target = null; }
    // a fresh profile opens DevTools only after its first-run screens
    if (!target && i % 4 === 3 && /firstrun|FirstRun/.test(topActivity(serial))) dismissFirstRun(serial);
  }
  if (!target?.webSocketDebuggerUrl) throw new Error(`${pkg}: Chrome DevTools did not answer over adb forward (top activity ${topActivity(serial)})`);
  await sleep(1500);
  for (let i = 0; i < 4 && dismissFirstRun(serial); i++) await sleep(1500); // the notification prompt over the first tab would take the OS taps
  const s = new AndroidSession({ serial, pkg, ownEmulator: false, chromeVersion, chromeMajor: major, standIn, cdpPort, targetId: target.id });
  s.ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { s.ws.addEventListener('open', ok); s.ws.addEventListener('error', bad); });
  s.ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && s.pending.has(m.id)) { s.pending.get(m.id)(m); s.pending.delete(m.id); } else if (m.method === 'Page.loadEventFired') s.events.push('load');
  });
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  if (s.standIn) {
    const ua = (await s.evaluate('navigator.userAgent')).replace(/Chrome\/[\d.]+/, `Chrome/${STAND_IN_MAJOR}.0.0.0`);
    await s.send('Emulation.setUserAgentOverride', { userAgent: ua, userAgentMetadata: { brands: [{ brand: 'Chromium', version: String(STAND_IN_MAJOR) }, { brand: 'Google Chrome', version: String(STAND_IN_MAJOR) }], fullVersion: `${STAND_IN_MAJOR}.0.0.0`, platform: 'Android', platformVersion: '15', architecture: '', model: '', mobile: true } });
  }
  s.serverPorts = serverPorts;
  return s;
}

/**
 * Start the AVD headless, open a tab of our own in the newest installed browser (or `pkg`) and attach CDP. The stand-in applies only when that browser is below 130.
 * @param {{avd?: string, avdHome?: string, port?: number, serverPorts: number[], standIn?: boolean, pkg?: string}} o
 */
export async function launchAndroid({ avd = 'hicmobile', avdHome = process.env.ANDROID_AVD_HOME, port = 5584, serverPorts, standIn = false, pkg }) {
  if (!existsSync(ADB) || !existsSync(EMULATOR)) throw new AndroidUnavailable(`Android SDK not found at ${SDK} (platform-tools and emulator are needed)`);
  const env = { ...process.env, ...(avdHome ? { ANDROID_AVD_HOME: avdHome } : {}) };
  const avds = spawnSync(EMULATOR, ['-list-avds'], { encoding: 'utf8', env }).stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!avds.includes(avd)) throw new AndroidUnavailable(`AVD "${avd}" not found (${avds.join(', ') || 'none'}; set ANDROID_AVD_HOME or --avd)`);
  const serial = `emulator-${port}`;
  if (spawnSync(ADB, ['devices'], { encoding: 'utf8' }).stdout.includes(serial)) throw new Error(`${serial} is already running (not ours): refusing to drive it`);
  const emulator = spawn(EMULATOR, ['-avd', avd, '-no-window', '-no-snapshot', '-no-boot-anim', '-no-audio', '-gpu', 'swiftshader_indirect', '-port', String(port)], { env, stdio: 'ignore' });
  const kill = () => { try { emulator.kill('SIGKILL'); } catch { /* gone */ } };
  process.on('exit', kill);
  try {
    let booted = false;
    for (let i = 0; i < 120 && !booted; i++) { await sleep(2000); booted = adb(serial, 'shell', 'getprop', 'sys.boot_completed') === '1'; }
    if (!booted) throw new Error(`${serial} did not boot in 4 min`);
    const browsers = installedBrowsers(serial);
    const chosen = pkg ?? browsers[0]?.pkg;
    if (!chosen) throw new AndroidUnavailable(`no browser installed on the AVD (${BROWSERS.join(', ')})`);
    const s = await openBrowser({ serial, pkg: chosen, serverPorts, standIn });
    Object.assign(s, { emulator, ownEmulator: true, browsers });
    return s;
  } catch (e) { adb(serial, 'emu', 'kill'); await sleep(1500); kill(); throw e; }
}

/** A plain session WITHOUT the stand-in override on an already-launched emulator (the refusal scenario): a second tab, real user agent. */
export async function plainTab(s) {
  const target = await newTab(s.cdpPort);
  const t = new AndroidSession({ serial: s.serial, pkg: s.pkg, ownEmulator: false, chromeVersion: s.chromeVersion, chromeMajor: s.chromeMajor, standIn: false, cdpPort: s.cdpPort, targetId: target.id });
  t.ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { t.ws.addEventListener('open', ok); t.ws.addEventListener('error', bad); });
  t.ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && t.pending.has(m.id)) { t.pending.get(m.id)(m); t.pending.delete(m.id); } else if (m.method === 'Page.loadEventFired') t.events.push('load'); });
  await t.send('Page.enable'); await t.send('Runtime.enable');
  t.close = async () => { try { t.ws.close(); } catch { /* gone */ } await closeTab(s.cdpPort, target.id); };
  return t;
}

/**
 * Another installed browser on the same emulator (the refusal on the image's own Chrome 124 after a Chromium run): the current browser is stopped (shared DevTools socket);
 * its session `s` must not be used afterwards, and `close()` of the returned session leaves the emulator to `s.close()`.
 * @param {AndroidSession} s @param {string} pkg
 */
export async function openPackage(s, pkg) {
  try { s.ws.close(); } catch { /* gone */ }
  adb(s.serial, 'forward', '--remove', `tcp:${s.cdpPort}`);
  return openBrowser({ serial: s.serial, pkg, serverPorts: s.serverPorts ?? [] });
}
