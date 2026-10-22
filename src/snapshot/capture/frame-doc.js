/**
 * The document of a same-origin <iframe>, <frame> or <object> inside a drawable, as a nested SVG image: the platform draws a same-origin frame's document into the canvas
 * (WPT iframe, iframe-local, privacy/iframes-ignored) and leaves out its cross-origin content (privacy/background-image-in-iframe-*: the frame's own cross-origin images are
 * not drawn). The frame's author CSS travels as text (its rules only reach its own document inside the nested image), resources are inlined through the resource cache
 * (unreadable ones are left out, as on the page level), form state is copied, nested frames recurse to a small depth, and the page background propagates to the frame's
 * viewport as in a browsing context. A frame whose document cannot be read (cross-origin, a sandbox without allow-same-origin, not loaded) yields null.
 * Module: snapshot-capture (src/snapshot/capture/*).
 */

import { MARK } from '../../contracts/events.js';
import { inlineCssUrls, resolveResource } from './inline-resources.js';
import { encodeSvgDataUrl } from './svg-builder.js';
import { appendInlineStyle } from './inline-style.js';

/** @typedef {import('../../contracts/types.js').ResourceCache} ResourceCache */

const MAX_DEPTH = 3;
const SKIP = new Set(['script', 'noscript', 'template']);
const XHTML = 'http://www.w3.org/1999/xhtml';

/**
 * The frame's document when this realm may read it; 'loading' while a frame with a source still shows its initial about:blank document (its own document, possibly
 * cross-origin, has not replaced it yet: nothing is drawn and nothing is reported until the load, which repaints the drawable).
 * @param {Element} frame @returns {Document|'loading'|null}
 */
export function frameDocument(frame) {
  /** @type {Document|null} */
  let doc = null;
  try {
    doc = /** @type {HTMLIFrameElement} */ (frame).contentDocument;
  } catch { /* cross-origin */ }
  if (!doc?.documentElement) return null;
  const src = frame.getAttribute(frame.localName === 'object' ? 'data' : 'src');
  return doc.URL === 'about:blank' && src && !/^\s*about:blank/i.test(src) && !frame.hasAttribute('srcdoc') ? 'loading' : doc;
}

/**
 * The author CSS of a document as text with its url()s inlined; a sheet that cannot be read (cross-origin without CORS) is left out, as it cannot be fetched into the image either.
 * @param {Document} doc @param {ResourceCache} cache @param {{pending: boolean}} state
 * @returns {string}
 */
function documentCss(doc, cache, state) {
  let css = '';
  for (const sheet of [...Array.from(doc.styleSheets), ...(doc.adoptedStyleSheets ?? [])]) {
    let text = '';
    try {
      if (sheet.disabled) continue;
      for (const rule of Array.from(sheet.cssRules)) text += rule.cssText + '\n';
    } catch {
      continue;
    }
    const media = sheet.media?.mediaText;
    const r = inlineCssUrls(text, sheet.href ?? doc.baseURI, cache);
    if (r.pending.length) state.pending = true;
    css += media && media !== 'all' ? `@media ${media}{${r.css}}` : r.css;
  }
  return css;
}

/**
 * Copy of `src` (an element of the frame document) into `doc`, with its subtree; resources inlined, live form state copied, managed polyfill nodes (a frame that runs its own
 * install) and scripts left out.
 * @param {Element} src @param {Document} doc @param {ResourceCache} cache @param {{pending: boolean}} state @param {number} depth
 * @returns {Element|null}
 */
function copyTree(src, doc, cache, state, depth) {
  const ln = src.localName;
  if (SKIP.has(ln) || src.hasAttribute(MARK.NODE_ATTR)) return null;
  if ((ln === 'iframe' || ln === 'frame' || ln === 'object') && src.namespaceURI === XHTML) {
    const box = ownBox(src, doc.documentElement);
    const page = frameImage(src, doc, cache, state, depth + 1);
    if (typeof page === 'object' && page) box.appendChild(page);
    return box;
  }
  const el = /** @type {Element} */ (doc.importNode(src, false));
  for (const name of el.getAttributeNames()) if (/^on/i.test(name) || name === 'autofocus' || !/^[A-Za-z_][\w.:-]*$/.test(name)) el.removeAttribute(name);
  const style = el.getAttribute('style');
  if (style && /url\(/i.test(style)) {
    const r = inlineCssUrls(style, src.ownerDocument.baseURI, cache);
    if (r.pending.length) state.pending = true;
    /** @type {HTMLElement} */ (el).style.cssText = r.css;
  }
  if (ln === 'img') {
    const img = /** @type {HTMLImageElement} */ (src);
    const abs = img.currentSrc || img.src;
    el.removeAttribute('srcset');
    el.removeAttribute('src');
    if (abs) {
      const r = resolveResource(cache, abs, 'image');
      if (r.state === 'ready') el.setAttribute('src', r.url);
      else if (r.state === 'pending') state.pending = true;
    }
  } else if (ln === 'canvas') {
    const c = /** @type {HTMLCanvasElement} */ (src);
    const img = doc.createElement('img');
    for (const a of ['id', 'class', 'style', 'width', 'height']) if (src.hasAttribute(a)) img.setAttribute(a, src.getAttribute(a) ?? '');
    try { if (c.width && c.height) img.setAttribute('src', c.toDataURL()); } catch { /* tainted: drawn as an empty box */ }
    return img;
  } else if (ln === 'input') {
    const input = /** @type {HTMLInputElement} */ (src);
    if (input.type === 'checkbox' || input.type === 'radio') el.toggleAttribute('checked', input.checked);
    else if (input.type !== 'file') el.setAttribute('value', input.value);
  } else if (ln === 'textarea') {
    el.textContent = /** @type {HTMLTextAreaElement} */ (src).value;
    return el;
  } else if (ln === 'option') el.toggleAttribute('selected', /** @type {HTMLOptionElement} */ (src).selected);
  for (let n = src.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) {
      const child = copyTree(/** @type {Element} */ (n), doc, cache, state, depth);
      if (child) el.appendChild(child);
    } else if (n.nodeType === 3 || n.nodeType === 4) el.appendChild(doc.createTextNode(n.nodeValue ?? ''));
  }
  return el;
}

/**
 * The element's own box (border, background, padding, margins) without its content, as an element of the same computed style: what the platform draws for a frame, an embed or an
 * object whose content is not drawn (measured on the native oracle: a cross-origin iframe, embed or object keeps its border and background). An <iframe> or <embed> in an SVG image
 * paints nothing at all, not even its border, so the box is a <div> (an inline frame becomes an inline-block of the same size).
 * @param {Element} src @param {Element} clone @param {string} [tag]
 * @returns {Element}
 */
export function ownBox(src, clone, tag = 'div') {
  const cs = (src.ownerDocument.defaultView ?? window).getComputedStyle(src);
  const box = clone.ownerDocument.createElement(tag);
  for (const a of ['id', 'class', 'title']) if (src.hasAttribute(a)) box.setAttribute(a, src.getAttribute(a) ?? '');
  let text = '';
  for (let i = 0; i < cs.length; i++) {
    const name = cs[i];
    if (name.startsWith('--') || name.startsWith('transition') || name.startsWith('animation')) continue;
    const value = cs.getPropertyValue(name);
    if (value) text += `${name}:${name === 'display' && value === 'inline' ? 'inline-block' : value}!important;`;
  }
  appendInlineStyle(box, text);
  return box;
}

/**
 * The frame's content box as an <img> of its document, sized to the content box (the frame element's own box is drawn by the caller); null when the document cannot be read,
 * 'loading' before the frame's own document replaced the initial one.
 * @param {Element} frame @param {Document} doc  the document the <img> is created in @param {ResourceCache} cache @param {{pending: boolean}} state @param {number} [depth]
 * @returns {Element|'loading'|null}
 */
export function frameImage(frame, doc, cache, state, depth = 1) {
  const fdoc = depth <= MAX_DEPTH ? frameDocument(frame) : null;
  if (fdoc === 'loading') return fdoc;
  const win = fdoc?.defaultView;
  if (!fdoc || !win) return null;
  const cs = (frame.ownerDocument.defaultView ?? window).getComputedStyle(frame);
  const width = Math.max(0, frame.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0));
  const height = Math.max(0, frame.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0));
  const inert = fdoc.implementation.createHTMLDocument('');
  const root = copyTree(fdoc.documentElement, inert, cache, state, depth);
  if (!root) return null;
  root.setAttribute('xmlns', XHTML);
  // the root background (of <html>, else of <body>) paints the whole viewport in a browsing context; inside the image the root is an ordinary box, so the viewport gets it
  const rootCs = win.getComputedStyle(fdoc.documentElement);
  const bodyCs = fdoc.body ? win.getComputedStyle(fdoc.body) : null;
  const own = rootCs.backgroundColor !== 'rgba(0, 0, 0, 0)' || rootCs.backgroundImage !== 'none';
  const bg = own ? rootCs : bodyCs;
  const viewportBg = bg ? `background-color:${bg.backgroundColor};` : '';
  const page = `position:absolute;left:${-win.scrollX}px;top:${-win.scrollY}px;width:${width}px;min-height:${height}px;margin:0`;
  /** @type {HTMLElement} */ (root).style.cssText += `;${page}`;
  // the propagated background colour is drawn by the viewport box: the page's own root or body box would draw it again, offset by the body margin
  const owner = own ? root : root.querySelector('body');
  if (bg) /** @type {HTMLElement|null} */ (owner)?.style.setProperty('background-color', 'transparent', 'important');
  const css = documentCss(fdoc, cache, state);
  const style = css ? `<style>${css.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</style>` : '';
  const markup = new XMLSerializer().serializeToString(root);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${style}<foreignObject width="${width}" height="${height}">`
    + `<div xmlns="${XHTML}" style="position:relative;overflow:hidden;width:${width}px;height:${height}px;${viewportBg}">${markup}</div></foreignObject></svg>`;
  const img = doc.createElement('img');
  img.setAttribute('src', encodeSvgDataUrl(svg));
  /** @type {HTMLElement} */ (img).style.cssText = `display:block;width:${width}px;height:${height}px`;
  return img;
}
