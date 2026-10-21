# Field test

The field test is a page of the live demo that a person without any technical knowledge opens on a machine we do not have (a Windows PC, a phone, another Mac), follows for about five minutes, and finishes by downloading one JSON file. The file is enough to diagnose fidelity and performance problems of the polyfill on that machine.

Page: [giuseppescottolavina.github.io/html-in-canvas-polyfill/examples/field-test/](https://giuseppescottolavina.github.io/html-in-canvas-polyfill/examples/field-test/) (source: [examples/field-test/](../../examples/field-test/)).

The page makes no network request besides its own files (the polyfill bundles, and the effects bundle plus the water plugin in the effect step), sends nothing anywhere, and states on its first screen what the file contains.

## Asking someone to run it

Send them something like this:

> Could you help me test something in your browser? It takes about five minutes.
> 1. Open https://giuseppescottolavina.github.io/html-in-canvas-polyfill/examples/field-test/ in the browser you normally use (on a Windows PC: Chrome or Edge if you have it).
> 2. Follow the steps on the page. If the browser asks to share the tab, choose "this tab" and allow it.
> 3. At the end, press "Download report" and send me the file (its name starts with `hic-field-test-`), or attach it to a new issue on GitHub as the page explains.

Ask them to keep the browser window large enough that both boxes of the test area are visible, and not to switch to another window during the steps. Nothing breaks if they do: the report records whether the window had the focus at each measurement.

The page ends with the link to a new GitHub issue that uses the "Field test report" template (`.github/ISSUE_TEMPLATE/field_test.yml`): one line for the device and a box where the file is dropped.

## Steps

| step | what the tester does | what is measured |
|---|---|---|
| welcome | reads what the file contains, presses Start | the environment (below) and the polyfill's `install()` result and `report()` |
| screen capture | allows a capture of **this tab** (Chrome and Edge on desktop), or continues without it | the capture state; with the capture, a calibration that maps CSS px to captured frame px |
| picture check | nothing (about 15 s) | box A (the HTML drawn into a canvas) against box B (the same HTML as a plain page) in five states: at rest, a focused field with its focus ring, a word selected inside a field, a word selected in static text, a scroll box scrolled to 60 px with its scrollbar |
| typing | types `hello field test` into the field of box A | key to canvas update (per key, from the canvas pixels in the next animation frames); with the capture, key to change on screen for box A and for box B (which copies the text), and how far box A trails box B |
| scrolling | scrolls inside the grey box of box A for 5 s (wheel, touchpad or finger) | scroll events, animation frames and canvas updates per second while scrolling; with the capture, on-screen changes per second of box A against box B (which follows the same offset); then box A against box B where the scrolling stopped |
| effect plugin | moves the pointer over the water effect for 6 s | the effect path (WebGPU or the 2D fallback and why), effect frames and animation frames per second, `host.stats()`, effect errors, a capture crop |
| browser zoom | sets the zoom to 125 % with Ctrl/Cmd and +, then back with Ctrl/Cmd and 0 (desktop only) | the zoom seen through `devicePixelRatio`, and the picture check again at that zoom |
| finish | presses Download report (or Copy report) | the summary on the page |

Every step can be skipped. A step that throws is recorded with the error and the test goes on. The page never depends on the polyfill to show itself: if the polyfill refuses the browser or its script does not load, the steps that need a canvas are recorded as skipped and the environment is still collected. A small script before the polyfill records which HTML-in-Canvas names the browser had natively and every console warning and error of the page.

### The pixel oracle (with the tab capture)

`getDisplayMedia({ video, preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude' })` captures the tab as the screen shows it, compositor output included. A capture of any other surface (a window, a screen) is stopped at once and recorded as `wrong-surface`.

- **Frame size.** The request limits the frame to 10 % above the tab's own device pixels. Without a limit Chrome 155 delivers the tab scaled down (800 px wide); with a limit far above it (4096) Chrome renders the tab at a higher device pixel ratio for the duration of the capture, which would measure another ratio than the tester's (the report records the ratio before and during the capture, and a change is a `capture.dpr` warning). The frame can still be scaled by a pixel or two: Chrome delivers frames with even dimensions, so a viewport with an odd height is scaled by, for example, 956/957. The calibration measures that scale.

- **Calibration.** A white card with four black 16 px squares at known CSS positions covers the page for a moment; the centroids of the squares in the captured frame give the scale and offset from CSS px to frame px (least squares, the residual is recorded). It runs again whenever the viewport, the device pixel ratio or the frame size changed. The card also checks that the capture shows this tab: if the squares are not found the capture is stopped (`calibration-failed`).
- **Fresh frames.** The tab capture delivers a frame only when the tab changes. A 6 px marker in the bottom left corner flips between black and white before every grab, and the grab uses the first frame that shows the new colour, so every change the page made before is in it.
- **The same screen pixels.** Box B is compared through a hidden copy of it that lies exactly over box A and is made visible only for the moment its picture is taken. Both pictures therefore come from the same frame pixels, so a capture scaled by a fraction of a pixel treats them alike (side by side, a 0.998 scale alone made 8 % of the pixels differ). Box B beside box A is what the tester sees, and what typing and scrolling are timed against. Before every picture the boxes are moved onto whole device pixels (`fractionalDevicePx` records the correction): a canvas bitmap is shown on the device pixel grid while HTML at a fractional position is rasterised at that position, so a plain-page reference at a fractional position would differ from any canvas, a native one included.
- **Comparison.** Box A's content box (1 frame px inset) is compared with the copy's, grabbed with a 2 frame px margin; the best of the 25 shifts within the margin is kept and reported (`shiftFramePx`), together with the numbers at zero shift. A pixel counts when its largest RGB difference exceeds 16 (and 100) levels, as in the repository's pixel gates. Verdict: **pass** at most 3 % over 16 and 1 % over 100, **warn** at most 6 % and 3 %, **fail** above. A blank box B makes the comparison invalid (`error`). Both boxes go through the same capture path (Chrome delivers I420 frames, so colours are chroma-subsampled), which is why the comparison is between the two boxes and not against a reference image.
- **Overlay scrollbars** show a thumb for about a second after a scroll; with overlay scrollbars both pictures of a scroll box are taken after it faded.
- **Selections.** One document has one selection and one focused element, so box A is set up and grabbed first, then box B. The selection background and glyph colours are measured in both (`selectionColours`, `twinSelectionColours`): on Windows the selected glyphs are expected in `HighlightText`.

### Without the capture

Firefox, Safari, phones and tablets cannot capture a single tab (Firefox and Safari share a whole window or screen, which the test does not ask for), and a tester may decline. The test then reads box A's own canvas backing store: the canvas must not be blank, focus, selections and scrolling must change the pixels of their region, and typing and scrolling are measured from the canvas pixels. These checks are `info` (or `fail` when nothing is drawn or nothing changes); box A is not compared with box B. The backing store crops are kept so the pictures can be looked at.

## The report

One JSON file, `hic-field-test-<date>-<platform>-<browser><major>.json`, schema `hic-field-test/1`. The page's own validator (`window.__fieldTest.validate(report)`) checks the shape; `scripts/check-field-test.mjs` uses it.

| key | content |
|---|---|
| `schema`, `tool`, `startedAt`, `finishedAt`, `page` | identification (the page URL without the query) |
| `collected` | the list of what is collected, as shown to the tester |
| `environment.browser` | user agent, `navigator.userAgentData` with the high-entropy values (`platformVersion`, `architecture`, `bitness`, `model`, `fullVersionList`, `formFactors`, `wow64`), language, CPU count, device memory, touch points |
| `environment.display` | `devicePixelRatio`, screen and viewport sizes, refresh rate from 90 animation frames |
| `environment.media` | `color-gamut`, `dynamic-range`, `prefers-color-scheme`, `prefers-reduced-motion`, `prefers-contrast`, `forced-colors`, `inverted-colors`, `pointer`, `hover` |
| `environment.systemColors` | `Canvas`, `CanvasText`, `Highlight`, `HighlightText`, `AccentColor`, `AccentColorText`, `Field`, `ButtonFace` and others, read through a canvas `fillStyle` (the parsed value and the painted RGBA) |
| `environment.scrollbars` | classic or overlay, gutter width |
| `environment.fonts` | which of 19 common fonts exist (Segoe UI, Arial, Helvetica, Roboto, ...), which of them `system-ui` matches |
| `environment.webgpu`, `environment.webgl` | adapter info (vendor, architecture, device, description, fallback adapter), features, limits; the WebGL renderer strings |
| `environment.apis` | presence of the APIs the test and the polyfill use |
| `polyfill` | script loaded, version, `mode`, the refusal (`feature`, `message`, `hint`), the full `installed.report()` at the end, the native names before install |
| `capture` | `state` (`not-asked`, `unsupported`, `declined`, `denied`, `error`, `wrong-surface`, `calibration-failed`, `active`, `stopped`, `ended-by-user`), the reason, the track settings, the frame format, every calibration |
| `steps.<id>` | `status` (`done`, `skipped`, `error`, `pending`), duration and the raw results of the step (per scenario: canvas backing store stats, region change, selection colours, capture comparison numbers and crop ids) |
| `checks[]` | one line per measurement: `id`, `verdict` (`pass`, `warn`, `fail`, `info`, `skipped`, `error`), a sentence, the key numbers. Read this first |
| `summary` | verdict counts, the worst verdict, platform, browser, mode, capture state |
| `pairs` | paints, paint and readback errors, backing store and CSS size of each canvas |
| `console`, `errors` | console warnings and errors of the page (polyfill messages included), page errors |
| `crops` | PNG data URLs keyed `<check id>.canvas`, `.plain`, `.diff` (with the capture) or `.canvas-backing-store` (without), at most 2,000,000 characters in all; failing and warning comparisons are kept first, the rest is listed in `omitted` |
| `selfCheck` | the result of the developer self-check, when it was run |

To read a report:

```sh
node scripts/field-report.mjs hic-field-test-2026-10-21-windows-chrome155.json --crops=.scratch/field/windows
```

It prints the device, the polyfill and capture state, every check, page errors and the polyfill's console messages, and writes the crops as PNG files.

## Limits per browser

| browser | capture comparison | without it |
|---|---|---|
| Chrome, Edge (desktop) | yes, after the tester allows "this tab" | everything else |
| Firefox (desktop) | no: Firefox offers windows and screens only | canvas checks, typing and scroll timings, effect (WebGPU where Firefox has it), zoom |
| Safari (macOS) | no: Safari offers windows and screens only | canvas checks, typing and scroll timings, effect, zoom (the step sees the zoom through `devicePixelRatio`; a browser whose zoom does not change it leaves the step waiting until it is skipped, unverified per browser) |
| phones and tablets | no (no `getDisplayMedia`) | canvas checks, typing and touch scroll timings, effect; the zoom step is skipped |
| browsers the polyfill refuses | no canvas to compare | the environment, the refusal and its reason |

Other limits: the timings run with the page's own measuring code active (one small canvas readback per frame during typing and scrolling); the capture's frame rate is the browser's (the settings are recorded); a 1-px shift between the boxes is absorbed by the shift search and reported, not judged; hovering the boxes during the picture check changes them (the instructions ask the tester not to touch anything).

## Self-check and automated test

The footer has a "Self-check (for developers)" button: the oracle must pass identical pictures, a 1 px offset and +-6 levels of noise, and fail a 4 px offset, text in another colour and a blank picture; with an active capture, box B grabbed twice must pass (the noise floor of the capture); and it reports whether the report built so far validates.

`npm run test:field` (`scripts/check-field-test.mjs`, after `npm run build`; `--headed` for a visible window) runs the page end to end in headless Chrome with trusted input, the capture accepted through `--auto-select-tab-capture-source-by-title`:

- `clean`: every step; the capture calibrates without changing the device pixel ratio; the five picture comparisons, the comparison where the scrolling stopped and the form at rest at an emulated 125 % zoom (`Emulation.setDeviceMetricsOverride`: the page sees `devicePixelRatio` change as with Ctrl and +) pass; typing and scrolling are measured in the canvas and on screen; the report downloads through the page's button, validates and stays within the crop budget; the self-check passes.
- `dpr125`: the same at a device pixel ratio of 1.25 (`--force-device-scale-factor=1.25`, the common Windows setting), without the zoom step. Two checks are KNOWN RED there and listed in the script with what was measured: the text inside a scrolled box is drawn at another sub-pixel phase than the plain page draws it (glyph edges differ by up to about 80 levels on 3-8 % of the box, none by more than 100; the static text of the same boxes matches at 0 %).
- `broken` (positive control): `drawElementImage` is wrapped to draw 8 grid px lower; every picture comparison must fail and keep its diff picture.
- `denied`: `getDisplayMedia` rejects; the report records `denied` and the canvas-only checks still run.
- `refused`: the user agent says Chrome 120; the polyfill refuses and the page still produces a valid report with the refusal.
- `missing`: the core bundle answers 404; the page still produces a valid report.

`npm run test:pages` also loads the page as part of the Pages site.
