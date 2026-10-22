// G-native-effects: the effects host over the browser's OWN HTML-in-Canvas implementation (Chrome Canary with CanvasDrawElement, the polyfill
// installed in mode native), F1 water form, headed, trusted CDP input. What a page relies on, measured on the pixels the user sees:
//   surface  the host with no plugin presents the source exactly as the browser draws it with the 2D drawElementImage (same page, painter=generic,
//            composited over the host's clear colour): measured max difference 1 level
//   typing   typing in a drawn field changes the presented frame (the native source reaches the effect)
//   cap      framecap 15 / 30 bounds the effect frames of a continuous plugin; canvas.frameCap reflects the attribute
//   pause    the effect stops rendering while the canvas is far outside the viewport, and renders again at once when it comes back
//   actions  the water plugin's action (handle.trigger / settled), and a destroyed GPUDevice is recovered (frames go on, not blank, reported once)
// Positive control (every sabotage at once, each class must go red): the CRT plugin at curvature 0.3 over the picture (surface), the native upload
// frozen after the first frame (typing), no framecap (cap), IntersectionObserver removed before the host starts (pause).
//   node test/native-effects/g-native-effects.mjs [--no-control]      (npm run test:native-effects runs it; needs Chrome Canary)
import { runGate, H, EFFECTS_BUNDLE, WATER_BUNDLE } from '../gates/lib/gate.mjs';
import { compositorShot } from '../gates/lib/pixel.mjs';

const CRT_BUNDLE = '/dist/plugins/crt.iife.js';
/** a passthrough frame and the browser's 2D drawing of the same source: at most this share of pixels may differ by more than 16 levels */
const PASSTHROUGH_MAX = 0.01;

async function framesIn(page, ms) {
  const a = await page.evaluate('window.__frames');
  await H.sleep(ms);
  return (await page.evaluate('window.__frames')) - a;
}

runGate('G-native-effects', async (ctx) => {
  const numbers = {};
  const control = ctx.control;
  const bundle = `${ctx.bundle},${EFFECTS_BUNDLE},${WATER_BUNDLE},${CRT_BUNDLE}`;

  // the browser's own 2D drawing of F1 (the fixture's generic painter: drawElementImage in onpaint), the reference of the passthrough frame
  // the launch tab can carry an infobar (a shorter viewport); both pages compared are fresh tabs
  await ctx.page();
  const ref = await ctx.page();
  await ctx.focus(ref);
  await ref.navigate(H.fixtureUrl(ctx.srv, 'f1', { mode: 'native', bundle: ctx.bundle }));
  await ref.waitForFunction('!!(window.__HIC_FIXTURE && window.__HIC_FIXTURE.ready)', { timeout: 15000 });
  // the host presents an opaque frame: where the source is transparent it shows its clear colour (gpu-presenter.js CLEAR), so the 2D reference is
  // composited over that same colour instead of the canvas's CSS background
  await ref.evaluate(`document.querySelector('#hic-surface').style.background = 'rgb(1, 5, 9)'`);
  await H.sleep(500);
  const native2d = (await H.screenshotElement(ref, '#hic-surface')).img;

  const page = await ctx.page();
  await ctx.focus(page);
  await page.navigate(H.fixtureUrl(ctx.srv, 'f1', { mode: 'native', bundle, params: { painter: 'none' } }));
  await page.waitForFunction('!!window.__HIC__ && !!window.HTMLInCanvasEffects && !!window.HicLivePlugins?.water && !!window.HicLivePlugins?.crt', { timeout: 10000 });
  const errors0 = page.errors().length;
  const st = await page.evaluate(`(async () => {
    const canvas = document.querySelector('#hic-surface'); const form = document.querySelector('#demo-form');
    window.__errs = []; window.__frames = 0;
    canvas.addEventListener('effecterror', (e) => window.__errs.push(String(e.detail && e.detail.error)));
    canvas.addEventListener('effectframe', () => { window.__frames += 1; });
    form.addEventListener('submit', (e) => e.preventDefault(), true);
    ${control ? 'delete window.IntersectionObserver;' : ''}
    window.__host = await HTMLInCanvasEffects.createHost(canvas, form, { maxDpr: 2.5 });
    await new Promise((r) => setTimeout(r, 800));
    ${control ? `const real = GPUQueue.prototype.drawElementImageToTexture; GPUQueue.prototype.drawElementImageToTexture = function () {};
      window.__crt = await __host.addPlugin(HicLivePlugins.crt.plugin, { curvature: 0.3, scanlines: 0, mask: 0, glow: 0, warmth: 0, flicker: 0, misconvergence: 0 });
      await new Promise((r) => setTimeout(r, 400));` : ''}
    return { mode: __HIC__.installed.mode, layers: document.querySelectorAll('hic-layer').length, stats: __host.stats(), frameCapType: typeof canvas.frameCap };
  })()`);
  numbers.setup = st;
  ctx.check('identity: the polyfill stepped aside (mode native, no live layer), the host presents frames, canvas.frameCap exists', st.mode === 'native' && st.layers === 0 && st.stats.frames > 0 && st.frameCapType === 'number', st, 'surface');

  // --- surface: the passthrough frame equals the browser's own 2D drawing -------------------------------------------------------------
  await page.mouseMove(2, 2);
  await H.sleep(300);
  const pass = (await compositorShot(page, '#hic-surface')).img;
  const cmp = H.compareImages(pass, native2d, { diffImage: false });
  numbers.passthrough = { sizes: [[pass.width, pass.height], [native2d.width, native2d.height]], sizeMatch: cmp.sizeMatch, fraction: cmp.fraction, countOver16: cmp.countOver16, maxDiff: cmp.maxDiff, bbox: cmp.overBBox, nonBlank: H.pixelStats(pass).nonBlank };
  if (!control) {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { RESULTS } = await import('../gates/lib/gate.mjs');
    mkdirSync(RESULTS, { recursive: true });
    writeFileSync(`${RESULTS}/${ctx.id}-passthrough.png`, H.encodePng(pass));
    writeFileSync(`${RESULTS}/${ctx.id}-native2d.png`, H.encodePng(native2d));
  }
  ctx.check('surface: the presented frame is not blank', H.pixelStats(pass).nonBlank, null, 'surface');
  ctx.check(`surface: the host with no plugin presents what the browser draws with 2D drawElementImage (delta > 16 on <= ${PASSTHROUGH_MAX * 100} %)`, cmp.sizeMatch && cmp.fraction <= PASSTHROUGH_MAX, numbers.passthrough, 'surface');
  const tight = H.compareImages(pass, native2d, { tolerance: 2, diffImage: false });
  numbers.passthrough.tight = { fraction: tight.fraction, count: tight.countOver16 };
  ctx.check('surface: tight pass (delta > 2 on <= 0.1 % of pixels): the same pixels, not just a similar picture', tight.sizeMatch && tight.fraction <= 0.001, numbers.passthrough.tight, 'surface');

  // --- typing: the native source reaches the effect -----------------------------------------------------------------------------------
  const name = await page.evaluate(`(() => { const r = document.querySelector('#name').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.click(name.x, name.y);
  await H.sleep(150);
  const before = (await compositorShot(page, '#hic-surface')).img;
  const uploads0 = (await page.evaluate('__host.stats()')).uploads;
  await page.typeText('WWWW');
  await H.sleep(250);
  const after = (await compositorShot(page, '#hic-surface')).img;
  const typed = { value: await page.evaluate(`document.querySelector('#name').value`), changedPixels: H.compareImages(after, before, { diffImage: false }).countOver16, uploads: (await page.evaluate('__host.stats()')).uploads - uploads0 };
  numbers.typing = typed;
  ctx.check('typing: a trusted click focuses the drawn field and the typing reaches it', /WWWW$/.test(typed.value), typed, 'interact');
  ctx.check('typing: the presented frame shows the typed text (> 100 pixels changed)', typed.changedPixels > 100, typed, 'typing');
  await page.evaluate('document.activeElement && document.activeElement.blur()');

  // --- cap: a continuous plugin under framecap 15 and 30 ------------------------------------------------------------------------------
  numbers.water = await page.evaluate(`(async () => { window.__water = await __host.addPlugin(HicLivePlugins.water.plugin, { intensity: 0.3 }); return true; })()`);
  await page.mouseMove(name.x, name.y + 40);
  const rates = {};
  for (const cap of [15, 30]) {
    if (!control) await page.evaluate(`document.querySelector('#hic-surface').frameCap = ${cap}`);
    await H.sleep(300);
    rates[cap] = { fps: (await framesIn(page, 2000)) / 2, prop: await page.evaluate(`document.querySelector('#hic-surface').frameCap`), attr: await page.evaluate(`document.querySelector('#hic-surface').getAttribute('framecap')`) };
  }
  await page.evaluate(`document.querySelector('#hic-surface').removeAttribute('framecap')`);
  await H.sleep(300);
  rates.uncapped = { fps: (await framesIn(page, 1000)) / 1 };
  numbers.cap = rates;
  for (const cap of [15, 30]) {
    ctx.check(`cap ${cap}: effect frames per second within [${0.9 * cap}, ${1.1 * cap}] and canvas.frameCap reflects the attribute`, rates[cap].fps >= 0.9 * cap && rates[cap].fps <= 1.1 * cap && rates[cap].prop === cap && rates[cap].attr === String(cap), rates[cap], 'cap');
  }
  ctx.check('cap: uncapped, the continuous plugin renders well above 30 per second (the bound above is not the display)', rates.uncapped.fps > 45, rates.uncapped, 'interact');

  // --- pause: far outside the viewport nothing renders; back in view it renders at once ------------------------------------------------
  const pause = await page.evaluate(`(async () => {
    document.body.style.overflow = 'auto';
    const spacer = document.createElement('div'); spacer.style.height = '6000px'; document.body.append(spacer);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    window.scrollTo(0, 5000); await wait(400);
    const f0 = window.__frames; await wait(1000); const off = window.__frames - f0; const paused = __host.stats().paused;
    window.scrollTo(0, 0); const t0 = performance.now(); const f1 = window.__frames;
    while (window.__frames - f1 < 3 && performance.now() - t0 < 2000) await wait(10);
    const resumedMs = performance.now() - t0;
    spacer.remove(); document.body.style.overflow = '';
    return { offscreenFramesPerSecond: off, paused, resumedMs: Math.round(resumedMs) };
  })()`);
  numbers.pause = pause;
  ctx.check('pause: far outside the viewport the continuous effect renders at most 1 frame per second and reports paused', pause.offscreenFramesPerSecond <= 1 && pause.paused === true, pause, 'pause');
  ctx.check('pause: back in view, 3 frames are presented within 300 ms', pause.resumedMs <= 300, pause, 'interact');

  // --- actions and device loss (must hold in the real run) ------------------------------------------------------------------------------
  const actions = await page.evaluate(`(async () => {
    const state = await __water.trigger('drop'); const rest = await __water.settled();
    let unknown = ''; try { await __water.trigger('nope'); } catch (e) { unknown = e.name; }
    return { state, rest, unknown };
  })()`);
  numbers.actions = actions;
  ctx.check('actions: handle.trigger("drop") resolves "calm", settled() says "calm", an unknown action rejects with TypeError', actions.state === 'calm' && actions.rest === 'calm' && actions.unknown === 'TypeError', actions);

  const lost = await page.evaluate(`(async () => {
    const spy = HTMLInCanvasEffects.definePlugin({ type: 'device-spy', apiVersion: 2, version: 1, create: (c) => { window.__device = c.device; return { render() {} }; } });
    const handle = await __host.addPlugin(spy);
    const first = window.__device;
    first.destroy();
    await new Promise((r) => setTimeout(r, 1500));
    const f0 = window.__frames; await new Promise((r) => setTimeout(r, 500));
    const s = __host.stats();
    const report = __HIC__.installed.report();
    handle.remove();
    return { recreated: window.__device !== first, framesAfter: window.__frames - f0, deviceLosses: s.deviceLosses, reported: report.errors.filter((e) => /device-lost/.test(JSON.stringify(e))).length };
  })()`);
  numbers.deviceLoss = lost;
  await H.sleep(200);
  const recovered = (await compositorShot(page, '#hic-surface')).img;
  ctx.check('device loss: the host recreates the device and the plugins, frames go on, the frame is not blank, the loss is reported once', lost.recreated && lost.framesAfter > 5 && lost.deviceLosses === 1 && lost.reported === 1 && H.pixelStats(recovered).nonBlank, lost);

  numbers.effectErrors = await page.evaluate('window.__errs');
  // the destroyed device above is reported on purpose (console.error 'effects:device-lost', once): every other error counts
  const errs = page.errors({ includeWarnings: false }).slice(errors0).filter((e) => !/internal error in effects:device-lost: Error: GPUDevice lost \(destroyed\)/.test(e.text ?? ''));
  ctx.check('no effecterror, no page error (but the reported device loss)', numbers.effectErrors.length === 0 && errs.length === 0, { effect: numbers.effectErrors, page: errs.slice(0, 3) });
  return { numbers };
}, { chrome: 'canary', nativeDrawElement: true, controlClasses: ['surface', 'typing', 'cap', 'pause'] });
