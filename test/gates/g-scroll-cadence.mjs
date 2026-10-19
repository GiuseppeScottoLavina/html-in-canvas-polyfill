// G-scroll-cadence: an inner list drawn into a canvas follows a trusted wheel stream at the display rate, and every frame it shows is a correct one.
//   Cases (fixture scroll-cadence.html, the same trusted input for each): a plain list with a sticky header, the same with rounded corners, with :hover rows, and a long
//   list (2000 rows, 6000+ elements). The pointer rests over the list before the stream (no warm-up gesture: the FIRST gesture is measured).
//   cadence  per rAF frame of the stream: the live scroller moved (the compositor delivered the offset to the main thread) and the canvas got a paint for it.
//            Thresholds per case, from the same harness on this machine (120 Hz, DPR 2): the plain DOM list moves in 116 of 120 frames per second and a native
//            drawable (Canary 158) paints all of them; the old behaviour moved the live list in every second frame (61/s) and painted 61, 61, 49 and 4 per second.
//   compose  the scroll compositor drew the steps (snapshot stats): a scroll is not re-photographed per frame.
//   pixel    samples of the canvas taken INSIDE paint handlers during the stream each equal the plain-DOM twin at one of the offsets the list had in the frames
//            just before (a composed frame shows the live offset, a fallback tile a slightly older one; anything else is a wrong frame), and the settled canvas
//            equals the twin at the final offset. Hover: the twin's pointer rests on the same point, so its hovered row is the one the canvas must show.
// Positive control (sabotage stale + nosync + nocompose): only the first draw reaches the canvas, the live scroller is never synchronised, and every scroll
// scroller under the pointer gets an empty position:fixed child (no plan for it): every class must go red.
import { runGate, H } from './lib/gate.mjs';

const FIXTURE = '/test/gates/fixtures/scroll-cadence.html';
/** minimum share of frames with scroller movement / of moved frames that got a paint / of moved frames composed, per case */
const CASES = [
  { name: 'plain', params: { rows: 300 }, move: 0.85, paint: 0.9, compose: 0.8 },
  { name: 'rounded', params: { rows: 300, round: 1 }, move: 0.85, paint: 0.9, compose: 0.8 },
  { name: 'hover', params: { rows: 300, hover: 1 }, move: 0.85, paint: 0.8, compose: 0 },
  { name: 'long', params: { rows: 2000 }, move: 0.8, paint: 0.85, compose: 0.7 },
];
const SAMPLE_EVERY = 9;
const SAMPLES = 8;
const TOLERANCE = 6;
const MAX_FRACTION = 0.004;

const url = (ctx, params, poly) => {
  const u = new URL(FIXTURE, ctx.srv.url);
  if (poly) u.searchParams.set('bundle', ctx.bundle);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.href;
};

async function open(ctx, page, params, poly) {
  await page.navigate(url(ctx, params, poly));
  await ctx.focus(page);
  await page.setInnerSize(1400, 880);
  await page.waitForFunction(poly ? 'window.__ready && window.__paints >= 1' : 'window.__ready', { timeout: 15000 });
  await H.sleep(300);
}

/** list rect relative to the stage (css px) and the pointer point (viewport css px) */
const GEO = `(() => { const s = document.getElementById('stage').getBoundingClientRect(); const l = document.getElementById('list').getBoundingClientRect();
  return { list: { x: l.left - s.left, y: l.top - s.top, width: l.width, height: l.height }, at: { x: l.left + l.width / 2, y: l.top + l.height / 2 + 20 }, dpr: devicePixelRatio }; })()`;

/** cadence numbers of the recorded rAF frames [t, scrollTop, paints] */
function cadence(frames) {
  const moved = [];
  for (let i = 1; i < frames.length; i++) if (frames[i][1] !== frames[i - 1][1]) moved.push(i);
  if (moved.length < 2) return { frames: frames.length, moved: moved.length, active: 0 };
  const first = moved[0], last = moved[moved.length - 1];
  const activeFrames = last - first + 1;
  // a paint for the movement of frame i fires in frame i (after its rAF callbacks): it shows in the paint count of the next row
  let painted = 0;
  for (const i of moved) if (i + 1 < frames.length && frames[i + 1][2] > frames[i][2]) painted++;
  const spanMs = frames[last][0] - frames[first][0];
  return { frames: frames.length, activeFrames, moved: moved.length, painted, moveShare: moved.length / activeFrames, paintShare: painted / moved.length, movesPerS: Math.round((1000 * moved.length) / spanMs), paintsPerS: Math.round((1000 * (frames[Math.min(last + 1, frames.length - 1)][2] - frames[first - 1][2])) / spanMs) };
}

/** device-pixel crop of the list out of a stage-sized image */
const cropList = (img, geo) => {
  const x = Math.round(geo.list.x * geo.dpr), y = Math.round(geo.list.y * geo.dpr);
  return H.cropImage(img, x, y, Math.min(img.width - x, Math.round(geo.list.width * geo.dpr)), Math.min(img.height - y, Math.round(geo.list.height * geo.dpr)));
};

runGate('G-scroll-cadence', async (ctx) => {
  const numbers = {};
  const page = await ctx.page();
  const ref = await ctx.page();
  // the browser's own first run (code caches, GPU process, the first trusted input of the session) is not what is measured: one stream on a page that is then reloaded
  await open(ctx, page, { rows: 300 }, true);
  const warm = await page.evaluate(GEO);
  await page.mouseMove(warm.at.x, warm.at.y);
  await H.wheelStream(page, { ...warm.at, deltaY: 40, count: 30, intervalMs: 8 });
  await H.sleep(300);
  const errors0 = page.errors().length;
  const only = process.argv.find((a) => a.startsWith('--cases='))?.slice(8).split(',');
  for (const c of CASES.filter((x) => !only || only.includes(x.name))) {
    await open(ctx, ref, c.params, false);
    await open(ctx, page, c.params, true);
    const geo = await page.evaluate(GEO);
    await page.mouseMove(geo.at.x - 30, geo.at.y);
    await page.mouseMove(geo.at.x, geo.at.y);
    await H.sleep(800);
    const sc0 = await page.evaluate('window.__HIC__.installed.report().canvases[0].stats.snapshot.scroll');
    await page.evaluate(`window.__rec.start(${SAMPLE_EVERY}, ${SAMPLES})`);
    await H.wheelStream(page, { ...geo.at, deltaY: 40, count: 60, intervalMs: 8 });
    await H.wheelStream(page, { ...geo.at, deltaY: -40, count: 60, intervalMs: 8 });
    await H.sleep(400);
    const frames = await page.evaluate('window.__rec.stop()');
    const sc1 = await page.evaluate('window.__HIC__.installed.report().canvases[0].stats.snapshot.scroll');
    const k = cadence(frames);
    const composed = sc1.composed - sc0.composed;
    numbers[c.name] = { ...k, composed, fallbacks: sc1.fallbacks - sc0.fallbacks, plans: sc1.plans - sc0.plans, refusals: sc1.refusals - sc0.refusals };
    ctx.check(`${c.name}: the wheel stream scrolled the live list (>= 40 frames with movement)`, k.moved >= 40, k, 'cadence');
    ctx.check(`${c.name}: the live list moved in >= ${c.move * 100} % of the frames of the stream (plain DOM: 97 %; old behaviour: 50 %)`, k.moveShare >= c.move, k, 'cadence');
    ctx.check(`${c.name}: >= ${c.paint * 100} % of those frames got a canvas paint (native: 100 %)`, k.paintShare >= c.paint, k, 'cadence');
    if (c.compose > 0) ctx.check(`${c.name}: the scroll compositor drew >= ${c.compose * 100} % of them, from the first gesture on`, composed >= c.compose * k.moved, { composed, moved: k.moved, ...numbers[c.name] }, 'compose');

    // pixels of the frames the canvas showed during the stream
    const samples = await page.evaluate('window.__rec.samples.map((s) => ({ t: s.t, top: s.top }))');
    await ctx.focus(ref);
    await ref.mouseMove(geo.at.x - 30, geo.at.y);
    await ref.mouseMove(geo.at.x, geo.at.y);
    /** @type {Map<number, any>} */
    const twin = new Map();
    const twinAt = async (top) => {
      if (twin.has(top)) return twin.get(top);
      await ref.evaluate(`document.getElementById('list').scrollTop = ${top}`);
      await H.sleep(250);
      const shot = await H.screenshotElement(ref, '#list');
      twin.set(top, { img: shot.img, top: await ref.evaluate(`document.getElementById('list').scrollTop`) });
      return twin.get(top);
    };
    const misses = [];
    let checked = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const png = await page.evaluate(`window.__rec.png(${i})`);
      const shot = cropList(H.decodePng(Buffer.from(png.split(',')[1], 'base64')), geo);
      const cands = [...new Set([s.top, ...frames.filter((f) => f[0] <= s.t && f[0] >= s.t - 45).map((f) => f[1])])];
      let best = null;
      for (const top of cands) {
        const tw = await twinAt(top);
        const d = H.compareImages(shot, tw.img, { tolerance: TOLERANCE, diffImage: false });
        const f = d.sizeMatch ? d.fraction : 1;
        if (!best || f < best.fraction) best = { top, fraction: f, sizes: d.sizes, bbox: d.overBBox, hist: d.deltaHistogram };
      }
      checked++;
      if (!best || best.fraction > MAX_FRACTION) misses.push({ sample: i, top: s.top, cands, best });
    }
    numbers[`${c.name}Samples`] = { checked, misses: misses.slice(0, 4) };
    if (misses.length && process.argv.includes('--dump')) { const { writeFileSync } = await import('node:fs'); const m0 = misses[0]; const png = await page.evaluate(`window.__rec.png(${m0.sample})`); writeFileSync('/tmp/gsc-canvas.png', Buffer.from(png.split(',')[1], 'base64')); writeFileSync('/tmp/gsc-twin.png', H.encodePng(twin.get(m0.best.top).img)); writeFileSync('/tmp/gsc-crop.png', H.encodePng(cropList(H.decodePng(Buffer.from(png.split(',')[1], 'base64')), geo))); }
    ctx.check(`${c.name}: every canvas frame sampled during the stream (${checked}) equals the twin at an offset the list had (tolerance ${TOLERANCE}, <= ${MAX_FRACTION * 100} %)`, checked >= 4 && misses.length === 0, numbers[`${c.name}Samples`], 'pixel');

    // the settled canvas at the final offset
    await ctx.focus(page);
    const fin = await page.evaluate(`document.getElementById('list').scrollTop`);
    const poly = await H.readCanvas(page, '#stage');
    await ctx.focus(ref);
    await ref.evaluate(`document.getElementById('list').scrollTop = ${fin}`);
    await H.sleep(250);
    const want = await H.screenshotElement(ref, '#stage');
    const d = H.compareImages(H.compositeOver(poly, [255, 255, 255]), want.img, { tolerance: TOLERANCE, diffImage: false });
    numbers[`${c.name}Settled`] = d.sizeMatch ? { top: fin, fraction: d.fraction, countOver: d.countOver16, bbox: d.overBBox } : { sizes: d.sizes };
    ctx.check(`${c.name}: the settled canvas equals the twin at the final offset (whole stage, tolerance ${TOLERANCE}, <= ${MAX_FRACTION * 100} %)`, d.sizeMatch && d.fraction <= MAX_FRACTION && H.pixelStats(poly).nonBlank, numbers[`${c.name}Settled`], 'pixel');
    await ctx.focus(page);
  }
  // the long list is above nodeBudget.hard: its 'node-budget' report is expected
  const errs = page.errors({ includeWarnings: false }).slice(errors0).filter((e) => !/unsupported node-budget/.test(e.text ?? ''));
  ctx.check('no page error or console error', errs.length === 0, errs.slice(0, 3), 'surface');
  return { numbers };
}, { scrollbars: 'overlay', controlSabotage: ['stale', 'nosync', 'nocompose'], controlClasses: ['cadence', 'compose', 'pixel'] });
