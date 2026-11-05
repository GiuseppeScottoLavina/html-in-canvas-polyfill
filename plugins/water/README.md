# water

A water surface over the HTML drawn in a canvas. A tap lets a drop fall: it rings out as real water does, a train of rings whose short capillary ripples run ahead of the longer waves, computed from the dispersion of capillary-gravity waves. A moving pointer leaves a wake, simulated with the wave equation. The page below is the floor of the pool: it is refracted through the surface normals and lit by caustics computed as light is (a refracted mesh of the surface, energy conserving), and the surface reflects a sky, a window light and a sun. Clicks and typing are remapped through the displacement to the field the user sees. At rest it costs nothing: no effect frame, no animation loop.

An **example** effect plugin of this library, not part of the polyfill: nothing in `src/` imports it, and the polyfill, the frame cap and the effects host work without it. The effects host and its plugins are extensions of this library, not part of the HTML-in-Canvas proposal; native implementations do not provide them ([details](../../docs/guides/EFFECTS-PLUGINS.md#extensions-not-the-standard)).

![The gallery form under the water plugin: a short rain, then the pointer leaves a wake and a click through the ripples focuses the email field](media/water.webp)

Recorded in headless Chrome from the plugin gallery (`node plugins/water/test/gallery.e2e.mjs --record`; with `--hero` it also writes the README's hero, `docs/media/hero.webp`).

## What it does

- **Drops.** A drop is the exact linear response of deep water to an impact (the Cauchy-Poisson problem, Lamb's *Hydrodynamics*, art. 255). The impact gives the surface an impulse in the shape of a small crater with a raised rim (6 CSS px across, no net volume): the surface starts flat, the crater opens to its depth within about 17 ms, rebounds, and rings out. Every wavenumber *k* of it runs at its own speed, by the dispersion relation of real water, ω² = g k + (σ/ρ) k³, with g, σ/ρ and the viscosity of water at 20 °C at a scale of 11 CSS px per cm (an 1100 px canvas is a basin 1 m across). The short capillary ripples therefore run ahead of the longer waves, the train of crests grows as it spreads, its wavelengths spread out, and the centre calms down. Short ripples die first (the viscous damping 2νk²); a surface film damps every wavelength by 1.2 per second more, so a drop is still in under 2 s. The amplitude falls as the ring widens, as on a pond.
  - **The table.** All drops have the same shape and differ only in depth and place, so the profile h(r, t) is tabulated once, with its slope and curvature: 560 radii (1 CSS px apart) by 240 instants (2 s at 120 per second), from a sum over 208 wavenumbers, about 0.35 ms per instant. Each instant is computed only out to where the ripples can have reached (the crater plus the fastest group speed of its wavenumbers, about 520 px/s), so the instants of a young drop are cheap. The first three are computed when the plugin is added, the rest in idle time 0.1 s later (about 75 ms of work in all, in slices of 3 ms); a drop that comes earlier computes the instants it needs. The table is stored as half floats (an rgba16float texture) that the GPU filters bilinearly in radius and time; it fades out over its last 0.3 s and its outer 12 %.
  - **On the GPU.** A first pass evaluates the drops once per CSS pixel (at most 64 sources: the drops and their mirror images in the walls their rings reach, so the walls reflect drops as they reflect wakes; each source is skipped outside the ring where its slope or curvature exceeds 0.4 % of its largest), into an rgba16float texture: slope and height. The picture samples it.
  - **Bursts.** At most 20 drops ring at once: a 21st makes the oldest fade out over 150 ms (by then it has lost most of its height), so that a burst of taps costs no more than 20 drops, whatever its rate.
- **The wakes.** A grid over the canvas, of cells of about 3 CSS px (at most 65,536 cells), runs the damped wave equation at a fixed 120 steps per second, whatever the display rate and the frame cap: an isotropic 9-point Laplacian, a viscosity that damps short ripples faster than long ones, and walls at the edges of the canvas that reflect the ripples. It runs on the CPU, so that the input mapper reads the very field the GPU draws (see [Input](#input)), and only while it holds a wake. Drops and wakes add up, as linear waves do.
- **The picture.** Per device pixel, the shader evaluates the wake field as a cubic B-spline (smooth normals and curvature, no grid pattern), adds the drops, and draws:
  - refraction: the page is sampled where the refracted view ray meets it (40 CSS px of displacement per unit of slope at intensity 1: text and field borders bend under a crest);
  - caustics, computed as light is (the method of Evan Wallace's WebGL Water): a mesh of the water surface, a vertex every 2 CSS px over the canvas and a margin, refracts the light of the window by Snell's law (n = 1.333) onto the page, which lies 320 CSS px below for the light; each triangle adds the ratio of its area on the surface to its area on the page into an r16float texture of one texel per CSS px (4x multisampled, so that a focused triangle thinner than a texel still lands its light). The light is conserved: it gathers into sharp lines under the ripples and leaves the troughs darker, its mean stays 1 (0.998 in the GPU test), and still water lights the page uniformly, with no pass at all. The page is lit 85 % by this light and 15 % by the sky (applied to its linear colour), and the water scatters a little of the focused light along its brightest lines, so that they show over dark content too;
  - Fresnel reflection (Schlick, F0 = 0.02 for water) of a sky, a soft window light and a small sun, seen from a viewer above the middle of the canvas: still water mirrors the window faintly over its top left, ripples break the reflection up and make the sun glint. The light the water adds (the reflection and the caustic web) is compressed with a soft knee: at most 38 % of the range per channel, so it never hides what lies below;
  - absorption: a little more blue-green where the water is deeper, in the troughs;
  - a dither of half a level against banding.
- **Input.** A pointerdown (a click, a tap) lets a drop fall there (4 CSS px deep). A moving pointer leaves a wake along its path, deeper when it moves faster, and deeper for a drag (a pressed button, a finger) than for a hovering mouse.
- **At rest.** Once the surface is flat again, below what a pixel shows (no pixel moved by more than 0.1 CSS px, no caustic focus changed by more than 1.2 %, at intensity 1; proportionally more at a lower intensity), the field is cleared, the drops are forgotten and the instance stops being `continuous`: the host renders nothing more until the page or the water changes. A drop is still again about 1.7 s later at the default intensity (at most 2 s), the rain of the action `demo` under 2 s after its last drop, a long stir of the whole canvas about 4 s after it ends.

### Why the drops are made this way

A drop on real water does not make one ring that travels unchanged. Water waves are dispersive: each wavelength runs at its own speed, so an impact rings out as a packet that spreads, gains crests and loses amplitude. How interactive water usually does it:

| approach | dispersion | cost | used here |
|---|---|---|---|
| the wave equation on a grid (Hugo Elias's 2D water; Evan Wallace's WebGL Water: a neighbour average, a damping of 0.995, drops as cosine bumps) | none: every wavelength at one speed, so a drop's ring keeps its shape | one step of a few loads per cell | for the wakes (as in 0.1.0-preview.23, which also made drops this way) |
| iWave (Tessendorf, *Interactive Water Surfaces*, 2004): the wave equation with the vertical derivative as a 13 x 13 convolution kernel | deep-water gravity waves, ω² = g k | 169 multiply-adds per cell per step: about 1.3 G a second on this grid, on the CPU the mapper needs | no |
| spectral and wavelet methods (FFT height fields; Jeschke and Wojtan, *Water Wave Packets*, 2017, and *Water Surface Wavelets*, 2018) | any dispersion relation | transforms or packets per frame, built for large scenes | no |
| analytic ripples (common in shader demos: sin(k r - ω t) under an envelope) | none, or an ad hoc one | cheap | no |
| the exact linear response (the Cauchy-Poisson integral), tabulated | the dispersion of real capillary-gravity water | a table computed once (about 90 ms), then one filtered sample per drop and CSS pixel | for the drops |

For a drop, whose shape is the same every time, the exact solution is cheaper than any simulation and as physical as linear water gets.

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
| `drop` | `point`: `{x, y}` in canvas CSS px (default: the centre); `strength`: 0.08 to 2 (default 1.2, a tap's drop); `swell`: `true` for a swell instead of a drop | a drop falls there at once, its depth in proportion to `strength`. A swell is one broad ring on the wake field (a 24 CSS px crater with a crown, 10 CSS px deep at 1.2) that the wave equation carries outwards as one piece: a large, slow, reproducible displacement of the page | `'calm'`, once the surface is still again (under 2 s; a swell, about 3 s) |
| `demo` | none | a short rain: a drop at the centre, then a shower of 30 smaller drops that thins out over 1.4 s, then calm | `'calm'`, once the surface is still (about 3 s at the default intensity); `null` when the user takes over during the rain (the pointer, `setOptions`: the rain stops at once) |

`handle.settled()` resolves with `'calm'` once no ripple runs (pointer ripples count too; the ambient swell does not). A `point` that is not `{x, y}` or a non-finite `strength` rejects with a `TypeError`; a newer trigger resolves a pending one with `null` (and stops the rain of a demo). The plugin never starts the demo by itself: the page decides when to show it.

## Input

The plugin is `spatial`. `mapWaterPoint(state, point, table)` is the JavaScript twin of the displacement in `water.wgsl`: the same B-spline over the same 4 x 4 cells of the field, the same drop sources evaluated at the same CSS-pixel texels from the same half floats of the table and rounded to half floats as the drop textures store them, the same bilinear interpolation, the same refraction, the same ambient waves, the same clamp. It evaluates the uniform block and the height field that were submitted for the presented frame (copied into one of four slots; the rows of the table never change once computed), so it describes those pixels: clicks and typing reach the field the user sees, also while ripples run (0 of 150,000 pixels disagree in the GPU test). A gesture keeps one frozen mapping. The mapper clamps to the canvas.

**Touch.** The water covers the whole canvas and never claims a gesture: its listeners are passive and never call `preventDefault()`, so a finger keeps scrolling the page and the form keeps its own interaction. A tap makes a drop. A moving finger makes a wake, also while it scrolls the page: the browser then cancels the pointer (`pointercancel`), but its passive `touchmove` events go on, and each touch point is converted to canvas CSS px with the canvas where it is at that moment (it moves with the page), so the finger keeps stirring the water under it.

## Reduced motion

With `prefers-reduced-motion: reduce` (read when the plugin is added, and by the host at every `trigger`), the water is still: the surface keeps its reflection and its tint, so it still shows what it is; no ripple starts (not from the pointer, not from `drop` or `demo`, which resolve `'calm'` at once), the ambient swell is off, and nothing animates, so the effect is rendered only when the page or an option changes. The mapper is then the identity.

## Performance

- **Zero work at rest.** At rest, and after every drop, wake and demo once the surface is still, the host renders no effect frame (0 in 3 s, measured in the gallery in headless Chrome and on the iPad below). A source change at rest renders one frame, which skips the field. The plugin requests frames only while the surface moves.
- **CPU.** One step of the wake field costs about 0.38 ms for the full 65,536-cell grid of a 1100 x 620 canvas (Node 24, Apple M1 Max); at 120 steps per second that is about 4.5 % of one core while a wake moves; the field (about 260 KB of r32float) is uploaded once per rendered frame then, never at rest, and not at all while only drops ring. The drop table costs about 90 ms once, in idle slices of 3 ms; a frame with drops writes their sources (32 bytes each) into the uniform block.
- **GPU.** The drops pass: per CSS pixel, a loop over the sources and one filtered sample of the table for each source whose ring covers the pixel (it runs only while drops ring). The caustics pass: about 310,000 mesh vertices (16 texel loads of the field and a sample of the drops each) and their triangles, 4x multisampled (it runs only while the surface moves). The picture: per device pixel, 16 texel loads of the field (skipped while it is flat), a sample of the drops, four of the light and one of the page. On the iPad below, at 1100 x 620 CSS px and DPR 2 (frames back to back, until the GPU is done): 0.8 ms a frame at rest; at most 4.3 ms at the demo's peak; at most 4.4 ms during 30 taps in one second and 4.2 ms during 10 taps a second for 3 s (3.9 and 3.5 ms without the caustics).
- **On the iPad.** iPad Pro 11-inch (3rd generation, M1), iPadOS 27.2, Safari, 120 Hz, DPR 2, the plugin gallery uncapped (2026-11-05): 0 effect frames in 3 s at rest; the demo at 120 effect frames per second, intervals 8.34 ms at p50 and 8.54 ms at p95; bursts of drops (30 in 1 s, 60 in 2 s, 10 a second for 3 s; pointer events dispatched by the page) at 116 to 118 effect frames per second with no interval over 12 ms; a 0.7 s wake at 119 per second, p95 8.52 ms; 0 effect frames in 3 s after each.
- **On the Mac.** Chrome, headed, 120 Hz (MacBook Pro, Liquid Retina XDR), trusted clicks on the water away from the form's controls, 10 a second for 3 s and 30 in 1 s: 120 effect frames per second, the longest frame interval 9.4 ms, no main-thread task over 8.33 ms (the longest 6.3 ms), the first frames after a click from rest 7.3 to 9.4 ms apart.

## Limitations

- The wakes run on the CPU (so that the input mapper reads exactly what the GPU draws), on a grid of cells of at least 3 CSS px: ripples shorter than about 4 cells are smoothed away by the B-spline. The wave equation of the wakes has no dispersion; the drops have the dispersion of real water.
- The caustics come from one light, the window of the environment, onto the page as a flat floor 320 CSS px below the surface (the page casts no shadow and has no depth of its own). Over dark content the caustic light shows mostly through the light the water scatters along its lines; over light content (buttons, text) through the page itself.
- The drops are linear water waves: no splash, no crown of droplets, no jet above the surface, which a real drop throws up for a few milliseconds. Every drop has the same crater (6 CSS px) and differs only in depth; the table reaches 560 CSS px, beyond which the leading ripples (by then far below a pixel) fade out. Mirror images make the walls of the canvas reflect drops once (a ring that crosses the canvas twice has faded by then).
- The environment that the water reflects is fixed (a sky, a window light up and to the left, a sun up and to the right); it is not the page's surroundings.
- A resize to another grid starts with a flat surface (a resize by a fraction of a cell keeps the ripples).
- WebGPU only (without an adapter `createHost` rejects with a `NotSupportedError`). Runs over the polyfill and over a browser's own HTML-in-Canvas implementation ([what differs there](../../docs/guides/EFFECTS-PLUGINS.md#on-a-native-implementation)); the native suite (`npm run test:native-effects`) runs it.

## Files and tests

| file | |
|---|---|
| `index.js` | `meta`, `plugin`, `ACTIONS`, `mapWaterPoint`, `demoRain`, the uniform layout `G` and `GLOBALS_LENGTH` |
| `sim.js` | the height field of the wakes: the grid, the wave equation, dents, the check for a still surface, the B-spline (`surfaceAt`) and the ambient waves shared with the mapper |
| `drops.js` | the drops: the dispersion of capillary-gravity water, the table of the Cauchy-Poisson profile (filled in slices), the half floats, the sources and their sum (`dropsAt`) and the slope the picture samples (`dropsSlope`), shared with the mapper |
| `../_lib/action.js` | the `point` option of actions (shared, bundled into each plugin that uses it) |
| `water.wgsl` | the shader; inlined into the built bundles |
| `wgsl.js` | loads `water.wgsl` when the plugin runs from source; the build replaces it |
| `media/water.webp` | the recording above |
| `test/drops.test.mjs` | Node: the table against an independent evaluation of the Cauchy-Poisson integral (another Bessel function, a finer wavenumber grid) and its derivatives against finite differences; a drop starts flat, opens a crater of its depth, carries no volume and ends flat; dispersion (the train grows and its wavelengths spread; control: the wave equation of preview.23's drop keeps its crests); half floats; the bilinear interpolation shared with the GPU sampler; the ring culling; the walls (with the mirror image the slope across a wall is zero; control: without it, it is not) |
| `test/water-math.test.mjs` | Node: the folder contract; the mapper against an independent oracle (the B-spline basis and a numeric gradient) over random fields, with and without the swell; the wave equation (the speed of the ring, the walls, stability at every cell size, the return to rest, the visibility threshold); zero work at rest; drops, wakes, passive listeners; mapper slots and gesture snapshots; options; a resize; reduced motion; the actions `drop` and `demo` through the real handle (their end at rest, a user's takeover, removal); a burst of 30 taps leaves 20 drops ringing and at most 64 sources (control: 20 taps fade none); a long gap between frames is skipped by the drops; the action drop with `swell: true` (control: without it) |
| `test/water-gpu.browser.test.mjs` | headless Chrome: the mapper against the pixels the GPU produced (`plugins/_shared/gpu-check.mjs`), a mapper of another instant as control, intensity 0, frozen mappers; zero work at rest (no frame without a change, and the frame at rest is the still picture); the light on a uniform page, with `light: 0` as control; the actions `drop` and `demo` (pixels move, every checked frame agrees with its mapper, `'calm'` at rest); the caustics conserve the light (the mean of the caustic texture stays 1 within 3 % while a drop gathers it into lines over 3 times as bright) |
| `test/gallery.e2e.mjs` | the gallery with trusted input: zero effect frames at rest, a wake from the pointer that dies out by itself, a click through the ripples and typing, the frame cap while the water moves, the actions from the gallery's buttons, superseding, `settled()`, the user's takeover of the demo, reduced motion (also the actions). Needs `npm run build` |
| `test/touch.e2e.mjs` | Chrome with touch emulation (trusted CDP touch events): a tap makes a drop; a finger drag over the water scrolls the page (control: a non-passive `preventDefault()` stops it) and keeps stirring the water while it scrolls (control: the same scroll with its touch moves stopped comes to rest earlier) |
| `test/offscreen.e2e.mjs` | the off-screen pause of the host in the gallery, with the water made continuous by its swell: scrolled far out of view no effect frame is rendered and the renderer and GPU processes use less CPU; a source change made meanwhile is uploaded only at the resume; an action triggered off-screen still resolves; a jump back into view is rendered in the frame that shows it. Control: the same page with `IntersectionObserver` silenced keeps rendering. Needs `npm run build` |
