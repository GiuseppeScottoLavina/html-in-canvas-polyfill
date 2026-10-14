// G-unsupported: unsupported content fails LOUDLY and never stalls (API-CONTRACT 9, ADR-J).
//   iframe child, cross-origin image without CORS, a fullscreen canvas (input limit), a popover canvas: exactly one console.error per (feature, path), a `hicunsupported` event, a report
//   entry with a count (report() is the subject of this gate, so reading it is not a rule-7 leak), a visible placeholder (CANVAS pixels non-blank), sibling UI still painting and typing
//   still working, the canvas keeps painting.
// Positive control: every check is a REAL check against a page where the offending content is swapped for supported content (iframe/xorigin) or where the refused action targets a canvas
// the polyfill does not manage (fullscreen/popover): nothing is reported, so the report / log / event / fullscreen / popover checks must go red. No hard-coded results.
import { runGate, H } from './lib/gate.mjs';
import { canvasShot, assertLayerHidden, deviceBox } from './lib/pixel.mjs';

async function openCase(ctx, kind, other) {
  const page = await ctx.page();
  await ctx.focus(page);
  const url = new URL('/test/fixtures/unsupported/index.html', ctx.srv.url);
  url.searchParams.set('bundle', ctx.bundle); url.searchParams.set('case', kind); if (other) url.searchParams.set('other', other); url.searchParams.set('iso', '0');
  await page.navigate(url.href);
  await page.waitForFunction('(window.__paints || 0) >= 1', { timeout: 10000 });
  await H.sleep(800);
  return page;
}

const hicErrors = (page) => page.errors({ includeWarnings: false }).filter((e) => /hic-live-polyfill|\[hic/i.test(e.text));

async function checkLoud(ctx, page, kind, feature) {
  const rep = await page.evaluate('window.__HIC__.installed.report()');
  const entries = rep.unsupported.filter((u) => u.feature === feature);
  const events = await page.evaluate('window.__events');
  const logs = hicErrors(page).filter((e) => e.text.includes(feature));
  ctx.check(`${kind}: a report entry for "${feature}" exists with a count`, entries.length >= 1 && entries.every((e) => e.count >= 1), { unsupported: rep.unsupported.map((u) => [u.feature, u.count]) }, 'report');
  ctx.check(`${kind}: exactly one console.error per (feature, path)`, logs.length === 1, { n: logs.length, text: logs.map((l) => l.text.slice(0, 120)) }, 'log');
  ctx.check(`${kind}: a hicunsupported event fired`, events.includes(feature), { events }, 'event');
  // not a silent blank / stall: placeholder painted, typing in the sibling control works and reaches the canvas, paint keeps firing
  await assertLayerHidden(ctx, page, kind);
  const shot = await canvasShot(page, '#c');
  const st = H.pixelStats(shot.img);
  ctx.check(`${kind}: the canvas is not blank (supported UI + placeholder painted)`, st.nonBlank, { distinctColors: st.distinctColors }, 'content');
  const paints0 = await page.evaluate('window.__paints');
  const r = await page.evaluate(`document.getElementById('name').getBoundingClientRect().toJSON()`);
  const cr = await page.evaluate(`document.getElementById('c').getBoundingClientRect().toJSON()`);
  await page.click(r.x + r.width / 2, r.y + r.height / 2);
  await H.sleep(150);
  await H.typeKeys(page, 'Z', { intervalMs: 40 });
  await H.sleep(700);
  const val = await page.evaluate(`document.getElementById('name').value`);
  const shot2 = await canvasShot(page, '#c');
  const scale = shot2.img.width / cr.width; // this fixture's canvas grid is not device-pixel sized
  const box = deviceBox(r, { x: cr.x, y: cr.y }, scale, shot2.img);
  const d = H.compareImages(H.cropImage(shot.img, box.x, box.y, box.w, box.h), H.cropImage(shot2.img, box.x, box.y, box.w, box.h), { diffImage: false });
  const paints1 = await page.evaluate('window.__paints');
  ctx.check(`${kind}: typing still works and updates the canvas (no stall)`, val.endsWith('Z') && d.countOver16 > 5 && paints1 > paints0, { val, countOver16: d.countOver16, paints0, paints1, box, rect: r, canvasRect: cr }, 'typing');
  return { entries: entries.map((e) => [e.feature, e.count]), logs: logs.length };
}

runGate('G-unsupported', async (ctx) => {
  const numbers = {};
  const other = await H.startServer(); // a second origin (another port) for the cross-origin image
  try {
    for (const [kind, feature] of [['iframe', 'iframe'], ['xorigin', 'cross-origin-resource']]) {
      const page = await openCase(ctx, ctx.control ? 'supported' : kind, other.url.replace(/\/$/, ''));
      numbers[kind] = await checkLoud(ctx, page, kind, feature);
    }
    // requestFullscreen: the managed canvas goes fullscreen (it draws as natively) and the input limit of its layer is reported once. The control targets a canvas the polyfill does not manage.
    const page = await openCase(ctx, 'supported', null);
    const target = ctx.control ? `(() => { const c = document.createElement('canvas'); document.body.appendChild(c); return c; })()` : `document.getElementById('c')`;
    const fs = await page.evaluate(`(async () => { const c = ${target}; const r = await c.requestFullscreen().then(() => ({ ok: true }), (e) => ({ ok: false, name: e.name, feature: e.feature }));
      await new Promise((res) => setTimeout(res, 300)); r.fullscreen = document.fullscreenElement === c;
      r.entries = window.__HIC__.installed.report().unsupported.filter((u) => u.feature === 'top-layer-canvas').length;
      await document.exitFullscreen().catch(() => {}); await new Promise((res) => setTimeout(res, 300)); return r; })()`);
    numbers.fullscreen = fs;
    const logs = hicErrors(page).filter((e) => e.text.includes('top-layer-canvas'));
    ctx.check('requestFullscreen() on a managed canvas goes fullscreen and its input limit is reported (top-layer-canvas report entry)', fs.ok === true && fs.fullscreen && fs.entries === 1, fs, 'fullscreen');
    ctx.check('the fullscreen input limit is logged once', logs.length === 1, { n: logs.length }, 'fullscreen');
    const popAttr = ctx.control ? '' : `c.setAttribute('content', 'drawable');`;
    const pop = await page.evaluate(`(() => { const c = document.createElement('canvas'); c.setAttribute('popover', 'manual'); ${popAttr} document.body.appendChild(c); return new Promise((res) => setTimeout(() => res(window.__HIC__.installed.report().unsupported.filter((u) => u.feature === 'top-layer-canvas').length), 300)); })()`);
    ctx.check('a popover canvas is refused at mount (report entry)', ctx.control ? pop >= 2 : pop >= 1, { entries: pop }, 'popover');
  } finally { await other.close(); }
  return { numbers };
}, { controlClasses: ['report', 'log', 'event', 'fullscreen', 'popover'] });
