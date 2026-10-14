/**
 * Glitch effect plugin (effect plugin ABI v2): an EXAMPLE of the effects extension of html-in-canvas-polyfill, not part of the polyfill.
 * Shader: ./glitch.wgsl.
 *
 * A controlled digital glitch: RGB channel split, block displacement, scanline tearing, pixel-sorting streaks, grain and scanlines.
 *   mode 'ambient'  subtle and continuous: a faint split, grain and scanlines, and every ~1.7 s a micro-glitch of 70-160 ms
 *   mode 'burst'    nothing until triggered
 * Either mode plays a burst (~0.5 s, the pattern changes every 45 ms) when triggered: when an element of the drawn page starts to match
 * `watch` (by default a validation error: [aria-invalid="true"], .invalid, [data-state="error"]), on an `invalid` event in the page, when
 * the `trigger` option changes, or from the Burst button of mountUI.
 *
 * Input mapper (`mapGlitchPoint`): the block table is the only layer that moves the page. Outside the displaced blocks the mapper is the
 * identity; inside a block it is the exact inverse of that block's offset (wrapped around the page, like the shader), so a click on a
 * displaced field reaches that field, also during a burst. The colour layers (split, sort streaks, grain, scanlines) do not move the
 * page: input goes to the element under them. All randomness is a hash of (seed, burst, pattern, index), so a frame is reproducible.
 */

import { wgsl } from './wgsl.js';
import { stateMapper } from '../_lib/mapper.js';
import { clampNum } from '../_lib/number.js';
import { injectStyle } from '../_lib/ui.js';

/** @typedef {import('../../src/contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../../src/contracts/types.js').InputMapper} InputMapper */
/** @typedef {import('../../src/contracts/types.js').InputPoint} InputPoint */

/** What the plugin gallery and the build read (plugins/README.md). */
export const meta = Object.freeze({
  name: 'glitch',
  title: 'Glitch',
  description: 'RGB split, block shifts, scanline tears and pixel sorting; bursts on a validation error. Clicks follow the displaced blocks.',
  defaults: Object.freeze({ mode: 'ambient', intensity: 0.35 }),
  reducedMotion: 'With reduced motion no block moves and there is no ambient glitch; a burst is one steady colour-split frame.',
});

export const MAX_BLOCKS = 16;
/** floats before the block table: resolution(2) css(2) time split grain scan count ready flash block_split */
export const HEADER_FLOATS = 12;
export const UNIFORM_FLOATS = HEADER_FLOATS + MAX_BLOCKS * 8;
export const BURST_MS = 520;
export const PATTERN_MS = 45;
export const AMBIENT_CYCLE_MS = 1700;
export const DEFAULT_WATCH = '[aria-invalid="true"], .invalid, [data-state="error"]';
export const MODES = Object.freeze(['ambient', 'burst']);

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
 * @param {Float32Array} out @param {number} n  block index
 * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1  the rectangle, CSS px
 * @param {number} dx @param {number} dy  offset of the page inside it @param {number} kind  0 shift, 1 sort @param {number} extra  split / sort length
 */
function writeBlock(out, n, x0, y0, x1, y1, dx, dy, kind, extra) {
  const b = HEADER_FLOATS + n * 8;
  out[b] = x0; out[b + 1] = y0; out[b + 2] = x1; out[b + 3] = y1;
  out[b + 4] = dx; out[b + 5] = dy; out[b + 6] = kind; out[b + 7] = extra;
}

/**
 * Writes the block table of one glitch pattern into `out` (from HEADER_FLOATS on) and returns the number of blocks. Every coordinate and
 * offset is a whole CSS pixel, so the shader samples texel centres and the mapper is exact. Order: sort streaks, blocks, tears (they are
 * drawn in this order, so a later block covers an earlier one, in the shader and in the mapper). PURE apart from `out`.
 * @param {Float32Array} out
 * @param {number} width  CSS px of the page
 * @param {number} height
 * @param {number} level  0..1 strength
 * @param {number} key  seed of the pattern (seed, burst serial)
 * @param {number} pattern  index of the pattern in its burst / micro-glitch
 * @param {boolean} sort  pixel-sorting streaks on
 */
export function fillBlocks(out, width, height, level, key, pattern, sort) {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  if (!(level > 0)) return 0;
  streamKey = (Math.imul(key | 0, 7919) + (pattern | 0)) | 0;
  streamIndex = 0;
  let n = 0;
  const sorts = sort && level >= 0.5 ? Math.round(1 + 2 * level) : 0;
  for (let i = 0; i < sorts; i += 1) {
    const bw = Math.min(w, Math.round(6 + 34 * rnd()));
    const bh = Math.min(h, Math.round(30 + 110 * rnd()));
    const x0 = Math.round(rnd() * (w - bw));
    const y0 = Math.round(rnd() * (h - bh));
    writeBlock(out, n++, x0, y0, x0 + bw, y0 + bh, 0, 0, 1, Math.round(20 + 60 * rnd()));
  }
  const blocks = Math.round(2 + 6 * level);
  for (let i = 0; i < blocks; i += 1) {
    const bw = Math.min(w, Math.round(w * (0.08 + 0.37 * rnd())));
    const bh = Math.min(h, Math.round((4 + 44 * rnd()) * (0.5 + level)));
    const x0 = Math.round(rnd() * (w - bw));
    const y0 = Math.round(rnd() * (h - bh));
    const dx = Math.round((rnd() * 2 - 1) * 60 * level);
    const dy = rnd() < 0.3 ? Math.round((rnd() * 2 - 1) * 10 * level) : 0;
    writeBlock(out, n++, x0, y0, x0 + bw, y0 + bh, dx, dy, 0, Math.round(2 + 6 * level * rnd()));
  }
  const tears = Math.round(1 + 3 * level);
  for (let i = 0; i < tears; i += 1) {
    const bh = Math.min(h, Math.round(2 + 8 * rnd()));
    const y0 = Math.round(rnd() * (h - bh));
    writeBlock(out, n++, 0, y0, w, y0 + bh, Math.round((rnd() * 2 - 1) * 120 * level), 0, 0, 0);
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
 * @property {boolean} reduced  prefers-reduced-motion
 * @property {boolean} split
 * @property {boolean} sort
 * @property {boolean} noise
 */

/**
 * Writes the uniform block of one frame. Everything is a function of the frame clock and the parameters, so the same instant gives the
 * same picture (and mapper) at every frame cap. Returns true while the picture changes from frame to frame (it needs the next frame);
 * a reduced-motion burst is one steady picture (false). PURE apart from `out`.
 * @param {Float32Array} out
 * @param {GlitchFrameParams} f
 */
export function fillGlitchFrame(out, f) {
  const ambient = f.mode !== 'burst';
  const k = f.intensity;
  out[0] = f.width; out[1] = f.height; out[2] = f.cssWidth; out[3] = f.cssHeight;
  out[4] = f.reduced ? 0 : Math.floor(f.now / (1000 / 24)) / 24;   // grain changes 24 times a second
  let split = f.split && ambient ? 0.8 * k : 0;
  let grain = f.noise && ambient ? 0.25 * k : 0;
  let scan = f.noise && ambient ? 0.15 * k : 0;
  let flash = 0;
  let count = 0;
  let moving = ambient && !f.reduced;
  const e = f.burstAt >= 0 ? f.now - f.burstAt : Infinity;
  if (e >= 0 && e < BURST_MS) {
    if (f.reduced) {
      // no motion: one steady frame of split colour for the length of the burst, nothing moves (the plugin asks for the frame that ends it)
      split += f.split ? 6 : 0;
      flash = 0.3;
    } else {
      moving = true;
      const envelope = e < 0.6 * BURST_MS ? 1 : 1 - (e - 0.6 * BURST_MS) / (0.4 * BURST_MS);
      const level = Math.min(1, 0.45 + 0.75 * k) * envelope;
      const pattern = Math.floor(e / PATTERN_MS);
      if (pattern % 5 !== 3) {   // every fifth pattern is clean: the burst flickers
        count = fillBlocks(out, f.cssWidth, f.cssHeight, level, f.seed * 101 + f.burstSerial, pattern, f.sort);
        split += f.split ? 4 * level : 0;
        if (f.noise) { grain = Math.max(grain, 0.6 * level); scan = Math.max(scan, 0.25 * level); }
        flash = pattern === 0 ? 0.3 : 0.12 * level * (pattern % 2);
      }
    }
  } else if (ambient && !f.reduced && k > 0) {
    const cycle = Math.floor(f.now / AMBIENT_CYCLE_MS);
    const start = cycle * AMBIENT_CYCLE_MS + hash01(f.seed, cycle) * (AMBIENT_CYCLE_MS - 220);
    const length = 70 + 90 * hash01(f.seed + 1, cycle);
    if (f.now >= start && f.now < start + length) {
      count = fillBlocks(out, f.cssWidth, f.cssHeight, 0.3 * k, f.seed * 31 + cycle, Math.floor((f.now - start) / 50), false);
    }
  }
  out[5] = split; out[6] = grain; out[7] = scan; out[8] = count; out[9] = f.ready ? 1 : 0; out[10] = flash; out[11] = f.split ? 1 : 0;
  out.fill(0, HEADER_FLOATS + count * 8);   // no stale blocks: the block of a frame depends on its instant only
  return moving;
}

/**
 * The input mapper formula, the twin of glitch.wgsl (an instanced draw: the page, then each block on top of the previous ones): the
 * presented point shows the page at the returned point. Identity outside the displaced blocks; inside, the offset of the last block that
 * covers the point, undone (wrapped around the page). Sort streaks do not move. PURE.
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
  if (top < 0 || state[top + 6] >= 0.5) return { x: point.x, y: point.y };   // the page, or a sort streak (it does not move)
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
 * The plugin's controls: mode, intensity, and a button that plays a burst.
 * @param {Element} root
 * @param {{getOptions: () => Readonly<Record<string, unknown>>, setOptions: (patch: Record<string, unknown>) => void}} ui
 * @param {() => void} burst
 */
function mountGlitchUi(root, ui, burst) {
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

/** @type {EffectPluginDefinition} */
export const plugin = Object.freeze({
  type: 'glitch',
  apiVersion: /** @type {const} */ (2),
  version: 1,
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
      burstAt: -1, burstSerial: 0, reduced: !!win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches, split: true, sort: true, noise: true,
    };
    let watch = DEFAULT_WATCH;
    /** @type {unknown} */ let trigger;
    let burstPending = false;
    let lastTrigger = -Infinity;
    let endTimer = /** @type {any} */ (0);

    function burst() {
      const now = performance.now();
      if (now - lastTrigger < TRIGGER_DEBOUNCE_MS) return;
      lastTrigger = now;
      burstPending = true;   // the burst starts on the next frame, on the frame clock
      context.requestRender();
    }

    /** @param {Readonly<Record<string, unknown>>|undefined} o @param {boolean} first */
    function applyOptions(o, first) {
      if (!o) return;
      if (o.mode !== undefined) params.mode = MODES.includes(String(o.mode)) ? String(o.mode) : 'ambient';
      if (o.intensity !== undefined) params.intensity = clampNum(o.intensity, 0, 1, params.intensity);
      if (o.seed !== undefined) params.seed = Math.trunc(clampNum(o.seed, -1e9, 1e9, 1));
      for (const key of /** @type {const} */ (['split', 'sort', 'noise'])) if (o[key] !== undefined) params[key] = o[key] !== false;
      if (o.watch !== undefined) watch = typeof o.watch === 'string' ? o.watch : '';
      if ('trigger' in o && !Object.is(o.trigger, trigger)) { if (!first) burst(); trigger = o.trigger; }
    }
    applyOptions(initialOptions, true);

    // validation errors in the drawn page start a burst: `invalid` events, and elements that start to match `watch`
    const onInvalid = () => burst();
    source.addEventListener('invalid', onInvalid, true);
    const Observer = win?.MutationObserver;
    const observer = Observer ? new Observer((/** @type {MutationRecord[]} */ records) => {
      if (!watch) return;
      for (const r of records) {
        const el = /** @type {Element} */ (r.target);
        try { if (el.matches?.(watch)) { burst(); return; } } catch { return; /* not a valid selector */ }
      }
    }) : null;
    observer?.observe(source, { subtree: true, attributes: true, attributeFilter: ['class', 'aria-invalid', 'data-state'] });

    return {
      spatial: true,   // not `continuous`: frames are requested while the picture changes (ambient mode, a burst), none otherwise
      setOptions(next) { applyOptions(next, false); context.requestRender(); },
      render(frame) {
        if (burstPending) { burstPending = false; params.burstAt = frame.now; params.burstSerial += 1; }
        params.width = frame.width; params.height = frame.height; params.cssWidth = frame.cssWidth; params.cssHeight = frame.cssHeight;
        params.now = frame.now; params.ready = frame.sourceReady;
        if (fillGlitchFrame(globals, params)) context.requestRender();
        else if (params.reduced && params.burstAt >= 0 && frame.now - params.burstAt < BURST_MS && !endTimer) {
          // the steady reduced-motion burst: no frame until the one that removes it
          endTimer = setTimeout(() => { endTimer = 0; context.requestRender(); }, BURST_MS - (frame.now - params.burstAt) + 1);
        }
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
      mountUI(root, ui) { return mountGlitchUi(root, ui, burst); },
      destroy() {
        clearTimeout(endTimer);
        observer?.disconnect();
        source.removeEventListener('invalid', onInvalid, true);
        uniforms.destroy?.();
      },
    };
  },
});
