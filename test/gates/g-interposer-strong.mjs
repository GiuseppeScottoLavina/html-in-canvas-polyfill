// G-interposer-strong: the effect-host interposer end to end under a STRONG displacement. F1 under the CRT example plugin at full curvature (k = 0.5: the middle of the screen
// magnified, the edges compressed toward a bezel), with the plugin's colour effects off so that only the geometry changes. Every field carries a flat, unique marker colour; its
// visual shape is measured in a screenshot of the presented frame (the oracle is the pixels the user sees, never the plugin's own mapper), and trusted clicks land 3 css px inside
// its visual top and bottom edges and at its visual middle, at several columns. A trial counts only where the native hit test (the plain-DOM twin at the same point, labels resolved)
// would NOT reach that field. The field the user sees must get the focus in >= 95 % of >= 30 such trials.
// The same with the water plugin at full intensity (the presented frame frozen with framecap=1, then a strong drop below a field, measured and clicked in that frame).
// Positive control: the host created with `interposer:false` (clicks reach the DOM position): class `interposer` must go red.
import { runGate, H, EFFECTS_BUNDLE, WATER_BUNDLE } from './lib/gate.mjs';
import { openRef, rectsOf } from './lib/f1.mjs';
import { compositorShot, assertLayerHidden } from './lib/pixel.mjs';
import { MARKS, MARK_CSS, MIN_TRIALS, MIN_SHARE, candidates, clickTrials } from './lib/displaced.mjs';

const CRT_BUNDLE = '/dist/plugins/crt.iife.js';
/** F1 with the polyfill, the effects host and one example plugin over the form; the page draws nothing itself (painter=none). */
async function setup(ctx, page, plugin, options, interposer) {
  const bundle = `${ctx.bundle},${EFFECTS_BUNDLE},${plugin === 'crt' ? CRT_BUNDLE : WATER_BUNDLE}`;
  await page.navigate(H.fixtureUrl(ctx.srv, 'f1', { mode: 'poly', bundle, params: { painter: 'none' } }));
  await page.waitForFunction(`!!window.__HIC__ && !!window.HTMLInCanvasEffects && !!window.HicLivePlugins?.${plugin}`, { timeout: 10000 });
  await page.evaluate(`(async () => {
    const canvas = document.querySelector('#hic-surface'); const form = document.querySelector('#demo-form');
    window.__errs = []; canvas.addEventListener('effecterror', (e) => window.__errs.push(String(e.detail && e.detail.error)));
    document.querySelector('#demo-form').addEventListener('submit', (e) => e.preventDefault(), true);
    const host = await HTMLInCanvasEffects.createHost(canvas, form, { maxDpr: 2.5, interposer: ${interposer} });
    window.__fx = await host.addPlugin(HicLivePlugins.${plugin}.plugin, ${JSON.stringify(options)});
    const s = document.createElement('style'); s.textContent = ${JSON.stringify(MARK_CSS)}; document.head.appendChild(s);
    await new Promise((r) => setTimeout(r, 1200));
  })()`);
}

runGate('G-interposer-strong', async (ctx) => {
  const numbers = {};
  const ref = await openRef(ctx);
  await ctx.focus(ref);
  await ref.evaluate(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(MARK_CSS)}; document.head.appendChild(s); })()`);
  const rects = await rectsOf(ref, ['#hic-surface']);
  const origin = { x: rects['#hic-surface'].x, y: rects['#hic-surface'].y };
  const dpr = await ref.evaluate('devicePixelRatio');
  const page = await ctx.page();
  await ctx.focus(page);
  const errors0 = page.errors().length;

  // --- CRT at full curvature, colours untouched: a static, strong barrel ---------------------------------------------------------------------------
  await setup(ctx, page, 'crt', { curvature: 1, scanlines: 0, mask: 0, glow: 0, warmth: 0, flicker: 0, misconvergence: 0 }, !ctx.control);
  await assertLayerHidden(ctx, page, 'crt');
  const crtShot = (await compositorShot(page, '#hic-surface')).img;
  const crt = { discriminating: 0, correct: 0, notDiscriminating: 0, missing: [], trials: [] };
  await clickTrials(ctx, page, ref, candidates(crtShot, Object.keys(MARKS), origin, dpr, crt.missing), crt);
  numbers.crt = crt;
  ctx.check('crt: every marked field is visible in the presented frame', crt.missing.length === 0, crt.missing, 'surface');
  ctx.check(`crt (curvature 1): >= ${MIN_TRIALS} trials where the native hit test would miss the field the user sees`, crt.discriminating >= MIN_TRIALS, crt, 'interposer');
  ctx.check(`crt (curvature 1): a trusted click focuses the field the user sees there in >= ${MIN_SHARE * 100} % of them (${crt.correct}/${crt.discriminating})`, crt.discriminating >= MIN_TRIALS && crt.correct >= MIN_SHARE * crt.discriminating, crt, 'interposer');

  // --- water at full intensity: the presented frame frozen (framecap=1), a strong drop below a field, measured and clicked in that frame -------------------------
  await setup(ctx, page, 'water', { intensity: 1 }, !ctx.control);
  const water = { discriminating: 0, correct: 0, notDiscriminating: 0, missing: [], trials: [], spots: 0 };
  const twin = await rectsOf(ref, Object.keys(MARKS));
  for (let s = 0; s < 40 && water.discriminating < MIN_TRIALS + 10; s++) {
    const sel = Object.keys(MARKS)[s % 4];
    const r = twin[sel];
    // a strong drop (the water plugin's action, strength 2) 35 css px below the field: its crown pushes the field's visual bottom edge down
    const cx = r.x + r.width * (0.3 + 0.1 * (s % 4)), cy = r.y + r.height + 35;
    await ctx.focus(page);
    await page.evaluate('document.querySelector("#hic-surface").removeAttribute("framecap")');
    // FREEZE first (framecap=1: every presented frame stays ~1 s), then the drop, shown by the next presented frame: the screenshot and the clicks judge that frame.
    // The water simulates its surface (its ripples travel on and settle), so it is stirred after the freeze, not before.
    await page.evaluate(`(() => { const c = document.querySelector('#hic-surface'); c.setAttribute('framecap', 1);
      const shown = new Promise((r) => c.addEventListener('effectframe', r, { once: true }));
      window.__fx.trigger('drop', { point: { x: ${cx - origin.x}, y: ${cy - origin.y} }, strength: 2 }).catch(() => {});
      return shown; })()`);
    const shot = (await compositorShot(page, '#hic-surface')).img;
    water.spots++;
    // the candidates nearest the ripples first (the most displaced), three per frozen frame
    const cands = candidates(shot, [sel], origin, dpr, water.missing).sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
    await clickTrials(ctx, page, ref, cands, water, 3);
  }
  await page.evaluate('document.querySelector("#hic-surface").removeAttribute("framecap")');
  numbers.water = water;
  ctx.check(`water (intensity 1, a strong drop): >= ${MIN_TRIALS} trials where the native hit test would miss`, water.discriminating >= MIN_TRIALS, water, 'interposer');
  ctx.check(`water (intensity 1, a strong drop): a trusted click focuses the field the user sees there in >= ${MIN_SHARE * 100} % of them (${water.correct}/${water.discriminating})`, water.discriminating >= MIN_TRIALS && water.correct >= MIN_SHARE * water.discriminating, water, 'interposer');

  numbers.effectErrors = await page.evaluate('window.__errs');
  const errs = page.errors({ includeWarnings: false }).slice(errors0);
  ctx.check('no effecterror, no page error', numbers.effectErrors.length === 0 && errs.length === 0, { effect: numbers.effectErrors, page: errs.slice(0, 3) }, 'surface');
  return { numbers };
}, { controlClasses: ['interposer'] });
