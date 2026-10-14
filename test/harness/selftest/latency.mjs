// Input -> first presented frame with the expected pixels. Positive controls: an app that delays its redraw by 60 ms must be
// measured >= 60 ms; a trigger that sends no event must be reported as noEvent, never as a latency.
export async function run({ check, info, page, srv }) {
  const { measureLatency } = await import('../lib/oracle-latency.mjs');
  const base = `${srv.url}/test/harness/selftest-fixture/app.html`;
  const dpr = async () => page.evaluate('devicePixelRatio');
  const open = async q => { await page.navigate(base + q); await page.waitForFunction('window.__APP_READY'); await page.requireForeground('latency section'); await page.click(150, 34); };
  const keyRegion = async () => ({ x: 0, y: 0, w: Math.round(320 * await dpr()), h: Math.round(30 * await dpr()) });

  await open('');
  const k = await measureLatency(page, { selector: '#lat', region: await keyRegion(), eventType: 'keydown', trials: 12, gapMs: 200, trigger: () => page.key('a') });
  check('key latency: all trials hit, no timeouts', k.commitMs.n === 12 && k.timedOut === 0 && k.noEvent === 0, { n: k.commitMs.n, timedOut: k.timedOut, noEvent: k.noEvent });
  check('key latency: plausible (p50 commit < 40 ms) for an app that redraws in the next rAF', k.commitMs.p50 < 40, { p50: k.commitMs.p50, p95: k.commitMs.p95, frame: k.framePeriodMs });
  info('key -> pixel (immediate app): commit / presented / observer cost', { commit: k.commitMs, presented: k.presentedMs, sampleCostMs: k.sampleCostMs });

  const p = await measureLatency(page, { selector: '#lat', region: { x: 0, y: Math.round(34 * await dpr()), w: Math.round(60 * await dpr()), h: Math.round(20 * await dpr()) }, eventType: 'pointerdown', trials: 8, gapMs: 200, trigger: () => page.click(380, 44) });
  check('pointer latency: all trials hit', p.commitMs.n === 8 && p.timedOut === 0, { n: p.commitMs.n, p50: p.commitMs.p50 });
  const w = await measureLatency(page, { selector: '#lat', region: { x: Math.round(56 * await dpr()), y: Math.round(34 * await dpr()), w: Math.round(48 * await dpr()), h: Math.round(20 * await dpr()) }, eventType: 'wheel', trials: 8, gapMs: 200, trigger: () => page.wheel(380, 44, 0, 40) });
  check('wheel latency: all trials hit', w.commitMs.n === 8 && w.timedOut === 0, { n: w.commitMs.n, p50: w.commitMs.p50 });
  info('pointer / wheel p50 commit ms', { pointer: p.commitMs.p50, wheel: w.commitMs.p50 });

  await open('?latdelay=60');
  const slow = await measureLatency(page, { selector: '#lat', region: await keyRegion(), eventType: 'keydown', trials: 8, gapMs: 200, trigger: () => page.key('a') });
  check('POSITIVE CONTROL: an app that delays its redraw 60 ms is measured >= 60 ms (p50) and clearly above the immediate app', slow.commitMs.n === 8 && slow.commitMs.p50 >= 60 && slow.commitMs.p50 > k.commitMs.p50 + 40, { slowP50: slow.commitMs.p50, immediateP50: k.commitMs.p50 });

  await open('');
  const none = await measureLatency(page, { selector: '#lat', region: await keyRegion(), eventType: 'keydown', trials: 3, gapMs: 100, timeoutMs: 400, trigger: async () => {} });
  check('POSITIVE CONTROL: a trigger that sends no event is reported as noEvent (no fabricated latency)', none.noEvent === 3 && none.commitMs.n === 0, { noEvent: none.noEvent, n: none.commitMs.n });
  // event arrives but the pixels never change (keys=30 wraps ... use a pointer event over a non-drawing region instead)
  const nochange = await measureLatency(page, { selector: '#lat', region: await keyRegion(), eventType: 'pointermove', trials: 3, gapMs: 100, timeoutMs: 500, trigger: () => page.mouseMove(380, 100) });
  check('POSITIVE CONTROL: event received but pixels unchanged -> timeout counted, not a latency', nochange.timedOut === 3 && nochange.commitMs.n === 0, { timedOut: nochange.timedOut, noEvent: nochange.noEvent });
}
