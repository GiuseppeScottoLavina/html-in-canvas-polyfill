# Getting started

Goal: the explainer demo, a form and the water demo running in five minutes, and a clear picture of what you are running.

Status: `0.1.0-preview.11`, a preview published under the npm dist-tag `next`, for desktop Chrome, Firefox 155+ and Safari 27+, and Chrome for Android 130+ and Safari on iOS / iPadOS 26+ (verified on simulators and emulators only). Read [README.md](../../README.md) for what the polyfill does and does not do.

## 1. Run the examples (about 3 minutes)

Needs Node >= 22 (`engines`) and a supported desktop browser (README, "Browser support"). To use the package without the examples: `npm install @giuseppe-scotto-lavina/html-in-canvas-polyfill@next`.

```sh
git clone https://github.com/GiuseppeScottoLavina/html-in-canvas-polyfill.git && cd html-in-canvas-polyfill
npm ci                          # build tooling only (esbuild, typescript); the polyfill has no runtime dependencies
npm run build                   # writes dist/ (classic IIFE bundles and dist/esm/)
npm run demo                    # http://127.0.0.1:8765/examples/
```

Open `http://127.0.0.1:8765/examples/` in a supported browser and try, in this order: `basic` (the WICG explainer example), `form`, `plugins` (the effect gallery) and `effect-plugin` (the smallest page with effects; both need WebGPU for the effects and say which path they took), `scroll-and-resize`, `webgl-texture`. Each example folder has a README. `npm run test:examples` runs all of them in headless Chrome as a smoke test.

`npm run demo` serves only `/examples` and `/dist` (everything else is 403). To try your own page, put it in a new folder such as `examples/mine/index.html` and load `../../dist/hic-live-polyfill.iife.min.js`, or open the file directly from disk (`file://` works; the built files make no network request). The snippets in this guide say `dist/...`, which is right only for a page next to `dist/`.

If an example says the polyfill is missing, `dist/` was not built. If the `form` or `scroll-and-resize` example shows `hic-live-polyfill not installed: ...`, the browser is not supported (section 5).

## 2. Your first canvas with a script tag

```html
<!doctype html>
<script src="dist/hic-live-polyfill.iife.min.js"></script>   <!-- FIRST: it installs while this tag runs -->

<canvas id="c" style="width: 400px; height: 200px" content="drawable">
  <form id="f" drawable>
    <label>name <input id="name"></label>
  </form>
</canvas>

<script>
  const canvas = document.getElementById('c');
  const form = document.getElementById('f');
  const ctx = canvas.getContext('2d');

  canvas.onpaint = () => {              // fires when every drawable has a snapshot
    ctx.reset();
    ctx.drawElementImage(form, 0, 0);   // draw the form's current snapshot
  };

  new ResizeObserver((entries) => {     // keep the bitmap at device-pixel size (writing width/height clears it; the polyfill repaints in the same frame)
    const box = entries[0].devicePixelContentBoxSize[0];
    canvas.width = box.inlineSize;
    canvas.height = box.blockSize;
  }).observe(canvas, { box: 'device-pixel-content-box' });
</script>
```

Rules that matter (API-CONTRACT sections 3 and 4):
- The canvas needs `content="drawable"` and each element you draw needs the `drawable` attribute. The old `layoutsubtree` attribute still works but is the pre-2026-09 name: it prints one `console.warn` per install, whether it is in the markup when the polyfill installs or set later from script.
- Draw from the `paint` event (or after `await installed.whenPainted(canvas)`, where `installed` is what `install()` returned, or `window.__HIC__.installed` for the classic script). A `drawElementImage` call before the first snapshot exists throws `InvalidStateError`, exactly as native does.
- The children of the canvas are real, live, focusable DOM. The polyfill moves them into a `<hic-layer>` element next to the canvas, at `opacity:0`. Do not hide, remove or restyle that element. See "children are relocated" in the README.
- Nothing is drawn unless you draw it: the polyfill only provides the snapshots and the standard API.

Uninstall and reinstall (rarely needed): `HicLivePolyfill.getInstalled().uninstall()` (or the `uninstall()` of what `install()` returned) hands the canvas children back and restores every patched method; a following `HicLivePolyfill.install()` manages the canvases again and gives each one its first `paint` by itself, like a first install (checked by `test/unit/api-core/reinstall.browser.test.mjs`; you do not need to call `requestPaint()`). What does NOT survive: handlers set through the `onpaint` property (and `onelementgeometryupdate`) before the uninstall are forgotten, so assign them again right after `install()`. Listeners added with `addEventListener('paint', ...)` stay on the canvas and fire for the new install. `window.__HIC__.installed` always points to the live install; a handle you kept from before the uninstall is dead.

Load order: the core script must run before any script that reads the API (`docs/BUNDLES.md`). To delay installation, add `data-hic-manual` to the script tag and call `HicLivePolyfill.install(options)` yourself (it is synchronous and returns the same install on a second call).

## 3. ES modules and bundlers

```js
import { install } from '@giuseppe-scotto-lavina/html-in-canvas-polyfill';   // or dist/esm/index.js by path

const hic = install();                            // synchronous; call it before app code reads the API
console.log(hic.mode);                            // 'polyfill' | 'native' | 'native-bridged' ('refused' with onUnsupportedBrowser: 'warn')
```

`install()` throws a `HicUnsupportedError` (`feature: 'browser'`, or `'partial-native'` for a native implementation without its core) in a browser the polyfill refuses; it never throws where the browser's own API is usable. Catch it, or pass `{ onUnsupportedBrowser: 'warn' }` to log once and install nothing. The classic script never throws on refusal: it logs one `console.warn` and sets `window.__HIC__ = { error }`.

Optional parts: `import { installEffects } from '@giuseppe-scotto-lavina/html-in-canvas-polyfill/effects'` (defines `window.HTMLInCanvasEffects`, needs the installed core), `import { plugin } from '@giuseppe-scotto-lavina/html-in-canvas-polyfill/plugins/water'` (an example plugin, `plugins/README.md`), `import '@giuseppe-scotto-lavina/html-in-canvas-polyfill/native-bridge'` (before `install()`, only for Chrome 154-155 behind a flag). `docs/BUNDLES.md` has the table of files, sizes and load order. The ESM quick start above is exercised by `npm run test:examples` (`test/examples-smoke/esm-quickstart/`), importing `dist/esm/index.js` by path.

## 4. Adding the effects

The effects and the frame cap are extensions of this library, not part of the HTML-in-Canvas proposal; native implementations do not provide them. They run over the polyfill and over a native implementation the installed polyfill steps aside for ([EFFECTS-PLUGINS.md](EFFECTS-PLUGINS.md#extensions-not-the-standard)).

Two more classic scripts, after the core: the effects host and a plugin (the water example of [`plugins/`](../../plugins/)):

```html
<script src="dist/hic-live-effects.iife.min.js"></script>     <!-- window.HTMLInCanvasEffects -->
<script src="dist/plugins/water.iife.min.js"></script>         <!-- window.HicLivePlugins.water = {meta, plugin, ...} -->
```

```js
// do NOT call canvas.getContext() first: the host owns the canvas bitmap and its 'webgpu' context
const host = await HTMLInCanvasEffects.createHost(canvas, form, { interposer: true });
const water = await host.addPlugin(HicLivePlugins.water.plugin, { intensity: 0.28 });
await water.trigger('drop', { point: { x: 120, y: 80 } });   // an action of the plugin: resolves 'calm' once the ripple has died out
```

The source element (`form` here) must have exactly the size of the canvas content box (for example `width` and `height` in CSS on both, `box-sizing: border-box`). The host stretches the source over the whole canvas and maps pointer input back through that stretch, so a smaller or larger source is drawn distorted and clicks land beside what the user sees; `createHost` prints one `console.warn` with both sizes when they differ by more than 1 CSS pixel. The complete page is in [EFFECTS-PLUGINS.md](EFFECTS-PLUGINS.md) section 9.

`createHost` rejects with `HicUnsupportedError('effect-plugins')` when there is no WebGPU; keep a 2D `drawElementImage` fallback and decide before any `getContext` call (`examples/effect-plugin/index.html` does, in about 30 lines that also set the frame cap and run a transition with `handle.trigger`). All the plugins over one form, with their actions: `examples/plugins/`. Writing your own plugin: [EFFECTS-PLUGINS.md](EFFECTS-PLUGINS.md) and [`plugins/_template/`](../../plugins/_template/).

## 5. What happens in other browsers

| browser | what the polyfill does | source |
|---|---|---|
| desktop Chrome without the native feature (154 and 155 measured; 156 in CI, headless on Linux and Windows and headed on macOS) | runs (mode `polyfill`) | SUPPORT-MATRIX browsers |
| Chrome with a native implementation (Canary 157.0.8103.0 measured 2026-10-14 and 158.0.8112.1 on 2026-10-22, with or without `--enable-blink-features=CanvasDrawElement`) | steps aside (mode `native`), never throws; the extensions (frame cap, effects) run over the native implementation (Canary 158.0.8112.1 measured with the flag) | API-CONTRACT section 2, EFFECTS-PLUGINS |
| Chrome 154-155 behind `--enable-blink-features=CanvasDrawElement` (the earlier `layoutsubtree` draft) | used as found with one console warning; load `dist/hic-live-native-bridge.iife.min.js` BEFORE the core to bridge `content="drawable"` (mode `native-bridged`) | BUNDLES |
| Firefox >= 155, Safari >= 27 (desktop) | polyfill runs, with documented form-control and text limits (`engine-gecko`, `engine-webkit`); classic pages also load `hic-live-engines.iife.min.js` (the Gecko / WebKit painters, docs/BUNDLES.md) | SUPPORT-MATRIX |
| Chrome for Android >= 130, Safari on iOS / iPadOS >= 26 (and the other iOS browsers, which are WebKit) | polyfill runs with phone budgets and the iOS control look; iOS pages also load `hic-live-engines.iife.min.js`. Verified on iOS Simulator / Android Emulator only | MOBILE |
| older Firefox/Safari, Android WebView, in-app iOS web views, Firefox for Android | refused loudly: one `console.warn`, `window.__HIC__.error` | SUPPORT-MATRIX |

Measured on macOS: Chrome 154 and 155, Chrome Canary 157 and 158 (native), Firefox 155.0.1 and Safari 27.0.1. On Linux and Windows only headless Chrome runs, in CI (unit tests, bundle check and the platform probe); CI on GitHub-hosted macOS runners also runs Chrome 156 headed (10 of the 15 browser gates) and Firefox 155. Other Chromium browsers are expected to work and are unverified.

## 6. When something looks wrong

1. Open the console: every refusal prints once as `[hic-live-polyfill] unsupported <feature> ...` with a hint.
2. In the console: `__HIC__.installed.report()` returns a JSON report (mode, per canvas state, unsupported entries with counts, deviations exercised, internal errors). Attach it to bug reports. `count` of an `unsupported` entry is the number of times the reporter was told about it (typically once per snapshot attempt that meets that content), not the number of elements: one `<iframe>` can show `count: 3`. `HicLivePolyfill.getInstalled()` returns the same instance as `__HIC__.installed`.
3. [TROUBLESHOOTING.md](TROUBLESHOOTING.md) lists every error and report entry with cause and remedy.
