// G-scroll-cadence: an inner list drawn into a canvas follows a trusted wheel stream at the display rate, and every frame it shows is a correct one.
//   Cases (fixture scroll-cadence.html, the same trusted input for each): a plain list with a sticky header, the same with rounded corners, with :hover rows, a long
//   list (2000 rows, 6000+ elements), the plain list in a column of fractional width (400.4 px: its clientWidth is rounded, its layout is not), and a list of rows of
//   fractional height (36.6 px, 900+ elements: the pages and tiles are pruned, and a spacer that was a LayoutUnit short put the rows after it a device pixel off
//   between a composed frame and the settled tile, clone.js layoutPx). The pointer rests over the list before the stream (no warm-up gesture: the FIRST gesture is measured).
//   cadence  per rAF frame of the stream: the live scroller moved (the compositor delivered the offset to the main thread) and the canvas got a paint for it.
//            Thresholds MOVE_CASE / MOVE_MEAN and the per-case paint shares, from this machine (120 Hz, DPR 2 and 1.25): the plain DOM list and a native drawable
//            (Canary 158) move and paint in 97 % of the frames; the old behaviour painted 61, 61, 49 and 4 times per second (plain, rounded, hover, long).
//   compose  the scroll compositor drew the steps (snapshot stats): a scroll is not re-photographed per frame.
//   pixel    samples of the canvas taken INSIDE paint handlers during the stream each equal the plain-DOM twin at one of the offsets the list had in the frames
//            just before (a composed frame shows the live offset, a fallback tile a slightly older one; anything else is a wrong frame), and the settled canvas
//            equals the twin at the final offset. Hover: a frame is the pair (offset, row the live DOM had under :hover), and the twin's pointer is put on that row;
//            the twin must then show that row hovered in its screenshot (the reference's own precondition, class twin: a resting OS pointer over the window was
//            delivered to the twin at every clipped screenshot and took its hover away, 2026-10-22; the harness now parks the pointer and reports foreign input).
// Positive control (sabotage stale + nosync + nocompose): only the first draw reaches the canvas, the live scroller is never synchronised, and every scroll
// scroller under the pointer gets an empty position:fixed child (no plan for it): every class must go red.
import { runGate, H } from './lib/gate.mjs';

const FIXTURE = '/test/gates/fixtures/scroll-cadence.html';
/** minimum share of the moved frames that got a paint / that the compositor drew, per case */
const CASES = [
  { name: 'plain', params: { rows: 300 }, paint: 0.9, compose: 0.8 },
  { name: 'rounded', params: { rows: 300, round: 1 }, paint: 0.9, compose: 0.8 },
  { name: 'hover', params: { rows: 300, hover: 1 }, paint: 0.8, compose: 0 },
  { name: 'long', params: { rows: 2000 }, paint: 0.85, compose: 0.7 },
  { name: 'fractional', params: { rows: 300, frac: 1 }, paint: 0.9, compose: 0.8 },
  { name: 'fracrows', params: { rows: 300, fracrows: 1 }, paint: 0.9, compose: 0.8 },
];
/**
 * Share of the stream's frames in which the live list moved (and the canvas with it): at least MOVE_CASE in every case and MOVE_MEAN over the cases. The plain DOM list
 * and a native drawable move in 97 % of them (116 of 120 per second). Chromium's input pipeline is bistable here (a frame with two wheel events can start an
 * alternation that lasts a few frames or the rest of the stream), so single cases spread: measured 0.80-0.96 per case and 0.88-0.94 on average with the scroll
 * synchronisation, 0.51-0.78 per case and 0.65-0.73 on average without it (the old behaviour).
 */
const MOVE_CASE = 0.7;
const MOVE_MEAN = 0.82;
const SAMPLE_EVERY = 9;
const SAMPLES = 8;
const TOLERANCE = 6;
const MAX_FRACTION = 0.004;
/** css px of each corner square of the list, and the share of it that may differ (delta > 16): the rounded clip's antialiasing is compared there, where a whole-list fraction would drown it */
const CORNER = 18;
const MAX_CORNER = 0.03;

/** worst delta > 16 share over the four corner squares of two list images */
function cornerDiff(a, b, dpr) {
  const n = Math.round(CORNER * dpr);
  let worst = 0;
  for (const [x, y] of [[0, 0], [a.width - n, 0], [0, a.height - n], [a.width - n, a.height - n]]) {
    const d = H.compareImages(H.cropImage(a, x, y, n, n), H.cropImage(b, x, y, n, n), { tolerance: 16, diffImage: false });
    worst = Math.max(worst, d.sizeMatch ? d.fraction : 1);
  }
  return worst;
}

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
  let pattern = '';
  for (let i = first; i <= last; i++) pattern += frames[i][1] !== frames[i - 1][1] ? '1' : '0';
  return { pattern, frames: frames.length, activeFrames, moved: moved.length, painted, moveShare: moved.length / activeFrames, paintShare: painted / moved.length, movesPerS: Math.round((1000 * moved.length) / spanMs), paintsPerS: Math.round((1000 * (frames[Math.min(last + 1, frames.length - 1)][2] - frames[first - 1][2])) / spanMs) };
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
  /** @type {number[]} */
  const shares = [];
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
    shares.push(k.moveShare ?? 0);
    ctx.check(`${c.name}: the wheel stream scrolled the live list (>= 40 frames with movement)`, k.moved >= 40, k, 'cadence');
    ctx.check(`${c.name}: the live list moved in >= ${MOVE_CASE * 100} % of the frames of the stream (plain DOM and native: 97 %)`, k.moveShare >= MOVE_CASE, { moveShare: k.moveShare, pattern: k.pattern }, 'cadence');
    ctx.check(`${c.name}: >= ${c.paint * 100} % of those frames got a canvas paint (native: 100 %)`, k.paintShare >= c.paint, k, 'cadence');
    if (c.compose > 0) ctx.check(`${c.name}: the scroll compositor drew >= ${c.compose * 100} % of them, from the first gesture on`, composed >= c.compose * k.moved, { composed, moved: k.moved, ...numbers[c.name] }, 'compose');

    // pixels of the frames the canvas showed during the stream
    const samples = await page.evaluate('window.__rec.samples.map((s) => ({ t: s.t, top: s.top, hov: s.hov }))');
    await ctx.focus(ref);
    await ref.mouseMove(geo.at.x - 30, geo.at.y);
    await ref.mouseMove(geo.at.x, geo.at.y);
    // with :hover rows a frame is a pair (offset, hovered row): the twin is put in that state (its pointer on that row), any other case ignores the row
    const withHover = !!c.params.hover;
    /** @type {Map<string, any>} */
    const twin = new Map();
    /** pairs whose twin screenshot did not show the hovered row it was given */
    const twinMisses = [];
    const twinAt = async (/** @type {number} */ top, /** @type {number} */ hov) => {
      const key = withHover ? `${top}|${hov}` : `${top}`;
      if (twin.has(key)) return twin.get(key);
      await ref.evaluate(`document.getElementById('list').scrollTop = ${top}`);
      if (withHover) {
        const at = hov < 0 ? { x: geo.at.x + 500, y: geo.at.y } : await ref.evaluate(`(() => { const r = document.getElementById('rows').children[${hov}].getBoundingClientRect(); const l = document.getElementById('list').getBoundingClientRect(); return { x: ${geo.at.x}, y: Math.min(l.bottom - 2, Math.max(l.top + 46, r.top + r.height / 2)) }; })()`);
        await ref.mouseMove(at.x, at.y);
      }
      await H.sleep(250);
      const shot = await H.screenshotElement(ref, '#list');
      if (withHover) {
        const got = await ref.evaluate(`(() => { const h = document.querySelector('#rows li:hover'); return h ? Array.prototype.indexOf.call(document.getElementById('rows').children, h) : -1; })()`);
        if (got !== hov) twinMisses.push({ top, want: hov, got });
      }
      twin.set(key, { img: shot.img, top: await ref.evaluate(`document.getElementById('list').scrollTop`) });
      return twin.get(key);
    };
    const misses = [];
    let checked = 0;
    let worstCorner = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const png = await page.evaluate(`window.__rec.png(${i})`);
      const shot = cropList(H.decodePng(Buffer.from(png.split(',')[1], 'base64')), geo);
      const seen = new Set();
      const cands = [[s.top, s.hov], ...frames.filter((f) => f[0] <= s.t && f[0] >= s.t - 45).map((f) => [f[1], f[3]])].filter(([t, h]) => { const k = withHover ? `${t}|${h}` : `${t}`; return !seen.has(k) && seen.add(k); });
      let best = null;
      for (const [top, hov] of cands) {
        const tw = await twinAt(top, hov);
        // a list of fractional width: the element screenshot of the twin rounds its device-pixel width one way, the crop of the canvas the other (800 / 801 px at
        // DPR 2 for 400.4 css px); both start at the list's left edge, so the canvas crop is cut to the twin's size (one device pixel at most)
        const sh = Math.abs(shot.width - tw.img.width) <= 1 && Math.abs(shot.height - tw.img.height) <= 1 ? H.cropImage(shot, 0, 0, Math.min(shot.width, tw.img.width), Math.min(shot.height, tw.img.height)) : shot;
        const ti = sh === shot ? tw.img : H.cropImage(tw.img, 0, 0, sh.width, sh.height);
        const d = H.compareImages(sh, ti, { tolerance: TOLERANCE, diffImage: false });
        const f = d.sizeMatch ? d.fraction : 1;
        if (!best || f < best.fraction) best = { top, hov, fraction: f, corner: d.sizeMatch ? cornerDiff(sh, ti, geo.dpr) : 1, sizes: d.sizes, bbox: d.overBBox };
      }
      checked++;
      worstCorner = Math.max(worstCorner, best?.corner ?? 1);
      if (!best || best.fraction > MAX_FRACTION || best.corner > MAX_CORNER) misses.push({ sample: i, top: s.top, cands, best });
    }
    numbers[`${c.name}Samples`] = { checked, worstCorner, misses: misses.slice(0, 4), twins: twin.size, twinMisses: twinMisses.slice(0, 4) };
    if (withHover) ctx.check(`${c.name}: each twin screenshot shows the row it was given under :hover (${twin.size} pairs; the reference's precondition)`, twinMisses.length === 0, { twinMisses: twinMisses.slice(0, 4), of: twin.size }, 'twin');
    if (misses.length && process.argv.includes('--dump')) { const { writeFileSync } = await import('node:fs'); const m0 = misses[0]; const png = await page.evaluate(`window.__rec.png(${m0.sample})`); writeFileSync('/tmp/gsc-canvas.png', Buffer.from(png.split(',')[1], 'base64')); writeFileSync('/tmp/gsc-twin.png', H.encodePng(twin.get(withHover ? `${m0.best.top}|${m0.best.hov}` : `${m0.best.top}`).img)); writeFileSync('/tmp/gsc-crop.png', H.encodePng(cropList(H.decodePng(Buffer.from(png.split(',')[1], 'base64')), geo))); }
    ctx.check(`${c.name}: every canvas frame sampled during the stream (${checked}) equals the twin at an offset the list had (tolerance ${TOLERANCE}, <= ${MAX_FRACTION * 100} %; each corner of the list <= ${MAX_CORNER * 100} % above 16)`, checked >= 4 && misses.length === 0, numbers[`${c.name}Samples`], 'pixel');

    // the settled canvas at the final offset
    await ctx.focus(page);
    const fin = await page.evaluate(`document.getElementById('list').scrollTop`);
    const poly = await H.readCanvas(page, '#stage');
    await ctx.focus(ref);
    await ref.evaluate(`document.getElementById('list').scrollTop = ${fin}`);
    await ref.mouseMove(geo.at.x, geo.at.y);
    await H.sleep(250);
    const want = await H.screenshotElement(ref, '#stage');
    const d = H.compareImages(H.compositeOver(poly, [255, 255, 255]), want.img, { tolerance: TOLERANCE, diffImage: false });
    numbers[`${c.name}Settled`] = d.sizeMatch ? { top: fin, fraction: d.fraction, countOver: d.countOver16, bbox: d.overBBox } : { sizes: d.sizes };
    ctx.check(`${c.name}: the settled canvas equals the twin at the final offset (whole stage, tolerance ${TOLERANCE}, <= ${MAX_FRACTION * 100} %)`, d.sizeMatch && d.fraction <= MAX_FRACTION && H.pixelStats(poly).nonBlank, numbers[`${c.name}Settled`], 'pixel');
    await ctx.focus(page);
  }
  const mean = shares.reduce((a, b) => a + b, 0) / Math.max(1, shares.length);
  numbers.moveShareMean = mean;
  if (shares.length === CASES.length) ctx.check(`the live list moved in >= ${MOVE_MEAN * 100} % of the frames on average over the cases (plain DOM and native: 97 %; old behaviour: 65-73 %)`, mean >= MOVE_MEAN, { mean, shares }, 'cadence');
  // the long list is above nodeBudget.hard: its 'node-budget' report is expected
  const errs = page.errors({ includeWarnings: false }).slice(errors0).filter((e) => !/unsupported node-budget/.test(e.text ?? ''));
  ctx.check('no page error or console error', errs.length === 0, errs.slice(0, 3), 'surface');
  return { numbers };
}, { scrollbars: 'overlay', controlSabotage: ['stale', 'nosync', 'nocompose'], controlClasses: ['cadence', 'compose', 'pixel'] });
