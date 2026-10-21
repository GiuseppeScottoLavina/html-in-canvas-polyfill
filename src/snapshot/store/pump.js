/**
 * Starts builds (sync part bounded by PumpBudget) and tracks in-flight decodes.
 * Module: snapshot-store (src/snapshot/store/*).
 *
 * Pacing, in one place: per canvas a build-credit gate (frameCap, maxSnapshotFps, interaction floor), per drawable ONE build in flight (measured: two in flight
 * was not better when measured), and one install-wide main-thread budget. A tile costs its synchronous build PLUS its decode wall PLUS its commit draw (decode is not
 * off-thread, ADR-D.8); the budget is a token bucket that refills at `mainThreadShare` ms per ms, so the long-run share is bounded and a build is only ever delayed, never starved.
 */

import { chooseScale, gridRasterScale } from './surfaces.js';
import { inflateRect, intersectRect, roundOutRect } from '../../util/rect.js';

/** @typedef {import('../../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../../contracts/types.js').CaptureFn} CaptureFn */
/** @typedef {import('../../contracts/types.js').CaptureRequest} CaptureRequest */
/** @typedef {import('../../contracts/types.js').CaptureResult} CaptureResult */
/** @typedef {import('../../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../../contracts/types.js').InteractionSnapshot} InteractionSnapshot */
/** @typedef {import('../../contracts/types.js').Insets} Insets */
/** @typedef {import('../../contracts/types.js').PumpBudget} PumpBudget */
/** @typedef {import('../../contracts/types.js').PumpResult} PumpResult */
/** @typedef {import('../../contracts/types.js').Rect} Rect */
/** @typedef {import('../../contracts/types.js').ResourceCache} ResourceCache */
/** @typedef {import('../../contracts/types.js').Size} Size */
/** @typedef {import('../../contracts/types.js').SnapshotVersion} SnapshotVersion */
/** @typedef {import('./caret-patch.js').CaretPatch} CaretPatch */
/** @typedef {import('./damage.js').DamageTracker} DamageTracker */
/** @typedef {HTMLCanvasElement|OffscreenCanvas} Surface */

/** Damage above this share of the surface becomes a full tile (ARCHITECTURE ADR-D.6). */
const FULL_TILE_SHARE = 0.55;
/** css px: measured ink overflow beyond this per side is clipped (the surface budget still applies to what is kept) */
const MAX_INK = 2048;
/** Cost assumed for a drawable that has no measured tile yet, ms. */
const DEFAULT_TILE_COST_MS = 3;
/** Damage that may ride along with scroll damage inside the scrolled box without losing its exception (pumpRecord): hover follows the rows that pass under a still pointer. */
const SCROLL_RIDERS = new Set(['hover']);
/** Drawables above nodeBudget.hard build at most this often, ms (4 fps). */
const DEGRADED_INTERVAL_MS = 250;
/**
 * A build whose synchronous part took at least this long starts its decode in the NEXT task: `img.src = url` makes the engine create the isolated SVG
 * document (XML parse, stylesheet parse, style) in the same task, and the two together were the remaining tasks > 8.33 ms of typing (measured 3-4 per 20 keys, ~10 ms each).
 * Not for urgent builds (focus / active in the input task, resize inside the frame): a task posted from either runs only after the next frame.
 */
const SPLIT_DECODE_MS = 3.5;

/**
 * @typedef {Object} Geometry  what one surface covers: border box + ink at a raster scale
 * @property {number} bw  border box width, css px
 * @property {number} bh
 * @property {number} scale
 * @property {boolean} reduced  scale is below clamp(gridScale, 1, maxDpr)
 * @property {Insets} ink
 * @property {number} widthPx  surface size
 * @property {number} heightPx
 */

/**
 * @typedef {Object} Entry  everything the store keeps per tracked drawable
 * @property {Element} el
 * @property {CanvasRecord} record
 * @property {number} incarnation  bumped by drop(): results of an older incarnation are discarded
 * @property {Surface|null} surface
 * @property {Geometry|null} geo   geometry of `surface`
 * @property {SnapshotVersion|null} version
 * @property {number} decoding     builds started and not yet landed / failed
 * @property {number|null} costEma ms per tile (sync build + decode wall + commit draw)
 * @property {number} lastNodes
 * @property {number} lastTakeAt
 * @property {number|null} firstTakeAt
 * @property {number} notBefore    backoff after a failed build
 * @property {number} failures
 * @property {boolean} refused     surface does not fit the budget: no builds until the next structural damage
 * @property {boolean} lost        2D context of the surface is lost
 * @property {boolean} reducedReported
 * @property {CaretPatch} patch
 * @property {{rectPx: Rect, rectCss: Rect, color: string}|null} caret   measured by the last tile that knew (surface px and border-box css px); null = none
 * @property {boolean} phase       blink phase wanted (true = visible)
 * @property {number} caretToggles pending 'caret' damage not yet applied
 * @property {(() => void)|null} unwatch  removes the context-loss listeners of `surface`
 * @property {boolean} failureReported  the current failure streak was reported already (once per streak)
 * @property {boolean} verifyGeometry  a tile was committed: the next pump checks that the surface still matches the layout (see store.verifyGeometries)
 * @property {number} geometryRetries  consecutive re-rasters caused by that check (bounded)
 * @property {number} ovSeq  optimistic text overlays requested so far (store.overlayText)
 * @property {number} ovShown  ovSeq of the overlay the surface shows; 0 = none (the tiles are the authority)
 * @property {Element|null} ovControl  the field of the last overlay request
 * @property {boolean} ovQueued  an overlay request waits for the next commit
 * @property {number} ovTileSeq  highest Job.ovSeq committed so far
 * @property {number} ovEpoch  bumped by every damage that is not typing (the overlay planner's obstruction cache key)
 * @property {Element|null} ovOk  the field whose last overlay was painted (its snapshot may wait for a typing pause)
 * @property {boolean} ovDeferred  the pending overlay request deferred the field's snapshot (a failure must damage it)
 * @property {number} caretLiveAt  performance.now() of the last live caret measurement (caretNow): tiles built before it do not replace that caret
 * @property {Element|null|undefined} caretAsk  store.caretNow: undefined = nothing asked; null = drop the caret; an element = measure its caret at the next commit
 * @property {string} blend  computed mix-blend-mode of the drawable, read with its transform-origin when a build starts (SnapshotVersion.blend)
 */

/**
 * @typedef {Object} Job  one started build
 * @property {Entry} entry
 * @property {number} incarnation
 * @property {number} epoch
 * @property {number} generation
 * @property {Rect|null} rect     the requested (shaped) rect, null = whole
 * @property {Geometry} geo
 * @property {string[]} causes
 * @property {number} batch       builds started by one pump round of one canvas share a batch (coherentPaint)
 * @property {number} startedAt
 * @property {number} syncMs
 * @property {number} estCost     cost charged to the budget at start
 * @property {DOMMatrixReadOnly|null} translation
 * @property {number} ovSeq  Entry.ovSeq when the build started: the tile shows every overlaid value up to it
 * @property {Map<Element, number>|null} scTops  scrollTop of every composed scroller when the build read the DOM (scroll-compose.js)
 * @property {number|null} scSeq  the scroll compositor's damage sequence number when the build read the DOM: its tile repairs the pages for every damage up to it
 * @property {boolean} first  the first build of the drawable (never measured): charged its fixed estimate only, see pumpRecord
 */

/**
 * @typedef {Job & {result: CaptureResult, image: HTMLImageElement, decodeMs: number, landedAt: number}} Landed  a decoded build waiting for commitLanded()
 */

/**
 * @typedef {Object} PumpHost  what the pump needs from the store
 * @property {() => Iterable<Entry>} entries
 * @property {(entry: Entry) => number} usedBytes  bytes of every OTHER retained surface
 * @property {(entry: Entry) => void} notLaidOut
 * @property {(entry: Entry, size: Size, now: number) => void} empty  a laid-out drawable whose border box has no area: publish an EMPTY snapshot
 * @property {(entry: Entry, err: unknown) => void} refuse
 * @property {(entry: Entry, geo: Geometry) => void} reduced
 * @property {(entry: Entry) => DOMMatrixReadOnly|null} translationOf
 * @property {(landed: Landed) => void} landed
 * @property {(job: Job, err: unknown, stage: 'capture'|'decode') => void} fail
 * @property {(entry: Entry) => Element[]} [scrollers]  composed scrollers of the drawable (their offsets are recorded per build)
 * @property {() => number} [scrollSeq]  the scroll compositor's damage sequence number (recorded per build)
 */

/**
 * @typedef {Object} PumpDeps
 * @property {CaptureFn} capture
 * @property {DamageTracker} damage
 * @property {Landed[]} landed
 * @property {Map<number, number>} inFlight  canvas id -> builds decoding
 * @property {Set<Job>} jobs  builds decoding
 * @property {PumpState} state
 * @property {PumpHost} host
 * @property {(url: string) => Promise<HTMLImageElement>} decode
 * @property {number} maxPerDrawable  builds in flight per drawable (1)
 * @property {ResourceCache} resources
 * @property {(record: CanvasRecord) => InteractionSnapshot} interaction
 * @property {(fn: () => void) => void} [nextTask]  run `fn` in a later task (absent: at once)
 */

/** Token bucket of main-thread milliseconds. */
export class CostBudget {
  constructor() {
    this.level = 0;
    this.last = -1;
    this.started = false;
  }

  /** @param {number} now @param {number} share ms of main thread per ms of wall time */
  refill(now, share) {
    const cap = share * 60;
    if (!this.started) { this.started = true; this.level = cap; } else this.level = Math.min(cap, this.level + Math.max(0, now - this.last) * share);
    this.last = now;
  }

  /** @returns {boolean} */
  canStart() {
    return this.level >= 0;
  }

  /** @param {number} ms charge (negative refunds) */
  spend(ms) {
    this.level -= ms;
  }

  /** @param {number} share @returns {number} ms until a build may start */
  waitMs(share) {
    return this.level >= 0 ? 0 : -this.level / Math.max(share, 1e-6);
  }
}

/**
 * Pacing of the build starts of one canvas: a credit of builds that grows by one per interval, so the long-run rate is the cap (also on a display whose frame
 * period does not divide the interval), capped at one and a half builds (less for a cap below 60 fps): after a pause two builds may start one 120 Hz frame apart
 * (a change right after the build that followed the pause is built in the next frame), never three, and a stream settles at the cap. It replaces a phase accumulator whose catch-up (next due up to two intervals in the past) gave that extra build
 * or not depending on the phase left by earlier builds, which the frame of the canvas's first build and any dropped frame decided (WPT onpaint changed between loads).
 * Times are the scheduler's frame time, so the credit moves in whole frames.
 */
export class PhaseGate {
  constructor() {
    /** builds of credit at `at` (one build: a new gate allows one start, then paces) */
    this.credit = 1;
    this.at = -Infinity;
  }

  /** @param {number} interval @returns {number} */
  static tolerance(interval) {
    return Math.min(3, interval * 0.3);
  }

  /** @param {number} now @param {number} interval @returns {number} the credit at `now` */
  level(now, interval) {
    const cap = 1 + 0.5 * Math.min(1, 1000 / 60 / interval);
    return Number.isFinite(this.at) ? Math.min(cap, this.credit + Math.max(0, now - this.at) / interval) : this.credit;
  }

  /** @param {number} now @param {number} interval ms, 0 = uncapped @returns {boolean} */
  isDue(now, interval) {
    return interval <= 0 || this.level(now, interval) >= 1 - PhaseGate.tolerance(interval) / interval;
  }

  /** @param {number} now @param {number} interval */
  started(now, interval) {
    if (interval <= 0) return;
    this.credit = this.level(now, interval) - 1;
    this.at = now;
  }

  /** @param {number} interval @returns {number} performance.now() at which the next start is allowed */
  dueAt(interval) {
    return this.at + (1 - PhaseGate.tolerance(interval) / interval - this.credit) * interval;
  }
}

/**
 * @typedef {Object} PumpState  survives between pump() calls
 * @property {CostBudget} bucket
 * @property {Map<number, PhaseGate>} gates
 * @property {number} batchSeq
 */

/** @returns {PumpState} */
export function createPumpState() {
  return { bucket: new CostBudget(), gates: new Map(), batchSeq: 0 };
}

/** @param {Geometry|null} a @param {Geometry|null} b @returns {boolean} same surface layout */
export function sameGeometry(a, b) {
  return !!a && !!b && Math.abs(a.bw - b.bw) < 0.01 && Math.abs(a.bh - b.bh) < 0.01 && a.scale === b.scale
    && a.widthPx === b.widthPx && a.heightPx === b.heightPx && a.ink.left === b.ink.left && a.ink.top === b.ink.top;
}

/**
 * Geometry of the surface a drawable needs now: border box + ink margin at the chosen raster scale (reduced by the per-drawable and install-wide budgets). Throws HicUnsupportedError('surface-size').
 * @param {HicEnv} env
 * @param {CanvasRecord} record
 * @param {Size} size  border box, css px
 * @param {number} usedBytes
 * @param {Element} [el]  the drawable: its measured ink overflow (LiveLayer.inkOverflow) widens the margin on the sides where it reaches further (native element images cover the ink overflow rect)
 * @returns {Geometry}
 */
export function planGeometry(env, record, size, usedBytes, el) {
  const m = env.options.inkMargin;
  const measured = el ? record.layer?.inkOverflow?.(el) ?? null : null;
  const side = (/** @type {number} */ v) => (v > m ? Math.min(Math.ceil(v), MAX_INK) : m);
  /** @type {Insets} */
  const ink = measured ? { left: side(measured.left), top: side(measured.top), right: side(measured.right), bottom: side(measured.bottom) } : { left: m, top: m, right: m, bottom: m };
  const { scale, reduced } = chooseScale(size, ink, gridRasterScale(record.contentBox, env.window?.devicePixelRatio ?? 0), env.options, usedBytes);
  const snapCeil = (/** @type {number} */ n) => Math.ceil(n - 1e-6);
  return { bw: size.width, bh: size.height, scale, reduced, ink, widthPx: snapCeil((size.width + ink.left + ink.right) * scale), heightPx: snapCeil((size.height + ink.top + ink.bottom) * scale) };
}

/**
 * PURE. Shape a damage rect (border-box frame, css px) into the tile that will be built: grown by the ink margin, rounded out to whole surface pixels, clipped to the surface,
 * and null (= whole drawable + ink) when it covers more than 55 % of it.
 * @param {Rect|null} rect
 * @param {Geometry} geo
 * @param {number} margin
 * @returns {Rect|null}
 */
export function tileRect(rect, geo, margin) {
  if (rect === null) return null;
  const g = inflateRect(rect, margin);
  const s = geo.scale;
  const px = roundOutRect({ x: g.x + geo.ink.left, y: g.y + geo.ink.top, width: g.width, height: g.height }, s);
  const c = intersectRect(px, { x: 0, y: 0, width: geo.widthPx, height: geo.heightPx });
  if (!c || c.width * c.height > FULL_TILE_SHARE * geo.widthPx * geo.heightPx) return null;
  return { x: c.x / s - geo.ink.left, y: c.y / s - geo.ink.top, width: c.width / s, height: c.height / s };
}

/**
 * snapshots per second the build gate of one canvas allows (Infinity = unpaced): min(frameCap raised by the interaction floor, maxSnapshotFps).
 * @param {HicEnv['options']} options
 * @param {CanvasRecord} record
 * @param {PumpBudget} budget
 * @returns {number}
 */
export function buildRate(options, record, budget) {
  let f = record.frameCap > 0 ? record.frameCap : Infinity;
  if (budget.interaction && options.interactionFloorFps > 0) f = Math.max(f, options.interactionFloorFps);
  return Math.min(f, options.maxSnapshotFps > 0 ? options.maxSnapshotFps : Infinity);
}

/** @type {ResourceCache} Used only when the integrator did not give the store the capture module's cache. */
export const NULL_RESOURCES = {
  peek: () => null,
  load: () => Promise.reject(new Error('no resource cache was given to the snapshot store')),
  onReady: () => () => {},
  stats: () => ({ entries: 0, bytes: 0 }),
  clear: () => {},
};

/**
 * Minimal InteractionSnapshot when no InteractionTracker was given: focus inside the layer, no hover/active.
 * @param {HicEnv} env
 * @param {CanvasRecord} record
 * @returns {InteractionSnapshot}
 */
export function defaultInteraction(env, record) {
  const active = env.document.activeElement;
  const layer = record.layer?.element;
  const focus = active && layer && layer.contains(active) ? active : null;
  let focusVisible = false;
  try { focusVisible = !!focus?.matches(':focus-visible'); } catch { /* selector unsupported */ }
  return { hover: new Set(), active: new Set(), focus, focusVisible, caretVisible: true };
}

/**
 * Build the CaptureRequest of one drawable (scale, ink, prune from the budget ladder, interaction snapshot).
 * @param {HicEnv} env
 * @param {CanvasRecord} record
 * @param {Element} el
 * @param {Rect|null} rect
 * @param {number} generation
 * @param {{geo?: Geometry, lastNodes?: number, resources?: ResourceCache, interaction?: InteractionSnapshot}} [extra]
 * @returns {CaptureRequest}
 */
export function requestOf(env, record, el, rect, generation, extra = {}) {
  let geo = extra.geo;
  if (!geo) {
    const size = record.layer?.borderBoxSize(el);
    if (!size) throw new Error('requestOf: the drawable has no border box');
    geo = planGeometry(env, record, size, 0, el);
  }
  return {
    record, element: el, rect, scale: geo.scale, ink: geo.ink, generation,
    resources: extra.resources ?? NULL_RESOURCES,
    prune: (extra.lastNodes ?? 0) > env.options.nodeBudget.soft,
    interaction: extra.interaction ?? defaultInteraction(env, record),
  };
}

/** @param {PumpResult} out @param {number} at */
function later(out, at) {
  out.moreWork = true;
  out.nextDueAt = out.nextDueAt === null ? at : Math.min(out.nextDueAt, at);
}

/**
 * For each drawable with due damage (cap, per-drawable depth and per-canvas maxInFlight respected): take damage, build a CaptureRequest, call capture, start the decode, hand the decoded
 * result to the store (host.landed). Returns PumpResult.
 * Cost model: see the file comment. The first build of a pump is always allowed (progress); further builds stop at budget.mainThreadMs of synchronous time or an empty token bucket.
 * Decode failures keep the previous version and are reported by the host (once).
 * @param {HicEnv} env
 * @param {PumpDeps} deps
 * @param {number} now
 * @param {PumpBudget} budget
 * @returns {PumpResult}
 */
export function runPump(env, deps, now, budget) {
  /** @type {PumpResult} */
  const out = { started: 0, spentMs: 0, moreWork: false, nextDueAt: null };
  budgetUrgent = !!budget.urgent;
  deps.state.bucket.refill(now, budget.mainThreadShare);
  /** @type {Map<CanvasRecord, Entry[]>} */
  const byRecord = new Map();
  for (const entry of deps.host.entries()) {
    if (!deps.damage.hasPending(entry.el)) continue;
    const list = byRecord.get(entry.record);
    if (list) list.push(entry); else byRecord.set(entry.record, [entry]);
  }
  for (const [record, list] of byRecord) {
    list.sort((a, b) => (deps.damage.pendingSince(a.el) ?? 0) - (deps.damage.pendingSince(b.el) ?? 0));
    pumpRecord(env, deps, record, list, now, budget, out);
  }
  return out;
}

/**
 * @param {HicEnv} env @param {PumpDeps} deps @param {CanvasRecord} record @param {Entry[]} list
 * @param {number} now @param {PumpBudget} budget @param {PumpResult} out
 */
function pumpRecord(env, deps, record, list, now, budget, out) {
  if (!record.layer || record.state !== 'active') return;
  const { state } = deps;
  const rate = buildRate(env.options, record, budget);
  const interval = Number.isFinite(rate) ? 1000 / rate : 0;
  let gate = state.gates.get(record.id);
  if (!gate) state.gates.set(record.id, (gate = new PhaseGate()));
  const due = gate.isDue(now, interval);
  // scroll damage alone (a scroller moved; at most hover inside it changed with it) is held by the framecap and the cost bucket only, not by maxSnapshotFps nor by the node-budget
  // interval: its tile is the scroller box, cut to the visible rows in a large drawable, and a native scroller presents every frame (measured: a 2000-row list built
  // 3-4 times per second under DEGRADED_INTERVAL_MS while native drew 67). Any other pending cause keeps every limit. A build started only by this exception takes no
  // credit of the gate (a scroll stream would otherwise drive the credit far below zero and hold the next change for as many intervals).
  const capF = buildRate({ ...env.options, maxSnapshotFps: 0 }, record, budget);
  const scrollDue = gate.isDue(now, Number.isFinite(capF) ? 1000 / capF : 0);
  // a resize / DPR re-raster inside the frame is not held by maxSnapshotFps (the canvas framecap still holds it): the retained tile has the WRONG geometry (stretched), not just
  // older content, and a 60 fps gate on a 120 Hz display phase-locks with the resize steps (every step's tile one frame late: resize convergence bimodal 8 / 16 ms)
  const geometryNow = !!budget.urgent && !(record.frameCap > 0 && record.frameCap <= (env.options.maxSnapshotFps || Infinity));
  const hard = env.options.nodeBudget.hard;
  let batch = 0;
  let paced = false;
  for (const entry of list) {
    if (entry.refused || entry.lost) continue;
    if (!record.layer.isLaidOut(entry.el)) { deps.host.notLaidOut(entry); continue; }
    if (entry.decoding >= deps.maxPerDrawable) continue;
    const scrollOnly = scrollDue && deps.damage.pendingScroll(entry.el, SCROLL_RIDERS, env.options.inkMargin + 1);
    const wait = Math.max(entry.notBefore - now, entry.lastNodes > hard && !scrollOnly ? entry.lastTakeAt + DEGRADED_INTERVAL_MS - now : 0);
    if (wait > 0) { later(out, now + wait); continue; }
    if (!due && !scrollOnly && !(geometryNow && (deps.damage.hasPendingCause(entry.el, 'resize') || deps.damage.hasPendingCause(entry.el, 'dpr')))) { later(out, gate.dueAt(interval)); continue; }
    // The FIRST build of a drawable (never built, so it has no snapshot and holds back every paint of its canvas: paint gate 'first-commit') is not deferred by
    // maxInFlight or by the measured time of this pump, only by the cost bucket, which charges it the fixed DEFAULT_TILE_COST_MS (store.js settleCost): at most
    // 8 first builds per round (bucket cap 21 ms), a number that does not depend on how long cold builds took. Deferring them only delayed the first paint (8 drawables:
    // 4 rounds two frames apart) and made the frame it landed in depend on machine load (WPT onpaint-remove-drawable-element).
    const first = entry.costEma === null;
    if (!first && (deps.inFlight.get(record.id) ?? 0) >= budget.maxInFlight) continue;
    if (!first && out.started > 0 && out.spentMs >= budget.mainThreadMs) { later(out, now); continue; }
    if (!state.bucket.canStart()) { later(out, now + state.bucket.waitMs(budget.mainThreadShare)); continue; }
    batch ||= ++state.batchSeq;
    const spent = startBuild(env, deps, entry, now, batch);
    if (spent !== null) { out.started++; out.spentMs += spent; paced ||= !first && (due || !scrollOnly); }
  }
  // first builds use no credit of the rate gate either: the build after the first paint was otherwise held a frame, or not when the first frame was long (a cold
  // page), and a page that changes the DOM every frame then stayed in either rhythm (WPT onpaint-remove-non-drawable-element passed or failed every subtest by turns)
  if (paced) gate.started(now, interval);
}

/**
 * Take the damage of one drawable and start its build. Returns the synchronous ms spent, or null when nothing was started.
 * @param {HicEnv} env @param {PumpDeps} deps @param {Entry} entry @param {number} now @param {number} batch
 * @returns {number|null}
 */
function startBuild(env, deps, entry, now, batch) {
  const { record, el } = entry;
  const { host } = deps;
  const size = record.layer?.borderBoxSize(el);
  if (!size) { host.notLaidOut(entry); return null; }
  if (!(size.width > 0 && size.height > 0)) { host.empty(entry, size, now); return null; }
  /** @type {Geometry} */
  let geo;
  try {
    geo = planGeometry(env, record, size, host.usedBytes(entry), el);
  } catch (err) {
    host.refuse(entry, err);
    return null;
  }
  if (geo.reduced) host.reduced(entry, geo);
  const sameLayout = !!entry.surface && sameGeometry(geo, entry.geo);
  const taken = deps.damage.take(el, (rect) => (sameLayout ? tileRect(rect, geo, env.options.inkMargin) : null));
  if (!taken) return null;
  entry.firstTakeAt ??= now;
  entry.lastTakeAt = now;
  const est = entry.costEma ?? DEFAULT_TILE_COST_MS;
  deps.state.bucket.spend(est);
  /** @type {Job} */
  const job = { entry, incarnation: entry.incarnation, epoch: taken.epoch, generation: taken.generation, rect: taken.rect, geo, causes: taken.causes, batch, startedAt: now, syncMs: 0, estCost: est, first: entry.costEma === null, translation: null, ovSeq: entry.ovSeq, scTops: null, scSeq: null };
  const scrollers = host.scrollers?.(entry) ?? [];
  if (scrollers.length) { job.scTops = new Map(scrollers.map((s) => [s, /** @type {HTMLElement} */ (s).scrollTop])); job.scSeq = host.scrollSeq?.() ?? null; }
  const t0 = env.now();
  /** @type {CaptureResult} */
  let result;
  try {
    job.translation = host.translationOf(entry);
    const req = requestOf(env, record, el, taken.rect, taken.generation, { geo, lastNodes: entry.lastNodes, resources: deps.resources, interaction: deps.interaction(record) });
    result = deps.capture(req);
  } catch (err) {
    job.syncMs = env.now() - t0;
    host.fail(job, err, 'capture');
    return job.syncMs;
  }
  job.syncMs = env.now() - t0;
  // scroll damage decodes at once: while the browser animates a wheel scroll it runs rendering updates back to back and a posted task waits for the animation to end
  // (measured: the first wheel tick of a stream drawn 150-180 ms late)
  if (deps.nextTask && !budgetUrgent && job.syncMs >= SPLIT_DECODE_MS && !job.causes.includes('scroll')) {
    const later = () => { if (job.incarnation === entry.incarnation) startDecode(env, deps, job, result); else deps.host.fail(job, new Error('drawable dropped before its decode started'), 'decode'); };
    entry.decoding++;
    deps.nextTask(() => { entry.decoding--; later(); });
  } else startDecode(env, deps, job, result);
  return job.syncMs;
}

/** the current pump is an urgent one (set by runPump from PumpBudget.urgent) */
let budgetUrgent = false;

/** @param {HicEnv} env @param {PumpDeps} deps @param {Job} job @param {CaptureResult} result */
function startDecode(env, deps, job, result) {
  const id = job.entry.record.id;
  job.entry.decoding++;
  deps.inFlight.set(id, (deps.inFlight.get(id) ?? 0) + 1);
  deps.jobs.add(job);
  const t = env.now();
  const settle = () => {
    job.entry.decoding--;
    deps.inFlight.set(id, Math.max(0, (deps.inFlight.get(id) ?? 1) - 1));
    deps.jobs.delete(job);
  };
  deps.decode(result.url).then(
    (image) => {
      settle();
      const landedAt = env.now();
      deps.host.landed({ ...job, result, image, decodeMs: landedAt - t, landedAt });
    },
    (err) => { settle(); deps.host.fail(job, err, 'decode'); },
  );
}
