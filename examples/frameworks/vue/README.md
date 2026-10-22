# Vue 3 inside a drawable canvas

A small Vue 3 app whose whole UI is inside `<canvas content="drawable">` and painted with `drawElementImage` from the `paint` event: a controlled input, a keyed list (Add / Remove first / Reverse buttons, click a row to select it), a conditional second drawable (the red badge, drawn at (340, 300) while it is laid out at the origin), and a timer component that re-renders every 500 ms. `dist/hic-live-polyfill.iife.js` is loaded BEFORE the app bundle.

Files: `main.js` (components with runtime-compiled templates: `vue.esm-bundler.js` with the compiler; an SFC `<template>` would be the same markup), `index.html`. Shared data and CSS: `../shared/app-spec.js`.

## The pattern

- The canvas is wired by `watch(canvasRef, (c, _old, onCleanup) => ..., { flush: 'post' })`: it runs when the template ref gets the element and again when `v-if` re-creates the canvas; `onCleanup` releases the old one.
- `v-model` on the drawn input, keyed `v-for` rows, `v-if` around a drawable (Vue leaves a `<!--v-if-->` comment as a direct child of the canvas; that works).
- `content="drawable"` is written as a static attribute in the template; it works whether Vue applies it as an attribute or through the `canvas.content` property the polyfill defines (not inspected which one Vue used).

## Run it

```sh
npm run build                                   # dist/ (the polyfill)
(cd test/frameworks && npm install)             # framework deps live there, never in the root package
node test/frameworks/build.mjs                  # builds examples/frameworks/*/dist/app.js
npm run demo                                    # then open http://127.0.0.1:8765/examples/frameworks/vue/
```

`?tick=0` stops the timer, `?mode=ref` renders the plain-DOM twin used by the pixel oracle. Tested by `npm run test:frameworks` (headless Chrome, results in `.scratch/results/`); see [docs/guides/FRAMEWORKS.md](../../../docs/guides/FRAMEWORKS.md) for what was verified.
