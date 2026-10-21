// HTML-in-Canvas field test: guided steps that measure the polyfill on a machine we do not have, and one JSON report to send back.
// Nothing is sent anywhere. The page loads only its own files (the polyfill bundles, and the effects bundle plus the water plugin in the
// effect step). docs/guides/FIELD-TEST.md describes the report; scripts/check-field-test.mjs runs the page end to end.
(() => {
  'use strict';

  const TOOL_VERSION = 'field-test/1';
  const SCHEMA = 'hic-field-test/1';
  const CROP_BUDGET = 2000000; // characters of PNG data URLs in one report
  const ISSUE_URL = 'https://github.com/GiuseppeScottoLavina/html-in-canvas-polyfill/issues/new?template=field_test.yml';
  // pixel verdicts, the same metric as the repository's pixel gates: share of pixels whose largest RGB difference exceeds 16 (and 100) levels
  const LIMITS = { pass: { over16: 3, over100: 1 }, warn: { over16: 6, over100: 3 } };
  const VERDICTS = ['pass', 'warn', 'fail', 'info', 'skipped', 'error'];
  const STATUSES = ['pending', 'running', 'done', 'skipped', 'error'];
  const CAPTURE_STATES = ['not-asked', 'unsupported', 'declined', 'denied', 'error', 'wrong-surface', 'calibration-failed', 'active', 'stopped', 'ended-by-user'];

  const boot = window.__fieldTestBoot || { t0: Date.now(), console: [], errors: [], native: {} };
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** the next animation frame, or a timer when the tab is hidden (rAF stops there) */
  const nextFrame = () => new Promise((r) => { let done = false; const end = (t) => { if (!done) { done = true; r(t ?? performance.now()); } }; requestAnimationFrame(end); setTimeout(end, 250); });
  const frames = async (n) => { for (let i = 0; i < n; i++) await nextFrame(); };
  const round = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v ?? null);
  const quantile = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };
  const summarize = (a) => (a.length ? { n: a.length, min: round(Math.min(...a)), p50: round(quantile(a, 0.5)), p95: round(quantile(a, 0.95)), max: round(Math.max(...a)), mean: round(a.reduce((x, y) => x + y, 0) / a.length) } : { n: 0 });
  const errInfo = (e) => ({ name: e && e.name || 'Error', message: String(e && e.message || e).slice(0, 500), stack: e && e.stack ? String(e.stack).split('\n').slice(0, 4).join('\n').slice(0, 600) : undefined });
  const coarse = () => matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;

  // ------------------------------------------------------------------------------------------------------------------------------
  // The report
  const report = {
    schema: SCHEMA,
    tool: TOOL_VERSION,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    page: location.origin + location.pathname,
    collected: [
      'browser name and version, operating system and version, CPU architecture and device model as the browser reports them',
      'screen size, pixel ratio, zoom, colour and contrast settings, system colours, scrollbar type, which of a short list of common fonts exist',
      'graphics adapter name (WebGPU and WebGL) when the browser exposes it',
      'timings of the steps (typing, scrolling, effect frame rates)',
      'small pictures of the test boxes of this page only (with the tab capture you allowed); nothing outside this tab',
    ],
    environment: null,
    polyfill: null,
    capture: { state: 'not-asked', supported: null },
    steps: {},
    checks: [],
    summary: null,
    console: boot.console,
    errors: boot.errors,
    crops: { budgetChars: CROP_BUDGET, usedChars: 0, omitted: [], images: {} },
    selfCheck: null,
  };

  /** One line of the flat check list (the summary table and the first thing to read in a report). */
  function check(id, verdict, text, numbers) {
    const entry = { id, verdict, text };
    if (numbers) entry.numbers = numbers;
    const i = report.checks.findIndex((c) => c.id === id);
    if (i >= 0) report.checks[i] = entry; else report.checks.push(entry);
    return entry;
  }
  function recordError(where, e) {
    if (report.errors.length < 60) report.errors.push({ where, ...errInfo(e) });
  }

  // ------------------------------------------------------------------------------------------------------------------------------
  // Environment
  async function measureRefresh() {
    const ts = [];
    await new Promise((resolve) => {
      const f = (t) => { ts.push(t); if (ts.length < 91) requestAnimationFrame(f); else resolve(); };
      requestAnimationFrame(f);
      setTimeout(resolve, 3000);
    });
    const iv = []; for (let i = 1; i < ts.length; i++) iv.push(ts[i] - ts[i - 1]);
    const p50 = quantile(iv, 0.5);
    return { frames: iv.length, intervalMs: summarize(iv), hz: p50 ? round(1000 / p50, 1) : null, documentVisible: document.visibilityState === 'visible' };
  }

  function mediaValue(feature, values) {
    for (const v of values) if (matchMedia(`(${feature}: ${v})`).matches) return v;
    return matchMedia(`(${feature})`).media === 'not all' ? 'unsupported' : 'none';
  }

  function readSystemColors() {
    const names = ['Canvas', 'CanvasText', 'Highlight', 'HighlightText', 'SelectedItem', 'SelectedItemText', 'AccentColor', 'AccentColorText', 'Mark', 'MarkText',
      'ButtonFace', 'ButtonText', 'ButtonBorder', 'Field', 'FieldText', 'GrayText', 'LinkText', 'VisitedText', 'ActiveText'];
    const c = document.createElement('canvas'); c.width = c.height = 1;
    const x = c.getContext('2d', { willReadFrequently: true });
    const out = {};
    for (const n of names) {
      x.fillStyle = '#010203'; x.fillStyle = n;
      const parsed = x.fillStyle;
      if (parsed === '#010203') { out[n] = null; continue; } // the keyword is not supported here
      x.clearRect(0, 0, 1, 1); x.fillRect(0, 0, 1, 1);
      out[n] = { style: parsed, rgba: [...x.getImageData(0, 0, 1, 1).data] };
    }
    return out;
  }

  function scrollbarInfo() {
    const d = document.createElement('div');
    d.style.cssText = 'position:absolute;left:-10000px;top:0;width:120px;height:120px;overflow:scroll;';
    document.body.append(d);
    const gutter = d.offsetWidth - d.clientWidth;
    d.remove();
    const s = document.querySelector('#ft-twin-scroll .ft-scroller');
    return { gutterCssPx: gutter, type: gutter > 0 ? 'classic' : 'overlay', testBoxGutterCssPx: s ? s.offsetWidth - s.clientWidth : null, scrollbarGutterSupported: CSS.supports('scrollbar-gutter', 'stable') };
  }

  function fontInfo() {
    const list = ['Segoe UI', 'Segoe UI Variable Text', 'Arial', 'Helvetica', 'Helvetica Neue', 'SF Pro Text', 'Roboto', 'Noto Sans', 'Ubuntu', 'Cantarell',
      'DejaVu Sans', 'Liberation Sans', 'Tahoma', 'Verdana', 'Times New Roman', 'Georgia', 'Consolas', 'Menlo', 'Courier New'];
    const c = document.createElement('canvas').getContext('2d');
    const text = 'mmmmmmmmmmlli WWW 0123456789 Canvas';
    const width = (font) => { c.font = font; return c.measureText(text).width; };
    const bases = ['monospace', 'serif'].map((b) => ({ b, w: width(`40px ${b}`) }));
    const systemUi = width('40px system-ui');
    const available = list.filter((f) => bases.some(({ b, w }) => width(`40px "${f}", ${b}`) !== w));
    return { available, systemUiWidthMatches: available.filter((f) => Math.abs(width(`40px "${f}", monospace`) - systemUi) < 0.01), testFont: getComputedStyle(document.querySelector('#ft-twin-sample .ft-sample')).fontFamily };
  }

  async function webgpuInfo() {
    if (!('gpu' in navigator)) return { available: false, reason: window.isSecureContext ? 'navigator.gpu is missing' : 'not a secure context (https)' };
    const adapter = await Promise.race([navigator.gpu.requestAdapter(), sleep(5000).then(() => 'timeout')]);
    if (adapter === 'timeout') return { available: false, reason: 'requestAdapter() did not answer within 5 s' };
    if (!adapter) return { available: false, reason: 'requestAdapter() returned null (no usable GPU, or the GPU is blocklisted)' };
    let info = adapter.info;
    if (!info && adapter.requestAdapterInfo) info = await adapter.requestAdapterInfo().catch(() => null);
    const pick = (o, keys) => { const r = {}; if (o) for (const k of keys) if (o[k] !== undefined && o[k] !== '') r[k] = o[k]; return r; };
    return {
      available: true,
      info: pick(info, ['vendor', 'architecture', 'device', 'description', 'isFallbackAdapter', 'subgroupMinSize', 'subgroupMaxSize']),
      isFallbackAdapter: adapter.isFallbackAdapter ?? info?.isFallbackAdapter ?? null,
      features: [...adapter.features].sort(),
      limits: pick(adapter.limits, ['maxTextureDimension2D', 'maxBufferSize', 'maxStorageBufferBindingSize', 'maxComputeWorkgroupSizeX']),
      preferredCanvasFormat: navigator.gpu.getPreferredCanvasFormat ? navigator.gpu.getPreferredCanvasFormat() : null,
    };
  }

  function webglInfo() {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return { available: false };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const out = { available: true, version: gl.getParameter(gl.VERSION), vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER),
      unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null, unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) };
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return out;
  }

  async function collectEnvironment() {
    const env = {};
    const safe = async (key, fn) => { try { env[key] = await fn(); } catch (e) { env[key] = { error: errInfo(e).message }; } };
    await safe('browser', async () => {
      const uad = navigator.userAgentData;
      let high = null;
      if (uad && uad.getHighEntropyValues) high = await uad.getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList', 'uaFullVersion', 'wow64', 'formFactors']).catch((e) => ({ error: String(e) }));
      return {
        userAgent: navigator.userAgent, platform: navigator.platform, vendor: navigator.vendor, language: navigator.language,
        uaData: uad ? { brands: uad.brands, mobile: uad.mobile, platform: uad.platform, ...(high || {}) } : null,
        hardwareConcurrency: navigator.hardwareConcurrency ?? null, deviceMemory: navigator.deviceMemory ?? null, maxTouchPoints: navigator.maxTouchPoints ?? 0,
        secureContext: window.isSecureContext, crossOriginIsolated: window.crossOriginIsolated ?? null,
      };
    });
    await safe('display', async () => ({
      devicePixelRatio: window.devicePixelRatio,
      screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth, orientation: screen.orientation?.type ?? null, isExtended: screen.isExtended ?? null },
      viewport: { innerWidth, innerHeight, outerWidth, outerHeight, clientWidth: document.documentElement.clientWidth, visualViewportScale: window.visualViewport?.scale ?? null },
      refresh: await measureRefresh(),
    }));
    await safe('media', async () => ({
      colorGamut: mediaValue('color-gamut', ['rec2020', 'p3', 'srgb']),
      dynamicRange: mediaValue('dynamic-range', ['high', 'standard']),
      prefersColorScheme: mediaValue('prefers-color-scheme', ['dark', 'light']),
      prefersReducedMotion: mediaValue('prefers-reduced-motion', ['reduce', 'no-preference']),
      prefersContrast: mediaValue('prefers-contrast', ['more', 'less', 'custom', 'no-preference']),
      prefersReducedTransparency: mediaValue('prefers-reduced-transparency', ['reduce', 'no-preference']),
      forcedColors: mediaValue('forced-colors', ['active', 'none']),
      invertedColors: mediaValue('inverted-colors', ['inverted', 'none']),
      pointer: mediaValue('pointer', ['coarse', 'fine', 'none']),
      anyPointer: mediaValue('any-pointer', ['fine', 'coarse', 'none']),
      hover: mediaValue('hover', ['hover', 'none']),
    }));
    await safe('systemColors', async () => readSystemColors());
    await safe('scrollbars', async () => scrollbarInfo());
    await safe('fonts', async () => fontInfo());
    await safe('webgpu', webgpuInfo);
    await safe('webgl', async () => webglInfo());
    await safe('apis', async () => ({
      getDisplayMedia: !!navigator.mediaDevices?.getDisplayMedia, requestVideoFrameCallback: 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
      MediaStreamTrackProcessor: typeof window.MediaStreamTrackProcessor === 'function', ImageCapture: typeof window.ImageCapture === 'function',
      ResizeObserverDevicePixel: (() => { try { new ResizeObserver(() => {}).observe(document.createElement('div'), { box: 'device-pixel-content-box' }); return true; } catch { return false; } })(),
      OffscreenCanvas: typeof window.OffscreenCanvas === 'function', ctxReset: typeof CanvasRenderingContext2D.prototype.reset === 'function',
    }));
    return env;
  }

  function polyfillInfo() {
    const hic = window.__HIC__, lib = window.HicLivePolyfill;
    const out = { scriptLoaded: !!lib, version: lib?.version ?? null, nativeBeforeInstall: boot.native, mode: null, refused: null, report: null,
      apiAvailable: typeof CanvasRenderingContext2D.prototype.drawElementImage === 'function' };
    if (hic && hic.error) out.refused = { name: hic.error.name, feature: hic.error.feature ?? null, message: String(hic.error.message).slice(0, 500), hint: hic.error.hint ?? null };
    try {
      const inst = hic && hic.installed;
      if (inst) { out.mode = inst.mode ?? null; out.report = JSON.parse(JSON.stringify(inst.report())); }
    } catch (e) { out.reportError = errInfo(e).message; }
    if (!lib) out.note = 'the polyfill script did not load (blocked or missing)';
    return out;
  }

  // ------------------------------------------------------------------------------------------------------------------------------
  // Pixels
  function imageStats(img) {
    const { data } = img, n = img.width * img.height, hist = new Map();
    for (let i = 0; i < n * 4; i += 4) { const k = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]; hist.set(k, (hist.get(k) || 0) + 1); if (hist.size > 4096) break; }
    let dom = 0, domK = 0; for (const [k, c] of hist) if (c > dom) { dom = c; domK = k; }
    const scanned = [...hist.values()].reduce((a, b) => a + b, 0);
    return { colors: hist.size, dominant: [domK >> 16, (domK >> 8) & 255, domK & 255], dominantShare: round(dom / Math.max(1, scanned), 4), nonBlank: hist.size > 8 && (scanned - dom) / Math.max(1, scanned) > 0.005 };
  }
  /** largest RGB difference per pixel between a (w x h) and b at offset (ox, oy) of b */
  function diffCounts(a, b, ox = 0, oy = 0, want = false) {
    const w = a.width, h = a.height, A = a.data, B = b.data, bw = b.width;
    let over16 = 0, over100 = 0, max = 0, sum = 0;
    const map = want ? new ImageData(w, h) : null;
    for (let y = 0; y < h; y++) {
      let ia = y * w * 4, ib = ((y + oy) * bw + ox) * 4;
      for (let x = 0; x < w; x++, ia += 4, ib += 4) {
        const d = Math.max(Math.abs(A[ia] - B[ib]), Math.abs(A[ia + 1] - B[ib + 1]), Math.abs(A[ia + 2] - B[ib + 2]));
        if (d > 16) over16++; if (d > 100) over100++; if (d > max) max = d; sum += d;
        if (map) { const v = d === 0 ? 0 : Math.min(255, 60 + d * 2); map.data[ia] = v; map.data[ia + 1] = d > 16 ? 0 : v >> 2; map.data[ia + 2] = 0; map.data[ia + 3] = 255; }
      }
    }
    const n = w * h;
    return { over16Pct: round(100 * over16 / n, 3), over100Pct: round(100 * over100 / n, 3), maxDelta: max, meanDelta: round(sum / n, 2), map };
  }
  function pixelVerdict(r) {
    if (r.over16Pct <= LIMITS.pass.over16 && r.over100Pct <= LIMITS.pass.over100) return 'pass';
    if (r.over16Pct <= LIMITS.warn.over16 && r.over100Pct <= LIMITS.warn.over100) return 'warn';
    return 'fail';
  }
  /** a (w x h) against b, which has `margin` extra pixels on each side: the best of the shifts within the margin */
  function compareShifted(a, b, margin) {
    let best = null;
    for (let dy = -margin; dy <= margin; dy++) for (let dx = -margin; dx <= margin; dx++) {
      const r = diffCounts(a, b, margin + dx, margin + dy);
      if (!best || r.over16Pct < best.over16Pct || (r.over16Pct === best.over16Pct && r.meanDelta < best.meanDelta)) best = { ...r, shift: { dx, dy } };
    }
    const atZero = diffCounts(a, b, margin, margin);
    const bestMap = diffCounts(a, b, margin + best.shift.dx, margin + best.shift.dy, true).map;
    return { over16Pct: best.over16Pct, over100Pct: best.over100Pct, maxDelta: best.maxDelta, meanDelta: best.meanDelta, shiftFramePx: best.shift,
      atZeroShift: { over16Pct: atZero.over16Pct, over100Pct: atZero.over100Pct }, verdict: pixelVerdict(best), map: bestMap };
  }
  function hashImage(img, stride = 1) {
    const d = img.data; let h = 2166136261 >>> 0;
    for (let i = 0; i < d.length; i += 4 * stride) { h = Math.imul(h ^ d[i], 16777619); h = Math.imul(h ^ d[i + 1], 16777619); h = Math.imul(h ^ d[i + 2], 16777619); }
    return h >>> 0;
  }
  function changedShare(a, b) {
    if (!a || !b || a.width !== b.width || a.height !== b.height) return null;
    return round(diffCounts(a, b).over16Pct, 2);
  }
  /** the colours of a selection: the commonest new colour among pixels that changed (the background) and the changed pixel farthest from it (the glyphs) */
  function selectionColours(before, after) {
    if (!before || !after || before.width !== after.width || before.height !== after.height) return null;
    const A = before.data, B = after.data, hist = new Map(); let changed = 0;
    for (let i = 0; i < A.length; i += 4) {
      if (Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2])) <= 16) continue;
      changed++; const k = (B[i] << 16) | (B[i + 1] << 8) | B[i + 2]; hist.set(k, (hist.get(k) || 0) + 1);
    }
    if (!changed) return { changedPct: 0, background: null, glyph: null };
    let bg = 0, bgN = 0; for (const [k, c] of hist) if (c > bgN) { bgN = c; bg = k; }
    const rgb = (k) => [k >> 16, (k >> 8) & 255, k & 255];
    const bgc = rgb(bg); let glyph = null, far = -1;
    for (const [k, c] of hist) { if (c < 3) continue; const p = rgb(k); const d = Math.abs(p[0] - bgc[0]) + Math.abs(p[1] - bgc[1]) + Math.abs(p[2] - bgc[2]); if (d > far) { far = d; glyph = p; } }
    return { changedPct: round(100 * changed / (A.length / 4), 2), background: bgc, glyph };
  }
  function toCanvas(img) {
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    c.getContext('2d').putImageData(img, 0, 0); return c;
  }

  // Crops: kept as canvases, encoded as PNG data URLs (by priority, within the budget) when the report is built.
  const cropStore = new Map();
  function addCrop(id, img, priority = 1) {
    if (!img || !img.width || !img.height) return null;
    cropStore.set(id, { canvas: img instanceof HTMLCanvasElement ? img : toCanvas(img), priority, encoded: null });
    return id;
  }
  /** the crops of one check (canvas, plain, diff) are kept or left out together; failing and warning checks first, then in order */
  function encodeCrops() {
    const images = {}, omitted = []; let used = 0;
    const groups = new Map();
    for (const [id, c] of cropStore) { const g = id.replace(/\.[^.]+$/, ''); if (!groups.has(g)) groups.set(g, []); groups.get(g).push([id, c]); }
    const ordered = [...groups.values()].map((list, i) => ({ list, i, priority: Math.max(...list.map(([, c]) => c.priority)) })).sort((a, b) => b.priority - a.priority || a.i - b.i);
    for (const { list } of ordered) {
      for (const [id, c] of list) if (c.encoded == null) { try { c.encoded = c.canvas.toDataURL('image/png'); } catch (e) { c.encoded = ''; c.error = errInfo(e).message; } }
      const size = list.reduce((n, [, c]) => n + c.encoded.length, 0);
      if (used + size > CROP_BUDGET) { for (const [id, c] of list) omitted.push({ id, reason: 'size budget', chars: c.encoded.length }); continue; }
      for (const [id, c] of list) { if (c.encoded) images[id] = c.encoded; else omitted.push({ id, reason: c.error || 'not encodable' }); }
      used += size;
    }
    return { budgetChars: CROP_BUDGET, usedChars: used, omitted, images };
  }

  // ------------------------------------------------------------------------------------------------------------------------------
  // The test boxes: the same HTML drawn into a canvas (A) and laid out as a plain page (B)
  const pairs = {};
  const apiAvailable = () => typeof CanvasRenderingContext2D.prototype.drawElementImage === 'function';

  function makePair(name, templateId, init) {
    const canvas = /** @type {HTMLCanvasElement} */ ($('ft-canvas-' + name)), twinBox = $('ft-twin-' + name), ghostBox = $('ft-ghost-' + name);
    const tpl = /** @type {HTMLTemplateElement} */ ($(templateId)).content.firstElementChild;
    const source = /** @type {HTMLElement} */ (tpl.cloneNode(true)), twin = /** @type {HTMLElement} */ (tpl.cloneNode(true));
    if (init) { init(source); init(twin); }
    source.setAttribute('drawable', '');
    canvas.append(source);
    if (twinBox) twinBox.append(twin);
    const ghost = /** @type {HTMLElement} */ (tpl.cloneNode(true));
    if (ghostBox) { if (init) init(ghost); for (const el of ghost.querySelectorAll('input, button, a')) el.setAttribute('tabindex', '-1'); ghostBox.append(ghost); }
    const pair = { name, canvas, twinBox, source, twin: twinBox ? twin : null, ghostBox, ghost: ghostBox ? ghost : null, ctx: null, paints: 0, lastPaint: 0, paintError: null, drawn: false };
    // 'twin' is the hidden copy over box A (the one whose picture is compared); box B is what the tester sees beside it
    pair.side = (side, selector) => { const root = side === 'canvas' ? source : ghost; return root.matches(selector) ? root : root.querySelector(selector); };
    /** give the hidden copy the state of box A that the tester changed (typed text, scroll offsets) */
    pair.syncGhost = () => {
      if (!ghostBox) return;
      const a = [...source.querySelectorAll('input, .ft-scroller')], b = [...ghost.querySelectorAll('input, .ft-scroller')];
      a.forEach((el, i) => { const g = /** @type {any} */ (b[i]); if (!g) return; if (el.localName === 'input') { g.value = /** @type {HTMLInputElement} */ (el).value; g.checked = /** @type {HTMLInputElement} */ (el).checked; } else { g.scrollTop = el.scrollTop; g.scrollLeft = el.scrollLeft; } });
    };
    pairs[name] = pair;
    if (name === 'effect') return pair; // the effects host owns that canvas
    if (!apiAvailable()) { drawUnavailable(canvas); return pair; }
    try {
      pair.ctx = canvas.getContext('2d');
      canvas.onpaint = () => {
        try {
          if (pair.ctx.reset) pair.ctx.reset(); else pair.ctx.clearRect(0, 0, canvas.width, canvas.height);
          pair.ctx.drawElementImage(source, 0, 0);
          pair.paints += 1; pair.lastPaint = performance.now(); pair.drawn = true;
        } catch (e) { pair.paintError = errInfo(e).message; }
      };
      sizeCanvas(canvas);
    } catch (e) { recordError('setup ' + name, e); }
    return pair;
  }
  function sizeCanvas(canvas) {
    const apply = (w, h) => { if (w > 0 && canvas.width !== w) canvas.width = w; if (h > 0 && canvas.height !== h) canvas.height = h; };
    const ro = new ResizeObserver((entries) => {
      const e = entries[0], b = e.devicePixelContentBoxSize && e.devicePixelContentBoxSize[0];
      if (b) apply(b.inlineSize, b.blockSize); else apply(Math.round(e.contentRect.width * devicePixelRatio), Math.round(e.contentRect.height * devicePixelRatio));
    });
    try { ro.observe(canvas, { box: 'device-pixel-content-box' }); } catch { ro.observe(canvas); }
  }
  function drawUnavailable(canvas) {
    try {
      canvas.width = canvas.clientWidth * devicePixelRatio; canvas.height = canvas.clientHeight * devicePixelRatio;
      const c = canvas.getContext('2d'); c.scale(devicePixelRatio, devicePixelRatio);
      c.fillStyle = '#f3f4f6'; c.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      c.fillStyle = '#566175'; c.font = '14px system-ui, sans-serif';
      c.fillText('HTML-in-Canvas is not available here.', 14, 28);
    } catch { /* nothing more to do */ }
  }

  /** wait for a paint of the pair's canvas after `since` (the polyfill paints a few frames after a DOM change), then two more frames */
  async function waitPaint(pair, since, timeout = 1200) {
    const t0 = performance.now();
    while (pair.lastPaint <= since && performance.now() - t0 < timeout) await nextFrame();
    await frames(2);
    return pair.lastPaint > since;
  }
  /** the content box of an element in viewport CSS px */
  function contentRect(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + el.clientLeft, y: r.top + el.clientTop, w: el.clientWidth, h: el.clientHeight };
  }
  function rectOf(el) { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }
  function inflate(r, d) { return { x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d }; }
  /** pixels of the pair's own canvas (backing store) under a viewport rect; null when it cannot be read */
  function readCanvas(pair, rect) {
    if (!pair.ctx) return null;
    const c = pair.canvas, box = contentRect(c);
    if (!box.w || !box.h || !c.width || !c.height) return null;
    const sx = c.width / box.w, sy = c.height / box.h;
    const r = rect || box;
    const x0 = Math.max(0, Math.floor((r.x - box.x) * sx)), y0 = Math.max(0, Math.floor((r.y - box.y) * sy));
    const x1 = Math.min(c.width, Math.ceil((r.x + r.w - box.x) * sx)), y1 = Math.min(c.height, Math.ceil((r.y + r.h - box.y) * sy));
    if (x1 <= x0 || y1 <= y0) return null;
    try { return pair.ctx.getImageData(x0, y0, x1 - x0, y1 - y0); } catch (e) { pair.readError = errInfo(e).message; return null; }
  }
  /** scroll as little as possible to show all of el, so that the instructions above it stay in view where they fit */
  function bringIntoView(el) {
    const r = el.getBoundingClientRect();
    if (r.top < 4) window.scrollBy(0, r.top - 8);
    else if (r.bottom > innerHeight - 4) window.scrollBy(0, Math.min(r.bottom - innerHeight + 12, r.top - 8));
  }
  /**
   * Put box A (and the copy over it) and box B on whole device pixels. The canvas bitmap is shown on the device pixel grid while HTML at a
   * fractional position is rasterised at that position, so a plain-page reference at a fractional position differs from any canvas, a
   * native one included. Records the offsets that were corrected.
   */
  function snapToDevicePixels() {
    const dpr = devicePixelRatio, out = {};
    for (const el of document.querySelectorAll('#ft-area .slot, #ft-area .twin:not(.ghost)')) {
      const h = /** @type {HTMLElement} */ (el);
      h.style.position = 'relative';
      for (let i = 0; i < 3; i++) {
        const r = h.getBoundingClientRect();
        const fx = r.left * dpr - Math.round(r.left * dpr), fy = r.top * dpr - Math.round(r.top * dpr);
        if (i === 0) out[h.id || h.querySelector('canvas')?.id || '?'] = [round(fx, 3), round(fy, 3)];
        if (Math.abs(fx) < 0.01 && Math.abs(fy) < 0.01) break;
        h.style.left = (parseFloat(h.style.left || '0') - fx / dpr) + 'px';
        h.style.top = (parseFloat(h.style.top || '0') - fy / dpr) + 'px';
      }
    }
    return out;
  }
  function overlayScrollbars() { const s = document.querySelector('#ft-twin-scroll .ft-scroller'); return !!s && s.offsetWidth === s.clientWidth; }
  function clearSelection() { const s = getSelection(); if (s) s.removeAllRanges(); }
  function blurActive() { const a = document.activeElement; if (a && a !== document.body && a.blur) a.blur(); }
  function selectContents(el) { const s = getSelection(), r = document.createRange(); r.selectNodeContents(el); s.removeAllRanges(); s.addRange(r); }

  // ------------------------------------------------------------------------------------------------------------------------------
  // Tab capture: the pixels the screen really shows, compared between box A and box B
  const cap = { stream: null, track: null, video: null, scratch: null, sctx: null, calib: null, sync: 0, syncEl: null };
  const captureActive = () => report.capture.state === 'active' && cap.track && cap.track.readyState === 'live';

  function captureSupport() {
    const md = navigator.mediaDevices;
    if (!md || !md.getDisplayMedia) return { supported: false, reason: 'this browser has no screen capture API for web pages (phones and tablets, older browsers)' };
    const chromium = !!(navigator.userAgentData && navigator.userAgentData.brands && navigator.userAgentData.brands.some((b) => /Chromium/.test(b.brand)));
    if (!chromium) return { supported: false, reason: 'only Chrome and Edge can capture just the current tab; Firefox and Safari share a whole window or screen, which this test does not ask for' };
    if (navigator.userAgentData.mobile) return { supported: false, reason: 'tab capture is not available on phones and tablets' };
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return { supported: false, reason: 'requestVideoFrameCallback is missing' };
    return { supported: true, reason: null };
  }

  async function startCapture() {
    // Without a size limit Chrome scales the tab down (to 800 px wide); a limit at the tab's own size can still scale it by a pixel or two.
    // A limit far above it (4096) makes Chrome render the tab at a higher device pixel ratio while it is captured, which would test another
    // ratio than the tester's. 10 % above the tab's own device pixels gives the tab unscaled (measured in Chrome 155); the calibration checks it.
    const dprBefore = devicePixelRatio, maxW = Math.ceil(innerWidth * devicePixelRatio * 1.1), maxH = Math.ceil(Math.max(screen.height, outerHeight, innerHeight) * devicePixelRatio * 1.1);
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60 }, width: { max: maxW }, height: { max: maxH }, cursor: 'never' },
      audio: false, preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude', systemAudio: 'exclude',
    });
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    report.capture.requested = { maxWidth: maxW, maxHeight: maxH, devicePixelRatio: dprBefore };
    report.capture.settings = { displaySurface: settings.displaySurface ?? null, width: settings.width, height: settings.height, frameRate: settings.frameRate, resizeMode: settings.resizeMode ?? null, logicalSurface: settings.logicalSurface ?? null };
    if (settings.displaySurface && settings.displaySurface !== 'browser') {
      stream.getTracks().forEach((t) => t.stop());
      report.capture.state = 'wrong-surface';
      return false;
    }
    cap.stream = stream; cap.track = track;
    track.addEventListener('ended', () => { if (report.capture.state === 'active') { report.capture.state = 'ended-by-user'; report.capture.endedAt = new Date().toISOString(); } });
    const video = document.createElement('video');
    video.id = 'ft-video'; video.muted = true; video.playsInline = true; video.srcObject = stream;
    document.body.append(video);
    await video.play();
    cap.video = video;
    cap.scratch = document.createElement('canvas');
    cap.sctx = cap.scratch.getContext('2d', { willReadFrequently: true });
    const sync = document.createElement('div'); sync.id = 'ft-sync'; document.body.append(sync); cap.syncEl = sync;
    report.capture.state = 'active';
    await onVideoFrame(() => true, 3000);
    await sleep(300);
    report.capture.devicePixelRatioDuringCapture = devicePixelRatio;
    if (devicePixelRatio !== dprBefore) check('capture.dpr', 'warn', `the capture changed the page's device pixel ratio from ${dprBefore} to ${devicePixelRatio}: the comparisons ran at the capture's ratio`);
    try {
      const reader = new MediaStreamTrackProcessor({ track: track.clone() }).readable.getReader();
      const { value } = await Promise.race([reader.read(), sleep(1500).then(() => ({}))]);
      if (value) { report.capture.frameFormat = value.format; value.close(); }
      reader.cancel().catch(() => {});
    } catch { report.capture.frameFormat = report.capture.frameFormat ?? null; }
    return true;
  }
  function stopCapture() {
    if (cap.stream) cap.stream.getTracks().forEach((t) => t.stop());
    if (report.capture.state === 'active') report.capture.state = 'stopped';
    cap.video?.remove(); cap.syncEl?.remove();
    cap.stream = cap.track = cap.video = null;
  }
  /** run fn(meta, now) inside the next video frame callback (the frame stays current there); null after the timeout */
  function onVideoFrame(fn, timeout = 1000) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeout);
      cap.video.requestVideoFrameCallback((now, meta) => {
        if (done) return; done = true; clearTimeout(timer);
        try { resolve(fn(meta, now)); } catch (e) { recordError('video frame', e); resolve(null); }
      });
    });
  }
  function readFrame(fx, fy, fw, fh) {
    const v = cap.video, w = Math.max(1, Math.round(fw)), h = Math.max(1, Math.round(fh));
    if (cap.scratch.width < w || cap.scratch.height < h) { cap.scratch.width = Math.max(cap.scratch.width, w); cap.scratch.height = Math.max(cap.scratch.height, h); }
    cap.sctx.clearRect(0, 0, w, h);
    cap.sctx.drawImage(v, Math.round(fx), Math.round(fy), w, h, 0, 0, w, h);
    return cap.sctx.getImageData(0, 0, w, h);
  }
  const calibKey = () => `${innerWidth}x${innerHeight}@${devicePixelRatio}|${cap.video?.videoWidth}x${cap.video?.videoHeight}`;

  /** a white card with four black squares at known CSS positions: their centroids in the frame give the CSS-to-frame mapping */
  async function calibrate() {
    const overlay = document.createElement('div'); overlay.id = 'ft-calib';
    const S = 16, M = 24, W = document.documentElement.clientWidth, Hh = document.documentElement.clientHeight;
    const marks = [[M, M], [W - M - S, M], [M, Hh - M - S], [W - M - S, Hh - M - S]];
    for (const [x, y] of marks) { const i = document.createElement('i'); i.style.left = x + 'px'; i.style.top = y + 'px'; overlay.append(i); }
    cap.syncEl.style.visibility = 'hidden';
    document.body.append(overlay);
    const t0 = performance.now();
    let result = null;
    try {
      await frames(3);
      for (let attempt = 0; attempt < 8 && !result; attempt++) {
        // the capture delivers a frame only when the tab changes: a 1-level change of the card forces one
        overlay.style.background = attempt % 2 ? '#fff' : '#fefefe';
        result = await onVideoFrame(() => analyseCalibration(marks.map(([x, y]) => [x + S / 2, y + S / 2]), S), 1500);
        if (result && !result.ok) { cap.lastCalibFailure = result; result = null; }
      }
    } finally { overlay.remove(); cap.syncEl.style.visibility = ''; }
    const out = result ? { ...result, key: calibKey(), ms: round(performance.now() - t0, 0), at: new Date().toISOString() } : { ok: false, key: calibKey(), failure: cap.lastCalibFailure ?? 'no frame' };
    cap.calib = result ? out : null;
    (report.capture.calibrations ||= []).push(Object.fromEntries(Object.entries(out).filter(([k]) => k !== 'key')));
    if (report.capture.calibrations.length > 12) report.capture.calibrations.splice(1, 1);
    return out;
  }
  function analyseCalibration(centers, S) {
    const v = cap.video, fw = v.videoWidth, fh = v.videoHeight;
    if (!fw || !fh) return { ok: false, reason: 'empty frame' };
    const img = readFrame(0, 0, fw, fh), d = img.data;
    let light = 0;
    for (let i = 0; i < d.length; i += 4) if ((d[i] * 3 + d[i + 1] * 6 + d[i + 2]) / 10 > 200) light++;
    const lightShare = light / (fw * fh);
    // dark pixels in a window around where each square should be (the frame edges are left out: a capture can carry a dark line there)
    const scaleGuess = fw / document.documentElement.clientWidth, scaleGuessY = fh / document.documentElement.clientHeight, expected = (S * scaleGuess) ** 2;
    const half = (S / 2 + 18) * Math.max(scaleGuess, scaleGuessY);
    const q = centers.map(([cx, cy]) => {
      const m = { n: 0, sx: 0, sy: 0 };
      const x0 = Math.max(0, Math.floor(cx * scaleGuess - half)), x1 = Math.min(fw, Math.ceil(cx * scaleGuess + half));
      const y0 = Math.max(0, Math.floor(cy * scaleGuessY - half)), y1 = Math.min(fh, Math.ceil(cy * scaleGuessY + half));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * fw + x) * 4;
        if ((d[i] * 3 + d[i + 1] * 6 + d[i + 2]) / 10 < 90) { m.n++; m.sx += x; m.sy += y; }
      }
      return m;
    });
    const found = q.map((m) => (m.n ? [m.sx / m.n, m.sy / m.n] : null));
    const counts = q.map((m) => m.n);
    if (lightShare < 0.9 || found.some((f, k) => !f || counts[k] < expected * 0.3 || counts[k] > expected * 3)) return { ok: false, reason: 'markers not found', lightShare: round(lightShare, 3), counts, expected: round(expected, 0), frame: [fw, fh] };
    const fit = (axis) => { // least squares frame = o + s * css
      const xs = centers.map((c) => c[axis]), ys = found.map((f) => f[axis]);
      const mx = xs.reduce((a, b) => a + b) / 4, my = ys.reduce((a, b) => a + b) / 4;
      let num = 0, den = 0; for (let k = 0; k < 4; k++) { num += (xs[k] - mx) * (ys[k] - my); den += (xs[k] - mx) ** 2; }
      const s = num / den; return { s, o: my - s * mx };
    };
    const fx = fit(0), fy = fit(1);
    const residual = Math.max(...centers.map((c, k) => Math.max(Math.abs(fx.o + fx.s * c[0] - found[k][0]), Math.abs(fy.o + fy.s * c[1] - found[k][1]))));
    const ok = residual < Math.max(1.5, fx.s) && fx.s > 0.2 && fy.s > 0.2;
    return { ok, reason: ok ? null : 'markers do not fit one scale', scaleX: round(fx.s, 4), scaleY: round(fy.s, 4), offsetX: round(fx.o, 2), offsetY: round(fy.o, 2),
      residualFramePx: round(residual, 2), devicePixelRatio, frame: [fw, fh], viewport: [document.documentElement.clientWidth, document.documentElement.clientHeight], lightShare: round(lightShare, 3) };
  }
  async function ensureCalibrated() {
    if (!captureActive()) return false;
    if (cap.calib && cap.calib.key === calibKey()) return true;
    const c = await calibrate();
    return c.ok;
  }
  const toFrame = (r) => {
    const c = cap.calib;
    const x0 = Math.round(c.offsetX + c.scaleX * r.x), y0 = Math.round(c.offsetY + c.scaleY * r.y);
    return { x: x0, y: y0, w: Math.round(c.scaleX * r.w), h: Math.round(c.scaleY * r.h) };
  };
  /** flip the frame marker and return when a captured frame shows it: everything the page changed before is in that frame */
  async function freshFrame(fn) {
    cap.sync ^= 1;
    cap.syncEl.style.background = cap.sync ? '#fff' : '#000';
    const want = cap.sync ? 255 : 0;
    const sr = toFrame(inflate(rectOf(cap.syncEl), -1.5));
    const deadline = performance.now() + 4000;
    while (performance.now() < deadline) {
      const out = await onVideoFrame((meta, now) => {
        const px = readFrame(sr.x, sr.y, Math.max(1, sr.w), Math.max(1, sr.h)).data;
        const lum = (px[0] + px[1] + px[2]) / 3;
        return Math.abs(lum - want) < 70 ? { value: fn(meta, now) } : null;
      }, 1000);
      if (out) return out.value;
    }
    throw new Error('the capture delivered no frame with the frame marker within 4 s');
  }
  /** crop of an element's content box from a fresh frame; `margin` extra frame px around it */
  async function grab(el, margin = 0, inset = 1) {
    for (let attempt = 0; ; attempt++) {
      const r = toFrame(contentRect(el));
      const x = r.x + inset - margin, y = r.y + inset - margin, w = r.w - 2 * inset + 2 * margin, h = r.h - 2 * inset + 2 * margin;
      try { return await freshFrame(() => readFrame(x, y, w, h)); } catch (e) {
        if (attempt || !captureActive()) throw e;
        report.capture.retries = (report.capture.retries || 0) + 1;
        cap.calib = null; if (!(await ensureCalibrated())) throw e; // the mapping may have changed: calibrate again once
      }
    }
  }
  /** the capture pixels of box A against box B (B grabbed with a margin for the shift search) */
  function comparePair(canvasImg, twinImg, margin) {
    if (!canvasImg || !twinImg) return null;
    const w = Math.min(canvasImg.width, twinImg.width - 2 * margin), h = Math.min(canvasImg.height, twinImg.height - 2 * margin);
    const a = canvasImg.width === w && canvasImg.height === h ? canvasImg : cropImage(canvasImg, 0, 0, w, h);
    const r = compareShifted(a, twinImg, margin);
    return { ...r, sizeFramePx: [w, h], twinStats: imageStats(twinImg), canvasStats: imageStats(a) };
  }
  function cropImage(img, x, y, w, h) {
    const out = new ImageData(w, h);
    for (let r = 0; r < h; r++) out.data.set(img.data.subarray(((y + r) * img.width + x) * 4, ((y + r) * img.width + x + w) * 4), r * w * 4);
    return out;
  }

  /** per captured frame, a hash of each region (for update rates and latencies seen on screen) until stop() */
  function watchRegions(regions) {
    const log = []; let running = true, clock = null;
    const rects = regions.map((el) => toFrame(inflate(contentRect(el), -2)));
    const loop = () => {
      if (!running || !captureActive()) return;
      cap.video.requestVideoFrameCallback((now, meta) => {
        if (!running) return;
        // captureTime is the capture moment on the page's clock where the browser provides it in that time base; otherwise the callback time
        const ct = meta.captureTime, useCapture = typeof ct === 'number' && ct > 0 && ct <= now && now - ct < 1000;
        const t = useCapture ? ct : now;
        clock ||= useCapture ? 'captureTime' : 'callback';
        if (!useCapture && typeof ct === 'number') clock = 'callback (captureTime not on the page clock)';
        log.push({ t, h: rects.map((r) => hashImage(readFrame(r.x, r.y, r.w, r.h), 2)) });
        loop();
      });
    };
    loop();
    const cssAtStart = regions.map((el) => JSON.stringify(contentRect(el)));
    return { stop() { running = false; return { log, clock: clock || 'none', rects, layoutMoved: regions.some((el, k) => JSON.stringify(contentRect(el)) !== cssAtStart[k]) }; } };
  }
  /** times at which region k changed in a watch log */
  function changeTimes(log, k) { const out = []; for (let i = 1; i < log.length; i++) if (log[i].h[k] !== log[i - 1].h[k]) out.push(log[i].t); return out; }

  // ------------------------------------------------------------------------------------------------------------------------------
  // Picture scenarios: the same state in box A and box B, compared on screen (with the capture) and checked in the canvas itself
  const SCENARIOS = {
    rest: { pair: 'sample', title: 'form at rest', roi: (p, side) => p.side(side, '.ft-sample'), setup: () => { blurActive(); clearSelection(); } },
    focus: { pair: 'sample', title: 'focused text field (focus ring)', roi: (p, side) => p.side(side, '.ft-input'), roiInflate: 4,
      setup: (p, side) => { clearSelection(); const i = p.side(side, '.ft-input'); i.focus({ preventScroll: true }); i.setSelectionRange(i.value.length, i.value.length); } },
    'select-input': { pair: 'sample', title: "the word 'Canvas' selected inside a text field", roi: (p, side) => p.side(side, '.ft-input'), selection: true,
      setup: (p, side) => { const i = p.side(side, '.ft-input'); i.focus({ preventScroll: true }); const at = i.value.indexOf('Canvas'); i.setSelectionRange(at, at + 6); } },
    'select-text': { pair: 'sample', title: "the word 'Canvas' selected in static text", roi: (p, side) => p.side(side, '.ft-word'), roiInflate: 2, selection: true,
      setup: (p, side) => { blurActive(); selectContents(p.side(side, '.ft-word')); } },
    typed: { pair: 'sample', title: 'the typed text', roi: (p, side) => p.side(side, '.ft-type'), setup: () => { blurActive(); clearSelection(); } },
    scroller: { pair: 'scroll', title: 'scroll box with its scrollbar', roi: (p, side) => p.side(side, '.ft-scroller'),
      setup: (p) => { blurActive(); clearSelection(); for (const root of [p.source, p.twin, p.ghost]) root.querySelector('.ft-scroller').scrollTop = 60; } },
    'scroll-end': { pair: 'scroll', title: 'scroll box where your scrolling stopped', roi: (p, side) => p.side(side, '.ft-scroller'),
      setup: () => { blurActive(); clearSelection(); } },
  };

  async function runScenario(id, prefix = 'picture', signal = { aborted: false }) {
    const sc = SCENARIOS[id], p = pairs[sc.pair], key = `${prefix}.${id}`;
    const out = { title: sc.title, windowFocused: document.hasFocus(), devicePixelRatio };
    if (!p.ctx) { out.skipped = 'the canvas is not drawn (no HTML-in-Canvas API here)'; check(key, 'skipped', `${sc.title}: no HTML-in-Canvas API, nothing to compare`); return out; }
    bringIntoView(p.canvas.closest('.pair'));
    out.fractionalDevicePx = snapToDevicePixels();
    p.source.classList.add('ft-nocaret'); p.ghost.classList.add('ft-nocaret');
    try {
      SCENARIOS.rest.setup(p, 'canvas');
      let t = performance.now(); await sleep(30); await waitPaint(p, t - 1, 400);
      const roiRect = () => inflate(rectOf(sc.roi(p, 'canvas')), sc.roiInflate || 0);
      const beforeRoi = readCanvas(p, roiRect());
      // box A
      // overlay scrollbars show a thumb for about a second after a scroll; both pictures are taken after it faded
      const settle = sc.pair === 'scroll' && overlayScrollbars() ? 1600 : 0;
      t = performance.now();
      sc.setup(p, 'canvas');
      out.painted = await waitPaint(p, t);
      if (settle) { await sleep(settle); await waitPaint(p, performance.now(), 300); }
      if (signal.aborted) return out;
      const full = readCanvas(p);
      const afterRoi = readCanvas(p, roiRect());
      out.canvas = { backingStore: [p.canvas.width, p.canvas.height], cssBox: [p.canvas.clientWidth, p.canvas.clientHeight], paints: p.paints, paintError: p.paintError, readError: p.readError ?? null };
      if (full) out.canvas.stats = imageStats(full);
      if (id !== 'rest' && id !== 'scroll-end' && id !== 'typed') out.canvas.roiChangedPct = changedShare(beforeRoi, afterRoi);
      if (sc.selection) out.canvas.selectionColours = selectionColours(beforeRoi, afterRoi);
      let capA = null, capB = null, capBefore = null;
      const capture = await ensureCalibrated().catch((e) => { recordError('calibrate', e); return false; });
      if (capture) {
        const margin = 2;
        capA = await grab(p.canvas, 0);
        // box B in the same state, on the hidden copy over box A (one selection and one focus per document: B is set up after A was grabbed)
        p.syncGhost();
        p.ghostBox.style.visibility = 'visible';
        try {
          if (sc.selection) { SCENARIOS.rest.setup(p, 'twin'); await frames(2); capBefore = await grab(p.ghostBox, margin); }
          sc.setup(p, 'twin'); await frames(3);
          if (settle) await sleep(settle);
          capB = await grab(p.ghostBox, margin);
        } finally { p.ghostBox.style.visibility = ''; }
        const cmp = comparePair(capA, capB, margin);
        if (cmp) {
          const { map, ...numbers } = cmp;
          out.capture = numbers;
          if (sc.selection && capBefore) {
            // the selection region inside the grabbed picture of box B (which starts 1 px inside its content box, minus the margin)
            const roiB = inflate(rectOf(sc.roi(p, 'twin')), sc.roiInflate || 0), box = contentRect(p.ghostBox);
            const fx = Math.max(0, Math.round(cap.calib.scaleX * (roiB.x - box.x)) - 1 + margin), fy = Math.max(0, Math.round(cap.calib.scaleY * (roiB.y - box.y)) - 1 + margin);
            const fw = Math.min(Math.round(cap.calib.scaleX * roiB.w), capB.width - fx), fh = Math.min(Math.round(cap.calib.scaleY * roiB.h), capB.height - fy);
            if (fw > 0 && fh > 0) out.capture.twinSelectionColours = selectionColours(cropImage(capBefore, fx, fy, fw, fh), cropImage(capB, fx, fy, fw, fh));
          }
          const prio = cmp.verdict === 'fail' ? 3 : cmp.verdict === 'warn' ? 2 : 1;
          out.crops = [addCrop(`${key}.canvas`, capA, prio), addCrop(`${key}.plain`, cropImage(capB, margin + cmp.shiftFramePx.dx, margin + cmp.shiftFramePx.dy, cmp.sizeFramePx[0], cmp.sizeFramePx[1]), prio), cmp.verdict !== 'pass' ? addCrop(`${key}.diff`, map, prio) : null].filter(Boolean);
          const blankTwin = !cmp.twinStats.nonBlank;
          check(key, blankTwin ? 'error' : cmp.verdict,
            blankTwin ? `${sc.title}: the capture of box B is blank, so the comparison is not valid` : `${sc.title}: ${cmp.over16Pct} % of the pixels of box A differ from box B by more than 16 levels (${cmp.over100Pct} % by more than 100), shift ${cmp.shiftFramePx.dx},${cmp.shiftFramePx.dy} frame px`,
            { over16Pct: cmp.over16Pct, over100Pct: cmp.over100Pct, maxDelta: cmp.maxDelta, shift: cmp.shiftFramePx });
        } else check(key, 'error', `${sc.title}: the captured pictures could not be compared`);
      } else {
        out.capture = null;
        out.crops = [addCrop(`${key}.canvas-backing-store`, id === 'rest' || id === 'scroller' || id === 'typed' ? full : readCanvas(p, inflate(roiRect(), 12)), 0)].filter(Boolean);
        const blank = full ? !imageStats(full).nonBlank : true;
        const changed = out.canvas.roiChangedPct;
        let verdict = blank ? 'fail' : 'info', text = blank ? `${sc.title}: the canvas is blank` : `${sc.title}: the canvas is drawn (no tab capture, so it was not compared with the plain page)`;
        if (!blank && changed != null && (id === 'focus' || sc.selection || id === 'scroller')) {
          verdict = changed > 0.5 ? 'info' : 'fail';
          text = changed > 0.5 ? `${sc.title}: the canvas shows the change (${changed} % of the region changed; not compared with the plain page without the tab capture)` : `${sc.title}: the canvas did not change (${changed} % of the region)`;
        }
        check(key, verdict, text, { roiChangedPct: changed ?? null });
      }
      if (sc.pair === 'scroll') out.scrollTop = { canvas: p.source.querySelector('.ft-scroller').scrollTop, plain: p.ghost.querySelector('.ft-scroller').scrollTop };
      return out;
    } finally {
      p.source.classList.remove('ft-nocaret'); p.ghost.classList.remove('ft-nocaret');
      blurActive(); clearSelection();
    }
  }

  // ------------------------------------------------------------------------------------------------------------------------------
  // The guided steps
  const ui = {
    show({ meta, title, html, buttons = [] }) {
      $('ft-step-meta').textContent = meta || '';
      $('ft-step-title').textContent = title;
      $('ft-step-text').innerHTML = html || '';
      const box = $('ft-step-buttons'); box.textContent = '';
      const all = this.onSkip ? [...buttons, { id: 'skip', label: 'Skip this step', onClick: this.onSkip }] : buttons;
      for (const b of all) {
        const el = document.createElement('button');
        el.type = 'button'; el.className = 'ft' + (b.primary ? '' : ' secondary'); el.textContent = b.label; el.dataset.action = b.id || '';
        if (b.disabled) el.disabled = true;
        el.addEventListener('click', b.onClick);
        box.append(el);
      }
      this.status(''); this.meter(null);
    },
    button(id) { return /** @type {HTMLButtonElement|null} */ (document.querySelector(`#ft-step-buttons [data-action="${id}"]`)); },
    status(text) { $('ft-status').textContent = text; },
    meter(fraction) { const m = $('ft-meter'); m.hidden = fraction == null; if (fraction != null) /** @type {HTMLElement} */ (m.firstElementChild).style.width = Math.round(Math.min(1, fraction) * 100) + '%'; },
    progress() {
      const box = $('ft-progress'); box.textContent = '';
      for (const s of STEPS) {
        const rec = report.steps[s.id], span = document.createElement('span');
        if (s.id === state.current) span.className = 'current'; else if (rec && rec.status === 'done') span.className = 'done'; else if (rec && (rec.status === 'skipped' || rec.status === 'error')) span.className = 'skipped';
        box.append(span);
      }
    },
  };
  const state = { current: null, initialDpr: devicePixelRatio, finished: false };
  const pointerWord = () => (coarse() ? 'finger' : 'pointer');

  const STEPS = [
    {
      id: 'welcome', title: 'Welcome', skippable: false,
      async run(rec, ctx) {
        ui.show({ meta: ctx.meta, title: 'Welcome, and thank you for helping', html: `
          <p>The test has a few short steps: it looks at your browser's settings, compares two boxes that should look the same, and asks you to type, scroll and zoom.
          At the end you download one file and send it to us. You can skip any step.</p>
          <p class="privacy"><strong>What the file contains</strong> (nothing is sent anywhere by this page; you decide whether to send the file):</p>
          <ul class="privacy">${report.collected.map((c) => `<li>${c}</li>`).join('')}</ul>
          <p class="privacy">It contains no name, no account, no location and no history, and nothing outside this tab.</p>`,
          buttons: [{ id: 'start', label: 'Start the test', primary: true, onClick: () => ctx.next() }] });
        await ctx.wait();
        ui.show({ meta: ctx.meta, title: 'Reading your browser settings', html: '<p>This takes a few seconds.</p>' });
        ui.status('Reading the screen, colours, fonts and graphics adapter...');
        report.environment = await collectEnvironment();
        report.polyfill = polyfillInfo();
        rec.results = { polyfillMode: report.polyfill.mode, refused: report.polyfill.refused };
        if (report.polyfill.refused) check('polyfill.install', 'fail', `the polyfill refused this browser: ${report.polyfill.refused.message}`);
        else if (!report.polyfill.scriptLoaded) check('polyfill.install', 'fail', 'the polyfill script did not load');
        else check('polyfill.install', 'info', `HTML-in-Canvas mode: ${report.polyfill.mode}`);
        const webgpu = report.environment.webgpu;
        check('environment.webgpu', webgpu && webgpu.available ? 'info' : 'warn', webgpu && webgpu.available ? `WebGPU adapter: ${[webgpu.info.vendor, webgpu.info.architecture, webgpu.info.description].filter(Boolean).join(' ') || 'available'}` : `no WebGPU: ${webgpu && (webgpu.reason || webgpu.error)}`);
        return 'done';
      },
    },
    {
      id: 'capture', title: 'Screen capture', skippable: true,
      async run(rec, ctx) {
        const support = captureSupport();
        report.capture.supported = support.supported;
        report.capture.reason = support.reason;
        if (!support.supported) {
          report.capture.state = 'unsupported';
          ui.show({ meta: ctx.meta, title: 'Screen capture is not available here', html: `<p>To compare the boxes exactly as your screen shows them, the test would take pictures of this tab, but this browser cannot: ${support.reason}.</p>
            <p>That is fine: the test continues with the checks that do not need it.</p>`, buttons: [{ id: 'continue', label: 'Continue', primary: true, onClick: () => ctx.next() }] });
          await ctx.wait();
          return 'done';
        }
        ui.show({ meta: ctx.meta, title: 'Allow a capture of this tab', html: `<p>The test compares box A and box B exactly as your screen shows them. For that it needs to take pictures of <strong>this tab</strong>.</p>
          <p>Press <strong>Allow capture</strong>. Your browser then asks what to share: choose <strong>this tab</strong> and press <strong>Share</strong> (or <strong>Allow</strong>).
          Only small pictures of the test boxes are kept, and the capture stops at the end of the test (you can also stop it any time with the browser's "Stop sharing" button).</p>`,
          buttons: [{ id: 'allow', label: 'Allow capture', primary: true, onClick: () => ctx.next('allow') }, { id: 'decline', label: 'Continue without it', onClick: () => ctx.next('decline') }] });
        const choice = await ctx.wait();
        if (ctx.signal.aborted) { report.capture.state = 'declined'; return 'skipped'; }
        if (choice === 'decline') { report.capture.state = 'declined'; check('capture', 'info', 'tab capture declined: pixel comparisons use the canvas only'); return 'done'; }
        ui.status('Waiting for your answer in the browser dialog...');
        try {
          const ok = await startCapture();
          if (!ok) { check('capture', 'warn', 'a window or screen was shared instead of this tab: the capture was stopped'); return 'done'; }
        } catch (e) {
          report.capture.state = e && e.name === 'NotAllowedError' ? 'denied' : 'error';
          report.capture.error = errInfo(e);
          check('capture', 'info', `tab capture ${report.capture.state}: ${errInfo(e).message}`);
          return 'done';
        }
        ui.status('Capture started. Calibrating (the page flashes white for a moment)...');
        await sleep(800); // the browser's "sharing this tab" bar changes the window height
        const c = await calibrate();
        if (!c.ok) {
          stopCapture(); report.capture.state = 'calibration-failed';
          check('capture', 'warn', 'tab capture started, but the calibration marks were not found in the captured frames: the capture was stopped', { failure: c.failure });
          return 'done';
        }
        check('capture', 'info', `tab capture active: ${c.frame[0]} x ${c.frame[1]} frame px, ${c.scaleX} frame px per CSS px (device pixel ratio ${devicePixelRatio})`, { scaleX: c.scaleX, scaleY: c.scaleY, residual: c.residualFramePx });
        return 'done';
      },
    },
    {
      id: 'picture', title: 'Picture check', skippable: true,
      async run(rec, ctx) {
        ui.show({ meta: ctx.meta, title: 'Picture check', html: `<p>Please <strong>do not move the mouse or touch the keyboard</strong> for about 15 seconds.
          The page selects words, focuses a field and scrolls the grey boxes by itself${captureActive() ? ', and flashes white for a moment while it calibrates' : ''}.</p>` });
        const ids = ['rest', 'focus', 'select-input', 'select-text', 'scroller'];
        rec.results.scenarios = {};
        for (let i = 0; i < ids.length && !ctx.signal.aborted; i++) {
          ui.status(`Checking ${SCENARIOS[ids[i]].title} (${i + 1} of ${ids.length})...`); ui.meter(i / ids.length);
          try { rec.results.scenarios[ids[i]] = await runScenario(ids[i], 'picture', ctx.signal); } catch (e) { recordError('picture ' + ids[i], e); rec.results.scenarios[ids[i]] = { error: errInfo(e) }; check('picture.' + ids[i], 'error', `${SCENARIOS[ids[i]].title}: ${errInfo(e).message}`); }
        }
        ui.meter(1);
        window.scrollTo(0, 0);
        return 'done';
      },
    },
    {
      id: 'typing', title: 'Typing', skippable: true,
      async run(rec, ctx) {
        const p = pairs.sample;
        if (!p.ctx) { check('typing', 'skipped', 'no HTML-in-Canvas API: typing into the canvas cannot be measured'); return 'skipped'; }
        const target = 'hello field test';
        ui.show({ meta: ctx.meta, title: 'Typing', html: `<p>${coarse() ? 'Tap' : 'Click'} the field <strong>Typing test</strong> in <strong>box A</strong> (the canvas) and type: <strong>${target}</strong></p>
          <p>The text cursor is hidden on purpose while the test measures. Box B copies what you type.</p>`,
          buttons: [{ id: 'done', label: 'Done', primary: true, disabled: true, onClick: () => ctx.next() }] });
        bringIntoView(p.canvas.closest('.pair'));
        const input = /** @type {HTMLInputElement} */ (p.source.querySelector('.ft-type')), twinInput = /** @type {HTMLInputElement} */ (p.twin.querySelector('.ft-type'));
        input.value = ''; twinInput.value = '';
        p.source.classList.add('ft-nocaret'); p.twin.classList.add('ft-nocaret');
        const keys = [], pending = [];
        const onKey = (e) => { if (e.target !== input || !(e.key.length === 1 || e.key === 'Backspace')) return; const k = { key: e.key.length === 1 ? 'char' : e.key, t: e.timeStamp || performance.now(), frames: 0 }; keys.push(k); pending.push(k); };
        const onInput = () => { twinInput.value = input.value; };
        document.addEventListener('keydown', onKey, true);
        input.addEventListener('input', onInput);
        const capture = await ensureCalibrated().catch(() => false);
        const watch = capture ? watchRegions([input, twinInput]) : null;
        let last = readCanvas(p, rectOf(input)), lastHash = last ? hashImage(last) : 0, rafs = 0;
        const loop = async () => {
          while (!ctx.signal.aborted && !ctx.ended) {
            const t = await nextFrame(); rafs++;
            for (const k of pending) k.frames++;
            const img = readCanvas(p, rectOf(input));
            if (!img) continue;
            const h = hashImage(img);
            if (h !== lastHash) {
              lastHash = h;
              while (pending.length && pending[0].t < t) { const k = pending.shift(); k.canvasMs = round(t - k.t, 1); }
            }
            for (let i = pending.length - 1; i >= 0; i--) if (t - pending[i].t > 1500) { pending[i].canvasMs = null; pending.splice(i, 1); }
            const measured = keys.filter((k) => k.canvasMs != null).length;
            ui.status(`${measured} key presses measured${measured < 10 ? ' (at least 10 are needed)' : ''}. Typed: "${input.value}"`);
            ui.meter(measured / 10);
            const done = ui.button('done'); if (done) done.disabled = measured < 10;
            if (input.value.trim() === target && measured >= 10) { await sleep(400); ctx.next(); }
          }
        };
        const looping = loop();
        await ctx.wait();
        ctx.ended = true; await looping;
        document.removeEventListener('keydown', onKey, true);
        input.removeEventListener('input', onInput);
        p.source.classList.remove('ft-nocaret'); p.twin.classList.remove('ft-nocaret');
        if (ctx.signal.aborted) { watch?.stop(); return 'skipped'; }
        const lat = keys.map((k) => k.canvasMs).filter((v) => v != null);
        rec.results = { typed: input.value, keys: keys.length, rafs, keyToCanvasMs: summarize(lat), unchanged: keys.filter((k) => k.canvasMs === null).length,
          refreshHz: report.environment?.display?.refresh?.hz ?? null, method: 'key event time to the first animation frame whose canvas pixels under the field changed (readback)' };
        if (watch) {
          const { log, clock, layoutMoved } = watch.stop();
          const ca = changeTimes(log, 0), tw = changeTimes(log, 1);
          const firstAfter = (arr, t) => arr.find((x) => x >= t);
          const perKey = keys.map((k) => { const a = firstAfter(ca, k.t), b = firstAfter(tw, k.t); return a != null && b != null ? { canvas: a - k.t, plain: b - k.t } : null; }).filter(Boolean);
          const frameMs = log.length > 1 ? (log[log.length - 1].t - log[0].t) / (log.length - 1) : null;
          rec.results.onScreen = { clock, capturedFrames: log.length, captureFrameMs: round(frameMs, 1), keyToCanvasMs: summarize(perKey.map((x) => x.canvas)), keyToPlainMs: summarize(perKey.map((x) => x.plain)),
            canvasBehindPlainMs: summarize(perKey.map((x) => x.canvas - x.plain)), changes: { canvas: ca.length, plain: tw.length }, layoutMoved,
            timeBase: { firstKey: round(keys[0]?.t, 1), firstFrame: round(log[0]?.t, 1), lastFrame: round(log[log.length - 1]?.t, 1) }, method: 'captured frames: first frame after the key event in which box A (canvas) and box B (plain page) changed' };
        }
        const p50 = rec.results.keyToCanvasMs.p50, frame = 1000 / (rec.results.refreshHz || 60);
        if (!lat.length) check('typing', 'fail', 'typing did not change the canvas');
        else {
          const behind = rec.results.onScreen?.canvasBehindPlainMs?.p50;
          const verdict = p50 <= 4 * frame + 8 ? 'pass' : p50 <= 8 * frame + 16 ? 'warn' : 'fail';
          check('typing', verdict, `key to canvas update: median ${p50} ms, 95th percentile ${rec.results.keyToCanvasMs.p95} ms over ${lat.length} keys${behind != null ? `; on screen the canvas trails the plain page by ${round(behind, 0)} ms (median)` : ''}`, { keyToCanvasMs: rec.results.keyToCanvasMs, canvasBehindPlainMs: rec.results.onScreen?.canvasBehindPlainMs ?? null });
        }
        try { rec.results.scenario = await runScenario('typed', 'typing', ctx.signal); } catch (e) { recordError('typing typed', e); }
        return 'done';
      },
    },
    {
      id: 'scrolling', title: 'Scrolling', skippable: true,
      async run(rec, ctx) {
        const p = pairs.scroll;
        if (!p.ctx) { check('scrolling', 'skipped', 'no HTML-in-Canvas API: scrolling inside the canvas cannot be measured'); return 'skipped'; }
        const NEED = 5000;
        ui.show({ meta: ctx.meta, title: 'Scrolling', html: coarse()
          ? '<p>Swipe up and down <strong>inside the grey box of box A</strong> (the canvas) for about 5 seconds. Box B follows on its own.</p>'
          : '<p>Put the pointer over <strong>the grey box in box A</strong> (the canvas) and scroll up and down with the mouse wheel or two fingers on the touchpad, for about 5 seconds. Box B follows on its own.</p>' });
        bringIntoView(p.canvas.closest('.pair'));
        const scroller = p.source.querySelector('.ft-scroller'), twinScroller = p.twin.querySelector('.ft-scroller');
        let lastScroll = -1e9, events = 0, active = 0;
        const onScroll = (e) => { twinScroller.scrollTop = scroller.scrollTop; twinScroller.scrollLeft = scroller.scrollLeft; lastScroll = e.timeStamp || performance.now(); events++; };
        scroller.addEventListener('scroll', onScroll, { passive: true });
        const capture = await ensureCalibrated().catch(() => false);
        const band = () => { const r = contentRect(scroller); return { x: r.x, y: r.y + r.h / 3, w: r.w, h: r.h / 3 }; };
        const activeWindows = [];
        let watch = null, rafActive = 0, canvasChangesActive = 0, scrollFrames = 0, prevT = performance.now(), lastHash = 0, lastEvents = 0;
        while (!ctx.signal.aborted && active < NEED) {
          const t = await nextFrame();
          const isActive = t - lastScroll < 150;
          if (isActive) {
            if (!watch && capture) watch = watchRegions([scroller, twinScroller]);
            if (!activeWindows.length || activeWindows[activeWindows.length - 1].end < prevT - 1) activeWindows.push({ start: prevT, end: t }); else activeWindows[activeWindows.length - 1].end = t;
            active += Math.min(100, t - prevT); rafActive++;
            if (events !== lastEvents) scrollFrames++;
          }
          lastEvents = events;
          const img = readCanvas(p, band());
          const h = img ? hashImage(img, 2) : 0;
          if (h !== lastHash) { if (isActive) canvasChangesActive++; lastHash = h; }
          prevT = t;
          ui.meter(active / NEED);
          ui.status(active > 0 ? `Keep scrolling... ${Math.ceil((NEED - active) / 1000)} s` : 'Waiting for you to scroll inside the grey box of box A.');
        }
        scroller.removeEventListener('scroll', onScroll);
        if (ctx.signal.aborted) { watch?.stop(); return 'skipped'; }
        ui.status('Thank you. You can stop scrolling.');
        const activeSec = active / 1000;
        rec.results = { activeSeconds: round(activeSec, 2), scrollEvents: events, scrollEventsPerSec: round(events / activeSec, 1), framesWhileScrolling: rafActive, framesPerSec: round(rafActive / activeSec, 1),
          framesWithScroll: scrollFrames, canvasUpdatesPerSec: round(canvasChangesActive / activeSec, 1), canvasUpdatesPerScrollFrame: round(canvasChangesActive / Math.max(1, scrollFrames), 2),
          method: 'animation frames during active scrolling (a scroll event in the last 150 ms); canvas updates = frames whose canvas pixels in the middle band of the box changed (readback)' };
        if (watch) {
          const { log, clock, layoutMoved } = watch.stop();
          const inActive = (t) => activeWindows.some((w) => t >= w.start - 20 && t <= w.end + 50);
          const capFrames = log.filter((f) => inActive(f.t));
          const ca = changeTimes(log, 0).filter(inActive).length, tw = changeTimes(log, 1).filter(inActive).length;
          rec.results.onScreen = { clock, capturedFramesWhileScrolling: capFrames.length, canvasChangesPerSec: round(ca / activeSec, 1), plainChangesPerSec: round(tw / activeSec, 1), canvasToPlainRatio: tw ? round(ca / tw, 2) : null, layoutMoved,
            method: 'captured frames during active scrolling in which the box changed, box A (canvas) against box B (plain page, scrolled to the same offset)' };
        }
        const ratio = rec.results.onScreen?.canvasToPlainRatio ?? rec.results.canvasUpdatesPerScrollFrame;
        const verdict = ratio == null ? 'info' : ratio >= 0.8 ? 'pass' : ratio >= 0.5 ? 'warn' : 'fail';
        check('scrolling', verdict, rec.results.onScreen
          ? `while scrolling the canvas changed ${rec.results.onScreen.canvasChangesPerSec} times per second on screen, the plain page ${rec.results.onScreen.plainChangesPerSec} (display ${report.environment?.display?.refresh?.hz ?? '?'} Hz)`
          : `while scrolling the canvas updated ${rec.results.canvasUpdatesPerSec} times per second for ${round(rec.results.framesWithScroll / activeSec, 1)} frames per second with a scroll event`, { ratio });
        await sleep(600);
        try { rec.results.scenario = await runScenario('scroll-end', 'scrolling', ctx.signal); } catch (e) { recordError('scroll-end', e); }
        return 'done';
      },
    },
    {
      id: 'effect', title: 'Effect plugin', skippable: true,
      async run(rec, ctx) {
        const mode = report.polyfill?.mode;
        // the effects run over the polyfill and over a native implementation the installed polyfill stepped aside for (createHost rejects where they cannot)
        if (mode !== 'polyfill' && mode !== 'native' && mode !== 'native-bridged') { check('effect', 'skipped', `the effect plugins need the installed polyfill (mode here: ${mode ?? 'none'})`); return 'skipped'; }
        ui.show({ meta: ctx.meta, title: 'Effect plugin', html: '<p>Loading the effect...</p>' });
        $('ft-effect-pair').hidden = false;
        const pair = pairs.effect || makePair('effect', 'ft-effect-template');
        bringIntoView(pair.canvas.closest('.pair'));
        await frames(3);
        rec.results = { webgpu: report.environment?.webgpu?.available ?? null };
        let host = null, effectFrames = 0, errors = [], pointer = 0;
        const onFrame = () => { effectFrames++; };
        const onError = (e) => { errors.push(String(e.detail?.error?.message ?? e.detail?.error ?? 'effect error').slice(0, 300)); };
        const onMove = () => { pointer++; };
        try {
          await loadScript('../../dist/hic-live-effects.iife.min.js');
          await loadScript('../../dist/plugins/water.iife.min.js');
          if (!navigator.gpu) throw Object.assign(new Error('this browser has no WebGPU'), { name: 'NoWebGPU' });
          host = await window.HTMLInCanvasEffects.createHost(pair.canvas, pair.source);
          await host.addPlugin(window.HicLivePlugins.water.plugin, { intensity: 0.3 });
          rec.results.path = 'effect';
        } catch (e) {
          rec.results.path = '2d';
          rec.results.fallbackReason = errInfo(e).message;
          try {
            const c2 = pair.canvas.getContext('2d');
            if (c2) { pair.ctx = c2; pair.canvas.onpaint = () => { c2.reset ? c2.reset() : c2.clearRect(0, 0, pair.canvas.width, pair.canvas.height); c2.drawElementImage(pair.source, 0, 0); pair.lastPaint = performance.now(); }; sizeCanvas(pair.canvas); pair.canvas.requestPaint?.(); }
          } catch (e2) { recordError('effect 2d fallback', e2); }
        }
        pair.canvas.addEventListener('effectframe', onFrame); pair.canvas.addEventListener('effecterror', onError); pair.source.addEventListener('pointermove', onMove);
        ui.show({ meta: ctx.meta, title: 'Effect plugin', html: rec.results.path === 'effect'
          ? `<p>Move your ${pointerWord()} over the dark box with the water ripples for a few seconds.</p>`
          : `<p>The water effect cannot run here (${rec.results.fallbackReason}); the box is drawn without it. Please wait a few seconds.</p>` });
        const DURATION = 6000, t0 = performance.now(); let rafs = 0;
        const capture = await ensureCalibrated().catch(() => false);
        const watch = capture ? watchRegions([pair.canvas]) : null;
        while (!ctx.signal.aborted && performance.now() - t0 < DURATION) { await nextFrame(); rafs++; ui.meter((performance.now() - t0) / DURATION); }
        if (ctx.signal.aborted) {
          watch?.stop(); pair.canvas.removeEventListener('effectframe', onFrame); pair.canvas.removeEventListener('effecterror', onError); pair.source.removeEventListener('pointermove', onMove);
          try { host?.destroy(); } catch (e) { recordError('effect destroy', e); }
          $('ft-effect-pair').hidden = true;
          return 'skipped';
        }
        const secs = (performance.now() - t0) / 1000;
        rec.results.seconds = round(secs, 2);
        rec.results.framesPerSec = round(rafs / secs, 1);
        rec.results.effectFramesPerSec = rec.results.path === 'effect' ? round(effectFrames / secs, 1) : null;
        rec.results.pointerMoves = pointer;
        rec.results.errors = errors;
        try { rec.results.hostStats = host ? JSON.parse(JSON.stringify(host.stats())) : null; } catch (e) { rec.results.hostStatsError = errInfo(e).message; }
        if (watch) {
          const { log } = watch.stop();
          rec.results.onScreen = { capturedFrames: log.length, changesPerSec: round(changeTimes(log, 0).length / secs, 1) };
          try { const img = await grab(pair.canvas); rec.results.onScreen.stats = imageStats(img); addCrop('effect.canvas', img, 1); } catch (e) { recordError('effect grab', e); }
        }
        pair.canvas.removeEventListener('effectframe', onFrame); pair.canvas.removeEventListener('effecterror', onError); pair.source.removeEventListener('pointermove', onMove);
        try { host?.destroy(); } catch (e) { recordError('effect destroy', e); }
        $('ft-effect-pair').hidden = true;
        if (rec.results.path !== 'effect') check('effect', rec.results.webgpu ? 'fail' : 'warn', `the water effect did not run: ${rec.results.fallbackReason}`);
        else if (errors.length) check('effect', 'fail', `the water effect reported errors: ${errors[0]}`);
        else {
          const fps = rec.results.effectFramesPerSec;
          check('effect', fps >= 0.8 * rec.results.framesPerSec || fps >= 50 ? 'pass' : fps >= 24 ? 'warn' : 'fail', `water effect: ${fps} effect frames per second, ${rec.results.framesPerSec} animation frames per second`, { effectFramesPerSec: fps, framesPerSec: rec.results.framesPerSec });
        }
        return 'done';
      },
    },
    {
      id: 'zoom', title: 'Browser zoom', skippable: true,
      async run(rec, ctx) {
        if (coarse()) { check('zoom', 'skipped', 'zoom step skipped on a touch screen (pinch zoom does not change the page zoom)'); return 'skipped'; }
        if (!pairs.sample.ctx) { check('zoom', 'skipped', 'no HTML-in-Canvas API'); return 'skipped'; }
        const mac = /Mac/.test(navigator.platform), mod = mac ? 'Cmd' : 'Ctrl';
        const base = devicePixelRatio;
        rec.results = { baseDevicePixelRatio: base };
        ui.show({ meta: ctx.meta, title: 'Browser zoom', html: `<p>Press <strong>${mod}</strong> and <strong>+</strong> together, twice, so that the page zoom is <strong>125 %</strong> (the browser shows the zoom level near the address bar). Then wait a moment.</p>` });
        const stable = async (pred) => { let since = null; while (!ctx.signal.aborted) { await sleep(150); if (pred()) { since ??= performance.now(); if (performance.now() - since > 900) return true; } else since = null; } return false; };
        if (!(await stable(() => Math.abs(devicePixelRatio / base - 1) > 0.04))) return 'skipped';
        rec.results.zoomedDevicePixelRatio = devicePixelRatio;
        rec.results.zoomPercent = round(100 * devicePixelRatio / base, 0);
        ui.status(`Zoom ${rec.results.zoomPercent} % detected. Measuring, please do not touch anything...`);
        await sleep(500);
        rec.results.scenarios = {};
        for (const id of ['rest', 'select-input', 'select-text', 'scroller']) {
          if (ctx.signal.aborted) break;
          try { rec.results.scenarios[id] = await runScenario(id, 'zoom', ctx.signal); } catch (e) { recordError('zoom ' + id, e); check('zoom.' + id, 'error', errInfo(e).message); }
        }
        window.scrollTo(0, 0);
        ui.show({ meta: ctx.meta, title: 'Browser zoom', html: `<p>Done. Now press <strong>${mod}</strong> and <strong>0</strong> (zero) together to set the zoom back to 100 %.</p>`,
          buttons: [{ id: 'continue', label: 'Continue', primary: true, onClick: () => ctx.next() }] });
        await Promise.race([stable(() => Math.abs(devicePixelRatio / base - 1) <= 0.04), ctx.wait()]);
        rec.results.restored = Math.abs(devicePixelRatio / base - 1) <= 0.04;
        return 'done';
      },
    },
    {
      id: 'finish', title: 'Download the report', skippable: false,
      async run(rec, ctx) {
        stopCapture();
        state.finished = true;
        const r = buildReport();
        const counts = r.summary.verdicts;
        const rows = r.checks.map((c) => `<tr><td class="v-${c.verdict}">${c.verdict}</td><td>${escapeHtml(c.text)}</td></tr>`).join('');
        ui.show({ meta: ctx.meta, title: 'Thank you! Please download the report', html: `
          <p>Results on this device: ${counts.pass} passed, ${counts.warn} ${counts.warn === 1 ? 'warning' : 'warnings'}, ${counts.fail} failed, ${counts.skipped} skipped.</p>
          <p><strong>What to do next:</strong> press <strong>Download report</strong>, then send us the file <code>${escapeHtml(fileName())}</code>:</p>
          <ul><li>open a <a href="${ISSUE_URL}" target="_blank" rel="noopener">new issue on GitHub</a>, write which device you used, and drag the file into the comment box; or</li>
          <li>send the file to the person who asked you to run this test.</li></ul>
          <details><summary>Show the results</summary><table class="results">${rows}</table></details>`,
          buttons: [{ id: 'download', label: 'Download report', primary: true, onClick: () => download() }, { id: 'copy', label: 'Copy report', onClick: () => copyReport() }, { id: 'again', label: 'Run again', onClick: () => location.reload() }] });
        rec.results = { checks: report.checks.length };
        return 'done';
      },
    },
  ];
  const STEP_IDS = STEPS.map((s) => s.id);

  async function runAll() {
    for (let i = 0; i < STEPS.length; i++) {
      const step = STEPS[i];
      const rec = report.steps[step.id] = { status: 'running', startedAt: new Date().toISOString(), durationMs: null, results: {} };
      state.current = step.id; ui.progress();
      const t0 = performance.now();
      let resolveWait = null;
      const signal = { aborted: false };
      const ctx = {
        meta: `Step ${i + 1} of ${STEPS.length}: ${step.title}`, signal, ended: false,
        wait: () => new Promise((r) => { resolveWait = r; }),
        next: (v) => { const r = resolveWait; resolveWait = null; if (r) r(v); },
      };
      let skip = null;
      const skipped = new Promise((r) => { skip = r; });
      ui.onSkip = step.skippable ? () => { signal.aborted = true; ctx.next('skip'); skip('skipped'); } : null;
      try {
        const out = await Promise.race([step.run(rec, ctx), skipped]);
        rec.status = out === 'skipped' || signal.aborted ? 'skipped' : 'done';
      } catch (e) {
        rec.status = 'error'; rec.error = errInfo(e); recordError('step ' + step.id, e);
        check('step.' + step.id, 'error', `the ${step.title.toLowerCase()} step failed: ${errInfo(e).message}`);
      } finally {
        ui.onSkip = null;
        signal.aborted = true;
        rec.durationMs = round(performance.now() - t0, 0);
        if (rec.status === 'skipped' && !report.checks.some((c) => c.id === step.id || c.id.startsWith(step.id + '.'))) check(step.id, 'skipped', `${step.title}: skipped`);
      }
    }
    ui.progress();
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if ([...document.scripts].some((s) => s.src && s.src.endsWith(src.replace(/^(\.\.\/)+/, '')))) return resolve();
      const s = document.createElement('script'); s.src = src;
      s.onload = () => resolve(); s.onerror = () => reject(new Error('could not load ' + src));
      document.head.append(s);
    });
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

  // ------------------------------------------------------------------------------------------------------------------------------
  // The report file
  function buildReport({ crops = true } = {}) {
    try { if (report.polyfill || window.HicLivePolyfill) report.polyfill = polyfillInfo(); } catch (e) { recordError('polyfill info', e); }
    report.pairs = Object.fromEntries(Object.values(pairs).map((p) => [p.name, { paints: p.paints, paintError: p.paintError, readError: p.readError ?? null, backingStore: [p.canvas.width, p.canvas.height], cssBox: [p.canvas.clientWidth, p.canvas.clientHeight] }]));
    for (const id of STEP_IDS) report.steps[id] ||= { status: 'pending', results: {} };
    const verdicts = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
    for (const c of report.checks) verdicts[c.verdict] = (verdicts[c.verdict] || 0) + 1;
    report.summary = { verdicts, worst: verdicts.fail ? 'fail' : verdicts.error ? 'error' : verdicts.warn ? 'warn' : 'pass',
      device: platformLabel(), browser: browserLabel(), polyfillMode: report.polyfill?.mode ?? null, capture: report.capture.state };
    report.finishedAt = new Date().toISOString();
    if (crops) report.crops = encodeCrops();
    return report;
  }
  function platformLabel() {
    const u = navigator.userAgentData, ua = navigator.userAgent;
    const p = (u && u.platform) || (/Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : 'unknown');
    return p.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }
  function browserLabel() {
    const ua = navigator.userAgent, u = navigator.userAgentData;
    const brand = u && u.brands && (u.brands.find((b) => /Edge/.test(b.brand)) || u.brands.find((b) => /Chrome/.test(b.brand)) || u.brands.find((b) => !/Not.A.Brand|Chromium/.test(b.brand)) || u.brands.find((b) => /Chromium/.test(b.brand)));
    if (brand) return (brand.brand.replace(/^Google /, '').replace(/^Microsoft /, '') + brand.version).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const m = ua.match(/Firefox\/(\d+)/) || ua.match(/Version\/(\d+).*Safari/);
    return m ? (/Firefox/.test(m[0]) ? 'firefox' : 'safari') + m[1] : 'browser';
  }
  function fileName() { return `hic-field-test-${new Date().toISOString().slice(0, 10)}-${platformLabel()}-${browserLabel()}.json`; }
  function reportText() { return JSON.stringify(buildReport(), null, 1); }
  function download() {
    try {
      const url = URL.createObjectURL(new Blob([reportText()], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = fileName(); document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      ui.status(`Saved as ${fileName()} (look in your Downloads folder).`);
      state.downloaded = true;
    } catch (e) { recordError('download', e); ui.status('The download did not work here. Use "Copy report" and paste it into an email or the GitHub issue instead.'); }
  }
  async function copyReport() {
    try { await navigator.clipboard.writeText(reportText()); ui.status('The report is copied. Paste it into an email or the GitHub issue.'); }
    catch (e) { recordError('copy', e); ui.status('Copying is not allowed here. Use "Download report" instead.'); }
  }

  /** the shape every report must have (used by the self-check and by scripts/check-field-test.mjs); returns the problems */
  function validateReport(r) {
    const problems = [];
    const need = (cond, msg) => { if (!cond) problems.push(msg); };
    const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
    need(r && r.schema === SCHEMA, `schema is not ${SCHEMA}`);
    if (!r) return problems;
    need(typeof r.startedAt === 'string' && typeof r.finishedAt === 'string', 'startedAt / finishedAt missing');
    need(isObj(r.environment) && isObj(r.environment.browser) && typeof r.environment.browser.userAgent === 'string', 'environment.browser.userAgent missing');
    for (const k of ['display', 'media', 'systemColors', 'scrollbars', 'fonts', 'webgpu', 'webgl', 'apis']) need(isObj(r.environment?.[k]), `environment.${k} missing`);
    need(isObj(r.polyfill) && typeof r.polyfill.scriptLoaded === 'boolean' && typeof r.polyfill.apiAvailable === 'boolean', 'polyfill section missing');
    need(isObj(r.capture) && CAPTURE_STATES.includes(r.capture.state), `capture.state ${r.capture?.state} is not one of ${CAPTURE_STATES.join(', ')}`);
    need(isObj(r.steps), 'steps missing');
    for (const id of STEP_IDS) need(isObj(r.steps?.[id]) && STATUSES.includes(r.steps[id].status), `steps.${id} missing or with an unknown status`);
    need(Array.isArray(r.checks) && r.checks.length > 0, 'checks missing');
    for (const c of r.checks || []) {
      need(typeof c.id === 'string' && VERDICTS.includes(c.verdict) && typeof c.text === 'string', `check ${c.id}: bad shape`);
      if (c.numbers && 'over16Pct' in c.numbers) need(typeof c.numbers.over16Pct === 'number' && typeof c.numbers.over100Pct === 'number', `check ${c.id}: pixel numbers are not numbers`);
    }
    need(isObj(r.summary) && isObj(r.summary.verdicts), 'summary missing');
    need(isObj(r.crops) && typeof r.crops.usedChars === 'number' && r.crops.usedChars <= r.crops.budgetChars, 'crops over budget or missing');
    for (const [id, url] of Object.entries(r.crops?.images || {})) need(typeof url === 'string' && url.startsWith('data:image/png;base64,'), `crop ${id} is not a PNG data URL`);
    need(Array.isArray(r.console) && Array.isArray(r.errors), 'console / errors missing');
    return problems;
  }

  // ------------------------------------------------------------------------------------------------------------------------------
  // Self-check (for developers): the pixel oracle must pass identical pictures and fail broken ones, and the report must validate
  async function selfCheck() {
    const out = $('ft-selfcheck'); out.hidden = false; out.textContent = 'Running the self-check...';
    const lines = [], results = [];
    const expect = (name, got, want) => { const ok = got === want; results.push({ name, ok, got, want }); lines.push(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got} (expected ${want})`); };
    try {
      const M = 2, W = 300, H = 120;
      const paint = (dx = 0, dy = 0, colour = '#1b2330', w = W + 2 * M, h = H + 2 * M) => {
        const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
        x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.fillStyle = colour; x.font = '16px system-ui, sans-serif';
        for (let i = 0; i < 5; i++) x.fillText('Canvas field test 0123456789 selection', 8 + dx, 22 + i * 21 + dy);
        x.fillStyle = '#2f6df6'; x.fillRect(200 + dx, 90 + dy, 80, 22);
        return x.getImageData(0, 0, w, h);
      };
      const twin = paint(M, M), same = cropImage(paint(M, M), M, M, W, H);
      expect('identical pictures pass', compareShifted(same, twin, M).verdict, 'pass');
      expect('a 1 px offset is absorbed by the shift search', compareShifted(cropImage(paint(M + 1, M), M, M, W, H), twin, M).verdict, 'pass');
      expect('a 4 px offset fails', compareShifted(cropImage(paint(M + 4, M + 4), M, M, W, H), twin, M).verdict, 'fail');
      expect('text in another colour fails', compareShifted(cropImage(paint(M, M, '#d11'), M, M, W, H), twin, M).verdict, 'fail');
      const blank = new ImageData(W, H); blank.data.fill(255);
      expect('a blank picture fails', compareShifted(blank, twin, M).verdict, 'fail');
      const noisy = cropImage(paint(M, M), M, M, W, H); for (let i = 0; i < noisy.data.length; i += 4) for (let k = 0; k < 3; k++) noisy.data[i + k] = Math.max(0, Math.min(255, noisy.data[i + k] + ((i >> 2) % 13) - 6));
      expect('noise of +-6 levels passes', compareShifted(noisy, twin, M).verdict, 'pass');
      if (captureActive() && pairs.sample.twinBox) {
        const ok = await ensureCalibrated();
        lines.push(`calibration: ${ok ? `scale ${cap.calib.scaleX} x ${cap.calib.scaleY}, residual ${cap.calib.residualFramePx} frame px` : 'FAILED'}`);
        if (ok) {
          bringIntoView(pairs.sample.twinBox);
          const a = await grab(pairs.sample.twinBox, 0), b = await grab(pairs.sample.twinBox, 2);
          lines.push(`box B captured twice: ${JSON.stringify(Object.fromEntries(Object.entries(comparePair(a, b, 2)).filter(([k]) => /Pct|shift/.test(k))))}`);
          expect('box B captured twice passes (capture noise floor)', comparePair(a, b, 2).verdict, 'pass');
        }
      } else lines.push('capture: not active (the capture checks need an active tab capture)');
      const problems = validateReport(JSON.parse(JSON.stringify(buildReport({ crops: false }))));
      lines.push(`report schema: ${problems.length ? 'problems (expected before the test is finished): ' + problems.join('; ') : 'valid'}`);
      report.selfCheck = { at: new Date().toISOString(), oracle: results, schemaProblems: problems, ok: results.every((r) => r.ok) };
    } catch (e) { recordError('self-check', e); lines.push('self-check error: ' + errInfo(e).message); report.selfCheck = { error: errInfo(e) }; }
    out.textContent = lines.join('\n');
    return report.selfCheck;
  }

  // ------------------------------------------------------------------------------------------------------------------------------
  // Start
  try {
    makePair('sample', 'ft-sample-template');
    makePair('scroll', 'ft-scroll-template', (root) => {
      const s = root.querySelector('.ft-scroller');
      for (let i = 1; i <= 40; i++) { const d = document.createElement('div'); d.textContent = `Line ${i}: scroll inside this grey box`; s.append(d); }
    });
  } catch (e) { recordError('setup', e); }
  snapToDevicePixels();
  addEventListener('resize', () => snapToDevicePixels());
  $('ft-selfcheck-button').addEventListener('click', () => { selfCheck(); });
  window.__fieldTest = { version: TOOL_VERSION, report, state, pairs, validate: validateReport, buildReport, selfCheck, fileName, captureState: () => report.capture.state };
  runAll().catch((e) => { recordError('runAll', e); ui.show({ title: 'Something went wrong', html: `<p>${escapeHtml(errInfo(e).message)}</p>`, buttons: [{ id: 'download', label: 'Download report', primary: true, onClick: () => download() }] }); });
})();
