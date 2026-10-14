# disintegrate

An **example** effect plugin: a transition in which the HTML drawn in a canvas burns away like paper and re-forms. It shows how to use the effects extension of this library (`HTMLInCanvasEffects`, plugin ABI v2). It is **not part of the polyfill**: the polyfill, the frame cap and the effects host work without it, and nothing in `src/` imports it.

The effects host and this plugin are extensions of this library. They are not part of the HTML-in-Canvas proposal, and browsers' native implementations do not provide them ([docs/guides/EFFECTS-PLUGINS.md](../../docs/guides/EFFECTS-PLUGINS.md)).

![The gallery form, with its live counter running, burning from the Submit button into 3D flakes and embers while text is still being typed into it, and re-forming with the success line and the typed text](media/disintegrate.webp)

`media/disintegrate.webp` was recorded in headless Chrome from the plugin gallery: the "Live counter" of the controls on, Enter in the name field (a valid submit), text typed while the form burns (`node plugins/disintegrate/test/gallery.e2e.mjs --record`).

## The point: the page stays live while it burns

A screenshot and a particle shader can fake a dissolve of a still picture. Here nothing is frozen: the paper, every flake and every ember sample the live page on every frame. A counter keeps counting on the flakes that carry it, text typed while the form burns appears on the flakes of its field (keyboard input is not blocked), and the form re-forms in the state the page has by then. The plugin's controls have a "Live counter" checkbox that shows a running stopwatch inside the form, to make this visible; it applies to any HTML, with no change to it.

## What it looks like

It is always the form itself that falls apart, never a generic particle cloud:

1. **The fire starts where you pressed** (the Submit button), or just outside a side of the canvas. The form is untouched at first.
2. **A ragged front sweeps out from there.** Ahead of it the form scorches brown and the hot air above the fire makes it shimmer; on it runs a thin glowing line. Bright content (text, borders, controls) holds the front back a few pixels, so the line wraps around letters.
3. **The form breaks into flakes**: Voronoi cells about 28 css px across that carry the live pixels of the form. About half of them break off just ahead of the front with the intact form on them (a piece of a label, digits of the counter, the corner of a field); the others burn in place and lift as charred ash. Flakes are 3D: they tumble about an axis in the page (most gently, so their content keeps facing you; a few right over, showing their charred underside), drift away from the fire and with the wind, rise towards the camera (the intact ones) or sink away from it, catch the light of a lamp and the glow of the fire below them, and burn from the side that faced the fire, their rims glowing.
4. **Every pixel of content a flake loses becomes an ember** of that pixel's live colour: born glowing, cooling to grey ash, rising. Embers come only from content (an edge or bright pixel: text, borders, controls), so letters visibly turn into sparks; plain background sheds only a few specks.
5. **Depth.** A camera straight above the page (perspective: the page itself is drawn one to one) sees what rises towards it larger and out of focus: flakes blur with their distance from the page, embers spread into soft bokeh discs. Behind the front, smoke lit by the fire drifts over the burned area and fades.
6. **Then it all plays in reverse**, with the live form: the page's new state (in the gallery, "Thanks, Ada." and whatever was typed during the burn) re-forms from the embers and closes back to the Submit button.

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

What the transition shows: the live source, on both ways and on every frame (nothing is copied when it starts), so changes the page makes in the meantime (a running counter, typed text, a success message) are on the paper, on the flakes and on the embers. The last frame of the way back is drawn with the host's passthrough formula, so it equals the frame the host presents without any plugin, bit for bit (checked on the GPU).

## Input

The plugin is `spatial`, so it supplies `captureInputMapper`. Its mapper is one of two constant functions, chosen by the frame that was presented:

- **assembled** (idle): the identity. The form is fully usable, the host's interposer passes every pointer event through.
- **while it burns, is gone, or re-forms** (including the reduced-motion crossfade): pointer input is **blocked**. The mapper returns `NO_TARGET` (the effects ABI value for "no element here"), so the host swallows the press: no focus change (the focused field keeps the focus), nothing activated, the click swallowed. Flakes are not hit-tested.

Keyboard input is not mapped by the host: a key pressed during a transition reaches the element that had the focus before it. A second submit during a transition does not restart it.

## Options

| option | default (gallery) | |
|---|---|---|
| `duration` | 3200 | ms of one way (out or in), 300 to 8000 |
| `flakeSize` | 28 | flake (Voronoi cell) size, 8 to 64 css px |
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
| `liveCounter` | false | the controls (`mountUI`) start with the "Live counter" on |

`mountUI` adds a Burn button, sliders for the flake size and the wind, and a "Live counter" checkbox: a stopwatch (large digits, 20 updates a second) inside the form, which keeps running while the form burns.

## How it works

- **One clock.** Everything is a function of the dissolve amount `g` (0 assembled, 1 gone) and of the pixel: when the front reaches it (the distance from the origin over the canvas, plus a slow wobble and a fine tear, plus the hold of bright content), when its flake lifts, where the flake is in 3D at its age, when its pixel turns to ash; the shimmer of the hot air and the smoke move with the time since the phase started (also a function of `g`). Nothing is simulated frame by frame, so `g = 0` is the form exactly, and the same instant looks the same at any frame cap. The front crosses the canvas by `g = 0.45`, a flake lives 0.5 of the timeline, an ember 0.16; `flakeTiming` in `index.js` is the twin of the shader's timing and the tests check that everything is gone by `g = 1`.
- **Live.** The paper and the flakes sample the source texture of the frame; an ember keeps the position of the pixel it came from and reads its colour there in the vertex shader, every frame.
- **3D.** A flake's pose is a rotation (Rodrigues) about a hashed axis plus a drift and a rise, projected by a camera `2.4` canvas sizes above the page; its normal decides which side shows (the live front or the charred underside) and how it is lit. Depth of field: a flake's picture and outline are blurred by `0.012` css px per css px of height; an ember's disc grows by its circle of confusion and spreads its light.
- **Three draws in one pass.** The paper that has not lifted (a full-screen pass that scorches, draws the glowing line and the char), the flakes (one quad per Voronoi cell; a fragment is kept only inside its own cell, so the flakes tile the form exactly), the embers (one triangle per ember cell, round in the fragment shader).
- **Embers are made when the picture changes.** Where, when and how big an ember is born does not depend on `g`: a compute pass (`cs_embers`) works it out from the picture into a storage buffer when a transition starts, and again only when the page changes, a resize, or new options. Every frame the vertex shader only ages them and reads their live colour.
- **No per-frame allocation.** A frame writes one preallocated `Float32Array` into one uniform buffer and reuses its render pass descriptor; bind groups are cached per texture view; the ember buffer is allocated once per size.
- **Frame cap.** The timeline is driven by `frame.now` and starts at the first frame rendered after the request, so a transition lasts the same time at any cap; at a 15 fps cap the frame at a given instant equals the 120 Hz one (checked). The instance is `continuous` only while it animates; idle, the host renders only when the source changes.
- **`prefers-reduced-motion: reduce`**: nothing burns or moves; the same triggers crossfade the picture to the backdrop and back, over the same duration.
- **Device loss.** The host creates the plugin again on the new device with the latest options; the new instance starts assembled, without the intro, and promises of the lost instance resolve `false`.

## Measured

On one machine (Apple M1 Max, macOS, headless Chrome, Metal, other work running on the machine), with timestamp queries on the plugin's render pass at 2200x1240 backing pixels (the gallery canvas at DPR 2), frames 8.33 ms apart through a whole play: GPU time p50 1.8 ms, p95 3.0 ms, max 3.7 ms while it burns (3D flakes with blurred sampling, depth-of-field embers, smoke); idle p50 0.8 ms. `render()` on the CPU p95 0.01 ms. Chrome quantises timestamps, and these numbers come from one run: they say the effect fits a 120 Hz frame (8.33 ms) on this machine, nothing about others. `test/disintegrate-perf.browser.test.mjs` prints them again.

`test/gallery.e2e.mjs` (headless Chrome 155, trusted CDP input, the plugin gallery, 2026-10-14): 20 of 20 checks pass, among them: the counter of the controls runs; Enter in the name field burns the form from the Submit button while typing still reaches the field and the counter keeps counting; the re-formed form shows the text typed during the burn; presses during the transition are swallowed; no console error.

## Files

| file | |
|---|---|
| `index.js` | `meta`, `plugin`, `trigger`, and the pure helpers the tests use (`particleGrid`, `flakeGrid`, `originFor`, `frontSpan`, `flakeTiming`, `readOptions`, `fillUniforms`) |
| `../_lib/transition.js` | shared with the shatter plugin, bundled into each: the out/in timeline, the two mappers, option parsing, the invalid-field probe (pure) |
| `disintegrate.wgsl` | the shader: full-screen pass (assembled frame, crossfade), the burning paper (heat shimmer, smoke), the 3D flakes, the embers and the compute pass that makes them |
| `wgsl.js` | loads the `.wgsl` file when the plugin runs from source; the build replaces it |
| `media/disintegrate.webp` | the recording above |
| `test/disintegrate.test.mjs` | Node: the folder contract, the timeline, the timing invariants (and that the shader uses the same constants), the grids, the origin of the fire, options, uniforms, and a fake GPU (no GPU object per frame, nothing frozen, the embers made again only when the page changes, the three draws, mapper per frame, triggers, the origin at the pointer press, submit wiring, destroy) |
| `test/disintegrate-gpu.browser.test.mjs` | headless Chrome, real host and GPU: assembled frame = passthrough bit for bit, mid-transition frames non-blank and moving, the fire starts at the pointer (the far corner untouched early on), input blocked through the interposer (identity when idle as the control), 120 Hz vs 15 fps cap, reduced-motion crossfade, device loss, intro and submit wiring, and **live**: a change of the page made after its flakes broke off shows up on them, away from where it was drawn (two runs without the change are identical, the control) |
| `test/disintegrate-perf.browser.test.mjs` | the GPU time measurement above |
| `test/gallery.e2e.mjs` | the plugin in the real gallery with trusted input: idle click-through and typing, Submit burns it from the button, a click during it changes nothing (focus kept, nothing activated), success state after, usable again, the Burn button, the live counter, typing during the burn and the re-formed state; `--record` writes the media. Steps shared with other transitions: `plugins/_shared/transition-e2e.mjs`. Needs `npm run build`; `npm run test:plugins` runs every gallery e2e. |
