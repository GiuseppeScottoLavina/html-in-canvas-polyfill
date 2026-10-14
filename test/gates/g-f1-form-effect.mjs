// G-f1-form-effect: F1 with the water plugin on (WebGPU host over the polyfill's snapshot). WebGPU canvases are judged from compositor SCREENSHOTS taken with the live layer
// forced invisible (a visible layer cannot pass) and with the layer's computed opacity asserted 0.
//   - the presented frame is not blank; intensity 0 equals the plain surface; a ripple distorts it (displacement, not a repaint)
//   - typing reaches the live field and changes the presented pixels
//   - idle clicks 2 px inside the inner edge of controls activate exactly that control and no other
//   - THE INTERPOSER, deterministically: while four stacked ripples displace the form, the presented frame is FROZEN (framecap=1, one presented frame for ~1 s), the visual position of
//     the visual top/bottom edge of a field (flat unique marker colour) is measured in a screenshot of that frame; a trusted click 3 css px INSIDE the visual edge must focus that field (and not a neighbour).
//     Only trials where the NATIVE hit test would give the other answer count. >= 10 such trials are required and >= 80 % must be correct.
//     Positive control: the same run with `interposer:false` must fail that assertion (class 'interposer').
//   - FPS cap at 30 / 60 / 120 (120 only on a >= 110 Hz display) from an INDEPENDENT clock: GPUCanvasContext.getCurrentTexture() calls stamped by a page-side tracker
//     (lib/present.mjs), never the polyfill's `effectframe` event. Positive control: cap removed must violate the bound (class 'cap').
import { runGate, H } from './lib/gate.mjs';
import { openRef, rectsOf, center, diffImages } from './lib/f1.mjs';
import { setupEffect } from './lib/effect.mjs';
import { compositorShot, assertLayerHidden } from './lib/pixel.mjs';
import { PRESENT_SRC, presentedHz } from './lib/present.mjs';
import { checkEdgeHits } from './lib/hit.mjs';

const SELECTORS = ['#hic-surface', '#name', '#email', '#project', '#consent', '#submit-button'];
const TRIAL_ATTEMPTS = 26;
const MIN_TRIALS = 10;
const MIN_CORRECT_SHARE = 0.8;

/** A quick pointer stroke centred on (x, y): the water plugin drops a ripple there. */
async function drop(page, x, y) {
  await page.mouseMove(x - 30, y);
  await H.sleep(10);
  await page.mouseMove(x + 30, y);
}

/** Flat, saturated, unique background per field: its visual rectangle in a screenshot is then unambiguous (the shader grades colours by <= 16 levels). */
const MARKS = { '#name': [255, 0, 0], '#email': [0, 255, 0], '#project': [0, 0, 255] };
const MARK_CSS = Object.entries(MARKS).map(([s, c]) => `${s}{background:rgb(${c}) !important;border-color:rgb(${c}) !important;box-shadow:none !important;background-image:none !important}`).join('');

/** Is pixel i of `img` the marker colour `c` (dominant channel high, the other two low)? */
const isMark = (img, i, c) => c.every((v, k) => (v > 0 ? img.data[i + k] > 150 : img.data[i + k] < 100));

/** Visual top/bottom of the marker in the screenshot at css column `x` (median over a few device columns), in css px of the surface. */
function visualEdges(img, c, x, dpr) {
  const tops = [], bottoms = [];
  for (let dxp = -3; dxp <= 3; dxp++) {
    const col = Math.round(x * dpr) + dxp;
    let top = -1, bottom = -1;
    for (let y = 0; y < img.height; y++) if (isMark(img, (y * img.width + col) * 4, c)) { if (top < 0) top = y; bottom = y; }
    if (top >= 0) { tops.push(top); bottoms.push(bottom + 1); }
  }
  if (tops.length < 4) return null;
  const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
  return { top: med(tops) / dpr, bottom: med(bottoms) / dpr };
}

/**
 * Deterministic interposer trials (see the header). Each attempt stacks four ripples, FREEZES the presented frame, measures the visual top/bottom edge of a field at one column
 * from its marker colour, and clicks 3 css px INSIDE a visual edge where the native hit test (twin) would not reach the field: that field, and no neighbour, must be focused.
 */
async function interposerTrials(ctx, page, ref, rects, dpr, origin) {
  const targets = ['#name', '#email', '#project'];
  const out = { attempts: 0, discriminating: 0, correct: 0, notDiscriminating: 0, noMark: 0, trials: [] };
  const surface = '#hic-surface';
  const frozen = (on) => page.evaluate(`document.querySelector(${JSON.stringify(surface)}).${on ? "setAttribute('framecap', 1)" : "removeAttribute('framecap')"}`);
  await page.evaluate(`(() => { const s = document.createElement('style'); s.id = '__marks'; s.textContent = ${JSON.stringify(MARK_CSS)}; document.head.appendChild(s); })()`);
  await H.sleep(1200); // the snapshot picks the marker colours up
  for (let t = 0; t < TRIAL_ATTEMPTS && out.discriminating < MIN_TRIALS + 6; t++) {
    const sel = targets[t % targets.length];
    const r = rects[sel];
    const cx = r.x + r.width * (0.3 + 0.4 * ((t % 5) / 4));
    const cyDrop = r.y + r.height - 12 - 64 * (t % 2 ? 1 : -0.8);
    out.attempts++;
    await page.evaluate('document.activeElement && document.activeElement.blur()');
    for (let k = 0; k < 4; k++) { await drop(page, cx, cyDrop); await H.sleep(26); } // the four ripple slots stack on one spot (and replace the previous trial's)
    await H.sleep(250 + 25 * (t % 4));
    // FREEZE: framecap=1 keeps the frame presented now for ~1 s, so the screenshot and the clicks judge the SAME displacement (the mapper of that presented frame)
    await page.evaluate(`document.querySelector(${JSON.stringify(surface)}).setAttribute('framecap', 1); new Promise((r) => document.querySelector(${JSON.stringify(surface)}).addEventListener('effectframe', r, { once: true }))`);
    const shot = (await compositorShot(page, surface)).img;
    const e = visualEdges(shot, MARKS[sel], cx - origin.x, dpr);
    if (!e) { out.noMark++; out.trials.push({ sel, skipped: 'marker not found' }); await frozen(false); continue; }
    const dTop = e.top - (r.y - origin.y), dBot = e.bottom - (r.y + r.height - origin.y);
    const rec = { sel, dTop: Math.round(dTop * 10) / 10, dBot: Math.round(dBot * 10) / 10 };
    // candidate clicks 3 css px inside each VISUAL edge (an 'outside' click is not asserted: the field's label wraps it, and clicking a label focuses its field by design). The NATIVE answer is read from the plain-DOM twin (same window, same layout, document.elementFromPoint, label
    // controls resolved): a candidate counts only when the native hit test would give the other answer, so label-wrapped fields cannot make the interposer look better than it is.
    const cands = [{ kind: 'inside', y: origin.y + e.top + 3 }, { kind: 'inside', y: origin.y + e.bottom - 3 }];
    for (const c of cands) c.native = await ref.evaluate(`(() => { const r = document.elementFromPoint(${cx}, ${c.y}); let c = r && r.closest('input,select,textarea,button'); if (!c) { const l = r && r.closest('label'); c = l && l.control; } return c ? c.id : ''; })()`);
    const subs = cands.filter((c) => c.native !== sel.slice(1)).map((c) => ({ ...c, expectFocus: true }));
    if (!subs.length) { out.notDiscriminating++; out.trials.push({ ...rec, skipped: 'native would answer the same' }); await frozen(false); continue; }
    const picked = subs.slice(0, 2);
    for (const sub of picked) {
      await page.evaluate('document.activeElement && document.activeElement.blur()');
      await page.click(cx, sub.y);
      await H.sleep(120);
      const active = await page.evaluate('document.activeElement && document.activeElement.id');
      const focused = active === sel.slice(1);
      const ok = sub.expectFocus ? focused : !focused;
      out.discriminating++;
      if (ok) out.correct++;
      out.trials.push({ ...rec, kind: sub.kind, native: sub.native, active, ok });
    }
    await frozen(false);
  }
  await page.evaluate(`document.getElementById('__marks')?.remove()`);
  return out;
}

runGate('G-f1-form-effect', async (ctx) => {
  const numbers = {};
  const ref = await openRef(ctx);
  await ctx.focus(ref);
  const rects = await rectsOf(ref, SELECTORS);
  const refShot = await H.screenshotElement(ref, '#hic-surface');
  const dpr = refShot.geo.dpr;
  const origin = { x: rects['#hic-surface'].x, y: rects['#hic-surface'].y };

  const page = await ctx.page();
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PRESENT_SRC });
  await ctx.focus(page);
  const errors0 = page.errors().length;
  await setupEffect(ctx, page, { interposer: !ctx.control });
  await page.evaluate(`window.__hits = {}; document.addEventListener('click', (e) => { const t = e.target; const id = (t.closest && t.closest('input,button,select,textarea,label')?.id) || t.localName; window.__hits[id] = (window.__hits[id] || 0) + 1; }, true)`);
  await ctx.focus(page);
  await H.sleep(500);
  await assertLayerHidden(ctx, page, 'effect on');

  // --- presented frame vs the plain render ------------------------------------------------------------------------------------------
  await page.evaluate('window.__water.setOptions({ intensity: 0 })');
  await H.sleep(700);
  const flat = await compositorShot(page);
  const st = H.pixelStats(flat.img);
  ctx.check('the presented frame is not blank', st.nonBlank, { distinctColors: st.distinctColors, nonDominantFraction: st.nonDominantFraction }, 'content');
  // the shader grades colours even at intensity 0 (glow, vignette: 5-16 levels over most of the frame), so the oracle is structural: no pixel off by more than 32 levels except <= 3 %
  const cmp0 = H.compareImages(flat.img, refShot.img, { tolerance: 32 });
  numbers.intensity0Fraction = cmp0.sizeMatch ? cmp0.fraction : null;
  numbers.intensity0MaxDiff = cmp0.maxDiff;
  ctx.check('intensity 0 equals the plain render up to the shader grading (delta > 32 on <= 3 % of pixels)', cmp0.sizeMatch && cmp0.fraction <= 0.03, { fraction: cmp0.fraction, countOver16: cmp0.countOver16, overBBox: cmp0.overBBox }, 'content');
  await page.evaluate('window.__water.setOptions({ intensity: 1 })');
  await drop(page, center(rects['#project']).x, center(rects['#project']).y);
  await H.sleep(60);
  const bent = await compositorShot(page);
  const cmp1 = H.compareImages(bent.img, flat.img);
  numbers.rippleFraction = cmp1.sizeMatch ? cmp1.fraction : null;
  ctx.check('a ripple distorts the presented frame (displacement present, frame not replaced)', cmp1.sizeMatch && cmp1.countOver16 > 300 && cmp1.fraction < 0.6, { fraction: cmp1.fraction, countOver16: cmp1.countOver16 }, 'content');

  // --- typing through the effect (pixels change in the presented frame; no reading of the polyfill's own counters) ---------------------------------
  await H.sleep(3600); // ripples die out
  const nameC = center(rects['#name']);
  const beforeType = (await compositorShot(page)).img;
  await page.click(nameC.x, nameC.y);
  await H.sleep(200);
  await page.key('End');
  await H.typeKeys(page, 'QQ', { intervalMs: 60 });
  await H.sleep(500);
  const typed = await page.evaluate('({v: document.getElementById("name").value, a: document.activeElement && document.activeElement.id})');
  const afterType = (await compositorShot(page)).img;
  const rel = { x: rects['#name'].x - origin.x, y: rects['#name'].y - origin.y, width: rects['#name'].width, height: rects['#name'].height };
  const dType = diffImages(beforeType, afterType, { rect: rel, dpr });
  numbers.typedRegionCountOver16 = dType.countOver16;
  ctx.check('typing reaches the live field through the effect', typed.v.endsWith('QQ') && typed.a === 'name', typed, 'typing');
  ctx.check('typing changes the presented pixels of the field', dType.countOver16 > 20, { countOver16: dType.countOver16 }, 'typing');
  await page.evaluate('document.activeElement.blur()');

  // --- idle clicks 2 px inside the inner edge: that control and no other ---------------------------------------------------------------------------
  await page.evaluate('window.__water.setOptions({ intensity: 0.28 })');
  await H.sleep(300);
  for (const [sel, id] of [['#submit-button', 'submit-button'], ['#consent', 'consent']]) {
    await page.evaluate('window.__hits = {}');
    const q = rects[sel];
    await page.click(q.x + 2.5, q.y + q.height / 2);
    await H.sleep(250);
    const hits = await page.evaluate('window.__hits');
    ctx.check(`an idle click 2.5 px inside the left edge of ${id} reaches it and no other control`, Object.keys(hits).length === 1 && Object.keys(hits)[0] === id, hits, 'hit');
  }

  // --- the interposer against the real GPU frame: deterministic trials -------------------------------------------------------------------------------
  await page.evaluate('window.__water.setOptions({ intensity: 1 })');
  const trials = await interposerTrials(ctx, page, ref, rects, dpr, origin);
  numbers.interposerTrials = trials;
  const need = Math.max(MIN_TRIALS, 0);
  ctx.check(`the interposer run produced >= ${MIN_TRIALS} discriminating trials (native hit test would miss; ${trials.attempts} attempts, ${trials.noMark} without marker, ${trials.notDiscriminating} not discriminating)`, trials.discriminating >= need, { discriminating: trials.discriminating, attempts: trials.attempts }, 'interposer');
  ctx.check(`a trusted click at the VISUAL centre of a displaced field focuses that field in >= ${MIN_CORRECT_SHARE * 100} % of the discriminating trials (${trials.correct}/${trials.discriminating})`, trials.discriminating >= need && trials.correct >= MIN_CORRECT_SHARE * trials.discriminating, { correct: trials.correct, of: trials.discriminating, trials: trials.trials.slice(0, 8) }, 'interposer');
  numbers.errors = await page.evaluate('window.__errs');
  ctx.check('no effecterror', numbers.errors.length === 0, numbers.errors, 'content');

  // --- FPS cap from an independent clock --------------------------------------------------------------------------------------------------------------
  await page.evaluate('window.__water.setOptions({ intensity: 0.28 })');
  const raf = await page.measureRaf({ frames: 90 });
  numbers.rafHz = Math.round(raf.hz);
  const caps = ctx.control ? [30, 60] : [30, 60, 120].filter((n) => n <= raf.hz + 8);
  numbers.caps = {};
  for (const n of caps) {
    await ctx.focus(page);
    await page.evaluate(`document.querySelector('#hic-surface').setAttribute('framecap', ${ctx.control ? 0 : n})`);
    await H.sleep(400);
    const m = await presentedHz(page, 3000);
    numbers.caps[n] = { presentedFrames: m.frames, hz: Math.round(m.hz * 10) / 10 };
    ctx.check(`cap ${n}: presented frames (getCurrentTexture stamps) within [0.9N, 1.1N]${ctx.control ? ' (control: cap removed)' : ''}`, m.hz >= 0.9 * n && m.hz <= 1.1 * n, numbers.caps[n], 'cap');
  }
  if (!ctx.control) numbers.cap120 = caps.includes(120) ? 'measured' : `NOT MEASURED: display ${numbers.rafHz} Hz`;
  const errs = page.errors({ includeWarnings: false }).slice(errors0);
  ctx.check('no page error or console error', errs.length === 0, errs.slice(0, 3), 'content');
  numbers.dpr = dpr;
  return { numbers };
}, { controlClasses: ['interposer', 'cap'] });
