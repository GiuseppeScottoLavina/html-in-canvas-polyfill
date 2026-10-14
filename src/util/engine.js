/**
 * Browser ENGINE of a navigator (pure, no DOM): Chromium (Chrome, Edge, Opera, ...), Gecko (Firefox) or WebKit (Safari). Used only where an engine behaviour
 * cannot be feature-detected synchronously (how an SVG image scales text, docs/SUPPORT-MATRIX.md "Engines") and by the browser gate; every API difference
 * is feature-detected where it is used.
 * Module: util.
 */

/**
 * @typedef {Object} EngineInfo
 * @property {'chromium'|'gecko'|'webkit'|'other'} engine
 * @property {number|null} major  Chromium major, Firefox major or Safari (Version/) major
 * @property {boolean} mobile
 */

/**
 * @param {any} nav  a Navigator (or a test double with userAgent / userAgentData)
 * @returns {EngineInfo}
 */
export function engineOf(nav) {
  const ua = String(nav?.userAgent ?? '');
  const brands = Array.isArray(nav?.userAgentData?.brands) ? nav.userAgentData.brands : [];
  const brand = brands.find((/** @type {{brand: string}} */ b) => b.brand === 'Chromium');
  const mobile = nav?.userAgentData?.mobile === true || /Mobile|Android|iPhone|iPad|iPod/.test(ua);
  const int = (/** @type {string|undefined} */ s) => { const n = Number.parseInt(s ?? '', 10); return Number.isFinite(n) ? n : null; };
  const chrome = /Chrome\/(\d+)/.exec(ua);
  if (brand || chrome) return { engine: 'chromium', major: int(brand ? brand.version : chrome?.[1]), mobile };
  const firefox = /Gecko\/\d+.*Firefox\/(\d+)/.exec(ua);
  if (firefox) return { engine: 'gecko', major: int(firefox[1]), mobile };
  const safari = /AppleWebKit\/[\d.]+.*Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//.exec(ua);
  if (safari) return { engine: 'webkit', major: int(safari[1]), mobile };
  return { engine: 'other', major: null, mobile };
}

/** @type {EngineInfo|null} */
let current = null;
/** Engine of the running page (cached; 'other' outside a browser). @returns {EngineInfo} */
export function currentEngine() {
  current ??= engineOf(typeof navigator === 'undefined' ? null : navigator);
  return current;
}
