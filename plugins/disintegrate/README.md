# disintegrate

An **example** effect plugin: a transition in which the CONTENT of the HTML drawn in a canvas turns to dust and blows away, while the page itself stays, and then flies back into the page's new state. It shows how to use the effects extension of this library (`HTMLInCanvasEffects`, plugin ABI v2). It is **not part of the polyfill**: the polyfill, the frame cap and the effects host work without it, and nothing in `src/` imports it.

The effects host and this plugin are extensions of this library. They are not part of the HTML-in-Canvas proposal, and browsers' native implementations do not provide them ([docs/guides/EFFECTS-PLUGINS.md](../../docs/guides/EFFECTS-PLUGINS.md)).

![The gallery form, with its live counter running: the text, fields and buttons turn to dust of their own colours along a diagonal sweep while the panels stay, the dust swirls away, then flies back and settles into the letters, with the text typed meanwhile and the new counter value](media/disintegrate.webp)

`media/disintegrate.webp` was recorded in headless Chrome from the plugin gallery: the "Live counter" of the controls on, Enter in the name field (a valid submit), text typed while the content is dust (`node plugins/disintegrate/test/gallery.e2e.mjs --record`).

## The point: the page stays live while it turns to dust

A screenshot and a particle shader can fake the dissolve of a still picture. Here nothing is frozen: the page and every grain of dust sample the live page on every frame. A counter keeps counting on the dust that carries it, text typed while the content is dust appears on the dust of its field (keyboard input is not blocked), and the dust settles back into the state the page has by then (the typed text, the success line, the counter's new value). The plugin's controls have a "Live counter" checkbox that shows a running stopwatch inside the form, to make this visible. It applies to any HTML, with no change to it.

## What it looks like

1. **Only the content goes.** Text, field borders and fills, buttons, icons: every pixel that differs from the background around it. The panels, cards and the page behind them stay, so no frame of the transition is dark.
2. **A diagonal sweep erodes it**, from the top left: the content goes porous (holes open at the scale of a few pixels, ragged at a larger one), thins, and is gone.
3. **Every eroded pixel becomes a grain of dust of its exact live colour** (light text gives light dust, a cyan button cyan dust), carried by the wind along swirling paths (the curl of a noise field), half of the grains streaking with their speed, a third leaving as small fragments that travel whole for a moment and then crumble.
4. **No still frame.** The way out takes 1.8 s: the content is gone after about 0.9 s and the dust keeps drifting until the end; a play then turns at once and the dust flies back at full strength (it fades out only when a transition ends gone).
5. **The re-forming is the climax**: in 1.2 s the dust flies back along the same paths, slowing as it arrives, and settles into the letters and fields of the page as it is now.

## Use

```html
<script src="dist/hic-live-polyfill.iife.min.js"></script>
<script src="dist/hic-live-effects.iife.min.js"></script>
<script src="dist/plugins/disintegrate.iife.min.js"></script>   <!-- window.HicLivePlugins.disintegrate -->
<script>
  const host = await HTMLInCanvasEffects.createHost(canvas, form, { interposer: true });
  const handle = await host.addPlugin(HicLivePlugins.disintegrate.plugin, { onSubmit: 'valid' });
  await HicLivePlugins.disintegrate.trigger(canvas, 'play');   // to dust and back
</script>
```

ES modules: `import { plugin, trigger } from '@giuseppe-scotto-lavina/html-in-canvas-polyfill/plugins/disintegrate'`.

| how | |
|---|---|
| `trigger(canvas, action)` | `'out'` turns the content to dust and stays so, `'in'` re-forms it, `'play'` does both. Returns a promise: `true` when that end state is reached, `false` when another request superseded it, the plugin was removed, or no instance runs on that canvas. |
| `handle.setOptions({ state: 'out' })` / `{ state: 'in' }` | the same, declaratively. Only a change of `state` starts a transition. |
| `onSubmit: 'valid'` or `'always'` | a `submit` event inside the source plays the transition (`'valid'`: only when no field matches `invalidSelector` at that moment). The page's own submit handler runs first when it was added before the plugin (the gallery's is), so the form re-forms showing the state the page set. |
| the "Turn to dust" button of `mountUI` | `'play'` |

## Input

The plugin is `spatial`, so it supplies `captureInputMapper`. Its mapper is one of two constant functions, chosen by the frame that was presented: **assembled** (idle) the identity, the form is fully usable; **while anything moves, is gone or fades** (also the reduced-motion crossfade) pointer input is **blocked**: the mapper returns `NO_TARGET`, so the host swallows the press (no focus change, nothing activated). Keyboard input is not mapped by the host: a key pressed during a transition reaches the element that had the focus. A second submit during a transition does not restart it.

## Options

| option | default | |
|---|---|---|
| `duration` | 1800 | ms of the way out (the dust keeps drifting after the content is gone), 300 to 8000 |
| `durationIn` | 1200 | ms of the way back |
| `particleSize` | 1.5 | dust cell, 1 to 4 css px; at most 420,000 cells (cells grow beyond) |
| `wind` | 1 | 0 to 2: how far the dust travels (0.32 x the larger canvas side at 1) |
| `direction` | -28 | wind direction in degrees (0 = right, negative = up) |
| `sweep` | 24 | the direction the erosion sweeps across the page, degrees |
| `turbulence` | 1 | 0 to 2: the swirl of the air |
| `fragments` | 0.3 | share of the dust that leaves as fragments before it crumbles |
| `sensitivity` | 0.5 | 0 to 1: how little a pixel must differ from its background to count as content |
| `backdrop` | the host's clear colour | what a transparent pixel of the source shows (`#rrggbb` or `[r, g, b]` 0..1) |
| `onSubmit` | `'off'` (`'valid'` in the gallery) | `'off'`, `'valid'`, `'always'` |
| `invalidSelector` | `:invalid, [aria-invalid="true"], .invalid` | what counts as an invalid field for `onSubmit: 'valid'` |
| `intro` | false (true in the gallery) | when created, re-form from dust once the first snapshot is there (skipped when re-created after a device loss) |
| `state` | `'in'` | `'out'` / `'in'`: see above |
| `reducedMotion` | follows `prefers-reduced-motion` | `true` / `false` to force it |
| `seed` | 1 | the pattern of the noise |
| `liveCounter` | false | the controls start with the "Live counter" on |

`mountUI` adds the "Turn to dust" button, sliders for the dust size and the wind, and the "Live counter" checkbox (a stopwatch, large digits, 20 updates a second, inside the form).

## How it works

- **What is content.** When a transition starts (and again when the page changes, at most every 250 ms), two small passes estimate the background: the source averaged into cells of 8 css px, then, per cell, the dominant colour around it (mean shift over a window of about 260 css px, started from the mean and from four points around, the best supported mode wins), so text, borders and fields smaller than a panel are never taken for its background. A pixel is content in proportion to its colour distance from that estimate.
- **One clock.** Everything is a function of the dissolve amount `g` and of the pixel: when the sweep reaches it (`erode_g`: the diagonal position, a ragged edge, pores), and where its grain is at its age (`dust_path`: wind, a rising drift, a curl-noise swirl read along the way, a fragment's shared start). A grain lives from its birth until `g = 1`. Nothing is simulated frame by frame, so `g = 0` is the page exactly, and the same instant looks the same at any frame cap (also where a play turns: its way back starts the instant its way out ended, not at the next frame).
- **Live.** The page pass samples the source of the frame; each grain reads the colour of its home pixel, and whether it is content, in the vertex shader, every frame.
- **Draws.** The page (full screen: the source where its content has not eroded, the background estimate where it has), then one grain per dust cell as an instanced 4-vertex strip (about 300,000 cells on the gallery canvas; a grain that is not content or not in flight is culled in the vertex shader).
- **No per-frame allocation.** A frame writes one preallocated `Float32Array` into one uniform buffer and reuses its render pass descriptors; bind groups are cached per source view; the two estimate textures are allocated once per size.
- **`prefers-reduced-motion: reduce`**: nothing moves; the same triggers fade the content into the page and back, over the same durations.
- **Device loss.** The host creates the plugin again on the new device with the latest options; the new instance starts assembled, without the intro, and promises of the lost instance resolve `false`.

## Measured

On one machine (Apple M1 Max, macOS, headless Chrome, Metal, other work running on the machine), with timestamp queries on the plugin's render pass at 2200x1240 backing pixels (the gallery canvas at DPR 2), frames 8.33 ms apart through a whole play: GPU time p50 0.72 ms, p95 1.11 ms, max 2.4 ms while it moves; the one frame that also makes the background estimate took 2.9 ms from submit to done (wall clock, an upper bound); `render()` on the CPU p95 0.01 ms. One run: it says the effect fits a 120 Hz frame (8.33 ms) on this machine, nothing about others. `test/disintegrate-perf.browser.test.mjs` prints them again and asserts p95 under half the frame.

`test/gallery.e2e.mjs` (headless Chrome 155, trusted CDP input, the plugin gallery, 2026-10-14): 22 of 22 checks pass, among them: Submit turns the content to dust, presses during the transition are swallowed, the form re-forms with the success line; no frame of a play is darker than 0.6 of the idle page (measured: the luminance stays within 2 levels of it); the counter keeps running and typed text reaches the field while the content is dust, and the re-formed field shows it; no console error.

## Files

| file | |
|---|---|
| `index.js` | `meta`, `plugin`, `trigger`, and the pure helpers the tests use (`dustGrid`, `bgSize`, `sweepOf`, `readOptions`, `fillUniforms`) |
| `../_lib/transition.js` | shared with the shatter plugin, bundled into each: the out/in timeline, the two mappers, option parsing, the invalid-field probe (pure) |
| `disintegrate.wgsl` | the shader: the background estimate (down, mean shift), the page (erosion), the dust, the passthrough and the crossfade |
| `wgsl.js` | loads the `.wgsl` file when the plugin runs from source; the build replaces it |
| `media/disintegrate.webp` | the recording above |
| `test/disintegrate.test.mjs` | Node: the folder contract, the timeline, the timing invariants, the dust grid, the sweep, options, the uniform layout (checked against the WGSL struct), and a fake GPU (no GPU object per frame, nothing frozen, the background estimated at the start and again only when the page changes, the draws, the separate lengths of the way out and back, mappers, triggers, submit wiring, reduced motion, destroy) |
| `test/disintegrate-gpu.browser.test.mjs` | headless Chrome, real host and GPU: assembled frame = passthrough bit for bit (at rest and after a play); mid-transition frames moving and never dark; **the background stays** (over 85 % of the background pixels unchanged mid-way, the content gone); **the dust keeps the colour of its pixel** (orange dust from the orange button); the diagonal sweep; input blocked through the interposer (identity when idle as the control); 120 Hz vs 15 fps cap; the reduced-motion crossfade (background untouched); device loss; intro and submit wiring; **live**: a change of the page made after its dust blew off shows up on the moving dust (two runs without it are identical, the control) |
| `test/disintegrate-perf.browser.test.mjs` | the GPU time measurement above |
| `test/gallery.e2e.mjs` | the plugin in the real gallery with trusted input (steps shared with other transitions: `plugins/_shared/transition-e2e.mjs`), plus the "Turn to dust" button, no dark frame, the live counter, typing during the transition and the re-formed state; `--record` writes the media. Needs `npm run build`; `npm run test:plugins` runs every gallery e2e. |
