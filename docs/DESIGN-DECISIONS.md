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

`install()` detects the native API by behaviour, not by browser name or version, and decides on the core only: `content="drawable"` (or the earlier `layoutsubtree`), the `paint` event handler and a 2D `drawElementImage` that behaves like a platform method. A browser with that core is never refused: whatever secondary members it lacks, renames or adds, the polyfill patches nothing of the standard surface, steps aside and records what differs in `report()`. The specification still moves (on 2026-10-08 `ElementImage.width/height` became `canvas.getElementImageDefaultSize()`), and an earlier preview that required the old members refused Chrome Canary 157 and would have thrown on a shipping Chrome; deciding on the core is what keeps a page working when the browser is ahead of, or behind, the polyfill. The optional native-bridge bundle adds what it can build from public native API (the `content` attribute over the earlier `layoutsubtree` draft of Chrome 154 and 155, the size getter, event names); without it such a build is used as found. Only a native implementation without its core is refused, because it can neither run the API nor be replaced safely. The two extensions (decision 11) are not supported in mode `native`. Install is synchronous, so the API exists before any page script reads it.

### 6. Paint is asynchronous: about two frames behind the DOM

A snapshot has to be cloned, serialised, parsed, laid out and decoded by the browser (`Image.decode()` is asynchronous) before it can be drawn. `paint` fires at the end of the frame (the ResizeObserver slot, after app rAF callbacks and layout) and only when every drawable has a picture, so a draw inside `paint` never throws for lack of a snapshot. A `canvas.width` write redraws in the same frame from the retained surface. On Chromium a snapshot whose image loads at once (no font or image still to fetch) is painted where it lands: in the first frame for the first paint of a canvas, and for a later change in a high-priority task right after the frame, so a change is usually painted one frame after it was made. The promise is an effect at the display rate over a source that updates at 30 to 60 Hz, not a 120 Hz source.

### 7. Snapshots are built after the frame

The expensive part of a snapshot runs in a task after the rendering update, so it does not delay the frame being produced. Resize and DPR changes, the first snapshot of a canvas and the first step of a scroll are built inside the frame instead, where a task would land one frame late.

### 8. Typed text is drawn at once

For a focused single-line text field, each keystroke is drawn into the retained surface immediately with `fillText`, from the live field's font, colour, alignment and scroll offset; the next snapshot replaces it. Keydown to canvas pixel is then 5.3 ms p50 against 5.2 ms natively, instead of a full snapshot round trip (15 to 18 ms).

### 9. Inner scrolling is composed from cached pages

A scroll step does not rebuild the scroller: it composes pages of the scrollport rendered at other offsets, plus sticky elements from their own tiles, in the step's own frame; the exact picture follows when scrolling settles. Wheel to pixel went from 51.5 ms to 28.5 ms p50 (native: 36.5 ms, which includes Chrome's smooth-scroll animation).

### 10. Form controls on Firefox and Safari are drawn by the polyfill

Gecko does not theme form controls inside an SVG image, and WebKit draws them in its legacy look and ignores `accent-color` there. On those engines an opt-in bundle (`hic-live-engines`) draws checkboxes, radios, ranges, buttons, fields and scrollbars in the engine's own measured look. Chromium draws them itself, so this code stays out of the Chrome core.

### 11. Frame cap and effect plugins are extensions

`framecap` / `frameCap` bounds `paint` events, effect frames and snapshot builds per canvas, paced by a phase accumulator and judged by an independent clock in the gates. The effect host runs WebGPU plugins over the drawn source; a plugin that moves pixels supplies a pure input mapper, so clicks reach the element the user sees. Both are extensions of this library: they are not part of the HTML-in-Canvas proposal, native implementations do not provide them, and they are supported only while the polyfill provides the API (mode `polyfill`). On top of a native implementation the frame cap property is absent and input is not remapped (`docs/guides/EFFECTS-PLUGINS.md`). They may change between previews. The plugins themselves are not part of the library: the example plugins live in `plugins/`, one self-contained folder each, built into their own bundles.

### 12. What is refused, and why

Refusals are loud: a hatched placeholder, one console message and a `report()` entry, never a silent gap.

- Iframes, `<object>`, `<embed>`: a child browsing context cannot be serialised into a `foreignObject`.
- Cross-origin images, fonts and CSS without CORS: SVG images cannot load external resources, and the read-back rules of the standard forbid leaking them.
- Workers: no browser rasterises `foreignObject` in a worker, and a userland `ElementImage` cannot be transferable (use `toImageBitmap()`).
- Mobile browsers, WebViews, Firefox before 155 and Safari before 27: not measured, and the required platform features (CSS anchor positioning, `ResizeObserver`, `HTMLImageElement.decode`, constructable stylesheets) have no fallback.
- Native UI is not part of any picture: select popups, date pickers, autofill, IME composition UI.

### 13. Small, dependency-free, no network on load

No runtime dependencies; the bundles make no network request when they load (snapshots fetch same-origin or CORS resources only to inline them). Modules talk only through typed interfaces (`src/contracts/`), at most 1000 code lines per file, enforced by `npm run lint`. The cost is a large core: about 96 KB gzipped, over the original 150 KB minified target (`docs/BUNDLES.md`).
