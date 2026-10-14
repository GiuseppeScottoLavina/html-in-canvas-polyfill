/**
 * Page curl effect plugin (effect plugin ABI v2): an EXAMPLE of the effects extension of html-in-canvas-polyfill, not part of the polyfill.
 * Shader: ./page-curl.wgsl.
 *
 * Drag a corner of the drawn page (a hot zone of `hotZone` CSS px around it) and the page peels off around a cylinder: the back of the
 * page (light paper, the front showing through it mirrored) folds over the front, the curl is shaded and casts a shadow on the page
 * underneath. On release the page springs back. At rest one corner (top-right unless `corner` names another) is a small dog-ear; hovering
 * a hot zone lifts its corner further and shows a grab cursor, and until the first drag the dog-ear now and then peeks open by itself.
 *
 * Input: the grab is the plugin's own gesture. Its pointer events are taken in the capture phase at the document, before the host's
 * interposer and the form see them (preventDefault: no focus change, no text selection, no click), and the pointer is captured to the
 * canvas. Every other pointer goes through the host's interposer and this plugin's input mapper (`mapCurlPoint`): on the flat part of
 * the page the mapper is the identity; on the back of the page (the folded flap, the top of the curl) and on the page underneath it
 * returns NO_TARGET (the effects ABI value for "no element here": the host swallows the press); the sliver of the front still visible on
 * the curl maps to the exact page point it shows. When the page lies flat again the mapper is the identity everywhere.
 */

import { NO_TARGET, isNoTarget } from '../../src/effects/no-target.js';
import { wgsl } from './wgsl.js';

/** @typedef {import('../../src/contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../../src/contracts/types.js').EffectPluginContext} EffectPluginContext */
/** @typedef {import('../../src/contracts/types.js').InputMapper} InputMapper */
/** @typedef {import('../../src/contracts/types.js').InputPoint} InputPoint */

/** What the plugin gallery and the build read (plugins/README.md). */
export const meta = Object.freeze({
  name: 'page-curl',
  title: 'Page curl',
  description: 'Grab the dog-eared top-right corner and drag to peel the page like a book page; it springs back on release. Clicks still reach the flat part.',
  defaults: Object.freeze({ corner: 'any', radius: 56, shadow: 0.8, dogEar: 40, autoPeek: 5 }),
  reducedMotion: 'With reduced motion the drag still follows the hand; the dog-ear stays still (no auto-peek); release and hover lift happen at once.',
});

/**
 * Uniform block (page-curl.wgsl `Uniforms`): [0,1] resolution, [2,3] css size, [4,5] dir, [6] axis, [7] radius, [8] curled, [9] shadow,
 * [10] ready, [11] ink (how much of the front shows through the back), [12..14] colour of the page underneath, [15] padding,
 * [16..18] colour of the back of the page (paper), [19] padding.
 */
export const UNIFORM_FLOATS = 20;
/** What a mapper returns for a point that shows no element: the NO_TARGET of the effects ABI (the host swallows a press there). */
export { NO_TARGET, isNoTarget };
/** Release animation length (ms of the frame clock, so it ends at the same time whatever the frame cap). */
export const RELEASE_MS = 420;
export const CORNERS = Object.freeze(['any', 'tl', 'tr', 'bl', 'br']);

const MAPPER_SLOTS = 4;   // the host keeps the mappers of the last 3 presented frames, plus the one being written
const INK = 0.42;             // the front seen through the paper: bright parts of the front darken the back by this much
const HOVER_FRACTION = 0.55;  // hover lift (CSS px per axis), as a fraction of the hot zone, on top of the dog-ear
const LIFT_MS = 90;           // time constant of the hover lift and of the corner changes
const PEEK_DELAY_MS = 1500;   // first auto-peek after the first frame
export const PEEK_MS = 1800;  // one auto-peek: the dog-ear opens and closes (sin^2)
const MIN_DRAG = 0.5;         // CSS px: a shorter pull is no curl
const CLEAR = Object.freeze({ r: 0, g: 0, b: 0, a: 1 });
/** corner name -> [x, y] as a fraction of the page */
const CORNER_AT = Object.freeze({ tl: [0, 0], tr: [1, 0], bl: [0, 1], br: [1, 1] });
const CORNER_NAME = Object.freeze({ tl: ['top-left', '\u2196'], tr: ['top-right', '\u2197'], bl: ['bottom-left', '\u2199'], br: ['bottom-right', '\u2198'] });
/** The corner that wears the dog-ear and peeks: the allowed corner, or top-right when any corner may be grabbed. @param {unknown} corner */
export const hintCorner = (corner) => /** @type {'tl'|'tr'|'bl'|'br'} */ (corner === 'tl' || corner === 'bl' || corner === 'br' ? corner : 'tr');
/** The text of the hint label for `corner`. @param {unknown} corner */
export function hintText(corner) {
  const [name, arrow] = CORNER_NAME[hintCorner(corner)];
  return `${arrow} Drag the ${name} corner to peel the page${corner === 'any' || !CORNERS.includes(String(corner)) ? ' (any corner works)' : ''}.`;
}

/**
 * The auto-peek of the dog-ear at frame time `t` (ms since the first frame): 0 at rest, rising to 1 and back during each peek of PEEK_MS,
 * the first one PEEK_DELAY_MS after the first frame and then one every `every` seconds. PURE. @param {number} t @param {number} every
 */
export function peekAt(t, every) {
  if (!(every > 0) || t < PEEK_DELAY_MS) return 0;
  const m = (t - PEEK_DELAY_MS) % Math.max(PEEK_MS, every * 1000);
  return m < PEEK_MS ? Math.sin((Math.PI * m) / PEEK_MS) ** 2 : 0;
}

let uiSerial = 0;

/** @param {unknown} v @param {number} lo @param {number} hi @param {number} fallback */
function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/** '#rgb' / '#rrggbb' -> [r, g, b] in 0..1 (falls back to `fallback`, the default page colour). @param {unknown} hex */
export function parseColor(hex, fallback = [0.055, 0.105, 0.16]) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex ?? ''));
  if (!m) return fallback;
  const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

/**
 * The corner whose hot zone contains (x, y), or null. PURE.
 * @param {number} x  CSS px in the page
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {string} allowed  'any' or one corner name
 * @param {number} hotZone  radius in CSS px
 * @returns {'tl'|'tr'|'bl'|'br'|null}
 */
export function hotCorner(x, y, width, height, allowed, hotZone) {
  if (!(x >= 0 && y >= 0 && x <= width && y <= height)) return null;
  /** @type {'tl'|'tr'|'bl'|'br'|null} */ let best = null;
  let bestDistance = hotZone;
  for (const key of /** @type {const} */ (['tl', 'tr', 'bl', 'br'])) {
    if (allowed !== 'any' && allowed !== key) continue;
    const d = Math.hypot(x - CORNER_AT[key][0] * width, y - CORNER_AT[key][1] * height);
    if (d < bestDistance) { bestDistance = d; best = key; }
  }
  return best;
}

/**
 * The cylinder that brings the corner (cx, cy) to the dragged point (dx, dy): writes dir [4,5], axis [6], radius [7] and curled [8] of the
 * uniform block `out`. The corner is wrapped half way round the cylinder and lies flat again, back side up, exactly under the pointer.
 * A short pull uses a thinner cylinder (radius <= distance / pi) so the curl grows continuously from nothing. PURE apart from `out`.
 * @param {Float32Array} out
 * @param {number} cx
 * @param {number} cy
 * @param {number} dx
 * @param {number} dy
 * @param {number} radius  CSS px
 */
export function curlGeometry(out, cx, cy, dx, dy, radius) {
  const vx = cx - dx;
  const vy = cy - dy;
  const length = Math.hypot(vx, vy);
  if (!(length >= MIN_DRAG)) { out[4] = 1; out[5] = 0; out[6] = 0; out[7] = 0; out[8] = 0; return; }
  const ux = vx / length;
  const uy = vy / length;
  const r = Math.min(radius, length / Math.PI);
  out[4] = ux; out[5] = uy;
  out[6] = ((cx + dx) * ux + (cy + dy) * uy - Math.PI * r) / 2;
  out[7] = r;
  out[8] = 1;
}

/**
 * The input mapper formula, the twin of the region decision of fs() in page-curl.wgsl. Where the presented point shows the FRONT of the
 * page it returns the page point shown: the identity on the flat page, the exact point on the front still visible on the lower half of
 * the cylinder. Where it shows the back of the page (the folded flap, the upper half of the cylinder) or the page underneath, there is
 * no element: NO_TARGET. PURE.
 * @param {Float32Array} state  the uniform block of the presented frame
 * @param {InputPoint} point  canvas CSS px, plus the presented size
 * @returns {{x: number, y: number}}
 */
export function mapCurlPoint(state, point) {
  if (!(state[8] > 0.5)) return { x: point.x, y: point.y };
  const width = state[2];
  const height = state[3];
  const px = point.x * (width / Math.max(1, point.width));
  const py = point.y * (height / Math.max(1, point.height));
  const ux = state[4];
  const uy = state[5];
  const r = Math.max(state[7], 0.001);
  const s = px * ux + py * uy - state[6];
  const inPage = (/** @type {number} */ k) => { const qx = px + k * ux; const qy = py + k * uy; return qx >= 0 && qy >= 0 && qx <= width && qy <= height; };
  if (s < 0) return inPage(Math.PI * r - 2 * s) ? NO_TARGET : { x: point.x, y: point.y };   // under the folded flap / the flat page
  if (!(s <= r)) return NO_TARGET;                                                           // the page underneath
  const lift = Math.asin(Math.min(1, s / r));
  if (inPage(r * (Math.PI - lift) - s)) return NO_TARGET;                                    // the back, on the upper half of the cylinder
  const k = r * lift - s;
  if (!inPage(k)) return NO_TARGET;                                                           // the page underneath
  // the front of the page on the lower half of the cylinder: still the page, seen compressed; map to the point it shows
  return { x: (px + k * ux) * (point.width / width), y: (py + k * uy) * (point.height / height) };
}

/** Ease-out cubic of the release, t in 0..1. @param {number} t */
export const releaseEase = (t) => 1 - (1 - t) ** 3;

/** @param {Float32Array} state @returns {InputMapper} */
function makeMapper(state) {
  /** @type {InputMapper} */
  const mapper = (point) => mapCurlPoint(state, point);
  mapper.captureGestureSnapshot = () => {
    const frozen = new Float32Array(state);
    return (point) => mapCurlPoint(frozen, point);
  };
  return mapper;
}

/** @param {Document} doc */
function injectUiStyle(doc) {
  if (doc.querySelector('style[data-hic-effect-style="page-curl"]')) return;
  const style = doc.createElement('style');
  style.dataset.hicEffectStyle = 'page-curl';
  style.textContent = `
    .hic-curl-ui { display:grid; grid-template-columns:auto 1fr auto; gap:4px 10px; align-items:center; color:rgba(224,247,255,.72); font-size:11px; font-weight:700; }
    .hic-curl-ui p { grid-column:1 / -1; margin:0 0 2px; font-size:13px; font-weight:800; color:#9cf5ff; }
    .hic-curl-ui output { color:#9cf5ff; text-align:right; font-variant-numeric:tabular-nums; min-width:4ch; }
    .hic-curl-ui input[type=range] { width:100%; height:24px; margin:0; accent-color:#79efff; cursor:ew-resize; }
    .hic-curl-ui select { font:inherit; color:#effcff; background:rgba(1,10,23,.55); border:1px solid rgba(173,226,255,.18); border-radius:8px; padding:3px 6px; }
    [data-hic-curl-cursor=grab], [data-hic-curl-cursor=grab] * { cursor:grab !important; }
    [data-hic-curl-cursor=grabbing], [data-hic-curl-cursor=grabbing] * { cursor:grabbing !important; }
  `;
  (doc.head || doc.documentElement).append(style);
}

/**
 * The plugin's controls: which corner can be grabbed, the curl radius and the shadow.
 * @param {Element} root
 * @param {{getOptions: () => Readonly<Record<string, unknown>>, setOptions: (patch: Record<string, unknown>) => void}} ui
 */
function mountCurlUi(root, ui) {
  const doc = root.ownerDocument;
  injectUiStyle(doc);
  const n = ++uiSerial;
  const o = ui.getOptions();
  const box = doc.createElement('div');
  box.className = 'hic-curl-ui';
  box.innerHTML = `<p class="hic-curl-hint"></p>`
    + `<label for="hic-curl-corner-${n}">Corner</label><select id="hic-curl-corner-${n}">${CORNERS.map((c) => `<option value="${c}">${c}</option>`).join('')}</select><span></span>`
    + `<label for="hic-curl-radius-${n}">Radius</label><input id="hic-curl-radius-${n}" data-key="radius" type="range" min="12" max="140" step="1"><output></output>`
    + `<label for="hic-curl-shadow-${n}">Shadow</label><input id="hic-curl-shadow-${n}" data-key="shadow" type="range" min="0" max="100" step="1"><output></output>`;
  const select = /** @type {HTMLSelectElement} */ (box.querySelector('select'));
  const hint = /** @type {HTMLElement} */ (box.querySelector('p'));
  const [radius, shadow] = /** @type {HTMLInputElement[]} */ ([...box.querySelectorAll('input')]);
  const [radiusOut, shadowOut] = [...box.querySelectorAll('output')];
  select.value = CORNERS.includes(String(o.corner)) ? String(o.corner) : 'any';
  radius.value = String(clampNum(o.radius, 12, 140, 56));
  shadow.value = String(Math.round(clampNum(o.shadow, 0, 1, 0.8) * 100));
  hint.textContent = hintText(select.value);
  const show = () => { radiusOut.textContent = `${radius.value}px`; shadowOut.textContent = `${shadow.value}%`; };
  show();
  const onCorner = () => { hint.textContent = hintText(select.value); ui.setOptions({ corner: select.value }); };
  const onRange = () => { show(); ui.setOptions({ radius: Number(radius.value), shadow: Number(shadow.value) / 100 }); };
  select.addEventListener('change', onCorner);
  radius.addEventListener('input', onRange);
  shadow.addEventListener('input', onRange);
  root.append(box);
  return () => {
    select.removeEventListener('change', onCorner);
    radius.removeEventListener('input', onRange);
    shadow.removeEventListener('input', onRange);
    box.remove();
  };
}

/** @param {any} device @param {string} code @param {string} format */
async function createPipeline(device, code, format) {
  const module = device.createShaderModule({ code, label: 'hic-page-curl' });
  // a WGSL error would otherwise only show as a blank frame: fail create() with the compiler's message instead
  const info = await module.getCompilationInfo?.();
  const error = info?.messages?.find((/** @type {any} */ m) => m.type === 'error');
  if (error) throw new Error(`page-curl.wgsl:${error.lineNum}: ${error.message}`);
  return device.createRenderPipeline({
    label: 'hic-page-curl', layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
}

const IDLE = 0;
const DRAG = 1;
const RELEASE = 2;

/** @type {EffectPluginDefinition} */
export const plugin = Object.freeze({
  type: 'page-curl',
  apiVersion: /** @type {const} */ (2),
  version: 1,
  // the pass only writes its destination as a same-format colour attachment (it never samples or reads it)
  outputCapabilities: Object.freeze({ directCanvasRenderAttachment: /** @type {const} */ (true) }),
  async create(context, initialOptions) {
    const { device, format, canvas, source } = context;
    const pipeline = await createPipeline(device, await wgsl('page-curl.wgsl'), format);
    const usage = /** @type {any} */ (globalThis).GPUBufferUsage;
    const uniforms = device.createBuffer({ label: 'hic-page-curl', size: UNIFORM_FLOATS * 4, usage: usage.UNIFORM | usage.COPY_DST });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const bindGroups = new WeakMap();   // one per source view: the host may replace the source texture on resize
    const globals = new Float32Array(UNIFORM_FLOATS);
    const mapperStates = Array.from({ length: MAPPER_SLOTS }, () => new Float32Array(UNIFORM_FLOATS));
    const mappers = mapperStates.map(makeMapper);
    let mapperSlot = 0;
    // reused every frame: no allocation on the render path
    const attachment = { view: /** @type {any} */ (null), loadOp: 'clear', storeOp: 'store', clearValue: CLEAR };
    const passDescriptor = { colorAttachments: [attachment] };

    const doc = canvas.ownerDocument;
    const win = /** @type {any} */ (doc.defaultView);
    const reducedMotion = !!win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (/** @type {any} */ (doc).createElement) injectUiStyle(doc);   // the grab cursor rules (a test fake may have no DOM)

    let corner = 'any';
    let radius = 56;
    let shadow = 0.8;
    let hotZone = 64;
    let dogEar = 40;
    let autoPeek = 5;
    let under = parseColor(null);
    let paper = parseColor(null, [0.384, 0.663, 0.769]);   // #62a9c4
    /** @param {Readonly<Record<string, unknown>>|undefined} o */
    function applyOptions(o) {
      if (!o) return;
      if (o.corner !== undefined) corner = CORNERS.includes(String(o.corner)) ? String(o.corner) : 'any';
      if (o.radius !== undefined) radius = clampNum(o.radius, 4, 200, radius);
      if (o.shadow !== undefined) shadow = clampNum(o.shadow, 0, 1, shadow);
      if (o.hotZone !== undefined) hotZone = clampNum(o.hotZone, 16, 200, hotZone);
      if (o.dogEar !== undefined) dogEar = clampNum(o.dogEar, 0, 120, dogEar);
      if (o.autoPeek !== undefined) autoPeek = clampNum(o.autoPeek === false ? 0 : o.autoPeek, 0, 600, autoPeek);
      if (o.under !== undefined) under = parseColor(o.under);
      if (o.paper !== undefined) paper = parseColor(o.paper, paper);
    }
    applyOptions(initialOptions);

    // gesture state (CSS px of the page)
    let phase = IDLE;
    let pointerId = -1;
    let grabbed = /** @type {'tl'|'tr'|'bl'|'br'} */ ('tr');
    let cornerX = 0, cornerY = 0;          // the grabbed corner
    let dragX = 0, dragY = 0;              // the pointer while dragging
    let fromX = 0, fromY = 0;              // where the release started
    let releaseStart = -1;                 // frame clock; -1 until the first frame after the release
    let swallowClick = false;
    let pageWidth = 0, pageHeight = 0;     // css size of the last frame
    // the rest pose: `restCorner` is lifted by `lift` CSS px per axis (the dog-ear, the hover lift, an auto-peek)
    let restCorner = hintCorner(corner);
    let lift = dogEar;
    let hover = /** @type {'tl'|'tr'|'bl'|'br'|null} */ (null);
    let lastNow = -1;
    let born = -1;                         // frame clock of the first frame: the auto-peek schedule starts there
    let dragged = false;                   // the first drag ends the auto-peek for good
    let peekTimer = 0;
    // the element the pointer events land on (the live layer): its cursor shows the grab
    /** @type {Element|null} */ let surface = null;
    let cursor = '';
    /** @type {Element} */ let captureEl = canvas;

    const size = () => (pageWidth > 0 ? [pageWidth, pageHeight] : [canvas.clientWidth, canvas.clientHeight]);
    /** @param {PointerEvent} e @returns {[number, number]} */
    function toPage(e) {
      const r = canvas.getBoundingClientRect();
      const [w, h] = size();
      const sx = r.width > 0 ? w / r.width : 1;
      const sy = r.height > 0 ? h / r.height : 1;
      return [(e.clientX - r.left) * sx, (e.clientY - r.top) * sy];
    }
    /** an event on the drawn page (the live form or the canvas) @param {Event} e */
    const onPage = (e) => { const path = e.composedPath(); return path.includes(canvas) || path.includes(source); };
    /** @param {Event} e */
    const swallow = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
    /** 'grab' over a hot zone, 'grabbing' while dragging, '' otherwise (a data attribute on the layer; the rules are in injectUiStyle) @param {string} value */
    function setCursor(value) {
      if (value === cursor || !surface) return;
      cursor = value;
      if (value) surface.setAttribute('data-hic-curl-cursor', value); else surface.removeAttribute('data-hic-curl-cursor');
    }
    const peeking = () => autoPeek > 0 && !dragged && !reducedMotion;
    function stopPeekTimer() { if (peekTimer) win?.clearTimeout?.(peekTimer); peekTimer = 0; }
    /** the hot corner under the pointer changed @param {'tl'|'tr'|'bl'|'br'|null} key */
    function hoverTo(key) {
      setCursor(key ? 'grab' : '');
      if (key === hover) return;
      hover = key; lastNow = -1;
      context.requestRender();
    }

    /** @param {PointerEvent} e */
    function onDown(e) {
      swallowClick = false;
      if (phase === DRAG || !e.isPrimary || e.button !== 0 || !onPage(e)) return;
      const [x, y] = toPage(e);
      const [w, h] = size();
      const key = hotCorner(x, y, w, h, corner, hotZone);
      if (!key) return;
      // the grab is this plugin's gesture: neither the interposer nor the form see it, nothing is focused or selected
      swallow(e);
      phase = DRAG;
      pointerId = e.pointerId;
      grabbed = key;
      cornerX = CORNER_AT[key][0] * w; cornerY = CORNER_AT[key][1] * h;
      dragX = x; dragY = y;
      hover = null; dragged = true;
      stopPeekTimer();
      setCursor('grabbing');
      // captured to the layer when known, so the grabbing cursor stays while the pointer leaves the page
      captureEl = surface ?? canvas;
      try { captureEl.setPointerCapture(e.pointerId); } catch { /* a synthetic or finished pointer */ }
      context.requestRender();
    }
    /** @param {PointerEvent} e */
    function onMove(e) {
      if (phase === DRAG && e.pointerId === pointerId) {
        swallow(e);
        const [x, y] = toPage(e);
        const [w, h] = size();
        dragX = Math.min(w, Math.max(0, x)); dragY = Math.min(h, Math.max(0, y));
        context.requestRender();
        return;
      }
      if (phase !== IDLE || !onPage(e)) return;
      const [x, y] = toPage(e);
      const [w, h] = size();
      hoverTo(hotCorner(x, y, w, h, corner, hotZone));
    }
    /** @param {PointerEvent} e */
    function onUp(e) {
      if (phase !== DRAG || e.pointerId !== pointerId) return;
      swallow(e);
      try { captureEl.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      swallowClick = e.type === 'pointerup';
      fromX = dragX; fromY = dragY;
      releaseStart = -1;
      pointerId = -1;
      setCursor('');
      if (reducedMotion) settle();   // reduced motion: the page lies back at once
      else phase = RELEASE;
      context.requestRender();
    }
    /** the release ended: the grabbed corner is the rest corner again, at its rest lift */
    function settle() {
      phase = IDLE;
      restCorner = grabbed;
      lift = grabbed === hintCorner(corner) ? dogEar : 0;
      lastNow = -1;
    }
    /** the click that follows the grab's pointerup (a pointer click has detail > 0) @param {MouseEvent} e */
    function onClick(e) {
      if (!swallowClick || e.detail === 0) return;
      swallowClick = false;
      swallow(e);
    }
    const onLeave = () => { if (phase === IDLE) hoverTo(null); };
    /** pointer events that reach the live layer: learn it (the cursor is shown there) @param {Event} e */
    const onLayerMove = (e) => {
      const t = /** @type {Element|null} */ (e.currentTarget);
      if (t && t !== canvas && t !== surface) { const c = cursor; setCursor(''); surface = t; setCursor(c || (hover ? 'grab' : '')); }
      else if (hover && !cursor) setCursor('grab');
    };

    /** @type {[string, (e: any) => void][]} */
    const documentListeners = [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onUp], ['click', onClick]];
    for (const [type, fn] of documentListeners) doc.addEventListener(type, fn, true);
    context.listen('pointerleave', onLeave);
    context.listen('pointermove', onLayerMove);
    context.listen('pointerover', onLayerMove);

    /** where the corner `key` lies when lifted by `a` CSS px per axis @param {'tl'|'tr'|'bl'|'br'} key @param {number} a @param {number} w @param {number} h */
    const liftedTo = (key, a, w, h) => {
      const [fx, fy] = CORNER_AT[key];
      return [fx * w + (fx ? -a : a), fy * h + (fy ? -a : a)];
    };

    /**
     * Writes the curl of this frame; advances the release, the hover lift and the auto-peek on the frame clock. Returns true while
     * something still moves (the next frame is needed). @param {number} now @param {number} w @param {number} h
     */
    function step(now, w, h) {
      if (born < 0) born = now;
      // the lift starts on the first frame after the hover changed (lastNow = -1), not from whenever the last frame was drawn
      const dt = lastNow < 0 ? 0 : Math.max(0, now - lastNow);
      lastNow = now;
      if (phase === DRAG) { curlGeometry(globals, cornerX, cornerY, dragX, dragY, radius); return false; }
      if (phase === RELEASE) {
        if (releaseStart < 0) releaseStart = now;
        const t = (now - releaseStart) / RELEASE_MS;
        if (t >= 1) settle();
        else {
          const e = releaseEase(Math.max(0, t));
          const [ex, ey] = liftedTo(grabbed, grabbed === hintCorner(corner) ? dogEar : 0, w, h);
          curlGeometry(globals, cornerX, cornerY, fromX + (ex - fromX) * e, fromY + (ey - fromY) * e, radius);
          return true;
        }
      }
      // the rest pose that is wanted now: the hovered corner lifted, else the dog-ear (peeking open now and then)
      const hint = hintCorner(corner);
      const want = hover ?? hint;
      const peek = !hover && peeking() ? peekAt(now - born, autoPeek) : 0;
      const a = (want === hint ? dogEar : 0) + (hover ? hotZone * HOVER_FRACTION : peek * Math.min(150, 0.25 * Math.min(w, h)));
      let moving = peek > 0;
      if (reducedMotion) { restCorner = want; lift = a; }
      else {
        const target = restCorner === want ? a : 0;   // another corner: lay this one flat first
        lift += (target - lift) * (1 - Math.exp(-dt / LIFT_MS));   // the same curve at every frame rate
        if (Math.abs(target - lift) < 0.05) lift = target;
        if (restCorner !== want && lift < 2) { restCorner = want; lift = 0; }
        moving = moving || lift !== a || restCorner !== want;
      }
      const [tx, ty] = liftedTo(restCorner, lift, w, h);
      const [fx, fy] = CORNER_AT[restCorner];
      curlGeometry(globals, fx * w, fy * h, tx, ty, radius);
      return moving;
    }

    /** At rest, wake for the next auto-peek (frames are requested only while something moves). @param {number} now */
    function schedulePeek(now) {
      stopPeekTimer();
      if (!peeking() || hover || phase !== IDLE || !win?.setTimeout) return;
      const t = now - born - PEEK_DELAY_MS;
      const every = Math.max(PEEK_MS, autoPeek * 1000);
      const wait = t < 0 ? -t : every - (t % every);
      peekTimer = win.setTimeout(() => { peekTimer = 0; context.requestRender(); }, Math.max(16, wait));
    }

    return {
      spatial: true,   // not `continuous`: frames are requested while something moves (drag, release, hover lift, auto-peek), none at rest
      setOptions(next) { applyOptions(next); lastNow = -1; context.requestRender(); },
      render(frame) {
        const w = frame.cssWidth;
        const h = frame.cssHeight;
        pageWidth = w; pageHeight = h;
        globals[0] = frame.width; globals[1] = frame.height; globals[2] = w; globals[3] = h;
        // the release, the lift and the peek run on the frame clock: ask for the next (capped) frame until they settle
        if (step(frame.now, w, h)) { stopPeekTimer(); context.requestRender(); } else schedulePeek(frame.now);
        globals[9] = shadow; globals[10] = frame.sourceReady ? 1 : 0; globals[11] = INK;
        globals[12] = under[0]; globals[13] = under[1]; globals[14] = under[2]; globals[15] = 0;
        globals[16] = paper[0]; globals[17] = paper[1]; globals[18] = paper[2]; globals[19] = 0;
        device.queue.writeBuffer(uniforms, 0, globals);
        let bindGroup = bindGroups.get(frame.sourceView);
        if (!bindGroup) {
          bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: uniforms } }, { binding: 1, resource: sampler }, { binding: 2, resource: frame.sourceView }],
          });
          bindGroups.set(frame.sourceView, bindGroup);
        }
        attachment.view = frame.destinationView;
        const pass = frame.encoder.beginRenderPass(passDescriptor);
        pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.draw(3); pass.end();
        attachment.view = null;
      },
      // called each time a frame is PRESENTED: the uniform block of that frame is copied into one of 4 slots
      captureInputMapper() {
        mapperSlot = (mapperSlot + 1) % MAPPER_SLOTS;
        mapperStates[mapperSlot].set(globals);
        return mappers[mapperSlot];
      },
      mountUI(root, ui) { return mountCurlUi(root, ui); },
      destroy() {
        for (const [type, fn] of documentListeners) doc.removeEventListener(type, fn, true);
        if (pointerId >= 0) { try { captureEl.releasePointerCapture(pointerId); } catch { /* gone */ } }
        stopPeekTimer();
        setCursor('');
        uniforms.destroy?.();
      },
    };
  },
});
