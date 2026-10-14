# crt

An **example** effect plugin: the HTML drawn in a canvas shown on a curved CRT monitor. Barrel curvature inside a bezel, scanlines that follow the curved glass, an aperture-grille mask, phosphor glow, slight red / blue misconvergence, a vignette, and (unless the user prefers reduced motion) a gentle flicker, a slow rolling bar and faint static. The form stays usable: a click on the curved picture reaches the element drawn there, and a click on the bezel reaches nothing.

It shows how to use the effects extension of this library (`HTMLInCanvasEffects`, plugin ABI v2). It is **not part of the polyfill**: the polyfill, the frame cap and the effects host work without it, and nothing in `src/` imports it. The effects host and this plugin are extensions of this library, not part of the HTML-in-Canvas proposal; browsers' native implementations do not provide them ([docs/guides/EFFECTS-PLUGINS.md](../../docs/guides/EFFECTS-PLUGINS.md)).

![The form of the plugin gallery on the CRT screen](media/crt.webp)

## Use

```html
<script src="dist/hic-live-polyfill.iife.min.js"></script>
<script src="dist/hic-live-effects.iife.min.js"></script>
<script src="dist/plugins/crt.iife.min.js"></script>   <!-- window.HicLivePlugins.crt -->
<script>
  const host = await HTMLInCanvasEffects.createHost(canvas, form, { interposer: true });
  const crt = await host.addPlugin(HicLivePlugins.crt.plugin, { curvature: 0.5, scanlines: 0.6 });
  crt.mountUI(document.getElementById('controls'));   // curvature, scanlines, glow and flicker sliders
</script>
```

ES modules: `import { plugin } from '@giuseppe-scotto-lavina/html-in-canvas-polyfill/plugins/crt'`.

| option | | |
|---|---|---|
| `curvature` | 0 to 1, default 0.5 | strength of the barrel (`k` = 0.5 x curvature); 0 is a flat screen inside the bezel |
| `scanlines` | 0 to 1, default 0.6 | depth of the scanlines and of the aperture-grille mask |
| `glow` | 0 to 1, default 0.55 | phosphor glow (two rings of taps around each pixel; bright parts bleed most) |
| `flicker` | 0 to 1, default 0.5 | flicker, rolling bar and static; 0 (or reduced motion) stops the animation |
| `misconvergence` | 0 to 1, default 0.5 | red and blue land up to 1.4 CSS px to each side of green |

## How the input mapping stays exact

`mapCrtPoint(state, point)` is the JavaScript twin of the barrel in `crt.wgsl`. The screen is the canvas minus the bezel; with `d` the point relative to the centre and `s` the half size of the screen, the source point is `(d / s) (1 + k |d|^2 / |s|^2) / (1 + k s^2 / |s|^2)` scaled to the whole source: the middle of the screen is magnified, the edges compressed, the midpoint of every edge lands on the edge of the source, and the corners are rounded off. Points on the bezel or in the rounded corners map to `NO_TARGET` (the effects ABI value for "no element here"): the host swallows a press there, so it reaches no element, even with another spatial plugin before this one in the chain. The mapper reads the uniform block of the presented frame (copied into one of four slots), so a curvature change does not alter the mapper of an earlier frame. Glow, scanlines, flicker and misconvergence change colours only; the green channel is the one the mapper describes.

## Motion, frame cap, cost

- The animation (flicker, bar, static) runs only while `flicker > 0` and the user does not prefer reduced motion: then the instance is `continuous` and is rendered on every capped frame. Otherwise it renders only when the form or an option changes.
- `prefers-reduced-motion: reduce`: no flicker, no rolling bar, no static; the picture is still.
- No allocation per frame: one uniform array, one render pass descriptor, bind groups cached per source view.
- Device loss: the host re-creates the plugin with its latest options.
- GPU time, measured on 2026-10-14 (Apple M1 Max, headless Chrome, 2200 x 1240 target = the gallery canvas at DPR 2, 600 frames back to back): 0.33 ms per frame (19 texture taps per pixel with the glow), against 0.06 ms for a pass that only clears the target (`measureGpuTime` of `plugins/_shared/gpu-time.mjs`).

## Files

| file | |
|---|---|
| `index.js` | `meta`, `plugin`, `mapCrtPoint`, `bezelWidth`, `cornerRadius`, `NO_TARGET` (re-exported from the effects ABI), `UNIFORM_FLOATS` |
| `crt.wgsl` | the shader; inlined into the built bundles |
| `wgsl.js` | loads the shader when the plugin runs from source; the build replaces it |
| `test/crt.test.mjs` | Node: the folder contract, the mapper against an independent formula, animation and reduced motion, option clamping, no per-frame allocation, per-frame freeze of the mapper |
| `test/crt-gpu.browser.test.mjs` | headless Chrome: the mapper against the GPU pixels (`checkMapperAgainstGpu`, with the identity mapper as the control), another curvature as a second control, the full look on the green channel, two instants of the flicker, device loss, GPU time |
| `test/gallery.e2e.mjs` | headless Chrome, trusted input, in the plugin gallery: clicks where the CRT draws a control; also console errors, frame rate and reduced motion (`npm run build` first; `npm run test:plugins` runs every gallery e2e). Steps shared with other plugins: `plugins/_shared/gallery-click.mjs` |
| `media/crt.webp` | recorded in headless Chrome from the plugin gallery |
