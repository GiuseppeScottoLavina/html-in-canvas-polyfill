/**
 * Page curl effect plugin (effect plugin ABI v2): an EXAMPLE of the effects extension of html-in-canvas-polyfill, not part of the polyfill.
 * Shaders: ./page-curl.wgsl, ./blur.wgsl. The shape of the fold: ./fold.js.
 *
 * The drawn page is a sheet of paper bound along one edge. Take hold of a corner (a hot zone of `hotZone` CSS px around it) and the sheet
 * folds over and rolls up under your hand: a tessellated 3D sheet, seen by a camera straight above it, lit by one lamp, casting a soft
 * shadow that widens with its height, its back plain paper with the live page's ink showing through it, and the page underneath revealed.
 * The corner follows the pointer on a spring (it has weight) and springs back on release. The live page keeps updating on the curling sheet
 * (it is sampled every frame), and its flat part stays usable. At rest one corner is a small dog-ear that now and then peeks open.
 *
 * Input: the grab is the plugin's own gesture. Its pointer events are taken in the capture phase at the document, before the host's
 * interposer and the form see them (preventDefault: no focus change, no text selection, no click), and the pointer is captured to the
 * layer. Every other pointer goes through the host's interposer and this plugin's input mapper (`mapCurlPoint`): the identity on the flat
 * page, the exact page point on the front of the roll that faces the reader, NO_TARGET on the back of the sheet (the roll, the folded
 * flap, the dog-ear) and on the page underneath.
 */

import { NO_TARGET, isNoTarget } from '../../src/effects/no-target.js';
import { constrainCorner, foldFor, foldPoint, project, springStep, SPRING_STEP, unproject } from './fold.js';
import { wgsl } from './wgsl.js';
import { stateMapper } from '../_lib/mapper.js';
import { clampNum } from '../_lib/number.js';
import { injectStyle } from '../_lib/ui.js';

/** @typedef {import('../../src/contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../../src/contracts/types.js').InputMapper} InputMapper */
/** @typedef {import('../../src/contracts/types.js').InputPoint} InputPoint */

/** What the plugin gallery and the build read (plugins/README.md). */
export const meta = Object.freeze({
  name: 'page-curl',
  title: 'Page curl',
  description: 'Grab a corner and the live page folds and rolls up under your hand in 3D, lit and shadowed, still updating; it springs back on release.',
  defaults: Object.freeze({ corner: 'any', radius: 48, shadow: 0.85, dogEar: 36, autoPeek: 5 }),
  reducedMotion: 'With reduced motion the drag still follows the hand (without lag); the dog-ear stays still; release and hover lift happen at once.',
});

/**
 * Uniform block (page-curl.wgsl `Uniforms`), also the frozen state of a mapper: [0,1] resolution, [2,3] css size W,H, [4,5] fold n,
 * [6,7] fold axis point a, [8] roll radius R, [9] pull L (0: flat), [10] mirror (1 bound left, -1 bound right), [11] camera distance,
 * [12] shadow, [13] ready, [14] ink, [15] rows of the strip, [16..19] page underneath, [20..23] paper, [24..27] towards the lamp,
 * [28..31] shadow offset, [32..35] the page in the fold's frame (s min, s max, w min, w max).
 */
export const UNIFORM_FLOATS = 36;
export { NO_TARGET, isNoTarget };
export const CORNERS = Object.freeze(['any', 'tl', 'tr', 'bl', 'br']);
/** the camera's distance, in page sizes */
export const DISTANCE = 2.4;
const LIGHT = (() => { const v = [-0.3, -0.42, 1]; const l = Math.hypot(...v); return v.map((x) => x / l); })();

const MAPPER_SLOTS = 4;       // the host keeps the mappers of the last 3 presented frames, plus the one being written
const INK = 0.3;             // the front's ink seen through the paper
const HOVER_FRACTION = 0.6;   // hover lift (CSS px per axis), as a fraction of the hot zone, on top of the dog-ear
const PEEK_DELAY_MS = 1500;   // first auto-peek after the first frame
export const PEEK_MS = 1800;  // one auto-peek: the dog-ear opens and closes (sin^2)
// springs (omega rad/s, zeta): the hand pulls the corner; released, the paper springs back; the rest pose eases in
const DRAG = Object.freeze([30, 0.8]);
const RELEASE = Object.freeze([13, 0.86]);
const REST = Object.freeze([16, 1]);
/** rows of the strip across the roll (page-curl.wgsl strip_point): one every PI R / 159, under 1.5 css px for the largest roll */
export const ROWS = 160;
/** corner name -> [x, y] as a fraction of the page */
const CORNER_AT = Object.freeze({ tl: [0, 0], tr: [1, 0], bl: [0, 1], br: [1, 1] });
const CORNER_NAME = Object.freeze({ tl: ['top-left', '↖'], tr: ['top-right', '↗'], bl: ['bottom-left', '↙'], br: ['bottom-right', '↘'] });
/** The corner that wears the dog-ear and peeks: the allowed corner, or top-right when any corner may be grabbed. @param {unknown} corner */
export const hintCorner = (corner) => /** @type {'tl'|'tr'|'bl'|'br'} */ (corner === 'tl' || corner === 'bl' || corner === 'br' ? corner : 'tr');
/** The text of the hint label for `corner`. @param {unknown} corner */
export function hintText(corner) {
  const [name, arrow] = CORNER_NAME[hintCorner(corner)];
  return `${arrow} Drag the ${name} corner to turn the page${corner === 'any' || !CORNERS.includes(String(corner)) ? ' (any corner works)' : ''}.`;
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

/** '#rgb' / '#rrggbb' -> [r, g, b] in 0..1 (else `fallback`). @param {unknown} hex @param {number[]} [fallback] */
export function parseColor(hex, fallback = [0.89, 0.865, 0.815]) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex ?? ''));
  if (!m) return fallback;
  const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

/**
 * The corner whose hot zone contains (x, y), or null. PURE.
 * @param {number} x  CSS px in the page @param {number} y @param {number} width @param {number} height
 * @param {string} allowed  'any' or one corner name @param {number} hotZone  radius in CSS px
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

/** the largest roll for a pull of L px on a page W wide: a long pull bows the sheet into a bigger loop @param {number} radius @param {number} L @param {number} W */
export const rollFor = (radius, L, W) => radius * (1 + 0.9 * Math.sin(Math.PI * Math.min(1, L / Math.max(1, W))));

const fold = { nx: 1, ny: 0, ax: 0, ay: 0, R: 0, L: 0 };
const leafAt = { x: 0, y: 0 };
/**
 * The fold that puts corner `key` at the page point (x, y) (as near as a bound sheet allows), written into the uniform block `out`
 * ([2..11]). Returns `out`. PURE apart from `out`.
 * @param {Float32Array} out @param {number} W @param {number} H @param {'tl'|'tr'|'bl'|'br'} key @param {number} x @param {number} y @param {number} radius
 */
export function poseState(out, W, H, key, x, y, radius) {
  const mirror = CORNER_AT[key][0] === 1 ? 1 : -1;   // a right-hand corner: the sheet is bound on the left edge
  const lead = CORNER_AT[key][1] === 1 ? 'bottom' : 'top';
  leafAt.x = mirror > 0 ? x : W - x; leafAt.y = y;
  constrainCorner(leafAt, lead, W, H, leafAt);
  const L = Math.hypot(W - leafAt.x, (lead === 'bottom' ? H : 0) - leafAt.y);
  foldFor(leafAt, lead, W, H, rollFor(radius, L, W), fold);
  out[2] = W; out[3] = H;
  out[4] = fold.nx; out[5] = fold.ny; out[6] = fold.ax; out[7] = fold.ay; out[8] = fold.R; out[9] = fold.L < 0.5 ? 0 : fold.L;
  out[10] = mirror; out[11] = DISTANCE * Math.max(W, H);
  return out;
}

/**
 * The page in the frame of the fold of `st` (written at [32..35]): the range of s (along n) and of w (along the axis) over its corners.
 * @param {Float32Array} st @param {number} W @param {number} H
 */
export function foldSpan(st, W, H) {
  const nx = st[4], ny = st[5], ax = st[6], ay = st[7];
  let s0 = Infinity, s1 = -Infinity, w0 = Infinity, w1 = -Infinity;
  for (const [x, y] of [[0, 0], [W, 0], [0, H], [W, H]]) {
    const s = (x - ax) * nx + (y - ay) * ny, w = -(x - ax) * ny + (y - ay) * nx;
    s0 = Math.min(s0, s); s1 = Math.max(s1, s); w0 = Math.min(w0, w); w1 = Math.max(w1, w);
  }
  st[32] = s0; st[33] = s1; st[34] = w0; st[35] = w1;
  return st;
}

const PHI_SAMPLES = 48;
/**
 * The input mapper formula, the twin of what page-curl.wgsl draws: for a presented point, the page point the reader sees there. The
 * identity on the flat page; on the front of the roll that faces the reader the exact page point; NO_TARGET on the back of the sheet (the
 * roll, the folded flap, the dog-ear) and on the page underneath. The camera is the shader's (perspective from straight above). PURE.
 * @param {Float32Array} st  the uniform block of the presented frame @param {InputPoint} point  canvas CSS px, plus the presented size
 * @returns {{x: number, y: number}}
 */
export function mapCurlPoint(st, point) {
  if (!(st[9] > 0)) return { x: point.x, y: point.y };
  const W = st[2], H = st[3];
  const sx = W / Math.max(1, point.width), sy = H / Math.max(1, point.height);
  const px = point.x * sx, py = point.y * sy;
  const nx = st[4], ny = st[5], ax = st[6], ay = st[7], R = st[8], m = st[10], D = st[11];
  const inside = (/** @type {number} */ x, /** @type {number} */ y) => x >= 0 && y >= 0 && x <= W && y <= H;
  const q = { x: 0, y: 0 };
  const localX = (/** @type {number} */ X) => (m > 0 ? X : W - X);
  // the folded flap lies highest (2R): the back of the sheet
  unproject(px, py, 2 * R, W, H, D, q);
  let lx = localX(q.x), ly = q.y;
  const t = (lx - ax) * nx + (ly - ay) * ny;
  if (t <= 0) {
    const k = 2 * (Math.PI * R - t) - Math.PI * R;
    if (inside(lx + nx * k, ly + ny * k)) return NO_TARGET;
  }
  // the roll: the points of the cylinder on this line of sight; the highest one inside the sheet is the one seen
  if (R > 0) {
    const f = (/** @type {number} */ phi) => { unproject(px, py, R * (1 - Math.cos(phi)), W, H, D, q); return (localX(q.x) - ax) * nx + (q.y - ay) * ny - R * Math.sin(phi); };
    let best = -1;
    let prev = f(0);
    for (let i = 1; i <= PHI_SAMPLES; i += 1) {
      const p1 = (Math.PI * i) / PHI_SAMPLES;
      const v1 = f(p1);
      if ((prev <= 0) !== (v1 <= 0)) {
        let lo = (Math.PI * (i - 1)) / PHI_SAMPLES, hi = p1, flo = prev;
        for (let k = 0; k < 30; k += 1) { const mid = (lo + hi) / 2; const fm = f(mid); if ((fm <= 0) === (flo <= 0)) { lo = mid; flo = fm; } else hi = mid; }
        const phi = (lo + hi) / 2;
        unproject(px, py, R * (1 - Math.cos(phi)), W, H, D, q);
        const back = R * phi - R * Math.sin(phi);
        const qx = localX(q.x) + nx * back, qy = q.y + ny * back;
        if (inside(qx, qy)) best = phi;   // phi grows with height: the last root found is the highest
      }
      prev = v1;
    }
    if (best >= 0) {
      const Z = R * (1 - Math.cos(best));
      unproject(px, py, Z, W, H, D, q);
      const X = q.x, Y = q.y;
      const back = R * best - R * Math.sin(best);
      const qx = localX(X) + nx * back, qy = Y + ny * back;
      // which side faces the reader: the front's normal (-n sin(phi), cos(phi)) against the line of sight
      const vx = W / 2 - X, vy = H / 2 - Y, vz = D - Z;
      const facing = -nx * Math.sin(best) * m * vx - ny * Math.sin(best) * vy + Math.cos(best) * vz;
      if (facing < 0) return NO_TARGET;
      return { x: (m > 0 ? qx : W - qx) / sx, y: qy / sy };
    }
  }
  // the flat part of the sheet is the page; beyond the fold lies the page underneath
  lx = localX(px); ly = py;
  return (lx - ax) * nx + (ly - ay) * ny <= 0 ? { x: point.x, y: point.y } : NO_TARGET;
}

/** @type {WeakMap<Function, Float32Array>} */
const mapperStates = new WeakMap();
/** The uniform block a mapper of this plugin answers from (the frame it was captured for), or undefined; for tests. @param {Function} mapper */
export const stateOf = (mapper) => mapperStates.get(mapper);

/** @param {Float32Array} state @returns {InputMapper} */
function makeMapper(state) {
  const mapper = stateMapper(state, mapCurlPoint);
  mapperStates.set(mapper, state);
  return mapper;
}

let uiSerial = 0;
/** CSS of the plugin UI (mountUI) */
const UI_CSS = `
    .hic-curl-ui { display:grid; grid-template-columns:auto 1fr auto; gap:4px 10px; align-items:center; color:rgba(224,247,255,.72); font-size:11px; font-weight:700; }
    .hic-curl-ui p { grid-column:1 / -1; margin:0 0 2px; font-size:13px; font-weight:800; color:#9cf5ff; }
    .hic-curl-ui output { color:#9cf5ff; text-align:right; font-variant-numeric:tabular-nums; min-width:4ch; }
    .hic-curl-ui input[type=range] { width:100%; height:24px; margin:0; accent-color:#79efff; cursor:ew-resize; }
    .hic-curl-ui select { font:inherit; color:#effcff; background:rgba(1,10,23,.55); border:1px solid rgba(173,226,255,.18); border-radius:8px; padding:3px 6px; }
    [data-hic-curl-cursor=grab], [data-hic-curl-cursor=grab] * { cursor:grab !important; }
    [data-hic-curl-cursor=grabbing], [data-hic-curl-cursor=grabbing] * { cursor:grabbing !important; }
  `;

/**
 * The plugin's controls: which corner can be grabbed, the roll radius and the shadow.
 * @param {Element} root
 * @param {{getOptions: () => Readonly<Record<string, unknown>>, setOptions: (patch: Record<string, unknown>) => void}} ui
 */
function mountCurlUi(root, ui) {
  const doc = root.ownerDocument;
  injectStyle(doc, 'page-curl', UI_CSS);
  const n = ++uiSerial;
  const o = ui.getOptions();
  const box = doc.createElement('div');
  box.className = 'hic-curl-ui';
  box.innerHTML = `<p class="hic-curl-hint"></p>`
    + `<label for="hic-curl-corner-${n}">Corner</label><select id="hic-curl-corner-${n}">${CORNERS.map((c) => `<option value="${c}">${c}</option>`).join('')}</select><span></span>`
    + `<label for="hic-curl-radius-${n}">Roll</label><input id="hic-curl-radius-${n}" data-key="radius" type="range" min="12" max="120" step="1"><output></output>`
    + `<label for="hic-curl-shadow-${n}">Shadow</label><input id="hic-curl-shadow-${n}" data-key="shadow" type="range" min="0" max="100" step="1"><output></output>`;
  const select = /** @type {HTMLSelectElement} */ (box.querySelector('select'));
  const hint = /** @type {HTMLElement} */ (box.querySelector('p'));
  const [radius, shadow] = /** @type {HTMLInputElement[]} */ ([...box.querySelectorAll('input')]);
  const [radiusOut, shadowOut] = [...box.querySelectorAll('output')];
  select.value = CORNERS.includes(String(o.corner)) ? String(o.corner) : 'any';
  radius.value = String(clampNum(o.radius, 12, 120, 48));
  shadow.value = String(Math.round(clampNum(o.shadow, 0, 1, 0.85) * 100));
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

/** @param {any} device @param {string} code @param {string} label */
async function shaderModule(device, code, label) {
  const module = device.createShaderModule({ code, label });
  // a WGSL error would otherwise only show as a blank frame: fail create() with the compiler's message instead
  const info = await module.getCompilationInfo?.();
  const error = info?.messages?.find((/** @type {any} */ m) => m.type === 'error');
  if (error) throw new Error(`${label}:${error.lineNum}: ${error.message}`);
  return module;
}

const IDLE = 0;
const DRAGGING = 1;
const RELEASING = 2;

/** @type {EffectPluginDefinition} */
export const plugin = Object.freeze({
  type: 'page-curl',
  apiVersion: /** @type {const} */ (2),
  version: 2,
  // every pass that touches the destination only writes it as a colour attachment (the MSAA resolve); nothing samples it
  outputCapabilities: Object.freeze({ directCanvasRenderAttachment: /** @type {const} */ (true) }),
  async create(context, initialOptions) {
    const { device, format, canvas, source } = context;
    const G = /** @type {any} */ (globalThis);
    const module = await shaderModule(device, await wgsl('page-curl.wgsl'), 'page-curl.wgsl');
    const blurModule = await shaderModule(device, await wgsl('blur.wgsl'), 'blur.wgsl');
    const S = G.GPUShaderStage, BU = G.GPUBufferUsage, TU = G.GPUTextureUsage;
    const mainLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: S.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: S.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 3, visibility: S.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 4, visibility: S.FRAGMENT, texture: { sampleType: 'float' } },
    ] });
    const occLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'uniform' } }] });
    const blurLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: S.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: S.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: S.FRAGMENT, texture: { sampleType: 'float' } },
    ] });
    const msaa = { count: 4 };
    const flatDepth = { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' };
    const pipe = (/** @type {any} */ o) => device.createRenderPipeline({ primitive: { topology: 'triangle-list' }, ...o });
    const mainPL = device.createPipelineLayout({ bindGroupLayouts: [mainLayout] });
    const passPipe = pipe({ layout: mainPL, vertex: { module, entryPoint: 'vs_full' }, fragment: { module, entryPoint: 'fs_pass', targets: [{ format }] }, multisample: msaa, depthStencil: flatDepth });
    const underPipe = pipe({ layout: mainPL, vertex: { module, entryPoint: 'vs_full' }, fragment: { module, entryPoint: 'fs_under', targets: [{ format }] }, multisample: msaa, depthStencil: flatDepth });
    // the sheet is a triangle strip in the fold's frame (no vertex buffer); its cut edges are antialiased by alpha to coverage
    const strip = { topology: 'triangle-strip' };
    const leafPipe = pipe({ layout: mainPL, primitive: strip, vertex: { module, entryPoint: 'vs_mesh' }, fragment: { module, entryPoint: 'fs_leaf', targets: [{ format, blend: { color: { srcFactor: 'one', dstFactor: 'zero' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } } }] },
      multisample: { count: 4, alphaToCoverageEnabled: true }, depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' } });
    const max = { operation: 'max', srcFactor: 'one', dstFactor: 'one' };
    const occPipe = pipe({ layout: device.createPipelineLayout({ bindGroupLayouts: [occLayout] }), primitive: strip, vertex: { module, entryPoint: 'vs_occ' },
      fragment: { module, entryPoint: 'fs_occ', targets: [{ format: 'rgba8unorm', blend: { color: max, alpha: max } }] } });
    const blurPipe = pipe({ layout: device.createPipelineLayout({ bindGroupLayouts: [blurLayout] }), vertex: { module: blurModule, entryPoint: 'vs_full' },
      fragment: { module: blurModule, entryPoint: 'fs_blur', targets: [{ format: 'rgba8unorm' }] } });

    const uniforms = device.createBuffer({ label: 'hic-page-curl', size: UNIFORM_FLOATS * 4, usage: BU.UNIFORM | BU.COPY_DST });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const occGroup = device.createBindGroup({ layout: occLayout, entries: [{ binding: 0, resource: { buffer: uniforms } }] });
    const blurSteps = Array.from({ length: 6 }, () => device.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST }));
    const globals = new Float32Array(UNIFORM_FLOATS);
    const stepData = new Float32Array(4);
    const slots = Array.from({ length: MAPPER_SLOTS }, () => new Float32Array(UNIFORM_FLOATS));
    const mappers = slots.map(makeMapper);
    let mapperSlot = 0;

    // size-dependent resources: the 4x multisampled colour and depth targets, the occlusion textures and their bind groups
    /** @type {any} */ let sized = null;
    function resources(/** @type {number} */ w, /** @type {number} */ h, /** @type {number} */ cw, /** @type {number} */ ch) {
      if (sized && sized.w === w && sized.h === h && sized.cw === cw && sized.ch === ch) return sized;
      if (sized) for (const t of sized.textures) t.destroy?.();
      const color = device.createTexture({ size: [w, h], format, sampleCount: 4, usage: TU.RENDER_ATTACHMENT });
      const depth = device.createTexture({ size: [w, h], format: 'depth24plus', sampleCount: 4, usage: TU.RENDER_ATTACHMENT });
      const ow = Math.max(1, Math.ceil(cw / 2)), oh = Math.max(1, Math.ceil(ch / 2));
      const occ = () => device.createTexture({ size: [ow, oh], format: 'rgba8unorm', usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
      const sharp = occ(), tmp = occ(), soft = occ(), wide = occ();
      const views = { sharp: sharp.createView(), tmp: tmp.createView(), soft: soft.createView(), wide: wide.createView() };
      // six blur passes: a little (1 tap), then a lot (3.5 taps, then 2.2), each horizontal then vertical
      const plan = [[views.sharp, views.tmp, 1, 0], [views.tmp, views.soft, 0, 1], [views.soft, views.tmp, 3.5, 0], [views.tmp, views.wide, 0, 3.5], [views.wide, views.tmp, 2.2, 0], [views.tmp, views.wide, 0, 2.2]];
      const blurs = plan.map(([src, dst, dx, dy], i) => {
        stepData[0] = /** @type {number} */ (dx) / ow; stepData[1] = /** @type {number} */ (dy) / oh;
        device.queue.writeBuffer(blurSteps[i], 0, stepData);
        return { dst, group: device.createBindGroup({ layout: blurLayout, entries: [{ binding: 0, resource: { buffer: blurSteps[i] } }, { binding: 1, resource: sampler }, { binding: 2, resource: src }] }) };
      });
      sized = { w, h, cw, ch, textures: [color, depth, sharp, tmp, soft, wide], colorView: color.createView(), depthView: depth.createView(), views, blurs, groups: new WeakMap(), occKey: '' };
      return sized;
    }
    // reused pass descriptors: a frame writes their views, it allocates nothing of its own
    const occAttachment = { view: /** @type {any} */ (null), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } };
    const occPass = { colorAttachments: [occAttachment] };
    const mainAttachment = { view: /** @type {any} */ (null), resolveTarget: /** @type {any} */ (null), loadOp: 'clear', storeOp: 'discard', clearValue: { r: 0, g: 0, b: 0, a: 1 } };
    const depthAttachment = { view: /** @type {any} */ (null), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' };
    const mainPass = { colorAttachments: [mainAttachment], depthStencilAttachment: depthAttachment };

    const doc = canvas.ownerDocument;
    const win = /** @type {any} */ (doc.defaultView);
    const reducedMotion = !!win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (/** @type {any} */ (doc).createElement) injectStyle(doc, 'page-curl', UI_CSS);   // the grab cursor rules (a test fake may have no DOM)

    let corner = 'any';
    let radius = 48;
    let shadow = 0.85;
    let hotZone = 64;
    let dogEar = 36;
    let autoPeek = 5;
    let under = parseColor(null, [0.82, 0.79, 0.735]);
    let paper = parseColor(null, [0.965, 0.95, 0.915]);
    /** @param {Readonly<Record<string, unknown>>|undefined} o */
    function applyOptions(o) {
      if (!o) return;
      if (o.corner !== undefined) corner = CORNERS.includes(String(o.corner)) ? String(o.corner) : 'any';
      if (o.radius !== undefined) radius = clampNum(o.radius, 4, 200, radius);
      if (o.shadow !== undefined) shadow = clampNum(o.shadow, 0, 1, shadow);
      if (o.hotZone !== undefined) hotZone = clampNum(o.hotZone, 16, 200, hotZone);
      if (o.dogEar !== undefined) dogEar = clampNum(o.dogEar, 0, 120, dogEar);
      if (o.autoPeek !== undefined) autoPeek = clampNum(o.autoPeek === false ? 0 : o.autoPeek, 0, 600, autoPeek);
      if (o.under !== undefined) under = parseColor(o.under, under);
      if (o.paper !== undefined) paper = parseColor(o.paper, paper);
    }
    applyOptions(initialOptions);

    // ---- the gesture -------------------------------------------------------------------------------------------------------------
    let phase = IDLE;
    let pointerId = -1;
    let dragX = 0, dragY = 0;              // the pointer while dragging (page css px)
    let swallowClick = false;
    let pageWidth = 0, pageHeight = 0;     // css size of the last frame
    // the corner that is lifted (or flat) now, and where it lies: two springs in page css px
    let active = /** @type {'tl'|'tr'|'bl'|'br'} */ (hintCorner(corner));
    const sx = { x: NaN, v: 0 }, sy = { x: NaN, v: 0 };
    let simT = -1;                         // frame clock of the spring simulation; -1: start at the next frame
    let hover = /** @type {'tl'|'tr'|'bl'|'br'|null} */ (null);
    let born = -1;
    let dragged = false;
    let peekTimer = 0;
    /** @type {Element|null} */ let surface = null;
    let cursor = '';
    /** @type {Element} */ let captureEl = canvas;

    const size = () => (pageWidth > 0 ? [pageWidth, pageHeight] : [canvas.clientWidth, canvas.clientHeight]);
    /** @param {PointerEvent} e @returns {[number, number]} */
    function toPage(e) {
      const r = canvas.getBoundingClientRect();
      const [w, h] = size();
      return [(e.clientX - r.left) * (r.width > 0 ? w / r.width : 1), (e.clientY - r.top) * (r.height > 0 ? h / r.height : 1)];
    }
    const onPage = (/** @type {Event} */ e) => { const path = e.composedPath(); return path.includes(canvas) || path.includes(source); };
    const swallow = (/** @type {Event} */ e) => { e.preventDefault(); e.stopImmediatePropagation(); };
    /** @param {string} value */
    function setCursor(value) {
      if (value === cursor || !surface) return;
      cursor = value;
      if (value) surface.setAttribute('data-hic-curl-cursor', value); else surface.removeAttribute('data-hic-curl-cursor');
    }
    const peeking = () => autoPeek > 0 && !dragged && !reducedMotion;
    function stopPeekTimer() { if (peekTimer) win?.clearTimeout?.(peekTimer); peekTimer = 0; }
    const wake = () => { if (simT >= 0 && resting) simT = -1; resting = false; context.requestRender(); };
    let resting = false;
    /** @param {'tl'|'tr'|'bl'|'br'|null} key */
    function hoverTo(key) {
      setCursor(key ? 'grab' : '');
      if (key === hover) return;
      hover = key;
      wake();
    }
    /** where corner `key` lies when lifted `a` CSS px per axis @param {'tl'|'tr'|'bl'|'br'} key @param {number} a @param {number} w @param {number} h @returns {[number, number]} */
    const liftedTo = (key, a, w, h) => { const [fx, fy] = CORNER_AT[key]; return [fx * w + (fx ? -a : a), fy * h + (fy ? -a : a)]; };
    const cornerAt = (/** @type {'tl'|'tr'|'bl'|'br'} */ key, /** @type {number} */ w, /** @type {number} */ h) => /** @type {[number, number]} */ ([CORNER_AT[key][0] * w, CORNER_AT[key][1] * h]);

    /** @param {PointerEvent} e */
    function onDown(e) {
      swallowClick = false;
      if (phase === DRAGGING || !e.isPrimary || e.button !== 0 || !onPage(e)) return;
      const [x, y] = toPage(e);
      const [w, h] = size();
      const key = hotCorner(x, y, w, h, corner, hotZone);
      if (!key) return;
      swallow(e);   // the grab is this plugin's gesture: neither the interposer nor the form see it
      if (key !== active) { active = key; [sx.x, sy.x] = cornerAt(key, w, h); sx.v = 0; sy.v = 0; }
      phase = DRAGGING;
      pointerId = e.pointerId;
      dragX = x; dragY = y;
      hover = null; dragged = true;
      stopPeekTimer();
      setCursor('grabbing');
      captureEl = surface ?? canvas;
      try { captureEl.setPointerCapture(e.pointerId); } catch { /* a synthetic or finished pointer */ }
      wake();
    }
    /** @param {PointerEvent} e */
    function onMove(e) {
      if (phase === DRAGGING && e.pointerId === pointerId) {
        swallow(e);
        [dragX, dragY] = toPage(e);
        wake();
        return;
      }
      if (phase !== IDLE || !onPage(e)) return;
      const [x, y] = toPage(e);
      const [w, h] = size();
      hoverTo(hotCorner(x, y, w, h, corner, hotZone));
    }
    /** @param {PointerEvent} e */
    function onUp(e) {
      if (phase !== DRAGGING || e.pointerId !== pointerId) return;
      swallow(e);
      try { captureEl.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      swallowClick = e.type === 'pointerup';
      pointerId = -1;
      setCursor('');
      phase = RELEASING;
      wake();
    }
    /** @param {MouseEvent} e */
    function onClick(e) {
      if (!swallowClick || e.detail === 0) return;
      swallowClick = false;
      swallow(e);
    }
    const onLeave = () => { if (phase === IDLE) hoverTo(null); };
    const onLayerMove = (/** @type {Event} */ e) => {
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

    /**
     * Advance the springs to frame time `now` (fixed steps: the pose depends on the time only, not on the frame rate) towards what is
     * wanted now: the pointer while dragging, the rest pose otherwise (the hovered corner lifted, else the dog-ear, peeking now and then).
     * Returns true while something still moves. @param {number} now @param {number} w @param {number} h
     */
    function step(now, w, h) {
      if (born < 0) born = now;
      if (Number.isNaN(sx.x)) { [sx.x, sy.x] = liftedTo(active, active === hintCorner(corner) ? dogEar : 0, w, h); }
      /** @type {readonly number[]} */ let spring = REST;
      let gx = sx.x, gy = sy.x;
      let moving = false;
      if (phase === DRAGGING) {
        // the pointer shows where the corner should appear; the corner lies 2R above the page, so aim at the point under it
        const lifted = unproject(Math.min(w, Math.max(0, dragX)), Math.min(h, Math.max(0, dragY)), 2 * globals[8], w, h, DISTANCE * Math.max(w, h), { x: 0, y: 0 });
        gx = lifted.x; gy = lifted.y; spring = DRAG;
      } else {
        const hint = hintCorner(corner);
        const want = phase === RELEASING ? active : hover ?? hint;
        const peek = phase === IDLE && !hover && peeking() ? peekAt(now - born, autoPeek) : 0;
        moving = peek > 0;
        if (want !== active) {
          // another corner is wanted: lay this one flat first
          [gx, gy] = cornerAt(active, w, h);
          if (Math.hypot(sx.x - gx, sy.x - gy) < 0.6 || reducedMotion) { active = want; [sx.x, sy.x] = cornerAt(want, w, h); sx.v = 0; sy.v = 0; }
          moving = true;
        }
        const a = (active === hint ? dogEar : 0) + (phase === IDLE && hover === active ? hotZone * HOVER_FRACTION : peek * Math.min(150, 0.25 * Math.min(w, h)));
        if (want === active) [gx, gy] = liftedTo(active, a, w, h);
        spring = phase === RELEASING ? RELEASE : REST;
      }
      if (reducedMotion) {
        sx.x = gx; sy.x = gy; sx.v = 0; sy.v = 0;
        simT = now;
        resting = true;
        // released: the page lies back at once, and in the same frame the dog-ear is where it rests
        if (phase === RELEASING) { phase = IDLE; return step(now, w, h); }
        return false;
      }
      if (simT < 0) simT = now;
      let steps = Math.floor((now - simT) / (SPRING_STEP * 1000) + 1e-6);
      if (steps > 480) { simT = now - 480 * SPRING_STEP * 1000; steps = 480; }
      for (let i = 0; i < steps; i += 1) { springStep(sx, gx, spring[0], spring[1]); springStep(sy, gy, spring[0], spring[1]); }
      simT += steps * SPRING_STEP * 1000;
      // the corner stays on the page (a spring overshooting past its own corner would fold the sheet the wrong way)
      sx.x = Math.min(w, Math.max(0, sx.x)); sy.x = Math.min(h, Math.max(0, sy.x));
      const settled = Math.abs(sx.x - gx) < 0.05 && Math.abs(sy.x - gy) < 0.05 && Math.abs(sx.v) < 0.5 && Math.abs(sy.v) < 0.5;
      if (settled && phase !== DRAGGING) {
        sx.x = gx; sy.x = gy; sx.v = 0; sy.v = 0;
        if (phase === RELEASING) phase = IDLE;
      }
      resting = settled && !moving;
      return phase === DRAGGING ? !settled : !resting;
    }

    /** At rest, wake for the next auto-peek (frames are requested only while something moves). @param {number} now */
    function schedulePeek(now) {
      stopPeekTimer();
      if (!peeking() || hover || phase !== IDLE || !win?.setTimeout) return;
      const t = now - born - PEEK_DELAY_MS;
      const every = Math.max(PEEK_MS, autoPeek * 1000);
      const wait = t < 0 ? -t : every - (t % every);
      peekTimer = win.setTimeout(() => { peekTimer = 0; wake(); }, Math.max(16, wait));
    }

    return {
      spatial: true,   // not `continuous`: frames are requested while something moves (drag, release, hover lift, auto-peek), none at rest
      setOptions(next) { applyOptions(next); wake(); },
      render(frame) {
        const w = frame.cssWidth, h = frame.cssHeight;
        pageWidth = w; pageHeight = h;
        const moving = step(frame.now, w, h);
        if (moving) { stopPeekTimer(); context.requestRender(); } else schedulePeek(frame.now);
        globals[0] = frame.width; globals[1] = frame.height;
        poseState(globals, w, h, active, sx.x, sy.x, radius);
        globals[12] = shadow; globals[13] = frame.sourceReady ? 1 : 0; globals[14] = INK; globals[15] = ROWS;
        globals.set(under, 16); globals[19] = 1;
        globals.set(paper, 20); globals[23] = 1;
        globals[24] = LIGHT[0]; globals[25] = LIGHT[1]; globals[26] = LIGHT[2]; globals[27] = 0;
        globals[28] = -LIGHT[0] / LIGHT[2]; globals[29] = -LIGHT[1] / LIGHT[2]; globals[30] = 0; globals[31] = 0;
        foldSpan(globals, w, h);
        device.queue.writeBuffer(uniforms, 0, globals);
        const r = resources(frame.width, frame.height, w, h);
        let group = r.groups.get(frame.sourceView);
        if (!group) {
          group = device.createBindGroup({ layout: mainLayout, entries: [
            { binding: 0, resource: { buffer: uniforms } }, { binding: 1, resource: sampler }, { binding: 2, resource: frame.sourceView },
            { binding: 3, resource: r.views.soft }, { binding: 4, resource: r.views.wide },
          ] });
          r.groups.set(frame.sourceView, group);
        }
        const curled = globals[9] > 0;
        if (curled) {
          // the lifted paper as the lamp sees it, and its soft copies; only when the fold moved
          const key = `${globals[4]},${globals[5]},${globals[6]},${globals[7]},${globals[8]},${globals[9]},${globals[10]}`;
          if (key !== r.occKey) {
            r.occKey = key;
            occAttachment.view = r.views.sharp;
            const occ = frame.encoder.beginRenderPass(occPass);
            occ.setPipeline(occPipe); occ.setBindGroup(0, occGroup);
            occ.draw(2 * (ROWS + 2));
            occ.end();
            for (const b of r.blurs) {
              occAttachment.view = b.dst;
              const pass = frame.encoder.beginRenderPass(occPass);
              pass.setPipeline(blurPipe); pass.setBindGroup(0, b.group); pass.draw(3); pass.end();
            }
            occAttachment.view = null;
          }
        }
        mainAttachment.view = r.colorView;
        mainAttachment.resolveTarget = frame.destinationView;
        depthAttachment.view = r.depthView;
        const pass = frame.encoder.beginRenderPass(mainPass);
        pass.setBindGroup(0, group);
        if (curled) {
          pass.setPipeline(underPipe); pass.draw(3);
          pass.setPipeline(leafPipe); pass.draw(2 * (ROWS + 2));
        } else {
          pass.setPipeline(passPipe); pass.draw(3);
        }
        pass.end();
        mainAttachment.view = null; mainAttachment.resolveTarget = null; depthAttachment.view = null;
      },
      // called each time a frame is PRESENTED: the uniform block of that frame is copied into one of 4 slots
      captureInputMapper() {
        mapperSlot = (mapperSlot + 1) % MAPPER_SLOTS;
        slots[mapperSlot].set(globals);
        return mappers[mapperSlot];
      },
      mountUI(root, ui) { return mountCurlUi(root, ui); },
      destroy() {
        for (const [type, fn] of documentListeners) doc.removeEventListener(type, fn, true);
        if (pointerId >= 0) { try { captureEl.releasePointerCapture(pointerId); } catch { /* gone */ } }
        stopPeekTimer();
        setCursor('');
        if (sized) for (const t of sized.textures) t.destroy?.();
        for (const b of [uniforms, ...blurSteps]) b.destroy?.();
      },
    };
  },
});

/** fold.js, re-exported for the tests */
export { foldPoint, project, unproject };
