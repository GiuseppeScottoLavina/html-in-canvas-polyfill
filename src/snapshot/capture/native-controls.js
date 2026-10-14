/**
 * WebKit form controls in the clone. Module: snapshot-capture (src/snapshot/capture/*).
 *
 * Safari draws native controls inside an SVG image with the LEGACY macOS look (grey square checkbox, gradient slider, colour input as text, square text fields) and ignores
 * accent-color there: the image document does not inherit the page's `formControlRefreshEnabled` setting, and no markup or CSS turns it on. A control the live page draws
 * natively is therefore drawn by the clone: `appearance:none`, the live box pinned (the refreshed theme sizes controls differently from the legacy one), and the refreshed look
 * painted as an SVG skin (webkit-skins.js, ported from WebKit's painter) through `border-image` (`fill`, outset for the slider thumb's shadow). Text stays the element's own.
 * Controls the author restyled (border or background differing from the UA look) are left alone: WebKit paints those with CSS in both documents.
 */

import { appendInlineStyle } from './inline-style.js';
import { currentEngine } from '../../util/engine.js';
import { pressOnThumb } from '../../util/native-states.js';
import { accentPalette, geckoArrow, geckoBoxSkin, geckoListboxBar, geckoListboxThumb, geckoProgressSkin, geckoRangeSkin, geckoToggleSkin } from './gecko-skins.js';
import { usedColorScheme } from './color-scheme.js';
import {
  THUMB, alpha, buttonSkin, cancelGlyph, css, inactiveTints, luminance, pressedShade, searchSkin, svgDoc, colorWellSkin, foregroundOn, meterSkin, over, popupGlyph, progressSkin, rangeSkin, resizerGlyph, skinUrl, spinGlyph, textFieldSkin,
  tintWithContrast, toggleSkin,
} from './webkit-skins.js';

/** @typedef {import('./webkit-skins.js').Rgba} Rgba */
/** @typedef {import('./webkit-skins.js').Palette} Palette */

const TEXT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);
const DATE_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week']);
const BUTTON_TYPES = new Set(['button', 'submit', 'reset']);
/** Controls WebKit stops painting natively when the author sets a border or background (devolvable widgets). */
const DEVOLVABLE = new Set(['button', 'text', 'menulist', 'listbox', 'textarea', 'progress', 'meter', 'color', 'date']);

/** A hidden probe that can never extend the page's scrollable overflow (an absolute probe at the end of <html> toggled a classic scrollbar mid-frame). */
const PROBE_BOX = 'position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;contain:strict;visibility:hidden;pointer-events:none';

/** @type {Map<string, Rgba>} */
const colorCache = new Map();
/** @type {Map<string, Palette>} */
const palettes = new Map();
/** @type {Map<string, string>} */
const uaLooks = new Map();

/**
 * Any CSS colour as sRGB [r, g, b, a] (computed values can be `oklab()`, `color(display-p3 ...)`): rgb() strings are parsed, the rest resolved through a 1 x 1 canvas.
 * @param {Document} doc @param {string} value @returns {Rgba}
 */
function rgbaOf(doc, value) {
  const hit = colorCache.get(value);
  if (hit) return hit;
  /** @type {Rgba} */
  let out = [0, 0, 0, 0];
  const m = /^rgba?\(([^)]+)\)$/.exec(value.trim());
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    out = [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  } else {
    const c = doc.createElement('canvas');
    c.width = c.height = 1;
    const x = c.getContext('2d', { willReadFrequently: true });
    if (x) {
      x.fillStyle = value;
      x.fillRect(0, 0, 1, 1);
      const d = x.getImageData(0, 0, 1, 1).data;
      out = d[3] ? [d[0] * 255 / d[3], d[1] * 255 / d[3], d[2] * 255 / d[3], d[3] / 255] : [0, 0, 0, 0];
    }
  }
  if (colorCache.size > 256) colorCache.clear();
  colorCache.set(value, out);
  return out;
}

/** @param {Document} doc @param {CSSStyleDeclaration} cs @returns {boolean} the control is drawn in the dark appearance */
function isDark(doc, cs) {
  const scheme = usedColorScheme(doc, cs.colorScheme);
  const dark = /\bdark\b/.test(scheme), light = /\blight\b/.test(scheme);
  const prefersDark = !!doc.defaultView?.matchMedia('(prefers-color-scheme: dark)').matches;
  return dark && (!light || prefersDark);
}

const KEYWORDS = /** @type {const} */ ([['canvas', 'canvas'], ['controlBg', '-webkit-control-background'], ['label', '-apple-system-label'], ['secondaryLabel', '-apple-system-secondary-label'],
  ['tertiaryLabel', '-apple-system-tertiary-label'], ['quaternaryLabel', '-apple-system-quaternary-label'], ['quinaryLabel', '-apple-system-quinary-label'],
  ['containerBorder', '-apple-system-container-border'], ['green', '-apple-system-green'], ['yellow', '-apple-system-yellow'], ['red', '-apple-system-red'], ['accent', '-apple-system-control-accent']]);

/**
 * The system colours of one appearance, resolved once in the live page (a hidden probe with that color-scheme). Fallbacks are the Safari 27 values.
 * @param {Document} doc @param {boolean} dark @returns {Palette & {accent: Rgba}}
 */
function paletteOf(doc, dark) {
  const key = dark ? 'dark' : 'light';
  const hit = palettes.get(key);
  if (hit) return /** @type {any} */ (hit);
  const probe = doc.createElement('div');
  probe.style.cssText = `color-scheme:${key};${PROBE_BOX}`;
  doc.documentElement.appendChild(probe);
  /** @type {any} */
  const p = { dark };
  for (const [name, kw] of KEYWORDS) {
    probe.style.color = '';
    probe.style.color = kw;
    p[name] = rgbaOf(doc, probe.style.color ? getComputedStyle(probe).color : dark ? 'rgb(255,255,255)' : 'rgb(0,0,0)');
  }
  probe.remove();
  p.opaqueFill = dark ? [52, 52, 52, 1] : [230, 230, 230, 1];
  p.opaqueSecondaryFill = dark ? [47, 47, 47, 1] : [235, 235, 235, 1];
  palettes.set(key, p);
  return p;
}

/**
 * Which natively drawn control `src` is, or null (a listbox select is drawn alike in WebKit's page and image; Gecko draws it as a field).
 * @param {Element} src @param {string} [engine] @returns {string|null}
 */
function controlKind(src, engine = 'webkit') {
  switch (src.localName) {
    case 'input': {
      const t = /** @type {HTMLInputElement} */ (src).type;
      if (t === 'checkbox' || t === 'radio' || t === 'range' || t === 'color' || t === 'file') return t;
      if (BUTTON_TYPES.has(t)) return 'button';
      if (TEXT_TYPES.has(t)) return 'text';
      return DATE_TYPES.has(t) ? 'date' : null;
    }
    case 'button': return 'button';
    case 'textarea': return 'textarea';
    case 'select': { const s = /** @type {HTMLSelectElement} */ (src); return s.multiple || s.size > 1 ? (engine === 'gecko' ? 'listbox' : null) : 'menulist'; }
    case 'progress': return 'progress';
    case 'meter': return 'meter';
    default: return null;
  }
}

const LOOK = ['borderTopStyle', 'borderTopWidth', 'borderLeftStyle', 'borderLeftWidth', 'borderTopLeftRadius', 'backgroundColor', 'backgroundImage'];

/** @param {CSSStyleDeclaration} cs @returns {string} border + background signature (a border colour only counts where a border is drawn: `currentcolor` follows the text) */
const lookOf = (cs) => LOOK.map((k) => /** @type {any} */ (cs)[k]).join('|') + (cs.borderTopStyle === 'none' ? '' : '|' + cs.borderTopColor);

/**
 * The UA look (border + background) of a control of this tag/type in this colour scheme, from a hidden `all:revert` probe (cached).
 * @param {Element} src @param {CSSStyleDeclaration} cs @param {string} [pseudo] @returns {string}
 */
function uaLook(src, cs, pseudo = '') {
  const doc = src.ownerDocument;
  const type = src.localName === 'input' ? /** @type {HTMLInputElement} */ (src).type : '';
  const disabled = src.matches(':disabled');
  // a listbox select (multiple, size > 1) has the UA look of a field, a menu list that of a button: the probe takes the same form
  const list = src.localName === 'select' && (/** @type {HTMLSelectElement} */ (src).multiple || /** @type {HTMLSelectElement} */ (src).size > 1);
  const key = `${src.localName}|${type}|${list}|${cs.colorScheme}|${isDark(doc, cs)}|${pseudo}|${disabled}`;
  const hit = uaLooks.get(key);
  if (hit !== undefined) return hit;
  const probe = /** @type {HTMLElement} */ (doc.createElement(src.localName));
  if (type) probe.setAttribute('type', type);
  if (list) probe.setAttribute('multiple', '');
  if (disabled) probe.setAttribute('disabled', '');
  probe.style.cssText = `all:revert;color-scheme:${cs.colorScheme};${PROBE_BOX}`;
  doc.documentElement.appendChild(probe);
  const pcs = getComputedStyle(probe, pseudo || null);
  const look = lookOf(pcs);
  probe.remove();
  uaLooks.set(key, look);
  return look;
}

/** @type {WeakMap<Element, boolean>} the authored-look verdict of a control taken while it was neither hovered nor pressed */
const idleVerdicts = new WeakMap();

/**
 * Did the author restyle the control's border / background? Compared with a hidden UA probe, which is never hovered or pressed: Gecko's UA sheet itself recolours a hovered or
 * pressed button (-moz-buttonhoverface), so in those states the verdict taken at rest is reused (without one, colours are left out of the comparison).
 * @param {Element} src @param {CSSStyleDeclaration} cs @returns {boolean}
 */
function authoredLook(src, cs) {
  if (src.matches(':hover') || src.matches(':active')) {
    const known = idleVerdicts.get(src);
    if (known !== undefined) return known;
    const shape = (/** @type {string} */ look) => look.split('|').filter((_, i) => i !== 5 && i !== 7).join('|');
    return shape(lookOf(cs)) !== shape(uaLook(src, cs));
  }
  const v = lookOf(cs) !== uaLook(src, cs);
  idleVerdicts.set(src, v);
  return v;
}

/** @param {CSSStyleDeclaration} cs @param {HTMLElement} el @returns {{w: number, h: number}} the used border-box size */
function borderBox(cs, el) {
  const px = (/** @type {string} */ v) => parseFloat(v) || 0;
  const w = px(cs.width), h = px(cs.height);
  const box = cs.boxSizing === 'border-box' ? { w, h } : { w: w + px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth), h: h + px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth) };
  // a scrolled textarea's computed size excludes its classic bar gutter on WebKit: the layout box wins when they disagree beyond rounding (see scroll-emulation borderBoxOf)
  if (Math.abs(box.w - el.offsetWidth) >= 1 && el.offsetWidth > 0) box.w = el.offsetWidth;
  if (Math.abs(box.h - el.offsetHeight) >= 1 && el.offsetHeight > 0) box.h = el.offsetHeight;
  return box;
}

/** @param {CSSStyleDeclaration} cs @param {{w: number, h: number}} box @returns {string} the live box, pinned */
function pinBox(cs, box) {
  let d = `appearance:none!important;-webkit-appearance:none!important;box-sizing:border-box!important;width:${box.w}px!important;height:${box.h}px!important;`
    + 'min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;border-style:solid!important;border-color:transparent!important;'
    + 'background:none!important;box-shadow:none!important;';
  for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
    const k = side.toLowerCase();
    d += `padding-${k}:${/** @type {any} */ (cs)['padding' + side]}!important;border-${k}-width:${/** @type {any} */ (cs)['border' + side + 'Width']}!important;margin-${k}:${/** @type {any} */ (cs)['margin' + side]}!important;`;
  }
  return d;
}

/** @type {Map<string, HTMLImageElement|null>} skin url() -> its decoded image in the live page (null while decoding); bounded */
const warmed = new Map();
let skinPending = false;
/** @type {Set<() => void>} */
const skinListeners = new Set();

/** @param {() => void} cb called when a skin a capture used cold has decoded (the capture is retried) @returns {() => void} */
export function onSkinReady(cb) {
  skinListeners.add(cb);
  return () => { skinListeners.delete(cb); };
}
const MAX_WARM = 256;

/**
 * Gecko loads an image nested in an SVG image asynchronously, AFTER the outer image's decode() resolved, unless the same URL is already in its image cache (measured: drawn
 * right after decode, a cold skin is absent, a skin decoded in the page first is present). The page decodes each skin once and keeps it; a capture that used a skin still
 * decoding is marked incomplete (consumeSkinPending) so the pump captures it again.
 * @param {string} cssUrl `url("data:...")`
 */
function warmSkin(cssUrl) {
  const hit = warmed.get(cssUrl);
  if (hit) return;
  skinPending = true;
  if (hit === null) return;
  if (warmed.size >= MAX_WARM) warmed.delete(/** @type {string} */ (warmed.keys().next().value));
  warmed.set(cssUrl, null);
  const img = new Image();
  img.src = cssUrl.slice(5, -2);
  img.decode().then(() => { if (warmed.has(cssUrl)) warmed.set(cssUrl, img); for (const cb of [...skinListeners]) cb(); }, () => warmed.delete(cssUrl));
}

/** @returns {boolean} a skin painted since the last call was still decoding (the capture must be retried) */
export function consumeSkinPending() {
  const p = skinPending;
  skinPending = false;
  return p;
}

/**
 * The skin as a `border-image` (fill, outset for ink outside the box: WebKit) or, on Gecko, a border-box background (Gecko paints no border-image image inside an SVG image
 * that is scaled through its viewBox, measured; the ink outside the box is clipped there).
 * @param {string} svg @param {number} out @param {number} radius @returns {string}
 */
function skinDecl(svg, out, radius) {
  if (currentEngine().engine === 'gecko') {
    const url = skinUrl(svg);
    warmSkin(url);
    return `background:${url} 0 0 / 100% 100% no-repeat border-box!important;border-radius:${radius}px!important;`;
  }
  return `border-image:${skinUrl(svg)} 0 fill / 0 / ${out}px stretch!important;border-radius:${radius}px!important;`;
}

/**
 * A native checkbox/radio has its baseline `inset` px above its border-box bottom (WebKit RenderThemeMac::baselinePosition: 2; Gecko nsCheckboxRadioFrame: the 1 px theme border);
 * with `appearance:none` the baseline is the bottom MARGIN edge, which lifts the box by inset + the bottom margin. Baseline-relative vertical-align values move the clone back.
 * @param {{verticalAlign: string, marginBottom: string}} cs @param {number} inset @returns {string}
 */
export function toggleBaseline(cs, inset) {
  const drop = inset + (parseFloat(cs.marginBottom) || 0);
  const va = cs.verticalAlign;
  if (va === 'baseline') return `vertical-align:${-drop}px!important;`;
  if (/^-?[\d.]+px$/.test(va)) return `vertical-align:${parseFloat(va) - drop}px!important;`;
  return '';
}

/** @param {HTMLInputElement} el @returns {number} */
function rangeRatio(el) {
  const min = Number(el.min || 0), max = Number(el.max || 100), v = Number(el.value);
  return max > min && Number.isFinite(v) ? Math.min(1, Math.max(0, (v - min) / (max - min))) : 0;
}

/**
 * The fields a date/time input shows (WebKit lays out the locale's numeric fields as inline boxes; the image document shows the raw value): Intl parts of the value in the page
 * locale, `field` false for the literal separators.
 * @param {HTMLInputElement} el @returns {{text: string, field: boolean}[]}
 */
function dateParts(el) {
  const v = el.value, t = el.type;
  if (!v) return [];
  try {
    let d;
    /** @type {Intl.DateTimeFormatOptions} */
    let o = { year: 'numeric', month: '2-digit', day: '2-digit' };
    if (t === 'time') { const [h, m] = v.split(':').map(Number); d = new Date(2000, 0, 1, h, m); o = { hour: '2-digit', minute: '2-digit' }; } else d = new Date(t === 'month' ? `${v}-01T00:00` : t === 'date' ? `${v}T00:00` : v);
    if (t === 'month') o = { year: 'numeric', month: 'long' };
    if (t === 'datetime-local') o = { ...o, hour: '2-digit', minute: '2-digit' };
    if (Number.isNaN(d.getTime())) return [{ text: v, field: false }];
    return new Intl.DateTimeFormat(undefined, o).formatToParts(d).map((x) => ({ text: x.value, field: x.type !== 'literal' }));
  } catch { return [{ text: v, field: false }]; }
}

/**
 * A date/time input becomes an inline-flex box with the live box and font, the refreshed field skin and the fields as 1 px padded inline boxes (html.css datetime-edit rules).
 * @param {HTMLInputElement} src @param {Element} clone @param {CSSStyleDeclaration} cs @param {string} decl the pinned box and skin @returns {Element}
 */
function dateStandIn(src, clone, cs, decl) {
  const doc = clone.ownerDocument;
  const gecko = currentEngine().engine === 'gecko';
  const box = doc.createElement('span');
  for (const a of ['class', 'id', 'title', 'hidden']) if (src.hasAttribute(a)) box.setAttribute(a, src.getAttribute(a) ?? '');
  const edit = doc.createElement('span');
  appendInlineStyle(edit, gecko ? 'overflow:hidden;flex-grow:1;white-space:nowrap;' : 'display:inline-block;padding:1px;white-space:pre;overflow:hidden;');
  for (const part of dateParts(src)) {
    const span = doc.createElement('span');
    if (part.field) appendInlineStyle(span, gecko ? 'display:inline;padding:1px 3px;text-align:center;' : 'display:inline-block;padding:1px;text-align:center;');
    span.textContent = part.text;
    edit.appendChild(span);
  }
  box.appendChild(edit);
  // Gecko's datetimebox: the edit wrapper and the calendar button (date and datetime-local, enabled and editable) spread apart; the button is the 16 px icon at 1em, 65 % text colour
  if (gecko && src.type !== 'time' && !src.disabled && !src.readOnly) {
    const btn = doc.createElement('span');
    appendInlineStyle(btn, 'flex:none;margin-inline:0.075em 0.15em;padding:0 0.15em;line-height:1;display:inline-flex;color:color-mix(in srgb, currentColor 65%, transparent);');
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [k, v] of [['viewBox', '0 0 16 16'], ['width', '16'], ['height', '16'], ['fill', 'currentColor']]) svg.setAttribute(k, v);
    svg.setAttribute('style', 'max-width:1em;max-height:1em;');
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', CALENDAR);
    svg.appendChild(path);
    btn.appendChild(svg);
    box.appendChild(btn);
  }
  appendInlineStyle(box, `${clone.getAttribute('style') ?? ''};display:${cs.display === 'block' ? 'flex' : 'inline-flex'}!important;align-items:center!important;overflow:hidden!important;white-space:nowrap!important;`
    + (gecko ? 'justify-content:space-between!important;' : '')
    + `font-family:${cs.fontFamily}!important;font-size:${cs.fontSize}!important;font-weight:${cs.fontWeight}!important;font-style:${cs.fontStyle}!important;line-height:${cs.lineHeight}!important;font-variant-numeric:${cs.fontVariantNumeric}!important;letter-spacing:${cs.letterSpacing}!important;text-align:${cs.textAlign}!important;vertical-align:${cs.verticalAlign}!important;${decl}`);
  return box;
}

/** Firefox's datetimebox calendar icon (toolkit/content/widgets/datetimebox.js). */
const CALENDAR = 'M13.5 2H13V1c0-.6-.4-1-1-1s-1 .4-1 1v1H5V1c0-.6-.4-1-1-1S3 .4 3 1v1h-.5C1.1 2 0 3.1 0 4.5v9C0 14.9 1.1 16 2.5 16h11c1.4 0 2.5-1.1 2.5-2.5v-9C16 3.1 14.9 2 13.5 2zm0 12.5h-11c-.6 0-1-.4-1-1V6h13v7.5c0 .6-.4 1-1 1z';

/**
 * Draw `src` (a control the live WebKit page paints natively) into `clone` in the refreshed look. No-op for controls drawn by CSS (appearance:none, or a devolvable control with an
 * author border/background), for kinds without a refreshed look here (listbox select) and for zero-size boxes.
 * @param {Element} src @param {Element} clone @returns {boolean|Element} the clone was changed (true), left alone (false) or must be replaced by the returned element
 */
export function paintNativeControl(src, clone) {
  const engine = currentEngine().engine;
  if (engine !== 'webkit' && engine !== 'gecko') return false;
  const kind = controlKind(src, engine);
  if (!kind) return false;
  const doc = src.ownerDocument;
  const cs = (doc.defaultView ?? window).getComputedStyle(src);
  if (cs.display === 'none') return false;
  if (kind === 'file') return engine === 'webkit' && fileButton(src, clone, cs);
  const box = borderBox(cs, /** @type {HTMLElement} */ (src));
  if (!(box.w > 0 && box.h > 0)) return false;
  if (cs.appearance === 'none' || (DEVOLVABLE.has(kind) && authoredLook(src, cs))) return cssControl(src, clone, cs, kind, box, engine);
  return engine === 'gecko' ? paintGecko(src, clone, cs, kind, box) : paintWebkit(src, clone, cs, kind, box);
}

/**
 * A control the page paints with CSS (appearance:none, or an author border/background). The image document paints it with CSS too, but sizes it without the theme's intrinsic
 * metrics (measured: Gecko text fields 1 css px taller per field, which drifted every row below): the live border-box size is pinned. Gecko also draws a styled select's
 * drop-down arrow natively (its arrow button keeps the theme), which the image omits: the arrow is added as a background layer.
 * @param {Element} src @param {Element} clone @param {CSSStyleDeclaration} cs @param {string} kind @param {{w: number, h: number}} box @param {string} engine @returns {boolean}
 */
function cssControl(src, clone, cs, kind, box, engine) {
  if (kind === 'checkbox' || kind === 'radio' || kind === 'range') return false;
  let decl = `box-sizing:border-box!important;width:${box.w}px!important;height:${box.h}px!important;min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;`;
  if (engine === 'gecko' && kind === 'menulist' && cs.appearance !== 'none') {
    const c = contentRect(cs, box.w, box.h);
    const arrow = svgDoc(box.w, box.h, geckoArrow({ x: c.x + c.w - 18, y: c.y, w: 18, h: c.h }, rgbaOf(src.ownerDocument, cs.color)));
    const url = skinUrl(arrow);
    warmSkin(url);
    decl += `background-image:${url}, ${cs.backgroundImage === 'none' ? 'none' : cs.backgroundImage}!important;background-size:100% 100%, ${cs.backgroundSize}!important;background-position:0 0, ${cs.backgroundPosition}!important;background-repeat:no-repeat, ${cs.backgroundRepeat}!important;background-origin:border-box, ${cs.backgroundOrigin}!important;`;
  }
  appendInlineStyle(clone, decl);
  return true;
}

/**
 * The refreshed WebKit look (webkit-skins.js).
 * @param {Element} src @param {Element} clone @param {CSSStyleDeclaration} cs @param {string} kind @param {{w: number, h: number}} box @returns {boolean|Element}
 */
function paintWebkit(src, clone, cs, kind, box) {
  const doc = src.ownerDocument;
  const dark = isDark(doc, cs);
  const p = paletteOf(doc, dark);
  const authored = cs.accentColor !== 'auto';
  // macOS draws no accent while the window is not key (repainted on window focus / blur by the interaction tracker)
  const inactive = !doc.hasFocus() ? inactiveTints(p) : null;
  const tint = tintWithContrast(authored ? rgbaOf(doc, cs.accentColor) : p.accent, dark, authored);
  const el = /** @type {HTMLInputElement} */ (src);
  const disabled = src.matches(':disabled');
  const pressed = !disabled && src.matches(':active');
  const { w, h } = box;
  let decl = pinBox(cs, box);
  switch (kind) {
    case 'checkbox': case 'radio':
      decl += skinDecl(toggleSkin(w, h, { type: kind, checked: el.checked, indeterminate: el.indeterminate, disabled, tint: inactive?.fill ?? tint, ink: inactive ? p.label : undefined, pressed }, p), 0, kind === 'radio' ? Math.min(w, h) / 2 : Math.min(w, h) * 5.5 / 16);
      decl += toggleBaseline(cs, 2);
      break;
    case 'range':
      clone.setAttribute('data-hic-wk', '');
      decl += skinDecl(rangeSkin(w, h, { ratio: rangeRatio(el), disabled, tint: inactive?.bar ?? tint, rtl: cs.direction === 'rtl', pressed: pressed && pressOnThumb(el, rangeRatio(el), THUMB.w, cs.direction === 'rtl') }, p), THUMB.shadow + 1, 0);
      break;
    case 'progress':
      clone.setAttribute('data-hic-wk', '');
      decl += skinDecl(progressSkin(w, h, { position: /** @type {HTMLProgressElement} */ (src).position, tint: inactive?.bar ?? tint }, p), 0, 4);
      break;
    case 'meter': {
      const m = /** @type {HTMLMeterElement} */ (src);
      clone.setAttribute('data-hic-wk', '');
      decl += skinDecl(meterSkin(w, h, { ratio: (m.value - m.min) / (m.max - m.min || 1), region: meterRegion(m) }, p), 0, Math.min(w, h) / 2);
      break;
    }
    case 'button': case 'menulist': {
      const submit = !inactive && ((src.localName === 'input' && el.type === 'submit') || (src.localName === 'button' && src.getAttribute('type')?.toLowerCase() === 'submit'));
      const base = submit ? tint : over(p.opaqueSecondaryFill, p.canvas);
      const fill = pressed && kind === 'button' ? pressedShade(base, dark) : base;
      const fs = parseFloat(cs.fontSize) || 13, inner = popupPadding(fs);
      const glyph = kind === 'menulist' ? popupGlyph(w, h, fs, (parseFloat(cs.borderRightWidth) || 0) + (parseFloat(cs.paddingRight) || 0) + inner.left, disabled ? p.tertiaryLabel : p.label) : '';
      decl += skinDecl(buttonSkin(w, h, { fill, disabled }, p, glyph), 0, 6);
      const text = submit ? alpha(foregroundOn(tint), disabled ? (luminanceIsWhite(foregroundOn(tint)) ? 0.6 : 0.3) : 1) : null;
      decl += `color:${text ? `rgba(${text.slice(0, 3).join(',')},${text[3]})` : cs.color}!important;`;
      if (kind === 'menulist') {
        const v = (/** @type {string} */ k) => parseFloat(/** @type {any} */ (cs)[k]) || 0;
        decl += `line-height:${cs.lineHeight}!important;padding:${v('paddingTop') + inner.top}px ${v('paddingRight') + inner.right}px ${v('paddingBottom') + inner.bottom}px ${v('paddingLeft') + inner.left}px!important;`;
      }
      break;
    }
    case 'color': {
      const pl = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth), pt = parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth);
      const inset = { x: pl, y: pt, w: w - pl - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth), h: h - pt - parseFloat(cs.paddingBottom) - parseFloat(cs.borderBottomWidth) };
      decl += skinDecl(colorWellSkin(w, h, { inset, value: rgbaOf(doc, el.value || '#000'), disabled }, p), 0, Math.min(w, h) / 2) + 'color:transparent!important;-webkit-text-fill-color:transparent!important;';
      break;
    }
    default: { // text, date, textarea
      const bg = rgbaOf(doc, cs.backgroundColor);
      let extra = '';
      if (kind === 'textarea' && cs.resize !== 'none') extra += resizerGlyph(w, h, Math.min(15, w, h), p);
      if (src.localName === 'input' && el.type === 'number') extra += spinGlyph(contentRect(cs, w, h), disabled, p);
      if (src.localName === 'input' && el.type === 'search') return searchField(el, clone, cs, box, p, dark, disabled, decl);
      if (kind === 'textarea' || /** @type {HTMLInputElement} */ (src).type !== 'text') clone.setAttribute('data-hic-wk', '');
      decl += skinDecl(textFieldSkin(w, h, { bg, disabled }, p, extra), 0, 5) + `color:${cs.color}!important;`;
      if (kind === 'textarea') decl += 'resize:none!important;';
      if (kind === 'date') return dateStandIn(el, clone, cs, decl);
    }
  }
  appendInlineStyle(clone, decl);
  return true;
}

/** @type {Map<string, import('./gecko-skins.js').GeckoPalette & {accent: Rgba, accentText: Rgba}>} */
const geckoPalettes = new Map();

/** Ink outside a Gecko range box (the thumb shadow: offset 2 px, blur std deviation 2 px). */
const GECKO_OUT = 8;

/**
 * Firefox's widget colours of one scheme: the content-visible system colours from a hidden probe, the -moz-* ones from nsXPLookAndFeel's stand-ins (light: ButtonFace / white
 * at 50 %; dark: #2b2a33 at 40 % over #1c1b22), the disabled border as measured on macOS (light #c7c7ce, dark #8f8f9d).
 * @param {Document} doc @param {boolean} dark
 */
function geckoPaletteOf(doc, dark) {
  const key = dark ? 'dark' : 'light';
  const hit = geckoPalettes.get(key);
  if (hit) return hit;
  const probe = doc.createElement('div');
  probe.style.cssText = `color-scheme:${key};${PROBE_BOX}`;
  doc.documentElement.appendChild(probe);
  const read = (/** @type {string} */ kw) => { probe.style.color = kw; return rgbaOf(doc, getComputedStyle(probe).color); };
  const face = read('ButtonFace');
  const p = {
    dark, border: read('ButtonBorder'), face, field: read('Field'), accent: read('AccentColor'), accentText: read('AccentColorText'),
    disabledFace: /** @type {Rgba} */ (dark ? over([43, 42, 51, 0.4], [28, 27, 34, 1]) : [face[0], face[1], face[2], 128 / 255]),
    disabledField: /** @type {Rgba} */ (dark ? over([43, 42, 51, 0.4], [28, 27, 34, 1]) : [255, 255, 255, 128 / 255]),
    disabledBorder: /** @type {Rgba} */ (dark ? [0x8f, 0x8f, 0x9d, 1] : [0xc7, 0xc7, 0xce, 1]),
    hoverFace: /** @type {Rgba} */ (dark ? [82, 82, 94, 1] : [0xd0, 0xd0, 0xd7, 1]), activeFace: /** @type {Rgba} */ (dark ? [91, 91, 102, 1] : [0xb1, 0xb1, 0xb9, 1]),
    hoverBorder: /** @type {Rgba} */ (dark ? [0xb1, 0xb1, 0xb1, 1] : [0x67, 0x67, 0x74, 1]), activeBorder: /** @type {Rgba} */ (dark ? [0xd0, 0xd0, 0xd7, 1] : [0x48, 0x48, 0x51, 1]),
  };
  probe.remove();
  geckoPalettes.set(key, p);
  return p;
}

/**
 * Firefox's focus ring on a themed control (Theme.cpp; measured on a text field in Firefox 157: 2 px of the accent centred on the border-box edge, following its radius), only
 * where the live page draws it (`:focus-visible` with an `auto` outline style). Box skins draw it themselves (with its 1 px white outer line), in a box grown by 2 px on every side
 * (border +2, margin -2: same layout), because an outline is not snapped to device pixels in the image (the ring came out half a device pixel off); other kinds fall back to an outline.
 * @param {Element} src @param {CSSStyleDeclaration} cs @param {string} kind @returns {boolean}
 */
const geckoRinged = (src, cs, kind) => kind !== 'range' && cs.outlineStyle === 'auto' && src.matches(':focus-visible');

/** @param {CSSStyleDeclaration} cs @param {{w: number, h: number}} box @returns {string} the pinned box grown by 2 px on every side around the same content box */
function growForRing(cs, box) {
  let d = `width:${box.w + 4}px!important;height:${box.h + 4}px!important;`;
  for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
    const k = side.toLowerCase();
    d += `border-${k}-width:${(parseFloat(/** @type {any} */ (cs)['border' + side + 'Width']) || 0) + 2}px!important;margin-${k}:${(parseFloat(/** @type {any} */ (cs)['margin' + side]) || 0) - 2}px!important;`;
  }
  return d;
}

/**
 * Firefox's non-native widget look (gecko-skins.js).
 * @param {Element} src @param {Element} clone @param {CSSStyleDeclaration} cs @param {string} kind @param {{w: number, h: number}} box @returns {boolean|Element}
 */
function paintGecko(src, clone, cs, kind, box) {
  const doc = src.ownerDocument;
  const p = geckoPaletteOf(doc, isDark(doc, cs));
  const authored = cs.accentColor !== 'auto';
  const accent = accentPalette(authored ? rgbaOf(doc, cs.accentColor) : p.accent, p.accentText, authored);
  const el = /** @type {HTMLInputElement} */ (src);
  const disabled = src.matches(':disabled');
  const hover = src.matches(':hover'), active = hover && src.matches(':active');
  const { w, h } = box;
  let decl = pinBox(cs, box);
  const ring = geckoRinged(src, cs, kind) ? accent.accent : null;
  const boxKind = kind === 'button' || kind === 'menulist' || kind === 'color' || kind === 'text' || kind === 'date' || kind === 'textarea' || kind === 'listbox';
  if (ring && boxKind) decl += growForRing(cs, box);
  else if (ring) decl += `outline:2px solid ${css(ring)}!important;outline-offset:-1px!important;`;
  switch (kind) {
    case 'checkbox': case 'radio':
      decl += skinDecl(geckoToggleSkin(w, h, { type: kind, checked: el.checked, indeterminate: el.indeterminate, disabled, accent, hover, active }, p), 0, kind === 'radio' ? Math.min(w, h) / 2 : 4);
      decl += toggleBaseline(cs, 1);
      break;
    case 'range':
      clone.setAttribute('data-hic-range', '');
      // the thumb's shadow falls outside the box and a background cannot: the box grows by OUT on every side and its margins shrink by as much (same layout)
      decl += skinDecl(geckoRangeSkin(w, h, { ratio: rangeRatio(el), disabled, rtl: cs.direction === 'rtl', accent, hover, active }, GECKO_OUT), 0, 0) + `width:${w + 2 * GECKO_OUT}px!important;height:${h + 2 * GECKO_OUT}px!important;`;
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) decl += `margin-${side.toLowerCase()}:${(parseFloat(/** @type {any} */ (cs)['margin' + side]) || 0) - GECKO_OUT}px!important;`;
      break;
    case 'progress': case 'meter': {
      clone.setAttribute('data-hic-range', '');
      const m = /** @type {HTMLMeterElement} */ (src);
      const position = kind === 'meter' ? (m.value - m.min) / (m.max - m.min || 1) : /** @type {HTMLProgressElement} */ (src).position;
      decl += skinDecl(geckoProgressSkin(w, h, { meter: kind === 'meter', position, region: kind === 'meter' ? meterRegion(m) : undefined, rtl: cs.direction === 'rtl', accent }), 0, 0);
      break;
    }
    case 'button': case 'menulist': case 'color': {
      let arrow = '';
      if (kind === 'menulist') {
        const c = contentRect(cs, w, h), aw = 18;
        arrow = geckoArrow({ x: c.x + c.w - aw, y: c.y, w: aw, h: c.h }, rgbaOf(doc, cs.color));
      }
      // the UA sheet recolours a hovered / pressed button and colour well (-moz-buttonhoverface / -moz-buttonactiveface): those live computed colours are the measured truth
      const live = (hover || active) && kind !== 'menulist' ? { ...p, hoverFace: rgbaOf(doc, cs.backgroundColor), activeFace: rgbaOf(doc, cs.backgroundColor), hoverBorder: rgbaOf(doc, cs.borderTopColor), activeBorder: rgbaOf(doc, cs.borderTopColor) } : p;
      decl += skinDecl(geckoBoxSkin(w, h, { field: false, disabled, hover, active }, live, arrow, ring), 0, ring ? 6 : 4);
      break;
    }
    default: { // text, date, textarea, listbox
      const bg = rgbaOf(doc, cs.backgroundColor);
      const bar = kind === 'listbox' ? listboxBar(/** @type {HTMLSelectElement} */ (src), cs, bg[3] ? luminance(bg) < 0.18 : p.dark) : null;
      if (bar) decl += bar.decl;
      decl += skinDecl(geckoBoxSkin(w, h, { field: true, disabled, hover, active, bg }, p, bar?.svg, ring), 0, ring ? 6 : 4) + `color:${cs.color}!important;`;
      if (kind === 'date') return dateStandIn(el, clone, cs, decl);
    }
  }
  appendInlineStyle(clone, decl);
  return true;
}

/**
 * Firefox draws no scrollbar for a listbox inside an SVG image (its options span the gutter): the gutter becomes padding on the scrollbar's side and the bar is drawn into the
 * skin (gecko-skins.js geckoListboxBar). The scroll offset is set by listboxScroll (scroll-emulation.js).
 * @param {HTMLSelectElement} src @param {CSSStyleDeclaration} cs @param {boolean} dark @returns {{svg: string, decl: string}|null}
 */
function listboxBar(src, cs, dark) {
  const bl = parseFloat(cs.borderLeftWidth) || 0, br = parseFloat(cs.borderRightWidth) || 0;
  const gv = src.offsetWidth - src.clientWidth - bl - br;
  if (!(gv > 0)) return null;
  const rtl = cs.direction === 'rtl';
  const g = { x: rtl ? bl : bl + src.clientWidth, y: src.clientTop, w: gv, h: src.clientHeight };
  const thumb = geckoListboxThumb({ track: src.clientHeight, client: src.clientHeight, scroll: src.scrollHeight, offset: src.scrollTop });
  const side = rtl ? 'Left' : 'Right';
  return { svg: geckoListboxBar(g, thumb, dark, rtl), decl: `padding-${side.toLowerCase()}:${(parseFloat(/** @type {any} */ (cs)['padding' + side]) || 0) + gv}px!important;` };
}

/**
 * A search field: capsule skin, the cancel glyph at the content end when there is a value, and on Safari >= 27 the magnifier decoration at the content start (1 em wide plus a
 * 0.36 em margin), which the image document does not lay out: the clone's start padding grows by as much.
 * @param {HTMLInputElement} el @param {Element} clone @param {CSSStyleDeclaration} cs @param {{w: number, h: number}} box @param {Palette} p @param {boolean} dark @param {boolean} disabled
 * @param {string} decl @returns {boolean}
 */
function searchField(el, clone, cs, box, p, dark, disabled, decl) {
  const em = parseFloat(cs.fontSize) || 13, c = contentRect(cs, box.w, box.h);
  const extra = el.value ? cancelGlyph({ x: c.x + c.w - em, y: c.y + c.h / 2 - em / 2, size: em }, dark, disabled) : '';
  const magnifier = (currentEngine().major ?? 0) >= 27 && cs.direction === 'ltr' ? { x: c.x, y: c.y + c.h / 2 - em / 2 } : undefined;
  clone.setAttribute('data-hic-wk', '');
  let d = decl + skinDecl(searchSkin(box.w, box.h, { bg: rgbaOf(el.ownerDocument, cs.backgroundColor), disabled, em, dark, magnifier }, p, extra), 0, box.h / 2) + `color:${cs.color}!important;`;
  if (magnifier) d += `padding-left:${(parseFloat(cs.paddingLeft) || 0) + 1.36 * em}px!important;`;
  appendInlineStyle(clone, d);
  return true;
}

/**
 * The file input's button (a UA part the clone can only reach through a rule): the refreshed fill and label colour travel as custom properties (css-collector.js BASE_CSS).
 * @param {Element} src @param {Element} clone @param {CSSStyleDeclaration} cs @returns {boolean}
 */
function fileButton(src, clone, cs) {
  const doc = src.ownerDocument;
  const b = (doc.defaultView ?? window).getComputedStyle(src, '::file-selector-button');
  if (b.appearance === 'none' || lookOf(b) !== uaLook(src, cs, '::file-selector-button')) return false;
  const p = paletteOf(doc, isDark(doc, cs));
  clone.setAttribute('data-hic-wk-file', '');
  appendInlineStyle(clone, `--hic-wk-fb:${css4(over(p.opaqueSecondaryFill, p.canvas), src.matches(':disabled'))};--hic-wk-fbc:${b.color};`
    + `--hic-wk-fbw:${b.width};--hic-wk-fbh:${b.height};--hic-wk-fbp:${b.paddingTop} ${b.paddingRight} ${b.paddingBottom} ${b.paddingLeft};--hic-wk-fbb:${b.borderTopWidth};--hic-wk-fbs:${b.boxSizing};`);
  return true;
}

/**
 * The menu list's internal padding (RenderThemeMac popupButtonPadding by the control size of the font: >= 16 px regular, >= 11 small, else mini): the text inset the native
 * select keeps inside its CSS padding, which an `appearance:none` select does not have; the chevron sits `left` px inside the end padding.
 * @param {number} fontSize @returns {{top: number, right: number, bottom: number, left: number}}
 */
export function popupPadding(fontSize) {
  return fontSize >= 16 ? { top: 2, right: 26, bottom: 3, left: 8 } : fontSize >= 11 ? { top: 2, right: 23, bottom: 3, left: 8 } : { top: 2, right: 22, bottom: 3, left: 10 };
}

/** @param {Rgba} c @returns {boolean} */
const luminanceIsWhite = (c) => c[0] === 255 && c[1] === 255 && c[2] === 255;

/** @param {Rgba} c @param {boolean} disabled @returns {string} */
const css4 = (c, disabled) => `rgba(${c.slice(0, 3).map(Math.round).join(',')},${disabled ? c[3] * 0.4 : c[3]})`;

/** @param {CSSStyleDeclaration} cs @param {number} w @param {number} h @returns {{x: number, y: number, w: number, h: number}} the content box in border-box coordinates */
function contentRect(cs, w, h) {
  const v = (/** @type {string} */ k) => parseFloat(/** @type {any} */ (cs)[k]) || 0;
  const x = v('paddingLeft') + v('borderLeftWidth'), y = v('paddingTop') + v('borderTopWidth');
  return { x, y, w: w - x - v('paddingRight') - v('borderRightWidth'), h: h - y - v('paddingBottom') - v('borderBottomWidth') };
}

/**
 * HTMLMeterElement gauge region (HTML spec "optimum" / "suboptimal" / "even less good").
 * @param {HTMLMeterElement} m @returns {'optimum'|'suboptimal'|'even-less-good'}
 */
export function meterRegion(m) {
  const { value, low, high, optimum } = m;
  if (optimum < low) return value <= low ? 'optimum' : value <= high ? 'suboptimal' : 'even-less-good';
  if (optimum > high) return value >= high ? 'optimum' : value >= low ? 'suboptimal' : 'even-less-good';
  return value >= low && value <= high ? 'optimum' : 'suboptimal';
}
