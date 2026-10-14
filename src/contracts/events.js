/**
 * Names shared by every module: internal bus topics, public DOM event names, polyfill-owned DOM markers.
 * Constants only.
 */

/** Internal topics (Bus.on/emit). Payload types in the comment. */
export const BUS = Object.freeze({
  /** {record: CanvasRecord} layer mounted, snapshotting begins */
  CANVAS_MOUNTED: 'canvas:mounted',
  /** {record: CanvasRecord} just before children are restored (uninstall, content=fallback, canvas removed) */
  CANVAS_UNMOUNTING: 'canvas:unmounting',
  /** {record: CanvasRecord, state: string, previous: string}. Emitted by the registry only. */
  CANVAS_STATE: 'canvas:state',
  /** {record, added: Element[], removed: Element[]} eligible drawable set changed (live -> snapshot, api) */
  DRAWABLES_CHANGED: 'drawables:changed',
  /** Damage (contracts/types.js). Observers publish it through Scheduler.damage(), not directly. */
  DAMAGE: 'damage',
  /** {record, changed: Element[], removed: Element[]} commitLanded() produced a change set */
  COMMIT: 'snapshot:commit',
  /** {record, contentBox: ContentBox, previous: ContentBox} canvas content box changed (resize) */
  RESIZE: 'canvas:resize',
  /** {dpr: number} devicePixelRatio changed (page zoom / monitor move) */
  DPR: 'dpr:changed',
  /** {record, version: SnapshotVersion} effects: a new source version is available for upload */
  SOURCE_VERSION: 'source:version',
  /** {commits: number, windowMs: number} the snapshot pipeline committed >= 30/s for 3 s with no outside damage (store/runaway.js); install.js reports it and uninstalls */
  RUNAWAY: 'runaway',
  /** {root: ShadowRoot} a shadow root was observed (attachShadow patch, initial walk, adoptRoot). Emitted by live/root-scope.js only. */
  ROOT_ADDED: 'root:added',
  /** {record, element: Element} a retained surface lost its 2D context and was re-rastered (whole-drawable damage 'forced' is queued). Emitted by the store only. */
  SURFACE_RESTORED: 'surface:restored',
});

/** Public DOM events (the first two are the standard ones). */
export const EVENTS = Object.freeze({
  PAINT: 'paint',
  ELEMENT_GEOMETRY_UPDATE: 'elementgeometryupdate',
  /** polyfill extension, CustomEvent<UnsupportedEntry>, bubbles:false, dispatched on the canvas */
  UNSUPPORTED: 'hicunsupported',
  /** polyfill extension, CustomEvent, dispatched on the canvas by the effect host */
  EFFECT_FRAME: 'effectframe',
  EFFECT_ERROR: 'effecterror',
});

/** DOM markers owned by the polyfill. Observers MUST ignore mutations on nodes carrying NODE_ATTR. */
export const MARK = Object.freeze({
  /** on the live layer; value = CanvasRecord.id */
  LAYER_ATTR: 'data-hic-layer',
  /** tag name of the layer element: an unknown element, so author `div`, `:nth-of-type`, `* > *` margin rules never target it (ADR-A) */
  LAYER_TAG: 'hic-layer',
  /** ids the polyfill generates for TOP-LEVEL logical children that have none, so the canvas can `aria-owns` them (ADR-M). Removed on unmount. */
  OWNS_ID_PREFIX: 'hic-o-',
  /** on the canvas element itself; value = CanvasRecord.id. Carries the CSS anchor-name hook of the layer (ADR-A). The only attribute besides a merged `aria-owns` (ADR-M) that the polyfill writes on the canvas. */
  CANVAS_ATTR: 'data-hic-canvas',
  /** on a LIVE drawable that is in the canvas's list of drawn elements (hit-testable, ADR-F); absent = pointer-events:none. Value = a per-root geometry key; the transform/clip live in a rule of the polyfill sheet, never in the style attribute. */
  HIT_ATTR: 'data-hic-hit',
  /** on every polyfill-created node (layer, placeholders, caret overlay) */
  NODE_ATTR: 'data-hic-node',
  /** classes written ONLY into the clone, never into live DOM */
  CLS_ROOT: 'hic-root',
  CLS_FOCUS: 'hic-focus',
  CLS_FOCUS_WITHIN: 'hic-focus-within',
  CLS_FOCUS_VISIBLE: 'hic-focus-visible',
  CLS_HOVER: 'hic-hover',
  CLS_ACTIVE: 'hic-active',
  CLS_NESTED: 'hic-nested-drawable',
  /** injected <style> id */
  STYLE_ID: 'hic-style',
  /** Symbol.for key stamped on every function/descriptor the polyfill installs (double-install and native detection) */
  PATCH_SYMBOL: Symbol.for('hic.patch'),
});

/** Attribute / property names of the extensions. */
export const EXT = Object.freeze({
  FRAME_CAP_ATTR: 'framecap',
  FRAME_CAP_PROP: 'frameCap',
  FRAME_CAP_MIN: 1,
  FRAME_CAP_MAX: 240,
  /** global namespace of the effect API */
  EFFECTS_GLOBAL: 'HTMLInCanvasEffects',
  /** debug/report handle */
  DEBUG_GLOBAL: '__HIC__',
  /** Symbol.for slot of the HicInstalled of a window (shared by every copy of the library on the page) */
  INSTALLED_KEY: Symbol.for('hic.installed'),
  /** Symbol.for key of the EffectsSeam hung on the HicInstalled: how the optional effects bundle reaches the core internals */
  EFFECTS_SEAM_KEY: Symbol.for('hic.effects-seam'),
  /** Symbol.for slot on globalThis where the optional native-bridge bundle registers installNativeBridge */
  NATIVE_BRIDGE_KEY: Symbol.for('hic.native-bridge'),
});
