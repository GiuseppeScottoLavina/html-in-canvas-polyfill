// The pointer guard (Page.installPointerGuard) and the parked OS pointer (os-pointer.mjs): input the harness sent is never foreign, input it did not send is
// reported (positive controls: a CDP event sent around the recording Page.send, and on macOS the REAL resting pointer delivered by a clipped screenshot).
import { osPointer, parkOsPointer } from '../lib/os-pointer.mjs';
import { sleep } from '../lib/util.mjs';
import { execFileSync } from 'node:child_process';

export async function run({ check, info, browser, srv }) {
  info('launch: the OS pointer', browser.pointerPark);
  const page = await browser.newPage({ reuseFirst: false });
  const fullscreenCheck = async () => {
    // a fullscreen page covers its display (the parked pointer is over it): input then is recorded apart and never judged
    const fs = await page.evaluate('document.documentElement.requestFullscreen().then(() => !!document.fullscreenElement, () => false)');
    if (fs) {
      await sleep(500); page.foreignPointer.length = 0; page.fullscreenPointer.length = 0;
      await page.conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 345, y: 111, button: 'none' }, page.sessionId);
      await sleep(150); await page.flushPointerGuard();
      check('pointer guard: input while the page is fullscreen is recorded apart, not as foreign', page.foreignPointer.length === 0 && page.fullscreenPointer.some((f) => f.x === 345 && f.y === 111), { foreign: page.foreignPointer, fullscreen: page.fullscreenPointer });
      await page.evaluate('document.exitFullscreen().then(() => true, () => true)'); await sleep(1500);
      page.foreignPointer.length = 0;
    } else info('fullscreen guard check', 'skipped: requestFullscreen refused');
  };
  try {
    await page.installPointerGuard();
    await page.navigate(`${srv.url}/test/harness/selftest-fixture/app.html`);
    await page.waitForFunction('window.__APP_READY');
    await page.requireForeground('pointer section');
    await page.mouseMove(120.5, 210.25); await page.click(400, 40); await page.wheel(170, 145, 0, 40);
    await sleep(150);
    check('pointer guard: moves, clicks and wheels the harness sent are not foreign', (await page.flushPointerGuard()).length === 0, page.foreignPointer);

    // positive control: the same kind of trusted event, sent around Page.send (as the OS would deliver it)
    await page.conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 321, y: 123, button: 'none' }, page.sessionId);
    await sleep(150);
    const f1 = await page.flushPointerGuard();
    check('pointer guard (control): a trusted move the harness did not record is reported with its position', f1.length === 1 && f1[0].type === 'mousemove' && f1[0].x === 321 && f1[0].y === 123, f1);
    await page.navigate(`${srv.url}/test/harness/selftest-fixture/app.html`);
    await page.waitForFunction('window.__APP_READY');
    await page.conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 333, y: 99, button: 'left', clickCount: 1 }, page.sessionId);
    await page.conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 333, y: 99, button: 'left', clickCount: 1 }, page.sessionId);
    await sleep(150);
    const f2 = (await page.flushPointerGuard()).slice(1);
    check('pointer guard (control): it survives a navigation and reports a foreign press', f2.some((f) => f.type === 'mousedown' && f.x === 333 && f.y === 99), f2);
    check('pointer guard: the page script cannot see the guard binding', (await page.evaluate("typeof window.__hicPointerSeen")) === 'undefined');

    // macOS, headed: the real pointer resting over the page is delivered by a clipped screenshot (the environment problem the guard exists for)
    const pid = browser.pid;
    const o = pid ? osPointer(pid) : null;
    if (!o || !o.windows.length) { info('real OS pointer control', 'skipped: the OS pointer or the browser window cannot be read here'); await fullscreenCheck(); return; }
    page.foreignPointer.length = 0;
    const vp = await page.evaluate('({ x: screenX + (outerWidth - innerWidth) / 2, y: screenY + outerHeight - innerHeight, w: innerWidth, h: innerHeight, dpr: devicePixelRatio })');
    const before = o.at;
    // a point inside the viewport, in screen points (no --force-device-scale-factor here: css px == points)
    const target = { x: Math.round(vp.x + vp.w * 0.6), y: Math.round(vp.y + vp.h * 0.6) };
    try {
      execFileSync('python3', ['-c', `import Quartz; Quartz.CGWarpMouseCursorPosition((${target.x}, ${target.y})); Quartz.CGAssociateMouseAndMouseCursorPosition(True)`], { timeout: 5000 });
      await sleep(200);
      await page.screenshot({ clip: { x: 10, y: 10, width: 100, height: 60 } });
      await sleep(300);
      const f3 = await page.flushPointerGuard();
      check('pointer guard (control): the real OS pointer resting over the page reaches it at a clipped screenshot, and is reported', f3.some((f) => Math.abs(f.x - (target.x - vp.x)) <= 2 && Math.abs(f.y - (target.y - vp.y)) <= 2), { target, viewport: vp, foreign: f3.slice(0, 3) });
    } finally {
      const park = parkOsPointer(pid);
      info('real OS pointer control: parked again', { before, park });
      page.foreignPointer.length = 0;
      await page.screenshot({ clip: { x: 10, y: 10, width: 100, height: 60 } });
      await sleep(300);
      check('parked OS pointer: a clipped screenshot delivers nothing', park.parked && (await page.flushPointerGuard()).length === 0, { park, foreign: page.foreignPointer });
    }
    await fullscreenCheck();
  } finally {
    await page.close();
  }
}
