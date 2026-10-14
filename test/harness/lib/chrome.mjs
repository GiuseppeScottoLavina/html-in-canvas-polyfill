// Launch and tear down a headed Chrome that THIS process spawned, with a throwaway profile under <repo>/.profiles/.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, rmSync, createWriteStream, statSync, existsSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep, basename } from 'node:path';
import { CDPConnection } from './cdp-conn.mjs';
import { Page } from './page.mjs';
import { sleep, PROFILES_DIR } from './util.mjs';

export const CHROME_APPS = {
  stable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  canary: '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
};

/** Trace categories: `disabled-by-default-devtools.timeline` is REQUIRED for RunTask events. */
export const DEFAULT_TRACE_CATEGORIES = [
  'toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame',
  'v8', 'v8.execute', 'blink', 'blink.user_timing', 'cc', 'viz', 'benchmark',
];

/** Every live child we spawned, so an unexpected Node exit cannot orphan a browser. Only ever our own PIDs. */
const liveChildren = new Set();
process.once('exit', () => { for (const c of liveChildren) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });

async function freePort() {
  return new Promise((ok, bad) => {
    const s = createServer(); s.once('error', bad);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); });
  });
}

/** Throws unless `dir` is strictly inside <repo>/.profiles/ (after resolving symlinks of the existing prefix). */
export function assertProfilePath(dir) {
  const abs = resolve(dir);
  mkdirSync(PROFILES_DIR, { recursive: true });
  const root = realpathSync(PROFILES_DIR);
  let probe = abs; while (!existsSync(probe)) probe = dirname(probe);
  const real = resolve(realpathSync(probe), abs.slice(probe.length + 1));
  const inside = p => p.startsWith(root + sep) && p.length > root.length + 1;
  if (!inside(abs) && !inside(real)) throw new Error(`refusing userDataDir outside ${PROFILES_DIR}${sep}: ${abs}`);
  if (!inside(real)) throw new Error(`userDataDir resolves outside ${PROFILES_DIR}${sep} (symlink?): ${real}`);
  return abs;
}

/** Merge --enable-features/--disable-features given as separate args (Chrome honours only the LAST of each). */
function mergeFeatureFlags(base, extra) {
  const pick = (list, name) => list.filter(a => a.startsWith(`--${name}=`)).flatMap(a => a.slice(name.length + 3).split(','));
  const rest = extra.filter(a => !a.startsWith('--enable-features=') && !a.startsWith('--disable-features='));
  const dis = [...new Set([...pick(base, 'disable-features'), ...pick(extra, 'disable-features')])];
  const en = [...new Set([...pick(base, 'enable-features'), ...pick(extra, 'enable-features')])];
  return [...base.filter(a => !a.startsWith('--enable-features=') && !a.startsWith('--disable-features=')), ...rest,
    ...(dis.length ? [`--disable-features=${dis.join(',')}`] : []), ...(en.length ? [`--enable-features=${en.join(',')}`] : [])];
}

/**
 * @typedef {object} LaunchOptions
 * @property {'stable'|'canary'|string} [chrome='stable'] channel name or an absolute executable path
 * @property {string} [userDataDir] must be inside <repo>/.profiles/; default is a fresh `<name>-<pid>-<rand>` dir
 * @property {string} [name='run'] used for the default profile dir name
 * @property {[number,number]} [windowSize=[1400,900]] OUTER window size; inner is smaller by the browser chrome (use Page.setInnerSize for exact)
 * @property {[number,number]} [windowPosition=[0,0]]
 * @property {1|2|number} [dpr] --force-device-scale-factor (real, not emulated); omit for the display's native (2 on Retina)
 * @property {boolean} [nativeDrawElement=false] --enable-blink-features=CanvasDrawElement (native HTML-in-Canvas baseline mode)
 * @property {'default'|'hidden'|'overlay'|'classic'} [scrollbars='default'] 'hidden' = --hide-scrollbars; 'overlay'/'classic' try
 *           Overlay Scrollbar feature toggles (NOT guaranteed on macOS, where the system setting wins) - verify with
 *           `scrollbarProbe()` and use the F5 fixture (::-webkit-scrollbar) when you need classic bars for certain
 * @property {string[]} [extraArgs]
 * @property {string} [url='about:blank']
 * @property {string|null} [colorProfile='srgb'] --force-color-profile; keep 'srgb' for any pixel comparison
 */
/** @param {LaunchOptions} [opts] @returns {Promise<Browser>} */
export async function launchChrome(opts = {}) {
  const { chrome = 'stable', name = 'run', windowSize = [1400, 900], windowPosition = [0, 0], dpr, nativeDrawElement = false,
    scrollbars = 'default', extraArgs = [], url = 'about:blank', colorProfile = 'srgb' } = opts;
  const chromePath = CHROME_APPS[chrome] ?? chrome;
  if (!existsSync(chromePath)) throw new Error(`Chrome executable not found: ${chromePath}`);
  const userDataDir = assertProfilePath(opts.userDataDir ?? resolve(PROFILES_DIR, `${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`));
  mkdirSync(userDataDir, { recursive: true });
  const port = opts.port || await freePort();
  const scrollbarArgs = { default: [], hidden: ['--hide-scrollbars'], overlay: ['--enable-features=OverlayScrollbar'], classic: ['--disable-features=OverlayScrollbar'] }[scrollbars];
  if (!scrollbarArgs) throw new Error('unknown scrollbars mode ' + scrollbars);
  const base = [
    `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    '--no-first-run', '--no-default-browser-check', '--use-mock-keychain', '--password-store=basic',
    '--disable-sync', '--disable-component-update', '--disable-default-apps', '--disable-background-networking',
    '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication',
    // keep timers/rAF alive when another window covers ours (macOS occlusion tracking)
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    '--disable-ipc-flooding-protection', '--noerrdialogs',
    // Without sRGB the display profile shifts compositor screenshots by 1-8 levels vs canvas readback on EVERY pixel.
    ...(colorProfile ? [`--force-color-profile=${colorProfile}`] : []),
    `--window-size=${windowSize[0]},${windowSize[1]}`, `--window-position=${windowPosition[0]},${windowPosition[1]}`,
    ...(dpr ? [`--force-device-scale-factor=${dpr}`] : []),
    ...(nativeDrawElement ? ['--enable-blink-features=CanvasDrawElement'] : []),
  ];
  const args = [...mergeFeatureFlags(base, [...scrollbarArgs, ...extraArgs]), url];
  const child = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
  liveChildren.add(child);
  let stderr = ''; child.stderr.on('data', d => { stderr += d; if (stderr.length > 200000) stderr = stderr.slice(-100000); });
  let exited = false; child.once('exit', () => { exited = true; liveChildren.delete(child); });
  const browser = new Browser({ child, port, userDataDir, args, chromePath, options: { ...opts, chrome, dpr, nativeDrawElement, scrollbars, windowSize },
    getStderr: () => stderr, isExited: () => exited });
  const deadline = Date.now() + 20000; let ver;
  while (Date.now() < deadline) {
    if (exited) throw new Error('Chrome exited early. stderr: ' + stderr.slice(-2000));
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(150); }
  }
  if (!ver) { await browser.close().catch(() => {}); throw new Error('DevTools endpoint did not come up. stderr: ' + stderr.slice(-2000)); }
  browser.version = ver;
  browser.conn = await new CDPConnection(ver.webSocketDebuggerUrl).open();
  return browser;
}

export class Browser {
  constructor(o) { Object.assign(this, o); this.pid = o.child.pid; /** @type {Page[]} */ this.pages = []; }

  /** Page for the first not-yet-wrapped tab (reuseFirst) or a freshly created one. */
  async newPage({ reuseFirst = true, url = 'about:blank' } = {}) {
    let targetId;
    if (reuseFirst) {
      const { targetInfos } = await this.conn.send('Target.getTargets');
      targetId = targetInfos.find(t => t.type === 'page' && !this.pages.some(p => p.targetId === t.targetId))?.targetId;
    }
    if (!targetId) ({ targetId } = await this.conn.send('Target.createTarget', { url }));
    const { sessionId } = await this.conn.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, targetId, sessionId);
    await page.init();
    this.pages.push(page);
    return page;
  }

  /** Immediate SIGKILL of this browser and every process of its profile (renderers included), for a browser whose renderer is stuck. Own processes only (matched by the unique --user-data-dir). */
  kill() {
    try {
      const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      for (const l of out.split('\n')) if (l.includes(`--user-data-dir=${this.userDataDir}`)) { const pid = Number(l.trim().split(/\s+/)[0]); if (pid && pid !== process.pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
    } catch { /* ps unavailable */ }
    try { this.child.kill('SIGKILL'); } catch { /* gone */ }
  }

  /** Graceful Browser.close, then SIGTERM, then SIGKILL on the spawned PID only; then sweep stragglers whose command line
   *  contains our unique --user-data-dir (never anything else). Optionally delete the profile. Returns a report. */
  async close({ rmProfile = true } = {}) {
    const report = { pid: this.pid, graceful: false, sigterm: false, sigkill: false, stragglersKilled: [], remaining: [] };
    const waitExit = async ms => { const t = Date.now(); while (!this.isExited() && Date.now() - t < ms) await sleep(50); return this.isExited(); };
    try { await Promise.race([this.conn?.send('Browser.close'), sleep(2000)]); } catch { /* connection may drop */ }
    if (await waitExit(5000)) report.graceful = true;
    else {
      try { this.child.kill('SIGTERM'); } catch { /* gone */ } report.sigterm = true;
      if (!(await waitExit(4000))) { try { this.child.kill('SIGKILL'); } catch { /* gone */ } report.sigkill = true; await waitExit(3000); }
    }
    this.conn?.close();
    await sleep(300);
    const mine = () => {
      try {
        const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        return out.split('\n').map(l => l.trim()).filter(l => l.includes(`--user-data-dir=${this.userDataDir}`)).map(l => Number(l.split(/\s+/)[0])).filter(p => p && p !== process.pid);
      } catch { return []; }
    };
    for (let i = 0; i < 3 && mine().length; i++) {
      for (const pid of mine()) { try { process.kill(pid, 'SIGTERM'); report.stragglersKilled.push(pid); } catch { /* gone */ } }
      await sleep(1000);
    }
    for (const pid of mine()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    await sleep(300);
    report.remaining = mine();
    if (rmProfile) {
      // belt and braces: never delete anything that is not a profile dir we created
      assertProfilePath(this.userDataDir);
      try { rmSync(this.userDataDir, { recursive: true, force: true }); report.profileRemoved = true; } catch { report.profileRemoved = false; }
    }
    return report;
  }

  /** Start a browser-level trace. Default categories cover RunTask, V8, blink, cc, viz and user timing. */
  async traceStart({ categories = DEFAULT_TRACE_CATEGORIES, recordMode = 'recordAsMuchAsPossible' } = {}) {
    await this.conn.send('Tracing.start', { traceConfig: { recordMode, includedCategories: categories }, transferMode: 'ReturnAsStream', streamFormat: 'json' });
    this._traceT0 = Date.now();
  }

  /** Stop the trace and write the raw JSON to `file`. @returns {Promise<{file:string,bytes:number,ms:number}>} */
  async traceStop(file) {
    const done = this.conn.waitFor('Tracing.tracingComplete', { timeout: 120000 });
    await this.conn.send('Tracing.end');
    const { stream } = await done;
    mkdirSync(dirname(file), { recursive: true });
    const out = createWriteStream(file);
    for (;;) {
      // NB: 4 MB chunks make the CDP websocket drop (Chrome 154 + Node 24); stay <= 1 MB.
      const r = await this.conn.send('IO.read', { handle: stream, size: 512 * 1024 });
      const chunk = r.base64Encoded ? Buffer.from(r.data, 'base64') : Buffer.from(r.data);
      if (!out.write(chunk)) await new Promise(ok => out.once('drain', ok));
      if (r.eof) break;
    }
    await new Promise(ok => out.end(ok));
    await this.conn.send('IO.close', { handle: stream });
    return { file, bytes: statSync(file).size, ms: Date.now() - (this._traceT0 ?? Date.now()) };
  }

  async info() {
    const v = await this.conn.send('Browser.getVersion');
    let sys = null; try { sys = await this.conn.send('SystemInfo.getInfo'); } catch { /* optional */ }
    return { ...v, gpu: sys?.gpu?.devices, featureStatus: sys?.gpu?.featureStatus, commandLine: sys?.commandLine };
  }
}

export { basename };
