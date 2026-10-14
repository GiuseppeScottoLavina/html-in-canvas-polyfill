/**
 * Running CSS/Web animations and transitions inside drawables -> continuous damage at the cap.
 * Module: schedule (src/schedule/observers/*).
 */

import { createDamageBatch, getRectMemory } from './damage-rect.js';

/** @typedef {import('../../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../../contracts/types.js').PatchLedger} PatchLedger */

/** @type {WeakMap<HicEnv, Set<(target: Element) => void>>} listeners of script-started animations, per install */
const scriptListeners = new WeakMap();

/**
 * Subscribe to Web Animations started by script (element.animate(), animation.play()): they fire no event, so the hooks of installAnimationHooks report them.
 * @param {HicEnv} env @param {(target: Element) => void} fn @returns {() => void}
 */
export function onScriptAnimation(env, fn) {
  let set = scriptListeners.get(env);
  if (!set) scriptListeners.set(env, (set = new Set()));
  const own = set;
  own.add(fn);
  return () => { own.delete(fn); };
}

/**
 * Wrap Element.prototype.animate and Animation.prototype.play (through the install's ledger, restored on uninstall) to report the animated element to onScriptAnimation
 * listeners. No getAnimations() poll: no idle cost, no delay.
 * @param {HicEnv} env @param {PatchLedger} ledger @returns {() => void}
 */
export function installAnimationHooks(env, ledger) {
  const win = /** @type {any} */ (env.window);
  const report = (/** @type {unknown} */ target) => {
    if (!(target instanceof win.Element)) return;
    for (const fn of [...(scriptListeners.get(env) ?? [])]) {
      try { fn(/** @type {Element} */ (target)); } catch (err) { env.reporter.caught(err, 'animation.script-hook'); }
    }
  };
  const after = (/** @type {Function} */ original, /** @type {(self: any, result: any) => unknown} */ targetOf) => /** @this {any} */ function (/** @type {any[]} */ ...args) {
    const result = Reflect.apply(original, this, args);
    try { report(targetOf(this, result)); } catch { /* reporting never breaks the call */ }
    return result;
  };
  try {
    if (typeof win.Element?.prototype?.animate === 'function') ledger.wrap(win.Element.prototype, 'animate', (original) => after(original, (self) => self));
    if (typeof win.Animation?.prototype?.play === 'function') ledger.wrap(win.Animation.prototype, 'play', (original) => after(original, (self) => self.effect?.target));
  } catch (err) {
    env.reporter.caught(err, 'animation.hooks');
  }
  return () => { scriptListeners.delete(env); };
}

const START_EVENTS = ['animationstart', 'transitionrun', 'transitionstart'];

/**
 * animationstart/transitionrun/end + document.getAnimations() polling only while any is running.
 * The clock is the scheduler: while animations run, a frame hook damages the targets of every running animation and asks for the next frame, so the page is painted at the frame cap and the
 * hook (like every hook) only works on ticks the cap allows. The tick after the last animation ended damages the targets once more (their final state), then the hook removes itself and the page is idle again.
 * Web Animations started with element.animate() or animation.play() fire no event: the script hook (installAnimationHooks) reports them at once.
 * @param {HicEnv} env
 * @param {CanvasRecord} record
 * @returns {() => void}
 */
export function observeAnimations(env, record) {
  const found = record.layer;
  if (!found || typeof found.element.getAnimations !== 'function') return () => {};
  const layer = found;
  const root = layer.element;
  const memory = getRectMemory(env);
  /** @type {(() => void)|null} */
  let removeHook = null;
  /** @type {Set<Element>} */
  let lastTargets = new Set();

  function running() {
    const targets = new Set();
    for (const animation of root.getAnimations({ subtree: true })) {
      const target = /** @type {KeyframeEffect|null} */ (animation.effect)?.target;
      if ((animation.playState === 'running' || animation.pending) && target) targets.add(target);
    }
    return targets;
  }

  /** @param {Iterable<Element>} targets */
  function damage(targets) {
    const batch = createDamageBatch();
    for (const target of targets) {
      const drawable = layer.nearestDrawable(target);
      if (drawable) batch.add(drawable, memory.reach(layer, target));
    }
    batch.flush((drawable, rect) => env.scheduler.damage(record, 'animation', drawable, rect));
  }

  /** @type {import('../../contracts/types.js').FrameHook} */
  function hook(_now, info) {
    if (!info.due) return true;
    const targets = running();
    const finished = [...lastTargets].filter((el) => !targets.has(el));
    damage(new Set([...targets, ...finished]));
    lastTargets = targets;
    if (targets.size) return true;
    stop();
    return false;
  }

  function stop() {
    removeHook?.();
    removeHook = null;
  }

  function start() {
    if (removeHook) return;
    const targets = running();
    if (!targets.size) return;
    removeHook = env.scheduler.addFrameHook(record, hook);
    lastTargets = targets;
    damage(targets);
  }

  const onStart = () => start();
  for (const type of START_EVENTS) root.addEventListener(type, onStart, { capture: true, passive: true });
  const offScript = onScriptAnimation(env, (target) => { if (root.contains(target)) start(); });
  start();

  return () => {
    for (const type of START_EVENTS) root.removeEventListener(type, onStart, { capture: true });
    offScript();
    stop();
  };
}
