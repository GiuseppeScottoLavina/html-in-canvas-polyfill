import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineOf } from '../../../src/util/engine.js';
import { ADDITIVE_NAMES, CORE_NAMES, LEGACY_NAMES, MIN_CHROMIUM_MAJOR, MIN_FIREFOX_MAJOR, MIN_SAFARI_MAJOR, missingRequirements, browserGate, classifyNative, decideMode } from '../../../src/api/native-detect.js';

const ALL = [...CORE_NAMES, ...ADDITIVE_NAMES, ...LEGACY_NAMES];
/** Chrome 154 with --enable-blink-features=CanvasDrawElement, as measured. */
const LEGACY_154 = [
  'layoutSubtree', 'onpaint', 'requestPaint', 'captureElementImage', 'getElementTransform', 'updateElementGeometry', 'clearElementGeometry',
  'CanvasRenderingContext2D.drawElementImage', 'OffscreenCanvasRenderingContext2D.drawElementImage', 'ElementImage',
  'WebGLRenderingContext.texElementSubImage2D', 'WebGL2RenderingContext.texElementSubImage2D', 'GPUQueue.drawElementImageToTexture',
  'WebGLRenderingContext.texElementImage2D', 'WebGL2RenderingContext.texElementImage2D', 'GPUQueue.copyElementImageToTexture',
];
const COMPLETE = [...CORE_NAMES, ...ADDITIVE_NAMES];
/** @param {string[]} present @param {string[]} [applicable] */
const classify = (present, applicable = ALL) => classifyNative({ present, applicable, browserMajor: 154 });
const without = (/** @type {string[]} */ list, /** @type {string[]} */ ...names) => list.filter((n) => !names.includes(n));

test('nothing present: absent', () => {
  const s = classify([]);
  assert.equal(s.kind, 'absent');
  assert.deepEqual(s.gaps, []);
  assert.deepEqual(s.missing, []);
  assert.equal(s.fillable, false);
});

test('every current name: complete, no gaps', () => {
  const s = classify(COMPLETE);
  assert.equal(s.kind, 'complete');
  assert.deepEqual(s.gaps, []);
  assert.equal(s.fillable, false);
  assert.equal(s.browserMajor, 154);
});

test('Chrome 154 + flag (measured shape): legacy, only the two event names are gaps', () => {
  const s = classify(LEGACY_154);
  assert.equal(s.kind, 'legacy');
  assert.deepEqual(s.missing, ['content', 'onelementgeometryupdate', 'ElementGeometryUpdateEvent']);
  assert.deepEqual(s.gaps, ['onelementgeometryupdate', 'ElementGeometryUpdateEvent']);
  assert.equal(s.fillable, false, 'legacy is bridged by kind, not by fillable');
  assert.deepEqual(s.legacyNames.sort(), [...LEGACY_NAMES].sort());
});

test('every CORE name missing, one at a time: partial and never fillable', () => {
  for (const name of CORE_NAMES) {
    const s = classify(without(COMPLETE, name));
    assert.equal(s.kind, 'partial', name);
    assert.equal(s.fillable, false, name);
    assert.ok(s.missing.includes(name), name);
  }
});

test('every ADDITIVE name missing, one at a time: partial and fillable with exactly that gap', () => {
  for (const name of ADDITIVE_NAMES) {
    const s = classify(without(COMPLETE, name));
    assert.equal(s.kind, 'partial', name);
    assert.equal(s.fillable, true, name);
    assert.deepEqual(s.gaps, [name]);
  }
});

test('a core name AND an additive name missing: partial, not fillable (the core hole decides)', () => {
  const s = classify(without(COMPLETE, 'requestPaint', 'onelementgeometryupdate'));
  assert.equal(s.kind, 'partial');
  assert.equal(s.fillable, false);
  assert.deepEqual(s.gaps, ['onelementgeometryupdate']);
});

test('content missing without layoutSubtree is partial, not legacy', () => {
  assert.equal(classify(without(COMPLETE, 'content')).kind, 'partial');
});

test('legacy shape with one more core name missing is partial', () => {
  assert.equal(classify(without(LEGACY_154, 'requestPaint')).kind, 'partial');
  assert.equal(classify(without(LEGACY_154, 'ElementImage')).kind, 'partial');
});

test('a lone legacy name is partial (something native exists, it is unknown)', () => {
  assert.equal(classify(['layoutSubtree']).kind, 'partial');
  assert.equal(classify(['GPUQueue.copyElementImageToTexture']).kind, 'partial');
});

test('names of classes that do not exist in this window are not applicable, hence not gaps', () => {
  const applicable = ALL.filter((n) => !/^(WebGL2?RenderingContext|GPUQueue)\./.test(n));
  const s = classify(COMPLETE.filter((n) => applicable.includes(n)), applicable);
  assert.equal(s.kind, 'complete');
  assert.deepEqual(s.gaps, []);
});

test('the result lists are copies (mutating a state never changes a later probe)', () => {
  const present = [...COMPLETE];
  const s = classify(present);
  s.present.push('x');
  assert.equal(present.includes('x'), false);
});

/** @param {Partial<{mode: 'auto'|'polyfill'|'native-only', forcePolyfill: boolean}>} [o] */
const opts = (o = {}) => ({ mode: /** @type {'auto'|'polyfill'|'native-only'} */ ('auto'), forcePolyfill: false, ...o });
const OK = { ok: true };
const BAD = { ok: false, reason: 'not a Chromium-family browser' };

test('decideMode, auto: absent -> polyfill, gate decides', () => {
  assert.equal(decideMode(classify([]), OK, opts()).mode, 'polyfill');
  const r = decideMode(classify([]), BAD, opts());
  assert.equal(r.mode, 'refused');
  assert.equal(r.refusal?.feature, 'browser');
  assert.match(r.refusal?.hint ?? '', /Chromium/);
});

test('decideMode, auto: complete -> native (no gate needed), legacy and fillable -> native-bridged', () => {
  assert.equal(decideMode(classify(COMPLETE), BAD, opts()).mode, 'native');
  assert.equal(decideMode(classify(LEGACY_154), BAD, opts()).mode, 'native-bridged');
  assert.equal(decideMode(classify(without(COMPLETE, 'GPUQueue.drawElementImageToTexture')), OK, opts()).mode, 'native-bridged');
});

test('decideMode, auto: a partial with a core hole is refused as partial-native', () => {
  const r = decideMode(classify(without(COMPLETE, 'captureElementImage')), OK, opts());
  assert.equal(r.mode, 'refused');
  assert.equal(r.refusal?.feature, 'partial-native');
  assert.match(r.refusal?.message ?? '', /captureElementImage/);
});

test('decideMode, forcePolyfill: replaces any native, still needs the browser gate', () => {
  for (const present of [COMPLETE, LEGACY_154, without(COMPLETE, 'requestPaint'), []]) {
    assert.equal(decideMode(classify(present), OK, opts({ forcePolyfill: true })).mode, 'polyfill');
  }
  assert.equal(decideMode(classify(COMPLETE), BAD, opts({ forcePolyfill: true })).refusal?.feature, 'browser');
});

test('decideMode, mode polyfill: only on an absent native, a present native is never overridden', () => {
  assert.equal(decideMode(classify([]), OK, opts({ mode: 'polyfill' })).mode, 'polyfill');
  for (const present of [COMPLETE, LEGACY_154, without(COMPLETE, 'requestPaint')]) {
    const r = decideMode(classify(present), OK, opts({ mode: 'polyfill' }));
    assert.equal(r.mode, 'refused');
    assert.equal(r.refusal?.feature, 'partial-native');
  }
});

test('decideMode, mode native-only: complete -> native, everything else throws (also with forcePolyfill)', () => {
  assert.equal(decideMode(classify(COMPLETE), OK, opts({ mode: 'native-only' })).mode, 'native');
  for (const present of [[], LEGACY_154, without(COMPLETE, 'onpaint'), without(COMPLETE, 'ElementGeometryUpdateEvent')]) {
    assert.equal(decideMode(classify(present), OK, opts({ mode: 'native-only', forcePolyfill: true })).mode, 'refused');
  }
  assert.equal(decideMode(classify([]), OK, opts({ mode: 'native-only' })).refusal?.feature, 'browser');
});

test('decideMode always reports mode "refused" together with a refusal, and a refusal only with "refused"', () => {
  for (const present of [[], COMPLETE, LEGACY_154, without(COMPLETE, 'requestPaint')]) {
    for (const mode of /** @type {const} */ (['auto', 'polyfill', 'native-only'])) {
      for (const gate of [OK, BAD]) {
        const r = decideMode(classify(present), gate, opts({ mode }));
        assert.equal(r.mode === 'refused', r.refusal !== null);
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
  assert.deepEqual(browserGate(win(CHROME(154))), { ok: true, major: 154, engine: 'chromium' });
  assert.equal(browserGate(win(CHROME(MIN_CHROMIUM_MAJOR))).ok, true);
  assert.equal(browserGate(win(CHROME(MIN_CHROMIUM_MAJOR - 1))).ok, false);
});

test('browserGate: desktop Firefox and Safari at the measured majors pass; older ones are refused as unverified', () => {
  assert.deepEqual(browserGate(win(FIREFOX(MIN_FIREFOX_MAJOR))), { ok: true, major: MIN_FIREFOX_MAJOR, engine: 'gecko' });
  assert.deepEqual(browserGate(win(SAFARI(MIN_SAFARI_MAJOR))), { ok: true, major: MIN_SAFARI_MAJOR, engine: 'webkit' });
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

test('browserGate: mobile, iOS and unknown agents are refused with a reason', () => {
  const android = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36';
  const ios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1';
  const firefoxAndroid = 'Mozilla/5.0 (Android 14; Mobile; rv:155.0) Gecko/155.0 Firefox/155.0';
  for (const ua of [android, ios, firefoxAndroid, '', 'curl/8.0']) {
    const g = browserGate(win(ua));
    assert.equal(g.ok, false, ua);
    assert.ok(g.reason && g.reason.length > 10, ua);
  }
  assert.equal(browserGate(win(CHROME(154), { userAgentData: { mobile: true, brands: [{ brand: 'Chromium', version: '154' }] } })).ok, false);
});

test('engineOf: Chromium, Gecko, WebKit and other agents', () => {
  assert.deepEqual(engineOf({ userAgent: FIREFOX(155) }), { engine: 'gecko', major: 155, mobile: false });
  assert.deepEqual(engineOf({ userAgent: SAFARI(27) }), { engine: 'webkit', major: 27, mobile: false });
  assert.deepEqual(engineOf({ userAgent: CHROME(154) }), { engine: 'chromium', major: 154, mobile: false });
  assert.equal(engineOf({ userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/154.0 Safari/537.36 Edg/154.0' }).engine, 'chromium');
  assert.equal(engineOf(null).engine, 'other');
});

test('browserGate: the Chromium brand of userAgentData wins over a frozen user agent string', () => {
  const g = browserGate(win('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/154.0.0.0', { userAgentData: { mobile: false, brands: [{ brand: 'Chromium', version: '158' }] } }));
  assert.deepEqual(g, { ok: true, major: 158, engine: 'chromium' });
});
