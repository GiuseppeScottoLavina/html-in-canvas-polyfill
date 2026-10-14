# disintegrate

An **example** effect plugin: a transition in which the HTML drawn in a canvas burns away like paper and re-forms. It shows how to use the effects extension of this library (`HTMLInCanvasEffects`, plugin ABI v2). It is **not part of the polyfill**: the polyfill, the frame cap and the effects host work without it, and nothing in `src/` imports it.

The effects host and this plugin are extensions of this library. They are not part of the HTML-in-Canvas proposal, and browsers' native implementations do not provide them ([docs/guides/EFFECTS-PLUGINS.md](../../docs/guides/EFFECTS-PLUGINS.md)).

![The gallery form burning away from the Submit button into flakes and embers, and re-forming with the success line](media/disintegrate.webp)

`media/disintegrate.webp` was recorded in headless Chrome from the plugin gallery: a trusted click on Submit with a valid form (`node plugins/disintegrate/test/gallery.e2e.mjs --record`).

## What it looks like

It is always the form itself that falls apart, never a generic particle cloud:

1. **The fire starts where you pressed** (the Submit button), or just outside a side of the canvas. The form is untouched at first.
2. **A ragged front sweeps out from there.** Ahead of it the form scorches brown; on it runs a thin glowing line. Bright content (text, borders, controls) holds the front back a few pixels, so the line wraps around letters.
3. **The form breaks into flakes**: Voronoi cells about 20 css px across that carry the exact pixels of the form. About half of them break off just ahead of the front with the intact form on them (a piece of a label, the corner of a field); the others burn in place and lift as charred ash. Flakes drift away from the fire and with the wind, rise, spin, curl (darker as they turn edge-on) and burn from the side that faced the fire, their rims glowing.
4. **Every pixel of content a flake loses becomes an ember** of that pixel's colour: born glowing, cooling to grey ash, rising. Embers come only from content (an edge or bright pixel: text, borders, controls), so letters visibly turn into sparks; plain background sheds only a few specks.
5. **Then it all plays in reverse**, with the live form: the page's new state (in the gallery, "Thanks, Ada.") re-forms from the embers and closes back to the Submit button.

## Use

```html
<script src="dist/hic-live-polyfill.iife.min.js"></script>
<script src="dist/hic-live-effects.iife.min.js"></script>
<script src="dist/plugins/disintegrate.iife.min.js"></script>   <!-- window.HicLivePlugins.disintegrate -->
<script>
  const host = await HTMLInCanvasEffects.createHost(canvas, form, { interposer: true });
  const handle = await host.addPlugin(HicLivePlugins.disintegrate.plugin, { onSubmit: 'valid' });
  await HicLivePlugins.disintegrate.trigger(canvas, 'play', { x: 580, y: 400 });   // burn from that point (canvas css px), re-form
</script>
```

ES modules: `import { plugin, trigger } from '@giuseppe-scotto-lavina/html-in-canvas-polyfill/plugins/disintegrate'`.

Ways to start a transition:

| how | |
|---|---|
| `trigger(canvas, action, point?)` | `'out'` burns away and stays gone, `'in'` re-forms, `'play'` does both with a 250 ms pause. `point`: where the fire starts, canvas css px. Returns a promise: `true` when that end state is reached, `false` when another request superseded it, the plugin was removed, or no instance runs on that canvas. |
| `handle.setOptions({ state: 'out' })` / `{ state: 'in' }` | the same, declaratively, through the handle of `addPlugin`. Only a change of `state` starts a transition. |
| `onSubmit: 'valid'` or `'always'` | a `submit` event inside the source plays the transition (`'valid'`: only when no field matches `invalidSelector` at that moment). The page's own submit handler runs first when it was added before the plugin (the gallery's is), so the form re-forms showing the state the page set. |
| the Burn button of `mountUI` | `'play'`, from the button |

Where the fire starts, when no `point` is given: the last pointer press on the canvas within 1.5 s (the Submit or Burn button that was clicked), else the button that submitted the form (a submit with the Enter key), else just outside the `from` side.

What the transition shows: when it starts, the plugin copies the picture the user sees at that moment (one render pass into its own texture), and the way out burns that copy. The way back uses the live source, so changes the page made in the meantime (a success message) are what re-forms. The last frame of the way back is drawn with the host's passthrough formula, so it equals the frame the host presents without any plugin, bit for bit (checked on the GPU).

## Input

The plugin is `spatial`, so it supplies `captureInputMapper`. Its mapper is one of two constant functions, chosen by the frame that was presented:

- **assembled** (idle): the identity. The form is fully usable, the host's interposer passes every pointer event through.
- **while it burns, is gone, or re-forms** (including the reduced-motion crossfade): pointer input is **blocked**. The mapper returns `NO_TARGET` (the effects ABI value for "no element here"), so the host swallows the press: no focus change (the focused field keeps the focus), nothing activated, the click swallowed. Flakes are not hit-tested.

Keyboard input is not mapped by the host: a key pressed during a transition reaches the element that had the focus before it. A second submit during a transition does not restart it.

## Options

| option | default (gallery) | |
|---|---|---|
| `duration` | 2000 | ms of one way (out or in), 300 to 8000 |
| `flakeSize` | 20 | flake (Voronoi cell) size, 8 to 64 css px |
| `particleSize` | 2.5 | ember cell size, 1.5 to 12 css px, rounded to backing pixels; at most 262,144 ember cells (cells grow beyond) |
| `from` | `'left'` | where the fire starts when there is no point: `'left'`, `'right'`, `'top'`, `'bottom'` (just outside that side) |
| `wind` | 1 | 0 to 2: how far flakes and embers drift (0.4 x the larger canvas side at 1) |
| `direction` | -70 | wind direction in degrees (0 = right, negative = up) |
| `turbulence` | 1 | 0 to 2: the wobble of flakes and the swirl of embers |
| `density` | 0.5 | 0 to 1: how many specks of ash plain background sheds (content always sheds embers) |
| `glow`, `glowAmount` | `#ff9e4d`, 0.9 | the colour and strength of the burning line, the glowing rims and the newborn embers |
| `backdrop` | the host's clear colour | what is left behind (`#rrggbb` or `[r, g, b]` 0..1) |
| `onSubmit` | `'off'` (`'valid'`) | `'off'`, `'valid'`, `'always'` |
| `invalidSelector` | `:invalid, [aria-invalid="true"], .invalid` | what counts as an invalid field for `onSubmit: 'valid'` |
| `intro` | false (true) | when created, re-form from ash once the first snapshot is there (skipped when re-created after a device loss) |
| `state` | `'in'` | `'out'` / `'in'`: see above |
| `reducedMotion` | follows `prefers-reduced-motion` | `true` / `false` to force it |
| `seed` | 1 | the pattern of flakes and noise |

`mountUI` adds a Burn button and sliders for the flake size and the wind.

## How it works

- **One clock.** Everything is a function of the dissolve amount `g` (0 assembled, 1 gone) and of the pixel: when the front reaches it (the distance from the origin over the canvas, plus a slow wobble and a fine tear, plus the hold of bright content), when its flake lifts, where the flake is at its age, when its pixel turns to ash. Nothing is simulated frame by frame, so `g = 0` is the form exactly, and the same instant looks the same at any frame cap. The front crosses the canvas by `g = 0.6`, a flake lives 0.32 of the timeline, an ember 0.16; `flakeTiming` in `index.js` is the twin of the shader's timing and the tests check that everything is gone by `g = 1`.
- **Three draws in one pass.** The paper that has not lifted (a full-screen pass that scorches, draws the glowing line and the char), the flakes (one quad per Voronoi cell; a fragment is kept only inside its own cell, so the flakes tile the form exactly), the embers (one triangle per ember cell, round in the fragment shader).
- **Embers are made once per phase.** Where, when, in which colour and how big an ember is born does not depend on `g`: a compute pass (`cs_embers`) works it out from the picture into a storage buffer when a phase starts (the frozen picture for the way out, the live one for the way back) and again only when the page changes during the way back, a resize, or new options. Every frame the vertex shader only ages them.
- **No per-frame allocation.** A frame writes one preallocated `Float32Array` into one uniform buffer and reuses its render pass descriptor; bind groups are cached per texture view; the frozen texture and the ember buffer are allocated once per size.
- **Frame cap.** The timeline is driven by `frame.now` and starts at the first frame rendered after the request, so a transition lasts the same time at any cap; at a 15 fps cap the frame at a given instant equals the 120 Hz one (checked). The instance is `continuous` only while it animates; idle, the host renders only when the source changes.
- **`prefers-reduced-motion: reduce`**: nothing burns or moves; the same triggers crossfade the picture to the backdrop and back, over the same duration.
- **Device loss.** The host creates the plugin again on the new device with the latest options; the new instance starts assembled, without the intro, and promises of the lost instance resolve `false`.

## Measured

On one machine (Apple M1 Max, macOS, headless Chrome, Metal, other work running on the machine), with timestamp queries on the plugin's render pass at 2200x1240 backing pixels (the gallery canvas at DPR 2), frames 8.33 ms apart through a whole play: GPU time p50 0.92 ms, p95 1.64 ms, max 2.6 ms while it burns (1,705 flakes, 109,120 ember cells); idle p50 0.2 ms. The two frames that also run the compute pass that makes the embers took 2.7 ms and 1.3 ms from submit to done (wall clock, an upper bound). `render()` on the CPU p95 0.01 ms. Chrome quantises timestamps, and these numbers come from one run: they say the effect fits a 120 Hz frame (8.33 ms) on this machine, nothing about others. `test/disintegrate-perf.browser.test.mjs` prints them again.

## Files

| file | |
|---|---|
| `index.js` | `meta`, `plugin`, `trigger`, and the pure helpers the tests use (`particleGrid`, `flakeGrid`, `originFor`, `frontSpan`, `flakeTiming`, `readOptions`, `fillUniforms`) |
| `../_lib/transition.js` | shared with the shatter plugin, bundled into each: the out/in timeline, the two mappers, option parsing, the invalid-field probe (pure) |
| `disintegrate.wgsl` | the shader: full-screen pass (assembled frame, crossfade, freeze copy), the burning paper, the flakes, the embers and the compute pass that makes them |
| `wgsl.js` | loads the `.wgsl` file when the plugin runs from source; the build replaces it |
| `media/disintegrate.webp` | the recording above |
| `test/disintegrate.test.mjs` | Node: the folder contract, the timeline, the timing invariants (and that the shader uses the same constants), the grids, the origin of the fire, options, uniforms, and a fake GPU (no GPU object per frame, the embers made once per phase, the three draws, mapper per frame, triggers, the origin at the pointer press, submit wiring, destroy) |
| `test/disintegrate-gpu.browser.test.mjs` | headless Chrome, real host and GPU: assembled frame = passthrough bit for bit, mid-transition frames non-blank and moving, the fire starts at the pointer (the far corner untouched early on), input blocked through the interposer (identity when idle as the control), 120 Hz vs 15 fps cap, reduced-motion crossfade, device loss, intro and submit wiring |
| `test/disintegrate-perf.browser.test.mjs` | the GPU time measurement above |
| `test/gallery.e2e.mjs` | the plugin in the real gallery with trusted input: idle click-through and typing, Submit burns it from the button, a click during it changes nothing (focus kept, nothing activated), success state after, usable again, the Burn button; `--record` writes the media. Steps shared with other transitions: `plugins/_shared/transition-e2e.mjs`. Needs `npm run build`; `npm run test:plugins` runs every gallery e2e. |
