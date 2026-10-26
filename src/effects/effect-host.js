/**
 * EffectHost implementation (docs/ARCHITECTURE.md ADR-G).
 * Module: gpu-effects (src/effects/**).
 */

import { HicUnsupportedError, invalidState } from '../contracts/errors.js';
import { BUS, EVENTS } from '../contracts/events.js';
import { createPluginSet } from './effect-plugins.js';
import { nativeFrameSource, schedulerFrameSource } from './frame-source.js';
import { createPresenter } from './gpu-presenter.js';
import { createMapperChain } from './input-mapper.js';
import { createInterposer } from './interposer.js';
import { contentBoxOf, createNativeGeometry } from './native-geometry.js';
import { createNativeInterposer } from './native-interposer.js';
import { captureMapper } from './plugin-abi.js';
import { createNativeSourceProvider, createStoreSourceProvider } from './source-provider.js';
import { watchVisibility } from '../util/visibility.js';

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
/** While the canvas cannot be seen, an action that somebody awaits still advances: one frame every SETTLE_MS (10 per second). */
const SETTLE_MS = 100;

/**
 * Runs as a Scheduler FrameHook; uploads only when the source version advanced; renders when due; effecterror on plugin failure (plugin disabled, last frame kept). Keeps source geometry in sync via GeometryApi.
 * OFF-SCREEN PAUSE (ADR-G): while the canvas cannot be seen (util/visibility.js: outside the viewport by more than VISIBILITY_MARGIN, or the document hidden) nothing is rendered,
 * continuous plugins included; the frame clock keeps running (`frame.now` is the time of the frame), so on resume a time-based effect shows the state it has at that
 * time, with nothing replayed. Coming back into the margin renders at once. While paused, an unsettled trigger()/settled() still advances at 1000 / SETTLE_MS frames
 * per second, so its promise resolves; a hidden document runs no frames at all, so there it resolves on the first frame after the document is shown again.
 * DEVICE LOSS: `device.lost` is handled (ADR-G): keep presenting the last frame, recreate device, source/destination textures and every plugin pipeline (plugin.create is re-run with the same options), report once; gate G-fault-injection (G-device-lost).
 * NATIVE MODE (no record: the browser implements HTML-in-Canvas and the polyfill stepped aside): the source comes from the standard
 * GPUQueue.drawElementImageToTexture (source-provider.js), frames from a rAF loop plus the canvas's paint event (frame-source.js), the
 * stretch and the pointer remap from the standard updateElementGeometry (native-geometry.js, native-interposer.js).
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
  if (!record) assertNativeApi(env, canvas, source);
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

/**
 * Native mode needs the standard GPU upload and the hit-test geometry of the browser; an earlier draft without them is refused loudly.
 * @param {HicEnv} env
 * @param {HTMLCanvasElement} canvas
 * @param {Element} source
 */
function assertNativeApi(env, canvas, source) {
  const win = /** @type {any} */ (env.window);
  const c = /** @type {any} */ (canvas);
  const missing = [
    typeof win.GPUQueue?.prototype?.drawElementImageToTexture !== 'function' && 'GPUQueue.drawElementImageToTexture',
    typeof c.updateElementGeometry !== 'function' && 'updateElementGeometry',
    typeof c.clearElementGeometry !== 'function' && 'clearElementGeometry',
    typeof c.getElementImageDefaultSize !== 'function' && 'getElementImageDefaultSize',
  ].filter(Boolean);
  if (missing.length) {
    throw new HicUnsupportedError('effect-plugins', `createHost: this browser's own HTML-in-Canvas implementation lacks ${missing.join(', ')}, which the effects host needs on top of it`, { hint: 'Keep the 2D drawElementImage path (draw the source on a 2D canvas) when createHost rejects.' });
  }
  // the standard eligibility check of the browser: InvalidStateError unless `source` is a drawable descendant of a content="drawable" canvas
  try { c.getElementTransform?.(source); } catch {
    throw invalidState('createHost: `source` is not an eligible drawable of this canvas (it must be a drawable child, or a descendant marked drawable)');
  }
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
    this.counters = { frames: 0, uploads: 0, pluginErrors: 0, deviceLosses: 0, pauses: 0, offscreenFrames: 0 };
    /** @type {import('../util/visibility.js').VisibilityWatch|null} */ this.visibility = null;
    /** @type {any} */ this.settleTimer = 0;
    /** a paused host may render one frame to advance an unsettled action */
    this.settleDue = false;
    /** @type {Array<() => void>} */ this.cleanups = [];
    this.chain = createMapperChain();
    /** @type {{stats: () => {remapped: number, passedThrough: number}}|null} */ this.interposer = null;
    /** @type {Presenter} */ this.presenter = /** @type {any} */ (null);
    this.provider = record ? createStoreSourceProvider(env, record, source) : createNativeSourceProvider(env, canvas, source);
    /** native mode: the content box of the canvas from a ResizeObserver (css px), null before its first report */
    /** @type {{width: number, height: number}|null} */ this.nativeCss = null;
    /** native mode: the hit-test geometry of the source (the stretch, and the interposer's shift under the pointer) */
    this.nativeGeometry = record ? null : createNativeGeometry(canvas, source);
    this.plugins = createPluginSet(env, canvas, source, {
      gpu: () => this.presenter,
      viewport: () => this.presenter.viewport(),
      requestRender: () => this.requestRender(),
      reducedMotion: () => !!(/** @type {any} */ (env.window)).matchMedia?.('(prefers-reduced-motion: reduce)').matches,
      reportError: (error, slot, phase) => this.reportPluginError(error, slot, phase),
      onWait: () => { if (!this.isVisible()) this.armSettle(); },
    });
    const hook = (/** @type {number} */ now, /** @type {{frameCap: number, due: boolean, repeat?: boolean}} */ info) => this.onFrame(now, info);
    this.frames = record ? schedulerFrameSource(deps.scheduler, record, hook) : nativeFrameSource(env, canvas, hook);
  }

  async start() {
    this.presenter = await this.openPresenter();
    const { bus } = this.env;
    const invalidate = () => { this.renderRequested = true; this.frames.wake(); };
    this.cleanups.push(
      bus.on(BUS.RESIZE, (/** @type {{record: unknown}} */ e) => { if (e.record === this.record) invalidate(); }),
      bus.on(BUS.DPR, invalidate),
    );
    const visibility = watchVisibility(this.env, this.canvas, (visible) => this.onVisibility(visible));
    this.visibility = visibility;
    this.cleanups.push(() => visibility.dispose(), () => this.clearSettle());
    if (this.opts.interposer !== false && (this.record?.layer || this.nativeGeometry)) {
      const interposer = this.record?.layer
        ? createInterposer(this.env, this.record, this.chain, this.deps.tracker)
        : createNativeInterposer(this.env, this.canvas, this.source, this.chain, /** @type {import('./native-geometry.js').NativeGeometry} */ (this.nativeGeometry));
      this.interposer = interposer;
      this.cleanups.push(() => interposer.dispose());
    }
    if (!this.record) this.cleanups.push(this.watchNativeSize());
    this.frames.wake();
  }

  /**
   * Native mode: no scheduler reports a resize or a DPR change of the canvas; a ResizeObserver does (the device-pixel box changes with both).
   * @returns {() => void}
   */
  watchNativeSize() {
    const win = /** @type {any} */ (this.env.window);
    if (typeof win.ResizeObserver !== 'function') return () => {};
    let first = true;
    const ro = new win.ResizeObserver((/** @type {any[]} */ entries) => {
      // the content box for the presenter, without a layout read per frame
      const box = entries[entries.length - 1]?.contentBoxSize?.[0];
      if (box) this.nativeCss = { width: box.inlineSize, height: box.blockSize };
      if (first) { first = false; return; }
      this.requestRender();
    });
    try { ro.observe(this.canvas, { box: 'device-pixel-content-box' }); } catch { ro.observe(this.canvas); }
    return () => ro.disconnect();
  }

  openPresenter() {
    const { canvas, record, env } = this;
    return createPresenter(canvas, this.opts, {
      cssSize: () => {
        const box = record?.contentBox;
        if (box && box.width > 0 && box.height > 0) return box;
        return record ? { width: canvas.clientWidth, height: canvas.clientHeight } : this.nativeCss ?? contentBoxOf(canvas);
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

  isVisible() { return this.visibility?.visible ?? true; }

  /** @param {boolean} visible */
  onVisibility(visible) {
    if (this.destroyed) return;
    if (visible) {
      // render on the next frame: the canvas is still inside the margin, so this fresh frame is presented before it scrolls in
      this.clearSettle();
      this.requestRender();
    } else {
      this.counters.pauses += 1;
      this.armSettle();
    }
  }

  /** While paused: schedule the next settle frame when some action is unsettled. */
  armSettle() {
    if (this.settleTimer || this.destroyed || !this.plugins.unsettled()) return;
    this.settleTimer = this.env.window.setTimeout(() => {
      this.settleTimer = 0;
      // re-checked here: an action that ended on the last settle frame resolves its promise a few microtasks after that frame
      if (this.destroyed || this.isVisible() || !this.plugins.unsettled()) return;
      this.settleDue = true;
      this.frames.wake();
    }, SETTLE_MS);
  }

  clearSettle() {
    if (this.settleTimer) this.env.window.clearTimeout(this.settleTimer);
    this.settleTimer = 0;
    this.settleDue = false;
  }

  /**
   * @param {number} now
   * @param {{frameCap: number, due: boolean, repeat?: boolean}} info
   * @returns {boolean}
   */
  onFrame(now, info) {
    // the hook is registered by the constructor but the presenter only exists once start() has awaited the GPU: until then there is nothing to render (start() wakes the loop when it is ready)
    if (this.destroyed || this.recovering || !this.presenter) return false;
    try {
      const v = this.provider.version();
      const sourceChanged = v !== null && v !== this.uploaded;
      if (info.repeat && this.counters.frames > 0 && this.lastNow === now) {
        // native: the paint event after this frame's rAF render. The frame stays as rendered (one render per frame: what is presented is what the
        // frame's input mappers describe); the source is uploaded now, while the element image is fresh, and the next frame shows it.
        if (sourceChanged && this.isVisible()) {
          const uploaded = this.presenter.uploadSource(this.provider);
          if (uploaded) { this.uploaded = uploaded; this.counters.uploads += 1; }
          this.renderRequested = true;
        }
        return this.renderRequested || this.plugins.hasContinuous();
      }
      if (!(sourceChanged || this.renderRequested || this.plugins.hasContinuous() || this.settleDue)) return false;
      const paused = !this.isVisible();
      // paused: the work waits for the resume (the source is uploaded and the clock read then), except a settle frame
      if (paused && !this.settleDue) { this.armSettle(); return false; }
      if (!info.due) return true;
      this.renderFrame(now, info.frameCap);
      if (paused) {
        this.counters.offscreenFrames += 1;
        this.settleDue = false;
        this.armSettle();
        return false;
      }
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
    const size = this.provider.size();
    if (!size || size.cssWidth <= 0 || size.cssHeight <= 0) return;
    if (!this.sizeChecked) this.warnSizeMismatch(vp, size);
    const x = vp.cssWidth / size.cssWidth;
    const y = vp.cssHeight / size.cssHeight;
    if (Math.abs(x - this.lastFill.x) < 1e-6 && Math.abs(y - this.lastFill.y) < 1e-6) return;
    this.lastFill = { x, y };
    // Always applied, also for an identity fill: an element is hit-testable only while it is in the canvas's drawn list (a source that exactly fills the canvas still has to be there).
    if (record) this.deps.geometry.update(record, source, { canvasTransform: { a: x, d: y } });
    else this.nativeGeometry?.setFill(x, y);
    this.fillApplied = true;
  }

  /**
   * The stretch maps drawn pixels to live pixels; a source of another size than the canvas is stretched, so input (and the picture) are off. One console.warn per host, at its first frame.
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
    return { ...this.counters, fps, paused: !this.isVisible(), sourceVersion: this.uploaded, ...(this.interposer?.stats() ?? { remapped: 0, passedThrough: 0 }) };
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
    this.nativeGeometry?.dispose();
    this.presenter?.dispose();
  }
}
