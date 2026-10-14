# Effect plugins

An effect plugin is a small WebGPU pass that runs over the HTML a canvas draws: the effects host of this library uploads the drawn picture into a texture, runs the plugins in order, presents the result on the canvas, and maps pointer input back through the plugins so that clicks reach the element the user sees.

**The plugins are not part of the polyfill.** Each folder here is an example of the effects extension, built into its own optional bundle; nothing in `src/` imports them. The effects host and the frame cap are themselves extensions of this library: they are not part of the HTML-in-Canvas proposal, and browsers' native implementations do not provide them ([what that means in practice](../docs/guides/EFFECTS-PLUGINS.md#extensions-not-the-standard)).

The plugin interface (ABI v2), step by step: [docs/guides/EFFECTS-PLUGINS.md](../docs/guides/EFFECTS-PLUGINS.md). Try them: the plugin gallery, [examples/plugins/](../examples/plugins/).

## Plugins

| plugin | |
|---|---|
| [`water`](water/) | Ripples that follow the pointer; clicks and typing are remapped through the displacement. |

Not built: [`_template`](_template/) (start a new plugin from a copy of it) and [`_shared`](_shared/) (test tooling).

## Using a built plugin

```html
<script src="dist/hic-live-polyfill.iife.min.js"></script>     <!-- the core -->
<script src="dist/hic-live-effects.iife.min.js"></script>      <!-- the effects host: window.HTMLInCanvasEffects -->
<script src="dist/plugins/water.iife.min.js"></script>          <!-- registers window.HicLivePlugins.water = {meta, plugin, ...} -->
<script>
  const host = await HTMLInCanvasEffects.createHost(canvas, form, { interposer: true });
  const handle = await host.addPlugin(HicLivePlugins.water.plugin, HicLivePlugins.water.meta.defaults);
</script>
```

ES modules: `import { plugin } from '@giuseppe-scotto-lavina/html-in-canvas-polyfill/plugins/water'`. A plugin bundle has no dependency and can load in any order; `host.addPlugin` validates the definition.

## The contract of a plugin folder

`npm run build` finds plugins by convention: every folder `plugins/<name>/` that has an `index.js` and whose name does not start with `_` or `.`. There is no list to edit. Before building a folder it checks this contract (`_shared/contract.mjs`), and `npm run lint` checks it for every folder, the template included:

| what | rule |
|---|---|
| folder name | `<name>` matches `^[a-z][a-z0-9-]{0,39}$`; it becomes the file name, the exports subpath and the registry key |
| `index.js` | an ES module that exports `meta` and `plugin`, and may export more (helpers for tests, constants) |
| `meta` | frozen `{name, title, description, defaults?}`: `name` equals the folder name, `title` at most 40 characters, `description` one line of at most 160, `defaults` the options the gallery passes to `addPlugin` |
| `plugin` | the frozen ABI v2 definition, `type` equal to `meta.name`; `definePlugin` of the effects host must accept it |
| imports | only files of the plugin's own folder (type-only JSDoc imports of `src/contracts/types.js` are fine); no `blob:` URLs |
| shaders | `.wgsl` files in the folder, loaded with `await wgsl('<file>.wgsl')` from `./wgsl.js` (a copy of the template's); the build inlines them, so a built plugin makes no request |
| `README.md` | what the plugin does, its options, its files |
| `test/` | at least one `*.test.mjs` (Node) and, for a plugin that moves pixels, a `*.browser.test.mjs` that checks the input mapper against the GPU pixels |
| this file | one row in the table above (`npm run lint` checks it) |

What the build makes of `plugins/<name>/`:

| output | |
|---|---|
| `dist/plugins/<name>.iife.js`, `.iife.min.js` | classic scripts that register `window.HicLivePlugins.<name>` (all exports of `index.js`, frozen) |
| `dist/plugins/<name>.esm.js` | the module, for bundlers: package subpath `./plugins/<name>` (types: `dist/types/plugins/<name>/index.d.ts`) |
| `dist/plugins/manifest.json` | `name`, `title`, `description`, `version`, `defaults` and file names of every plugin; the gallery reads it |

`npm run check:bundle` loads every plugin bundle after the core and the effects bundle in headless Chrome (it registers, the host accepts it, it compiles its shaders from inlined strings, no request) and holds each minified bundle under 16 KB unless the script sets a tighter ceiling for it.

## Tests

- Node tests (`plugins/*/test/*.test.mjs`) run with `npm run test:unit`. Start with the contract test of the template: `checkPluginFolder` returns no problem.
- Browser tests (`plugins/*/test/*.browser.test.mjs`) run in headless Chrome with the unit tests (`npm run test:unit:browser`; one file: `node test/unit/run.mjs plugins/<name>/test/<file>`). They import the kit `/plugins/_shared/gpu-check.mjs`:
  - `checkMapperAgainstGpu(t, plugin, options)` presents one frame of the plugin through the real effects host over a grid of white markers and counts the pixels where the mapper's prediction disagrees with the GPU. It passes only when the mapper is right (at most 5 pixels) AND the identity mapper is wrong (at least 200), so the check could have failed.
  - `presentOnce`, `agreement`, `markerScene`, `spyMappers` and `gpuTest` (skips, never passes, where Chrome has no WebGPU adapter) for plugin-specific checks; `water/test/water-gpu.browser.test.mjs` uses them.

## Working on several plugins at once

Each plugin lives only in its own folder plus one row in the table above, so authors working in parallel do not touch the same files. Nothing else needs editing: the build, the package exports (`./plugins/*`), the manifest, the bundle check and the gallery pick a new folder up by convention.
