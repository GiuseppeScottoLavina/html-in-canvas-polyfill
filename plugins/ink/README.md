# ink

The live page as wet ink on a thin layer of water. A pointer that moves over it stirs an incompressible 2D fluid; the flow carries the page's own pixels along, so the picture smears, swirls and stretches as marbling does, and then the page heals back to its layout. A pressed pointer or a finger also releases pigment: two inks side by side that the wake folds into each other and that fade by age. Clicks and typing are remapped through the displacement to the element the user sees, mid-swirl. At rest it costs nothing: no effect frame, no animation loop, and the picture is the source, texel for texel.

An **example** effect plugin of this library, not part of the polyfill: nothing in `src/` imports it, and the polyfill, the frame cap and the effects host work without it. The effects host and its plugins are extensions of this library, not part of the HTML-in-Canvas proposal; native implementations do not provide them ([details](../../docs/guides/EFFECTS-PLUGINS.md#extensions-not-the-standard)). Like the host, it is **experimental** ([STABILITY.md](../../docs/STABILITY.md)): its options, actions and look may change in any minor release.

![The gallery form under the ink plugin: the demo stroke, a pressed pointer stirring the text, then a click into the name field and typing](media/ink.webp)

Recorded in headless Chrome from the plugin gallery (`node plugins/ink/test/gallery.e2e.mjs --record`).

## What it does

1. **The fluid** (`sim.js`, on the CPU). A plane flow in a closed box, the canvas, in vorticity and stream function form, on cells of about 10 CSS px (112 x 64 for a 1100 x 620 canvas), 120 steps per second whatever the display rate. Each step solves the Poisson equation for the stream function with one multigrid V cycle (red-black Gauss-Seidel, five grids, started from the previous solution: the residual falls by about 20 a cycle), takes the velocity as the curl of the cubic B-spline of the stream function, and carries the vorticity along the flow (semi-Lagrangian with a midpoint trace and a MacCormack correction, limited to the values around the departure point). A velocity that is the curl of a smooth stream function is divergence free wherever it is read, whatever the accuracy of the solve: nothing in the flow gathers or thins the page or the pigment.
2. **Vorticity confinement** (Fedkiw, Stam and Jensen 2001) gives back the rotation that a coarse grid smears out. Its force is added as its curl, which is a transport of the vorticity up its own gradient, by upwind fluxes; the result is limited to the largest vorticity before the step, the invariant of a plane flow, so confinement restores swirls and cannot feed them at any strength.
3. **The page** is a displacement field `d` on the same grid: the pixel at `x` shows the source at `x - d(x)`. The flow carries it like the vorticity, and it gains the path of each step (the page moves with the water). It relaxes to zero (the option `heal`), so the page comes home in a second or two.
4. **Rest in finite time.** The vorticity decays (the drag of a thin layer, the option `flow`) and loses 2 /s² on top; the displacement relaxes and loses 4 CSS px/s on top. A decay with a constant loss reaches exactly zero after a finite time, so there is no threshold at which something snaps. The same loss holds the page still where the water moves slower than 4 CSS px/s: the displacement is exactly zero outside a bounded region, and there the output is the source texel.
5. **Stirring.** The pointer pushes the water under it towards its own velocity (the push is the difference to the water's velocity there, so it saturates), over a radius of 32 CSS px. A push is added as its curl: a pair of counter-rotating swirls either side of the path. As the wake of a body in water sheds swirls to alternate sides, the push sways sideways with a period of five radii along the path, so a stroke leaves a street of swirls and not a straight jet. A hovering pointer pushes with 0.11 of its speed, a pressed one or a finger with 0.5 (times `intensity`).
6. **The pigment** (`advect.wgsl`, on the GPU) lives in an rgba16float texture of about one texel per CSS px: the densities of three inks and their age. Every step each texel traces back through the same flow (the curl of the B-spline of the stream function of that very step, a midpoint step) and reads the pigment there with a Catmull-Rom filter limited to the four texels around the point, which keeps filaments a few texels wide over hundreds of steps. A pressed pointer releases two inks side by side along its path (a Gaussian across the path, integrated along each segment with the error function, so consecutive segments join without beads); a press releases a drop of one ink around a core of the next, pushed the way the pointer was heading, which the water rolls into a mushroom. Successive strokes start at another place of the palette (the golden ratio), and the hue drifts along a stroke.
7. **Fading by age.** Pigment keeps its full strength for 1.3 s and has faded out when it is 2.9 s old, whatever its density: a stroke stays whole while it is drawn and folded, and its tail goes in the order it was drawn. All pigment is therefore gone 2.9 s after the last release, which the plugin knows without reading anything back from the GPU.
8. **The picture** (`ink.wgsl`), per device pixel, in linear light: the displacement as a cubic B-spline of the field (no grid shows); where the map squeezes the page, up to 6 taps of the source along the squeezed direction (the largest singular value of the Jacobian, from the same B-spline), so stretched text does not alias; the pigment as a layer of absorbing and scattering particles over the page (Kubelka and Munk): the absorption `K` and the scattering `S` of the three inks add up by density, and the layer's reflectance `R` and transmittance `T` over a page of reflectance `Rg` give `R + T² Rg / (1 - R Rg)` per channel. Over a bright page the ink glazes it; over a dark page it shows by the light its particles scatter. Half a level of dither where there is pigment. Where the field is zero and there is no pigment, the source texel goes out untouched.

## Usage

```html
<script src="dist/hic-live-polyfill.iife.min.js"></script>
<script src="dist/hic-live-effects.iife.min.js"></script>
<script src="dist/plugins/ink.iife.min.js"></script>   <!-- window.HicLivePlugins.ink -->
<script type="module">
  const host = await HTMLInCanvasEffects.createHost(canvas, form, { interposer: true });
  const ink = await host.addPlugin(HicLivePlugins.ink.plugin, { intensity: 0.6, flow: 0.5, pigment: 0.7 });
  ink.mountUI(document.getElementById('controls'));                      // three sliders: Stir, Flow, Pigment
  await ink.trigger('demo');                                             // one stroke across the page; 'still' at rest
  await ink.trigger('stir', { point: { x: 120, y: 80 }, angle: 30 });    // a short stroke there
</script>
```

ES modules: `import { plugin } from '@giuseppe-scotto-lavina/html-in-canvas-polyfill/plugins/ink'`.

## Options

| option | default | |
|---|---|---|
| `intensity` | 0.6 | 0 to 1: how hard the pointer pushes the water; 0 turns the effect off (the output is the source, no pigment) |
| `flow` | 0.5 | 0 to 1: how long swirls live: the flow dies by 1/e in 0.3 s (0), 0.95 s (0.5) or 3 s (1) |
| `heal` | 0.5 | 0 to 1: how fast the page comes home: 1 /s (0), 2.8 /s (0.5) or 8 /s (1) |
| `pigment` | 0.7 | 0 to 1: the density of the ink that a pressed pointer releases; 0 moves the page without any pigment |
| `palette` | `'marbling'` | `'marbling'` (blue, crimson, saffron), `'sumi'` (black with a bronze sheen, vermilion, indigo), `'neon'`, or up to three entries, each a colour (`'#rgb'`, `'#rrggbb'`) or a pair `[ink, sheen]`: the colour of the ink on white paper and the colour of the light it scatters over a dark page |
| `selectText` | `false` | `true`: a pressed pointer that crosses text also selects it, as without the plugin (see Input) |

`mountUI` adds three sliders (`intensity`, `flow`, `pigment`). The gallery passes `meta.defaults`: `{ intensity: 0.6, flow: 0.5, pigment: 0.7 }`.

## Actions

`handle.trigger(action, options)` ([semantics](../../docs/guides/EFFECTS-PLUGINS.md#5-actions-trigger-and-settled)).

| action | options | | resolves with |
|---|---|---|---|
| `demo` | none | one pressed stroke across the page, an S, in 1.3 s (`demoPath`), slow at both ends; then the page heals and the pigment fades | `'still'`, once nothing moves and no pigment is left: 4.4 s at the defaults; `null` when the user takes over during the stroke (a press, a pointer or finger that stirs, `setOptions`: the stroke stops at once and what is there runs out) |
| `stir` | `point`: `{x, y}` in canvas CSS px (default: the centre); `angle`: degrees, 0 to the right, 90 down (default: another direction each time); `strength`: 0.1 to 2 (default 1) | a short pressed stroke through the point: 150 CSS px x `strength` in 0.3 s x √`strength` | `'still'` at rest (about 3.4 s) |
| `clear` | none | the ink is gone at once: flow, displacement and pigment | `'still'`, with the frame that shows the clean page |

`handle.settled()` resolves with `'still'` once nothing moves and no pigment is left (what the pointer stirred counts too). A `point` that is not `{x, y}`, a `strength` or an `angle` that is not a finite number rejects with a `TypeError`; a newer trigger resolves a pending one with `null` (the stroke of a demo stops). The plugin never starts the demo by itself. At `intensity` 0 the actions resolve at once.

## Input

The plugin is `spatial`. `mapInkPoint(state, point)` is the JavaScript twin of the displacement in `ink.wgsl`: the same cubic B-spline over the same 4 x 4 cells of the field, the same clamp to the canvas. It evaluates the uniform block and the field that were uploaded for the presented frame (copied into one of four slots), so it describes exactly those pixels: 0 of 150,000 pixels disagree in the GPU test, and a click reaches the element the user sees mid-swirl. A gesture keeps one frozen mapping. At rest the mapper is the identity. Nothing crosses the walls: a point of the canvas edge maps to the same edge.

- **The pointer** is read through `context.localPoint` (`pointerIn`), so the ink is stirred where the user sees the pointer when another plugin is added after this one.
- **A press on a control** of the page (a field, a button, a slider, a link, a label) is the page's gesture: no drop falls on the field being focused, and a drag that starts there (a slider, a selection in a field) stirs as a hovering pointer does, without pigment.
- **Text selection.** A pressed pointer that moves over the page stirs it; the browser would also select the text it crosses, and the selection would be drawn into the ink. While such a press lasts, a selection that starts outside a text field does not start (`selectstart` is cancelled; this is the plugin's only listener that is not passive). Selections in fields, by the keyboard and without a press are untouched; `selectText: true` turns this off.
- **Touch.** The ink covers the whole canvas and never claims a gesture: its pointer and touch listeners are passive, so a finger keeps scrolling the page. A tap is a drop. A finger that moves over the canvas stirs and releases pigment along its path (its passive `touchmove` events); a finger that scrolls the page stays over the same spot of the canvas and stirs nothing.

## Reduced motion

With `prefers-reduced-motion: reduce` (read when the plugin is added, and by the host at every `trigger`) nothing flows and the page never moves: the mapper stays the identity. A press leaves a soft tint where it landed, which fades in place over the life of the pigment (2.9 s); a drag draws nothing. `demo` resolves `'still'` at once; `stir` leaves that tint at its point and resolves when it has faded.

## Performance

Measured on 2026-11-10 on an Apple M1 Max (macOS, headless Chrome), at 1280 x 800 CSS px and DPR 2 (2560 x 1600 device px, a grid of 112 x 72 cells, a pigment texture of 1200 x 750), while the demo plays: its stroke crosses the whole canvas, so every pass covers most of it. `test/ink-gpu.browser.test.mjs` prints these numbers.

- **Zero work at rest.** At rest, and after every stroke once flow, displacement and pigment are gone, the host renders no effect frame (0 in 3 s in the gallery). A source change at rest renders one frame of one pass that reads one texel per pixel.
- **CPU.** The time inside `render()` (the steps of the fluid, the uploads, the encoding of the passes): at 120 frames per second, one step a frame, 0.70 ms at the mean (p95 0.75 ms, the longest 0.80 ms); at 60 frames per second, two steps a frame, 1.38 ms at the mean (p95 1.44 ms, the longest 1.48 ms). One step of the 112 x 64 grid of a 1100 x 620 canvas costs 0.5 to 0.65 ms in Node 24: about half of it the transport, a fifth the confinement, a sixth the multigrid cycle. A frame at rest costs 0.003 ms. The engine compiles the step before the first stroke: 60 steps of a small fluid while the pipelines compile (about 10 ms), then 30 steps of a fluid of the canvas's size in idle moments of at most 3 ms; without that the first step took 18 ms and the second 5 ms.
- **GPU.** Frames rendered back to back on a device of their own, the time until the GPU is done divided by the frame count (throughput: an upper bound, it includes the submission): 1.01 ms a frame at 120 frames per second (one pigment step and the picture), 1.44 ms at 60 frames per second (two pigment steps and the picture), against 0.06 ms for a pass that only clears the target and 0.12 ms for the plugin at rest. The picture: per device pixel 16 texel loads of the field (only where the 4 x 4 cells may be non-zero), 4 bilinear taps of the pigment (only inside the rectangle that can hold pigment) and 1 to 6 taps of the page. A pigment step: per texel 16 texel loads of the field for the velocity (32 where the water moves more than a quarter of a CSS px in the step: the midpoint), 10 bilinear taps and 4 loads of the pigment; it runs only while pigment is left, over the rectangle that can hold pigment (it grows no faster than the water moves).
- **Memory.** The field: 8 layers of rgba32float at the grid's size (one per step of a frame; 116 x 68 cells, 1 MB for a 1100 x 620 canvas). The pigment: two rgba16float textures of at most 900,000 texels (14.4 MB together at that size). Four mapper states of 126 KB.
- **Allocations.** A frame allocates nothing of its own: the uniform blocks, the pass descriptors, the segment queue and the packed field are reused (the browser makes its pass encoder objects).


## Extended range

With the host's `hdr` option the ink writes nothing above white and nothing below black: the pigment absorbs and scatters the page's own light and adds none. Measured in the gallery with `&hdr=1`, a pointer sweep and the demo: 0 pixels above white and none below 0, on the form and the daylight scene.
## Limitations

- The fluid runs on the CPU (so that the input mapper reads exactly what the GPU draws) on cells of about 10 CSS px: swirls smaller than about 3 cells do not form, and the displacement is smooth at that scale. The pigment has about one texel per CSS px and no more detail than that.
- The pigment is carried by a semi-Lagrangian step, which does not conserve its amount exactly: filaments thinner than about 2 texels lose density as they stretch.
- The flow is a closed box with free-slip walls: nothing flows in or out at the canvas edge, and the page's own content (a button, a border) is no obstacle.
- The page heals along straight lines (each point slides home), it does not unwind the way it was wound.
- Pigment fades by its age, not by its density. Ink released onto older ink makes the mixture younger: the age is carried as a mean.
- A drop that lands with no heading (a press without a move before it) is pushed in a direction that turns by the golden angle from drop to drop, not in a direction of the page.
- With reduced motion a drag draws nothing: only presses leave tints.
- The largest bundle of the example plugins: about a third of it is the two shaders, inlined.
- A resize to another grid starts at rest (a resize by a fraction of a cell keeps the flow); the pigment is dropped whenever its texture changes size.
- WebGPU only (without an adapter `createHost` rejects with a `NotSupportedError`).

## Files and tests

| file | |
|---|---|
| `index.js` | `meta`, `plugin`, `ACTIONS`, the mapper `mapInkPoint`, the uniform layouts `G` and `S`, the palettes and `inkOptics`, `inkMix`, `demoPath`, `pigmentGrid`, the constants of the pointer, the pigment and the actions |
| `sim.js` | the fluid: the grid, the multigrid solve, the velocity, the transport, confinement, the friction and the way to rest, the push (`stir`), the packed field and its B-spline (`fieldAt`) shared with the mapper |
| `ink.wgsl` | the picture: the displaced page, the pigment layer; inlined into the built bundles |
| `advect.wgsl` | one step of the pigment: transport, ageing, release |
| `wgsl.js` | loads the `.wgsl` files when the plugin runs from source; the build replaces it |
| `../_lib/` | `pointer.js` (the pointer through the plugins added after this one), `mapper.js`, `action.js`, `number.js`, `ui.js` |
| `media/ink.webp` | the recording above |
| `test/ink-sim.test.mjs` | Node, the fluid against independent oracles: the stream function against a dense direct solve (Gaussian elimination) and against an eigenfunction of the Laplacian; the velocity against the net flux through closed loops (control: a gradient field has one); a push (the centre takes the pushed velocity, two opposite swirls); the displacement after 0.3 s of a steady swirl against particles traced back through the analytic flow with RK4 (control: the oracle of half the time does not fit); confinement at 3, 30 and 300 /s (the largest vorticity never grows; control: it keeps a swirl tighter than none); the kinetic energy never grows once stirring stops and every field is exactly zero after a finite time (control: without the constant losses the flow is still moving then); the page holds still where the water is slow (the box); the B-spline read against the B-spline basis |
| `test/ink.test.mjs` | Node, the plugin over a recording fake device: the folder contract; the palettes, the hue, the pigment texture, the demo path; the mapper against an independent oracle; nothing at rest; the same fields and pigment steps, bit for bit, at 30, 60 and 120 frames per second (control: another intensity); the demo to rest within 4.5 s at 120, 60 and 24 frames per second; a long gap between frames; hover, press, a press on a control, text selection; the pointer through `context.localPoint`; a finger; reduced motion; the actions `stir`, `demo` and `clear` through the real handle (their options, their end at rest, a user's takeover, superseding, removal); mapper slots and gesture snapshots |
| `test/ink-gpu.browser.test.mjs` | headless Chrome, the real host and GPU: the mapper against the pixels (`plugins/_shared/gpu-check.mjs`; control: the identity, and a mapper of another instant); the frame at intensity 0 and before any input against the host's picture without a plugin, bit for bit, and every pixel that a gentle stroke does not displace; the pigment over white and over black (control: no pigment); the actions through the handle (`demo`: every sixth frame agrees with its mapper, the last frame is the first bit for bit; `stir`; `clear`); zero work at rest; the GPU and CPU time of a frame |
| `test/gallery.e2e.mjs` | the gallery with trusted input: zero effect frames at rest; a hover stirs and the page heals to the same pixels; a pressed pointer releases pigment and selects no text (control: `selectText`); a click on the drawn position of the checkbox toggles it (control: a click on its DOM position does not); typing; the frame cap; the actions from the gallery's buttons, superseding, `settled()`, the user's takeover of the demo; reduced motion. Needs `npm run build` |
