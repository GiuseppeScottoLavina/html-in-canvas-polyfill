/**
 * Per-node state copy (values, checked, selected, open, canvas/video frames, frozen animations, interaction classes).
 * Module: snapshot-capture (src/snapshot/capture/*).
 */

import { MARK } from '../../contracts/events.js';
import { inlineCssUrls, resolveResource } from './inline-resources.js';
import { appendInlineStyle, setInlineStyle } from './inline-style.js';
import { scaleMode } from './svg-builder.js';
import { usedColorScheme } from './color-scheme.js';
import { engineSkins, skinsFor } from './engine-skins.js';

/** @typedef {import('../../contracts/types.js').CaptureRequest} CaptureRequest */
/** @typedef {import('../../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../../contracts/types.js').UnsupportedEntry} UnsupportedEntry */

/** Tags whose clone must not receive the source's child nodes (their content is state, not markup). */
export const LEAF_TAGS = new Set(['textarea', 'canvas', 'video', 'audio', 'img', 'input', 'iframe', 'frame', 'object', 'embed']);
const KEEP_HIC_ATTRS = new Set(['data-hic-root', 'data-hic-shell', 'data-hic-s', 'data-hic-sp']);
const XML_ATTR_NAME = /^[A-Za-z_][\w.-]*$/;
const MAX_CANVAS_PIXELS = 4_000_000;
const MAX_VIDEO_SIDE = 640;
const ANIMATION_KEYS = new Set(['offset', 'easing', 'composite', 'computedOffset']);

/** @param {Element} el @param {Element|null} [stop] @returns {string} css-like path ("form#f > input.name") for UnsupportedEntry.path */
export function elementPath(el, stop = null) {
  const parts = [];
  for (let cur = /** @type {Element|null} */ (el); cur && cur !== stop && parts.length < 6; cur = cur.parentElement) {
    if (cur.localName === 'canvas' || cur.localName === MARK.LAYER_TAG) break;
    const cls = typeof cur.className === 'string' ? cur.className.trim().split(/\s+/)[0] : '';
    parts.unshift(cur.localName + (cur.id ? `#${cur.id}` : cls ? `.${cls}` : ''));
  }
  return parts.join(' > ');
}

/**
 * Drop what must not reach the image document: event handlers, polyfill markers, attribute names XML cannot carry (frameworks use `@click`, `:class`), autofocus.
 * @param {Element} el
 */
export function cleanAttributes(el) {
  const attrs = el.attributes;
  for (let i = attrs.length - 1; i >= 0; i--) {
    const a = attrs[i];
    const name = a.name;
    if (a.namespaceURI) continue;
    if ((name.charCodeAt(0) === 111 && name.charCodeAt(1) === 110) || name === 'autofocus' || !XML_ATTR_NAME.test(name) || (name.startsWith('data-hic-') && !KEEP_HIC_ATTRS.has(name))) el.removeAttribute(name);
  }
}

/**
 * @param {UnsupportedEntry[]} list
 * @param {Element} src
 * @param {string} feature
 * @param {string} message
 * @param {string} [hint]
 */
export function addUnsupported(list, src, feature, message, hint) {
  const path = elementPath(src);
  if (!list.some((e) => e.feature === feature && e.path === path)) list.push({ feature, message: `${message}${path ? ` (${path})` : ''}`, hint, path, t: 0, count: 1 });
}

/**
 * @param {UnsupportedEntry[]} list
 * @param {Element} src
 * @param {string} feature
 * @param {string} message
 * @param {string} [hint]
 * @returns {false}
 */
function refuse(list, src, feature, message, hint) {
  addUnsupported(list, src, feature, message, hint);
  return false;
}

/** @param {string} value @returns {string} */
const kebab = (value) => value.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

/**
 * Write the COMPUTED value of each animated property inline and set animation/transition none (docs: css-animations).
 * @param {Element} src
 * @param {HTMLElement} clone
 */
export function freezeAnimations(src, clone) {
  const anims = src.getAnimations ? src.getAnimations() : [];
  if (!anims.length) return;
  const cs = (src.ownerDocument.defaultView ?? window).getComputedStyle(src);
  const props = new Set();
  for (const a of anims) {
    const effect = /** @type {KeyframeEffect|null} */ (a.effect);
    if (!effect || effect.pseudoElement) continue;
    if (typeof /** @type {any} */ (a).transitionProperty === 'string') props.add(/** @type {any} */ (a).transitionProperty);
    else for (const kf of effect.getKeyframes()) for (const key of Object.keys(kf)) if (!ANIMATION_KEYS.has(key)) props.add(key === 'cssFloat' ? 'float' : kebab(key));
  }
  for (const p of props) clone.style.setProperty(p, cs.getPropertyValue(p));
  clone.style.setProperty('animation', 'none', 'important');
  clone.style.setProperty('transition', 'none', 'important');
}

/**
 * The state the live tree has and a clone cannot: hover/active chains, focus, focus-within.
 * @typedef {Object} InteractionContext
 * @property {ReadonlySet<Element>} hover
 * @property {ReadonlySet<Element>} active
 * @property {Element|null} focus
 * @property {boolean} focusVisible
 * @property {ReadonlySet<Element>} focusWithin  the focused element and its ancestors
 */

/**
 * @param {CaptureRequest["interaction"]} ix
 * @param {Element|null} [stop]  the layer: ancestors above it are never classed
 * @returns {InteractionContext}
 */
export function interactionContext(ix, stop = null) {
  const within = new Set();
  for (let cur = ix.focus; cur && cur !== stop; cur = cur.parentElement) within.add(cur);
  return { hover: ix.hover, active: ix.active, focus: ix.focus, focusVisible: ix.focusVisible, focusWithin: within };
}

/**
 * Classes the clone carries instead of live pseudo-class state.
 * @param {Element} src
 * @param {Element} clone
 * @param {InteractionContext} ix
 */
export function applyInteractionClasses(src, clone, ix) {
  let add = '';
  if (ix.hover.has(src)) add += ' ' + MARK.CLS_HOVER;
  if (ix.active.has(src)) add += ' ' + MARK.CLS_ACTIVE;
  if (ix.focusWithin.has(src)) {
    add += ' ' + MARK.CLS_FOCUS_WITHIN;
    if (src === ix.focus) add += ' ' + MARK.CLS_FOCUS + (ix.focusVisible ? ' ' + MARK.CLS_FOCUS_VISIBLE : '');
  }
  if (add) clone.setAttribute('class', ((clone.getAttribute('class') ?? '') + add).trim());
  if (ix.hover.has(src) && src.localName === 'input' && /** @type {HTMLInputElement} */ (src).type === 'range') lightenHoveredRange(src, clone);
}

/**
 * The engine draws a hovered range slider with its accent colour lightened by about 42 % towards white (measured on `#79efff`: 121,239,255 -> 177,246,255). That look belongs to the
 * native control, not to a `:hover` rule, so the clone gets the same mix as its accent.
 * @param {Element} src @param {Element} clone
 */
function lightenHoveredRange(src, clone) {
  appendInlineStyle(clone, `accent-color:color-mix(in srgb, ${accentOf(src)} 58%, white)!important;`);
}

/**
 * The accent colour of a control as a colour value: the author's, else the engine default of the control's colour scheme (the `AccentColor` keyword does not resolve in the image document).
 * @param {Element} src @returns {string}
 */
function accentOf(src) {
  const cs = (src.ownerDocument.defaultView ?? window).getComputedStyle(src);
  return cs.accentColor !== 'auto' ? cs.accentColor : usedColorScheme(src.ownerDocument, cs.colorScheme).includes('dark') ? '#99c8ff' : '#0075ff';
}

// ---------------------------------------------------------------------------------------------- element kinds

/**
 * Inline style attribute: url()s become data: URLs.
 * @param {HicEnv} env
 * @param {Element} clone
 * @param {CaptureRequest} req
 * @param {UnsupportedEntry[]} unsupported
 * @param {Element} src
 */
function inlineStyleUrls(env, clone, req, unsupported, src) {
  const style = clone.getAttribute('style');
  if (!style || !/url\(/i.test(style)) return;
  const r = inlineCssUrls(style, env.document.baseURI, req.resources);
  setInlineStyle(clone, r.css);
  for (const f of r.failed) refuse(unsupported, src, f.error.feature, f.error.message, f.error.hint);
  if (r.pending.length) markPending(unsupported);
}

/** @type {WeakSet<UnsupportedEntry[]>} capture sinks (the `unsupported` array of one capture) that had to leave a resource out */
const pendingSinks = new WeakSet();

/**
 * True for an element that is rendered in the top layer (modal dialog, open popover, fullscreen element). Natively it is painted in the page's top layer and NOT into the canvas
 * (WPT top-layer-not-painted-in-canvas); the live element does exactly that from the layer (top-layer rendering escapes the layer's opacity), so the clone leaves it out.
 * @param {Element} src @returns {boolean}
 */
export function inTopLayer(src) {
  for (const sel of [':modal', ':popover-open', ':fullscreen']) {
    try { if (src.matches(sel)) return true; } catch { /* selector unknown to this engine */ }
  }
  return false;
}

/**
 * The elements of `root`'s subtree (and `root` itself) rendered in the top layer, in its own tree scope: one query per pseudo-class instead of three matches() per cloned element.
 * @param {Element} root @returns {Set<Element>}
 */
export function topLayerIn(root) {
  /** @type {Set<Element>} */
  const out = new Set();
  if (inTopLayer(root)) out.add(root);
  for (const sel of [':modal', ':popover-open', ':fullscreen']) {
    try { for (const el of root.querySelectorAll(sel)) out.add(el); } catch { /* selector unknown to this engine */ }
  }
  return out;
}

/** @param {UnsupportedEntry[]} sink a resource was left out: the capture is `complete: false` */
export function markPending(sink) { pendingSinks.add(sink); }

/** @param {UnsupportedEntry[]} sink @returns {boolean} */
export function isPending(sink) { return pendingSinks.has(sink); }

/** A data: URL that cannot be decoded: an <img> showing it is drawn as a broken image. */
const BROKEN_IMAGE = 'data:image/png;base64,AAAA';

/** @param {CSSStyleDeclaration} cs @returns {string} the used size as an inline declaration */
const usedSize = (cs) => `width:${cs.width}!important;height:${cs.height}!important;`;

/**
 * @param {HicEnv} env @param {HTMLImageElement} src @param {Element} clone @param {CaptureRequest} req @param {UnsupportedEntry[]} unsupported
 * @returns {boolean}
 */
function syncImage(env, src, clone, req, unsupported) {
  const abs = src.currentSrc || src.src;
  clone.removeAttribute('srcset');
  clone.removeAttribute('sizes');
  clone.removeAttribute('loading');
  if (!abs) return true;
  const cs = (src.ownerDocument.defaultView ?? window).getComputedStyle(src);
  const r = resolveResource(req.resources, abs, abs.endsWith('.svg') ? 'svg' : 'image');
  if (r.state === 'failed' && r.error.feature === 'resource-fetch-failed') {
    // The platform draws a broken <img> as the broken-image icon in its box (WPT broken-image): an undecodable data: URL gives the same picture, the failure is still reported.
    addUnsupported(unsupported, src, r.error.feature, r.error.message, r.error.hint);
    clone.setAttribute('src', BROKEN_IMAGE);
    appendInlineStyle(clone, usedSize(cs));
    return true;
  }
  if (r.state === 'failed') return refuse(unsupported, src, r.error.feature, r.error.message, r.error.hint);
  clone.removeAttribute('src');
  appendInlineStyle(clone, usedSize(cs));
  if (r.state === 'pending') { markPending(unsupported); return true; }
  clone.setAttribute('src', r.url);
  return true;
}

/**
 * @param {Element} src canvas @param {Element} clone @param {UnsupportedEntry[]} unsupported
 * @returns {Element|false}
 */
function syncCanvas(src, clone, unsupported) {
  const c = /** @type {HTMLCanvasElement} */ (src);
  const doc = clone.ownerDocument;
  if (c.width * c.height > MAX_CANVAS_PIXELS) return refuse(unsupported, src, 'canvas-child', `canvas of ${c.width}x${c.height} exceeds the size budget`, 'Draw large canvases outside the drawable or reduce their size.');
  let url;
  try {
    url = c.width && c.height ? c.toDataURL('image/png') : '';
  } catch {
    return refuse(unsupported, src, 'canvas-child', 'tainted canvas cannot be read', 'Load the images drawn into it with CORS (crossorigin="anonymous").');
  }
  const img = doc.createElement('img');
  for (const a of ['class', 'id', 'style', 'title', 'hidden']) if (src.hasAttribute(a)) img.setAttribute(a, src.getAttribute(a) ?? '');
  const cs = (src.ownerDocument.defaultView ?? window).getComputedStyle(src);
  appendInlineStyle(img, usedSize(cs));
  if (url) img.setAttribute('src', url);
  return img;
}

/** @param {Element} src video @param {Element} clone @param {UnsupportedEntry[]} unsupported @param {CaptureRequest} req @returns {Element|false} */
function syncVideo(src, clone, unsupported, req) {
  const v = /** @type {HTMLVideoElement} */ (src);
  const doc = clone.ownerDocument;
  if (v.controls) addUnsupported(unsupported, src, 'video-controls', 'the control bar of <video controls> is native UI and is not drawn into the snapshot', 'Draw your own controls inside the drawable, or put the video outside it.');
  const cs = (src.ownerDocument.defaultView ?? window).getComputedStyle(src);
  const img = doc.createElement('img');
  for (const a of ['class', 'id', 'style', 'title', 'hidden']) if (src.hasAttribute(a)) img.setAttribute(a, src.getAttribute(a) ?? '');
  appendInlineStyle(img, `${usedSize(cs)}object-fit:${cs.objectFit};object-position:${cs.objectPosition};`);
  let url = '';
  if (v.readyState >= 2 && v.videoWidth > 0) {
    try {
      const k = Math.min(1, MAX_VIDEO_SIDE / Math.max(v.videoWidth, v.videoHeight));
      const tmp = src.ownerDocument.createElement('canvas');
      tmp.width = Math.round(v.videoWidth * k);
      tmp.height = Math.round(v.videoHeight * k);
      tmp.getContext('2d')?.drawImage(v, 0, 0, tmp.width, tmp.height);
      url = tmp.toDataURL('image/jpeg', 0.85);
    } catch {
      return refuse(unsupported, src, 'cross-origin-resource', 'video frame of a cross-origin source cannot be read', 'Serve the video with CORS and crossorigin="anonymous".');
    }
  } else if (v.poster) {
    const r = resolveResource(req.resources, v.poster, 'image');
    if (r.state === 'ready') url = r.url;
    else if (r.state === 'pending') markPending(unsupported);
  }
  if (url) img.setAttribute('src', url);
  return img;
}

const TEXTAREA_LOOK = ['box-sizing', 'width', 'height', 'padding', 'border', 'border-radius', 'font', 'letter-spacing', 'word-spacing', 'line-height', 'color', 'background', 'text-align', 'tab-size',
  'text-transform', 'text-indent', 'text-shadow', 'direction'];

/**
 * A textarea that scrolls (or has a bar gutter) becomes a div with the same box and look: a textarea cannot be scrolled from markup, a div can (scroll-emulation).
 * @param {HTMLTextAreaElement} src @param {Element} clone
 * @returns {Element}
 */
function textareaAsDiv(src, clone) {
  const cs = (src.ownerDocument.defaultView ?? window).getComputedStyle(src);
  const div = clone.ownerDocument.createElement('div');
  for (const a of ['class', 'id', 'title']) if (src.hasAttribute(a)) div.setAttribute(a, src.getAttribute(a) ?? '');
  let look = `${clone.getAttribute('style') ?? ''};display:block!important;overflow:hidden!important;white-space:pre-wrap!important;overflow-wrap:break-word!important;`;
  for (const p of TEXTAREA_LOOK) look += `${p}:${cs.getPropertyValue(p)}!important;`;
  appendInlineStyle(div, look);
  div.textContent = src.value;
  return div;
}

export { usedColorScheme } from './color-scheme.js';

/**
 * `indeterminate` is a JS property: it does not survive serialisation, so the clone shows the mixed state the way the engine draws it (accent fill, white or dark dash) through `appearance:none` (which also moves the baseline: the 3 px offset keeps the line box).
 * The look is that of a 13 px desktop checkbox, scaled to the live box (Chrome for Android's checkboxes are 16 px).
 * @param {HTMLInputElement} src @param {Element} clone
 */
function paintIndeterminate(src, clone) {
  const fill = src.disabled ? '#d1d1d1' : accentOf(src);
  const cs = (src.ownerDocument.defaultView ?? window).getComputedStyle(src);
  // the dash is dark on the default dark-scheme fill (measured Chrome 155 desktop and Chromium 158 Android: #3b3b3b on #99c8ff)
  const dash = fill === '#99c8ff' ? '#3b3b3b' : '#fff';
  const side = (/** @type {string} */ v) => (parseFloat(v) || 0);
  const w = cs.boxSizing === 'border-box' ? side(cs.width) : side(cs.width) + side(cs.paddingLeft) + side(cs.paddingRight) + side(cs.borderLeftWidth) + side(cs.borderRightWidth);
  const h = cs.boxSizing === 'border-box' ? side(cs.height) : side(cs.height) + side(cs.paddingTop) + side(cs.paddingBottom) + side(cs.borderTopWidth) + side(cs.borderBottomWidth);
  const f = (w > 0 ? w : 13) / 13;
  const n = (/** @type {number} */ v) => +(v * f).toFixed(3);
  clone.removeAttribute('checked');
  appendInlineStyle(clone, `appearance:none!important;-webkit-appearance:none!important;box-sizing:border-box!important;width:${w > 0 ? w : 13}px!important;height:${h > 0 ? h : 13}px!important;border-radius:${n(2)}px!important;border:0!important;vertical-align:${n(-3)}px!important;background-color:${fill}!important;background-image:linear-gradient(${dash},${dash})!important;background-size:${n(8)}px ${n(2)}px!important;background-position:center!important;background-repeat:no-repeat!important;`);
}

/**
 * Chromium draws a checkbox / radio inside the image at the image's zoom, and at a zoom a little off the device scale its theme draws the box smaller (measured on
 * Chromium 158 Android at DPR 2.625: 40 device px at zoom 2.62632, the canvas grid scale of a 380 css px canvas 998 px wide, against 42 in the page; a size a hair
 * above a whole device pixel is drawn smaller, a size at or just below it is not). A zoom on the
 * control brings its own scale back to the page's (devicePixelRatio) when the raster scale is within 1 % of it. Other engines and other scales: unchanged.
 * @param {HTMLInputElement} src @param {Element} clone @param {number} scale
 */
function matchToggleZoom(src, clone, scale) {
  const win = src.ownerDocument.defaultView ?? window;
  const dpr = win.devicePixelRatio;
  if (scaleMode() !== 'zoom' || !(dpr > 0) || !(scale > 0) || dpr === scale || Math.abs(dpr / scale - 1) > 0.01) return;
  const own = parseFloat(win.getComputedStyle(src).zoom) || 1;
  // the root's zoom reaches the image with 6 significant digits; the product must not land a hair ABOVE the page's scale (16 px x 2.6250042 drew 40 px, 2.625 x 16 = 42),
  // so the control's zoom is rounded down
  const root = Number(scale.toPrecision(6));
  appendInlineStyle(clone, `zoom:${Math.floor(((own * dpr) / root) * 1e5) / 1e5}!important;`);
}

/** @param {HTMLInputElement} src @param {Element} clone @param {number} scale */
function syncInput(src, clone, scale) {
  const type = (src.type || 'text').toLowerCase();
  if (type === 'checkbox' || type === 'radio') matchToggleZoom(src, clone, scale);
  if (type === 'checkbox' && src.indeterminate) paintIndeterminate(src, clone);
  else if (type === 'checkbox' || type === 'radio') {
    clone.toggleAttribute('checked', src.checked);
  } else if (type === 'range') {
    clone.setAttribute('value', src.value);
  } else if (type !== 'file' && type !== 'image' && (src.hasAttribute('value') || !BUTTON_LABEL_TYPES.has(type))) {
    clone.setAttribute('value', src.value);
    if (src.scrollLeft > 0 && TEXT_SCROLL_TYPES.has(type)) scrollInputText(src, clone);
  }
}

/** Buttons whose label is the engine default while they have no value attribute (writing `value=""` would blank it). */
const BUTTON_LABEL_TYPES = new Set(['submit', 'reset']);

/** Text controls whose inner editor scrolls horizontally with the caret. */
const TEXT_SCROLL_TYPES = new Set(['text', 'search', 'url', 'tel', 'password', 'email', 'number']);

/**
 * A text field whose text is scrolled (typing past the right edge) shows the END of the value in the live page. The clone input cannot be scrolled from markup, so the text is shifted
 * by a negative text-indent of the same distance (left-to-right fields; the inner editor clips it exactly like the live scroll does).
 * @param {HTMLInputElement} src @param {Element} clone
 */
function scrollInputText(src, clone) {
  const cs = (src.ownerDocument.defaultView ?? window).getComputedStyle(src);
  if (cs.direction !== 'ltr') return;
  appendInlineStyle(clone, `text-indent:calc(${cs.textIndent} - ${src.scrollLeft}px)!important;`);
}

/**
 * Copy the live state of `src` onto `clone`. Returns true when the clone stays, false when src is unsupported (iframe, shadow host, top layer, ...) and the caller must put a placeholder in its place
 * (an entry was pushed to `unsupported`), or the element that replaces the clone (canvas and video frames become an <img>).
 * @param {HicEnv} env
 * @param {Element} src
 * @param {Element} clone
 * @param {CaptureRequest} req
 * @param {UnsupportedEntry[]} unsupported
 * @returns {boolean|Element}
 */
export function syncNodeState(env, src, clone, req, unsupported) {
  const ln = src.localName;
  switch (ln) {
    case 'iframe': case 'frame': case 'object': case 'embed':
      return refuse(unsupported, src, 'iframe', `<${ln}> cannot be captured`, 'Replace it with an <img> or draw it outside the drawable.');
    case 'input': syncInput(/** @type {HTMLInputElement} */ (src), clone, req.scale); break;
    case 'textarea': {
      const ta = /** @type {HTMLTextAreaElement} */ (src);
      if (ta.scrollHeight > ta.clientHeight || ta.scrollWidth > ta.clientWidth || ta.offsetWidth > ta.clientWidth + 2 * ta.clientLeft) { const div = textareaAsDiv(ta, clone); const skins = skinsFor(env, req); if (skins) { skins.paintNativeControl(ta, div); if (skins.consumeSkinPending()) markPending(unsupported); } return div; }
      clone.textContent = ta.value;
      break;
    }
    case 'option': clone.toggleAttribute('selected', /** @type {HTMLOptionElement} */ (src).selected); break;
    case 'details': clone.toggleAttribute('open', /** @type {HTMLDetailsElement} */ (src).open); break;
    case 'dialog':
      clone.toggleAttribute('open', /** @type {HTMLDialogElement} */ (src).open);
      break;
    case 'img': if (!syncImage(env, /** @type {HTMLImageElement} */ (src), clone, req, unsupported)) return false; break;
    case 'canvas': return syncCanvas(src, clone, unsupported);
    case 'video': return syncVideo(src, clone, unsupported, req);
    case 'image':
      if (src.namespaceURI === 'http://www.w3.org/2000/svg') {
        const href = src.getAttribute('href') ?? src.getAttribute('xlink:href') ?? '';
        if (href && !href.startsWith('data:')) {
          const r = resolveResource(req.resources, new URL(href, env.document.baseURI).href, 'image');
          if (r.state === 'failed') return refuse(unsupported, src, r.error.feature, r.error.message, r.error.hint);
          if (r.state === 'pending') markPending(unsupported);
          clone.setAttribute('href', r.state === 'ready' ? r.url : 'data:,');
          clone.removeAttribute('xlink:href');
        }
      }
      break;
    default:
  }
  inlineStyleUrls(env, clone, req, unsupported, src);
  if (scaleMode() === 'transform') webkitShadows(src, clone);
  const skins = skinsFor(env, req);
  const painted = skins ? skins.paintNativeControl(src, clone) : false;
  if (skins?.consumeSkinPending()) markPending(unsupported);
  if (typeof painted === 'object') return painted;
  return true;
}

/** WebKit 'transform' mode: outer box-shadows are mispainted under the scale, the clone carries them as outline / drop-shadow (webkit-shadow.js). @param {Element} src @param {Element} clone */
function webkitShadows(src, clone) {
  const cs = (src.ownerDocument.defaultView ?? window).getComputedStyle(src);
  if (cs.boxShadow === 'none' || !cs.boxShadow) return;
  const decl = engineSkins()?.webkitShadowStyle(cs) ?? '';
  if (decl) appendInlineStyle(clone, decl);
}
