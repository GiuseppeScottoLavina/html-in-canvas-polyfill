# water

Water ripples over the HTML drawn in a canvas: the pointer stirs the surface, the action `drop` lets a drop fall anywhere, and clicks and typing are remapped through the displacement to the field the user sees.

An **example** effect plugin of this library, not part of the polyfill: nothing in `src/` imports it, and the polyfill, the frame cap and the effects host work without it. The effects host and its plugins are extensions of this library, not part of the HTML-in-Canvas proposal; native implementations do not provide them ([details](../../docs/guides/EFFECTS-PLUGINS.md#extensions-not-the-standard)).

![The gallery form under the water plugin: the pointer raises ripples, a click through them focuses the email field](media/water.webp)

Recorded in headless Chrome from the plugin gallery (`node plugins/water/test/gallery.e2e.mjs --record`, which also writes the README's hero, `docs/media/hero.webp`).

## What it does

A gentle refraction moves over the whole surface all the time; ripples start where the pointer goes down (a strong drop) and along its path (stronger when it moves faster), and on the action `drop`. Up to 4 ripples run at once (a new one replaces the oldest); each spreads as rings and dies out in 3.2 s. Two small ripples start when the plugin is added.

## Usage

```html
<script src="dist/hic-live-polyfill.iife.min.js"></script>
<script src="dist/hic-live-effects.iife.min.js"></script>
<script src="dist/plugins/water.iife.min.js"></script>   <!-- window.HicLivePlugins.water -->
<script type="module">
  const host = await HTMLInCanvasEffects.createHost(canvas, form, { interposer: true });
  const water = await host.addPlugin(HicLivePlugins.water.plugin, { intensity: 0.28 });
  water.mountUI(document.getElementById('controls'));                    // the plugin's intensity slider
  await water.trigger('drop', { point: { x: 120, y: 80 }, strength: 1.5 });   // 'calm' once the ripple has died out
</script>
```

ES modules: `import { plugin } from '@giuseppe-scotto-lavina/html-in-canvas-polyfill/plugins/water'`. [`examples/effect-plugin/`](../../examples/effect-plugin/) uses it in a complete page.

## Options

| option | default | |
|---|---|---|
| `intensity` | 0.28 | 0 to 1: strength of the displacement; 0 shows the source unchanged |
| `shader` | `water.wgsl` | WGSL text that replaces the shader (same bindings and uniform layout) |

`mountUI` adds the intensity slider.

## Actions

`handle.trigger('drop', { point, strength })` ([semantics](../../docs/guides/EFFECTS-PLUGINS.md#5-actions-trigger-and-settled)).

| action | options | | resolves with |
|---|---|---|---|
| `drop` | `point`: `{x, y}` in canvas CSS px (default: the centre); `strength`: 0.08 to 2 (default 1.2) | a drop falls there; its ripple starts at the next frame | `'calm'`, once no ripple is left (about 3.2 s) |

`handle.settled()` resolves with `'calm'` once no ripple runs (pointer ripples count too). A `point` that is not `{x, y}` or a non-finite `strength` rejects with a `TypeError`; a newer trigger resolves a pending one with `null`.

## Input

The plugin is `spatial`. `mapWaterPoint(state, point)` is the JavaScript twin of the displacement in `water.wgsl` (the same constants, the same fast exponential, the same clamp) and evaluates the uniform block that was submitted for the presented frame (copied into one of four slots), so it describes exactly those pixels: clicks and typing reach the field the user sees, also while ripples run. A gesture keeps one frozen mapping. The mapper clamps to the canvas.

## Reduced motion

With `prefers-reduced-motion: reduce` (read when the plugin is added, and by the host at every `trigger`), the water is calm: the surface keeps its gentle refraction, frozen in time; no ripple starts (not on load, not from the pointer, not from `drop`, which resolves `'calm'` at once) and nothing animates, so the effect is rendered only when the page or an option changes. Clicks and typing are still remapped through the still surface.

## Performance

One full-screen pass with one texture sample per pixel; no allocation per frame except the pass descriptor; bind groups cached per source view. The water is `continuous` (rendered on every capped frame) unless the user prefers reduced motion: use the frame cap to bound its cost. Its GPU time was not measured on its own; the one-sample template pass measured 0.09 ms per frame at 2200x1240 on the machine of the other plugins' numbers.

## Limitations

- At most 4 ripples at once (the newest replaces the oldest).
- Always animating (except with reduced motion): the host renders it at the frame cap, never idle.
- WebGPU only (without an adapter `createHost` rejects with a `NotSupportedError`). Runs over the polyfill and over a browser's own HTML-in-Canvas implementation ([what differs there](../../docs/guides/EFFECTS-PLUGINS.md#on-a-native-implementation)); measured there on Chrome Canary 158 with `--enable-blink-features=CanvasDrawElement`: the gallery e2e, the frame cap and trusted clicks through the ripples (gates G-native-effects and G-native-interposer, `npm run test:native-effects`).

## Files and tests

| file | |
|---|---|
| `index.js` | `meta`, `plugin`, `ACTIONS`, `mapWaterPoint`, `calmAt`, `RIPPLE_COUNT`, `GLOBALS_LENGTH` |
| `../_lib/action.js` | the `point` option of actions (shared, bundled into each plugin that uses it) |
| `water.wgsl` | the shader; inlined into the built bundles |
| `wgsl.js` | loads `water.wgsl` when the plugin runs from source; the build replaces it |
| `media/water.webp` | the recording above |
| `test/water-math.test.mjs` | Node: the folder contract, the mapper against an independent copy of the formula, options and pointer handling, the calm mode of reduced motion, the action `drop` through the real handle (the ripple at the point on the next frame, `'calm'` when it has died out, bad options, removal, reduced motion) |
| `test/water-gpu.browser.test.mjs` | headless Chrome: the mapper against the pixels the GPU produced (`plugins/_shared/gpu-check.mjs`), a mapper of another instant as control, intensity 0, frozen mappers, the action `drop` (pixels around its point move, the frame agrees with its mapper, `'calm'` at the end) |
| `test/gallery.e2e.mjs` | the gallery with trusted input: pointer ripples, a click through them and typing, the frame cap, the action `drop` from the gallery's button, an unknown action, superseding, `settled()`, reduced motion (also the action). 16 of 16 checks pass (18 with `--record`; headless Chrome 155, 2026-10-16). Needs `npm run build` |
