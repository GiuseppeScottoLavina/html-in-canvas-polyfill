// The scenarios of the mobile gate (test/mobile/run.mjs), on iOS Simulator (Mobile Safari through safaridriver) and Android Emulator (Chrome through CDP).
// ctx = { s, srv, bundle, control, check(label, ok, data, cls), numbers, save(name, img), platform: 'ios'|'android', standIn }
// The session `s` offers navigate, evaluate, waitFor, screenshot, viewportOffset, tap, swipe, longPress, typeText (false when not drivable), rotate (false when not
// drivable), osTap (Android). In the control run the pages are sabotaged (RECORDER ?xbsab=1: drawElementImage draws nothing, drawn children ignore the pointer) and
// every class a scenario declares must go red.
import { pixelStats, cropImage } from '../harness/lib/pixels.mjs';
import { decodePng } from '../harness/lib/png.mjs';
import { readCanvas, oracle, regionChanged, pageErrors, sleep } from '../xbrowser/lib.mjs';

function url(ctx, path, params = {}) {
  const u = new URL(path, ctx.srv.url);
  u.searchParams.set('iso', '0');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  if (ctx.control && params.mode !== 'ref') u.searchParams.set('xbsab', '1');
  return u.href;
}
const center = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const rectOf = (s, sel) => s.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
const until = (s, expr, timeoutMs = 15000) => s.waitFor(expr, { timeoutMs });
const devRect = (r, origin, k, pad = 0) => ({ x: Math.max(0, Math.floor((r.x - origin.x) * k) - pad), y: Math.max(0, Math.floor((r.y - origin.y) * k) - pad), w: Math.ceil(r.width * k) + 2 * pad, h: Math.ceil(r.height * k) + 2 * pad });
const scrollTo = (s, y) => s.evaluate(`(scrollTo(0, ${y}), new Promise((ok) => setTimeout(() => ok(scrollY), 500)))`);

/** Page rect (document coordinates) of an element. */
const pageRectOf = (s, sel) => s.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); const r = e.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`);

/**
 * A reference crop that remembers its screenshot: at a fractional DPR (Android 2.625) the crop origin of a css rect is uncertain by one device pixel in each axis, so
 * `oracleBest` compares the 9 crops around it and keeps the best (an alignment search of the crop, not a tolerance on the content).
 */
function refCrop(img, x, y, w, h) {
  const c = cropImage(img, x, y, w, h);
  c.at = (dx, dy) => cropImage(img, x + dx, y + dy, w, h);
  return c;
}
function oracleBest(surface, ref, opts) {
  let best = null;
  for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const o = oracle(surface, ref.at ? ref.at(dx, dy) : ref, opts);
    if (!best || o.structural + o.shiftTolerant < best.structural + best.shiftTolerant) best = o;
    if (!ref.at) break;
  }
  return best;
}

/**
 * A screenshot with the document point (right edge, `docY`) located in it: a magenta marker absolutely positioned there is found in the SAME screenshot, so a frame
 * that lags the scroll position (measured in Mobile Safari) cannot misplace a crop. Returns the image and where document coordinates land in it.
 */
async function markedShot(s, docY) {
  const dpr = await s.evaluate('devicePixelRatio');
  for (let attempt = 0; attempt < 4; attempt++) {
    const mx = await s.evaluate(`(() => { const m = document.createElement('div'); m.id = '__xb_m'; const x = document.documentElement.clientWidth - 6; m.style.cssText = 'position:absolute;left:' + x + 'px;top:${docY}px;width:6px;height:6px;background:#f0f;z-index:2147483647;pointer-events:none'; document.body.appendChild(m); return new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => ok(x), 250)))); })()`);
    const img = decodePng(await s.screenshot());
    await s.evaluate(`(document.getElementById('__xb_m')?.remove(), true)`);
    for (let y = 0; y < img.height; y++) for (let x = img.width - 1; x >= img.width - Math.ceil(40 * dpr); x--) {
      const i = (y * img.width + x) * 4, d = img.data;
      if (d[i] > 230 && d[i + 1] < 40 && d[i + 2] > 230) return { img, k: dpr, x0: x + 1 - (mx + 6) * dpr, y0: y, docY }; // x is the marker's right-most pixel
    }
    await sleep(400);
  }
  throw new Error('scroll marker not found in the screenshot');
}

/**
 * Screenshot crops of page rects (document coordinates) on a phone: each rect is scrolled into the upper half of the viewport first (Mobile Safari's toolbar and its
 * blur cover the bottom of the screen; Chrome's toolbar may hide) and cut from that screenshot. Returns the crops in the same order.
 */
async function pageShots(s, rects) {
  const ih = await s.evaluate('innerHeight');
  const out = new Array(rects.length);
  const todo = rects.map((r, i) => ({ r, i })).sort((a, b) => a.r.y - b.r.y);
  while (todo.length) {
    const sy = await scrollTo(s, Math.max(0, todo[0].r.y - 8));
    const shot = await markedShot(s, sy);
    let took = 0;
    for (let j = 0; j < todo.length;) {
      const { r, i } = todo[j];
      const top = r.y - sy;
      if (top >= 0 && top + r.height <= ih * 0.55) {
        // the marker's left edge is at document x = clientWidth - 6; x0 is where document x = 0 lands
        out[i] = refCrop(shot.img, Math.round(shot.x0 + r.x * shot.k), Math.round(shot.y0 + top * shot.k), Math.round(r.width * shot.k), Math.round(r.height * shot.k));
        todo.splice(j, 1); took++;
      } else j++;
    }
    if (!took) throw new Error(`page rect at y ${todo[0].r.y} cannot be scrolled into the upper half of the viewport (scrollY ${sy}); give the page room below it`);
  }
  await scrollTo(s, 0);
  return out;
}

function judge(ctx, name, o, cls = 'pixel', { maxFraction = 0.05, maxStructural = 0.01 } = {}) {
  ctx.numbers[name] = { shiftTolerant: +(o.shiftTolerant ?? 1).toFixed(5), structural: +(o.structural ?? 1).toFixed(5), size: o.size, refSize: o.refSize, surfaceNonBlank: o.surfaceNonBlank, refNonBlank: o.refNonBlank };
  const pass = o.sizeMatch && o.surfaceNonBlank && o.refNonBlank && o.shiftTolerant <= maxFraction && o.structural <= maxStructural;
  ctx.check(`${name}: canvas vs plain-DOM twin: <= ${maxFraction * 100} % of pixels over 16 and <= ${maxStructural * 100} % over 100 (+-1 device row), both non-blank`, pass, ctx.numbers[name], cls);
  if (!pass) { ctx.save(name + '.surface', o.surface); ctx.save(name + '.ref', o.ref); if (o.diffImage) ctx.save(name + '.diff', o.diffImage); }
}

async function noErrors(ctx, label) {
  const errs = (await pageErrors(ctx.s)).filter((e) => !/xbsab/.test(e.m));
  ctx.check(`${label}: no page exception or console.error`, errs.length === 0, errs.slice(0, 3), 'surface');
}

async function mode(ctx, label) {
  const m = await ctx.s.evaluate('window.__HIC__ ? (window.__HIC__.error ? "error: " + window.__HIC__.error.message : window.__HIC__.installed.mode) : "no __HIC__"');
  ctx.numbers[`${label}Mode`] = m;
  ctx.check(`${label}: the polyfill installed (mode polyfill)`, m === 'polyfill', { mode: m }, 'surface');
}

const FIX = '/test/fixtures/mobile/index.html';
async function openPoly(ctx, path = FIX, extra = {}) {
  await ctx.s.navigate(url(ctx, path, { mode: 'poly', bundle: ctx.bundle, ...extra }));
  await until(ctx.s, 'window.__HIC_FIXTURE && (window.__HIC_FIXTURE.ready || window.__HIC_FIXTURE.fatal)').catch(() => null);
  await sleep(900);
}

/** The device classification and the browser gate, read with the polyfill's own pure modules (no install). */
export async function gate(ctx) {
  const { s } = ctx;
  await s.navigate(url(ctx, FIX, { mode: 'ref' }));
  const g = await s.evaluate(`Promise.all([import('/src/api/native-detect.js'), import('/src/util/engine.js')]).then(([d, e]) => ({ gate: d.browserGate(window), engine: e.engineOf(navigator), ua: navigator.userAgent, touch: navigator.maxTouchPoints, dpr: devicePixelRatio, inner: [innerWidth, innerHeight] }))`);
  ctx.numbers.gate = g;
  ctx.check(`gate: classified as ${ctx.platform} mobile and admitted (${g.gate.engine} ${g.gate.major ?? 'n/a'})`, g.gate.ok && g.gate.mobile && g.gate.os === ctx.platform, g, 'surface');
}

/** The WICG explainer example: pixels vs the twin, a tap on the drawn input focuses it, typing reaches it once and repaints. */
export async function explainer(ctx) {
  const { s } = ctx; const P = '/test/fixtures/explainer/index.html';
  await s.navigate(url(ctx, P, { mode: 'ref' })); await until(s, 'document.getElementById("twin")');
  await sleep(600);
  const twin = await pageRectOf(s, '#twin');
  const [ref] = await pageShots(s, [twin]);
  await s.navigate(url(ctx, P, { mode: 'poly', bundle: ctx.bundle }));
  await until(s, '(window.__paints || 0) >= 1').catch(() => null); await sleep(900);
  await mode(ctx, 'explainer');
  const rest = await readCanvas(s, 'canvas');
  judge(ctx, 'explainerRest', oracleBest(rest, ref));
  // sharpness: on a DPR-3 phone the snapshot is rastered at the device scale (mobile maxDpr 3), not upscaled from the desktop 2.5
  const sharp = await s.evaluate('(() => { const r = window.__HIC__.installed.report(); return { dpr: devicePixelRatio, rasterScale: r.canvases[0].stats.snapshot.rasterScale, bitmap: [document.querySelector("canvas").width, document.querySelector("canvas").height] }; })()').catch((e) => ({ error: e.message }));
  ctx.numbers.sharpness = sharp;
  ctx.check(`explainer: the snapshot is rastered at the device pixel ratio (DPR ${sharp.dpr}, mobile maxDpr 3)`, !sharp.error && Math.abs(sharp.rasterScale - Math.min(sharp.dpr, 3)) < 0.01, sharp, 'surface');
  const input = await rectOf(s, '#name'); const canvasR = await rectOf(s, 'canvas');
  await s.tap(center(input).x, center(input).y); await sleep(500);
  const focus = await s.evaluate('document.activeElement && document.activeElement.id');
  ctx.check('explainer: a trusted touch tap on the drawn input focuses the live input', focus === 'name', { focus }, 'hit');
  const typed = await s.typeText('hello');
  if (!typed) {
    // iOS Simulator: safaridriver delivers trusted keydown/keypress but inserts no text (the plain-DOM twin behaves the same): the text goes in through the editing command
    await s.evaluate(`(document.getElementById('name').focus(), document.execCommand('insertText', false, 'hello'), true)`);
  }
  await sleep(900);
  const value = await s.evaluate('document.getElementById("name").value');
  ctx.numbers.explainerTyping = { value, via: typed ? 'IME (adb input text)' : 'execCommand insertText after a trusted tap (iOS keys not drivable)' };
  ctx.check('explainer: typed text reaches the live input exactly once', value === 'hello', ctx.numbers.explainerTyping, 'typing');
  const after = await readCanvas(s, 'canvas');
  const changed = regionChanged(rest, after, devRect(input, canvasR, after.width / canvasR.width, 2));
  ctx.check('explainer: typing changes the canvas pixels of the input', changed > 8, { countOver16: changed }, 'typing');
  await s.hideKeyboard?.();
  await noErrors(ctx, 'explainer');
}

/** The mobile fixture: form taps, checkbox, button, pixels vs the twin at rest. */
export async function form(ctx) {
  const { s } = ctx;
  await s.navigate(url(ctx, FIX, { mode: 'ref' })); await until(s, 'window.__HIC_FIXTURE && window.__HIC_FIXTURE.ready'); await sleep(600);
  const top = await pageRectOf(s, '#hic-surface');
  const head = { ...top, height: 320 };
  const [ref] = await pageShots(s, [head]);
  await openPoly(ctx);
  await mode(ctx, 'form');
  const poly = await readCanvas(s, '#hic-surface');
  const k = poly.width / top.width;
  judge(ctx, 'formRest', oracleBest(cropImage(poly, 0, 0, poly.width, Math.round(320 * k)), ref));
  const R = {}; for (const id of ['name', 'consent', 'go']) R[id] = await rectOf(s, '#' + id);
  await s.tap(center(R.name).x, center(R.name).y); await sleep(500);
  ctx.check('form: a tap on the drawn name field focuses it', (await s.evaluate('document.activeElement && document.activeElement.id')) === 'name', null, 'hit');
  if (!(await s.typeText('Ada'))) await s.evaluate(`(document.execCommand('insertText', false, 'Ada'), true)`);
  await sleep(500);
  await s.hideKeyboard?.(); await sleep(500);
  for (const id of ['consent', 'go']) R[id] = await rectOf(s, '#' + id);
  await s.tap(center(R.consent).x, center(R.consent).y); await sleep(400);
  await s.tap(center(R.go).x, center(R.go).y); await sleep(900);
  const v = await s.evaluate('({ name: document.getElementById("name").value, consent: document.getElementById("consent").checked, said: document.getElementById("said").textContent })');
  ctx.numbers.formValues = v;
  ctx.check('form: taps on the drawn checkbox and button reach them (checked, click handler ran)', v.consent === true && v.said === 'Thanks, Ada.', v, 'hit');
  const after = await readCanvas(s, '#hic-surface');
  const said = await rectOf(s, '#said'); const surf = await rectOf(s, '#hic-surface');
  ctx.check('form: the handler\'s result is repainted into the canvas', regionChanged(poly, after, devRect(said, surf, k, 2)) > 8, null, 'pixel');
  await noErrors(ctx, 'form');
}

/** A drawable drawn 120 / 160 css px away from its layout box: a tap at the DRAWN button activates it, a tap at the layout box does not. */
export async function moved(ctx) {
  const { s } = ctx;
  await s.navigate(url(ctx, '/test/fixtures/mobile-moved/index.html', { bundle: ctx.bundle }));
  await until(s, '(window.__drawn || 0) >= 1').catch(() => null); await sleep(900);
  await mode(ctx, 'moved');
  const g = await s.evaluate(`(() => { const c = document.getElementById('c').getBoundingClientRect(); const b = document.getElementById('b'); return { c: { x: c.left, y: c.top }, bx: b.offsetLeft + b.offsetWidth / 2, by: b.offsetTop + b.offsetHeight / 2, off: window.OFFSET }; })()`);
  // the button's position inside the card (offsetLeft/Top are relative to the card's layout box, which the polyfill keeps at the drawn place)
  const card = await s.evaluate(`(() => { const b = document.getElementById('b'), c = document.getElementById('card'); return { x: b.getBoundingClientRect().left - c.getBoundingClientRect().left + b.offsetWidth / 2, y: b.getBoundingClientRect().top - c.getBoundingClientRect().top + b.offsetHeight / 2 }; })()`);
  const drawn = { x: g.c.x + g.off.x + card.x, y: g.c.y + g.off.y + card.y };
  const layout = { x: g.c.x + card.x, y: g.c.y + card.y };
  await s.tap(layout.x, layout.y); await sleep(500);
  const atLayout = await s.evaluate('window.__taps');
  await s.tap(drawn.x, drawn.y); await sleep(600);
  const atDrawn = await s.evaluate('window.__taps');
  ctx.numbers.moved = { drawn, layout, atLayout, atDrawn };
  ctx.check('moved: a tap at the DRAWN button activates it once', atDrawn - atLayout === 1, ctx.numbers.moved, 'hit');
  ctx.check('moved: a tap at the layout box (where nothing is drawn) does not', atLayout === 0, ctx.numbers.moved, 'hit');
  const img = await readCanvas(s, '#c');
  ctx.check('moved: the canvas shows the drawable at the offset', pixelStats(img).nonBlank, null, 'pixel');
  await noErrors(ctx, 'moved');
}

/** A touch drag inside the drawn inner list scrolls the live list (not the page) and the canvas is repainted at the new offset, matching the twin. */
export async function touchScroll(ctx) {
  const { s } = ctx;
  if (ctx.platform === 'ios') {
    // measured: any touch (or mouse) pointer MOVE while down wedges the simulator's safaridriver session for good (every later command times out)
    ctx.check('touchScroll: not drivable on the iOS Simulator (a WebDriver touch drag wedges the session): skipped, documented', true, null, 'n/a'); return;
  }
  await openPoly(ctx);
  await mode(ctx, 'touchScroll');
  const list = await rectOf(s, '#list'); const surf = await rectOf(s, '#hic-surface');
  const before = await readCanvas(s, '#hic-surface');
  const y0 = await s.evaluate('scrollY');
  await s.swipe(center(list).x, list.y + list.height - 30, center(list).x, list.y + 40, 450); await sleep(1500);
  const st = await s.evaluate('({ list: document.getElementById("list").scrollTop, page: scrollY })');
  ctx.numbers.touchScroll = { ...st, pageBefore: y0 };
  ctx.check('touchScroll: a finger drag over the drawn list scrolls the live list, the page stays', st.list >= 60 && Math.abs(st.page - y0) < 2, ctx.numbers.touchScroll, 'scroll');
  const poly = await readCanvas(s, '#hic-surface');
  const k = poly.width / surf.width;
  ctx.check('touchScroll: the list region of the canvas is repainted', regionChanged(before, poly, devRect(list, surf, k, 0)) > 50, null, 'scroll');
  await s.navigate(url(ctx, FIX, { mode: 'ref' })); await until(s, 'window.__HIC_FIXTURE && window.__HIC_FIXTURE.ready');
  await s.evaluate(`(document.getElementById('list').scrollTop = ${st.list}, true)`); await sleep(700);
  const lr = await pageRectOf(s, '#list'); const sr = await pageRectOf(s, '#hic-surface');
  const [ref] = await pageShots(s, [lr]);
  judge(ctx, 'touchScrollList', oracleBest(cropImage(poly, Math.round((lr.x - sr.x) * k), Math.round((lr.y - sr.y) * k), ref.width, ref.height), ref));
  await noErrors(ctx, 'touchScroll');
}

/** Rotation: Android rotates the device (the viewport changes size); iOS cannot be rotated from the command line, so the canvas is resized instead (labelled). */
export async function rotation(ctx) {
  const { s } = ctx;
  await openPoly(ctx);
  await mode(ctx, 'rotation');
  const before = await s.evaluate('({ w: innerWidth, h: innerHeight, cw: document.getElementById("hic-surface").width })');
  let how;
  if (await s.rotate?.(true)) {
    how = 'device rotated to landscape';
    for (let i = 0; i < 30 && (await s.evaluate('innerWidth')) === before.w; i++) await sleep(300);
  } else {
    how = 'iOS: canvas css width 340 -> 300 px (no rotation from the command line)';
    await s.evaluate(`(document.getElementById('hic-surface').style.width = '300px', true)`);
  }
  await sleep(1500);
  const after = await s.evaluate('(() => { const c = document.getElementById("hic-surface"); const r = c.getBoundingClientRect(); return { w: innerWidth, h: innerHeight, cw: c.width, cssW: r.width, dpr: devicePixelRatio }; })()');
  ctx.numbers.rotation = { how, before, after };
  ctx.check(`rotation (${how}): the backing store follows the device-pixel content box`, Math.abs(after.cw - Math.round(after.cssW * after.dpr)) <= 1 && after.cw > 0, ctx.numbers.rotation, 'surface');
  const img = await readCanvas(s, '#hic-surface');
  ctx.check('rotation: the canvas is drawn after the change (non-blank)', pixelStats(img).nonBlank, null, 'pixel');
  const r = await rectOf(s, '#name');
  await s.tap(center(r).x, center(r).y); await sleep(500);
  ctx.check('rotation: a tap on the drawn field still focuses it', (await s.evaluate('document.activeElement && document.activeElement.id')) === 'name', null, 'hit');
  await s.hideKeyboard?.();
  if (how.startsWith('device')) { await s.rotate(false); await sleep(1500); }
  await noErrors(ctx, 'rotation');
}

/** Android: a tap on a field the virtual keyboard would cover reveals it (visual viewport shrinks or pans, the field stays visible, its drawn copy is still under it). */
export async function keyboard(ctx) {
  const { s } = ctx;
  if (ctx.platform !== 'android') { ctx.check('keyboard: not drivable on the iOS Simulator (its hardware keyboard keeps the virtual one hidden): skipped, documented', true, null, 'n/a'); return; }
  await openPoly(ctx);
  await mode(ctx, 'keyboard');
  const late = await pageRectOf(s, '#late');
  await scrollTo(s, Math.max(0, late.y - 600));
  const r = await rectOf(s, '#late');
  const vv0 = await s.evaluate('visualViewport.height');
  await s.osTap(center(r).x, center(r).y); await sleep(2000);
  const st = await s.evaluate(`(() => { const r = document.getElementById('late').getBoundingClientRect(); const v = visualViewport; return { active: document.activeElement.id, vvH: v.height, vvTop: v.offsetTop, top: r.top, bottom: r.bottom, visible: r.top >= v.offsetTop - 1 && r.bottom <= v.offsetTop + v.height + 1 }; })()`);
  ctx.numbers.keyboard = { vv0, ...st };
  ctx.check('keyboard: an OS tap on the drawn late field focuses it and opens the virtual keyboard', st.active === 'late' && st.vvH < vv0 - 100, ctx.numbers.keyboard, 'hit');
  ctx.check('keyboard: the focused field is inside the visible viewport above the keyboard', st.visible, ctx.numbers.keyboard, 'hit');
  await s.hideKeyboard(); await sleep(800);
  await noErrors(ctx, 'keyboard');
}

/** A long press on the drawn text of a field selects a word in the live field (the OS selection handles belong to the live element). */
export async function selection(ctx) {
  const { s } = ctx;
  // drivability first, on the plain DOM: a WebDriver touch hold is not a long press in the iOS Simulator's Safari (measured: no focus, no selection on the twin either)
  await s.navigate(url(ctx, FIX, { mode: 'ref' })); await until(s, 'window.__HIC_FIXTURE && window.__HIC_FIXTURE.ready');
  const lateRef = await pageRectOf(s, '#late');
  await scrollTo(s, Math.max(0, lateRef.y - 200));
  const rr = await rectOf(s, '#late');
  await s.longPress(rr.x + 40, rr.y + rr.height / 2, 900); await sleep(1200);
  const twin = await s.evaluate(`(() => { const e = document.getElementById('late'); return { active: document.activeElement.id, start: e.selectionStart, end: e.selectionEnd }; })()`);
  await s.hideKeyboard?.();
  if (!(twin.active === 'late' && twin.end > twin.start)) {
    ctx.numbers.selectionTwin = twin;
    ctx.check('selection: not drivable here (a long press does not select on the plain-DOM twin either): skipped, documented', true, twin, 'n/a'); return;
  }
  await openPoly(ctx);
  await mode(ctx, 'selection');
  const late = await pageRectOf(s, '#late');
  await scrollTo(s, Math.max(0, late.y - 200));
  const r = await rectOf(s, '#late');
  await s.longPress(r.x + 40, r.y + r.height / 2, 900); await sleep(1200);
  const sel = await s.evaluate(`(() => { const e = document.getElementById('late'); return { active: document.activeElement.id, start: e.selectionStart, end: e.selectionEnd }; })()`);
  ctx.numbers.selection = sel;
  ctx.check('selection: a long press on the drawn field selects text in the live field', sel.active === 'late' && sel.end > sel.start, sel, 'hit');
  await s.hideKeyboard?.();
  await noErrors(ctx, 'selection');
}

/** iOS: every F6 control region in the iOS look vs the plain-DOM twin (the controls thresholds of G-xbrowser). */
export async function controls(ctx) {
  const { s } = ctx; const P = '/test/fixtures/f6-controls/index.html';
  await s.navigate(url(ctx, P, { mode: 'ref', narrow: 1 })); await until(s, 'window.__HIC_FIXTURE && window.__HIC_FIXTURE.ready'); await sleep(800);
  const surf = await pageRectOf(s, '#hic-surface');
  const rects = await s.evaluate(`[...document.querySelectorAll('[data-ctl]')].map((e) => { const r = e.getBoundingClientRect(); return { id: e.dataset.ctl, x: r.left + scrollX - 1, y: r.top + scrollY - 1, width: r.width + 2, height: r.height + 2 }; })`);
  const refs = await pageShots(s, rects);
  await s.navigate(url(ctx, P, { mode: 'poly', narrow: 1, bundle: ctx.bundle }));
  await until(s, 'window.__HIC_FIXTURE && (window.__HIC_FIXTURE.ready || window.__HIC_FIXTURE.fatal)').catch(() => null);
  if (ctx.control) await s.evaluate(`(() => { const st = document.createElement('style'); st.textContent = '[data-ctl] > *, [data-ctl].sc { accent-color: #f00 !important; outline: 6px solid #f0f !important; }'; document.head.appendChild(st); for (const e of document.querySelectorAll('[data-ctl] > *')) e.value = e.value; return true; })()`);
  await sleep(1500);
  await mode(ctx, 'controls');
  const poly = await readCanvas(s, '#hic-surface');
  const k = poly.width / surf.width;
  const bad = []; const per = {};
  rects.forEach((r, i) => {
    const ref = refs[i];
    const crop = cropImage(poly, Math.round((r.x - surf.x) * k), Math.round((r.y - surf.y) * k), ref.width, ref.height);
    const o = oracleBest(crop, ref, { maxFraction: 0.15, maxStructural: 0.015 });
    per[r.id] = [+(o.shiftTolerant * 100).toFixed(1), +(o.structural * 100).toFixed(1)];
    if (!(o.sizeMatch && o.shiftTolerant <= 0.15 && o.structural <= 0.015)) { bad.push(r.id); ctx.save(`controls-${r.id}.surface`, crop); ctx.save(`controls-${r.id}.ref`, o.ref); }
  });
  ctx.numbers.controls = per;
  if (ctx.standIn && !ctx.control) {
    // Chromium draws its own controls inside the image; on the stand-in (Chrome 124 with the anchor flag) the look is that OLD version's Android theme (measured: an outlined
    // indeterminate checkbox, a dark progress track under a light accent, sub-pixel edges at DPR 2.625), so the numbers are recorded, not gated, until a Chrome >= 130 image runs
    ctx.numbers.controlsBad = bad;
    ctx.check(`controls: informative on the stand-in Chrome ${ctx.s.chromeVersion}: ${rects.length - bad.length} of ${rects.length} regions within the thresholds (not gated)`, true, { bad }, 'n/a');
    return;
  }
  ctx.check(`controls: each of ${rects.length} control regions matches the plain-DOM twin (<= 15 % over 16, <= 1.5 % over 100, +-1 device row)`, bad.length === 0 && rects.length > 50, { bad, per: Object.fromEntries(bad.map((b) => [b, per[b]])) }, 'control-look');
  await noErrors(ctx, 'controls');
}

/**
 * The refusal on a browser the gate does not admit (Android: the image's own Chrome 124 with its real user agent; iOS: Safari 18 in an iOS 18 simulator): install() does
 * not run, window.__HIC__.error names the version, the page keeps working. Control: the same page with a user agent of a supported version must NOT be refused for the version.
 */
export async function unsupported(ctx) {
  const { s } = ctx;
  await s.navigate(url(ctx, '/examples/basic/index.html', ctx.control ? { xbua: 1 } : {}));
  await sleep(1500);
  const r = await s.evaluate('({ err: window.__HIC__ && window.__HIC__.error ? String(window.__HIC__.error.message) : null, feature: window.__HIC__ && window.__HIC__.error ? window.__HIC__.error.feature : null, status: document.getElementById("status").textContent })');
  ctx.numbers.unsupported = r;
  ctx.check('unsupported: refused loudly with the version named (HicUnsupportedError browser), the page keeps running', r.feature === 'browser' && /older than the supported minimum/.test(r.err ?? '') && /refused to install/.test(r.status), r, 'refusal');
}

export const SCENARIOS = { gate, explainer, form, moved, touchScroll, rotation, keyboard, selection, controls };
export const CONTROL_CLASSES = { gate: [], explainer: ['pixel', 'hit', 'typing'], form: ['pixel', 'hit'], moved: ['hit'], touchScroll: ['scroll'], rotation: ['hit'], keyboard: ['hit'], selection: ['hit'], controls: ['control-look'], unsupported: ['refusal'] };
