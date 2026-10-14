/**
 * Seam to the ENGINES bundle (optimization 7): the form-control skins, the WebKit scrollbars and the WebKit shadow rewrite are drawn by the polyfill only on Gecko and
 * WebKit, so they live outside the Chrome core in `hic-live-engines.iife.js` (ESM: imported by the package entry). That bundle registers its painter on a global symbol,
 * in any order relative to the core; the capture looks it up when it needs it. On Gecko / WebKit without it, form controls are drawn by the engine's image renderer and the
 * capture reports it loudly once (feature engine-gecko / engine-webkit).
 * Module: snapshot-capture (src/snapshot/capture/*).
 */

import { currentEngine } from '../../util/engine.js';

/** @typedef {import('../../contracts/types.js').CaptureRequest} CaptureRequest */
/** @typedef {import('../../contracts/types.js').HicEnv} HicEnv */

/**
 * @typedef {Object} EngineSkins  what the engines bundle provides (src/engines.js)
 * @property {(src: Element, clone: Element) => boolean|Element} paintNativeControl  paint the live look of a native control on its clone (an element when the clone is replaced); false when nothing was done
 * @property {() => boolean} consumeSkinPending  a skin painted since the last call was still decoding (the capture must be retried)
 * @property {(cb: () => void) => () => void} onSkinReady  a skin a capture used cold has decoded
 * @property {(cs: {boxShadow: string, outlineStyle: string, filter: string, position: string}) => string} webkitShadowStyle  WebKit 'transform' mode shadow rewrite
 * @property {(win: Window, src: Element, clone: HTMLElement, f: any, dark: boolean) => void} paintWebkitBars  WebKit classic scrollbars
 * @property {(win: Window, src: Element) => boolean} webkitDarkBars
 */

export const ENGINE_SKINS_KEY = Symbol.for('hic.engine-skins');

/** @returns {EngineSkins|null} the registered engines bundle */
export function engineSkins() {
  return /** @type {any} */ (globalThis)[ENGINE_SKINS_KEY] ?? null;
}

/** @param {EngineSkins} skins called by the engines bundle */
export function registerEngineSkins(skins) {
  /** @type {any} */ (globalThis)[ENGINE_SKINS_KEY] = skins;
}

/**
 * The painter for this capture: null on Chromium (it draws its controls inside SVG images itself) and, loudly, on Gecko / WebKit when the engines bundle is missing.
 * @param {HicEnv} env @param {CaptureRequest} req @returns {EngineSkins|null}
 */
export function skinsFor(env, req) {
  const engine = currentEngine().engine;
  if (engine !== 'gecko' && engine !== 'webkit') return null;
  const skins = engineSkins();
  if (!skins) {
    env.reporter.unsupported({
      feature: engine === 'gecko' ? 'engine-gecko' : 'engine-webkit',
      message: `form controls on ${engine === 'gecko' ? 'Firefox' : 'Safari'} are drawn by the polyfill's engines bundle, which is not loaded: they keep the engine's image look (legacy, no accent colour)`,
      hint: 'load hic-live-engines.iife.js (any order with the core), or import the package entry instead of the core-only build',
    }, req.record.canvas);
  }
  return skins;
}
