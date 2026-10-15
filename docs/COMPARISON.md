# Comparison with `html-in-canvas-polyfill` (npm)

Measured 2026-10-13 by the authors of this polyfill, so read it as one party's measurements: every number below is reproducible with the method described, and where the other package is ahead it says so (section 6).

Scope: facts and our own measurements only. Chrome 154.0.8037.98 (no native feature), Apple M1 Max, macOS, DPR 2 for the gates and DPR 1 for WPT. Nothing was run in Firefox or Safari for this comparison. Load average stayed under 4.

## 1. What the package is

| | `html-in-canvas-polyfill` | this polyfill (ours) |
|---|---|---|
| version | 1.0.1 (npm, 2026-05-09). It is a 1.5 KB wrapper: `import 'three-html-render/polyfill'` + `installHtmlInCanvasPolyfill()`. Its README says "All credits go to repalash/three-html-render". | 0.1.0-preview.1 (preview) |
| real implementation | `three-html-render` 0.1.2 by repalash (npm 2026-04-13; repo last push 2026-04-20, 190 stars, 12 forks, 1 issue/PR ever, 0 open) | this repo |
| wrapper repo | samdenty/html-in-canvas-polyfill: 3 commits, all on 2026-05-09, 2 stars, 0 issues | |
| npm downloads (2026-09-12 to 2026-10-11) | 58 (wrapper), 1,512 (three-html-render) | none yet (preview) |
| licence | MIT (both packages; bundles ts-browser-helpers 0.12.0, MIT) | MIT |
| runtime dependencies | `three-html-render` (optional peer: `three` >= 0.150, only for its Three.js renderer) | none |
| size (classic IIFE, minified) | `dist/polyfill.js` 29,684 B, gzip -9 9,712 B (ESM `polyfill.mjs` 37,039 B unminified / 10,713 gzip) | core 256,396 B, gzip -9 90,176 B |

## 2. Approach (read from `three-html-render/dist/polyfill.mjs`)

- Rendering: per drawn child, deep `cloneNode`, form state synced into the clone, all page stylesheets inlined (`cssRules`, external sheets re-fetched), `:hover/:focus/:active/:focus-visible/:focus-within` rewritten to classes toggled by event listeners, caret and selection drawn as injected `<div>`s, the whole thing serialised into an SVG `foreignObject` `data:` URL, decoded through `<img>`, drawn into one canvas per element at `devicePixelRatio`. Re-rasterises the whole element whenever the serialised SVG string changes (no dirty-region reuse). Same family of technique as ours (clone + foreignObject); ours keeps a retained surface and redraws changed regions.
- Live DOM: canvas children are moved into a `<div data-html-in-canvas-host>` appended to `<body>`, positioned over the canvas with `getBoundingClientRect` on scroll/resize; each child gets inline `position:absolute; left:0; top:0; opacity:0`. `canvas.children`, `appendChild`, `insertBefore`, `removeChild`, `contains` and node getters are patched so the move is mostly hidden.
- Hit testing: the browser's own, on the invisible live element at the host origin. The `x, y` passed to `drawElementImage` are NOT applied to the live element; the author must apply `canvas.getElementTransform(el, matrix)` (README) to align them.
- Paint: one rAF per canvas; `paint` (with `changedElements`) fires after the asynchronous rasterisation of all dirty children has finished. Triggers: ResizeObserver on the canvas, MutationObserver on the host, `input`/`change`/`selectionchange`, image `load`, a 500 ms caret-blink interval while an input is focused.
- Native detection: skips itself when `drawElementImage`, `requestPaint` and `onpaint` exist (`?polyfillHIC` or `force` overrides). `uninstallHtmlInCanvasPolyfill()` restores patched prototypes.

## 3. API surface

| item | competitor | ours |
|---|---|---|
| opt-in attribute | `layoutsubtree` only (+ `layoutSubtree` property). `content="drawable"`/`drawable` (current explainer, the pinned WPT, Chrome 157) are not recognised. | `content="drawable"` / `drawable` |
| `paint` event, `onpaint`, `requestPaint()`, `changedElements` | yes (async, after raster) | yes |
| `drawElementImage` | `(el, x, y)` and `(el, x, y, w, h)`; returns `DOMMatrix`. No source-rect (9-argument) overload. | all overloads (see docs/API-CONTRACT.md) |
| `captureElementImage`, `getElementTransform` | yes (returns its internal canvas / matrix) | see API-CONTRACT |
| `texElementImage2D` (WebGL1/2) | yes; crop and resize overloads log a warning and upload the full bitmap | yes |
| `GPUQueue.copyElementImageToTexture` (WebGPU) | yes (2 or 4 arguments) | yes |
| OffscreenCanvas / worker (`ElementImage`) | no | partial (WPT offscreen 1/8 files) |
| extras | Three.js `ThreeHTMLRenderer` (mesh textures, DOM overlay via `matrix3d`), WebXR examples, Chrome/Safari extension | frame cap, WebGPU effect-plugin host with input remapping |
| browsers (claimed) | Chrome, Edge, Safari, iOS Safari, Firefox, Android Chrome/WebView: "Full" (not verified here) | desktop Chrome, Firefox 155+, Safari 27+; mobile refused |
| documented limits | textarea inner scroll not reflected; no caret/selection in `contenteditable`; stylesheets added later need `invalidatePageStylesCss()`; `:visited` | docs/SUPPORT-MATRIX.md, docs/CONFORMANCE.md |

## 4. Official WPT subset (same runner, configuration B, its bundle instead of ours)

The repository's WPT runner (`test/wpt/`, configuration B) with the other package's bundle in place of ours; 230 files at WPT `d9b949e5`, 3 repetitions, worst repetition reported, a file passes only if all 3 pass (identical rules to ours).

| configuration | files passing | subtests passing |
|---|---|---|
| A native (Chrome 157.0.8099.0 + CanvasDrawElement) | 202 / 230 | 317 / 375 |
| B ours | 139 / 230 | 238 / 375 |
| competitor, verbatim (1 repetition) | 13 / 230 | 22 / 375 |
| competitor + attribute adapter (3 repetitions, 9 files unstable) | 66 / 230 | 83 / 375 |
| C no polyfill | 10 / 230 | 19 / 375 |

- Verbatim is almost the no-polyfill control because the tests use `content=drawable`. To measure the rendering engine anyway we wrote an adapter: it mirrors `content=drawable` to `layoutsubtree` when page script first touches the canvas, at DOMContentLoaded and on later mutations; plus a wrapper that defers the competitor's install until `<html>` exists, because the runner injects at document start and its install throws there (`MutationObserver.observe(document.documentElement)`). A first adapter that set the attribute while the canvas was still being parsed gave 68 / 86; both are reported for transparency.
- By directory (files, native / ours / competitor-adapted / none): top-level 105 / 73 / 37 / 9, privacy 84 / 42 / 27 / 0, hit-test 7 / 6 / 2 / 1, offscreen 6 / 1 / 0 / 0.
- Competitor-adapted passes 7 files that ours fails and native passes: `fullscreen-canvas`, `hit-test/selection`, `onpaint-fires-post-intersection-observation-steps`, `privacy/svg/svg-pattern-href-outside-subtree-ignored`, `privacy/svg/svg-pattern-outside-subtree-ignored`, `privacy/visited-link/visited-link-slotted-color-ignored`, `top-layer-not-painted-in-canvas` (at the time of this comparison; this polyfill has since been fixed to pass all seven, `onpaint-fires-post-intersection-observation-steps` included: a snapshot that loads at once is now painted after the frame computed its IntersectionObserver entries and before they are delivered). Ours passes 145 subtests the adapted competitor fails.

## 5. End-to-end gates (our gates run against the other bundle, without positive controls, one run each)

Checks that look for our internal layer (`hic-layer`) and "the API supports content=drawable" are ours-specific and excluded below. Pixel bounds were written for our polyfill against a plain-DOM twin; read the numbers, not only pass/fail. Our numbers: last recorded passing runs (2026-10-12, same machine, same gates, with controls).

| scenario | competitor (adapted unless said) | ours |
|---|---|---|
| explainer example verbatim (script-tag load, no adapter) | `paint` never fires: canvas stays blank (`content="drawable"` not recognised) | PASS |
| explainer, adapted: whole-surface diff vs plain DOM (delta > 16) | 0.89 % (passes the 3 % bound; fails the tight bound and the input region at 22 %) | PASS |
| explainer: hit testing | click on drawn input focuses it, but 4 of 8 edge probes hit a different element than the plain DOM (form drawn at x=100, live form left at x=0); dense variant: 65 of 80 probes differ and a click on the drawn input does not focus it | PASS (all probes) |
| explainer: keydown-to-canvas latency, text fits | p50 10.6 ms, p95 15.7 ms (30/30 trials) | p50 17.3 ms, p95 24.4 ms |
| explainer: same, text scrolls inside the field | p50 11.0 ms, p95 440 ms | p50 14.8 ms, p95 20.8 ms |
| explainer: blank frames around click + typing | 0 | 0 |
| water form (F1, 2D): rest whole-surface diff | 4.3 % (bound 3 %), 6 of 7 control regions over bound | PASS |
| F1: hit testing, checkbox, range, typing reaches live fields | all pass (form drawn at 0,0) | PASS |
| F1: typing latency | p50 14.0 ms, p95 617 ms (bound 100) | p50 18.9 ms, p95 24.8 ms |
| F1: caret blink in a focused `type=email` field | no blink on canvas | PASS |
| real window resize drag (4 drags, 809 frames) | 174 blank frames in 65 runs, longest 21 frames; final pixels 7.3 % / 7.7 % diff; click after resize lands correctly; layout converges | 0 blank frames; PASS |
| inner scroll (F2) | 0 blank frames; wheel/keyboard/Tab scroll the live list; after scrolling, the sticky-header region differs in 97 % of pixels and the header colour is absent from the canvas; `:hover` row colour not drawn; whole surface 11-15 % diff | PASS |

These runs had machine load above threshold (another process above 15 % CPU; load average below 4) and no positive control, so they are indicative, not gate-grade.

## 6. Where the competitor is ahead (measured or factual)

- About 8.9x smaller minified (29.7 KB vs 264 KB) and 9.5x smaller gzipped (9.7 KB vs 91.8 KB); published on npm and in use.
- Lower keystroke-to-canvas latency on the explainer while the text fits (p50 10.6 vs 17.3 ms).
- 7 WPT files pass that ours fails (listed above).
- Three.js integration, WebXR examples, a browser extension; claims mobile and WebView support (we refuse mobile; not verified here).

## 7. Reproduce

```sh
node test/bench/compare/competitor/build.mjs        # npm install of html-in-canvas-polyfill@1.0.1 into .scratch/, wrapper + adapter (test/bench/compare/competitor/adapter.js)
node test/bench/compare/competitor/wpt.mjs 3 1/4    # the WPT subset, configuration B, with that bundle; repeat for 2/4 .. 4/4
node test/gates/g-explainer.mjs --no-control --bundle-file=$PWD/.scratch/competitor/competitor-adapted.iife.js   # likewise g-f1-form, g-resize-drag, g-scroll-inner
```

The build script writes the package's own classic bundle byte for byte, wrapped and followed by the adapter; neither changes how the package renders. The performance side of the comparison is [PERFORMANCE-COMPARISON.md](PERFORMANCE-COMPARISON.md).
