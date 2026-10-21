# API contract

What this polyfill implements of the WICG / WHATWG *HTML-in-Canvas* API, how each part behaves (timing, exceptions), what is
out of scope and how it fails, and the two extensions (frame cap, effect plugins).

Sources: the WICG explainer (https://github.com/WICG/html-in-canvas), the Chromium IDL, the HTML Standard pull request
(whatwg/html#11588) and the WPT tests, re-checked on 2026-10-14 against explainer commit `8aaaf5d6` (2026-10-09), pull request head `4cfec766`
(2026-10-08, "Replace ElementImage width/height with getElementImageDefaultSize()"), Chromium `main` (`html_canvas_element.idl`; the runtime
feature `CanvasDrawElement` has status `stable`) and WPT `master`. Spec status: an explainer plus a draft in the HTML Standard PR; Chrome
ran an origin trial in 148-150, the `content=drawable` rename landed 2026-09 (WICG issues 174, 179), and Chrome Canary 157.0.8103.0 exposes
the API without any flag (measured 2026-10-14). The API still changes week to week, so the polyfill decides on the core behaviour and never on
a secondary member (section 2); section 2.2 lists the changes after the pinned WPT revision.

Conventions: "grid px" = canvas bitmap pixels (`canvas.width/height`); "css px" = layout pixels. The names of the typedefs
(`CanvasRecord`, `SnapshotVersion`, ...) are in `src/contracts/types.js`. Feature ids (`tree-identity`, ...) are the rows of
`src/contracts/features.js` and `docs/SUPPORT-MATRIX.md`. The public API is what this document describes, reached through the entry
points of `package.json` `exports` (`docs/BUNDLES.md`); the modules under `src/` are internal and may change in any release.

## 1. Scope

| Implemented (supported or limited) | Not implemented (fails loudly, section 9) |
|---|---|
| `content` attribute + IDL property; `drawable` attribute; legacy `layoutsubtree` / `layoutSubtree` | Firefox < 155, Safari < 27 (desktop) or < 26 (iOS), other engines, web views, Firefox for Android, an engine lacking a required platform feature |
| `paint` event, `CanvasPaintEvent.changedElements`, `onpaint`, `requestPaint()` | cross-origin frames and objects (drawn as their own box, as natively), top layer inside a drawable; `requestFullscreen()`/`popover` on a managed canvas; SVG `drawable`; a CSP without `img-src data:` |
| `ctx.drawElementImage` (all 4 overloads) on `CanvasRenderingContext2D` and main-thread `OffscreenCanvasRenderingContext2D` | cross-origin resources that cannot be inlined (section 9.2) |
| `canvas.captureElementImage`, `ElementImage` (`close()`), `getElementImageDefaultSize` on the canvas and on its OffscreenCanvas; an `ElementImage` posted to a dedicated Worker that loads the worker bundle (section 5.2) | an `ElementImage` through a MessagePort, a BroadcastChannel or to a ServiceWorker (use `toImageBitmap()`) |
| `updateElementGeometry`, `clearElementGeometry`, `getElementTransform`, `elementgeometryupdate`, `ElementGeometryUpdateEvent` | a managed canvas in a closed shadow root created before install (`adoptRoot` hook) |
| WebGL and WebGL2 `texElementSubImage2D` (+ legacy `texElementImage2D`); WebGPU `GPUQueue.drawElementImageToTexture` (+ legacy `copyElementImageToTexture`) | zero-copy texture paths |
| canvases in open shadow roots (limited), nested `<canvas content=drawable>` managed independently (limited) | |
| Extensions of this library, not of the standard (section 7): `framecap` / `frameCap`; `HTMLInCanvasEffects` (effect host, plugin ABI v2, input remap); example plugins in `plugins/` | any other CSS/DOM breadth work for its own sake |

Interfaces defined by the polyfill only when the platform lacks them: `window.ElementImage`, `window.CanvasPaintEvent`,
`window.ElementGeometryUpdateEvent`. They are ordinary classes (`instanceof` works; `Symbol.toStringTag` set); they are NOT
`Transferable` (structured clone of an `ElementImage` throws `DataCloneError`, loud by construction).

## 2. Feature detection and the native-first policy

`install(options?)` is synchronous and idempotent per window (a second call returns the first `HicInstalled`).

**Behavioural probe (`api/native-detect.js`, pure, no side effects, never trusts `in` alone).** The decision rests on the CORE only:
`content` reflecting only `fallback|drawable` (exercised on a detached canvas) or the legacy `layoutSubtree`, the `onpaint` handler, and
`CanvasRenderingContext2D.prototype.drawElementImage`. The probe also calls that `drawElementImage` on a detached `content=drawable` canvas: a
platform method converts its argument (a plain object is a `TypeError`) and refuses a drawable of a canvas that was never rendered
(`InvalidStateError`), as Canary 157 does; the outcome is `NativeState.probe` (`ok`, `inert` for a stub that returns, `unexpected`) and
`NativeState.verified`. Every other name of the current specification (`requestPaint`, `captureElementImage`, `getElementTransform`,
`updateElementGeometry`, `clearElementGeometry`, `getElementImageDefaultSize`, `onelementgeometryupdate`, the OffscreenCanvas methods and
Offscreen 2D `drawElementImage`, `ElementImage` with `close()`, `ElementGeometryUpdateEvent`, the WebGL and WebGPU names) is recorded in
`NativeState.missing` when absent, and names of earlier drafts (`layoutSubtree`, `ElementImage.width`, `texElementImage2D`,
`copyElementImageToTexture`) in `NativeState.legacyNames`. `CanvasPaintEvent` is not probed (the `onpaint` IDL attribute and the event are one feature).

**Policy: a usable native implementation is never refused and never replaced.** A missing, renamed or extra secondary member never makes
`install()` throw: the polyfill steps aside, leaves the standard surface untouched and records why (`report().native`, and
`report().deviations` id `native-step-aside`). Only a native implementation whose core is missing is refused, because it can neither run the API
nor be replaced safely. A failed behavioural probe alone is not a refusal either: in doubt the polyfill steps aside and reports it.

| kind | meaning | `HicMode` | what install does |
|---|---|---|---|
| `complete` | the core plus every other current name (Canary 157.0.8103.0, with or without the flag) | `native` | patches NOTHING of the standard surface. The extensions are not supported in this mode (section 7.6): no `frameCap` property, no input remapping. |
| `partial` | the core works, some other current name is missing (for example the 2026-10-07 shape with `ElementImage.width/height` and no `getElementImageDefaultSize`) | `native`, or `native-bridged` when the bridge is loaded and can build a missing name (`NativeState.fillable`) | uses the native implementation as found; with the bridge, adds only the names it can build from public native API (`gaps`). Never throws. |
| `legacy` | the core with the earlier `layoutSubtree` instead of `content` (Chrome 154 and 155.0.8059.40 behind `--enable-blink-features=CanvasDrawElement`, measured) | `native-bridged` with the bridge, else `native` | with the bridge: `content` IDL + attribute mirroring to `layoutsubtree`, method aliases, `getElementImageDefaultSize` over `ElementImage.width/height` (section 2.1; row `legacy-native-bridge`). Without it: used as found, one `console.warn` that `content="drawable"` canvases are not drawable in that build and how to load the bridge. Never throws. |
| `broken` | something native exists but a core name is missing | `refused` | throws `HicUnsupportedError('partial-native')` unless `options.forcePolyfill` (test only). |
| `absent` | no names | `polyfill` | full polyfill (browser gate below). |

### 2.1 What the native bridge translates (modes `native-bridged`)
The bridge is the OPTIONAL bundle `dist/hic-live-native-bridge.iife.js` (ESM: `import '@giuseppe-scotto-lavina/html-in-canvas-polyfill/native-bridge'`), loaded BEFORE the core installs. Without it a `legacy` or `partial, fillable` native is used as found (mode `native`; the `native-step-aside` entry of `report().deviations` names the bundle).
| area | legacy native (Chrome 154 flag) | bridge |
|---|---|---|
| markup | `layoutsubtree` attribute / `layoutSubtree` IDL, no `content` | `content` IDL + attribute mirrored to `layoutsubtree`; only DIRECT children can be drawn natively, so drawing a non-direct descendant is reported loudly (no silent no-op) |
| `drawElementImage` | returns a `DOMMatrix` | the standard returns undefined: callers of the legacy `layoutsubtree` pattern keep the matrix (returned for canvases activated by `layoutsubtree`), standard callers get undefined |
| geometry | no automatic geometry update: an app written for the new API gets non-hit-testable, geometry-less children | the bridge calls `updateElementGeometry` after a draw unless `preserveElementGeometry` |
| WebGPU | `copyElementImageToTexture({source, sx, sy, swidth, sheight}, {destination:{texture}, width, height})` | `drawElementImageToTexture({source, sourceX, sourceY, sourceWidth, sourceHeight}, {texture, size, origin, ...})` mapped both ways |
| WebGL | `texElementImage2D` only | `texElementSubImage2D` added on WebGL and WebGL2 with the natural-size rule of 5.3 |
| events | no `onelementgeometryupdate` (Chrome 154) | `ElementGeometryUpdateEvent` + handler added |
| size | `ElementImage.width/height`, no `getElementImageDefaultSize` | `HTMLCanvasElement.prototype.getElementImageDefaultSize(element \| ElementImage)` built over them (a capture for an Element), so it returns that build's own numbers: Chrome 155.0.8059.40 reports device pixels, not grid px (400 x 120 for a 200 x 60 css element at DPR 2 on a canvas whose grid equals its css size, measured 2026-10-14); the originating canvas of an `ElementImage` is not checked; the OffscreenCanvas one is not added |
| `{preserveElementGeometry}` | ignored by legacy native | honoured by skipping the automatic update |
Gate G-bridged-translation runs these rows on Chrome 154 with the flag; the unit tests run them on fake native shapes (`test/unit/api-core/_page-env.mjs`: the measured current, previous and legacy shapes, and the shape of Safari Technology Preview 254 with its HTML-in-Canvas flag, read from its binary).
A legacy build without the geometry methods (Safari Technology Preview 254 with Debug > WebKit Internal Features > HTML-in-Canvas, measured live 2026-10-16) is bridged all the same: only the methods that exist are wrapped. That build fires `paint` only from `requestPaint()`, draws an element as the previous rendering update painted it, returns an identity matrix from every draw and draws nothing for a child with a css transform, and draws a sizeless element at css px as grid px. So on that shape the bridge requests the paints itself (`src/api/native-paint.js`: when a canvas becomes drawable and after every change inside it, one rendering update after the update that rendered the change; a grid resize at once), gives `drawElementImage(element, dx, dy)` the standard destination size (the border box times the canvas grid scale), and writes no transform rule: hit testing stays at the layout boxes (`docs/SUPPORT-MATRIX.md`).
In every native mode `install()` also completes the ResizeObserver `device-pixel-content-box` where the engine lacks it, as in mode `polyfill` (feature-detected, nothing is patched on Chromium): the explainer's own sizing line threw on that WebKit build.

Browser gate (only evaluated for `absent`/`forcePolyfill`): Chromium >= 130 on desktop and Chrome for Android (only 154 and Canary 157 measured on desktop; Android: Chromium 158 on
the Android Emulator, with the polyfill forced over its native API), Firefox >= 155 or Safari >= 27 on desktop (the measured majors, G-xbrowser), Safari >= 26 on iOS / iPadOS (iPadOS detected from a `Macintosh` agent with
more than one touch point; G-mobile on the iOS Simulator) and the other iOS browsers (WebKit, no version in their agent: decided by the features), AND every required platform
feature present (CSS anchor positioning, ResizeObserver, `HTMLImageElement.decode`, constructable stylesheets; a missing one is named in the message). Android WebView, in-app
iOS web views (no `Safari/` token) and Firefox for Android are refused with that reason (`docs/guides/MOBILE.md`). Anything else: `install()` throws
`HicUnsupportedError('browser')` (default `onUnsupportedBrowser: 'throw'`); `'warn'` logs once and installs nothing.
`options.mode`: `'auto'` (default) as above; `'native-only'` never runs the renderer (throws where `auto` would run the polyfill or refuse);
`'polyfill'` runs the polyfill when native is `absent`; over a usable native it steps aside like `auto`, with one `console.warn` and a
`native-step-aside` report entry (a usable native is never overridden; `forcePolyfill` is the single override and exists for tests).

Patch hygiene: every installed function/descriptor carries `Symbol.for('hic.patch')` (`MARK.PATCH_SYMBOL`). `uninstall()` restores
the exact original descriptor. If a foreign script wrapped one of our patches after us, uninstall leaves that property alone and
reports it (`report().errors`). The install is transactional: a step that throws undoes everything before it (observers, intervals, listeners, patches). `uninstall()` also removes the `paint` / `elementgeometryupdate` listeners and forgets `onpaint` handlers, hands the children back in order and keeps the focused element focused; scroll offsets of managed content cannot survive (once back in the canvas the children are fallback content without a layout box, where `scrollTop` is 0). A repeated `install(options)` returns the first install but still validates `options`. Numeric options `defaultFrameCap`, `maxSurfacePixels`, `maxTotalSurfaceBytes` must be integers; option names are checked as own properties. **Reinstall** (`uninstall()` then `install()`): the new install manages the canvases again and every canvas with `content="drawable"` (or `layoutsubtree`) in the document gets its first `paint` on its own, exactly as at a first install (`test/unit/api-core/reinstall.browser.test.mjs`); `onpaint` / `onelementgeometryupdate` handlers assigned through the property before the uninstall are forgotten and must be assigned again, while listeners added with `addEventListener` stay and fire for the new install. `window.__HIC__.installed` (classic script) is a getter that returns `getInstalled()`, so it names the live install after a reinstall; a handle kept from before the uninstall is dead.

Bundle contract (docs/BUNDLES.md has the file list, sizes and load order): the classic core IIFE (`dist/hic-live-polyfill.iife.js`, the 2D path; `.min.js` twin) exposes `window.HicLivePolyfill = {install, version, FEATURES,
HicUnsupportedError}` and auto-installs synchronously when it executes, unless its `<script>` has `data-hic-manual`. It must be
loaded before app scripts that read the API. AUTO-install policy: a refusal (`HicUnsupportedError`: an unsupported or too old browser, a missing required platform feature, a native implementation without its core) is ONE `console.warn` and `window.__HIC__ = {error}`, never a throw (a site that includes the script
unconditionally keeps working for every visitor; a usable native implementation is never a refusal at all, with or without the optional native-bridge bundle); any other error is a polyfill bug: `console.error`, `window.__HIC__ = {error}`, rethrown. An explicit `install()` call throws on refusal. Pages whose CSP forbids `img-src data:` get a `csp-blocked` report with a hint
(every snapshot is a data: SVG image); `onpaint="..."` attributes need `new Function`, a CSP/Trusted Types block of it is reported.

### 2.2 Specification changes after the pinned WPT revision (2026-10-07) and what the polyfill does
| change (source) | polyfill |
|---|---|
| `ElementImage.width/height` removed; `getElementImageDefaultSize(element \| ElementImage)` on `HTMLCanvasElement` and `OffscreenCanvas` returns `{width, height}` in grid px of the CURRENT bitmap (WHATWG PR `4cfec766`, 2026-10-08; WPT `dcdb8e11`, 2026-10-09; explainer PR #184) | follows it: `ElementImage` has `close()` only (plus the `toImageBitmap()` extension); both `getElementImageDefaultSize` methods exist. No deprecated `width`/`height` alias: the current WPT asserts `'width' in elementImage` is false, and an alias would let code pass on the polyfill and fail on native Chrome. The WPT expects `InvalidStateError` for a closed image, another canvas and a standalone OffscreenCanvas where the PR text says `TypeError`; the polyfill follows the WPT (section 6.3). |
| the two-argument `getElementTransform(element, drawTransform)` and `OffscreenCanvas.getElementTransform` removed; the one-argument form stays (WPT `b59184b6`, 2026-10-09) | the one-argument form is unchanged; the two-argument form and the OffscreenCanvas method are KEPT as deprecated legacy overloads until the WPT pin moves (they cost nothing to code written for the current API, which never passes a second argument) |
| non-finite source or destination rects: draw nothing and return (WPT `30d4d7d4`, 2026-10-07) | already the behaviour (`draw-math.js` returns before drawing or updating geometry) |
| `opacity: 0` on the canvas or an ancestor does not hide the drawn content (WPT `beed7c13`); popover privacy, filters invalidated when content moves into a canvas, backdrop-filter with mix-blend-mode (WPT `136493f8`, `a7242745`, `e723d22a`) | rendering fixes of the native implementation; measured against WPT master in `docs/CONFORMANCE.md` |

## 3. Markup

- `content` (canvas): enumerated `fallback` (default, missing, invalid) | `drawable`. IDL attribute `canvas.content` reflects only
  those two values (`ReflectOnly`). Setting it is a CEReaction in spirit: the registry observes the attribute and mounts / unmounts
  (ARCHITECTURE section 4). Removing it or setting `fallback` returns the children to the canvas and clears every snapshot
  (spec "reset drawable element state").
- `drawable` (any element): boolean attribute. Required on every element that will be drawn. There is no IDL property (matches
  Chromium; none exists in 154, measured). Implies `isolation: isolate !important` and being a containing block for all
  descendants: the polyfill's stylesheet sets `[drawable]{isolation:isolate !important; contain:layout}` (deviation `contain-layout`).
- Tree scopes: a canvas inside an OPEN shadow root (and a closed one created after install) is managed like a document canvas, with its layer and styles in the same root (row `shadow-canvas`); a closed root created before install is refused unless `installed.adoptRoot(root)` is called. A `content=drawable` canvas inside another managed canvas is managed independently (row `nested-canvas`).
- A managed canvas may be `requestFullscreen()`-ed: it draws as natively, but its drawn controls take no input while it is fullscreen (the live layer is outside the fullscreen subtree, which Chrome makes inert); this limit is reported once (`top-layer-canvas`, `docs/ARCHITECTURE.md` ADR-L). Fullscreen an ancestor container to keep input. A canvas with a `popover` attribute is refused at mount.
- **Eligible for drawing onto canvas C**: `el` has the `drawable` attribute AND its nearest canvas ancestor in the LOGICAL tree is `C`
  AND `C.content === 'drawable'` (a descendant, not only a child: WICG issue 134). A drawable inside a drawable is nested: its
  snapshot excludes the nested drawable's subtree and vice versa.
- Legacy `layoutsubtree` attribute / `layoutSubtree` boolean property (`legacyNames`, default true): activates the same machinery
  with every DIRECT child implicitly drawable and no `drawable` attribute needed. If both `content=drawable` and `layoutsubtree` are
  present, `content=drawable` wins (the `drawable` attribute is then required). First use logs one `console.warn`
  (`layoutsubtree-legacy`).
- Layout facts the author can observe (all deviations are listed in section 9.3): children of a managed canvas are laid out in a live
  layer (`<hic-layer>`, the next sibling of the canvas; the parent's `children`/`childElementCount`/`lastElementChild` hide it with `parentFacade`, CSS `:last-child`/`+` and live collections do not) positioned over the canvas content box (a one-cell grid with layout containment: every direct child sits at the content-box origin with zero margins and `position: static`, like native; an auto-width child fills the width where native shrinks it to fit, deviation `children-layout`).
  They are invisible (`opacity:0`) and, until drawn (geometry), not hit-testable (WPT `hit-test/elementsFromPoint-no-content-drawable`).

## 4. `HTMLCanvasElement` API

All methods are installed on `HTMLCanvasElement.prototype` and act on the record of `this`. A canvas that is not managed (content is
not `drawable`, or detached, or disposed) behaves as "no eligible element" (InvalidStateError, section 6).

### 4.1 `requestPaint()`
Sets `record.paint.force`. The `paint` event fires once at the next rendering opportunity of the polyfill (the next scheduler tick
whose frame cap allows it, normally the next frame), even when nothing changed (`changedElements` is then `[]`), BUT only once the paint gate is open (4.2): `requestPaint()` on a freshly mounted canvas never lets a draw inside the handler throw for lack of a snapshot.
Calling it inside a `paint` handler schedules the NEXT frame, never a re-entrant dispatch. A connected `content=drawable` canvas the registry has not seen yet (observer microtask pending) is adopted first; a canvas that is genuinely unmanaged, detached or `display:none` is a no-op (the draw methods are the ones that throw `InvalidStateError` there, 6.1). Never throws.

### 4.2 `paint` event and `onpaint`
- Interface `CanvasPaintEvent extends Event`, `changedElements: FrozenArray<Element>` (`[SameObject]`: the same frozen array each read).
  `bubbles:false`, `cancelable:false`, `composed:false`. Constructor `new CanvasPaintEvent(type, {changedElements})` works.
- `onpaint` is a real event-handler IDL attribute (`null` by default; non-callable values coerce to `null`) and the `onpaint="..."`
  content attribute is compiled lazily with `new Function('event', code)` (a CSP that forbids it produces a reported error, not a silent no-op).
- `changedElements` = the drawables whose committed snapshot version advanced since the previous paint, in tree order, nested
  drawables included as their own entries. Drawables removed or no longer eligible are NOT listed (WICG issue 85 is open; the
  scheduler fires a paint for the removal with their absence visible through `getElementTransform` / errors).
- **Paint gate.** `paint` is dispatched only when every eligible drawable that has a CSS box has a committed snapshot (or a placeholder), because native creates all snapshots BEFORE firing `paint` and the explainer's own pattern (`onpaint = () => ctx.drawElementImage(form, ...)` plus `requestPaint()`)
  and the WPT helper `waitForCanvasPaint` draw unconditionally. With `coherentPaint` (default) it also holds up to `coherenceMaxWaitMs` (50 ms) while builds that started from the same DOM state as a landed one are in flight, so all drawables show one state. `force` stays set while the gate is closed;
  after `paintGateMaxWaitMs` (400 ms) the paint fires anyway with a report entry. A canvas with no eligible drawable-with-a-box fires at once with `[]` when `requestPaint()` asks for it, but a canvas WITHOUT any drawable fires no initial paint at mount (native does not; the first drawable added damages it). `requestPaint()` on a canvas that is not `content=drawable` fires one empty paint at the next frame. A `requestPaint()` paint is held (up to `paintGateMaxWaitMs`) while damage still waits for a snapshot, so a DOM change made before the call is in the snapshot the handler draws; a paint that has changes to report is never held. A canvas that contains another one paints after it and, when the nested one painted in the same tick, waits for a fresh snapshot.
- Firing rules: at most one `paint` per canvas per rendering frame; across canvases in reverse tree order (spec: descendants before
  ancestors); fired when `commitLanded()` produced a non-empty `ChangeSet`, a drawable was removed, `requestPaint()` was called, or
  the canvas content box changed (section 8, resize); also immediately, once per frame, from the microtask queued by a `canvas.width/height` write (section 8).
- Phase: the polyfill dispatches at the END of its frame (ResizeObserver slot: after app rAF callbacks, style/layout and earlier-created observers), so an app rAF that fills red followed by an `onpaint` that fills green ends green, and a game's scene-in-rAF plus HUD-in-`onpaint` keeps its HUD.
  Drawing inside the handler appears in the frame being produced. Deviations (rows `paint-timing`, `paint-dom-write-timing`): not after the IntersectionObserver steps; DOM writes made in the handler are laid out in the same frame by the observer loop (native: next frame) while their SNAPSHOT is
  captured by a later build (never the one that produced this event) and reaches the canvas >= 2 frames later; the page may log a "ResizeObserver loop completed with undelivered notifications" window error if the handler removes or resizes an element that the PAGE observes (the polyfill's own observers stop watching a canvas the moment it is detached, so removing the canvas itself raises nothing). Polyfill-created events have `isTrusted === false` (row `event-untrusted`).

### 4.3 `captureElementImage(element)` -> `ElementImage`
Resolution of the snapshot is the spec "get element image snapshot" (section 6 for exceptions). Returns a new `ElementImage` holding
the newest committed `SnapshotVersion` of `element`; it never changes afterwards (WPT `captureElementImage.html`: A and B taken before
a repaint keep the default width 100 after the DOM grew to 150). The capture pins the version (`SnapshotStore.pin`). The argument is an `Element` only, as in the IDL: an `ElementImage` is a `TypeError` (accepting it would have to pin the version it holds, not the newest). `drawElementImage` and the geometry methods accept both.

### 4.4 `ElementImage`
- No constructor: `new ElementImage()` throws `TypeError`. The interface has `close()` only (WHATWG PR 11588 since 2026-10-08): there is no `width` / `height`, and
  `'width' in elementImage` is false, as natively. Its size is `canvas.getElementImageDefaultSize(elementImage)` (4.4.1).
- `close()`: idempotent; detaches (`[[Detached]]`), unpins the version. Later use throws `InvalidStateError` (section 6).
- A never-closed `ElementImage` is released by a `FinalizationRegistry`; the bytes stay pinned until then (stat `pinnedSurfaces`).
- Extension `toImageBitmap(): Promise<ImageBitmap>`: a transferable copy of the pinned surface (full source rect), for workers.

#### 4.4.1 `getElementImageDefaultSize(element | ElementImage)` -> `{width, height}`
On `HTMLCanvasElement` and on a main-thread `OffscreenCanvas` transferred from one (spec "get the element image default size"). Resolves the
snapshot like `drawElementImage` (an `Element` gives its newest committed snapshot, an `ElementImage` the one it holds) and returns a new
dictionary `{width: snapshot.width * (bitmapWidth / snapshot.canvasWidth), height: ...}` in grid px: the default `dw`/`dh` of a draw, computed at
call time from the CURRENT bitmap size (the canvas's, or the OffscreenCanvas's own for the OffscreenCanvas method), so a `canvas.width` write is
reflected before the next paint (WPT `element-image-fractional-size`). Doubles, fractional values kept. Throws `InvalidStateError` before the
first snapshot, for a canvas that is not rendered, for a closed `ElementImage`, for an element or image of another canvas and on a standalone
OffscreenCanvas (WPT; the PR text says `TypeError` for the last two, section 6.3); `TypeError` for a missing or non-`Element`/`ElementImage` argument.

### 4.5 `updateElementGeometry(element | ElementImage, options?)`
`options`: `{preserveHitTestOrder = false, clip?: DOMRectInit, canvasTransform?: DOMMatrixInit}`. The spec text names the clip member
`canvasClip` while the IDL/README name it `clip`: BOTH are accepted, `clip` wins when both are given.
Steps (spec): resolve the element (an `ElementImage` resolves to its originating element); require eligibility; if `canvasTransform`
exists set the element's canvas transform from the dictionary (invalid `DOMMatrixInit`, e.g. `{a:1, m11:2}`, throws `TypeError` -
WPT `canvas-transform-get-set`); if `clip` exists set the canvas clip; unless `preserveHitTestOrder` is true AND the element is already
in the list of drawn elements, move it to the END of the list (top-most). 2D and 3D (`is2D:false`) matrices are both stored verbatim and
both applied (CSS `matrix` / `matrix3d`). An element in the drawn list with a null transform hit-tests at the identity transform (WPT:
`updateElementGeometry(b)` makes `b` hittable at canvas (0,0)). It does not require a snapshot and never triggers `paint`.
Effect on the page: the live element is moved by CSS so that input lands where the pixels are drawn (ARCHITECTURE ADR-F); it gets
`data-hic-hit` and becomes hit-testable; `elementsFromPoint` lists drawn elements most-recently-drawn first, then the canvas.

### 4.6 `clearElementGeometry(element | ElementImage)`
Removes the element from the drawn list, sets canvas transform and clip to null; the live element loses `data-hic-hit`
(`pointer-events:none` again) and its CSS correction.

### 4.7 `getElementTransform(element)` -> `DOMMatrix`
A NEW `DOMMatrix` each call (a copy of the canvas transform, identity when null; 3D preserved). Deprecated: the two-argument overload
`getElementTransform(element, drawTransform: DOMMatrix)` (in the IDL of the pinned WPT revision and exercised by its `get-element-transform`; removed from native builds on 2026-10-09, section 2.2; kept until the WPT pin moves, always available, also without `legacyNames`) returns, without
changing state, the matrix a draw with `drawTransform` as the draw transform would store, `S^-1 * D * S` (`S` = scale(canvas grid / css size)); it needs a snapshot (`InvalidStateError` before the first paint). The same overload exists on a main-thread `OffscreenCanvas` (two arguments only, as native). The first argument of `getElementTransform` and `updateElementGeometry` is `Element` or `ElementImage`. `drawable` on an outermost `<svg>` is supported like any CSS box; `drawable` on an SVG element inside an `<svg>` is refused (`svg-drawable`: `HicUnsupportedError`; the WPT `<rect drawable>` cases fail by design).

### 4.8 `elementgeometryupdate` / `onelementgeometryupdate`
`ElementGeometryUpdateEvent` with `elements: FrozenArray<Element>`, dispatched on the HTMLCanvasElement after a batch of geometry
updates that originated from an `OffscreenCanvas` (section 5.2) has been applied. Elements that no longer exist are omitted.

### 4.9 Not changed
`getContext`, `width`, `height`, `toDataURL`, `toBlob`, `transferControlToOffscreen` (except the link bookkeeping of 5.2) behave as
in the browser. The polyfill never writes `canvas.width/height` of a canvas the author draws on and never clears the author's bitmap (the one exception is the output canvas of an effect host, 7.3, whose bitmap the host sizes and owns). The only author-visible
writes on the canvas element are the attribute `data-hic-canvas` (at mount) and a merged `aria-owns` (ADR-M; plus generated `hic-o-*` ids on top-level children that had none, all restored on unmount; while the document is still loading these two are written after `load` + one task, so a server-rendered page hydrates first); the polyfill never writes the author's `style` attributes (geometry lives in its own adopted sheet, ADR-F). Inside drawables it writes `data-hic-hit` on drawn elements (4.5) and, in Chrome, `data-hic-scroll` on a scroller while the pointer is over it or it scrolls: a rule of the polyfill sheet then adds a transparent inset `box-shadow` and a transparent `background-attachment: local` image after the author's own values, which `getComputedStyle` of that scroller shows meanwhile (it makes Chrome present the scroll in step with the canvas, ADR-E). Meanwhile `box-shadow`, `background-image`, `background-attachment` and `background-clip` of that scroller compute to the values they had when it began plus the added layers (the canvas still shows every author change: snapshots are built from the author's style sheets), an author transition that covers `box-shadow` is held for `box-shadow` alone so that no transition event is fired, and a `MutationObserver` that watches attributes sees `data-hic-scroll` come and go (the polyfill's own observers ignore `data-hic-*`). Not done for a scroller whose shadow or background is animated, a shadow host or a slotted scroller, nor in Firefox and Safari. For `framecap`, nothing.

## 5. Context and texture APIs

### 5.1 `drawElementImage` (2D and main-thread Offscreen2D)
Overloads (spec IDL): `(el, dx, dy [, o])`, `(el, dx, dy, dw, dh [, o])`, `(el, sx, sy, sw, sh, dx, dy [, o])`,
`(el, sx, sy, sw, sh, dx, dy, dw, dh [, o])`; `el` is `Element` or `ElementImage`; `o` is `{preserveElementGeometry = false}`.
Algorithm (spec "draw an element"), in order:
1. any numeric argument infinite or NaN -> return silently.
2. `canvas` = the canvas of the context (for an `OffscreenCanvasRenderingContext2D`: its placeholder HTMLCanvasElement; none ->
   `TypeError`).
3. resolve the snapshot (section 6). The snapshot's originating canvas must be `canvas`, else `TypeError`.
4. `scaleX = ctx.canvas.width / snapshot.canvasWidth`, `scaleY` likewise (output bitmap pixels per css px of the canvas content box).
   Defaults: `sx=sy=0`, `sw,sh = snapshot.width,height` (css px of the border box); `dw = sw*scaleX`, `dh = sh*scaleY`
   (when `dw,dh` are omitted the element is drawn at EXACTLY its outside-canvas size).
5. Paint source rect (`sx,sy,sw,sh`, border-box frame, css px, negative origin reaches ink overflow up to `inkMargin`) into the
   destination rect under the CURRENT transform. A negative `dw`/`dh` never mirrors: the element keeps its orientation, the rect is normalised.
   Implemented as one `ctx.drawImage(surface, ...)` from `SnapshotStore.rasterSource` (no resampling when scales match).
6. unless `preserveElementGeometry`: `T_draw = CTM * translate(dx,dy) * scale(dw/sw, dh/sh) * translate(-sx,-sy)`;
   `canvasClip = (sx,sy,sw,sh)`; `canvasTransform = S^-1 * T_draw` (`S` = scale(scaleX, scaleY); no transform-origin term: the canvas transform maps the border box, origin at its top-left corner, to the canvas, WPT `get-element-transform`; a legacy `layoutsubtree` canvas gets `T_tr^-1 * M * T_tr` as the RETURN value of the draw); then set the element's clip/transform and move it to the end of the drawn list.
   For an Offscreen2D context the update is queued (microtask batch) and `elementgeometryupdate` fires on the placeholder canvas.
The call is synchronous, does not touch the DOM beyond step 6, and never reads layout: all numbers come from the version, including the border-box layout offset `layoutOffset` that the capture measured; step 6 is a no-op when matrix, clip and rank are unchanged, so drawing N elements per frame costs N cache hits.
Default-size draws take the source rect from the SURFACE pixel size (no resampling at fractional DPR). A canvas activated by the legacy `layoutsubtree` attribute returns the stored canvas transform as a `DOMMatrix` (legacy callers pipe it into `style.transform`; the polyfill's `!important` geometry rule gives the identical result); otherwise `undefined`.

### 5.2 OffscreenCanvas
`canvas.transferControlToOffscreen()` is wrapped only to record the link `record.offscreen`. A main-thread `OffscreenCanvas` (one
the page obtained from `transferControlToOffscreen()` and keeps on the main thread, or `new OffscreenCanvas` linked by the
placeholder semantics) can use `getContext('2d').drawElementImage` and `offscreen.updateElementGeometry/clearElementGeometry`
(microtask-batched, then `elementgeometryupdate` on the HTMLCanvasElement). In a dedicated worker the surface exists when the worker loads the
worker bundle first (`importScripts('hic-live-worker.iife.min.js')`, or `import '@giuseppe-scotto-lavina/html-in-canvas-polyfill/worker'` in a module
worker): `Worker.prototype.postMessage` on the page replaces each `ElementImage` at a shallow position of the message (the message itself, an array item,
a property of a plain object) by a record with the snapshot's pixels as an `ImageBitmap`, and closes the `ElementImage` when it is in the transfer list (a
transfer detaches); the worker bundle turns the record back into an `ElementImage` before the worker's own listeners run. In the worker,
`OffscreenCanvasRenderingContext2D.drawElementImage` (the four overloads) draws it on the OffscreenCanvas of its canvas, and `getElementImageDefaultSize`,
`updateElementGeometry`, `clearElementGeometry` and the earlier draft's two-argument `getElementTransform` work on that OffscreenCanvas; another canvas's
OffscreenCanvas, a standalone one or a closed image throws `InvalidStateError`. The geometry of the worker's draws and calls is sent back once per worker
turn and applied on the page as for a main-thread OffscreenCanvas (one `elementgeometryupdate`). The pixels are those of the snapshot when it was posted:
post a new capture after `paint` to update them. A worker without the bundle receives the plain record. An `ElementImage` sent through a MessagePort, a
BroadcastChannel or to a ServiceWorker throws `HicUnsupportedError('worker-element-image')`; `toImageBitmap()` is the alternative there.

### 5.3 WebGL and WebGL2
Installed on BOTH `WebGLRenderingContext.prototype` and `WebGL2RenderingContext.prototype` (legacy aliases on both).
`gl.texElementSubImage2D(target, level, xoffset, yoffset, element, config = {})` with `config = {sx, sy, swidth, sheight, width,
height}`. Implemented as `gl.texSubImage2D(target, level, xoffset, yoffset, RGBA, UNSIGNED_BYTE, source)`.
**Upload rectangle (the natural-size rule).** Source rect = `(sx, sy, swidth, sheight)` in css px of the border-box frame, default the whole border box. Destination size = `config.width/height` when given, else the ceiling of `canvas.getElementImageDefaultSize(element)` (grid px; this is what issue 174 tells apps to preallocate with `texImage2D`); WPT `element-image-fractional-size` is the oracle for the rounding and wins if it disagrees with ceil.
`source` is the retained surface when its pixel size for that rect equals the destination size, otherwise a scratch 2D canvas holding the resampled rect (canvas grid scale < 1, grid scale above `maxDpr`, fractional sizes), cached per `SnapshotVersion` id. Like `texSubImage2D` the
storage must exist (no auto allocation; issue 174): missing or too-small storage is a GL error (`getError()`), never an exception, as native. The current `UNPACK_*` state (FLIP_Y, PREMULTIPLY_ALPHA) applies. Legacy
`texElementImage2D(target, level, internalformat, format, type, element[, config])` -> `texImage2D` with the same size rule. Geometry is NOT updated
automatically (spec: 3D contexts must call `updateElementGeometry`). Cost: one GPU upload per call.

### 5.4 WebGPU
`queue.drawElementImageToTexture({source, sourceX, sourceY, sourceWidth, sourceHeight}, {texture, size, origin, colorSpace,
premultipliedAlpha})` -> `queue.copyExternalImageToTexture({source: surfaceOrCrop, origin: {x:sourceX, y:sourceY}}, destination,
size)` (flipY false); the default `size` follows the same natural-size rule as 5.3 (the ceiling of the element image default size), with the same scratch resample. Legacy `copyElementImageToTexture({source, sx, sy, swidth, sheight}, {destination:{texture}, width, height})` is
mapped to the same call. One GPU copy per call; the surface is a 2D canvas, which is the only sink that does not taint (measured on Chrome 154 and Safari).

## 6. Exceptions

All DOMExceptions are the platform class. Loud polyfill refusals are `HicUnsupportedError` (section 9).

### 6.1 Snapshot resolution ("get element image snapshot")
| condition | thrown | by |
|---|---|---|
| argument is neither `Element` nor `ElementImage` | `TypeError` (WebIDL) | all |
| `ElementImage` is closed/detached or its originating element is gone | `DOMException InvalidStateError` | all |
| `Element` has no canvas ancestor, the canvas is not `content=drawable`, or the element is not a `drawable` descendant | `InvalidStateError` | drawElementImage, captureElementImage, getElementTransform, updateElementGeometry, clearElementGeometry |
| no snapshot yet (before the first commit, or after reset: content toggled, display:none, removed) | `InvalidStateError` | drawElementImage, captureElementImage |
| snapshot belongs to ANOTHER canvas, or the `Element` is a drawable of another managed canvas | `InvalidStateError` (was `TypeError` before the 2026-10 WPT revision) | drawElementImage, captureElementImage |
| the canvas itself has no box (`display:none`, detached) | `InvalidStateError` (no snapshot is served from before) | drawElementImage, captureElementImage |
| Offscreen context without placeholder canvas | `InvalidStateError` (a WebGL context of such a canvas keeps `TypeError`) | drawElementImage |
| invalid `DOMMatrixInit` / `DOMRectInit` | `TypeError` | updateElementGeometry |
| any numeric argument NaN / infinite | none (silent return) | drawElementImage |
| `drawable` SVG element inside an `<svg>` (not the outermost `<svg>`) | `HicUnsupportedError('svg-drawable')` (polyfill limit) | getElementTransform, updateElementGeometry, clearElementGeometry, capture |
| `postMessage` of an `ElementImage` through a MessagePort / BroadcastChannel / to a ServiceWorker; an `ElementImage` in a Worker's transfer list but not in the message | `HicUnsupportedError('worker-element-image')` / `DataCloneError` | postMessage |
| in a worker: an `ElementImage` of another canvas, a standalone OffscreenCanvas, a closed image | `InvalidStateError` | drawElementImage, the OffscreenCanvas geometry methods |
| `new ElementImage()` | `TypeError` (Illegal constructor) | constructor |

### 6.2 "Throws before an initial snapshot"
After mounting, the first snapshot is committed one or more frames later (async SVG decode). In that window `drawElementImage` /
`captureElementImage` called OUTSIDE a `paint` handler throw `InvalidStateError`, exactly as native does before its first rendering update; `getElementTransform` /
`updateElementGeometry` do not need a snapshot. A draw INSIDE a `paint` handler never throws for lack of a snapshot because of the paint gate (4.2; native creates every snapshot before it fires `paint`): the gate keeps `paint` back until every eligible drawable with a CSS box has a snapshot
(waiting at most `paintGateMaxWaitMs`, then it fires with a report entry, and a draw of a still-missing drawable then throws). This is decided behaviour for a very large DOM (tens of thousands of nodes: the first snapshot takes longer than the 400 ms default): the app's first `drawElementImage` throws `InvalidStateError` as native does without a snapshot, and the message and the `paint-timing` deviation name the remedies (raise `paintGateMaxWaitMs`, stay below `nodeBudget.soft`, split the drawable). Authors draw from `paint` or await `installed.whenPainted(canvas)`. The same window reopens after any reset. A drawable without a CSS box (display:none, also through a hidden canvas ancestor) has no snapshot and a draw throws `InvalidStateError`.

### 6.3 Where the spec text and the WPT copy disagree (decision: the WPT wins, it is what Chrome does)
`updateElementGeometry` / `clearElementGeometry` / `getElementTransform` on an ineligible element: spec text says `TypeError`;
`wpt/error-conditions.html` asserts `InvalidStateError` for `getElementTransform(grandchild)` and for every method when
`content` was removed. The polyfill throws `InvalidStateError`. Spec text `options["canvasClip"]` vs IDL `clip`: both accepted (4.5).
`getElementImageDefaultSize` of an element or `ElementImage` of another canvas, or on a standalone OffscreenCanvas: the PR text says `TypeError`, WPT master
(`dcdb8e11`) and Canary 157 throw `InvalidStateError`; the polyfill throws `InvalidStateError`.

## 7. Extensions

The frame cap and the effects host are extensions of this library. They are not part of the HTML-in-Canvas proposal, native implementations do not provide them, and they are supported only while the polyfill provides the API (mode `polyfill`); section 7.6 has what was observed on top of a native implementation.

### 7.1 Frame cap
- Attribute `framecap` on the canvas: a non-negative integer, `0..240` (`EXT.FRAME_CAP_MAX`). Missing/invalid -> `options.defaultFrameCap`
  (default 0). `0` = uncapped = display refresh rate. IDL property `canvas.frameCap` (unsigned long), reflecting the attribute; the
  setter writes the attribute; values above 240 clamp. A change takes effect on the next tick (<= 1 frame).
  Clamping rules (`src/api/validate.js`): the property is an IDL `unsigned long`, so the setter converts with ToUint32 and then clamps to 240: `300` -> 240, `12.9` -> 12, `NaN`, `'abc'`, `undefined` -> 0 (uncapped), and a negative number wraps modulo 2^32 to a huge value and therefore becomes 240 (`-5` -> 240, not 0). The attribute follows the HTML rules for parsing non-negative integers (leading digits kept, trailing text ignored, clamped to 240): `"999"` -> 240, `"30fps"` -> 30; a missing or non-numeric value (`"abc"`, `"-5"`, `""`) means `options.defaultFrameCap`.
- Semantics: the effective cap `F` (fps) is an upper bound, per canvas, on (1) `paint` events, (2) effect frames (`effectframe`),
  and (3) snapshot build starts together with `options.maxSnapshotFps` (default 60): `min(F, maxSnapshotFps)` when both non-zero. Two exceptions to
  `maxSnapshotFps` only (never to `F`): the re-raster of a canvas resize / DPR change built inside the frame of the change, because the retained tile then has the
  wrong geometry; and the build of a scroller's own scroll damage when nothing else is pending for the drawable but hover changes inside that scroller (rows passing
  under a still pointer), which `nodeBudget.hard` does not slow down either: a native scroller presents every frame, and the main-thread cost bucket still bounds it.
  Frames are paced by a phase accumulator (not "now - last >= interval") so a 60 fps cap on a 120 Hz display renders every second
  rAF, not every 2.5th.
- **Who honours the cap.** `requestPaint()` is a request, not a bypass: the `paint` it asks for fires on the first tick the cap
  allows, so a capped canvas never paints faster than `F` however often the page calls it. `paintNow` (the same-frame redraw behind a `canvas.width/height` write,
  section 8) bypasses the cap on purpose: a bitmap that was just cleared must be redrawn in the SAME frame, and it is limited to one per frame. User-driven damage
  (input, focus, hover, scroll, caret) honours the cap too unless `options.interactionFloorFps` is set: it then uses `max(F, interactionFloorFps)` for those causes only
  (default 0 = strict cap, input latency can then be up to one cap period). Measured by gate G-f1-form-effect (page-side `effectframe` stamps at 30 / 60 / 120).
- The promise is "an effect at the cap, over a source updated at most that fast", not a stable 120 Hz source. A 120 Hz effect over
  30-60 Hz source updates is `framecap=120` with source builds limited by `maxSnapshotFps`/pipeline throughput.
- In mode `native` the `frameCap` property is not defined; the `framecap` attribute bounds effect frames only (feature row `frame-cap`, section 7.6).

### 7.2 Effect plugins: ABI v2
Global `window.HTMLInCanvasEffects` (`EffectsApi`): `{version: 2, definePlugin(def), createHost(canvas, source, options), NO_TARGET, isNoTarget(point)}`. It is defined by the OPTIONAL effects bundle (`dist/hic-live-effects.iife.js`, loaded after the core; ESM: `installEffects()` of `hic-live-polyfill/effects`), not by `install()`. It is bound late: every call looks up the installed core, so before an install or after `uninstall()` `createHost` rejects with `InvalidStateError`, and after a reinstall it works again. The plugins are not part of the effects bundle: the example plugins of `plugins/` are built to `dist/plugins/<name>.iife(.min).js` (each registers `window.HicLivePlugins.<name>`, WGSL inlined) and `dist/plugins/<name>.esm.js` (`plugins/README.md`).
`definePlugin` validates and freezes a definition: `{type: string, apiVersion: 2, version: number, outputCapabilities?:
{directCanvasRenderAttachment?: true}, actions?: string[], create(context, options)}`. `actions`, when present, is a non-empty array of
unique names matching `/^[a-z][a-z0-9-]{0,31}$/` (frozen copy), else `TypeError`. `create` may be async and returns an `EffectPluginInstance`:
`render(frame)` (required), `resize?`, `setOptions?`, `captureInputMapper?`, `mountUI?`, `runAction?`, `settled?`, `destroy?`, `spatial?`,
`continuous?` (`continuous` is read after every frame and may change at runtime; an idle host needs `context.requestRender()` to see it
turn true). Any other `apiVersion` (including the pre-release ABI 1) is a `TypeError`. A `spatial` plugin MUST provide
`captureInputMapper`; a plugin whose definition declares `actions` MUST provide `runAction(action, options, info)` and `settled()`, and
one without `actions` must not provide `runAction` (`addPlugin` rejects with `TypeError` otherwise, and destroys the instance). The context
is `{apiVersion, canvas, source, adapter, device, format, requestRender(), viewport(), listen(type, listener, options), trigger(action,
options?)}`; the `ui` of `mountUI(root, ui)` is `{canvas, getOptions(), setOptions(patch), requestRender(), trigger(action, options?)}`.
Types: `EffectPluginDefinition`, `EffectPluginContext`, `EffectRenderFrame`, `EffectPluginInstance`, `EffectActionState`,
`EffectActionInfo` in `contracts/types.js`.

### 7.3 Effect host
`await HTMLInCanvasEffects.createHost(canvas, source, {maxDpr, powerPreference, interposer})` -> `EffectHost`
`{pluginCount, addPlugin(def, options) -> EffectHandle, stats(), destroy()}`.
- Acquires an adapter/device, configures `canvas.getContext('webgpu')`. If the canvas already has another context type the promise
  rejects with `InvalidStateError` (`canvas-context-conflict`); no WebGPU -> rejects with `HicUnsupportedError('effect-plugins')`.
- `source` must be an eligible drawable (else `InvalidStateError`). The host reads source pixels through a `SourceProvider` (the
  `SnapshotStore` in polyfill mode, the public native API in native mode, which is not supported: section 7.6), uploads only when `version()` advanced, renders the
  plugin chain each due frame (`continuous` plugins) or on change, and keeps the source geometry in sync so the live element sits
  under the presented pixels (`GeometryApi.update(source, fill transform)`).
- Off-screen pause (always on, no option): while the canvas does not intersect the viewport enlarged by half its size on each side (and
  each scroll container around it enlarged the same way: `IntersectionObserver` `scrollMargin: '50%'`, or `rootMargin: '50%'` where
  `scrollMargin` is missing), or its document is hidden, the host renders and uploads nothing, `continuous` plugins included. Back inside
  that area it renders on the next frame; a scroll that moves the canvas box from outside to inside it renders in the frame of that
  scroll (a jump). `frame.now` is the time of the frame and does not stop during a pause; `delta` is the real gap since the previous
  presented frame. `stats()` reports `paused`, `pauses` and `offscreenFrames`. Without `IntersectionObserver` the host never pauses.
- Presented-frame events on the canvas: `effectframe` (CustomEvent, detail `EffectPresentationFrame`) and `effecterror` (CustomEvent,
  detail `{error, type, id, phase}`, `phase` one of `create`, `render`, `resize`, `setOptions`, `recreate`, `destroy`, `mountUI-dispose`,
  `action`, `settled`; `type: 'host', phase: 'recover'` when the device recovery gives up); after `effecterror` the canvas keeps the last
  presented frame (never blank).
- `EffectHandle`: `{id, type, options, enabled, actions, setOptions(patch), setEnabled(bool), mountUI(root) -> dispose, trigger(action,
  options?) -> Promise<EffectActionState>, settled() -> Promise<EffectActionState>, remove()}` (7.3.1).
- `destroy()`: stops rendering, unregisters the frame hook and the interposer, destroys plugin resources and the device. A WebGPU canvas context cannot
  be released, so the canvas keeps a (cleared) WebGPU context; a later `getContext('2d')` on it returns `null`, as in any browser.

#### 7.3.1 Plugin actions
`handle.actions` is the frozen list the definition declares (empty without `actions`). `EffectActionState` is a string naming the state
the plugin rests in (documented by each plugin), or `null`.

`handle.trigger(action, options?)` (an async function; every failure is a rejection, never a synchronous throw):
1. Rejects `TypeError` when the definition declares no actions (`trigger: the plugin "<type>" declares no actions`), when `action` is not
   in `actions` (`trigger: unknown action "<action>" of the plugin "<type>"; its actions are '<a>', '<b>'`), or when `options` is neither
   `undefined` nor an object.
2. While the plugin is being created again after a device loss, waits for that creation, then continues with the new instance.
3. Rejects `InvalidStateError` when the plugin was removed, failed (until `setEnabled(true)`), or is disabled.
4. Resolves the previous pending trigger of the same handle with `null` (superseded), then calls `instance.runAction(action,
   Object.freeze({...options}), Object.freeze({reducedMotion}))` SYNCHRONOUSLY (triggers keep their order; `reducedMotion` is
   `matchMedia('(prefers-reduced-motion: reduce)').matches` at the call) and requests a frame.
5. Resolves with what `runAction` returns or resolves (`undefined` becomes `null`), unless it was superseded first. A plugin resolves
   after the frame that draws the end state was rendered, and with `null` when it superseded or cancelled the action itself.
6. Rejects with the plugin's error when `runAction` throws or rejects; the plugin stays enabled and nothing is reported (the caller has
   the rejection).
7. The pending trigger resolves `null` when the plugin is removed (`remove()`, `host.destroy()`, `uninstall()`), disabled, or fails, and
   when its instance is destroyed for a device loss (the action is not replayed on the new instance).
8. While the host is paused off-screen (7.3), a pending trigger or `settled()` still advances: the host renders one frame every 100 ms
   until no trigger or `settled()` of any of its plugins is pending, so the promise resolves on the plugin's own timeline. A hidden
   document runs no frames: there it resolves on the first frame after the document is shown again.

`context.trigger` and `ui.trigger` (the plugin's own triggers: its submit handler, its buttons) run the same steps on the plugin's handle,
so they supersede a pending page trigger; a rejection is also reported (`effecterror`, phase `action`).

`handle.settled()`: rejects `TypeError` without declared actions; resolves `null` at once when the plugin is removed, failed or disabled;
otherwise resolves with `instance.settled()` (`undefined` becomes `null`). Pending `settled()` calls resolve `null` on removal, disable
or failure; across a device loss they are attached to the re-created instance. A throwing or rejecting `instance.settled()` is reported
(phase `settled`) and resolves `null`.

Verified by `test/unit/gpu-effects/effect-plugins.test.mjs` (every rule above, with a scripted plugin) and, per example plugin, by its
Node tests through the real handle, its GPU test (`runActionOnGpu`) and its gallery e2e (`actionChecks`, trusted clicks). Rule 8 and the
off-screen pause: `test/unit/gpu-effects/host-pause.browser.test.mjs`, `visibility.browser.test.mjs` and `plugins/water/test/offscreen.e2e.mjs`.

### 7.4 Input mapper and interposer
`captureInputMapper(frame: EffectPresentationFrame): InputMapper` is called by the host each time a frame is PRESENTED; the host keeps
the mapper of the last few presented frames. `InputMapper = (p: InputPoint) => {x, y}` is a PURE function mapping a point of the presented
output (canvas-relative css px of the content box, plus the presented `width`/`height` in css px) to the SOURCE point it shows, in the same
coordinate system. The optional method `mapper.captureGestureSnapshot(): InputMapper` returns a mapper frozen at the call (the host calls it
at `pointerdown` so a drag keeps one mapping). The host composes the mappers of all spatial plugins (last plugin first).
`NO_TARGET` (`effects/no-target.js`; exported by the effects module and as `HTMLInCanvasEffects.NO_TARGET`, tested with `isNoTarget`, which
recognises a registered-symbol brand so that copies from other bundles count) is what a mapper returns where the presented pixel shows no
element of the source. The composition stops at it (earlier mappers never see it), and the interposer swallows that gesture: `pointerdown`
default prevented, no focus change, no activation, the following `click` swallowed, hover on no element of the page.
Interposer (`options.interposer`, default true): capture-phase listeners on the live layer. For `pointermove/down/up/click`, it maps the
pointer through the gesture mapper and, because live elements sit where the source pixels are drawn, finds the intended element with the
layer's `elementAtPoint`. Hover/active mirrors follow the mapped target. At `pointerdown`, if the mapped element's control differs from
the native hit control it prevents the native handling and re-implements the activation: focus, button/link/checkbox/radio/label click
on `pointerup`, `input[type=range]` value + `input`/`change` events during the gesture, text caret placement. Not re-targeted: select
popups, drag selection, contenteditable (row `interposer-retarget`). Validated against GPU pixels, not against the mapper itself
(gate G-interposer-gpu).

### 7.5 Polyfill events and handles
`hicunsupported` (CustomEvent<UnsupportedEntry> on the canvas), `effectframe`, `effecterror` (above). `window.__HIC__` = debug handle
`{installed, report(), error?}`; `installed` is a getter that follows the live install (`getInstalled() ?? the first install`), so it stays right after `uninstall()` + `install()`.

### 7.6 On top of a native implementation (not supported)
Checked on 2026-10-14 with the built core and effects bundles (macOS, Apple M1 Max, 120 Hz, headed and headless; details in `docs/guides/EFFECTS-PLUGINS.md`):
- Chrome Canary 157.0.8103.0, with or without `--enable-blink-features=CanvasDrawElement`: `install()` steps aside (mode `native`, kind `complete`, probe `ok`) and the page draws natively (a drawable form painted from `onpaint`, `getElementImageDefaultSize` 200 x 60, no console message). No extension exists there: no `frameCap` property, no input remapping.
- Before this check the same build was refused (`partial-native`, because its `ElementImage` has no `width` / `height`); with a test-only stub that completed `ElementImage` (mode `native`), `createHost` and the water plugin rendered over `GPUQueue.drawElementImageToTexture`; the `frameCap` property was not defined (the `framecap` attribute paced effect frames: 15 and 30.5 per second at 15 and 30); pointer input is not remapped (the interposer needs the polyfill's live layer), so a click on the drawn field reached the canvas, not the field.

## 8. Timing model (summary; full detail in ARCHITECTURE ADR-C)
- DOM change -> mutation/input/focus/hover observers publish `Damage` -> (next tick, under the cap) clone + serialise + data: URL (main
  thread, bounded by `PumpBudget.mainThreadMs`) -> `Image.decode()` (off main thread) -> landed -> next tick `commitLanded()` ->
  `paint` event. Minimum latency = 2 frames; measured p50 15-34 ms at 120 Hz on the prototype (p95 up to 100 ms from decode).
- Native fires `paint` at the end of update-the-rendering (after IntersectionObserver steps) and applies canvas draws to the same frame; the
  polyfill fires at the end of its own frame, in the ResizeObserver slot (after app rAF callbacks, layout and earlier observers) and applies draws to that frame: same ordering against app rAF and observers, snapshots lag the DOM by >= 2 frames (deviations `paint-timing`, `paint-dom-write-timing`).
- Resize: on a canvas content-box size change every drawable gets a metadata-only new version at once (new `canvasWidth/Height`, same
  pixels) so a `paint` fires in the next frame and a handler that wrote `canvas.width` (clearing the bitmap) redraws immediately from
  the previous pixels; the re-rasterised snapshots follow (deviation `resize-stale-first`).
- Setting `canvas.width/height` on a managed canvas (also from a ResizeObserver callback, as in the explainer's basic example) refreshes the grid scale from the layer at once and fires ONE paint from a microtask in the SAME frame (a microtask checkpoint follows every ResizeObserver callback), at most one per frame and never re-entrant. A size write made INSIDE a `paint` handler of that canvas (detected synchronously in the setter) schedules nothing: the app clears the bitmap in order to redraw it right after, and native does not repaint on a size write either.
- "No blank frame" is claimed only AFTER the first non-blank paint, across resize, scroll, typing and DPR change. It cannot hold before the first commit (draws throw by spec; the paint gate), after a 2D context loss or GPU device loss until recovery (<= 3 frames), or on a hidden-to-visible transition (measured separately).
  During a resize drag the canvas shows pixels from 2-3 frames earlier stretched into the new box (no blank, but not current) while the live layer is already at the new size, so a click can land on the new layout while the pixels show the old one.

## 9. Out of scope and how it fails (loudly)

### 9.1 Mechanism
Every refusal is a `HicUnsupportedError` (class extends `DOMException`, `name === 'NotSupportedError'`, `code === 9`, plus
`feature`, `hint`, `path`). Rules:
1. A call the polyfill cannot honour THROWS it synchronously (install on a bad browser or over a native implementation without its core, `toImageBitmap` on a
   closed image is `InvalidStateError`, etc.).
2. Content the polyfill cannot capture never stalls and never blanks the rest: the offending subtree is replaced in the clone by a
   visible hatched placeholder box (`options.onUnsupportedContent: 'placeholder'`, default), a `Reporter.unsupported()` entry is
   recorded, `console.error` prints ONCE per (feature, path), a `hicunsupported` CustomEvent fires on the canvas, and the commit
   proceeds. With `'abort'` the commit is dropped, no paint fires, the event still fires. Content that the platform itself leaves
   out of a canvas (an image or frame document that is cross-origin, a filter that would draw a cross-origin image) is drawn as the
   platform draws it, without a hatched box: the element's own box without the content, or the element unfiltered; it is reported
   in the same way.
3. `installed.report()` returns the JSON `HicReport` (mode, native state, browser, per canvas state/drawables/frame cap/stats,
   unsupported entries, exercised deviations, caught internal errors). An unsupported entry's `count` is the number of times the reporter was told about it (typically once per snapshot attempt that meets that content, so a re-capture counts again), NOT the number of offending elements: one iframe can read 3. Internal errors are never swallowed: they land in
   `report().errors` and `console.error` once.
4. **Runaway guard (feature `runaway`).** A polyfill must never be able to spin a page. `src/snapshot/store/runaway.js` watches the commits of the
   snapshot store: when it publishes at least 90 versions (>= 30 per second) inside a 3 s window and NOTHING outside the pipeline asked for any of
   them (no damage of cause `mutation`, `input`, `focus`, `hover`, `active`, `scroll`, `resize`, `dpr`, `animation`, `selection`, `stylesheet` or
   `content-attr` since the window began; the pipeline's own `forced`, `geometry`, `resource` and `caret` damage does not count), the pipeline is a feedback
   loop. The polyfill then (a) records ONE report entry `feature: 'runaway'` (`installed.report().unsupported`, message "the snapshot pipeline committed N
   times in 3000 ms with nothing on the page asking for it; the polyfill uninstalled itself"), (b) prints `console.error` once, (c) fires `hicunsupported`
   on every canvas, (d) uninstalls itself one task later: layers unmount, every patched descriptor is restored, the canvas keeps its LAST drawn bitmap and its
   children are the canvas's own (fallback) children again, i.e. the page is exactly as in a browser without the API. The `installed` handle stays valid
   (`report()`, `uninstall()` is a no-op). Limits: a loop that is fed by outside damage every frame (a ResizeObserver that resizes its own canvas
   forever, a page that mutates the drawable every frame) is indistinguishable from an animation and is NOT stopped; those are bounded by the frame cap,
   the per-drawable depth of one build and the main-thread budget (ARCHITECTURE ADR-D). The decode of one tile is bounded as well: `decodeDataUrl` rejects
   after 4000 ms, the tile is dropped, its rect is re-damaged and the next build waits 100, 200, ... 5000 ms (consecutive failures), so the pump never waits
   forever on `img.decode()`.

### 9.2 Refusal table
| id | trigger | behaviour |
|---|---|---|
| `browser` | not Chromium desktop >= 130 | `install()` throws |
| `partial-native` | a native implementation without its core (no `content`/`layoutSubtree`, `onpaint` or 2D `drawElementImage`) | `install()` throws unless `forcePolyfill`; a usable native is never refused (section 2) |
| `shadow-dom` | (no longer reported) open shadow roots inside a drawable are drawn in flat-tree order with computed styles inlined (limited) | - |
| `iframe` | iframe/frame/object whose document this page cannot read (cross-origin, sandboxed without `allow-same-origin`), or an embed that does not show an image, in a drawable subtree | its own box (border, background) without the document, as natively; entry. A same-origin frame or object draws its document (resources inlined, its cross-origin content left out), repainted when that document changes or reloads; no entry |
| `shadow-canvas` | managed canvas in a closed shadow root created before install | refused, entry with hint `installed.adoptRoot(root)` |
| `top-layer-canvas` | a managed canvas became the fullscreen element (its controls take no input), or a `popover` canvas | entry with hint (fullscreen proceeds) / refused at mount |
| `svg-drawable` | `drawable` on an SVG element inside an `<svg>` | API calls throw `HicUnsupportedError` |
| `csp-blocked` | CSP without `img-src data:` | entry + hint (snapshots cannot decode) |
| `top-layer` | (no longer reported) a modal dialog, open popover or fullscreen element inside a drawable is left out of the snapshot, as natively | - |
| `cross-origin-resource` | image/font/CSS url without CORS and not same-origin | as natively: an `<img>` / `<picture>` / embed / object draws its box without the picture, an SVG `<image>` draws nothing, a `<filter>` with such an `feImage` is not applied, a font falls back; entry |
| `resource-fetch-failed` | fetch error / undecodable | as above |
| `worker-element-image` | `postMessage(elementImage)` through a MessagePort, a BroadcastChannel or to a ServiceWorker (a dedicated Worker takes it, section 5.2) | `HicUnsupportedError` with the `toImageBitmap()` hint |
| `node-budget` | a drawable above `nodeBudget.absolute` nodes | placeholder + entry (above `hard`: degraded to <= 4 fps except for its inner scrolling, reported) |

### 9.3 Documented deviations (rows with status `deviation`; each is recorded in `report().deviations` when exercised)
`paint-timing`, `paint-dom-write-timing`, `event-untrusted`, `contain-layout`, `a11y-geometry`, `resize-stale-first`, `css-transform-on-drawable`, `paint-order`.
Limited rows that change observable layout or structure: `tree-identity` (parent-level collections and CSS see the layer), `layer-containing-block` (fixed/clipping ancestors), `stacking-overlap` (page content above a non-positioned canvas), `a11y-tree-link` (aria-owns and generated ids),
`container-queries`, `shadow-canvas`, `nested-canvas`, `export-resolution`, `context-loss`, `print-find`.

## 10. Options (`HicOptions`)
Typedef with defaults: `contracts/types.js` (`HicOptions`, `ResolvedOptions`). Options include `coherentPaint` (true), `coherenceMaxWaitMs` (50), `paintGateMaxWaitMs` (400), `parentFacade` (true), `stackingAudit` ('report'), `maxTotalSurfaceBytes` (512 MiB). On a phone or tablet (the browser gate's `mobile`), options the page did not set default to `maxDpr` 3, `maxSurfacePixels` 16,777,216 and `maxTotalSurfaceBytes` 256 MiB (128 MiB when `navigator.deviceMemory <= 2`): `options.js` `MOBILE_BUDGETS`, rationale and the unverified status in `docs/guides/MOBILE.md`. `window` / `document` options allow installing into
another realm (tests). `autoDiscover:false` disables the document-wide canvas scan and the document MutationObserver; canvases are then managed only through
`installed.adopt(canvas)`.
