# plugins (the effect gallery)

One live HTML form inside `<canvas content="drawable">`, and a list of the effect plugins of this repository: pick one and it is applied to the form, with its own controls (rendered as HTML inside the form by the plugin's `mountUI`), a frame cap slider (`canvas.frameCap`, 15 to 120 fps) and an "Effect off" choice. The form stays live under every effect: click a field and type. A panel under the list describes the selected plugin from its manifest entry: title, version, description, what it does when the user prefers reduced motion (`meta.reducedMotion`), the options the page passes (`meta.defaults`) and a link to its source; the line under the canvas shows whether `prefers-reduced-motion: reduce` is in effect.

Run: `npm run build && npm run demo`, then open `http://127.0.0.1:8765/examples/plugins/` in desktop Chrome with WebGPU. `?effect=<name>` selects an effect on load (`?effect=off` none).

How it works:
- The list comes from `dist/plugins/manifest.json`, which the build writes from every `plugins/<name>/` folder ([plugins/README.md](../../plugins/README.md)). A new plugin appears here without any change to this page.
- The page loads the core and the effects bundle; a plugin bundle (`dist/plugins/<name>.iife.min.js`) is loaded when it is first selected. Switching removes the previous plugin from the host (which also removes its controls) and adds the new one with the `defaults` of its manifest entry.
- Without WebGPU (or when `createHost` rejects) the page says so above the canvas, disables the effects and draws the same form through the plain 2D `drawElementImage` path, decided BEFORE any `getContext` call.

The effects host, the plugins and the frame cap are extensions of this library, not part of the HTML-in-Canvas proposal; browsers' native implementations do not provide them ([docs/guides/EFFECTS-PLUGINS.md](../../docs/guides/EFFECTS-PLUGINS.md#extensions-not-the-standard)).

Checked by `npm run test:examples` in headless Chrome: no console or page error, the canvas is not blank, every plugin of the manifest is listed, selecting it mounts its controls, changes the presented pixels and fills the panel (title, version, reduced-motion behaviour), "Effect off" removes them, typing reaches the live field, and the slider changes `canvas.frameCap`. A second run hides `navigator.gpu` and checks the message, the disabled effects and typing on the 2D path. The end-to-end test of each plugin (`npm run test:plugins`, also run by `npm run test:examples`) drives this page with trusted input: clicks through the effect, its triggers, the frame cap and reduced motion.
