# water

An **example** effect plugin: pointer-driven water ripples over the HTML drawn in a canvas. It shows how to use the effects extension of this library (`HTMLInCanvasEffects`, plugin ABI v2). It is **not part of the polyfill**: the polyfill, the frame cap and the effects host work without it, and nothing in `src/` imports it.

The effects host and this plugin are extensions of this library. They are not part of the HTML-in-Canvas proposal, and browsers' native implementations do not provide them ([docs/guides/EFFECTS-PLUGINS.md](../../docs/guides/EFFECTS-PLUGINS.md)).

## Use

```html
<script src="dist/hic-live-polyfill.iife.min.js"></script>
<script src="dist/hic-live-effects.iife.min.js"></script>
<script src="dist/plugins/water.iife.min.js"></script>   <!-- window.HicLivePlugins.water -->
<script>
  const host = await HTMLInCanvasEffects.createHost(canvas, form, { interposer: true });
  const water = await host.addPlugin(HicLivePlugins.water.plugin, { intensity: 0.28 });
  water.mountUI(document.getElementById('controls'));   // the plugin's intensity slider
</script>
```

ES modules: `import { plugin } from '@giuseppe-scotto-lavina/html-in-canvas-polyfill/plugins/water'`.

| option | | |
|---|---|---|
| `intensity` | 0 to 1, default 0.28 | strength of the displacement; 0 shows the source unchanged |
| `shader` | WGSL text | replaces `water.wgsl` (same bindings and uniform layout) |

The plugin is `spatial`: it moves pixels, so it supplies `captureInputMapper`. `mapWaterPoint(state, point)` is the JavaScript twin of the displacement in `water.wgsl`; it is exported for tests.

## Files

| file | |
|---|---|
| `index.js` | `meta`, `plugin` (the definition), `mapWaterPoint`, `RIPPLE_COUNT`, `GLOBALS_LENGTH` |
| `water.wgsl` | the shader; inlined into the built bundles |
| `wgsl.js` | loads `water.wgsl` when the plugin runs from source; the build replaces it |
| `test/water-math.test.mjs` | Node: the folder contract, the mapper against an independent copy of the formula, options and pointer handling |
| `test/water-gpu.browser.test.mjs` | headless Chrome: the mapper against the pixels the GPU produced (`plugins/_shared/gpu-check.mjs`) |
