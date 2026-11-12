// G-interposer-strong: the effect-host interposer end to end under a STRONG displacement. F1 under the CRT example plugin at full curvature (k = 0.5: the middle of the screen
// magnified, the edges compressed toward a bezel), with the plugin's colour effects off so that only the geometry changes. Every field carries a flat, unique marker colour; its
// visual shape is measured in a screenshot of the presented frame (the oracle is the pixels the user sees, never the plugin's own mapper), and trusted clicks land 3 css px inside
// its visual top and bottom edges and at its visual middle, at several columns. A trial counts only where the native hit test (the plain-DOM twin at the same point, labels resolved)
// would NOT reach that field. The field the user sees must get the focus in >= 95 % of >= 30 such trials.
// The same with the water plugin at full intensity (the presented frame frozen with framecap=1, then a strong drop below a field, measured and clicked in that frame).
// Hover through the effect (class `hover`), under the same CRT: the page gets a :hover rule for an element OUTSIDE the canvas (a menu chip), and a mouse sweep across the
// drawn form must upload no new source (no rebuild: the rule cannot match inside the form); the same sweep with a rule that matches inside the form must upload (in-run
// positive control). Then a finger (touch emulation, the page's touch-action none, as a plugin that claims its gesture) pans across the form with that rule present: a
// finger moves no :hover (Mobile Safari), so again no upload. Mutants hover-scope-off and finger-hover-follows. Then a :hover rule that counts only with :focus: the
// mouse enters the form's card, the card gets the focus, the mouse leaves; the presented frame must equal a fresh tile (mutant hover-state-kept).
// Positive control: the host created with `interposer:false` (clicks reach the DOM position): class `interposer` must go red.
import { runGate, H, EFFECTS_BUNDLE, WATER_BUNDLE } from './lib/gate.mjs';
import { openRef, rectsOf } from './lib/f1.mjs';
import { compositorShot, assertLayerHidden } from './lib/pixel.mjs';
import { MARKS, MARK_CSS, MIN_TRIALS, MIN_SHARE, candidates, clickTrials, frozenShot, fieldClip, touchesBorder } from './lib/displaced.mjs';

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

/**
 * A :hover rule that counts only together with :focus (the preview.24 audit): the mouse enters the drawn form card through the effect, the card gets the focus, the mouse leaves
 * with the focus kept. The presented frame must then equal a fresh tile of the same state (a mutation that changes no pixel rebuilds the form). Preview.24 cached "the rule cannot
 * match here" while the form had no focus and kept the hover look after the mouse left. Mutant hover-state-kept.
 * @param {any} ctx @param {any} page
 */
async function hoverThenFocus(ctx, page) {
  await ctx.focus(page);
  await page.mouseMove(2, 2);
  const card = await page.evaluate(`(() => {
    const f = document.querySelector('#demo-form .form-card'); f.tabIndex = -1;
    const s = document.createElement('style'); s.id = 'hv-focus'; s.textContent = '.form-card { outline: none !important } .form-card:hover:focus { background: rgb(255, 255, 0) !important }'; document.head.append(s);
    const r = f.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  await H.sleep(600);
  const filled = (img) => { let n = 0; for (let i = 0; i < img.data.length; i += 4) if (img.data[i] > 200 && img.data[i + 1] > 200 && img.data[i + 2] < 60) n++; return n; };
  // the middle of the card's box: under the barrel it is drawn nearer the middle of the canvas, still over the card
  await page.mouseMove(card.x, card.y);
  await H.sleep(500);
  const entered = filled((await compositorShot(page, '#hic-surface')).img);
  await page.evaluate(`document.querySelector('#demo-form .form-card').focus()`);
  await H.sleep(500);
  const focused = filled((await compositorShot(page, '#hic-surface')).img);
  await page.mouseMove(2, 2);
  await H.sleep(600);
  const left = (await compositorShot(page, '#hic-surface')).img;
  await page.evaluate(`document.querySelector('#demo-form .form-card').classList.add('hv-fresh')`);
  await H.sleep(600);
  const fresh = (await compositorShot(page, '#hic-surface')).img;
  let differ = 0, max = 0;
  for (let i = 0; i < left.data.length; i += 4) {
    const d = Math.max(Math.abs(left.data[i] - fresh.data[i]), Math.abs(left.data[i + 1] - fresh.data[i + 1]), Math.abs(left.data[i + 2] - fresh.data[i + 2]));
    if (d > 8) differ++;
    max = Math.max(max, d);
  }
  const state = await page.evaluate(`(() => { const f = document.querySelector('#demo-form .form-card'); const r = { hover: f.matches(':hover'), focus: document.activeElement === f }; f.blur(); f.removeAttribute('tabindex'); f.classList.remove('hv-fresh'); document.getElementById('hv-focus').remove(); return r; })()`);
  const out = { entered, focused, leftFilled: filled(left), freshFilled: filled(fresh), differ, max, sameSize: left.width === fresh.width && left.height === fresh.height, state };
  ctx.check('hover:focus: the rule paints the drawn card once it is hovered and focused, not while only hovered (positive control)', entered === 0 && focused > 1000, out, 'hover');
  ctx.check('hover:focus: after the mouse leaves with the focus kept, the presented frame equals a fresh tile of the same state (no hover look left)', out.sameSize && !state.hover && state.focus && out.leftFilled === 0 && differ === 0, out, 'hover');
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
  numbers.hoverFocus = await hoverThenFocus(ctx, page);

  // --- water at full intensity: the presented frame frozen (framecap=1), a strong drop below a field, measured and clicked in that frame -------------------------
  await setup(ctx, page, 'water', { intensity: 1 }, !ctx.control);
  const water = { discriminating: 0, correct: 0, notDiscriminating: 0, missing: [], trials: [], spots: 0 };
  const twin = await rectsOf(ref, Object.keys(MARKS));
  // one click per frozen frame (below), so up to 100 drops: a frozen frame stays ~1 s, and a loaded Mac takes ~0.8 s of it for the screenshot
  for (let s = 0; s < 100 && water.discriminating < MIN_TRIALS + 10; s++) {
    const sel = Object.keys(MARKS)[s % 4];
    const r = twin[sel];
    // a strong drop (the water plugin's action, strength 2, `swell: true`: one broad crater with a crown on the wake field; a tap's pebble rings in narrow bands that
    // move an edge by +-4 px only, 2026-11-05) 40 css px below the field: its crown pushes the field's visual bottom edge down
    // the drop's column moves along the field with every round of the four fields (golden-ratio steps over 20 % to 80 % of its width): with one click per frozen
    // frame, four fixed columns repeated the same click from the fifth drop on
    const cx = r.x + r.width * (0.2 + 0.6 * (((s % 4) * 0.25 + Math.floor(s / 4) * 0.618) % 1)), cy = r.y + r.height + 40;
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
    // the oracle is the frame still presented at each click (frozenShot, clickTrials): a shot or a click across a frame change is not a trial
    // only the field's neighbourhood is captured (fieldClip): a shot of the whole canvas took ~0.9 s of the ~1 s the frame stays
    const clip = fieldClip(rects['#hic-surface'], r);
    const frozen = await frozenShot(page, async () => (await compositorShot(page, '#hic-surface', { clip })).img);
    if (!frozen) { water.staleShots = (water.staleShots ?? 0) + 1; continue; }
    const shot = frozen.img;
    if (touchesBorder(shot, MARKS[sel])) { water.clipped = (water.clipped ?? 0) + 1; continue; }
    water.spots++;
    // the candidates nearest the ripples first (the most displaced), three per frozen frame
    const cands = candidates(shot, [sel], { x: clip.x, y: clip.y }, dpr, water.missing).sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
    // one per frozen frame: the frame cap of 1 holds it ~1 s, the screenshot can take most of that on a loaded Mac, and each click is also a drop, shown by the next
    // frame (until 2026-11-12 two were made, and the second was often judged against a frame no longer presented)
    await clickTrials(ctx, page, ref, cands, water, 1, frozen.frame);
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
