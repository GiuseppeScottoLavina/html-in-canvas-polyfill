# effect-plugin

The smallest page that uses the effects extension of this library: a live HTML form inside `<canvas content="drawable">`, presented through two example plugins, with a frame cap slider. About 30 lines of script, commented step by step:

1. Load the polyfill, the effects host (`hic-live-effects.iife.min.js`) and the plugin bundles (`dist/plugins/water.iife.min.js`, `dist/plugins/disintegrate.iife.min.js`; each registers `window.HicLivePlugins.<name>`).
2. `HTMLInCanvasEffects.createHost(canvas, form)`: the host owns the canvas and presents the drawn form through the plugin chain. When it cannot start (no WebGPU, or a browser whose own implementation is used), the page draws the form with the standard 2D `drawElementImage` instead. That choice is made before any `getContext` call, because a canvas keeps its first context type.
3. `canvas.frameCap`: at most this many effect frames per second (15 to 120 here).
4. `host.addPlugin(HicLivePlugins.water.plugin, { intensity: 0.3 })`: ripples that follow the pointer; clicks and typing reach the field the user sees.
5. `host.addPlugin(HicLivePlugins.disintegrate.plugin, { onSubmit: 'off' })` and, in the page's own submit handler, `await dust.trigger('out')` then `await dust.trigger('in')`: the form turns to dust, the page writes its answer, and the form re-forms showing it. Each `trigger` resolves with the state the plugin rests in (`'out'`, `'in'`), or `null` when a newer action superseded it.

Run: `npm run build && npm run demo`, then open `http://127.0.0.1:8765/examples/effect-plugin/` in a desktop browser with WebGPU.

The effect plugins and the frame cap are extensions of this library, not part of the HTML-in-Canvas proposal; native implementations do not provide them. Reference for both: [docs/guides/EFFECTS-PLUGINS.md](../../docs/guides/EFFECTS-PLUGINS.md). All plugins over one form, with their controls and actions: the [plugin gallery](../plugins/).

Checked by `npm run test:examples` in headless Chrome: no console or page error, the canvas is not blank, a trusted click and typing reach the live field, the frame cap slider sets `canvas.frameCap` and bounds the effect frames, a trusted click on Send turns the form to dust and re-forms it with the answer, and two more runs (no `navigator.gpu`, no WebGPU adapter) take the 2D path.
