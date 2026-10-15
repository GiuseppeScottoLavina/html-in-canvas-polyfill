/**
 * Wrap the clone markup into the foreignObject SVG and encode as a data: URL (never blob:).
 * Module: snapshot-capture (src/snapshot/capture/*). The string parts are pure.
 */

import { currentEngine } from '../../util/engine.js';

/** @typedef {import('../../contracts/types.js').Rect} Rect */
/** @typedef {import('../../contracts/types.js').Size} Size */

// Characters XML 1.0 cannot carry: they would make the whole image fail to load.
const XML_BAD = '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F' + String.fromCharCode(0xfffe, 0xffff) + ']';
const INVALID_XML = new RegExp(XML_BAD, 'g');
const HAS_INVALID_XML = new RegExp(XML_BAD);

/** @param {number} n @returns {string} a short decimal */
const num = (n) => String(+n.toFixed(4));

/**
 * Size of the raster that `crop` becomes at `scale`.
 * @param {Rect} crop
 * @param {number} scale
 * @returns {{widthPx: number, heightPx: number}}
 */
export function cropPixels(crop, scale) {
  // Rounded UP like the surface (pump.js planGeometry): a rounded-down whole-frame tile was stretched by up to 1 px into the surface (a fractional-width drawable drifted by a fraction of a pixel).
  return { widthPx: Math.max(1, Math.ceil(crop.width * scale - 1e-6)), heightPx: Math.max(1, Math.ceil(crop.height * scale - 1e-6)) };
}

/**
 * The SVG document text. `crop` is in css px with its origin at the top-left of the laid-out frame; the viewBox is the crop at physical-pixel scale
 * (layout happens at that scale through `zoom` on the root, because viewBox up-scaling drifted line metrics).
 * @param {string} rootHtml  serialised div.hic-root
 * @param {string} css
 * @param {Rect} crop
 * @param {Size} frame
 * @param {number} scale
 * @param {ScaleMode} [mode]  'zoom' (layout at device scale, Chromium), 'transform' (layout at css scale, a CSS scale on the root: WebKit) or 'viewBox' (layout at css scale, the image scales it: Gecko); see scaleMode
 * @returns {string}
 */
export function buildSvgMarkup(rootHtml, css, crop, frame, scale, mode = 'zoom') {
  const { widthPx, heightPx } = cropPixels(crop, scale);
  // An SVG <style> (a child of the <svg> root) styles the foreignObject HTML exactly like an XHTML one inside it, but Chromium loads the image at once with it
  // (complete one microtask after `src` is set) while an XHTML <style> delays the load to a later task: that is what lets a tile land, and its paint fire, in the task that built it.
  const style = css ? `<style>${css.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</style>` : '';
  const k = mode === 'viewBox' ? 1 : scale;
  const box = mode === 'viewBox' ? `${num(widthPx / scale)} ${num(heightPx / scale)}` : `${widthPx} ${heightPx}`;
  // 'transform' (WebKit): the viewBox ORIGIN is ignored for HTML with its own layer too, so a damage-cropped tile showed the frame's top-left and was pasted at the crop
  // position (pieces of the page in the wrong place on focus/caret/typing). The crop offset travels in the root's CSS transform instead (rootTransform) and the viewBox starts at 0 0.
  const origin = mode === 'transform' ? '0 0' : `${num(crop.x * k)} ${num(crop.y * k)}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="${origin} ${box}">`
    + `${style}<foreignObject x="0" y="0" width="${num(frame.width * k)}" height="${num(frame.height * k)}">${rootHtml}</foreignObject></svg>`;
  return HAS_INVALID_XML.test(svg) ? svg.replace(INVALID_XML, '') : svg;
}

/** @typedef {'zoom'|'viewBox'|'transform'} ScaleMode */

/**
 * The root's CSS transform in 'transform' mode: the crop offset (device px) then the scale, origin 0 0. Null when there is nothing to apply.
 * @param {Rect} crop @param {number} scale @returns {string|null}
 */
export function rootTransform(crop, scale) {
  const tx = -crop.x * scale;
  const ty = -crop.y * scale;
  if (scale === 1 && !tx && !ty) return null;
  return `translate(${num(tx)}px, ${num(ty)}px) scale(${scale})`;
}

/**
 * How the image reaches device scale. Chromium lays out at device scale through `zoom` (viewBox up-scaling drifted its line metrics).
 * Gecko 155 and WebKit 27 pick the font OPTICAL SIZE from the zoomed size inside an SVG image (system-ui at 15 px zoomed x2 is set 8 % narrower than in the
 * page, G-xbrowser probe); laid out at css scale their text matches the page within 3 device px per 900. Gecko scales through the viewBox. WebKit does NOT apply
 * the viewBox (nor an SVG transform) to HTML that has its own layer (positioned, scrolling, transformed boxes: the drawable root always is), which came out at 1x and
 * offset; a CSS `transform: scale(s)` on the root is carried by those layers, so WebKit uses 'transform'. Not feature-detectable synchronously (an image decode is
 * needed), hence the engine switch.
 * @returns {ScaleMode}
 */
export function scaleMode() {
  const { engine } = currentEngine();
  return engine === 'gecko' ? 'viewBox' : engine === 'webkit' ? 'transform' : 'zoom';
}

/**
 * Percent-encoded data: URL of an SVG document (base64 measured no better).
 * @param {string} svg
 * @returns {string}
 */
export function encodeSvgDataUrl(svg) {
  let body;
  try {
    body = encodeURIComponent(svg);
  } catch {
    body = encodeURIComponent(/** @type {any} */ (svg).toWellFormed());
  }
  return 'data:image/svg+xml;charset=utf-8,' + body;
}

/**
 * viewBox crops the damage rect at scale s; layout at physical-pixel scale through zoom:s inside the image; percent-encoded data:image/svg+xml;charset=utf-8.
 * `crop` is relative to the top-left of the frame (the laid-out root); `root` gets its zoom written here.
 * @param {Element} root
 * @param {string} css
 * @param {Rect} crop
 * @param {Size} frame
 * @param {number} scale
 * @returns {{url: string, bytes: number}}
 */
export function buildSvgDataUrl(root, css, crop, frame, scale) {
  const mode = scaleMode();
  if (scale !== 1 && mode === 'zoom') /** @type {HTMLElement} */ (root).style.setProperty('zoom', String(scale));
  const transform = mode === 'transform' ? rootTransform(crop, scale) : null;
  if (transform) {
    /** @type {HTMLElement} */ (root).style.setProperty('transform', transform, 'important');
    /** @type {HTMLElement} */ (root).style.setProperty('transform-origin', '0 0', 'important');
  }
  const url = encodeSvgDataUrl(buildSvgMarkup(new XMLSerializer().serializeToString(root), css, crop, frame, scale, mode));
  return { url, bytes: url.length };
}
