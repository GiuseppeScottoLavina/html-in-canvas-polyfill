/**
 * Scheduler: damage sink, frame-end tick, paint dispatch, pump, frame hooks (docs/ARCHITECTURE.md ADR-C).
 * Module: schedule (src/schedule/**).
 */

import { BUS, EXT } from '../contracts/events.js';
import { clampFrameCap, createCapGate, effectiveFps, parseFrameCap } from './frame-cap.js';
import { createFramePhase } from './frame-phase.js';
import { createPaintGate } from './paint-gate.js';

/** @typedef {import('../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../contracts/types.js').ChangeSet} ChangeSet */
/** @typedef {import('../contracts/types.js').DamageCause} DamageCause */
/** @typedef {import('../contracts/types.js').FrameHook} FrameHook */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').PumpResult} PumpResult */
/** @typedef {import('../contracts/types.js').Rect} Rect */
/** @typedef {import('../contracts/types.js').Scheduler} Scheduler */
/** @typedef {import('../contracts/types.js').SchedulerHooks} SchedulerHooks */
/** @typedef {import('../contracts/types.js').SnapshotStore} SnapshotStore */

/**
 * @typedef {Object} Entry  everything the scheduler keeps per canvas
 * @property {CanvasRecord} record
 * @property {boolean} registered
 * @property {Set<FrameHook>} hooks
 * @property {boolean} dirty  damage or in-flight work may exist: tick until the store reports settled
 * @property {boolean} interaction  user-driven damage is pending (interactionFloorFps applies)
 * @property {boolean} hookKeep  a frame hook asked for the next frame
 * @property {boolean} wake  a hook was asked to run once without damage
 * @property {boolean} dispatching  inside firePaint
 * @property {boolean} due  the cap allowed a frame in the current tick
 * @property {boolean} committed  commitLanded ran for this canvas in the current tick
 * @property {Set<Element>} changed  committed since the last paint event
 * @property {Set<Element>} removed
 * @property {number} batches  commits merged into `changed` (more than one: the order is no longer the store's)
 * @property {boolean} afterNested  a canvas nested in its drawables fired a paint (its handler may have drawn into the bitmap the snapshot shows): the next paint waits for a fresh snapshot
 * @property {boolean} resized  resize / DPR damage is pending: this tick builds inside the rendering update (see runTick)
 */

/** Damage that comes from the user's hands: it may use options.interactionFloorFps. */
const INTERACTION_CAUSES = new Set(['input', 'selection', 'focus', 'hover', 'active', 'scroll']);
/**
 * Discrete user actions whose tile is built at once, in a microtask of the input task itself: after discrete input Chrome runs the rendering update before
 * any ordinary or user-blocking task, so only work done inside the input task can land before that frame. Damage published with `urgent` (a value change of a non-text control) too.
 */
const URGENT_CAUSES = new Set(['focus', 'active']);
/** ms without scroll damage after which the next one starts a new scroll stream */
const SCROLL_STREAM_GAP_MS = 200;
/** ms after a window resize event during which every build stays inside the rendering update */
const RESIZE_IN_FRAME_MS = 100;
/** A tick whose rAF timestamp is this many frame periods after the previous consecutive tick is late. */
const LATE_FRAME_FACTOR = 1.5;
const PUMP_MAIN_THREAD_MS = 4;
const PUMP_MAIN_THREAD_SHARE = 0.35;
const PUMP_MAX_IN_FLIGHT = 2;
const DOCUMENT_POSITION_FOLLOWING = 4;

/** @param {Node} a @param {Node} b @returns {number} */
function treeOrder(a, b) {
  if (a === b) return 0;
  return a.compareDocumentPosition(b) & DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

/** @param {CanvasRecord} record @returns {Entry} */
function createEntry(record) {
  return {
    record, registered: false, hooks: new Set(), dirty: false, interaction: false, hookKeep: false, wake: false,
    dispatching: false, due: false, committed: false, changed: new Set(), removed: new Set(), batches: 0, afterNested: false, resized: false,
  };
}

/**
 * Implements Scheduler (docs/ARCHITECTURE.md ADR-C). TWO phases per frame through frame-phase.js: the rAF ARM callback (arms the sentinel observer) and the frame-end RUN in a fresh ResizeObserver callback
 * (after app rAF callbacks, style/layout and earlier ResizeObservers). RUN, per canvas in reverse tree order: cap gate, paint gate (paint-gate.js), commitLanded, paint dispatch; then the frame hooks. ONE store pump for all canvases runs in a task posted after the rendering update (queuePump).
 * paintNow(record) is the same dispatch from a microtask (canvas width/height setters), at most one per frame. Zero rAF and zero ResizeObserver when idle; the only timer is the caret blink while a text control is focused (observers/; no idle poll).
 *
 * Cap semantics: the cap bounds paint events AND frame hooks (one cap gate per canvas, advanced only on ticks that have work). requestPaint() honours the cap too; paintNow() does not (the app just cleared the bitmap: skipping a frame would show it blank).
 * `interactionFloorFps` (default 0 = strict) raises a finite cap for user-driven damage only; it never lifts options.maxSnapshotFps, which the store applies to build starts.
 * @param {HicEnv} env
 * @param {SnapshotStore} store
 * @param {SchedulerHooks} hooks
 * @returns {Scheduler}
 */
export function createScheduler(env, store, hooks) {
  /** @type {Map<CanvasRecord, Entry>} */
  const entries = new Map();
  const capGate = createCapGate();
  const gate = createPaintGate(env, store);
  const counters = { frames: 0, paintsFired: 0, lateFrames: 0, gateTimeouts: 0 };
  const phase = createFramePhase(env, runTick);
  let registeredCount = 0;
  let armed = false;
  let disposed = false;
  /** @type {Set<Element>|null} elements the store reported through BUS.COMMIT during the current commitLanded call */
  let commitSeen = null;
  let lastTickAt = -1;
  let framePeriod = Infinity;
  let chained = false;
  let auditQueued = false;
  // Builds run in a task AFTER the rendering update: a build costs clone + CSS + serialise and forced style/layout, which inside the frame-end tick
  // delayed the frame itself (every long task of a wheel stream or a large-DOM update was BeginMainFrame). The commit and the paint dispatch stay in the tick.
  let pumpQueued = false;
  let pumpInteraction = false;
  let urgentQueued = false;
  let lastScrollAt = -Infinity;
  /** @type {MessageChannel|null} created on first use (an install without canvases never opens a port) */
  let pumpChannel = null;

  const offCommit = env.bus.on(BUS.COMMIT, onCommit);
  const offState = env.bus.on(BUS.CANVAS_STATE, (/** @type {{record: CanvasRecord, state: string}} */ e) => {
    const entry = entries.get(e.record);
    if (entry?.registered && e.state === 'active') resume(entry);
  });
  // A drawable added to / removed from a mounted canvas: the store tracks it (forced damage) but only the scheduler can arm a tick to build, commit and paint it.
  const offDrawables = env.bus.on(BUS.DRAWABLES_CHANGED, (/** @type {{record: CanvasRecord}} */ e) => {
    const entry = entries.get(e.record);
    if (!entry?.registered) return;
    entry.dirty = true;
    armTick();
  });
  const onVisibility = () => {
    if (env.document.hidden) return;
    for (const entry of entries.values()) if (entry.registered) resume(entry);
  };
  env.document.addEventListener('visibilitychange', onVisibility);
  // while the window is being resized every frame is long, so a post-frame build lands a frame late; the damage of a resize step is not only the canvas's own 'resize'
  // (layout inside it, re-rasters of the geometry check): every build stays inside the rendering update until the resizing has paused (measured: convergence max 25 -> 17 ms)
  let resizingUntil = -Infinity;
  const onWindowResize = () => { resizingUntil = env.now() + RESIZE_IN_FRAME_MS; };
  env.window.addEventListener?.('resize', onWindowResize, { passive: true });

  /** @param {CanvasRecord} record */
  function ensure(record) {
    let entry = entries.get(record);
    if (!entry) entries.set(record, (entry = createEntry(record)));
    return entry;
  }

  function armTick() {
    if (disposed || registeredCount === 0) return;
    armed = true;
    phase.arm();
  }

  /**
   * Full damage and a forced paint: first mount, hidden tab shown again, canvas active again. The gate clocks and the cap phase must not carry the time spent invisible.
   * @param {Entry} entry
   */
  function resume(entry) {
    const paint = entry.record.paint;
    paint.waitingSince = null;
    paint.gateReason = null;
    // A canvas without a drawable has nothing to snapshot: native fires no paint for it (WPT moved-webgl-canvas would see an exception thrown by its handler); the first drawable added damages it.
    paint.force = (entry.record.layer?.drawableElements().length ?? 0) > 0;
    capGate.reset(entry.record.id);
    api.damage(entry.record, 'forced', null, null);
  }

  /** @param {{record: CanvasRecord, changed: Element[], removed: Element[]}} change */
  function onCommit(change) {
    const entry = entries.get(change.record);
    if (!entry?.registered) return;
    for (const el of change.changed) {
      entry.changed.add(el);
      commitSeen?.add(el);
    }
    for (const el of change.removed) {
      entry.removed.add(el);
      commitSeen?.add(el);
    }
    entry.batches++;
  }

  /**
   * Elements of the returned change set that no BUS.COMMIT announced (a store that only returns the set): attribute them through the registry.
   * @param {ChangeSet|undefined} cs
   * @param {Set<Element>} seen
   */
  function attributeLeftovers(cs, seen) {
    if (!cs) return;
    for (const [list, key] of /** @type {Array<[Element[], 'changed'|'removed']>} */ ([[cs.changed, 'changed'], [cs.removed, 'removed']])) {
      for (const el of list) {
        if (seen.has(el)) continue;
        const owner = env.registry.ownerOfDrawable(el);
        const entry = owner && entries.get(owner);
        if (entry?.registered) {
          entry[key].add(el);
          entry.batches++;
        }
      }
    }
  }

  /** @param {Entry} entry */
  function commit(entry) {
    const seen = (commitSeen = new Set());
    /** @type {ChangeSet|undefined} */
    let cs;
    try {
      // a forced paint (requestPaint(), first mount, shown again) reports the DOM as it is now: no superseded tile may stand in for it
      cs = store.commitLanded(entry.record, { current: entry.record.paint.force });
    } finally {
      commitSeen = null;
    }
    entry.committed = true;
    attributeLeftovers(cs, seen);
  }

  /**
   * changedElements: the committed drawables in tree order, plus the drawable ancestor of every removed NESTED drawable (a removed top-level drawable lists nothing).
   * @param {Entry} entry
   * @returns {Element[]}
   */
  function changedElements(entry) {
    const out = new Set(entry.changed);
    let added = false;
    const layer = entry.record.layer;
    for (const el of entry.removed) {
      const parent = el.parentNode;
      const ancestor = parent && layer ? layer.nearestDrawable(parent) : null;
      if (ancestor && !out.has(ancestor)) {
        out.add(ancestor);
        added = true;
      }
    }
    const list = [...out];
    if ((added || entry.batches > 1) && list.length > 1) list.sort(treeOrder);
    return list;
  }

  /** @param {Entry} entry */
  function fire(entry) {
    const { record } = entry;
    const paint = record.paint;
    const list = changedElements(entry);
    entry.changed.clear();
    entry.removed.clear();
    entry.batches = 0;
    paint.force = false;
    paint.serial++;
    paint.lastFireAt = env.now();
    paint.everFired = true;
    counters.paintsFired++;
    entry.dispatching = true;
    try {
      hooks.firePaint(record, list);
    } catch (err) {
      env.reporter.caught(err, 'schedule.firePaint');
    } finally {
      entry.dispatching = false;
    }
  }

  /**
   * Gate, commit and dispatch of one canvas. Returns false while the gate holds the paint.
   * @param {Entry} entry
   * @param {number} now
   * @param {boolean} landed  the store has landed results
   */
  function servePaint(entry, now, landed) {
    const { record } = entry;
    const paint = record.paint;
    const before = paint.gateReason;
    const verdict = gate.evaluate(record, now);
    if (!verdict.open) return false;
    if (verdict.reason === 'timeout') {
      counters.gateTimeouts++;
      env.reporter.deviation('paint-timing', `paint fired after the ${before ?? 'first-commit'} gate wait cap elapsed; a draw of a drawable that still has no snapshot throws InvalidStateError (raise options.paintGateMaxWaitMs, or split a very large drawable)`);
    }
    const waitingSince = paint.waitingSince;
    if (paint.force || landed) commit(entry);
    // The commit can drop a stale tile (damage of a newer epoch arrived while it decoded): a draw in the handler would then throw for lack of a snapshot. Ask the gate again.
    if (verdict.reason !== 'timeout' && !gate.evaluate(record, now).open) {
      if (waitingSince !== null) paint.waitingSince = waitingSince;
      return false;
    }
    if (holdsForFreshness(entry, now)) return false;
    if (paint.force || entry.changed.size || entry.removed.size) fire(entry);
    return true;
  }

  /**
   * A canvas inside the drawables of another one paints first (reverse tree order), and the outer snapshot shows its bitmap: while the nested canvas is still held back (no first snapshot, or its own wait),
   * the outer paint stays back as well, so `captureElementImage` of a nested drawable works in the outer handler and the nested handler has drawn before the outer one runs (WPT nested-content-drawable-canvas).
   * Bounded by options.paintGateMaxWaitMs like every other hold.
   * A nested canvas that DID fire this tick makes the outer one wait for the next tick (the microtask that damages the outer drawable after the nested handler drew has not run yet) and then for a fresh snapshot.
   * @param {Entry} entry
   * @param {Entry[]} held
   * @param {Entry[]} fired
   * @param {number} now
   * @returns {boolean}
   */
  function holdsForNested(entry, held, fired, now) {
    const paint = entry.record.paint;
    const layerEl = entry.record.layer?.element;
    const inside = (/** @type {Entry} */ h) => !!layerEl && layerEl.contains(h.record.canvas);
    if (fired.some(inside)) {
      entry.afterNested = true;
      return true;
    }
    const blocked = held.some(inside);
    if (!blocked) return false;
    paint.holdSince ??= now;
    if (now - paint.holdSince >= env.options.paintGateMaxWaitMs) { paint.holdSince = null; return false; }
    return true;
  }

  /**
   * requestPaint() asks for a paint of the DOM as it is NOW (native snapshots every drawable in the rendering update that fires the event), so a style or content change made right before the call
   * must be in the snapshot the handler draws (WPT `child.style.width = '150px'; await waitForCanvasPaint(canvas); captureElementImage(child)`). The pump builds after the paint step of a tick, so a forced paint with
   * damage still waiting would present the OLD snapshot. It is held until the builds land (their commit makes the paint fire anyway) for at most options.paintGateMaxWaitMs. A paint with changes to report is never held,
   * so a requestPaint() loop over animating content is paced by the commits, exactly like a paint that no one requested.
   * @param {Entry} entry
   * @param {number} now
   * @returns {boolean} true while the paint stays back
   */
  function holdsForFreshness(entry, now) {
    const { record } = entry;
    const paint = record.paint;
    const unseen = paint.force && entry.changed.size === 0 && entry.removed.size === 0;
    const stale = env.options.coherentPaint && (unseen || entry.afterNested) && !store.isFresh(record);
    if (!stale) {
      entry.afterNested = false;
      paint.holdSince = null;
      return false;
    }
    paint.holdSince ??= now;
    if (now - paint.holdSince >= env.options.paintGateMaxWaitMs) {
      paint.holdSince = null;
      return false;
    }
    return true;
  }

  /** @param {Entry} entry */
  function hasWork(entry) {
    return entry.dirty || entry.record.paint.force || entry.wake || entry.hookKeep || entry.changed.size > 0 || entry.removed.size > 0;
  }

  /** @param {Entry} entry */
  function isServable(entry) {
    const state = entry.record.state;
    return state === 'active' || state === 'mounting';
  }

  /** @returns {Entry[]} registered entries, last canvas in tree order first */
  function orderedEntries() {
    /** @type {Entry[]} */
    const out = [];
    const all = env.registry.all();
    for (let i = all.length - 1; i >= 0; i--) {
      const entry = entries.get(all[i]);
      if (entry?.registered) out.push(entry);
    }
    if (out.length < registeredCount) {
      const listed = new Set(out);
      for (const entry of entries.values()) if (entry.registered && !listed.has(entry)) out.push(entry);
    }
    return out;
  }

  /** @param {number} now */
  function noteLateness(now) {
    if (chained && lastTickAt >= 0) {
      const gap = now - lastTickAt;
      if (gap > 1 && gap < framePeriod) framePeriod = gap;
      if (gap > framePeriod * LATE_FRAME_FACTOR) counters.lateFrames++;
    }
    lastTickAt = now;
  }

  /**
   * @param {number} now
   * @param {boolean} interaction
   * @param {boolean} [urgent]
   * @returns {PumpResult|null}
   */
  function pump(now, interaction, urgent = false) {
    try {
      return store.pump(now, { mainThreadMs: PUMP_MAIN_THREAD_MS, mainThreadShare: PUMP_MAIN_THREAD_SHARE, maxInFlight: PUMP_MAX_IN_FLIGHT, interaction, urgent });
    } catch (err) {
      env.reporter.caught(err, 'schedule.pump');
      return null;
    }
  }

  /** @param {boolean} interaction */
  function queuePump(interaction) {
    pumpInteraction ||= interaction;
    if (pumpQueued) return;
    pumpQueued = true;
    if (!pumpChannel) {
      const MC = /** @type {typeof MessageChannel} */ ((/** @type {any} */ (env.window)).MessageChannel ?? globalThis.MessageChannel);
      pumpChannel = new MC();
      pumpChannel.port1.onmessage = () => runPumpTask();
    }
    pumpChannel.port2.postMessage(0);
  }

  /** The urgent build (URGENT_CAUSES): one pump in a microtask of the current input task, so the decode can land before the next rendering update. */
  function urgentPump() {
    if (urgentQueued) return;
    urgentQueued = true;
    queueMicrotask(() => {
      urgentQueued = false;
      if (disposed) return;
      afterPump(pump(env.now(), true, true), true);
    });
  }

  /** The post-frame build task: start what is due, then keep the canvases that still have work ticking (decodes land in a later frame's commit). */
  function runPumpTask() {
    pumpQueued = false;
    if (disposed) return;
    const interaction = pumpInteraction;
    pumpInteraction = false;
    afterPump(pump(env.now(), interaction), interaction);
  }

  /** @param {PumpResult|null} pumped @param {boolean} interaction */
  function afterPump(pumped, interaction) {
    let again = false;
    for (const entry of entries.values()) {
      if (!entry.registered || !isServable(entry)) continue;
      if (pumped?.moreWork || !isSettled(entry)) {
        entry.dirty = true;
        if (interaction) entry.interaction = true;
        again = true;
      }
    }
    if (again) armTick();
  }

  /** @param {Entry} entry @param {number} now */
  function runHooks(entry, now) {
    let keep = false;
    for (const hook of [...entry.hooks]) {
      try {
        if (hook(now, { frameCap: entry.record.frameCap, due: entry.due }) === true) keep = true;
      } catch (err) {
        env.reporter.caught(err, 'schedule.frame-hook');
      }
    }
    entry.hookKeep = keep;
  }

  /** @param {Entry} entry */
  function isSettled(entry) {
    for (const el of entry.record.layer?.drawableElements() ?? []) if (store.has(el) && !store.isSettled(el)) return false;
    return true;
  }

  /**
   * Does the canvas need another frame? A hook asked, a paint is owed or held, the cap deferred it, the store still builds/decodes/has landed results.
   * (Work the post-frame pump defers re-arms the tick from the pump task.)
   * @param {Entry} entry
   */
  function needsTick(entry) {
    const paint = entry.record.paint;
    if (paint.force || entry.hookKeep || entry.changed.size > 0 || entry.removed.size > 0) return true;
    if (paint.waitingSince !== null || !entry.due) return true;
    if (!entry.committed && store.hasLanded(entry.record)) return true;
    return !isSettled(entry);
  }

  /**
   * The stacking audit needs the hit-test rules of the draws of this very tick, which the geometry layer flushes in a microtask; so it runs in one that is queued after them.
   * The layer rate-limits it (and skips it while nothing is drawn), so a busy canvas pays for it twice a second.
   */
  function queueStackingAudit() {
    if (auditQueued) return;
    auditQueued = true;
    queueMicrotask(() => {
      auditQueued = false;
      if (disposed) return;
      for (const entry of entries.values()) {
        if (!entry.registered || !isServable(entry)) continue;
        try {
          entry.record.layer?.stackingAudit();
        } catch (err) {
          env.reporter.caught(err, 'schedule.stacking-audit');
        }
      }
    });
  }

  /** @param {number} now */
  function runTick(now) {
    armed = false;
    noteLateness(now);
    /** @type {Entry[]} */
    const work = [];
    for (const entry of orderedEntries()) {
      if (!isServable(entry) || !hasWork(entry)) continue;
      entry.committed = false;
      entry.wake = false;
      entry.due = capGate.allow(entry.record.id, now, effectiveFps(entry.record.frameCap, env.options, 'paint', entry.interaction));
      work.push(entry);
    }
    let interaction = false;
    /** @type {Entry[]} canvases whose paint stayed back this tick: the canvases that contain them wait too */
    const held = [];
    /** @type {Entry[]} canvases that fired a paint this tick: the canvases that contain them must show what their handlers drew, so they paint later */
    const fired = [];
    for (const entry of work) {
      interaction ||= entry.interaction;
      if (!entry.due) continue;
      try {
        if (holdsForNested(entry, held, fired, now)) { held.push(entry); continue; }
        const serial = entry.record.paint.serial;
        if (!servePaint(entry, now, store.hasLanded(entry.record))) held.push(entry);
        else if (entry.record.paint.serial !== serial) fired.push(entry);
      } catch (err) {
        env.reporter.caught(err, 'schedule.paint');
      }
    }
    // a resize frame is long (the page relayouts) and the browser runs the NEXT rendering update before a task posted from it, so a post-frame build would land a frame later
    // (measured: resize convergence p95 17 -> 25 ms); resize / DPR damage is built inside the tick. Everything else builds after the frame.
    // ... and so is the FIRST snapshot of a canvas (so its first paint is not a frame late: WPT onpaint-zindex expects the initial paint within the first frame)
    const resized = now < resizingUntil || work.some((entry) => entry.resized || !entry.record.paint.everFired);
    const pumped = resized ? pump(now, interaction, true) : null;
    if (resized) for (const entry of work) entry.resized = false;
    else if (work.length) queuePump(interaction);
    for (const entry of work) runHooks(entry, now);
    counters.frames++;
    if (work.some((entry) => entry.committed)) queueStackingAudit();
    let again = false;
    for (const entry of work) {
      entry.dirty = needsTick(entry) || !!pumped?.moreWork;
      if (!entry.dirty) entry.interaction = false;
      again ||= entry.dirty;
    }
    chained = again;
    if (again) armTick();
  }

  /**
   * @param {CanvasRecord} record
   * @param {DamageCause} cause
   * @param {Element|null} drawable
   * @param {Rect|null} rect
   */
  function markStore(record, cause, drawable, rect) {
    try {
      if (drawable) {
        store.markDamage(drawable, rect, cause);
        return;
      }
      for (const el of record.layer?.drawableElements() ?? []) if (store.has(el)) store.markDamage(el, null, cause);
    } catch (err) {
      env.reporter.caught(err, 'schedule.damage');
    }
  }

  /** @type {Scheduler} */
  const api = {
    register(record) {
      const entry = ensure(record);
      if (entry.registered) return;
      entry.registered = true;
      registeredCount++;
      record.frameCap = parseFrameCap(record.canvas.getAttribute(EXT.FRAME_CAP_ATTR), env.options.defaultFrameCap);
      record.dpr = env.window.devicePixelRatio || 1;
      resume(entry);
    },

    unregister(record) {
      const entry = entries.get(record);
      if (!entry) return;
      if (entry.registered) registeredCount--;
      entries.delete(record);
      capGate.reset(record.id);
      if (registeredCount === 0) {
        phase.cancel();
        armed = false;
      }
    },

    requestPaint(record) {
      const entry = entries.get(record);
      if (!entry?.registered) return;
      record.paint.force = true;
      entry.dirty = true;
      armTick();
    },

    paintNow(record) {
      const entry = entries.get(record);
      if (!entry?.registered || !isServable(entry)) return false;
      const paint = record.paint;
      const serial = counters.frames + 1;
      if (entry.dispatching || paint.microtaskFrame === serial) {
        api.requestPaint(record);
        return false;
      }
      paint.force = true;
      entry.dirty = true;
      const fired = servePaint(entry, env.now(), store.hasLanded());
      if (fired) paint.microtaskFrame = serial;
      armTick();
      return fired;
    },

    setFrameCap(record, fps) {
      const next = clampFrameCap(fps);
      if (record.frameCap === next) return;
      record.frameCap = next;
      capGate.reset(record.id);
      if (entries.get(record)?.dirty) armTick();
    },

    addFrameHook(record, hook) {
      const entry = ensure(record);
      entry.hooks.add(hook);
      return () => {
        entry.hooks.delete(hook);
        if (!entry.hooks.size) entry.hookKeep = false;
      };
    },

    wake(record) {
      const entry = entries.get(record);
      if (!entry?.registered) return;
      entry.wake = true;
      armTick();
    },

    damage(record, cause, drawable = null, rect = null, urgent = false) {
      const entry = entries.get(record);
      if (!entry?.registered) return;
      markStore(record, cause, drawable, rect);
      env.bus.emit(BUS.DAMAGE, { record, drawable, rect, cause, t: env.now() });
      entry.dirty = true;
      if (INTERACTION_CAUSES.has(cause)) entry.interaction = true;
      // and the FIRST scroll step of a stream: during a wheel scroll animation the browser runs rendering updates back to back and starves posted tasks, so a post-frame
      // build of that step was drawn 70-80 ms late (later steps are composed from cached pages; their fallback builds stay after the frame, where they cost no frame time)
      const streamStart = cause === 'scroll' && env.now() - lastScrollAt > SCROLL_STREAM_GAP_MS;
      if (cause === 'scroll') lastScrollAt = env.now();
      if (cause === 'resize' || cause === 'dpr' || streamStart) entry.resized = true;
      armTick();
      if (urgent || URGENT_CAUSES.has(cause)) urgentPump();
    },

    stats() {
      return { ...counters, phaseFallbacks: phase.stats().fallbacks };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      offCommit();
      offState();
      offDrawables();
      env.document.removeEventListener('visibilitychange', onVisibility);
      env.window.removeEventListener?.('resize', onWindowResize);
      phase.cancel();
      if (pumpChannel) {
        pumpChannel.port1.onmessage = null;
        pumpChannel.port1.close();
        pumpChannel = null;
      }
      entries.clear();
      registeredCount = 0;
      armed = false;
    },
  };

  return api;
}
