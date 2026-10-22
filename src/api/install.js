/**
 * install() / getInstalled(): the public entry (docs/API-CONTRACT.md section 2).
 * Module: api-core.
 *
 * The install is transactional: every step registers its inverse, a failing step undoes the ones before it and rethrows, and uninstall() runs the same
 * inverses in reverse order. All prototype patches go through the ledger, so uninstall restores every descriptor by identity.
 */

import { HicUnsupportedError } from '../contracts/errors.js';
import { BUS, EXT } from '../contracts/events.js';
import { createBus } from '../util/bus.js';
import { VERSION } from '../version.js';
import { resolveOptions, withDeviceBudgets } from './options.js';
import { createEnv } from './env.js';
import { createPatchLedger } from './patch.js';
import { browserGate, decideMode, nativeUsable, probeNative } from './native-detect.js';
import { buildReport, createReporter, watchCsp } from './report.js';
import { compose, composeNative, defaultServices } from './compose.js';
import { createSchedulerHooks, defineEventGlobals, disposeHandlers } from './paint-event.js';
import { defineElementImageGlobal } from './element-image.js';
import { installCanvasPatches } from './canvas-patch.js';
import { installContext2DPatches } from './context2d-patch.js';
import { installOffscreenPatches } from './offscreen-patch.js';
import { GPU_LATE_KEY, installGpu } from './gpu-seam.js';
import { installDevicePixelBox } from './ro-dpcb.js';
import { installFullscreenGuard } from './fullscreen-guard.js';
import { installWorkerGuard } from './worker-guard.js';

/** @typedef {import('../contracts/types.js').HicInstalled} HicInstalled */
/** @typedef {import('../contracts/types.js').HicMode} HicMode */
/** @typedef {import('../contracts/types.js').HicOptions} HicOptions */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').NativeState} NativeState */
/** @typedef {import('../contracts/types.js').ResolvedOptions} ResolvedOptions */
/** @typedef {import('../contracts/types.js').Services} Services */
/** @typedef {import('./native-detect.js').ModeDecision} ModeDecision */

/** One slot per window, shared by every copy of the library on the page: a second bundle must find the first one's install instead of probing patched prototypes. */
const SLOT = EXT.INSTALLED_KEY;

/** @type {WeakSet<object>} windows that already got the one warning of onUnsupportedBrowser:'warn' */
const warned = new WeakSet();

/**
 * The HicInstalled of a window, or null.
 * @param {Window} [win]
 * @returns {HicInstalled|null}
 */
export function getInstalled(win = typeof window === 'undefined' ? undefined : window) {
  return (win && /** @type {any} */ (win)[SLOT]) ?? null;
}

/**
 * SYNCHRONOUS, idempotent per window. Order: resolveOptions, probeNative, decide mode, browserGate, create env, compose, patch prototypes (ledger), registry.scan, observer.
 * HicUnsupportedError (sync) for refused browsers and for a native implementation whose core is missing (kind 'broken') when onUnsupportedBrowser is "throw".
 * A usable native implementation (kind complete, partial or legacy) never throws: install steps aside (mode native). A legacy native and a partial native with
 * gaps the bridge can build (NativeState.fillable) are bridged in mode native-bridged by the OPTIONAL native-bridge bundle (src/native-bridge.js registers it under
 * EXT.NATIVE_BRIDGE_KEY); without it install still steps aside in mode native and records why (report().deviations, id native-step-aside).
 * @param {HicOptions} [options]
 * @returns {HicInstalled}
 * @throws HicUnsupportedError('browser'|'partial-native')
 */
export function install(options) {
  return installWith(options, defaultServices());
}

/**
 * install() with injected module factories (tests wire fakes through this; production uses defaultServices()).
 * @param {HicOptions|undefined} options
 * @param {Services} services
 * @returns {HicInstalled}
 */
export function installWith(options, services) {
  const win = /** @type {Window|undefined} */ (options?.window ?? (typeof window === 'undefined' ? undefined : window));
  if (!win || !win.document) {
    throw new HicUnsupportedError('browser', 'install() needs a browser window and found none', { hint: 'run it in a page, or pass options.window' });
  }
  const existing = getInstalled(win);
  if (existing) {
    resolveOptions(options); // idempotent, but a typo or an invalid value in the repeated call must not pass silently
    return existing;
  }
  const doc = options?.document ?? win.document;
  if (doc.nodeType !== 9) throw new TypeError('option "document" must be a Document');

  const given = resolveOptions(options);
  const native = probeNative(win);
  const gate = browserGate(win);
  const decision = decideMode(native, gate, given);
  if (decision.refusal) return refuse(win, given, native, decision.refusal);
  const { mode, notes, warning } = stepAside(native, decision);
  if (warning) /** @type {Window & typeof globalThis} */ (win).console.warn(`[hic-live-polyfill] ${warning}`);
  // phones and tablets get their own surface budgets where the page did not choose (options.js MOBILE_BUDGETS)
  const resolved = withDeviceBudgets(given, options, gate, /** @type {any} */ (win).navigator?.deviceMemory);
  if (mode !== 'native-bridged') return build(win, doc, resolved, native, mode, services, notes);
  try {
    return build(win, doc, resolved, native, mode, services, notes);
  } catch (err) {
    // the bridge met a native shape it cannot patch: build() already undid every step; the native implementation is used as found
    return build(win, doc, resolved, native, 'native', services, [...notes, `the native bridge failed (${err}) and was removed; the native implementation is used as found`]);
  }
}

/**
 * The final mode over a usable native implementation, and what to record about it. Never throws: a usable native is used as found.
 * @param {NativeState} native
 * @param {ModeDecision} decision
 * @returns {{mode: HicMode, notes: string[], warning: string|null}}  notes go to report().deviations (native-step-aside); warning is printed once
 */
function stepAside(native, decision) {
  /** @type {string[]} */ const notes = [];
  /** @type {string[]} */ const warnings = [];
  let mode = decision.mode;
  if (decision.notice) { notes.push(decision.notice); warnings.push(decision.notice); }
  if (mode === 'native-bridged' && !(/** @type {any} */ (globalThis))[EXT.NATIVE_BRIDGE_KEY]) {
    mode = 'native';
    const bridge = 'load hic-live-native-bridge.iife.min.js before the core (ESM: import the /native-bridge subpath first)';
    if (native.kind === 'legacy') {
      const legacy = `this browser implements the earlier layoutsubtree draft of HTML-in-Canvas and is used as found: content="drawable" canvases are not drawable here. To bridge them, ${bridge}`;
      notes.push(legacy);
      warnings.push(legacy);
    } else {
      notes.push(`the native implementation lacks ${native.gaps.join(', ')} and is used as found. To add them, ${bridge}`);
    }
  }
  if (nativeUsable(native) && !native.verified) notes.push(`the drawElementImage probe gave "${native.probe}"; the native implementation is used as found`);
  return { mode, notes, warning: warnings.length ? warnings.join(' ') : null };
}

/**
 * A snapshot pipeline that keeps committing with nothing asking for it (store/runaway.js) is reported loudly (console.error once, report entry 'runaway', `hicunsupported` on every canvas),
 * then the polyfill removes itself: layers unmount, the page is no longer driven by it. Deferred one task: the signal comes from inside a commit.
 * @param {HicEnv} env @param {() => void} uninstall @returns {() => void} remover
 */
function onRunaway(env, uninstall) {
  return env.bus.on(BUS.RUNAWAY, ({ commits, windowMs }) => {
    const entry = {
      feature: 'runaway', message: `the snapshot pipeline committed ${commits} times in ${windowMs} ms with nothing on the page asking for it; the polyfill uninstalled itself`,
      hint: 'canvases keep their last bitmap and their children are plain canvas fallback content again; installed.report() lists this entry; please report the page as a bug',
    };
    const canvases = env.registry.all().map((r) => r.canvas);
    for (const canvas of canvases.length ? canvases : [undefined]) env.reporter.unsupported(entry, canvas);
    env.window.setTimeout(uninstall, 0);
  });
}

/**
 * @param {Window} win
 * @param {Readonly<ResolvedOptions>} options
 * @param {NativeState} native
 * @param {NonNullable<ModeDecision['refusal']>} refusal
 * @returns {HicInstalled}
 */
function refuse(win, options, native, refusal) {
  const error = new HicUnsupportedError(refusal.feature, refusal.message, { hint: refusal.hint });
  if (options.onUnsupportedBrowser === 'throw') throw error;
  if (!warned.has(win)) {
    warned.add(win);
    /** @type {Window & typeof globalThis} */ (win).console.warn(`[hic-live-polyfill] not installed (${refusal.feature}): ${refusal.message}. Hint: ${refusal.hint}`);
  }
  const report = () => ({
    version: VERSION, mode: /** @type {HicMode} */ ('refused'), native,
    browser: { userAgent: win.navigator.userAgent, major: native.browserMajor, dpr: win.devicePixelRatio },
    canvases: [], unsupported: [{ feature: refusal.feature, message: refusal.message, hint: refusal.hint, t: win.performance.now(), count: 1 }],
    deviations: [], errors: [],
  });
  return {
    version: VERSION, mode: 'refused', native, options, report, canvases: () => [],
    whenPainted: () => Promise.reject(new (/** @type {Window & typeof globalThis} */ (win)).DOMException('the polyfill is not installed in this browser', 'InvalidStateError')),
    adopt() {}, adoptRoot() {}, uninstall() {},
  };
}

/**
 * @param {Window} win
 * @param {Document} doc
 * @param {Readonly<ResolvedOptions>} options
 * @param {NativeState} native
 * @param {HicMode} mode  'native' | 'native-bridged' | 'polyfill'
 * @param {Services} services
 * @param {string[]} [notes]  why a usable native was used as found (report().deviations, id native-step-aside)
 * @returns {HicInstalled}
 */
function build(win, doc, options, native, mode, services, notes = []) {
  /** @type {import('../contracts/types.js').Reporter|null} */
  let reporter = null;
  const bus = createBus((err, topic) => reporter?.caught(err, `bus:${topic}`));
  reporter = createReporter(win, options);
  const env = createEnv(win, options, bus, reporter, doc);
  const ledger = createPatchLedger(win);
  if (notes.length) env.reporter.deviation('native-step-aside', notes.join(' | '));
  /** @type {Array<() => void>} inverses, in the order the steps ran */
  const undo = [];
  let uninstalled = false;

  const uninstall = () => {
    if (uninstalled) return;
    uninstalled = true;
    delete (/** @type {any} */ (win))[SLOT];
    for (const step of undo.reverse()) {
      try { step(); } catch (err) { env.reporter.caught(err, 'uninstall'); }
    }
    const left = ledger.restoreAll();
    if (left.length) env.reporter.caught(new Error(`left alone because another script re-patched them: ${left.join(', ')}`), 'uninstall.ledger');
    bus.clear();
  };

  /** @type {{adoptRoot: (root: ShadowRoot) => void}} */
  let adoption = { adoptRoot() {} };
  /** @type {import('../contracts/types.js').EffectsSeam} */
  let seam;
  try {
    seam = mode === 'polyfill' ? installPolyfill(env, services, ledger, undo, (a) => { adoption = a; }) : installNative(env, native, mode, services, ledger, undo, (a) => { adoption = a; });
  } catch (err) {
    uninstall();
    throw err;
  }
  if (mode === 'polyfill') undo.push(onRunaway(env, uninstall));
  Object.seal(env);

  const installed = makeInstalled(env, native, mode, options, uninstall, adoption);
  Object.defineProperty(installed, EXT.EFFECTS_SEAM_KEY, { value: seam });
  Object.defineProperty(win, SLOT, { value: installed, configurable: true, enumerable: false, writable: false });
  return installed;
}

/**
 * @param {HicEnv} env
 * @param {Services} services
 * @param {import('../contracts/types.js').PatchLedger} ledger
 * @param {Array<() => void>} undo
 * @param {(a: {adoptRoot: (root: ShadowRoot) => void}) => void} setAdoption
 * @returns {import('../contracts/types.js').EffectsSeam}
 */
function installPolyfill(env, services, ledger, undo, setAdoption) {
  const win = env.window;
  const composed = compose(env, services, createSchedulerHooks(env), ledger);
  undo.push(composed.dispose);
  undo.push(() => disposeHandlers(env));
  const geometry = composed.geometry;

  defineEventGlobals(win, ledger);
  defineElementImageGlobal(win, ledger);
  installOffscreenPatches(env, ledger, geometry);
  installCanvasPatches(env, ledger, geometry);
  installContext2DPatches(env, ledger, geometry);
  const lateGpu = installGpu(env, ledger);
  undo.push(installFullscreenGuard(env, ledger));
  installWorkerGuard(env, ledger, geometry);
  installDevicePixelBox(env, ledger);
  undo.push(watchCsp(env));

  setAdoption({ adoptRoot: (root) => env.roots.adopt(root) });
  if (env.options.autoDiscover) {
    composed.registry.scan(env.document);
    for (const root of env.roots.roots()) if (root !== env.document) composed.registry.scan(root);
  }
  // a GPU bundle loaded after the core replaces the element-texture stubs through this hook (gpu-seam.js)
  Object.defineProperty(composed.effects, GPU_LATE_KEY, { value: lateGpu });
  return composed.effects;
}

/**
 * @param {HicEnv} env
 * @param {NativeState} native
 * @param {HicMode} mode
 * @param {Services} services
 * @param {import('../contracts/types.js').PatchLedger} ledger
 * @param {Array<() => void>} undo
 * @param {(a: {adoptRoot: (root: ShadowRoot) => void}) => void} setAdoption
 * @returns {import('../contracts/types.js').EffectsSeam}
 */
function installNative(env, native, mode, services, ledger, undo, setAdoption) {
  const composed = composeNative(env, services);
  undo.push(composed.dispose);
  if (mode === 'native-bridged') {
    const bridge = (/** @type {any} */ (globalThis))[EXT.NATIVE_BRIDGE_KEY].install(env, native, ledger);
    undo.push(bridge.dispose);
    setAdoption(bridge);
  }
  // a native build in an engine without the device-pixel ResizeObserver box (Safari Technology Preview with its HTML-in-Canvas feature) would make the
  // explainer's own sizing line throw: completed as in mode polyfill (feature-detected: nothing is patched where the engine has it; ledger-restored)
  installDevicePixelBox(env, ledger);
  return composed.effects;
}

/**
 * @param {HicEnv} env
 * @param {NativeState} native
 * @param {HicMode} mode
 * @param {Readonly<ResolvedOptions>} options
 * @param {() => void} uninstall
 * @param {{adoptRoot: (root: ShadowRoot) => void}} adoption
 * @returns {HicInstalled}
 */
function makeInstalled(env, native, mode, options, uninstall, adoption) {
  const win = /** @type {Window & typeof globalThis} */ (env.window);
  /** @param {unknown} canvas */
  const assertCanvas = (canvas) => {
    if (!canvas || /** @type {Node} */ (canvas).nodeType !== 1 || /** @type {Element} */ (canvas).localName !== 'canvas') throw new TypeError('expected an HTMLCanvasElement');
  };
  return {
    version: VERSION, mode, native, options,
    report: () => buildReport(env, { version: VERSION, mode, native }),
    canvases: () => env.registry.all().filter((r) => r.state !== 'detached' && r.state !== 'disposed').map((r) => r.canvas),
    whenPainted(canvas, timeoutMs = 5000) {
      assertCanvas(canvas);
      if (env.registry.get(canvas)?.paint.everFired) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const finish = (/** @type {() => void} */ settle) => { win.clearTimeout(timer); canvas.removeEventListener('paint', onPaint); settle(); };
        const onPaint = () => finish(resolve);
        const timer = win.setTimeout(() => finish(() => reject(new win.DOMException(`no paint event within ${timeoutMs} ms`, 'TimeoutError'))), timeoutMs);
        canvas.addEventListener('paint', onPaint);
      });
    },
    adopt(canvas) { assertCanvas(canvas); env.adopt(canvas); },
    adoptRoot(root) {
      if (!root || root.nodeType !== 11) throw new TypeError('adoptRoot expects a ShadowRoot');
      adoption.adoptRoot(root);
    },
    uninstall,
  };
}
