# crt

An **example** effect plugin: the HTML drawn in a canvas shown on an old bar arcade monitor. The default preset (`arcade`) gives curved glass inside a bezel, thick dark scanlines whose beams widen on bright content, a visible RGB aperture grille, strong phosphor glow and bloom, a slightly warm phosphor, slight red / blue misconvergence, a vignette, a soft reflection on the glass, and (unless the user prefers reduced motion) a gentle flicker, a slow rolling bar and faint static. The preset `monitor` is a sharper, cleaner screen. It applies to any HTML already drawn in a `content="drawable"` canvas, like the other plugins. The page stays usable: a click on the curved picture reaches the element drawn there, and a click on the bezel reaches nothing.

It shows how to use the effects extension of this library (`HTMLInCanvasEffects`, plugin ABI v2). It is **not part of the polyfill**: the polyfill, the frame cap and the effects host work without it, and nothing in `src/` imports it. The effects host and this plugin are extensions of this library, not part of the HTML-in-Canvas proposal; browsers' native implementations do not provide them ([docs/guides/EFFECTS-PLUGINS.md](../../docs/guides/EFFECTS-PLUGINS.md)).

![The form of the plugin gallery on the arcade CRT, typing into the message (one CSS px per pixel, so the scanlines and the phosphor stripes are visible)](media/crt.webp)

## Use

```html
<script src="dist/hic-live-polyfill.iife.min.js"></script>
<script src="dist/hic-live-effects.iife.min.js"></script>
<script src="dist/plugins/crt.iife.min.js"></script>   <!-- window.HicLivePlugins.crt -->
<script>
  const host = await HTMLInCanvasEffects.createHost(canvas, form, { interposer: true });
  const crt = await host.addPlugin(HicLivePlugins.crt.plugin);            // the arcade preset
  crt.mountUI(document.getElementById('controls'));   // preset picker; curvature, scanlines, mask, glow, warmth and flicker sliders
  // crt.setOptions({ ...HicLivePlugins.crt.presets.monitor });           // the cleaner preset
</script>
```

ES modules: `import { plugin, presets } from '@giuseppe-scotto-lavina/html-in-canvas-polyfill/plugins/crt'`.

| option | 0 to 1; `arcade` (default) / `monitor` | |
|---|---|---|
| `curvature` | 0.5 / 0.3 | strength of the barrel (`k` = 0.5 x curvature); 0 is a flat screen inside the bezel |
| `scanlines` | 0.8 / 0.35 | depth of the gaps between the scanlines; a line is 3 CSS px (or 1/240 of a taller screen), and each beam is wider where the picture is bright, as on a real tube |
| `mask` | 0.7 / 0.25 | the aperture grille: red, green and blue phosphor stripes one CSS px wide each, so they stay visible at any device pixel ratio |
| `glow` | 0.7 / 0.3 | phosphor glow and bloom: three rings of taps (1.5, 4 and 9 CSS px); light spills from bright parts into darker neighbours, a flat bright area is not washed out |
| `warmth` | 0.6 / 0.1 | a slightly warm phosphor (more red, less blue) and a warm black level |
| `flicker` | 0.3 / 0 | flicker, rolling bar and static; 0 (or reduced motion) stops the animation |
| `misconvergence` | 0.4 / 0.15 | red and blue land up to 1.4 CSS px to each side of green (no slider) |
| `preset` | `'arcade'` or `'monitor'` | applies that set; options given next to it win |

`presets` (frozen) holds both sets; `meta.defaults` is `presets.arcade`. Bright parts are compressed by a soft shoulder instead of being clipped, so white areas keep their lines and stripes. The interlace mode of earlier builds was removed.

## How the input mapping stays exact

`mapCrtPoint(state, point)` is the JavaScript twin of the barrel in `crt.wgsl`. The screen is the canvas minus the bezel; with `d` the point relative to the centre and `s` the half size of the screen, the source point is `(d / s) (1 + k |d|^2 / |s|^2) / (1 + k s^2 / |s|^2)` scaled to the whole source: the middle of the screen is magnified, the edges compressed, the midpoint of every edge lands on the edge of the source, and the corners are rounded off. Points on the bezel or in the rounded corners map to `NO_TARGET` (the effects ABI value for "no element here"): the host swallows a press there, so it reaches no element, even with another spatial plugin before this one in the chain. The mapper reads the uniform block of the presented frame (copied into one of four slots), so a curvature change does not alter the mapper of an earlier frame. Scanlines, mask, glow, warmth, flicker, the glass reflection and misconvergence change colours only (green is the reference for misconvergence); the GPU test checks that every lit pixel of the full look is where the mapper says.

## Motion, frame cap, cost

- The animation (flicker, bar, static) runs only while `flicker > 0` and the user does not prefer reduced motion: then the instance is `continuous` and is rendered on every capped frame. Otherwise it renders only when the page or an option changes.
- `prefers-reduced-motion: reduce`: no flicker, no rolling bar, no static; the curved screen, the scanlines, the mask and the glow stay.
- No allocation per frame: one uniform array, one reused render pass descriptor, bind groups cached per source view. One pass, no extra texture.
- Device loss: the host re-creates the plugin with its latest options.
- GPU time, measured on 2026-10-14 (Apple M1 Max, headless Chrome 155, 2200 x 1240 target = the gallery canvas at DPR 2, 600 frames back to back): 0.46 ms per frame, against 0.06 ms for a pass that only clears the target (`measureGpuTime` of `plugins/_shared/gpu-time.mjs`).

## Files

| file | |
|---|---|
| `index.js` | `meta`, `presets`, `presetOf`, `plugin`, `mapCrtPoint`, `bezelWidth`, `cornerRadius`, `NO_TARGET` (re-exported from the effects ABI), `UNIFORM_FLOATS` |
| `crt.wgsl` | the shader; inlined into the built bundles |
| `wgsl.js` | loads the shader when the plugin runs from source; the build replaces it |
| `test/crt.test.mjs` | Node: the folder contract, the mapper against an independent formula, the presets (default, `preset` option, explicit options win, `presetOf`), animation and reduced motion, option clamping, the uniform block, no per-frame allocation, per-frame freeze of the mapper, no geometry change from the look |
| `test/crt-gpu.browser.test.mjs` | headless Chrome: the mapper against the GPU pixels (`checkMapperAgainstGpu`, with the identity mapper as the control), another curvature as a second control, the full `arcade` and `monitor` looks (brightest channel, 0 wrong px), the look's structure on white (bright and dark lines, R / G / B columns), two instants of the flicker, device loss, GPU time |
| `test/gallery.e2e.mjs` | headless Chrome, trusted input, in the plugin gallery: clicks where the CRT draws a control; console errors, frame rate and reduced motion; the preset picker (Arcade by default, Monitor moves every slider, a slider moved by hand shows Custom), the flicker animating and flicker 0 idle (`npm run build` first; `npm run test:plugins` runs every gallery e2e; `--record` rewrites `media/crt.webp` and `docs/media/plugins/crt.webp`). Steps shared with other plugins: `plugins/_shared/gallery-click.mjs` |
| `media/crt.webp` | recorded in headless Chrome from the plugin gallery (`--record`): the form side of the screen at one CSS px per pixel, typing into the message |
