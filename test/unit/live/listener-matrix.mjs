// The listener matrix (not a test file): every combination of a canvas listener's options, what its callback does and what happens to the canvas
// (remount, uninstall and install, abort, remove), run on a canvas of the real polyfill and on a native element with a child, and compared call by call.
// A canvas listener must behave as on that native element: the event of a relocated child and the event aimed at the canvas reach it as the child's
// event and the target's own event reach the native element. The three listener-matrix-*.browser.test.mjs files run its parts.
import { install } from '/src/index.js';
import { frames } from '/test/unit/lib/t.js';

export const OPTIONS = [];
for (const once of [false, true]) for (const capture of [false, true]) for (const passive of [false, true]) for (const signal of [false, true]) OPTIONS.push({ once, capture, passive, signal });

/** what the callback does with the event it gets */
export const BEHAVIOURS = ['none', 'stopImmediate', 'stop', 'nestChild', 'nestTarget', 'removeSelf', 'prevent', 'addAnother', 'handleEvent'];

/**
 * The canvas under the real polyfill, and its lifecycle steps; `native` has the same shape for the reference element, where the steps change nothing.
 * @param {any} t
 */
export async function setupPair(t) {
  let installed = install();
  const host = document.createElement('div');
  host.innerHTML = '<canvas content="drawable" width="200" height="100"><div id="lm-a" drawable style="width:100px;height:50px;background:red"><span id="lm-g">x</span></div></canvas>';
  const ref = document.createElement('div');
  ref.innerHTML = '<div><span>x</span></div>';
  document.body.append(host, ref);
  const canvas = /** @type {HTMLCanvasElement} */ (host.firstElementChild);
  t.cleanup(() => { installed.uninstall(); host.remove(); ref.remove(); });
  canvas.requestPaint();
  await installed.whenPainted(canvas);
  // mounted: the drawable child lives in the layer (its native parent is not the canvas); read natively, past the tree facade
  const nativeParent = /** @type {() => Node|null} */ (Object.getOwnPropertyDescriptor(Node.prototype, 'parentNode')?.get);
  const drawable = /** @type {Element} */ (canvas.querySelector('#lm-a'));
  const mounted = () => nativeParent.call(drawable) !== canvas;
  /** @param {boolean} want */
  const until = async (want) => { for (let i = 0; i < 20 && mounted() !== want; i++) { await Promise.resolve(); if (mounted() !== want) await frames(1); } if (mounted() !== want) throw new Error(`the canvas did not ${want ? 'mount' : 'unmount'}`); };
  await until(true);
  return {
    canvas: {
      target: canvas, child: /** @type {Element} */ (canvas.querySelector('#lm-g')),
      async remount() { canvas.setAttribute('content', 'fallback'); await until(false); canvas.setAttribute('content', 'drawable'); await until(true); },
      async unmount() { canvas.setAttribute('content', 'fallback'); await until(false); },
      async mount() { canvas.setAttribute('content', 'drawable'); await until(true); },
      async reinstall() { installed.uninstall(); if (mounted()) throw new Error('still mounted after uninstall'); installed = install(); await until(true); },
      async uninstall() { installed.uninstall(); if (mounted()) throw new Error('still mounted after uninstall'); },
      async install() { installed = install(); await until(true); },
    },
    native: { target: /** @type {Element} */ (ref.firstElementChild), child: /** @type {Element} */ (ref.querySelector('span')), async remount() {}, async reinstall() {}, async unmount() {}, async mount() {}, async uninstall() {}, async install() {} },
  };
}

let serial = 0;

/**
 * The part of a log compared with the native element. With the polyfill uninstalled until the last dispatch, everything up to that point is compared (the
 * canvas is then native and must behave exactly so); the last dispatch follows the restoration of the reinstall (event-bridge.js reregister), which the events
 * test holds with explicit expectations.
 * @param {string} life @param {string} log
 */
function comparable(life, log) {
  if (!life.includes('uninstall')) return log;
  const at = log.indexOf(' D2:');
  return at < 0 ? log : log.slice(0, log.indexOf(' ', at + 1) < 0 ? log.length : log.indexOf(' ', at + 1));
}

/**
 * One case on one side: the listener registered, the lifecycle step before the first dispatch ('pre') or after it ('mid'), four dispatches alternating
 * the child and the target. Returns the log: every call (which listener, the event's phase, currentTarget and `this` being the target) and every
 * dispatch (its return value, i.e. not cancelled).
 * @param {any} side @param {{once: boolean, capture: boolean, passive: boolean, signal: boolean}} o @param {string} behaviour
 * @param {string} life 'none' | 'remount' | 'reinstall' | 'abort' | 'remove' | 'remount+abort' | 'reinstall+remove' | 'unmount' (unmounted until the last dispatch,
 * so that some dispatches happen with the children back in the canvas) | 'unmount+abort' | 'uninstall' (uninstalled until the last dispatch) @param {'pre'|'mid'} at
 * @param {boolean} childFirst
 */
export async function runCase(side, o, behaviour, life, at, childFirst) {
  const type = `lm${++serial}`;
  const { target, child } = side;
  /** @type {string[]} */ const log = [];
  const ac = o.signal ? new AbortController() : null;
  let depth = 0;
  const other = function (/** @type {Event} */ ev) { log.push(`other:${ev.eventPhase}:${ev.currentTarget === target}`); };
  /** @type {any} */
  let listener;
  const body = function (/** @type {any} */ self, /** @type {Event} */ ev) {
    log.push(`L:${ev.eventPhase}:${ev.currentTarget === target}:${self === target || self === listener}`);
    if (depth > 0) return;
    depth++;
    try {
      if (behaviour === 'stopImmediate') ev.stopImmediatePropagation();
      else if (behaviour === 'stop') ev.stopPropagation();
      else if (behaviour === 'nestChild') log.push(`nested:${child.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))}`);
      else if (behaviour === 'nestTarget') log.push(`nested:${target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))}`);
      else if (behaviour === 'removeSelf') target.removeEventListener(type, listener, o.capture);
      else if (behaviour === 'prevent') ev.preventDefault();
      else if (behaviour === 'addAnother') target.addEventListener(type, other, { capture: o.capture });
    } finally { depth--; }
  };
  listener = behaviour === 'handleEvent' ? { handleEvent(/** @type {Event} */ ev) { body(this, ev); } } : function (/** @type {Event} */ ev) { body(this, ev); };
  target.addEventListener(type, listener, { once: o.once, capture: o.capture, passive: o.passive, ...(ac ? { signal: ac.signal } : {}) });
  const step = async () => {
    for (const part of life.split('+')) {
      if (part === 'remount') await side.remount();
      else if (part === 'reinstall') await side.reinstall();
      else if (part === 'unmount') await side.unmount();
      else if (part === 'uninstall') await side.uninstall();
      else if (part === 'abort') ac?.abort();
      else if (part === 'remove') target.removeEventListener(type, listener, o.capture);
    }
  };
  if (at === 'pre') await step();
  for (let i = 0; i < 4; i++) {
    if (at === 'mid' && i === 1) await step();
    if (i === 3 && life.includes('unmount')) await side.mount();
    if (i === 3 && life.includes('uninstall')) await side.install();
    const to = (i % 2 === 0) === childFirst ? child : target;
    log.push(`D${i}:${to === child ? 'child' : 'target'}:${to.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))}`);
  }
  target.removeEventListener(type, listener, o.capture);
  target.removeEventListener(type, other, o.capture);
  return log.join(' ');
}

/**
 * Run `cases` on both sides and return the divergences.
 * @param {any} pair @param {Array<{o: any, behaviour: string, life: string, at: 'pre'|'mid', childFirst: boolean}>} cases
 */
export async function divergences(pair, cases) {
  const out = [];
  let k = 0;
  for (const c of cases) {
    // let the page breathe: a run of cases without a lifecycle step has no await of its own
    if (++k % 50 === 0) await new Promise((r) => setTimeout(r));
    const native = await runCase(pair.native, c.o, c.behaviour, c.life, c.at, c.childFirst);
    const poly = await runCase(pair.canvas, c.o, c.behaviour, c.life, c.at, c.childFirst);
    if (comparable(c.life, native) !== comparable(c.life, poly)) out.push({ ...c, native, poly });
  }
  return out;
}

/** every combination for the lifecycle steps in `lives` (abort only with a signal) */
export function casesFor(/** @type {string[]} */ lives) {
  const cases = [];
  for (const o of OPTIONS) for (const behaviour of BEHAVIOURS) for (const life of lives) {
    if (life.includes('abort') && !o.signal) continue;
    for (const at of /** @type {const} */ (['pre', 'mid'])) for (const childFirst of [true, false]) cases.push({ o, behaviour, life, at, childFirst });
  }
  return cases;
}

/** a readable summary of divergences: counts per dimension and the first examples */
export function summary(/** @type {any[]} */ div, total) {
  if (!div.length) return `0 divergences in ${total} cases`;
  const by = (/** @type {(d: any) => string} */ f) => Object.entries(div.reduce((m, d) => ((m[f(d)] = (m[f(d)] ?? 0) + 1), m), /** @type {Record<string, number>} */ ({}))).map(([k, n]) => `${k}=${n}`).join(' ');
  const opt = (/** @type {any} */ o) => ['once', 'capture', 'passive', 'signal'].filter((k) => o[k]).join('+') || 'plain';
  return `${div.length} divergences in ${total} cases\n  by life: ${by((d) => d.life)}\n  by behaviour: ${by((d) => d.behaviour)}\n  by options: ${by((d) => opt(d.o))}\n  by at: ${by((d) => d.at)}  by order: ${by((d) => (d.childFirst ? 'child-first' : 'target-first'))}\n`
    + div.filter((d) => !globalThis.__LM_FILTER || globalThis.__LM_FILTER(d)).slice(0, globalThis.__LM_MAX ?? 12).map((d) => `  ${opt(d.o)} ${d.behaviour} ${d.life} ${d.at} ${d.childFirst ? 'child-first' : 'target-first'}\n    native: ${d.native}\n    canvas: ${d.poly}`).join('\n');
}

// ---- two listeners on the target: their order across the two routes, passive next to non-passive, and what the first does to the second ----------------

/** references to the native methods taken when this module loads, as a library loaded before the polyfill keeps them */
const NATIVE_PREVENT = Event.prototype.preventDefault;
const NATIVE_RETURN_VALUE_SET = /** @type {(this: Event, v: boolean) => void} */ (Object.getOwnPropertyDescriptor(Event.prototype, 'returnValue')?.set);

export const PAIR_OPTIONS = [];
for (const once of [false, true]) for (const capture of [false, true]) for (const passive of [false, true]) PAIR_OPTIONS.push({ once, capture, passive });
/** what the first listener does */
export const PAIR_BEHAVIOURS = ['none', 'prevent', 'preventProto', 'preventSaved', 'returnValue', 'returnValueSaved', 'stopImmediate', 'removeOther', 'nestChild'];

/**
 * Two listeners A then B registered on the target, the lifecycle step before the dispatches, four dispatches alternating the child and the target.
 * @param {any} side @param {any} a @param {any} b @param {string} behaviour @param {string} life @param {boolean} childFirst
 */
export async function runPair(side, a, b, behaviour, life, childFirst, who = 'A') {
  const type = `lp${++serial}`;
  const { target, child } = side;
  /** @type {string[]} */ const log = [];
  let depth = 0;
  /** @type {any} */ let A, B;
  const act = function (/** @type {string} */ name, /** @type {Event} */ ev) {
    log.push(`${name}:${ev.eventPhase}:${ev.defaultPrevented}`);
    if (name !== who || depth > 0) return;
    const otherFn = name === 'A' ? B : A, otherOpt = name === 'A' ? b : a;
    depth++;
    try {
      if (behaviour === 'prevent') ev.preventDefault();
      else if (behaviour === 'preventProto') Event.prototype.preventDefault.call(ev);
      else if (behaviour === 'preventSaved') NATIVE_PREVENT.call(ev);
      else if (behaviour === 'returnValue') ev.returnValue = false;
      else if (behaviour === 'returnValueSaved') NATIVE_RETURN_VALUE_SET.call(ev, false);
      else if (behaviour === 'stopImmediate') ev.stopImmediatePropagation();
      else if (behaviour === 'removeOther') target.removeEventListener(type, otherFn, otherOpt.capture);
      else if (behaviour === 'nestChild') log.push(`nested:${child.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))}`);
    } finally { depth--; }
  };
  A = (/** @type {Event} */ ev) => act('A', ev);
  B = (/** @type {Event} */ ev) => act('B', ev);
  target.addEventListener(type, A, a);
  target.addEventListener(type, B, b);
  for (const part of life.split('+')) { if (part === 'remount') await side.remount(); else if (part === 'reinstall') await side.reinstall(); else if (part === 'unmount') await side.unmount(); else if (part === 'uninstall') await side.uninstall(); }
  for (let i = 0; i < 4; i++) {
    if (i === 3 && life.includes('unmount')) await side.mount();
    if (i === 3 && life.includes('uninstall')) await side.install();
    const to = (i % 2 === 0) === childFirst ? child : target;
    log.push(`D${i}:${to === child ? 'child' : 'target'}:${to.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))}`);
  }
  target.removeEventListener(type, A, a.capture);
  target.removeEventListener(type, B, b.capture);
  return log.join(' ');
}

/** every pair of options, first-listener behaviour, lifecycle step in `lives` and order */
export function pairCasesFor(/** @type {string[]} */ lives) {
  const cases = [];
  for (const a of PAIR_OPTIONS) for (const b of PAIR_OPTIONS) for (const behaviour of PAIR_BEHAVIOURS) for (const who of ['A', 'B']) for (const life of lives) for (const childFirst of [true, false]) {
    if (who === 'B' && behaviour === 'none') continue;
    cases.push({ a, b, behaviour, who, life, childFirst });
  }
  return cases;
}

/** @param {any} pair @param {any[]} cases */
export async function pairDivergences(pair, cases) {
  const out = [];
  let k = 0;
  for (const c of cases) {
    // let the page breathe: a run of cases without a lifecycle step has no await of its own
    if (++k % 50 === 0) await new Promise((r) => setTimeout(r));
    const native = await runPair(pair.native, c.a, c.b, c.behaviour, c.life, c.childFirst, c.who);
    const poly = await runPair(pair.canvas, c.a, c.b, c.behaviour, c.life, c.childFirst, c.who);
    if (comparable(c.life, native) !== comparable(c.life, poly)) out.push({ ...c, native, poly });
  }
  return out;
}

/** @param {any[]} div @param {number} total */
export function pairSummary(div, total) {
  if (!div.length) return `0 divergences in ${total} cases`;
  const opt = (/** @type {any} */ o) => ['once', 'capture', 'passive'].filter((k) => o[k]).join('+') || 'plain';
  const by = (/** @type {(d: any) => string} */ f) => Object.entries(div.reduce((m, d) => ((m[f(d)] = (m[f(d)] ?? 0) + 1), m), /** @type {Record<string, number>} */ ({}))).map(([k, n]) => `${k}=${n}`).join(' ');
  return `${div.length} divergences in ${total} cases\n  by life: ${by((d) => d.life)}\n  by behaviour: ${by((d) => d.behaviour)}\n  by A: ${by((d) => opt(d.a))}\n  by B: ${by((d) => opt(d.b))}\n`
    + div.slice(0, 10).map((d) => `  A ${opt(d.a)} B ${opt(d.b)} ${d.who}:${d.behaviour} ${d.life} ${d.childFirst ? 'child-first' : 'target-first'}\n    native: ${d.native}\n    canvas: ${d.poly}`).join('\n');
}

// ---- the on* event handler property next to a listener: order (the handler sits where it was first set), return false, stopImmediatePropagation ----------

/** what the handler does */
export const HANDLER_BEHAVIOURS = ['none', 'returnFalse', 'stopImmediate', 'prevent', 'nestChild', 'clearSelf'];

/**
 * `target.onclick` and one listener (registered before or after the handler is set), the lifecycle step, four click dispatches alternating the child and the
 * target. The handler property is cleared at the end.
 * @param {any} side @param {any} o the listener's options @param {boolean} listenerFirst @param {string} behaviour @param {string} life @param {boolean} childFirst
 */
export async function runHandler(side, o, listenerFirst, behaviour, life, childFirst) {
  const { target, child } = side;
  /** @type {string[]} */ const log = [];
  let depth = 0;
  const L = function (/** @type {Event} */ ev) { log.push(`L:${ev.eventPhase}:${ev.defaultPrevented}`); };
  const H = function (/** @type {Event} */ ev) {
    log.push(`H:${ev.eventPhase}:${ev.currentTarget === target}`);
    if (depth > 0) return undefined;
    depth++;
    try {
      if (behaviour === 'returnFalse') return false;
      if (behaviour === 'stopImmediate') ev.stopImmediatePropagation();
      else if (behaviour === 'prevent') ev.preventDefault();
      else if (behaviour === 'nestChild') log.push(`nested:${child.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))}`);
      else if (behaviour === 'clearSelf') target.onclick = null;
    } finally { depth--; }
    return undefined;
  };
  if (listenerFirst) target.addEventListener('click', L, o);
  target.onclick = H;
  if (!listenerFirst) target.addEventListener('click', L, o);
  for (const part of life.split('+')) { if (part === 'remount') await side.remount(); else if (part === 'reinstall') await side.reinstall(); else if (part === 'unmount') await side.unmount(); else if (part === 'uninstall') await side.uninstall(); }
  for (let i = 0; i < 4; i++) {
    if (i === 3 && life.includes('unmount')) await side.mount();
    if (i === 3 && life.includes('uninstall')) await side.install();
    const to = (i % 2 === 0) === childFirst ? child : target;
    log.push(`D${i}:${to === child ? 'child' : 'target'}:${to.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))}`);
  }
  target.onclick = null;
  target.removeEventListener('click', L, o.capture);
  return log.join(' ');
}

/** @param {string[]} lives */
export function handlerCasesFor(lives) {
  const cases = [];
  for (const o of PAIR_OPTIONS) for (const listenerFirst of [true, false]) for (const behaviour of HANDLER_BEHAVIOURS) for (const life of lives) for (const childFirst of [true, false]) cases.push({ o, listenerFirst, behaviour, life, childFirst });
  return cases;
}

/** @param {any} pair @param {any[]} cases */
export async function handlerDivergences(pair, cases) {
  const out = [];
  let k = 0;
  for (const c of cases) {
    // let the page breathe: a run of cases without a lifecycle step has no await of its own
    if (++k % 50 === 0) await new Promise((r) => setTimeout(r));
    const native = await runHandler(pair.native, c.o, c.listenerFirst, c.behaviour, c.life, c.childFirst);
    const poly = await runHandler(pair.canvas, c.o, c.listenerFirst, c.behaviour, c.life, c.childFirst);
    if (comparable(c.life, native) !== comparable(c.life, poly)) out.push({ ...c, native, poly });
  }
  return out;
}

/** @param {any[]} div @param {number} total */
export function handlerSummary(div, total) {
  if (!div.length) return `0 divergences in ${total} cases`;
  const opt = (/** @type {any} */ o) => ['once', 'capture', 'passive'].filter((k) => o[k]).join('+') || 'plain';
  const by = (/** @type {(d: any) => string} */ f) => Object.entries(div.reduce((m, d) => ((m[f(d)] = (m[f(d)] ?? 0) + 1), m), /** @type {Record<string, number>} */ ({}))).map(([k, n]) => `${k}=${n}`).join(' ');
  return `${div.length} divergences in ${total} cases\n  by life: ${by((d) => d.life)}\n  by behaviour: ${by((d) => d.behaviour)}\n  by listener: ${by((d) => opt(d.o) + (d.listenerFirst ? ' first' : ' after'))}\n`
    + div.slice(0, 10).map((d) => `  L ${opt(d.o)} ${d.listenerFirst ? 'before' : 'after'} the handler, ${d.behaviour} ${d.life} ${d.childFirst ? 'child-first' : 'target-first'}\n    native: ${d.native}\n    canvas: ${d.poly}`).join('\n');
}
