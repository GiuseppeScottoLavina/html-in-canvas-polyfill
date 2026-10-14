// Real window drag resize, emulated resize, DPR change.
import { dragResize, emulatedResize, clearEmulation, setDpr } from '../lib/window.mjs';

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

  const e = await emulatedResize(page, { to: { width: 800, height: 500 }, steps: 8, intervalMs: 16 });
  check('emulatedResize reaches 800x500 and is labelled emulation (not a real window)', e.reachedTarget && e.kind === 'emulation', { final: e.finalInner, saw: e.pageSaw });
  await clearEmulation(page);

  const dpr1 = await setDpr(page, 1);
  check('setDpr(1): devicePixelRatio is 1 and the window size is unchanged', dpr1.dpr === 1 && dpr1.innerWidth === (await page.viewport()).innerWidth, { dpr: dpr1.dpr, inner: [dpr1.innerWidth, dpr1.innerHeight] });
  const mq = await page.evaluate('matchMedia("(resolution: 1dppx)").matches');
  check('DPR emulation is visible to media queries (resolution: 1dppx)', mq === true, { mq });
  await clearEmulation(page);
  const back2 = await page.viewport();
  check('clearEmulation restores the native DPR', back2.dpr === v0.dpr, { was: v0.dpr, now: back2.dpr });
  await page.setInnerSize(v0.innerWidth, v0.innerHeight);
}
