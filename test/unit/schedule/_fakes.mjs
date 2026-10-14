// Fakes for the pure scheduler tests: a window whose frames are stepped by hand (rAF callbacks, then ResizeObserver delivery in creation order,
// like one rendering update), a minimal document, a store with scripted behaviour, canvas records and an env. No DOM, no timers.
import { createBus } from '../../../src/util/bus.js';
import { DEFAULT_OPTIONS } from '../../../src/api/options.js';

export function createFakeWindow() {
  let nextId = 1;
  /** @type {Map<number, (ts: number) => void>} */
  const rafs = new Map();
  /** @type {any[]} */
  const observers = [];
  const counters = { rafRequests: 0, roCreated: 0, roCallbacks: 0 };
  const flags = { suppressRO: false };
  class ResizeObserver {
    constructor(cb) {
      this.cb = cb;
      this.targets = new Set();
      this.pending = false;
      this.disconnected = false;
      observers.push(this);
      counters.roCreated++;
    }
    observe(target) { this.targets.add(target); this.pending = true; }
    disconnect() { this.disconnected = true; this.targets.clear(); this.pending = false; }
  }
  /** tasks posted through MessageChannel: delivered after the rendering update (end of frame()), like the browser's next task */
  const tasks = [];
  class MessageChannel {
    constructor() {
      const port1 = { onmessage: null, close() { this.onmessage = null; } };
      this.port1 = port1;
      this.port2 = { postMessage: () => { tasks.push(() => port1.onmessage?.({ data: 0 })); } };
    }
  }
  const runTasks = () => { for (let guard = 0; tasks.length && guard < 100; guard++) tasks.shift()(); };
  const listeners = new Map();
  const win = {
    addEventListener(type, fn) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatch(type) { for (const fn of [...(listeners.get(type) ?? [])]) fn({ type }); },
    listenerCount: (type) => listeners.get(type)?.size ?? 0,
    devicePixelRatio: 2,
    MessageChannel,
    requestAnimationFrame(cb) { const id = nextId++; rafs.set(id, cb); counters.rafRequests++; return id; },
    cancelAnimationFrame(id) { rafs.delete(id); },
    ResizeObserver,
  };
  return {
    win,
    counters,
    flags,
    rafCount: () => rafs.size,
    liveObservers: () => observers.filter((o) => !o.disconnected && o.targets.size).length,
    /** One rendering update: rAF callbacks queued before it, then ResizeObserver delivery (creation order, repeated until quiet). */
    frame(ts) {
      const callbacks = [...rafs.values()];
      rafs.clear();
      for (const cb of callbacks) cb(ts);
      if (flags.suppressRO) { runTasks(); return; }
      for (let guard = 0; guard < 10; guard++) {
        const due = observers.filter((o) => o.pending && !o.disconnected && [...o.targets].every((t) => t.isConnected !== false));
        if (!due.length) break;
        for (const o of due) {
          o.pending = false;
          counters.roCallbacks++;
          o.cb([]);
        }
      }
      runTasks();
    },
    runTasks,
  };
}

export function createFakeDocument() {
  const listeners = new Map();
  const added = [];
  const doc = {
    hidden: false,
    added,
    documentElement: {
      appendChild(el) { el.isConnected = true; added.push(el); },
    },
    createElement(tag) {
      return { tag, isConnected: false, attrs: {}, style: { setProperty() {} }, setAttribute(k, v) { this.attrs[k] = v; }, remove() { this.isConnected = false; } };
    },
    addEventListener(type, fn) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatch(type) { for (const fn of [...(listeners.get(type) ?? [])]) fn({ type }); },
    listenerCount: (type) => listeners.get(type)?.size ?? 0,
  };
  return doc;
}

let recordId = 0;
let elementIndex = 0;

/** A drawable stand-in: only what the scheduler touches (tree order and the parent chain). */
export function fakeElement(parent = null) {
  const el = {
    idx: ++elementIndex,
    parentNode: parent,
    compareDocumentPosition(other) { return other.idx > el.idx ? 4 : 2; },
  };
  return el;
}

export function fakeRecord(drawables = [], init = {}) {
  const record = {
    id: ++recordId,
    state: 'active',
    frameCap: 0,
    dpr: 1,
    canvas: { getAttribute: () => null },
    paint: { force: false, serial: 0, lastFireAt: 0, everFired: false, microtaskFrame: -1, waitingSince: null, gateReason: null, holdSince: null },
    layer: {
      drawables,
      drawableElements: () => record.layer.drawables,
      nearestDrawable: (node) => { for (let n = node; n; n = n.parentNode) if (record.layer.drawables.includes(n)) return n; return null; },
    },
    ...init,
  };
  return record;
}

/** A store whose answers are set by the test; every call is recorded. */
export function createFakeStore(bus) {
  const store = {
    calls: [],
    ready: { ready: true, reason: 'ready' },
    landed: false,
    unsettled: new Set(),
    pumpResult: { started: 0, spentMs: 0, moreWork: false, nextDueAt: null },
    nextChange: null,
    emitCommit: true,
    pumps: 0,
    fresh: true,
    freshFor: new Map(),
    isFresh: (record) => store.freshFor.get(record) ?? store.fresh,
    readyFor: new Map(),
    isPaintReady: (record) => store.readyFor.get(record) ?? store.ready,
    hasLanded: () => store.landed,
    commitLanded() {
      store.calls.push(['commitLanded']);
      const change = store.nextChange ?? { changed: [], removed: [] };
      store.nextChange = null;
      store.landed = false;
      if (store.emitCommit && (change.changed.length || change.removed.length)) bus.emit('snapshot:commit', { record: store.commitRecord, changed: change.changed, removed: change.removed });
      return change;
    },
    pump(now, budget) { store.pumps++; store.lastBudget = budget; store.calls.push(['pump']); return store.pumpResult; },
    markDamage(el, rect, cause) { store.calls.push(['markDamage', el, rect, cause]); },
    invalidateAll(cause) { store.calls.push(['invalidateAll', cause]); },
    has: () => true,
    isSettled: (el) => !store.unsettled.has(el),
  };
  return store;
}

export function createFakeEnv(optionOverrides = {}) {
  const clock = { t: 0 };
  const fw = createFakeWindow();
  const document = createFakeDocument();
  const bus = createBus();
  const reporter = {
    deviations: [],
    errors: [],
    deviation(id, detail) { this.deviations.push([id, detail]); },
    caught(err, where) { this.errors.push([err, where]); },
    unsupported() {},
    entries: () => [],
  };
  const records = [];
  const env = {
    window: fw.win,
    document,
    bus,
    reporter,
    now: () => clock.t,
    options: { ...DEFAULT_OPTIONS, ...optionOverrides },
    registry: {
      all: () => records,
      get: (canvas) => records.find((r) => r.canvas === canvas),
      ownerOfDrawable: (el) => records.find((r) => r.layer.drawables.includes(el)),
      logicalCanvasAncestor: () => null,
    },
    isManagedLayerNode: () => false,
  };
  const store = createFakeStore(bus);
  return {
    env,
    fw,
    document,
    bus,
    reporter,
    store,
    records,
    clock,
    addRecord(drawables, init) { const r = fakeRecord(drawables, init); records.push(r); store.commitRecord = r; return r; },
    /** Advance the clock by `dt` ms and run one frame. */
    step(dt = 1000 / 120) { clock.t += dt; fw.frame(clock.t); },
    /** Run frames of `dt` ms for `ms` ms. */
    run(ms, dt = 1000 / 120) { const end = clock.t + ms; while (clock.t + dt <= end + 1e-9) this.step(dt); },
  };
}
