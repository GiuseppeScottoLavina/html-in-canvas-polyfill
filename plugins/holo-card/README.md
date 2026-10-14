# holo-card

An **example** effect plugin: the HTML drawn in a canvas becomes a holographic collectible card. The card tilts towards the pointer in perspective (on a spring; it sways gently when the pointer is away), an iridescent foil shifts its colours with the viewing angle, sparkles and a star field sit at other depths and move against the print (parallax), and a specular glare follows the pointer. The form stays usable: a click on the tilted picture reaches the element drawn there, and a click beside the card reaches nothing.

It shows how to use the effects extension of this library (`HTMLInCanvasEffects`, plugin ABI v2). It is **not part of the polyfill**: the polyfill, the frame cap and the effects host work without it, and nothing in `src/` imports it. The effects host and this plugin are extensions of this library, not part of the HTML-in-Canvas proposal; browsers' native implementations do not provide them ([docs/guides/EFFECTS-PLUGINS.md](../../docs/guides/EFFECTS-PLUGINS.md)).

![The form of the plugin gallery as a tilting holographic card](media/holo-card.webp)

## Use

```html
<script src="dist/hic-live-polyfill.iife.min.js"></script>
<script src="dist/hic-live-effects.iife.min.js"></script>
<script src="dist/plugins/holo-card.iife.min.js"></script>   <!-- window.HicLivePlugins['holo-card'] -->
<script>
  const host = await HTMLInCanvasEffects.createHost(canvas, form, { interposer: true });
  const card = await host.addPlugin(HicLivePlugins['holo-card'].plugin, { tilt: 14, foil: 0.6 });
  card.mountUI(document.getElementById('controls'));   // tilt, foil and glare sliders and an "Idle sway" checkbox
</script>
```

ES modules: `import { plugin } from '@giuseppe-scotto-lavina/html-in-canvas-polyfill/plugins/holo-card'`.

| option | | |
|---|---|---|
| `tilt` | 0 to 30 degrees, default 14 | the largest tilt, reached with the pointer on an edge of the canvas |
| `foil` | 0 to 1, default 0.6 | iridescent foil, sparkles and rim (strongest on dark parts of the card, so text stays readable) |
| `glare` | 0 to 1, default 0.6 | specular glare at the pointer and a sheen that sweeps with the tilt |
| `idle` | boolean, default true | the card sways slowly while the pointer is away |
| `scale` | 0.5 to 1, default 0.86 | size of the card in the canvas, so that the tilted card stays inside |

## How the input mapping stays exact

`mapCardPoint(state, point)` is the JavaScript twin of the projection in `holo-card.wgsl`: the eye is `2 x max(width, height)` CSS px in front of the canvas centre, the card plane passes through the centre with the rotated normal, and the point where the ray through the presented point meets the plane, expressed in the card's own axes and divided by the card scale, is the source point. The rotated axes are computed once per frame on the CPU (`writeCardPose`) and written into the uniform block, so the shader and the mapper use the very same numbers. A point beside the card (or in its rounded corners) maps to `NO_TARGET` (the effects ABI value for "no element here"): the host swallows a press there. Each presented frame's block is copied into one of four slots, so the card can keep moving without changing the mapper of an earlier frame; a pointer gesture gets a frozen copy. Foil, glare, sparkles and stars change colours only.

## Motion, frame cap, cost

- The tilt follows the pointer on a spring that integrates `frame.delta` (same timing at a 15 fps cap as at 120 fps). The instance is `continuous` only while the card moves or sways; at rest the host renders nothing.
- `prefers-reduced-motion: reduce`: the card stays flat (no tilt, no sway, no shimmer over time); the glare still follows the pointer.
- No allocation per frame: one uniform array, one render pass descriptor, bind groups cached per source view.
- Device loss: the host re-creates the plugin with its latest options.
- GPU time, measured on 2026-10-14 (Apple M1 Max, headless Chrome, 2200 x 1240 target = the gallery canvas at DPR 2, 600 frames back to back): 0.21 ms per frame, against 0.06 ms for a pass that only clears the target (`measureGpuTime` of `plugins/_shared/gpu-time.mjs`).

## Files

| file | |
|---|---|
| `index.js` | `meta`, `plugin`, `mapCardPoint`, `writeCardPose`, `NO_TARGET` (re-exported from the effects ABI), `UNIFORM_FLOATS` |
| `holo-card.wgsl` | the shader; inlined into the built bundles |
| `wgsl.js` | loads the shader when the plugin runs from source; the build replaces it |
| `test/holo-card.test.mjs` | Node: the folder contract, the mapper as the inverse of an independent forward projection, spring, idle sway, reduced motion, frame cap, no per-frame allocation, per-frame freeze of the mapper |
| `test/holo-card-gpu.browser.test.mjs` | headless Chrome: the mapper against the GPU pixels (`checkMapperAgainstGpu`, with the identity mapper as the control), the flat card as a second control, a card tilting on its spring, device loss, GPU time |
| `test/gallery.e2e.mjs` | headless Chrome, trusted input, in the plugin gallery: rests the pointer where the tilted card draws a control away from its DOM position and clicks; also console errors, frame rate and reduced motion (`npm run build` first) |
| `media/holo-card.webp` | recorded in headless Chrome from the plugin gallery |
