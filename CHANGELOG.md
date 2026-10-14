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
- Tests: unit tests in Node and headless Chrome, browser gates with positive controls and a mutation suite, the official WPT HTML-in-Canvas tests at a pinned commit (`docs/CONFORMANCE.md`), Firefox and Safari through WebDriver, and framework apps.

### Changed

- Following the specification change of 2026-10-08 (whatwg/html#11588), `ElementImage` has `close()` only: its size is `canvas.getElementImageDefaultSize(elementImage)`. There is no deprecated `width` / `height` alias, because native Chrome has none and code that relied on it would pass on the polyfill and fail natively.
- The two-argument `getElementTransform(element, drawTransform)` and `OffscreenCanvas.getElementTransform`, removed from native builds on 2026-10-09, remain as deprecated legacy overloads until the pinned WPT revision moves.
- `options.mode: 'polyfill'` over a usable native implementation steps aside with one warning instead of throwing; a legacy native without the bridge bundle is used as found (one warning) instead of being refused.

### Fixed

- `install()` threw `HicUnsupportedError('partial-native')` on Chrome Canary 157.0.8103.0, which exposes the API by default, because the native probe required `ElementImage.width` / `height`. The probe now decides on the core behaviour only, and Canary 157 installs in mode `native` and draws natively.

### Known limitations

- The picture lags the DOM by about two frames, except for the typing and scrolling shortcuts above.
- The children of a drawable canvas are relocated into a live layer next to it; some CSS selectors and live collections can see that layer.
- The core bundle is about 89 KB gzipped, over its original size target.
- Iframes, cross-origin resources without CORS, native UI (select popups, date pickers, IME composition), workers and mobile browsers are not supported.

See the README and `docs/SUPPORT-MATRIX.md` for the full list.

[0.1.0-preview.1]: https://github.com/GiuseppeScottoLavina/html-in-canvas-polyfill/releases/tag/v0.1.0-preview.1
