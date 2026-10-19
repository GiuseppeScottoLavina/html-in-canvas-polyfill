/**
 * Cross-module typedefs. TYPES ONLY, no runtime code.
 *
 * Shared typed interfaces between the modules; change them deliberately, together with docs/ARCHITECTURE.md.
 * Every module imports what it needs with a one-line local typedef: at-typedef, then import('../contracts/types.js').CanvasRecord in braces, then the name.
 * Units: "css px" = CSS pixels (layout units). "surface px" = device pixels of a retained surface.
 * "grid px" = the canvas bitmap grid (canvas.width/height).
 */
export {};

// ---------------------------------------------------------------------------------------------- primitives
/** @typedef {{x:number, y:number, width:number, height:number}} Rect */
/** @typedef {{width:number, height:number}} Size */
/** @typedef {{left:number, top:number, right:number, bottom:number}} Insets */

// ---------------------------------------------------------------------------------------------- options
/**
 * @typedef {Object} NodeBudget
 * @property {number} soft  nodes cloned per commit above which damage-pruned clone + adaptive cadence engage (default 350)
 * @property {number} hard  nodes in ONE drawable above which the drawable is degraded to <= 4 fps (its inner scrolling excepted) and reported (default 3000)
 * @property {number} absolute nodes in ONE drawable above which capture is refused with HicUnsupportedError('node-budget') (default 20000)
 */

/**
 * @typedef {Object} HicOptions  install() argument. Every field optional.
 * @property {'auto'|'polyfill'|'native-only'} [mode]  'auto' (default): native-first, a usable native implementation is never refused. 'native-only': never run the renderer.
 *   'polyfill': run the polyfill where there is no native implementation; over a usable one it steps aside like 'auto' (one warning).
 * @property {'throw'|'warn'} [onUnsupportedBrowser]   default 'throw' (loud). 'warn' only logs and installs nothing.
 * @property {'placeholder'|'abort'} [onUnsupportedContent]  default 'placeholder' (hatched box + report + console.error once).
 *           'abort' drops the commit, fires no paint and dispatches 'hicunsupported'.
 * @property {boolean} [legacyNames]     accept layoutsubtree / layoutSubtree / copyElementImageToTexture aliases (default true)
 * @property {number}  [defaultFrameCap] fps cap for canvases without a framecap attribute; 0 = uncapped (default 0)
 * @property {number}  [maxDpr]          upper bound for surface raster scale (default 2.5)
 * @property {number}  [maxSnapshotFps]  upper bound for snapshot build starts per canvas, independent of framecap; 0 = none (default 60). Not applied to the in-frame re-raster of a resize / DPR change (the framecap is)
 * @property {number}  [maxSurfacePixels] pixel budget of ONE drawable surface; above it the raster scale is reduced and the drawable reported (default 33554432)
 * @property {number}  [interactionFloorFps] fps floor for input-driven damage even under a lower framecap; 0 = strict cap (default 0)
 * @property {number}  [inkMargin]       css px of ink overflow kept around each border box (default 24)
 * @property {boolean} [coherentPaint]   hold a paint until the builds of one canvas that started from the same damage epoch have landed, so all drawables show one DOM state (default true)
 * @property {number}  [coherenceMaxWaitMs] upper bound of that hold (default 50)
 * @property {number}  [paintGateMaxWaitMs] upper bound of the first-paint gate: paint fires only when every eligible drawable with a CSS box has a committed version (or a placeholder); after this wait it fires anyway and a report entry is made (default 400)
 * @property {boolean} [parentFacade]    own-property facade on the PARENT of a managed canvas that hides the layer from children/childNodes/childElementCount/firstElementChild/lastElementChild/lastChild/nextElementSibling of the canvas (default true)
 * @property {'report'|'off'} [stackingAudit] detect page content that natively paints above the canvas but is covered by the layer's drawn drawables (default 'report')
 * @property {number}  [maxTotalSurfaceBytes] total bytes of all retained surfaces of an install; above it new surfaces are rasterised at a reduced scale and reported (default 536870912)
 * @property {Partial<NodeBudget>} [nodeBudget]
 * @property {'off'|'queries'|'css'|'both'} [selectorBridge] canvas-ancestor selector emulation (default 'both')
 * @property {boolean} [forcePolyfill]   test only: run the polyfill over any native implementation (usable or broken) instead of stepping aside or refusing
 * @property {boolean} [autoDiscover]    observe the document for canvases (default true)
 * @property {Window}  [window]          default globalThis.window
 * @property {Document} [document]       default window.document
 */

/**
 * @typedef {Object} ResolvedOptions  HicOptions with every default applied (frozen).
 * @property {'auto'|'polyfill'|'native-only'} mode
 * @property {'throw'|'warn'} onUnsupportedBrowser
 * @property {'placeholder'|'abort'} onUnsupportedContent
 * @property {boolean} legacyNames
 * @property {number} defaultFrameCap
 * @property {number} maxDpr
 * @property {number} maxSnapshotFps
 * @property {number} maxSurfacePixels
 * @property {number} interactionFloorFps
 * @property {number} inkMargin
 * @property {boolean} coherentPaint
 * @property {number} coherenceMaxWaitMs
 * @property {number} paintGateMaxWaitMs
 * @property {boolean} parentFacade
 * @property {'report'|'off'} stackingAudit
 * @property {number} maxTotalSurfaceBytes
 * @property {NodeBudget} nodeBudget
 * @property {'off'|'queries'|'css'|'both'} selectorBridge
 * @property {boolean} forcePolyfill
 * @property {boolean} autoDiscover
 */

// ---------------------------------------------------------------------------------------------- install / detection
/**
 * @typedef {Object} NativeState  Result of the behavioural native probe (api/native-detect.js). Pure, no side effects.
 * @property {'complete'|'partial'|'legacy'|'broken'|'absent'} kind
 *   The CORE is: `content` reflecting only fallback|drawable (or the legacy `layoutSubtree`), the `onpaint` handler, 2D `drawElementImage`.
 *   complete = the core plus every other name of the CURRENT spec (getElementImageDefaultSize, ElementImage with close(), the geometry methods, ...)
 *   partial  = the core works, some other name of the current spec is missing (recorded in `missing`; never a reason to refuse)
 *   legacy   = the core with the pre-2026-09 `layoutSubtree` instead of `content`
 *   broken   = something native exists but a core name is missing: the only kind that is refused
 *   absent   = none
 * @property {string[]} present   names found
 * @property {string[]} missing   names of the current spec not found (`content` for a legacy build)
 * @property {string[]} legacyNames  names of earlier drafts found (layoutSubtree, ElementImage.width, texElementImage2D, copyElementImageToTexture)
 * @property {string[]} gaps  missing names the optional native bridge can build from the native build (onelementgeometryupdate, ElementGeometryUpdateEvent, and the texture names when their legacy twin exists)
 * @property {boolean} fillable  kind 'partial' with at least one gap: with the bridge loaded, install gap-fills in mode native-bridged; without it, mode native
 * @property {boolean} verified  the core is usable AND 2D drawElementImage behaved like a platform method on a detached drawable (`probe` 'ok')
 * @property {'ok'|'inert'|'unexpected'|'skipped'} probe  the behavioural drawElementImage probe: 'inert' = returned without throwing, 'unexpected' = threw something else, 'skipped' = no core to probe. Only recorded: a usable core is never refused on it
 * @property {number|null} browserMajor  Chromium major or null when not Chromium
 */

/** @typedef {'native'|'native-bridged'|'polyfill'|'refused'} HicMode */

/**
 * @typedef {Object} UnsupportedEntry  One loud refusal. Also the detail of the 'hicunsupported' CustomEvent.
 * @property {string} feature   id from contracts/features.js (e.g. 'iframe', 'shadow-dom', 'cross-origin-resource')
 * @property {string} message   human readable, includes the offending URL/selector when there is one
 * @property {string} [hint]    what the author can do
 * @property {string} [path]    css-like path of the offending node inside the canvas ("form#f > iframe")
 * @property {number} t         performance.now()
 * @property {number} count     how many times it was hit (the console message is printed once)
 */

/**
 * @typedef {Object} HicReport  installed.report(): plain JSON-able object, safe to attach to bug reports.
 * @property {string} version
 * @property {HicMode} mode
 * @property {NativeState} native
 * @property {{userAgent:string, major:number|null, dpr:number}} browser
 * @property {Array<{id:number, state:string, drawables:number, frameCap:number, unsupported:UnsupportedEntry[], stats:object}>} canvases
 * @property {UnsupportedEntry[]} unsupported
 * @property {Array<{id:string, detail:string, count:number}>} deviations  documented deviations that were actually exercised
 * @property {Array<{name:string, message:string, t:number}>} errors  internal errors that were caught (never swallowed silently)
 */

/**
 * @typedef {Object} HicInstalled  What install() returns. install() is SYNCHRONOUS: every prototype patch is in place when it returns
 *   (an app script that runs next already sees the API). Asynchronous work (probing WebGPU, first snapshots) happens behind it.
 * @property {string} version
 * @property {HicMode} mode
 * @property {NativeState} native
 * @property {Readonly<ResolvedOptions>} options
 * @property {() => HicReport} report
 * @property {() => HTMLCanvasElement[]} canvases   managed canvases in tree order
 * @property {(canvas: HTMLCanvasElement, timeoutMs?: number) => Promise<void>} whenPainted  resolves after the first paint event of canvas; rejects with a TimeoutError DOMException after timeoutMs (default 5000)
 * @property {(canvas: HTMLCanvasElement) => void} adopt  manage a canvas now (needed only with autoDiscover:false); no-op when content is not drawable/legacy
 * @property {(root: ShadowRoot) => void} adoptRoot  explicit hook for a shadow root the install could not observe (closed root created before install, or autoDiscover:false); idempotent
 * @property {() => void} uninstall  idempotent; restores DOM, prototypes, listeners
 */

// ---------------------------------------------------------------------------------------------- environment shared by every module
/**
 * @typedef {Object} Bus  tiny typed pub/sub for INTERNAL topics (contracts/events.js BUS.*). Synchronous, ordered, exceptions isolated.
 * @property {(topic: string, listener: (payload: any) => void) => () => void} on  returns unsubscribe
 * @property {(topic: string, payload?: any) => void} emit
 * @property {() => void} clear
 */

/**
 * @typedef {Object} Reporter  Loud-failure sink (api/report.js implements it, everybody else only calls it).
 * @property {(entry: Omit<UnsupportedEntry,'t'|'count'>, canvas?: HTMLCanvasElement) => void} unsupported
 *           console.error ONCE per (feature,path), CustomEvent 'hicunsupported' on canvas, report entry.
 * @property {(id: string, detail?: string) => void} deviation  record that a documented deviation was exercised
 * @property {(err: unknown, where: string) => void} caught     internal error that was handled; recorded in report().errors, console.error once
 * @property {() => UnsupportedEntry[]} entries
 */

/**
 * @typedef {Object} CanvasRegistryView  Read-only view of managed canvases, given to every module.
 * @property {(canvas: HTMLCanvasElement) => CanvasRecord|undefined} get
 * @property {() => CanvasRecord[]} all  tree order
 * @property {(el: Element) => CanvasRecord|undefined} ownerOfDrawable  record whose LOGICAL subtree contains el (nearest managed canvas)
 * @property {(node: Node) => HTMLCanvasElement|null} logicalCanvasAncestor  nearest canvas in the LOGICAL tree (looks through live layers)
 */

/**
 * @typedef {CanvasRegistryView & {
 *   ensure: (canvas: HTMLCanvasElement) => CanvasRecord|undefined,
 *   observe: (root: Document|ShadowRoot) => void,
 *   create: (canvas: HTMLCanvasElement) => CanvasRecord,
 *   setState: (record: CanvasRecord, state: CanvasRecord['state']) => void,
 *   remove: (record: CanvasRecord) => void,
 *   scan: (root?: ParentNode) => void,
 *   dispose: () => void }} CanvasRegistry  Owner: api-core (canvas-registry.js). setState is the ONLY writer of record.state and emits BUS.CANVAS_STATE.
 */

/**
 * @typedef {Object} PatchLedger  Every prototype/instance patch is recorded with its original descriptor so uninstall restores it exactly (api/patch.js implements it).
 * @property {(target: object, key: PropertyKey, descriptor: PropertyDescriptor) => void} define  define/replace a property; stamps MARK.PATCH_SYMBOL on functions
 * @property {(target: object, key: string, wrap: (original: Function) => Function) => void} wrap  replace a method by wrap(original)
 * @property {() => Array<{target: object, key: PropertyKey, patched: boolean}>} list
 * @property {() => string[]} restoreAll  restore in reverse order; returns keys left alone because a foreign script re-patched them
 */

/**
 * @typedef {Object} GeometryRules  One CSSStyleRule per drawn element in the polyfill-owned adopted sheet of a root (ADR-F): geometry never touches the author's `style` attribute. Updating an existing rule is rule.style.setProperty, not a re-parse.
 * @property {(key: string, declarations: Record<string, string>) => void} set  create or update the rule `[data-hic-hit="key"]{...}`; every declaration is written with !important
 * @property {(key: string) => void} remove
 * @property {(sheet: CSSStyleSheet) => boolean} owns  true for the polyfill's own sheets (the stylesheet observer ignores them)
 */

/**
 * @typedef {Object} LayerStyleHandle  Reference-counted layer + geometry stylesheet of one tree scope (live/layer-style.js).
 * @property {(id: number) => void} add  per-canvas anchor rule
 * @property {(id: number) => void} remove
 * @property {GeometryRules} geometry
 * @property {GeometryRules} scroll  rules keyed by MARK.SCROLL_ATTR (live/scroll-sync.js)
 * @property {() => void} dispose
 */

/**
 * @typedef {Object} RootScope  Tree scopes that can contain a managed canvas (ADR-K). Owner: live (root-scope.js). Anchor names and adopted sheets are tree-scoped, so every root that holds a canvas needs its own layer sheet.
 * @property {() => Array<Document|ShadowRoot>} roots  document first, then every observed shadow root that is connected
 * @property {(root: ShadowRoot) => void} adopt  observe a root explicitly (adoptRoot); idempotent
 * @property {(cb: (root: ShadowRoot) => void) => () => void} onRoot  a shadow root appeared (attachShadow patch or initial walk); the registry then scans it and observes it for canvases
 * @property {(root: Document|ShadowRoot) => LayerStyleHandle} style  reference-counted layer + geometry stylesheet of one root
 * @property {() => void} dispose
 */

/**
 * @typedef {Object} Services  What api/install.js wires together once per install (the composition root; nobody else constructs these).
 * @property {(env: HicEnv, record: CanvasRecord) => LiveLayer} createLiveLayer      live/
 * @property {(env: HicEnv, capture: CaptureFn, extras?: StoreExtras) => SnapshotStore} createSnapshotStore  snapshot-store (extras: resource cache, interaction tracker, test hooks)
 * @property {(env: HicEnv) => Capture} createCapture                                 snapshot-capture
 * @property {(env: HicEnv, store: SnapshotStore, hooks: SchedulerHooks) => Scheduler} createScheduler   schedule/
 * @property {(env: HicEnv, capture?: Capture) => TrackerControl} createInteractionTracker   schedule/ (one per install; shared by the observers, the store and the effects; capture tells which pseudo-classes the CSS uses)
 * @property {(env: HicEnv, tracker: InteractionTracker, ledger?: PatchLedger) => () => void} startObservers  schedule/ (damage sources; returns the disposer; the ledger lets the stylesheet observer wrap CSSOM mutators)
 * @property {(env: HicEnv, deps: EffectsDeps) => EffectsSeam} createEffects   api/ (the hand-over point to the optional effects bundle)
 * @property {(env: HicEnv, ledger: PatchLedger) => () => void} installSelectorBridge  live/ (canvas-ancestor selector emulation: query wrappers + mirrored stylesheet; returns the remover)
 * @property {(env: HicEnv, ledger: PatchLedger) => RootScope} createRootScope   live/ (tree scopes: document + shadow roots, ADR-K)
 */

/**
 * @typedef {Object} HicEnv  Dependency-injection root. Created by api/install.js, passed to every factory. Never a global.
 * @property {Window} window
 * @property {Document} document
 * @property {Readonly<ResolvedOptions>} options
 * @property {Bus} bus
 * @property {Reporter} reporter
 * @property {() => number} now  performance.now()
 * @property {CanvasRegistryView} registry
 * @property {(el: Element) => boolean} isManagedLayerNode  true for polyfill-created nodes (layer, placeholders, caret overlay): observers must ignore them
 * @property {SnapshotStore} store      assigned by api/compose.js right after construction; NEVER read inside a factory, only at call time
 * @property {Scheduler} scheduler      same rule as `store`
 * @property {RootScope} roots          assigned by api/compose.js; the tree scopes (document + observed shadow roots) in which layers and geometry rules live
 * @property {(canvas: HTMLCanvasElement) => void} adopt  hand a canvas to the registry (used by autoDiscover:false and by tests)
 */

// ---------------------------------------------------------------------------------------------- per-canvas record
/**
 * @typedef {Object} ElementGeometry  Canvas transform + hit-test clip of one drawable (spec: "canvas transform", "canvas clip").
 * @property {DOMMatrix|null} transform  maps the border box (before CSS transforms) to the canvas, in CSS px of the canvas content box
 * @property {DOMRect|null} clip         hit-test clip in the coordinate space of `transform`
 */

/**
 * @typedef {Object} GeometryState
 * @property {WeakMap<Element, ElementGeometry>} byElement
 * @property {Element[]} order  spec "list of drawn elements", bottom to top (last = top-most hit target)
 */

/**
 * @typedef {Object} PaintState
 * @property {boolean} force     spec "force paint event"; set by requestPaint(), cleared right before dispatch
 * @property {number} serial     increments every dispatched paint event
 * @property {number} lastFireAt performance.now() of the last dispatch
 * @property {boolean} everFired true after the first paint event (whenPainted)
 * @property {number} microtaskFrame frame serial of the last paint fired from a canvas width/height setter microtask (the frame-end phase then skips a force-only paint of the same frame)
 * @property {number|null} waitingSince performance.now() since which the paint gate (first commit / coherence) holds the paint, null when open
 * @property {'first-commit'|'coherence'|null} gateReason why the gate is closed
 * @property {number|null} holdSince performance.now() since which this canvas's paint is held back because the DOM changes made before a requestPaint() are not snapshotted yet, or because a canvas nested in its drawables has not painted yet; null otherwise
 */

/**
 * @typedef {Object} ContentBox  Canvas CONTENT box (excludes border and padding), css px, sampled at one instant.
 * @property {number} width
 * @property {number} height
 * @property {number} gridScaleX  canvas.width  / width   (spec: scaleX)
 * @property {number} gridScaleY  canvas.height / height  (spec: scaleY)
 */

/**
 * @typedef {Object} CanvasRecord  Everything the polyfill knows about one managed canvas. Created by api/canvas-registry.js.
 *   Only the owner module of a field may assign it (see docs/ARCHITECTURE.md section 3). Others read.
 * @property {number} id
 * @property {HTMLCanvasElement} canvas
 * @property {'detached'|'mounting'|'active'|'suspended'|'disposed'} state
 *           detached = content!=drawable (children untouched); mounting = relocation in progress;
 *           active = live layer mounted and snapshotting; suspended = canvas not connected / display:none / page hidden; disposed = uninstalled
 * @property {boolean} legacy  activated by layoutsubtree (direct children implicitly drawable)
 * @property {Document|ShadowRoot} root  tree scope of the canvas (document or an open/observed shadow root); owner: registry, updated when the canvas is moved to another scope
 * @property {LiveLayer|null} layer           owner: live
 * @property {SnapshotStore|null} store       owner: snapshot-store
 * @property {GeometryState} geometry         owner: api
 * @property {PaintState} paint               owner: schedule
 * @property {number} frameCap                owner: schedule (effective fps, 0 = uncapped)
 * @property {ContentBox} contentBox          owner: live (updated by layer.syncPresentation)
 * @property {number} dpr                     owner: schedule (observers)
 * @property {Set<OffscreenCanvas>} offscreen owner: api (transferControlToOffscreen links)
 */

// ---------------------------------------------------------------------------------------------- live layer (module: live)
/**
 * @typedef {Object} ChildrenChange
 * @property {Node[]} added
 * @property {Node[]} removed
 */

/**
 * @typedef {Object} StackingFinding  A page element that natively paints above the (non-positioned) canvas but is covered by the layer's drawn drawable at a sampled point.
 * @property {Element} drawable
 * @property {Element} covered
 * @property {{x:number,y:number}} point  viewport css px
 */

/**
 * @typedef {Object} LiveLayer  The live DOM of one canvas. See ARCHITECTURE ADR-A.
 * @property {HTMLElement} element  the layer <hic-layer data-hic-layer="<record id>"> (unknown tag so author tag/nth-of-type selectors never match; anchor-positioned sibling of the canvas, ADR-A)
 * @property {() => void} mount     relocate logical children into slots, insert the layer after the canvas, install tree facade. Idempotent.
 * @property {() => void} unmount   exact inverse: children back into the canvas in original order, layer removed, facade removed. Idempotent.
 * @property {() => boolean} isMounted
 * @property {() => ContentBox} syncPresentation  re-read canvas border/padding/inherited props, write them to the layer, return the content box
 * @property {() => Node[]} logicalChildNodes     the canvas children as the author sees them (all node types)
 * @property {() => Element[]} drawableElements   eligible drawables in TREE order (includes ones that are not laid out)
 * @property {(node: Node) => Element|null} nearestDrawable  nearest inclusive ancestor drawable of node that belongs to this canvas, else null
 * @property {(el: Element) => boolean} isLaidOut  el has a CSS box (not display:none, not under display:none, canvas content=drawable)
 * @property {(el: Element) => Size|null} borderBoxSize  border box in css px BEFORE any CSS/canvas transform (offsetWidth-like but fractional); null when not laid out
 * @property {(el: Element) => Rect|null} borderBoxRectInLayer  border box position inside the layer (css px, before transforms)
 * @property {(el: Element) => Insets|null} [inkOverflow]  measured ink overflow of a drawable beyond its border box (own CSS transform, box-shadow, outline, overflowing descendants to the right/bottom), css px >= 0; null when not laid out
 * @property {(el: Element) => Insets|null} [paintInk]  ink an element paints beyond its border box (outer box-shadow, outline, text-shadow), css px >= 0; null when not laid out. Damage rects grow by it
 * @property {(el: Element) => Rect|null} frameRect  rect of el in the border-box FRAME of its nearest drawable (origin = that border box top-left, css px) with the drawable's applied geometry transform removed; null when not laid out. Damage sources and the clone use it, never raw getBoundingClientRect
 * @property {(drawable: Element) => (el: Element, sized?: boolean) => Rect|null} frameMeasurer  frameRect for many elements of `drawable` while the layout does not change (one synchronous capture): the drawable-level reads are made once. `sized`: the caller ignores rects without area, so the laid-out test may be skipped
 * @property {(el: Element, geometry: ElementGeometry|null, layoutOffset?: {x:number,y:number}|null) => void} applyGeometry  make the live element land where its pixels are drawn (ADR-F); null removes the correction and the hit attribute. NEVER measures layout: `layoutOffset` comes from the newest SnapshotVersion (null/undefined = the layer's cached offset, revalidated lazily). A no-op when matrix, clip and rank are unchanged; DOM/rule writes are batched to one flush per task.
 * @property {() => StackingFinding[]} stackingAudit  elementsFromPoint sampling of the drawn drawables: page elements that sit between a drawn drawable and the canvas in hit order (ADR-L); no style mutation
 * @property {() => void} revalidateGeometry  re-measure layout offsets of every geometry-applied drawable and rewrite its CSS correction (called after structural commits)
 * @property {(order: Element[]) => void} setHitTestOrder  z-order for hit testing (bottom to top); elements not in `order` lose BUS HIT_ATTR (pointer-events:none)
 * @property {(cb: (c: ChildrenChange) => void) => () => void} onChildrenChanged  logical child list changes (facade writes + relocated MutationObserver)
 * @property {(point: {x:number,y:number}) => Element|null} elementAtPoint  hit test in viewport css px honoring slots (interposer + tests)
 * @property {(el: Element, on: boolean) => void} [syncScroll]  a live scroller inside a drawable starts (true) or stops (false) scrolling: while on, the compositor waits for the main frame of each scroll step (live/scroll-sync.js; Chromium only, a no-op elsewhere)
 * @property {(el: Element) => {boxShadow: string, backgroundImage: string, backgroundAttachment: string}|null} [scrollAuthorStyle]  the author's computed values of the properties syncScroll overrides, while it overrides them; null otherwise
 * @property {() => void} dispose
 */

// ---------------------------------------------------------------------------------------------- damage & snapshots (modules: snapshot-*, schedule)
/** @typedef {'mutation'|'input'|'focus'|'hover'|'active'|'scroll'|'resize'|'dpr'|'animation'|'caret'|'selection'|'resource'|'stylesheet'|'content-attr'|'forced'|'geometry'} DamageCause */

/**
 * @typedef {Object} Damage
 * @property {CanvasRecord} record
 * @property {Element|null} drawable  nearest drawable that owns the change; null = every drawable of the canvas
 * @property {Rect|null} rect  css px in the drawable's border-box frame (origin = border box top-left); null = whole drawable
 * @property {DamageCause} cause
 * @property {number} t
 */

/**
 * @typedef {Object} SnapshotVersion  IMMUTABLE once published to readers. One per (drawable, commit). Spec: "element image snapshot".
 * @property {number} id            globally increasing
 * @property {WeakRef<Element>} element
 * @property {number} canvasId
 * @property {number} width         border box width, css px (fractional allowed)   [spec: snapshot width]
 * @property {number} height        border box height, css px
 * @property {number} canvasWidth   canvas content box width at snapshot time, css px   [spec: canvas width]
 * @property {number} canvasHeight  canvas content box height at snapshot time, css px
 * @property {DOMMatrixReadOnly} translation  translation matrix of the computed transform-origin   [spec: translation matrix]
 * @property {number} scale         surface px per css px (raster scale, <= options.maxDpr)
 * @property {Insets} ink           css px kept beyond the border box on each side (the surface covers border box + ink)
 * @property {{x:number,y:number}|null} layoutOffset  border-box offset of the element inside the layer content box (css px, before transforms) measured by the capture that produced the surface; geometry application reads it instead of measuring layout. null = unknown
 * @property {HTMLCanvasElement|OffscreenCanvas} surface  pixels. Never mutated while pinned (the caret patch counts as a write: it forks a pinned surface).
 * @property {boolean} pinned       an ElementImage references it (or a draw is in flight): the store must fork before writing
 * @property {number} refs          outstanding ElementImage objects
 * @property {number} committedAt   performance.now()
 * @property {Rect|null} dirty      border-box-frame css rect whose pixels differ from the previous version of the same surface; null = unknown / everything (partial GPU uploads read it)
 */

/**
 * @typedef {Object} SourceRectCss  Source rectangle in the BORDER-BOX frame of the element (css px, negative origin = ink overflow).
 * @property {number} sx
 * @property {number} sy
 * @property {number} sw
 * @property {number} sh
 */

/**
 * @typedef {Object} RasterSource  What a consumer must pass to drawImage / copyExternalImageToTexture for one source rect.
 * @property {HTMLCanvasElement|OffscreenCanvas} source
 * @property {number} sx  surface px
 * @property {number} sy
 * @property {number} sw
 * @property {number} sh
 */

/**
 * @typedef {Object} ChangeSet  Result of a commit round; the scheduler turns it into one paint event.
 * @property {Element[]} changed  drawables whose snapshot version advanced, TREE order
 * @property {Element[]} removed  drawables whose snapshot was dropped (removed / display:none / no longer eligible)
 */

/**
 * @typedef {Object} PaintReadiness
 * @property {boolean} ready
 * @property {'ready'|'no-drawables'|'first-commit'|'coherence'} reason
 */

/**
 * @typedef {Object} SnapshotStats
 * @property {number} commits
 * @property {number} tiles
 * @property {number} fullTiles
 * @property {number} cloneMsP50
 * @property {number} cloneMsP95
 * @property {number} decodeMsP50
 * @property {number} decodeMsP95
 * @property {number} decodeMainMsP95  main-thread RunTask attributable to one tile decode, EMA (decode is NOT off-thread cost: ADR-D.8)
 * @property {number} nodesLast
 * @property {number} degraded  drawables currently on the degrade ladder
 * @property {number} surfaces
 * @property {number} surfaceBytes
 * @property {number} rasterScale  the largest raster scale of a committed snapshot (surface px per css px, <= options.maxDpr; 0 before the first commit)
 * @property {number} pinnedSurfaces
 * @property {number} dropped  results discarded as stale
 * @property {number} redamaged  dropped results whose uncovered rect was re-marked as damage (ADR-B)
 * @property {number} surfaceRestores  retained surfaces re-rastered after a 2D context loss (ADR-B)
 * @property {{plans: number, refusals: number, pages: number, pins: number, failed: number, composed: number, fallbacks: number, dropped: number, droppedGeometry: number, kept: number, dirtied: number, patched: number, dirtyMisses: number, obstructed: number}} [scroll]  scroll compositor counters (scroll-compose.js): `kept` damage elsewhere in the drawable that left the pages valid, `dirtied` damage inside a scroller's content, `patched` page parts repaired from a tile
 */

/**
 * @typedef {Object} SnapshotStore  Owner: snapshot-store. Read side is used by api/ and effects/, write side by schedule/.
 * @property {(el: Element) => SnapshotVersion|null} version  latest committed version, or null before the first commit / after drop
 * @property {(el: Element) => SnapshotVersion} pin   spec "get element image snapshot" + pin; throws InvalidStateError when none
 * @property {(v: SnapshotVersion) => void} unpin
 * @property {(v: SnapshotVersion, r: SourceRectCss) => RasterSource|null} rasterSource  null when the rect has no overlap with the surface
 * @property {(el: Element, rect: Rect|null, cause: DamageCause) => void} markDamage  (rect in border-box frame; null = whole)
 * @property {(cause: DamageCause) => void} invalidateAll
 * @property {(now: number, budget: PumpBudget) => PumpResult} pump  start builds/decodes that are due; synchronous part bounded by budget.mainThreadMs
 * @property {() => boolean} [needsPump]  a pump would have something to do: damage waiting for a build, a side build queued, a geometry check owed after a commit (absent: always true)
 * @property {(record?: CanvasRecord) => boolean} hasLanded  at least one decoded result (of `record` when given) is waiting to be committed
 * @property {(record?: CanvasRecord, opts?: {current?: boolean}) => ChangeSet} commitLanded  apply landed results to surfaces in ONE synchronous step, publish new versions. With `record` only that canvas is committed (the others keep their landed results queued: a closed paint gate stays closed). `current`: the paint that follows must show the DOM as it is now, so a whole tile superseded by a DOM mutation is reclaimed instead of committed
 * @property {(record: CanvasRecord) => void} forget  drop every drawable of the record and release its surfaces (content!=drawable, unmount, uninstall)
 * @property {(el: Element) => boolean} has  the store tracks el (eligible drawable with a CSS box)
 * @property {(el: Element) => boolean} isSettled  no damage pending, nothing building/decoding for el
 * @property {(record: CanvasRecord) => boolean} isFresh  no eligible, laid-out drawable of the canvas has damage waiting for a build or a build in flight (refused, lost and repeatedly failing ones do not count)
 * @property {(drawable: Element, scroller: Element) => void} scrollSettled  `scroller` was seen (the pointer is over it, it scrolled, or its scrolling paused): a scroller the compositor does not know yet is planned and its first pages are built in the next post-frame pump
 * @property {(drawable: Element, scroller: Element) => boolean} scrollCompose  a scroll event of `scroller`: true when the next commit shows its live offset by composing cached pages (the caller then asks for the exact tile only once the scrolling stops); false = damage it as usual
 * @property {(drawable: Element, control: Element|null) => void} caretNow  the focus moved: the next commit shows the caret of `control` measured from the live field (null: the drawable loses its caret), before the tile with the focus styles lands
 * @property {(drawable: Element, control: Element) => boolean} overlayText  optimistic text overlay: the next commit paints the live value of the focused field `control` into `drawable`'s surface (no-op without StoreExtras.textOverlay). true: the field's last overlay worked, so its snapshot may wait for the typing to pause (if this one fails, the store damages the field itself)
 * @property {(record: CanvasRecord) => PaintReadiness} isPaintReady  paint gate input (ADR-C): is every eligible drawable with a CSS box committed (or a placeholder), and are builds of the same damage epoch still in flight
 * @property {() => SnapshotStats} stats
 * @property {() => void} dispose
 */

/**
 * @typedef {Object} PumpBudget
 * @property {number} mainThreadMs  stop starting new builds once this much synchronous time was spent in this pump (default 4)
 * @property {number} mainThreadShare  fraction of the frame period that the EMA of (sync build + decode wall + commit draw) of all drawables may use; builds are not started above it (default 0.35)
 * @property {number} maxInFlight   per canvas (default 2)
 * @property {boolean} interaction  an input-driven damage is pending: the scheduler may apply options.interactionFloorFps (0 = ignore, strict cap)
 * @property {boolean} [urgent]  decodes start at once, never in a later task: pumped inside an input task (focus / active) or inside a resize frame (both would lose a frame to a later task)
 */
/**
 * @typedef {Object} PumpResult
 * @property {number} started   builds started
 * @property {number} spentMs
 * @property {boolean} moreWork  damage remains that the budget/cap did not allow
 * @property {number|null} nextDueAt  performance.now() when the cap allows the next build (null = now / nothing pending)
 */

// ---------------------------------------------------------------------------------------------- capture (module: snapshot-capture)
/**
 * @typedef {Object} ResourceCache  url -> data: URL cache with byte budget (snapshot/inline-resources.js)
 * @property {(absUrl: string) => string|null} peek  data: URL or null if not cached (sync, hot path)
 * @property {(absUrl: string, kind: 'image'|'font'|'css'|'svg') => Promise<string>} load  fetch + encode; rejects with HicUnsupportedError
 * @property {(cb: (absUrl: string) => void) => () => void} onReady  fires when a previously missing resource settled: it became available or its load FAILED (-> 'resource' damage; the next capture then uses it or reports the failure)
 * @property {(what: string) => void} [settle]  announce that something a capture left out outside this cache became ready (a pre-decoded control skin): fires onReady listeners
 * @property {() => {entries:number, bytes:number}} stats
 * @property {() => void} clear
 */

/**
 * @typedef {Object} CaptureRequest
 * @property {CanvasRecord} record
 * @property {Element} element        the drawable to rasterise
 * @property {Rect|null} rect         damage crop in border-box frame (css px); null = whole drawable + ink
 * @property {number} scale           surface px per css px
 * @property {Insets} ink
 * @property {number} generation      monotonically increasing per drawable; echoed back so stale results can be dropped
 * @property {ResourceCache} resources
 * @property {boolean} prune          budget.soft exceeded: only clone what intersects `rect` (+ ancestor skeleton + spacers)
 * @property {InteractionSnapshot} interaction  hover/active chains, focus, caret phase at request time (the clone mirrors them as classes)
 * @property {Element} [hideText]     this field is cloned with transparent text: the backdrop tile of the optimistic text overlay
 * @property {{el: Element, top: number, hide: Element[], bars?: 'track'|'thumb', shape?: 'square'|'backdrop'}} [scroll]  a PAGE of the scroll compositor: the scroller `el` is rendered at scrollTop `top` instead of its live offset, the `hide` elements (pinned sticky descendants) invisible; `bars`: only the classic bar's track (thumb hidden) or only its thumb (everything else invisible); `shape` (a rounded scroller): 'square' renders `el` with square corners (the compositor clips to the rounded port), 'backdrop' renders it without its content (what lies under that clip)
 */

/**
 * @typedef {Object} InteractionSnapshot  Immutable view of pointer/focus state that the live DOM has and the clone cannot have.
 * @property {ReadonlySet<Element>} hover      hovered element and its ancestors inside the layer (empty when no pointer is over the layer)
 * @property {ReadonlySet<Element>} active     :active chain (pointer or keyboard activation in progress)
 * @property {Element|null} focus              document.activeElement when inside the layer, else null
 * @property {boolean} focusVisible            focus ring should be painted (keyboard modality or text input)
 * @property {boolean} caretVisible            blink phase (tiles are caret-free; the store applies it when it paints the caret patch)
 */

/**
 * @typedef {Object} InteractionTracker  Owner: schedule (observers/interaction-tracker.js). One per install.
 * @property {() => InteractionSnapshot} snapshot
 * @property {(record: CanvasRecord, target: Element|null) => void} setMappedTarget  effects: hover/active follow the element under the MAPPED pointer instead of the native hit (null = native again)
 * @property {(cb: (change: {record: CanvasRecord, kind: 'hover'|'active'|'focus'|'caret', elements: Element[]}) => void) => () => void} onChange
 */

/**
 * @typedef {Object} CssBundle  Flattened stylesheet text for one capture (snapshot/css-collector.js). Cached by `key`.
 * @property {string} css
 * @property {string} key       changes whenever css would change (viewport, dpr, stylesheet set/version, color-scheme)
 * @property {{hover:boolean, active:boolean, focus:boolean, focusVisible:boolean, focusWithin:boolean, hoverLayout?:boolean}} pseudo  which interaction pseudo-classes appear in any rule (skip damage for the others); `hoverLayout`: a :hover rule sets a property that is not paint-only (absent = assume it does)
 * @property {string[]} pendingUrls  url()s still being fetched (result.complete will be false)
 */

/**
 * @typedef {Object} StoreExtras  optional wiring of createSnapshotStore by the composition root
 * @property {ResourceCache} [resources]  the capture module's cache, handed to every CaptureRequest
 * @property {{snapshot: () => InteractionSnapshot}} [interaction]  hover/active/focus chains for the clone and the real blink phase for the caret patch
 * @property {(url: string) => Promise<HTMLImageElement>} [decode]  replaces the data-URL decode (tests)
 * @property {number} [buildsPerDrawable]  builds in flight per drawable (tests)
 * @property {(fn: () => void) => void} [nextTask]  runs a deferred decode start in a later task (tests; default: a MessageChannel task, none when `decode` is given)
 * @property {(control: Element, drawable: Element, frame: Rect, epoch: number) => TextOverlayPlan|null} [textOverlay]  plans the optimistic text overlay (Capture.textOverlay); absent = no overlay
 * @property {(control: Element, frame: Rect) => {rect: Rect, color: string}|null} [caretOf]  measures the caret of a focused text control (Capture.caretOf); absent = the caret comes with the next tile
 * @property {(scroller: Element, drawable: Element, layer: LiveLayer) => ScrollPlan|null|Iterator<void, ScrollPlan|null, void>} [scrollPlan]  plans the scroll compositor (Capture.scrollPlan: the steps of the plan, one post-frame task each); absent = every scroll step is built
 */

/**
 * @typedef {Object} TrackerControl  The InteractionTracker plus its lifecycle (schedule/observers/interaction-tracker.js)
 * @property {() => InteractionSnapshot} snapshot
 * @property {(record: CanvasRecord, target: Element|null) => void} setMappedTarget
 * @property {(cb: (change: {record: CanvasRecord, kind: 'hover'|'active'|'focus'|'caret', elements: Element[]}) => void) => () => void} onChange
 * @property {(record: CanvasRecord) => void} attach  called on CANVAS_MOUNTED by startObservers
 * @property {(record: CanvasRecord) => void} detach  called on CANVAS_UNMOUNTING
 * @property {() => void} dispose
 */

/**
 * @typedef {CaptureFn & {resources: ResourceCache, invalidateStyles: () => void, cssBundle: (record: CanvasRecord, resources: ResourceCache) => CssBundle, textOverlay?: (control: Element, drawable: Element, frame: Rect, epoch: number) => TextOverlayPlan|null, scrollPlan?: (scroller: Element, drawable: Element, layer: LiveLayer) => Iterator<void, ScrollPlan|null, void>, caretOf?: (control: Element, frame: Rect) => {rect: Rect, color: string}|null}} Capture
 *   What createCapture returns: the CaptureFn plus its resource cache (hand it to the store), a stylesheet-epoch invalidator and the cached CssBundle (the tracker reads `.pseudo`).
 */

/**
 * @typedef {Object} TextOverlayPlan  Optimistic paint of a focused text field's live value (snapshot/capture/text-overlay.js); css px in the drawable's border-box frame
 * @property {Rect} box  content box of the field: refilled with `fill`, and the clip of the text
 * @property {string|null} fill  backdrop colour of the content box (rgba; alpha 0 = transparent surface); null = not a solid colour: the store paints a backdrop TILE (the field rendered with transparent text, CaptureRequest.hideText)
 * @property {string} text  what the field shows (text-transform applied, password masked)
 * @property {string} color
 * @property {number} x  text origin (alignment and scrollLeft applied)
 * @property {number} baseline
 * @property {string} font  canvas font shorthand
 * @property {string} letterSpacing
 * @property {string} wordSpacing
 * @property {CanvasFontKerning} kerning
 * @property {{rect: Rect, color: string}|null} caret
 */

/**
 * @typedef {Object} ScrollPlan  How a scroller can be composed from pages (snapshot/capture/scroll-pages.js); css px in the drawable's border-box frame
 * @property {Rect} frame  the scroller's border box (= the rect of its own scroll damage)
 * @property {Rect} port  its scrollport (padding box; overlay scrollbars only)
 * @property {Element[]} pinned  sticky descendants drawn from their own tiles (opaque rectangles)
 * @property {{gutter: Rect, thumbX: number, thumbW: number, thumbH: number, thumbY: (top: number) => number}|null} bar  the vertical classic scrollbar the polyfill paints in the gutter (null: overlay bars, no gutter)
 * @property {number} maxTop
 * @property {number} scrollHeight
 * @property {{tl: {x: number, y: number}, tr: {x: number, y: number}, br: {x: number, y: number}, bl: {x: number, y: number}}|null} [round]  inner radii of a rounded padding box (the port and a classic bar gutter; css px); null/absent = square
 * @property {(rects: Rect[]) => boolean} [clear]  hit test: true when nothing outside the scroller covers the port inside these rects (frame css px), now
 */

/** @typedef {(req: CaptureRequest) => CaptureResult} CaptureFn  SYNCHRONOUS part of a capture: clone + css + serialise + encode to a data: URL. Decode is the store's job. Must not throw: failures become result.unsupported + a placeholder. */

/**
 * @typedef {Object} GeometryApi  What effects/ may call on api/ (api-surface/geometry.js implements it).
 * @property {(record: CanvasRecord, el: Element, opts: {canvasTransform?: DOMMatrixInit, clip?: DOMRectInit, preserveHitTestOrder?: boolean}) => void} update  same semantics as canvas.updateElementGeometry
 * @property {(record: CanvasRecord, el: Element) => void} clear
 * @property {(record: CanvasRecord, el: Element) => DOMMatrix} get
 */

/**
 * @typedef {Object} CaptureResult
 * @property {string} url             data:image/svg+xml URL (never blob:)
 * @property {Rect} cropCss           the css-px rectangle (border-box frame, may extend into ink) that `url` depicts
 * @property {number} widthPx         intrinsic raster width in surface px
 * @property {number} heightPx
 * @property {number} nodes           nodes cloned
 * @property {boolean} complete       false when a resource was still loading (a 'resource' damage will follow)
 * @property {UnsupportedEntry[]} unsupported
 * @property {{x:number,y:number}|null} layoutOffset  see SnapshotVersion.layoutOffset
 * @property {{rect: Rect, color: string}|null} caret  measured caret of the focused text control in the border-box frame; NOT part of the tile: the store paints it onto the retained surface (ADR-D.2)
 * @property {{cloneMs:number, cssMs:number, shakeMs:number, svgMs:number, bytes:number}} timings
 */

// ---------------------------------------------------------------------------------------------- scheduling (module: schedule)
/**
 * @typedef {Object} SchedulerHooks  Provided by api/ (the only code allowed to construct and dispatch spec events).
 * @property {(record: CanvasRecord, changed: Element[]) => void} firePaint  dispatch one CanvasPaintEvent at record.canvas (never throws into the scheduler)
 */

/**
 * @typedef {(now: number, info: {frameCap: number, due: boolean}) => boolean|void} FrameHook
 *   Runs inside the scheduler's rAF tick of ONE canvas, AFTER paint dispatch and the store pump. `due` = the frame cap allows a frame now.
 *   Return true to keep the tick running next frame without damage (continuous effects). Must not throw (caught + reported).
 */

/**
 * @typedef {Object} Scheduler
 * @property {(record: CanvasRecord) => void} register     start serving a mounted canvas
 * @property {(record: CanvasRecord) => void} wake          arm one tick for the canvas WITHOUT damage and without a paint event (the effect host's frame hook after addPlugin/setOptions/resize/device recovery)
 * @property {(record: CanvasRecord) => void} unregister
 * @property {(record: CanvasRecord) => void} requestPaint  spec requestPaint(): sets record.paint.force, schedules the next opportunity
 * @property {(record: CanvasRecord) => boolean} paintNow  fire the paint of this canvas immediately (called from a microtask queued by the canvas width/height setters, so a ResizeObserver-driven resize redraws in the SAME frame). At most once per frame, never re-entrant (inside a dispatch it falls back to requestPaint); returns whether it fired
 * @property {(record: CanvasRecord, fps: number) => void} setFrameCap
 * @property {(record: CanvasRecord, hook: FrameHook) => () => void} addFrameHook  returns remove()
 * @property {(record: CanvasRecord, cause: DamageCause, drawable?: Element|null, rect?: Rect|null, urgent?: boolean) => void} damage  sink for observers; `urgent` (and every focus/active damage): a discrete user action whose tile is built at once, in the input task
 * @property {() => {frames:number, paintsFired:number, lateFrames:number, phaseFallbacks:number, gateTimeouts:number}} stats
 * @property {() => void} dispose
 */

// ---------------------------------------------------------------------------------------------- effects (module: gpu-effects)
/**
 * @typedef {Object} InputPoint  canvas-relative css px of the PRESENTED pixel, plus the presented size
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */
/**
 * @typedef {((p: InputPoint) => {x:number, y:number}) & {captureGestureSnapshot?: () => InputMapper}} InputMapper
 *   output -> source map for exactly the pixels of one presentation. Pure. Returns NO_TARGET (effects/no-target.js) where the presented
 *   pixel shows no element of the source. See API-CONTRACT 7.4.
 */
/**
 * @typedef {Object} EffectViewport
 * @property {number} width
 * @property {number} height  backing pixels
 * @property {number} cssWidth
 * @property {number} cssHeight
 * @property {number} dpr
 */
/**
 * @typedef {Object} EffectPresentationFrame
 * @property {number} now
 * @property {number} delta
 * @property {number} frameIndex
 * @property {number} frameCap
 * @property {number|null} sourceVersion  SnapshotVersion.id sampled by sourceTexture, null before the first source upload
 */
/**
 * @typedef {EffectViewport & EffectPresentationFrame & {sourceReady:boolean, encoder:any, sourceTexture:any, sourceView:any, destinationTexture:any, destinationView:any, profiling?:any}} EffectRenderFrame
 *   `profiling` is never set by the host: a measurement harness that renders a plugin directly may pass
 *   `{timestampWrites(label) -> GPURenderPassTimestampWrites}`, which the example plugins add to their own passes
 */
/**
 * @typedef {Object} EffectPluginContext
 * @property {2} apiVersion
 * @property {HTMLCanvasElement} canvas
 * @property {Element} source   the drawable the host samples
 * @property {any} adapter
 * @property {any} device
 * @property {string} format
 * @property {() => void} requestRender
 * @property {() => EffectViewport} viewport
 * @property {(type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions|boolean) => () => void} listen  auto-removed on detach
 * @property {(action: string, options?: Record<string, unknown>) => Promise<EffectActionState>} trigger  runs one of the plugin's own declared
 *   actions through the host, exactly as EffectHandle.trigger (a submit handler of the plugin uses it); a failure is reported as effecterror (phase 'action')
 */
/**
 * @typedef {string|null} EffectActionState  the state a plugin rests in after an action (a name the plugin documents, such as 'in', 'out',
 *   'cracked'); null when the action did not complete (superseded by a newer action, plugin removed, disabled or failed, GPU device lost)
 */
/**
 * @typedef {Object} EffectActionInfo  what the host hands to EffectPluginInstance.runAction with each action
 * @property {boolean} reducedMotion  prefers-reduced-motion: reduce, read when the action was triggered
 */
/**
 * @typedef {Object} EffectPluginUIContext
 * @property {HTMLCanvasElement} canvas
 * @property {() => Readonly<Record<string, unknown>>} getOptions
 * @property {(patch: Record<string, unknown>) => void} setOptions
 * @property {() => void} requestRender
 * @property {(action: string, options?: Record<string, unknown>) => Promise<EffectActionState>} trigger  EffectHandle.trigger, for the plugin's
 *   own buttons; a failure is reported as effecterror (phase 'action')
 */
/**
 * @typedef {Object} EffectPluginInstance
 * @property {boolean} [spatial]     true: output pixels are displaced; the host then REQUIRES captureInputMapper
 * @property {boolean} [continuous]  true: needs a render every capped frame even without source changes
 * @property {(frame: EffectRenderFrame) => void} render
 * @property {(viewport: EffectViewport) => void} [resize]
 * @property {(options: Readonly<Record<string, unknown>>) => void} [setOptions]
 * @property {(frame: EffectPresentationFrame) => InputMapper} [captureInputMapper]
 * @property {(root: Element, ui: EffectPluginUIContext) => void | (() => void)} [mountUI]
 * @property {(action: string, options: Readonly<Record<string, unknown>>, info: EffectActionInfo) => EffectActionState | Promise<EffectActionState>} [runAction]
 *   REQUIRED when the definition declares `actions`: start `action` (a declared name; the host has validated it) and resolve, once the
 *   frame that shows its end state was rendered, with the state the plugin then rests in; null when the plugin superseded or cancelled it
 * @property {() => EffectActionState | Promise<EffectActionState>} [settled]  REQUIRED with `actions`: resolves once nothing of the plugin
 *   moves any more (at once when nothing moves), with the state it rests in
 * @property {() => void} [destroy]
 */
/**
 * @typedef {Object} EffectPluginDefinition  ABI v2 (API-CONTRACT 7.2)
 * @property {string} type
 * @property {2} apiVersion
 * @property {number} version
 * @property {{directCanvasRenderAttachment?: true}} [outputCapabilities]
 * @property {ReadonlyArray<string>} [actions]  the names EffectHandle.trigger accepts (lowercase words, unique, at least one); the instance
 *   then implements runAction and settled
 * @property {(context: EffectPluginContext, options: Readonly<Record<string, unknown>>) => EffectPluginInstance | Promise<EffectPluginInstance>} create
 */
/**
 * @typedef {Object} SourceProvider  Where the effect host reads source pixels. Polyfill mode: the SnapshotStore; native mode: the public API.
 * @property {'store'|'native'} kind
 * @property {() => number|null} version   id of the newest source version (null before the first); changes whenever pixels changed
 * @property {() => {width:number, height:number, cssWidth:number, cssHeight:number}|null} size  source size (grid px of the draw, css px of the drawable)
 * @property {(device: any, texture: any, onlyDirty: boolean) => number} upload  copy the source into `texture` (GPUTexture), return the version id uploaded
 * @property {() => void} dispose
 */

/**
 * @typedef {{store: SnapshotStore, scheduler: Scheduler, geometry: GeometryApi, tracker: InteractionTracker}} EffectsDeps
 * @typedef {Object} EffectsSeam  What the core hands to the optional effects bundle (createEffectsSeam of api/compose.js; hung on HicInstalled under EXT.EFFECTS_SEAM_KEY). The core never loads effects code.
 * @property {HicEnv} env
 * @property {EffectsDeps} deps
 * @property {EffectsApi|null} effects  the effects bundle's per-install API, created on first use
 * @property {Set<() => void>} cleanups  run by uninstall() (the effects bundle registers the destruction of its hosts here)
 * @property {() => void} dispose
 */

/**
 * @typedef {Object} EffectsApi  What window.HTMLInCanvasEffects exposes (effects/index.js).
 * @property {2} version
 * @property {(def: EffectPluginDefinition) => EffectPluginDefinition} definePlugin  validates and freezes a definition
 * @property {Readonly<{x: number, y: number}>} NO_TARGET  what an input mapper returns where no element is shown (effects/no-target.js)
 * @property {(point: unknown) => boolean} isNoTarget
 * @property {(canvas: HTMLCanvasElement, source: Element, options?: EffectHostOptions) => Promise<EffectHost>} createHost
 * @property {() => void} dispose
 */

/**
 * @typedef {Object} EffectHostOptions
 * @property {number} [maxDpr]
 * @property {'low-power'|'high-performance'} [powerPreference]
 * @property {boolean} [interposer]  remap pointer input through spatial plugins (default true)
 */
/**
 * @typedef {Object} EffectHandle
 * @property {string} id
 * @property {string} type
 * @property {Readonly<Record<string, unknown>>} options
 * @property {boolean} enabled
 * @property {(patch: Record<string, unknown>) => void} setOptions
 * @property {(enabled: boolean) => void} setEnabled
 * @property {(root: Element) => () => void} mountUI
 * @property {ReadonlyArray<string>} actions  the actions the plugin declares (empty when it has none)
 * @property {(action: string, options?: Record<string, unknown>) => Promise<EffectActionState>} trigger  runs a declared action (API-CONTRACT 7.3.1)
 * @property {() => Promise<EffectActionState>} settled  resolves once nothing of the plugin moves, with the state it rests in
 * @property {() => void} remove
 */
/**
 * @typedef {Object} EffectHostStats
 * @property {number} frames  presented frames
 * @property {number} fps  presentation rate over the last frames
 * @property {number} uploads
 * @property {number} pluginErrors
 * @property {number} deviceLosses
 * @property {boolean} paused  the canvas cannot be seen (off-screen or hidden document), so the host renders nothing (ADR-G)
 * @property {number} pauses  times the host paused
 * @property {number} offscreenFrames  frames rendered while paused, only to advance an unsettled trigger()/settled()
 * @property {number|null} sourceVersion
 * @property {number} remapped
 * @property {number} passedThrough
 */
/**
 * @typedef {Object} EffectHost
 * @property {number} pluginCount
 * @property {(def: EffectPluginDefinition, options?: Record<string, unknown>) => Promise<EffectHandle>} addPlugin
 * @property {() => EffectHostStats} stats
 * @property {() => void} destroy
 */
