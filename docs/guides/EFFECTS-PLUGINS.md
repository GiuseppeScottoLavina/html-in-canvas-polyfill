# Writing an effect plugin (ABI v2)

An effect plugin is a small GPU pass that runs after the polyfill has produced the snapshot of your HTML. The optional effects bundle hosts it: it uploads the snapshot into a WebGPU texture, runs the chain of plugins, presents the result on the canvas, and keeps pointer input pointing at the right element. The water ripple of `examples/water-form/` is a plugin; it lives with the other example plugins in [`plugins/`](../../plugins/), outside the polyfill, and the [plugin gallery](../../examples/plugins/) applies each of them to one live form.

## Extensions, not the standard

The effects host (`HTMLInCanvasEffects`, this plugin interface, the input remapping) and the frame cap (`framecap`, `canvas.frameCap`) are **extensions of this library**. They are not part of the HTML-in-Canvas proposal, and browsers' native implementations do not and will not provide them: they are this library's own API. Code that uses them depends on this library, not on the standard.

They work only while this polyfill provides the API (mode `polyfill`, see `__HIC__.installed.mode`). On top of a native implementation they are not supported. What was checked on 2026-10-14 (macOS, Apple M1 Max, 120 Hz display, headed and headless Chrome), with the built core and effects bundles in `examples/plugins/` and `examples/water-form/`:

- **Chrome Canary 157.0.8103.0, with or without `--enable-blink-features=CanvasDrawElement`: mode `native`.** The polyfill steps aside (kind `complete`); the examples turn the effects off unless the mode is `polyfill` and draw the form through the browser's own `drawElementImage`; clicking and typing work natively. Earlier preview builds refused this build (`partial-native`, because its `ElementImage` has no `width` / `height`), so the effect behaviour below was measured with a test-only stub that added `ElementImage.prototype.width` and `height`; the effects code never reads those two members, so the stub measurement describes mode `native` on this build.
- **Effects in mode `native` (measured with that stub): partially.** The effects host started and the water plugin rendered over the native `GPUQueue.drawElementImageToTexture` (frames presented, ripples visible). But `canvas.frameCap` is not defined in this mode (assigning it creates a plain property: 120 effect frames per second whatever the value; the `framecap` attribute did bound the effect frames, 15 and 30.5 per second at 15 and 30), and pointer input was not remapped: a trusted click on the drawn name field hit the canvas, the field did not get the focus and the typing was lost. The input interposer needs the polyfill's live layer, which does not exist in mode `native`.

So with a native implementation the drawing of an effect may work, the interaction through it does not, and the frame cap property is absent. The examples turn the effects and the frame cap off unless the mode is `polyfill`, and keep the form usable.

Sources of truth: `docs/API-CONTRACT.md` sections 7.2 to 7.4, the typedefs `EffectPluginDefinition`, `EffectPluginInstance`, `EffectPluginContext`, `EffectRenderFrame`, `InputMapper` in `src/contracts/types.js`, and the validation in `src/effects/plugin-abi.js`. The example below is `test/examples-smoke/wobble-plugin/wobble-plugin.js`, run by `npm run test:examples` (section 6).

## 1. How the pieces fit

```
live HTML  --snapshot-->  source texture  --plugin 1-->  --plugin 2-->  canvas (WebGPU)
 (your form)              (host uploads                    ...            presented frame
                           when it changed)
pointer events on the live layer --interposer--> mapped through the mappers of the PRESENTED frame --> the element the user sees
```

- `HTMLInCanvasEffects` is defined by `dist/hic-live-effects.iife.min.js` (load it after the core). The plugins of this repository are separate bundles, `dist/plugins/<name>.iife.min.js`, which register `window.HicLivePlugins.<name>` (`plugins/README.md`). `createHost(canvas, source, options)` takes a canvas with `content="drawable"` and one drawable element as the source. It owns the canvas bitmap and its `webgpu` context: do not call `getContext` on that canvas yourself.
- Each plugin reads `frame.sourceView` (the source for the first plugin, the previous plugin's output after that) and writes `frame.destinationView`.
- `host.addPlugin(definition, options)` returns a handle: `{id, type, options, enabled, setOptions(patch), setEnabled(bool), mountUI(root), remove()}`.
- Without WebGPU `createHost` rejects with `HicUnsupportedError('effect-plugins')`. Keep a 2D `drawElementImage` fallback (decide before any `getContext`).

### Size the source like the canvas

The source element must have exactly the size of the canvas content box (the same CSS width and height, with `box-sizing: border-box` if you use padding). The host does not lay the source out for you: it presents the source texture stretched over the WHOLE canvas, and it applies the matching stretch to the live element so that hit testing follows the picture. That is also why the size matters for input: the pointer mapping goes canvas point -> plugin mappers -> source point, and the source point is only the right element when the source and the canvas have the same coordinate system. With a 400x200 canvas and a 37 px high form, the form is drawn 5.4 times too tall and a click on the drawn field lands on blank space (measured).

When the drawn source and the canvas differ by more than 1 CSS pixel at the first frame, `createHost` prints one `console.warn` per host with both sizes. It does not change anything else. The complete page of section 7 shows the sizing.

## 2. The definition

`HTMLInCanvasEffects.definePlugin(def)` validates and freezes a definition (a `TypeError` names the first problem):

| field | rule |
|---|---|
| `type` | non-empty string |
| `apiVersion` | `2` (any other value is a `TypeError`) |
| `version` | finite number (your plugin's own version) |
| `create(context, options)` | function, may be async, returns the instance |
| `outputCapabilities` | optional. `{ directCanvasRenderAttachment: true }` promises that the pass only WRITES its destination as a colour attachment of the same format and never samples or reads it; the host may then give the last plugin the canvas texture directly. Any other key is a `TypeError`. |

`create` receives `context = { apiVersion, canvas, source, adapter, device, format, requestRender(), viewport(), listen(type, listener, options) }`. `listen` adds a listener on the canvas AND on its live layer (pointer events land on the layer) and removes it when the plugin is removed. `options` is what you passed to `addPlugin`.

## 3. The instance

| member | |
|---|---|
| `render(frame)` | required. Encode your pass into `frame.encoder`. `frame` has `now` (ms), `delta`, `frameIndex`, `frameCap`, `sourceVersion`, `sourceReady`, `encoder`, `sourceView`/`sourceTexture`, `destinationView`/`destinationTexture`, and `width`, `height` (backing pixels), `cssWidth`, `cssHeight`, `dpr`. When `sourceReady` is false no snapshot has been uploaded yet: write something harmless. |
| `spatial` | `true` when your output moves pixels. Then `captureInputMapper` is REQUIRED: `addPlugin` rejects with a `TypeError` when the created instance is `spatial` without it (`src/effects/plugin-abi.js`, `validateInstance`). |
| `continuous` | `true` to be rendered on every capped frame even when the source did not change (animations). Otherwise the host renders when the source changed or you call `context.requestRender()`. It may change at runtime (a getter, or a property you assign): the host reads it after every frame, so a plugin that animates only now and then is `continuous` only while it animates. A host with nothing to render is idle and reads it again only at its next frame: after switching it to `true`, call `context.requestRender()`. |
| `captureInputMapper(frame)` | see section 4 |
| `setOptions(options)`, `resize(viewport)`, `mountUI(root, ui)`, `destroy()` | optional functions |

Frame pacing: the host renders at most at the canvas frame cap (`framecap` attribute / `canvas.frameCap`, 0 to 240, 0 = display rate). Plugins do not pace themselves. With the cap at 30 the plugin is called about 30 times a second (`docs/API-CONTRACT.md` 7.1).

## 4. The input mapper contract

When a plugin moves pixels, the element under the pointer is not the element the user sees. The host calls `captureInputMapper(frame)` each time a frame is PRESENTED and keeps the mappers of the last 3 presented frames. A mapper answers: "the pixel the user sees at output point P shows the source at which point?"

- Signature: `mapper(point) => {x, y}` with `point = {x, y, width, height}`. `x`, `y` are canvas-relative CSS pixels of the content box; `width`, `height` are the presented size in CSS pixels. The result is in the same coordinate system, in the SOURCE.
- PURE: no reads of the DOM, no state that changes afterwards. Freeze what that frame used (time, options) when `captureInputMapper` is called; a later `render` must not change an earlier mapper. The water plugin (`plugins/water/`) copies its uniform block into one of 4 slots per presented frame; the example below stores `{t, a}` at render time.
- Finite: a mapper that returns a non-finite number makes the host throw a `TypeError` (`an input mapper returned a non-finite point`).
- No element: where the presented pixel shows nothing of the source (a monitor bezel, the space beside a tilted card, a fragment in flight), return `NO_TARGET` (below), not a made-up far-away point.
- Optional `mapper.captureGestureSnapshot()` returns a mapper frozen at that moment. The host calls it at `pointerdown` so a drag keeps one mapping while the picture keeps moving.
- Several spatial plugins: the host composes their mappers, last plugin first.
- Not every plugin moves pixels. A plugin that only tints or blurs is not `spatial` and has no mapper.

What the host does with a mapper (the interposer, on by default): for `pointermove`, `pointerdown`, `pointerup` and `click` on the live layer it maps the pointer, finds the element at the mapped point, and when the native hit control differs it re-implements the activation (focus, button, link, checkbox, radio and label click on `pointerup`, `input[type=range]` value and `input`/`change` events during the gesture, text caret placement). It does NOT re-target select popups, drag selection or contenteditable (`interposer-retarget` in `docs/SUPPORT-MATRIX.md`). End to end with trusted input, the interposer is checked through the example plugins in the gallery (`npm run test:plugins`: clicks on controls drawn away from their DOM position by the CRT, holo-card and liquid-glass plugins, and presses swallowed while the disintegrate and shatter transitions play); for other plugins only the mapper against the GPU pixels is checked (section 6).

### `NO_TARGET`: no element here

`NO_TARGET` is the value a mapper returns for "the user sees no element of the source at this point". It is exported by the effects module (`import { NO_TARGET, isNoTarget } from '@giuseppe-scotto-lavina/html-in-canvas-polyfill/effects'`) and by the classic bundle (`HTMLInCanvasEffects.NO_TARGET`, `HTMLInCanvasEffects.isNoTarget(point)`). The plugins of this repository, built inside it, import `src/effects/no-target.js` by relative path; `src/` is internal and not an entry point of the package.

What the host does with it:
- The mapper chain stops at it. The mappers of the plugins before this one never see the point, so none of them can clamp it back onto the canvas, onto an element (a mapper that clamps to the canvas is common: the water plugin and the wobble example below do it).
- The interposer swallows the gesture: at `pointerdown` it prevents the native handling (no `mousedown`, no focus change, no text selection on the element natively under the pointer), activates nothing at `pointerup`, swallows the `click` that follows, and the focused element keeps the focus. Hover and `:active` show no element of the page, and the cursor is the default arrow.
- Keyboard input is not mapped and still reaches the focused element.

`NO_TARGET` is recognised by a registered symbol (`isNoTarget`), not by identity, so the copy that each plugin bundle carries is the same answer for the host. Its `x` and `y` are finite and far outside any viewport, so code that does not know the value hit-tests nothing there; do not rely on them, test with `isNoTarget`. Pointer events themselves still reach plugin listeners and page code with their native target.

## 5. A complete plugin: horizontal wobble

To add a plugin to this repository, start from [`plugins/_template/`](../../plugins/_template/): the build discovers the folder, inlines its WGSL, writes its bundles and lists it in the gallery; `plugins/README.md` has the folder contract and the shared test kit that checks a mapper against the GPU pixels. The example below is the same kind of plugin written as one classic script for your own page.

Load order in the page: core, effects bundle, this file. The page then calls `createHost` and `addPlugin(WobblePlugin, { amplitude: 8 })` (section 7).

```js
// A complete ABI v2 effect plugin: a horizontal wobble. Classic script; load it after hic-live-effects.iife.min.js.
// The shader displaces each output pixel sideways; captureInputMapper is the exact inverse-direction twin of that
// displacement (output point -> the SOURCE point the presented pixel shows), so clicks land on what the user sees.
(() => {
  const FREQUENCY = 0.05;   // radians per css px, vertically
  const SPEED = 2.0;        // radians per second

  const WGSL = /* wgsl */ `
    struct Uniforms { time : f32, amplitude : f32, css : vec2<f32>, resolution : vec2<f32> };
    @group(0) @binding(0) var<uniform> u : Uniforms;
    @group(0) @binding(1) var samp : sampler;
    @group(0) @binding(2) var source : texture_2d<f32>;

    @vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
      var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
      return vec4<f32>(p[i], 0.0, 1.0);
    }

    @fragment fn fs(@builtin(position) pos : vec4<f32>) -> @location(0) vec4<f32> {
      var uv = pos.xy / u.resolution;                       // 0..1 over the presented frame
      let cssY = uv.y * u.css.y;                            // css px down the canvas
      uv.x = uv.x + (u.amplitude * sin(cssY * ${FREQUENCY} + u.time * ${SPEED})) / u.css.x;
      return textureSample(source, samp, uv);
    }`;

  /** Source point shown at the presented point p, for a frame rendered at time t (seconds) with amplitude a (css px). PURE. */
  function wobbleSource(t, a, p) {
    const x = p.x + a * Math.sin(p.y * FREQUENCY + t * SPEED);
    return { x: Math.min(p.width, Math.max(0, x)), y: p.y };
  }

  window.WobblePlugin = HTMLInCanvasEffects.definePlugin({
    type: 'wobble',
    apiVersion: 2,
    version: 1,
    outputCapabilities: { directCanvasRenderAttachment: true }, // this pass only writes the destination as a colour attachment
    async create(context, options) {
      const { device, format } = context;
      const module = device.createShaderModule({ code: WGSL });
      const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
      const uniforms = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
      const bindGroups = new WeakMap();                      // one bind group per source texture view
      let amplitude = Number(options.amplitude ?? 6);        // css px
      let presented = { t: 0, a: amplitude };                // what the LAST rendered frame used

      return {
        spatial: true,       // pixels move, so the host REQUIRES captureInputMapper
        continuous: true,    // the wobble animates: render every capped frame even if the source did not change
        setOptions(next) { if (next.amplitude !== undefined) amplitude = Number(next.amplitude) || 0; },
        render(frame) {
          const t = frame.now / 1000;
          presented = { t, a: amplitude };
          device.queue.writeBuffer(uniforms, 0, new Float32Array([t, amplitude, frame.cssWidth, frame.cssHeight, frame.width, frame.height]));
          let bindGroup = bindGroups.get(frame.sourceView);
          if (!bindGroup) {
            bindGroup = device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: [{ binding: 0, resource: { buffer: uniforms } }, { binding: 1, resource: sampler }, { binding: 2, resource: frame.sourceView }],
            });
            bindGroups.set(frame.sourceView, bindGroup);
          }
          const pass = frame.encoder.beginRenderPass({
            colorAttachments: [{ view: frame.destinationView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
          });
          if (frame.sourceReady) { pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.draw(3); }
          pass.end();
        },
        // Called by the host each time a frame is PRESENTED. Freeze the values that frame used: later renders must not change THIS mapper.
        captureInputMapper() {
          const { t, a } = presented;
          return (point) => wobbleSource(t, a, point);
        },
        destroy() { uniforms.destroy(); },
      };
    },
  });
  window.WobblePlugin.wobbleSource = wobbleSource; // exposed only so the smoke test can compare it with the GPU's pixels
})();
```

Notes on the code:
- The shader and `wobbleSource` use the same constants and the same formula. The shader moves the source sideways by `amplitude * sin(y * 0.05 + t * 2)` css px, so the mapper adds exactly that to the output x.
- `render` stores `{t, a}` BEFORE encoding; `captureInputMapper` reads that, so the mapper describes the pixels of the frame that was just rendered.
- Bind groups are cached per `frame.sourceView`, because the host may recreate the source texture when the canvas size changes.
- `uniforms` is 32 bytes: the WGSL struct is `f32, f32, vec2, vec2` = 24 bytes, rounded up.

## 6. How this example is verified

`npm run test:examples` serves `test/examples-smoke/wobble-plugin/index.html` (a red bar 14 css px wide at x = 300 in the source) in headless Chrome and checks: the host and plugin start; the presented frame is not blank and the live layer has computed opacity 0; amplitude 24 differs from amplitude 0 in more than 400 pixels; and the mapper against the pixels. For the last check the frame is frozen (`framecap=1`), a compositor screenshot is taken, the left edge of the bar is found on 38 rows, and `mapper(edge)` must give x = 300 within 2 px. The control is the identity mapper (what a plugin without a mapper amounts to), which must be wrong by 8 px or more on the same pixels.

Result of one run on one machine (headless Chrome 154.0.8037.98, macOS, DPR 1, amplitude 24): bar edge moved over a range of 48 px, the plugin's mapper was off by at most 1.18 px, the identity mapper by 24.5 px (`.scratch/results/examples-<timestamp>.json`, `numbers.mapper`). This shows the mapper contract works for this plugin; it is not a statement about every plugin or GPU.

## 7. Using a plugin in a page

The complete page. Save it as `examples/mine/index.html` and the plugin of section 5 as `examples/mine/wobble.js` (the demo server serves only `/examples` and `/dist`; opening the file from disk works too). The three scripts must come in this order: core, effects bundle, plugin. Note that `#src` and `#stage` have the same size (`600x320`):

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>wobble plugin</title>
<script src="../../dist/hic-live-polyfill.iife.min.js"></script>   <!-- 1. core: installs while this tag runs -->
<script src="../../dist/hic-live-effects.iife.min.js"></script>    <!-- 2. defines HTMLInCanvasEffects -->
<script src="wobble.js"></script>                                  <!-- 3. the plugin of section 5 (defines window.WobblePlugin) -->
<style>
  body { margin: 0; font: 14px system-ui, sans-serif; }
  #stage { display: block; width: 600px; height: 320px; }                      /* the canvas: 600 x 320 css px */
  #src { box-sizing: border-box; width: 600px; height: 320px; padding: 40px;   /* the source: EXACTLY the same size */
         background: #f4f4f0; }
  #name { width: 180px; padding: 6px; font: inherit; }
</style>
</head>
<body>
<canvas id="stage" content="drawable">
  <div id="src" drawable>
    <label>name <input id="name" value="wobble" autocomplete="off"></label>
    <button id="go">Go</button>
  </div>
</canvas>
<div id="state">starting</div>
<script>
  (async () => {
    const state = document.getElementById('state');
    try {
      // do NOT call canvas.getContext() before this: the host owns the canvas bitmap
      const host = await HTMLInCanvasEffects.createHost(document.getElementById('stage'), document.getElementById('src'), { interposer: true });
      await host.addPlugin(WobblePlugin, { amplitude: 8 });
      state.textContent = 'wobble plugin running: click the wobbling field and type';
    } catch (error) {                                   // no WebGPU, or the source is not a drawable of the canvas
      state.textContent = 'effect not available: ' + (error && error.message || error);
    }
  })();
</script>
</body>
</html>
```

Calling the handle:

```js
const host = await HTMLInCanvasEffects.createHost(canvas, formElement, { maxDpr: 2.5, interposer: true });
const handle = await host.addPlugin(WobblePlugin, { amplitude: 8 });

handle.setOptions({ amplitude: 14 });   // calls instance.setOptions
handle.setEnabled(false);               // skip the plugin without destroying it
handle.mountUI(document.getElementById('controls'));   // if the instance implements mountUI(root, ui); returns a dispose function
handle.remove();                        // destroys the instance
host.destroy();                         // stops rendering; the canvas keeps a (cleared) WebGPU context for life
```

Events on the canvas: `effectframe` (a frame was presented, `detail` is the presentation frame) and `effecterror` (`detail: {error, type, id, phase}`). A plugin that throws is marked failed and is no longer called (`src/effects/effect-plugins.js`); the error is recorded in `installed.report().errors` and printed once. The contract says the canvas keeps the last presented frame after `effecterror` (`docs/API-CONTRACT.md` 7.3); that behaviour has no gate of its own.

## 8. Checklist

- `spatial: true` has a `captureInputMapper` and it is pure and frozen per frame.
- Where the presented pixel shows no element of the source, the mapper returns `NO_TARGET`.
- The mapper formula is the shader formula (test it against pixels, as `check-examples` does, or with `checkMapperAgainstGpu` of `plugins/_shared/gpu-check.mjs`).
- You did not call `getContext` on the canvas.
- A 2D fallback exists for browsers without WebGPU, and for a browser whose own native implementation is in use (the extensions are not available there, see the top of this guide).
- You measured the cost on your own page: `docs/guides/PERFORMANCE.md` says which numbers exist and which do not.
