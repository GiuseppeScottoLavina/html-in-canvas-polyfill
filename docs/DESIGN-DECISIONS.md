# Design decisions

The choices a reader needs to understand this polyfill, each with its reason. The detailed design, with the alternatives that were rejected, is in [ARCHITECTURE.md](ARCHITECTURE.md); the public behaviour is in [API-CONTRACT.md](API-CONTRACT.md).

### 1. The real DOM stays live; the browser paints it

Browsers do not lay out the children of a `<canvas>`, so the polyfill moves them into an invisible layer next to the canvas, positioned over its content box. The browser lays out, focuses, scrolls, hit-tests and edits that DOM (keyboard, IME, accessibility) as usual. An earlier approach re-implemented CSS painting in JavaScript: its pictures differed from the plain DOM in 11 to 18 % of pixels and it had no `:hover` or keyboard scrolling. Letting the browser's own engine rasterise removes that whole class of fidelity bugs.

### 2. Pictures come from an SVG `foreignObject`

The only way a page can make the browser rasterise HTML into pixels it can draw is an SVG image with a `foreignObject`. The polyfill clones the changed part of a drawable with its live state (input values, checked states, scroll offsets, focus and hover as classes), inlines the CSS it needs, serialises it into an SVG document and decodes it as an image. The explainer example and the form fixtures differ from the plain DOM in 0 to 0.4 % of pixels.

### 3. `data:` URLs, never `blob:`

A `blob:` SVG image taints every canvas sink on Chrome and Safari; a `data:` URL drawn into a 2D canvas does not. `copyExternalImageToTexture` and `createImageBitmap` of a `foreignObject` image throw `SecurityError` on Chrome, so WebGL and WebGPU uploads read the 2D surface instead (one GPU copy per call). `scripts/check-repo.mjs` fails the build if `blob:` appears in `src/`.

### 4. One retained surface per drawable

Each drawable has a retained 2D canvas with immutable versions; a new picture is committed atomically when it has been decoded, and the old one stays visible until then. That is why a window resize shows no blank frame (0 of 3127 sampled frames), and why `drawElementImage` can draw synchronously inside `paint`.

### 5. Native first

`install()` detects the native API by behaviour, not by browser name or version, and decides on the core only: `content="drawable"` (or the earlier `layoutsubtree`), the `paint` event handler and a 2D `drawElementImage` that behaves like a platform method. A browser with that core is never refused: whatever secondary members it lacks, renames or adds, the polyfill patches nothing of the standard surface, steps aside and records what differs in `report()`. The specification still moves (on 2026-10-08 `ElementImage.width/height` became `canvas.getElementImageDefaultSize()`), and an earlier preview that required the old members refused Chrome Canary 157 and would have thrown on a shipping Chrome; deciding on the core is what keeps a page working when the browser is ahead of, or behind, the polyfill. The optional native-bridge bundle adds what it can build from public native API (the `content` attribute over the earlier `layoutsubtree` draft of Chrome 154 and 155, the size getter, event names); without it such a build is used as found. Only a native implementation without its core is refused, because it can neither run the API nor be replaced safely. The two extensions (decision 11) run in mode `native` too. Install is synchronous, so the API exists before any page script reads it.

### 6. Paint is asynchronous: one to two frames behind the DOM

A snapshot has to be cloned, serialised, parsed, laid out and decoded by the browser (`Image.decode()` is asynchronous) before it can be drawn. `paint` fires at the end of the frame (the ResizeObserver slot, after app rAF callbacks and layout) and only when every drawable has a picture, so a draw inside `paint` never throws for lack of a snapshot. A `canvas.width` write redraws in the same frame from the retained surface. On Chromium a snapshot whose image loads at once (no font or image still to fetch) is painted where it lands: in the first frame for the first paint of a canvas, and for a later change in a high-priority task right after the frame, so a change is usually painted one frame after it was made. The promise is an effect at the display rate over a source that updates at 30 to 60 Hz, not a 120 Hz source.

### 7. Snapshots are built after the frame

The expensive part of a snapshot runs in a task after the rendering update, so it does not delay the frame being produced. Resize and DPR changes, the first snapshot of a canvas and the first step of a scroll are built inside the frame instead, where a task would land one frame late.

### 8. Typed text is drawn at once

For a focused single-line text field, each keystroke is drawn into the retained surface immediately with `fillText`, from the live field's font, colour, alignment and scroll offset; the next snapshot replaces it. Keydown to canvas pixel is then 5.3 ms p50 against 5.2 ms natively, instead of a full snapshot round trip (15 to 18 ms).

### 9. Inner scrolling is composed from cached pages

A scroll step does not rebuild the scroller: it composes pages of the scrollport rendered at other offsets, plus sticky elements from their own tiles, in the step's own frame; the exact picture follows when scrolling settles. Wheel to pixel went from 51.5 ms to 28.5 ms p50, and is 27.7 ms in the current comparison (native: 36.5 ms, which includes Chrome's smooth-scroll animation). Chromium and WebKit compose (WebKit on its 1 css px layout grid, a rounded port only over an opaque scroller); Gecko composes at whole-pixel offsets, only at a device pixel ratio of 1 (its SVG images lay out with 1x font metrics) only square scrollers and only content whose painting a clip edge does not change (no rounded corners, dotted lines, transforms, images, SVG or form controls), and rebuilds every other step. On WebKit, under a scripted 60 Hz scroll, it raised the canvas updates per second from about 30 to 59 on the scroll-and-resize example and from about 25 to 59 on F2 (desktop Safari 27, DPR 2), and from 30 to 58 on that example on the iOS Simulator (which runs on the Mac's CPU).

The canvas can only follow the scroll offset the main thread sees, and during a trackpad scroll Chromium delivers it in every second frame once the page draws per scroll step (its compositor then favours its own latency). While a live scroller is under the pointer or scrolls, the polyfill gives it an invisible main-thread repaint reason, as the scrollers inside a native drawable have, and the compositor waits for each frame: a 300-row list went from 61 to 113 canvas updates per second (native 116), a 2000-row list from 4 to 95. Pages are planned when the pointer reaches a scroller, a change elsewhere in the drawable keeps them, a change inside the list (a hovered row) is repaired from the next tile, and rounded scrollports are composed inside their rounded clip.

### 10. Form controls on Firefox and Safari are drawn by the polyfill

Gecko does not theme form controls inside an SVG image, and WebKit draws them in its legacy look and ignores `accent-color` there. On those engines an opt-in bundle (`hic-live-engines`) draws checkboxes, radios, ranges, buttons, fields and scrollbars in the engine's own measured look. Chromium draws them itself, so this code stays out of the Chrome core.

### 11. Frame cap and effect plugins are extensions

`framecap` / `frameCap` bounds `paint` events, effect frames and snapshot builds per canvas, paced by a phase accumulator and judged by an independent clock in the gates. The effect host runs WebGPU plugins over the drawn source; a plugin that moves pixels supplies a pure input mapper, so clicks reach the element the user sees. Both are extensions of this library: they are not part of the HTML-in-Canvas proposal and native implementations do not provide them. They run over the polyfill and over a native implementation the polyfill steps aside for: there the host reads the source with the standard `GPUQueue.drawElementImageToTexture` and remaps input by moving the standard hit-test geometry (`updateElementGeometry`) under the pointer, so the browser's own hover, focus and caret follow what the user sees (`docs/API-CONTRACT.md` 7.6). They may change between previews. The plugins themselves are not part of the library: the example plugins live in `plugins/`, one self-contained folder each, built into their own bundles.

### 12. What is refused, and why

Refusals are loud: one console message and a `report()` entry, never a silent gap. Content the polyfill cannot capture is a hatched placeholder; content the platform itself leaves out of a canvas is drawn as the platform draws it (measured against the native implementation), so a page looks the same with and without native support.

- Cross-origin (or sandboxed) iframes, `<object>`, `<embed>`: their document cannot be read. The element's own box (border, background) is drawn without the document, as natively. A same-origin frame's document is drawn as a nested image of its own (its CSS stays inside it) and repaints when it changes; an `<object>` or `<embed>` that shows a readable image draws the image.
- Cross-origin images, fonts and CSS without CORS: SVG images cannot load external resources, and the read-back rules of the standard forbid leaking them. As natively, an image element keeps its box without the picture, a filter that would draw such an image is not applied, an element whose mask image cannot be read is masked away (on SVG content the mask is ignored), a cross-origin video is an invisible box and a cross-origin SVG `<use>` document draws nothing.
- Workers: no browser rasterises `foreignObject` in a worker, and a userland `ElementImage` cannot be Transferable. A dedicated worker that loads the worker bundle receives the snapshot's pixels in its place and draws them, with the geometry sent back to the page; other message carriers refuse it (use `toImageBitmap()`).
- Chrome before 130, Firefox before 155, Safari before 27 (before 26 on iOS and iPadOS): not measured, and the required platform features (CSS anchor positioning, `ResizeObserver`, `HTMLImageElement.decode`, constructable stylesheets) have no fallback. Android WebView and in-app iOS web views: their engine and flags belong to the app. Firefox for Android: never measured. Chrome for Android 130+ and Safari on iOS / iPadOS 26+ are admitted (verified on simulators and emulators only).
- Native UI is not part of any picture: select popups, date pickers, autofill, IME composition UI.

### 13. Small, dependency-free, no network on load

No runtime dependencies; the bundles make no network request when they load (snapshots fetch same-origin or CORS resources only to inline them). Modules talk only through typed interfaces (`src/contracts/`), at most 1000 code lines per file, enforced by `npm run lint`. The cost is a large core: about 114.5 KB gzipped (339 KB minified), over the original 150 KB minified target (`docs/BUNDLES.md`).
