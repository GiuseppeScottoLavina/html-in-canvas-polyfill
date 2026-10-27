/**
 * SnapshotStore: tracks drawables, owns surfaces/versions/damage, runs builds and commits (docs/ARCHITECTURE.md ADR-B).
 * Module: snapshot-store (src/snapshot/store/*).
 *
 * Data per drawable is one Entry (pump.js): surface + geometry, the published version, the caret state. Everything that touches pixels happens in commitLanded(),
 * one synchronous step: results are grouped per drawable, oldest generation first, each one passes DamageTracker.accepts() or is reclaimed (re-damaged), is drawn with the
 * atomic bounded commit, and the drawable gets ONE new immutable version per round.
 */

import { BUS } from '../../contracts/events.js';
import { HicUnsupportedError, invalidState } from '../../contracts/errors.js';
import { featureById } from '../../contracts/features.js';
import { inflateRect, intersectRect, roundOutRect, unionRect } from '../../util/rect.js';
import { createCaretPatch } from './caret-patch.js';
import { DamageTracker } from './damage.js';
import { decodeDataUrl, decodedAtOnce, drawTileAtomic, releaseImage } from './decode.js';
import { createPumpState, defaultInteraction, NULL_RESOURCES, planGeometry, requestOf, runPump, sameGeometry } from './pump.js';
import { rasterSourceFor } from './raster-source.js';
import { createRunawayGuard } from './runaway.js';
import { createBackdropCache, paintTextOverlay } from './text-paint.js';
import { createScrollCompositor } from './scroll-compose.js';
import { allocateSurface, forkSurface, makeCanvas, surfaceBytes, watchSurfaceLoss } from './surfaces.js';
import { newVersion, parseTransformOrigin, reviseVersion } from './versions.js';

/** @typedef {import('../../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../../contracts/types.js').CaptureFn} CaptureFn */
/** @typedef {import('../../contracts/types.js').CaptureResult} CaptureResult */
/** @typedef {import('../../contracts/types.js').ChangeSet} ChangeSet */
/** @typedef {import('../../contracts/types.js').ContentBox} ContentBox */
/** @typedef {import('../../contracts/types.js').DamageCause} DamageCause */
/** @typedef {import('../../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../../contracts/types.js').InteractionSnapshot} InteractionSnapshot */
/** @typedef {import('../../contracts/types.js').Rect} Rect */
/** @typedef {import('../../contracts/types.js').ResourceCache} ResourceCache */
/** @typedef {import('../../contracts/types.js').SnapshotStore} SnapshotStore */
/** @typedef {import('../../contracts/types.js').SnapshotVersion} SnapshotVersion */
/** @typedef {import('./pump.js').Entry} Entry */
/** @typedef {import('./pump.js').Geometry} Geometry */
/** @typedef {import('./pump.js').Job} Job */
/** @typedef {import('./pump.js').Landed} Landed */
/** @typedef {HTMLCanvasElement|OffscreenCanvas} Surface */

/** @typedef {import('../../contracts/types.js').StoreExtras} StoreExtras */

/**
 * @typedef {Object} Round  what one commit round did to one drawable
 * @property {boolean} wrote   pixels or surface changed: a new version is due
 * @property {boolean} fresh   the surface was replaced by a new allocation (dirty rect unknown)
 * @property {Rect|null|undefined} dirty  css rect changed so far (undefined = nothing yet, null = everything)
 * @property {{x: number, y: number}|null|undefined} layoutOffset
 * @property {DOMMatrixReadOnly|null|undefined} translation
 * @property {number} [tileSeq]  highest Job.ovSeq of the tiles committed in this round
 * @property {boolean} [composed]  the scroll compositor rewrote a scrollport in this round
 * @property {boolean} [current]  the paint after this commit must show the DOM as it is now (commitLanded `current`): a whole tile from before a DOM mutation does not stand in
 */

/** Consecutive failures back off 100, 200, ... ms up to this cap. */
const MAX_BACKOFF_MS = 5000;
/** Weight of the newest sample in the per-drawable tile cost EMA. */
const COST_EMA_WEIGHT = 0.3;
const SAMPLES = 64;
/** Damage causes that may change what a refused drawable needs, so a refusal is retried. */
const RETRY_CAUSES = new Set(['resize', 'dpr', 'forced', 'stylesheet', 'content-attr']);
/** Damage of typing in a field: it cannot move anything over the field (every other cause may, so the overlay planner re-checks). */
const TYPING_CAUSES = new Set(['input', 'selection', 'caret']);

/** Fixed-size ring of numbers with percentile reads. */
class Samples {
  constructor() {
    /** @type {number[]} */
    this.values = [];
    this.next = 0;
  }

  /** @param {number} x */
  push(x) {
    if (this.values.length < SAMPLES) this.values.push(x); else this.values[this.next] = x;
    this.next = (this.next + 1) % SAMPLES;
  }

  /** @param {number} p 0..1 @returns {number} */
  percentile(p) {
    if (!this.values.length) return 0;
    const sorted = [...this.values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  }
}

/** @param {Element} a @param {Element} b @returns {number} tree order */
function treeOrder(a, b) {
  if (a === b || typeof a.compareDocumentPosition !== 'function') return 0;
  return a.compareDocumentPosition(b) & 4 ? -1 : 1;
}

/** @param {Rect} outer @param {Rect} inner @returns {boolean} */
const covers = (outer, inner) => outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;

/** @param {Landed[]} list @returns {Map<Entry, Landed[]>} oldest generation first */
function groupByEntry(list) {
  /** @type {Map<Entry, Landed[]>} */
  const groups = new Map();
  for (const l of list) {
    const group = groups.get(l.entry);
    if (group) group.push(l); else groups.set(l.entry, [l]);
  }
  for (const group of groups.values()) group.sort((a, b) => a.generation - b.generation);
  return groups;
}

/**
 * Run functions in a later task, batched: the deferred decode start of a long build (pump.js SPLIT_DECODE_MS). A user-blocking task (Prioritized Task Scheduling)
 * like the scheduler's post-frame pump, so the tile still lands before the tasks the page queued earlier (a setTimeout from its rAF callback): with a MessageChannel
 * task it landed after them, and a paint came before or after the page's next task depending on whether the build took 3.5 ms (machine load decided WPT onpaint).
 * Without the API, a MessageChannel task.
 * @param {Window} win
 * @param {(err: unknown) => void} onError
 * @returns {((fn: () => void) => void) & {dispose: () => void}}
 */
export function createNextTask(win, onError) {
  /** @type {Array<() => void>} */
  const queue = [];
  /** @type {MessageChannel|null} */
  let channel = null;
  const run = () => { for (const f of queue.splice(0)) { try { f(); } catch (err) { onError(err); } } };
  /** @param {() => void} fn */
  const post = (fn) => {
    if (queue.push(fn) > 1) return;
    const sched = /** @type {any} */ (win).scheduler;
    if (typeof sched?.postTask === 'function') return void sched.postTask(run, { priority: 'user-blocking' }).catch(() => {});
    if (!channel) {
      channel = new ((/** @type {any} */ (win)).MessageChannel ?? MessageChannel)();
      /** @type {MessageChannel} */ (channel).port1.onmessage = run;
    }
    /** @type {MessageChannel} */ (channel).port2.postMessage(0);
  };
  return Object.assign(post, { dispose() { queue.length = 0; channel?.port1.close(); channel = null; } });
}

/**
 * Implements SnapshotStore. Subscribes to BUS.DRAWABLES_CHANGED, RESIZE, DPR, CANVAS_UNMOUNTING; emits BUS.COMMIT and BUS.SOURCE_VERSION from commitLanded, BUS.LANDED for a tile decoded at once, BUS.SURFACE_RESTORED after a context loss.
 * commitLanded: every tile goes through drawTileAtomic; a result rejected by DamageTracker.accepts is reclaimed (re-damaged), never silently dropped; 'caret' damage is served by caret-patch.js without a build; versions carry layoutOffset from the CaptureResult.
 * isPaintReady(record): not ready ('first-commit') while any eligible drawable that has a CSS box has neither a version nor a placeholder; not ready ('coherence', coherentPaint only) while a build that started from the same damage epoch as a landed one is still in flight.
 * @param {HicEnv} env
 * @param {CaptureFn} capture
 * @param {StoreExtras} [extras]
 * @returns {SnapshotStore}
 */
export function createSnapshotStore(env, capture, extras = {}) {
  const damage = new DamageTracker();
  /** @type {Map<Element, Entry>} */
  const entries = new Map();
  /** @type {Landed[]} */
  const landed = [];
  /** @type {Set<Job>} */
  const jobs = new Set();
  /** @type {Map<number, number>} */
  const inFlight = new Map();
  const state = createPumpState();
  /** @type {Map<Surface, number>} ElementImage pins per surface; a pinned surface is never written */
  const pins = new Map();
  /** @type {Set<Element>} metadata-only versions published outside commitLanded (resize) */
  const pendingChanged = new Set();
  /** @type {Map<Element, CanvasRecord>} */
  const pendingRemoved = new Map();
  const counters = { commits: 0, tiles: 0, fullTiles: 0, dropped: 0, redamaged: 0, surfaceRestores: 0, nodesLast: 0 };
  const cloneMs = new Samples();
  const decodeMs = new Samples();
  const decodeMainMs = new Samples();
  const options = env.options;
  const interaction = extras.interaction;
  const runaway = createRunawayGuard({ onTrip: (info) => env.bus.emit(BUS.RUNAWAY, info) });

  const isLive = (/** @type {Entry} */ entry, /** @type {number} */ incarnation) => entry.incarnation === incarnation && entries.get(entry.el) === entry;
  const pinned = (/** @type {Surface} */ surface) => (pins.get(surface) ?? 0) > 0;

  // ---------------------------------------------------------------------------------------------- entries and surfaces

  /** @param {CanvasRecord} record @param {Element} el @returns {Entry} */
  function track(record, el) {
    const known = entries.get(el);
    if (known && known.record === record) return known;
    if (known) dropEntry(known, false);
    /** @type {Entry} */
    const entry = {
      el, record, incarnation: 0, surface: null, geo: null, version: null, blend: 'normal', backdrop: 'none', decoding: 0, costEma: null, lastNodes: 0, lastTakeAt: 0, firstTakeAt: null,
      notBefore: 0, failures: 0, refused: false, lost: false, reducedReported: false, patch: createCaretPatch(), caret: null, phase: true, caretToggles: 0,
      unwatch: null, failureReported: false, verifyGeometry: false, geometryRetries: 0, ovSeq: 0, ovShown: 0, ovControl: null, ovQueued: false, ovEpoch: 0, ovTileSeq: 0, caretAsk: undefined, caretLiveAt: -Infinity, ovOk: null, ovDeferred: false,
    };
    entries.set(el, entry);
    return entry;
  }

  /** @param {Entry} entry @param {Surface} surface @param {Geometry} geo */
  function bind(entry, surface, geo) {
    if (entry.surface !== surface) {
      entry.unwatch?.();
      entry.unwatch = watchSurfaceLoss(surface, () => onLost(entry), () => onRestored(entry));
    }
    entry.surface = surface;
    entry.geo = geo;
  }

  /** The drawable has no snapshot any more (its surface stays alive only for ElementImages that pinned it). @param {Entry} entry */
  function release(entry) {
    entry.unwatch?.();
    entry.unwatch = null;
    entry.surface = null;
    entry.geo = null;
    entry.version = null;
    entry.caret = null;
    entry.caretToggles = 0;
    entry.firstTakeAt = null;
    entry.lost = false;
    entry.patch = createCaretPatch();
    entry.ovShown = 0;
    entry.ovQueued = false;
    compositor.forget(entry);
  }

  /** @param {Entry} entry @param {boolean} announce  list the element in ChangeSet.removed when it had a snapshot */
  function dropEntry(entry, announce) {
    entry.incarnation++;
    entries.delete(entry.el);
    damage.forget(entry.el);
    pendingChanged.delete(entry.el);
    if (entry.version && announce) pendingRemoved.set(entry.el, entry.record);
    release(entry);
  }

  /** @param {Entry} entry */
  function onLost(entry) {
    entry.lost = true;
    env.reporter.unsupported({ feature: 'context-loss', message: 'a retained 2D surface lost its context; the drawable is re-rastered when the browser restores it', hint: 'no action needed' }, entry.record.canvas);
  }

  /** The restored context is blank even though isContextLost() reads false: only a whole re-raster brings the pixels back. @param {Entry} entry */
  function onRestored(entry) {
    if (entries.get(entry.el) !== entry) return;
    entry.lost = false;
    entry.patch = createCaretPatch();
    counters.surfaceRestores++;
    damage.mark(entry.el, null, 'forced', env.now());
    env.bus.emit(BUS.SURFACE_RESTORED, { record: entry.record, element: entry.el });
  }

  /** Bytes of every retained surface (pinned leftovers included) except `except`'s own. @param {Entry} [except] @returns {number} */
  function retainedBytes(except) {
    const all = new Set();
    for (const e of entries.values()) if (e.surface) all.add(e.surface);
    for (const s of pins.keys()) all.add(s);
    if (except?.surface) all.delete(except.surface);
    let total = 0;
    for (const s of all) total += surfaceBytes(s);
    return total;
  }

  /** A surface that may be written: forks a pinned one (copy-on-write, ElementImage immutability). @param {Entry} entry @returns {Surface} */
  function writable(entry) {
    const surface = /** @type {Surface} */ (entry.surface);
    if (!pinned(surface)) return surface;
    const copy = forkSurface(surface);
    bind(entry, copy, /** @type {Geometry} */ (entry.geo));
    return copy;
  }

  // ---------------------------------------------------------------------------------------------- damage

  /** @param {Element} el @param {Rect|null} rect @param {DamageCause} cause */
  function markDamage(el, rect, cause) {
    let entry = entries.get(el);
    if (!entry) {
      const record = env.registry.ownerOfDrawable(el);
      if (!record) return;
      entry = track(record, el);
    }
    if (cause === 'caret') {
      if (entry.caret) entry.caretToggles++;
      return;
    }
    if (!TYPING_CAUSES.has(cause)) entry.ovEpoch++;
    compositor.damaged(entry, rect, cause);
    if (entry.failures >= 3) entry.failures = 0;
    if (RETRY_CAUSES.has(cause)) entry.refused = false;
    runaway.damage(cause, env.now());
    damage.mark(el, rect, cause, env.now());
  }

  /** @param {Iterable<Entry>} list @param {DamageCause} cause */
  function markAll(list, cause) {
    for (const entry of [...list]) markDamage(entry.el, null, cause);
  }

  /** @param {CanvasRecord} record @returns {Entry[]} */
  const entriesOf = (record) => [...entries.values()].filter((e) => e.record === record);

  // ---------------------------------------------------------------------------------------------- pump host

  /** @param {Entry} entry @param {unknown} err @param {string} where */
  function noteFailure(entry, err, where) {
    entry.failures++;
    entry.notBefore = env.now() + Math.min(MAX_BACKOFF_MS, 100 * 2 ** (entry.failures - 1));
    if (entry.failureReported) return;
    entry.failureReported = true;
    env.reporter.caught(err, `snapshot-store:${where}`);
  }

  /** Tile cost = sync build + decode wall + commit draw (decode is main-thread time, ADR-D.8). @param {Entry} entry @param {Landed} l @param {number} drawMs */
  function settleCost(entry, l, drawMs) {
    const actual = l.syncMs + l.decodeMs + drawMs;
    entry.costEma = entry.costEma === null ? actual : entry.costEma * (1 - COST_EMA_WEIGHT) + actual * COST_EMA_WEIGHT;
    if (!l.first) state.bucket.spend(actual - l.estCost);
    cloneMs.push(l.result.timings?.cloneMs ?? l.syncMs);
    decodeMs.push(l.decodeMs);
    decodeMainMs.push(l.decodeMs + drawMs);
  }

  /** @param {Entry} entry @returns {string} */
  const describe = (entry) => `${entry.el.localName ?? 'drawable'}${entry.el.id ? '#' + entry.el.id : ''}`;

  /** @type {import('./pump.js').PumpHost} */
  const host = {
    entries: () => entries.values(),
    scrollers: (entry) => compositor.scrollers(entry),
    scrollSeq: () => compositor.seq(),
    usedBytes: (entry) => retainedBytes(entry),
    notLaidOut(entry) {
      if (entry.version) pendingRemoved.set(entry.el, entry.record);
      pendingChanged.delete(entry.el);
      release(entry);
    },
    empty(entry, size, now) {
      // A drawable whose box has no area has an EMPTY snapshot, not none: drawing it paints nothing and must not throw (WPT draw-element-image-empty, drawElementImage-zero-size).
      const taken = damage.take(entry.el, () => null);
      if (!taken) return;
      entry.firstTakeAt ??= now;
      const geo = { bw: size.width, bh: size.height, scale: 1, reduced: false, ink: { top: 0, right: 0, bottom: 0, left: 0 }, widthPx: 1, heightPx: 1 };
      try {
        bind(entry, allocateSurface(1, 1), geo);
      } catch (err) {
        damage.reclaim(entry.el, null, taken.generation);
        noteFailure(entry, err, 'surface');
        return;
      }
      damage.committed(entry.el, taken.generation);
      const at = entry.record.layer?.borderBoxRectInLayer?.(entry.el);
      publish(entry, { wrote: true, fresh: true, dirty: null, layoutOffset: at ? { x: at.x, y: at.y } : undefined, translation: host.translationOf(entry) ?? undefined }, env.now(), !entry.version);
      pendingChanged.add(entry.el);
    },
    refuse(entry, err) {
      entry.refused = true;
      if (err instanceof HicUnsupportedError) env.reporter.unsupported({ feature: err.feature, message: err.message, hint: err.hint, path: describe(entry) }, entry.record.canvas);
      else env.reporter.caught(err, 'snapshot-store:geometry');
    },
    reduced(entry, geo) {
      if (entry.reducedReported) return;
      entry.reducedReported = true;
      env.reporter.unsupported({ feature: 'surface-size', message: `${describe(entry)} is rasterised at scale ${geo.scale.toFixed(2)} to fit options.maxSurfacePixels / maxTotalSurfaceBytes`, hint: 'raise the budgets or split the drawable', path: describe(entry) }, entry.record.canvas);
    },
    translationOf(entry) {
      const cs = env.window.getComputedStyle(entry.el);
      entry.blend = cs.mixBlendMode || 'normal';
      entry.backdrop = cs.backdropFilter || 'none';
      const origin = parseTransformOrigin(cs.transformOrigin);
      return new DOMMatrixReadOnly([1, 0, 0, 1, origin.x, origin.y]);
    },
    landed(l) {
      if (!isLive(l.entry, l.incarnation)) { releaseImage(l.image); return; }
      l.entry.lastNodes = l.result.nodes;
      counters.nodesLast = l.result.nodes;
      landed.push(l);
      // landed inside the task that built it: the scheduler can paint it now rather than at the next frame
      if (decodedAtOnce(l.image)) env.bus.emit(BUS.LANDED, { record: l.entry.record });
    },
    fail(job, err, stage) {
      const entry = job.entry;
      if (!isLive(entry, job.incarnation)) return;
      if (!job.first) state.bucket.spend(job.syncMs - job.estCost);
      if (damage.reclaim(entry.el, job.rect, job.generation)) counters.redamaged++;
      noteFailure(entry, err, stage);
    },
  };

  const nextTask = createNextTask(env.window, (err) => env.reporter.caught(err, 'snapshot-store:next-task'));

  /** @type {import('./pump.js').PumpDeps} */
  const pumpDeps = {
    capture, damage, landed, inFlight, jobs, state, host,
    decode: extras.decode ?? ((url) => decodeDataUrl(url)),
    maxPerDrawable: extras.buildsPerDrawable ?? 1,
    resources: extras.resources ?? NULL_RESOURCES,
    interaction: (record) => (interaction ? interaction.snapshot() : defaultInteraction(env, record)),
    nextTask: extras.nextTask ?? (extras.decode ? undefined : nextTask),
  };

  /** @type {Array<{entry: Entry, run: () => void}>} side builds (scroll pages, pinned tiles, overlay backdrops): run by the post-frame pump after the regular builds */
  const side = [];

  const compositor = createScrollCompositor({
    plan: (scroller, drawable) => {
      const layer = entries.get(drawable)?.record.layer;
      return layer && extras.scrollPlan ? extras.scrollPlan(scroller, drawable, layer) : null;
    },
    capture(entry, rectCss, geo, scroll) {
      try {
        const req = requestOf(env, entry.record, entry.el, rectCss, 0, { geo, lastNodes: entry.lastNodes, resources: pumpDeps.resources, interaction: pumpDeps.interaction(entry.record) });
        const result = capture({ ...req, scroll });
        // a 'limited' entry (node-budget: a large scroller) describes a page that renders like the tiles do
        return (result.unsupported ?? []).some((u) => featureById(u.feature)?.status !== 'limited') || !result.complete ? null : result.url;
      } catch (err) {
        env.reporter.caught(err, 'snapshot-store:scroll-page');
        return null;
      }
    },
    decode: (url) => pumpDeps.decode(url),
    canvas: makeCanvas,
    schedule: (entry, run) => { side.push({ entry, run }); },
  });

  /** Side builds while the pump's budget allows (at least one when no regular build started). @param {import('../../contracts/types.js').PumpResult} out @param {import('../../contracts/types.js').PumpBudget} budget */
  function runSide(out, budget) {
    while (side.length && (out.started === 0 || out.spentMs < budget.mainThreadMs)) {
      const job = /** @type {{entry: Entry, run: () => void}} */ (side.shift());
      if (entries.get(job.entry.el) !== job.entry) continue;
      const t0 = env.now();
      try { job.run(); } catch (err) { env.reporter.caught(err, 'snapshot-store:side-build'); }
      out.started++;
      out.spentMs += env.now() - t0;
    }
    if (side.length) { out.moreWork = true; out.nextDueAt = out.nextDueAt ?? env.now(); }
  }

  /**
   * The scroll compositor's commit step (scroll-compose.js): ports whose live offset is not on the surface are composed from pages; a promised composition that cannot
   * happen becomes ordinary scroll damage (built by the next pump).
   * @param {Entry} entry @param {Round} round
   */
  function scrollStep(entry, round) {
    if (!extras.scrollPlan || !entry.surface || entry.lost) return;
    const out = compositor.step(entry, () => {
      try {
        const surface = writable(entry);
        if (entry.patch.visible()) entry.patch.hide(surface);
        return surface;
      } catch (err) {
        noteFailure(entry, err, 'scroll-compose');
        return null;
      }
    });
    for (const r of out.fallback) markDamage(entry.el, r, 'scroll');
    if (!out.dirty.length) return;
    round.wrote = true;
    round.composed = true;
    for (const r of out.dirty) round.dirty = round.dirty === null ? null : unionRect(round.dirty ?? null, r);
  }

  // A backdrop tile arrived: every field still waiting for its value to reach a tile gets its overlay at the next commit.
  const backdrops = createBackdropCache({
    capture(control, rectCss, geo) {
      const entry = [...entries.values()].find((e) => e.ovControl === control);
      if (!entry) return null;
      try {
        const req = requestOf(env, entry.record, entry.el, rectCss, 0, { geo, lastNodes: entry.lastNodes, resources: pumpDeps.resources, interaction: pumpDeps.interaction(entry.record) });
        const result = capture({ ...req, hideText: control });
        return result.unsupported?.length ? null : result.url;
      } catch (err) {
        env.reporter.caught(err, 'snapshot-store:overlay-backdrop');
        return null;
      }
    },
    decode: (url) => pumpDeps.decode(url),
    canvas: makeCanvas,
    landed() {
      for (const e of entries.values()) if (e.ovControl && e.ovSeq > e.ovTileSeq) e.ovQueued = true;
    },
    schedule(run) {
      const entry = [...entries.values()].find((e) => e.ovControl);
      if (entry) side.push({ entry, run }); else run();
    },
  });

  // ---------------------------------------------------------------------------------------------- commit

  /**
   * The first tile of a drawable that still waits for fonts/images is held (up to paintGateMaxWaitMs) so the first paint is not a flash of unstyled content;
   * the 'resource' damage that follows brings a complete tile, which supersedes the held one.
   * @param {Entry} entry @param {Landed[]} items oldest first @param {number} t @returns {boolean}
   */
  function holdsFirstTile(entry, items, t) {
    if (entry.version || entry.firstTakeAt === null || t - entry.firstTakeAt >= options.paintGateMaxWaitMs) return false;
    return !items[items.length - 1].result.complete;
  }

  /**
   * A decoded first tile is waiting and the very next commitLanded() will publish it (it is not held for a still-loading resource). The paint gate counts it as ready:
   * versions only exist after a commit, and the scheduler commits right after the gate opens, so waiting for a version here would deadlock until the gate timeout.
   * @param {Entry} entry @returns {boolean}
   */
  function firstTileLanded(entry) {
    const items = landed.filter((l) => l.entry === entry && isLive(l.entry, l.incarnation));
    if (!items.length) return false;
    items.sort((a, b) => a.generation - b.generation);
    return !holdsFirstTile(entry, items, env.now());
  }

  /** The tile's pixel rect on the surface; null when it does not touch it. @param {Landed} l @returns {Rect|null} */
  function cropPxOf(l) {
    const g = l.geo;
    const whole = { x: 0, y: 0, width: g.widthPx, height: g.heightPx };
    if (l.rect === null) return whole;
    const c = l.result.cropCss ?? l.rect;
    return intersectRect(roundOutRect({ x: c.x + g.ink.left, y: c.y + g.ink.top, width: c.width, height: c.height }, g.scale), whole);
  }

  /** A result that will not be drawn: its rect is re-damaged (reclaim) and, when the surface it was built for is gone, the whole drawable too. @param {Entry} entry @param {Landed} l @param {boolean} wholeAgain */
  function dropResult(entry, l, wholeAgain) {
    const again = damage.reclaim(entry.el, l.rect, l.generation);
    if (wholeAgain) damage.mark(entry.el, null, 'forced', env.now());
    counters.dropped++;
    if (again || wholeAgain) counters.redamaged++;
    settleCost(entry, l, 0);
    releaseImage(l.image);
  }

  /** A result that is consumed without pixels (onUnsupportedContent 'abort', a tile outside the surface): settled, not re-damaged. @param {Entry} entry @param {Landed} l */
  function discardResult(entry, l) {
    damage.committed(entry.el, l.generation);
    settleCost(entry, l, 0);
    releaseImage(l.image);
  }

  /**
   * Where the tile is drawn: in place, a fork of a pinned surface, or a new allocation (full tile with another geometry, a pinned or lost surface). null = a partial tile whose surface is gone or re-laid-out.
   * An in-place target has its caret lifted first, so no saved pixels are stale after the tile.
   * @param {Entry} entry @param {Landed} l @returns {{surface: Surface, fresh: boolean}|null}
   */
  function targetFor(entry, l) {
    const same = !!entry.surface && sameGeometry(entry.geo, l.geo);
    if (l.rect !== null && !same) return null;
    if (l.rect === null && (!same || entry.lost || pinned(/** @type {Surface} */ (entry.surface)))) return { surface: allocateSurface(l.geo.widthPx, l.geo.heightPx), fresh: true };
    const surface = writable(entry);
    if (entry.patch.visible()) entry.patch.hide(surface);
    return { surface, fresh: false };
  }

  /** Forward the capture's unsupported-content entries; true when onUnsupportedContent is 'abort' and the tile must not be committed. @param {Entry} entry @param {CaptureResult} result @returns {boolean} */
  function reportUnsupported(entry, result) {
    for (const u of result.unsupported ?? []) env.reporter.unsupported(u, entry.record.canvas);
    // a 'limited' feature (video-controls, node-budget) is a documented deviation of a tile that still renders: it is reported, never a reason to abort
    return options.onUnsupportedContent === 'abort' && (result.unsupported ?? []).some((u) => featureById(u.feature)?.status !== 'limited');
  }

  /** The tile is caret-free: remember where the capture measured the caret, or forget it when the tile shows the control without one. @param {Entry} entry @param {Landed} l @param {Rect} crop */
  function updateCaret(entry, l, crop) {
    // a tile built before the caret was last measured from the live field (store.caretNow) is older than that caret: keep it
    if (l.startedAt < entry.caretLiveAt) return;
    const measured = l.result.caret;
    if (measured) {
      const g = l.geo;
      const rectPx = roundOutRect({ x: measured.rect.x + g.ink.left, y: measured.rect.y + g.ink.top, width: measured.rect.width, height: measured.rect.height }, g.scale);
      entry.caret = { rectPx, rectCss: measured.rect, color: measured.color };
      entry.phase = interaction ? interaction.snapshot().caretVisible : true;
      entry.caretToggles = 0;
    } else if (l.rect === null || (entry.caret && covers(crop, entry.caret.rectPx))) {
      entry.caret = null;
    }
  }

  /** @param {Entry} entry @param {Landed} l @param {Round} round */
  function commitOne(entry, l, round) {
    if (!damage.accepts(entry.el, l.epoch, l.generation, l.rect === null && !round.current)) { dropResult(entry, l, false); return; }
    const crop = cropPxOf(l);
    if (reportUnsupported(entry, l.result) || !crop) { discardResult(entry, l); return; }
    const t0 = env.now();
    /** @type {{surface: Surface, fresh: boolean}|null} */
    let target;
    try {
      target = targetFor(entry, l);
    } catch (err) {
      noteFailure(entry, err, 'surface');
      dropResult(entry, l, false);
      return;
    }
    if (!target) { dropResult(entry, l, true); return; }
    if (!drawTileAtomic(target.surface, l.image, crop)) {
      noteFailure(entry, new Error('the decoded tile could not be drawn into the retained surface'), 'commit');
      dropResult(entry, l, false);
      return;
    }
    entry.failures = 0;
    entry.failureReported = false;
    bind(entry, target.surface, l.geo);
    if (target.fresh) { entry.lost = false; entry.patch.tileLanded(crop); round.fresh = true; }
    updateCaret(entry, l, crop);
    damage.committed(entry.el, l.generation);
    round.wrote = true;
    round.dirty = l.rect === null || round.dirty === null ? null : unionRect(round.dirty ?? null, l.result.cropCss ?? l.rect);
    round.layoutOffset = l.result.layoutOffset ?? round.layoutOffset;
    round.translation = l.translation ?? round.translation;
    round.tileSeq = Math.max(round.tileSeq ?? 0, l.ovSeq ?? 0);
    for (const sc of compositor.scrollers(entry)) compositor.tileLanded(entry, crop, l.scTops?.get(sc) ?? null, l.scTops?.has(sc) ? sc : null, l.scSeq ?? null, target.surface);
    entry.ovTileSeq = Math.max(entry.ovTileSeq, round.tileSeq);
    counters.tiles++;
    if (l.rect === null) counters.fullTiles++;
    settleCost(entry, l, env.now() - t0);
    releaseImage(l.image);
  }

  /** Paint or lift the caret so the surface shows what the blink phase wants. Costs O(caret rect), never a build. @param {Entry} entry @param {Round} round */
  function syncCaret(entry, round) {
    if (entry.caretToggles) {
      entry.phase = interaction ? interaction.snapshot().caretVisible : entry.caretToggles % 2 ? !entry.phase : entry.phase;
      entry.caretToggles = 0;
    }
    const caret = entry.caret;
    if (!entry.surface || entry.lost) return;
    const want = !!caret && entry.phase;
    if (want === entry.patch.visible()) return;
    try {
      const surface = writable(entry);
      if (want && caret) entry.patch.show(surface, caret.rectPx, caret.color); else entry.patch.hide(surface);
    } catch (err) {
      noteFailure(entry, err, 'caret');
      return;
    }
    round.wrote = true;
    const r = caret?.rectCss;
    if (r) round.dirty = round.dirty === null ? null : unionRect(round.dirty ?? null, { x: r.x - 1, y: r.y - 1, width: r.width + 2, height: r.height + 2 });
  }

  /**
   * Optimistic text overlay (text-paint.js): paint the field's live value when asked, and again after a tile that was built before the latest request (an older value would
   * otherwise come back for a frame). A tile built after the latest request is the authority: the overlay is retired. The re-measured caret replaces the tile's.
   * @param {Entry} entry @param {Round} round
   */
  function overlayStep(entry, round) {
    if (round.tileSeq !== undefined && round.tileSeq >= entry.ovSeq) entry.ovShown = 0;
    const again = entry.ovShown > 0 && (round.tileSeq !== undefined || !!round.composed);
    if (!entry.ovQueued && !again) return;
    entry.ovQueued = false;
    entry.ovShown = 0;
    const control = entry.ovControl;
    const geo = entry.geo;
    const layer = entry.record.layer;
    if (!control) return;
    if (!extras.textOverlay || !entry.surface || !entry.version || !geo || entry.lost || !layer) { overlayMissed(entry, control, null); return; }
    const size = layer.borderBoxSize(entry.el);
    const frame = layer.frameRect(control);
    if (!size || !frame || Math.abs(size.width - geo.bw) > 0.01 || Math.abs(size.height - geo.bh) > 0.01) { overlayMissed(entry, control, frame); return; }
    const plan = extras.textOverlay(control, entry.el, frame, entry.ovEpoch);
    const backdrop = plan && plan.fill === null ? backdrops.get(control, plan, geo, entry.ovEpoch) : null;
    let painted = false;
    if (plan && (plan.fill !== null || backdrop)) {
      try {
        const surface = writable(entry);
        if (entry.patch.visible()) entry.patch.hide(surface);
        painted = paintTextOverlay(surface, geo, plan, backdrop);
      } catch (err) {
        noteFailure(entry, err, 'overlay');
      }
    }
    if (!painted || !plan) { overlayMissed(entry, control, frame); return; }
    entry.ovOk = control;
    entry.ovShown = entry.ovSeq;
    const c = plan.caret;
    entry.caret = c ? { rectPx: roundOutRect({ x: c.rect.x + geo.ink.left, y: c.rect.y + geo.ink.top, width: c.rect.width, height: c.rect.height }, geo.scale), rectCss: c.rect, color: c.color } : null;
    entry.phase = interaction ? interaction.snapshot().caretVisible : true;
    entry.caretToggles = 0;
    round.wrote = true;
    round.dirty = round.dirty === null ? null : unionRect(round.dirty ?? null, inflateRect(plan.box, 1));
  }

  /**
   * store.caretNow: the caret follows the focus at once (measured from the live field), the tile with the focus styles comes later and re-measures it.
   * @param {Entry} entry @param {Round} round
   */
  function caretStep(entry, round) {
    const ask = entry.caretAsk;
    if (ask === undefined) return;
    entry.caretAsk = undefined;
    const geo = entry.geo;
    const layer = entry.record.layer;
    /** @type {{rectPx: Rect, rectCss: Rect, color: string}|null} */
    let next = null;
    if (ask !== null) {
      if (!extras.caretOf || !geo || !layer || /** @type {Document|ShadowRoot} */ (ask.getRootNode()).activeElement !== ask) return;
      const frame = layer.frameRect(ask);
      const c = frame ? extras.caretOf(ask, frame) : null;
      if (!c) return;
      next = { rectPx: roundOutRect({ x: c.rect.x + geo.ink.left, y: c.rect.y + geo.ink.top, width: c.rect.width, height: c.rect.height }, geo.scale), rectCss: c.rect, color: c.color };
    }
    // a caret shown elsewhere is lifted first (syncCaret only toggles visibility)
    const old = entry.caret;
    if (entry.patch.visible() && entry.surface && !entry.lost) {
      try {
        entry.patch.hide(writable(entry));
        round.wrote = true;
        if (old) round.dirty = round.dirty === null ? null : unionRect(round.dirty ?? null, inflateRect(old.rectCss, 1));
      } catch (err) {
        noteFailure(entry, err, 'caret');
        return;
      }
    }
    entry.caret = next;
    entry.caretLiveAt = env.now();
    if (next) {
      entry.phase = interaction ? interaction.snapshot().caretVisible : true;
      entry.caretToggles = 0;
    }
  }

  /**
   * The overlay could not be painted: the field's snapshot was deferred to the end of the typing (input-observer) on the promise of the overlay, so it is damaged now.
   * @param {Entry} entry @param {Element} control @param {Rect|null} frame
   */
  function overlayMissed(entry, control, frame) {
    if (entry.ovOk === control) entry.ovOk = null;
    if (!entry.ovDeferred) return;
    entry.ovDeferred = false;
    markDamage(entry.el, frame ? inflateRect(frame, options.inkMargin) : null, 'input');
  }

  /** One immutable version per drawable per round. @param {Entry} entry @param {Round} round @param {number} t @param {boolean} first */
  function publish(entry, round, t, first) {
    const geo = /** @type {Geometry} */ (entry.geo);
    const box = entry.record.contentBox;
    const prev = entry.version;
    const version = newVersion({
      element: prev?.element ?? new WeakRef(entry.el), canvasId: entry.record.id, width: geo.bw, height: geo.bh, canvasWidth: box.width, canvasHeight: box.height,
      translation: round.translation ?? prev?.translation ?? new DOMMatrixReadOnly(), blend: entry.blend, backdrop: entry.backdrop, scale: geo.scale, ink: geo.ink,
      layoutOffset: round.layoutOffset ?? prev?.layoutOffset ?? null, surface: /** @type {Surface} */ (entry.surface),
      dirty: round.fresh || first ? null : round.dirty ?? null,
    }, t);
    entry.version = version;
    counters.commits++;
    runaway.commit(t);
    env.bus.emit(BUS.SOURCE_VERSION, { record: entry.record, version });
  }

  /**
   * A tile was planned from the layout read at build time. During a resize the live element can still carry the polyfill's previous hit-test transform, which makes that
   * read a fraction of a pixel off (measured: a surface one device pixel wider than the final layout, left resampled and blurry for good because no damage follows an idle page).
   * One pump after a commit (the paint handler has redrawn and refreshed the geometry by then) the surface geometry is compared with the current plan; a difference re-rasters the
   * drawable. Bounded: three consecutive corrections at most.
   */
  function verifyGeometries() {
    for (const entry of entries.values()) {
      if (!entry.verifyGeometry) continue;
      entry.verifyGeometry = false;
      const { record, el } = entry;
      if (!entry.surface || !entry.geo || entry.lost || entry.refused || record.state !== 'active' || damage.hasPending(el)) continue;
      const size = record.layer?.borderBoxSize(el);
      if (!size || !(size.width > 0 && size.height > 0)) continue;
      let plan;
      try { plan = planGeometry(env, record, size, retainedBytes(entry), el); } catch { continue; }
      if (sameGeometry(plan, entry.geo)) { entry.geometryRetries = 0; continue; }
      if (entry.geometryRetries >= 3) continue;
      entry.geometryRetries++;
      markDamage(el, null, 'resize');
    }
  }

  /** @param {Entry} entry @param {Landed[]} items oldest generation first @param {number} t @param {boolean} current see commitLanded @returns {boolean} a version was published */
  function commitEntry(entry, items, t, current) {
    /** @type {Round} */
    const round = { wrote: false, fresh: false, dirty: undefined, layoutOffset: undefined, translation: undefined, current };
    const first = !entry.version;
    for (const l of items) commitOne(entry, l, round);
    if (items.length) entry.verifyGeometry = true;
    scrollStep(entry, round);
    overlayStep(entry, round);
    caretStep(entry, round);
    syncCaret(entry, round);
    if (!round.wrote || !entry.surface) return false;
    publish(entry, round, t, first);
    return true;
  }

  /**
   * Landed results of live drawables; held first tiles stay queued. With `record` only that canvas is taken: the landed results of the other canvases stay queued untouched
   * (a canvas whose paint gate is closed must not be committed because another canvas opens).
   * @param {number} t @param {CanvasRecord} [record] @returns {Map<Entry, Landed[]>}
   */
  function takeLanded(t, record) {
    const queued = landed.splice(0, landed.length);
    const mine = record ? queued.filter((l) => l.entry.record === record) : queued;
    if (record) landed.push(...queued.filter((l) => l.entry.record !== record));
    const live = mine.filter((l) => isLive(l.entry, l.incarnation) || (releaseImage(l.image), counters.dropped++, false));
    const groups = groupByEntry(live);
    for (const [entry, items] of groups) {
      if (!holdsFirstTile(entry, items, t)) continue;
      landed.push(...items);
      groups.delete(entry);
    }
    for (const entry of entries.values()) if ((entry.caretToggles || entry.ovQueued || entry.caretAsk !== undefined || compositor.queued(entry)) && !groups.has(entry) && (!record || entry.record === record)) groups.set(entry, []);
    return groups;
  }

  /**
   * @param {CanvasRecord} [record]
   * @param {{current?: boolean}} [opts]  current: the paint that follows must show the DOM as it is now (requestPaint(), first mount, shown again): a whole tile that a DOM mutation
   *   superseded while it decoded is reclaimed instead of committed, so that paint waits for the rebuild (WPT nested-tainted-canvas: a child canvas drawn right before requestPaint())
   * @returns {ChangeSet}
   */
  function commitLanded(record, { current = false } = {}) {
    const t = env.now();
    const groups = takeLanded(t, record);
    /** @type {Set<Element>} */
    const changed = new Set();
    for (const el of [...pendingChanged]) {
      if (record && entries.get(el)?.record !== record) continue;
      pendingChanged.delete(el);
      changed.add(el);
    }
    for (const [entry, items] of groups) if (commitEntry(entry, items, t, current)) changed.add(entry.el);
    const removed = new Map();
    for (const [el, owner] of [...pendingRemoved]) {
      if (record && owner !== record) continue;
      pendingRemoved.delete(el);
      removed.set(el, owner);
    }
    for (const el of changed) removed.delete(el);
    emitCommits(changed, removed);
    return { changed: [...changed].sort(treeOrder), removed: [...removed.keys()].sort(treeOrder) };
  }

  /** One BUS.COMMIT per canvas. @param {Set<Element>} changed @param {Map<Element, CanvasRecord>} removed */
  function emitCommits(changed, removed) {
    /** @type {Map<CanvasRecord, {changed: Element[], removed: Element[]}>} */
    const byRecord = new Map();
    const slot = (/** @type {CanvasRecord} */ record) => {
      let set = byRecord.get(record);
      if (!set) byRecord.set(record, (set = { changed: [], removed: [] }));
      return set;
    };
    for (const el of changed) { const e = entries.get(el); if (e) slot(e.record).changed.push(el); }
    for (const [el, record] of removed) slot(record).removed.push(el);
    for (const [record, set] of byRecord) env.bus.emit(BUS.COMMIT, { record, changed: set.changed.sort(treeOrder), removed: set.removed.sort(treeOrder) });
  }

  // ---------------------------------------------------------------------------------------------- lifecycle and bus

  /** @param {CanvasRecord} record */
  function forget(record) {
    for (const entry of entriesOf(record)) dropEntry(entry, false);
    for (const [el, r] of pendingRemoved) if (r === record) pendingRemoved.delete(el);
  }

  const offs = [
    env.bus.on(BUS.DRAWABLES_CHANGED, (/** @type {{record: CanvasRecord, added: Element[], removed: Element[]}} */ e) => {
      for (const el of e.removed) { const entry = entries.get(el); if (entry) dropEntry(entry, true); }
      for (const el of e.added) { track(e.record, el); markDamage(el, null, 'forced'); }
    }),
    // Metadata-only versions: the old pixels stay anchored (no blank frame) while the structural damage re-rasters at the new layout.
    env.bus.on(BUS.RESIZE, (/** @type {{record: CanvasRecord, contentBox: ContentBox}} */ e) => {
      const t = env.now();
      for (const entry of entriesOf(e.record)) {
        markDamage(entry.el, null, 'resize');
        if (!entry.version) continue;
        entry.version = reviseVersion(entry.version, { canvasWidth: e.contentBox.width, canvasHeight: e.contentBox.height }, t); // same surface, new canvas size
        pendingChanged.add(entry.el);
      }
    }),
    env.bus.on(BUS.DPR, () => markAll(entries.values(), 'dpr')),
    env.bus.on(BUS.CANVAS_UNMOUNTING, (/** @type {{record: CanvasRecord}} */ e) => forget(e.record)),
  ];

  /** A build of the same pump round as an already landed one is still decoding. @param {CanvasRecord} record @returns {boolean} */
  function coherenceOpen(record) {
    const batches = new Set();
    for (const l of landed) if (l.entry.record === record) batches.add(l.batch);
    if (!batches.size) return false;
    for (const j of jobs) if (j.entry.record === record && batches.has(j.batch)) return true;
    return false;
  }

  /** @type {SnapshotStore} */
  const store = {
    version: (el) => entries.get(el)?.version ?? null,
    pin(el) {
      const v = entries.get(el)?.version;
      if (!v) throw invalidState('the element has no snapshot yet (it was never painted, or its drawable state was reset)');
      v.refs++;
      v.pinned = true;
      pins.set(v.surface, (pins.get(v.surface) ?? 0) + 1);
      return v;
    },
    unpin(v) {
      if (v.refs <= 0) return;
      v.refs--;
      v.pinned = v.refs > 0;
      const n = (pins.get(v.surface) ?? 1) - 1;
      if (n > 0) pins.set(v.surface, n); else pins.delete(v.surface);
    },
    rasterSource: rasterSourceFor,
    markDamage,
    caretNow(drawable, control) {
      const entry = entries.get(drawable);
      if (entry && entry.version) entry.caretAsk = control;
    },
    overlayText(drawable, control) {
      const entry = entries.get(drawable);
      if (!entry || !extras.textOverlay) return false;
      entry.ovSeq++;
      entry.ovControl = control;
      entry.ovQueued = true;
      // the snapshot may wait for the typing to pause only while this field's overlay is known to work (a failure at the next commit damages it at once)
      entry.ovDeferred = entry.ovOk === control;
      return entry.ovDeferred;
    },
    invalidateAll: (cause) => markAll(entries.values(), cause),
    needsPump() {
      if (side.length) return true;
      for (const entry of entries.values()) if (entry.verifyGeometry || damage.hasPending(entry.el)) return true;
      return false;
    },
    pump: (now, budget) => {
      verifyGeometries();
      const out = runPump(env, pumpDeps, now, budget);
      // side builds (scroll pages, plans, overlay backdrops) never run in a pump inside the rendering update: they would delay that frame
      if (!budget.urgent) runSide(out, budget); else if (side.length) { out.moreWork = true; out.nextDueAt = out.nextDueAt ?? env.now(); }
      return out;
    },
    scrollSettled(drawable, scroller) {
      const entry = entries.get(drawable);
      if (entry && extras.scrollPlan) compositor.prepare(entry, scroller);
    },
    scrollCompose(drawable, scroller) {
      const entry = entries.get(drawable);
      const served = !!entry && !!extras.scrollPlan && compositor.serve(entry, scroller);
      // a composed step is asked for by the page (a scroll event) as much as a built one is: without this, a scroll composed for 3 s with no other change (a long
      // fling, a stream that starts composed) looked like a feedback loop to the runaway guard, and the polyfill uninstalled itself
      if (served) runaway.damage('scroll', env.now());
      return served;
    },
    hasLanded(record) {
      for (const el of pendingChanged) if (!record || entries.get(el)?.record === record) return true;
      for (const owner of pendingRemoved.values()) if (!record || owner === record) return true;
      for (const entry of entries.values()) if ((entry.caretToggles || entry.ovQueued || entry.caretAsk !== undefined || compositor.queued(entry)) && (!record || entry.record === record)) return true;
      if (!landed.length) return false;
      const t = env.now();
      for (const [entry, items] of groupByEntry(landed)) if ((!record || entry.record === record) && !holdsFirstTile(entry, items, t)) return true;
      return false;
    },
    commitLanded,
    forget,
    has: (el) => entries.has(el),
    isSettled(el) {
      const entry = entries.get(el);
      if (!entry) return true;
      return !damage.hasPending(el) && entry.decoding === 0 && entry.caretToggles === 0 && !entry.ovQueued && entry.caretAsk === undefined && !(entry.ovControl && backdrops.busy())
        && !compositor.queued(entry) && !compositor.busy(entry) && !side.some((j) => j.entry === entry) && !landed.some((l) => l.entry === entry);
    },
    isFresh(record) {
      for (const entry of entriesOf(record)) {
        if (entry.refused || entry.lost || entry.failures >= 3 || !record.layer?.isLaidOut(entry.el)) continue;
        if (damage.hasPending(entry.el) || entry.decoding > 0) return false;
      }
      return true;
    },
    isPaintReady(record) {
      const layer = record.layer;
      let any = false;
      for (const el of layer?.drawableElements() ?? []) {
        if (!layer?.isLaidOut(el)) continue;
        any = true;
        const entry = entries.get(el);
        if (!entry?.version && !entry?.refused && !(entry && firstTileLanded(entry))) return { ready: false, reason: 'first-commit' };
      }
      if (!any) return { ready: true, reason: 'no-drawables' };
      if (options.coherentPaint && coherenceOpen(record)) return { ready: false, reason: 'coherence' };
      return { ready: true, reason: 'ready' };
    },
    stats() {
      const surfaces = new Set();
      let degraded = 0, rasterScale = 0;
      for (const e of entries.values()) {
        if (e.surface) surfaces.add(e.surface);
        if (e.lastNodes > options.nodeBudget.hard) degraded++;
        if (e.version) rasterScale = Math.max(rasterScale, e.version.scale);
      }
      return {
        ...counters, cloneMsP50: cloneMs.percentile(0.5), cloneMsP95: cloneMs.percentile(0.95), decodeMsP50: decodeMs.percentile(0.5), decodeMsP95: decodeMs.percentile(0.95),
        decodeMainMsP95: decodeMainMs.percentile(0.95), degraded, surfaces: surfaces.size, surfaceBytes: retainedBytes(), rasterScale, pinnedSurfaces: pins.size, scroll: compositor.stats(),
      };
    },
    dispose() {
      nextTask.dispose();
      for (const off of offs) off();
      for (const l of landed.splice(0, landed.length)) releaseImage(l.image);
      for (const entry of [...entries.values()]) dropEntry(entry, false);
      pendingChanged.clear();
      pendingRemoved.clear();
      jobs.clear();
      pins.clear();
    },
  };
  return store;
}
