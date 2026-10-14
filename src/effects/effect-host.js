/**
 * EffectHost implementation (docs/ARCHITECTURE.md ADR-G).
 * Module: gpu-effects (src/effects/**).
 */

import { invalidState } from '../contracts/errors.js';
import { BUS, EVENTS } from '../contracts/events.js';
import { createPluginSet } from './effect-plugins.js';
import { rafFrameSource, schedulerFrameSource } from './frame-source.js';
import { createPresenter } from './gpu-presenter.js';
import { createMapperChain } from './input-mapper.js';
import { createInterposer } from './interposer.js';
import { captureMapper } from './plugin-abi.js';
import { createNativeSourceProvider, createStoreSourceProvider } from './source-provider.js';

/** @typedef {import('../contracts/types.js').EffectHost} EffectHost */
/** @typedef {import('../contracts/types.js').EffectHostOptions} EffectHostOptions */
/** @typedef {import('../contracts/types.js').EffectPresentationFrame} EffectPresentationFrame */
/** @typedef {import('../contracts/types.js').EffectViewport} EffectViewport */
/** @typedef {import('../contracts/types.js').GeometryApi} GeometryApi */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').InputMapper} InputMapper */
/** @typedef {import('../contracts/types.js').InteractionTracker} InteractionTracker */
/** @typedef {import('../contracts/types.js').Scheduler} Scheduler */
/** @typedef {import('../contracts/types.js').SnapshotStore} SnapshotStore */
/** @typedef {import('./effect-plugins.js').Slot} Slot */
/** @typedef {import('./gpu-presenter.js').Presenter} Presenter */

/** More device losses than this inside the window stop the host from recreating the device again. */
const MAX_LOSSES = 3;
const LOSS_WINDOW_MS = 10000;
const FPS_WINDOW = 32;

/**
 * Runs as a Scheduler FrameHook; uploads only when the source version advanced; renders when due; effecterror on plugin failure (plugin disabled, last frame kept). Keeps source geometry in sync via GeometryApi.
 * DEVICE LOSS: `device.lost` is handled (ADR-G): keep presenting the last frame, recreate device, source/destination textures and every plugin pipeline (plugin.create is re-run with the same options), report once; gate G-fault-injection (G-device-lost).
 * @param {HicEnv} env
 * @param {{store: SnapshotStore, scheduler: Scheduler, geometry: GeometryApi, tracker: InteractionTracker}} deps
 * @param {HTMLCanvasElement} canvas
 * @param {Element} source
 * @param {EffectHostOptions} [options]
 * @returns {Promise<EffectHost>}
 * @throws InvalidStateError (source not eligible / canvas context conflict), HicUnsupportedError (no WebGPU)
 */
export async function createEffectHost(env, deps, canvas, source, options = {}) {
  const record = env.registry.get(canvas) ?? null;
  assertEligible(canvas, source, record);
  const runtime = new HostRuntime(env, deps, canvas, source, record, { ...options, maxDpr: options.maxDpr ?? env.options.maxDpr });
  try {
    await runtime.start();
  } catch (error) {
    runtime.destroy();
    const e = /** @type {any} */ (error);
    if (e && e.feature) env.reporter.unsupported({ feature: e.feature, message: e.message, hint: e.hint }, canvas);
    throw error;
  }
  return runtime.publicApi();
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {Element} source
 * @param {import('../contracts/types.js').CanvasRecord|null} record
 */
function assertEligible(canvas, source, record) {
  const eligible = record
    ? !!record.layer?.isMounted() && record.layer.drawableElements().includes(source)
    : source !== canvas && canvas.contains(source);
  if (!eligible) throw invalidState('createHost: `source` is not an eligible drawable of this canvas (it must be a drawable child, or a descendant marked drawable)');
}

class HostRuntime {
  /**
   * @param {HicEnv} env
   * @param {{store: SnapshotStore, scheduler: Scheduler, geometry: GeometryApi, tracker: InteractionTracker}} deps
   * @param {HTMLCanvasElement} canvas
   * @param {Element} source
   * @param {import('../contracts/types.js').CanvasRecord|null} record
   * @param {EffectHostOptions} opts
   */
  constructor(env, deps, canvas, source, record, opts) {
    this.env = env;
    this.deps = deps;
    this.canvas = canvas;
    this.source = source;
    this.record = record;
    this.opts = opts;
    this.destroyed = false;
    this.recovering = false;
    this.renderRequested = true;
    /** @type {number|null} source version id in the source texture */
    this.uploaded = null;
    this.frameIndex = 0;
    this.lastNow = 0;
    /** @type {EffectViewport|null} */ this.lastViewport = null;
    this.lastFill = { x: NaN, y: NaN };
    this.fillApplied = false;
    this.sizeChecked = false;
    /** @type {number[]} */ this.lossTimes = [];
    /** @type {Float64Array} */ this.frameTimes = new Float64Array(FPS_WINDOW);
    this.counters = { frames: 0, uploads: 0, pluginErrors: 0, deviceLosses: 0 };
    /** @type {Array<() => void>} */ this.cleanups = [];
    this.chain = createMapperChain();
    /** @type {{stats: () => {remapped: number, passedThrough: number}}|null} */ this.interposer = null;
    /** @type {Presenter} */ this.presenter = /** @type {any} */ (null);
    this.provider = record ? createStoreSourceProvider(env, record, source) : createNativeSourceProvider(canvas, source);
    this.plugins = createPluginSet(env, canvas, source, {
      gpu: () => this.presenter,
      viewport: () => this.presenter.viewport(),
      requestRender: () => this.requestRender(),
      reportError: (error, slot, phase) => this.reportPluginError(error, slot, phase),
    });
    const hook = (/** @type {number} */ now, /** @type {{frameCap: number, due: boolean}} */ info) => this.onFrame(now, info);
    this.frames = record ? schedulerFrameSource(deps.scheduler, record, hook) : rafFrameSource(env, canvas, hook);
  }

  async start() {
    this.presenter = await this.openPresenter();
    const { bus } = this.env;
    const invalidate = () => { this.renderRequested = true; this.frames.wake(); };
    this.cleanups.push(
      bus.on(BUS.RESIZE, (/** @type {{record: unknown}} */ e) => { if (e.record === this.record) invalidate(); }),
      bus.on(BUS.DPR, invalidate),
    );
    if (this.opts.interposer !== false && this.record?.layer) {
      const interposer = createInterposer(this.env, this.record, this.chain, this.deps.tracker);
      this.interposer = interposer;
      this.cleanups.push(() => interposer.dispose());
    }
    this.frames.wake();
  }

  openPresenter() {
    const { canvas, record, env } = this;
    return createPresenter(canvas, this.opts, {
      cssSize: () => {
        const box = record?.contentBox;
        return box && box.width > 0 && box.height > 0 ? box : { width: canvas.clientWidth, height: canvas.clientHeight };
      },
      devicePixelRatio: () => env.window.devicePixelRatio || 1,
      onLost: (info) => { void this.onDeviceLost(info); },
      onError: (error) => env.reporter.caught(error, 'effects:gpu-error'),
    });
  }

  requestRender() {
    if (this.destroyed) return;
    this.renderRequested = true;
    this.frames.wake();
  }

  /**
   * @param {number} now
   * @param {{frameCap: number, due: boolean}} info
   * @returns {boolean}
   */
  onFrame(now, info) {
    // the hook is registered by the constructor but the presenter only exists once start() has awaited the GPU: until then there is nothing to render (start() wakes the loop when it is ready)
    if (this.destroyed || this.recovering || !this.presenter) return false;
    try {
      const v = this.provider.version();
      const sourceChanged = v !== null && v !== this.uploaded;
      if (!(sourceChanged || this.renderRequested || this.plugins.hasContinuous())) return false;
      if (!info.due) return true;
      this.renderFrame(now, info.frameCap);
      return this.renderRequested || this.plugins.hasContinuous();
    } catch (error) {
      this.env.reporter.caught(error, 'effects:frame');
      return false;
    }
  }

  /** @param {number} now @param {number} frameCap */
  renderFrame(now, frameCap) {
    this.renderRequested = false;
    const p = this.presenter;
    p.syncSize();
    const vp = p.viewport();
    const v = this.provider.version();
    if (v !== null && v !== this.uploaded) {
      const uploaded = p.uploadSource(this.provider);
      if (uploaded) { this.uploaded = uploaded; this.counters.uploads += 1; }
    }
    this.notifyResize(vp);
    this.syncGeometry(vp);
    /** @type {EffectPresentationFrame} */
    const frame = { now, delta: this.lastNow ? now - this.lastNow : 0, frameIndex: this.frameIndex, frameCap, sourceVersion: this.uploaded };
    const presented = this.present(frame);
    if (!presented) return;
    this.lastNow = now;
    this.frameIndex += 1;
    this.counters.frames += 1;
    this.frameTimes[this.counters.frames % FPS_WINDOW] = now;
    this.chain.push(frame.frameIndex, this.captureMappers(presented, frame));
    this.canvas.dispatchEvent(new CustomEvent(EVENTS.EFFECT_FRAME, { detail: Object.freeze({ ...frame }) }));
  }

  /**
   * Submit the chain; a throwing plugin is disabled and reported. When it had already taken this frame's canvas texture the frame is
   * redrawn without it (the canvas would present an empty texture otherwise); before that the canvas simply keeps its last frame.
   * @param {EffectPresentationFrame} frame
   * @returns {import('./effect-plugins.js').Stage[]|null} the stages that were presented, null when nothing was
   */
  present(frame) {
    for (;;) {
      const stages = this.plugins.stages();
      const failure = this.presenter.renderChain(stages, frame);
      if (!failure) return stages;
      if (!failure.plugin.slot) throw failure.error;
      this.counters.pluginErrors += 1;
      this.plugins.fail(failure.plugin.slot, failure.error);
      if (!failure.acquired) return null;
    }
  }

  /**
   * @param {import('./effect-plugins.js').Stage[]} stages
   * @param {EffectPresentationFrame} frame
   * @returns {InputMapper[]}
   */
  captureMappers(stages, frame) {
    /** @type {InputMapper[]} */
    const mappers = [];
    for (const s of stages) {
      if (!s.instance.spatial) continue;
      try { mappers.push(captureMapper(s.instance, s.def, frame)); } catch (error) { this.plugins.fail(s.slot, error); }
    }
    return mappers;
  }

  /** @param {EffectViewport} vp */
  notifyResize(vp) {
    const last = this.lastViewport;
    if (last && last.width === vp.width && last.height === vp.height && last.dpr === vp.dpr) return;
    this.lastViewport = vp;
    this.plugins.resize(vp);
  }

  /**
   * The effect shows the source stretched over the whole canvas; the live element must sit under those pixels (API-CONTRACT 7.3).
   * @param {EffectViewport} vp
   */
  syncGeometry(vp) {
    const { record, source } = this;
    const size = record ? this.provider.size() : null;
    if (!record || !size || size.cssWidth <= 0 || size.cssHeight <= 0) return;
    if (!this.sizeChecked) this.warnSizeMismatch(vp, size);
    const x = vp.cssWidth / size.cssWidth;
    const y = vp.cssHeight / size.cssHeight;
    if (Math.abs(x - this.lastFill.x) < 1e-6 && Math.abs(y - this.lastFill.y) < 1e-6) return;
    this.lastFill = { x, y };
    // Always applied, also for an identity fill: an element is hit-testable only while it is in the canvas's drawn list (a source that exactly fills the canvas still has to be there).
    this.deps.geometry.update(record, source, { canvasTransform: { a: x, d: y } });
    this.fillApplied = true;
  }

  /**
   * N-02: the stretch maps drawn pixels to live pixels; a source of another size than the canvas is stretched, so input (and the picture) are off. One console.warn per host, at its first frame.
   * @param {EffectViewport} vp
   * @param {{cssWidth: number, cssHeight: number}} size
   */
  warnSizeMismatch(vp, size) {
    this.sizeChecked = true;
    if (Math.abs(vp.cssWidth - size.cssWidth) <= 1 && Math.abs(vp.cssHeight - size.cssHeight) <= 1) return;
    const r = (/** @type {number} */ n) => Math.round(n * 100) / 100;
    /** @type {Window & typeof globalThis} */ (this.env.window).console.warn(`[hic-live-polyfill] createHost: the source is ${r(size.cssWidth)}x${r(size.cssHeight)} CSS px but the canvas is ${r(vp.cssWidth)}x${r(vp.cssHeight)}; it is stretched to fit, so the picture is distorted and clicks land off target. Size the source like the canvas (docs/guides/EFFECTS-PLUGINS.md).`);
  }

  /** @param {unknown} error @param {Slot} slot @param {string} phase */
  reportPluginError(error, slot, phase) {
    if (phase !== 'render') this.counters.pluginErrors += 1;
    try {
      this.canvas.dispatchEvent(new CustomEvent(EVENTS.EFFECT_ERROR, { detail: { error, type: slot.def.type, id: slot.id, phase } }));
    } catch { /* a throwing listener must not stop the report */ }
    this.env.reporter.caught(error, `effects:${slot.def.type}:${phase}`);
  }

  /** @param {{reason: string, message: string}} info */
  async onDeviceLost(info) {
    if (this.destroyed || this.recovering) return;
    this.recovering = true;
    this.counters.deviceLosses += 1;
    const t = this.env.now();
    this.lossTimes = this.lossTimes.filter((x) => t - x < LOSS_WINDOW_MS);
    this.lossTimes.push(t);
    this.env.reporter.caught(new Error(`GPUDevice lost (${info.reason}): ${info.message}`), 'effects:device-lost');
    if (this.lossTimes.length > MAX_LOSSES) {
      this.giveUp(new Error(`GPUDevice lost ${this.lossTimes.length} times within ${LOSS_WINDOW_MS} ms; the effect stays on its last frame`));
      return;
    }
    try {
      const next = await this.openPresenter();
      if (this.destroyed) { next.dispose(); return; }
      const old = this.presenter;
      this.presenter = next;
      old.dispose(true);
      this.uploaded = null;
      this.lastViewport = null;
      await this.plugins.recreate();
    } catch (error) {
      this.giveUp(error);
      return;
    }
    this.recovering = false;
    this.requestRender();
  }

  /** @param {unknown} error */
  giveUp(error) {
    this.env.reporter.caught(error, 'effects:recover');
    try { this.canvas.dispatchEvent(new CustomEvent(EVENTS.EFFECT_ERROR, { detail: { error, type: 'host', id: 'host', phase: 'recover' } })); } catch { /* listener threw */ }
  }

  stats() {
    const n = Math.min(this.counters.frames, FPS_WINDOW);
    let fps = 0;
    if (n >= 2) {
      const newest = this.frameTimes[this.counters.frames % FPS_WINDOW];
      const oldest = this.frameTimes[(this.counters.frames - n + 1) % FPS_WINDOW];
      fps = newest > oldest ? ((n - 1) * 1000) / (newest - oldest) : 0;
    }
    return { ...this.counters, fps, sourceVersion: this.uploaded, ...(this.interposer?.stats() ?? { remapped: 0, passedThrough: 0 }) };
  }

  /** @returns {EffectHost} */
  publicApi() {
    const rt = this;
    return {
      get pluginCount() { return rt.plugins.count; },
      addPlugin: (def, options) => rt.plugins.add(def, options),
      stats: () => rt.stats(),
      destroy: () => rt.destroy(),
    };
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const c of this.cleanups.splice(0)) c();
    this.frames.remove();
    this.plugins.destroy();
    this.provider.dispose();
    if (this.fillApplied && this.record) this.deps.geometry.clear(this.record, this.source);
    this.presenter?.dispose();
  }
}
