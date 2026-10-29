// G-explainer: the WICG explainer "Basic Example", verbatim, through the polyfill in real Chrome, plus a DENSER variant of the same pattern.
//   O-pixel: the CANVAS BACKING STORE (not a compositor screenshot) against the plain-DOM twin: whole surface (<= 3 % at delta > 16 and a tight pass at delta > 4-6),
//            per-element regions, twin content minimum, live layer computed opacity 0.
//   O-place: in EVERY phase that is compared (at rest, typed, while the field has focus and the caret blinks, the dense form while typing) the bounding box
//            of the canvas content must sit on the twin's to 1 device px. The fraction budgets cannot see a shift on this sparse page: drawn content shifted
//            40 device px to the right while a field had focus passed every other check (mutant shift40-while-focused).
//   O-hit:   trusted clicks 2 px inside / 3 px outside the edges of each control must hit the same element as the twin (the neighbour never gets the click).
//   O-blank: zero blank frames around the click and the typing; keydown-to-pixel latency bounded.
// Positive control (pre-first-paint sabotage: black renderer + geometry never applied): a named check of EVERY class must go red.
import { runGate, H } from './lib/gate.mjs';
import { canvasShot, compareToTwin, dumpFailure, contentBox, checkContentBox, boxEdgeDistance } from './lib/pixel.mjs';
import { checkEdgeHits } from './lib/hit.mjs';
import { withBlankWatch, checkTypingLatency } from './lib/sections.mjs';

const VERBATIM = '/test/fixtures/explainer/index.html';
const DENSE = '/test/gates/fixtures/explainer-dense/index.html';

async function rectsOf(page, selectors) {
  return page.evaluate(`(() => { const o = {}; for (const s of ${JSON.stringify(selectors)}) { const e = document.querySelector(s); if (!e) { o[s] = null; continue; } const r = e.getBoundingClientRect(); o[s] = { x: r.left, y: r.top, width: r.width, height: r.height }; } return o; })()`);
}

async function openPair(ctx, fixture) {
  const ref = await ctx.page();
  await ref.navigate(H.fixtureUrl(ctx.srv, fixture, { mode: 'ref' }));
  await ctx.focus(ref);
  await ref.waitForFunction('window.__ready === true', { timeout: 8000 });
  const page = await ctx.page();
  const errors0 = page.errors().length;
  await page.navigate(ctx.polyUrl(fixture));
  await ctx.focus(page);
  await page.waitForFunction('(window.__paints || 0) >= 1', { timeout: 8000 });
  await H.sleep(500);
  return { ref, page, errors0 };
}

/** Public-API install check (no polyfill internals): the API names exist on a Chrome without the native feature. */
async function checkApi(ctx, page) {
  const api = await page.evaluate(`({ draw: typeof CanvasRenderingContext2D.prototype.drawElementImage, rp: typeof HTMLCanvasElement.prototype.requestPaint, onpaint: 'onpaint' in HTMLCanvasElement.prototype, content: document.querySelector('canvas').content })`);
  ctx.check('the API is present on Chrome without the native feature (drawElementImage, requestPaint, onpaint, content=drawable)', api.draw === 'function' && api.rp === 'function' && api.onpaint && api.content === 'drawable', api, 'surface');
}

/** Content-box tolerance of the positional check (device px): 0 in every clean run measured (headless and CI, DPR 2), 1 leaves a pixel of antialiasing. */
const BOX = { maxEdge: 1, tolerance: 16 };

async function typingSection(ctx, page, { input, clickAt, text, region, numbers, name, selector = '#hic-surface', twin = null }) {
  const { out } = await withBlankWatch(ctx, page, `${name} click and typing`, async () => {
    await page.click(clickAt.x, clickAt.y);
    await H.sleep(250);
    const focus = await page.evaluate(`({active: document.activeElement && document.activeElement.id, match: !!document.getElementById(${JSON.stringify(input)})?.matches(":focus")})`);
    ctx.check(`${name}: a trusted click at the drawn input focuses the live input (O-hit)`, focus.active === input && focus.match, focus, 'hit');
    const before = await canvasShot(page, selector);
    await H.typeKeys(page, text, { intervalMs: 45 });
    await H.sleep(400);
    const after = await canvasShot(page, selector);
    return { before, after };
  }, { selector, grid: [200, 100] });
  const value = await page.evaluate(`document.getElementById(${JSON.stringify(input)}).value`);
  ctx.check(`${name}: typed characters reach the live input`, value.endsWith(text), { value }, 'typing');
  const crop = (s) => H.cropImage(s.img, region.x, region.y, region.w, region.h);
  const typed = H.compareImages(crop(out.before), crop(out.after), { diffImage: false });
  numbers[`${name}TypedRegionCountOver16`] = typed.countOver16;
  ctx.check(`${name}: typing changes the canvas pixels in the input region`, typed.countOver16 > 8, { countOver16: typed.countOver16, region }, 'typing');
  // twin: {img, bg} whose content box is the same with the field focused (its focus ring is inside the drawn form's background), so the focused canvas is placed too
  if (twin) checkContentBox(ctx, { name: `${name} typed (focused)`, poly: out.after.img, twin: twin.img, bg: twin.bg, numbers, ...BOX });
}

async function caretBlink(ctx, page, region, numbers, selector, twin) {
  const samples = [];
  let worst = { edge: -1 };
  for (let i = 0; i < 14; i++) {
    const s = await canvasShot(page, selector);
    // every sample is placed: the box is the twin's with the field focused there too (the caret is inside the field, so it never moves the box)
    const box = contentBox(s.img, twin.bg, BOX.tolerance), edge = boxEdgeDistance(box, twin.box);
    if (edge > worst.edge) worst = { edge, sample: i, canvas: box, twin: twin.box };
    const c = H.cropImage(s.img, region.x, region.y, region.w, region.h).data;
    let h = 0; for (let k = 0; k < c.length; k += 4) h = (h * 31 + c[k] + 3 * c[k + 1] + 7 * c[k + 2]) | 0;
    samples.push(h);
    await H.sleep(170);
  }
  const states = new Set(samples);
  numbers.caretDistinctStates = states.size;
  ctx.check('the caret blinks (>= 2 distinct canvas states of the input region over 2.4 s, returning to the first)', states.size >= 2 && samples.filter((h) => h === samples[0]).length < samples.length, { distinct: states.size }, 'typing');
  numbers['verbatim blink content box'] = worst;
  ctx.check(`while the caret blinks: in every sample the content bounding box matches the focused twin's, every edge within ${BOX.maxEdge} device px`, worst.edge <= BOX.maxEdge, worst, 'pixel');
}

/** Device-pixel region of a css rect relative to the surface. */
function deviceRegion(rect, origin, dpr, pad = 0) {
  return { x: Math.max(0, Math.floor((rect.x - origin.x) * dpr) - pad), y: Math.max(0, Math.floor((rect.y - origin.y) * dpr) - pad), w: Math.ceil(rect.width * dpr) + 2 * pad, h: Math.ceil(rect.height * dpr) + 2 * pad };
}

async function verbatim(ctx, numbers) {
  const { ref, page, errors0 } = await openPair(ctx, VERBATIM);
  await checkApi(ctx, page);
  await ctx.focus(ref);
  const tr = await rectsOf(ref, ['#twin', '#name', 'label[for=name]']);
  const regions = [{ name: 'input', rect: tr['#name'] }, { name: 'label', rect: tr['label[for=name]'] }];

  // O-pixel at rest: the canvas and the twin are identical to ~1 level on a sound build, so the tight pass is really tight
  const rest = await compareToTwin(ctx, { ref, page, name: 'verbatim rest', selector: 'canvas', refSelector: '#twin', numbers, regions, minContent: 0.004, tight: { tolerance: 4, max: 0.0005 }, regionMax: 0.005, regionTolerance: 4, box: BOX });
  if (!ctx.control) await dumpFailure(ctx, 'verbatim-rest', rest.poly.img, rest.twin.img);
  const dpr = rest.twin.geo.dpr;
  const origin = { x: rest.twin.geo.x, y: rest.twin.geo.y };
  numbers.dpr = dpr;

  const inputRect = tr['#name'];
  await checkEdgeHits(ctx, { page, ref, controls: [{ name: 'input', id: 'name', rect: inputRect }], group: 'verbatim edge hits', numbers });

  const region = deviceRegion(inputRect, origin, dpr, 3);
  const click = { x: inputRect.x + inputRect.width / 2, y: inputRect.y + inputRect.height / 2 };
  await ctx.focus(page);
  await typingSection(ctx, page, { input: 'name', clickAt: click, text: 'hello', region, numbers, name: 'verbatim', selector: 'canvas' });
  await ctx.focus(ref);
  await ref.click(click.x, click.y);
  await H.typeKeys(ref, 'hello', { intervalMs: 45 });
  await H.sleep(200);
  await ref.evaluate('document.getElementById("name").blur()');
  await ctx.focus(page);
  await page.evaluate('document.getElementById("name").blur()');
  await H.sleep(600);
  const typed = await compareToTwin(ctx, { ref, page, name: 'verbatim typed', selector: 'canvas', refSelector: '#twin', numbers, regions: [{ name: 'input', rect: inputRect }], minContent: 0.004, tight: { tolerance: 16, max: 0.01 }, regionMax: 0.01, regionTolerance: 48, box: BOX });
  if (!ctx.control) await dumpFailure(ctx, 'verbatim-typed', typed.poly.img, typed.twin.img);

  // the focused state: the twin's field is focused by the same trusted click, so both carry the focus ring
  await ctx.focus(ref);
  await ref.click(click.x, click.y);
  await H.sleep(150);
  const focusedTwin = (await H.screenshotElement(ref, '#twin')).img;
  await ref.evaluate('document.getElementById("name").blur()');
  const bg = typed.poly.geo.bg;
  await ctx.focus(page);
  await page.click(click.x, click.y);
  await H.sleep(150);
  await caretBlink(ctx, page, region, numbers, 'canvas', { box: contentBox(focusedTwin, bg, BOX.tolerance), bg });
  await checkTypingLatency(ctx, page, { region, name: 'verbatim typing latency', numbers, selector: 'canvas', inputId: 'name' });

  const errs = page.errors({ includeWarnings: false }).slice(errors0);
  ctx.check('no page error or console error', errs.length === 0, errs.slice(0, 3), 'surface');
}

async function dense(ctx, numbers) {
  const { ref, page, errors0 } = await openPair(ctx, DENSE);
  await ctx.focus(ref);
  const ids = ['title', 'note', 'first', 'last', 'role', 'sw1', 'sw2', 'sw3', 'sw4', 'bio', 'news', 'plan-a', 'plan-b', 'vol', 'tbl', 'save', 'cancel'];
  const tr = await rectsOf(ref, ['#hic-surface', ...ids.map((id) => '#' + id)]);
  const regions = ids.map((id) => ({ name: id, rect: tr['#' + id] }));
  const rest = await compareToTwin(ctx, { ref, page, name: 'dense rest', selector: '#hic-surface', numbers, regions, minContent: 0.05, tight: { tolerance: 4, max: 0.001 }, regionMax: 0.01, regionTolerance: 6, box: BOX });
  if (!ctx.control) await dumpFailure(ctx, 'dense-rest', rest.poly.img, rest.twin.img);
  const hitIds = ['first', 'last', 'role', 'bio', 'news', 'plan-a', 'plan-b', 'vol', 'save', 'cancel'];
  await checkEdgeHits(ctx, { page, ref, controls: hitIds.map((id) => ({ name: id, id, rect: tr['#' + id] })), accept: { news: ['label'], 'plan-a': ['label'], 'plan-b': ['label'] }, group: 'dense edge hits', numbers });

  const first = tr['#first'];
  const region = deviceRegion(first, { x: tr['#hic-surface'].x, y: tr['#hic-surface'].y }, rest.twin.geo.dpr);
  await ctx.focus(page);
  await typingSection(ctx, page, { input: 'first', clickAt: { x: first.x + first.width / 2, y: first.y + first.height / 2 }, text: 'xyz', region, numbers, name: 'dense', twin: { img: rest.twin.img, bg: rest.poly.geo.bg } });
  const errs = page.errors({ includeWarnings: false }).slice(errors0);
  ctx.check('dense: no page error or console error', errs.length === 0, errs.slice(0, 3), 'surface');
}

runGate('G-explainer', async (ctx) => {
  const numbers = {};
  await verbatim(ctx, numbers);
  await dense(ctx, numbers);
  return { numbers };
}, { controlSabotage: ['blank', 'nogeom'], controlClasses: ['pixel', 'content', 'region', 'hit', 'typing', 'blank', 'latency'] });
