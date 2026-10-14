# page-curl

An **example** effect plugin: the HTML drawn in a canvas becomes a sheet of paper you can take by a corner and turn. It shows how to use the effects extension of this library (`HTMLInCanvasEffects`, plugin ABI v2). It is **not part of the polyfill**: the polyfill, the frame cap and the effects host work without it, and nothing in `src/` imports it.

The effects host and this plugin are extensions of this library. They are not part of the HTML-in-Canvas proposal, and browsers' native implementations do not provide them ([docs/guides/EFFECTS-PLUGINS.md](../../docs/guides/EFFECTS-PLUGINS.md)).

![page-curl in the plugin gallery: the dog-ear peeks, a drag curls the live form in 3D while text is typed into it, the text appears mirrored through the back of the sheet; then the bottom-left corner](media/page-curl.webp)

## What it does

It applies to any drawable, with no change to the HTML: the gallery applies it to its form as it is.

- **A 3D sheet.** The page is folded along a straight line and rolled around a cylinder under the held corner: the part between the bound edge and the fold stays flat, the roll lifts, the part beyond it lies back side up, with the held corner exactly under the pointer. The sheet is bound along the edge opposite the corner (the left edge for a right-hand corner). Rolling a sheet around a cylinder never stretches it, so the paper keeps its proportions (the tests measure it). A long pull bows the sheet into a larger loop.
- **Seen and lit.** A camera straight above the page with a little perspective (a lifted point lands farther from the centre, the flat page is drawn one to one), one lamp from the upper left: the roll brightens where it faces the lamp and darkens where it turns away, paper lets a little warm light through, a soft sheen runs along the roll.
- **Shadows.** The lifted paper casts a soft shadow on the page underneath and on the flat part of the sheet, and its penumbra widens with the height of the paper above what it falls on (sharp where the roll meets the page, soft under the raised flap). A little light is trapped in the wedge between the roll and the page.
- **The back of the sheet is paper.** Cream paper with a fibre grain, and the page's content showing through it, soft and mirrored, as ink shows through real paper: text, borders and controls of the front darken the back where they lie, in the page's own polarity (light ink on a dark page, dark ink on a light one).
- **Live.** The sheet samples the live page every frame. Typing into a field while the page is held curled shows the text on the curling sheet (on its front, or mirrored through its back); the flat part stays usable at any time.
- **Physics-like follow.** The corner follows the pointer on a spring (it has a little weight) and springs back when released. The springs run in fixed steps on the frame clock, so a pose depends on the time only, at any frame cap.
- **Affordances.** At rest one corner (`corner`, else top-right) is a small dog-ear that peeks open by itself every `autoPeek` seconds until the first drag; hovering a corner lifts it further with a `grab` cursor (`grabbing` while dragging). The plugin's controls show the hint "Drag the top-right corner to turn the page (any corner works)".
- **The page underneath** is plain paper, faintly ruled (`under`): a plugin receives one source texture, so what lies beneath the sheet is not another live page.

## Input

The grab is the plugin's own gesture. Its pointer events are taken in the capture phase at the document, before the host's interposer and the form see them: `preventDefault` (no focus change, no text selection, no compatibility mouse events), `stopImmediatePropagation`, the pointer is captured to the live layer, and the click that follows the release is swallowed. The form never sees the drag; keyboard input still reaches the focused field.

Every other pointer goes through the host's interposer and this plugin's input mapper, `mapCurlPoint(state, point)`, the twin of what the shader draws, with the same camera:

| presented pixel shows | mapper returns |
|---|---|
| the flat part of the page | the same point (identity) |
| the front of the roll, where it faces the reader | the exact page point it shows (the line of sight is intersected with the cylinder; the nearest crossing inside the sheet is the one seen) |
| the back of the sheet (the roll, the folded flap, the dog-ear) | `NO_TARGET` |
| the page underneath | `NO_TARGET` |

`NO_TARGET` is the effects ABI value for "no element here" (`src/effects/no-target.js`, re-exported by this plugin): the host swallows a press there and the mapper chain stops at it. Touch: a touch drag on a corner may be claimed by the browser for scrolling (`pointercancel` releases the page); `touch-action: none` on the drawable keeps it for the plugin.

## Use

```html
<script src="dist/hic-live-polyfill.iife.min.js"></script>
<script src="dist/hic-live-effects.iife.min.js"></script>
<script src="dist/plugins/page-curl.iife.min.js"></script>   <!-- window.HicLivePlugins['page-curl'] -->
<script>
  const host = await HTMLInCanvasEffects.createHost(canvas, form, { interposer: true });
  const curl = await host.addPlugin(HicLivePlugins['page-curl'].plugin, { corner: 'any', radius: 48 });
  curl.mountUI(document.getElementById('controls'));   // the hint label, corner, roll and shadow controls
</script>
```

| option | | |
|---|---|---|
| `corner` | `'any'` (default), `'tl'`, `'tr'`, `'bl'`, `'br'` | which corners can be grabbed |
| `radius` | 4 to 200 CSS px, default 48 (slider 12 to 120) | roll radius; a long pull bows it up to 1.9 times larger; a short pull uses a tighter one (at most pull / pi) |
| `shadow` | 0 to 1, default 0.85 | strength of the shadows |
| `dogEar` | 0 to 120 CSS px, default 36 | how far the dog-eared corner is folded at rest (per axis); 0: no dog-ear |
| `autoPeek` | seconds, default 5; 0 or `false`: off | the dog-ear peeks open every `autoPeek` s until the first drag |
| `hotZone` | 16 to 200 CSS px, default 64 | grab distance from a corner |
| `under` | `'#rrggbb'`, default `#d1c9bb` | the page underneath |
| `paper` | `'#rrggbb'`, default `#f6f2e9` | the back of the sheet |

`prefers-reduced-motion: reduce`: the drag still curls the page (it follows the hand, without the spring's lag); the dog-ear stays still (no auto-peek); the release lays the page back at once and the hover lift appears without animation. Frames are requested only while something moves (drag, release, hover lift, an auto-peek); at rest the plugin costs nothing (one timer for the next auto-peek, until the first drag). After a GPU device loss the host re-creates the plugin with the same options; the gesture in progress is dropped and the page shows flat.

## How it is drawn

`page-curl.wgsl`, per curled frame, all on the GPU, nothing allocated per frame:

1. **The lifted paper as the lamp sees it** (half resolution, max blending): coverage and height of every point of the sheet more than 0.75 px above the page. Only when the fold moved.
2. **Two soft copies of it** (`blur.wgsl`, separable Gaussian, six passes): sigma about 4 and 24 CSS px. A receiver estimates the height of the paper above it and blends between them: contact hardening.
3. **The page underneath** (a full-screen pass) and **the sheet**: a triangle strip in the fold's own frame (rows of constant distance from the axis, one every 1.5 px or less across the roll), so the roll's silhouette runs along the rows and stays smooth; 4x MSAA with a depth buffer; the parts of the strip beyond the page are cut in the fragment shader, antialiased by alpha to coverage. The side the reader sees is the triangle's winding (stable where the normal is edge-on). The lifted paper is shaded by its own curvature only (its own half-resolution shadow would draw texels on it).

At rest without any curl (`dogEar: 0`) the pass draws the source unchanged.

## Measured

`test/page-curl-gpu.browser.test.mjs`, headless Chrome on an Apple M1 Max (Metal), 2200x1240 backing pixels (the gallery canvas at DPR 2), the page curled, while other work ran on the machine: 0.81 ms per frame submitted back to back (the one-sample template pass: 0.09 ms), a tenth of the 8.33 ms frame at 120 Hz. One run on one machine.

`test/gallery.e2e.mjs` (headless Chrome 155, trusted CDP input, the plugin gallery, 2026-10-14): 19 of 19 checks pass, among them: the hint names the top-right corner; the dog-ear is visible at rest and peeks open by itself (the paper area at the corner grows 24 times); hovering lifts it with a `grab` cursor; a drag of the dog-ear curls the page with a `grabbing` cursor while the form receives no pointer, mouse, click, focus or `selectstart` event and keeps its focus, value and empty selection; **typing while the page is held curled reaches the focused field and the typed text appears on the curled sheet, mirrored, away from where the field lies flat**; the release presents its animation and ends on the dog-ear; clicks map again; the auto-peek stops after the first drag; at frame cap 30 the drag is presented at 30 frames per second; with reduced motion the dog-ear is still and the release is immediate; no console error.

## Files

| file | |
|---|---|
| `index.js` | `meta`, `plugin`, the mapper `mapCurlPoint`, `poseState`, `foldSpan`, `stateOf`, `hotCorner`, `hintCorner`, `hintText`, `peekAt`, `rollFor`, `NO_TARGET`, `isNoTarget` |
| `fold.js` | the shape of the sheet as pure math (fold, normal, the corner's constraints, the camera, the spring) |
| `page-curl.wgsl`, `blur.wgsl` | the shaders; inlined into the built bundles |
| `wgsl.js` | loads the `.wgsl` files when the plugin runs from source; the build replaces it |
| `test/page-curl.test.mjs` | Node: the folder contract; the fold (an isometry, the corner under the pointer, the bound edge flat); the mapper against an independent forward rendering of the sheet (every point splatted through the camera into a z-buffer), 8 poses, every pixel; the grab (which events are taken); the spring that follows the pointer and settles with the corner under it; the release at 120/30/15 fps (the same pose at the same time); reduced motion; frozen mappers; no allocation per frame and the shadow passes only when the fold moved; the dog-ear, hover, grab cursor, auto-peek |
| `test/page-curl-gpu.browser.test.mjs` | headless Chrome, the real host: `checkMapperAgainstGpu` (identity as positive control), a pose 20 px away as wrong-mapper control, the corner seen under the pointer, the back of the sheet (paper, darker exactly over the mirrored markers of the source), the dog-ear, the spring back to the plain source, device loss, the GPU time |
| `test/gallery.e2e.mjs` | the gallery click-through with trusted input (`node plugins/page-curl/test/gallery.e2e.mjs [--record]`; `npm run test:plugins` runs every gallery e2e), which also records `media/page-curl.webp` |
| `media/page-curl.webp` | the recording above |
