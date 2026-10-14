# Effect plugins

An effect plugin is a small WebGPU pass that runs over the HTML a canvas draws: the effects host of this library uploads the drawn picture into a texture, runs the plugins in order, presents the result on the canvas, and maps pointer input back through the plugins so that clicks reach the element the user sees.

**The plugins are not part of the polyfill.** Each folder here is an example of the effects extension, built into its own optional bundle; nothing in `src/` imports them. The effects host and the frame cap are themselves extensions of this library: they are not part of the HTML-in-Canvas proposal, and browsers' native implementations do not provide them ([what that means in practice](../docs/guides/EFFECTS-PLUGINS.md#extensions-not-the-standard)).

The plugin interface (ABI v2), step by step: [docs/guides/EFFECTS-PLUGINS.md](../docs/guides/EFFECTS-PLUGINS.md). Try them: the plugin gallery, [examples/plugins/](../examples/plugins/).

## Plugins

| plugin | what it does | input mapper (where a click lands) | |
|---|---|---|---|
| [`crt`](crt/) | A curved CRT screen with scanlines, phosphor glow, flicker and a rolling bar. | the inverse of the barrel curvature; on the bezel and in the rounded corners `NO_TARGET` | [README](crt/README.md), [preview](crt/media/crt.webp) |
| [`disintegrate`](disintegrate/) | The form turns to dust made of its own pixels and reassembles, on a valid submit or the Snap button. | the identity at rest; `NO_TARGET` while the transition plays | [README](disintegrate/README.md), [preview](disintegrate/media/disintegrate.webp) |
| [`glitch`](glitch/) | RGB split, block shifts, scanline tears and pixel sorting; bursts on a validation error. | follows the shifted blocks (also during a burst); the identity outside them and with reduced motion | [README](glitch/README.md), [preview](glitch/media/glitch.webp) |
| [`holo-card`](holo-card/) | The form becomes a holographic card that tilts towards the pointer. | the inverse of the 3D perspective of the tilted card; beside the card `NO_TARGET` | [README](holo-card/README.md), [preview](holo-card/media/holo-card.webp) |
| [`liquid-glass`](liquid-glass/) | A refractive glass lens follows the pointer or stays pinned. | through the lens, the point it magnifies or bends; the identity outside it | [README](liquid-glass/README.md), [preview](liquid-glass/media/liquid-glass.webp) |
| [`page-curl`](page-curl/) | Drag a corner to peel the page like a book page; it springs back on release. | the identity on the flat page, the exact point on the visible front of the curl; on the back and on the page underneath `NO_TARGET`. The corner drag is the plugin's own gesture and never reaches the form | [README](page-curl/README.md), [preview](page-curl/media/page-curl.webp) |
| [`shatter`](shatter/) | The form cracks where you click, falls apart in glass shards and flies back, on an invalid submit or the Shatter button. | the identity at rest; `NO_TARGET` from the first crack until the form is back | [README](shatter/README.md), [preview](shatter/media/shatter.webp) |
| [`water`](water/) | Ripples that follow the pointer. | the inverse of the ripple displacement; clicks and typing reach the field the user sees | [README](water/README.md), [preview](water/media/water.webp) |

The previews are recorded from the gallery in headless Chrome (each plugin's `test/gallery.e2e.mjs --record`). Each plugin's `meta.reducedMotion` says what it does when the user prefers reduced motion; the gallery shows it.

Not built: [`_template`](_template/) (start a new plugin from a copy of it), [`_lib`](_lib/) (runtime code that more than one plugin uses, bundled into each: the transition timeline of disintegrate and shatter) and [`_shared`](_shared/) (test tooling).

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
| `meta` | frozen `{name, title, description, defaults?, reducedMotion?}`: `name` equals the folder name, `title` at most 40 characters, `description` one line of at most 160, `defaults` the options the gallery passes to `addPlugin`, `reducedMotion` one line of at most 160 on what the plugin does under `prefers-reduced-motion: reduce` |
| `plugin` | the frozen ABI v2 definition, `type` equal to `meta.name`; `definePlugin` of the effects host must accept it |
| imports | only files of the plugin's own folder, of [`_lib/`](_lib/), and `src/effects/no-target.js` (the `NO_TARGET` value of the effects ABI, a module without dependencies); type-only JSDoc imports of `src/contracts/types.js` are fine; no `blob:` URLs. The build bundles all of it into the plugin |
| shaders | `.wgsl` files in the folder, loaded with `await wgsl('<file>.wgsl')` from `./wgsl.js` (a copy of the template's); the build inlines them, so a built plugin makes no request |
| `README.md` | what the plugin does, its options, its files |
| `test/` | at least one `*.test.mjs` (Node) and, for a plugin that moves pixels, a `*.browser.test.mjs` that checks the input mapper against the GPU pixels; optionally a `gallery.e2e.mjs` that drives the plugin in the gallery with trusted input |
| this file | one row in the table above (`npm run lint` checks it) |

What the build makes of `plugins/<name>/`:

| output | |
|---|---|
| `dist/plugins/<name>.iife.js`, `.iife.min.js` | classic scripts that register `window.HicLivePlugins.<name>` (all exports of `index.js`, frozen) |
| `dist/plugins/<name>.esm.js` | the module, for bundlers: package subpath `./plugins/<name>` (types: `dist/types/plugins/<name>/index.d.ts`) |
| `dist/plugins/manifest.json` | `name`, `title`, `description`, `reducedMotion`, `version`, `defaults` and file names of every plugin; the gallery reads it |

`npm run check:bundle` loads every plugin bundle after the core and the effects bundle in headless Chrome (it registers, the host accepts it, it compiles its shaders from inlined strings, no request) and holds each minified bundle under its ceiling: the measured size plus a small margin (`PLUGIN_LIMITS` in `scripts/check-bundle.mjs`), 16 KB for a new plugin.

## Tests

- Node tests (`plugins/*/test/*.test.mjs`) run with `npm run test:unit`. Start with the contract test of the template: `checkPluginFolder` returns no problem.
- Browser tests (`plugins/*/test/*.browser.test.mjs`) run in headless Chrome with the unit tests (`npm run test:unit:browser`; one file: `node test/unit/run.mjs plugins/<name>/test/<file>`). They import the kit `/plugins/_shared/gpu-check.mjs`:
  - `checkMapperAgainstGpu(t, plugin, options)` presents one frame of the plugin through the real effects host over a grid of white markers and counts the pixels where the mapper's prediction disagrees with the GPU. It passes only when the mapper is right (at most 5 pixels) AND the identity mapper is wrong (at least 200), so the check could have failed.
  - `minBrightShare` (default 0.8): the share of the painted marker area that must be bright. An effect that draws the whole source smaller passes its own (`crt` 0.7, `holo-card` 0.6).
  - `presentOnce`, `agreement`, `markerScene`, `spyMappers` (records every mapper; the instance is wrapped, not copied, so a `continuous` getter stays live) and `gpuTest` (skips, never passes, where Chrome has no WebGPU adapter) for plugin-specific checks; `water/test/water-gpu.browser.test.mjs` uses them.
  - `_shared/gpu-time.mjs`: the GPU time of one pass outside the host (`measureGpuTime`: back-to-back throughput against a clear-only pass; `measurePassGpuTime`: pass timestamps where available).
- Gallery end-to-end tests (`plugins/*/test/*.e2e.mjs`) open `examples/plugins/?effect=<name>` in their own headless Chrome and drive it with trusted input (clicks through the effect, typing, the frame cap, reduced motion). `npm run test:plugins` runs all of them, one after the other, against the built bundles (`npm run build` first); `npm run test:examples` runs them too. One plugin: `node plugins/<name>/test/gallery.e2e.mjs` (`--record` rewrites its `media/<name>.webp` with ffmpeg). Shared steps: `_shared/gallery-e2e.mjs` (open the gallery, shots, drags, recording), `_shared/gallery-click.mjs` (click where the plugin's mapper says a control is drawn away from its DOM position, with a control click at the DOM position) and `_shared/transition-e2e.mjs` (the transition plugins).

## Working on several plugins at once

Each plugin lives only in its own folder plus one row in the table above (and, for code that several plugins share, `_lib/`), so authors working in parallel do not touch the same files. Nothing else needs editing: the build, the package exports (`./plugins/*`), the manifest, the bundle check and the gallery pick a new folder up by convention.
