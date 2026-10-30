// The scenarios of the mobile gate (test/mobile/run.mjs), on iOS Simulator (Mobile Safari through safaridriver) and Android Emulator (Chrome through CDP).
// ctx = { s, srv, files, bundle, control, check(label, ok, data, cls), numbers, save(name, img), platform: 'ios'|'android', standIn, forced, plainBundle }; `files`: the server's map of URL paths onto files (scrollCompose serves its mutant bundles through it)
// `forced`: the browser has a usable native implementation (Chromium 158 on Android), so `bundle` ends with force-polyfill.js (install({ forcePolyfill: true })) and the
// polyfill scenarios run the polyfill's path on that engine; `nativeFirst` loads `plainBundle` and checks that the polyfill steps aside and the native result passes.
// The session `s` offers navigate, evaluate, waitFor, screenshot, viewportOffset, tap, swipe, longPress, typeText (false when not drivable), rotate (false when not
// drivable), osTap (Android). In the control run the pages are sabotaged (RECORDER ?xbsab=1: drawElementImage draws nothing, drawn children ignore the pointer) and
// every class a scenario declares must go red.
import { pixelStats, cropImage } from '../harness/lib/pixels.mjs';
import { decodePng } from '../harness/lib/png.mjs';
import { readCanvas, oracle, regionChanged, pageErrors, sleep } from '../xbrowser/lib.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_ROOT } from '../harness/lib/util.mjs';
import { buildMutant } from '../gates/mutants/build.mjs';

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

async function mode(ctx, label, want = 'polyfill') {
  const m = await ctx.s.evaluate('window.__HIC__ ? (window.__HIC__.error ? "error: " + window.__HIC__.error.message : window.__HIC__.installed.mode) : "no __HIC__"');
  ctx.numbers[`${label}Mode`] = m;
  const how = want === 'native' ? 'the polyfill stepped aside for the native implementation (mode native)' : `the polyfill installed (mode polyfill${ctx.forced ? ', forced over the native implementation' : ''})`;
  ctx.check(`${label}: ${how}`, m === want, { mode: m }, 'surface');
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
export async function explainer(ctx, want = 'polyfill') {
  const { s } = ctx; const P = '/test/fixtures/explainer/index.html';
  await s.navigate(url(ctx, P, { mode: 'ref' })); await until(s, 'document.getElementById("twin")');
  await sleep(600);
  const twin = await pageRectOf(s, '#twin');
  const [ref] = await pageShots(s, [twin]);
  await s.navigate(url(ctx, P, { mode: 'poly', bundle: ctx.bundle }));
  await until(s, '(window.__paints || 0) >= 1').catch(() => null); await sleep(900);
  await mode(ctx, 'explainer', want);
  const rest = await readCanvas(s, 'canvas');
  judge(ctx, 'explainerRest', oracleBest(rest, ref));
  if (want === 'native') {
    // the native implementation has no polyfill report: the raster scale is the browser's
    await tapAndType(ctx, rest); return;
  }
  // sharpness: on a DPR-3 phone the snapshot is rastered at the device scale (mobile maxDpr 3), not upscaled from the desktop 2.5
  const sharp = await s.evaluate('(() => { const r = window.__HIC__.installed.report(); return { dpr: devicePixelRatio, rasterScale: r.canvases[0].stats.snapshot.rasterScale, bitmap: [document.querySelector("canvas").width, document.querySelector("canvas").height] }; })()').catch((e) => ({ error: e.message }));
  ctx.numbers.sharpness = sharp;
  ctx.check(`explainer: the snapshot is rastered at the device pixel ratio (DPR ${sharp.dpr}, mobile maxDpr 3)`, !sharp.error && Math.abs(sharp.rasterScale - Math.min(sharp.dpr, 3)) < 0.01, sharp, 'surface');
  await tapAndType(ctx, rest);
}

/** The explainer's tap, typing and repaint checks (after the pixels at rest). */
async function tapAndType(ctx, rest) {
  const { s } = ctx;
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

/**
 * In the page: jumps of each scroller (a far one, then a near one the cached pages cover); the first canvas paint after each jump (a COMPOSED frame when the scroll
 * compositor served it) against the settled canvas at the same offset (the exact tile). A pixel differs when a channel differs by more than 16. Inside the corner squares
 * of a rounded scroller (radius + 2 css px) the pixels within 1.5 device px of the padding box's curve (the ARC, antialiased by the clip) are counted apart from the
 * rest (OFF the arc), with the number of arc pixels.
 */
export const COMPOSE_ORACLE = (sels, offsets) => `(async () => {
  const canvas = document.getElementById('hic-surface');
  const stats = () => window.__HIC__.installed.report().canvases[0].stats.snapshot.scroll ?? {};
  const grab = () => { const c = new OffscreenCanvas(canvas.width, canvas.height); const x = c.getContext('2d'); x.drawImage(canvas, 0, 0); return x.getImageData(0, 0, c.width, c.height).data; };
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const out = [];
  for (const sel of ${JSON.stringify(sels)}) {
    const s = document.querySelector(sel);
    const cr = canvas.getBoundingClientRect(), k = canvas.width / cr.width, r = s.getBoundingClientRect(), cs = getComputedStyle(s);
    const rad = parseFloat(cs.borderTopLeftRadius) || 0, m = (rad + 2) * k;
    const box = { x0: (r.left - cr.left) * k, y0: (r.top - cr.top) * k, x1: (r.right - cr.left) * k, y1: (r.bottom - cr.top) * k };
    const corner = (x, y) => rad > 0 && (x < box.x0 + m || x > box.x1 - m) && (y < box.y0 + m || y > box.y1 - m);
    // the padding box and its inner radii (uniform radius and border here), device px
    const bw = parseFloat(cs.borderTopWidth) || 0, pb = { x0: box.x0 + bw * k, y0: box.y0 + bw * k, x1: box.x1 - bw * k, y1: box.y1 - bw * k }, ri = Math.max(0, rad - bw) * k;
    const arc = (x, y) => {
      const px = x + 0.5, py = y + 0.5;
      const cx = px < (pb.x0 + pb.x1) / 2 ? pb.x0 + ri : pb.x1 - ri, cy = py < (pb.y0 + pb.y1) / 2 ? pb.y0 + ri : pb.y1 - ri;
      if (!(ri > 0) || (px - cx) * (cx - (pb.x0 + pb.x1) / 2) < 0 || (py - cy) * (cy - (pb.y0 + pb.y1) / 2) < 0) return false;
      return Math.abs(Math.hypot(px - cx, py - cy) - ri) < 1.5;
    };
    let arcPixels = 0;
    for (let y = Math.floor(box.y0); y < box.y1; y++) for (let x = Math.floor(box.x0); x < box.x1; x++) if (corner(x, y) && arc(x, y)) arcPixels++;
    for (const t of ${JSON.stringify(offsets)}) {
      await wait(700);
      const c0 = stats().composed ?? 0;
      const painted = new Promise((ok) => canvas.addEventListener('paint', () => ok(grab()), { once: true }));
      s.scrollTop = t;
      const a = await Promise.race([painted, wait(5000).then(() => null)]);
      if (!a) { out.push({ sel, t, painted: false }); continue; }
      const composed = (stats().composed ?? 0) > c0;
      await wait(700);
      const b = grab();
      let grid = 0, onArc = 0, offArc = 0, max = 0, maxArc = 0;
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
        if (d <= 16) continue;
        const p = i / 4, x = p % canvas.width, y = (p - x) / canvas.width;
        if (!corner(x, y)) { grid++; max = Math.max(max, d); } else if (arc(x, y)) { onArc++; maxArc = Math.max(maxArc, d); } else { offArc++; max = Math.max(max, d); }
      }
      let ink = 0; for (let i = 3; i < b.length; i += 4) if (b[i] > 0) ink++;
      out.push({ sel, t, live: s.scrollTop, composed, grid, offArc, onArc, arcPixels, max, maxArc, ink: +(ink / (b.length / 4)).toFixed(3) });
    }
  }
  return { dpr: devicePixelRatio, size: [canvas.width, canvas.height], jumps: out, scroll: stats() };
})()`;

/**
 * In the scroll-and-resize example with an empty drawable canvas (no drawable child yet, as a page that fills a canvas later has) added to the page: a momentum-like
 * scroll of the inbox driven from requestAnimationFrame (scrollTop += v, v decaying, as test/bench/scroll-jank-ios.mjs `script`), its scroll steps and the composed
 * commits they made. Such a canvas once stopped the compositor for every canvas of the page (0 of about 200 steps composed). The jumps of COMPOSE_ORACLE wait 700 ms
 * each and did not see it on the fixture: it needs a post-frame pump that leaves side builds for the next one.
 */
const EMPTY_CANVAS_SCROLL = `(async () => {
  const c = document.createElement('canvas'); c.setAttribute('content', 'drawable'); c.style.cssText = 'display:block;width:40px;height:40px'; document.body.append(c);
  const stats = () => window.__HIC__.installed.report().canvases[0].stats.snapshot.scroll ?? {};
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const s = document.getElementById('inbox');
  // a phone plans the visible inbox ahead while the page rests, before this canvas came: a layout change of the inbox drops that plan, so the plan and the pages are
  // built during the scroll, beside the empty canvas (the stuck pump this check is for left exactly those side builds unrun)
  s.style.paddingBottom = '1px';
  await wait(1500);
  const c0 = stats().composed ?? 0;
  let steps = 0;
  for (const dir of [1, 1, -1]) {
    await new Promise((ok) => { let v = 40; const f = () => { const t = s.scrollTop; s.scrollTop += v * dir; if (s.scrollTop !== t) steps++; v *= 0.95; if (v < 0.5) return ok(); requestAnimationFrame(f); }; requestAnimationFrame(f); });
    await wait(500);
  }
  return { steps, composed: (stats().composed ?? 0) - c0, canvases: window.__HIC__.installed.report().canvases.map((x) => x.state + ':' + x.drawables) };
})()`;

/**
 * Mutants of the readable core bundle for the scrollCompose control: each takes back one part of the WebKit composition (an anchor that drifted fails loudly).
 * grid: pages and rects on device pixels (the Chromium snapping): the composed frames came out one device pixel low. corner: a rounded port composed with 'copy':
 * an accelerated WebKit canvas drops the destination under the antialiased curve. empty: a canvas that never painted counts as one whose first snapshot is due, for
 * good, so the scheduler builds inside the frame, where the side builds (plans, pages) never run: nothing is composed while an empty drawable canvas is on the page.
 */
const COMPOSE_MUTANTS = {
  grid: [['...grid ? { grid } : {},', '...{},']],
  corner: [['const over = round && grid ? "source-over" : "copy";', 'const over = "copy";']],
  empty: [['entry.resized || firstDue(entry, now)', 'entry.resized || !entry.record.paint.everFired']],
};

/**
 * The scroll compositor on WebKit at the phone's DPR (3 on the iPhone 17 Pro, 2 on the iPhone 17): every composed frame equals the tile the snapshot settles on at
 * that offset, everywhere but on the antialiased arc of a rounded port. On the arc a few pixels may differ (at most 2 % of them, measured 0-3 of about 250 at DPR 3):
 * the compositor blends a page rendered with square corners (content over the scroller's background) into the backdrop by the clip's coverage, where the engine
 * clips the content alone over background and border; the two differ where translucent content (a glyph's edge, a row's border) crosses the curve. The Chromium path
 * composes rounded ports the same way (test/unit/snapshot-capture/scroll-pages.browser.test.mjs). Then the composed share of a scripted scroll beside an empty
 * drawable canvas (EMPTY_CANVAS_SCROLL, class `empty`). The control serves a mutant core (COMPOSE_MUTANTS) instead of sabotaging the page, and each mutant must turn
 * its own class red.
 */
export async function scrollCompose(ctx) {
  const { s } = ctx;
  if (ctx.platform !== 'ios') { ctx.check('scrollCompose: WebKit only (Chrome for Android runs the Chromium compositor that the desktop gates cover)', true, null, 'n/a'); return; }
  const sels = ['#round', '#square'];
  const offsets = [100, 131, 400, 437, 800, 851, 20, 61, 1203, 1170];
  const run = async (bundle, tag) => {
    const u = new URL('/test/fixtures/mobile/scroll-compose.html', ctx.srv.url);
    u.searchParams.set('iso', '0'); u.searchParams.set('mode', 'poly'); u.searchParams.set('bundle', bundle);
    await s.navigate(u.href);
    await until(s, 'window.__HIC_FIXTURE && (window.__HIC_FIXTURE.ready || window.__HIC_FIXTURE.fatal)', 20000).catch(() => null);
    await sleep(1500);
    const r = await s.evaluate(COMPOSE_ORACLE(sels, offsets), { timeoutMs: 90000 });
    ctx.numbers[`scrollCompose${tag}`] = r;
    return r;
  };
  /** the example loads the minified core: a mutant is served at its path (`core`: a file to serve there, null for the built one) @param {string|null} core @param {string} tag */
  const runEmpty = async (core, tag) => {
    const min = '/dist/hic-live-polyfill.iife.min.js';
    if (core) /** @type {Record<string, string>} */ (ctx.files)[min] = core;
    try {
      const u = new URL('/examples/scroll-and-resize/index.html', ctx.srv.url);
      u.searchParams.set('iso', '0');
      await s.navigate(u.href);
      await until(s, '!!(window.__HIC__ && window.__HIC__.installed && window.__HIC__.installed.report().canvases.length)', 20000);
      await sleep(1000);
      const r = await s.evaluate(EMPTY_CANVAS_SCROLL, { timeoutMs: 60000 });
      ctx.numbers[`scrollComposeEmpty${tag}`] = r;
      ctx.check(`scrollCompose${tag ? ` (mutant ${tag})` : ''}: an empty drawable canvas on the page leaves the compositor running: a scripted scroll of the example's inbox composed at least half of its steps (${r.composed} of ${r.steps}; canvases ${r.canvases.join(' ')})`,
        r.steps > 50 && r.composed >= r.steps / 2, r, 'empty');
    } finally { if (core) delete /** @type {Record<string, string>} */ (ctx.files)[min]; }
  };
  /** @param {any} r @param {string} label @param {'grid'|'corner'} cls */
  const judgeCompose = (r, label, cls) => {
    const composed = r.jumps.filter((j) => j.composed);
    const per = sels.map((sel) => composed.filter((j) => j.sel === sel).length);
    const bad = composed.filter((j) => (cls === 'grid' ? j.grid > 0 : j.offArc > 0 || j.onArc > 0.02 * j.arcPixels));
    ctx.check(`scrollCompose ${label}: each scroller composed at least 3 of its ${offsets.length} jumps (composed: ${per.join(' / ')}) and every jump painted, the canvas non-blank`,
      per.every((n) => n >= 3) && r.jumps.every((j) => j.painted !== false && j.ink > 0.5), { per, scroll: r.scroll }, 'surface');
    ctx.check(`scrollCompose ${label}: every composed frame equals the settled tile at its offset at DPR ${r.dpr} (${cls === 'grid' ? 'outside the rounded corners: no pixel over 16' : 'in the rounded corners: no pixel over 16 off the antialiased arc, at most 2 % of the arc'})`,
      composed.length > 0 && bad.length === 0, bad.slice(0, 4), cls);
  };
  if (!ctx.control) {
    const r = await run(ctx.bundle, '');
    judgeCompose(r, '', 'grid');
    judgeCompose(r, '', 'corner');
    await noErrors(ctx, 'scrollCompose');
    await runEmpty(null, '');
    await noErrors(ctx, 'scrollCompose (empty drawable canvas)');
    return;
  }
  const core = '/dist/hic-live-polyfill.iife.js';
  if (!ctx.bundle.split(',').includes(core) || !ctx.files) throw new Error(`scrollCompose control: the bundle list has no ${core} to replace, or the server serves no mutants`);
  const text = readFileSync(resolve(PROJECT_ROOT, 'dist/hic-live-polyfill.iife.js'), 'utf8');
  const dir = resolve(PROJECT_ROOT, '.scratch/mobile-mutants');
  mkdirSync(dir, { recursive: true });
  for (const [cls, edits] of Object.entries(COMPOSE_MUTANTS)) {
    const m = buildMutant(text, { edits });
    if ('drift' in m) throw new Error(`scrollCompose control: mutant ${cls}: ${m.drift}`);
    const file = resolve(dir, `core-${cls}.js`);
    writeFileSync(file, m.text);
    const path = `/__mutant/core-${cls}.js`;
    ctx.files[path] = file;
    if (cls === 'empty') { await runEmpty(file, cls); continue; }
    const r = await run(ctx.bundle.split(',').map((b) => (b === core ? path : b)).join(','), `Mutant_${cls}`);
    judgeCompose(r, `(mutant ${cls})`, /** @type {'grid'|'corner'} */ (cls));
  }
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
    // indeterminate checkbox, a dark progress track under a light accent, sub-pixel edges at DPR 2.625), so the numbers are recorded, not gated (a real Chromium >= 130 is)
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

/**
 * A browser with a usable native implementation (Chromium 158 on Android): the plain bundles step aside (mode native) and the explainer's pixels, tap and typing pass
 * on the native result. Skipped (documented) where the browser has none.
 */
export async function nativeFirst(ctx) {
  if (!ctx.forced) { ctx.check('nativeFirst: this browser has no usable native implementation: skipped', true, null, 'n/a'); return; }
  const numbers = {};
  await explainer({ ...ctx, numbers, bundle: ctx.plainBundle, forced: false }, 'native');
  ctx.numbers.nativeFirst = numbers;
}

export const SCENARIOS = { gate, nativeFirst, explainer, form, moved, touchScroll, scrollCompose, rotation, keyboard, selection, controls };
export const CONTROL_CLASSES = { gate: [], nativeFirst: ['pixel', 'hit', 'typing'], explainer: ['pixel', 'hit', 'typing'], form: ['pixel', 'hit'], moved: ['hit'], touchScroll: ['scroll'], scrollCompose: ['grid', 'corner', 'empty'], rotation: ['hit'], keyboard: ['hit'], selection: ['hit'], controls: ['control-look'], unsupported: ['refusal'] };
