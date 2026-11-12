# cloth

The HTML drawn in a canvas is printed on a sheet of fabric that hangs from its top edge in front of a wall. At rest it hangs flat and the frame is the page itself, pixel for pixel, with nothing rendered. A moving pointer pushes a dent into it, a press that moves takes hold of it and pulls it, a gust billows it, and it swings back and settles; the form on it stays live the whole time, and a click reaches the field the user sees.

An **example** effect plugin of this library, not part of the polyfill: nothing in `src/` imports it, and the polyfill, the frame cap and the effects host work without it. The effects host and its plugins are extensions of this library, not part of the HTML-in-Canvas proposal; native implementations do not provide them ([details](../../docs/guides/EFFECTS-PLUGINS.md#extensions-not-the-standard)). Like the host, it is **experimental** ([STABILITY.md](../../docs/STABILITY.md)): its options, actions and look may change in any minor release.

![cloth in the plugin gallery: a gust billows the live form and it settles, a drag lifts the cloth by its hem while text is typed into it, released it swings back, the pins let go and the cloth falls away, and it is hung again](media/cloth.webp)

Recorded in headless Chrome from the plugin gallery (`node plugins/cloth/test/gallery.e2e.mjs --record-only`). The same test writes the README's hero with `--hero` and the still picture of the examples' landing page with `--landing`.

## What it does

It applies to any drawable, with no change to the HTML.

- **A simulated cloth.** About 1,040 cells of particles (43 x 24 on the gallery's canvas; the grid follows the shape of the canvas), advanced 480 times a second on the frame clock by a position-based solver (`sim.js`). Each thread of the weave is solved as a whole, as a tridiagonal system (one Newton step of all its links together), so the cloth does not stretch under its own weight or in a hand: its most stretched thread is 0.2 % longer in a gust of strength 1, 0.3 % in the strongest one, and about 2 % at the worst moment of a hard pull (the tests hold the last two under 4 % and 6 %). A thread pulls but hardly pushes (a compressed link gives a quarter of the push that would keep its length): threads buckle, they are not rods. The diagonals of each cell are compliant (woven cloth shears easily), and bending acts on the second difference of each thread, which resists the shortest buckle of the grid most, so no wrinkle is ever one cell wide. Tethers to the pins (Kim et al., "Long Range Attachments") make the flat hanging pose an exact fixed point of the step.
- **The cloth does not pass through itself.** At the end of every step, any two particles closer than the spacing of the grid (the two ends of a link: closer than 0.6 of its length) are moved apart, found through a hash of the columns they stand in. A particle then never lies in a cell of another part of the sheet, nor does a link, and the drawn surface, an average of the particles, keeps its layers apart too: where the cloth lies over itself it is one spacing thick (26 CSS px on the gallery's canvas). The hand's force is bounded so that in one step it moves what it holds at most a sixth of that gap beyond its course: a fast flick cannot press a crumpled patch through itself. The test drags the cloth fast and wide across itself (lower third sideways, the hem up and across, a corner diagonally, at 120 and at 30 pointer events a second) and finds no frame in which the drawn sheet crosses itself; with this step switched off, most frames do. Without it, a brisk pull showed the part of the cloth that should be hidden through the part in front of it, in holes and seams.
- **Physical numbers.** Gravity is 13 canvas heights per second squared: the cloth swings like a sheet about 0.75 m tall, with the period of the first mode of a hanging sheet, 5.23 sqrt(height / g) = 1.45 s (the simulation: 1.46 s). The air resists motion along the surface normal most; a wall 8.5 % of the canvas's smaller side behind the cloth stops it, with friction.
- **The same motion at every frame rate.** A frame shows the cloth between its last two steps (interpolated by the time since the last step), so at 30, 60 and 120 frames per second the cloth is in the same place at the same instant (the tests: within 0.001 px).
- **A smooth surface.** The particles are the control points of a bicubic B-spline surface, evaluated on the GPU at 4 x 4 vertices per cell with its analytic tangents and second derivatives: normals and curvature are continuous, the grid of the simulation never shows, and flat control points give the flat page exactly.
- **Light.** One lamp up and to the left, raking across the cloth, and the light of the room. The page is the cloth's albedo, decoded from sRGB, lit in linear light and encoded again. The lamp's light wraps a little round the folds; the fibres add a sheen (Estevez and Kulla's distribution for the fuzz of the fibres, a broad GGX lobe for the threads, Neubelt's visibility term), woven thread by thread where a pixel is fine enough to show it; the room's light does not reach into concave folds (the mean curvature of the surface); and the cloth casts the lamp's shadow on itself and on the wall (a variance shadow map of the cloth as the lamp sees it, blurred to a narrow penumbra for what is close and a wide one for the wall). Even the darkest print scatters a few percent of the light, so the folds show on a black page too. Everything is relative to the flat pose: where the cloth hangs flat its light is exactly 1 and its sheen exactly 0.
- **Text that does not flicker.** The source has no mip levels. The page is filtered over the footprint of each pixel (up to 6 x 2 taps along the footprint's axes where the cloth is seen at a slant), and every tap is bilinear in linear light: a thin bright line keeps its energy wherever it falls between two texels, instead of dimming by half in between as a filter over sRGB-encoded values makes it. 4x MSAA with a depth buffer antialiases the silhouette and the folds that lie over each other.
- **Two sides.** The back of the cloth is linen with the print soaked through, lit by the dimmer room behind it and by the lamp's light that comes through the weave.
- **Live.** The cloth samples the live page every frame: typing into a field shows on the cloth while it is held or hangs in folds.
- **Zero work at rest.** Once the motion has died out the cloth is drawn onto the flat pose over the last 0.4 px and snapped to it below 0.012 px; from then on the pass is one full-screen copy of the page, only when the page changes: no frame, no timer, no animation frame of its own. Held by two corners (`pins: 'corners'`) it comes to rest in its folds and is drawn again only when the page changes.

## Usage

```html
<script src="dist/hic-live-polyfill.iife.min.js"></script>
<script src="dist/hic-live-effects.iife.min.js"></script>
<script src="dist/plugins/cloth.iife.min.js"></script>   <!-- window.HicLivePlugins.cloth -->
<script type="module">
  const host = await HTMLInCanvasEffects.createHost(canvas, form, { interposer: true });
  const cloth = await host.addPlugin(HicLivePlugins.cloth.plugin, { weight: 0.5, sheen: 0.5 });
  cloth.mountUI(document.getElementById('controls'));            // weight, wind, sheen, pins, Gust, Drop
  await cloth.trigger('gust', { direction: 0, strength: 1.2 });  // 'hanging', once the cloth is still again
  await cloth.trigger('drop');                                   // 'dropped': the cloth has fallen away, the wall shows
  await cloth.trigger('in');                                     // 'hanging': hung again
</script>
```

ES modules: `import { plugin } from '@giuseppe-scotto-lavina/html-in-canvas-polyfill/plugins/cloth'`.

## Options

| option | default | |
|---|---|---|
| `weight` | 0.5 | 0 (light: the air slows it more, soft narrow folds, a push moves it far) to 1 (heavy: it swings longer, stiffer broad folds) |
| `wind` | 0 | 0 to 1: a breeze from the left that never stops. Above 0 the cloth keeps moving and the plugin renders every frame, on purpose; at 0 it comes to rest |
| `pins` | `'top'` | `'top'`: held along its whole top edge, it hangs flat. `'corners'`: held by its two top corners, each 2 % of the width further in, it sags between them and hangs in folds |
| `sheen` | 0.5 | 0 (matt) to 1: how much the fibres and threads shine |
| `shadow` | 0.85 | 0 to 1: strength of the shadows and of the occlusion in the folds |
| `through` | 0.35 | 0 to 1: how much of the print shows on the back of the cloth |
| `back` | `#9b9790` | the unprinted back of the cloth (`'#rrggbb'`) |
| `backdrop` | `#3f3d40` | the wall (`'#rrggbb'`); the lamp lights it in a pool, from half to 1.3 times this colour |

`mountUI` adds sliders for the weight, the wind and the sheen, a picker for the pins, and the buttons Gust and Drop (Hang once the cloth has dropped), which run the actions through the host.

## Actions

`handle.trigger(action, options?)` ([semantics](../../docs/guides/EFFECTS-PLUGINS.md#5-actions-trigger-and-settled)). The plugin starts none by itself, except `in` from a press on the bare wall.

| action | options | | resolves with |
|---|---|---|---|
| `demo` | none | one gust from the left (strength 1.1): the cloth billows about a third of its height towards the viewer and settles, 2.5 to 3 s in all. A press on the cloth ends the gust at once | `'hanging'`, after the frame that shows the page again |
| `gust` | `direction` (degrees along the cloth: 0 towards the right, 90 downwards; default 0), `strength` (0.1 to 2, default 1) | a front of wind crosses the cloth in that direction (0.8 s) and lifts it off the wall, more where it hangs free, unevenly as moving air is | `'hanging'`, once it is still again |
| `drop` | none | the pins let go one after the other from the left (0.32 s), the cloth peels off and falls out of the frame (about 0.7 s) | `'dropped'`, after the frame that shows the bare wall |
| `in` | none | the cloth is hung again: it comes down from above the frame on its pins (no faster than it falls, so it stays taut), swung towards the viewer, and settles (about 2.6 s) | `'hanging'` |

`handle.settled()` resolves with `'hanging'` or `'dropped'` once nothing moves. `gust` and `demo` on a dropped cloth do nothing and resolve `'dropped'`; `in` during the fall waits for the cloth to be gone. A `TypeError` for a `direction` or `strength` that is not a finite number. A newer trigger resolves a pending one with `null`. While the cloth has dropped, a press anywhere on the canvas triggers `in`.

## Input

Every pointer goes through the host's interposer and this plugin's input mapper, `mapClothPoint(state, point)` (`surface.js`). It is the twin of the rasteriser, not an approximation of the surface: it intersects the pointer's line of sight with the same triangles the GPU drew for the presented frame (the same control points as 32-bit floats, the same 4 x 4 tessellation and diagonal, the same perspective-correct interpolation of the page coordinates) and takes the nearest one, as the depth buffer does.

| presented pixel shows | mapper returns |
|---|---|
| the page, while the cloth hangs flat at rest | the same point (identity) |
| the printed side of the cloth | the exact page point of the nearest triangle on the line of sight |
| the back of the cloth | `NO_TARGET` |
| the wall (beside the cloth, or after `drop`) | `NO_TARGET` |

`NO_TARGET` is the effects ABI value for "no element here" (re-exported by this plugin): the host swallows a press there and the mapper chain stops at it. A mapper answers from a copy of its frame's control points (four are kept, and one more per gesture), finds the cells whose screen boxes contain the point (a patch lies inside the hull of its control points) and computes their vertices once per frame: 74 µs for the first question of a frame, 5 µs for each further one (Node, Apple M1 Max).

**Gestures.**

- A moving pointer pushes the cloth where it passes (through `context.localPoint`, so under a later plugin the dent is where the user sees the pointer). A press pokes it.
- **A press that does not move is the page's click.** Once a pressed mouse has moved 6 CSS px the press is the cloth's gesture: the cloth under the pointer is held on a spring (critically damped, its force bounded, and the hand leans into the pull until the cloth is where it is held) and lifted a little off its plane; the pointer is captured, the gesture's events are taken in the capture phase at the document so that neither the interposer nor the form sees them, no text is selected, and the click that follows the release is swallowed. A press that moves on a button therefore pulls the cloth and does not click.
- **Controls that are dragged themselves keep their drag**: a press on a slider, a text field, a `select`, an editable element or a draggable one never becomes the cloth's gesture.
- **Touch.** The first `touchmove` of a finger decides whose the gesture is. A mostly sideways move (more than 1.5 times wider than tall) anywhere on the cloth, or a move in any direction of a finger that landed on the lower 44 CSS px of the cloth (its hem, where it is drawn), is the cloth's: that move and the next are prevented, so the page does not scroll and the pointer is not cancelled, and once the finger has moved 8 px it holds the cloth as a pressed mouse does. A mostly vertical move elsewhere scrolls the page, as does a move the browser no longer lets the page prevent. The `touchstart` is passive, so a tap stays a tap: the field under it gets the focus through the input mapper. A finger on a control that is dragged itself (a slider, a text field) keeps that control's gesture.

Static text of the page cannot be selected with the mouse under this effect: a press on it that moves pulls the cloth.

## Reduced motion

With `prefers-reduced-motion: reduce` the cloth hangs flat and still: no push, pull, gust or breeze, and `pins: 'corners'` is the top edge. `demo` and `gust` resolve `'hanging'` at once; `drop` and `in` crossfade between the page and the bare wall (0.26 s). The frame is the page, and input is the identity.

## Performance

Measured on an Apple M1 Max, headless Chrome 157, 2026-11-11, one run on one machine while other work ran on it. GPU in a gust: 0.37 ms per frame, unchanged by the self-collision (it is CPU work).

- **GPU.** `test/cloth-gpu.browser.test.mjs`, 2560 x 1600 backing pixels (1280 x 800 CSS px at DPR 2), the cloth in a gust: 0.37 ms per frame submitted back to back (the one-sample template pass: 0.09 ms), 4 % of the 8.33 ms frame at 120 Hz; at rest, the full-screen copy: 0.09 ms, and only when the page changes. Per moving frame: the cloth as the lamp sees it at a third of the CSS resolution and four separable blur passes over it, then the tessellated sheet (about 33,000 triangles, 16 texture loads per vertex) and the wall behind it in one 4x MSAA pass with depth. Nothing is allocated per frame.
- **CPU.** `render()` with the mapper capture, in Node over a fake device (the simulation and the control points are all of it), in a gust: median 0.91 ms per frame at 120 frames per second (4 steps; p95 1.34 ms), 1.80 ms at 60 (8 steps), 3.5 ms at 30 (16 steps). The simulation alone during brisk drags of the cloth across itself: median 0.92 ms per 120 Hz frame (p95 1.13 ms), of which the cloth against itself is 0.41 ms (0.1 ms a step). A step without it costs about 0.12 ms. At rest: nothing.
- **Bundle.** `dist/plugins/cloth.iife.min.js`: 46,808 bytes (18,846 gzip), of which about 10 KB is WGSL (minified by the build) and 11 KB the simulation.


## Extended range

With the host's `hdr` option the cloth writes nothing above white: it adds no light of its own above the page's white, and its output is clamped to the range of an 8-bit target (the dither went below 0 on black channels, which a float target would show). Measured in the gallery with `&hdr=1`, a pointer sweep and the demo: 0 pixels above white and none below 0, on the form and the daylight scene (before the clamp, up to 27,665 pixels below 0 on the form).
## Limitations

- Where the cloth lies over itself, its layers are one spacing of the grid apart (26 CSS px on the gallery's canvas, about 15 on a phone): a fold over the sheet is that thick, and a crease is as round.
- The hand's force is bounded (120 times the cloth's gravity): a flick faster than the cloth can follow leaves it behind the pointer for a moment.
- The source texture has no mip levels, so where the cloth is seen nearly edge on (more than 6 texels per pixel along the footprint) the page aliases; a cloth that hangs or billows does not come near it.
- Texels are filtered bilinearly: on a cloth that rests in folds (`pins: 'corners'`) text is as sharp as a bilinear resampling leaves it.
- The 4x multisampled colour and depth targets are held from the first motion on (about 8 bytes per backing pixel times 4 samples).
- After a GPU device loss the cloth hangs flat again; a gesture in progress is dropped and a pending action resolves `null`.
- WebGPU only (without an adapter `createHost` rejects with a `NotSupportedError`). Runs over the polyfill and over a browser's own HTML-in-Canvas implementation ([what differs there](../../docs/guides/EFFECTS-PLUGINS.md#on-a-native-implementation)); not run there by the test suites; expected to behave the same, as the plugin uses only the plugin interface.

## Files and tests

| file | |
|---|---|
| `index.js` | `meta`, `plugin`, `ACTIONS`, `PINS`, `mapClothPoint`, `presentedState`, `stateOf`, `fabric`, `gustDirection`, `parseColor`, the gesture constants, `NO_TARGET`, `isNoTarget` |
| `sim.js` | the cloth as pure math: the particles, the step (forces, threads, shear, bending, tethers, the wall), pins, gusts, the hand, coming to rest |
| `surface.js` | the B-spline surface over the particles, the state of a frame, and the input mapper (`castCloth`, `mapClothPoint`) |
| `cloth.wgsl` | the shaders; inlined into the built bundles |
| `wgsl.js` | loads the `.wgsl` file when the plugin runs from source; the build replaces it |
| `media/cloth.webp` | the recording above |
| `test/self-crossing.mjs` | a helper of the tests: the drawn surface of a state, tessellated as the shader draws it, and every edge of it that crosses a triangle more than one cell away |
| `test/cloth.test.mjs` | Node: the folder contract; the flat pose as an exact fixed point; the cloth against itself in brisk wide drags, at 120 and at 30 pointer events a second, in the simulation and through the real handle (no frame shows the sheet through itself; control: switched off, most do); the period of the swing against the hanging chain's first mode (control: a quarter of the gravity doubles it); the stretch under a gust and a pull beyond reach, the tethers; coming to rest on the flat pose exactly after a push, a gust, a new hanging and a change of pins, the last part of the way without a jump; the wall; the corners and the drop; the surface against its basis function; `castCloth` and `mapClothPoint` against a brute-force oracle written another way (Moller-Trumbore over every triangle), with the back, the wall, the identity and a later frame as control; the cache against the state's serial; through the real handle: one pass at rest, the same cloth at 30, 60 and 120 frames per second (control: a frame later), the frame between two steps, the demo within 4 s, the actions and their states, superseding, bad options, removal, `in` during the fall, reduced motion (also when only the trigger carries it), the pointer through `context.localPoint` (shifted, and hidden), the gestures (click, drag, the swallowed click, a slider), touch (sideways anywhere and any way from the hem; vertical elsewhere, a tap, a slider and a move that can no longer be prevented as controls), the takeover of the demo, frozen mappers and gesture snapshots, the options |
| `test/cloth-gpu.browser.test.mjs` | headless Chrome, the real host: `checkMapperAgainstGpu` on a pulled cloth and on a cloth folded over itself (identity as positive control), the mapper of the pull 100 ms earlier as wrong-mapper control, the frame at rest equal to the page in every pixel (before and after a gust, with the default look), the frame drawn as a mesh with a small dent (beyond the dent it is still the page in every pixel), the actions `gust`, `demo`, `drop` and `in` (`runActionOnGpu`: every checked frame agrees with its mapper), device loss, the GPU time |
| `test/gallery.e2e.mjs` | the gallery with trusted input: zero frames at rest (control: the opt-in wind), a click and typing on the flat cloth, the push of a moving pointer, the folds of `pins: 'corners'` with a click where a control is drawn (control: its place in the DOM) and typing, a drag that the form never sees, a drag from the button (no submit) and a click on it (submit), a slider that keeps its drag, the actions from the gallery's buttons, a press on the bare wall, the frame cap, the cloth under CRT and over water, reduced motion, touch through Chrome's touch emulation (the hem is taken, and a sideways drag from the middle of the cloth, without a scroll or a `pointercancel`; controls: a vertical drag from the same place, and one elsewhere, scroll the page). 50 of 50 checks pass (headless Chrome 157, 2026-11-11). `--record` also writes the media, `--record-only` only that; needs `npm run build` |
