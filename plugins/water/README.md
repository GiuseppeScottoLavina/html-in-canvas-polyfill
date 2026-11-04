# water

A water surface over the HTML drawn in a canvas. A height field follows the wave equation; the page below is refracted through its surface normals and lit by caustics, and the surface reflects a sky, a window light and a sun. Taps make drops, a moving pointer leaves a wake, and clicks and typing are remapped through the displacement to the field the user sees. At rest it costs nothing: no effect frame, no animation loop.

An **example** effect plugin of this library, not part of the polyfill: nothing in `src/` imports it, and the polyfill, the frame cap and the effects host work without it. The effects host and its plugins are extensions of this library, not part of the HTML-in-Canvas proposal; native implementations do not provide them ([details](../../docs/guides/EFFECTS-PLUGINS.md#extensions-not-the-standard)).

![The gallery form under the water plugin: a short rain, then the pointer leaves a wake and a click through the ripples focuses the email field](media/water.webp)

Recorded in headless Chrome from the plugin gallery (`node plugins/water/test/gallery.e2e.mjs --record`; with `--hero` it also writes the README's hero, `docs/media/hero.webp`).

## What it does

- **The surface.** A grid over the canvas, of cells of about 3 CSS px (at most 65,536 cells), runs the damped wave equation at a fixed 120 steps per second, whatever the display rate and the frame cap: an isotropic 9-point Laplacian, a viscosity that damps short ripples faster than long ones (as in real water), and walls at the edges of the canvas that reflect the ripples. It runs on the CPU, so that the input mapper reads the very field the GPU draws (see [Input](#input)).
- **The picture.** Per device pixel, the shader evaluates the field as a cubic B-spline (smooth normals and curvature, no grid pattern) and draws:
  - refraction: the page is sampled where the refracted view ray meets it (30 CSS px of displacement per unit of slope at intensity 1);
  - caustics: the light refracted by the same surface focuses on the page (the inverse Jacobian of that displacement, at a deeper light depth); over dark content they show as a faint glow of the focused light;
  - Fresnel reflection (Schlick, F0 = 0.02 for water) of a sky, a soft window light and a small sun, seen from a viewer above the middle of the canvas: still water mirrors the window faintly over its top left, ripples break the reflection up and make the sun glint. The reflection is compressed so that it adds at most 38 % of the range and never hides what lies below;
  - absorption: a little more blue-green where the water is deeper, in the troughs;
  - a dither of half a level against banding.
- **Input.** A pointerdown (a click, a tap) lets a drop fall there: a crater with a raised crown that rings out as a train of ripples. A moving pointer leaves a wake along its path, deeper when it moves faster, and deeper for a drag (a pressed button, a finger) than for a hovering mouse.
- **At rest.** Once the surface is flat again, below what a pixel shows (no pixel moved by more than 0.06 CSS px, no caustic focus changed by more than 0.6 %, at intensity 1; proportionally more at a lower intensity), the field is cleared and the instance stops being `continuous`: the host renders nothing more until the page or the water changes. A drop is still again about 2 s later; the rain of the action `demo` about 1.5 s after its last drop.

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
| `drop` | `point`: `{x, y}` in canvas CSS px (default: the centre); `strength`: 0.08 to 2 (default 1.2) | a drop falls there at once | `'calm'`, once the surface is still again (about 2 s) |
| `demo` | none | a short rain: a large drop, then a shower of 30 drops that thins out over 1.6 s, then calm | `'calm'`, once the surface is still (about 3 s at the default intensity); `null` when the user takes over during the rain (the pointer, `setOptions`: the rain stops at once) |

`handle.settled()` resolves with `'calm'` once no ripple runs (pointer ripples count too; the ambient swell does not). A `point` that is not `{x, y}` or a non-finite `strength` rejects with a `TypeError`; a newer trigger resolves a pending one with `null` (and stops the rain of a demo). The plugin never starts the demo by itself: the page decides when to show it.

## Input

The plugin is `spatial`. `mapWaterPoint(state, point)` is the JavaScript twin of the displacement in `water.wgsl`: the same B-spline over the same 4 x 4 cells of the field, the same refraction, the same ambient waves, the same clamp. It evaluates the uniform block and the height field that were submitted for the presented frame (copied into one of four slots), so it describes exactly those pixels: clicks and typing reach the field the user sees, also while ripples run. A gesture keeps one frozen mapping. The mapper clamps to the canvas.

**Touch.** The water covers the whole canvas and never claims a gesture: its listeners are passive and never call `preventDefault()`, so a finger keeps scrolling the page and the form keeps its own interaction. A tap makes a drop; a moving finger makes a wake until the browser takes the gesture for scrolling (it then sends `pointercancel`, and the wake stops).

## Reduced motion

With `prefers-reduced-motion: reduce` (read when the plugin is added, and by the host at every `trigger`), the water is still: the surface keeps its reflection and its tint, so it still shows what it is; no ripple starts (not from the pointer, not from `drop` or `demo`, which resolve `'calm'` at once), the ambient swell is off, and nothing animates, so the effect is rendered only when the page or an option changes. The mapper is then the identity.

## Performance

- **Zero work at rest.** At rest, and after every drop, wake and demo once the surface is still, the host renders no effect frame (0 in 3 s, measured in the gallery in headless Chrome and on the iPad below). A source change at rest renders one frame, which skips the field. The plugin requests frames only while the surface moves.
- **CPU.** One simulation step costs about 0.38 ms for the full 65,536-cell grid of a 1100 x 620 canvas (Node 24, Apple M1 Max); at 120 steps per second that is about 4.5 % of one core while the water moves. The field (about 260 KB of r32float) is uploaded once per rendered frame while it moves, never at rest.
- **GPU.** One full-screen pass: 16 texel loads of the field per pixel (the B-spline) and one sample of the page; the loads are skipped while the field is flat.
- **On the iPad.** iPad Pro 11-inch (3rd generation, M1), iPadOS 27.2, Safari, 120 Hz, DPR 2, the plugin gallery with the frame cap at 120 (2026-11-04): 0 effect frames in 3 s at rest; during the demo effect frame intervals of 8.34 ms (p50) and 9.06 ms (p95), i.e. the display rate; 0 effect frames in 3 s after it.

## Limitations

- The simulation runs on the CPU (so that the input mapper reads exactly what the GPU draws), on a grid of cells of at least 3 CSS px: ripples shorter than about 4 cells are smoothed away by the B-spline.
- The wave equation has no dispersion of its own: the trains of ripples come from the crown of each drop, not from capillary physics.
- The environment that the water reflects is fixed (a sky, a window light up and to the left, a sun up and to the right); it is not the page's surroundings.
- A resize to another grid starts with a flat surface (a resize by a fraction of a cell keeps the ripples).
- WebGPU only (without an adapter `createHost` rejects with a `NotSupportedError`). Runs over the polyfill and over a browser's own HTML-in-Canvas implementation ([what differs there](../../docs/guides/EFFECTS-PLUGINS.md#on-a-native-implementation)).

## Files and tests

| file | |
|---|---|
| `index.js` | `meta`, `plugin`, `ACTIONS`, `mapWaterPoint`, `demoRain`, the uniform layout `G` and `GLOBALS_LENGTH` |
| `sim.js` | the height field: the grid, the wave equation, drops and dents, the check for a still surface, the B-spline (`surfaceAt`) and the ambient waves shared with the mapper |
| `../_lib/action.js` | the `point` option of actions (shared, bundled into each plugin that uses it) |
| `water.wgsl` | the shader; inlined into the built bundles |
| `wgsl.js` | loads `water.wgsl` when the plugin runs from source; the build replaces it |
| `media/water.webp` | the recording above |
| `test/water-math.test.mjs` | Node: the folder contract; the mapper against an independent oracle (the B-spline basis and a numeric gradient) over random fields, with and without the swell; the wave equation (the speed of the ring, the walls, stability at every cell size, the return to rest, the visibility threshold); zero work at rest; drops, wakes, passive listeners; mapper slots and gesture snapshots; options; a resize; reduced motion; the actions `drop` and `demo` through the real handle (their end at rest, a user's takeover, removal) |
| `test/water-gpu.browser.test.mjs` | headless Chrome: the mapper against the pixels the GPU produced (`plugins/_shared/gpu-check.mjs`), a mapper of another instant as control, intensity 0, frozen mappers; zero work at rest (no frame without a change, and the frame at rest is the still picture); the light on a uniform page, with `light: 0` as control; the actions `drop` and `demo` (pixels move, every checked frame agrees with its mapper, `'calm'` at rest) |
| `test/gallery.e2e.mjs` | the gallery with trusted input: zero effect frames at rest, a wake from the pointer that dies out by itself, a click through the ripples and typing, the frame cap while the water moves, the actions from the gallery's buttons, superseding, `settled()`, the user's takeover of the demo, reduced motion (also the actions). Needs `npm run build` |
| `test/touch.e2e.mjs` | Chrome with touch emulation (trusted CDP touch events): a finger drag over the water scrolls the page and is never cancelled by the plugin, a tap makes a drop |
| `test/offscreen.e2e.mjs` | the off-screen pause of the host in the gallery, with the water made continuous by its swell: scrolled far out of view no effect frame is rendered and the renderer and GPU processes use less CPU; a source change made meanwhile is uploaded only at the resume; an action triggered off-screen still resolves; a jump back into view is rendered in the frame that shows it. Control: the same page with `IntersectionObserver` silenced keeps rendering. Needs `npm run build` |
