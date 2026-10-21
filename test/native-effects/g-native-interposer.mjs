// G-native-interposer: the effects host over the browser's OWN HTML-in-Canvas implementation (Chrome Canary with CanvasDrawElement, the polyfill
// installed in mode native), pointer input through a STRONG displacement, end to end with trusted CDP input. The method of G-interposer-strong
// (test/gates/lib/displaced.mjs): F1 under the CRT plugin at curvature 1 (geometry only) and under the water plugin at intensity 1 (four stacked
// ripples, the presented frame frozen with framecap=1). Every field has a flat marker colour, its visual shape is measured in a screenshot of the
// presented frame (the pixels the user sees, never the plugin's mapper), and trusted clicks land where the plain-DOM twin says the native hit test
// would NOT reach it. The field the user sees must get the focus in >= 95 % of >= 30 such trials.
// Also on native: native hover follows the field the user sees (the pointer comes to rest there in small steps, and `:hover` is read), and typing
// after such a click reaches that field.
// Positive control: the host created with `interposer:false` (the source stays at its DOM position for hit testing): classes `interposer` and
// `hover` must go red.
//   node test/native-effects/g-native-interposer.mjs [--no-control]      (npm run test:native-effects runs it; needs Chrome Canary)
import { runGate, H, EFFECTS_BUNDLE, WATER_BUNDLE } from '../gates/lib/gate.mjs';
import { openRef, rectsOf } from '../gates/lib/f1.mjs';
import { compositorShot } from '../gates/lib/pixel.mjs';
import { MARKS, MARK_CSS, MIN_TRIALS, MIN_SHARE, candidates, clickTrials, nativeAt } from '../gates/lib/displaced.mjs';

const CRT_BUNDLE = '/dist/plugins/crt.iife.js';
const HOVER_TRIALS = 12;

/** F1 in mode native (the browser draws; the polyfill steps aside), the effects host and one example plugin over the form. */
async function setup(ctx, page, plugin, options, interposer) {
  const bundle = `${ctx.bundle},${EFFECTS_BUNDLE},${plugin === 'crt' ? CRT_BUNDLE : WATER_BUNDLE}`;
  await page.navigate(H.fixtureUrl(ctx.srv, 'f1', { mode: 'native', bundle, params: { painter: 'none' } }));
  await page.waitForFunction(`!!window.__HIC__ && !!window.HTMLInCanvasEffects && !!window.HicLivePlugins?.${plugin}`, { timeout: 10000 });
  return page.evaluate(`(async () => {
    const canvas = document.querySelector('#hic-surface'); const form = document.querySelector('#demo-form');
    window.__errs = []; canvas.addEventListener('effecterror', (e) => window.__errs.push(String(e.detail && e.detail.error)));
    document.querySelector('#demo-form').addEventListener('submit', (e) => e.preventDefault(), true);
    const host = await HTMLInCanvasEffects.createHost(canvas, form, { maxDpr: 2.5, interposer: ${interposer} });
    window.__host = host;
    window.__fx = await host.addPlugin(HicLivePlugins.${plugin}.plugin, ${JSON.stringify(options)});
    const s = document.createElement('style'); s.textContent = ${JSON.stringify(MARK_CSS)}; document.head.appendChild(s);
    await new Promise((r) => setTimeout(r, 1200));
    return { mode: __HIC__.installed.mode, layers: document.querySelectorAll('hic-layer').length, stats: host.stats() };
  })()`);
}

/** The pointer comes to rest at each candidate in small steps (as a hand does); then `:hover` must be on the field the user sees there. */
async function hoverTrials(ctx, page, ref, cands, out) {
  const native = await nativeAt(ref, cands);
  const subs = cands.map((c, i) => ({ ...c, native: native[i] })).filter((c) => c.native !== c.sel.slice(1)).slice(0, HOVER_TRIALS);
  for (const c of subs) {
    for (const k of [12, 8, 4, 2, 0]) { await page.mouseMove(c.x - k, c.y); await H.sleep(16); }
    await H.sleep(60);
    const hovered = await page.evaluate(`[...document.querySelectorAll(${JSON.stringify(Object.keys(MARKS).join(','))})].filter((e) => e.matches(':hover')).map((e) => e.id)`);
    const ok = hovered.length === 1 && hovered[0] === c.sel.slice(1);
    out.trials++;
    if (ok) out.correct++;
    if (!ok || out.samples.length < 4) out.samples.push({ sel: c.sel, x: Math.round(c.x), y: Math.round(c.y), native: c.native, hovered });
  }
}

runGate('G-native-interposer', async (ctx) => {
  const numbers = {};
  // the launch tab of a Chrome started with --enable-blink-features carries an infobar (a shorter viewport, and F1 centres its form in it):
  // the twin and the effect page are both fresh tabs, so their layouts are the same
  await ctx.page();
  const ref = await openRef(ctx);
  await ctx.focus(ref);
  await ref.evaluate(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(MARK_CSS)}; document.head.appendChild(s); })()`);
  const rects = await rectsOf(ref, ['#hic-surface']);
  const origin = { x: rects['#hic-surface'].x, y: rects['#hic-surface'].y };
  const dpr = await ref.evaluate('devicePixelRatio');
  const page = await ctx.page();
  await ctx.focus(page);
  const errors0 = page.errors().length;

  // --- CRT at full curvature, colours untouched: a static, strong barrel ------------------------------------------------------------------
  const st = await setup(ctx, page, 'crt', { curvature: 1, scanlines: 0, mask: 0, glow: 0, warmth: 0, flicker: 0, misconvergence: 0 }, !ctx.control);
  numbers.setup = st;
  ctx.check('the polyfill stepped aside for the native implementation (mode native, no live layer) and the effects host runs on it', st.mode === 'native' && st.layers === 0 && st.stats.frames > 0, st, 'surface');
  const crtShot = (await compositorShot(page, '#hic-surface')).img;
  ctx.check('crt: the presented frame is not blank', H.pixelStats(crtShot).nonBlank, null, 'surface');
  const crt = { discriminating: 0, correct: 0, notDiscriminating: 0, missing: [], trials: [] };
  const crtCands = candidates(crtShot, Object.keys(MARKS), origin, dpr, crt.missing);
  await clickTrials(ctx, page, ref, crtCands, crt);
  numbers.crt = crt;
  ctx.check('crt: every marked field is visible in the presented frame', crt.missing.length === 0, crt.missing, 'surface');
  ctx.check(`crt (curvature 1): >= ${MIN_TRIALS} trials where the native hit test at the DOM position would miss the field the user sees`, crt.discriminating >= MIN_TRIALS, crt, 'interposer');
  ctx.check(`crt (curvature 1): a trusted click focuses the field the user sees there in >= ${MIN_SHARE * 100} % of them (${crt.correct}/${crt.discriminating})`, crt.discriminating >= MIN_TRIALS && crt.correct >= MIN_SHARE * crt.discriminating, crt, 'interposer');

  const hover = { trials: 0, correct: 0, samples: [] };
  await hoverTrials(ctx, page, ref, crtCands.filter((_, i) => i % 3 === 0), hover);
  numbers.hover = hover;
  ctx.check(`crt: native :hover follows the field the user sees under a pointer at rest (>= ${MIN_SHARE * 100} % of ${HOVER_TRIALS}; ${hover.correct}/${hover.trials})`, hover.trials >= HOVER_TRIALS && hover.correct >= MIN_SHARE * hover.trials, hover, 'hover');

  // typing after a click through the barrel reaches the field the user sees there, and the presented pixels change
  const typing = await (async () => {
    const c = crtCands.find((k) => k.sel === '#name' && k.kind === 'middle');
    if (!c) return { ok: false, reason: 'no #name candidate' };
    await page.evaluate(`document.activeElement && document.activeElement.blur(); document.querySelector('#name').value = ''`);
    await page.click(c.x, c.y);
    await H.sleep(120);
    const before = (await compositorShot(page, '#hic-surface')).img;
    await page.typeText('WWW');
    await H.sleep(300);
    const after = (await compositorShot(page, '#hic-surface')).img;
    const value = await page.evaluate(`document.querySelector('#name').value`);
    const changed = H.compareImages(after, before).countOver16;
    return { ok: value === 'WWW' && changed > 50, value, changedPixels: changed };
  })();
  numbers.typing = typing;
  ctx.check('crt: typing after a click through the barrel reaches the field the user sees, and the presented frame shows it', typing.ok, typing, 'interposer');

  // --- water at full intensity: four stacked ripples per spot, the presented frame frozen (framecap=1) while it is measured and clicked -----------------
  await setup(ctx, page, 'water', { intensity: 1 }, !ctx.control);
  const water = { discriminating: 0, correct: 0, notDiscriminating: 0, missing: [], trials: [], spots: 0 };
  const twin = await rectsOf(ref, Object.keys(MARKS));
  for (let s = 0; s < 40 && water.discriminating < MIN_TRIALS + 10; s++) {
    const sel = Object.keys(MARKS)[s % 4];
    const r = twin[sel];
    const cx = r.x + r.width * (0.3 + 0.1 * (s % 4)), cy = r.y + (s % 2 ? r.height + 20 : -20);
    await ctx.focus(page);
    await page.evaluate('document.querySelector("#hic-surface").removeAttribute("framecap")');
    for (let k = 0; k < 4; k++) { await page.mouseMove(cx - 30, cy); await H.sleep(10); await page.mouseMove(cx + 30, cy); await H.sleep(26); }
    await H.sleep(260);
    await page.evaluate('document.querySelector("#hic-surface").setAttribute("framecap", 1); new Promise((r) => document.querySelector("#hic-surface").addEventListener("effectframe", r, { once: true }))');
    const shot = (await compositorShot(page, '#hic-surface')).img;
    water.spots++;
    const cands = candidates(shot, [sel], origin, dpr, water.missing).sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
    await clickTrials(ctx, page, ref, cands, water, 3);
  }
  await page.evaluate('document.querySelector("#hic-surface").removeAttribute("framecap")');
  numbers.water = water;
  ctx.check(`water (intensity 1, stacked ripples): >= ${MIN_TRIALS} trials where the native hit test at the DOM position would miss`, water.discriminating >= MIN_TRIALS, water, 'interposer');
  ctx.check(`water (intensity 1, stacked ripples): a trusted click focuses the field the user sees there in >= ${MIN_SHARE * 100} % of them (${water.correct}/${water.discriminating})`, water.discriminating >= MIN_TRIALS && water.correct >= MIN_SHARE * water.discriminating, water, 'interposer');

  numbers.interposer = await page.evaluate('window.__host.stats()');
  numbers.effectErrors = await page.evaluate('window.__errs');
  const errs = page.errors({ includeWarnings: false }).slice(errors0);
  ctx.check('no effecterror, no page error', numbers.effectErrors.length === 0 && errs.length === 0, { effect: numbers.effectErrors, page: errs.slice(0, 3) }, 'surface');
  return { numbers };
}, { chrome: 'canary', nativeDrawElement: true, controlClasses: ['interposer', 'hover'] });
