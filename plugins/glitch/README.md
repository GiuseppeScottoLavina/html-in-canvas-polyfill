# glitch

An **example** effect plugin: a controlled digital glitch over the HTML drawn in a canvas. It shows how to use the effects extension of this library (`HTMLInCanvasEffects`, plugin ABI v2). It is **not part of the polyfill**: the polyfill, the frame cap and the effects host work without it, and nothing in `src/` imports it.

The effects host and this plugin are extensions of this library. They are not part of the HTML-in-Canvas proposal, and browsers' native implementations do not provide them ([docs/guides/EFFECTS-PLUGINS.md](../../docs/guides/EFFECTS-PLUGINS.md)).

![glitch in the plugin gallery](media/glitch.webp)

## What it does

Layers: RGB channel split (red and blue sampled a few pixels apart, green in place), block displacement, scanline tearing (full-width bands shifted sideways), pixel-sorting streaks (a pixel takes the brightest of the pixels above it, so bright runs smear downwards), grain and scanlines.

| mode | |
|---|---|
| `'ambient'` (default) | subtle and continuous: a faint split, grain and scanlines, and about every 1.7 s a micro-glitch of 70 to 160 ms (a few small block shifts) |
| `'burst'` | nothing until a burst is triggered |

A **burst** (520 ms; a new pattern every 45 ms, every fifth pattern clean so that it flickers; full strength for 60 % of the time, then fading) plays in either mode when:
- an element of the drawn page starts to match `watch`: by default a validation error, `[aria-invalid="true"], .invalid, [data-state="error"]` (a `MutationObserver` on the source watches `class`, `aria-invalid` and `data-state`). In the plugin gallery a Submit with an invalid email sets `.invalid` and `data-state="error"`, so the form glitches, without any change to the gallery page;
- an `invalid` event fires in the page (native constraint validation);
- the `trigger` option changes (`handle.setOptions({ trigger: Date.now() })`; the value given to `addPlugin` is the baseline, not a trigger);
- the Burst button of `mountUI` is pressed.
Triggers closer than 250 ms are one burst. All randomness is a hash of (seed, burst, pattern, index): the same instant gives the same picture and the same mapper at every frame cap.

## Input

`mapGlitchPoint(state, point)` is the JavaScript twin of `glitch.wgsl`. Only the shift blocks move the page: outside them the mapper is the identity; inside, it returns the point the block shows, its integer offset undone and wrapped around the page like the shader. So a click on a displaced field reaches the field the user sees there, **also during a burst** (no input is suspended). The colour layers do not move the page: under a sort streak, the split, the grain or the scanlines, input goes to the element at that place.

The shader draws the page and then each block as an instanced rectangle on top of the previous ones (the last block that covers a pixel is visible); the mapper takes the last block that covers the point. Every block edge and offset is a whole CSS pixel, so the shader samples texel centres and the mapper is exact.

## Use

```html
<script src="dist/hic-live-polyfill.iife.min.js"></script>
<script src="dist/hic-live-effects.iife.min.js"></script>
<script src="dist/plugins/glitch.iife.min.js"></script>   <!-- window.HicLivePlugins.glitch -->
<script>
  const host = await HTMLInCanvasEffects.createHost(canvas, form, { interposer: true });
  const glitch = await host.addPlugin(HicLivePlugins.glitch.plugin, { mode: 'ambient', intensity: 0.35 });
  glitch.mountUI(document.getElementById('controls'));   // mode, intensity, Burst button
  form.addEventListener('submit', (e) => { if (!valid(form)) glitch.setOptions({ trigger: performance.now() }); });   // or rely on `watch`
</script>
```

| option | | |
|---|---|---|
| `mode` | `'ambient'` (default) or `'burst'` | see above |
| `intensity` | 0 to 1, default 0.35 | strength of the ambient layers and of the bursts |
| `split`, `sort`, `noise` | booleans, default true | the RGB split, the sort streaks, the grain and scanlines |
| `seed` | integer, default 1 | the random patterns |
| `watch` | CSS selector, default `[aria-invalid="true"], .invalid, [data-state="error"]` | elements whose appearance triggers a burst; `''` turns it off |
| `trigger` | any value | a change plays a burst |

`prefers-reduced-motion: reduce`: no block ever moves (the mapper is the identity), the grain does not animate, there are no micro-glitches, and a burst is one steady frame of split colour for its duration. Frames are requested only while the picture changes (ambient mode; a burst); burst mode at rest costs nothing. Per frame the render path allocates nothing (one uniform array rewritten in place, one reused pass descriptor; mappers are copied into 4 preallocated slots). After a GPU device loss the host re-creates the plugin with the same options.

## Measured

`test/glitch-gpu.browser.test.mjs`, headless Chrome on an Apple M1 Max (Metal), 2200x1240 backing pixels (1100x620 CSS px at DPR 2), burst frames with every layer on (15 blocks), while other work ran on the machine: 0.11 ms per frame submitted back to back (the one-sample template pass: 0.09 ms); about 1.3 % of the 8.33 ms frame at 120 Hz. A first version looped over the 16 blocks in the fragment shader: 0.48 ms per frame; drawing each block as an instanced rectangle removed the loop. Headless Chrome presents at most 60 frames per second, so the 120 Hz budget was checked as GPU time per frame, not as presented frames.

`test/gallery.e2e.mjs` (headless Chrome 155, trusted CDP input, the plugin gallery): every check passes (8, and 9 with `--record`). Among them: ambient presents 30 / 60 / 60 frames per second at frame caps 30 / 60 / 120; a trusted Submit with an invalid email plays a burst through the gallery's unchanged validation code; the Burst button works through the effect; burst mode at rest and reduced-motion ambient present no frame; a reduced-motion burst presents 2 frames (its start and its end).

## Files

| file | |
|---|---|
| `index.js` | `meta`, `plugin`, the mapper `mapGlitchPoint`, the pure frame function `fillGlitchFrame` and block generator `fillBlocks` |
| `glitch.wgsl` | the shader; inlined into the built bundles |
| `wgsl.js` | loads the `.wgsl` file when the plugin runs from source; the build replaces it |
| `test/glitch.test.mjs` | Node: the folder contract, the generator, the mapper against an independent port of the shader on every pixel, bursts, ambient, reduced motion, the same frame at 120/60/30/15 fps, the triggers, no allocation per frame |
| `test/glitch-gpu.browser.test.mjs` | headless Chrome: `checkMapperAgainstGpu` on the displacement (identity as positive control), every layer on read on the green channel, the next pattern's mapper as wrong-mapper control, ambient, the GPU time |
| `test/gallery.e2e.mjs` | the gallery click-through with trusted input (`node plugins/glitch/test/gallery.e2e.mjs [--record]`; `npm run test:plugins` runs every gallery e2e), which also records `media/glitch.webp`; shared steps in `plugins/_shared/gallery-e2e.mjs` |
| `media/glitch.webp` | the recording above (headless Chrome, the plugin gallery) |
