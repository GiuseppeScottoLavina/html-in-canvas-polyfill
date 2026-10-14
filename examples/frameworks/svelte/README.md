# Svelte 5 inside a drawable canvas

A small Svelte 5 app whose whole UI is inside `<canvas content="drawable">` and painted with `drawElementImage` from the `paint` event: a controlled input, a keyed list (Add / Remove first / Reverse buttons, click a row to select it), a conditional second drawable (the red badge, drawn at (340, 300) while it is laid out at the origin), and a timer component that re-renders every 500 ms. `dist/hic-live-polyfill.iife.js` is loaded BEFORE the app bundle.

Files: `App.svelte`, `Ticker.svelte`, `main.js` (`mount`), `index.html`. The build compiles `.svelte` files with `svelte/compiler` through a small esbuild plugin (`test/frameworks/build.mjs`). Shared data and CSS: `../shared/app-spec.js`.

## The pattern

- The canvas is wired in a `$effect` that reads only `canvas` (from `bind:this`); it re-runs, with cleanup, when `{#if}` re-creates the canvas. The drawables (`panel`, `badgeEl`) are read inside the paint handler, so they are not effect dependencies.
- `bind:value`, keyed `{#each items as it (it.id)}`, `{#if}` around a drawable, a snippet rendered into the canvas.

## Run it

```sh
npm run build                                   # dist/ (the polyfill)
(cd test/frameworks && npm install)             # framework deps live there, never in the root package
node test/frameworks/build.mjs                  # builds examples/frameworks/*/dist/app.js
npm run demo                                    # then open http://127.0.0.1:8765/examples/frameworks/svelte/
```

`?tick=0` stops the timer, `?mode=ref` renders the plain-DOM twin used by the pixel oracle. Tested by `npm run test:frameworks` (headless Chrome 154, results in `.scratch/results/`); see [docs/guides/FRAMEWORKS.md](../../../docs/guides/FRAMEWORKS.md) for what was verified.
