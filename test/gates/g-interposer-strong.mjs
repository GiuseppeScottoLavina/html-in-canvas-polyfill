// G-interposer-strong: the effect-host interposer end to end under a STRONG displacement. F1 under the CRT example plugin at full curvature (k = 0.5: the middle of the screen
// magnified, the edges compressed toward a bezel), with the plugin's colour effects off so that only the geometry changes. Every field carries a flat, unique marker colour; its
// visual shape is measured in a screenshot of the presented frame (the oracle is the pixels the user sees, never the plugin's own mapper), and trusted clicks land 3 css px inside
// its visual top and bottom edges and at its visual middle, at several columns. A trial counts only where the native hit test (the plain-DOM twin at the same point, labels resolved)
// would NOT reach that field. The field the user sees must get the focus in >= 95 % of >= 30 such trials.
// The same with the water plugin at full intensity (four stacked ripples, the presented frame frozen with framecap=1 while it is measured and clicked).
// Positive control: the host created with `interposer:false` (clicks reach the DOM position): class `interposer` must go red.
import { runGate, H, EFFECTS_BUNDLE, WATER_BUNDLE } from './lib/gate.mjs';
import { openRef, rectsOf } from './lib/f1.mjs';
import { compositorShot, assertLayerHidden } from './lib/pixel.mjs';

const CRT_BUNDLE = '/dist/plugins/crt.iife.js';
const MARKS = { '#name': [255, 0, 0], '#email': [0, 255, 0], '#project': [0, 0, 255], '#message': [255, 0, 255] };
const MARK_CSS = Object.entries(MARKS).map(([s, c]) => `${s}{background:rgb(${c}) !important;border-color:rgb(${c}) !important;box-shadow:none !important;background-image:none !important;color:rgb(${c}) !important}`).join('');
const MIN_TRIALS = 30;
const MIN_SHARE = 0.95;
const COLUMNS = [0.08, 0.2, 0.32, 0.44, 0.56, 0.68, 0.8, 0.92];

const isMark = (img, i, c) => c.every((v, k) => (v > 0 ? img.data[i + k] > 150 : img.data[i + k] < 100));

/** visual bounding box of a marker colour in the screenshot, device px (null when absent) */
function bbox(img, c) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) if (isMark(img, (y * img.width + x) * 4, c)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/** visual top / bottom of the marker at device column `col` (the longest run), device px */
function column(img, c, col) {
  let best = null, start = -1;
  for (let y = 0; y <= img.height; y++) {
    const on = y < img.height && isMark(img, (y * img.width + col) * 4, c);
    if (on && start < 0) start = y;
    if (!on && start >= 0) { if (!best || y - start > best.bottom - best.top) best = { top: start, bottom: y }; start = -1; }
  }
  return best && best.bottom - best.top >= 6 ? best : null;
}

/** The ids of the controls the native hit test reaches at each point on the twin (a label resolves to its control), in one evaluation. */
const nativeAt = (ref, pts) => ref.evaluate(`${JSON.stringify(pts.map((p) => [p.x, p.y]))}.map(([x, y]) => { const r = document.elementFromPoint(x, y); let c = r && r.closest('input,select,textarea,button'); if (!c) { const l = r && r.closest('label'); c = l && l.control; } return c ? c.id : ''; })`);

/** Candidate clicks at the visual places of the marked fields in `shot`: 3 css px inside the visual top, bottom, left and right edges and at the middle, along several columns / rows. */
function candidates(shot, fields, origin, dpr, missing) {
  const out = [];
  for (const sel of fields) {
    const c = MARKS[sel];
    const box = bbox(shot, c);
    if (!box) { missing.push(sel); continue; }
    for (const f of COLUMNS) {
      const col = Math.round(box.x0 + f * (box.x1 - box.x0));
      const e = column(shot, c, col);
      if (!e) continue;
      for (const [kind, yDev] of [['top', e.top + 3 * dpr], ['top+6', e.top + 6 * dpr], ['middle', (e.top + e.bottom) / 2], ['bottom-6', e.bottom - 6 * dpr], ['bottom', e.bottom - 3 * dpr]]) {
        if (yDev > e.top && yDev < e.bottom) out.push({ sel, kind, x: origin.x + col / dpr, y: origin.y + yDev / dpr });
      }
    }
    const midRow = Math.round((box.y0 + box.y1) / 2);
    let left = -1, right = -1;
    for (let x = 0; x < shot.width; x++) if (isMark(shot, (midRow * shot.width + x) * 4, c)) { if (left < 0) left = x; right = x; }
    if (left >= 0 && right - left > 12 * dpr) {
      out.push({ sel, kind: 'left', x: origin.x + left / dpr + 3, y: origin.y + midRow / dpr });
      out.push({ sel, kind: 'right', x: origin.x + (right + 1) / dpr - 3, y: origin.y + midRow / dpr });
    }
  }
  return out;
}

/**
 * Trusted clicks at the candidates where the native hit test would NOT reach the field the user sees there; at most `max` (a frozen frame is presented for ~1 s).
 * @returns {Promise<void>} counts into `out`
 */
async function clickTrials(ctx, page, ref, cands, out, max = Infinity) {
  // read from the twin without bringing it to the front: a tab switch makes the effect page visible again and re-render, which would change the frozen frame
  const native = await nativeAt(ref, cands);
  const subs = cands.map((c, i) => ({ ...c, native: native[i] })).filter((c) => { const d = c.native !== c.sel.slice(1); if (!d) out.notDiscriminating++; return d; }).slice(0, max);
  for (const c of subs) {
    await page.evaluate('document.activeElement && document.activeElement.blur()');
    await page.click(c.x, c.y);
    await H.sleep(60);
    const active = await page.evaluate('document.activeElement && document.activeElement.id');
    const ok = active === c.sel.slice(1);
    out.discriminating++;
    if (ok) out.correct++;
    if (!ok || out.trials.length < 6) out.trials.push({ sel: c.sel, kind: c.kind, x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10, native: c.native, active, ok });
  }
}

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

  // --- water at full intensity: four stacked ripples per spot, the presented frame frozen (framecap=1) while it is measured and clicked ------------------------------
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
    // the candidates nearest the ripples first (the most displaced), three per frozen frame
    const cands = candidates(shot, [sel], origin, dpr, water.missing).sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
    await clickTrials(ctx, page, ref, cands, water, 3);
  }
  await page.evaluate('document.querySelector("#hic-surface").removeAttribute("framecap")');
  numbers.water = water;
  ctx.check(`water (intensity 1, stacked ripples): >= ${MIN_TRIALS} trials where the native hit test would miss`, water.discriminating >= MIN_TRIALS, water, 'interposer');
  ctx.check(`water (intensity 1, stacked ripples): a trusted click focuses the field the user sees there in >= ${MIN_SHARE * 100} % of them (${water.correct}/${water.discriminating})`, water.discriminating >= MIN_TRIALS && water.correct >= MIN_SHARE * water.discriminating, water, 'interposer');

  numbers.effectErrors = await page.evaluate('window.__errs');
  const errs = page.errors({ includeWarnings: false }).slice(errors0);
  ctx.check('no effecterror, no page error', numbers.effectErrors.length === 0 && errs.length === 0, { effect: numbers.effectErrors, page: errs.slice(0, 3) }, 'surface');
  return { numbers };
}, { controlClasses: ['interposer'] });
