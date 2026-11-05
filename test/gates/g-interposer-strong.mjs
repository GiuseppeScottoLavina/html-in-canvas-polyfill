// G-interposer-strong: the effect-host interposer end to end under a STRONG displacement. F1 under the CRT example plugin at full curvature (k = 0.5: the middle of the screen
// magnified, the edges compressed toward a bezel), with the plugin's colour effects off so that only the geometry changes. Every field carries a flat, unique marker colour; its
// visual shape is measured in a screenshot of the presented frame (the oracle is the pixels the user sees, never the plugin's own mapper), and trusted clicks land 3 css px inside
// its visual top and bottom edges and at its visual middle, at several columns. A trial counts only where the native hit test (the plain-DOM twin at the same point, labels resolved)
// would NOT reach that field. The field the user sees must get the focus in >= 95 % of >= 30 such trials.
// The same with the water plugin at full intensity (the presented frame frozen with framecap=1, then a strong drop below a field, measured and clicked in that frame).
// Hover through the effect (class `hover`), under the same CRT: the page gets a :hover rule for an element OUTSIDE the canvas (a menu chip), and a mouse sweep across the
// drawn form must upload no new source (no rebuild: the rule cannot match inside the form); the same sweep with a rule that matches inside the form must upload (in-run
// positive control). Then a finger (touch emulation, the page's touch-action none, as a plugin that claims its gesture) pans across the form with that rule present: a
// finger moves no :hover (Mobile Safari), so again no upload. Mutants hover-scope-off and finger-hover-follows.
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
    window.__host = host;
    window.__fx = await host.addPlugin(HicLivePlugins.${plugin}.plugin, ${JSON.stringify(options)});
    const s = document.createElement('style'); s.textContent = ${JSON.stringify(MARK_CSS)}; document.head.appendChild(s);
    await new Promise((r) => setTimeout(r, 1200));
  })()`);
}

/** Uploads of a new source (host.stats().uploads) during `fn`, once the page is quiet. @param {any} page @param {() => Promise<void>} fn */
async function uploadsDuring(page, fn) {
  await H.sleep(700);
  const u0 = await page.evaluate('window.__host.stats().uploads');
  await fn();
  await H.sleep(400);
  return (await page.evaluate('window.__host.stats().uploads')) - u0;
}

/** @param {any} ctx @param {any} page @param {{x: number, y: number, width: number, height: number}} box  the canvas (css px of the page) */
async function hoverThroughEffect(ctx, page, box) {
  await ctx.focus(page);
  await page.evaluate(`(() => {
    document.activeElement && document.activeElement.blur && document.activeElement.blur();
    const nav = document.createElement('nav'); nav.innerHTML = '<button type="button" class="hv-chip">chip</button>'; document.body.append(nav);
    const s = document.createElement('style'); s.id = 'hv-rules'; s.textContent = '.hv-chip:hover{outline:2px solid #f0f}'; document.head.append(s);
  })()`);
  // a sweep along the middle of the form, left to right and back, at 120 events per second
  const sweep = async (mouse) => {
    const y = box.y + box.height * 0.45;
    const at = (k) => ({ x: box.x + box.width * (0.08 + 0.84 * Math.abs(((k / 40) % 2) - 1)), y: y + 60 * Math.sin(k / 7) });
    if (mouse) { for (let k = 0; k <= 80; k++) { const p = at(k); await page.mouseMove(p.x, p.y); await H.sleep(8); } return; }
    const tp = (k) => { const p = at(k); return [{ x: p.x, y: p.y, radiusX: 4, radiusY: 4, force: 1, id: 5 }]; };
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(0) });
    for (let k = 1; k <= 80; k++) { await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(k) }); await H.sleep(8); }
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const outside = await uploadsDuring(page, () => sweep(true));
  await page.evaluate(`document.getElementById('hv-rules').textContent += '#demo-form label:hover, #demo-form input:hover, #demo-form textarea:hover { outline: 2px solid #f0f }'`);
  const inside = await uploadsDuring(page, () => sweep(true));
  await page.mouseMove(2, 2);
  await page.evaluate(`document.getElementById('hv-rules').textContent += 'html { touch-action: none }'`);
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const finger = await uploadsDuring(page, () => sweep(false));
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page.evaluate(`(() => { document.getElementById('hv-rules').remove(); document.querySelector('nav .hv-chip').parentElement.remove(); document.activeElement && document.activeElement.blur && document.activeElement.blur(); })()`);
  const out = { outside, inside, finger };
  ctx.check('hover: a :hover rule for an element outside the canvas uploads no new source while the mouse crosses the drawn form through the effect', outside === 0, out, 'hover');
  ctx.check('hover: a :hover rule that matches inside the form does (positive control of the measure)', inside > 0, out, 'hover');
  ctx.check('hover: a finger panning across the form through the effect moves no :hover (no upload with that rule present)', finger === 0, out, 'hover');
  return out;
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

  // --- hover through the effect: a :hover rule outside the drawn form rebuilds nothing; one inside does (control); a finger pan hovers nothing -----------------------
  numbers.hover = await hoverThroughEffect(ctx, page, rects['#hic-surface']);

  // --- water at full intensity: the presented frame frozen (framecap=1), a strong drop below a field, measured and clicked in that frame -------------------------
  await setup(ctx, page, 'water', { intensity: 1 }, !ctx.control);
  const water = { discriminating: 0, correct: 0, notDiscriminating: 0, missing: [], trials: [], spots: 0 };
  const twin = await rectsOf(ref, Object.keys(MARKS));
  for (let s = 0; s < 40 && water.discriminating < MIN_TRIALS + 10; s++) {
    const sel = Object.keys(MARKS)[s % 4];
    const r = twin[sel];
    // a strong drop (the water plugin's action, strength 2, `swell: true`: one broad crater with a crown on the wake field; a tap's pebble rings in narrow bands that
    // move an edge by +-4 px only, 2026-11-05) 40 css px below the field: its crown pushes the field's visual bottom edge down
    const cx = r.x + r.width * (0.3 + 0.1 * (s % 4)), cy = r.y + r.height + 40;
    await ctx.focus(page);
    await page.evaluate('document.querySelector("#hic-surface").removeAttribute("framecap")');
    await H.sleep(50);
    // The drop, then the FREEZE inside the effectframe of the first frame 170 ms or more after it: framecap=1 keeps that frame presented for ~1 s, so the screenshot and
    // the clicks judge it. Uncapped, the water advances in real time, so that frame shows the drop at a fixed age (~170 ms), when the crown has pushed the field's bottom
    // edge down as one piece (at age 0 the crater magnifies a thin sliver of the field far below it instead).
    await page.evaluate(`(() => { const c = document.querySelector('#hic-surface');
      const t = performance.now();
      const shown = new Promise((r) => { const on = () => { if (performance.now() - t >= 170) { c.setAttribute('framecap', 1); c.removeEventListener('effectframe', on); r(); } }; c.addEventListener('effectframe', on); });
      window.__fx.trigger('drop', { point: { x: ${cx - origin.x}, y: ${cy - origin.y} }, strength: 2, swell: true }).catch(() => {});
      return shown; })()`);
    const shot = (await compositorShot(page, '#hic-surface')).img;
    water.spots++;
    // the candidates nearest the ripples first (the most displaced), three per frozen frame
    const cands = candidates(shot, [sel], origin, dpr, water.missing).sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
    // two per frozen frame: the frame cap of 1 holds the frame ~1 s, and a third click can outlast it (each click is also a drop, shown by the next frame)
    await clickTrials(ctx, page, ref, cands, water, 2);
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
