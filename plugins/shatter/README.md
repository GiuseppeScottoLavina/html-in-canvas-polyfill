# shatter

The HTML drawn in a canvas sits behind a pane of glass that takes two impacts. The first cracks it, and the form stays visible and usable through the cracked glass; the second breaks it: the shards fall out in 3D, then fly back into place and the cracks close.

An **example** effect plugin of this library, not part of the polyfill: nothing in `src/` imports it, and the polyfill, the frame cap and the effects host work without it. The effects host and its plugins are extensions of this library, not part of the HTML-in-Canvas proposal; native implementations do not provide them ([details](../../docs/guides/EFFECTS-PLUGINS.md#extensions-not-the-standard)).

![The gallery form: a first invalid submit cracks the glass from the Submit button, a second one breaks it; the shards fall in 3D and fly back, the form shows the error](media/shatter.webp)

Recorded in headless Chrome from the plugin gallery (`node plugins/shatter/test/gallery.e2e.mjs --record`): two trusted clicks on Submit with an invalid email.

## What it does

1. **First impact: the glass cracks.** From the impact point a spiderweb runs out in 450 ms: jagged radial cracks to the edges of the canvas, rings around the impact (whole near it, more and more broken farther out), crushed glass and a flash at the impact, a few chips flying. Each piece shifts a few pixels away from the impact, the picture bends along every broken edge (a 7 px bevel that acts as a lens), and the pieces catch the light at their own slight tilts. The form is still there and **usable through the glass**, and the cracked pane redraws the live form as you type.
2. **Second impact: the pane breaks.** A flash, then the shards fall away from the impact in 3D perspective: out and towards the viewer, turning about tilted axes, falling under gravity, lit on their faces (darker seen from behind, where the form shows mirrored), with bright edges, slight motion blur and small debris. The empty backdrop is left.
3. **Then it rewinds.** The shards fly back up into place with the live form (the page's error state), and the cracks close back into the impact point.

A valid submit while the pane is cracked heals it (the cracks close) without breaking it.

The impact point, when an action gives no `point`: the last pointer press on the canvas within 1.5 s (the Submit or Strike button that was clicked), else the centre of the first invalid field (a submit with the Enter key) or of the button that submitted, else the `impact` option, else the canvas centre. The cracked pane and the way back sample the live source; when the pane breaks, the plugin copies the picture shown at that moment and the falling shards are cut from that copy. The last frame of the way back equals the frame the host presents without any plugin, bit for bit (checked on the GPU).

## Usage

```html
<script src="dist/hic-live-polyfill.iife.min.js"></script>
<script src="dist/hic-live-effects.iife.min.js"></script>
<script src="dist/plugins/shatter.iife.min.js"></script>   <!-- window.HicLivePlugins.shatter -->
<script type="module">
  const host = await HTMLInCanvasEffects.createHost(canvas, form, { interposer: true });
  const glass = await host.addPlugin(HicLivePlugins.shatter.plugin, { onSubmit: 'invalid' });   // invalid submits crack, then break it
  await glass.trigger('impact', { point: { x: 120, y: 80 } });   // 'cracked' (the point in canvas CSS px)
  await glass.trigger('impact');                                 // 'intact': it breaks, falls and flies back
</script>
```

ES modules: `import { plugin } from '@giuseppe-scotto-lavina/html-in-canvas-polyfill/plugins/shatter'`.

## Options

| option | default (gallery) | |
|---|---|---|
| `cracks` | 13 | radial cracks, 6 to 24 |
| `duration` | 1600 | ms of one way of the fall (out or in), 300 to 8000; one way plays 1.7 s of physics |
| `gravity` | 1 | 0.2 to 3 (1 = 2400 CSS px/s²) |
| `refraction` | 1.6 | 0 to 4: CSS px the picture bends at a crack |
| `edgeColor`, `edgeAmount` | `#d9f5ff`, 0.85 | the fractures, the crushed glass, the edges of falling shards and the flash (0: geometry only) |
| `glint` | 0.8 | 0 to 1: the light the pieces and the falling shards catch |
| `backdrop` | the host's clear colour | what is left behind (`#rrggbb` or `[r, g, b]` 0..1) |
| `onSubmit` | `'off'` (`'invalid'`) | `'off'`, `'invalid'`, `'valid'`, `'always'`: a matching `submit` inside the source is an impact (the first cracks, the next breaks); a submit that does not match heals a cracked pane, also while its cracks run. A matching submit while the cracks run, and any submit while shards fall, does nothing. The page's own submit handler runs first when it was added before the plugin |
| `invalidSelector` | `:invalid, [aria-invalid="true"], .invalid` | what counts as an invalid field |
| `intro` | false (true) | when created, the shards fly into place once the first snapshot is there (not when re-created after a device loss) |
| `state` | `'in'` | `'cracked'`, `'out'`, `'in'`: the end state, declaratively; only a change of `state` starts something |
| `impact` | the canvas centre | `{x, y}` CSS px: the impact when there is no point, no pointer press and no field |
| `reducedMotion` | follows `prefers-reduced-motion` | `true` / `false` to force it |
| `seed` | 7 | the crack pattern (each crack adds one) |

`mountUI` adds a Strike button (the action `impact`, from the button) and a slider for the number of radial cracks.

## Actions

`handle.trigger(action, { point })` ([semantics](../../docs/guides/EFFECTS-PLUGINS.md#5-actions-trigger-and-settled)). `point` is optional, `{x, y}` in canvas CSS px (anything else rejects with a `TypeError`); it places the impact of a crack.

| action | | resolves with |
|---|---|---|
| `impact` | cracks an intact pane; breaks a cracked one (as `play`) | `'cracked'`, or `'intact'` after a break |
| `crack` | cracks and stays cracked | `'cracked'` |
| `out` | breaks and stays gone (an intact pane cracks in the first moments of the fall) | `'gone'` |
| `in` | flies back and closes the cracks; on a cracked pane, closes them | `'intact'` |
| `play` | out, a 300 ms pause, in | `'intact'` |

`handle.settled()` resolves with `'intact'`, `'cracked'` or `'gone'` once nothing moves, after the frame that draws that state. A newer action, a submit (`onSubmit`), the Strike button or `setOptions({ state })` supersede a pending trigger (it resolves `null`). `crack` with reduced motion, or while shards fall, does nothing and resolves with the state the pane rests in.

## Input

The plugin is `spatial`; its mapper depends on the presented frame:

- **intact**: the identity; the form is fully usable.
- **cracked and still**: the inverse of the pane (`crackedSource` in `shards.js`). For a presented point it finds the piece drawn there (the later piece where two shifted pieces overlap, as on the GPU), removes that piece's offset and, within 7 px of a crack, the bending of the bevel; inside an open crack it is the identity. A click, a focus, typing, a checkbox all work through the cracked glass. The mapper is made once per crack pattern, not per frame.
- **while the cracks run or close, and from the second impact until the form is back** (including the reduced-motion crossfade): `NO_TARGET` for every point, so the host swallows a press (no focus change, nothing activated). Falling shards are not hit-tested.

Keyboard input is not mapped: a key pressed during a transition reaches the element that had the focus.

## Reduced motion

With `prefers-reduced-motion: reduce` nothing cracks or falls: an `impact` (or `out`, `in`, `play`) crossfades the picture to the backdrop and back; `crack` does nothing.

## Performance

On one machine (Apple M1 Max, macOS, headless Chrome, Metal, other work running), timestamp queries on the plugin's pass at 2200x1240 backing pixels (the gallery canvas at DPR 2), frames 8.33 ms apart: GPU time p50 0.26 ms, p95 0.59 ms while the cracks run and on the cracked pane; p50 0.20 ms, p95 0.59 ms, max 0.92 ms while shards fall; intact p50 0.33 ms. `render()` on the CPU p95 0.01 ms, 2.9 ms once per crack (the frame that builds the pattern). Chrome quantises timestamps, and these numbers come from one run: they say the pass fits a 120 Hz frame (8.33 ms) on this machine, nothing about others. `test/shatter-perf.browser.test.mjs` prints them again.

How: the crack pattern (`spiderweb` in `shards.js`: radial cracks, broken rings, every cell clipped to the canvas so the cells partition it exactly, each fanned from a point that sees all its edges) is built on the CPU once per crack. The shards are one preallocated vertex buffer and up to 160 shard records in the uniform block; the vertex shader moves a shard as a function of time only (in the pane: home + offset, the mapper's formula; falling: rotated, moved, pulled by gravity and projected). Both clocks (the cracks' 450 ms, the fall's out/in timeline) run on `frame.now` from the first frame after the request, so the same instant looks the same at any cap (checked at 120 Hz and 15 fps). The instance is `continuous` only while something moves; a cracked, still pane renders only when the page changes. A frame writes a preallocated 28-float header and reuses its pass descriptor.

## Limitations

- Pointer input is blocked while the cracks run and while shards fall or fly back.
- The falling shards show the picture of the moment the pane broke (a copy), not the live page; the cracked pane and the way back are live.
- At most 160 shards per pattern.
- Device loss mid-transition: the plugin comes back intact (or at its `state`), without the intro; the pending trigger resolves `null`.
- WebGPU only (without an adapter `createHost` rejects with a `NotSupportedError`). Runs over the polyfill and over a browser's own HTML-in-Canvas implementation ([what differs there](../../docs/guides/EFFECTS-PLUGINS.md#on-a-native-implementation)); not run there by the test suites (the native suite runs water, CRT and disintegrate); expected to behave the same, as the plugin uses only the plugin interface.

## Files and tests

| file | |
|---|---|
| `index.js` | `meta`, `plugin`, `ACTIONS`, `actionPoint`, and the pure helpers the tests use (`readOptions`, `fillHeader`, `crackFront`) |
| `shards.js` | pure: the crack pattern, cells, fans, shard parameters, the mapper of the cracked pane (`crackedLayout`, `crackedSource`), `shardPoint` |
| `../_lib/transition.js`, `../_lib/action.js` | shared with other plugins, bundled into each: the out/in timeline, the two constant mappers, option parsing, the invalid-field probe; the `point` option of actions |
| `shatter.wgsl` | the shader: full-screen pass (intact frame, the dimmed picture in the open cracks, crossfade, freeze copy), the shards (pane and fall), the debris |
| `wgsl.js` | loads the `.wgsl` file when the plugin runs from source; the build replaces it |
| `media/shatter.webp` | the recording above |
| `test/shatter.test.mjs` | Node: the folder contract, the partition and the fans for many impacts and seeds, rings, border flags, offsets and fall start, the mapper of the cracked pane (exact inverse inside a piece, identity in an open crack), `shardPoint`, options and the header, and a fake GPU behind the real handle (no GPU object per frame, one pattern per crack, the two impacts and their mappers, the impact point from the action / pointer / invalid field / option / centre, submit wiring incl. healing, every action and its state, `settled`, superseding by a submit, bad points, reduced motion, removal) |
| `test/shatter-gpu.browser.test.mjs` | headless Chrome, real host and GPU: intact frame = passthrough bit for bit; the cracked pane's mapper against the GPU pixels (`checkMapperAgainstGpu`: 0 wrong pixels, the identity wrong on over a thousand); a click through the cracked glass reaches the button (swallowed while the cracks run); the second impact: mid frames moving, input blocked, the end bit for bit; 120 Hz vs 15 fps cap; reduced motion; device loss; intro and submit wiring |
| `test/shatter-perf.browser.test.mjs` | the GPU time measurement above |
| `test/gallery.e2e.mjs` | the plugin in the gallery with trusted input: an invalid Submit cracks it, a click through the cracks focuses the message field and typing shows; a second one breaks it, a click during the fall changes nothing, it comes back usable; the Strike button, healing; every action from the gallery's buttons (`crack`, `in`, `out`, `in`, `impact` twice), an unknown action, superseding, `settled()`. 47 of 47 checks pass (headless Chrome 155, 2026-10-16). `--record` writes the media; needs `npm run build` |
