# Performance: what the numbers are, and are not

Read this before quoting a number from this project. The figures come from [docs/PERFORMANCE-COMPARISON.md](../PERFORMANCE-COMPARISON.md), which measures this polyfill, the npm package `html-in-canvas-polyfill` and the native implementation on the same pages with the same harness, and explains the method.

## 1. Summary

- The polyfill draws the page twice per update: the browser lays out and paints the live DOM, and the polyfill photographs it (clone, serialise into an SVG `foreignObject` `data:` URL, decode, draw into a retained 2D canvas). That second pass costs main-thread time that grows with the size of the DOM that is re-photographed, and the picture usually arrives about 2 frames after the DOM change (`docs/API-CONTRACT.md` sections 4.2 and 8).
- Two shortcuts hide most of that delay where it matters: typed text in a single-line field is drawn into the retained surface at once (the text overlay), and inner scrolling is composed from cached pages of the scroller (the scroll compositor). See [docs/DESIGN-DECISIONS.md](../DESIGN-DECISIONS.md).
- The design goal is a 120 Hz effect over a source updated at 30 to 60 Hz. A stable 120 Hz source is not promised.
- Everything was measured on one machine: Apple M1 Max, macOS, 120 Hz display, DPR 2, Chrome 155 for the polyfill and Chrome Canary 157 for native. Nothing was measured on Windows or Linux, and these runs did not cover DPR 1 or the effect.

## 2. Selected numbers (p50 / p95 in ms unless stated)

| scenario | this polyfill | native |
|---|---|---|
| keydown to canvas pixel, explainer example, text fits | 5.3 / 9.9 | 5.2 / 10.3 |
| keydown to canvas pixel, F1 form | 6.3 / 12.1 | 6.9 / 10.5 |
| click to focus pixel | 13.9 / 15.6 | 5.7 / 8.1 |
| wheel to pixel, inner list | 28.5 / 32.4 | 36.5 / 42.2 |
| real window resize: blank frames | 0 of 3127 | 0 of 3129 |
| resize: convergence after the last resize event | 8.2 / 8.9 | 8.1 / 9.9 |
| author update in a large drawable (F4, 1000 elements): update to pixel | 1.8 / 11.3 | 2.6 / 5.5 |
| a 60 Hz counter beside 2,000 elements: paints per second | 59 | not measured |
| first paint of the F1 form, new renderer (p50) | 97 | 71 |
| minified core: parse, compile and install (p50) | 8.1 | 0 |

Where the polyfill is clearly slower: the main-thread cost of updates in large drawables, first paint, and memory (about 60 MB more renderer RSS on F1). The full table, the method and the analysis of each loss are in [docs/PERFORMANCE-COMPARISON.md](../PERFORMANCE-COMPARISON.md).

## 3. Node budget guidance

Defaults (`src/api/options.js`, `docs/API-CONTRACT.md` section 9.2), counted per drawable:

| option | default | effect |
|---|---|---|
| `nodeBudget.soft` | 350 | above it the clone is damage-pruned (only the part near the damage is cloned in full) |
| `nodeBudget.hard` | 3000 | above it the drawable is updated at most 4 times per second and a `node-budget` entry is reported |
| `nodeBudget.absolute` | 20000 | above it the capture is refused: a hatched placeholder and a `node-budget` entry |

A drawable that updates often (typing, animation, a slider) should stay well under about 1000 elements, and under a few hundred if you want headroom for the rest of your page: one update of a 2000-element drawable costs about 20 ms of main thread (F4 rows of the comparison), most of it the browser's own style and layout of the page and of the snapshot. A change that keeps its parent's size is repainted from a tile around the children that moved, and the content of a large block below that tile is left out of the snapshot, so a small part that changes often (a counter, a clock) next to a large static part stays cheap. A large static list is better split into several drawables or windowed (render only the visible rows). Counting: `element.getElementsByTagName('*').length + 1`. The F4 fixture (`test/fixtures/f4-large-app`, `nodes=200|500|1000|2000`) is there to measure your own sizes.

## 4. Frame cap semantics (`docs/API-CONTRACT.md` 7.1)

- `framecap` attribute on the canvas (non-negative integer, 0 to 240, 0 = uncapped = display rate) and the `canvas.frameCap` property that reflects it. A change takes effect within one frame. The default for canvases without the attribute is `options.defaultFrameCap` (0).
- The effective cap F is an upper bound, per canvas, on: `paint` events, effect frames (`effectframe`), and snapshot build starts (together with `options.maxSnapshotFps`, default 60: the lower non-zero value wins; `maxSnapshotFps` does not hold the re-raster of a canvas resize / DPR change built inside its frame, the framecap does).
- Frames are paced by a phase accumulator, so 60 on a 120 Hz display renders every second frame. Measured with the water plugin on a 120 Hz display: caps 30, 60 and 120 gave 30.0, 60.0 and 120.1 Hz, from an independent clock.
- `requestPaint()` is a request, not a bypass: a capped canvas never paints faster than F. The redraw behind a `canvas.width/height` write is the one exception (one per frame): a cleared bitmap must be redrawn in the same frame.
- Input-driven updates also honour the cap unless `options.interactionFloorFps` is set; with the default 0, typing latency can be up to one cap period.
- With a complete native implementation the cap only bounds effect frames.
- A cap is a ceiling, not a promise: a slow page cannot be sped up by raising it.

## 5. Tips

- Avoid giant drawables. A retained surface is bounded: `options.maxSurfacePixels` 33,554,432 per drawable and `options.maxTotalSurfaceBytes` 512 MiB per install; above them the raster scale is reduced and a `surface-size` entry is reported. A full-canvas drawable of 1440x900 CSS px at DPR 3 is 46.7 MB. The raster scale never exceeds `options.maxDpr` (2.5); an export canvas at 3 to 4x is upscaled.
- Keep resources inlinable. Snapshots are SVG images that cannot load external resources, so images, CSS `url()`s and fonts are fetched by the polyfill and inlined as `data:`. Same-origin or CORS-enabled resources work; others become a placeholder or a fallback font plus a `cross-origin-resource` entry. Prefer `data:` URIs or same-origin files for assets in a drawable. A resource above the cache budget is refused (`resource-fetch-failed`).
- Fonts: system fonts need nothing. A web font is expected to be inlined as `data:` when it is same-origin or CORS-enabled (`docs/SUPPORT-MATRIX.md`, content table: label "expected", no gate loads a web font). Test your own font before relying on it.
- Keep the drawable small and static where you can: animations and transitions are re-snapshotted at the cap, frozen at the sampled time (`css-animations`). Prefer an effect plugin for motion over animating the source.
- Do not read the canvas back every frame (`getImageData`) on a native implementation: it was measured to slow the native path considerably. The polyfill's own retained surfaces are not affected.
- Use `framecap` deliberately: 30 or 60 for forms, higher only when an effect animates.
- An effect costs nothing while its canvas is out of view: the effect host pauses more than half a viewport away and when the document is hidden (gallery with the water effect, headless: renderer + GPU process CPU 28.8 % on screen, 1.3 % one viewport away). `paint` events and snapshot builds go on off-screen, as they do natively.
- Chrome's dropped-frame count during a page scroll over a capped effect reflects the cap, not the effect's work. Measured (headed Chrome 155, 120 Hz, DPR 2, wheel scroll of the gallery with the water effect): cap 60, 66 frames counted as dropped (all of them "presented partial": the scroll moved, the canvas did not, as the cap asks); cap 120, twice the effect frames, 1 dropped; the effect off, 12. Main thread busy 4 to 5 %, no task above 8.33 ms in any of them. The scroll itself is presented every frame; to see the effect move at the display rate, raise the cap.
- Measure with a trace, not the Long Tasks API (its threshold is 50 ms, six times a 120 Hz frame): `RunTask` on the renderer main thread against 8.33 ms (`test/harness/README.md`).

## 6. How to measure your own page

```sh
node test/gates/measure-timing.mjs    # reported data, no thresholds, headed Chrome, F1 and F3 fixtures
npm run bench:compare                 # the full comparison (about 45 minutes, headed Chrome and Canary)
```

The harness records a load snapshot with every run and labels a run `highLoad` when another process used more than 15 % CPU; keep that label when you quote a number. Do not judge the frame cap by a badge that measures its own rAF (`docs/TEST-PLAN.md` section 0).
