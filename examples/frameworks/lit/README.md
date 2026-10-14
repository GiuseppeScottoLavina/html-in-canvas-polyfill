# Lit 3 inside a drawable canvas

A small Lit 3 app whose whole UI is inside `<canvas content="drawable">` and painted with `drawElementImage` from the `paint` event: a controlled input, a keyed list (Add / Remove first / Reverse buttons, click a row to select it), a conditional second drawable (the red badge, drawn at (340, 300) while it is laid out at the origin), and a timer component that re-renders every 500 ms. `dist/hic-live-polyfill.iife.js` is loaded BEFORE the app bundle.

Files: `main.js` (`<hic-app>` with an OPEN shadow root, `<hic-ticker>` in light DOM), `index.html`. Shared data and CSS: `../shared/app-spec.js`.

## The pattern

- The canvas lives in the component's shadow root; the polyfill manages it like a document canvas (its `<hic-layer>` is created in the same shadow root).
- The canvas is wired by a `ref()` **callback** (a stable arrow-function field): Lit calls it with the element and with `undefined` when the canvas leaves the DOM.
- `repeat()` keyed rows, `.value=` on the drawn input, a conditional drawable with `nothing`.

## Run it

```sh
npm run build                                   # dist/ (the polyfill)
(cd test/frameworks && npm install)             # framework deps live there, never in the root package
node test/frameworks/build.mjs                  # builds examples/frameworks/*/dist/app.js
npm run demo                                    # then open http://127.0.0.1:8765/examples/frameworks/lit/
```

`?tick=0` stops the timer, `?mode=ref` renders the plain-DOM twin used by the pixel oracle. Tested by `npm run test:frameworks` (headless Chrome 154, results in `.scratch/results/`); see [docs/guides/FRAMEWORKS.md](../../../docs/guides/FRAMEWORKS.md) for what was verified.
