# Support matrix

What works, what works with limits, what is refused, and on which browsers. The feature tables below are GENERATED from
`src/contracts/features.js` (`npm run docs:sync`); gate G-doc-sync fails when they drift. Everything outside the generated block is
hand-written and uses only these words: **measured** (a number exists in a test report or a gate run), **expected** (follows from the
design, not measured), **refused** (the polyfill throws or reports).

The conformance status against the official WPT tests is generated in `docs/CONFORMANCE.md`; the browser gates and what they assert are in `docs/TEST-PLAN.md`.
"Measured" in the hand-written rows means Chrome 154 and 155, Canary 157 (native), Firefox 155 and Safari 27, on macOS with an Apple M1 Max; some content rows were measured
on the prototype that preceded this implementation and say so. Layout, hit-test, ordering and accessibility-tree rows are facts from probes, not timings.

## Browsers

| browser | behaviour | evidence |
|---|---|---|
| Chrome desktop 154 | polyfill (`absent`) or native-bridged (flag `CanvasDrawElement`: legacy names `layoutSubtree`, `copyElementImageToTexture`, no `content`, no `onelementgeometryupdate`) | measured: browser gates (fidelity, resize, scroll, typing); native probe |
| Chrome Canary 157 | native expected complete (`content=drawable`); polyfill steps aside | measured: the WPT oracle runs on Canary 157 (`docs/CONFORMANCE.md`) |
| Chrome 155 | polyfill | measured: WPT subject runs and the performance comparison |
| Chrome 156 and Chrome 130-153 | polyfill expected (anchor positioning needs >= 125) | expected, unverified |
| Chrome >= 157 stable with the feature shipped | native complete: polyfill patches nothing of the standard surface; extensions only | expected; web evidence of shipping is contradictory (see API-CONTRACT) |
| Edge, Opera, Brave, other Chromium desktop >= 130 | same engine as Chrome | expected, unverified |
| Firefox >= 155 desktop | polyfill (row `engine-gecko`) | measured: Firefox 155.0.1 and 157.0.1 (macOS), G-xbrowser scenarios PASS with their controls red (table below) |
| Safari >= 27 desktop | polyfill (row `engine-webkit`) | measured: Safari 27.0.1 (macOS), G-xbrowser 11 scenarios PASS with their controls red, incl. `controls` (56/56 regions), classic scrollbars, `interaction` and `inactive`; needs an unlocked screen (Safari suspends rendering behind the lock screen) |
| Firefox < 155, Safari < 27 | refused (`browser`, "older than the supported minimum") | unverified |
| Chrome Android, iOS browsers, WebViews | refused (`browser`) | not measured |
| any browser with a PARTIAL native implementation (a CORE name missing) | refused (`partial-native`) | by design |
| a native build missing only ADDITIVE names (155-156-like) | native-bridged gap-fill | expected; tested on synthetic shapes only |

Minimum Chrome for the polyfill path is 130 by policy. Every engine is also checked for the platform features the polyfill path cannot run without (CSS anchor positioning,
ResizeObserver, `HTMLImageElement.decode`, constructable stylesheets); a missing one is named in the refusal.

## Engines (measured 2026-10-10, macOS 27.0.1, M1 Max, DPR 2; `npm run test:xbrowser`, plain-DOM twin in the SAME engine)

Pixel numbers are `shiftTolerant / structural` (fraction of pixels over 16 / over 100 levels, a pixel may match the reference row above or below; gate 5 % / 1 %, `docs/TEST-PLAN.md` section 2.9) and the
strict fraction over 16 in brackets. Chrome rows come from the Chromium gates (strict 3 % rule).

| scenario | Chrome 154 | Firefox 155.0.1 | Safari 27.0.1 |
|---|---|---|---|
| explainer at rest / after typing | 0 % / 0.41 % strict | 0.66 / 0.26 % (0.78 %) | 0.20 / 0 % (0.56 %); 0.35 / 0.09 % typed |
| click on the drawn input focuses it; typed text exact (no doubled insertion) | pass | pass ("hello") | pass ("hello") |
| keydown-to-canvas (in-page, 5 keys, ms) | 15-34 (prototype) | 18-28 | 24-39 |
| F1 form at rest; checkbox click, field typing, textarea | 0.0002 % | 3.5 / 0.98 % (4.9 %): pass | 2.6 / 0.23 % (3.2 %): pass |
| F3 resize drag (12 steps), blank frames, final pixels 1400 / 800 px, click after resize | 0 blank | 0 blank of 145 frames; 0.7 / 0 % and 1.8 / 0 %; click lands | 0 blank of 89; 0.02 / 0 % and 0.01 / 0 %; click lands |
| F2 inner wheel scroll to 300 / 900 px, sticky header | 0.03 % | scrollTop 300 / 900, page 0; 0.16 / 0 % | scrollTop 300 / 900, page 0; 1.1 / 0.05 % |
| unsupported iframe: report, one console.error, event, canvas paints, sibling typing | pass | pass | pass |
| install / uninstall descriptor identity | 60 props, 0 left | 102 props, 0 left | 108 props, 0 left (2 always-new getters ignored) |
| taint: canvas readable, WebGL `texElementSubImage2D`, WebGPU `drawElementImageToTexture` non-blank | pass | pass (raw: data: SVG -> 2D, createImageBitmap, texImage2D all allowed) | pass (raw: same, all allowed in 27.0.1) |
| raw foreignObject decode of an F1-size snapshot (p50 / p95 ms) | n/m | 22.1 / 27.4 | 5.2 / 18.2 |

What differs and why (classification):
- **fidelity limit of foreignObject**: Gecko themes no widget in SVG images (checkbox/radio absent, fields with the UA inset border, range thumb only); WebKit draws controls in
  its legacy look and ignores accent-color there; both set text lines one device row off and light-on-dark text thinner. Polyfill fallback: the clone draws every native
  control in the live engine's look, ported from the engine's own painter. Firefox 157.0.1: G-xbrowser `controls` 56 of 56 regions within 10 % / 1.5 % (old bundle: 50 of 56 out,
  e.g. buttons 38.7 / 9.6 %, dark checkbox 15.9 / 14.3 %). Safari 27.0.1: G-xbrowser `controls` 56 of 56 regions (worst 6.2 / 0.48 %; old bundle: 23 regions failed incl. submit, checkbox, radio,
  range, progress, meter, search); control probe 112 cells: only the 4 indeterminate progress cells differ. Interaction and window states: Firefox hover,
  pressed and focus-ring looks (colours measured live in Firefox 157.0.1) and the listbox scrollbar gutter; Safari pressed looks and the inactive-window look (no accent while the
  window is not key, repainted on window focus / blur): G-xbrowser `interaction` 30 of 30 states and `inactive` 62 of 62 regions in both engines (before: Firefox 16 states out,
  worst hovered select 50 / 0.4 %, focused field 14 / 11 %; Safari 10 pressed states out, buttons 37 %; inactive window 30 regions out, worst submit 44 / 39 %; Firefox scrolled
  listbox 38.7 / 5.8 %). The ONLY control look still different: an indeterminate progress bar (drawn at its start position: the engine's animation clock is not readable).
- **engine behaviour needing a polyfill-side fallback**: optical font size chosen from the zoomed size (scale by viewBox on Gecko, CSS transform on WebKit); no
  `scroll-initial-target` (scroll snap); no `computedStyleMap` on Gecko; opacity:0 subtree not wheel-scrollable on Gecko; no `device-pixel-content-box` in WebKit
  (`resize-observer-dpcb`); `isContextLost` absent on Safari's OffscreenCanvas 2D (already optional-chained, no change); Gecko dark classic scrollbars.
- **engine bug**: none found that blocks a scenario. Safari stops rendering updates behind a locked screen (test environment limit, not user-visible).
- Not measured: WebGPU effect host (water plugin) on Firefox/Safari, DPR 1, Linux/Windows, trace-based timing (no trace API outside Chromium).

## Native-first behaviour

| native state (behavioural probe) | mode | polyfill does |
|---|---|---|
| complete | native | extensions only: effects global; frame cap bounds effect frames |
| legacy (pre-2026-09 names) | native-bridged | attribute aliasing + missing method aliases; native renderer untouched |
| partial (a CORE name missing / unknown shape) | refused | `install()` throws unless `forcePolyfill` (tests); the IIFE auto-install warns once instead of throwing |
| partial, only additive names missing | native-bridged | gap-fill only; native renderer untouched |
| absent | polyfill | full implementation (Chromium gate) |

## Content inside a drawable (what the clone can reproduce)

| content | status | note |
|---|---|---|
| text, flex, grid, positioned boxes, borders, shadows, gradients, transforms, clip-path, masks, filters | expected | same rendering engine as the page (SVG foreignObject image); pixel difference vs plain DOM measured 0.0003 % / 0 % / 0 % on three fixtures |
| `input`, `textarea`, `select` (closed), `button`, checkbox, radio, range, progress, meter, details | measured (inputs, checkbox, range on the prototype) / expected (others) | value and state are copied to the clone |
| select popup, datalist popup, date pickers, autofill, IME composition UI | refused | native UI is not part of any snapshot (also excluded by the spec's read-back-allowed rendering) |
| `position:sticky` / `position:fixed` inside the drawable | measured (sticky header exact) / expected (fixed) | fixed descendants resolve against the drawable, as the spec's containing-block rule says |
| scroll inside the drawable | measured (gate G-scroll-inner) | native scrolling; clone mirrors offsets; steps composed from cached pages |
| `:hover`, `:active`, `:focus*` | expected | mirrored as classes; hover/active were NOT in the prototype |
| CSS animations/transitions | expected | sampled and frozen per snapshot, limited by the cap |
| `backdrop-filter`, `mix-blend-mode` against content outside the drawable | measured: unsupported in effect (deviation `backdrop-isolation`, WPT `css-backdrop-filter*`) | the clone is isolated (`isolation:isolate` is part of the spec) so the backdrop is transparent; `mix-blend-mode` inside the drawable works |
| `filter: url(#id)` naming an SVG `<filter>` outside the drawable | measured (WPT `css-filter-reference-on-div`) | the filter is copied into the clone (hidden `<svg>`); its `feImage` goes through the resource cache; masks, markers, patterns and `<use>` outside the subtree are NOT drawn (as native, for privacy) |
| an `<img>` that failed to load (404) | measured (WPT `broken-image`) | stays an `<img>` and draws as the broken-image icon in its box; reported as `resource-fetch-failed` |
| a CSS transform on the drawable itself | measured (WPT `css-transform-on-div`, `canvas-transform-get-bounding-client-rect`, `elementsFromPoint`) | painted in the snapshot; the surface covers its transformed box (`ink-overflow`); a translation canvas transform composes with it in spec order on the live element (hit testing, `getBoundingClientRect`); a canvas transform with scale/rotation/skew is not applied while it has one (`css-transform-on-drawable`) |
| `<img>`, CSS images, web fonts, same-origin or CORS | expected | inlined as `data:` |
| cross-origin images/fonts without CORS | refused | placeholder + report |
| `<canvas>` child | expected | static bitmap per commit; tainted refused |
| `<video>` | expected | poster/current frame at snapshot time |
| inline `<svg>` | expected | serialised with the clone |
| iframe, object, embed, shadow DOM inside a drawable, top layer | refused | see unsupported table |
| nested `canvas[content=drawable]` | limited | managed independently, appears in the outer snapshot as a plain bitmap |
| `container-type` / `contain` / `overflow` ancestors between the layer and a drawable | limited | become real boxes in the clone; `@container` whose container is OUTSIDE the canvas is reported, not honoured |
| sibling-dependent selectors on a drawable root (`+`, `~`, `:nth-child`, `:first-child`) | expected | display:none sibling stubs preserve them (measured in an SVG image) |
| caret | expected | measured and painted on the retained surface, not in the tile |

## Page integration (where the canvas lives)

| situation | status | note |
|---|---|---|
| block or inline canvas, page scroll, scaled ancestor | measured (layer rect == canvas rect to 0.01 px) | [probe] |
| `position:sticky` canvas | measured | layer stays glued |
| `position:fixed` canvas | limited | layer mirrors fixed (measured: an absolute layer drifts away) |
| canvas inside a non-positioned scroller / clipping ancestor | limited | JS clip-path + focus reveal; the clip follows scrolling one frame late |
| page content that natively covers a non-positioned canvas (sticky header, floats) | limited | detected and reported (`stacking-overlap`), not fixed; give the canvas a positioned stacking context |
| open shadow root (and closed roots created after install) | limited | per-root styles; document-level selectors do not cross; closed root created before install: `adoptRoot` |
| `requestFullscreen()` on the canvas, `popover` canvas | refused | fullscreen an ancestor container instead |
| screen readers | limited | `aria-owns` of the top-level children restores list/listitem structure (measured in the Chrome AX tree) |
| frameworks (React, Vue, Lit) | expected | children reconcile through the canvas facade; parent-level collections hide the layer with `parentFacade`; `:last-child`/`+` still see it |
| print | expected | layer hidden, canvas bitmap prints |
| find in page | limited | matches the invisible live text without a highlight |
| strict CSP (`img-src` without `data:`) | refused | reported with a hint; every snapshot is a data: SVG image |
| `canvas.width` written from a ResizeObserver (the README example) | expected | redrawn in the same frame by a setter microtask |
| export at 3-4x the layout size | limited | raster capped at `maxDpr`; raise it for export-only pages |

## Generated feature tables

<!-- BEGIN GENERATED FEATURES -->

### Supported

| id | what | reason / the one thing to know |
|---|---|---|
| `content-drawable` | canvas content="drawable" + drawable attribute (reflected content IDL attribute) | Descendants are relocated into a live layer; see tree-identity. |
| `request-paint` | requestPaint() fires paint at the next rendering opportunity even without changes | Fires at the end of the polyfill frame once the paint gate is open (every eligible drawable has a snapshot); at most once per frame. |
| `draw-element-image-2d` | ctx.drawElementImage 4 overloads, negative rects, preserveElementGeometry; 2D and main-thread Offscreen2D | Draws from a retained 2D surface; pixels are those of the browser rasteriser (SVG foreignObject), not of the live page. |
| `capture-element-image` | captureElementImage + ElementImage (immutable, close(), width/height in grid px) | A capture pins the current surface; the store forks it on the next commit (copy-on-write). |
| `elementgeometryupdate` | main-thread OffscreenCanvas updateElementGeometry batching + elementgeometryupdate event | Main thread only; there is no worker support (worker-element-image). |
| `frame-cap` | framecap attribute / frameCap property (fps upper bound for snapshot commits, paint events and effect frames) | With a complete native implementation the cap only bounds effect frames (native paint events cannot be throttled). |
| `effect-plugins` | HTMLInCanvasEffects: effect host, plugin ABI v2 (v1 adapted), input mapper, interposer, water plugin | Optional bundles (docs/BUNDLES.md): hic-live-effects.iife.js after the core, hic-live-effects-water.iife.js for the water plugin. Needs WebGPU; without it createHost rejects loudly and the page keeps the 2D path. |
| `top-layer` | top-layer content inside a drawable (modal <dialog>, open popover, fullscreen element) is not painted into the canvas; the live element shows in the page top layer | Same behaviour as native (WPT top-layer-not-painted-in-canvas, dialog-paints-in-top-layer). |

### Limited (works, with documented deviations)

| id | what | reason / the one thing to know |
|---|---|---|
| `layoutsubtree-legacy` | layoutsubtree attribute / layoutSubtree property as aliases; children implicitly drawable; deprecation warning once | Pre-2026-09 name; the standard renamed it to content=drawable (WICG issue 179). |
| `paint-event` | paint + CanvasPaintEvent.changedElements; fires >= 1 frame after the DOM change (async raster), once per frame per canvas, only when every eligible drawable has a snapshot (paint gate) | Snapshots are rasterised asynchronously (SVG decode), so the event cannot fire in the same rendering update as the DOM change; the gate guarantees a draw inside the handler never throws for lack of a snapshot (waits at most paintGateMaxWaitMs). |
| `element-geometry` | updateElementGeometry/clearElementGeometry/getElementTransform with 2D and 3D matrices applied to the live element via CSS | Exact only when no ancestor between the drawable and the canvas is transformed or clipping (see nested-geometry). |
| `webgl-tex-element` | texElementSubImage2D (+ legacy texElementImage2D) on WebGL and WebGL2 through a 2D surface upload; the default rect is the ElementImage natural size; no zero-copy | One GPU copy from the retained 2D surface per call, resampled through a scratch canvas whenever the surface pixel size differs from the requested rect; browsers expose no zero-copy path to userland. Classic pages load hic-live-gpu.iife.js (before or after the core; the package entry carries it): without it the methods exist and throw a NotSupportedError that names the bundle. |
| `webgpu-draw-element` | GPUQueue.drawElementImageToTexture (+ legacy copyElementImageToTexture) through copyExternalImageToTexture of a 2D surface | One GPU copy from the retained 2D surface per call. Classic pages load hic-live-gpu.iife.js (before or after the core; the package entry carries it): without it the methods exist and throw a NotSupportedError that names the bundle. |
| `offscreen-main-thread` | OffscreenCanvas on the main thread only | No browser rasterises foreignObject in a Worker, so there is no worker-side source. |
| `tree-identity` | canvas children live in a sibling layer; parent/children/query/contains/events (addEventListener and on* handlers, currentTarget, composedPath) are bridged by instance facades on the canvas, its children and (parentFacade) its parent | The browser does not lay out canvas children, so they must live elsewhere; author MutationObservers on the canvas, live HTMLCollections of the parent, :last-child/:nth-child/+ selectors of siblings and framework reconcilers that read the parent child list can still see the layer. |
| `selector-bridge` | selectors/CSS rules that name the canvas as ancestor are rewritten for the layer with the original specificity preserved; sibling combinators after the canvas, :hover/:focus on the canvas are not | Stylesheet rules are mirrored once per stylesheet change (adopted sheet, so CSP style-src is not an issue); rules inserted via insertRule are picked up on the next stylesheet observation. |
| `classic-scrollbars` | non-overlay scrollbars: layout exact, thumb/track painted by the polyfill; Safari bars measured on Safari 27 (light and dark color-scheme, 0.5 % over 100 in their regions); the hover thumb colour is not reproduced | Native scrollbars are not painted inside an SVG image; the polyfill paints them (author ::-webkit-scrollbar colours and scrollbar-color are honoured). |
| `caret-selection` | caret and selection painted for single-line inputs; textarea/contenteditable selection approximated; email/number caret derived from presses, edits and keys (no selection highlight) | Caret and selection are native UI of the live element, absent from the clone, and are redrawn from selection geometry; an author ::selection background is honoured, its text colour and the textarea resize grip are not drawn. |
| `hover-active` | :hover/:active/:focus/:focus-visible/:focus-within carried into the snapshot by class rewriting | The clone cannot be hovered; state is tracked on the live layer and mirrored as classes. |
| `css-animations` | animations/transitions are re-snapshotted at the frame cap, frozen at the sampled time | Clone animations are frozen; each snapshot samples the live computed values. |
| `canvas-child` | plain <canvas> inside a drawable is captured as a static bitmap per commit (size budget); tainted canvases refused; a script redraw through the 2D or WebGL drawing methods damages the drawable | A canvas bitmap is not serialisable into SVG without a synchronous data: encode. Redraws are noticed by wrapping fillRect/stroke/fillText/drawImage/putImageData/clearRect... and the WebGL draw calls (one wrapper call per call on any canvas); pixels written by other means (ImageBitmapRenderer, OffscreenCanvas commit, width resets) are not noticed until something else damages the drawable. |
| `video` | <video> shows poster/current frame at snapshot time, not continuously unless the drawable is animated | A video frame must be encoded to a data: URL per commit. |
| `video-controls` | <video controls> shows its poster/current frame without the control bar; reported once per element at runtime | The media control bar is native UI of the live element and is not part of the serialised clone. |
| `node-budget` | above nodeBudget.soft the clone is damage-pruned; above hard the drawable is degraded to <= 4 fps and reported | Clone cost is O(nodes) on the main thread (1125 nodes = ~26 ms per full clone measured on the prototype). |
| `ink-overflow` | the surface covers the border box plus the measured ink overflow (own CSS transform, box-shadow, outline, descendants overflowing to the right/bottom; at least options.inkMargin, at most 2048 css px per side); descendant shadows and descendants overflowing to the left/top beyond options.inkMargin are clipped | Measuring the full ink overflow of every descendant would cost O(subtree) per snapshot; the measured part is O(1). |
| `nested-geometry` | geometry of a drawable below a transformed or clipping non-drawable ancestor is not applied to the live element | The correction transform assumes a translation-only path from the layer to the drawable; reported once. |
| `interposer-retarget` | effect input remap re-targets focus, click activation, range drag and caret placement; not select popups, drag selection or contenteditable | Trusted pointer events cannot be re-dispatched at another target; the interposer re-implements the common activations. |
| `surface-size` | a drawable larger than options.maxSurfacePixels is rasterised at a reduced scale and reported | Retained surfaces are bounded GPU/CPU memory. |
| `legacy-native-bridge` | mode native-bridged: attribute aliasing (content <-> layoutsubtree), missing method shims and gap-fill of additive names over a legacy or nearly complete native implementation, with per-method argument translation | Only what the public API of the native build can express; the native renderer is never replaced (API-CONTRACT 2.1 lists what is translated). Optional bundle hic-live-native-bridge.iife.js, loaded before the core; without it such a browser is refused with partial-native. |
| `shadow-canvas` | a managed canvas inside an open shadow root (and a closed one created after install): per-root layer/geometry sheet, the root styles are collected for the clone | Document-level selectors and the selector bridge do not cross the boundary; a closed root created before install is refused (use adoptRoot). |
| `layer-containing-block` | canvas that is position:fixed, or sits inside a non-positioned scroller/clipping ancestor: the layer mirrors fixed and is clipped by a JS-maintained clip-path, focus reveal scrolls the canvas scrollers | An absolutely positioned layer has the canvas containing block, not its clipping ancestors; the clip follows scrolling one frame late (reported once when a case is not coverable). |
| `stacking-overlap` | page content that natively paints above a non-positioned canvas (sticky header, floats, earlier overlays) but is covered by the layer drawn drawables is detected and reported, not fixed | A positioned layer cannot paint at the in-flow stacking step; give the canvas a positioned stacking context to avoid it. |
| `a11y-tree-link` | the canvas aria-owns its top-level logical children (ids generated when missing, merged with the author value, restored on unmount) so role=list/listitem structure and names survive the relocation | Probe: aria-owns the layer keeps parentage but loses the listitem roles; only the children themselves resolve roles (measured on Chrome 154). |
| `container-queries` | container-type / contain / overflow ancestors between the layer and a drawable become real boxes in the clone; @container whose container is OUTSIDE the canvas is not honoured and is reported | A display:contents shell is not a query container (measured in an SVG image). |
| `export-resolution` | the retained raster scale is clamp(canvas grid scale, 1, maxDpr); a canvas exported at 3-4x is upscaled above maxDpr | Surfaces are bounded memory; raise options.maxDpr (and maxSurfacePixels) for export-only pages. |
| `context-loss` | a retained surface that loses its 2D context is re-rastered (whole-drawable damage) and the effect host recreates its GPU device; the page shows the last good frame meanwhile where it can | After a GPU reset a retained 2D canvas can come back blank; recovery needs up to 3 frames (gate G-fault-injection). |
| `print-find` | the layer is hidden in print (the canvas bitmap prints); find-in-page matches the invisible live text without a highlight | The live DOM is the opacity:0 layer by design. |
| `inline-drawable-geometry` | an inline (non-atomic) drawable cannot carry the canvas transform: CSS transforms do not apply to inline boxes, so its live element stays at its layout position | Native treats an inline drawable as an atomic box; making it inline-block would change line breaking and fragmentation. |
| `animated-images` | an animated GIF/APNG/WebP in a drawable shows one frame per snapshot and its frame changes do not by themselves raise a paint event | The browser gives no signal when an image advances a frame and the SVG image of a snapshot does not animate nested images. |
| `drawable-canvas-element` | a <canvas drawable> (or a nested canvas) is drawn from the bitmap of the last snapshot, so a draw right after painting into that canvas shows the previous bitmap until the next paint | Snapshots are asynchronous; a canvas bitmap is only read when a build starts. |
| `engine-gecko` | Firefox >= 155 (macOS measured): 2D/WebGL/WebGPU paths, typing, hit-testing, resize, inner scroll and uninstall work; form controls (checkbox, radio, range, button, select, listbox with its scrollbar, text fields, textarea, progress, meter, colour, date/time) are drawn by the polyfill in Firefox's own widget look incl. hover, pressed and focus-ring states (ported from its theme, colours measured live in Firefox 157; G-xbrowser controls + interaction); text lines may sit 1 device px off and light-on-dark text is set thinner; an indeterminate progress bar is drawn at its start position | Gecko does not theme widgets inside an SVG image (a checkbox is absent, a field falls back to a 2 px inset border) and loads images nested in an SVG image after its decode (the polyfill pre-decodes its control skins); it snaps text lines on its own grid and does not dilate light glyphs in images (measured, G-xbrowser). The native progress animation clock is not readable. Classic pages load hic-live-engines.iife.js with the core for the form-control skins (the package entry carries it); without it the controls keep the image look and the capture reports it once. |
| `engine-webkit` | Safari >= 27 (macOS measured): same paths as Chromium; form controls are drawn by the polyfill in the refreshed macOS look ported from WebKit (checkbox, radio, range, buttons, select, fields, search capsule, textarea, progress, meter, colour, date/time, file button; accent-color honoured; G-xbrowser controls 56/56 in Safari 27.0.1); pressed controls and the inactive-window look (no accent while the window is not key; repainted on window focus/blur) are drawn as measured on Safari 27.0.1 (G-xbrowser interaction + inactive); an indeterminate progress bar is drawn at its start position; text lines may sit 1 device px off; ResizeObserver device-pixel-content-box is provided as contentBox x dpr | WebKit draws form controls in SVG images in the legacy look and without accent-color (the image document lacks the page's form-control-refresh setting) and ignores the viewBox for HTML that has its own layer, so the polyfill draws the controls itself and scales snapshots with a CSS transform. The progress animation clock is not readable from the page (the only control look that is not reproduced). The window state is read with document.hasFocus(), which is also false while the address bar has focus. Rendering stops behind a locked screen. Classic pages load hic-live-engines.iife.js with the core for the form-control skins, bars and shadows (the package entry carries it); without it they keep the image look and the capture reports it once. |
| `resize-observer-dpcb` | ResizeObserver box "device-pixel-content-box" and ResizeObserverEntry.devicePixelContentBoxSize where the engine lacks them (Safari): contentBoxSize x devicePixelRatio, rounded | A box at a fractional device-pixel offset can differ by 1 px from a native snapped size, and a devicePixelRatio change alone does not re-fire the observer. |
| `selection-through-canvas` | a trusted double click that hits the canvas itself (not a drawn child) selects the word of the live layer text nearest to the point, as native word selection walks the canvas subtree; a preventDefault() on the mousedown or dblclick and user-select:none cancel it | Triple click (paragraph) and a drag selection that starts on the bare canvas are not reproduced. |
| `shadow-dom` | OPEN shadow roots inside a drawable are captured in flat-tree order (slots render their assigned nodes or fallback); shadow-tree elements, their hosts and slotted elements carry their computed style inline; mutations inside them repaint the drawable | Pseudo-elements generated by shadow-scoped sheets are not drawn, a later change of a shadow root's adoptedStyleSheets is not observed, and a CLOSED root created before install is invisible (its light DOM is drawn). |
| `top-layer-canvas` | requestFullscreen() on a managed canvas works and draws as natively, but its drawn controls take no input while fullscreen (reported once); a managed canvas with a popover attribute is refused at mount | The live layer is a sibling outside the fullscreen subtree, which Chrome makes inert even when the layer is promoted to the top layer (measured); fullscreen an ancestor container to keep input. |
| `svg-drawable` | `drawable` on an outermost <svg> is supported (captured, measured, hit tested as a CSS box; paint servers, masks and markers outside it are ignored, <use> targets outside it are drawn without their cross-origin images, as natively); `drawable` on an SVG element inside an <svg> (`<rect drawable>`) throws HicUnsupportedError from capture and the geometry methods | An inner SVG element has no CSS border box, which capture and geometry are built on. |
| `nested-canvas` | a canvas with content=drawable inside another managed canvas is managed independently (its layer sits inside the outer layer); the outer snapshot shows it as a plain canvas bitmap | Natively supported by the platform WPT (moved-nested-content-drawable-canvas); geometry of the inner canvas below a transformed outer drawable follows nested-geometry. |

### Deviations from the standard behaviour

| id | what | reason / the one thing to know |
|---|---|---|
| `paint-timing` | paint is dispatched at the END of the polyfill frame (ResizeObserver phase, after app rAF callbacks, style/layout and earlier-created ResizeObservers), not inside update-the-rendering after the IntersectionObserver steps; snapshot content lags the DOM by >= 2 frames | A userland polyfill cannot run inside the rendering steps; the ResizeObserver slot is the closest one (measured on Chrome 154). |
| `contain-layout` | drawable is made a containing block with contain:layout (getComputedStyle().contain === "layout" instead of "none") | The only way to give a drawable the spec containing-block behaviour from CSS. |
| `a11y-geometry` | drawables always expose real geometry to assistive technology (native withholds it until geometry is updated) | The live DOM is laid out for real. |
| `resize-stale-first` | on canvas resize a paint with the previous snapshots fires immediately, the re-rasterised one follows | Avoids a blank canvas while the new snapshot decodes. |
| `css-transform-on-drawable` | a translation canvas transform (every drawElementImage at the natural size) composes with the drawable's own CSS transform/translate/rotate/scale in spec order, synchronously; a canvas transform with scale, rotation or skew is not applied to a drawable that has its own CSS transform (reported once) | A translation is applied as a relative offset, outside the CSS transform chain; a general matrix needs the transform property, which the author owns. |
| `paint-order` | changedElements is in tree order, not in paint order | Paint order needs compositor stacking information that userland cannot read. |
| `paint-dom-write-timing` | DOM writes made inside a paint handler are laid out within the same frame (ResizeObserver loop) instead of the next one; the snapshot of that write still arrives >= 2 frames later | The handler runs in the ResizeObserver phase; the page may log a benign "ResizeObserver loop" notification if the write resizes an observed element. |
| `event-untrusted` | paint and elementgeometryupdate events created by the polyfill have isTrusted === false | Userland cannot create trusted events. |
| `backdrop-isolation` | backdrop-filter and mix-blend-mode of a drawable (or of its descendants) against content outside the drawable have nothing to blend with: the backdrop is transparent | The clone is an isolated SVG image document (isolation:isolate is part of the standard, but native still composites the canvas background under the snapshot). |
| `paint-spurious` | a paint event can fire although no snapshot changed (an ancestor attribute or z-order change, the removal of a nested drawable) and the outer canvas of a nested one paints a second time after the nested handler drew | The standard only says a paint "may" fire without a change; the polyfill cannot know a rebuilt tile equals the old one without reading it back, and snapshots are asynchronous. |
| `children-layout` | children of the canvas are blockified, shrink-to-fit, position static, zero margins, all at one origin (like native), but that origin is the canvas content box (native: its border box, visible only with canvas border/padding), and children of a display:contents child are laid out below it with their own position (native forces them static at the origin too); the static rule has zero specificity, so a class or id selector with !important still wins | CSS cannot select by computed display, so the box-tree children of a display:contents wrapper cannot be targeted synchronously. |
| `raster-scale-floor` | when the canvas grid is smaller than its css size (or differs per axis) the snapshot is rasterised at one scale >= 1 and the draw resamples it; a scaled draw is isolated to its source rect, so edges stay opaque, but text is resampled rather than painted at the grid scale | Text rasterised below 1x is unreadable; native paints at the grid scale. |
| `color-space` | snapshots are sRGB: wide-gamut colours (display-p3) of a drawable are not preserved in a display-p3 canvas | The SVG foreignObject rasteriser and the retained 2D surface are sRGB. |

### Unsupported (refused loudly)

| id | what | reason / the one thing to know |
|---|---|---|
| `browser` | mobile browsers, engines other than Chromium/Gecko/WebKit, Chromium < 130, Firefox < 155, Safari < 27, and any engine lacking a required platform feature (CSS anchor positioning, ResizeObserver, HTMLImageElement.decode, constructable stylesheets; the refusal names it): install() throws HicUnsupportedError | Only Chrome 154/157, Firefox 155.0.1 and Safari 27.0.1 on macOS were measured (G-xbrowser); older versions are unverified and the named features have no fallback. |
| `partial-native` | a native implementation that lacks a CORE name or has an unknown shape is never overridden (install() throws unless forcePolyfill); a build that lacks only additive names is gap-filled | Mixing two implementations of one core surface is unsound. |
| `iframe` | <iframe>/<object>/<embed> inside a drawable subtree | A child browsing context cannot be serialised into foreignObject. |
| `cross-origin-resource` | images/fonts/CSS that cannot be fetched with CORS or same-origin credentials | SVG-as-image cannot load external resources; read-back-allowed rendering forbids leaking them. |
| `resource-fetch-failed` | a resource that cannot be fetched or decoded as data: | Network error or undecodable payload. |
| `worker-element-image` | postMessage of an ElementImage (message or transfer list) to a Worker/MessagePort throws HicUnsupportedError with a toImageBitmap() hint | A userland class cannot be Transferable; the guard replaces the platform's generic DataCloneError by an actionable one. |
| `runaway` | safety net: a snapshot pipeline that publishes >= 30 versions/s for 3 s with no outside damage (no mutation, input, animation, resize, scroll, stylesheet change) is judged a feedback loop; the polyfill reports it and uninstalls itself | A polyfill must never be able to hang or spin a page; after the guard fires canvases keep their last bitmap and their children are plain canvas fallback content again. |
| `csp-blocked` | pages whose CSP forbids data: images (img-src) or new Function (onpaint attribute): detected through securitypolicyviolation and reported with a hint | Every snapshot is a data: SVG image; without img-src data: nothing can be decoded. |

<!-- END GENERATED FEATURES -->
