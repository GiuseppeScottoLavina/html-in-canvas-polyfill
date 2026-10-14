# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0-preview.1] - unreleased

First preview, published as `@giuseppe-scotto-lavina/html-in-canvas-polyfill` under the npm dist-tag `next`.

### Added

- The proposed HTML-in-Canvas API over a live DOM: `content="drawable"` on the canvas and the `drawable` attribute on drawn elements (legacy `layoutsubtree` / `layoutSubtree` accepted with one deprecation warning); the `paint` event with `changedElements`, `onpaint` and `requestPaint()`; `drawElementImage` (all overloads) on 2D and main-thread `OffscreenCanvas` contexts; `captureElementImage` and `ElementImage`; `updateElementGeometry`, `clearElementGeometry`, `getElementTransform` and `elementgeometryupdate`.
- WebGL and WebGL2 `texElementSubImage2D` (and the legacy `texElementImage2D`), WebGPU `GPUQueue.drawElementImageToTexture` (and the legacy `copyElementImageToTexture`), in the opt-in `hic-live-gpu` bundle.
- Native-first install: a behavioural probe chooses between running the polyfill, stepping aside for a complete native implementation, bridging a legacy native (`hic-live-native-bridge`), or refusing loudly (`HicUnsupportedError`, `installed.report()`).
- Desktop Chrome, Firefox 155+ and Safari 27+. On Firefox and Safari the opt-in `hic-live-engines` bundle draws form controls, classic scrollbars and shadows in each engine's look.
- Typed text in single-line fields is drawn at once, inner scrolling is composed from cached pages, and snapshot builds run after the frame, so typing and wheel scrolling are close to native latency (`docs/PERFORMANCE-COMPARISON.md`).
- Extensions of this library, not part of the standard and not provided by native implementations: a frame cap (`framecap` attribute, `canvas.frameCap`) and a WebGPU effect-plugin host with input remapping (`HTMLInCanvasEffects`, plugin ABI v2). They work only while the polyfill provides the API (mode `polyfill`).
- Example effect plugins outside the polyfill, in `plugins/` (one folder each, found by the build by convention; first: `water`): bundles `dist/plugins/<name>.iife(.min).js` and `.esm.js`, package subpaths `./plugins/<name>`, a manifest, a plugin template and a test kit that checks a plugin's input mapper against the GPU pixels.
- Classic `<script>` bundles (readable and minified) and an ES module build with `exports` and TypeScript declarations; no runtime dependencies and no network request on load.
- Six examples, among them a gallery of the effect plugins over one live form, and a zero-dependency demo server (`npm run demo`); guides for getting started, frameworks (React, Vue, Svelte, Lit), effect plugins, performance and troubleshooting.
- Tests: unit tests in Node and headless Chrome, browser gates with positive controls and a mutation suite, the official WPT HTML-in-Canvas tests at a pinned commit (`docs/CONFORMANCE.md`), Firefox and Safari through WebDriver, and framework apps.

### Known limitations

- The picture lags the DOM by about two frames, except for the typing and scrolling shortcuts above.
- The children of a drawable canvas are relocated into a live layer next to it; some CSS selectors and live collections can see that layer.
- The core bundle is about 88 KB gzipped, over its original size target.
- Iframes, cross-origin resources without CORS, native UI (select popups, date pickers, IME composition), workers and mobile browsers are not supported.

See the README and `docs/SUPPORT-MATRIX.md` for the full list.

[0.1.0-preview.1]: https://github.com/GiuseppeScottoLavina/html-in-canvas-polyfill/releases/tag/v0.1.0-preview.1
