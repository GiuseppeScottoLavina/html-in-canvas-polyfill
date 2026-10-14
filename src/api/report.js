/**
 * Reporter (loud-failure sink), HicReport builder and the CSP violation watcher.
 * Module: api-core.
 */

import { EVENTS } from '../contracts/events.js';
import { createOnceLog } from '../util/once-log.js';

/** @typedef {import('../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').HicMode} HicMode */
/** @typedef {import('../contracts/types.js').HicReport} HicReport */
/** @typedef {import('../contracts/types.js').NativeState} NativeState */
/** @typedef {import('../contracts/types.js').Reporter} Reporter */
/** @typedef {import('../contracts/types.js').ResolvedOptions} ResolvedOptions */
/** @typedef {import('../contracts/types.js').UnsupportedEntry} UnsupportedEntry */

const MAX_ERRORS = 100;

/**
 * What buildReport needs beyond the public Reporter interface.
 * @typedef {Object} ReporterState
 * @property {() => HicReport['deviations']} deviations
 * @property {() => HicReport['errors']} errors
 * @property {(canvas: HTMLCanvasElement) => UnsupportedEntry[]} entriesFor
 */

/** @type {WeakMap<Reporter, ReporterState>} */
const states = new WeakMap();

/** @param {string} feature @param {string|undefined} path */
const keyOf = (feature, path) => `${feature}\u0000${path ?? ''}`;

/** @param {{feature: string, message: string, hint?: string, path?: string}} e */
function formatEntry(e) {
  return `[hic-live-polyfill] unsupported ${e.feature}${e.path ? ` at ${e.path}` : ''}: ${e.message}${e.hint ? ` Hint: ${e.hint}` : ''}`;
}

/**
 * console.error ONCE per (feature,path) via util/once-log, CustomEvent hicunsupported on the canvas (once per feature/path/canvas; later hits only raise the count), report entries, deviation and caught-error recording.
 * @param {Window} win
 * @param {ResolvedOptions} _options
 * @returns {Reporter}
 */
export function createReporter(win, _options) {
  const w = /** @type {Window & typeof globalThis} */ (win);
  const log = createOnceLog(w.console);
  const now = () => w.performance.now();
  /** @type {Map<string, UnsupportedEntry>} */
  const entries = new Map();
  /** @type {WeakMap<HTMLCanvasElement, Map<string, UnsupportedEntry>>} */
  const perCanvas = new WeakMap();
  /** @type {Map<string, {id: string, detail: string, count: number}>} */
  const deviations = new Map();
  /** @type {HicReport['errors']} */
  const errors = [];

  /** @param {Map<string, UnsupportedEntry>} map @param {string} key @param {Omit<UnsupportedEntry,'t'|'count'>} src @returns {UnsupportedEntry} */
  function bump(map, key, src) {
    let e = map.get(key);
    if (!e) {
      e = { feature: src.feature, message: src.message, t: now(), count: 0 };
      if (src.hint !== undefined) e.hint = src.hint;
      if (src.path !== undefined) e.path = src.path;
      map.set(key, e);
    }
    e.count++;
    return e;
  }

  /** @type {Reporter} */
  const reporter = {
    unsupported(entry, canvas) {
      const key = keyOf(entry.feature, entry.path);
      bump(entries, key, entry);
      log.once(`unsupported:${key}`, 'error', formatEntry(entry));
      if (!canvas) return;
      let own = perCanvas.get(canvas);
      if (!own) perCanvas.set(canvas, (own = new Map()));
      const first = !own.has(key);
      const e = bump(own, key, entry);
      if (!first) return;
      try {
        canvas.dispatchEvent(new w.CustomEvent(EVENTS.UNSUPPORTED, { detail: { ...e }, bubbles: false }));
      } catch (err) { reporter.caught(err, 'reporter.dispatch'); }
    },
    deviation(id, detail = '') {
      const d = deviations.get(id);
      if (d) d.count++;
      else deviations.set(id, { id, detail, count: 1 });
    },
    caught(err, where) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (errors.length < MAX_ERRORS) errors.push({ name: where, message: `${e.name}: ${e.message}`, t: now() });
      log.once(`caught:${where}:${e.message}`, 'error', `[hic-live-polyfill] internal error in ${where}:`, err);
    },
    entries: () => [...entries.values()].map((e) => ({ ...e })),
  };
  states.set(reporter, {
    deviations: () => [...deviations.values()].map((d) => ({ ...d })),
    errors: () => errors.map((e) => ({ ...e })),
    entriesFor: (canvas) => [...(perCanvas.get(canvas)?.values() ?? [])].map((e) => ({ ...e })),
  });
  return reporter;
}

/** @template T @param {() => T} fn @param {T} fallback @returns {T} a report must never throw, whatever state the install is in */
function safely(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

/** @param {HicEnv} env @param {CanvasRecord} record @param {ReporterState|undefined} state @returns {HicReport['canvases'][number]} */
function canvasEntry(env, record, state) {
  const stats = {
    paintSerial: record.paint.serial,
    paintFired: record.paint.everFired,
    dpr: record.dpr,
    contentBox: { ...record.contentBox },
    legacy: record.legacy,
    snapshot: safely(() => env.store.stats(), null),
    scheduler: safely(() => env.scheduler.stats(), null),
  };
  return {
    id: record.id,
    state: record.state,
    drawables: safely(() => record.layer?.drawableElements().length ?? 0, 0),
    frameCap: record.frameCap,
    unsupported: state?.entriesFor(record.canvas) ?? [],
    stats,
  };
}

/**
 * Assemble the JSON-able HicReport (docs/API-CONTRACT.md section 9.1).
 * @param {HicEnv} env
 * @param {{version: string, mode: HicMode, native: NativeState}} info
 * @returns {HicReport}
 */
export function buildReport(env, info) {
  const state = states.get(env.reporter);
  const records = safely(() => env.registry.all(), /** @type {CanvasRecord[]} */ ([]));
  return {
    version: info.version,
    mode: info.mode,
    native: { ...info.native, present: [...info.native.present], missing: [...info.native.missing], legacyNames: [...info.native.legacyNames], gaps: [...info.native.gaps] },
    browser: { userAgent: env.window.navigator.userAgent, major: info.native.browserMajor, dpr: env.window.devicePixelRatio },
    canvases: records.map((r) => canvasEntry(env, r, state)),
    unsupported: env.reporter.entries(),
    deviations: state?.deviations() ?? [],
    errors: state?.errors() ?? [],
  };
}

/**
 * Report a CSP that blocks what every snapshot needs (`data:` images) or what `onpaint="..."` attributes need (eval), once, with a hint.
 * @param {HicEnv} env
 * @returns {() => void} remover
 */
export function watchCsp(env) {
  /** @param {SecurityPolicyViolationEvent} e */
  const onViolation = (e) => {
    const directive = e.effectiveDirective || e.violatedDirective || '';
    if (/^img-src/.test(directive) && /^data(:|$)/.test(e.blockedURI)) {
      env.reporter.unsupported({
        feature: 'csp-blocked', path: 'img-src', message: `the page CSP blocks data: images (${e.violatedDirective}); every snapshot is a data: SVG image, so no drawable can be decoded`,
        hint: "add data: to img-src, e.g. img-src 'self' data:",
      });
    } else if (/^script-src/.test(directive) && e.blockedURI === 'eval') {
      env.reporter.unsupported({
        feature: 'csp-blocked', path: 'script-src', message: `the page CSP blocks eval (${e.violatedDirective}); onpaint="..." attributes cannot be compiled`,
        hint: 'assign canvas.onpaint or use addEventListener("paint", ...) instead of the attribute, or allow script-src \'unsafe-eval\'',
      });
    }
  };
  const doc = env.document;
  doc.addEventListener('securitypolicyviolation', /** @type {EventListener} */ (onViolation));
  return () => doc.removeEventListener('securitypolicyviolation', /** @type {EventListener} */ (onViolation));
}
