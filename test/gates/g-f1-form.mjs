// G-f1-form, part 1: the water form (F1) through the 2D path (effect off), against its plain-DOM twin.
//   O-pixel on the CANVAS BACKING STORE (never a compositor screenshot that could show the live DOM), whole surface + per-control regions, plus a
//   compositor screenshot with the layer forced invisible; O-hit at the inner edge of every control (neighbour never gets the click); blank watch around the
//   click/typing/range section; typing latency bounded. Positive control: black renderer + geometry never applied, a check of EVERY class must go red.
// Part 2 (effect on) lives in g-f1-form-effect.mjs.
import { runGate, H } from './lib/gate.mjs';
import { openRef, openPoly, rectsOf, center } from './lib/f1.mjs';
import { compareToTwin, compositorShot, canvasShot, checkSurface, dumpFailure, regionCompare } from './lib/pixel.mjs';
import { checkEdgeHits } from './lib/hit.mjs';
import { withBlankWatch, checkTypingLatency } from './lib/sections.mjs';

const CONTROLS = ['#name', '#email', '#project', '#message', '#consent', '#fps-cap', '#submit-button'];
const SELECTORS = ['#hic-surface', ...CONTROLS];

const regionsOf = (rr) => CONTROLS.map((s) => ({ name: s.slice(1), rect: rr[s] }));

runGate('G-f1-form', async (ctx) => {
  const numbers = {};
  const ref = await openRef(ctx);
  const page = await openPoly(ctx);
  await ctx.focus(ref);
  const rr = await rectsOf(ref, SELECTORS);
  await ctx.focus(page);
  const errors0 = page.errors().length;
  const api = await page.evaluate(`({ draw: typeof CanvasRenderingContext2D.prototype.drawElementImage, rp: typeof HTMLCanvasElement.prototype.requestPaint, content: document.querySelector('#hic-surface').content })`);
  ctx.check('the API is present (drawElementImage, requestPaint, content=drawable)', api.draw === 'function' && api.rp === 'function' && api.content === 'drawable', api, 'surface');
  await page.evaluate('document.querySelector("#hic-surface").requestPaint()');
  await H.sleep(500);

  // --- rest: canvas backing store vs twin (tight), then a compositor screenshot with the layer hidden --------------------------------------
  const rest = await compareToTwin(ctx, { ref, page, name: 'rest', numbers, regions: regionsOf(rr), minContent: 0.03, tight: { tolerance: 6, max: 0.003 }, regionMax: 0.02, regionTolerance: 6 });
  if (!ctx.control) await dumpFailure(ctx, 'rest', rest.poly.img, rest.twin.img);
  const dpr = rest.twin.geo.dpr;
  const origin = { x: rr['#hic-surface'].x, y: rr['#hic-surface'].y };
  const comp = await compositorShot(page);
  const cc = H.compareImages(comp.img, rest.twin.img);
  numbers.restCompositorLayerHidden = cc.sizeMatch ? { fraction: cc.fraction, maxDiff: cc.maxDiff } : { sizeMismatch: cc.sizes };
  if (!ctx.control && cc.sizeMatch && cc.fraction > 0.03) await dumpFailure(ctx, 'rest-compositor', comp.img, rest.twin.img);
  ctx.check('rest: the compositor screenshot with the live layer forced invisible equals the twin (<= 3 %)', cc.sizeMatch && cc.fraction <= 0.03, numbers.restCompositorLayerHidden, 'pixel');

  // --- O-hit at the inner edge of each control ---------------------------------------------------------------------------------------------
  await checkEdgeHits(ctx, { page, ref, controls: CONTROLS.map((s) => ({ name: s.slice(1), id: s.slice(1), rect: rr[s] })), accept: { consent: ['consent-label'] }, group: 'edge hits', numbers });

  // --- interaction on the polyfill page under a blank watch ------------------------------------------------------------------------------
  const consentBefore = await page.evaluate('document.getElementById("consent").checked');
  const c = center(rr['#consent']), n = center(rr['#name']), m = center(rr['#message']), fps = rr['#fps-cap'];
  const { out } = await withBlankWatch(ctx, page, 'click, typing and range', async () => {
    await page.click(c.x, c.y);
    await H.sleep(500);
    const consentAfter = await page.evaluate('document.getElementById("consent").checked');
    await page.click(n.x, n.y);
    await H.sleep(150);
    const nameFocused = await page.evaluate('document.activeElement && document.activeElement.id');
    await page.key('End');
    await H.typeKeys(page, 'XY', { intervalMs: 50 });
    await H.sleep(300);
    await page.click(m.x, m.y);
    await H.sleep(150);
    await H.typeKeys(page, ' ok', { intervalMs: 50 });
    await H.sleep(300);
    const values = await page.evaluate('({name: document.getElementById("name").value, message: document.getElementById("message").value})');
    const rangeBefore = await page.evaluate('document.getElementById("fps-cap").value');
    await page.click(fps.x + fps.width * 0.9, fps.y + fps.height / 2);
    await H.sleep(300);
    const rangeAfter = await page.evaluate('document.getElementById("fps-cap").value');
    return { consentAfter, nameFocused, values, rangeBefore, rangeAfter };
  }, { grid: [240, 160] });
  ctx.check('a trusted click at the drawn checkbox toggles it (O-hit)', consentBefore === true && out.consentAfter === false, { consentBefore, consentAfter: out.consentAfter }, 'hit');
  ctx.check('a click at the drawn name field focuses it', out.nameFocused === 'name', { nameFocused: out.nameFocused }, 'hit');
  ctx.check('typed characters reach the live name field', out.values.name.endsWith('XY'), out.values, 'typing');
  ctx.check('typed characters reach the live textarea', out.values.message.includes(' ok'), out.values, 'typing');
  ctx.check('a trusted click on the drawn range track moves the slider', out.rangeBefore === '60' && +out.rangeAfter > 90, { rangeBefore: out.rangeBefore, rangeAfter: out.rangeAfter }, 'hit');

  // the twin gets the same actions, then everything is blurred and the final canvas is compared (caret excluded)
  await ctx.focus(ref);
  await ref.click(c.x, c.y);
  await H.sleep(300);
  await ref.click(n.x, n.y);
  await ref.key('End');
  await H.typeKeys(ref, 'XY', { intervalMs: 50 });
  await ref.click(m.x, m.y);
  await H.typeKeys(ref, ' ok', { intervalMs: 50 });
  await ref.click(fps.x + fps.width * 0.9, fps.y + fps.height / 2);
  await H.sleep(300);
  await ref.evaluate('document.activeElement && document.activeElement.blur()');
  await ctx.focus(page);
  await page.evaluate('document.activeElement && document.activeElement.blur()');
  await H.sleep(800);
  const end = await compareToTwin(ctx, { ref, page, name: 'after interaction', numbers, regions: [{ name: 'name', rect: rr['#name'] }, { name: 'message', rect: rr['#message'] }, { name: 'consent', rect: rr['#consent'] }, { name: 'fps-cap', rect: rr['#fps-cap'] }], minContent: 0.03, tight: { tolerance: 16, max: 0.01 }, regionMax: 0.03, regionTolerance: 48 });
  if (!ctx.control) await dumpFailure(ctx, 'after-interaction', end.poly.img, end.twin.img);
  const changed = regionCompare(rest.poly.img, end.poly.img, rr['#message'], origin, dpr, { tolerance: 16 });
  ctx.check('the canvas pixels of the textarea changed after typing', changed.countOver > 20, { countOver: changed.countOver }, 'typing');

  // --- keystroke-to-pixel latency in the name field -----------------------------------------------------------------------------------------
  await ctx.focus(page);
  await page.click(n.x, n.y);
  await H.sleep(150);
  const region = { x: Math.floor((rr['#name'].x - origin.x) * dpr), y: Math.floor((rr['#name'].y - origin.y) * dpr), w: Math.ceil(rr['#name'].width * dpr), h: Math.ceil(rr['#name'].height * dpr) };
  await checkTypingLatency(ctx, page, { region, name: 'typing latency', numbers, inputId: 'name' });

  // --- caret in a type=email field (selectionStart is null there: the caret used to be missing, a reported regression) --------------------------
  const em = rr['#email'];
  await page.click(em.x + em.width * 0.5, em.y + em.height / 2);
  await H.sleep(200);
  const emailRegion = { x: Math.floor((em.x - origin.x) * dpr), y: Math.floor((em.y - origin.y) * dpr), w: Math.ceil(em.width * dpr), h: Math.ceil(em.height * dpr) };
  const emailStates = new Set(); const emailFocused = await page.evaluate('document.activeElement && document.activeElement.id');
  for (let i = 0; i < 10; i++) {
    const shot = await canvasShot(page, '#hic-surface');
    const px = H.cropImage(shot.img, emailRegion.x, emailRegion.y, emailRegion.w, emailRegion.h).data;
    let h = 0; for (let k = 0; k < px.length; k += 4) h = (h * 31 + px[k] + 3 * px[k + 1] + 7 * px[k + 2]) | 0;
    emailStates.add(h);
    await H.sleep(170);
  }
  numbers.emailCaretDistinctStates = emailStates.size;
  ctx.check('a click in the drawn type=email field focuses it and its caret blinks on the canvas (>= 2 distinct states over 1.7 s)', emailFocused === 'email' && emailStates.size >= 2, { emailFocused, distinct: emailStates.size }, 'typing');

  const errs = page.errors({ includeWarnings: false }).slice(errors0);
  ctx.check('no page error or console error', errs.length === 0, errs.slice(0, 3), 'surface');
  const rep = await page.evaluate('window.__HIC__ ? window.__HIC__.installed.report() : null');
  numbers.reportUnsupported = rep ? rep.unsupported.length : null;
  numbers.reportErrors = rep ? rep.errors.length : null;
  numbers.dpr = dpr;
  return { numbers };
}, { controlSabotage: ['blank', 'nogeom'], controlClasses: ['pixel', 'content', 'region', 'hit', 'typing', 'blank', 'latency'] });
