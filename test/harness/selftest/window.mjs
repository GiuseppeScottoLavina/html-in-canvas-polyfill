// Real window drag resize.
import { dragResize } from '../lib/window.mjs';

export async function run({ check, info, page, srv }) {
  await page.navigate(`${srv.url}/test/harness/selftest-fixture/app.html`);
  await page.waitForFunction('window.__APP_READY');
  await page.requireForeground('window section');
  const v0 = await page.viewport();

  const v1 = await page.setInnerSize(1000, 600);
  check('setInnerSize makes the REAL inner viewport exactly 1000x600', v1.innerWidth === 1000 && v1.innerHeight === 600, { inner: [v1.innerWidth, v1.innerHeight], outer: [v1.outerWidth, v1.outerHeight] });

  const d = await dragResize(page, { to: { width: 700, height: 520 }, steps: 24, intervalMs: 16 });
  check('dragResize: real window ends at the target inner size', d.reachedTarget, { start: d.start, final: d.finalInner });
  check('dragResize: injector reported its cadence (~16 ms) and the page saw intermediate sizes', d.injector.cadenceOk && d.pageSaw.distinctWidths >= 4, { cadence: d.injector.actual, pageSaw: d.pageSaw, ackMs: d.injector.ackMs });
  info('real drag 1000->700 in 24 steps @16 ms', { effectiveHz: d.injector.effectiveHz, resizeEvents: d.pageSaw.resizeEvents, distinctWidths: d.pageSaw.distinctWidths, firstToLastMs: d.pageSaw.firstToLastMs, ackP50: d.injector.ackMs.p50 });

  const back = await dragResize(page, { to: { width: 1200, height: 640 }, steps: 12, intervalMs: 8 });
  check('dragResize back up at 8 ms cadence reaches the target', back.reachedTarget, { final: back.finalInner, cadence: back.injector.actual, ackP50: back.injector.ackMs.p50 });

  await page.setInnerSize(v0.innerWidth, v0.innerHeight);
}
