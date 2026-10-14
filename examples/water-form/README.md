# water-form

A live HTML contact form inside `<canvas content="drawable">`, presented through the optional WebGPU effects host with the water-ripple example plugin, plus a frame cap slider (`canvas.frameCap`, 15 to 120 fps). A cleaned, self-contained port of the repository fixture `test/fixtures/f1-water-form`.

Run: `npm run build && npm run demo`, then open `http://127.0.0.1:8765/examples/water-form/` in desktop Chrome with WebGPU.

What to look at:
- Move the pointer over the form: ripples bend the pixels. Click a field and type: the field is the real, live `<input>`, and the pointer is re-mapped through the displacement (the "interposer"; it re-implements focus, click, range drag and caret placement, not select popups or drag selection).
- The frame cap slider sets `canvas.frameCap`. The meter under the canvas counts `effectframe` events per second on the page. That counter is the page counting the polyfill's own event; the independent measurement is gate G-f1-form-effect (cap 30 / 60 / 120 measured as 30.0 / 60.0 / 120.1 Hz on one 120 Hz display, from an independent clock).
- Without WebGPU (or if `createHost` rejects) the page falls back to the plain 2D `drawElementImage` path and says so in the line under the canvas. The fallback is decided BEFORE any `getContext` call, because a canvas keeps its first context type.

Scripts, in this order: `dist/hic-live-polyfill.iife.min.js` (core), `dist/hic-live-effects.iife.min.js` (host, plugin ABI), `dist/plugins/water.iife.min.js` (the example plugin of [plugins/water](../../plugins/water/), WGSL inlined). Nothing is fetched from the network.

Checked by `npm run test:examples` in headless Chrome: no console or page error, the canvas is not blank, a trusted click and typing change the live field and the pixels, and changing the slider changes `canvas.frameCap`. Whether the WebGPU path runs headless depends on the machine; the check prints which path it exercised, and a second run hides `navigator.gpu` to check the 2D fallback.
