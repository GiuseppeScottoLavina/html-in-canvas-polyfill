// Input helpers + cadence reporting, including a deliberately slowed injector that the reporter must flag.
import { paced, stats } from '../lib/util.mjs';
import { typeKeys, pressKeys, wheelStream, mouseStream, mouseDrag } from '../lib/input.mjs';

export async function run({ check, info, page, srv }) {
  await page.navigate(`${srv.url}/test/harness/selftest-fixture/app.html`);
  await page.waitForFunction('window.__APP_READY');
  await page.requireForeground('input section');

  // ---- keys at an explicit 8 ms cadence, with what the page saw
  await page.click(150, 34);
  const text = 'abcdefghijklmnopqrstuvwx';
  const k = await typeKeys(page, text, { intervalMs: 8, probe: true });
  const value = await page.evaluate('document.getElementById("inp").value');
  check('typeKeys: every key reached the focused input', value === text, { value });
  check('typeKeys: injector reports achieved cadence ~8 ms and cadenceOk', k.cadenceOk && k.actual.p50 > 7 && k.actual.p50 < 9.5, { requested: k.requestedMs, p50: k.actual.p50, p95: k.actual.p95, hz: k.effectiveHz });
  check('typeKeys: page saw all keydowns', k.pageSaw.keydown.n === text.length, k.pageSaw.keydown);
  info('keys at 8 ms: injector gaps / page-seen gaps / ack', { sent: k.actual, pageSeen: k.pageSaw.keydown.intervalsMs, ackMs: k.ackMs });

  // ---- the reporter must catch a deliberately slowed injector (positive control)
  const slow = await paced(30, 4, () => { const s = performance.now(); while (performance.now() - s < 12) { /* injector stalls */ } return page.evaluate('0'); });
  check('cadence reporter flags a deliberately slowed injector (requested 4 ms, really ~12 ms)', slow.cadenceOk === false && slow.actual.p50 >= 11, { requested: slow.requestedMs, p50: slow.actual.p50, cadenceOk: slow.cadenceOk });
  const fast = await paced(60, 4, () => page.evaluate('0'));
  info('paced 4 ms with CDP round trips (pipelined)', { p50: fast.actual.p50, p95: fast.actual.p95, ok: fast.cadenceOk });

  // ---- named keys
  await page.evaluate('document.getElementById("inp").value = ""');
  const pk = await pressKeys(page, ['a', 'b', 'Backspace', 'c'], { intervalMs: 8 });
  check('pressKeys: Backspace edits the field', (await page.evaluate('document.getElementById("inp").value')) === 'ac', pk.actual);

  // ---- wheel
  const sc = { x: 170, y: 145 };
  const w = await wheelStream(page, { ...sc, deltaY: 40, count: 12, intervalMs: 8, probe: true });
  const top1 = await page.evaluate('document.getElementById("scroller").scrollTop');
  check('wheelStream scrolls the inner scroller', top1 > 100, { scrollTop: top1 });
  check('wheelStream: cadence reported, page saw wheel events', w.cadenceOk && w.pageSaw.wheel.n >= 4, { cadence: w.actual, pageSaw: w.pageSaw.wheel });
  await page.evaluate('document.getElementById("scroller").scrollTop = 0');

  // ---- mouse
  const ms = await mouseStream(page, { x: 30, y: 300 }, { x: 300, y: 380 }, { steps: 30, intervalMs: 8, probe: true });
  check('mouseStream: page saw pointermoves, cadence reported', ms.pageSaw.pointermove.n >= 10 && ms.cadenceOk, { sent: ms.actual.p50, seen: ms.pageSaw.pointermove });
  info('pointermove: sent 30 @8 ms, page saw', { seen: ms.pageSaw.pointermove.n, gapP50: ms.pageSaw.pointermove.intervalsMs.p50 });
  const dr = await mouseDrag(page, { x: 30, y: 300 }, { x: 300, y: 380 }, { steps: 20, intervalMs: 8 });
  check('mouseDrag completes with cadence report', dr.count === 20, dr.actual);
  const before = await page.evaluate('__fx.downs()');
  await page.click(400, 40);
  check('click dispatches pointerdown on a canvas', (await page.evaluate('__fx.downs()')) === before + 1, { before });
  const stuck = await page.evaluate('document.getElementById("scroller").scrollTop'); void stuck; void stats;
}
