# Plugin template

The smallest complete **spatial** effect plugin with **actions**: it shifts the picture sideways by `offset` CSS pixels, supplies the input mapper that keeps clicks on the element the user sees, and has two actions, `shift` and `demo`. It follows the three rules of every interactive plugin ([the guide, 15.1](../../docs/guides/EFFECTS-PLUGINS.md#151-touch-demo-and-zero-work-at-rest)): it claims no touch gesture (it has nothing to grab), its `demo` shows the effect without any input, and it does no work at rest. Start a new plugin from a copy of this folder. Folders whose name starts with `_` are not built, so this one never ships as a bundle.

## What it does

The picture moves right by `offset` CSS px; the gap on the left is black. The mapper moves a point back by the same offset.

## Usage

This folder is not built; a plugin made from it is used like any other ([docs/guides/EFFECTS-PLUGINS.md](../../docs/guides/EFFECTS-PLUGINS.md), section 3):

```js
const handle = await host.addPlugin(plugin, { offset: 24 });
await handle.trigger('shift', { offset: 60 });   // 'still', once a frame shows the new offset
await handle.trigger('demo');                    // the picture swings out and back in 1.6 s; 'still' at rest
```

## Options

| option | default | |
|---|---|---|
| `offset` | 24 | 0 to 200 CSS px |

`mountUI` adds a slider for it.

## Actions

| action | options | | resolves with |
|---|---|---|---|
| `shift` | `offset` (optional) | moves the picture to `offset` | `'still'`, after the frame that shows it was rendered |
| `demo` | none | the picture swings 48 CSS px further and back in 1.6 s (`DEMO_MS`, `demoOffset`: a raised cosine, at rest at both ends); a press on the canvas or `setOptions` ends it at once; with reduced motion nothing moves | `'still'`, after the frame at rest |

The code shows the whole contract of an action (section 15 of the guide): `actions` in the definition, `runAction` that returns `settled()`, `settled()` that resolves in `render` after the frame was encoded, and `destroy()` that resolves pending waiters with `null`. The host validates the action name, supersedes an older trigger and handles removal. The `demo` adds the rest of the pattern: its clock starts at the first frame that renders it, `render` asks for the next frame only while it moves, and a passive `pointerdown` (`context.listen`) gives way to the user.

## Input

The identity shifted back by `offset`, clamped to the canvas (`mapOffsetPoint`). Each mapper keeps the offset of the frame it was captured for.

## Reduced motion

Nothing moves on its own: the picture is shifted, not animated, `shift` jumps and `demo` resolves at once (`info.reducedMotion`).

## Performance

One full-screen pass with one texture sample per pixel; rendered only when the source changed or on request (not `continuous`): at rest, and after its demo, it presents no frame. The kit's GPU time measurements use this pass as their baseline (0.09 ms per frame at 2200x1240 on an Apple M1 Max).

## Limitations

A starting point, not an effect: replace the shader, the mapper and the action.

## Make your own

1. Copy the folder: `cp -r plugins/_template plugins/<name>` (`<name>`: lowercase letters, digits and `-`; it becomes `dist/plugins/<name>.iife.js`, the exports subpath `./plugins/<name>` and `window.HicLivePlugins.<name>`).
2. In `index.js`, set `meta.name` and `plugin.type` to `<name>`, and write `meta.title`, a one-line `meta.description` and a one-line `meta.reducedMotion` (what the plugin does under `prefers-reduced-motion: reduce`; the plugin gallery shows all three).
3. Replace `offset.wgsl` and `mapOffsetPoint` together: the mapper is the JavaScript twin of the shader's sampling formula. Where a presented pixel shows no element of the source, the mapper returns `NO_TARGET` (`import { NO_TARGET } from '../../src/effects/no-target.js'`; the host then swallows the press). A plugin that does not move pixels drops `spatial` and `captureInputMapper`.
4. Replace the action `shift` with yours, or drop `actions`, `runAction` and `settled` when the plugin has nothing to trigger. If its look depends on an input or an event, keep a `demo` (at most about 4 s, ending at rest, giving way to user input) and adapt it; if it renders at rest by design, say what in `meta.continuous`. If it has something a finger grabs, claim the touch gesture only on it (the guide, 15.1). Your own triggers (a button of `mountUI`, a submit listener) call `ui.trigger` / `context.trigger`.
5. Rename the tests and adapt them. Keep the GPU tests: `checkMapperAgainstGpu` (`plugins/_shared/gpu-check.mjs`) compares the mapper with the pixels the GPU presented, and fails when the identity mapper would pass too; `runActionOnGpu` runs an action through the real host and judges the mapper of its frames. In Node, `nodeHandle` (`plugins/_shared/node-host.mjs`) puts the plugin behind the real handle.
6. `npm run build` discovers the folder, checks it against the contract and writes the bundles and the manifest entry (with the actions); `npm test` runs its tests; the gallery (`examples/plugins/`) lists it and shows a button per action. Add a row to `plugins/README.md` (`npm run lint` checks it), and a `PLUGIN_LIMITS` entry in `scripts/check-bundle.mjs` once its size is known.
7. Optional: a `test/gallery.e2e.mjs` that drives the plugin in the gallery with trusted input, built on `plugins/_shared/gallery-e2e.mjs` (`actionChecks` for the actions; `npm run test:plugins` runs it).

## Files and tests

| file | |
|---|---|
| `index.js` | `meta`, `plugin` and the mapper formula `mapOffsetPoint` |
| `offset.wgsl` | the shader |
| `wgsl.js` | loads the `.wgsl` files of the folder when the plugin runs from source; the build replaces it with inlined strings. Copy it unchanged. |
| `test/template.test.mjs` | Node: the folder contract, the mapper formula, the per-frame freeze of the mapper, the actions through the real handle (state, superseding, removal; the demo: it moves and ends at rest, no frame requested after it, user input takes over, reduced motion) |
| `test/template-gpu.browser.test.mjs` | headless Chrome: the mapper against the GPU pixels; the action through the real host (the frame that resolves it shows the new offset and agrees with its mapper) |
