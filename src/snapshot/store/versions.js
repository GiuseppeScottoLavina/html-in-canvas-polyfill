/**
 * SnapshotVersion construction and the metadata-only rebase used on resize.
 * Module: snapshot-store (src/snapshot/store/*).
 */

/** @typedef {import('../../contracts/types.js').ContentBox} ContentBox */
/** @typedef {import('../../contracts/types.js').Rect} Rect */
/** @typedef {import('../../contracts/types.js').SnapshotVersion} SnapshotVersion */

let nextId = 1;

/**
 * Immutable SnapshotVersion: every field is read-only and the object is not extensible; only the `pinned`/`refs` counters stay writable (the store owns them).
 * `dirty` (not in the contract typedef, read by effects/source-provider.js) is the border-box-frame css rect whose pixels differ from the previous version of the same surface; null = unknown / everything.
 * @param {Omit<SnapshotVersion, "id"|"pinned"|"refs"|"committedAt"> & {dirty?: Rect|null}} p
 * @param {number} now
 * @returns {SnapshotVersion}
 */
export function newVersion(p, now) {
  const fixed = {
    id: nextId++,
    element: p.element,
    canvasId: p.canvasId,
    width: p.width,
    height: p.height,
    canvasWidth: p.canvasWidth,
    canvasHeight: p.canvasHeight,
    translation: p.translation,
    scale: p.scale,
    ink: Object.freeze({ ...p.ink }),
    layoutOffset: p.layoutOffset ? Object.freeze({ x: p.layoutOffset.x, y: p.layoutOffset.y }) : null,
    surface: p.surface,
    committedAt: now,
    dirty: p.dirty ? Object.freeze({ ...p.dirty }) : null,
  };
  /** @type {PropertyDescriptorMap} */
  const descriptors = {};
  for (const [k, value] of Object.entries(fixed)) descriptors[k] = { value, enumerable: true, writable: false, configurable: false };
  descriptors.pinned = { value: false, enumerable: true, writable: true, configurable: false };
  descriptors.refs = { value: 0, enumerable: true, writable: true, configurable: false };
  const v = Object.defineProperties({}, descriptors);
  return /** @type {SnapshotVersion} */ (Object.preventExtensions(v));
}

/**
 * A new version of the same surface or of its fork with other fields (caret-only commit, rebase). Counters start at 0: pins live on the surface (the store counts them per surface).
 * @param {SnapshotVersion} v
 * @param {Partial<Pick<SnapshotVersion, "surface"|"canvasWidth"|"canvasHeight"|"layoutOffset">> & {dirty?: Rect|null}} changes
 * @param {number} now
 * @returns {SnapshotVersion}
 */
export function reviseVersion(v, changes, now) {
  return newVersion({
    element: v.element, canvasId: v.canvasId, width: v.width, height: v.height,
    canvasWidth: changes.canvasWidth ?? v.canvasWidth, canvasHeight: changes.canvasHeight ?? v.canvasHeight,
    translation: v.translation, scale: v.scale, ink: v.ink,
    layoutOffset: changes.layoutOffset === undefined ? v.layoutOffset : changes.layoutOffset,
    surface: changes.surface ?? v.surface,
    dirty: changes.dirty ?? null,
  }, now);
}

/**
 * New version sharing the same surface with new canvasWidth/canvasHeight (resize). The surface is shared, so the store's per-surface pin count covers every version that reads it.
 * @param {SnapshotVersion} v
 * @param {ContentBox} box
 * @param {number} now
 * @returns {SnapshotVersion}
 */
export function rebaseVersion(v, box, now) {
  return reviseVersion(v, { canvasWidth: box.width, canvasHeight: box.height }, now);
}

/**
 * PURE. The first two lengths of a computed `transform-origin` ("120px 40.5px", optionally followed by a z length); a keyword or an unparsable value reads as 0.
 * @param {string} value
 * @returns {{x: number, y: number}}
 */
export function parseTransformOrigin(value) {
  const [x, y] = String(value ?? '').trim().split(/\s+/).map((part) => parseFloat(part));
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
}
