/**
 * Running CSS/Web animations and transitions inside drawables -> continuous damage at the cap; a script change of an animation's timing -> one damage.
 * Module: schedule (src/schedule/observers/*).
 */

import { createDamageBatch, getRectMemory } from './damage-rect.js';

/** @typedef {import('../../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../../contracts/types.js').PatchLedger} PatchLedger */

/** @type {WeakMap<HicEnv, Set<(target: Element, timing: boolean) => void>>} listeners of script-started and script-retimed animations, per install */
const scriptListeners = new WeakMap();

/**
 * Subscribe to Web Animations started by script (element.animate(), animation.play(): `timing` false) and to script changes of an animation's timing, whatever its
 * play state (a seek, pause(), finish(), cancel(), reverse(), a playback rate, an effect edit: `timing` true). Neither fires an event, so the hooks of
 * installAnimationHooks report them.
 * @param {HicEnv} env @param {(target: Element, timing: boolean) => void} fn @returns {() => void}
 */
export function onScriptAnimation(env, fn) {
  let set = scriptListeners.get(env);
  if (!set) scriptListeners.set(env, (set = new Set()));
  const own = set;
  own.add(fn);
  return () => { own.delete(fn); };
}

/** Animation methods and setters that change its timing: reported only when the call changed the play state, the current time or the rate. */
const TIMING = ['pause', 'finish', 'cancel', 'reverse', 'updatePlaybackRate', 'currentTime', 'startTime', 'playbackRate'];

/** @param {any} animation @returns {string} compared before and after a timing call (a scroll timeline answers a fresh CSSUnitValue per read: compared as text) */
const timingOf = (animation) => `${animation.playState} ${String(animation.currentTime)} ${animation.playbackRate}`;

/**
 * Wrap Element.prototype.animate and Animation.prototype.play (through the install's ledger, restored on uninstall) to report the animated element to onScriptAnimation
 * listeners. No getAnimations() poll: no idle cost, no delay.
 * A paused, finished or idle animation is not followed by the frame-hook loop, yet a script that seeks or retimes it changes its target's rendering (natively the paint
 * event fires): the timing methods and setters of Animation are wrapped too, and report the target as retimed when the call changed the play state, the current time or
 * the rate (a seek to the current time reports nothing), as are the effect edits (AnimationEffect.updateTiming, KeyframeEffect.setKeyframes, the target and effect
 * setters: both the old and the new target), which are always reported. One wrapper call per call, nothing per frame.
 * @param {HicEnv} env @param {PatchLedger} ledger @returns {() => void}
 */
export function installAnimationHooks(env, ledger) {
  const win = /** @type {any} */ (env.window);
  const report = (/** @type {unknown} */ target, timing = false) => {
    if (!(target instanceof win.Element)) return;
    for (const fn of [...(scriptListeners.get(env) ?? [])]) {
      try { fn(/** @type {Element} */ (target), timing); } catch (err) { env.reporter.caught(err, 'animation.script-hook'); }
    }
  };
  const after = (/** @type {Function} */ original, /** @type {(self: any, result: any) => unknown} */ targetOf) => /** @this {any} */ function (/** @type {any[]} */ ...args) {
    const result = Reflect.apply(original, this, args);
    try { report(targetOf(this, result)); } catch { /* reporting never breaks the call */ }
    return result;
  };
  /** @param {(self: any) => unknown} read @returns {(self: any) => unknown} read, undefined where it throws (not an Animation or effect: the call throws natively) */
  const safe = (read) => (self) => { try { return read(self); } catch { return undefined; } };
  /** @type {(self: any, call: () => unknown) => unknown} a timing method or setter */
  const seek = (self, call) => {
    const before = safe(timingOf)(self);
    const result = call();
    if (before !== undefined && safe(timingOf)(self) !== before) report(safe((a) => a.effect?.target)(self), true);
    return result;
  };
  /** @param {(self: any) => unknown} targetOf @returns {typeof seek} an effect edit: the old and the new target */
  const edit = (targetOf) => (self, call) => {
    const old = safe(targetOf)(self);
    const result = call();
    for (const target of new Set([old, safe(targetOf)(self)])) report(target, true);
    return result;
  };
  /** wrap the method, or else the setter, `key` of `proto` where it exists @param {any} proto @param {string} key @param {typeof seek} around */
  const patch = (proto, key, around) => {
    const d = proto && Object.getOwnPropertyDescriptor(proto, key);
    if (typeof d?.value === 'function') ledger.wrap(proto, key, (original) => /** @this {any} */ function (/** @type {unknown[]} */ ...args) { return around(this, () => Reflect.apply(original, this, args)); });
    else if (d?.set) ledger.define(proto, key, { ...d, set: /** @this {any} */ function (/** @type {unknown} */ value) { around(this, () => d.set?.call(this, value)); } });
  };
  try {
    const anim = win.Animation?.prototype;
    if (typeof win.Element?.prototype?.animate === 'function') ledger.wrap(win.Element.prototype, 'animate', (original) => after(original, (self) => self));
    if (typeof anim?.play === 'function') ledger.wrap(anim, 'play', (original) => after(original, (self) => self.effect?.target));
    for (const key of TIMING) patch(anim, key, seek);
    patch(anim, 'effect', edit((self) => self.effect?.target));
    patch(win.AnimationEffect?.prototype, 'updateTiming', edit((self) => self.target));
    for (const key of ['setKeyframes', 'target']) patch(win.KeyframeEffect?.prototype, key, edit((self) => self.target));
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
 * A script change of an animation's timing (a paused animation seeked by a scrubber) is reported by the same hooks: the retimed targets of one task are damaged once, one
 * microtask later (after the script's synchronous work, like a MutationObserver callback), whatever their play state; a target the running loop follows is left to its next tick.
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
  /** @type {Set<Element>} targets whose animation timing script changed in this task */
  const retimed = new Set();
  let stopped = false;

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

  function flushRetimed() {
    if (stopped) return;
    // a retime may start the animation (startTime, reverse(), a seek back into a finished one): the loop takes it; a target the loop follows is damaged at its next due tick
    start();
    damage([...retimed].filter((el) => root.contains(el) && !(removeHook && lastTargets.has(el))));
    retimed.clear();
  }

  const onStart = () => start();
  for (const type of START_EVENTS) root.addEventListener(type, onStart, { capture: true, passive: true });
  const offScript = onScriptAnimation(env, (target, timing) => {
    if (!root.contains(target)) return;
    if (timing && !retimed.size) queueMicrotask(flushRetimed);
    if (timing) retimed.add(target); else start();
  });
  start();

  return () => {
    for (const type of START_EVENTS) root.removeEventListener(type, onStart, { capture: true });
    offScript();
    stopped = true;
    stop();
  };
}
