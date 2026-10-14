# page-curl

An **example** effect plugin: the HTML drawn in a canvas can be peeled like a book page by dragging one of its corners. It shows how to use the effects extension of this library (`HTMLInCanvasEffects`, plugin ABI v2). It is **not part of the polyfill**: the polyfill, the frame cap and the effects host work without it, and nothing in `src/` imports it.

The effects host and this plugin are extensions of this library. They are not part of the HTML-in-Canvas proposal, and browsers' native implementations do not provide them ([docs/guides/EFFECTS-PLUGINS.md](../../docs/guides/EFFECTS-PLUGINS.md)).

![page-curl in the plugin gallery](media/page-curl.webp)

## What it does

- **Grab**: a press within `hotZone` CSS px of a corner (all four, or the one named by `corner`) starts a peel. Hovering a hot zone lifts the corner a little, so the user can see that it can be grabbed.
- **Curl**: the page is wrapped around a cylinder of radius `radius` lying on the page; the grabbed corner ends exactly under the pointer. The back of the page shows the page mirrored and dimmed, the top of the curl is shaded where it turns away from the light, and the curl casts a shadow on the page underneath (a plain ruled page in the colour `under`) and, around the folded flap, on the flat page.
- **Release**: the page springs back to flat in 420 ms (ease-out), on the frame clock, so it ends at the same time whatever the frame cap.
- **Not done**: turning the page over to reveal a second page. A plugin receives one source texture (the drawable the host was created with); a second page would need a host that hands a plugin a second drawable.

## Input

The grab is the plugin's own gesture. Its pointer events are taken in the capture phase at the document, before the host's interposer and the form see them: `preventDefault` (no focus change, no text selection, no compatibility mouse events), `stopImmediatePropagation`, the pointer is captured to the canvas, and the click that follows the release is swallowed. The form never sees the drag.

Every other pointer goes through the host's interposer and this plugin's input mapper, `mapCurlPoint(state, point)`, the JavaScript twin of the region decision in `page-curl.wgsl`:

| presented pixel shows | mapper returns |
|---|---|
| the flat page | the same point (identity) |
| the front of the page on the lower half of the cylinder (a thin sliver) | the exact page point it shows |
| the back of the page (the folded flap, the top of the curl) | `NO_TARGET` |
| the page underneath | `NO_TARGET` |

Touch: a touch drag on a corner may be claimed by the browser for scrolling (it sends `pointercancel`, which releases the page). Whether the page may scroll there is the page's decision: `touch-action: none` on the drawable keeps the drag for the plugin.

`NO_TARGET` is the effects ABI value for "no element here" (`src/effects/no-target.js`, re-exported by this plugin): the host swallows a press there, so it focuses nothing and activates nothing, and the mapper chain stops at it, so another spatial plugin earlier in the chain never clamps it back onto the canvas. When the page lies flat (at rest, or once the release ends) the mapper is the identity everywhere, hot zones included.

## Use

```html
<script src="dist/hic-live-polyfill.iife.min.js"></script>
<script src="dist/hic-live-effects.iife.min.js"></script>
<script src="dist/plugins/page-curl.iife.min.js"></script>   <!-- window.HicLivePlugins['page-curl'] -->
<script>
  const host = await HTMLInCanvasEffects.createHost(canvas, form, { interposer: true });
  const curl = await host.addPlugin(HicLivePlugins['page-curl'].plugin, { corner: 'any', radius: 36 });
  curl.mountUI(document.getElementById('controls'));   // corner, radius and shadow controls
</script>
```

| option | | |
|---|---|---|
| `corner` | `'any'` (default), `'tl'`, `'tr'`, `'bl'`, `'br'` | which corners can be grabbed |
| `radius` | 4 to 160 CSS px, default 36 | cylinder radius (a short pull uses a thinner one, at most distance / pi) |
| `shadow` | 0 to 1, default 0.6 | strength of the shadows |
| `hotZone` | 16 to 200 CSS px, default 64 | grab distance from a corner |
| `under` | `'#rrggbb'`, default `#0e1b29` | colour of the page underneath |

`prefers-reduced-motion: reduce`: the drag still peels (it follows the hand), the release lays the page flat at once and the hover lift appears without animation. Frames are requested only while something moves (drag, release, hover lift); at rest the plugin costs nothing. Per frame the render path allocates nothing (one uniform array, one reused pass descriptor; mappers are copied into 4 preallocated slots). After a GPU device loss the host re-creates the plugin with the same options; the gesture in progress, if any, is dropped and the page shows flat.

## Measured

`test/page-curl-gpu.browser.test.mjs`, headless Chrome on an Apple M1 Max (Metal), 2200x1240 backing pixels (1100x620 CSS px at DPR 2), the page curled, while other work ran on the machine: 0.09 ms per frame submitted back to back, the same as the one-sample template pass (0.09 ms); 1 % of the 8.33 ms frame at 120 Hz. Per-pass timestamps on this GPU come in ~66 µs steps and read about 1.2 ms for any full-screen-triangle pass, the template's included, so the back-to-back figure is the one to read. Headless Chrome presents at most 60 frames per second, so the 120 Hz budget was checked as GPU time per frame, not as presented frames.

`test/gallery.e2e.mjs` (headless Chrome 155, trusted CDP input, the plugin gallery): 13 of 13 checks pass. Among them: during a corner drag and its release the form receives no pointer, mouse, click, focus or `selectstart` event and keeps its focus, value and (empty) selection; after the release a click focuses the field under it; the release presents 26 animation frames and ends on the flat picture; at frame cap 30 the drag is presented at 30.5 frames per second; with reduced motion the release presents no animation frame.

## Files

| file | |
|---|---|
| `index.js` | `meta`, `plugin`, the mapper `mapCurlPoint`, `curlGeometry`, `hotCorner`, `NO_TARGET`, `isNoTarget` |
| `page-curl.wgsl` | the shader; inlined into the built bundles |
| `wgsl.js` | loads the `.wgsl` file when the plugin runs from source; the build replaces it |
| `test/page-curl.test.mjs` | Node: the folder contract, the geometry, the mapper against an independent port of the shader's region decision on every pixel, the grab (which events are taken), the release at 120/30/15 fps, reduced motion, no allocation per frame |
| `test/page-curl-gpu.browser.test.mjs` | headless Chrome: `checkMapperAgainstGpu` (with the identity mapper as positive control), a mapper of a pose 20 px away as wrong-mapper control, the back of the page pixel by pixel, the release, the GPU time |
| `test/gallery.e2e.mjs` | the gallery click-through with trusted input (`node plugins/page-curl/test/gallery.e2e.mjs [--record]`; `npm run test:plugins` runs every gallery e2e), which also records `media/page-curl.webp`; shared steps in `plugins/_shared/gallery-e2e.mjs` |
| `media/page-curl.webp` | the recording above (headless Chrome, the plugin gallery) |
