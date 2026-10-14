// G-regress-paint: end-to-end regression gates for three correctness findings (REVIEW-correctness):
//   M1 a drawable appended after mount is tracked and painted (paint fires, the draw does not throw, its pixels are in the canvas) without any other damage
//   M2 three drawables drawn in ONE task all stay hit-testable (elementsFromPoint + a trusted click reaches each one and no other)
//   M3 `canvas.width = N` inside onpaint does not start a paint loop (paint count over 1.5 s stays small)
// Positive control per finding: M1 appends a plain element (no `drawable`), M2 runs with geometry never applied, M3 adds a real requestPaint() loop; every check class must go red.
import { runGate, H } from './lib/gate.mjs';
import { openRegress } from './lib/regress.mjs';
import { canvasShot, assertLayerHidden } from './lib/pixel.mjs';

runGate('G-regress-paint', async (ctx) => {
  const numbers = {};
  const page = await ctx.page();
  const errors0 = page.errors().length;

  // --- M1: dynamic append ---------------------------------------------------------------------------------------------------------------
  await openRegress(ctx, page, 'dynamic-append.html');
  const p0 = await page.evaluate('window.__paints');
  await page.evaluate(`window.__append(${ctx.control ? 'false' : 'true'})`);
  await H.sleep(1000);
  const after = await page.evaluate('({ paints: window.__paints, errors: window.__errors })');
  const shot = await canvasShot(page, '#c');
  const px = (x, y) => { const i = (y * shot.img.width + x) * 4; return [shot.img.data[i], shot.img.data[i + 1], shot.img.data[i + 2]]; };
  const blue = px(20, 70); // the second slot (y = 10 + 50) of the 300x160 grid
  numbers.append = { paintsBefore: p0, paintsAfter: after.paints, errors: after.errors, blueSample: blue };
  ctx.check('M1: a drawable appended after the first paint triggers a paint (without any other damage)', after.paints > p0, { before: p0, after: after.paints }, 'append');
  ctx.check('M1: its draw does not throw', after.errors.length === 0, after.errors, 'append');
  ctx.check('M1: the appended drawable is in the canvas pixels (blue box)', blue[2] > 150 && blue[0] < 90, { blue }, 'append');
  await assertLayerHidden(ctx, page, 'M1 page');

  // --- M2: two or more drawables drawn in one task --------------------------------------------------------------------------------------------
  await openRegress(ctx, page, 'two-hit.html');
  await H.sleep(500);
  const geo = await page.evaluate(`(() => { const r = document.getElementById('c').getBoundingClientRect(); return { x: r.left, y: r.top, pos: window.__pos }; })()`);
  const rows = [];
  for (const id of ['b1', 'b2', 'b3']) {
    const cx = geo.x + geo.pos[id][0] + 45, cy = geo.y + geo.pos[id][1] + 17;
    const top = await page.evaluate(`(document.elementsFromPoint(${cx}, ${cy})[0] || {}).id || ''`);
    await page.evaluate("for (const k of Object.keys(window.__clicks)) window.__clicks[k] = 0");
    await page.click(cx, cy);
    await H.sleep(150);
    const clicks = await page.evaluate('window.__clicks');
    rows.push({ id, top, clicks });
  }
  numbers.twoHit = rows;
  ctx.check('M2: elementsFromPoint over every drawn drawable returns that drawable first', rows.every((r) => r.top === r.id), rows, 'hit');
  ctx.check('M2: a trusted click on every drawn drawable reaches it and no other', rows.every((r) => Object.entries(r.clicks).every(([k, v]) => v === (k === r.id ? 1 : 0))), rows, 'hit');

  // --- M3: width write inside onpaint ---------------------------------------------------------------------------------------------------------
  await openRegress(ctx, page, 'width-loop.html', ctx.control ? { loop: 1 } : {});
  const w0 = await page.evaluate('window.__paints');
  await H.sleep(1500);
  const w1 = await page.evaluate('window.__paints');
  numbers.widthLoop = { paintsIn1500ms: w1 - w0 };
  ctx.check('M3: a canvas.width write inside onpaint does not start a paint loop (<= 6 paints in 1.5 s; the buggy build made ~180)', w1 - w0 <= 6, { paints: w1 - w0 }, 'loop');

  const errs = page.errors({ includeWarnings: false }).slice(errors0);
  ctx.check('no page error or console error', errs.length === 0, errs.slice(0, 3), 'surface');
  return { numbers };
}, { controlSabotage: ['nogeom'], controlClasses: ['append', 'hit', 'loop'] });
