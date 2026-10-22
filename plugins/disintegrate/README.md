# disintegrate

A transition: the CONTENT of the HTML drawn in a canvas (text, field borders and fills, buttons, icons) turns to dust of its own live colours and blows away while the page itself stays, then flies back and settles into the page's new state.

An **example** effect plugin of this library, not part of the polyfill: nothing in `src/` imports it, and the polyfill, the frame cap and the effects host work without it. The effects host and its plugins are extensions of this library, not part of the HTML-in-Canvas proposal; native implementations do not provide them ([details](../../docs/guides/EFFECTS-PLUGINS.md#extensions-not-the-standard)).

![The gallery form, with its live counter running: the text, fields and buttons turn to dust of their own colours along a diagonal sweep while the panels stay, the dust swirls away, then flies back and settles into the letters, with the text typed meanwhile and the new counter value](media/disintegrate.webp)

Recorded in headless Chrome from the plugin gallery (`node plugins/disintegrate/test/gallery.e2e.mjs --record`): the "Live counter" of the controls on, Enter in the name field (a valid submit), text typed while the content is dust.

## What it does

1. **Only the content goes.** Every pixel that differs from the background around it: text, field borders and fills, buttons, icons. The panels, cards and the page behind them stay, so no frame of the transition is dark.
2. **A diagonal sweep erodes it**, from the top left: the content goes porous (holes at the scale of a few pixels, ragged at a larger one), thins, and is gone.
3. **Every eroded pixel becomes a grain of dust of its exact live colour**, carried by the wind along swirling paths (the curl of a noise field), half of the grains streaking with their speed, a third leaving as small fragments that crumble on the way.
4. **No still frame.** The way out takes 1.8 s (the content is gone after about 0.9 s, the dust keeps drifting); a play then turns at once and the dust flies back at full strength.
5. **The re-forming**: in 1.2 s the dust flies back along the same paths and settles into the letters and fields of the page as it is now.

**The page stays live.** The page and every grain sample the live page on every frame: a counter keeps counting on the dust that carries it, text typed while the content is dust appears on the dust of its field (keyboard input is not blocked), and the dust settles into the state the page has by then (the typed text, the success line). It applies to any HTML, with no change to it.

## Usage

```html
<script src="dist/hic-live-polyfill.iife.min.js"></script>
<script src="dist/hic-live-effects.iife.min.js"></script>
<script src="dist/plugins/disintegrate.iife.min.js"></script>   <!-- window.HicLivePlugins.disintegrate -->
<script>
  const host = await HTMLInCanvasEffects.createHost(canvas, form, { interposer: true });
  const dust = await host.addPlugin(HicLivePlugins.disintegrate.plugin);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await dust.trigger('out');    // 'out': the content is dust
    showAnswer();                 // change the page while nothing of it is shown
    await dust.trigger('in');     // 'in': it re-forms, showing the answer
  });
</script>
```

ES modules: `import { plugin } from '@giuseppe-scotto-lavina/html-in-canvas-polyfill/plugins/disintegrate'`. Without code: `onSubmit: 'valid'` plays the transition on every valid submit of the form inside the source.

## Options

| option | default (gallery) | |
|---|---|---|
| `duration` | 1800 | ms of the way out (the dust keeps drifting after the content is gone), 300 to 8000 |
| `durationIn` | 1200 | ms of the way back |
| `particleSize` | 1.5 | dust cell, 1 to 4 CSS px; at most 420,000 cells (cells grow beyond) |
| `wind` | 1 | 0 to 2: how far the dust travels (0.32 x the larger canvas side at 1) |
| `direction` | -28 | wind direction in degrees (0 = right, negative = up) |
| `sweep` | 24 | the direction the erosion sweeps across the page, degrees |
| `turbulence` | 1 | 0 to 2: the swirl of the air |
| `fragments` | 0.3 | share of the dust that leaves as fragments before it crumbles |
| `sensitivity` | 0.5 | 0 to 1: how little a pixel must differ from its background to count as content |
| `backdrop` | the host's clear colour | what a transparent pixel of the source shows (`#rrggbb` or `[r, g, b]` 0..1) |
| `onSubmit` | `'off'` (`'valid'`) | `'off'`, `'valid'` (only when no field matches `invalidSelector`), `'always'`: a `submit` inside the source plays the transition. The page's own submit handler runs first when it was added before the plugin, so the form re-forms showing what the page set |
| `invalidSelector` | `:invalid, [aria-invalid="true"], .invalid` | what counts as an invalid field for `onSubmit: 'valid'` |
| `intro` | false (true) | when created, re-form from dust once the first snapshot is there (not when re-created after a device loss) |
| `state` | `'in'` | `'out'` / `'in'`: the end state, declaratively; only a change of `state` starts a transition |
| `reducedMotion` | follows `prefers-reduced-motion` | `true` / `false` to force it |
| `seed` | 1 | the pattern of the noise |
| `liveCounter` | false | the controls start with the "Live counter" on |

`mountUI` adds the "Turn to dust" button (the action `play`), sliders for the dust size and the wind, and the "Live counter" checkbox (a stopwatch inside the form, 20 updates a second, to make the liveness visible).

## Actions

`handle.trigger(action)` ([semantics](../../docs/guides/EFFECTS-PLUGINS.md#5-actions-trigger-and-settled)); no options.

| action | | resolves with |
|---|---|---|
| `out` | the content turns to dust and stays gone | `'out'` |
| `in` | the content re-forms, from where it is (a reversal midway is continuous) | `'in'` |
| `play` | out, then at once in | `'in'` |

`handle.settled()` resolves with `'in'` or `'out'` once nothing moves. A newer action, a submit (`onSubmit`), the "Turn to dust" button or `setOptions({ state })` supersede a pending trigger (it resolves `null`). The action's clock starts at the first frame that renders it, so its length is the same at every frame cap.

## Input

The plugin is `spatial`. Its mapper is one of two constant functions, chosen by the presented frame: **assembled** (at rest) the identity, so the form is fully usable; **while anything moves, is gone or fades** (also the reduced-motion crossfade) it returns `NO_TARGET` for every point, so the host swallows a press (no focus change, nothing activated). Keyboard input is not mapped: a key pressed during a transition reaches the element that had the focus. A second submit during a transition does not restart it.

## Reduced motion

With `prefers-reduced-motion: reduce` (read by the host at every `trigger`, and by the plugin for its own triggers), nothing moves: the same actions fade the content into the page and back, over the same durations, and resolve with the same states.

## Performance

On one machine (Apple M1 Max, macOS, headless Chrome, Metal, other work running), timestamp queries on the plugin's pass at 2200x1240 backing pixels (the gallery canvas at DPR 2), frames 8.33 ms apart through a whole play: GPU time p50 0.72 ms, p95 1.11 ms, max 2.4 ms while it moves; the one frame that also makes the background estimate took 2.9 ms from submit to done (wall clock, an upper bound); `render()` on the CPU p95 0.01 ms. One run: it says the effect fits a 120 Hz frame (8.33 ms) on this machine, nothing about others. `test/disintegrate-perf.browser.test.mjs` prints the numbers and asserts p95 under half the frame.

How it stays cheap: everything is a function of the dissolve amount `g` and of the pixel (when the sweep reaches it, where its grain is at its age), so nothing is simulated frame by frame; the page is one full-screen pass and the dust one instanced 4-vertex strip per cell, culled in the vertex shader when not in flight; the background estimate (two small passes: the source averaged into 8 CSS px cells, then the dominant colour around each cell by mean shift over about 260 CSS px) runs when a transition starts and again only when the page changes, at most every 250 ms; a frame writes one preallocated uniform array and reuses its pass descriptors. At rest the instance is not `continuous` and costs nothing.

## Limitations

- Pointer input is blocked while a transition plays (by design: the pieces are not where the controls are).
- "Content" is what differs from the dominant colour around it: a large picture or a gradient wider than the estimate's window can count as background, and content very close to its background colour (below `sensitivity`) stays.
- Device loss mid-transition: the plugin comes back at its `state` (assembled by default), without the intro; the pending trigger resolves `null`.
- WebGPU only (without an adapter `createHost` rejects with a `NotSupportedError`). Runs over the polyfill and over a browser's own HTML-in-Canvas implementation ([what differs there](../../docs/guides/EFFECTS-PLUGINS.md#on-a-native-implementation)); measured there on Chrome Canary 158 with `--enable-blink-features=CanvasDrawElement`: the gallery e2e (`npm run test:native-effects`).

## Files and tests

| file | |
|---|---|
| `index.js` | `meta`, `plugin`, `ACTIONS`, and the pure helpers the tests use (`dustGrid`, `bgSize`, `sweepOf`, `readOptions`, `fillUniforms`) |
| `../_lib/transition.js` | shared with the shatter plugin, bundled into each: the out/in timeline, the two mappers, option parsing, the invalid-field probe (pure) |
| `disintegrate.wgsl` | the shader: the background estimate (down, mean shift), the page (erosion), the dust, the passthrough and the crossfade |
| `wgsl.js` | loads the `.wgsl` file when the plugin runs from source; the build replaces it |
| `media/disintegrate.webp` | the recording above |
| `test/disintegrate.test.mjs` | Node: the folder contract, the timeline, the timing invariants, the dust grid, the sweep, options, the uniform layout (checked against the WGSL struct), and a fake GPU behind the real handle (no GPU object per frame, nothing frozen, the background estimate, the draws, the lengths of the way out and back, the mappers, the actions and their states, `settled`, superseding by a submit, removal, reduced motion) |
| `test/disintegrate-gpu.browser.test.mjs` | headless Chrome, real host and GPU: assembled frame = passthrough bit for bit; mid-transition frames moving and never dark; the background stays; the dust keeps the colour of its pixel; the diagonal sweep; input blocked through the interposer; 120 Hz vs 15 fps cap; the reduced-motion crossfade; device loss (the pending trigger resolves `null`, `settled()` reports the new instance); intro and submit wiring; a change of the page shows up on the moving dust |
| `test/disintegrate-perf.browser.test.mjs` | the GPU time measurement above |
| `test/gallery.e2e.mjs` | the plugin in the gallery with trusted input: Submit turns the content to dust, presses during the transition are swallowed, the form re-forms with the success line; the "Turn to dust" button, no dark frame; the actions `out`, `in`, `play` from the gallery's buttons, an unknown action, superseding, `settled()`; the live counter and typing during the transition. 35 of 35 checks pass (headless Chrome 155, and Chrome Canary 158 over its native implementation, 2026-10-22). `--record` writes the media; needs `npm run build` |
