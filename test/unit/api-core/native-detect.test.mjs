import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineOf } from '../../../src/util/engine.js';
import { ADDITIVE_NAMES, CORE_NAMES, LEGACY_NAMES, MIN_CHROMIUM_MAJOR, MIN_FIREFOX_MAJOR, MIN_IOS_SAFARI_MAJOR, MIN_SAFARI_MAJOR, SPEC_NAMES, missingRequirements, browserGate, classifyNative, decideMode, nativeUsable } from '../../../src/api/native-detect.js';

const ALL = [...CORE_NAMES, ...SPEC_NAMES, ...LEGACY_NAMES];
const without = (/** @type {string[]} */ list, /** @type {string[]} */ ...names) => list.filter((n) => !names.includes(n));
/** Canary 157.0.8103.0 with or without the flag, as measured on 2026-10-14: the 2026-10-08 specification. */
const CURRENT = [...CORE_NAMES, ...SPEC_NAMES];
/** The 2026-10-07 shape (pinned WPT revision, Chromium 157.0.8091.0): ElementImage.width/height, no getElementImageDefaultSize. */
const PREVIOUS = [...without(CURRENT, 'getElementImageDefaultSize', 'OffscreenCanvas.getElementImageDefaultSize'), 'ElementImage.width'];
/** Chrome 155.0.8059.40 with --enable-blink-features=CanvasDrawElement, as measured on 2026-10-14 (the earlier draft, with the event names). */
const LEGACY_155 = [
  'layoutSubtree', 'onpaint', 'onelementgeometryupdate', 'requestPaint', 'captureElementImage', 'getElementTransform', 'updateElementGeometry', 'clearElementGeometry',
  'OffscreenCanvas.updateElementGeometry', 'OffscreenCanvas.clearElementGeometry', 'CanvasRenderingContext2D.drawElementImage', 'OffscreenCanvasRenderingContext2D.drawElementImage',
  'ElementImage', 'ElementImage.width', 'ElementGeometryUpdateEvent', 'WebGLRenderingContext.texElementSubImage2D', 'WebGL2RenderingContext.texElementSubImage2D',
  'GPUQueue.drawElementImageToTexture', 'WebGLRenderingContext.texElementImage2D', 'WebGL2RenderingContext.texElementImage2D', 'GPUQueue.copyElementImageToTexture',
];
/** Chrome 154 with --enable-blink-features=CanvasDrawElement, as measured. */
const LEGACY_154 = [
  'layoutSubtree', 'onpaint', 'requestPaint', 'captureElementImage', 'getElementTransform', 'updateElementGeometry', 'clearElementGeometry',
  'CanvasRenderingContext2D.drawElementImage', 'OffscreenCanvasRenderingContext2D.drawElementImage', 'ElementImage', 'ElementImage.width',
  'WebGLRenderingContext.texElementSubImage2D', 'WebGL2RenderingContext.texElementSubImage2D', 'GPUQueue.drawElementImageToTexture',
  'WebGLRenderingContext.texElementImage2D', 'WebGL2RenderingContext.texElementImage2D', 'GPUQueue.copyElementImageToTexture',
];
/**
 * Safari Technology Preview 254 (WebKit 22627.1.2.1) with Develop > Feature Flags > HTML-in-Canvas: the binding names in its WebCore binary (2026-10-16; the flag
 * is off by default, so the shape is read, not observed live). No content, no geometry methods, no size getter, no current texture names, no OffscreenCanvas names.
 */
const WEBKIT_STP = [
  'layoutSubtree', 'onpaint', 'requestPaint', 'captureElementImage', 'getElementTransform', 'CanvasRenderingContext2D.drawElementImage', 'ElementImage', 'ElementImage.width',
  'WebGLRenderingContext.texElementImage2D', 'WebGL2RenderingContext.texElementImage2D', 'GPUQueue.copyElementImageToTexture',
];
/** @param {string[]} present @param {string[]} [applicable] @param {any} [probe] */
const classify = (present, applicable = ALL, probe = 'ok') => classifyNative({ present, applicable, browserMajor: 157, probe });

test('nothing present: absent', () => {
  const s = classify([], ALL, 'skipped');
  assert.equal(s.kind, 'absent');
  assert.deepEqual(s.gaps, []);
  assert.deepEqual(s.missing, []);
  assert.equal(s.fillable, false);
  assert.equal(s.verified, false);
});

test('the current shape (Canary 157, 2026-10-08 spec): complete, verified', () => {
  const s = classify(CURRENT);
  assert.equal(s.kind, 'complete');
  assert.deepEqual(s.missing, []);
  assert.deepEqual(s.gaps, []);
  assert.equal(s.fillable, false);
  assert.equal(s.verified, true);
  assert.equal(s.browserMajor, 157);
});

test('regression: ElementImage without width/height is NOT a reason to refuse (the Canary 157 shape used to be classified partial and refused)', () => {
  assert.equal(CURRENT.includes('ElementImage.width'), false, 'the measured shape has no width');
  const s = classify(CURRENT);
  assert.equal(nativeUsable(s), true);
  assert.equal(decideMode(s, BAD, opts()).mode, 'native');
  assert.equal(decideMode(s, BAD, opts()).refusal, null);
});

test('the previous shape (ElementImage.width/height, no getElementImageDefaultSize): usable, partial; the bridge can build the canvas size getter', () => {
  const s = classify(PREVIOUS);
  assert.equal(s.kind, 'partial');
  assert.deepEqual(s.missing, ['getElementImageDefaultSize', 'OffscreenCanvas.getElementImageDefaultSize']);
  assert.deepEqual(s.gaps, ['getElementImageDefaultSize'], 'built from ElementImage.width/height; the OffscreenCanvas one is not buildable');
  assert.equal(s.fillable, true);
  assert.deepEqual(s.legacyNames, ['ElementImage.width']);
  assert.equal(decideMode(s, OK, opts()).mode, 'native-bridged', 'install falls back to native when the bridge is not loaded');
});

test('Chrome 155 + flag (measured 2026-10-14): legacy, bridged; the only gap is the size getter', () => {
  const s = classify(LEGACY_155);
  assert.equal(s.kind, 'legacy');
  assert.deepEqual(s.missing, ['content', 'getElementImageDefaultSize', 'OffscreenCanvas.getElementImageDefaultSize']);
  assert.deepEqual(s.gaps, ['getElementImageDefaultSize']);
  assert.equal(s.verified, true);
  assert.equal(decideMode(s, BAD, opts()).mode, 'native-bridged');
});

test('Chrome 154 + flag (measured legacy shape): legacy, content and the event names listed, the event names and the size getter are gaps', () => {
  const s = classify(LEGACY_154);
  assert.equal(s.kind, 'legacy');
  assert.deepEqual(s.missing, ['content', 'getElementImageDefaultSize', 'onelementgeometryupdate', 'OffscreenCanvas.updateElementGeometry', 'OffscreenCanvas.clearElementGeometry',
    'OffscreenCanvas.getElementImageDefaultSize', 'ElementGeometryUpdateEvent']);
  assert.deepEqual(s.gaps, ['onelementgeometryupdate', 'ElementGeometryUpdateEvent', 'getElementImageDefaultSize']);
  assert.equal(s.fillable, false, 'legacy is bridged by kind, not by fillable');
  assert.deepEqual(s.legacyNames.sort(), [...LEGACY_NAMES].sort());
  assert.equal(decideMode(s, BAD, opts()).mode, 'native-bridged');
});

test('Safari Technology Preview 254 + HTML-in-Canvas flag (binary names): legacy, never refused, whatever the probe and the browser gate say', () => {
  for (const probe of ['ok', 'inert', 'unexpected', 'skipped']) {
    const s = classify(WEBKIT_STP, ALL, probe);
    assert.equal(s.kind, 'legacy', probe);
    assert.ok(s.missing.includes('content') && s.missing.includes('updateElementGeometry') && s.missing.includes('clearElementGeometry'));
    assert.deepEqual(s.gaps, ['onelementgeometryupdate', 'ElementGeometryUpdateEvent', 'getElementImageDefaultSize', 'WebGLRenderingContext.texElementSubImage2D',
      'WebGL2RenderingContext.texElementSubImage2D', 'GPUQueue.drawElementImageToTexture'], 'every additive name has its legacy twin');
    for (const gate of [OK, BAD]) for (const mode of /** @type {const} */ (['auto', 'polyfill', 'native-only'])) {
      const d = decideMode(s, gate, opts({ mode }));
      assert.equal(d.refusal, null, `${probe} ${mode}`);
      assert.equal(d.mode, 'native-bridged');
    }
  }
});

test('every CORE name missing, one at a time: broken, never usable', () => {
  for (const name of CORE_NAMES) {
    const s = classify(without(CURRENT, name));
    assert.equal(s.kind, 'broken', name);
    assert.equal(s.fillable, false, name);
    assert.equal(s.verified, false, name);
    assert.ok(s.missing.includes(name), name);
    assert.equal(decideMode(s, OK, opts()).refusal?.feature, 'partial-native', name);
  }
});

test('every other name of the specification missing, one at a time: partial and usable, never refused', () => {
  for (const name of SPEC_NAMES) {
    const s = classify(without(CURRENT, name));
    assert.equal(s.kind, 'partial', name);
    assert.deepEqual(s.missing, [name], name);
    const r = decideMode(s, BAD, opts());
    assert.equal(r.refusal, null, name);
    // only the two event names can be built without a legacy twin; every other missing name is used as found
    assert.equal(r.mode, ['onelementgeometryupdate', 'ElementGeometryUpdateEvent'].includes(name) ? 'native-bridged' : 'native', name);
    assert.equal(s.fillable, ADDITIVE_NAMES.includes(name) && r.mode === 'native-bridged', name);
  }
});

test('ALL secondary names missing at once still steps aside (only the core decides)', () => {
  const s = classify([...CORE_NAMES]);
  assert.equal(s.kind, 'partial');
  assert.equal(s.missing.length, SPEC_NAMES.length);
  assert.equal(decideMode(s, BAD, opts()).refusal, null);
});

test('texture gaps are bridgeable only when their legacy twin exists', () => {
  const s = classify(without(CURRENT, 'WebGLRenderingContext.texElementSubImage2D', 'GPUQueue.drawElementImageToTexture'));
  assert.deepEqual(s.gaps, [], 'nothing to build them from');
  assert.equal(decideMode(s, OK, opts()).mode, 'native');
  const t = classify([...without(CURRENT, 'GPUQueue.drawElementImageToTexture'), 'GPUQueue.copyElementImageToTexture']);
  assert.deepEqual(t.gaps, ['GPUQueue.drawElementImageToTexture']);
  assert.equal(t.fillable, true);
  assert.equal(decideMode(t, OK, opts()).mode, 'native-bridged');
});

test('unknown extra names never matter, and a usable native that failed the behavioural probe still steps aside (unverified)', () => {
  for (const probe of ['inert', 'unexpected']) {
    const s = classify([...CURRENT, 'somethingNew'], ALL, probe);
    assert.equal(s.kind, 'complete', probe);
    assert.equal(s.verified, false, probe);
    assert.equal(s.probe, probe);
    assert.equal(decideMode(s, OK, opts()).mode, 'native', probe);
  }
});

test('content missing without layoutSubtree is broken, not legacy; legacy with a core name missing is broken', () => {
  assert.equal(classify(without(CURRENT, 'content')).kind, 'broken');
  assert.equal(classify(without(LEGACY_154, 'onpaint')).kind, 'broken');
  assert.equal(classify(without(LEGACY_154, 'CanvasRenderingContext2D.drawElementImage')).kind, 'broken');
  assert.equal(classify(without(LEGACY_154, 'requestPaint')).kind, 'legacy', 'a secondary name never breaks a legacy build either');
});

test('a lone native name is broken (something native exists, without its core)', () => {
  assert.equal(classify(['layoutSubtree']).kind, 'broken');
  assert.equal(classify(['GPUQueue.copyElementImageToTexture']).kind, 'broken');
  assert.equal(classify(['ElementImage']).kind, 'broken');
});

test('names of classes that do not exist in this window are not applicable, hence not missing', () => {
  const applicable = ALL.filter((n) => !/^(WebGL2?RenderingContext|GPUQueue|OffscreenCanvas)\./.test(n));
  const s = classify(CURRENT.filter((n) => applicable.includes(n)), applicable);
  assert.equal(s.kind, 'complete');
  assert.deepEqual(s.gaps, []);
});

test('the result lists are copies (mutating a state never changes a later probe)', () => {
  const present = [...CURRENT];
  const s = classify(present);
  s.present.push('x');
  assert.equal(present.includes('x'), false);
});

/** @param {Partial<{mode: 'auto'|'polyfill'|'native-only', forcePolyfill: boolean}>} [o] */
function opts(o = {}) { return { mode: /** @type {'auto'|'polyfill'|'native-only'} */ ('auto'), forcePolyfill: false, ...o }; }
const OK = { ok: true };
const BAD = { ok: false, reason: 'not a Chromium-family browser' };

test('decideMode, auto: absent -> polyfill, gate decides', () => {
  assert.equal(decideMode(classify([]), OK, opts()).mode, 'polyfill');
  const r = decideMode(classify([]), BAD, opts());
  assert.equal(r.mode, 'refused');
  assert.equal(r.refusal?.feature, 'browser');
  assert.match(r.refusal?.hint ?? '', /Chromium/);
});

test('decideMode, auto: complete and partial -> native (no gate needed), legacy and fillable -> native-bridged', () => {
  assert.equal(decideMode(classify(CURRENT), BAD, opts()).mode, 'native');
  assert.equal(decideMode(classify(without(CURRENT, 'requestPaint')), BAD, opts()).mode, 'native', 'a gap nothing can build is used as found');
  assert.equal(decideMode(classify(PREVIOUS), BAD, opts()).mode, 'native-bridged');
  assert.equal(decideMode(classify(LEGACY_154), BAD, opts()).mode, 'native-bridged');
  assert.equal(decideMode(classify(without(CURRENT, 'onelementgeometryupdate')), OK, opts()).mode, 'native-bridged');
});

test('decideMode, auto: broken is refused as partial-native and names the missing core', () => {
  const r = decideMode(classify(without(CURRENT, 'onpaint')), OK, opts());
  assert.equal(r.mode, 'refused');
  assert.equal(r.refusal?.feature, 'partial-native');
  assert.match(r.refusal?.message ?? '', /onpaint/);
});

test('decideMode, forcePolyfill: replaces any native, still needs the browser gate', () => {
  for (const present of [CURRENT, PREVIOUS, LEGACY_154, without(CURRENT, 'onpaint'), []]) {
    assert.equal(decideMode(classify(present), OK, opts({ forcePolyfill: true })).mode, 'polyfill');
  }
  assert.equal(decideMode(classify(CURRENT), BAD, opts({ forcePolyfill: true })).refusal?.feature, 'browser');
});

test('decideMode, mode polyfill: on an absent native it runs; on a usable native it steps aside with a notice, never throws; broken is refused', () => {
  assert.equal(decideMode(classify([]), OK, opts({ mode: 'polyfill' })).mode, 'polyfill');
  for (const present of [CURRENT, PREVIOUS, LEGACY_154]) {
    const r = decideMode(classify(present), OK, opts({ mode: 'polyfill' }));
    assert.equal(r.refusal, null);
    assert.ok(r.mode === 'native' || r.mode === 'native-bridged');
    assert.match(r.notice ?? '', /never replaced/);
  }
  assert.equal(decideMode(classify(CURRENT), OK, opts()).notice, null, 'no notice in mode auto');
  assert.equal(decideMode(classify(without(CURRENT, 'onpaint')), OK, opts({ mode: 'polyfill' })).refusal?.feature, 'partial-native');
});

test('decideMode, mode native-only: any usable native -> its native mode; absent and broken throw (also with forcePolyfill)', () => {
  assert.equal(decideMode(classify(CURRENT), OK, opts({ mode: 'native-only' })).mode, 'native');
  assert.equal(decideMode(classify(without(CURRENT, 'requestPaint')), OK, opts({ mode: 'native-only' })).mode, 'native');
  assert.equal(decideMode(classify(PREVIOUS), OK, opts({ mode: 'native-only' })).mode, 'native-bridged');
  assert.equal(decideMode(classify(LEGACY_154), OK, opts({ mode: 'native-only' })).mode, 'native-bridged');
  for (const present of [[], without(CURRENT, 'onpaint')]) {
    assert.equal(decideMode(classify(present), OK, opts({ mode: 'native-only', forcePolyfill: true })).mode, 'refused');
  }
  assert.equal(decideMode(classify([]), OK, opts({ mode: 'native-only' })).refusal?.feature, 'browser');
  assert.equal(decideMode(classify(without(CURRENT, 'content')), OK, opts({ mode: 'native-only' })).refusal?.feature, 'partial-native');
});

test('decideMode always reports mode "refused" together with a refusal, and a refusal only with "refused"; a usable native is never refused', () => {
  for (const present of [[], CURRENT, PREVIOUS, LEGACY_154, without(CURRENT, 'onpaint'), without(CURRENT, 'requestPaint')]) {
    for (const mode of /** @type {const} */ (['auto', 'polyfill', 'native-only'])) {
      for (const gate of [OK, BAD]) {
        const s = classify(present);
        const r = decideMode(s, gate, opts({ mode }));
        assert.equal(r.mode === 'refused', r.refusal !== null);
        if (nativeUsable(s)) assert.equal(r.refusal, null, `${s.kind} ${mode}`);
      }
    }
  }
});

/** A window double with every required platform feature (missingRequirements) unless `lack` names one. */
const FEATURES = { CSS: { supports: (/** @type {string} */ p) => p === 'anchor-name' || p === 'position-anchor' }, ResizeObserver: function () {}, HTMLImageElement: { prototype: { decode() {} } },
  CSSStyleSheet: { prototype: { replaceSync() {} } }, document: { adoptedStyleSheets: [] } };
/** @param {string} ua @param {object} [extra] @param {Record<string, unknown>} [over] */
const win = (ua, extra = {}, over = {}) => /** @type {any} */ ({ ...FEATURES, ...over, navigator: { userAgent: ua, ...extra } });
const CHROME = (/** @type {number} */ v) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`;
const FIREFOX = (/** @type {number} */ v) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`;
const SAFARI = (/** @type {number} */ v) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v}.0.1 Safari/605.1.15`;

test('browserGate: desktop Chromium >= the minimum passes', () => {
  assert.deepEqual(browserGate(win(CHROME(154))), { ok: true, major: 154, engine: 'chromium', os: 'desktop', mobile: false });
  assert.equal(browserGate(win(CHROME(MIN_CHROMIUM_MAJOR))).ok, true);
  assert.equal(browserGate(win(CHROME(MIN_CHROMIUM_MAJOR - 1))).ok, false);
});

test('browserGate: desktop Firefox and Safari at the measured majors pass; older ones are refused as unverified', () => {
  assert.deepEqual(browserGate(win(FIREFOX(MIN_FIREFOX_MAJOR))), { ok: true, major: MIN_FIREFOX_MAJOR, engine: 'gecko', os: 'desktop', mobile: false });
  assert.deepEqual(browserGate(win(SAFARI(MIN_SAFARI_MAJOR))), { ok: true, major: MIN_SAFARI_MAJOR, engine: 'webkit', os: 'desktop', mobile: false });
  assert.match(String(browserGate(win(SAFARI(26), { maxTouchPoints: 0 })).reason), /Safari 26 is older/, 'a Mac (no touch points) with Safari 26 is desktop Safari, not iPadOS');
  assert.match(String(browserGate(win(FIREFOX(MIN_FIREFOX_MAJOR - 1))).reason), /Firefox 154 is older than the supported minimum 155/);
  assert.match(String(browserGate(win(SAFARI(MIN_SAFARI_MAJOR - 1))).reason), /Safari 26 is older/);
});

test('browserGate: a missing platform feature is named in the refusal, per feature, on every engine', () => {
  const noAnchor = { CSS: { supports: () => false } };
  for (const ua of [CHROME(154), FIREFOX(155), SAFARI(27)]) {
    const g = browserGate(win(ua, {}, noAnchor));
    assert.equal(g.ok, false); assert.match(String(g.reason), /lacks CSS anchor positioning/);
  }
  assert.match(String(browserGate(win(FIREFOX(155), {}, { ResizeObserver: undefined })).reason), /lacks ResizeObserver/);
  assert.deepEqual(missingRequirements(win(FIREFOX(155))), []);
});

/** Real agents: iOS 26.4 simulator (iPhone 17, iPad: desktop UA + 5 touch points), Android Emulator API 35 (Chrome 124 shipped with the image), and published shapes. */
const IOS_SAFARI = (/** @type {number} */ v) => `Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v}.4 Mobile/15E148 Safari/604.1`;
const IPADOS_SAFARI = (/** @type {number} */ v) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v}.4 Safari/605.1.15`;
const CHROME_ANDROID = (/** @type {number} */ v) => `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Mobile Safari/537.36`;
const CRIOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.96 Mobile/15E148 Safari/604.1';
const FXIOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/144.0 Mobile/15E148 Safari/605.1.15';
const EDGIOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/141.0.3537.71 Version/18.0 Mobile/15E148 Safari/604.1';
const IOS_WEBVIEW = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const ANDROID_WEBVIEW = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36';
const FIREFOX_ANDROID = 'Mozilla/5.0 (Android 14; Mobile; rv:155.0) Gecko/155.0 Firefox/155.0';

test('browserGate: Chrome for Android >= the Chromium minimum passes as mobile; older is refused with its version', () => {
  assert.deepEqual(browserGate(win(CHROME_ANDROID(MIN_CHROMIUM_MAJOR), { maxTouchPoints: 5 })), { ok: true, major: MIN_CHROMIUM_MAJOR, engine: 'chromium', os: 'android', mobile: true });
  assert.match(String(browserGate(win(CHROME_ANDROID(124))).reason), /Chrome for Android 124 is older than the supported minimum 130/);
  const desktopSite = win(CHROME(141), { userAgentData: { mobile: false, platform: 'Android', brands: [{ brand: 'Chromium', version: '141' }] } });
  assert.deepEqual(browserGate(desktopSite), { ok: true, major: 141, engine: 'chromium', os: 'android', mobile: true }, '"Request desktop site" (Linux UA) is still Android');
  assert.equal(browserGate(win(CHROME_ANDROID(141))).ok, true, 'without userAgentData (the UA alone)');
  assert.match(String(browserGate(win(CHROME_ANDROID(141), {}, { CSS: { supports: () => false } })).reason), /Chrome for Android 141 lacks CSS anchor positioning/);
});

test('browserGate: Safari on iOS >= 26 passes; iPadOS (desktop UA + touch points) is iOS, not desktop Safari', () => {
  assert.deepEqual(browserGate(win(IOS_SAFARI(MIN_IOS_SAFARI_MAJOR))), { ok: true, major: 26, engine: 'webkit', os: 'ios', mobile: true });
  assert.match(String(browserGate(win(IOS_SAFARI(18))).reason), /Safari on iOS 18 is older than the supported minimum 26/);
  assert.deepEqual(browserGate(win(IPADOS_SAFARI(26), { maxTouchPoints: 5 })), { ok: true, major: 26, engine: 'webkit', os: 'ios', mobile: true });
  assert.equal(engineOf({ userAgent: IPADOS_SAFARI(26), maxTouchPoints: 0 }).os, 'desktop', 'control: the same UA on a Mac is desktop');
  assert.match(String(browserGate(win(IOS_SAFARI(26), {}, { CSS: { supports: () => false } })).reason), /Safari on iOS 26 lacks CSS anchor positioning/);
});

test('browserGate: Chrome, Firefox and Edge on iOS are WebKit, decided by the features (no WebKit version in their agent)', () => {
  for (const [ua, shell] of [[CRIOS, 'CriOS'], [FXIOS, 'FxiOS'], [EDGIOS, 'EdgiOS']]) {
    const e = engineOf({ userAgent: ua, maxTouchPoints: 5 });
    assert.deepEqual(e, { engine: 'webkit', major: null, mobile: true, os: 'ios', webview: null, shell }, ua);
    assert.equal(browserGate(win(ua)).ok, true, ua);
    const g = browserGate(win(ua, {}, { CSS: { supports: () => false } }));
    assert.equal(g.ok, false); assert.match(String(g.reason), new RegExp(`${shell} \\(WebKit on iOS\\) lacks CSS anchor positioning`));
  }
});

test('browserGate: WebViews, Firefox for Android and unknown agents are refused loudly with a reason', () => {
  assert.match(String(browserGate(win(ANDROID_WEBVIEW)).reason), /Android WebView is not supported/);
  assert.match(String(browserGate(win(CHROME_ANDROID(141), { userAgentData: { mobile: true, platform: 'Android', brands: [{ brand: 'Android WebView', version: '141' }, { brand: 'Chromium', version: '141' }] } })).reason), /Android WebView/);
  assert.match(String(browserGate(win(IOS_WEBVIEW)).reason), /in-app iOS web view/);
  assert.match(String(browserGate(win(FIREFOX_ANDROID)).reason), /Firefox for Android is not supported/);
  for (const ua of ['', 'curl/8.0', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Opera Mini']) {
    const g = browserGate(win(ua));
    assert.equal(g.ok, false, ua);
    assert.ok(g.reason && g.reason.length > 10, ua);
  }
  const r = decideMode(classify([]), browserGate(win(ANDROID_WEBVIEW)), opts());
  assert.equal(r.refusal?.feature, 'browser'); assert.match(String(r.refusal?.message), /unsupported browser: Android WebView/); assert.match(String(r.refusal?.hint), /iOS/);
});

test('engineOf: Chromium, Gecko, WebKit and other agents', () => {
  const desk = { mobile: false, os: 'desktop', webview: null, shell: null };
  assert.deepEqual(engineOf({ userAgent: FIREFOX(155) }), { engine: 'gecko', major: 155, ...desk });
  assert.deepEqual(engineOf({ userAgent: SAFARI(27) }), { engine: 'webkit', major: 27, ...desk });
  assert.deepEqual(engineOf({ userAgent: CHROME(154) }), { engine: 'chromium', major: 154, ...desk });
  assert.equal(engineOf({ userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/154.0 Safari/537.36 Edg/154.0' }).engine, 'chromium');
  assert.equal(engineOf(null).engine, 'other');
});

test('browserGate: the Chromium brand of userAgentData wins over a frozen user agent string', () => {
  const g = browserGate(win('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/154.0.0.0', { userAgentData: { mobile: false, brands: [{ brand: 'Chromium', version: '158' }] } }));
  assert.deepEqual(g, { ok: true, major: 158, engine: 'chromium', os: 'desktop', mobile: false });
});
