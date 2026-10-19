# Effect plugins: using them and writing them

An effect plugin is a small WebGPU pass that runs over the HTML a canvas draws. The optional effects bundle of this library hosts it: the host uploads the polyfill's picture of one drawable element into a texture, runs the plugins in order, presents the result on the canvas, and maps pointer input back through the plugins so that a click reaches the element the user sees. A plugin may also declare **actions** (a transition that plays, a burst, a hint) that page code runs through the plugin's handle.

This guide is the reference for both sides:

- **Using plugins** (sections 1 to 9): load the bundles, create the host, add plugins, set the frame cap, run actions, reduced motion, errors, removal, a complete page.
- **Writing plugins** (sections 10 to 18): the plugin interface (ABI v2), the context, the instance, the input mapper and `NO_TARGET`, actions, a complete plugin, and how to test a plugin with the shared kit.

The example plugins of this repository live in [`plugins/`](../../plugins/), outside the polyfill; the [plugin gallery](../../examples/plugins/) applies each of them to one live form, and [`examples/effect-plugin/`](../../examples/effect-plugin/) is the smallest page that uses them.

## Extensions, not the standard

The effects host (`HTMLInCanvasEffects`, this plugin interface, the input remapping) and the frame cap (`framecap`, `canvas.frameCap`) are **extensions of this library**. They are not part of the HTML-in-Canvas proposal, and browsers' native implementations do not and will not provide them: they are this library's own API. Code that uses them depends on this library, not on the standard.

They work only while this polyfill provides the API (mode `polyfill`, see `__HIC__.installed.mode`). On top of a native implementation they are not supported. What was checked on 2026-10-14 (macOS, Apple M1 Max, 120 Hz display, headed and headless Chrome), with the built core and effects bundles in `examples/plugins/` and the water example page of that time (now `examples/effect-plugin/`):

- **Chrome Canary 157.0.8103.0, with or without `--enable-blink-features=CanvasDrawElement`: mode `native`.** The polyfill steps aside (kind `complete`); the examples turn the effects off unless the mode is `polyfill` and draw the form through the browser's own `drawElementImage`; clicking and typing work natively. Earlier preview builds refused this build (`partial-native`, because its `ElementImage` has no `width` / `height`), so the effect behaviour below was measured with a test-only stub that added `ElementImage.prototype.width` and `height`; the effects code never reads those two members, so the stub measurement describes mode `native` on this build.
- **Effects in mode `native` (measured with that stub): partially.** The effects host started and the water plugin rendered over the native `GPUQueue.drawElementImageToTexture` (frames presented, ripples visible). But `canvas.frameCap` is not defined in this mode (assigning it creates a plain property: 120 effect frames per second whatever the value; the `framecap` attribute did bound the effect frames, 15 and 30.5 per second at 15 and 30), and pointer input was not remapped: a trusted click on the drawn name field hit the canvas, the field did not get the focus and the typing was lost. The input interposer needs the polyfill's live layer, which does not exist in mode `native`.

So with a native implementation the drawing of an effect may work, the interaction through it does not, and the frame cap property is absent. The examples turn the effects and the frame cap off unless the mode is `polyfill`, and keep the form usable.

Sources of truth: `docs/API-CONTRACT.md` section 7, the typedefs `EffectHost`, `EffectHandle`, `EffectPluginDefinition`, `EffectPluginInstance`, `EffectPluginContext`, `EffectRenderFrame`, `InputMapper` and `EffectActionState` in `src/contracts/types.js`, the validation in `src/effects/plugin-abi.js` and the handles in `src/effects/effect-plugins.js`.

## Using plugins

### 1. Load the bundles

Classic scripts, in this order: the core, the effects host, then the plugins (each plugin bundle registers `window.HicLivePlugins.<name>`; the plugins can load in any order among themselves):

```html
<script src="dist/hic-live-polyfill.iife.min.js"></script>      <!-- the polyfill: installs while this tag runs -->
<script src="dist/hic-live-effects.iife.min.js"></script>       <!-- window.HTMLInCanvasEffects -->
<script src="dist/plugins/water.iife.min.js"></script>          <!-- window.HicLivePlugins.water = {meta, plugin, ...} -->
<script src="dist/plugins/disintegrate.iife.min.js"></script>   <!-- window.HicLivePlugins.disintegrate -->
```

With a bundler: `import { installEffects } from '@giuseppe-scotto-lavina/html-in-canvas-polyfill/effects'` (it defines `window.HTMLInCanvasEffects` and returns the same API) and `import { plugin } from '@giuseppe-scotto-lavina/html-in-canvas-polyfill/plugins/water'`. Every bundle and subpath: [docs/BUNDLES.md](../BUNDLES.md). On Firefox and Safari also load `hic-live-engines.iife.min.js` (it draws form controls in those engines' look).

### 2. Create the host

```js
const host = await HTMLInCanvasEffects.createHost(canvas, source, { maxDpr: 2.5, interposer: true });
```

- `canvas` is a `<canvas content="drawable">` managed by the polyfill; `source` is one drawable element of it (a direct child with the `drawable` attribute, or a descendant marked drawable). The host owns the canvas bitmap and its `webgpu` context: **do not call `canvas.getContext()` before or after** on that canvas.
- The host presents `source` stretched over the whole canvas and applies the matching stretch to the live element, so input follows the picture. **Size the source like the canvas** (section 2.1).

| option | default | |
|---|---|---|
| `maxDpr` | the polyfill's `maxDpr` option (2.5; 3 on phones) | the canvas backing store is its CSS size times `min(devicePixelRatio, maxDpr)` |
| `powerPreference` | the browser's | `'low-power'` or `'high-performance'`, passed to `requestAdapter` |
| `interposer` | `true` | remap pointer input through the spatial plugins (section 14); `false` leaves input to the browser |

`createHost` rejects with:

| error | when |
|---|---|
| `HicUnsupportedError` (`feature: 'effect-plugins'`) | no WebGPU, no adapter, or the device request failed. The canvas is still free for a 2D context: the adapter and the device are acquired before the canvas is claimed |
| `InvalidStateError` | `source` is not an eligible drawable of `canvas`; the canvas already has another context type; the core is not installed (or was uninstalled) |
| `TypeError` | `canvas` is not an `HTMLCanvasElement`, `source` not an `Element`, `options` not an object |

Keep the standard 2D path as the fallback and choose before any `getContext` call, because a canvas keeps its first context type for life. The effects also run only while the polyfill provides the API (section "Extensions, not the standard"):

```js
let host = null;
try {
  if (window.__HIC__?.installed?.mode !== 'polyfill') throw new Error('the effects need the polyfill');
  if (!navigator.gpu) throw new Error('this browser has no WebGPU');
  host = await HTMLInCanvasEffects.createHost(canvas, form);
} catch (error) {
  const ctx = canvas.getContext('2d');                      // the standard path, without effects
  canvas.onpaint = () => { ctx.reset(); ctx.drawElementImage(form, 0, 0); };
}
```

`host` has `pluginCount`, `addPlugin(definition, options)`, `stats()` (`{frames, fps, uploads, pluginErrors, deviceLosses, paused, pauses, offscreenFrames, sourceVersion, remapped, passedThrough}`) and `destroy()`.

The host does no work for a canvas nobody can see. While the canvas is more than half a viewport (or half its scroll container) out of view, or the document is hidden, it renders nothing, `continuous` plugins included, and uploads nothing; `stats().paused` is then `true`. It starts again before the canvas scrolls back in, so the first frame you see is current; a jump straight into view (`scrollTo`, an anchor) is rendered in the frame that shows it. The frame clock does not stop: on resume an effect shows what it shows at that time, nothing is replayed. An action you trigger, or a `settled()` you await, while the canvas is out of view still completes: the host renders about 10 frames per second until it settles (`stats().offscreenFrames`), and in a hidden document, where the browser runs no frames, on the first frame after the document is shown again. There is no option: the pause cannot be seen.

#### 2.1 Size the source like the canvas

The source element must have exactly the size of the canvas content box (the same CSS width and height, with `box-sizing: border-box` if you use padding). The host does not lay the source out for you: it presents the source texture stretched over the WHOLE canvas, and it applies the matching stretch to the live element so that hit testing follows the picture. That is also why the size matters for input: the pointer mapping goes canvas point -> plugin mappers -> source point, and the source point is only the right element when the source and the canvas have the same coordinate system. With a 400x200 canvas and a 37 px high form, the form is drawn 5.4 times too tall and a click on the drawn field lands on blank space (measured).

When the drawn source and the canvas differ by more than 1 CSS pixel at the first frame, `createHost` prints one `console.warn` per host with both sizes. It does not change anything else.

### 3. Add plugins

```js
const water = await host.addPlugin(HicLivePlugins.water.plugin, { intensity: 0.3 });
const dust = await host.addPlugin(HicLivePlugins.disintegrate.plugin, { onSubmit: 'off' });
```

`addPlugin(definition, options)` validates the definition (`TypeError` naming the first problem), creates the plugin on the host's device and resolves with its **handle**. Plugins run in the order they were added: the first reads the drawn source, each next one reads the previous one's output. Each plugin's options are documented in its README (`plugins/<name>/README.md`); `meta.defaults` of a plugin bundle are the options the gallery uses. `addPlugin` rejects when the plugin's `create` fails (the error of the plugin) or when the host was destroyed (`InvalidStateError`).

The handle:

| member | |
|---|---|
| `id`, `type` | a unique id (`'water-1'`) and the plugin's type |
| `options` | the current options, frozen |
| `enabled` | `false` after `setEnabled(false)` or after the plugin failed |
| `actions` | the names `trigger` accepts (empty when the plugin declares none) |
| `setOptions(patch)` | merges `patch` into the options and hands the result to the plugin |
| `setEnabled(enabled)` | takes the plugin out of the chain (or back in) without destroying it; `true` also clears a failure |
| `mountUI(root)` | lets the plugin add its own controls, as ordinary HTML, to `root` (it can be inside the drawn form); returns a function that removes them |
| `trigger(action, options?)` | runs an action; resolves with the state the plugin rests in afterwards (section 5) |
| `settled()` | resolves once nothing of the plugin moves, with that state (section 5) |
| `remove()` | destroys the plugin (section 8) |

### 4. The frame cap

The frame cap bounds how often the effect renders: at most `F` effect frames per second for that canvas (and `paint` events and snapshot builds), `0` = the display rate.

```js
canvas.frameCap = 30;                       // or <canvas content="drawable" framecap="30">
```

`canvas.frameCap` reflects the `framecap` attribute (0 to 240; larger values clamp). Plugins do not pace themselves: the host calls them at most at the cap, and a plugin whose animation is a function of the frame clock (all of the example plugins) shows the same picture at the same instant whatever the cap. Rules and measurements: [API-CONTRACT 7.1](../API-CONTRACT.md#71-frame-cap).

### 5. Actions: `trigger` and `settled`

A plugin may declare actions: the transition plugins play, the glitch bursts, the page curl peeks. Page code runs them through the plugin's handle:

```js
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const gone = await dust.trigger('out');     // 'out' once the form has turned to dust (null if superseded)
  showAnswer();                               // change the page while nothing of it is shown
  const back = await dust.trigger('in');      // 'in' once the form has re-formed, showing the answer
});
```

**`handle.trigger(action, options?)`** returns a promise:

- It **resolves with the state** the plugin rests in once the action has ended, after the frame that shows that state was rendered: for example `'in'` / `'out'` (disintegrate), `'intact'` / `'cracked'` / `'gone'` (shatter). Each plugin documents its states (its README, "Actions").
- It **resolves with `null`** when the action did not complete:
  - a **newer action superseded it**: a newer `trigger` on the same handle (the older promise resolves `null` at the moment the newer `trigger` is called), or an action the plugin started itself (its submit handler, its own buttons), or a declarative option that moves it (`setOptions({ state: 'out' })` of the transition plugins);
  - the plugin was **removed** (`handle.remove()`, `host.destroy()`), **disabled** (`setEnabled(false)`) or **failed** (it threw while rendering);
  - the GPU device was **lost**: the host creates the plugin again on a new device, in the state its options describe, and the action that was playing is gone.
- It **rejects** with:

| error | when |
|---|---|
| `TypeError` | `action` is not one of `handle.actions` (the message lists them: `unknown action "spin" of the plugin "disintegrate"; its actions are 'out', 'in', 'play'`); the plugin declares no actions; `options` is not an object; the plugin rejects the options (for example a `point` that is not `{x, y}`) |
| `InvalidStateError` | the plugin was removed, is disabled, or failed |
| the plugin's own error | the plugin threw or rejected while running the action; the plugin keeps running |

`trigger` calls the plugin synchronously, so actions run in the order they are triggered. While the host is creating the plugin again after a device loss, a `trigger` waits for the new instance and runs on it.

**`handle.settled()`** resolves once nothing of the plugin moves any more (at once when nothing moves), with the state it rests in; with `null` when the plugin is removed, disabled or failed. Unlike `trigger` it survives a device loss: it then waits for the re-created instance. A plugin without actions rejects `settled()` with a `TypeError`.

**Reduced motion.** The host reads `prefers-reduced-motion` when an action is triggered and passes it to the plugin. The plugin plays its reduced variant (the transitions crossfade instead of moving pieces), or, when an action has no reduced variant, does nothing and resolves at once with the state it rests in (the water's drop and the page curl's peek). The promises behave the same way in both cases. Some plugins have their own `reducedMotion` option that overrides the user preference (`true` or `false`).

**The plugin's own triggers.** A plugin that runs an action by itself (the submit handler of the transition plugins, the Burst, Strike and "Turn to dust" buttons of `mountUI`) goes through the same path as `trigger`, so it supersedes a pending `trigger` of the page. Nobody awaits those, so their failures are reported as `effecterror` with `phase: 'action'`.

The actions of the example plugins:

| plugin | actions | options | states |
|---|---|---|---|
| [`disintegrate`](../../plugins/disintegrate/README.md#actions) | `out` (to dust, stays gone), `in` (re-forms), `play` (both) | none | `'in'`, `'out'` |
| [`shatter`](../../plugins/shatter/README.md#actions) | `impact` (cracks an intact pane, breaks a cracked one), `crack`, `out`, `in`, `play` | `point: {x, y}` (canvas CSS px) | `'intact'`, `'cracked'`, `'gone'` |
| [`glitch`](../../plugins/glitch/README.md#actions) | `burst` | none | `'idle'` |
| [`page-curl`](../../plugins/page-curl/README.md#actions) | `peek` (the dog-ear opens and closes once) | none | `'rest'` |
| [`water`](../../plugins/water/README.md#actions) | `drop` (a ripple) | `point: {x, y}` (canvas CSS px), `strength` (0.08 to 2) | `'calm'` |

`crt`, `holo-card` and `liquid-glass` follow the pointer and have no actions.

### 6. Reduced motion

Every plugin of this repository states in one line what it does under `prefers-reduced-motion: reduce` (`meta.reducedMotion`, also in `dist/plugins/manifest.json`; the gallery shows it): animations stop or become crossfades, and input keeps working through what is shown. The preference is read when the plugin is created and, for actions, at every `trigger` (section 5). Nothing in the host animates on its own.

### 7. Errors and events

Two events on the canvas:

| event | `detail` | |
|---|---|---|
| `effectframe` | the presented frame: `{now, delta, frameIndex, frameCap, sourceVersion}` | after each presented frame |
| `effecterror` | `{error, type, id, phase}` | a plugin failed; `phase` is `create`, `render`, `resize`, `setOptions`, `recreate`, `destroy`, `mountUI-dispose`, `action` (a trigger of the plugin itself failed) or `settled`; `type: 'host', phase: 'recover'` when the host gave up after GPU device losses |

A plugin that throws while rendering, resizing or taking options is marked failed and is no longer called (the canvas keeps its last presented frame); `handle.enabled` turns `false`, its pending `trigger` and `settled` resolve `null`, and `handle.setEnabled(true)` tries it again. Every error is also recorded in `__HIC__.installed.report().errors` and printed once.

**GPU device loss.** The host keeps presenting the last frame, opens a new device and creates every plugin again with its latest options, re-mounting its UI. More than 3 losses within 10 seconds stop the recovery (`effecterror` with `type: 'host'`).

### 8. Removing plugins and destroying the host

- `handle.remove()` destroys the plugin: its `destroy()` runs, the listeners it added through `context.listen` are removed, its mounted UI is disposed, its pending `trigger` and every `settled()` waiter resolve `null`, and later calls of `trigger` reject (`InvalidStateError`); `settled()` resolves `null`.
- `host.destroy()` removes every plugin, stops rendering, unregisters the input interposer and gives the live element its normal geometry back. A WebGPU canvas context cannot be released: the canvas keeps a (cleared) `webgpu` context, and a later `getContext('2d')` on it returns `null`, as in any browser.
- `uninstall()` of the polyfill destroys every host.

### 9. A complete page

[`examples/effect-plugin/`](../../examples/effect-plugin/) is a complete page with the plugins of this repository in about 30 lines of script: the host, the water plugin, the frame cap, and a disintegrate transition run from the page's submit handler, with the 2D fallback.

The page below runs the plugin written in section 16 instead. Save it as `examples/mine/index.html` and the plugin as `examples/mine/wobble.js` (the demo server serves only `/examples` and `/dist`; opening the file from disk works too). Note that `#src` and `#stage` have the same size (`600x320`):

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>wobble plugin</title>
<script src="../../dist/hic-live-polyfill.iife.min.js"></script>   <!-- 1. core: installs while this tag runs -->
<script src="../../dist/hic-live-effects.iife.min.js"></script>    <!-- 2. defines HTMLInCanvasEffects -->
<script src="wobble.js"></script>                                  <!-- 3. the plugin of section 16 (defines window.WobblePlugin) -->
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
    <button id="go">Pulse</button>
  </div>
</canvas>
<div id="state">starting</div>
<script>
  (async () => {
    const state = document.getElementById('state');
    try {
      // do NOT call canvas.getContext() before this: the host owns the canvas bitmap
      const host = await HTMLInCanvasEffects.createHost(document.getElementById('stage'), document.getElementById('src'), { interposer: true });
      const wobble = await host.addPlugin(WobblePlugin, { amplitude: 8 });
      document.getElementById('go').addEventListener('click', async () => {
        state.textContent = 'pulse: ' + await wobble.trigger('pulse', { amplitude: 30 });   // 'calm', or null when superseded
      });
      state.textContent = 'wobble plugin running: click the wobbling field and type, or press Pulse';
    } catch (error) {                                   // no WebGPU, or the source is not a drawable of the canvas
      state.textContent = 'effect not available: ' + (error && error.message || error);
    }
  })();
</script>
</body>
</html>
```

The handle in short:

```js
const host = await HTMLInCanvasEffects.createHost(canvas, formElement, { maxDpr: 2.5, interposer: true });
const handle = await host.addPlugin(WobblePlugin, { amplitude: 8 });

handle.setOptions({ amplitude: 14 });   // calls instance.setOptions with the merged options
handle.setEnabled(false);               // skip the plugin without destroying it
handle.mountUI(document.getElementById('controls'));   // if the instance implements mountUI(root, ui); returns a dispose function
await handle.trigger('pulse');          // an action: resolves with the state at rest ('calm'), or null when superseded
await handle.settled();                 // nothing moves: the state at rest
handle.remove();                        // destroys the instance; pending actions resolve null
host.destroy();                         // stops rendering; the canvas keeps a (cleared) WebGPU context for life
```

## Writing plugins

To add a plugin to this repository, start from [`plugins/_template/`](../../plugins/_template/): the build discovers the folder, inlines its WGSL, writes its bundles and lists it in the gallery; [`plugins/README.md`](../../plugins/README.md) has the folder contract. The plugin of section 16 is the same kind of plugin written as one classic script for your own page.

### 10. How the pieces fit

```
live HTML  --snapshot-->  source texture  --plugin 1-->  --plugin 2-->  canvas (WebGPU)
 (your form)              (host uploads                    ...            presented frame
                           when it changed)
pointer events on the live layer --interposer--> mapped through the mappers of the PRESENTED frame --> the element the user sees
handle.trigger(action) --host: validate, supersede--> instance.runAction --> resolves after the frame that shows the end state
```

Each plugin reads `frame.sourceView` (the source for the first plugin, the previous plugin's output after that) and writes `frame.destinationView`.

### 11. The definition (ABI v2)

`HTMLInCanvasEffects.definePlugin(def)` (also run by `addPlugin`) validates and freezes a definition; a `TypeError` names the first problem:

| field | rule |
|---|---|
| `type` | non-empty string |
| `apiVersion` | `2` (any other value is a `TypeError`) |
| `version` | finite number (your plugin's own version) |
| `create(context, options)` | function, may be async, returns the instance |
| `outputCapabilities` | optional. `{ directCanvasRenderAttachment: true }` promises that the pass only WRITES its destination as a colour attachment of the same format and never samples or reads it; the host may then give the last plugin the canvas texture directly. Any other key is a `TypeError`. |
| `actions` | optional. A non-empty array of unique action names, each a lowercase word (`/^[a-z][a-z0-9-]{0,31}$/`): the names `handle.trigger` accepts. The instance must then implement `runAction` and `settled` (section 15). |

### 12. The context

`create` receives `context` and the options passed to `addPlugin`:

| member | |
|---|---|
| `apiVersion` | `2` |
| `canvas`, `source` | the canvas and the drawable element the host samples |
| `adapter`, `device`, `format` | the host's WebGPU adapter and device (a new one after a device loss: `create` runs again) and the canvas format |
| `requestRender()` | asks for a frame (the host renders only when the source changed, on request, or every frame for a `continuous` instance) |
| `viewport()` | `{width, height, cssWidth, cssHeight, dpr}` of the canvas now |
| `listen(type, listener, options)` | adds a listener on the canvas AND on its live layer (pointer events land on the layer); removed when the plugin is removed |
| `trigger(action, options?)` | runs one of the plugin's own actions through the host, exactly as `handle.trigger` (section 15) |

### 13. The instance

| member | |
|---|---|
| `render(frame)` | required. Encode your pass into `frame.encoder`. `frame` has `now` (ms), `delta`, `frameIndex`, `frameCap`, `sourceVersion`, `sourceReady`, `encoder`, `sourceView`/`sourceTexture`, `destinationView`/`destinationTexture`, and `width`, `height` (backing pixels), `cssWidth`, `cssHeight`, `dpr`. When `sourceReady` is false no snapshot has been uploaded yet: write something harmless. `now` is the time of the frame and keeps running while the host is idle or paused off-screen, so `delta` (the time since the previous presented frame) can be seconds long: clamp it before you integrate anything with it (the example plugins clamp it to 0.1 s). |
| `spatial` | `true` when your output moves pixels. Then `captureInputMapper` is REQUIRED: `addPlugin` rejects with a `TypeError` when the created instance is `spatial` without it. |
| `continuous` | `true` to be rendered on every capped frame even when the source did not change (animations). Otherwise the host renders when the source changed or you call `context.requestRender()`. It may change at runtime (a getter, or a property you assign): the host reads it after every frame, so a plugin that animates only now and then is `continuous` only while it animates. A host with nothing to render is idle and reads it again only at its next frame: after switching it to `true`, call `context.requestRender()`. |
| `captureInputMapper(frame)` | see section 14 |
| `runAction(action, options, info)`, `settled()` | required when the definition declares `actions`; forbidden (`runAction`) otherwise. See section 15 |
| `setOptions(options)` | the merged options after `handle.setOptions` |
| `resize(viewport)` | the canvas size changed |
| `mountUI(root, ui)` | add your controls to `root`; `ui` is `{canvas, getOptions(), setOptions(patch), requestRender(), trigger(action, options?)}`; return a dispose function |
| `destroy()` | free your GPU resources; resolve what your `settled()` waiters wait for with `null` |

Frame pacing: the host renders at most at the canvas frame cap (section 4). Plugins do not pace themselves. With the cap at 30 the plugin is called about 30 times a second.

### 14. The input mapper contract

When a plugin moves pixels, the element under the pointer is not the element the user sees. The host calls `captureInputMapper(frame)` each time a frame is PRESENTED and keeps the mappers of the last 3 presented frames. A mapper answers: "the pixel the user sees at output point P shows the source at which point?"

- Signature: `mapper(point) => {x, y}` with `point = {x, y, width, height}`. `x`, `y` are canvas-relative CSS pixels of the content box; `width`, `height` are the presented size in CSS pixels. The result is in the same coordinate system, in the SOURCE.
- PURE: no reads of the DOM, no state that changes afterwards. Freeze what that frame used (time, options) when `captureInputMapper` is called; a later `render` must not change an earlier mapper. The water plugin (`plugins/water/`) copies its uniform block into one of 4 slots per presented frame; the plugin of section 16 stores `{t, a}` at render time.
- Finite: a mapper that returns a non-finite number makes the host throw a `TypeError` (`an input mapper returned a non-finite point`).
- No element: where the presented pixel shows nothing of the source (a monitor bezel, the space beside a tilted card, a fragment in flight), return `NO_TARGET` (below), not a made-up far-away point.
- Optional `mapper.captureGestureSnapshot()` returns a mapper frozen at that moment. The host calls it at `pointerdown` so a drag keeps one mapping while the picture keeps moving.
- Several spatial plugins: the host composes their mappers, last plugin first.
- Not every plugin moves pixels. A plugin that only tints or blurs is not `spatial` and has no mapper.

What the host does with a mapper (the interposer, on by default): for `pointermove`, `pointerdown`, `pointerup` and `click` on the live layer it maps the pointer, finds the element at the mapped point, and when the native hit control differs it re-implements the activation (focus, button, link, checkbox, radio and label click on `pointerup`, `input[type=range]` value and `input`/`change` events during the gesture, text caret placement). It does NOT re-target select popups, drag selection or contenteditable (`interposer-retarget` in `docs/SUPPORT-MATRIX.md`). End to end with trusted input, the interposer is checked through the example plugins in the gallery (`npm run test:plugins`); for other plugins only the mapper against the GPU pixels is checked (section 17).

#### `NO_TARGET`: no element here

`NO_TARGET` is the value a mapper returns for "the user sees no element of the source at this point". It is exported by the effects module (`import { NO_TARGET, isNoTarget } from '@giuseppe-scotto-lavina/html-in-canvas-polyfill/effects'`) and by the classic bundle (`HTMLInCanvasEffects.NO_TARGET`, `HTMLInCanvasEffects.isNoTarget(point)`). The plugins of this repository, built inside it, import `src/effects/no-target.js` by relative path; `src/` is internal and not an entry point of the package.

What the host does with it:
- The mapper chain stops at it. The mappers of the plugins before this one never see the point, so none of them can clamp it back onto the canvas, onto an element (a mapper that clamps to the canvas is common: the water plugin and the wobble plugin of section 16 do it).
- The interposer swallows the gesture: at `pointerdown` it prevents the native handling (no `mousedown`, no focus change, no text selection on the element natively under the pointer), activates nothing at `pointerup`, swallows the `click` that follows, and the focused element keeps the focus. Hover and `:active` show no element of the page, and the cursor is the default arrow.
- Keyboard input is not mapped and still reaches the focused element.

`NO_TARGET` is recognised by a registered symbol (`isNoTarget`), not by identity, so the copy that each plugin bundle carries is the same answer for the host. Its `x` and `y` are finite and far outside any viewport, so code that does not know the value hit-tests nothing there; do not rely on them, test with `isNoTarget`. Pointer events themselves still reach plugin listeners and page code with their native target.

### 15. Actions

Declare the names in the definition and implement two methods on the instance. The host does the rest: it validates the action name and the type of `options`, supersedes the pending action of the handle, resolves pending promises with `null` on removal, disable, failure and device loss, and moves `settled()` waiters to a re-created instance.

```js
definePlugin({ type: 'wobble', apiVersion: 2, version: 1, actions: ['pulse'], create(context, options) { /* ... */ } });
```

`runAction(action, options, info)`:
- `action` is one of your declared names (the host has checked it); `options` is a frozen copy of what the page passed (`{}` when nothing); `info.reducedMotion` is `prefers-reduced-motion: reduce` as the host read it for this call.
- Start the action and return the state your plugin will rest in, or a promise of it. Resolve **after the frame that draws the end state was rendered** (resolve in `render`, after you encoded that frame), so that a page that awaits it and then reads the canvas sees the end state.
- Start the animation's clock at the first frame that renders it (as the example plugins do: the length of the action is then the same at every frame cap), and call `context.requestRender()` if your instance is not `continuous`.
- Drive it from `frame.now`, not from a count of frames: while the canvas is out of view the host renders an unsettled action at about 10 frames per second, and after a hidden document is shown again the next frame may already be past the end of the action.
- Resolve with `null` when your plugin supersedes or cancels the action itself (a submit handler that starts another one).
- Throw a `TypeError` for options you cannot use (the host rejects the trigger with it; your plugin keeps running).
- When the action cannot do anything now (reduced motion without a reduced variant, a state where it makes no sense), return what `settled()` returns: the state you rest in next.

`settled()`: return the state at once when nothing moves, otherwise a promise that you resolve with the state after the frame where the motion ended. In `destroy()`, resolve your waiters with `null`.

Your own triggers (a submit listener, a button of `mountUI`) should call `context.trigger(action, options)` or `ui.trigger(action, options)`, not your internals directly: they then supersede a pending trigger of the page like any other action, the host passes the reduced-motion reading, and a failure is reported as `effecterror` (`phase: 'action'`).

States are short lowercase words that describe what the plugin shows at rest, documented in the plugin's README.

### 16. A complete plugin: horizontal wobble

A complete ABI v2 plugin as one classic script, with an input mapper and one action. It is the file that the smoke test of `npm run test:examples` runs (`test/examples-smoke/wobble-plugin/wobble-plugin.js`; the test checks that this block and the file are the same). Load order in the page: core, effects bundle, this file (section 9).

```js
// A complete ABI v2 effect plugin: a horizontal wobble. Classic script; load it after hic-live-effects.iife.min.js.
// The shader displaces each output pixel sideways; captureInputMapper is the exact inverse-direction twin of that
// displacement (output point -> the SOURCE point the presented pixel shows), so clicks land on what the user sees.
// One action, 'pulse': handle.trigger('pulse', { amplitude, ms }) swells the wobble and back, then resolves 'calm'.
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
    actions: ['pulse'],                                         // the names handle.trigger accepts (the host checks them)
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
      let pulse = null;                                      // the running pulse {from, peak, ms}; from: its first frame
      const waiters = [];                                    // settled() calls waiting for the pulse to end
      const settled = () => (pulse ? new Promise((resolve) => waiters.push(resolve)) : 'calm');

      return {
        spatial: true,       // pixels move, so the host REQUIRES captureInputMapper
        continuous: true,    // the wobble animates: render every capped frame even if the source did not change
        setOptions(next) { if (next.amplitude !== undefined) amplitude = Number(next.amplitude) || 0; },
        // The action 'pulse' (handle.trigger): resolve with the state the plugin rests in once the frame that ends it was rendered.
        runAction(action, actionOptions) {
          pulse = { from: NaN, peak: Number(actionOptions.amplitude ?? 24), ms: Number(actionOptions.ms ?? 600) };
          return settled();
        },
        settled,                                             // resolves once nothing of the action moves: 'calm'
        render(frame) {
          const t = frame.now / 1000;
          let a = amplitude;
          if (pulse) {
            if (Number.isNaN(pulse.from)) pulse.from = frame.now;   // the pulse starts at the first frame that renders it
            const k = (frame.now - pulse.from) / pulse.ms;
            if (k < 1) a += (pulse.peak - amplitude) * Math.sin(Math.PI * k);
            else { pulse = null; for (const resolve of waiters.splice(0)) resolve('calm'); }
          }
          presented = { t, a };
          device.queue.writeBuffer(uniforms, 0, new Float32Array([t, a, frame.cssWidth, frame.cssHeight, frame.width, frame.height]));
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
        destroy() { for (const resolve of waiters.splice(0)) resolve(null); uniforms.destroy(); },
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
- The action `pulse` follows section 15: `runAction` starts it, its clock starts at the first frame that renders it, `render` resolves the waiters in the frame where it ends, and `destroy` resolves them with `null`. The host checks the action name, supersedes an older pulse and handles removal.

### 17. Testing a plugin

The shared test kit of `plugins/_shared/` (test tooling, not shipped) covers the three levels the example plugins are tested at; [`plugins/README.md`](../../plugins/README.md#tests) has the commands.

**Node** (`plugins/<name>/test/*.test.mjs`, run by `npm run test:unit`):
- `contractTest(import.meta.url)` (`_shared/contract-test.mjs`): the folder satisfies the plugin contract.
- `nodeHandle(plugin, options, {device, canvas, source, reducedMotion})` (`_shared/node-host.mjs`): the plugin behind the REAL handle of the host (`trigger`, `settled`, `setOptions`, `remove`, `context.trigger`, `ui.trigger`), over a fake device; the test calls `render(frame)` itself, so the timing of an action is exact. Every plugin with actions tests them this way: the states, superseding, removal, reduced motion, bad options.
- `fakeGpu()` (`_shared/fake-gpu.mjs`): a recording fake device for single-pass plugins.

**Browser** (`plugins/<name>/test/*.browser.test.mjs`, headless Chrome, `npm run test:unit:browser`), from `/plugins/_shared/gpu-check.mjs`, through the real host on a real WebGPU canvas:
- `checkMapperAgainstGpu(t, plugin, options)`: presents one frame over a grid of white markers and counts the pixels where the mapper's prediction disagrees with the GPU. It passes only when the mapper is right (at most 5 pixels) AND the identity mapper is wrong (at least 200), so the check could have failed.
- `runActionOnGpu(t, plugin, options, action, actionOptions)`: triggers an action through the handle and presents frames on the frame clock until it resolves; returns the state, the largest change against the first frame and the worst agreement of a frame's mapper with its pixels during the action (input must follow the pixels while an action plays too).
- `presentOnce`, `agreement`, `markerScene`, `spyMappers`, `lossSpy`, `until`, and `gpuTest` (skipped, never passed, where Chrome has no WebGPU adapter).

**Gallery end to end** (`plugins/<name>/test/gallery.e2e.mjs`, `npm run test:plugins`): the plugin in `examples/plugins/` with trusted input. `_shared/gallery-e2e.mjs` opens the gallery, takes shots, drags, records; `actionChecks(page, check, steps, supersede)` clicks the gallery's button of each action and checks the state, that the frame changed and that the host goes idle, then from page script an unknown action, superseding and `settled()`.

How the plugin of section 16 is verified: `npm run test:examples` serves `test/examples-smoke/wobble-plugin/index.html` (a red bar 14 css px wide at x = 300 in the source) in headless Chrome and checks: the host and plugin start; the presented frame is not blank and the live layer has computed opacity 0; amplitude 24 differs from amplitude 0 in more than 400 pixels; and the mapper against the pixels. For the last check the frame is frozen (`framecap=1`), a compositor screenshot is taken, the left edge of the bar is found on 38 rows, and `mapper(edge)` must give x = 300 within 2 px. The control is the identity mapper (what a plugin without a mapper amounts to), which must be wrong by 8 px or more on the same pixels.

Result of one run on one machine (headless Chrome 154.0.8037.98, macOS, DPR 1, amplitude 24): bar edge moved over a range of 48 px, the plugin's mapper was off by at most 1.18 px, the identity mapper by 24.5 px (`.scratch/results/examples-<timestamp>.json`, `numbers.mapper`). This shows the mapper contract works for this plugin; it is not a statement about every plugin or GPU.

The smoke test also runs its action: `handle.trigger('pulse')` resolves `'calm'` after the pulse, `settled()` then resolves `'calm'`, and an unknown action rejects with a `TypeError` that lists `'pulse'`.

### 18. Checklist

- `spatial: true` has a `captureInputMapper`, and it is pure and frozen per frame.
- Where the presented pixel shows no element of the source, the mapper returns `NO_TARGET`.
- The mapper formula is the shader formula (test it against pixels with `checkMapperAgainstGpu`, also during your actions with `runActionOnGpu`).
- Declared `actions` have `runAction` and `settled`; both resolve after the frame that shows the end state; your own triggers go through `context.trigger` / `ui.trigger`; `destroy` resolves your waiters with `null`.
- `meta.reducedMotion` says what the plugin does under `prefers-reduced-motion: reduce`, and the actions honour `info.reducedMotion`.
- You did not call `getContext` on the canvas.
- A 2D fallback exists for browsers without WebGPU, and for a browser whose own native implementation is in use (the extensions are not available there, see the top of this guide).
- You measured the cost on your own page: `docs/guides/PERFORMANCE.md` says which numbers exist and which do not.
