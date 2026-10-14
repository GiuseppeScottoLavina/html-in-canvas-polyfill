# shatter

An **example** effect plugin: a transition in which the HTML drawn in a canvas cracks from an impact point, breaks into glass shards that fall, tumble and catch the light, then flies back together. It shows how to use the effects extension of this library (`HTMLInCanvasEffects`, plugin ABI v2). It is **not part of the polyfill**: the polyfill, the frame cap and the effects host work without it, and nothing in `src/` imports it.

The effects host and this plugin are extensions of this library. They are not part of the HTML-in-Canvas proposal, and browsers' native implementations do not provide them ([docs/guides/EFFECTS-PLUGINS.md](../../docs/guides/EFFECTS-PLUGINS.md)).

![The gallery form shattering from the Submit button after an invalid email, and coming back with the error shown](media/shatter.webp)

`media/shatter.webp` was recorded in headless Chrome from the plugin gallery: a trusted click on Submit with an invalid email (`node plugins/shatter/test/gallery.e2e.mjs --record`).

## Use

```html
<script src="dist/hic-live-polyfill.iife.min.js"></script>
<script src="dist/hic-live-effects.iife.min.js"></script>
<script src="dist/plugins/shatter.iife.min.js"></script>   <!-- window.HicLivePlugins.shatter -->
<script>
  const host = await HTMLInCanvasEffects.createHost(canvas, form, { interposer: true });
  const handle = await host.addPlugin(HicLivePlugins.shatter.plugin, { onSubmit: 'invalid' });
  await HicLivePlugins.shatter.trigger(canvas, 'play', { x: 120, y: 80 });   // impact point in canvas css px (optional)
</script>
```

ES modules: `import { plugin, trigger } from '@giuseppe-scotto-lavina/html-in-canvas-polyfill/plugins/shatter'`.

Ways to start a transition:

| how | |
|---|---|
| `trigger(canvas, action, point?)` | `'out'` shatters and stays gone, `'in'` flies back together, `'play'` does both with a 300 ms pause. `point` is the impact in canvas css px. Returns a promise: `true` when that end state is reached, `false` when another request superseded it, the plugin was removed, or no instance runs on that canvas. |
| `handle.setOptions({ state: 'out' })` / `{ state: 'in' }` | the same, declaratively, through the handle of `addPlugin`. Only a change of `state` starts a transition. |
| `onSubmit: 'invalid'`, `'valid'` or `'always'` | a `submit` event inside the source plays the transition (`'invalid'`: only when a field matches `invalidSelector` at that moment). The page's own submit handler runs first when it was added before the plugin (the gallery's is), so the form comes back showing the error state the page set. |
| the Shatter button of `mountUI` | `'play'`, cracking from the button |

The impact point, when no `point` is given: the last pointer press on the canvas within 1.5 s (the Submit or Shatter button that was clicked), else the centre of the first invalid field (a submit with the Enter key), else the canvas centre.

What the transition shows: when it starts, the plugin copies the picture the user sees at that moment (one render pass into its own texture), and the shards of the way out are cut from that copy. The way back samples the live source, so changes the page made in the meantime (a validation message, a red border) are on the shards as they land. The last frame of the way back is drawn with the host's passthrough formula, so it equals the frame the host presents without any plugin, bit for bit (checked on the GPU).

## Input

The plugin is `spatial`, so it supplies `captureInputMapper`. Its mapper is one of two constant functions, chosen by the frame that was presented:

- **assembled** (idle): the identity. The form is fully usable, the host's interposer passes every pointer event through.
- **from the first crack until the last shard is back** (including gone, and the reduced-motion crossfade): pointer input is **blocked**. The mapper returns `NO_TARGET` (the effects ABI value for "no element here"), so the host swallows the press: no focus change (the focused field keeps the focus), nothing activated, the click swallowed. Shards are not hit-tested: a click on a flying shard does not reach the control drawn on it.

Keyboard input is not mapped by the host: a key pressed during a transition reaches the element that had the focus before it (a press during the transition removes that focus). A second submit during a transition does not restart it.

## Options

| option | default (gallery) | |
|---|---|---|
| `pieces` | 36 | number of shards, 6 to 64 |
| `gravity` | 1 | 0.2 to 3 (1 = 2400 css px/s²) |
| `duration` | 1400 | ms of one way (out or in), 300 to 8000; one way plays 1.6 s of physics |
| `edgeColor`, `edgeAmount` | `#d9f5ff`, 0.85 | the crack lines, the sheen of a tumbling shard and the impact flash |
| `backdrop` | the host's clear colour | what is left behind (`#rrggbb` or `[r, g, b]` 0..1) |
| `onSubmit` | `'off'` (`'invalid'`) | `'off'`, `'invalid'`, `'valid'`, `'always'` |
| `invalidSelector` | `:invalid, [aria-invalid="true"], .invalid` | what counts as an invalid field |
| `intro` | false (true) | when created, the shards fly together once the first snapshot is there (skipped when re-created after a device loss) |
| `state` | `'in'` | `'out'` / `'in'`: see above |
| `reducedMotion` | follows `prefers-reduced-motion` | `true` / `false` to force it |
| `seed` | 7 | the crack pattern (each shatter adds one) |

`mountUI` adds a Shatter button and a slider for the number of pieces.

## Geometry, physics, frame cap, device loss

- **Cracks.** Voronoi seeds on jittered rings around the impact point, denser near it, so the cells read as radial cracks. Each cell is the canvas rectangle clipped by the bisectors of its seed and every other seed: the cells are an exact partition of the canvas (checked). This runs on the CPU once per shatter, when it starts (0.14 ms median for 36 pieces, 0.28 ms for 64, in Node on the machine below), never per frame.
- **Drawing.** Each cell is a triangle fan in one preallocated vertex buffer (position, shard, border flag, an edge factor that is 1 at the centre and 0 on the outer edge); the motion of up to 64 shards lives in the uniform block (2 vec4 each). The vertex shader moves each shard as a function of time only: it waits until the crack front has passed it (0.12 s + distance / 2600 css px/s), then flies outward from the impact, spins, tumbles (narrowing along an axis, darker edge-on, with a sheen) and falls. The fragment shader draws crack lines on the outer edges (from `fwidth` of the edge factor) once the front has reached them; edges on the canvas border get none. `shardPoint` in `shards.js` is the JavaScript twin of the vertex shader. The way back is the same motion played backwards.
- **No per-frame allocation.** A frame writes a preallocated 24-float header into the uniform buffer and reuses its render pass descriptor; bind groups are cached per texture view.
- **Frame cap.** The timeline is driven by `frame.now` and starts at the first frame rendered after the request, so a transition lasts the same time at any cap; at a 15 fps cap the frame at a given instant equals the 120 Hz one (checked). The instance is `continuous` only while it animates.
- **`prefers-reduced-motion: reduce`**: nothing breaks or moves; the same triggers crossfade the picture to the backdrop and back.
- **Device loss.** The host creates the plugin again on the new device with the latest options; the new instance starts assembled, without the intro, and promises of the lost instance resolve `false`.

## Measured

On one machine (Apple M1 Max, macOS, headless Chrome, Metal), with timestamp queries on the plugin's pass at 2200x1240 backing pixels (the gallery canvas at DPR 2), frames 8.33 ms apart through a whole play with 36 pieces: GPU time of the pass p50 0.07 ms, p95 0.20 ms while shards move; idle (the full-screen pass) p50 0.33 ms; `render()` on the CPU p95 0.01 ms, 1.6 ms once per shatter (the frame that builds the cells). Chrome quantises timestamps, and these numbers come from one run: they say the pass fits a 120 Hz frame (8.33 ms) on this machine, nothing about others. `test/shatter-perf.browser.test.mjs` prints them again.

## Files

| file | |
|---|---|
| `index.js` | `meta`, `plugin`, `trigger`, and the pure helpers the tests use (`readOptions`, `fillHeader`) |
| `shards.js` | pure: seeds, Voronoi cells, triangle fans, shard motion, `shardPoint` |
| `../_lib/transition.js` | shared with the disintegrate plugin, bundled into each: the out/in timeline, the two mappers, option parsing, the invalid-field probe (pure) |
| `shatter.wgsl` | the shader: full-screen pass (assembled frame, crossfade, freeze copy) and the shards |
| `wgsl.js` | loads the `.wgsl` file when the plugin runs from source; the build replaces it |
| `media/shatter.webp` | the recording above |
| `test/shatter.test.mjs` | Node: the folder contract, the Voronoi partition, seeds around the impact, fans and border flags, crack-front start times, `shardPoint`, options, the uniform header, and a fake GPU (no GPU object per frame, one layout per shatter, impact point from pointer / invalid field / centre, mapper per frame, submit wiring, destroy) |
| `test/shatter-gpu.browser.test.mjs` | headless Chrome, real host and GPU: assembled frame = passthrough bit for bit, mid-transition frames non-blank and moving, cracks first near the pointer, input blocked through the interposer (identity when idle as the control), 120 Hz vs 15 fps cap, reduced-motion crossfade, device loss, intro and submit wiring |
| `test/shatter-perf.browser.test.mjs` | the GPU time measurement above |
| `test/gallery.e2e.mjs` | the plugin in the real gallery with trusted input: idle click-through and typing, Submit with an invalid email shatters it from the button, a click during it changes nothing (focus kept, nothing activated), error state after, usable again, the Shatter button; `--record` writes the media. Steps shared with disintegrate: `plugins/_shared/transition-e2e.mjs`. Needs `npm run build`; `npm run test:plugins` runs every gallery e2e. |
