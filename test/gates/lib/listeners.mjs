// Listener / observer / timer audit of the polyfill. Two independent instruments, both attribute work to the polyfill by its script URL:
//   TRACKER   installed before any page script (Page.addScriptToEvaluateOnNewDocument): wraps EventTarget.add/removeEventListener, MutationObserver, ResizeObserver,
//             IntersectionObserver, setInterval and requestAnimationFrame and records what code whose stack names the bundle registered, on ANY target (MediaQueryList,
//             visualViewport, FontFaceSet, shadow-root elements, ...).
//   DEBUGGER  DOMDebugger.getEventListeners on window, document (pierce:true, depth -1: every element, shadow roots and iframes), visualViewport, screen, document.fonts
//             and every target the tracker saw: the browser's own list, attributed by the script URL of the listener function (Debugger.scriptParsed).
// The audit is run with the effect host off, with the effect host on, and AFTER uninstall (zero listeners, active observers or intervals may remain).
import { H } from './gate.mjs';

/** Script names that count as the polyfill: the core bundle and the optional effects/water bundles (docs/BUNDLES.md), so the effect host's listeners stay audited. */
const MARK = /hic-live-(polyfill|effects)/;

export const TRACKER_SRC = `(() => {
  if (window.__trk) return;
  const T = window.__trk = { listeners: [], observers: [], intervals: new Map(), raf: { registered: 0, fired: 0 }, targets: new Set(), mqls: [] };
  const mine = () => ${MARK}.test(new Error().stack || '');
  const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (fn && mine()) {
      const o = typeof opts === 'object' && opts ? opts : { capture: !!opts };
      T.listeners.push({ target: this, type, fn, capture: !!o.capture, passive: o.passive === true, once: !!o.once, removed: false, tag: this === window ? 'window' : this === document ? 'document' : (this.localName || this.constructor.name) });
      T.targets.add(this);
    }
    return add.call(this, type, fn, opts);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, opts) {
    const cap = typeof opts === 'object' && opts ? !!opts.capture : !!opts;
    for (const l of T.listeners) if (!l.removed && l.target === this && l.type === type && l.fn === fn && l.capture === cap) { l.removed = true; break; }
    return rem.call(this, type, fn, opts);
  };
  for (const name of ['MutationObserver', 'ResizeObserver', 'IntersectionObserver']) {
    const C = window[name]; if (!C) continue;
    const W = function (...a) { const o = new C(...a); if (mine()) { const rec = { name, active: false, observed: 0 }; T.observers.push(rec); const ob = o.observe.bind(o), dc = o.disconnect.bind(o);
      o.observe = (...b) => { rec.active = true; rec.observed++; return ob(...b); }; o.disconnect = () => { rec.active = false; return dc(); }; } return o; };
    W.prototype = C.prototype; Object.defineProperty(window, name, { value: W, writable: true, configurable: true });
  }
  const si = window.setInterval, ci = window.clearInterval;
  window.setInterval = function (fn, ms, ...a) { const id = si.call(this, fn, ms, ...a); if (mine()) T.intervals.set(id, ms); return id; };
  window.clearInterval = function (id) { T.intervals.delete(id); return ci.call(this, id); };
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) { if (mine()) { T.raf.registered++; const w = (t) => { T.raf.fired++; return cb(t); }; return raf.call(this, w); } return raf.call(this, cb); };
  const mm = window.matchMedia; window.matchMedia = function (q) { const r = mm.call(this, q); if (mine()) { T.mqls.push(r); T.targets.add(r); } return r; };
})()`;

export const TYPES_FORBIDDEN_ALWAYS = new Set(['wheel', 'mousewheel', 'DOMMouseScroll', 'touchstart', 'touchmove', 'touchend', 'touchcancel']);

/** Tracker state as plain data. `live` = attributed listeners that were not removed (once-listeners excluded: they remove themselves). */
export function readTracker(page) {
  return page.evaluate(`(() => { const T = window.__trk; if (!T) return null;
    const live = T.listeners.filter((l) => !l.removed && !l.once).map((l) => ({ tag: l.tag, type: l.type, capture: l.capture, passive: l.passive }));
    return { live, total: T.listeners.length, observers: T.observers.filter((o) => o.active).map((o) => o.name), observersTotal: T.observers.length, intervals: [...T.intervals.values()], raf: { ...T.raf } }; })()`);
}

/** Targets for DOMDebugger: everything that can hold a listener, as a JS array in the page (no per-element round trips for the DOM tree: document + pierce). */
const TARGETS = `(() => [window, document, window.visualViewport, screen, document.fonts, ...(window.__trk ? [...window.__trk.targets] : [])].filter(Boolean))()`;

/** Browser-side listener list attributed to the polyfill by script URL. @returns {Promise<{total:number, found:object[]}>} */
export async function debuggerAudit(page, urls) {
  const found = [];
  const collect = (ls, where) => { for (const l of ls) { const url = urls.get(l.scriptId) ?? ''; found.push({ type: l.type, passive: l.passive, capture: l.useCapture, url, where, poly: MARK.test(url) }); } };
  const { result: arr } = await page.send('Runtime.evaluate', { expression: TARGETS, returnByValue: false });
  const { result: props } = await page.send('Runtime.getProperties', { objectId: arr.objectId, ownProperties: true });
  for (const p of props.filter((q) => /^\d+$/.test(q.name) && q.value?.objectId)) {
    try { const { listeners } = await page.send('DOMDebugger.getEventListeners', { objectId: p.value.objectId, depth: 0, pierce: false }); collect(listeners, p.value.description?.slice(0, 30) ?? p.value.className); } catch { /* not a listener target */ }
  }
  const { result: doc } = await page.send('Runtime.evaluate', { expression: 'document', returnByValue: false });
  try { const { listeners } = await page.send('DOMDebugger.getEventListeners', { objectId: doc.objectId, depth: -1, pierce: true }); collect(listeners, 'document-tree'); } catch { /* no DOM listeners */ }
  return { total: found.length, found };
}

const keyOf = (f) => `${f.type}${f.passive ? ':passive' : ''}${f.capture ? ':capture' : ''}`;

/** Page with the tracker and the script-URL map ready. */
export async function openAuditPage(ctx) {
  const page = await ctx.page();
  const urls = new Map();
  await page.send('Debugger.enable');
  page.on('Debugger.scriptParsed', (p) => urls.set(p.scriptId, p.url || ''));
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: TRACKER_SRC });
  return { page, urls };
}

/**
 * Audit and check one state. `effectHost` relaxes only pointermove (the interposer's capture listeners, by design).
 * @returns {Promise<{tracker:object, poly:object[], byType:object}>}
 */
export async function checkListenerState(ctx, { page, urls, label, effectHost = false, numbers }) {
  const a = await debuggerAudit(page, urls);
  const tr = await readTracker(page);
  const poly = a.found.filter((f) => f.poly);
  const byType = {};
  for (const f of poly) byType[keyOf(f)] = (byType[keyOf(f)] ?? 0) + 1;
  numbers[label] = { debuggerPolyfillListeners: poly.length, trackerLive: tr.live.length, byType, observers: tr.observers, intervals: tr.intervals };
  ctx.check(`${label}: the audit sees polyfill listeners (not vacuous: debugger ${poly.length}, tracker ${tr.live.length})`, poly.length > 0 && tr.live.length > 0, { scripts: [...new Set(a.found.map((f) => f.url))].slice(0, 5) }, 'audit');
  const badType = (f) => TYPES_FORBIDDEN_ALWAYS.has(f.type) || (f.type === 'pointermove' && !effectHost) || (f.type === 'scroll' && !f.passive);
  const bad = poly.filter(badType);
  ctx.check(`${label}: the polyfill registers no wheel / touch / non-passive scroll${effectHost ? '' : ' / pointermove'} listener (debugger view, all targets incl. shadow roots, visualViewport, screen, fonts, media queries)`, bad.length === 0, bad.slice(0, 5), 'forbidden');
  const badT = tr.live.filter((l) => TYPES_FORBIDDEN_ALWAYS.has(l.type) || (l.type === 'pointermove' && !effectHost) || (l.type === 'scroll' && !l.passive));
  ctx.check(`${label}: ... and the registration tracker agrees (no forbidden listener was ever added and left)`, badT.length === 0, badT.slice(0, 5), 'forbidden');
  return { tracker: tr, poly, byType };
}

/** After uninstall: zero polyfill listeners (debugger and tracker), zero active observers and intervals, and no polyfill rAF callback keeps firing. */
export async function checkClean(ctx, { page, urls, label, numbers }) {
  const r0 = (await readTracker(page)).raf.fired;
  await H.sleep(1000);
  const a = await debuggerAudit(page, urls);
  const tr = await readTracker(page);
  const poly = a.found.filter((f) => f.poly);
  numbers[label] = { debuggerPolyfillListeners: poly.length, trackerLive: tr.live, observers: tr.observers, intervals: tr.intervals, rafFiredAfter: tr.raf.fired - r0 };
  ctx.check(`${label}: zero listeners attributed to the bundle (debugger: ${poly.length}, tracker: ${tr.live.length})`, poly.length === 0 && tr.live.length === 0, { debugger: poly.slice(0, 4), tracker: tr.live.slice(0, 4) }, 'leftover');
  ctx.check(`${label}: no mutation / resize / intersection observer of the bundle is still observing, no interval is left`, tr.observers.length === 0 && tr.intervals.length === 0, { observers: tr.observers, intervals: tr.intervals }, 'leftover');
  ctx.check(`${label}: no polyfill requestAnimationFrame callback fires in the second after uninstall`, tr.raf.fired - r0 <= 2, { fired: tr.raf.fired - r0 }, 'leftover');
}
