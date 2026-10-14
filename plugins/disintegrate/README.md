# disintegrate

An **example** effect plugin: a transition in which the HTML drawn in a canvas turns to dust made of its own pixels, blows away and reassembles. It shows how to use the effects extension of this library (`HTMLInCanvasEffects`, plugin ABI v2). It is **not part of the polyfill**: the polyfill, the frame cap and the effects host work without it, and nothing in `src/` imports it.

The effects host and this plugin are extensions of this library. They are not part of the HTML-in-Canvas proposal, and browsers' native implementations do not provide them ([docs/guides/EFFECTS-PLUGINS.md](../../docs/guides/EFFECTS-PLUGINS.md)).

![The gallery form dissolving into particles and reassembling](media/disintegrate.webp)

`media/disintegrate.webp` was recorded in headless Chrome from the plugin gallery (`node plugins/disintegrate/test/gallery.e2e.mjs --record`).

## Use

```html
<script src="dist/hic-live-polyfill.iife.min.js"></script>
<script src="dist/hic-live-effects.iife.min.js"></script>
<script src="dist/plugins/disintegrate.iife.min.js"></script>   <!-- window.HicLivePlugins.disintegrate -->
<script>
  const host = await HTMLInCanvasEffects.createHost(canvas, form, { interposer: true });
  const handle = await host.addPlugin(HicLivePlugins.disintegrate.plugin, { onSubmit: 'valid' });
  await HicLivePlugins.disintegrate.trigger(canvas, 'play');   // out, a short pause, in; resolves true at the end
</script>
```

ES modules: `import { plugin, trigger } from '@giuseppe-scotto-lavina/html-in-canvas-polyfill/plugins/disintegrate'`.

Ways to start a transition:

| how | |
|---|---|
| `trigger(canvas, action)` | `'out'` dissolves and stays gone, `'in'` reassembles, `'play'` does both with a 380 ms pause. Returns a promise: `true` when that end state is reached, `false` when another request superseded it, the plugin was removed, or no instance runs on that canvas. |
| `handle.setOptions({ state: 'out' })` / `{ state: 'in' }` | the same, declaratively, through the handle of `addPlugin`. Only a change of `state` starts a transition. |
| `onSubmit: 'valid'` or `'always'` | a `submit` event inside the source plays the transition (`'valid'`: only when no field matches `invalidSelector` at that moment). The page's own submit handler runs first when it was added before the plugin (the gallery's is), so with `'valid'` the form reassembles showing the state the page set (in the gallery, the success message). |
| the Snap button of `mountUI` | `'play'` |

What the transition shows: when it starts, the plugin copies the picture the user sees at that moment (one render pass into its own texture), and the particles of the way out are made of that copy. The way back samples the live source, so changes the page made in the meantime (a success message) appear as the particles land. The last frame of the way back is drawn with the host's passthrough formula, so it equals the frame the host presents without any plugin, bit for bit (checked on the GPU).

## Input

The plugin is `spatial`, so it supplies `captureInputMapper`. Its mapper is one of two constant functions, chosen by the frame that was presented:

- **assembled** (idle): the identity. The form is fully usable, the host's interposer passes every pointer event through.
- **while pieces move, are gone, or fade** (including the reduced-motion crossfade): pointer input is **blocked**. The mapper returns `NO_TARGET` (the effects ABI value for "no element here"), so the host swallows the press: no focus change (the focused field keeps the focus), nothing activated, the click swallowed. A pointer released on blank space of the page outside any control is not affected.

Keyboard input is not mapped by the host: a key pressed during a transition reaches the element that had the focus before it (a press during the transition removes that focus). A second submit during a transition does not restart it.

## Options

| option | default (gallery) | |
|---|---|---|
| `particleSize` | 3 | particle (grid cell) size, 1.5 to 12 css px, rounded to backing pixels; at most 262,144 particles (cells grow beyond) |
| `wind` | 1 | 0 to 2: how far particles travel (0.55 x the larger canvas side at 1) |
| `direction` | -25 | wind direction in degrees (0 = right, negative = up); the downwind side leaves first |
| `turbulence` | 1 | 0 to 2: noise-driven swirl added to the wind |
| `sizeVariation` | 0.7 | 0 to 1: particles shrink or grow as they fly |
| `duration` | 1700 | ms of one way (out or in), 300 to 8000 |
| `glow`, `glowAmount` | `#ffb06b`, 0.5 | the ember colour a particle flashes as it tears off |
| `backdrop` | the host's clear colour | what is left behind (`#rrggbb` or `[r, g, b]` 0..1) |
| `onSubmit` | `'off'` (`'valid'`) | `'off'`, `'valid'`, `'always'` |
| `invalidSelector` | `:invalid, [aria-invalid="true"], .invalid` | what counts as an invalid field for `onSubmit: 'valid'` |
| `intro` | false (true) | when created, reassemble from dust once the first snapshot is there (skipped when re-created after a device loss) |
| `state` | `'in'` | `'out'` / `'in'`: see above |
| `reducedMotion` | follows `prefers-reduced-motion` | `true` / `false` to force it |
| `seed` | 1 | the noise pattern |

`mountUI` adds a Snap button and sliders for the particle size and the wind.

## Motion, frame cap, device loss

- **No particle state.** Particle `i` is the grid cell `i`; its start time, path, size and fade are functions of the cell and of the dissolve amount `g` (0 assembled, 1 gone), computed in the vertex shader of one instanced draw (6 vertices per particle, no vertex buffer). Nothing is simulated or stored per particle, and `g = 0` puts every particle exactly on its cell. `particleAge` in `index.js` is the JavaScript twin of the shader's age formula.
- **No per-frame allocation.** A frame writes one preallocated `Float32Array` into one uniform buffer and reuses its render pass descriptor; bind groups are cached per texture view. The frozen texture is allocated once per source size.
- **Frame cap.** The timeline is driven by `frame.now` and starts at the first frame rendered after the request, so a transition lasts the same time at any cap; at a 15 fps cap the frame at a given instant equals the 120 Hz one (checked). The instance is `continuous` only while it animates; idle, the host renders only when the source changes.
- **`prefers-reduced-motion: reduce`**: no particle moves; the same triggers crossfade the picture to the backdrop and back, over the same duration.
- **Device loss.** The host creates the plugin again on the new device with the latest options; the new instance starts assembled, without the intro, and promises of the lost instance resolve `false`.

## Measured

On one machine (Apple M1 Max, macOS, headless Chrome, Metal), with timestamp queries on the plugin's pass at 2200x1240 backing pixels (the gallery canvas at DPR 2), frames 8.33 ms apart through a whole play: GPU time of the pass p50 0.33 ms, p95 0.46 ms, max 2.3 ms while particles move (75,969 particles); idle p50 0.26 ms; `render()` on the CPU p95 0.01 ms. Chrome quantises timestamps, and these numbers come from one run: they say the pass fits a 120 Hz frame (8.33 ms) on this machine, nothing about others. `test/disintegrate-perf.browser.test.mjs` prints them again.

## Files

| file | |
|---|---|
| `index.js` | `meta`, `plugin`, `trigger`, and the pure helpers the tests use (`particleGrid`, `particleAge`, `readOptions`, `fillUniforms`) |
| `../_lib/transition.js` | shared with the shatter plugin, bundled into each: the out/in timeline, the two mappers, option parsing, the invalid-field probe (pure) |
| `disintegrate.wgsl` | the shader: full-screen pass (assembled frame, crossfade, freeze copy) and the instanced particles |
| `wgsl.js` | loads the `.wgsl` file when the plugin runs from source; the build replaces it |
| `media/disintegrate.webp` | the recording above |
| `test/disintegrate.test.mjs` | Node: the folder contract, the timeline, the reassembly invariant of the particle ages, the grid, options, uniforms, and a fake GPU (no GPU object per frame, mapper per frame, triggers, submit wiring, destroy) |
| `test/disintegrate-gpu.browser.test.mjs` | headless Chrome, real host and GPU: assembled frame = passthrough bit for bit, mid-transition frames non-blank and moving, input blocked through the interposer (identity when idle as the control), 120 Hz vs 15 fps cap, reduced-motion crossfade, device loss, intro and submit wiring |
| `test/disintegrate-perf.browser.test.mjs` | the GPU time measurement above |
| `test/gallery.e2e.mjs` | the plugin in the real gallery with trusted input: idle click-through and typing, Submit plays it, a click during it changes nothing (focus kept, nothing activated), success state after, usable again; `--record` writes the media. Steps shared with shatter: `plugins/_shared/transition-e2e.mjs`. Needs `npm run build`; `npm run test:plugins` runs every gallery e2e. |
