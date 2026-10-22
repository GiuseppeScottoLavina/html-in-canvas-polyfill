# Troubleshooting

Built from `src/contracts/errors.js`, `src/contracts/features.js` and the code that raises each entry. Messages are quoted from the source; the polyfill prefixes them with `[hic-live-polyfill]`.

## 0. How the polyfill reports things

| channel | what | when |
|---|---|---|
| thrown `HicUnsupportedError` | a `DOMException` named `NotSupportedError` (code 9) with `feature`, `hint`, `path` | a call or install that cannot be honoured |
| `console.error`, ONCE per (feature, path) | `[hic-live-polyfill] unsupported <feature> at <path>: <message> Hint: <hint>` | content or a setup the polyfill cannot reproduce (it keeps running) |
| `hicunsupported` event on the canvas | `CustomEvent`, `detail` = the entry (`feature`, `message`, `hint`, `path`, `count`, `t`) | the first hit per feature, path and canvas |
| `installed.report()` / `window.__HIC__.installed.report()` | JSON: `mode`, `native`, `browser`, `canvases[]` (state, drawables, frame cap, entries), `unsupported[]` (with `count`), `deviations[]`, `errors[]` | any time; attach it to bug reports. `count` is how often the reporter was told about the entry (typically once per snapshot attempt that meets the content), not the number of elements: one iframe can show `count: 3` |
| `console.warn` once | install refused (classic script), or the legacy `layoutsubtree` name used | see sections 1 and 6 |

Default policy for content it cannot capture (`onUnsupportedContent: 'placeholder'`): the offending subtree is drawn as a hatched box, the report entry is added, the rest of the drawable keeps painting. Content that the browser itself leaves out of a canvas (a cross-origin frame document, a cross-origin image or video without CORS) is drawn as the browser draws it instead (the element's box without that content; a cross-origin video's box paints nothing, and an element whose mask image cannot be read is masked away), with the same report entry. With `'abort'` the commit is dropped and no `paint` fires, but the event still fires.

## 1. Install refused

Classic script: one `console.warn` (`[hic-live-polyfill] not installed (<feature>): <reason>. Hint: <hint>`) and `window.__HIC__ = { error }`; it never throws. `install()` from ESM throws unless `onUnsupportedBrowser: 'warn'`.

| feature | message (start) | cause | remedy |
|---|---|---|---|
| `browser` | `unsupported browser: <reason>` | not Chromium >= 130 (desktop or Chrome for Android), Firefox >= 155 or Safari >= 27 on desktop, or Safari >= 26 on iOS / iPadOS (other iOS browsers are WebKit and are decided by the features); an Android WebView, an in-app iOS web view, Firefox for Android, an older version; or a required platform feature is missing (named in the reason) | use a current Chrome, Edge, Firefox or Safari, or open the page in the device's browser instead of an app's web view (source: `native-detect.js` `browserGate`; mobile: `docs/guides/MOBILE.md`) |
| `browser` | `install() needs a browser window and found none` | called without a `window` | run it in a page, or pass `options.window` |
| `browser` | `mode "native-only" needs a native HTML-in-Canvas implementation and this browser has none` | `options.mode: 'native-only'` on a browser without native | use `mode: 'auto'` |
| `partial-native` | `this browser has a native HTML-in-Canvas implementation without its core (missing: ...)` | the native build lacks `content` (and `layoutSubtree`), `onpaint` or 2D `drawElementImage` | update the browser or remove the experimental flag (`forcePolyfill` replaces it in tests only) |

A usable native implementation is never a refusal. When it lacks or renames a secondary member, or is the earlier `layoutsubtree` draft, `install()` steps aside (mode `native`) and `installed.report().deviations` has an entry `native-step-aside` that says why, for example `the native implementation lacks ...` or `this browser implements the earlier layoutsubtree draft of HTML-in-Canvas ... To bridge them, load hic-live-native-bridge.iife.min.js before the core` (the readable twin is `dist/hic-live-native-bridge.iife.js`; ESM: import the `/native-bridge` subpath before `install()`). The earlier draft and an explicit `mode: 'polyfill'` over a native implementation also print one `console.warn`.

Option errors are plain `TypeError`s that name the option: `option "<name>" (got <value>) must be one of ... / a boolean / a finite number / an integer / >= <min>`; `defaultFrameCap` must be 0 or between the cap limits (0..240); `nodeBudget` must be `{soft, hard, absolute}` with `soft <= hard <= absolute`.

## 2. API calls that throw

| thrown | message (start) | cause | remedy |
|---|---|---|---|
| `InvalidStateError` | `The element has no snapshot yet (no first paint, display:none, or its state was reset). Draw from the canvas's paint event or after installed.whenPainted(canvas); ...` | `drawElementImage` / `captureElementImage` before the first snapshot exists (as native) | draw from `paint`, or `await installed.whenPainted(canvas)`. For a very large drawable raise `paintGateMaxWaitMs`, stay under `nodeBudget.soft`, or split it |
| `InvalidStateError` | `The canvas does not have content="drawable".` | `content` is missing or `fallback`, or the canvas is not managed | set `content="drawable"` |
| `InvalidStateError` | `The element is not a drawable descendant of this canvas.` | the element lacks the `drawable` attribute, or is not inside this canvas | add `drawable` to the element you draw |
| `InvalidStateError` | `The canvas is not rendered (detached or display:none), so its drawables have no snapshot.` | canvas hidden or detached | show it first |
| `InvalidStateError` | `The ElementImage is closed.` / `The element of this ElementImage no longer exists.` | `close()` was called, or the element was removed | capture again |
| `InvalidStateError` | `The element belongs to another canvas.` / `The ElementImage was captured from another canvas.` | drawing a drawable of canvas A on canvas B | draw on the owning canvas |
| `TypeError` | `Illegal constructor` | `new ElementImage()` | use `canvas.captureElementImage(el)` |
| `InvalidStateError` | `This OffscreenCanvas has no placeholder canvas; use transferControlToOffscreen() on a content="drawable" canvas.` | an Offscreen 2D context without a managed placeholder | transfer from a managed canvas |
| `InvalidStateError` | `The element is not a drawable descendant of a canvas with content="drawable".` | texture upload of an element outside a drawable canvas | see above |
| `InvalidStateError` | `Could not allocate a WxH scratch canvas for the texture upload.` | scratch resample canvas could not be created | smaller rect or `maxDpr` |
| `HicUnsupportedError('svg-drawable')` | `` `drawable` on an SVG element inside an <svg> is not supported by the polyfill (an outermost <svg drawable> is). `` | `drawable` on an SVG element inside an `<svg>` (`<rect drawable>`) | put `drawable` on the outermost `<svg>`, or wrap it in an HTML element with `drawable` and draw that |
| `HicUnsupportedError('worker-element-image')` | `An ElementImage cannot be posted to a <MessagePort\|BroadcastChannel\|ServiceWorker>: only a dedicated Worker running the worker bundle takes one.` | `postMessage` of an `ElementImage` through another carrier | post it to the dedicated Worker itself (it loads `hic-live-worker`), or `await image.toImageBitmap()` and transfer the `ImageBitmap` |

Texture upload errors on missing or too small storage are GL errors (`gl.getError()`), not exceptions: allocate with `texImage2D` first (`docs/API-CONTRACT.md` 5.3).

## 3. Content the snapshot cannot reproduce (report entry; a placeholder, or the content left out as natively)

| feature | cause | remedy |
|---|---|---|
| `iframe` | a cross-origin or sandboxed `<iframe>` / `<frame>` / `<object>`, or an `<embed>` that does not show an image, inside a drawable (drawn as its own box without the document, as natively) | use a same-origin frame (its document is drawn), draw the content as elements of the drawable, or put the frame outside it |
| `cross-origin-resource` | image, font, CSS or video frame without CORS and not same-origin ("the server did not allow cross-origin (CORS) access"): left out as natively (an image keeps its box without the picture, a font falls back, an element with such a mask image is masked away, a video's box paints nothing) | serve it with `Access-Control-Allow-Origin` or host it same-origin; load video with `crossorigin="anonymous"` |
| `resource-fetch-failed` | fetch error, HTTP error, undecodable payload, invalid URL, or larger than the resource cache budget | check URL, network, CSP `connect-src`; shrink the resource |
| `canvas-child` | a `<canvas>` child larger than the size budget, or tainted | draw big canvases outside the drawable; load images with CORS |
| `video-controls` | `<video controls>`: the control bar is native UI | draw your own controls inside the drawable |
| `container-queries` | `@container` rules whose container is outside the canvas | put `container-type` on an element inside the canvas |
| `node-budget` (degrade) | more than `nodeBudget.hard` (3000) nodes: updated at most 4 times per second (scrolling inside it is not slowed down) | split the content into several drawables or render less DOM |
| `node-budget` (absolute) | more than `nodeBudget.absolute` (20000) nodes: refused, placeholder | same |
| `surface-size` | the drawable does not fit `maxSurfacePixels` / `maxTotalSurfaceBytes` / the canvas dimension limit (raster scale reduced, or refused below 0.25) | lower `maxDpr` or the drawable size, raise the budgets, reduce the number of drawables |
| `context-loss` | a retained 2D surface lost its context; the drawable is re-rastered (`no action needed`) | none; the page shows the last good frame where it can, recovery up to 3 frames |

Not captured at all, by design (no entry, listed in `docs/SUPPORT-MATRIX.md`): select popups, datalist popups, date pickers, autofill and IME composition UI, the `backdrop-filter` of an element inside a drawable (the drawable's own `backdrop-filter` is applied against the canvas content). Left out as natively, without an entry: top-layer content inside a drawable (an open modal `<dialog>`, an open popover, a fullscreen element), which shows in the page's top layer. Open shadow roots inside a drawable are drawn (row `shadow-dom`).

## 4. Page integration reports

| feature | cause | remedy |
|---|---|---|
| `layer-containing-block` | the canvas sits inside a clipping ancestor with a `clip-path` shape the layer clip cannot follow | give the canvas container `position:relative` |
| `stacking-overlap` | page content that paints above the canvas (sticky header, float) but under its live layer, or a clipping ancestor hides the canvas from hit testing | give the canvas a positioned stacking context (`position:relative; z-index:0`) |
| `shadow-canvas` | a canvas in a closed shadow root created before install | call `installed.adoptRoot(shadowRoot)`, or install before the component attaches its root |
| `top-layer-canvas` | `popover` attribute on a managed canvas (refused at mount), or the canvas became the fullscreen element: it draws as usual, but its drawn controls take no input until fullscreen ends | put `popover` on an ancestor container; request fullscreen on an ancestor container |
| `legacy-native-bridge` | a legacy native can only draw DIRECT children; a deeper draw failed natively | make the drawn element a direct child, or use a native build with the current API |
| `csp-blocked` (`img-src`) | the page CSP blocks `data:` images, and every snapshot is a `data:` SVG image | add `data:` to `img-src`, e.g. `img-src 'self' data:` |
| `csp-blocked` (`script-src`) | the page CSP blocks eval, so `onpaint="..."` cannot be compiled | assign `canvas.onpaint` or use `addEventListener('paint', ...)` |
| `layoutsubtree-legacy` (console.warn once per install) | the pre-2026-09 name was used, as a markup attribute at install time or from script | add `drawable` to the drawn elements and use `content="drawable"` |

## 5. Effects (`HTMLInCanvasEffects`)

| error | cause | remedy |
|---|---|---|
| `HicUnsupportedError('effect-plugins')` from `createHost` | no WebGPU adapter or device | keep the 2D `drawElementImage` path (decide before any `getContext`); the hint says so |
| `InvalidStateError` `canvas-context-conflict: the canvas already has another context type` | `getContext('2d')`/`webgl` was called on the canvas before `createHost` | do not touch the canvas context when using a host; the host owns it |
| `InvalidStateError` `HTMLInCanvasEffects needs the installed polyfill: ...` | the core is not installed, was uninstalled, or loaded after | load the core first and let it install (or call `install()`) |
| `console.warn` `createHost: the source is AxB CSS px but the canvas is CxD` (once per host) | the source has another size than the canvas, so the effect stretches it: the picture is distorted and clicks land beside what you see | give the source exactly the canvas content-box size ([EFFECTS-PLUGINS.md](EFFECTS-PLUGINS.md), "Size the source like the canvas") |
| `InvalidStateError` `createHost: source is not an eligible drawable of this canvas ...` | the source is not a drawable child or a descendant marked `drawable` | pass the element that has `drawable` |
| `TypeError` `createHost: canvas must be an HTMLCanvasElement` / `source must be an Element` / `options must be an object` | wrong arguments | fix the call |
| `TypeError` from `definePlugin` / `addPlugin` | `type`, `apiVersion` (must be 2), `version`, `create` invalid; unknown `outputCapabilities` key; instance without `render`; `spatial` without `captureInputMapper`; `captureInputMapper` not returning a function | see [EFFECTS-PLUGINS.md](EFFECTS-PLUGINS.md) |
| `TypeError` `an input mapper returned a non-finite point` | a mapper returned NaN or Infinity | clamp inside the mapper |
| `InvalidStateError` `the effect host was destroyed` / `the plugin was removed` | calling a handle after `destroy()` / `remove()` | do not reuse handles |
| `effecterror` event (`detail: {error, type, id, phase}`) | a plugin or the GPU failed | the plugin is marked failed and skipped; see `report().errors` |
| `a later getContext('2d') on it returns null` | a canvas keeps its first context type for life; `host.destroy()` leaves a cleared WebGPU context | use a new canvas |

## 6. Symptoms without an error

| symptom | cause | remedy |
|---|---|---|
| the canvas is empty right after load | the first snapshot is decoded asynchronously; drawing before it throws by spec | draw from `paint`; "no blank frame" is only claimed after the first non-blank paint (`docs/API-CONTRACT.md` section 8) |
| the canvas is blank after a context or GPU loss | a retained 2D canvas can come back blank | recovers within 3 frames (`context-loss`) |
| during a window drag the picture lags the layout; a click lands on the "wrong" element | the drawn pixels are 1 to 3 frames old and stretched into the new box while the live layer is already at the new size | documented deviation `resize-stale-first`; the pixels converge a few frames after the last resize event |
| `canvas.width` writes make the canvas flash | writing `width/height` clears the bitmap | write it only from the `ResizeObserver` (the polyfill redraws in the same frame) and only when the size changed |
| typing feels late by a frame or two | snapshots lag the DOM by one frame, two or more when an image or font must load first (typing in a single-line field is drawn at once); with a frame cap input latency can reach one cap period | raise `framecap`, or set `options.interactionFloorFps` |
| `parent.children`, `:last-child`, `canvas + x`, a MutationObserver on the canvas behave differently | the children live in `<hic-layer>`, a sibling of the canvas (`tree-identity`, `selector-bridge`) | do not rely on the canvas's siblings; use the facades (`canvas.children`, `parentFacade`) |
| a framework renders the canvas children and something breaks | the framework reads the parent's child list or the canvas's siblings, which the layer perturbs | see [FRAMEWORKS.md](FRAMEWORKS.md) |
| scrollbar thumbs look slightly different | native scrollbars are not painted inside an SVG image; the polyfill paints them in the platform's look, but not their hover and pressed states (`classic-scrollbars`) | style them with `::-webkit-scrollbar` / `scrollbar-color` |
| find-in-page matches invisible text with no highlight, print shows the bitmap | the live DOM is the `opacity:0` layer (`print-find`) | by design |
| a CSS animation looks stepped | animations are re-snapshotted at the cap and frozen at the sampled time (`css-animations`) | animate with an effect plugin instead |
| `getComputedStyle(drawable).contain` is `layout` | the polyfill makes drawables containing blocks (`contain-layout` deviation) | none |
| `TypeError: ctx.drawElementImage is not a function` (also `canvas.requestPaint is not a function`, `captureElementImage`) | your code ran BEFORE the core script did, so the API was not there yet (the polyfill cannot warn: it was not loaded). Causes: the core `<script>` is after the inline script that draws; the core tag has `defer` or `async` (it then installs after the parser finished, later than inline scripts); the core is loaded as `type="module"` without calling `install()` yourself; it is loaded late from code. | put the plain `<script src="...hic-live-polyfill.iife.min.js">` FIRST (no `defer`, no `async`, no `type=module`), or call `install()` before any code reads the API; with `data-hic-manual` call `HicLivePolyfill.install()` yourself first |
| nothing happens in Firefox or Safari | the version is below 155 / 27 or a platform feature is missing (section 1, the console warning names it) | update the browser |
| checkboxes, radios or sliders look different in Firefox/Safari snapshots, and the console names `engine-gecko` / `engine-webkit` with "engines bundle, which is not loaded" | the classic page loads only the core | add `<script src=".../hic-live-engines.iife.min.js">` (any order with the core; docs/BUNDLES.md) |
| `texElementSubImage2D() needs the polyfill's GPU bundle` (NotSupportedError) | the classic page uploads elements as WebGL / WebGPU textures without the GPU bundle | add `<script src=".../hic-live-gpu.iife.min.js">` (before or after the core) |
| checkboxes, radios or sliders look different in Firefox/Safari snapshots (with the engines bundle loaded) | the engine paints form controls differently inside SVG images (rows `engine-gecko`, `engine-webkit`) | expected; style the controls with `appearance:none` for an identical look |

## 7. Still stuck

Collect: the browser and version, the OS, `JSON.stringify(__HIC__.installed.report(), null, 1)`, the console output, and a minimal page.
When the problem shows up on a machine you cannot use yourself, ask its owner to run the [field test](FIELD-TEST.md): it collects the environment, compares the canvas with the plain page as that screen shows them, and measures typing and scrolling, in one report file. File an issue at https://github.com/GiuseppeScottoLavina/html-in-canvas-polyfill/issues/new/choose.
