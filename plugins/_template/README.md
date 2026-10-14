# Plugin template

The smallest complete **spatial** effect plugin: it shifts the picture sideways by `offset` CSS pixels and supplies the input mapper that keeps clicks on the element the user sees. Start a new plugin from a copy of this folder. Folders whose name starts with `_` are not built, so this one never ships as a bundle.

## Make your own

1. Copy the folder: `cp -r plugins/_template plugins/<name>` (`<name>`: lowercase letters, digits and `-`; it becomes `dist/plugins/<name>.iife.js`, the exports subpath `./plugins/<name>` and `window.HicLivePlugins.<name>`).
2. In `index.js`, set `meta.name` and `plugin.type` to `<name>`, and write `meta.title` and a one-line `meta.description` (the plugin gallery shows both).
3. Replace `offset.wgsl` and `mapOffsetPoint` together: the mapper is the JavaScript twin of the shader's sampling formula. A plugin that does not move pixels drops `spatial` and `captureInputMapper`.
4. Rename the tests and adapt them. Keep the GPU test: `checkMapperAgainstGpu` (`plugins/_shared/gpu-check.mjs`) compares the mapper with the pixels the GPU presented, and fails when the identity mapper would pass too.
5. `npm run build` discovers the folder, checks it against the contract and writes the bundles and the manifest entry; `npm test` runs its tests; the gallery (`examples/plugins/`) lists it.

## Files

| file | |
|---|---|
| `index.js` | `meta`, `plugin` and the mapper formula `mapOffsetPoint` |
| `offset.wgsl` | the shader |
| `wgsl.js` | loads the `.wgsl` files of the folder when the plugin runs from source; the build replaces it with inlined strings. Copy it unchanged. |
| `test/template.test.mjs` | Node: the folder contract, the mapper formula, the per-frame freeze of the mapper |
| `test/template-gpu.browser.test.mjs` | headless Chrome: the mapper against the GPU pixels |

Options: `offset`, 0 to 200 CSS px, default 24. `mountUI` adds a slider for it.
