# Effect plugins

An effect plugin is a small WebGPU pass that runs over the HTML a canvas draws: the effects host of this library uploads the drawn picture into a texture, runs the plugins in order, presents the result on the canvas, and maps pointer input back through the plugins so that clicks reach the element the user sees.

**The plugins are not part of the polyfill.** Each folder here is an example of the effects extension, built into its own optional bundle; nothing in `src/` imports them. The effects host and the frame cap are themselves extensions of this library: they are not part of the HTML-in-Canvas proposal, and browsers' native implementations do not provide them; the host runs them over the polyfill and over a native implementation alike ([what that means in practice](../docs/guides/EFFECTS-PLUGINS.md#extensions-not-the-standard)). The plugins, the effects host and the frame cap are **experimental** ([STABILITY.md](../docs/STABILITY.md)): any of them may change or be removed in any minor release, with a CHANGELOG entry.

Using plugins and writing them (ABI v2, actions, the test kit): [docs/guides/EFFECTS-PLUGINS.md](../docs/guides/EFFECTS-PLUGINS.md). Try them: the plugin gallery, [examples/plugins/](../examples/plugins/); the smallest page that uses them: [examples/effect-plugin/](../examples/effect-plugin/).

## Plugins

| plugin | what it does | input mapper (where a click lands) | actions (`handle.trigger`) | |
|---|---|---|---|---|
| [`crt`](crt/) | An old bar arcade monitor (default preset `arcade`): curved glass, thick scanlines, an RGB aperture grille, phosphor glow and bloom, warm phosphor, a glass reflection, flicker; preset `monitor` is a cleaner screen. | the inverse of the barrel curvature; on the bezel and in the rounded corners `NO_TARGET` | none | [README](crt/README.md), [preview](crt/media/crt.webp) |
| [`disintegrate`](disintegrate/) | The content of the form (text, fields, buttons) turns to dust of its own live colours at a glowing front and swirls away in depth on a curl-noise wind while the page stays, then flies back and settles into the new state (typed text, the success line, a live counter). On a valid submit or its "Turn to dust" button. | the identity at rest; `NO_TARGET` while the transition plays | `out`, `in`, `play`, `demo`; states `'in'`, `'out'` | [README](disintegrate/README.md), [preview](disintegrate/media/disintegrate.webp) |
| [`glitch`](glitch/) | RGB split, block shifts, tracking tears, pixel sorting and broken macroblocks; at rest a still damaged signal with timed events that keep off the focused field; bursts on a validation error. | follows the shifted blocks (also during a burst); the identity outside them and with reduced motion | `burst`, `demo`; state `'idle'` | [README](glitch/README.md), [preview](glitch/media/glitch.webp) |
| [`holo-card`](holo-card/) | The form becomes a holographic card (lamp-lit glare with Fresnel, thin-film foil, glinting flakes) that tilts towards the pointer, a finger (passive: the page still scrolls) or, opt-in, the device. | the inverse of the 3D perspective of the tilted card; beside the card `NO_TARGET` | `demo`; state `'rest'` | [README](holo-card/README.md), [preview](holo-card/media/holo-card.webp) |
| [`liquid-glass`](liquid-glass/) | A squircle slab of refractive glass (Snell refraction through a height field, dispersion, Fresnel, glints, shadows, optional frost) that follows the mouse or is dragged with a finger, with inertia; or stays pinned. | through the glass, the point it shows; the identity outside it | `demo`; states `'free'`, `'pinned'` | [README](liquid-glass/README.md), [preview](liquid-glass/media/liquid-glass.webp) |
| [`page-curl`](page-curl/) | Grab a corner and the live page folds and rolls up under your hand: a 3D sheet with perspective, lighting, a soft shadow that widens with height, its back paper with the page showing through, mirrored; still updating while it curls (type into it). A finger on a corner turns the page instead of scrolling it; the corner springs back on release (the dog-ear peek is opt-in, `autoPeek`). | the identity on the flat page, the exact point on the front of the roll that faces the reader; on the back of the sheet (the dog-ear included) and on the page underneath `NO_TARGET`. The corner drag is the plugin's own gesture and never reaches the form | `peek`, `demo`; state `'rest'` | [README](page-curl/README.md), [preview](page-curl/media/page-curl.webp) |
| [`shatter`](shatter/) | Two impacts: the first cracks the glass over the form (still usable through it), the second breaks it into thick 3D glass shards (bevelled, Fresnel-lit, casting soft shadows) that fall and fly back. On an invalid submit or the Strike button. | the identity at rest; on the still, cracked pane the exact inverse of the shifted pieces and of the bending along the cracks; `NO_TARGET` while the cracks run and from the second impact until the form is back | `impact`, `crack`, `out`, `in`, `play` (`point`), `demo`; states `'intact'`, `'cracked'`, `'gone'` | [README](shatter/README.md), [preview](shatter/media/shatter.webp) |
| [`water`](water/) | A height-field water surface (the wave equation) over the live page: drops, wakes, refraction from the surface normals, caustics and reflections; nothing renders when it is calm. | the inverse of the displacement, from the same field the GPU draws; clicks and typing reach the field the user sees | `drop` (`point`, `strength`, `swell`), `demo`; state `'calm'` | [README](water/README.md), [preview](water/media/water.webp) |

The previews are recorded from the gallery in headless Chrome (each plugin's `test/gallery.e2e.mjs --record`). Each plugin's `meta.reducedMotion` says what it does when the user prefers reduced motion; the gallery shows it, and shows a button per action. Every plugin README has the same sections: what it does, a preview, usage, options, actions, input, reduced motion, performance, limitations, files and tests.

Not built: [`_template`](_template/) (start a new plugin from a copy of it: a spatial plugin with two actions, `shift` and a `demo`, and no work at rest), [`_lib`](_lib/) (runtime code that more than one plugin uses, bundled into each: the transition timeline of disintegrate and shatter, the `point` option of actions, the WGSL loader, the UI stylesheet, the state mapper, option clamping, the full-screen WebGPU pass and the pointer spring) and [`_shared`](_shared/) (test tooling).

## Using a built plugin

```html
<script src="dist/hic-live-polyfill.iife.min.js"></script>     <!-- the core -->
<script src="dist/hic-live-effects.iife.min.js"></script>      <!-- the effects host: window.HTMLInCanvasEffects -->
<script src="dist/plugins/water.iife.min.js"></script>          <!-- registers window.HicLivePlugins.water = {meta, plugin, ...} -->
<script type="module">
  const host = await HTMLInCanvasEffects.createHost(canvas, form, { interposer: true });
  const handle = await host.addPlugin(HicLivePlugins.water.plugin, HicLivePlugins.water.meta.defaults);
  await handle.trigger('drop', { point: { x: 120, y: 80 } });   // an action: resolves 'calm' once the ripple has died out
</script>
```

The page script is a module script so that it can `await` at the top level; `canvas` is your `<canvas content="drawable">` and `form` the drawable element it presents, sized like the canvas ([why](../docs/guides/EFFECTS-PLUGINS.md#21-size-the-source-like-the-canvas)). The usage blocks of the plugin READMEs follow the same pattern.

ES modules: `import { plugin } from '@giuseppe-scotto-lavina/html-in-canvas-polyfill/plugins/water'`. A plugin bundle has no dependency and can load in any order; `host.addPlugin` validates the definition. The actions of a plugin are its definition's `actions` (`HicLivePlugins.<name>.plugin.actions`, `handle.actions`, the manifest); a plugin bundle exports no other way to start them.

## The contract of a plugin folder

`npm run build` finds plugins by convention: every folder `plugins/<name>/` that has an `index.js` and whose name does not start with `_` or `.`. There is no list to edit. Before building a folder it checks the rules of this contract that a script can check (`_shared/contract.mjs`: the name, `index.js` and `README.md` exist, `meta`, `plugin`, the imports, a `wgsl.js` next to `.wgsl` files, a `test/*.test.mjs`), and `npm run lint` runs the same check for every folder, the template included. The README sections and the browser tests are a convention that review keeps, not a check:

| what | rule |
|---|---|
| folder name | `<name>` matches `^[a-z][a-z0-9-]{0,39}$`; it becomes the file name, the exports subpath and the registry key |
| `index.js` | an ES module that exports `meta` and `plugin`, and may export more (helpers for tests, constants) |
| `meta` | frozen `{name, title, description, defaults?, reducedMotion?, continuous?, touch?}`: `name` equals the folder name (the template's is `template`), `title` at most 40 characters, `description` one line of at most 160, `defaults` the options the gallery passes to `addPlugin`, `reducedMotion` one line of at most 160 on what the plugin does under `prefers-reduced-motion: reduce`, `continuous` one line on what keeps rendering at rest when the plugin does so by design, `touch` the one-line hint the gallery shows on a touch screen ([the guide, 15.1](../docs/guides/EFFECTS-PLUGINS.md#151-touch-demo-and-zero-work-at-rest)) |
| `plugin` | the frozen ABI v2 definition, `type` equal to `meta.name`; `definePlugin` of the effects host must accept it. Its optional `actions` are the names `handle.trigger` accepts (the instance then implements `runAction` and `settled`) |
| imports | only files of the plugin's own folder, of [`_lib/`](_lib/), and `src/effects/no-target.js` (the `NO_TARGET` value of the effects ABI, a module without dependencies); type-only JSDoc imports of `src/contracts/types.js` are fine; no `blob:` URLs. The build bundles all of it into the plugin |
| shaders | `.wgsl` files in the folder, loaded with `await wgsl('<file>.wgsl')` from `./wgsl.js` (a copy of the template's, over `_lib/wgsl.js`); the build inlines them, so a built plugin makes no request |
| `README.md` | the sections every plugin README has: what it does, a preview, usage, options, actions, input, reduced motion, performance, limitations, files and tests |
| `test/` | at least one `*.test.mjs` (Node) and, for a plugin that moves pixels, a `*.browser.test.mjs` that checks the input mapper against the GPU pixels (and, for a plugin with actions, each action through the real host); optionally a `gallery.e2e.mjs` that drives the plugin in the gallery with trusted input |
| this file | one row in the table above (`npm run lint` checks it) |

What the build makes of `plugins/<name>/`:

| output | |
|---|---|
| `dist/plugins/<name>.iife.js`, `.iife.min.js` | classic scripts that register `window.HicLivePlugins.<name>` (all exports of `index.js`, frozen) |
| `dist/plugins/<name>.esm.js` | the module, for bundlers: package subpath `./plugins/<name>` (types: `dist/types/plugins/<name>/index.d.ts`) |
| `dist/plugins/manifest.json` | `name`, `title`, `description`, `reducedMotion`, `continuous`, `touch` (the last three when the plugin declares them), `version`, `defaults`, `actions` and file names of every plugin; the gallery reads it |

`npm run check:bundle` loads every plugin bundle after the core and the effects bundle in headless Chrome (it registers, the host accepts it, it compiles its shaders from inlined strings, no request) and holds each minified bundle under its ceiling: the measured size plus a small margin (`PLUGIN_LIMITS` in `scripts/check-bundle.mjs`), 16 KB for a new plugin.

## Tests

- Node tests (`plugins/*/test/*.test.mjs`) run with `npm run test:unit`. Start with the contract test of the template: `contractTest(import.meta.url)` of `_shared/contract-test.mjs` checks that `checkPluginFolder` returns no problem. `_shared/fake-gpu.mjs` is a recording fake device for single-pass plugins. `_shared/node-host.mjs` (`nodeHandle`) puts a plugin behind the REAL handle of the effects host over a fake device, so a test runs `handle.trigger`, `settled`, `remove` and the plugin's own `context.trigger` exactly as a page does, and calls `render(frame)` itself.
- Browser tests (`plugins/*/test/*.browser.test.mjs`) run in headless Chrome with the unit tests (`npm run test:unit:browser`; one file: `node test/unit/run.mjs plugins/<name>/test/<file>`). They import the kit `/plugins/_shared/gpu-check.mjs`:
  - `checkMapperAgainstGpu(t, plugin, options)` presents one frame of the plugin through the real effects host over a grid of white markers and counts the pixels where the mapper's prediction disagrees with the GPU. It passes only when the mapper is right (at most 5 pixels) AND the identity mapper is wrong (at least 200), so the check could have failed.
  - `minBrightShare` (default 0.8): the share of the painted marker area that must be bright. An effect that draws the whole source smaller passes its own (`crt` 0.7, `holo-card` 0.6).
  - `runActionOnGpu(t, plugin, options, action, actionOptions)` runs an action through the real host and handle, presents frames on the frame clock until it resolves, and returns the state, the largest change against the first frame and the worst agreement of a frame's mapper with its pixels while the action played.
  - `presentOnce`, `agreement`, `changedPixels`, `markerScene`, `spyMappers` (records every mapper; the instance is wrapped, not copied, so a `continuous` getter stays live) and `gpuTest` (skips, never passes, where Chrome has no WebGPU adapter) for plugin-specific checks; `water/test/water-gpu.browser.test.mjs` uses them. `lossSpy` and `until` serve the device-loss tests.
  - `_shared/transition-gpu-rig.mjs`: the transition plugins (`disintegrate`, `shatter`) through the real host over a form-like picture.
  - `_shared/gpu-time.mjs`: the GPU time of one pass outside the host (`measureGpuTime`: back-to-back throughput against a clear-only pass; `measurePassGpuTime`: pass timestamps where available).
- Gallery end-to-end tests (`plugins/*/test/*.e2e.mjs`) open `examples/plugins/?effect=<name>` in their own headless Chrome and drive it with trusted input (clicks through the effect, typing, the frame cap, reduced motion). `npm run test:plugins` runs all of them, one after the other, against the built bundles (`npm run build` first); `npm run test:examples` runs them too. One plugin: `node plugins/<name>/test/gallery.e2e.mjs` (`--record` rewrites its `media/<name>.webp` with ffmpeg). Shared steps: `_shared/gallery-e2e.mjs` (open the gallery, shots, drags, recording; `actionChecks` clicks the gallery's button of each action and checks its state, that the frame changed, superseding, an unknown action and `settled()`), `_shared/gallery-click.mjs` (click where the plugin's mapper says a control is drawn away from its DOM position, with a control click at the DOM position) and `_shared/transition-e2e.mjs` (the transition plugins). `openGallery` opens the gallery with `&demo=0`, so a test starts from the plugin's own state.
- The gallery check (`scripts/check-gallery.mjs`, `npm run test:gallery`, headless) holds every plugin of the manifest, and the template, to the three rules of [the guide, 15.1](../docs/guides/EFFECTS-PLUGINS.md#151-touch-demo-and-zero-work-at-rest) in the gallery at 390 x 844 and 1194 x 748: the stage in the first viewport and the form without an inner scroll, the `demo` played on selection (not under reduced motion), 0 effect frames over 2 s once settled unless `meta.continuous` says otherwise, a touch drag on the stage that scrolls the page, and the frame cap at the display rate.

## Working on several plugins at once

Each plugin lives only in its own folder plus one row in the table above (and, for code that several plugins share, `_lib/`), so authors working in parallel do not touch the same files. Nothing else needs editing: the build, the package exports (`./plugins/*`), the manifest, the bundle check and the gallery pick a new folder up by convention.
