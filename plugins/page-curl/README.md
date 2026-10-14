# page-curl

An **example** effect plugin: the HTML drawn in a canvas can be peeled like a book page by dragging one of its corners. At rest the top-right corner is a small dog-ear that now and then peeks open, so the page shows by itself that it can be grabbed. It shows how to use the effects extension of this library (`HTMLInCanvasEffects`, plugin ABI v2). It is **not part of the polyfill**: the polyfill, the frame cap and the effects host work without it, and nothing in `src/` imports it.

The effects host and this plugin are extensions of this library. They are not part of the HTML-in-Canvas proposal, and browsers' native implementations do not provide them ([docs/guides/EFFECTS-PLUGINS.md](../../docs/guides/EFFECTS-PLUGINS.md)).

![page-curl in the plugin gallery: the dog-ear, an auto-peek, the hover lift, a drag of the top-right corner and of the bottom-left one](media/page-curl.webp)

## What it does

- **Dog-ear**: at rest one corner (`hintCorner`: the corner named by `corner`, else top-right) is folded over by `dogEar` CSS px, showing the light back of the page. The plugin controls show the hint "Drag the top-right corner to peel the page (any corner works)", naming the dog-eared corner.
- **Auto-peek**: until the user's first drag, the dog-ear opens by itself, gently (1.8 s, up to 150 CSS px), 1.5 s after the first frame and then every `autoPeek` seconds. A timer wakes the host only for the next peek; the first drag ends it for good.
- **Hover**: over a hot zone (`hotZone` CSS px around a grabbable corner) the corner lifts further and the cursor becomes `grab` (`grabbing` while dragging).
- **Grab and curl**: a press in a hot zone starts a peel. The page is wrapped around a cylinder of radius `radius` lying on the page; the grabbed corner ends exactly under the pointer. The back of the page is paper (`paper`) with the front showing through it, mirrored; the top of the curl is shaded where it turns away from the light, and the curl casts a shadow on the page underneath (a ruled page in the colour `under`) and, around the folded flap, on the flat page.
- **Release**: the page springs back in 420 ms (ease-out), on the frame clock, so it ends at the same time whatever the frame cap; the dog-eared corner springs back to its dog-ear.
- **Not done**: turning the page over to reveal a second page. A plugin receives one source texture (the drawable the host was created with); a second page would need a host that hands a plugin a second drawable.

### Why "I don't notice anything" before (2026-10-14)

The drag itself worked, but nothing told the user it was there or made it stand out: the only affordance was a hover lift of about 19 CSS px per axis, mostly clipped by the 22 px rounded corner of the gallery canvas; nothing hinted where to drag (one grey line, "Drag a corner of the form to peel it"); and the curl was dark on dark (the back of the page was the form dimmed to 0.28 plus a dark tint, over a dark page underneath), so even a real peel read as a shadow. Now: the dog-ear, the auto-peek, a larger hover lift, the grab cursor, a prominent hint naming the corner, a light paper back side, a larger default radius (56) and stronger shadows (0.8).

## Input

The grab is the plugin's own gesture. Its pointer events are taken in the capture phase at the document, before the host's interposer and the form see them: `preventDefault` (no focus change, no text selection, no compatibility mouse events), `stopImmediatePropagation`, the pointer is captured to the live layer (the element pointer events land on, learned through `context.listen`; the canvas before any pointer reached it), and the click that follows the release is swallowed. The form never sees the drag.

The cursor: the plugin sets `data-hic-curl-cursor="grab"` (or `"grabbing"`) on the live layer, and a rule injected once (`[data-hic-curl-cursor=grab] * { cursor: grab !important }`) shows it over the form. The layer is a node of the polyfill, not of the drawable, so the attribute damages no snapshot.

Every other pointer goes through the host's interposer and this plugin's input mapper, `mapCurlPoint(state, point)`, the JavaScript twin of the region decision in `page-curl.wgsl`:

| presented pixel shows | mapper returns |
|---|---|
| the flat page | the same point (identity) |
| the front of the page on the lower half of the cylinder (a thin sliver) | the exact page point it shows |
| the back of the page (the folded flap, the top of the curl, the dog-ear) | `NO_TARGET` |
| the page underneath | `NO_TARGET` |

Touch: a touch drag on a corner may be claimed by the browser for scrolling (it sends `pointercancel`, which releases the page). Whether the page may scroll there is the page's decision: `touch-action: none` on the drawable keeps the drag for the plugin.

`NO_TARGET` is the effects ABI value for "no element here" (`src/effects/no-target.js`, re-exported by this plugin): the host swallows a press there, so it focuses nothing and activates nothing, and the mapper chain stops at it, so another spatial plugin earlier in the chain never clamps it back onto the canvas. At rest the mapper is the identity everywhere except on the dog-ear (a triangle of about `dogEar` CSS px at the dog-eared corner, `NO_TARGET`: what the user sees there is the back of the page; a press there is the grab anyway). With `dogEar: 0` and `autoPeek: 0` the page lies flat at rest and the mapper is the identity everywhere, hot zones included.

## Use

```html
<script src="dist/hic-live-polyfill.iife.min.js"></script>
<script src="dist/hic-live-effects.iife.min.js"></script>
<script src="dist/plugins/page-curl.iife.min.js"></script>   <!-- window.HicLivePlugins['page-curl'] -->
<script>
  const host = await HTMLInCanvasEffects.createHost(canvas, form, { interposer: true });
  const curl = await host.addPlugin(HicLivePlugins['page-curl'].plugin, { corner: 'any', radius: 56 });
  curl.mountUI(document.getElementById('controls'));   // the hint label, corner, radius and shadow controls
</script>
```

| option | | |
|---|---|---|
| `corner` | `'any'` (default), `'tl'`, `'tr'`, `'bl'`, `'br'` | which corners can be grabbed |
| `radius` | 4 to 200 CSS px, default 56 (slider 12 to 140) | cylinder radius (a short pull uses a thinner one, at most distance / pi) |
| `shadow` | 0 to 1, default 0.8 | strength of the shadows |
| `dogEar` | 0 to 120 CSS px, default 40 | how far the dog-eared corner is folded at rest (per axis); 0: no dog-ear |
| `autoPeek` | seconds, default 5; 0 or `false`: off | the dog-ear peeks open every `autoPeek` s until the first drag |
| `hotZone` | 16 to 200 CSS px, default 64 | grab distance from a corner |
| `under` | `'#rrggbb'`, default `#0e1b29` | colour of the page underneath |
| `paper` | `'#rrggbb'`, default `#62a9c4` | colour of the back of the page (its red stays under the GPU oracle's "bright" threshold, so the back is never mistaken for the front) |

`prefers-reduced-motion: reduce`: the drag still peels (it follows the hand), the dog-ear stays still (no auto-peek), the release lays the page back at once and the hover lift appears without animation. Frames are requested only while something moves (drag, release, hover lift, an auto-peek); at rest the plugin costs nothing (one timer for the next auto-peek, until the first drag). Per frame the render path allocates nothing (one uniform array, one reused pass descriptor; mappers are copied into 4 preallocated slots). After a GPU device loss the host re-creates the plugin with the same options; the gesture in progress, if any, is dropped and the page shows flat.

## Measured

`test/page-curl-gpu.browser.test.mjs`, headless Chrome on an Apple M1 Max (Metal), 2200x1240 backing pixels (1100x620 CSS px at DPR 2), the page curled, while other work ran on the machine: 0.09 ms per frame submitted back to back, the same as the one-sample template pass (0.09 ms); 1 % of the 8.33 ms frame at 120 Hz. Per-pass timestamps on this GPU come in ~66 µs steps and read about 1.2 ms for any full-screen-triangle pass, the template's included, so the back-to-back figure is the one to read. Headless Chrome presents at most 60 frames per second, so the 120 Hz budget was checked as GPU time per frame, not as presented frames.

`test/gallery.e2e.mjs` (headless Chrome 155, trusted CDP input, the plugin gallery, 2026-10-14): 19 of 19 checks pass. Among them: the hint label names the top-right corner; the dog-ear is visible at rest and, with no input, peeks open by itself (the paper area at the corner grows 17 times); hovering the corner lifts it further with a `grab` cursor; a one-second drag of the dog-ear peels the page with a `grabbing` cursor and the form receives no pointer, mouse, click, focus or `selectstart` event and keeps its focus, value and (empty) selection; the release presents 28 animation frames and ends on the dog-ear; after the first drag no frame is presented for 5.6 s (the auto-peek stopped); at frame cap 30 the drag is presented at 30 frames per second; with reduced motion the dog-ear is still (no frame in 3.5 s) and the release presents no animation frame.

Headed check (one real Chrome 155 window, DPR 2, 2026-10-14): a trusted CDP drag from the top-right corner at human speed (70 moves 16 ms apart). The screenshots mid-drag show the page peeled across half the form, the paper back with the form mirrored through it ("60 fps", ".com") and the shadow on the ruled page underneath; the cursor was `grab` on hover and `grabbing` during the drag; the form saw only the hover moves before the press (no `pointerdown`, `pointerup`, `click`, `focus` or selection), the name field kept the focus and its value; after the release a click focused the email field and typing reached it.

## Files

| file | |
|---|---|
| `index.js` | `meta`, `plugin`, the mapper `mapCurlPoint`, `curlGeometry`, `hotCorner`, `hintCorner`, `hintText`, `peekAt`, `NO_TARGET`, `isNoTarget` |
| `page-curl.wgsl` | the shader; inlined into the built bundles |
| `wgsl.js` | loads the `.wgsl` file when the plugin runs from source; the build replaces it |
| `test/page-curl.test.mjs` | Node: the folder contract, the geometry, the mapper against an independent port of the shader's region decision on every pixel, the grab (which events are taken), the release at 120/30/15 fps, reduced motion, no allocation per frame; the dog-ear at rest, the hover lift and the grab / grabbing cursor, the release back to the dog-ear, the auto-peek schedule and its end at the first drag |
| `test/page-curl-gpu.browser.test.mjs` | headless Chrome: `checkMapperAgainstGpu` (with the identity mapper as positive control), a mapper of a pose 20 px away as wrong-mapper control, the back of the page (paper, the source mirrored through it) pixel by pixel, the dog-ear at rest, the release, the GPU time |
| `test/gallery.e2e.mjs` | the gallery click-through with trusted input (`node plugins/page-curl/test/gallery.e2e.mjs [--record]`; `npm run test:plugins` runs every gallery e2e), which also records `media/page-curl.webp`; shared steps in `plugins/_shared/gallery-e2e.mjs` |
| `media/page-curl.webp` | the recording above (headless Chrome, the plugin gallery, `--record`: the dog-ear, an auto-peek, the hover, a drag of the top-right and of the bottom-left corner) |
