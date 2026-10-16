# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0-preview.1] - unreleased

First preview, published as `@giuseppe-scotto-lavina/html-in-canvas-polyfill` under the npm dist-tag `next`.

### Added

- The proposed HTML-in-Canvas API over a live DOM: `content="drawable"` on the canvas and the `drawable` attribute on drawn elements (legacy `layoutsubtree` / `layoutSubtree` accepted with one deprecation warning); the `paint` event with `changedElements`, `onpaint` and `requestPaint()`; `drawElementImage` (all overloads) on 2D and main-thread `OffscreenCanvas` contexts; `captureElementImage` and `ElementImage` (`close()`); `getElementImageDefaultSize` on the canvas and on its main-thread `OffscreenCanvas`; `updateElementGeometry`, `clearElementGeometry`, `getElementTransform` and `elementgeometryupdate`. The API follows the HTML Standard pull request as of 2026-10-08.
- WebGL and WebGL2 `texElementSubImage2D` (and the legacy `texElementImage2D`), WebGPU `GPUQueue.drawElementImageToTexture` (and the legacy `copyElementImageToTexture`), in the opt-in `hic-live-gpu` bundle.
- Native-first install: a behavioural probe of the core (`content="drawable"`, the `paint` handler, a 2D `drawElementImage` that behaves like a platform method) chooses between running the polyfill and stepping aside for the browser's own implementation. A usable native implementation is never refused, whatever secondary members it lacks, renames or adds; `installed.report()` records what differs (`native-step-aside`). The optional `hic-live-native-bridge` adds what it can build over the earlier `layoutsubtree` draft. Only a native implementation without its core is refused (`HicUnsupportedError('partial-native')`).
- Desktop Chrome, Firefox 155+ and Safari 27+. On Firefox and Safari the opt-in `hic-live-engines` bundle draws form controls, classic scrollbars and shadows in each engine's look.
- Typed text in single-line fields is drawn at once, inner scrolling is composed from cached pages, and snapshot builds run after the frame, so typing and wheel scrolling are close to native latency (`docs/PERFORMANCE-COMPARISON.md`).
- Extensions of this library, not part of the standard and not provided by native implementations: a frame cap (`framecap` attribute, `canvas.frameCap`) and a WebGPU effect-plugin host with input remapping (`HTMLInCanvasEffects`, plugin ABI v2). They work only while the polyfill provides the API (mode `polyfill`).
- Eight example effect plugins outside the polyfill, in `plugins/` (one folder each, found by the build by convention): `crt`, `disintegrate`, `glitch`, `holo-card`, `liquid-glass`, `page-curl`, `shatter` and `water`. Bundles `dist/plugins/<name>.iife(.min).js` and `.esm.js`, package subpaths `./plugins/<name>`, a manifest (with each plugin's reduced-motion behaviour), a plugin template, `plugins/_lib/` for runtime code that several plugins share, and a test kit that checks a plugin's input mapper against the GPU pixels and drives it in the gallery with trusted input (`npm run test:plugins`).
- `NO_TARGET` in the effects ABI (`HTMLInCanvasEffects.NO_TARGET`, `isNoTarget`; exported by the effects module): what an input mapper returns where the presented pixel shows no element. The mapper chain stops at it, so an earlier plugin cannot clamp it back onto the canvas, and the interposer swallows that gesture (no focus change, no activation, no click). An additive extension of the plugin ABI; the polyfill core is unchanged.
- `npm run test:pages`: the GitHub Pages site under its project path in headless Chrome, every example and the gallery with each plugin.
- Classic `<script>` bundles (readable and minified) and an ES module build with `exports` and TypeScript declarations; no runtime dependencies and no network request on load.
- Six examples, among them a gallery of the effect plugins over one live form, and a zero-dependency demo server (`npm run demo`); guides for getting started, frameworks (React, Vue, Svelte, Lit), effect plugins, performance and troubleshooting.
- Phones and tablets, verified on the iOS Simulator and the Android Emulator only: Chrome for Android 130+ and Safari on iOS / iPadOS 26+ are admitted (iPadOS's desktop user agent is recognised by its touch points; Chrome, Firefox and Edge on iOS are WebKit and are admitted by the required features). Android WebView, in-app iOS web views and Firefox for Android stay refused, with the reason named. Phones get their own surface budgets (`maxDpr` 3, 4096 x 4096 px per surface, 256 MiB in all, 128 MiB on devices reporting 2 GB or less), and iOS form controls are drawn in the iOS look (system blue tint, pill buttons and pop-up buttons, the colour-well hue ring, medium-style date and time pills, no number spinner). Guide: `docs/guides/MOBILE.md`.
- `npm run test:mobile`: Mobile Safari in the iOS Simulator (`safaridriver`) and Chrome in the Android Emulator (adb and the DevTools protocol): taps on moved drawables, typing, touch scroll, the virtual keyboard, rotation, long-press selection, the iOS control look (62 regions) and the refusal of older browsers, each with a positive control.
- `report().canvases[].stats.snapshot.rasterScale`: the raster scale of the committed snapshots.
- Safari Technology Preview as an optional engine of `npm run test:xbrowser` (`stp`): skipped with the reason when it is not installed or its remote automation is off; its native surface is read first and decides between the polyfill scenarios and a native-examples scenario.
- Tests: unit tests in Node and headless Chrome, browser gates with positive controls and a mutation suite, the official WPT HTML-in-Canvas tests at a pinned commit (`docs/CONFORMANCE.md`), Firefox and Safari through WebDriver, and framework apps.

### Changed

- The `crt` example plugin looks like an old bar arcade monitor by default (preset `arcade`: thick scanlines, an RGB aperture grille, strong phosphor glow, warm phosphor, a reflection on the glass; preset `monitor` is cleaner). The interlace mode was removed. The input mapper is unchanged.
- Following the specification change of 2026-10-08 (whatwg/html#11588), `ElementImage` has `close()` only: its size is `canvas.getElementImageDefaultSize(elementImage)`. There is no deprecated `width` / `height` alias, because native Chrome has none and code that relied on it would pass on the polyfill and fail natively.
- The two-argument `getElementTransform(element, drawTransform)` and `OffscreenCanvas.getElementTransform`, removed from native builds on 2026-10-09, remain as deprecated legacy overloads until the pinned WPT revision moves.
- `options.mode: 'polyfill'` over a usable native implementation steps aside with one warning instead of throwing; a legacy native without the bridge bundle is used as found (one warning) instead of being refused.

- Startup is cheaper: the canvas's custom properties are read from its computed style, a ResizeObserver notification that reports the box already measured is not synced twice, and the style rules for the controls the engines bundle paints on Firefox and Safari moved into that bundle. The minified and gzipped sizes of every classic bundle are a budget checked by `npm run check:bundle` and CI.

- Large drawables: a change that resizes an element inside an unchanged parent repaints the children of that parent that moved instead of the whole drawable, and a partial tile leaves the trailing content of a large block or inline flow below it out of its snapshot. A 60 Hz counter next to 2,000 elements paints at the display rate (59/s, was 27/s).

### Removed

- The options `strictResources` and `trace`: they were validated but had no effect. Passing either now throws a `TypeError`, like any unknown option.
- Plugin ABI 1 and its adapter (the `sourceSnapshotSerial` frame field): `definePlugin` accepts `apiVersion: 2` only.
- The `./src/*` package export. The public API is the documented entry points of `exports`; the modules under `src/` are internal.

### Fixed

- The native bridge threw on a legacy native build without `updateElementGeometry` / `clearElementGeometry` (the shape of Safari Technology Preview 254 with its HTML-in-Canvas feature flag, read from its binary), so install dropped the bridge and `content="drawable"` canvases were not drawable there. Only the methods a build has are wrapped now; regression tests on that shape.
- At a fractional device pixel ratio (1.25, 1.5), a scroller with classic scrollbars (macOS with a mouse connected, or author-styled `::-webkit-scrollbar`) was drawn with its content up to one device pixel off: the bar gutter, a whole number of device pixels (14.4 css px at 1.25), was reproduced rounded to a whole css px, so fractional layouts inside it (a grid of `1fr` columns) landed elsewhere. The gutter is now measured exactly (F4 against native: 2.0 % -> 0.005 % of pixels).
- `install()` threw `HicUnsupportedError('partial-native')` on Chrome Canary 157.0.8103.0, which exposes the API by default, because the native probe required `ElementImage.width` / `height`. The probe now decides on the core behaviour only, and Canary 157 installs in mode `native` and draws natively.
- Selecting static text inside the canvas (double or triple click, drag, select all) did not show on the canvas until something else repainted it, and clearing the selection did not show either; with an effect plugin the picture stayed unchanged until the effect was switched. A selection change now repaints the drawables where the old and the new highlight are.
- A text or style change on an element whose text-shadow, box-shadow or outline reached further than 24 css px past its box (`options.inkMargin`) left the old shadow on the canvas: a counter with a glow or an offset shadow on a transparent background showed ghosts of older digits. The repainted area now includes the ink the element paints outside its box, before and after the change.
- A counter changing at 60 Hz in a font with proportional digits (Georgia, Impact) reached only a few canvas paints per second, and often none, while one with tabular digits painted at the display rate. Its box changes width on most changes, which makes every change a whole-drawable rebuild, and the rebuild in flight was discarded each time a newer change arrived, so few ever reached the canvas. A whole-drawable rebuild overtaken by a DOM change is now committed (it is a complete, newer picture) and the latest state is rebuilt after it; a resize or device pixel ratio change still discards it, and so does a paint that must show the page as it is now (`requestPaint()`, the first paint), so a child canvas drawn right before `requestPaint()` is in that paint.

- The first paint of a canvas landed two or three frames after it was mounted, and a change was painted at the earliest in the frame after its snapshot decoded. On Chromium a snapshot whose image loads at once (the snapshot's sheet is now an SVG `<style>`) is painted where it lands: the first paint in the first frame, a later change in a high-priority task right after the frame that saw it (after that frame's IntersectionObserver entries, before the app's next task). Fixes the official WPT files `onpaint-fires-post-resize-observer`, `requestPaint` (both were flaky), `onpaint-fires-post-intersection-observation-steps` and most of `onpaint`.
- The canvases inside a same-origin iframe in a drawable painted after the canvas that contains the iframe; the parent's tick now runs the iframe document's tick first (WPT `onpaint-iframe-post-tree-order`, first subtest).
- A z-index-only change of a drawable's inline style repainted it (a drawable is always its own stacking context, so its picture does not change).
- An author-styled scrollbar thumb or track with a background image (`::-webkit-scrollbar-thumb { background-image }`) was drawn without its image, and a thumb shorter than its `min-height`.
- A sticky (or fixed) drawable moved inside the live layer when the page scrolled, and a click at the place the app draws it missed it. While such a drawable is drawn, a passive window scroll listener re-measures it; there is no listener otherwise.
- A page that zooms the canvas with CSS `zoom` (on `html`, `body`, a wrapper or the canvas) drew the drawables twice too large when the canvas grid was not at that zoom.
- An explicit draw size within 1 px and 1 % of the snapshot (`el.offsetWidth * devicePixelRatio` against a fractional border box at DPR 1.25 / 1.5) resampled the whole picture by a hair and blurred every edge; it is drawn 1:1.
- With `navigator.gpu` present but no adapter (simulators, blocklisted GPUs) or a device request that fails, `createHost` had already claimed the canvas's `webgpu` context, so the documented 2D fallback got a null context and the canvas stayed blank (`examples/water-form` and `examples/plugins` threw). The presenter now acquires the adapter and the device before it claims the canvas.
- In a reversed ordered list (`<ol reversed>`), the numbers of the items in a partial tile of a large drawable were off: the stand-ins of the items left out of it did not count. Merged stand-ins of list items no longer change the numbering of the items after them either.
- The `water` example plugin had no reduced-motion mode: with `prefers-reduced-motion: reduce` the water is now calm (a still refraction, no ripples, no animation).

### Known limitations

- The picture lags the DOM by one to two frames, except for the typing and scrolling shortcuts above.
- The children of a drawable canvas are relocated into a live layer next to it; some CSS selectors and live collections can see that layer.
- The core bundle is about 92 KB gzipped, over its original size target.
- Iframes, cross-origin resources without CORS, native UI (select popups, date pickers, IME composition), workers and mobile browsers are not supported.

See the README and `docs/SUPPORT-MATRIX.md` for the full list.

[0.1.0-preview.1]: https://github.com/GiuseppeScottoLavina/html-in-canvas-polyfill/releases/tag/v0.1.0-preview.1
