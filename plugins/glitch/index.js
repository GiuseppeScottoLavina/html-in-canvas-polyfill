/**
 * Glitch effect plugin (effect plugin ABI v2): an EXAMPLE of the effects extension of html-in-canvas-polyfill, not part of the polyfill.
 * Shader: ./glitch.wgsl.
 *
 * A controlled digital glitch: a spectral RGB split, block displacement, scanline tearing, a VHS tracking band, pixel-sorting streaks,
 * corrupted macroblocks, grain and scanlines.
 *   mode 'ambient'  a still, damaged signal (a fine colour fringe, scanlines, a frozen grain) and every ~1.4 s a short glitch event
 *                   (slices, a tracking band or a chroma jolt) that keeps off the focused field and holds off while the user types
 *   mode 'burst'    nothing until triggered
 * Either mode plays a burst (~0.5 s, the pattern changes every 45 ms): the action 'burst' (`handle.trigger('burst')`, resolves 'idle'
 * when the burst has ended; also the Burst button of mountUI), and on its own when an element of the drawn page starts to match `watch`
 * (by default a validation error: [aria-invalid="true"], .invalid, [data-state="error"]) or an `invalid` event fires in the page. The action
 * 'demo' plays a scripted sequence of bursts (about 3 s) and resolves 'idle'.
 *
 * Frames are requested only while something plays (a burst, the demo, an ambient event: every frame within the frame cap); between
 * them the picture is still, the plugin sets one timer for the next event, and the host renders nothing.
 *
 * Input mapper (`mapGlitchPoint`): the block table is the only layer that moves the page. Outside the displaced blocks the mapper is the
 * identity; inside a block it is the exact inverse of that block's offset (wrapped around the page, like the shader), so a click on a
 * displaced field reaches that field, also during a burst. The colour layers (split, sort streaks, macroblocks, grain, scanlines) do not
 * move the page: input goes to the element under them. All randomness is a hash of (seed, burst, pattern, index), so a frame is
 * reproducible.
 */

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
  name: 'glitch',
  title: 'Glitch',
  description: 'RGB split, block shifts, tracking tears, pixel sorting and broken macroblocks; bursts on a validation error. Clicks follow the shifted blocks.',
  defaults: Object.freeze({ mode: 'ambient', intensity: 0.35 }),
  reducedMotion: 'With reduced motion no block moves and there is no ambient glitch; a burst or the demo is one steady colour-split frame.',
  continuous: 'In ambient mode a short glitch event plays about every 1.4 s and renders only while it lasts; burst mode and reduced motion render nothing at rest.',
});

export const MAX_BLOCKS = 32;
/** floats before the block table: resolution(2) css(2) time split grain scan count ready flash block_split */
export const HEADER_FLOATS = 12;
export const UNIFORM_FLOATS = HEADER_FLOATS + MAX_BLOCKS * 8;
export const BURST_MS = 520;
export const PATTERN_MS = 45;
/** the grain changes this many times a second (only while a burst or an ambient event plays) */
export const GRAIN_HZ = 24;
export const AMBIENT_CYCLE_MS = 1400;
/** an ambient event does not start within this time after a key press or an input in the page */
export const TYPING_HOLD_MS = 1200;
/** RGB split of the ambient look at intensity 1, CSS px */
export const AMBIENT_SPLIT = 4;
export const DEFAULT_WATCH = '[aria-invalid="true"], .invalid, [data-state="error"]';
export const MODES = Object.freeze(['ambient', 'burst']);
/** The actions of `handle.trigger`: burst plays one burst now (bursts closer than 250 ms are one); demo plays the scripted sequence. */
export const ACTIONS = Object.freeze(/** @type {const} */ (['burst', 'demo']));
/** What a block of the table is (its third float). Below 0.5 the block moves the page (the mapper follows it); from 0.5 on it only recolours. */
export const KIND = Object.freeze({ SHIFT: 0, BAND: 0.25, SORT: 1, MACRO: 2 });
/** Which layers fillBlocks writes (a bit mask). */
export const STYLE = Object.freeze({ SHIFT: 1, SORT: 2, MACRO: 4, BAND: 8 });
/** one burst: [start ms, length ms, strength] */
export const BURST_SCRIPT = Object.freeze([Object.freeze([0, BURST_MS, 1])]);
/** the action 'demo': a micro-glitch, a burst, a stutter of two short hits, and the strongest burst; then calm */
export const DEMO_SCRIPT = Object.freeze([[0, 160, 0.5], [430, 130, 0.7], [820, BURST_MS, 1], [1650, 90, 0.6], [1840, 110, 0.85], [2150, 820, 1.15]].map((s) => Object.freeze(s)));

const MAPPER_SLOTS = 4;
const TRIGGER_DEBOUNCE_MS = 250;
const CLEAR = Object.freeze({ r: 0, g: 0, b: 0, a: 1 });

let uiSerial = 0;

/** A 32-bit integer hash of (a, b) mapped to [0, 1). PURE. @param {number} a @param {number} b */
export function hash01(a, b) {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(((b | 0) + 0x632be59b) | 0, 0xc2b2ae35);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// the random stream of one fillBlocks call (module scope, used synchronously: no closure is allocated per frame)
let streamKey = 0;
let streamIndex = 0;
const rnd = () => hash01(streamKey, streamIndex++);

/**
 * Appends one block unless the table is full or the block meets `keep` (the keep-out rectangle). Returns the new count.
 * @param {Float32Array} out @param {number} n  block index
 * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1  the rectangle, CSS px
 * @param {number} dx @param {number} dy  offset of the page inside it @param {number} kind  KIND @param {number} extra  split / sort length / macroblock size
 * @param {ArrayLike<number>|null} keep
 */
function writeBlock(out, n, x0, y0, x1, y1, dx, dy, kind, extra, keep) {
  if (n >= MAX_BLOCKS) return n;
  if (keep && x0 < keep[2] && x1 > keep[0] && y0 < keep[3] && y1 > keep[1]) return n;
  const b = HEADER_FLOATS + n * 8;
  out[b] = x0; out[b + 1] = y0; out[b + 2] = x1; out[b + 3] = y1;
  out[b + 4] = dx; out[b + 5] = dy; out[b + 6] = kind; out[b + 7] = extra;
  return n + 1;
}

/**
 * Writes the block table of one glitch pattern into `out` (from HEADER_FLOATS on) and returns the number of blocks. Every coordinate and
 * offset is a whole CSS pixel, so the shader samples texel centres and the mapper is exact. Order: sort streaks, macroblocks, shift blocks,
 * tears, the tracking band (they are drawn in this order, so a later block covers an earlier one, in the shader and in the mapper). A block
 * that meets `keep` (x0, y0, x1, y1, CSS px: the focused field) is left out. PURE apart from `out`.
 * @param {Float32Array} out
 * @param {number} width  CSS px of the page
 * @param {number} height
 * @param {number} level  0..1 strength (a little more in the demo's last burst)
 * @param {number} key  seed of the pattern (seed, burst serial)
 * @param {number} pattern  index of the pattern in its burst / event
 * @param {number} style  STYLE bits
 * @param {ArrayLike<number>|null} [keep]
 */
export function fillBlocks(out, width, height, level, key, pattern, style, keep = null) {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  if (!(level > 0)) return 0;
  const L = Math.min(1.2, level);
  streamKey = (Math.imul(key | 0, 7919) + (pattern | 0)) | 0;
  streamIndex = 0;
  let n = 0;
  if (style & STYLE.SORT && L >= 0.5) {
    const sorts = Math.round(1 + 2 * Math.min(1, L));
    for (let i = 0; i < sorts; i += 1) {
      const bw = Math.min(w, Math.round(6 + 34 * rnd()));
      const bh = Math.min(h, Math.round(30 + 110 * rnd()));
      const x0 = Math.round(rnd() * (w - bw));
      const y0 = Math.round(rnd() * (h - bh));
      n = writeBlock(out, n, x0, y0, x0 + bw, y0 + bh, 0, 0, KIND.SORT, Math.round(20 + 60 * rnd()), keep);
    }
  }
  if (style & STYLE.MACRO && L >= 0.6) {
    const macros = rnd() < L - 0.3 ? 2 : 1;
    for (let i = 0; i < macros; i += 1) {
      const size = rnd() < 0.5 ? 8 : 16;
      const bw = Math.min(w, Math.max(size, Math.round((w * (0.08 + 0.24 * rnd())) / size) * size));
      const bh = Math.min(h, Math.max(size, Math.round((h * (0.05 + 0.14 * rnd())) / size) * size));
      const x0 = Math.floor((rnd() * (w - bw)) / size) * size;
      const y0 = Math.floor((rnd() * (h - bh)) / size) * size;
      n = writeBlock(out, n, x0, y0, x0 + bw, y0 + bh, 0, 0, KIND.MACRO, size, keep);
    }
  }
  if (style & STYLE.SHIFT) {
    const blocks = Math.round(2 + 6 * Math.min(1, L));
    for (let i = 0; i < blocks; i += 1) {
      const bw = Math.min(w, Math.round(w * (0.08 + 0.37 * rnd())));
      const bh = Math.min(h, Math.round((4 + 44 * rnd()) * (0.5 + L)));
      const x0 = Math.round(rnd() * (w - bw));
      const y0 = Math.round(rnd() * (h - bh));
      const dx = Math.round((rnd() * 2 - 1) * 60 * L);
      const dy = rnd() < 0.3 ? Math.round((rnd() * 2 - 1) * 10 * L) : 0;
      n = writeBlock(out, n, x0, y0, x0 + bw, y0 + bh, dx, dy, KIND.SHIFT, Math.round(2 + 6 * L * rnd()), keep);
    }
    const tears = Math.round(1 + 3 * Math.min(1, L));
    for (let i = 0; i < tears; i += 1) {
      const bh = Math.min(h, Math.round(2 + 8 * rnd()));
      const y0 = Math.round(rnd() * (h - bh));
      n = writeBlock(out, n, 0, y0, w, y0 + bh, Math.round((rnd() * 2 - 1) * 120 * L), 0, KIND.SHIFT, 0, keep);
    }
  }
  if (style & STYLE.BAND) {
    // a VHS tracking band: a stack of thin full-width slices, each jittered sideways, washed out (the shader adds dropout lines in a burst)
    const bandH = Math.min(h, Math.round(16 + 34 * rnd()));
    let y = Math.round(rnd() * (h - bandH));
    const end = y + bandH;
    const drift = (rnd() * 2 - 1) * 10 * L;
    while (y < end && n < MAX_BLOCKS) {
      const sh = Math.min(end - y, Math.round(2 + 4 * rnd()));
      n = writeBlock(out, n, 0, y, w, y + sh, Math.round(drift + (rnd() * 2 - 1) * (4 + 16 * L)), 0, KIND.BAND, Math.round(1 + 3 * L), keep);
      y += sh;
    }
  }
  return n;
}

/**
 * The state of one frame, read by fillGlitchFrame. The plugin keeps ONE of these and rewrites it every frame.
 * @typedef {Object} GlitchFrameParams
 * @property {number} width  backing px
 * @property {number} height
 * @property {number} cssWidth
 * @property {number} cssHeight
 * @property {number} now  ms, frame clock
 * @property {boolean} ready
 * @property {string} mode
 * @property {number} intensity
 * @property {number} seed
 * @property {number} burstAt  frame clock of the burst's first frame, -1 for none
 * @property {number} burstSerial
 * @property {ReadonlyArray<ReadonlyArray<number>>} [script]  the steps of the running burst (BURST_SCRIPT by default, DEMO_SCRIPT)
 * @property {number} [quietUntil]  frame clock before which no ambient event starts (the user types)
 * @property {ArrayLike<number>|null} [keepOut]  x0, y0, x1, y1 CSS px: no ambient block meets it (the focused field)
 * @property {boolean} reduced  prefers-reduced-motion
 * @property {boolean} split
 * @property {boolean} sort
 * @property {boolean} noise
 */

/** the end of the last step of a script, ms @param {ReadonlyArray<ReadonlyArray<number>>} script */
export const scriptLength = (script) => script.reduce((end, s) => Math.max(end, s[0] + s[1]), 0);

/**
 * The ambient event of a cycle: when it starts (frame clock), how long it lasts and its style draw (0..1). PURE.
 * @param {number} seed @param {number} cycle
 */
export function ambientEvent(seed, cycle) {
  return {
    start: cycle * AMBIENT_CYCLE_MS + hash01(seed, cycle) * (AMBIENT_CYCLE_MS - 260),
    length: 90 + 130 * hash01(seed + 1, cycle),
    draw: hash01(seed + 2, cycle),
  };
}


/**
 * Writes the uniform block of one frame. Everything is a function of the frame clock and the parameters, so the same instant gives the
 * same picture (and mapper) at every frame cap. Returns when the plugin needs its next frame, in ms: 0 while a burst, the demo or an
 * ambient event plays (every frame), the time until the next ambient event while nothing plays (the picture is still until then), the
 * end of a steady reduced-motion burst, Infinity when nothing is scheduled (burst mode at rest, reduced motion at rest). PURE apart from `out`.
 * @param {Float32Array} out
 * @param {GlitchFrameParams} f
 * @returns {number}
 */
export function fillGlitchFrame(out, f) {
  const ambient = f.mode !== 'burst';
  const k = f.intensity;
  out[0] = f.width; out[1] = f.height; out[2] = f.cssWidth; out[3] = f.cssHeight;
  const grainMs = 1000 / GRAIN_HZ;
  let split = f.split && ambient ? AMBIENT_SPLIT * k : 0;
  let grain = f.noise && ambient ? 0.25 * k : 0;
  let scan = f.noise && ambient ? 0.4 * k : 0;
  let flash = 0;
  let count = 0;
  let next = Infinity;
  let animated = false;   // the grain steps with the clock (it is frozen between events)
  const script = f.script ?? BURST_SCRIPT;
  const total = scriptLength(script);
  const e = f.burstAt >= 0 ? f.now - f.burstAt : Infinity;
  if (e >= 0 && e < total) {
    if (f.reduced) {
      // no motion: one steady frame of split colour for the length of the burst, nothing moves; the next change is its end
      split += f.split ? 6 : 0;
      flash = 0.3;
      next = total - e;
    } else {
      let step = null;
      for (const s of script) if (e >= s[0] && e < s[0] + s[1]) { step = s; break; }
      next = 0;   // a script plays on the frame clock, every frame (its gaps are short), so it keeps its timing at any frame cap
      if (step) {
        const local = e - step[0];
        const pattern = Math.floor(local / PATTERN_MS);
        // the envelope is read at the start of the pattern: the picture is constant for the whole pattern
        const at = pattern * PATTERN_MS;
        const envelope = at < 0.6 * step[1] ? 1 : Math.max(0, 1 - (at - 0.6 * step[1]) / (0.4 * step[1]));
        const level = Math.min(1, 0.45 + 0.75 * k) * step[2] * envelope;
        animated = true;
        if (pattern % 5 !== 3) {   // every fifth pattern is clean: the burst flickers
          const band = hash01(f.seed * 13 + f.burstSerial, pattern + 977 * Math.round(step[0])) < 0.4 ? STYLE.BAND : 0;
          const style = STYLE.SHIFT | STYLE.MACRO | band | (f.sort ? STYLE.SORT : 0);
          count = fillBlocks(out, f.cssWidth, f.cssHeight, level, f.seed * 101 + f.burstSerial + Math.round(step[0]), pattern, style);
          split += f.split ? 4 * level : 0;
          if (f.noise) { grain = Math.max(grain, 0.6 * level); scan = Math.max(scan, 0.25 * level); }
          flash = pattern === 0 ? 0.3 : 0.12 * level * (pattern % 2);
        }
      }
    }
  } else if (ambient && !f.reduced && k > 0) {
    const cycle = Math.floor(f.now / AMBIENT_CYCLE_MS);
    const ev = ambientEvent(f.seed, cycle);
    const quiet = f.quietUntil ?? -Infinity;
    if (f.now >= ev.start && f.now < ev.start + ev.length && ev.start >= quiet) {
      const local = f.now - ev.start;
      const pattern = Math.floor(local / 50);
      const level = 0.3 + 0.7 * k;
      animated = true;
      if (ev.draw < 0.45) count = fillBlocks(out, f.cssWidth, f.cssHeight, 0.8 * level, f.seed * 31 + cycle, pattern, STYLE.SHIFT, f.keepOut);
      else if (ev.draw < 0.8) count = fillBlocks(out, f.cssWidth, f.cssHeight, level, f.seed * 31 + cycle, pattern, STYLE.BAND, f.keepOut);
      else {
        // a chroma jolt: the whole picture splits and the scanlines flare, nothing moves
        split += f.split ? (2 + 4 * level) * (pattern % 2 ? 0.6 : 1) : 0;
        if (f.noise) scan = Math.max(scan, 0.3 + 0.3 * level);
      }
      next = 0;
    } else {
      // the next event that can play (one that would start while the user types is skipped)
      let c = f.now < ev.start ? cycle : cycle + 1;
      let start = ambientEvent(f.seed, c).start;
      for (let i = 0; i < 8 && start < quiet; i += 1) start = ambientEvent(f.seed, ++c).start;
      next = start - f.now;
    }
  }
  if (e < 0) next = Math.min(next, -e);   // a burst set to start later (the plugin starts them on the current frame)
  // the grain steps GRAIN_HZ times a second while something plays; between events it stays where it was (a still picture)
  out[4] = f.reduced ? 0 : (animated ? Math.floor(f.now / grainMs) : Math.floor(f.seed)) / GRAIN_HZ;
  out[5] = split; out[6] = grain; out[7] = scan; out[8] = count; out[9] = f.ready ? 1 : 0; out[10] = flash; out[11] = f.split ? 1 : 0;
  out.fill(0, HEADER_FLOATS + count * 8);   // no stale blocks: the block of a frame depends on its instant only
  return Math.max(0, next);
}

/**
 * The input mapper formula, the twin of glitch.wgsl (an instanced draw: the page, then each block on top of the previous ones): the
 * presented point shows the page at the returned point. Identity outside the displaced blocks; inside, the offset of the last block that
 * covers the point, undone (wrapped around the page). Colour blocks (sort streaks, macroblocks) do not move. PURE.
 * @param {Float32Array} state  the uniform block of the presented frame
 * @param {InputPoint} point  canvas CSS px, plus the presented size
 * @returns {{x: number, y: number}}
 */
export function mapGlitchPoint(state, point) {
  const width = state[2];
  const height = state[3];
  const n = Math.min(MAX_BLOCKS, state[8] | 0);
  const px = point.x * (width / Math.max(1, point.width));
  const py = point.y * (height / Math.max(1, point.height));
  let top = -1;   // the last block drawn over this point, as the instanced draw layers them
  for (let i = 0; i < n; i += 1) {
    const b = HEADER_FLOATS + i * 8;
    if (px >= state[b] && py >= state[b + 1] && px < state[b + 2] && py < state[b + 3]) top = b;
  }
  if (top < 0 || state[top + 6] >= 0.5) return { x: point.x, y: point.y };   // the page, or a colour block (it does not move)
  const qx = px - state[top + 4];
  const qy = py - state[top + 5];
  const sx = qx - Math.floor(qx / width) * width;
  const sy = qy - Math.floor(qy / height) * height;
  return { x: sx * (point.width / width), y: sy * (point.height / height) };
}


/** CSS of the plugin UI (mountUI) */
const UI_CSS = `
    .hic-glitch-ui { display:grid; grid-template-columns:auto 1fr auto; gap:4px 10px; align-items:center; color:rgba(224,247,255,.72); font-size:11px; font-weight:700; }
    .hic-glitch-ui output { color:#9cf5ff; text-align:right; font-variant-numeric:tabular-nums; min-width:4ch; }
    .hic-glitch-ui input[type=range] { width:100%; height:24px; margin:0; accent-color:#ff5c8a; cursor:ew-resize; }
    .hic-glitch-ui select, .hic-glitch-ui button { font:inherit; color:#effcff; background:rgba(1,10,23,.55); border:1px solid rgba(173,226,255,.18); border-radius:8px; padding:3px 8px; }
    .hic-glitch-ui button { cursor:pointer; }
  `;

/**
 * The plugin's controls: mode, intensity, and a button that plays a burst (the action 'burst', through the host).
 * @param {Element} root
 * @param {{getOptions: () => Readonly<Record<string, unknown>>, setOptions: (patch: Record<string, unknown>) => void, trigger: (action: string) => Promise<unknown>}} ui
 */
function mountGlitchUi(root, ui) {
  const doc = root.ownerDocument;
  injectStyle(doc, 'glitch', UI_CSS);
  const n = ++uiSerial;
  const o = ui.getOptions();
  const box = doc.createElement('div');
  box.className = 'hic-glitch-ui';
  box.innerHTML = `<label for="hic-glitch-mode-${n}">Mode</label><select id="hic-glitch-mode-${n}">${MODES.map((m) => `<option value="${m}">${m}</option>`).join('')}</select>`
    + `<button type="button">Burst</button>`
    + `<label for="hic-glitch-intensity-${n}">Intensity</label><input id="hic-glitch-intensity-${n}" type="range" min="0" max="100" step="1"><output></output>`;
  const select = /** @type {HTMLSelectElement} */ (box.querySelector('select'));
  const button = /** @type {HTMLButtonElement} */ (box.querySelector('button'));
  const range = /** @type {HTMLInputElement} */ (box.querySelector('input'));
  const output = /** @type {HTMLOutputElement} */ (box.querySelector('output'));
  select.value = MODES.includes(String(o.mode)) ? String(o.mode) : 'ambient';
  range.value = String(Math.round(clampNum(o.intensity, 0, 1, 0.35) * 100));
  output.textContent = `${range.value}%`;
  const onMode = () => ui.setOptions({ mode: select.value });
  const onRange = () => { output.textContent = `${range.value}%`; ui.setOptions({ intensity: Number(range.value) / 100 }); };
  const burst = () => { ui.trigger('burst'); };
  select.addEventListener('change', onMode);
  range.addEventListener('input', onRange);
  button.addEventListener('click', burst);
  root.append(box);
  return () => {
    select.removeEventListener('change', onMode);
    range.removeEventListener('input', onRange);
    button.removeEventListener('click', burst);
    box.remove();
  };
}

/** @param {any} device @param {string} code @param {string} format */
async function createPipeline(device, code, format) {
  const module = device.createShaderModule({ code, label: 'hic-glitch' });
  // a WGSL error would otherwise only show as a blank frame: fail create() with the compiler's message instead
  const info = await module.getCompilationInfo?.();
  const error = info?.messages?.find((/** @type {any} */ m) => m.type === 'error');
  if (error) throw new Error(`glitch.wgsl:${error.lineNum}: ${error.message}`);
  return device.createRenderPipeline({
    label: 'hic-glitch', layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
}

/**
 * The plugin's definition (effect plugin ABI v2).
 * @experimental an example plugin of the effects, an extension of this library, not part of the HTML-in-Canvas standard (docs/STABILITY.md)
 * @type {EffectPluginDefinition}
 */
export const plugin = Object.freeze({
  type: 'glitch',
  apiVersion: /** @type {const} */ (2),
  version: 3,
  actions: ACTIONS,
  // the pass only writes its destination as a same-format colour attachment (it never samples or reads it)
  outputCapabilities: Object.freeze({ directCanvasRenderAttachment: /** @type {const} */ (true) }),
  async create(context, initialOptions) {
    const { device, format, canvas, source } = context;
    const pipeline = await createPipeline(device, await wgsl('glitch.wgsl'), format);
    const usage = /** @type {any} */ (globalThis).GPUBufferUsage;
    const uniforms = device.createBuffer({ label: 'hic-glitch', size: UNIFORM_FLOATS * 4, usage: usage.UNIFORM | usage.COPY_DST });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const bindGroups = new WeakMap();   // one per source view: the host may replace the source texture on resize
    const globals = new Float32Array(UNIFORM_FLOATS);
    const mapperStates = Array.from({ length: MAPPER_SLOTS }, () => new Float32Array(UNIFORM_FLOATS));
    const mappers = mapperStates.map((s) => stateMapper(s, mapGlitchPoint));
    let mapperSlot = 0;
    // reused every frame: no allocation on the render path
    const attachment = { view: /** @type {any} */ (null), loadOp: 'clear', storeOp: 'store', clearValue: CLEAR };
    const passDescriptor = { colorAttachments: [attachment] };
    const win = /** @type {any} */ (canvas.ownerDocument.defaultView);
    /** @type {GlitchFrameParams} */
    const params = {
      width: 0, height: 0, cssWidth: 0, cssHeight: 0, now: 0, ready: false, mode: 'ambient', intensity: 0.35, seed: 1,
      burstAt: -1, burstSerial: 0, script: BURST_SCRIPT, quietUntil: -Infinity, keepOut: null, reduced: !!win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches, split: true, sort: true, noise: true,
    };
    let watch = DEFAULT_WATCH;
    let burstPending = false;
    /** @type {ReadonlyArray<ReadonlyArray<number>>} */ let pendingScript = BURST_SCRIPT;
    /** a burst was asked for and has not ended (it ends at the first frame after the end of its script) */
    let bursting = false;
    let lastTrigger = -Infinity;
    let wakeTimer = /** @type {any} */ (0);
    let wakeAt = Infinity;
    /** the pending action's resolve (a newer action resolves it with null) */
    /** @type {((state: string|null) => void)|null} */ let actionDone = null;
    /** @type {((state: string|null) => void)[]} */ const settleWaiters = [];
    const keep = new Float32Array(4);

    function finish(/** @type {string|null} */ state) {
      bursting = false;
      const done = actionDone;
      actionDone = null;
      done?.(state);
      for (const resolve of settleWaiters.splice(0)) resolve('idle');
    }

    /** @param {ReadonlyArray<ReadonlyArray<number>>} script @param {boolean} debounce */
    function burst(script = BURST_SCRIPT, debounce = true) {
      const now = performance.now();
      // one burst per validation pass: the running one (a burst never joins the demo: it replaces it)
      if (debounce && bursting && pendingScript === BURST_SCRIPT && now - lastTrigger < TRIGGER_DEBOUNCE_MS) return false;
      lastTrigger = now;
      pendingScript = script;
      burstPending = true;   // the burst starts on the next frame, on the frame clock
      bursting = true;
      context.requestRender();
      return true;
    }

    /** ask for a frame in `ms` (one timer; the host renders on its own whenever the source changes, and render() re-arms it) */
    function wakeIn(/** @type {number} */ ms) {
      if (ms <= 2) { context.requestRender(); return; }
      if (!Number.isFinite(ms)) { clearTimeout(wakeTimer); wakeTimer = 0; wakeAt = Infinity; return; }
      const at = performance.now() + ms;
      if (wakeTimer && Math.abs(at - wakeAt) < 2) return;
      clearTimeout(wakeTimer);
      wakeAt = at;
      wakeTimer = setTimeout(() => { wakeTimer = 0; wakeAt = Infinity; context.requestRender(); }, ms);
    }

    /** @param {Readonly<Record<string, unknown>>|undefined} o */
    function applyOptions(o) {
      if (!o) return;
      if (o.mode !== undefined) params.mode = MODES.includes(String(o.mode)) ? String(o.mode) : 'ambient';
      if (o.intensity !== undefined) params.intensity = clampNum(o.intensity, 0, 1, params.intensity);
      if (o.seed !== undefined) params.seed = Math.trunc(clampNum(o.seed, -1e9, 1e9, 1));
      for (const key of /** @type {const} */ (['split', 'sort', 'noise'])) if (o[key] !== undefined) params[key] = o[key] !== false;
      if (o.watch !== undefined) watch = typeof o.watch === 'string' ? o.watch : '';
    }
    applyOptions(initialOptions);

    /**
     * The focused element of the drawn page, as a keep-out rectangle in CSS px of the frame (ambient events stay off the field the user
     * is in), or null. @returns {Float32Array|null}
     */
    function focusKeepOut() {
      const active = /** @type {any} */ (source.ownerDocument)?.activeElement;
      if (!active || active === source || !source.contains?.(active) || !source.getBoundingClientRect) return null;
      const s = source.getBoundingClientRect();
      const r = active.getBoundingClientRect();
      const sx = params.cssWidth / Math.max(1, s.width);
      const sy = params.cssHeight / Math.max(1, s.height);
      const margin = 6;
      keep[0] = (r.left - s.left) * sx - margin; keep[1] = (r.top - s.top) * sy - margin;
      keep[2] = (r.right - s.left) * sx + margin; keep[3] = (r.bottom - s.top) * sy + margin;
      return keep;
    }

    // validation errors in the drawn page start a burst: `invalid` events, and elements that start to match `watch`
    // (they join a running burst, and the demo, which is glitching already)
    const autoBurst = () => { if (!(bursting && pendingScript === DEMO_SCRIPT)) burst(); };
    const onInvalid = () => { autoBurst(); };
    source.addEventListener('invalid', onInvalid, true);
    // typing holds the ambient events off; a press or a key during the demo ends it (the user takes over)
    const onTyping = () => {
      params.quietUntil = performance.now() + TYPING_HOLD_MS;
      if (params.script === DEMO_SCRIPT && bursting) stopDemo();
      context.requestRender();   // the next event is now later: render() re-arms the timer
    };
    const onPress = () => { if (params.script === DEMO_SCRIPT && bursting) stopDemo(); };
    source.addEventListener('keydown', onTyping, true);
    source.addEventListener('input', onTyping, true);
    context.listen?.('pointerdown', onPress);
    function stopDemo() {
      params.burstAt = -1;
      params.script = BURST_SCRIPT;
      burstPending = false;
      finish(null);
      context.requestRender();
    }
    const Observer = win?.MutationObserver;
    const observer = Observer ? new Observer((/** @type {MutationRecord[]} */ records) => {
      if (!watch) return;
      for (const r of records) {
        const el = /** @type {Element} */ (r.target);
        try { if (el.matches?.(watch)) { autoBurst(); return; } } catch { return; /* not a valid selector */ }
      }
    }) : null;
    observer?.observe(source, { subtree: true, attributes: true, attributeFilter: ['class', 'aria-invalid', 'data-state'] });

    return {
      spatial: true,   // not `continuous`: a frame is requested when the picture changes next, none between changes
      setOptions(next) { if (params.script === DEMO_SCRIPT && bursting) stopDemo(); applyOptions(next); context.requestRender(); },
      // 'burst': one burst; 'demo': the scripted sequence. Each resolves 'idle' once it has ended (null when superseded or cut short)
      runAction(action) {
        const previous = actionDone;
        actionDone = null;
        previous?.(null);
        const demo = action === 'demo';
        if (!burst(demo ? DEMO_SCRIPT : BURST_SCRIPT, !demo) && !bursting) return 'idle';
        return new Promise((resolve) => { actionDone = resolve; });
      },
      settled: () => (bursting ? new Promise((resolve) => { settleWaiters.push(resolve); }) : 'idle'),
      render(frame) {
        if (burstPending) { burstPending = false; params.burstAt = frame.now; params.burstSerial += 1; params.script = pendingScript; }
        params.width = frame.width; params.height = frame.height; params.cssWidth = frame.cssWidth; params.cssHeight = frame.cssHeight;
        params.now = frame.now; params.ready = frame.sourceReady;
        params.keepOut = params.mode !== 'burst' && !params.reduced ? focusKeepOut() : null;
        const next = fillGlitchFrame(globals, params);
        if (bursting && !burstPending && frame.now - params.burstAt >= scriptLength(params.script ?? BURST_SCRIPT)) finish('idle');
        wakeIn(next);
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
        // instance 0 is the page, instance i the block i - 1 on top of it (glitch.wgsl)
        pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.draw(6, 1 + globals[8]); pass.end();
        attachment.view = null;
      },
      // called each time a frame is PRESENTED: the uniform block of that frame is copied into one of 4 slots
      captureInputMapper() {
        mapperSlot = (mapperSlot + 1) % MAPPER_SLOTS;
        mapperStates[mapperSlot].set(globals);
        return mappers[mapperSlot];
      },
      mountUI(root, ui) { return mountGlitchUi(root, ui); },
      destroy() {
        clearTimeout(wakeTimer);
        actionDone?.(null);
        actionDone = null;
        for (const resolve of settleWaiters.splice(0)) resolve(null);
        observer?.disconnect();
        source.removeEventListener('invalid', onInvalid, true);
        source.removeEventListener('keydown', onTyping, true);
        source.removeEventListener('input', onTyping, true);
        uniforms.destroy?.();
      },
    };
  },
});
