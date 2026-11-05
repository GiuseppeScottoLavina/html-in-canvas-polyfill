# water

A water surface over the HTML drawn in a canvas. A tap drops a pebble into the pond: a few broad rings that the wave equation carries outwards for about 2 s, in the same water as the wake a moving pointer leaves. The page below is the floor of the pool: it is refracted through the surface normals and lit by caustics computed as light is (a refracted mesh of the surface, energy conserving), and the surface reflects a sky, a window light and a sun. Clicks and typing are remapped through the displacement to the field the user sees. At rest it costs nothing: no effect frame, no animation loop.

An **example** effect plugin of this library, not part of the polyfill: nothing in `src/` imports it, and the polyfill, the frame cap and the effects host work without it. The effects host and its plugins are extensions of this library, not part of the HTML-in-Canvas proposal; native implementations do not provide them ([details](../../docs/guides/EFFECTS-PLUGINS.md#extensions-not-the-standard)).

![The gallery form under the water plugin: a short rain, then the pointer leaves a wake and a click through the ripples focuses the email field](media/water.webp)

Recorded in headless Chrome from the plugin gallery (`node plugins/water/test/gallery.e2e.mjs --record`; with `--hero` it also writes the README's hero, `docs/media/hero.webp`).

## What it does

- **Drops.** A tap is a pebble: four impulses on the wake field, 90 ms apart, at the tap: a smooth crater 22 CSS px across and 12 CSS px deep (at a tap's strength), the water that rushes back into it (a rebound in the middle, the 'plop'), and two smaller swings after. The wave equation carries each impulse outwards as a ring, so a tap rings out as a few separated rings in the wakes' language, with their caustics, their walls and their cost (independent of the number of taps). The rain of the demo falls on the pond as raindrops: 0.65 of a pebble in size, 0.6 in depth. The steepest slope at the impact is about 40 degrees.
- **The wakes.** A grid over the canvas, of cells of about 3 CSS px (at most 65,536 cells), runs the damped wave equation at a fixed 120 steps per second, whatever the display rate and the frame cap: an isotropic 9-point Laplacian, a viscosity that damps short ripples faster than long ones, and walls at the edges of the canvas that reflect the ripples. It runs on the CPU, so that the input mapper reads the very field the GPU draws (see [Input](#input)), and only while it holds a wake. Drops and wakes add up, as linear waves do.
- **The picture.** Per device pixel, the shader evaluates the field as a cubic B-spline (smooth normals and curvature, no grid pattern) and draws:
  - refraction: the page is sampled where the refracted view ray meets it (40 CSS px of displacement per unit of slope at intensity 1: text and field borders bend under a crest);
  - caustics, computed as light is (the method of Evan Wallace's WebGL Water): a mesh of the water surface, a vertex every 2 CSS px over the canvas and a margin, refracts light that falls from straight above by Snell's law (n = 1.333) onto the page, which lies 320 CSS px below for the light, so that a drop's caustic rings are centred on the drop (light from aside would shift them by about a fifth of the depth: seen from above, a wave whose light lands beside it); each triangle adds the ratio of its area on the surface to its area on the page into an r16float texture of one texel per CSS px (4x multisampled, so that a focused triangle thinner than a texel still lands its light). The light is conserved: it gathers into sharp lines under the ripples and leaves the troughs darker, its mean stays 1 (0.998 in the GPU test), and still water lights the page uniformly, with no pass at all. The page is lit 85 % by this light and 15 % by the sky (applied to its linear colour), and the water scatters a little of the focused light along its brightest lines, so that they show over dark content too;
  - Fresnel reflection (Schlick, F0 = 0.02 for water) of a sky, a soft window light and a small sun, seen from a viewer above the middle of the canvas: still water mirrors the window faintly over its top left, ripples break the reflection up and make the sun glint. The light the water adds (the reflection and the caustic web) is compressed with a soft knee: at most 38 % of the range per channel, so it never hides what lies below;
  - absorption: a little more blue-green where the water is deeper, in the troughs;
  - a dither of half a level against banding.
- **Input.** A pointerdown (a click, a tap) drops a pebble there, exactly at the event's point (a test holds the caustic rings within 1 CSS px of it); one event is one drop, also where it reaches both the canvas and the live layer. A moving pointer leaves a wake along its path, deeper when it moves faster, and deeper for a drag (a pressed button, a finger) than for a hovering mouse.
- **At rest.** Once the surface is flat again, below what a pixel shows (no pixel moved by more than 0.1 CSS px, no caustic focus changed by more than 1.2 %, at intensity 1; proportionally more at a lower intensity), the field is cleared, the drops are forgotten and the instance stops being `continuous`: the host renders nothing more until the page or the water changes. A pebble is still again about 3 s later at the default intensity, the rain of the action `demo` under 2 s after its last drop, a long stir of the whole canvas about 4 s after it ends.

### Why the drops are made this way

A tap and a wake are the same water: both are impulses on one height field that the wave equation advances, so a tap has the wakes' waves, caustics and walls, and the cost of a frame does not grow with the number of taps. A pebble is not one impulse but four, 90 ms apart (the crater, the water that rushes back into it, two smaller swings), so that it rings out as a few separated rings, as a stone in a pond does, rather than as one ring that travels unchanged. The wave equation has no dispersion of its own (dispersive height fields exist: iWave, Tessendorf 2004; spectral and wave-packet methods); here the train of impulses gives the rings, and the viscosity of the grid damps the short ripples first.

## Usage

```html
<script src="dist/hic-live-polyfill.iife.min.js"></script>
<script src="dist/hic-live-effects.iife.min.js"></script>
<script src="dist/plugins/water.iife.min.js"></script>   <!-- window.HicLivePlugins.water -->
<script type="module">
  const host = await HTMLInCanvasEffects.createHost(canvas, form, { interposer: true });
  const water = await host.addPlugin(HicLivePlugins.water.plugin, { intensity: 0.5 });
  water.mountUI(document.getElementById('controls'));                    // the plugin's intensity slider
  await water.trigger('demo');                                          // a short rain; 'calm' once the surface is still
  await water.trigger('drop', { point: { x: 120, y: 80 }, strength: 1.5 });
</script>
```

ES modules: `import { plugin } from '@giuseppe-scotto-lavina/html-in-canvas-polyfill/plugins/water'`. [`examples/effect-plugin/`](../../examples/effect-plugin/) uses it in a complete page.

## Options

| option | default | |
|---|---|---|
| `intensity` | 0.5 | 0 to 1: the strength of the water (its refraction and its light); 0 shows the source unchanged |
| `light` | 1 | 0 to 1: the caustics, the reflection and the glints; 0 keeps the refraction only |
| `ambient` | 0 | 0 to 1: a gentle swell of three long waves that never settles. Above 0 the instance is `continuous` (rendered on every capped frame) on purpose. Off with reduced motion |
| `shader` | `water.wgsl` | WGSL text that replaces the shader (same bindings and uniform layout) |

`mountUI` adds the intensity slider.

## Actions

`handle.trigger(action, options)` ([semantics](../../docs/guides/EFFECTS-PLUGINS.md#5-actions-trigger-and-settled)).

| action | options | | resolves with |
|---|---|---|---|
| `drop` | `point`: `{x, y}` in canvas CSS px (default: the centre); `strength`: 0.08 to 2 (default 1.2, a tap's pebble); `swell`: `true` for a swell instead of a pebble | a pebble falls there at once, its depth in proportion to `strength`. A swell is one broad ring on the wake field (a 24 CSS px crater with a crown, 10 CSS px deep at 1.2) that the wave equation carries outwards as one piece: a large, slow, reproducible displacement of the page | `'calm'`, once the surface is still again (under 2 s; a swell, about 3 s) |
| `demo` | none | a short rain: a pebble at the centre, then a shower of 30 raindrops (smaller pebbles) that thins out over 1.4 s, then calm | `'calm'`, once the surface is still (about 3 s at the default intensity); `null` when the user takes over during the rain (the pointer, `setOptions`: the rain stops at once) |

`handle.settled()` resolves with `'calm'` once no ripple runs (pointer ripples count too; the ambient swell does not). A `point` that is not `{x, y}` or a non-finite `strength` rejects with a `TypeError`; a newer trigger resolves a pending one with `null` (and stops the rain of a demo). The plugin never starts the demo by itself: the page decides when to show it.

## Input

The plugin is `spatial`. `mapWaterPoint(state, point)` is the JavaScript twin of the displacement in `water.wgsl`: the same B-spline over the same 4 x 4 cells of the field, the same refraction, the same ambient waves, the same clamp. It evaluates the uniform block and the height field that were submitted for the presented frame (copied into one of four slots), so it describes exactly those pixels: clicks and typing reach the field the user sees, also while ripples run (0 of 150,000 pixels disagree in the GPU test). A gesture keeps one frozen mapping. The mapper clamps to the canvas.

**Touch.** The water covers the whole canvas and never claims a gesture: its listeners are passive and never call `preventDefault()`, so a finger keeps scrolling the page and the form keeps its own interaction. A tap makes a drop. A moving finger makes a wake, also while it scrolls the page: the browser then cancels the pointer (`pointercancel`), but its passive `touchmove` events go on, and each touch point is converted to canvas CSS px with the canvas where it is at that moment (it moves with the page), so the finger keeps stirring the water under it.

## Reduced motion

With `prefers-reduced-motion: reduce` (read when the plugin is added, and by the host at every `trigger`), the water is still: the surface keeps its reflection and its tint, so it still shows what it is; no ripple starts (not from the pointer, not from `drop` or `demo`, which resolve `'calm'` at once), the ambient swell is off, and nothing animates, so the effect is rendered only when the page or an option changes. The mapper is then the identity.

## Performance

- **Zero work at rest.** At rest, and after every drop, wake and demo once the surface is still, the host renders no effect frame (0 in 3 s, measured in the gallery in headless Chrome and on the iPad below). A source change at rest renders one frame, which skips the field. The plugin requests frames only while the surface moves.
- **CPU.** One step of the wake field costs about 0.38 ms for the full 65,536-cell grid of a 1100 x 620 canvas (Node 24, Apple M1 Max); at 120 steps per second that is about 4.5 % of one core while a wake moves; the field (about 260 KB of r32float) is uploaded once per rendered frame then, never at rest.
- **GPU.** The caustics pass: about 310,000 mesh vertices (16 texel loads of the field each) and their triangles, 4x multisampled (it runs only while the surface moves). The picture: per device pixel, 16 texel loads of the field (skipped while it is flat), four samples of the light and one of the page. Neither depends on the number of taps.
- **On the iPad.** iPad Pro 11-inch (3rd generation, M1), iPadOS 27.2, Safari, 120 Hz, DPR 2, the plugin gallery uncapped (2026-11-05, with the drops of the previous design; the pebbles cost less): 0 effect frames in 3 s at rest; the demo at 120 effect frames per second, intervals 8.34 ms at p50 and 8.54 ms at p95; a 0.7 s wake at 119 per second, p95 8.52 ms; 0 effect frames in 3 s after each.
- **On the Mac.** Chrome, headed, 120 Hz (MacBook Pro, Liquid Retina XDR), trusted clicks on the water away from the form's controls, 10 a second for 3 s and 30 in 1 s: 120 effect frames per second, the longest frame interval 9.4 ms, no main-thread task over 8.33 ms (the longest 6.3 ms), the first frames after a click from rest 7.3 to 9.4 ms apart.

## Limitations

- The wakes run on the CPU (so that the input mapper reads exactly what the GPU draws), on a grid of cells of at least 3 CSS px: ripples shorter than about 4 cells are smoothed away by the B-spline. The wave equation has no dispersion: the rings of a pebble come from its train of impulses.
- The caustics come from one light, from straight above, onto the page as a flat floor 320 CSS px below the surface (the page casts no shadow and has no depth of its own). Over dark content the caustic light shows mostly through the light the water scatters along its lines; over light content (buttons, text) through the page itself.
- The pebbles are linear water waves: no splash, no crown of droplets, no jet above the surface. Every pebble has the same shape and differs only in depth.
- The environment that the water reflects is fixed (a sky, a window light up and to the left, a sun up and to the right); it is not the page's surroundings.
- A resize to another grid starts with a flat surface (a resize by a fraction of a cell keeps the ripples).
- WebGPU only (without an adapter `createHost` rejects with a `NotSupportedError`). Runs over the polyfill and over a browser's own HTML-in-Canvas implementation ([what differs there](../../docs/guides/EFFECTS-PLUGINS.md#on-a-native-implementation)); the native suite (`npm run test:native-effects`) runs it.

## Files and tests

| file | |
|---|---|
| `index.js` | `meta`, `plugin`, `ACTIONS`, `mapWaterPoint`, `demoRain`, the uniform layout `G` and `GLOBALS_LENGTH` |
| `sim.js` | the height field of the wakes: the grid, the wave equation, dents, the check for a still surface, the B-spline (`surfaceAt`) and the ambient waves shared with the mapper |
| `../_lib/action.js` | the `point` option of actions (shared, bundled into each plugin that uses it) |
| `water.wgsl` | the shader; inlined into the built bundles |
| `wgsl.js` | loads `water.wgsl` when the plugin runs from source; the build replaces it |
| `media/water.webp` | the recording above |
| `test/water-math.test.mjs` | Node: the folder contract; the mapper against an independent oracle (the B-spline basis and a numeric gradient) over random fields, with and without the swell; the wave equation (the speed of the ring, the walls, stability at every cell size, the return to rest, the visibility threshold); zero work at rest; pebbles, wakes, passive listeners; mapper slots and gesture snapshots; options; a resize; reduced motion; the actions `drop` and `demo` through the real handle (their end at rest, a user's takeover, removal); a tap is a pebble centred on it within 0.5 CSS px that rings out as several rings (control: a single dent of its size makes fewer) and is at rest within about 4 s; one pointerdown that reaches both listen targets is one pebble (control: two pointerdowns stir twice as deep); a long gap between frames is skipped by the pebbles (control: frames all along); the action drop with `swell: true` (control: a pebble starts as a dip) |
| `test/water-gpu.browser.test.mjs` | headless Chrome: the mapper against the pixels the GPU produced (`plugins/_shared/gpu-check.mjs`), a mapper of another instant as control, intensity 0, frozen mappers; zero work at rest (no frame without a change, and the frame at rest is the still picture); the light on a uniform page, with `light: 0` as control; the actions `drop` and `demo` (pixels move, every checked frame agrees with its mapper, `'calm'` at rest); the caustics conserve the light (the mean of the caustic texture stays 1 within 3 % while a drop gathers it into lines over 3 times as bright); a tap's caustic rings are centred on the tap within 1 CSS px (control: light from aside shifts them by more than 10 px) |
| `test/gallery.e2e.mjs` | the gallery with trusted input: zero effect frames at rest, a wake from the pointer that dies out by itself, a click through the ripples and typing, the frame cap while the water moves, the actions from the gallery's buttons, superseding, `settled()`, the user's takeover of the demo, reduced motion (also the actions). Needs `npm run build` |
| `test/touch.e2e.mjs` | Chrome with touch emulation (trusted CDP touch events): a tap makes a drop; a finger drag over the water scrolls the page (control: a non-passive `preventDefault()` stops it) and keeps stirring the water while it scrolls (control: the same scroll with its touch moves stopped comes to rest earlier) |
| `test/offscreen.e2e.mjs` | the off-screen pause of the host in the gallery, with the water made continuous by its swell: scrolled far out of view no effect frame is rendered and the renderer and GPU processes use less CPU; a source change made meanwhile is uploaded only at the resume; an action triggered off-screen still resolves; a jump back into view is rendered in the frame that shows it. Control: the same page with `IntersectionObserver` silenced keeps rendering. Needs `npm run build` |
