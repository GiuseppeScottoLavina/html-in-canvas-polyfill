# Examples

Six self-contained pages, no network resources, each with its own `index.html` and a short README. They load the built files from `../../dist/`.

```sh
npm install        # once (build tooling only; the polyfill has no runtime dependencies)
npm run build      # writes dist/
npm run demo       # serves /examples and /dist on http://127.0.0.1:8765 (zero-dependency server, examples/serve.mjs)
```

Open `http://127.0.0.1:8765/examples/` in desktop Chrome, Firefox 155+ or Safari 27+.

The server answers only under `/examples` and `/dist` (403 elsewhere). To try your own page, put it in a folder next to these (`examples/mine/index.html`, scripts from `../../dist/`) or open it from disk with `file://`.

| example | shows | needs |
|---|---|---|
| [basic](basic/) | the WICG explainer "Basic Example", unchanged | core |
| [form](form/) | a contact form (inputs, textarea, checkbox, validation) drawn from `onpaint` | core |
| [plugins](plugins/) | the effect gallery: pick a plugin of `plugins/` and apply it to one live form, its controls, FPS cap slider, "effect off", 2D fallback | core, effects, the plugin bundles, WebGPU for the effects |
| [water-form](water-form/) | the form under the WebGPU water plugin, FPS cap slider (`canvas.frameCap`), 2D fallback | core, effects, `plugins/water`, WebGPU for the effect |
| [scroll-and-resize](scroll-and-resize/) | a scrolling list (sticky header, hover) and a responsive layout in one canvas | core |
| [webgl-texture](webgl-texture/) | a spinning cube textured with a live form via `gl.texElementSubImage2D` | core, WebGL2 |

`npm run test:examples` opens each page in headless Chrome and asserts: no console error or page error, the canvas is not blank, and the key interaction works (typing, the frame cap slider, choosing and removing effects in the gallery, wheel scrolling plus a viewport resize, typing into the texture source). It also runs a control with a broken `dist/` path that must fail every example. It also runs two smoke pages that exercise the code printed in the guides (`test/examples-smoke/`: the ESM quick start, the HTML blocks of the README and of GETTING-STARTED extracted from the Markdown, and the complete plugin of `docs/guides/EFFECTS-PLUGINS.md`, whose input mapper is compared with GPU pixels). Results are written to `.scratch/results/` (git-ignored).
