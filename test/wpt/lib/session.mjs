// One Chrome per configuration, driven over CDP: launch with the WPT host rules, optional polyfill injection into every
// new document, the `__wptDrive` input binding of testdriver-vendor.js, crash/dialog handling and a resilient test tab.
import { readFileSync } from 'node:fs';
import { launchChrome } from '../../harness/lib/chrome.mjs';
import { HOST_RULES } from '../server.mjs';
import { PROJECT_ROOT, sleep } from '../../harness/lib/util.mjs';

export const CONFIGS = {
  A: { id: 'A', role: 'oracle', chrome: 'canary', nativeDrawElement: true, polyfill: false, label: 'Chrome Canary, native (CanvasDrawElement)' },
  B: { id: 'B', role: 'subject', chrome: 'stable', nativeDrawElement: false, polyfill: true, label: 'Chrome stable + polyfill' },
  C: { id: 'C', role: 'control', chrome: 'stable', nativeDrawElement: false, polyfill: false, label: 'Chrome stable, no polyfill' },
};
export const VIEWPORT = { width: 800, height: 600 };

async function handleBinding(page, p) {
  if (p.name !== '__wptDrive') return;
  let m; try { m = JSON.parse(p.payload); } catch { return; }
  let err = '';
  try {
    const base = { x: m.x, y: m.y, button: m.button ?? 'left', clickCount: m.clickCount ?? 1 };
    if (m.t === 'move') await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, buttons: m.buttons ?? 0 });
    else if (m.t === 'down') await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 });
    else if (m.t === 'up') await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
    else if (m.t === 'wheel') await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: m.x, y: m.y, deltaX: m.dx, deltaY: m.dy });
  } catch (e) { err = String(e?.message ?? e); }
  await page.send('Runtime.evaluate', { expression: `window.__wptDriveDone && window.__wptDriveDone(${m.id}, ${JSON.stringify(err)})` }).catch(() => {});
}

export class Session {
  /** `scrollbars`: 'hidden' (default, --hide-scrollbars: screenshots without scrollbars) or 'default' for the tests that render author-styled scrollbars (inventory `scrollbars`). */
  constructor(config, { polyfillFile = resolveDist(), name, scrollbars = 'hidden' } = {}) { this.config = config; this.polyfillFile = polyfillFile; this.name = name ?? `wpt-${config.id}`; this.scrollbars = scrollbars; this.crashed = false; }

  async start() {
    this.browser = await launchChrome({
      chrome: this.config.chrome, name: this.name, nativeDrawElement: this.config.nativeDrawElement, dpr: 1, scrollbars: this.scrollbars,
      windowSize: [VIEWPORT.width + 40, VIEWPORT.height + 140],
      extraArgs: ['--ignore-certificate-errors', `--host-resolver-rules=${HOST_RULES}`, '--autoplay-policy=no-user-gesture-required',
        '--disable-popup-blocking', '--force-prefers-no-reduced-motion'],
    });
    this.browser.conn.sendTimeoutMs = 30000;
    await this.newTab();
    return this;
  }

  async newTab() {
    if (this.page) await this.page.close().catch(() => {});
    this.browser.pages = [];
    const page = this.page = await this.browser.newPage({ reuseFirst: false });
    this.crashed = false;
    page.on('Inspector.targetCrashed', () => { this.crashed = true; });
    page.on('Page.javascriptDialogOpening', () => { page.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); });
    page.on('Runtime.bindingCalled', p => handleBinding(page, p));
    await page.send('Runtime.addBinding', { name: '__wptDrive' });
    if (this.config.polyfill) await this.injectPolyfill(page);
    await page.bringToFront().catch(() => {});
    await page.setInnerSize(VIEWPORT.width, VIEWPORT.height).catch(() => {});
    return page;
  }

  /** The polyfill runs first in every new document: the page, same-process frames, and (auto-attach) cross-site frames. */
  async injectPolyfill(page) {
    const source = readFileSync(this.polyfillFile, 'utf8');
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source });
    const conn = page.conn;
    conn.on('Target.attachedToTarget', async p => {
      const sid = p.sessionId;
      try {
        await conn.send('Page.enable', {}, sid);
        await conn.send('Page.addScriptToEvaluateOnNewDocument', { source }, sid);
        await conn.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid);
      } catch { /* the frame went away */ }
      conn.send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
    }, page.sessionId);
    await page.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }

  /** Chrome version string and, for the subject, the polyfill file. */
  info() { return { id: this.config.id, role: this.config.role, label: this.config.label, version: this.browser.version.Browser, polyfill: this.config.polyfill ? this.polyfillFile : null }; }

  async blank() {
    await this.page.send('Page.navigate', { url: 'about:blank' }).catch(() => {});
    await sleep(30);
    this.page.clearLogs();
  }

  async stop() { try { return await this.browser?.close(); } catch { this.browser?.kill(); return null; } }
}

function resolveDist() { return `${PROJECT_ROOT}/dist/hic-live-polyfill.iife.js`; }
