# Architecture

Design of this polyfill: a live-DOM shadow snapshot implementation of HTML-in-Canvas. Read `docs/API-CONTRACT.md` first (the public
behaviour this implements); [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md) is the short version of the main choices. Types are in
`src/contracts/types.js`; every cross-module object is typed there.

Evidence labels used below: **[probe]**, **[probe2]**, **[probe3]** = one-run design probes on Chrome 154.0.8037.98, headed (layout, hit-test, frame ordering of rAF /
ResizeObserver / microtasks, and accessibility-tree facts, not timings; some were taken under machine load above threshold, which does not affect facts of this kind).
**[E4]** = the taint matrix (which 2D and GPU sinks an SVG `foreignObject` image taints, and whether workers rasterise it). **[E5]** = measurements of the prototype that
preceded this implementation. **[E6]** = the native baseline (Chrome 154 with the flag, Canary 157). **[review-b]** = timing probes of a design review (taken under machine
load above threshold, used as ratios only). **[spec]** = the WICG explainer and the HTML Standard pull request. The raw probe data is not part of this repository.
Anything unlabeled is a design decision, not a measurement.

## 1. Layers and the one-sentence model

```
 author page                      real DOM children of <canvas content=drawable>
      |  install()                        |  (relocated, never cloned, never re-created)
      v                                   v
+-------------+   +------------------------------------------------------------------+
| api-core    |   | LIVE LAYER (live/): sibling <hic-layer>, anchored to the   |
| install,    |   | canvas content box, opacity:0, laid out + focusable + scrollable +   |
| detect,     |   | IME-native. The BROWSER paints it; hit-testing is native.            |
| registry,   |   +------------------------------------------------------------------+
| report      |          | mutations / input / focus / hover / scroll / resize / dpr
+-------------+          v
| api-surface |   +----------------+   damage   +-------------------+  CaptureFn  +----------------+
| patches:    |<->| schedule/      |----------->| snapshot-store    |------------>| snapshot-      |
| canvas, 2D, |   | scheduler,     |  pump()    | surfaces, damage, |  data: URL  | capture        |
| GL/GPU,     |   | fps cap,       |  commit()  | versions, decode  |<------------| clone, css,    |
| ElementImage|   | observers      |            | (img.decode ->    |  (sync)     | resources, svg |
| paint event |   +----------------+            |  drawImage)       |             +----------------+
+-------------+          | frame hooks           +-------------------+
      ^                  v                              | rasterSource / SOURCE_VERSION
      |           +----------------------------------+  v
      |           | gpu-effects: effect host, plugin ABI v2, input interposer             |
      +-----------+ reads sources through a SourceProvider; sets geometry via GeometryApi |
                  +----------------------------------------------------------------------+
```

One sentence: the live DOM stays the source of truth and is painted by the browser; the polyfill photographs it (per drawable, damage
cropped) into retained 2D surfaces, and everything the standard API offers (`paint`, `drawElementImage`, `ElementImage`, textures)
reads those surfaces.

Dependency rule (enforced by gate G-deps, a grep over imports): `contracts/` and `util/` import nothing. `live/`, `snapshot/capture`,
`snapshot/store`, `schedule/`, `effects/` import only `contracts/`, `util/` and their own directory; they talk to each other through
the typed interfaces (`LiveLayer`, `CaptureFn`, `SnapshotStore`, `Scheduler`, `SourceProvider`, `GeometryApi`) injected by
`api/compose.js`. Only `api/` imports the factories of the other modules.

## 2. Data flow of one change (typing in an `<input>` in drawable F)

1. Native: the live input gets the key, IME and caret natively. A capture-phase `input` listener (schedule/observers) and a
   MutationObserver publish `Damage{record, drawable:F, rect, cause:'input'}` through `Scheduler.damage`.
2. `Scheduler.damage` -> `SnapshotStore.markDamage(F, rect, 'input')`; the canvas is put on the next rAF tick.
3. Frame (ADR-C): the rAF ARM callback arms the frame-end phase; at the END of the frame (ResizeObserver slot, after app rAF, layout and app observers) the RUN does: paint gate -> `commitLanded()` of the PREVIOUS builds (and the optimistic text overlay) -> `ChangeSet` -> `paint` event; then ONE task posted after the rendering update runs `pump()`, which starts a new build (so the build never delays the frame):
   `CaptureFn(req)` clones the damaged crop of F (state-synced: values, scroll offsets, focus; the caret is measured, not drawn), tree-shakes and flattens CSS, inlines resources,
   serialises to a `data:image/svg+xml` URL (synchronous, bounded by `PumpBudget.mainThreadMs`).
4. The store creates an `Image` and `await img.decode()` -> result lands in a queue (generation-tagged). Decode is asynchronous but NOT free: its main-thread share is budgeted (ADR-D.8).
5. Next frame: `commitLanded()` writes the decoded tile into F's retained 2D surface with the ATOMIC bounded commit (clip + `copy` of the crop rect only, a failure keeps the old pixels),
   paints the caret patch, publishes a new immutable `SnapshotVersion` (with `layoutOffset`), emits `SOURCE_VERSION` (effects) and returns `changed:[F]` -> `paint{changedElements:[F]}`.
6. Author handler: `ctx.drawElementImage(F, ...)` copies the surface into the canvas bitmap. Or the effect host uploads the surface into a
   GPU texture and draws a post-process pass on the same canvas.
Minimum latency is two frames (build tick + commit tick); measured on the prototype at 120 Hz: keydown-to-pixel p50 15-34 ms, p95 up to 100 ms
(decode tail) [E5].

## 3. Ownership of the shared record (who may WRITE a field)

`CanvasRecord` (types.js) is created by the registry and read by everybody. A field is written only by its owner; others call the
owner's interface.

| field | owner (writer) | note |
|---|---|---|
| `id`, `canvas`, `legacy` | api-core `canvas-registry.js` | immutable after create |
| `root` | api-core `canvas-registry.js` | tree scope (document or shadow root); updated on a move between scopes (ADR-K) |
| `state` | api-core `registry.setState()` only | emits `BUS.CANVAS_STATE`; the lifecycle (section 4) |
| `layer` | live (`mount`/`unmount` via registry hand-off) | `null` unless active/suspended-with-layer |
| `contentBox` | live (`layer.syncPresentation`) | emits `BUS.RESIZE` when css size or grid scale changed |
| `store` | snapshot-store | per-record view of the global store |
| `geometry` | api-surface `geometry.js` | `byElement`, `order`; it then calls `layer.applyGeometry/setHitTestOrder` |
| `paint`, `frameCap`, `dpr` | schedule | `paint.force` set by `Scheduler.requestPaint`; `paint.waitingSince/gateReason` by the paint gate, `paint.microtaskFrame` by `paintNow` |
| geometry rules, `aria-owns`, layer clip | live | polyfill-owned sheets per root; never the author's `style` attribute (ADR-F, ADR-L, ADR-M) |
| `offscreen` | api-surface `offscreen-patch.js` | |

Cross-module events go through `BUS.*` (`contracts/events.js`); the comment of each topic names its payload and, where it matters, its single emitter. Two topics have two emitters: `DRAWABLES_CHANGED` (the layer's own drawable scan and the mutation observer) and `RESIZE` (the presentation sync and the canvas ResizeObserver, which skips a change the sync already announced).

## 4. Lifecycle

### 4.1 install / uninstall
`install(opts)` (sync): resolve options -> `probeNative()` -> decide mode (API-CONTRACT 2) -> browser gate -> create env (bus, reporter,
registry) -> `compose` (root scope, store, capture, scheduler, observers, effects) -> patch prototypes through `api/patch.js` (every patch recorded in
a ledger with the original descriptor: the standard surface, `attachShadow`, the fullscreen/popover guard, the worker `postMessage` guard, the synchronous mount hooks) -> `registry.scan(document)` and every open shadow root
(existing canvases) -> start the per-scope MutationObservers (dynamic canvases) -> return `HicInstalled`. A native build with only ADDITIVE names missing is gap-filled (ADR-N). Patching happens BEFORE the scan so an app script that runs right after sees the final API.
`uninstall()` (idempotent): for each record `unmount` (children restored to the canvas in original order, layer + facade + attributes
removed) -> stop observers, scheduler (cancels rAF), effects -> `store.forgetAll` (surfaces released) -> restore descriptors from the ledger
in reverse order -> `bus.clear()`. Postcondition checked by G-lifecycle: serialised DOM and prototype descriptors equal their pre-install state.

### 4.2 Dynamic canvases (registry, `canvas-registry.js`)
One `MutationObserver` per tree scope of `env.roots` (the document and every observed shadow root; childList+subtree, attributes `content|layoutsubtree|drawable|popover`, filtered through
`env.isManagedLayerNode`) drives the per-canvas state machine. `registry.ensure(canvas)` (synchronous `env.adopt`) is also called by the patched `content` setter, `setAttribute/removeAttribute/toggleAttribute` and every API entry point, so a connected `content=drawable` canvas the observer microtask has not delivered yet is mounted at once (a layout read right after `canvas.content='drawable'` sees laid-out children). Parser-inserted markup: the observer sees the canvas before its
children are parsed; the layer is mounted at once and later children arrive through the canvas MutationObserver and are relocated in a
microtask (children of a canvas are not rendered by the browser, so there is no flash) [probe: canvas children have a 0x0 box and no offsetParent].

```
detached --(content=drawable | layoutsubtree, connected)--> mounting --(layer mounted)--> active
active --(canvas disconnected | canvas display:none)--> suspended --(reconnected; within the same task = a MOVE)--> active
active|suspended --(content!=drawable)--> detached      (children restored, snapshots cleared)
any --(uninstall | suspended > suspendGraceMs=5000)--> disposed
```
A canvas that is removed takes its layer out of the document with it (children are out of the document as natively; framework-owned parents stay clean); a canvas that is MOVED (removed and reinserted in one task) keeps its layer: the registry re-inserts the layer after the canvas
(`layer.element` is a sibling, so it does not travel with the canvas) in the new tree scope, switching `record.root` and the style handle. A `content=drawable` canvas inside another managed canvas gets its own record (its layer sits inside the outer layer, ADR-A). A canvas with a `popover` attribute is refused (ADR-L). Suspended records hold the canvas through a `WeakRef` after the
grace period (no leak for canvases that are dropped). `mounting` is the only state in which children are in transit; no API call observes it
(calls are synchronous, relocation is synchronous inside one task).

## 5. Architecture decision records

### ADR-A: how canvas children become live and laid out

**Problem.** No browser lays out the children of a `<canvas>` (they are fallback content) [probe: child box 0x0, `offsetParent` null].
The design needs them real: laid out, focusable, scrollable, hit-testable, IME-native, in the accessibility tree.

**Alternatives.**
1. Keep children in the canvas. Impossible (above).
2. Replace the canvas by a `<div>` host (the E5 prototype). Rejected: destroys canvas identity (`getContext`, `width/height`,
   `toDataURL`, `transferControlToOffscreen`, the effect host's WebGPU context).
3. Wrap the canvas in a div. Rejected: changes the author's DOM and `parent > canvas` / `canvas + x` selectors.
4. Shadow root on the canvas. Impossible: `attachShadow` on `<canvas>` throws `NotSupportedError` [probe].
5. Portal the layer to `<body>`. Rejected: loses the stacking context, transforms, scroll container and inheritance of the canvas's place.
6. **Chosen: relocate the logical children into one polyfill-owned layer element inserted as the NEXT SIBLING of the canvas.**

**Decision.**
- Layer: `<hic-layer data-hic-layer="N" data-hic-node role="presentation">` after the canvas (an UNKNOWN tag: author `div`, `div:last-child`, `:nth-of-type` and `.card > div` rules cannot match it); the canvas gets `data-hic-canvas="N"` (plus a merged `aria-owns`, ADR-M: the only attributes written on it).
  Positioned with CSS anchor positioning, so the browser keeps it glued to the canvas through layout, scroll, resize and ancestor
  transforms with no JS per frame: the canvas gets `anchor-name:--hic-N` via the polyfill stylesheet, the layer
  `position:absolute; position-anchor:--hic-N; top:anchor(top); left:anchor(left); width:anchor-size(width); height:anchor-size(height);
  box-sizing:border-box; border:solid transparent; padding:...` with the canvas's border/padding widths copied, so the layer CONTENT box equals the canvas CONTENT
  box. [probe] verified: block and inline canvas, after an inner scroll, and under a `scale(1.5)` ancestor, layer and canvas content boxes are
  identical to 0.01 px. Anchor positioning needs Chrome >= 125 (the browser gate is >= 130).
- Layer style (one adopted stylesheet PER TREE SCOPE, ADR-K): `opacity:0; pointer-events:none; overflow:clip; contain:layout; overflow-anchor:none; isolation:isolate`, and EVERY load-bearing declaration (position, anchor insets, size, margin, display, opacity, pointer-events, overflow, contain, isolation)
  is `!important` (sheet) or inline `setProperty(..., 'important')`, so `.stack > * {margin-top:1rem}`, Tailwind `space-y-*` or `* + *` cannot displace the layer and silently desynchronise hit testing from the pixels [review-b measured margin displacement]. `@media print` hides the layer (the canvas bitmap prints).
  `opacity:0` keeps the subtree hit-testable, focusable and in the a11y tree (E5 typed into such an input); `pointer-events:none` on the layer lets
  empty areas fall through to the canvas, drawn drawables re-enable it (ADR-F) [probe: child `auto` under a `none` layer is hit; empty area hits the canvas].
- `layer.syncPresentation()` copies from the canvas to the layer: border widths, padding, `z-index` (so a z-indexed canvas does not cover
  its own layer), `transform`/`translate`/`rotate`/`scale`/`transform-origin` of the canvas itself (a sibling does not inherit them),
  `display`, `visibility`, `inert`, `direction`, `writing-mode`, and ALL inherited properties computed on the canvas (`INHERITED_PROPS`: font*, color, line-height, spacing, text-*, white-space, word-break, hyphens, tab-size, quotes, cursor,
  text-shadow, list-style, image-rendering, forced-color-adjust, accent-color, color-scheme, caret-color, `container-type/name`) plus the custom properties declared on the canvas, because children no longer inherit from the canvas. Triggered by ResizeObserver, attribute mutations of the canvas, `matchMedia` changes, window resize, and a 1 s
  idle safety poll (border/padding changes do not resize the box and are otherwise invisible).
- Children are placed directly in the layer in logical order (no wrappers: a `display:contents` wrapper has a zero rect and a transformed wrapper needs
  `flow-root` [probe]). The layer is a block formatting context (layout containment, like the spec's canvas); top-level inline-level children are
  NOT blockified (limitation; every standard example uses blocks). **Current layout:** the layer is `display:grid` with one 100% x 100% cell and `align-items:start`; each direct child gets `grid-area:1/1; margin:0; position:static` through a zero-specificity `:where()` rule, so children sit at the origin like native and inline-level children are blockified; widths still fill.
- **DOM-identity facade** (`live/tree-facade.js`, `event-bridge.js`; instance-level own properties, removed on unmount; prototypes are not touched except
  where noted): on the canvas: `childNodes, children, first/lastChild, first/lastElementChild, childElementCount, hasChildNodes, append, prepend, appendChild,
  insertBefore, removeChild, replaceChild, replaceChildren, contains, innerHTML, textContent, addEventListener/removeEventListener` operate on the LOGICAL child list
  (writes go into the layer, then `onChildrenChanged` fires; this is how React/Vue/Lit reconcile children of the canvas). On relocated top-level children: `parentNode, parentElement, previousSibling, nextSibling,
  previous/nextElementSibling`. On the canvas also `nextSibling/nextElementSibling` (skip the layer), and with `parentFacade` (default true) on the PARENT of the canvas: `children, childNodes, childElementCount, firstChild/lastChild,
  firstElementChild/lastElementChild` hide the layer (`children` becomes a snapshot array-like, not a live HTMLCollection). CSS `:last-child`, `:nth-child`, `+`, native live collections and `parent.innerHTML` still see the layer (limit, row `tree-identity`).
  `canvas.addEventListener(type, fn)` and the `on*` handler properties of the canvas (`canvas.onclick = fn`) register a bridge listener on the layer for events whose target is a
  descendant, overriding `currentTarget` to the canvas and `composedPath()` (the layer entry is replaced by the canvas) (own-property overrides on the event work [probe]).
- **Selector bridge** (`live/selector-bridge.js`, option `selectorBridge`): `queries` = `Document/Element .querySelector[All], matches, closest` are wrapped
  (only when a managed canvas exists and the selector has a combinator or names `canvas`): the native result is unioned (document order, deduped) with the
  result of the selector rewritten for each managed canvas (the compound that `canvas.matches()` is replaced by `[data-hic-layer="N"]`);
  `css` = a polyfill `<style data-hic-node>` mirrors every stylesheet rule whose selector has a canvas-matching compound with the layer attribute substituted
  (cached per stylesheet epoch, re-evaluated when the canvas's class/id/data-*/lang/dir change). The replacement PRESERVES SPECIFICITY (`:not(.hic-pad)` padding, `layerReplacement`): a per-canvas rewrite, not a `:is(canvas, [data-hic-layer])` form, because that form would make every class-only author rule restyle the layer.
  The SAME pure rewriter produces the clone's CSS (replacement `[data-hic-root]`). Not bridged: `canvas + x`, `canvas ~ x` (siblings after the canvas),
  `:has()` crossing the boundary, author MutationObserver records on the canvas (the polyfill does not synthesize them; rows `tree-identity`, `selector-bridge`).
- focus/scroll/IME: native, because the elements are real. Tab order follows layer position (after the canvas in DOM order = where the canvas
  fallback content would be). `overflow:clip` stops the layer itself scrolling when focus reveals an element; inner scrollers inside the
  drawable scroll natively; scrollers of the CANVAS's own ancestors are revealed by the polyfill (ADR-L). A drawable that is partly outside the canvas box is captured whole (the clip only restricts hit testing).
- a11y: the AX tree has the real controls with real bounds; the canvas-to-content relationship is restored with `aria-owns` (ADR-M).
- Containing block, clipping, fixed, stacking, top layer: ADR-L. Shadow roots: ADR-K. A nested `content=drawable` canvas inside a managed canvas is managed independently: the recursion is natural (its layer is the next sibling of the inner canvas, inside the outer layer; the outer capture skips polyfill nodes and shows the inner canvas as a bitmap).
- Measured/verified consequences: layout of children equals plain DOM in the same box (the pixel oracle compares against a plain-DOM twin, G-pixel-*).

**Consequences.** (+) native input, selection, IME, cursor shapes, scroll physics, a11y with real geometry. (-) the facade is a compatibility
surface to keep tested (page-structure and framework fixtures, G-page-structure and G-framework-smoke); `display:none` canvas hides the layer; anchor positioning is Chromium-only (consistent with the Chrome-only first release);
the containing-block chain of an absolute layer differs from the canvas's (ADR-L).

### ADR-B: retained-surface model

**Decision: one retained surface per drawable element** (not one per canvas), because the spec's unit is the element (`changedElements`,
`captureElementImage(el)`, per-element geometry, nested drawables excluded from their parent's snapshot) and because a per-canvas surface would
force a full-canvas composite for every typing commit.
- `SnapshotStore` keeps per drawable: `surface` (HTMLCanvasElement/OffscreenCanvas 2D, covers border box + `inkMargin` on each side, raster scale
  `s = clamp(contentBox.gridScaleX, 1, maxDpr)` so a draw at the default size is a 1:1 pixel copy), the current `SnapshotVersion`, the damage record
  (union rect, epoch, generation) and in-flight builds. A drawable whose surface would exceed `maxSurfacePixels` is rastered at a reduced `s` and reported (`surface-size`).
- **Tiles (atomic bounded commit).** A commit replaces only the damaged crop in ONE operation: guard `img.complete && naturalWidth > 0`, then `save(); beginPath(); rect(crop); clip(); globalCompositeOperation='copy'; drawImage(tile); restore()` (`decode.drawTileAtomic`).
  `copy` WITHOUT the clip is unbounded (it wiped the rest of the canvas in the E5 scroll oracle: that was the missing clip), and `clearRect` + `drawImage` leaves a permanent hole when `drawImage` throws (measured: alpha 0 after a broken image, [review-b x8]);
  clip + copy keeps the previous pixels on failure and replaces transparent pixels like clearRect did. Crop rects are whole surface pixels. Damage above 55 % of the surface becomes a full tile.
- **Nested drawables.** `CaptureRequest.element` clones the drawable subtree EXCLUDING every nested drawable (replaced by a same-size invisible spacer so
  layout is unchanged); each nested drawable has its own surface/version. Damage inside a nested drawable belongs to it, not to the parent. A parent whose layout
  changed because a nested drawable changed size gets whole-surface damage (structural).
- **`drawElementImage(el, ...)` -> surface.** The call resolves `el` to a `SnapshotVersion` and issues one `ctx.drawImage(source, sx*s, sy*s, sw*s, sh*s, dx, dy, dw, dh)` with
  `RasterSource` from `SnapshotStore.rasterSource(version, sourceRectCss)`; the browser applies the context's CTM, clip, filters, alpha and compositing exactly as for `drawImage`.
  Source rects with a negative origin reach into the ink margin; parts outside the surface draw nothing. Geometry (hit test/a11y) is a separate side effect
  (ADR-F), computed from the version's numbers only, with the spec formula.
- **Immutability.** A `SnapshotVersion` is immutable once published: `pinned`/`refs` count the `ElementImage`s (and in-flight draws) that reference it. If a
  commit needs to write a pinned surface the store FORKS first (new surface = full `drawImage` copy of the old one, old surface stays with the pinning
  `ElementImage`s) then writes the tile into the new one; unpinned surfaces are written in place (a commit is one synchronous step, so no draw can interleave).
  Cost: at most one full-surface copy per capture-then-commit. `ElementImage.close()` and the FinalizationRegistry unpin. Metadata-only versions (resize, ADR-E) share the surface and pin it.
- **"Throws before an initial snapshot".** `store.version(el)` is `null` until the first commit lands, after `drop(el)`, `forget(record)`, `display:none`, removal, ineligibility.
  `pin`/`drawElementImage`/`captureElementImage` then throw `InvalidStateError` (API-CONTRACT 6.2). The first commit of a drawable waits for `CaptureResult.complete`
  (fonts/images) up to 400 ms so the first paint is not a flash of unstyled content.
- **Monotonic commits (the cross-generation race).** Each drawable has a `generation` (per build) and an `epoch` (bumped by STRUCTURAL damage: childList mutation, attribute/style
  change that can move boxes, resize, dpr, stylesheet epoch). A landed result is dropped if its epoch is older than the drawable's current epoch or its generation older than the
  last committed one; otherwise it is committed even if newer, non-structural damage is pending (that damage stays marked and rebuilds the region): progress is monotonic and a seam
  between tiles of different layouts cannot be shown. One exception: a WHOLE tile whose epoch was bumped only by DOM mutations is committed (a complete picture has no seam and is
  newer than the one shown) and the pending damage rebuilds the latest state; without it a drawable whose content changes size every frame (a counter in proportional digits) was
  starved, every build superseded before its commit. A resize, dpr, stylesheet, content-attribute or forced cause still drops it (`DamageTracker.hard`), and so does the commit before a
  forced paint (`requestPaint()`, the first paint, a canvas shown again: `commitLanded(record, {current: true})`), which must show the DOM as it is now (a child canvas drawn right before `requestPaint()`). All results of one canvas that landed before a tick commit in ONE synchronous `commitLanded()` step.
  **Invariant: every dropped result re-damages its rect** (`DamageTracker.reclaim`: the dropped crop minus rects of newer committed or in-flight tiles; stat `redamaged`), otherwise an older tile that covers a region the newer non-overlapping tile does not would leave a permanent stale patch.
- **Context loss.** Every retained surface is watched (`surfaces.watchSurfaceLoss`): `contextlost` freezes it (last version stays published), `contextrestored` queues whole-drawable damage (`forced`) and emits `SURFACE_RESTORED`; allocation checks `getContext('2d')`. Recovery target: non-blank within 3 frames (G-fault-injection / G-context-loss).
- **Caret patch.** The tile never contains the caret. `CaptureResult.caret` (measured rect + color) is painted on the retained surface by `caret-patch.js` after the tile (save pixels, fill; blink restores or fills; a tile that lands over the rect forgets the saved pixels). A blink is `caret` damage served WITHOUT a build. The patch is a write: a pinned surface forks first.
- **Paint readiness.** `isPaintReady(record)` feeds the paint gate (ADR-C): not ready while an eligible drawable that has a CSS box has no version/placeholder, or (coherentPaint) while builds of the same damage epoch as a landed result are in flight.

**Consequences.** Memory = sum of drawable surfaces (bounded by `maxSurfacePixels` each and `maxTotalSurfaceBytes` in total; report `surfaceBytes`; a full-canvas 1440x900 css drawable at DPR 3 is 46.7 MB, so the total budget, not the per-drawable one, bounds 30 drawables). ElementImage costs a copy only when it outlives a commit.

### ADR-C: paint-event emulation

**Native** [spec]: `paint` is fired at the END of update-the-rendering (after rAF callbacks, style/layout, ResizeObserver and IntersectionObserver steps); every snapshot is created BEFORE it fires, so a draw inside the handler never fails for lack of a snapshot;
canvas draws made in the handler are part of the same frame; DOM changes made in it apply to the next frame; fired in reverse tree order.
**Polyfill**: the frame has two phases (`schedule/frame-phase.js`).
- **ARM (rAF).** One rAF callback for all canvases: cap gate, bookkeeping, toggles a fixed 1 px sentinel (`position:fixed; contain:strict; visibility:hidden`, polyfill-owned) and creates a FRESH `ResizeObserver` on it.
- **RUN (ResizeObserver callback = frame end).** Runs after app rAF callbacks, after style/layout and after every earlier-created observer and the microtasks they queued. [probe3] in one real Chrome 154 frame: `rAF-app, rAF-polyfill-tick, RO-install-time, RO-app, microtask-in-RO-app, RO-fresh-per-tick`.
  An install-time observer would run before the app's, which is why one is created per tick (cheap, only while armed). If the callback does not arrive by the next ARM (no layout), the next rAF runs the tick directly and counts a fallback (`stats().phaseFallbacks`).
  Consequences: an app rAF that fills red followed by an `onpaint` that fills green ends green (changes-in-paint-event); a game that draws the scene in rAF and the HUD in `onpaint` keeps its HUD; `canvas.width` written in an app ResizeObserver is redrawn by the setter microtask (ADR-E). Remaining deviations:
  `paint-timing` (a paint in the tick is not after the IntersectionObserver steps; a snapshot that cannot land at once lags the DOM by >= 2 frames) and `paint-dom-write-timing` (a DOM write in the handler is laid out in the same frame by the RO loop, native: next frame; since a managed canvas shows snapshots this only affects the page's own non-snapshot DOM; the browser may log a benign "ResizeObserver loop" notification).

Tick RUN(now), for each canvas record in reverse tree order:
1. `due = capGate.allow(record, now)` (phase-accumulator pacing, `frame-cap.js`). If `!due` and nothing forced: skip to step 4 with `due:false`.
2. **Paint gate** (`paint-gate.js`, `store.isPaintReady`): the paint of a canvas fires only when every eligible drawable that has a CSS box has a committed version or a placeholder (first paint after load, after `content` toggled, after a reset, after a dynamically added drawable) and, with `coherentPaint`, no build that started from the
   same damage epoch as an already landed one is still in flight. `force` stays set while closed. Caps: `paintGateMaxWaitMs` (400, first commit) and `coherenceMaxWaitMs` (50); on timeout the paint fires anyway and a report entry is made (`stats().gateTimeouts`). A canvas with no eligible drawable-with-a-box is open (paint with `[]`).
3. If open and (`record.paint.force || store.hasLanded()`): `cs = store.commitLanded()`; fire when `cs.changed.length || cs.removed.length || force` (`record.paint.force=false` first,
   `serial++`, `SchedulerHooks.firePaint(record, cs.changed)`; a throwing handler is reported by the platform, never breaks the loop; `requestPaint()` inside the handler sets `force` for the next frame). A force-only paint already fired this frame by `paintNow` is skipped.
4. `store.pump(now, budget)`: starts due builds (`maxInFlight` 2 per canvas, synchronous part <= `mainThreadMs` 4 ms, total main-thread share incl. decode <= `mainThreadShare`, remaining work -> `moreWork`).
   The FIRST build of a drawable (never built: it holds back every paint of its canvas) is held by neither `maxInFlight` nor `mainThreadMs`, only by the cost bucket, which charges
   it the fixed 3 ms estimate, not its measured cost, and it uses no credit of the snapshot-rate gate: the first snapshot of a canvas is one round (at most 8 drawables), whatever cold
   compilation or machine load made it cost, and the change right after the first paint is built in the next frame.
   `now` is frame time: the timestamp of the last rendering update plus whole frame periods, so the snapshot-rate gate does not depend on when the post-frame task ran.
   That gate (`min(F, maxSnapshotFps)`) is a credit of builds that grows by one per interval and is capped at one and a half: the long-run rate is the cap, and after a pause two
   builds may start one 120 Hz frame apart, never three (it replaced a phase accumulator whose catch-up allowed that second build or not depending on the phase left by earlier builds).
   A long build defers its decode start to the next task, a `scheduler.postTask` user-blocking task like the post-frame pump, so the tile still lands before the app's queued tasks.
   Ordering 3-before-4 means DOM writes made in the paint handler are captured by the build started in the same frame, and the capture reads freshly laid-out DOM (no forced layout).
5. Frame hooks (`addFrameHook`: the effect host renders here, after the new source version is committed); a hook returning `true` keeps ticking.
6. Re-arm only if: damage pending, builds in flight/landed, `force`, the gate is waiting, a hook asked, or the cap deferred work (there is no timer). Idle page = zero rAF and zero ResizeObserver from the polyfill (the only remaining timer is the caret blink while a text control is focused; the 1 s presentation poll was replaced by events; G-idle).

- **Early paint where a tile lands.** A tile whose image is complete one microtask after `src` was set (Chromium loads a data: SVG with its sheet in an SVG `<style>` at once; store/decode.js `decodedAtOnce`, `BUS.LANDED`) is committed and painted by the same steps 2-3 right there instead of at the next tick: inside the rendering update for builds made in the tick (first snapshot, resize), so the first paint of a canvas fires in its first frame; in the post-frame build task otherwise, which is a `scheduler.postTask` user-blocking task where available, so the paint comes after the frame computed its IntersectionObserver entries and before the app's ordinary tasks (WPT onpaint-fires-post-intersection-observation-steps, onpaint-fires-post-resize-observer, requestPaint, onpaint). Only for uncapped canvases that have not painted in this frame interval and have no canvas nested in or around them; everything else waits for the tick. A post-frame build is queued only when a pump has something to do (`store.needsPump`), so no build task left behind a quiet frame takes a later DOM change ahead of the frame that should observe it.
- **Frames.** A same-origin iframe inside a drawable whose document runs its own install: the parent's tick runs the child's tick first (window symbol `hic.frame-tick`), and holds the containing canvas while a child paint is still owed, so canvases paint in reverse tree order across frames.
- `paintNow(record)` (from the width/height setter microtask): the same steps 2-3 without the pump, at most one per frame, never inside a dispatch (then `requestPaint`).
- `changedElements`: `ChangeSet.changed` (tree order, nested drawables are separate entries; deviation `paint-order`). A removed nested drawable lists its drawable ancestor, a removed non-nested one lists nothing (WPT onpaint-remove-drawable-element). Computed from the store, i.e. from DAMAGE, not by diffing pixels: a drawable
  changes when its committed version advanced. Damage that produces identical pixels still advances the version (no pixel compare; spec allows spurious paints).
- Coalescing: damage between ticks is unioned per drawable; one `paint` per canvas per frame; `requestPaint` is idempotent until fired.
- FPS cap: `capGate` per canvas, `F = frameCap` (`framecap`, else `defaultFrameCap`), build rate `min(F, maxSnapshotFps)` (an in-frame resize / DPR re-raster is held by `F` only). `due` is true when `now >= nextDue - tolerance`
  and then `nextDue += 1000/F` (resynchronised if more than 2 intervals late). A cap lower than the display rate therefore skips whole ticks. `interactionFloorFps` (default 0) lets input damage
  use `max(F, floor)`.
- Hidden tab: rAF stops, so does everything; on `visibilitychange` visible a full-damage + `force` is queued (gate G-hidden-visible).

### ADR-D: snapshot pipeline

`CaptureFn(req)` (synchronous, never throws; failures -> `result.unsupported` + placeholder markup) then store-side decode.

1. **Clone with state sync** (`clone.js`, `state-sync.js`): the unit is ONE drawable. The clone root is a `div.hic-root` carrying the layer's INHERITED computed text properties (so html/body-derived
   inheritance works) containing SHELLS for the logical ancestors between the layer and the drawable (same tag/attributes; `display:contents` so `a > b` and `.x .y` selectors
   and inheritance work with zero layout effect, EXCEPT a shell whose computed `container-type != normal`, or with `contain`, `overflow != visible`, transform or filter, which becomes a real box with its measured size, translated so the drawable lands at the crop origin: a display:contents shell is not a query container, measured in an SVG image [review-b x10]),
   plus attribute-only `display:none` stubs for every element sibling in order (so `.a + .b`, `~`, `:nth-child`, `:first/:last/:only-child` keep their live answer: stubs measured to preserve them), then a clone of the drawable with forced `box-sizing:border-box; width/height = measured border box; margin:0; position:static|relative; transform:none;
   contain:layout; isolation:isolate`. The first shell stands for the canvas (attributes of the canvas, `data-hic-root`). Nested drawables become invisible spacers. Skipped nodes: `script, style, link, noscript,
   template`, `[data-hic-node]`. State copied: `input` value/checked/indeterminate/`valueAsNumber` as attributes, `select` selected options, `textarea` text, `details[open]`, `dialog` (non-modal only),
   `scrollTop/Left` of every scroller (children translated; sticky children re-pinned as overlays; long child lists pruned to the visible window +-60 %), `<canvas>` bitmaps (size budget), `<video>` poster/frame,
   `img currentSrc`, CSS animations (frozen: each animated property's COMPUTED value is written inline and `animation/transition:none`), `:focus`/`:focus-visible`/`:focus-within`/`:hover`/`:active` as classes
   `hic-focus*/hic-hover/hic-active` from `CaptureRequest.interaction`, `hic-focus-visible` adds the UA focus ring (`outline:auto`) that the clone does not get natively. IDs are kept; duplicates are harmless in the isolated image document.
   Prototype evidence: caret, values, scroll offsets, sticky header all pixel-exact [E5, fidelity 0.0003 % / 0 % / 0 %]. The shell trick is verified [probe2]: a `display:contents` shell carrying `.wrap` makes the descendant rule `.wrap .x` and inherited `color/font` apply inside the foreignObject image, and a canvas that drew the `data:` URL image stays origin-clean (`toDataURL` does not throw).
2. **Caret and selection** (`caret-overlay.js`): the caret is MEASURED (1 css px bar at the caret x from canvas `measureText` with the control's font, `caret-color`) and returned in `CaptureResult.caret`; it is NOT in the tile: the store paints it on the retained surface (ADR-B caret patch), so a blink is O(caret rect) with no build and no decode
   (with the caret in the clone every blink was a full capture of the drawable and the page was never idle while a field was focused). Non-collapsed selection = `::selection`-coloured rects from the measured ranges, kept in the tile (limited for textarea/contenteditable, row `caret-selection`).
3. **CSS collection and flattening** (`css-collector.js` + pure `css-rewrite.js`, cached by `CssBundle.key`): walk `document.styleSheets` + `adoptedStyleSheets` (imports followed); evaluate `@media`
   against the live viewport with `matchMedia` and inline the matching rules; keep `@layer`, `@supports`, `@container`, `@keyframes`, `@font-face`; replace viewport units by px of the LIVE viewport; rewrite
   `html|body|:root` -> `.hic-root`; `:hover|:active|:focus|:focus-visible|:focus-within` -> classes (`CssBundle.pseudo` says which exist, so damage for hover/focus is skipped when no rule uses them);
   canvas-ancestor compounds -> `[data-hic-root]` (selector bridge); drop `:visited` rules, `::-webkit-scrollbar` (ADR-E). Rules of the canvas's own shadow root and its `:host` are included (ADR-K). The polyfill's own sheets are skipped. **Per-tile tree-shaking** (`css-shake.js`, pure): before serialising, keep only the rules whose rightmost
   class/id/tag tokens occur in the pruned subtree (conservative for `*`, `:root`, attribute selectors) and only the `@font-face` whose family appears in a kept rule; cached per (bundle key, token signature). Motivation is cost per BYTE (ADR-D.8). Cross-origin sheets whose `cssRules` throw are fetched with CORS or refused
   (`cross-origin-resource`). The cache is invalidated by the stylesheet epoch: `<style>/<link>` mutations, `adoptedStyleSheets`, and wrapped `CSSStyleSheet.insertRule/deleteRule/replace[Sync]` and
   `CSSStyleDeclaration.setProperty/removeProperty/cssText` when `parentRule` is set (schedule/observers/stylesheet-observer.js).
4. **Resource inlining** (`inline-resources.js`, `ResourceCache`): every `url()`, `<img src/srcset(currentSrc)>`, SVG `<image>`/`<use>` and `@font-face` source is fetched (same-origin with credentials per
   the element's `crossorigin`, else CORS) and replaced by a `data:` URL (SVG-as-image cannot load external resources [E4], and `blob:` taints every sink [E4]). LRU byte budget (default 48 MB), keyed by absolute URL.
   `peek` is the hot path; a miss starts a load, marks `complete:false`, and a `resource` damage is published when it arrives. Failures are LOUD (`cross-origin-resource` / `resource-fetch-failed`: placeholder
   or, for fonts, a fallback face + entry). Fonts: capture waits for `document.fonts.ready` (<= 1 s) before the first commit, `loadingdone` publishes `stylesheet` damage.
5. **SVG build** (`svg-builder.js`): `<svg width=cw*s height=ch*s viewBox=crop*s><foreignObject width=... height=...>` + the `div.hic-root` markup serialised with `XMLSerializer`, CSS in one `<style>`; layout at
   physical-pixel scale through `zoom:s` inside the image (not viewBox up-scaling: it drifted line metrics [E5 notes]); the viewBox crops the damage rect. Encoded as a **percent-encoded `data:` URL**
   (default; base64 optional via an internal switch), never `blob:`.
6. **Damage tiling**: `Damage.rect` in the drawable's border-box frame (`LiveLayer.frameRect` removes any applied geometry transform); the store unions per drawable, grows the rect by `inkMargin`, rounds to
   whole surface pixels, and converts > 55 % to a full tile. An element whose box changed size is bounded by the nearest ancestor (the drawable included) whose box did not change: when every
   child of that ancestor was measured before (no bare text, no generated content, at most 32 children), the rect is the old and new reach of the children that moved; otherwise the ancestor's
   own reach, or the whole drawable when that ancestor is the drawable (`schedule/observers/damage-rect.js`).
7. **Node budget** (`budget.js`): count nodes while cloning. `> soft` (350 by default per commit): the clone is damage-PRUNED (only subtrees intersecting the crop + ancestor skeleton + spacers) and the cadence adapts so
   main-thread time stays <= 50 % of the frame period; `> hard` (3000): the drawable is degraded to <= 4 fps, flagged, reported (`node-budget` limited); `> absolute` (20000): refused with a placeholder + entry.
   A 1125-node DOM measured ~25.7 ms RunTask per full commit (90 % busy) on the prototype [E5]: pruning and per-drawable surfaces are the lever, not a faster serializer.
   In a pruned tile, the trailing children of a large block / inline flow container that lie below the kept region are left out altogether (`clone.js` truncation): the cut starts a line
   (or the rest of its line is uniform), everything after it is below the region (one Range rect), and the container keeps its live height (and, as a row flex item, its width), so the kept
   lines lay out as they do live. Not done where the dropped content could matter: sibling-position or `:has()` selectors, justification, a styled last line, balanced / pretty wrapping,
   line clamping, columns, `::after` content, reversed numbering, scroll containers, focus inside.
8. **Async-decode pipelining and its main-thread cost** (`pump.js`, `decode.js`): `maxInFlight` builds per canvas; decode is `new Image(); img.decoding='async'; img.src=url; await img.decode()`; the decoded image is committed
   into the surface from the landed queue during `commitLanded()` with the atomic bounded commit (`drawImage` into a 2D canvas launders the SVG-image taint; `createImageBitmap(img)` and `copyExternalImageToTexture(img)` throw
   `SecurityError` on Chrome [E4]) and `img.src=''` frees the decode. Measured on the prototype: build 0.9 ms + encode 0.08 ms + decode p50 2.7 ms (small DOM), 118 commits/s at DPR 2 [E5 throughput]; E5's `mainMsPerCommit` EXCLUDES decode.
   **Decode is not off the main thread.** [review-b x6, ratios only] RunTask on the renderer main thread per tile was 4.2 ms (60 nodes), 6.6 ms (1125 nodes), 5.1 ms (60 nodes + 100 KB CSS) and 9.4 ms (1125 nodes + 100 KB CSS, max single task 11.7 ms, above the 8.33 ms budget), about equal to decode wall time + draw,
   against a build-only control of 0.08-0.9 ms per tile. At 118 commits/s a 4.2 ms tile is ~50 % busy before effects and caret. The cost is proportional to BYTES (encodeURIComponent ~2.6 ms/MB, decode ~6 ms/MB of payload, a 96 KB base64 font ~2.6 ms per tile, and it re-parses on every tile),
   so the levers are tile tree-shaking (D.3), pruning, and a budget: the pump keeps a per-drawable EMA of (sync build + decode wall + commit draw) and starts builds only while the sum stays under `mainThreadShare` (0.35) of the frame period; individual decode tasks above 8.33 ms count against G-typing. Caching serialized strings of unchanged top-level subtrees is an optional lever to try after measuring.
   Data URL size is not a limit in Chrome 154 (32 MB loaded and decoded, linear in time) [review-b x7]. Decode tail (p95 30-100 ms, worse at cap 120) remains the known weakness; mitigation is pipelining (>= 2 in flight) and never blocking input on it. Gate G-decode-main re-measures all of it in a QUIET window.

### ADR-E: resize, DPR, scroll, scrollbars

- **Resize (canvas box changes).** The live layer relayouts NATIVELY in the same frame (anchor positioning) so hit testing and a11y are already correct. The polyfill never writes `canvas.width/height`.
  A ResizeObserver on the canvas (`content-box`) updates `contentBox` and emits `BUS.RESIZE`. The store reacts at once: every drawable gets a METADATA-ONLY new version (new `canvasWidth/Height`, same
  surface, pinned-shared) and is marked `changed` so a `paint` fires in the next tick; a handler that wrote `canvas.width` (which clears the bitmap natively) redraws immediately from the previous pixels
  (old bitmap stays anchored, no blank frame; deviation `resize-stale-first`). Structural damage re-rasters every drawable at the new layout; the new versions follow in a second `paint`.
  Setting `canvas.width/height` (setter patched on managed canvases) refreshes `gridScaleX/Y` and `contentBox` SYNCHRONOUSLY from the layer (not from the polyfill's ResizeObserver, which the app's may precede) and queues ONE microtask that fires `paintNow(record)`:
  the README's `ResizeObserver` + `devicePixelContentBoxSize` example writes `canvas.width` inside the observer, the setter clears the native bitmap, and a microtask checkpoint follows every RO callback [probe3: microtask-in-RO-app runs before the next observer],
  so the redraw from the metadata-only versions lands in the SAME frame (without it every such resize presented one cleared frame; positive control of G-resize-ro). Prototype: resize converged in ~1-2 frames, 0 blank frames,
  0 tasks > 8.33 ms in the traced drag [E5 resize]; an earlier JavaScript-painter approach blanked the canvas for 108-136 ms after every resize.
- **Fractional DPR** (1.25/1.5, common on Windows): the border box is fractional while the surface is whole pixels (`ceil(border * s)`); default-size draws take the source rect from the SURFACE pixel size, so there is no resampling blur; tiles are rounded to whole surface pixels.
  Tiles need no snapping to whole DEVICE pixels of the page: native draws a drawable into the canvas grid, so its canvas does not depend on where the page puts the canvas (measured against Chrome Canary at DPR 1.25 and 1.5: 0.000 % between a fractional and a whole device-pixel origin), and neither does the polyfill's (G-pixel-dpr; polyfill vs native 0.1-0.6 % on F2/F4/F5). The plain-DOM oracle had shown > 3 % at DPR 1.25 only because its reference sat on half a device pixel (the page snaps text there and the screenshot clip resampled); it now moves the reference onto whole device pixels. An explicit draw size within 1 px and 1 % of the raster (`offsetWidth * devicePixelRatio` against a fractional border box) is drawn 1:1 instead of resampled (`snapDefaultSize`): F1 at DPR 1.25 went from 2.3 % to 1.6 % of native; the rest is `zoom:s` layout in the SVG image, which places glyphs slightly differently from native at 125/150 %.
- **DPR change** (page zoom, monitor move; `matchMedia('(resolution: Ndppx)')` + window resize): `BUS.DPR`; raster scale is recomputed from the grid; old surfaces keep being used until re-rastered (`dpr` damage, whole drawable).
- **Scroll.** Page scroll moves canvas and layer together natively; no re-snapshot is needed because a drawable's surface does not depend on its page position. Scrolling INSIDE the drawable (a `overflow:auto`
  element): native on the live element (wheel, keyboard, touch, scrollbar drag, focus reveal, sticky, anchoring all native); a capture-phase `scroll` listener publishes `scroll` damage on the scroller's box;
  the clone mirrors `scrollTop/Left` (state sync). Strip-translate scrolling (S-b) failed the pixel oracle at 26-28 % and is discarded [E5]. Eligible scrollers are shown in the scroll step's own rendering update by the scroll compositor (cached pages of the scrollport rendered at other offsets + pinned sticky tiles, exact tile after the scrolling stops). Prototype: pixel-exact incl. sticky header, p50 18 ms lag [E5 scroll].
  Large lists are pruned to the visible window (node budget).
- **Scrollbars.** Overlay scrollbars (macOS default): no gutter in the live DOM, hidden in the clone (`scrollbar-width:none`), nothing to paint. Classic scrollbars: the gutter is kept in the clone so layout is exact and the polyfill
  PAINTS an approximation of track and thumb (a scroll-position-dependent overlay, colours from `color-scheme`), feature row `classic-scrollbars`; the prototype ran with scrollbars hidden and measured 3-4 % difference on classic ones [E5];
  gate G-pixel-f5 requires <= 4 %.

### ADR-F: geometry and hit testing

**Goal.** After `updateElementGeometry(el, {canvasTransform: M})` or an auto-update by `drawElementImage`, a trusted click on the pixels drawn for `el` must hit `el` natively, and `elementsFromPoint` must list drawn elements most-recent first [WPT `hit-test/*`].
**Math.** `M = S^-1 * T_draw`: the canvas transform maps the border box (origin at its top-left corner) to the canvas css px and has NO transform-origin term (WPT `get-element-transform`; the older formula conjugated it by the transform-origin translation `T_tr`). The geometry rule therefore pins `transform-origin: 0 0`, so the CSS `transform: translate(-e) matrix(M)` yields exactly `D = M`. WPT confirms the placement is ABSOLUTE in the canvas, not relative to the layout position: after `updateElementGeometry(b)` an element laid out at y=100 is hit at (60,60).
**Mechanism (`live/geometry-apply.js`, `geometry-sheet.js`).** For a drawn drawable `E` with computed `transform: none` and an ancestor path (E up to the layer) that is translation-only and non-clipping:
`e` = border-box offset of E in the layer's content box without E's own transform. `e` is NOT measured in `drawElementImage`: the capture already reads layout, so it stores `layoutOffset` on every `SnapshotVersion` and `applyGeometry` reads it from the newest version (re-measured by `revalidateGeometry`, which the resize observer calls on every canvas resize and the mutation observer calls for a mutation batch that can move a drawable; a sticky or fixed drawable moves inside the layer when the page or a scroller around the canvas scrolls: while one has applied geometry, a passive capture `scroll` listener on the window re-measures only those drawables in each scroll event of such a scroll, and their measured offset wins over the cached one; no listener exists otherwise, G-regress-pagescroll).
The CSS written is `[data-hic-hit="key"]{transform: translate(-e.x px, -e.y px) matrix(M) !important}` or `matrix3d(M)` for a 3D matrix (the perspective row is kept; `transform-origin: 0 0` is part of the rule; the rule is flushed synchronously), as ONE rule per drawn element in the polyfill-owned adopted sheet of the canvas's root; updating it is `rule.style.setProperty`.
NOTHING is written to the author's `style` attribute (no `cssText` pollution, no fight with legacy `el.style.transform`, no CSP `style-src` issue) and the only attribute written is `data-hic-hit="key"`, which the observers filter, so there is no feedback loop:
a draw per frame of N elements does N no-ops (matrix, clip and rank unchanged) and, when something changed, one batched flush per task [gate G-idle variant: draw one element every paint for 3 s, builds and commits stop after the first].
The layer stylesheet has `hic-layer [data-hic-hit]{pointer-events:auto}` (an author's inline `pointer-events:none` still wins, WPT `pointerEventsNone`); everything else inherits `none` from the layer, so non-drawn drawables are not hit-testable,
as the spec requires [WPT `elementsFromPoint-no-content-drawable`]. A null transform inside the drawn list = identity D. `clip` (canvas clip) is applied as `clip-path: inset()` in the same rule when it differs from the border box and the author has no `clip-path`.
Z-order: `setHitTestOrder(order)` gives the drawn elements `z-index = rank` in their rule (`position:relative` only on drawables, which are already containing blocks), so `elementsFromPoint` returns most-recently-drawn first.
**Nested drawables.** A parent drawn with `translate(-e) matrix(M)` carries that transform into nested children, so a nested drawable drawn elsewhere would be hit at the parent's offset plus its own layout offset. All those transforms are polyfill-written, hence known: the child correction is `P^-1 * D_child` with `P` = the composed applied transforms of its drawable ancestors,
and a parent's `clip-path` is not applied to hit testing while it has geometry-applied nested drawables (reported once, `nested-geometry`). Gate: the nested-sparkles trusted click.
**Limits (explicit, reported once).** A drawable whose own CSS transform is not `none` (deviation `css-transform-on-drawable`: spec order cannot be reproduced without owning the property) or below a transformed/clipping ancestor
(`nested-geometry`): geometry is not applied (hit testing follows the live layout position); `getElementTransform` still returns the stored matrix.
**a11y.** Real geometry always (deviation `a11y-geometry`).
**Effects.** The effect host owns the source's geometry: it sets the fill transform (source border box -> presented rect) through `GeometryApi`, so live elements sit under the presented pixels; the displacement of an effect is handled by the interposer (ADR-G), not by geometry.
3D: `matrix3d` with a perspective w component, backface and behind-the-camera behaviour are NOT covered by [probe2] (its 9 cases are 2D); G-geometry-hit adds them with their own controls.
Pre-validated in real Chrome [probe2]: for three drawables laid out at y=0/100/200 and the canvas transforms translate, scale(1.5,2) and rotate(25deg), the live element's bounding box equals the box of `D(border box)` with max error 0.000 px, `elementFromPoint` at the drawn centre and at an inner point hits the element in 9/9 cases, an element without `data-hic-hit` falls through to the canvas, and `clip-path: inset()` removes the clipped half from hit testing (kept half hits the element, dropped half hits the canvas). The full gate is G-geometry-hit (trusted clicks, with a positive control).

### ADR-G: effect host, plugin ABI v2, FPS cap, input interposer

- **Host** (`effects/effect-host.js`, `gpu-presenter.js`): `createHost(canvas, source, options)` acquires adapter/device once per host, `canvas.getContext('webgpu')`, a source texture (`rgba8unorm`, sized like the surface at presentation scale) and a
  destination (the canvas texture or an intermediate for multi-plugin chains). Per due frame: `SourceProvider.upload()` only if the source version advanced (partial: the dirty rect of the committed tile -> `copyExternalImageToTexture` of the
  2D surface sub-rect, as the prototype did [E5]), then each enabled plugin renders into the encoder (`render(frame)`), one submit. Chain of N plugins uses ping-pong textures; a plugin with `outputCapabilities.directCanvasRenderAttachment` and
  being last renders straight into the canvas view. The host runs as a `FrameHook` (after the commit of the same tick), so the effect always samples the newest committed source, and `continuous` plugins keep the tick alive at the frame cap.
- **Why polyfill and native share it:** the host reads pixels through a `SourceProvider`: `store` (polyfill: `rasterSource` of the newest version, cheap partial uploads) or `native` (public API: `queue.drawElementImageToTexture`, `captureElementImage`,
  `paint` events as version signal). Plugins never see the difference.
- **Plugin ABI v2** (`plugin-abi.js`): types in `contracts/types.js`; any other `apiVersion` is refused (API-CONTRACT 7.2). Plugin errors in `create`/`render` are caught per plugin: `effecterror` event + `report().errors`, the plugin is disabled, the last presented frame stays (never blank).
- **FPS cap**: the host does not own timers. Its hook receives `due`; it renders only when `due` (and always at least once after a source change when due). So the cap bounds effect frames, paint events and builds with the same gate (ADR-C).
- **Input interposer** (`interposer.js` + `input-mapper.js`): capture listeners on the layer (`pointermove/down/up/click`, `wheel` untouched). The mapper chain composes `captureInputMapper(frame)` results of the spatial plugins of the frames actually presented
  (ring of the last 3), frozen per gesture with `captureGestureSnapshot`. The mapped point is in canvas space; since the source geometry sits under the presented pixels (ADR-F), the intended element is `layer.elementAtPoint(mapped)`.
  Re-targeting rules and limits in API-CONTRACT 7.4 (prototype: pointerdown whose native target control differs from the mapped control is swallowed and the activation re-implemented [E5 prototype]). With an effect on, native hover, `:active` and cursor follow the NATIVE pointer (the displaced control), so
  `InteractionTracker.setMappedTarget` makes hover/active follow `layer.elementAtPoint(mapped)` and the layer cursor follows its computed cursor; range drag updates on every pointermove of the gesture; touch is re-implemented from the mapped target (implicit capture stays on the natively hit element). Verified in Chrome 154 for the design: `preventDefault` on pointerdown suppresses mousedown, focus and caret placement on the natively hit element,
  but `click` still fires and a checkbox still toggles, so the click swallow is required and a mousedown handler never sees the gesture.
  VALIDATION AGAINST THE REAL DISPLACEMENT (not only against its own mapper): gate G-interposer-gpu renders a known marker in the source, reads the presented frame from the GPU (screenshot), finds where the control's pixels really are, clicks there with a trusted
  event and asserts the intended control activated; positive control: interposer off -> a measurable fraction of those clicks hits the wrong control.
- **Device loss.** The host handles `GPUDevice.lost`: it keeps presenting the last frame, recreates the device, the source/destination textures and the pipelines (each plugin is re-`create`d with its options) and reports once (gate G-device-lost, non-blank within 3 frames after recovery).
- **Example plugins** live outside `src/`, in `plugins/<name>/` (`plugins/README.md`): the water plugin (`plugins/water/`) is the prototype's water effect + `water.wgsl`, unchanged shader, `spatial:true`, `continuous:true`, mapper state per presented frame. The build discovers plugin folders by convention and inlines their WGSL.

### ADR-H: WebGL / WebGPU texture variants, OffscreenCanvas, workers

- WebGL and WebGPU variants are thin adapters over `SnapshotStore.rasterSource` + one GPU copy (API-CONTRACT 5.3/5.4); the only sink that works for an SVG-image-derived pixel is a 2D canvas source [E4: `copyExternalImageToTexture(img)`, `createImageBitmap(img)` throw `SecurityError` on
  Chrome; 2D canvas intermediate works on Chrome, Firefox and Safari-with-data:]. No zero-copy is available to userland. Each call costs a GPU upload of the requested rect; callers should call it from `paint` (once per change), not every frame.
- Texture variants never update geometry automatically (spec). `ElementImage` is accepted anywhere an `Element` is. `texElementSubImage2D` / `texElementImage2D` are installed on BOTH `WebGLRenderingContext` and `WebGL2RenderingContext` prototypes (three.js, regl-style engines and the WICG demos use WebGL2).
  The upload rect is `config.width/height` or the natural size, the ceiling of `getElementImageDefaultSize` (issue 174's preallocation advice); whenever the surface pixel size of the source rect differs from it (canvas grid scale < 1, above `maxDpr`, fractional) a scratch 2D canvas resamples (cached per version id); missing/too-small storage is a GL error as native. Pure rules in `api/texture-math.js` (G-webgl-gpu-variants: gridScale 0.5/1/2/3 x webgl/webgl2 x flipY/premultiply).
- Main-thread OffscreenCanvas: `drawElementImage` on its 2D context works through the placeholder link. Workers: no polyfill, no foreignObject rasterisation in any browser [E4 worker row]; `ElementImage` is not transferable; `toImageBitmap()` is the supported hand-off, and a `postMessage` guard (`api/worker-guard.js`) turns the README's worker example into an actionable `HicUnsupportedError('worker-element-image')` instead of a generic DataCloneError.

### ADR-I: privacy, security, refusals, error model

- Read-back-allowed rendering [spec]: the clone contains only author DOM and same-origin / CORS-approved resources inlined as `data:`; cross-origin images/CSS/fonts without CORS are refused (placeholder + entry), tainted `<canvas>` children refused, iframes/objects refused,
  `<video>` is poster/current frame only without controls or captions, `:visited` rules dropped, spellcheck/autofill UI and IME UI are never part of the clone, system colors resolve in the clone to defaults (no machine-specific leak beyond what `matchMedia` already exposes),
  text is greyscale-antialiased (SVG image). The retained surface is origin-clean because every input is.
- The polyfill needs no privileged API; it reads only the live DOM and fetches resources the page could fetch itself.
- CSP: snapshots are `data:image/svg+xml` images, so a CSP without `img-src data:` fails every decode. The polyfill listens to `securitypolicyviolation`, reports `csp-blocked` with a hint, keeps its sheets in `adoptedStyleSheets` (no `<style>` element, so `style-src` without 'unsafe-inline' is fine) and reports a blocked `onpaint=` attribute (CSP / Trusted Types) instead of ignoring it.
- Error model: native types for spec errors (API-CONTRACT 6), `HicUnsupportedError` (section ADR-J) for polyfill limits, `Reporter.caught` for internal faults (never silent).

### ADR-J: what "loud failure" means

1. `class HicUnsupportedError extends DOMException` (`name 'NotSupportedError'`, `code 9`, `feature`, `hint`, `path`) thrown synchronously where a call cannot be honoured. [probe: a `DOMException` subclass keeps `name`, `code`, `instanceof`.]
2. Unsupported CONTENT inside a drawable: placeholder box (hatched, `data-hic-node`) in the clone + `Reporter.unsupported`: `console.error` once per `(feature, path)` (`util/once-log.js`), CustomEvent `hicunsupported` on the canvas, entry in `installed.report().unsupported` with a `count`.
3. `installed.report()`: the JSON-able `HicReport`; also `window.__HIC__.report()`.
4. Internal errors: `Reporter.caught(err, where)` -> `report().errors` + `console.error` once; a failed build keeps the previous version (no blank), the next damage retries.
5. Never: silent stall, silent blank, swallowed exception, a "supported" claim in the report for something refused.
6. Auto-install (IIFE, ADR-N) turns a REFUSAL into one `console.warn` + `window.__HIC__.error` so that unconditional inclusion does not throw on every page load of Firefox/Safari visitors; real bugs still `console.error` and throw; an explicit `install()` throws.

### ADR-K: tree scopes (canvases in shadow roots)

The spec iterates shadow-including descendants and flat-tree eligibility; web components are the usual packaging of a canvas widget. Anchor names and adopted stylesheets are tree-scoped: a document sheet does not style a layer inside an open root (measured: a `position:static`, in-flow, 1000x0 layer) while the same CSS inside the root positions it exactly (30/30).
- `live/root-scope.js` (`RootScope`): patches `Element.prototype.attachShadow` through the ledger (the returned root is recorded even when closed, as long as it is created after install), walks existing open roots once, emits `BUS.ROOT_ADDED`, and hands out one reference-counted `LayerStyleHandle` per root (layer sheet, anchor rules, geometry rules).
- The registry observes every scope, `CanvasRecord.root` is the canvas's scope (moves between scopes swap the style handle), the layer lives in the same root as its canvas, `env.roots.rootOf(node)` resolves scopes for the observers and the stylesheet observer; the CSS collector adds the root's own sheets and maps `:host` to the canvas shell.
- A canvas in a closed root created BEFORE install cannot be seen: it is refused with `shadow-canvas` and the hint `installed.adoptRoot(root)`. Document-level selectors and the selector bridge do not cross the boundary (limit). Shadow DOM INSIDE a drawable (open roots) is captured in flat-tree order with computed styles inlined, and its mutations are observed (`shadow-dom` limited). Gate G-shadow-canvas (positive control: document-only styling gives a mispositioned layer).

### ADR-L: containing block, clipping, stacking and the top layer

The layer is `position:absolute` (or fixed) anchored to the canvas, so its containing block is NOT the canvas's DOM chain. Reviewer B measured four consequences in Chrome 154; the polyfill answers each.
1. **Fixed canvas.** The layer mirrors `position:fixed` from the canvas or a fixed ancestor (a fixed layer stayed glued 70/70/70 where the absolute layer drifted to -430 px / -1130 px). Sticky canvases are fine (measured).
2. **Clipping or scrolling ancestors.** A non-positioned `overflow:auto` ancestor clips the canvas but not the layer: elementFromPoint above the scroller returned the drawable, and focusing a layer input below the visible area did not scroll the scroller. `live/ancestor-clip.js` keeps `clip-path: inset()` on the layer equal to the canvas content box
   intersected with the visible rects of those ancestors (ResizeObserver + capture-phase `scroll` on the chain), adds `position-visibility: anchors-visible`, and on `focusin` scrolls the canvas's own scrollers with `nearest` semantics (`live/ancestor-clip.js` `reveal`). It never sets `position` on author elements (that would change the containing block of their absolutely positioned descendants).
   The clip follows scrolling one frame late. A case that cannot be covered is reported once as `layer-containing-block`. Gate G-layer-ancestors (fixed, sticky, static and relative scrollers, transformed, fixed ancestor, inline canvas; positive control = the measured failures).
3. **Stacking above a non-positioned canvas.** The positioned, opacity:0 layer paints at the z-index:0 positioned step, so a sticky header, float or earlier overlay that natively covers a non-positioned canvas is covered by the layer's drawn drawables (measured: elementFromPoint at the overlap returned the drawable). No exact fix exists.
   `live/stacking-audit.js` samples up to 5 points per drawn drawable with `elementsFromPoint` (no style mutation, never toggling the layer's display, which would blur a focused element): page elements positioned between the layer content and the canvas in the hit list are above the canvas natively and below the layer; they are reported once per (canvas, element) as `stacking-overlap`. Documented workaround: a positioned stacking context on the canvas. Gate G-stacking.
4. **Top layer.** `requestFullscreen()` puts only the canvas subtree in the top layer; the sibling layer is outside it and Chrome makes it inert. Decision : fullscreen proceeds and draws as natively; the input limit is reported once (`top-layer-canvas`, `api/fullscreen-guard.js`). The promotion experiment was measured and does not help: the promoted layer (`popover=manual` + `showPopover()`) is still inert. A canvas with `popover` stays refused at mount. A canvas inside a modal dialog is fine (the layer is a sibling in the same top-layer subtree). Top-layer content INSIDE a drawable (modal dialog, open popover, fullscreen element) is left out of the clone, as native leaves it out of the canvas; the live element shows in the page top layer.

### ADR-M: accessibility link

Natively the children of `<canvas role=list>` are its AX children (the spec's pie-chart example). Relocated to a sibling layer they would lose the list parent, the canvas's name and role no longer scope the content, and `aria-describedby`/landmarks are separated.
- The layer is `role=presentation`. The canvas `aria-owns` its TOP-LEVEL logical children (`live/a11y-link.js`): generated `hic-o-<id>-<n>` ids where missing, merged with the author's tokens, restored on unmount, own-write filtered from observers.
- [probe3] (real Chrome 154 AX tree, `role=list` canvas): `aria-owns=<layer id>` gives parentage list > ignored layer > children BUT the children resolve to role `generic` (no `listitem`); `aria-owns="a b"` (the children themselves) gives list > listitem x2 with their names; without any owns the listitems are orphans of the list. Hence the children, not the layer, are owned. Nested descendants keep their natural ancestors.
- Undrawn drawables expose layout-position geometry (deviation `a11y-geometry`): authors should `aria-hidden` unused views. Gate G-a11y asserts parentage, names, tab order, aria-hidden/inert and the aria-owns merge/restore on the pie-chart and figure examples (positive control: aria-owns removed fails).

### ADR-N: install policy, native gap-fill, guards

- **Auto-install** (IIFE) warns on refusal and never throws for it (ADR-J.6); `install()` throws `HicUnsupportedError('browser' | 'partial-native')`, the latter only for a native implementation without its core.
- **Native probe.** The decision rests on the CORE (`content` or `layoutSubtree`, `onpaint`, 2D `drawElementImage`, the last also exercised on a detached drawable). `complete` = the core plus every other current name; `partial` = the core plus some missing current name; `legacy` = the core with `layoutSubtree` (Chrome 154 and 155 with the flag); `broken` = a core name missing, the only kind that is refused. A usable kind is never refused: mode `native`, or `native-bridged` when the optional bridge is loaded and can build a missing name (`gaps`: the event names, `getElementImageDefaultSize` over `ElementImage.width/height`, the texture/WebGPU aliases over their legacy twins). Unit tests cover the measured current, previous and legacy shapes and every secondary name removed in turn.
- **Guards through the ledger:** fullscreen/popover canvases (ADR-L), `postMessage` of an `ElementImage` (ADR-H), synchronous mount hooks for `content`/`setAttribute` (ADR-C/§4.2). Content security policy: ADR-I.
- **Legacy `layoutsubtree` draws return the DOMMatrix** of the stored canvas transform.

## 6. Module boundaries

Seven modules on disjoint file sets that talk only through the typed interfaces of `src/contracts/`; `scripts/check-repo.mjs` (G-deps) enforces the boundaries and `npm run check` (tsc, checkJs) type-checks every module.

| module | dir | depends on (interfaces only) |
|---|---|---|
| api-core | `src/api/{install,options,compose,native-detect,native-bridge,canvas-registry,report,env,patch}.js`, `src/index.js`, `src/iife.js`, `src/native-bridge.js` | all factories (composition root) |
| api-surface | `src/api/{canvas-patch,context2d-patch,texture-patch,texture-math,offscreen-patch,element-image,paint-event,geometry,draw-math,validate,fullscreen-guard,worker-guard}.js` | `env.store`, `env.scheduler`, `record.layer`, `patch.js` |
| live | `src/live/*` (adds `root-scope`, `ancestor-clip`, `geometry-sheet`, `a11y-link`, `stacking-audit`) | contracts, util |
| snapshot-capture | `src/snapshot/capture/*` (adds `css-shake`, `shells`; `caret-overlay` now measures) | contracts, util |
| snapshot-store | `src/snapshot/store/*` (adds `caret-patch`; `decode` has the atomic commit, `surfaces` the loss watcher, `damage` the reclaim) | contracts, util, `CaptureFn` |
| schedule | `src/schedule/**` (adds `paint-gate`, `frame-phase`) | contracts, util, `SnapshotStore`, `LiveLayer` (via `record.layer`) |
| gpu-effects | `src/effects/**`, `src/effects.js`, `src/effects-iife.js` (the example plugins are in `plugins/`, outside the module graph) | contracts, util, `SourceProvider`, `GeometryApi`, `InteractionTracker`, `Scheduler.addFrameHook`, `LiveLayer.elementAtPoint` |

Shared leaves: `src/contracts/*` and `src/util/*`. A contract change (a new field, topic or option) edits `contracts/` and this document together.
Size budget: at most 1000 code lines per file, and a total ceiling for the core (gate G-size, `scripts/check-repo.mjs`).

## 7. Budgets and non-goals

Budgets (verified by trace, `RunTask` on `CrRendererMain`): no task > 16.7 ms in any interaction gate; > 8.33 ms tasks tolerated at <= 1 % of frames in typing/resize on F1. The cost of one tile is the SUM of its synchronous build, its decode (main-thread, not free: ADR-D.8) and its commit draw:
the pump caps the synchronous build part at <= 4 ms per pump (<= 8 ms at DPR 2 with > soft nodes) AND the EMA of the whole sum over all drawables at `mainThreadShare` (35 %) of the frame period. Measured ratios ([review-b]): RunTask per tile 4.2-9.4 ms against 0.1-0.9 ms for the build alone; the thresholds of G-throughput and G-typing are set only from a run without machine load above threshold (G-decode-main).
Bundle <= 150 KB minified for the core (target, gate G-bundle; NOT met, see docs/BUNDLES.md for the split into core / effects / plugins / native bridge and where the bytes are). Non-goals: 120 Hz source updates (the promise is a 120 Hz effect over 30-60 Hz source), CSS-breadth work for its own sake, WPT percentage.

## 8. Risks and open questions (not decided here)

- Resolved [probe2]: an `opacity:0` live input in a foreground window is focusable, `matches(':focus')` is true and trusted typing arrives (`abc`); the earlier `false` of [probe] came from a non-focused window.
- Focus of a live element positioned OUTSIDE the layer box (`overflow:clip` layer) does not scroll the layer but DOES scroll the page to that element's position [probe2: scrollY 0 -> 576.5], exactly like plain DOM; accepted, not mitigated. Focus inside an inner scroller of a drawable scrolls that scroller.
- Hit-test-before-geometry differs across natives (E6: Chrome 154 needs `updateElementGeometry`; Canary 157 hits children as soon as `content=drawable`, before any geometry). The polyfill follows the spec/WPT (not hit-testable until drawn).
- Anchor positioning inside unusual containing blocks: fixed canvases, scrollers and sticky canvases were measured by a design review and are answered in ADR-L; `contain:paint` containing blocks, transformed scrollers inside shadow roots and `zoom` are still unprobed (G-layer-ancestors, G-shadow-canvas).
- The paint-phase mechanism rests on one probe in one browser version [probe3]: observer ordering is specified, but an unobservable sentinel (no layout in a frame) falls back to the rAF phase (`phaseFallbacks`); G-raf-order measures how often.
- The real-box shell placement of ADR-D.1, the generic inherited-property/custom-property copy and the `aria-owns` id generation on author elements are stated, not yet measured on real pages.
- Cross-origin sheets whose `cssRules` throw need a CORS refetch path whose coverage is unknown. The decode tail (p95 30-100 ms) is the known weakness; the mitigation (>= 2 builds in flight) is unproven, and decode main-thread cost was measured only under machine load above threshold.
- Memory: one full-canvas drawable at DPR 3 is 46.7 MB; many drawable surfaces risk the browser's accelerated 2D canvas limits (silent software fallback). `maxTotalSurfaceBytes` bounds it; the cliff is not measured.
- `rule.style` writes are observable only through the patched `CSSStyleDeclaration` methods; direct `CSSStyleDeclaration` named-property writes on rules are not.
- `CanvasPaintEvent`-order semantics across nested canvases are untested natively; the polyfill manages nested `content=drawable` canvases independently (ADR-A) and fires inner before outer in reverse tree order.

## 9. Measured constraints (prototype and native measurements behind the design)

All numbers: Chrome 154, M1 Max, 120 Hz, DPR 2 unless stated, every run with machine load above threshold (another browser was running; its effect was bounded within the data). Measured on the prototype that preceded this implementation or on the browser's native implementation, not on `src/`.

- **Native baseline (the budget to approach).** A native commit costs under 1 ms of main thread (slider drag 5 % busy, RunTask p95 0.74 ms, 0 tasks over 8.33 ms) and one frame (input to next frame start 8.1 ms; typing keydown to frame 11.8 ms p50, 15.5 ms p95); a real window drag produces 0 blank frames. A readback of the native surface (`getImageData`) turns the same drag into 20.6 ms `Commit` tasks: never time native with a readback probe.
- **Node budget (ADR-D).** Unmitigated full-surface commit = `2.6 + 5.8 x nodes/1000` ms (3.4 / 8.7 / 12.9 ms at 200 / 1000 / 2000 nodes, re-measured): 600 nodes comfortable, 1000 nodes the hard per-frame limit for first paint, resize, DPR change and structural damage. Size-preserving spacer pruning keeps localised damage at 1.8-2.8 ms flat from 200 to 2000 nodes.
- **Pipelining depth (ADR-D, ADR-G).** One snapshot in flight. Two in flight was not better (key-to-draw p95 74 vs 50 ms). Dense typing (8 ms) merges 10-18 of 25 keys into a later frame; every key is in the pixels eventually (75/75, 0 dropped) but intermediate states are not shown. Text inputs need the optimistic overlay (0.55 ms p50 / 2.5 ms p95 key to draw, 3.9 ms to the next frame). The decoded-image cache halves the median: latency gates must use a nonce. Caret blink costs 2.3 ms per commit (cap 60) / 4.2 ms (cap 120).
- **Page scroll and listeners (ADR-E, ADR-G).** With the live layer installed, scroll-update latency, janky frames and compositor fps are unchanged under a 4 ms/frame, a 12 ms/frame and a 60 ms-every-100 ms main-thread load (24.5 ms p50, 0 janky, 119.7 fps under the 60 ms stalls); page scroll does not wake the pipeline (the one exception: a passive window `scroll` listener re-measures sticky / fixed drawables while the page has one). The design has no `wheel`/`touch*` listener (CDP audit): keep it so, and if one is ever added it must be passive. A non-passive wheel listener is measurable only with discrete wheel events (2x median under a 60 ms stall), not with scroll gestures, so gate with the listener audit, not with timing.
- **Resize and zoom (ADR-E).** The retained surface is kept until the new tile commits: 0 blank frames in all drag and zoom runs (F3, F1; DPR 1 and 2; 50 and 8 ms cadence; 20 real zoom steps 75-400 %). Convergence is 1-3 frames (10-26 ms) after the last resize event. The committed layout lags the live layout during a drag (12-17 % of frames at 50 ms cadence, 66-100 % at 8 ms, up to 77 css px): anchor top-left and clip, never scale. The ResizeObserver callback must not run the clone (3 ms F3, 6-11 ms F1, the only over-budget tasks): defer to the pump. Pixels vs plain DOM after a drag: F3 0 %, F1 1.2-1.4 %; zoom F3 <= 1.4 %, F1 <= 2.0 % (gate 3 %); the plain-DOM reference must hide scrollbars like the prototype.
- **Stacking audit and ancestor clip (ADR-L).** The audit as specified detects a `z-index:auto` sticky header over a non-positioned canvas only when a sample lands in the overlap: 5 samples (centre + 10 % corners) missed a 30 px overlap of a 300 px canvas. Sample a 3 x 3 grid plus the boundary points of intersecting sticky/fixed/positioned elements. It cannot see the unclipped-scroller case (the canvas is absent from `elementsFromPoint`): add a "canvas missing" finding. `ancestor-clip` must compute the `clip-path` inset from the canvas rect (the layer's own rect misses the anchor scroll compensation and breaks after the scroller scrolls). A positioned stacking context on the canvas fixes the sticky-header case when the header precedes the canvas in the DOM. Chrome 154's native hit test is not the oracle (it hits the drawn child above a `z-index:auto` sticky header); use a plain canvas.
