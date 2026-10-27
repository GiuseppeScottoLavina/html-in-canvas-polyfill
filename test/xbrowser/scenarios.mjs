// The scenarios of G-xbrowser. Each one runs against the polyfill canvas AND the plain-DOM twin of the same fixture in the SAME engine.
// ctx = { s (WdSession), srv, bundle, control, check(name, ok, data, cls), numbers, save(name, img) }
// In the control run the pages are sabotaged (RECORDER ?xbsab=1: drawElementImage draws nothing, drawn children ignore the pointer; unsupported -> supported
// content; uninstall -> a leaked property): every class a scenario declares must then go red.
import { IDENTITY_EXPR, diffIdentity } from '../gates/lib/identity.mjs';
import { KEYS } from '../harness/lib/webdriver.mjs';
import { pixelStats } from '../harness/lib/pixels.mjs';
import { shotRect, rectOf, readCanvas, oracle, regionChanged, BLANK_START, BLANK_STOP, pageErrors, until, sleep } from './lib.mjs';
import { cropImage } from '../harness/lib/pixels.mjs';
import { SCROLLBAR_PROBE_EXPR } from '../harness/lib/env.mjs';
import { COMPOSE_ORACLE } from '../mobile/scenarios.mjs';
import { buildMutant } from '../gates/mutants/build.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_ROOT } from '../harness/lib/util.mjs';

function url(ctx, path, params = {}) {
  const u = new URL(path, ctx.srv.url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  if (ctx.control && params.mode !== 'ref') u.searchParams.set('xbsab', '1');
  return u.href;
}
/** Overlay scrollbars (macOS) appear for ~1 s after a load or a scroll in the plain-DOM twin; the snapshot never shows them. */
const OVERLAY_FADE_MS = 1600;
const center = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const devRect = (r, origin, k, pad = 0) => ({ x: Math.max(0, Math.floor((r.x - origin.x) * k) - pad), y: Math.max(0, Math.floor((r.y - origin.y) * k) - pad), w: Math.ceil(r.width * k) + 2 * pad, h: Math.ceil(r.height * k) + 2 * pad });

function judge(ctx, name, o, cls = 'pixel') {
  ctx.numbers[name] = { fraction: +(o.fraction ?? 1).toFixed(5), shiftTolerant: +(o.shiftTolerant ?? 1).toFixed(5), structural: +(o.structural ?? 1).toFixed(5), countOver16: o.countOver16, maxDiff: o.maxDiff, size: o.size, refSize: o.refSize, surfaceNonBlank: o.surfaceNonBlank, refNonBlank: o.refNonBlank };
  ctx.check(`${name}: canvas vs plain-DOM twin: <= 5 % of pixels over 16 and <= 1 % over 100 (+-1 device row), both non-blank`, o.pass, ctx.numbers[name], cls);
  if (o.diffImage) ctx.save(name + '.diff', o.diffImage);
  if (!o.pass) { ctx.save(name + '.surface', o.surface); ctx.save(name + '.ref', o.ref); }
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

/** In-page keydown -> first rendering update whose canvas region differs (commit latency, frame-quantised). */
const LATENCY = (sel, region, n) => `(async () => {
  const c = document.querySelector(${JSON.stringify(sel)}); const t = document.createElement('canvas'); const R = ${JSON.stringify(region)};
  t.width = R.w; t.height = R.h; const x = t.getContext('2d', { willReadFrequently: true });
  const hash = () => { x.clearRect(0, 0, R.w, R.h); x.drawImage(c, R.x, R.y, R.w, R.h, 0, 0, R.w, R.h); const d = x.getImageData(0, 0, R.w, R.h).data; let h = 0; for (let i = 0; i < d.length; i += 16) h = (h * 31 + d[i] + 3 * d[i + 1] + 7 * d[i + 2]) | 0; return h; };
  window.__XB_LAT = { out: [], n: ${n} }; const st = window.__XB_LAT;
  document.addEventListener('keydown', () => { const h0 = hash(); const t0 = performance.now(); const tick = () => { if (hash() !== h0) st.out.push(performance.now() - t0); else if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else st.out.push(-1); }; requestAnimationFrame(tick); }, true);
  return true; })()`;

export async function explainer(ctx) {
  const { s } = ctx; const P = '/test/fixtures/explainer/index.html';
  await s.navigate(url(ctx, P, { mode: 'ref' })); await until(s, 'window.__ready === true');
  const twin = await rectOf(s, '#twin'); const inputR = await rectOf(s, '#name');
  const refRest = (await shotRect(s, twin)).img;
  await s.click(center(inputR).x, center(inputR).y); await s.typeText('hello'); await s.evaluate('document.getElementById("name").blur()'); await sleep(300);
  const refTyped = (await shotRect(s, twin)).img;

  await s.navigate(url(ctx, P, { mode: 'poly', bundle: ctx.bundle }));
  await until(s, '(window.__paints || 0) >= 1').catch(() => null); await sleep(700);
  await mode(ctx, 'explainer');
  const rest = await readCanvas(s, 'canvas');
  judge(ctx, 'explainerRest', oracle(rest, refRest));
  const k = rest.width / twin.width; const region = devRect(inputR, twin, k, 2);

  await s.click(center(inputR).x, center(inputR).y); await sleep(250);
  const focus = await s.evaluate('document.activeElement && document.activeElement.id');
  ctx.check('explainer: a trusted click at the drawn input focuses the live input', focus === 'name', { focus }, 'hit');
  await s.evaluate(LATENCY('canvas', region, 5));
  await s.typeText('hello', { intervalMs: 120 }); await sleep(600);
  const value = await s.evaluate('document.getElementById("name").value');
  ctx.check('explainer: typed text reaches the live input exactly once per key (no doubled insertion)', value === 'hello', { value }, 'typing');
  const lat = await s.evaluate('window.__XB_LAT.out');
  ctx.numbers.explainerKeyToCanvasMs = lat.map((v) => Math.round(v));
  const typed = await readCanvas(s, 'canvas');
  const changed = regionChanged(rest, typed, region);
  ctx.check('explainer: typing changes the canvas pixels of the input', changed > 8, { countOver16: changed }, 'typing');
  await s.evaluate('document.getElementById("name").blur()'); await sleep(600);
  judge(ctx, 'explainerTyped', oracle(await readCanvas(s, 'canvas'), refTyped));
  ctx.numbers.taint = await s.evaluate(TAINT_PROBE, { timeoutMs: 20000 }).catch((e) => ({ error: e.message.slice(0, 300) }));
  const t = ctx.numbers.taint;
  ctx.check('explainer: the canvas stays readable and the WebGL / WebGPU texture paths upload non-blank pixels', !t.error && t.canvasReadable && t.webgl?.nonZero > 0 && (t.webgpu?.nonZero > 0 || t.webgpu?.skipped), t, 'pixel');
  await noErrors(ctx, 'explainer');
}

/** Raw engine behaviour of the data: URL path (informative) + the polyfill texture paths (asserted). Runs on the explainer poly page. */
const TAINT_PROBE = `(async () => {
  const out = {};
  const form = document.querySelector('canvas form'); const dpr = devicePixelRatio;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="background:#f00;width:100px;height:40px">x</div></foreignObject></svg>';
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await img.decode();
  const c = document.createElement('canvas'); c.width = 100; c.height = 40; const x = c.getContext('2d'); x.drawImage(img, 0, 0);
  try { out.raw2dRed = x.getImageData(50, 20, 1, 1).data[0]; } catch (e) { out.raw2dRed = 'ERR ' + e.name; }
  try { await createImageBitmap(img); out.rawBitmap = 'ok'; } catch (e) { out.rawBitmap = 'ERR ' + e.name; }
  try { const g = document.createElement('canvas').getContext('webgl2'); g.bindTexture(g.TEXTURE_2D, g.createTexture()); g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, img); out.rawWebGL = g.getError() === 0 ? 'ok' : 'glError ' + g.getError(); } catch (e) { out.rawWebGL = 'ERR ' + e.name; }
  try { document.querySelector('canvas').toDataURL(); out.canvasReadable = true; } catch (e) { out.canvasReadable = false; out.canvasErr = e.name; }
  const w = Math.ceil(form.offsetWidth * dpr), h = Math.ceil(form.offsetHeight * dpr); out.size = [w, h];
  try {
    const gc = document.createElement('canvas'); gc.setAttribute('content', 'drawable'); gc.width = 200; gc.height = 100; gc.style.cssText = 'width:100px;height:50px';
    gc.innerHTML = '<div drawable style="width:100px;height:50px;background:#c00;color:#fff">gl</div>'; document.body.appendChild(gc);
    const gl = gc.getContext('webgl2'); const el = gc.firstElementChild;
    await new Promise((ok) => { gc.addEventListener('paint', ok, { once: true }); gc.requestPaint(); setTimeout(ok, 3000); });
    const gw = 200, gh = 100; const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gw, gh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, el);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const px = new Uint8Array(gw * gh * 4); gl.readPixels(0, 0, gw, gh, gl.RGBA, gl.UNSIGNED_BYTE, px); let n = 0; for (let i = 3; i < px.length; i += 4) n += px[i] ? 1 : 0;
    out.webgl = { nonZero: n, glError: gl.getError() }; gc.remove();
  } catch (e) { out.webgl = { error: String(e) }; }
  try {
    const adapter = navigator.gpu && await navigator.gpu.requestAdapter();
    if (!adapter) out.webgpu = { skipped: 'no adapter' };
    else {
      const device = await adapter.requestDevice();
      const tex = device.createTexture({ size: [w + 4, h + 4], format: 'rgba8unorm', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      const ctl = device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT });
      const red = document.createElement('canvas'); red.width = red.height = 8; red.getContext('2d').fillStyle = '#f00'; red.getContext('2d').fillRect(0, 0, 8, 8);
      device.pushErrorScope('validation');
      device.queue.copyExternalImageToTexture({ source: red }, { texture: ctl }, [8, 8]);
      device.queue.drawElementImageToTexture({ source: form }, { texture: tex });
      const verr = await device.popErrorScope(); out.webgpuValidation = verr ? verr.message.slice(0, 200) : null;
      const bpr = Math.ceil(w * 4 / 256) * 256; const buf = device.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = device.createCommandEncoder(); enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [w, h]); device.queue.submit([enc.finish()]);
      await buf.mapAsync(GPUMapMode.READ); const px = new Uint8Array(buf.getMappedRange()); let n = 0; for (let y = 0; y < h; y++) for (let i = 3; i < w * 4; i += 4) n += px[y * bpr + i] ? 1 : 0;
      out.webgpu = { nonZero: n };
      const b2 = device.createBuffer({ size: 256 * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }); const e2 = device.createCommandEncoder();
      e2.copyTextureToBuffer({ texture: ctl }, { buffer: b2, bytesPerRow: 256 }, [8, 8]); device.queue.submit([e2.finish()]); await b2.mapAsync(GPUMapMode.READ); out.webgpuRaw2dRed = new Uint8Array(b2.getMappedRange())[0];
    }
  } catch (e) { out.webgpu = { error: String(e).slice(0, 200) }; }
  return out;
})()`;

export async function form(ctx) {
  const { s } = ctx; const P = '/test/fixtures/f1-water-form/index.html';
  await s.navigate(url(ctx, P, { mode: 'ref' })); await until(s, 'window.__HIC_FIXTURE && window.__HIC_FIXTURE.ready'); await sleep(OVERLAY_FADE_MS);
  const surf = await rectOf(s, '#hic-surface'); const R = {}; for (const id of ['name', 'message', 'consent']) R[id] = await rectOf(s, '#' + id);
  const ref = (await shotRect(s, surf)).img;
  await s.navigate(url(ctx, P, { mode: 'poly', bundle: ctx.bundle }));
  await until(s, 'window.__HIC_FIXTURE && (window.__HIC_FIXTURE.ready || window.__HIC_FIXTURE.fatal)', 15000).catch(() => null); await sleep(800);
  await mode(ctx, 'form');
  const rest = await readCanvas(s, '#hic-surface');
  judge(ctx, 'formRest', oracle(rest, ref));
  const k = rest.width / surf.width;
  await s.click(center(R.name).x, center(R.name).y); await sleep(200);
  ctx.check('form: a click on the drawn name field focuses it', (await s.evaluate('document.activeElement && document.activeElement.id')) === 'name', null, 'hit');
  await s.typeText('Ada Lovelace', { intervalMs: 50 });
  await s.click(center(R.message).x, center(R.message).y); await sleep(150);
  await s.typeText('hi there', { intervalMs: 50 });
  const before = await s.evaluate('document.getElementById("consent").checked');
  await s.click(center(R.consent).x, center(R.consent).y); await sleep(700);
  const v = await s.evaluate('({ name: document.getElementById("name").value, message: document.getElementById("message").value, consent: document.getElementById("consent").checked })');
  ctx.numbers.formValues = v;
  ctx.check('form: typed values reach the live fields exactly (no doubled insertion)', v.name.endsWith('Ada Lovelace') && !v.name.includes('AAda') && v.message.endsWith('hi there') && !/hhi|tthere/.test(v.message), v, 'typing');
  ctx.check('form: a click on the drawn checkbox toggles it', v.consent !== before, { before, after: v.consent }, 'hit');
  const after = await readCanvas(s, '#hic-surface');
  const ch = regionChanged(rest, after, devRect(R.name, surf, k, 2));
  ctx.check('form: typing changes the canvas pixels of the name field', ch > 8, { countOver16: ch }, 'typing');
  await noErrors(ctx, 'form');
}

export async function resize(ctx) {
  const { s } = ctx; const P = '/test/fixtures/f3-resize/index.html';
  const shotRef = async () => { await s.navigate(url(ctx, P, { mode: 'ref' })); await until(s, 'window.__HIC_FIXTURE && window.__HIC_FIXTURE.ready'); await sleep(OVERLAY_FADE_MS); const r = await rectOf(s, '#hic-surface'); return { r, img: (await shotRect(s, r)).img, go: await rectOf(s, '.card button') }; };
  await s.setWindowSize(1400, 900); await sleep(400);
  const wide = await shotRef();
  await s.navigate(url(ctx, P, { mode: 'poly', bundle: ctx.bundle }));
  await until(s, 'window.__HIC_FIXTURE && (window.__HIC_FIXTURE.ready || window.__HIC_FIXTURE.fatal)', 15000).catch(() => null); await sleep(800);
  await mode(ctx, 'resize');
  judge(ctx, 'resize1400', oracle(await readCanvas(s, '#hic-surface'), wide.img));
  await s.evaluate(BLANK_START('#hic-surface'));
  const t0 = Date.now();
  for (let i = 1; i <= 12; i++) { await s.setWindowSize(Math.round(1400 - (600 * i) / 12), 900); await sleep(30); }
  const dragMs = Date.now() - t0;
  await sleep(900);
  const blank = await s.evaluate(BLANK_STOP);
  ctx.numbers.resizeDrag = { steps: 12, dragMs, ...blank };
  ctx.check('resize: zero blank canvas frames during and after a 12-step window drag 1400 -> 800 px', blank.seenNonBlank && blank.blank === 0 && blank.frames > 10, ctx.numbers.resizeDrag, 'blank');
  const backing = await s.evaluate('(() => { const c = document.getElementById("hic-surface"); const r = c.getBoundingClientRect(); return { w: c.width, h: c.height, cssW: r.width, dpr: devicePixelRatio }; })()');
  ctx.check('resize: the backing store follows the device-pixel content box', Math.abs(backing.w - Math.round(backing.cssW * backing.dpr)) <= 1, backing, 'surface');
  const narrowPoly = await readCanvas(s, '#hic-surface');
  const narrow = await shotRef();
  judge(ctx, 'resize800', oracle(narrowPoly, narrow.img));
  await s.navigate(url(ctx, P, { mode: 'poly', bundle: ctx.bundle }));
  await until(s, 'window.__HIC_FIXTURE && (window.__HIC_FIXTURE.ready || window.__HIC_FIXTURE.fatal)', 15000).catch(() => null); await sleep(600);
  await s.setWindowSize(1100, 900); await sleep(80); await s.setWindowSize(800, 900); await sleep(120);
  await s.evaluate('(() => { window.__goClicks = 0; document.querySelector(".card button").addEventListener("click", () => window.__goClicks++); return true; })()');
  await s.click(center(narrow.go).x, center(narrow.go).y); await sleep(150);
  const clicks = await s.evaluate('window.__goClicks');
  ctx.check('resize: a click ~120 ms after the last resize lands on the drawn button (first card action)', clicks === 1, { clicks, at: center(narrow.go) }, 'hit');
  await noErrors(ctx, 'resize');
  await s.setWindowSize(1200, 900);
}

export async function scroll(ctx) {
  const { s } = ctx; const P = '/test/fixtures/f2-scroll/index.html';
  await s.navigate(url(ctx, P, { mode: 'poly', bundle: ctx.bundle }));
  await until(s, 'window.__HIC_FIXTURE && (window.__HIC_FIXTURE.ready || window.__HIC_FIXTURE.fatal)', 15000).catch(() => null); await sleep(800);
  await mode(ctx, 'scroll');
  const list = await rectOf(s, '#list'); const surf = await rectOf(s, '#hic-surface');
  const results = [];
  for (const target of [300, 900]) {
    for (let i = 0; i < 8; i++) {
      const top = await s.evaluate('document.getElementById("list").scrollTop');
      if (top >= target) break;
      await s.wheel(center(list).x, center(list).y, 0, Math.min(150, target - top)); await sleep(120);
    }
    await sleep(900);
    const st = await s.evaluate('({ list: document.getElementById("list").scrollTop, page: scrollY })');
    const poly = await readCanvas(s, '#hic-surface');
    results.push({ target, st, poly });
  }
  ctx.numbers.scrollTops = results.map((r) => r.st);
  ctx.check('scroll: a trusted wheel over the drawn list scrolls the live list (scrollTop moves, page does not)', results[1].st.list >= 600 && results[1].st.page === 0, ctx.numbers.scrollTops, 'scroll');
  await noErrors(ctx, 'scroll');
  await s.navigate(url(ctx, P, { mode: 'ref' })); await until(s, 'window.__HIC_FIXTURE && window.__HIC_FIXTURE.ready');
  for (const r of results) {
    await s.evaluate(`document.getElementById("list").scrollTop = ${r.st.list}`); await sleep(OVERLAY_FADE_MS);
    const ref = (await shotRect(s, surf)).img;
    judge(ctx, `scroll${r.target}`, oracle(r.poly, ref));
  }
}

/**
 * Mutants of the readable core for the scrollCompose control (an anchor that drifted fails loudly). grid: the planner vouches for content whose painting a clip edge
 * changes (the rounded badges are composed, and a page edge or the scrollport cuts their corners at other rows than in the settled tile). refusal: the 1x rule is
 * dropped, so a page at another devicePixelRatio is composed too.
 */
const GECKO_COMPOSE_MUTANTS = {
  grid: [['function clipInvariant(cs) {', 'function clipInvariant(cs) {\n    return true;'], ['GECKO_UNVERIFIED.has(el.localName) ||', '']],
  refusal: [['if (gecko && win.devicePixelRatio !== 1) return null;', '']],
};

/**
 * The scroll compositor on Gecko (Firefox): at a devicePixelRatio of 1 (with overlay scrollbars; classic ones are refused and the scenario reports n/a), both lists of the composed-scrolling fixture with square badges are
 * composed, and every composed frame equals the tile the snapshot settles on at that offset (outside the rounded port's corners: no pixel over 16; on its antialiased
 * arc: the G-mobile criterion). With rounded badges (the default fixture) nothing is composed: Gecko paints a corner differently once a clip edge crosses it. At another
 * ratio nothing is composed at all. The control serves mutant cores (GECKO_COMPOSE_MUTANTS) instead of sabotaging the page.
 * Desktop Safari composes on its own grid: G-mobile scrollCompose covers WebKit.
 */
export async function scrollCompose(ctx) {
  const { s } = ctx;
  if (s.engine !== 'firefox') { ctx.check('scrollCompose: Gecko only (WebKit: G-mobile scrollCompose; Chromium: G-scroll-cadence)', true, null, 'n/a'); return; }
  const sels = ['#round', '#square'];
  const offsets = [100, 131, 400, 437, 800, 851, 20, 61, 1203, 1170];
  const run = async (bundle, badges, tag) => {
    const u = new URL('/test/fixtures/mobile/scroll-compose.html', ctx.srv.url);
    u.searchParams.set('iso', '0'); u.searchParams.set('mode', 'poly'); u.searchParams.set('bundle', bundle);
    if (badges) u.searchParams.set('badges', badges);
    await s.navigate(u.href);
    await until(s, 'window.__HIC_FIXTURE && (window.__HIC_FIXTURE.ready || window.__HIC_FIXTURE.fatal)', 20000).catch(() => null);
    await sleep(1500);
    // one scroller per call: a WebDriver session's script timeout is 30 s, and one scroller's 10 jumps take about 15
    const parts = [];
    for (const sel of sels) parts.push(await s.evaluate(COMPOSE_ORACLE([sel], offsets), { timeoutMs: 60000 }));
    const r = { ...parts[parts.length - 1], jumps: parts.flatMap((p) => p.jumps) };
    ctx.numbers[`scrollCompose${tag}`] = { ...r, jumps: r.jumps.map((j) => ({ sel: j.sel, t: j.t, live: j.live, composed: j.composed, grid: j.grid, offArc: j.offArc, onArc: j.onArc })) };
    return r;
  };
  const gutter = (await s.evaluate(SCROLLBAR_PROBE_EXPR).catch(() => null))?.verticalGutterPx ?? null;
  const dpr = await s.evaluate('devicePixelRatio');
  const composable = dpr === 1 && gutter === 0;
  ctx.numbers.scrollComposeEnv = { dpr, gutter, composable };
  // classic bars are refused on Gecko whatever the ratio (the composed bar has Chromium's thumb geometry): nothing a mutant of the composition could turn red
  if (gutter !== 0) { ctx.check(`scrollCompose: classic scrollbars (gutter ${gutter} css px): Gecko composes no scroller with a classic bar, nothing to measure`, true, { dpr, gutter }, 'n/a'); return; }
  const painted = (r) => r.jumps.every((j) => j.painted !== false && j.ink > 0.5);
  /** @param {any} r @param {string} label */
  const judgeExact = (r, label) => {
    const composed = r.jumps.filter((j) => j.composed);
    const bad = composed.filter((j) => j.grid > 0);
    const badArc = composed.filter((j) => j.offArc > 0 || j.onArc > 0.02 * j.arcPixels);
    ctx.check(`scrollCompose ${label}: every composed frame equals the settled tile at its offset (outside the rounded corners: no pixel over 16)`, composed.length > 0 && bad.length === 0, bad.slice(0, 4), 'grid');
    ctx.check(`scrollCompose ${label}: in the rounded corners no pixel over 16 off the antialiased arc, at most 2 % of the arc`, composed.length > 0 && badArc.length === 0, badArc.slice(0, 4), 'corner');
  };
  /** @param {any} r @param {string} label */
  const judgeRefused = (r, label) => ctx.check(`scrollCompose ${label}: nothing composed (every jump painted by a build), the canvas non-blank`,
    r.jumps.every((j) => !j.composed) && painted(r), { composed: r.jumps.filter((j) => j.composed).length, scroll: r.scroll }, 'refusal');
  if (!ctx.control) {
    const sq = await run(ctx.bundle, 'square', 'Square');
    if (composable) {
      const per = sels.map((sel) => sq.jumps.filter((j) => j.sel === sel && j.composed).length);
      ctx.check(`scrollCompose square badges, DPR 1, overlay bars: each scroller composed at least 3 of its ${offsets.length} jumps (composed: ${per.join(' / ')}), every jump painted, the canvas non-blank`,
        per.every((n) => n >= 3) && painted(sq), { per, scroll: sq.scroll }, 'surface');
      judgeExact(sq, 'square badges');
      judgeRefused(await run(ctx.bundle, null, 'Rounded'), 'rounded badges (a clip edge changes how Gecko paints a corner)');
    } else judgeRefused(sq, `square badges at DPR ${dpr} (Gecko composes only at DPR 1: its SVG images lay out with 1x font metrics and borders)`);
    await noErrors(ctx, 'scrollCompose');
    return;
  }
  const core = '/dist/hic-live-polyfill.iife.js';
  if (!ctx.bundle.split(',').includes(core) || !ctx.files) throw new Error(`scrollCompose control: the bundle list has no ${core} to replace, or the server serves no mutants`);
  const text = readFileSync(ctx.coreFile ?? resolve(PROJECT_ROOT, 'dist/hic-live-polyfill.iife.js'), 'utf8');
  const dir = resolve(PROJECT_ROOT, '.scratch/xbrowser-mutants');
  mkdirSync(dir, { recursive: true });
  for (const [cls, edits] of Object.entries(GECKO_COMPOSE_MUTANTS)) {
    const m = buildMutant(text, { edits });
    if ('drift' in m) throw new Error(`scrollCompose control: mutant ${cls}: ${m.drift}`);
    const file = resolve(dir, `core-${cls}.js`);
    writeFileSync(file, m.text);
    const path = `/__mutant/core-${cls}.js`;
    ctx.files[path] = file;
    const bundle = ctx.bundle.split(',').map((b) => (b === core ? path : b)).join(',');
    if (cls === 'grid') {
      if (!composable) continue;
      const r = await run(bundle, null, 'MutantGrid');
      judgeExact(r, '(mutant grid: rounded badges composed)');
      judgeRefused(r, '(mutant grid)');
    } else if (!composable) judgeRefused(await run(bundle, 'square', 'MutantRefusal'), '(mutant refusal: composed at another ratio)');
  }
}

export async function unsupported(ctx) {
  const { s } = ctx;
  const kind = ctx.control ? 'supported' : 'iframe';
  await s.navigate(new URL(`/test/fixtures/unsupported/index.html?iso=0&case=${kind}&bundle=${encodeURIComponent(ctx.bundle)}`, ctx.srv.url).href);
  await until(s, '(window.__paints || 0) >= 1', 10000).catch(() => null); await sleep(900);
  const rep = await s.evaluate('window.__HIC__ && window.__HIC__.installed ? window.__HIC__.installed.report().unsupported.map((u) => [u.feature, u.count]) : null');
  const ev = await s.evaluate('window.__events');
  const logs = (await pageErrors(s)).filter((e) => e.k === 'error' && /hic-live-polyfill/.test(e.m) && e.m.includes('iframe'));
  ctx.numbers.unsupported = { report: rep, events: ev, consoleErrors: logs.length };
  ctx.check('unsupported: an iframe child is reported (report entry, one console.error, hicunsupported event)', !!rep?.some(([f]) => f === 'iframe') && logs.length === 1 && ev?.includes('iframe'), ctx.numbers.unsupported, 'report');
  const canvasImg = await readCanvas(s, '#c');
  ctx.check('unsupported: the canvas still paints (placeholder + supported UI)', pixelStats(canvasImg).nonBlank, null, 'content');
  const r = await rectOf(s, '#name');
  await s.click(center(r).x, center(r).y); await sleep(150); await s.typeText('Z'); await sleep(500);
  ctx.check('unsupported: the sibling input still takes typing', (await s.evaluate('document.getElementById("name").value')) === 'abcZ', null, 'content');
}

export async function uninstall(ctx) {
  const { s } = ctx;
  await s.navigate(new URL(`/test/fixtures/identity/index.html?bundle=${encodeURIComponent(ctx.bundle)}`, ctx.srv.url).href);
  await until(s, 'typeof HicLivePolyfill === "object" && document.readyState === "complete"');
  const IDX = IDENTITY_EXPR.replace("['Reflect', Reflect]", "['Reflect', window.Reflect]");
  const before = await s.evaluate(IDX, { timeoutMs: 60000 });
  // members that return a NEW object on every read with no install at all (Safari 27: PerformanceObserver.supportedEntryTypes, PushManager.supportedContentEncodings) are not identity
  const volatile = new Set(diffIdentity(before, await s.evaluate(IDX, { timeoutMs: 60000 })).map((d) => d.where));
  const real = (list) => list.filter((d) => !volatile.has(d.where));
  const m = await s.evaluate('window.__id.install()');
  await sleep(500);
  const during = await s.evaluate(IDX, { timeoutMs: 60000 });
  await s.evaluate('window.__id.uninstall()');
  if (ctx.control) await s.evaluate('HTMLCanvasElement.prototype.__xbLeak = 1');
  await sleep(300);
  const after = await s.evaluate(IDX, { timeoutMs: 60000 });
  const changed = real(diffIdentity(before, during)).length; const left = real(diffIdentity(before, after));
  ctx.numbers.uninstall = { mode: m, changedByInstall: changed, leftAfterUninstall: left.length, volatileIgnored: [...volatile], first: left.slice(0, 3) };
  ctx.check('uninstall: install patches the platform, uninstall restores every descriptor and the DOM exactly', m === 'polyfill' && changed > 10 && left.length === 0, ctx.numbers.uninstall, 'identity');
}

/** Raw foreignObject decode cost of an F1-sized snapshot in this engine (informative, not asserted). */
export async function decodeTiming(ctx) {
  const { s } = ctx;
  await s.navigate(url(ctx, '/test/fixtures/f1-water-form/index.html', { mode: 'ref' })); await until(s, 'window.__HIC_FIXTURE && window.__HIC_FIXTURE.ready');
  ctx.check('decode: measured (informative)', true, null, 'info');
  ctx.numbers.decode = await s.evaluate(`(async () => {
    const el = document.getElementById('demo-form'); const r = el.getBoundingClientRect(); const css = [...document.styleSheets].map((sh) => { try { return [...sh.cssRules].map((x) => x.cssText).join(''); } catch { return ''; } }).join('');
    const xml = new XMLSerializer().serializeToString(el);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + Math.ceil(r.width) + '" height="' + Math.ceil(r.height) + '"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml"><style>' + css.replace(/[<&]/g, ' ') + '</style>' + xml + '</div></foreignObject></svg>';
    const c = document.createElement('canvas'); c.width = Math.ceil(r.width * 2); c.height = Math.ceil(r.height * 2); const x = c.getContext('2d');
    const ms = [];
    for (let i = 0; i < 15; i++) { const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace('</div></foreignObject>', '<!--' + i + '--></div></foreignObject>')); const t0 = performance.now(); await img.decode(); x.drawImage(img, 0, 0, c.width, c.height); ms.push(performance.now() - t0); }
    ms.sort((a, b) => a - b); return { bytes: svg.length, p50: +ms[7].toFixed(1), p95: +ms[14].toFixed(1), min: +ms[0].toFixed(1) };
  })()`, { timeoutMs: 60000 });
}


/** Pixels with a channel delta > tol OUTSIDE `ex` (device px rect), and the image size; a, b same size. */
function outsideDiff(a, b, ex, tol = 16) {
  if (a.width !== b.width || a.height !== b.height) return { count: -1, fraction: 1 };
  let n = 0;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    if (x >= ex.x && x < ex.x + ex.w && y >= ex.y && y < ex.y + ex.h) continue;
    const i = (y * a.width + x) * 4;
    if (Math.abs(a.data[i] - b.data[i]) > tol || Math.abs(a.data[i + 1] - b.data[i + 1]) > tol || Math.abs(a.data[i + 2] - b.data[i + 2]) > tol) n++;
  }
  return { count: n, fraction: n / (a.width * a.height) };
}
/** Copy the `ex` rect of `from` into a copy of `img` (the clicked control is judged by the caret check, not by the twin). */
function patched(img, from, ex) {
  const out = { width: img.width, height: img.height, data: Uint8Array.from(img.data) };
  for (let y = Math.max(0, ex.y); y < Math.min(img.height, ex.y + ex.h); y++) for (let x = Math.max(0, ex.x); x < Math.min(img.width, ex.x + ex.w); x++) {
    const i = (y * img.width + x) * 4; for (let k = 0; k < 4; k++) out.data[i + k] = from.data[i + k];
  }
  return out;
}
const hashRegion = (img, r) => { const c = cropImage(img, r.x, r.y, r.w, r.h).data; let h = 0; for (let k = 0; k < c.length; k += 4) h = (h * 31 + c[k] + 3 * c[k + 1] + 7 * c[k + 2]) | 0; return h; };

/**
 * A CLICK into a drawn text field must change nothing outside that field (a reported regression, Safari 27: pieces of the page appeared at the wrong place after a click:
 * WebKit ignored the viewBox origin of damage-cropped tiles), and a type=email field must show a blinking caret (a reported regression, Chrome: no caret, selectionStart is null).
 * Run with the WebGPU water effect ON (intensity 0: the effect output is the source) and on the 2D path. Judged from viewport screenshots (a WebGPU canvas cannot be read back),
 * against the pre-click surface outside the clicked field (+8 css px for the focus ring) and (2D path) against the plain-DOM twin with the field patched out.
 * Control: a misplaced piece is injected after the click (the title moved by 40,30 px) and the drawn children ignore the pointer.
 */
export async function clickEffect(ctx) {
  const { s } = ctx; const P = '/test/fixtures/f1-water-form/index.html';
  await s.navigate(url(ctx, P, { mode: 'ref' })); await until(s, 'window.__HIC_FIXTURE && window.__HIC_FIXTURE.ready'); await sleep(OVERLAY_FADE_MS);
  const surf = await rectOf(s, '#hic-surface'); const em = await rectOf(s, '#email');
  const ref = (await shotRect(s, surf)).img;
  const bundles = [ctx.bundle, '/dist/hic-live-effects.iife.js', '/dist/plugins/water.iife.js'].join(',');
  for (const variant of ['effect', '2d']) {
    const params = variant === 'effect' ? { mode: 'poly', bundle: bundles, painter: 'none' } : { mode: 'poly', bundle: ctx.bundle };
    await s.navigate(url(ctx, P, params));
    await until(s, 'window.__HIC_FIXTURE && (window.__HIC_FIXTURE.ready || window.__HIC_FIXTURE.fatal)', 15000).catch(() => null);
    if (variant === 'effect') {
      ctx.numbers.clickEffectHost = await s.evaluate(`(async () => { try {
        await new Promise((ok) => { const t = setInterval(() => { if (window.HTMLInCanvasEffects && window.HicLivePlugins && window.HicLivePlugins.water) { clearInterval(t); ok(); } }, 50); setTimeout(ok, 8000); });
        const host = await HTMLInCanvasEffects.createHost(document.querySelector('#hic-surface'), document.querySelector('#demo-form'), { maxDpr: 2.5, interposer: true });
        await host.addPlugin(HicLivePlugins.water.plugin, { intensity: 0 }); return 'webgpu'; } catch (e) { return 'error: ' + e.message; } })()`, { timeoutMs: 20000 });
      ctx.check('clickEffect: the WebGPU water host runs over the form', ctx.numbers.clickEffectHost === 'webgpu', { host: ctx.numbers.clickEffectHost }, 'surface');
    }
    await sleep(1200);
    await s.move(surf.x + surf.width - 4, surf.y + surf.height - 4); await sleep(400);
    const k = (await shotRect(s, surf)).scale; const ex = devRect(em, surf, k, Math.ceil(8 * k));
    const pre = (await shotRect(s, surf)).img;
    await s.click(em.x + em.width * 0.45, em.y + em.height / 2);
    if (ctx.control) await s.evaluate('(() => { const h = document.querySelector("#demo-form h1, #demo-form h2, #demo-form .lede"); if (h) h.style.transform = "translate(40px, 30px)"; return !!h; })()');
    await s.move(surf.x + surf.width - 4, surf.y + surf.height - 4); await sleep(1500);
    const focus = await s.evaluate('document.activeElement && document.activeElement.id');
    ctx.check(`clickEffect[${variant}]: a trusted click at the drawn email field focuses it`, focus === 'email', { focus }, 'hit');
    const shots = [];
    for (let i = 0; i < 6; i++) { shots.push((await shotRect(s, surf)).img); await sleep(230); }
    const post = shots[0];
    const out = outsideDiff(pre, post, ex);
    ctx.numbers[`clickEffect_${variant}_outside`] = out;
    // WebKit (Playwright 26.5) before the fix: 4.3 % (2D) and 10.0 % (effect); after: 0.26-0.29 %, the same as two shots with NO click (page settling, sub-pixel text edges)
    const clean = out.count >= 0 && out.fraction <= 0.005;
    ctx.check(`clickEffect[${variant}]: the click changes nothing outside the clicked field (<= 0.5 % of pixels over 16: misplaced tiles, misplaced focus ring)`, clean, out, 'misplaced');
    if (!clean) { ctx.save(`clickEffect-${variant}.pre`, pre); ctx.save(`clickEffect-${variant}.post`, post); }
    // the water shader tints the whole frame even at intensity 0 (measured 8.9 % vs the twin in Firefox): the effect variant is judged against its own pre-click frame only
    if (variant === '2d') judge(ctx, `clickEffect_${variant}_twin`, oracle(post.width === ref.width && post.height === ref.height ? patched(post, ref, ex) : post, ref), 'misplaced');
    const states = new Set(shots.map((im) => hashRegion(im, devRect(em, surf, k, -Math.ceil(3 * k)))));
    ctx.numbers[`clickEffect_${variant}_caretStates`] = states.size;
    ctx.check(`clickEffect[${variant}]: the focused type=email field shows a blinking caret (>= 2 states over 1.4 s)`, states.size >= 2, { distinct: states.size }, 'caret');
    await s.evaluate('document.activeElement && document.activeElement.blur()');
  }
  await noErrors(ctx, 'clickEffect');
}

/**
 * Form controls: every control of f6-controls (light, dark, accent-color, disabled, indeterminate, classic scroller bars) judged in its OWN region against the plain-DOM
 * twin in the same engine (WebKit draws controls in an SVG image in the legacy look and ignores accent-color; Gecko draws none or a CSS fallback: the clone paints them).
 * Per control: shift-tolerant <= 15 % at delta > 16 (glyph edges of the engine's image text in small text-dense regions: Firefox date fields 9-13 %) and <= 1.5 % at delta > 100 (the legacy look measured
 * 1.6-22 % over 100 on every control whose look differs). Control: the live controls get a red accent and a
 * 6 px border after the capture page loads, so their regions must differ from the twin.
 */
export async function controls(ctx) {
  const { s } = ctx; const P = '/test/fixtures/f6-controls/index.html';
  const RECTS = `[...document.querySelectorAll('[data-ctl]')].map((e) => { const r = e.getBoundingClientRect(); return { id: e.dataset.ctl, x: r.left, y: r.top, width: r.width, height: r.height }; })`;
  await s.navigate(url(ctx, P, { mode: 'ref' })); await until(s, 'window.__HIC_FIXTURE && window.__HIC_FIXTURE.ready'); await sleep(OVERLAY_FADE_MS);
  const surf = await rectOf(s, '#hic-surface'); const rects = await s.evaluate(RECTS);
  const ref = (await shotRect(s, surf)).img;
  await s.navigate(url(ctx, P, { mode: 'poly', bundle: ctx.bundle }));
  await until(s, 'window.__HIC_FIXTURE && (window.__HIC_FIXTURE.ready || window.__HIC_FIXTURE.fatal)', 15000).catch(() => null);
  if (ctx.control) await s.evaluate(`(() => { const st = document.createElement('style'); st.textContent = '[data-ctl] > *, [data-ctl].sc { accent-color: #f00 !important; outline: 6px solid #f0f !important; }'; document.head.appendChild(st); for (const e of document.querySelectorAll('[data-ctl] > *')) e.value = e.value; return true; })()`);
  await sleep(1200);
  await mode(ctx, 'controls');
  const poly = await readCanvas(s, '#hic-surface');
  const k = poly.width / surf.width;
  const bad = []; const per = {};
  for (const r of rects) {
    const d = devRect(r, surf, k, 2);
    const o = oracle(cropImage(poly, d.x, d.y, d.w, d.h), cropImage(ref, d.x, d.y, d.w, d.h), { maxFraction: 0.15, maxStructural: 0.015 });
    per[r.id] = [+(o.shiftTolerant * 100).toFixed(2), +(o.structural * 100).toFixed(2)];
    const ok = o.sizeMatch && o.shiftTolerant <= 0.15 && o.structural <= 0.015;
    if (!ok) bad.push(r.id);
    if (!ok || process.env.XB_SAVE_REGIONS) { ctx.save(`controls-${r.id}.surface`, cropImage(poly, d.x, d.y, d.w, d.h)); ctx.save(`controls-${r.id}.ref`, cropImage(ref, d.x, d.y, d.w, d.h)); }
  }
  ctx.numbers.controls = per;
  ctx.check(`controls: each of ${rects.length} control regions matches the plain-DOM twin (<= 15 % over 16, <= 1.5 % over 100, +-1 device row)`, bad.length === 0 && rects.length > 50, { bad }, 'control-look');
  judge(ctx, 'controlsRest', oracle(poly, ref));
  await noErrors(ctx, 'controls');
}

const F6 = '/test/fixtures/f6-controls/index.html';
const F6_RECTS = `[...document.querySelectorAll('[data-ctl]')].map((e) => { const r = e.getBoundingClientRect(); return { id: e.dataset.ctl, x: r.left, y: r.top, width: r.width, height: r.height }; })`;

/** A poly page for a TARGETED positive control: no blanket sabotage; in the control run the listed events never reach the page (RECORDER xbblock). */
function controlUrl(ctx, path, params, block) {
  const u = new URL(path, ctx.srv.url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  if (ctx.control && block) u.searchParams.set('xbblock', block);
  return u.href;
}

/** One f6 region of the canvas vs the same region of the twin, with the controls thresholds; failures (or every crop with XB_SAVE_REGIONS) saved. */
function regionVerdict(ctx, label, poly, ref, d) {
  const o = oracle(cropImage(poly, d.x, d.y, d.w, d.h), cropImage(ref, d.x, d.y, d.w, d.h), { maxFraction: 0.15, maxStructural: 0.015 });
  const ok = o.sizeMatch && o.shiftTolerant <= 0.15 && o.structural <= 0.015;
  if (!ok || process.env.XB_SAVE_REGIONS) { ctx.save(`${label}.surface`, cropImage(poly, d.x, d.y, d.w, d.h)); ctx.save(`${label}.ref`, cropImage(ref, d.x, d.y, d.w, d.h)); }
  return { ok, n: [+(o.shiftTolerant * 100).toFixed(2), +(o.structural * 100).toFixed(2)] };
}

const ptr = (actions) => [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions }];
const mv = (p) => ({ type: 'pointerMove', duration: 0, origin: 'viewport', x: Math.round(p.x), y: Math.round(p.y) });

/**
 * The interaction states of the f6 controls, per region vs the twin driven by the SAME trusted input: hover (pointer over the control), pressed (button held down, read while
 * held, released away from the control so nothing toggles) and focus (a click into a text field). Firefox draws hover/pressed in its widget colours (measured live);
 * Safari draws its pressed look. Control: the pointer/focus events never reach the polyfill (xbblock), so the snapshot keeps the idle look while the live control changes.
 */
const STATES = { 'L-btn': ['hover', 'press'], 'L-cb-off': ['hover', 'press'], 'L-cb-on': ['hover', 'press'], 'L-rd-off': ['hover', 'press'], 'L-rg': ['hover', 'press'], 'L-sel': ['hover'],
  'L-submit': ['hover', 'press'], 'L-color': ['hover'], 'L-txt': ['hover', 'focus'], 'L-lb': ['hover'], 'D-btn': ['hover', 'press'], 'D-cb-on': ['hover', 'press'], 'D-rg': ['hover', 'press'],
  'D-sel': ['hover'], 'D-txt': ['hover', 'focus'], 'LA-cb-on': ['hover', 'press'], 'LA-rg': ['hover', 'press'] };
export async function interaction(ctx) {
  const { s } = ctx;
  const BLOCK = 'pointerover,pointerout,pointerenter,pointerleave,mouseover,mouseout,pointerdown,mousedown,pointerup,mouseup,focusin,focusout,focus,blur';
  const drive = async (rect, origin, st, read) => {
    const c = { x: origin.x + rect.x + rect.width / 2, y: origin.y + rect.y + rect.height / 2 }, away = { x: origin.x + 500, y: origin.y + 735 };
    await s.actions(ptr([mv(away)])); await sleep(250);
    if (st === 'hover') { await s.actions(ptr([mv(c)])); await sleep(400); return read(); }
    if (st === 'focus') { await s.click(c.x, c.y); await sleep(400); const img = await read(); await s.evaluate('document.activeElement && document.activeElement.blur(), true'); return img; }
    await s.cmd('POST', '/actions', { actions: ptr([mv(c), { type: 'pointerDown', button: 0 }, { type: 'pause', duration: 50 }]) }); await sleep(400);
    const img = await read();
    await s.cmd('POST', '/actions', { actions: ptr([mv(away), { type: 'pointerUp', button: 0 }]) }); await s.cmd('DELETE', '/actions');
    return img;
  };
  await s.navigate(url(ctx, F6, { mode: 'ref' })); await until(s, 'window.__HIC_FIXTURE && window.__HIC_FIXTURE.ready'); await sleep(OVERLAY_FADE_MS);
  const surf = await rectOf(s, '#hic-surface');
  const rects = (await s.evaluate(F6_RECTS)).filter((r) => STATES[r.id]).map((r) => ({ ...r, x: r.x - surf.x, y: r.y - surf.y }));
  const refs = {};
  for (const r of rects) for (const st of STATES[r.id]) refs[`${r.id}:${st}`] = await drive(r, surf, st, async () => (await shotRect(s, surf)).img);
  await s.navigate(controlUrl(ctx, F6, { mode: 'poly', bundle: ctx.bundle }, BLOCK));
  await until(s, 'window.__HIC_FIXTURE && (window.__HIC_FIXTURE.ready || window.__HIC_FIXTURE.fatal)', 15000).catch(() => null); await sleep(1200);
  await mode(ctx, 'interaction');
  const psurf = await rectOf(s, '#hic-surface');
  const bad = []; const per = {};
  let k = 0;
  for (const r of rects) for (const st of STATES[r.id]) {
    const poly = await drive(r, psurf, st, () => readCanvas(s, '#hic-surface'));
    k = poly.width / surf.width;
    const v = regionVerdict(ctx, `interaction-${r.id}-${st}`, poly, refs[`${r.id}:${st}`], devRect({ ...r, x: r.x + surf.x, y: r.y + surf.y }, surf, k, 2));
    per[`${r.id}:${st}`] = v.n;
    if (!v.ok) bad.push(`${r.id}:${st}`);
  }
  ctx.numbers.interaction = per;
  ctx.check(`interaction: ${Object.keys(per).length} hover / pressed / focus states match the twin under the same trusted input (<= 15 % over 16, <= 1.5 % over 100 per region)`, bad.length === 0 && Object.keys(per).length > 25, { bad }, 'interaction-look');
  await noErrors(ctx, 'interaction');
}

/**
 * The window loses activation (a popup window of the same browser becomes key; the test window stays visible): macOS WebKit draws its controls in the inactive look, and the
 * snapshot must follow (window blur/focus); when the window is key again the active look comes back. Every f6 region vs the twin in the same window state.
 * Control: blur/focus never reach the polyfill (xbblock), so the snapshot keeps the active look (Safari); Firefox has no inactive look, so its control also gives the live
 * controls a red accent once the window is inactive.
 */
export async function inactive(ctx) {
  const { s } = ctx;
  const OPEN = `(() => { const b = document.createElement('button'); b.id = 'xb-pop'; b.textContent = 'popup'; b.style.cssText = 'position:fixed;right:4px;bottom:4px;z-index:99';
    b.onclick = () => { window.__xbPop = window.open('about:blank', 'xbpop', 'popup,width=320,height=240,left=40,top=40'); }; document.body.appendChild(b); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`;
  const deactivate = async () => {
    const at = await s.evaluate(OPEN); await s.click(at.x, at.y);
    for (let i = 0; i < 30 && (await s.evaluate('document.hasFocus()')); i++) await sleep(100);
    await sleep(700);
    return !(await s.evaluate('document.hasFocus()'));
  };
  const reactivate = async (h) => {
    await s.evaluate('window.__xbPop && window.__xbPop.close(), true'); await sleep(300);
    try { await s.cmd('POST', '/window', { handle: h }); } catch { /* single window */ }
    for (let i = 0; i < 30 && !(await s.evaluate('document.hasFocus()')); i++) await sleep(100);
    await sleep(900);
  };
  const handle = await s.cmd('GET', '/window');
  await s.navigate(url(ctx, F6, { mode: 'ref' })); await until(s, 'window.__HIC_FIXTURE && window.__HIC_FIXTURE.ready'); await sleep(OVERLAY_FADE_MS);
  const surf = await rectOf(s, '#hic-surface'); const rects = await s.evaluate(F6_RECTS);
  const refActive = (await shotRect(s, surf)).img;
  const refInactiveOk = await deactivate();
  const refInactive = (await shotRect(s, surf)).img;
  await reactivate(handle);
  await s.navigate(controlUrl(ctx, F6, { mode: 'poly', bundle: ctx.bundle }, 'focus,blur'));
  await until(s, 'window.__HIC_FIXTURE && (window.__HIC_FIXTURE.ready || window.__HIC_FIXTURE.fatal)', 15000).catch(() => null); await sleep(1200);
  await mode(ctx, 'inactive');
  const polyInactiveOk = await deactivate();
  ctx.check('inactive: a popup window took the activation from the test window (document.hasFocus() false on both pages)', refInactiveOk && polyInactiveOk, { refInactiveOk, polyInactiveOk }, 'surface');
  if (ctx.control && !s.webkit) { await s.evaluate(`(() => { const st = document.createElement('style'); st.textContent = '[data-ctl] > * { accent-color: #f00 !important; outline: 6px solid #f0f !important; }'; document.head.appendChild(st); return true; })()`); await sleep(800); }
  const polyInactive = await readCanvas(s, '#hic-surface');
  await reactivate(handle);
  const polyActive = await readCanvas(s, '#hic-surface');
  const k = polyInactive.width / surf.width;
  for (const [phase, poly, ref] of [['inactive', polyInactive, refInactive], ['active', polyActive, refActive]]) {
    const bad = []; const per = {};
    for (const r of rects) { const v = regionVerdict(ctx, `inactive-${phase}-${r.id}`, poly, ref, devRect(r, surf, k, 2)); per[r.id] = v.n; if (!v.ok) bad.push(r.id); }
    ctx.numbers[`inactive_${phase}`] = per;
    ctx.check(`inactive: window ${phase === 'inactive' ? 'NOT key' : 'key again'}: each of ${rects.length} control regions matches the twin in the same window state`, bad.length === 0 && rects.length > 50, { bad }, phase === 'inactive' ? 'inactive-look' : 'control-look');
  }
  await noErrors(ctx, 'inactive');
}

/** What the engine exposes natively, read on a page WITHOUT the polyfill (the polyfill's own pure probe, src/api/native-detect.js). */
export const NATIVE_SURFACE = `import('/src/api/native-detect.js').then((m) => { const native = m.probeNative(window); const gate = m.browserGate(window);
  return { native, gate, decision: m.decideMode(native, gate, { mode: 'auto', forcePolyfill: false }) }; })`;

/** The native-flag pages load the optional bridge before the core (docs/BUNDLES.md): a legacy native build is bridged, a current one is used as found. */
const NATIVE_BUNDLE = '/dist/hic-live-native-bridge.iife.js,/dist/hic-live-polyfill.iife.js';
const nativeMode = (s) => s.evaluate('window.__HIC__ ? (window.__HIC__.error ? "error: " + window.__HIC__.error.message : window.__HIC__.installed.mode) : "no __HIC__"');
const stepsAside = (m) => m === 'native' || m === 'native-bridged';

/**
 * Native flag on (Safari Technology Preview with Debug > WebKit Internal Features > HTML-in-Canvas): install() never refuses the usable native and never throws,
 * with or without the bridge bundle; without it a legacy build is used as found (mode native, one warning, no error).
 */
export async function nativeSurface(ctx) {
  const { s } = ctx; const P = '/test/fixtures/explainer/index.html';
  ctx.numbers.nativeSurface = {};
  for (const [label, bundle, want] of [['core only', '/dist/hic-live-polyfill.iife.js', ['native']], ['bridge + core', NATIVE_BUNDLE, ['native', 'native-bridged']]]) {
    await s.navigate(url(ctx, P, { mode: 'poly', bundle })); await until(s, 'document.readyState === "complete"'); await sleep(600);
    const m = await nativeMode(s);
    const r = await s.evaluate('window.__HIC__ && window.__HIC__.installed ? { kind: window.__HIC__.installed.native.kind, probe: window.__HIC__.installed.native.probe, errors: window.__HIC__.installed.report().errors.length } : null');
    ctx.numbers.nativeSurface[label] = { mode: m, ...r };
    ctx.check(`native surface, ${label}: install steps aside without throwing (mode ${want.join(' or ')})`, want.includes(m) && r?.errors === 0, ctx.numbers.nativeSurface[label], 'surface');
    await noErrors(ctx, `native surface, ${label}`);
  }
}

/**
 * The WICG explainer example on the native implementation through the bridge: drawn natively (canvas backing store vs the plain-DOM twin, same oracle as the
 * polyfill scenarios), typing into its field repaints the canvas (the bridge requests the paints the build does not fire on its own).
 * The click is not asserted: the example draws the form 100 grid px right of its layout box and a legacy build without geometry methods keeps hit testing
 * at the layout box (docs/SUPPORT-MATRIX.md); where the drawn field is hit is recorded.
 */
export async function nativeExplainer(ctx) {
  const { s } = ctx; const P = '/test/fixtures/explainer/index.html';
  await s.navigate(url(ctx, P, { mode: 'ref' })); await until(s, 'window.__ready === true');
  const twin = await rectOf(s, '#twin'); const inputR = await rectOf(s, '#name');
  const refRest = (await shotRect(s, twin)).img;
  await s.navigate(url(ctx, P, { mode: 'poly', bundle: NATIVE_BUNDLE }));
  await until(s, '(window.__paints || 0) >= 1').catch(() => null); await sleep(800);
  const m = await nativeMode(s); ctx.numbers.nativeExplainerMode = m;
  ctx.check('native explainer: install steps aside (mode native or native-bridged)', stepsAside(m), { mode: m }, 'surface');
  const rest = await readCanvas(s, 'canvas');
  judge(ctx, 'nativeExplainerRest', oracle(rest, refRest));
  const k = rest.width / twin.width; const region = devRect(inputR, twin, k, 2);
  ctx.numbers.nativeExplainerHitAtDrawn = await s.evaluate(`(() => { const e = document.elementFromPoint(${center(inputR).x}, ${center(inputR).y}); return e && (e.id || e.localName); })()`);
  await s.evaluate('document.getElementById("name").focus()');
  if ((await s.evaluate('document.activeElement && document.activeElement.id')) === 'name') await s.typeText('hello', { intervalMs: 120 });
  await sleep(700);
  const value = await s.evaluate('document.getElementById("name").value');
  const typed = await readCanvas(s, 'canvas');
  const changed = regionChanged(rest, typed, region);
  ctx.numbers.nativeExplainerTyping = { value, countOver16: changed };
  ctx.check('native explainer: typing reaches the field once per key and the native canvas repaints its pixels', value === 'hello' && changed > 8, ctx.numbers.nativeExplainerTyping, 'typing');
  await noErrors(ctx, 'native explainer');
}

/**
 * The published contact form (examples/form) on the native implementation: it draws the form at its layout box, so a legacy build that keeps hit testing at the
 * layout box hits the drawn controls. Non-blank native pixels, trusted clicks focus and toggle the drawn controls, typing reaches the fields and repaints the
 * native canvas where the field is drawn. (The rich F1 fixture is not compared with its twin here: Safari Technology Preview 254 leaves most of it undrawn,
 * a native rendering limit recorded in docs/SUPPORT-MATRIX.md.)
 */
export async function nativeForm(ctx) {
  const { s } = ctx;
  await s.navigate(url(ctx, '/examples/form/index.html', { xbbridge: 1 }));
  await until(s, 'document.readyState === "complete"'); await sleep(1500);
  const m = await nativeMode(s); ctx.numbers.nativeFormMode = m;
  ctx.check('native form: install steps aside (mode native or native-bridged)', stepsAside(m), { mode: m }, 'surface');
  const box = await s.evaluate('(() => { const c = document.getElementById("stage"); const r = c.getBoundingClientRect(); return { x: r.left + c.clientLeft, y: r.top + c.clientTop, width: c.clientWidth, height: c.clientHeight }; })()');
  const R = {}; for (const id of ['name', 'email', 'message', 'consent']) R[id] = await rectOf(s, '#' + id);
  const rest = await readCanvas(s, '#stage');
  ctx.numbers.nativeFormRest = { nonDominant: +pixelStats(rest).nonDominantFraction.toFixed(4) };
  ctx.check('native form: the form is drawn natively (non-blank canvas)', pixelStats(rest).nonBlank, ctx.numbers.nativeFormRest, 'pixel');
  const k = rest.width / box.width;
  await s.click(center(R.name).x, center(R.name).y); await sleep(200);
  const focused = (await s.evaluate('document.activeElement && document.activeElement.id')) === 'name';
  ctx.check('native form: a trusted click on the drawn name field focuses it', focused, null, 'hit');
  if (focused) await s.typeText('Ada Lovelace', { intervalMs: 50 });
  // the textarea is not hit-testable at its layout box on Safari Technology Preview 254 (elementFromPoint answers the canvas; native, docs/SUPPORT-MATRIX.md): recorded
  ctx.numbers.nativeFormTextareaHit = await s.evaluate(`(() => { const e = document.elementFromPoint(${center(R.message).x}, ${center(R.message).y}); return e && (e.id || e.localName); })()`);
  await s.click(center(R.email).x, center(R.email).y); await sleep(150);
  if ((await s.evaluate('document.activeElement && document.activeElement.id')) === 'email') await s.typeText('ada@example.com', { intervalMs: 50 });
  const before = await s.evaluate('document.getElementById("consent").checked');
  await s.click(center(R.consent).x, center(R.consent).y); await sleep(700);
  const v = await s.evaluate('({ name: document.getElementById("name").value, email: document.getElementById("email").value, consent: document.getElementById("consent").checked })');
  ctx.numbers.nativeFormValues = v;
  ctx.check('native form: typed values reach the live fields exactly (no doubled insertion)', v.name === 'Ada Lovelace' && v.email === 'ada@example.com', v, 'typing');
  ctx.check('native form: a trusted click on the drawn checkbox toggles it', v.consent !== before, { before, after: v.consent }, 'hit');
  const after = await readCanvas(s, '#stage');
  const ch = regionChanged(rest, after, devRect(R.name, box, k, 2));
  ctx.numbers.nativeFormNameRegion = ch;
  ctx.check('native form: typing repaints the native canvas where the name field is drawn', ch > 8, { countOver16: ch }, 'typing');
  await noErrors(ctx, 'native form');
}

/** install() over the native implementation patches only through its ledger: uninstall restores every descriptor and the DOM (the mirrored layoutsubtree included). */
export async function nativeUninstall(ctx) {
  const { s } = ctx;
  await s.navigate(new URL(`/test/fixtures/identity/index.html?bundle=${encodeURIComponent(NATIVE_BUNDLE)}`, ctx.srv.url).href);
  await until(s, 'typeof HicLivePolyfill === "object" && document.readyState === "complete"');
  const IDX = IDENTITY_EXPR.replace("['Reflect', Reflect]", "['Reflect', window.Reflect]");
  const before = await s.evaluate(IDX, { timeoutMs: 60000 });
  const volatile = new Set(diffIdentity(before, await s.evaluate(IDX, { timeoutMs: 60000 })).map((d) => d.where));
  const real = (list) => list.filter((d) => !volatile.has(d.where));
  const m = await s.evaluate('window.__id.install()');
  await sleep(500);
  const during = await s.evaluate(IDX, { timeoutMs: 60000 });
  await s.evaluate('window.__id.uninstall()');
  if (ctx.control) await s.evaluate('HTMLCanvasElement.prototype.__xbLeak = 1');
  await sleep(300);
  const after = await s.evaluate(IDX, { timeoutMs: 60000 });
  const changed = real(diffIdentity(before, during)).length; const left = real(diffIdentity(before, after));
  ctx.numbers.nativeUninstall = { mode: m, changedByInstall: changed, leftAfterUninstall: left.length, first: left.slice(0, 3) };
  ctx.check('native uninstall: the bridge patches the platform, uninstall restores every descriptor and the DOM exactly', stepsAside(m) && (m === 'native' || changed > 3) && left.length === 0, ctx.numbers.nativeUninstall, 'identity');
}

/**
 * The published examples on the native implementation: every one installs without throwing, steps aside (mode native or native-bridged; the bridge bundle
 * is loaded through ?xbbridge=1), draws a non-blank canvas natively and logs no error.
 */
export async function nativeExamples(ctx) {
  const { s } = ctx;
  for (const ex of ['basic', 'form', 'scroll-and-resize', 'effect-plugin']) {
    await s.navigate(url(ctx, `/examples/${ex}/index.html`, { xbbridge: 1 }));
    await until(s, 'document.readyState === "complete"'); await sleep(1500);
    const m = await nativeMode(s);
    const img = await readCanvas(s, 'canvas[content="drawable"]').catch((e) => ({ error: String(e) }));
    const nonBlank = !img.error && pixelStats(img).nonBlank;
    ctx.numbers[`native_${ex}`] = { mode: m, nonBlank, nonDominant: img.error ? null : +pixelStats(img).nonDominantFraction.toFixed(4) };
    ctx.check(`native ${ex}: install steps aside without throwing (mode native or native-bridged)`, stepsAside(m), { mode: m }, 'surface');
    // scroll-and-resize: Safari Technology Preview 254 draws its tall app element on the first paint after the update that rendered it and blank on every later
    // draw until the element is repainted (measured on a page without the polyfill, docs/SUPPORT-MATRIX.md); recorded, not asserted, on that build only
    const knownNativeDefect = ex === 'scroll-and-resize' && /Technology Preview/.test(s.version) && /^27\./.test(s.caps.browserVersion ?? '');
    if (!knownNativeDefect) ctx.check(`native ${ex}: the canvas is drawn natively (non-blank)`, nonBlank, img.error ?? null, 'pixel');
    await noErrors(ctx, `native ${ex}`);
  }
}

/** Run instead of SCENARIOS on an engine whose native implementation is usable. */
export const NATIVE_SCENARIOS = { nativeSurface, nativeExplainer, nativeForm, nativeUninstall, nativeExamples };

export const SCENARIOS = { explainer, form, clickEffect, controls, interaction, inactive, resize, scroll, scrollCompose, unsupported, uninstall, decodeTiming };
/** classes each scenario's control must turn red; scrollCompose: the composition classes only where the real run composed (DPR 1, overlay bars), else the refusal */
export const CONTROL_CLASSES = { explainer: ['pixel', 'hit', 'typing'], form: ['pixel', 'hit', 'typing'], clickEffect: ['hit', 'misplaced'], controls: ['control-look'], interaction: ['interaction-look'], inactive: ['inactive-look'], resize: ['pixel', 'blank', 'hit'], scroll: ['pixel', 'scroll'], scrollCompose: (row) => (row.checks.some((c) => c.cls === 'grid') ? ['grid', 'refusal'] : ['refusal']), unsupported: ['report'], uninstall: ['identity'], decodeTiming: [], nativeSurface: [], nativeExplainer: ['pixel', 'typing'], nativeForm: ['pixel', 'hit', 'typing'], nativeUninstall: ['identity'], nativeExamples: ['pixel'] };
export { KEYS };
