/**
 * Page curl effect plugin (effect plugin ABI v2): an EXAMPLE of the effects extension of html-in-canvas-polyfill, not part of the polyfill.
 * Shaders: ./page-curl.wgsl, ./blur.wgsl. The shape of the fold: ./fold.js.
 *
 * The drawn page is a sheet of paper bound along one edge. Take hold of a corner (a hot zone of `hotZone` CSS px around it) and the sheet
 * folds over and rolls up under your hand: a tessellated 3D sheet, seen by a camera straight above it, lit by one lamp, casting a soft
 * shadow that widens with its height, its back plain paper with the live page's ink showing through it, and the page underneath revealed.
 * The corner follows the pointer on a spring (it has weight) and springs back on release. The live page keeps updating on the curling sheet
 * (it is sampled every frame), and its flat part stays usable. At rest one corner is a small dog-ear, and nothing is drawn until something
 * changes (no frame, no timer; the opt-in `autoPeek` opens the dog-ear now and then).
 *
 * Input: the grab is the plugin's own gesture. Its pointer events are taken in the capture phase at the document, before the host's
 * interposer and the form see them (preventDefault: no focus change, no text selection, no click), and the pointer is captured to the
 * layer. A finger that lands on a corner claims its touch (a non-passive touchstart, prevented), so the browser does not scroll the page
 * and cancel the pointer; a touch anywhere else is left to the page (it scrolls). Every other pointer goes through the host's interposer and this plugin's input mapper (`mapCurlPoint`): the identity on the flat
 * page, the exact page point on the front of the roll that faces the reader, NO_TARGET on the back of the sheet (the roll, the folded
 * flap, the dog-ear) and on the page underneath.
 *
 * Action 'peek' (`handle.trigger('peek')`): the dog-ear opens and closes once now, as a hint that the page can be turned, also after the
 * auto-peek stopped (the first drag stops it). Action 'demo': a hand takes the dog-eared corner, turns the page most of the way over and lets
 * go; the sheet springs back (DEMO_RELEASE_MS, then the release). A press on the page or a key takes over at once. Both resolve 'rest' once
 * the sheet lies still again; `handle.settled()` does the same.
 */

import { NO_TARGET, isNoTarget } from '../../src/effects/no-target.js';
import { TAPER, coneFor, constrainCorner, foldFor, foldPoint, project, springStep, SPRING_STEP, unproject } from './fold.js';
import { wgsl } from './wgsl.js';
import { stateMapper } from '../_lib/mapper.js';
import { clampNum } from '../_lib/number.js';
import { injectStyle } from '../_lib/ui.js';

/** @typedef {import('../../src/contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../../src/contracts/types.js').InputMapper} InputMapper */
/** @typedef {import('../../src/contracts/types.js').InputPoint} InputPoint */

/**
 * What the plugin gallery and the build read (plugins/README.md).
 * @experimental an example plugin of the effects, an extension of this library, not part of the HTML-in-Canvas standard (docs/STABILITY.md)
 */
export const meta = Object.freeze({
  name: 'page-curl',
  title: 'Page curl',
  description: 'Grab a corner, with a mouse or a finger, and the live page rolls up under your hand in 3D, lit and shadowed, still updating; it springs back on release.',
  defaults: Object.freeze({ corner: 'any', radius: 48, shadow: 0.85, dogEar: 36, autoPeek: 0 }),
  touch: 'Drag a corner with a finger to turn the page.',
  reducedMotion: 'With reduced motion the drag follows the hand without lag; the dog-ear stays still; release and hover lift are instant; peek and demo resolve at once.',
});

/**
 * Uniform block (page-curl.wgsl `Uniforms`), also the frozen state of a mapper: [0,1] resolution, [2,3] css size W,H, [4,5] fold n,
 * [6,7] fold axis point a, [8] roll radius R, [9] pull L (0: flat), [10] mirror (1 bound left, -1 bound right), [11] camera distance,
 * [12] shadow, [13] ready, [14] ink, [15] rows of the strip, [16..19] page underneath, [20..23] paper, [24..27] towards the lamp,
 * [28..31] shadow offset, [32..35] the page in the fold's frame (s min, s max, w min, w max), [36..39] the cone (apex wA on the axis, gs,
 * k = sine of its half angle (0: a cylinder), its cosine), [40..43] the curl's reach from the apex (r0, r1, the last polar angle) and the
 * held corner's height, [44] the held corner's leaf y (0 or H).
 */
export const UNIFORM_FLOATS = 48;
export { NO_TARGET, isNoTarget };
export const CORNERS = Object.freeze(['any', 'tl', 'tr', 'bl', 'br']);
/** the camera's distance, in page sizes */
export const DISTANCE = 2.4;
/** towards the lamp: 60 degrees up, towards the top-right corner (page-curl.wgsl to_lamp); a roll of the top-right corner shows its highlight band */
const LIGHT = (() => { const v = [0.354, -0.354, 0.866]; const l = Math.hypot(...v); return v.map((x) => x / l); })();

const MAPPER_SLOTS = 4;       // the host keeps the mappers of the last 3 presented frames, plus the one being written
const INK = 0.3;             // the front's ink seen through the paper
const HOVER_FRACTION = 0.6;   // hover lift (CSS px per axis), as a fraction of the hot zone, on top of the dog-ear
const PEEK_DELAY_MS = 1500;   // first auto-peek after the first frame
export const PEEK_MS = 1800;  // one auto-peek: the dog-ear opens and closes (sin^2)
/** The actions of `handle.trigger`: peek opens and closes the dog-ear once now; demo turns the page most of the way and lets it spring back. */
export const ACTIONS = Object.freeze(/** @type {const} */ (['peek', 'demo']));
/** the demo's hand: it takes the corner (until LIFT ms), sweeps it over the page (PULL ms), holds it, and lets go at DEMO_RELEASE_MS */
const DEMO_LIFT_MS = 240, DEMO_PULL_MS = 1500;
export const DEMO_RELEASE_MS = 2000;
/** the peek of the action at `t` ms after its first frame: 0 .. 1 .. 0 over PEEK_MS. PURE. @param {number} t */
export const peekOnce = (t) => (t >= 0 && t < PEEK_MS ? Math.sin((Math.PI * t) / PEEK_MS) ** 2 : 0);
// springs (omega rad/s, zeta): the hand pulls the corner; released, the paper springs back; the rest pose eases in
const DRAG = Object.freeze([30, 0.8]);
const RELEASE = Object.freeze([13, 0.86]);
const REST = Object.freeze([16, 1]);
/** rows of the strip across the roll (page-curl.wgsl strip_point): one every PI R / 159, under 1.5 css px for the largest roll; the strip has 3 more (the flat part, the flap) */
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

/**
 * Where the demo's hand holds corner `key` at `t` ms after its first frame (page CSS px), or null once it has let go: from the corner, along
 * an arc (smootherstep in time), most of the way to the bound edge and half way down the page. PURE.
 * @param {number} t @param {'tl'|'tr'|'bl'|'br'} key @param {number} W @param {number} H @param {number[]} [out]  written and returned
 * @returns {number[]|null}
 */
export function demoHand(t, key, W, H, out = [0, 0]) {
  if (!(t >= 0 && t < DEMO_RELEASE_MS)) return null;
  const k = Math.min(1, Math.max(0, (t - DEMO_LIFT_MS) / DEMO_PULL_MS));
  const e = k * k * k * (k * (6 * k - 15) + 10);
  const across = 0.03 + 0.83 * e, down = 0.03 + 0.4 * e + 0.12 * Math.sin(Math.PI * e);
  const [fx, fy] = CORNER_AT[key];
  out[0] = W * (fx ? 1 - across : across); out[1] = H * (fy ? 1 - down : down);
  return out;
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

const fold = { nx: 1, ny: 0, ax: 0, ay: 0, R: 0, L: 0, k: 0, ca: 1, wA: 0, gs: 1 };
const leafAt = { x: 0, y: 0 }, aimed = { x: 0, y: 0 }, corner3 = [0, 0, 0], reach = [0, 0, 0];
/** what poseState solves for (module state: a pose allocates nothing) */
const pose = { lead: /** @type {'top'|'bottom'} */ ('top'), W: 0, H: 0, cy: 0, radius: 0, taper: 0 };
const res = [0, 0];
/** the cone fold that puts the corner at the aim (x, y); writes the corner to corner3; false when it is a cylinder @param {number} x @param {number} y */
function solve(x, y) {
  const { lead, W, H, cy } = pose;
  aimed.x = x; aimed.y = y;
  foldFor(aimed, lead, W, H, rollFor(pose.radius, Math.hypot(W - x, cy - y), W), fold);
  coneFor(fold, lead, W, H, pose.taper, reach);
  corner3[0] = W; corner3[1] = cy; corner3[2] = 0;
  foldPoint(W, cy, fold, corner3);
  return fold.k > 0;
}
/** how far the corner of the aim (x, y) lands from where it is wanted (leafAt; the vector in res); Infinity on a cylinder @param {number} x @param {number} y */
function residual(x, y) {
  if (!solve(x, y)) return Infinity;
  res[0] = corner3[0] - leafAt.x; res[1] = corner3[1] - leafAt.y;
  return Math.hypot(res[0], res[1]);
}
/** The fold of a uniform block (or a mapper's state), as fold.js takes it. @param {Float32Array} st */
export const foldOf = (st) => ({ nx: st[4], ny: st[5], ax: st[6], ay: st[7], R: st[8], L: st[9], wA: st[36], gs: st[37], k: st[38], ca: st[39] });
/** Where the held corner of a uniform block lies, leaf space [x, y, z] (page x = W - x when st[10] < 0). @param {Float32Array} st */
export function heldCorner(st) {
  const out = [st[2], st[44], 0];
  if (st[9] > 0) foldPoint(st[2], st[44], foldOf(st), out);
  return out;
}
/**
 * The fold that puts corner `key` at the page point (x, y) (as near as a bound sheet allows; seen from above, the corner lies at its height
 * over that point), written into the uniform block `out` ([2..11], [36..44]). The roll is a cone (fold.js coneFor) of radius `radius` at
 * the corner, narrowing by `taper` at most; the cone moves the corner a little from where the cylinder of foldFor puts it, so the fold
 * is solved again for a corrected aim until the corner lands on (x, y) (a fixed point: the correction is nearly a translation). Returns
 * `out`. PURE apart from `out`.
 * @param {Float32Array} out @param {number} W @param {number} H @param {'tl'|'tr'|'bl'|'br'} key @param {number} x @param {number} y @param {number} radius
 * @param {number} [taper]
 */
export function poseState(out, W, H, key, x, y, radius, taper = TAPER) {
  const mirror = CORNER_AT[key][0] === 1 ? 1 : -1;   // a right-hand corner: the sheet is bound on the left edge
  const lead = CORNER_AT[key][1] === 1 ? 'bottom' : 'top';
  const cy = lead === 'bottom' ? H : 0;
  leafAt.x = mirror > 0 ? x : W - x; leafAt.y = y;
  constrainCorner(leafAt, lead, W, H, leafAt);
  pose.lead = lead; pose.W = W; pose.H = H; pose.cy = cy; pose.radius = radius; pose.taper = taper;
  // Newton on the aim, its Jacobian by finite differences, with backtracking (a plain fixed point oscillates: the cone's taper depends on
  // the fold, and near the bound edge the map bends sharply)
  let x0 = leafAt.x, y0 = leafAt.y;
  let e = residual(x0, y0);
  for (let i = 0; i < 8 && e > 1e-3 && e < Infinity; i += 1) {
    const fx = res[0], fy = res[1];
    residual(x0 + 0.25, y0); const a = (res[0] - fx) * 4, c = (res[1] - fy) * 4;
    residual(x0, y0 + 0.25); const b = (res[0] - fx) * 4, d = (res[1] - fy) * 4;
    const det = a * d - b * c;
    let sx = fx, sy = fy;
    if (Math.abs(det) > 1e-3) { sx = (d * fx - b * fy) / det; sy = (a * fy - c * fx) / det; }
    let step = 1, next = Infinity;
    for (let j = 0; j < 6; j += 1, step *= 0.5) { next = residual(x0 - sx * step, y0 - sy * step); if (next < e) break; }
    if (!(next < e)) break;
    x0 -= sx * step; y0 -= sy * step; e = next;
  }
  // a cylinder puts the corner exactly where it is aimed
  if (!solve(x0, y0)) solve(leafAt.x, leafAt.y);
  out[2] = W; out[3] = H;
  out[4] = fold.nx; out[5] = fold.ny; out[6] = fold.ax; out[7] = fold.ay; out[8] = fold.R; out[9] = fold.L < 0.5 ? 0 : fold.L;
  out[10] = mirror; out[11] = DISTANCE * Math.max(W, H);
  out[36] = fold.wA; out[37] = fold.gs; out[38] = fold.k; out[39] = fold.ca;
  out[40] = reach[0]; out[41] = reach[1]; out[42] = reach[2]; out[43] = out[9] > 0 ? corner3[2] : 0; out[44] = cy;
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
  if (st[38] > 0) return mapCone(st, point, px, py, sx, sy);
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

/**
 * mapCurlPoint on a cone: the line of sight from the camera through the presented point, intersected with the cone (a quadratic) and with
 * the plane of the flap; the nearest crossing that lies on the sheet (on the roll: 0 <= angle round the cone <= PI; on the flap: beyond
 * it; and inside the page once unrolled) is the one seen. PURE.
 * @param {Float32Array} st @param {InputPoint} point @param {number} px @param {number} py @param {number} sx @param {number} sy
 * @returns {{x: number, y: number}}
 */
function mapCone(st, point, px, py, sx, sy) {
  const W = st[2], H = st[3], ax = st[6], ay = st[7], m = st[10], D = st[11];
  const nl = Math.hypot(st[4], st[5]), nx = st[4] / nl, ny = st[5] / nl;
  // the cosine from the sine in doubles: the 32-bit pair is not exactly on the unit circle
  const wA = st[36], gs = st[37], k = st[38], ca = Math.sqrt(1 - k * k);
  const gx = -ny * gs, gy = nx * gs;
  const lx = m > 0 ? px : W - px;
  // Everything relative to O, the point of the fold line nearest the presented point, rho from the apex: X = Y + rho g. The cone
  // (X.c)^2 = ca^2 |X|^2 then reads (Y.c)^2 - ca^2 |Y|^2 + 2 rho ca k Y.z = 0: its large constant terms cancel exactly, so a far apex
  // (a nearly cylindrical roll) stays exact.
  const wO = -(lx - ax) * ny + (py - ay) * nx;
  const Ox = ax - ny * wO, Oy = ay + nx * wO, rho = gs * (wO - wA);
  // the ray, from the camera (t = 0) to the page (t = 1): Y(t) = Y0 + t d
  const Y0x = W / 2 - Ox, Y0y = H / 2 - Oy, Y0z = D;
  const dx = lx - W / 2, dy = py - H / 2, dz = -D;
  const cx = ca * gx, cy = ca * gy, cz = k;   // the cone's axis; e1 = k g - ca z points from it to the line where it touches the page
  const c2 = ca * ca, lin = 2 * rho * ca * k;
  const dc = dx * cx + dy * cy + dz * cz, Yc = Y0x * cx + Y0y * cy + Y0z * cz;
  const qa = dc * dc - c2 * (dx * dx + dy * dy + dz * dz);
  const qb = 2 * (Yc * dc - c2 * (Y0x * dx + Y0y * dy + Y0z * dz)) + lin * dz;
  const qc = Yc * Yc - c2 * (Y0x * Y0x + Y0y * Y0y + Y0z * Y0z) + lin * Y0z;
  let best = Infinity, bx = 0, by = 0, kind = 0, bb = 0;
  /** the flat point at distance r from the apex and polar angle th, kept if it lies inside the page and nearer @param {number} t @param {number} r @param {number} th @param {number} part @param {number} b */
  const consider = (t, r, th, part, b) => {
    const u = r * Math.cos(th) - rho, v = r * Math.sin(th);
    const qx = Ox + gx * u + nx * v, qy = Oy + gy * u + ny * v;
    if (t < best && qx >= 0 && qy >= 0 && qx <= W && qy <= H) { best = t; bx = qx; by = qy; kind = part; bb = b; }
  };
  const disc = qb * qb - 4 * qa * qc;
  if (disc >= 0 && Math.abs(qa) > 1e-12) {
    const sq = Math.sqrt(disc);
    for (const t of [(-qb - sq) / (2 * qa), (-qb + sq) / (2 * qa)]) {
      // a hair beyond the page (t > 1): the roll where it leaves the page along the fold line, through 32-bit rounding of the fold
      if (!(t > 0 && t < 1 + 1e-4)) continue;
      const Yx = Y0x + t * dx, Yy = Y0y + t * dy, Yz = Y0z + t * dz;
      const along = Yx * cx + Yy * cy + Yz * cz;
      if (along + rho * ca <= 0) continue;   // the other nappe
      // X off the axis: Y - (Y.c) c + rho k e1; the angle round the cone from e1 towards n
      const b = Math.atan2(Yx * nx + Yy * ny, k * (Yx * gx + Yy * gy) - ca * Yz + rho * k);
      if (b < 0 || b > Math.PI) continue;
      consider(t, Math.hypot(Yx + rho * gx, Yy + rho * gy, Yz), b * k, 1, b);
    }
  }
  // the flap: the plane through the apex that touches the cone along its top line G = (1 - 2k^2) g + 2 k ca z; its normal (2 k ca g, k^2 - ca^2)
  const Nx = 2 * k * ca * gx, Ny = 2 * k * ca * gy, Nz = k * k - c2;
  const dn = dx * Nx + dy * Ny + dz * Nz;
  if (Math.abs(dn) > 1e-12) {
    const t = -(Y0x * Nx + Y0y * Ny + Y0z * Nz + rho * 2 * k * ca) / dn;
    if (t > 0 && t < 1 + 1e-9) {
      const Yx = Y0x + t * dx, Yy = Y0y + t * dy, Yz = Y0z + t * dz;
      const r1 = (Yx * gx + Yy * gy + rho) * (1 - 2 * k * k) + Yz * 2 * k * ca, r2 = -(Yx * nx + Yy * ny);
      const tp = Math.atan2(r2, r1);
      if (r1 > 0 && tp >= 0) consider(t, Math.hypot(r1, r2), tp + Math.PI * k, 2, Math.PI);
    }
  }
  if (kind === 2) return NO_TARGET;   // the back of the folded flap
  if (kind === 1) {
    // which side of the roll faces the reader: its up side's normal against the line of sight (back towards the camera: -d)
    const ag = k * ca * (1 - Math.cos(bb)), an = -ca * Math.sin(bb);
    const facing = -((nx * an + gx * ag) * dx + (ny * an + gy * ag) * dy + (k * k + c2 * Math.cos(bb)) * dz);
    if (facing < 0) return NO_TARGET;
    return { x: (m > 0 ? bx : W - bx) / sx, y: by / sy };
  }
  // the flat part of the sheet is the page; beyond the fold lies the page underneath
  return (lx - ax) * nx + (py - ay) * ny <= 0 ? { x: point.x, y: point.y } : NO_TARGET;
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
// (each colour is light-dark(on a light page, on a dark page): the controls follow the page's color-scheme)
const UI_CSS = `
    .hic-curl-ui { display:grid; grid-template-columns:auto 1fr auto; gap:4px 10px; align-items:center; color:light-dark(rgba(16,32,46,.8), rgba(224,247,255,.72)); font-size:11px; font-weight:700; }
    .hic-curl-ui p { grid-column:1 / -1; margin:0 0 2px; font-size:13px; font-weight:800; color:light-dark(#006b80, #9cf5ff); }
    .hic-curl-ui output { color:light-dark(#006b80, #9cf5ff); text-align:right; font-variant-numeric:tabular-nums; min-width:4ch; }
    .hic-curl-ui input[type=range] { width:100%; height:24px; margin:0; accent-color:light-dark(#007a94, #79efff); cursor:ew-resize; }
    .hic-curl-ui select { font:inherit; color:light-dark(#10202e, #effcff); background:light-dark(rgba(255,255,255,.75), rgba(1,10,23,.55)); border:1px solid light-dark(rgba(16,32,46,.25), rgba(173,226,255,.18)); border-radius:8px; padding:3px 6px; }
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
const DEMO = 3;

/**
 * The plugin's definition (effect plugin ABI v2).
 * @experimental an example plugin of the effects, an extension of this library, not part of the HTML-in-Canvas standard (docs/STABILITY.md)
 * @type {EffectPluginDefinition}
 */
export const plugin = Object.freeze({
  type: 'page-curl',
  apiVersion: /** @type {const} */ (2),
  version: 3,
  actions: ACTIONS,
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
    let autoPeek = 0;   // opt-in, as meta.defaults: a periodic peek is work at rest
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
    /** the peek of the action: -1 none, -2 asked for (it starts at the next frame), else its first frame's time */
    let peekFrom = -1;
    let demoFrom = -1;                     // the demo's first frame (-1: at the next frame)
    /** @type {((state: string|null) => void)[]} */ const waiters = [];
    /** @type {Element|null} */ let surface = null;
    let cursor = '';
    /** @type {Element} */ let captureEl = canvas;

    const size = () => (pageWidth > 0 ? [pageWidth, pageHeight] : [canvas.clientWidth, canvas.clientHeight]);
    /** @param {{clientX: number, clientY: number}} e @returns {[number, number]} */
    function toPage(e) {
      const r = canvas.getBoundingClientRect();
      const [w, h] = size();
      // through the plugins added after this one: the corner is grabbed where the user sees it (where one of them shows none of the page, the point on the canvas)
      // (localPoint takes and gives points of the content box; the page is measured over the border box)
      const bx = canvas.clientLeft || 0, by = canvas.clientTop || 0;
      const cx = e.clientX - r.left - bx, cy = e.clientY - r.top - by;
      const seen = Number.isFinite(cx) && Number.isFinite(cy) ? context.localPoint?.({ x: cx, y: cy }) : null;
      const x = (seen ? seen.x : cx) + bx, y = (seen ? seen.y : cy) + by;
      return [x * (r.width > 0 ? w / r.width : 1), y * (r.height > 0 ? h / r.height : 1)];
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

    /** a press on the page or a key takes over from the demo at once: the hand lets go */
    function endDemo() { if (phase === DEMO) { phase = RELEASING; demoFrom = -1; wake(); } }
    /** @param {PointerEvent} e */
    function onDown(e) {
      swallowClick = false;
      if (phase === DRAGGING || !e.isPrimary || !onPage(e)) return;
      endDemo();
      if (e.button !== 0) return;
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
    const onKey = (/** @type {Event} */ e) => { if (onPage(e)) endDemo(); };
    /**
     * A finger that lands on a corner (or holds one: the pointerdown came first) claims its touch: prevented, the browser neither scrolls
     * nor cancels the pointer. Any other touch stays the page's. @param {Event} event
     */
    function onTouchStart(event) {
      const e = /** @type {TouchEvent} */ (event);
      const t = e.touches?.[0];
      if (!t) return;
      const [x, y] = toPage(t);
      const [w, h] = size();
      if (phase === DRAGGING || (e.touches.length === 1 && hotCorner(x, y, w, h, corner, hotZone))) e.preventDefault();
    }
    const onLeave = () => { if (phase === IDLE) hoverTo(null); };
    const onLayerMove = (/** @type {Event} */ e) => {
      const t = /** @type {Element|null} */ (e.currentTarget);
      if (t && t !== canvas && t !== surface) { const c = cursor; setCursor(''); surface = t; setCursor(c || (hover ? 'grab' : '')); }
      else if (hover && !cursor) setCursor('grab');
    };
    /** @type {[string, (e: any) => void][]} */
    const documentListeners = [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onUp], ['click', onClick], ['keydown', onKey]];
    for (const [type, fn] of documentListeners) doc.addEventListener(type, fn, true);
    context.listen('touchstart', onTouchStart, { passive: false });
    context.listen('pointerleave', onLeave);
    context.listen('pointermove', onLayerMove);
    context.listen('pointerover', onLayerMove);

    const hand = [0, 0], aim = { x: 0, y: 0 };
    /** the pointer shows where the corner should appear; the corner lies above the page (2R on a cylinder), so aim at the point under it (writes `aim`) */
    const aimAt = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ w, /** @type {number} */ h) =>
      unproject(Math.min(w, Math.max(0, x)), Math.min(h, Math.max(0, y)), globals[43], w, h, DISTANCE * Math.max(w, h), aim);
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
      if (phase === DEMO) {
        if (demoFrom < 0) demoFrom = now;
        if (demoHand(now - demoFrom, active, w, h, hand)) [dragX, dragY] = hand; else { phase = RELEASING; demoFrom = -1; }
      }
      const held = phase === DRAGGING || phase === DEMO;
      if (held) {
        aimAt(dragX, dragY, w, h);
        gx = aim.x; gy = aim.y; spring = DRAG;
      } else {
        const hint = hintCorner(corner);
        const want = phase === RELEASING ? active : hover ?? hint;
        if (peekFrom === -2) peekFrom = now;
        if (peekFrom >= 0 && now - peekFrom >= PEEK_MS) peekFrom = -1;
        const manual = peekFrom >= 0 ? peekOnce(now - peekFrom) : 0;
        const peek = phase === IDLE && !hover ? Math.max(peeking() ? peekAt(now - born, autoPeek) : 0, manual) : 0;
        moving = peek > 0 || peekFrom >= 0;
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
      for (let i = 0; i < steps; i += 1) {
        // the demo's hand moves between frames too: the pose at a time is the same at any frame rate
        if (phase === DEMO && demoHand(simT + (i + 1) * SPRING_STEP * 1000 - demoFrom, active, w, h, hand)) { aimAt(hand[0], hand[1], w, h); gx = aim.x; gy = aim.y; }
        springStep(sx, gx, spring[0], spring[1]); springStep(sy, gy, spring[0], spring[1]);
      }
      simT += steps * SPRING_STEP * 1000;
      // the corner stays on the page (a spring overshooting past its own corner would fold the sheet the wrong way)
      sx.x = Math.min(w, Math.max(0, sx.x)); sy.x = Math.min(h, Math.max(0, sy.x));
      const settled = Math.abs(sx.x - gx) < 0.05 && Math.abs(sy.x - gy) < 0.05 && Math.abs(sx.v) < 0.5 && Math.abs(sy.v) < 0.5;
      if (settled && !held) {
        sx.x = gx; sy.x = gy; sx.v = 0; sy.v = 0;
        if (phase === RELEASING) phase = IDLE;
      }
      resting = settled && !moving && !held;
      return phase === DRAGGING ? !settled : phase === DEMO || !resting;
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

    /** nothing moves: the last frame rested and no peek is asked for or playing */
    const still = () => resting && phase === IDLE && peekFrom === -1;
    const wait = () => (still() ? 'rest' : new Promise((resolve) => { waiters.push(resolve); }));

    return {
      spatial: true,   // not `continuous`: frames are requested while something moves (drag, release, hover lift, a peek, the demo), none at rest
      setOptions(next) { applyOptions(next); wake(); },
      runAction(action, _options, info) {
        // nothing moves with reduced motion or while a corner is held or springs back (or the demo plays): the state it rests in next
        if (!reducedMotion && !info.reducedMotion && phase === IDLE) {
          stopPeekTimer();
          if (action === 'demo') {
            // the hand takes the dog-eared corner where it lies now
            const hint = hintCorner(corner);
            if (active !== hint) { active = hint; [sx.x, sy.x] = liftedTo(hint, dogEar, pageWidth || canvas.clientWidth, pageHeight || canvas.clientHeight); sx.v = 0; sy.v = 0; }
            peekFrom = -1; hover = null; demoFrom = -1; phase = DEMO;
          } else peekFrom = -2;
          wake();
        }
        return wait();
      },
      settled: wait,
      render(frame) {
        const w = frame.cssWidth, h = frame.cssHeight;
        pageWidth = w; pageHeight = h;
        const moving = step(frame.now, w, h);
        if (moving) { stopPeekTimer(); context.requestRender(); } else schedulePeek(frame.now);
        if (waiters.length && still()) for (const resolve of waiters.splice(0)) resolve('rest');
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
            occ.draw(2 * (ROWS + 3));
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
          pass.setPipeline(leafPipe); pass.draw(2 * (ROWS + 3));
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
        for (const resolve of waiters.splice(0)) resolve(null);
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
