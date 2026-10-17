/**
 * Browser ENGINE of a navigator (pure, no DOM): Chromium (Chrome, Edge, Opera, ...), Gecko (Firefox) or WebKit (Safari, and every browser on iOS / iPadOS). Used only
 * where an engine behaviour cannot be feature-detected synchronously (how an SVG image scales text, docs/SUPPORT-MATRIX.md "Engines"), for the iOS form-control look
 * and the mobile memory budgets, and by the browser gate; every API difference is feature-detected where it is used.
 * Module: util.
 *
 * Mobile classification (measured user agents: iPhone 17 and iPad simulators on iOS 26.4, Android Emulator API 35):
 *  - iOS / iPadOS: `iPhone|iPad|iPod` in the UA, or a `Macintosh` UA with more than one touch point (iPadOS Safari, and "Request Desktop Website" on an iPhone, send
 *    the macOS UA; a Mac reports 0 touch points). Every iOS browser is WebKit. Safari's major is its `Version/` token (the OS token is frozen at 18_x since iOS 26).
 *    Chrome, Firefox, Edge, Opera, ... on iOS (`CriOS/`, `FxiOS/`, `EdgiOS/`, `OPiOS/`, ...) carry no WebKit version (EdgiOS even sends an unrelated `Version/`):
 *    their major is null and the gate decides on the features alone. A UA without the `Safari/` token is an in-app WKWebView.
 *  - Android: `Android` in the UA or userAgentData.platform "Android" ("Request desktop site" sends a Linux UA). `; wv)` or `Version/4.0 Chrome/` is an Android WebView.
 */

/**
 * @typedef {Object} EngineInfo
 * @property {'chromium'|'gecko'|'webkit'|'other'} engine
 * @property {number|null} major  Chromium major, Firefox major or Safari (Version/) major; null when the agent does not carry it (iOS browsers other than Safari)
 * @property {boolean} mobile  iOS, iPadOS or Android (a touch-first device class: mobile budgets and looks)
 * @property {'desktop'|'ios'|'android'} os
 * @property {'android-webview'|'ios-webview'|null} webview  an embedded web view, else null
 * @property {string|null} shell  the iOS browser other than Safari ('CriOS', 'FxiOS', 'EdgiOS', ...), else null
 */

const IOS_SHELL = /\b(CriOS|FxiOS|EdgiOS|OPiOS|OPT|YaBrowser|DuckDuckGo|Brave|GSA)\/[\d.]+/;

/**
 * @param {any} nav  a Navigator (or a test double with userAgent / userAgentData / maxTouchPoints)
 * @returns {EngineInfo}
 */
export function engineOf(nav) {
  const ua = String(nav?.userAgent ?? '');
  const data = nav?.userAgentData;
  const brands = Array.isArray(data?.brands) ? data.brands : [];
  const brand = brands.find((/** @type {{brand: string}} */ b) => b.brand === 'Chromium');
  const int = (/** @type {string|undefined} */ s) => { const n = Number.parseInt(s ?? '', 10); return Number.isFinite(n) ? n : null; };
  const touch = Number(nav?.maxTouchPoints) > 1;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touch && !/Chrome\/|Firefox\//.test(ua));
  const android = !ios && (/Android/.test(ua) || data?.platform === 'Android');
  /** @type {EngineInfo['os']} */
  const os = ios ? 'ios' : android ? 'android' : 'desktop';
  const mobile = ios || android;
  /** @param {EngineInfo['engine']} engine @param {number|null} major @param {Partial<EngineInfo>} [more] @returns {EngineInfo} */
  const info = (engine, major, more = {}) => ({ engine, major, mobile, os, webview: null, shell: null, ...more });

  if (ios) {
    if (!/AppleWebKit\//.test(ua)) return info('other', null);
    const shell = IOS_SHELL.exec(ua);
    if (shell) return info('webkit', null, { shell: shell[1] });
    if (!/ Safari\//.test(ua)) return info('webkit', null, { webview: 'ios-webview' });
    const safari = /Version\/(\d+)/.exec(ua);
    return info('webkit', safari ? int(safari[1]) : null);
  }
  const chrome = /Chrome\/(\d+)/.exec(ua);
  if (brand || chrome) {
    const webview = android && (/; wv\)/.test(ua) || /Version\/4\.0 Chrome\//.test(ua) || brands.some((/** @type {{brand: string}} */ b) => b.brand === 'Android WebView'));
    return info('chromium', int(brand ? brand.version : chrome?.[1]), { webview: webview ? 'android-webview' : null });
  }
  const firefox = /Gecko\/[\d.]+.*Firefox\/(\d+)/.exec(ua);
  if (firefox) return info('gecko', int(firefox[1]));
  const safari = /AppleWebKit\/[\d.]+.*Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//.exec(ua);
  if (safari) return info('webkit', int(safari[1]));
  return info('other', null);
}

/** @type {EngineInfo|null} */
let current = null;
/** Engine of the running page (cached; 'other' outside a browser). @returns {EngineInfo} */
export function currentEngine() {
  current ??= engineOf(typeof navigator === 'undefined' ? null : navigator);
  return current;
}

/**
 * Does the engine paint selected text in the selection foreground colour (the system colour HighlightText) when no author `::selection` rule applies?
 * Selection painting is not observable from script (no API reads the pixels of a selection, and the tile of a clone carries no selection), so no feature probe
 * exists and the platform decides; this is the only place that makes that decision.
 *  - Chromium on Linux, Windows, ChromeOS and Android: yes. Its default theme supports selection foreground colours (measured: Chrome 155 on Linux paints the
 *    selected glyphs #ffffff = HighlightText over the Highlight background, on dark and on light controls; Windows takes HighlightText from the system, not measured).
 *  - Chromium on macOS: no. Its macOS theme does not support selection foreground colours: the glyphs keep their own colour (measured, Chrome 155).
 *  - Gecko and WebKit: treated as keeping the glyph colour. Measured on macOS (Firefox, Safari); Firefox on Linux / Windows takes its selection foreground from the
 *    system theme and is not measured, so it keeps the glyph colour here (docs/SUPPORT-MATRIX.md, row `caret-selection`). Every iOS browser is WebKit.
 * @param {any} nav  a Navigator (or a test double with userAgent / userAgentData)
 * @returns {boolean}
 */
export function selectionForegroundOf(nav) {
  if (engineOf(nav).engine !== 'chromium') return false;
  const platform = String(nav?.userAgentData?.platform ?? '');
  return platform ? platform !== 'macOS' : !/Macintosh|Mac OS X/.test(String(nav?.userAgent ?? ''));
}

/** @type {boolean|null} */
let selectionForeground = null;
/** selectionForegroundOf() for the running page (cached). @returns {boolean} */
export function currentSelectionForeground() {
  selectionForeground ??= selectionForegroundOf(typeof navigator === 'undefined' ? null : navigator);
  return selectionForeground;
}
