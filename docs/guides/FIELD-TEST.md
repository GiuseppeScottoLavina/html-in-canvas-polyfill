# Field test

The field test is a page of the live demo that a person without any technical knowledge opens on a machine we do not have (a Windows PC, a phone, another Mac), follows for about six minutes, and finishes by downloading one JSON file. The file is enough to diagnose fidelity and performance problems of the polyfill on that machine.

Page: [giuseppescottolavina.github.io/html-in-canvas-polyfill/examples/field-test/](https://giuseppescottolavina.github.io/html-in-canvas-polyfill/examples/field-test/) (source: [examples/field-test/](../../examples/field-test/)).

The page makes no network request besides its own files (the polyfill bundles, and the effects bundle plus the water plugin in the effect step), sends nothing anywhere, and states on its first screen what the file contains.

## Asking someone to run it

Send them something like this:

> Could you help me test something in your browser? It takes about six minutes.
> 1. Open https://giuseppescottolavina.github.io/html-in-canvas-polyfill/examples/field-test/ in the browser you normally use (on a Windows PC: Chrome or Edge if you have it; on an iPhone: Safari).
> 2. Follow the steps on the page. If the browser asks to share the tab, choose "this tab" and allow it. In the "Scroll smoothness" step, do not touch anything until the page says "Your turn", then flick (or scroll) the list on the left until the counter reaches zero.
> 3. At the end, press "Download report" and send me the file (its name starts with `hic-field-test-`), or attach it to a new issue on GitHub as the page explains.

On an iPhone, "Download report" asks whether to download the file and saves it in the Files app (Downloads); from there it can be shared like any file. "Copy report" puts the whole report on the clipboard instead, to paste into a message or an email. Ask them to hold the phone upright and to leave Low Power Mode off during the test (it lowers the frame rate; the report records the measured frame interval either way).

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
| scroll smoothness | presses Start, does not touch anything for about 25 s, then flicks the Rounded list with a finger (or scrolls it with the wheel or touchpad) for 6 s of movement | a long list drawn into a canvas while it scrolls: canvas updates per second, stutters, the longest gap, moves not painted, the first-step lag, the scroll compositor's counters, clone and decode times; a scripted scroll as a baseline; the first frame after a jump of a list against the settled canvas. See [Scroll smoothness](#scroll-smoothness) |
| effect plugin | moves the pointer over the water effect for 6 s | the effect path (WebGPU or the 2D fallback and why), effect frames and animation frames per second, `host.stats()`, effect errors, a capture crop |
| browser zoom | sets the zoom to 125 % with Ctrl/Cmd and +, then back with Ctrl/Cmd and 0 (desktop only) | the zoom seen through `devicePixelRatio`, and the picture check again at that zoom |
| finish | presses Download report (or Copy report) | the summary on the page |

Every step can be skipped. A step that throws is recorded with the error and the test goes on. The page never depends on the polyfill to show itself: if the polyfill refuses the browser or its script does not load, the steps that need a canvas are recorded as skipped and the environment is still collected. A small script before the polyfill records which HTML-in-Canvas names the browser had natively and every console warning and error of the page.

### Scroll smoothness

A step for the question "does scrolling inside a canvas stutter on this device?", with the metrics of the repository's scroll benches (`test/bench/scroll-jank.mjs` in Chrome, `test/bench/scroll-jank-ios.mjs` in the iOS Simulator), so that a phone's numbers compare with theirs. It needs no tab capture and no WebGPU: it reads the polyfill's own canvas.

**The drawable.** One canvas (full width up to 560 css px, 380 css px high, less on a short viewport) with two lists of 60 rows each, laid out on fractional css px like `test/fixtures/mobile/scroll-compose.html`: a 1fr / 1.3fr grid, rows 36.6 px high, sticky headers. The Rounded list (left) is rounded, bordered and opaque; the Square list (right) is square and transparent, 7.4 px lower: the scroll compositor's two port shapes. The canvas is created when the step starts and removed when it ends.

**Three parts**, each bounded:

1. **Scripted scroll** (about 10 s, hands off): three momentum-like scrolls of each list from `requestAnimationFrame` (`scrollTop += v`, v from 40 px per frame decaying by 0.95 per frame, down, down, up), the `script` mode of `scroll-jank-ios.mjs`. A baseline that does not depend on how the tester scrolls; it ends after 6 s per scroll whatever happens (an animation frame never comes in a hidden tab).
2. **Scroll frames** (about 18 s, hands off): six jumps of each list (to 100, 130, 437, 851, 61 and 1203 css px); for each, the first canvas paint after the jump against the canvas 700 ms later, the benches' `oracle` mode. Both pictures are copies of the canvas (`drawImage` into a scratch canvas), so the measured canvas itself is never read back. A jump not repainted within 2 s is recorded as such.
3. **Your scrolling**: the tester flicks the Rounded list with a finger (phones) or scrolls it with the wheel or touchpad (desktops) until 6 s of movement have been measured; a prompt above the canvas counts down. The part ends by itself after 60 s, and "I cannot flick here" ends it at once; the whole step has the usual "Skip this step". Without movement the part is recorded as skipped.

A summary with one green, amber or red line per part ends the step (Continue, or it moves on by itself after 2 minutes).

**Metrics** (per part, from one row per animation frame `[time, offsets of the lists, canvas paints so far]`; a move in frame m counts as painted when the canvas painted in that frame):

| key | meaning |
|---|---|
| `frameMs` | median animation frame interval (the display's refresh, as the browser runs it) |
| `moves`, `movingMs` | frames in which a list moved; time from the first move to one frame after the last, summed over the stretches of movement |
| `paintHz` | canvas updates per second while a list moves |
| `paintedShare`, `unpainted` | share of the moves painted in their own frame; moves not painted |
| `paintGaps`, `stuttersPerSec`, `maxPaintGap` | stutters: canvas update gaps longer than 2.5 frame intervals over an unpainted move; per second of movement; the longest |
| `moveGaps`, `maxMoveGap`, `rafGaps`, `maxRaf` | the list itself stalled (gaps between moves), animation frames dropped |
| `startLag` | per stretch of movement, from the first move to the first canvas update (the first-step lag) |
| `stats.scroll` | the scroll compositor's counters during the part (`composed`, `fallbacks`, `refusals`, `plans`, `pages`, ...), from `__HIC__.installed.report().canvases[i].stats.snapshot.scroll` |
| `stats.cloneMsP50` ... `decodeMsP95` | the snapshot's clone and decode times (p50, p95) at the end of the part |
| `pixels.<list>.jumps[]` | per jump: composed from cached pages or not, `settlePaints` (0: no paint after the first one, the frame is final), `diff` (share of the canvas pixels with a channel more than 16 levels apart), its bounding box |

Device facts in `scrollSmoothness.device`: user agent, platform and browser labels, device pixel ratio, screen and viewport, pointer (`coarse` on a phone), the measured refresh rate, the polyfill's mode and version, the raster scale it chose (`stats.snapshot.rasterScale`), the canvas backing store and CSS size, the states of the drawable canvases on the page. `canvasInView` per part records whether the whole canvas was on screen when it began (the compositor plans a list only when all of its port is on screen).

**Verdicts.** The scripted part and the tester's part are judged alike; a part with fewer than 20 moves is not judged.

| | green | amber | red |
|---|---|---|---|
| moves painted (`paintedShare`) | >= 85 % | between | < 60 % |
| stutters per second of movement | <= 0.5 | between | > 2 |
| scroll frames: worst `diff` | <= 0.01 % | <= 1 % | > 1 %, or a jump not repainted, or a blank canvas |

Basis (the numbers of the benches, CHANGELOG 0.1.0-preview.9 and this page):

- **Moves painted.** A scripted scroll moves the list in every frame, so the benches' "canvas updates per second" over the frame rate is this share. With the scroll compositor a 60 Hz scripted scroll updates the canvas in 58-59 of 60 frames (0.97-0.98: desktop Safari 27; the iOS Simulator, scroll-and-resize example; this page: 0.99 in the Simulator, 1.0 in headless Chrome). With a rebuild per step (WebKit before 0.1.0-preview.9) 25-30 of 60 (0.42-0.5), 23 of 60 with 8 ms of extra work per frame; Chrome with the compositor refused at 4x CPU throttling 16-30 of 60. Green leaves room below the composed path for a slower device; red sits above the best rebuild-per-step rate measured. The control `smooth-drop` (every other paint dropped) scores 0.49: red.
- **Stutters.** One scripted part is three scrolls of about 1.3 s at 60 Hz (about 4 s of movement on this page: 4.25 s in headless Chrome, 3.8 s in the iOS Simulator, where offsets are whole css px). With the compositor the benches counted 0-1 stutters per run (at most 0.25 per second), 2-5 with 8 ms of extra work per frame (0.5-1.2 per second); with a rebuild per step 5-7 per run in the Simulator (1.2-1.7 per second), about 30 in desktop Safari (7 per second), 47-50 with the extra work (11-12 per second).
- **Scroll frames.** G-mobile's `scrollCompose` accepts only antialiased pixels of a rounded port's arc (0-3 of about 250 at DPR 3); on this page the iOS Simulator measured at most 0.0005 % (6 pixels of the 1128 x 1134 canvas, at the bottom right corner of the Rounded list). A row border one device pixel off (desktop Safari 27 before the exact stand-in lengths) was 0.1-0.17 % of the canvas: amber, a slight jump when the scroll settles. A whole frame 1 css px off (the control `smooth-shift`) is 13-14 %: red. Headless Chrome at DPR 1.25 with classic scrollbars measures 0.15-0.23 % (the scrollbar thumb of a composed frame): amber, a known difference (`KNOWN_RED` in `scripts/check-field-test.mjs`).

On a phone the step measures the phone: the iOS Simulator runs on the Mac's CPU, and its numbers (`node test/bench/field-smoothness-ios.mjs`) show WebKit's code paths, not a phone's frame times. Safari on an iPhone may run animation frames at 60 Hz on a 120 Hz display; `frameMs` records what it ran.

**On an iPhone**: open the page in Safari, press Start in each step (the capture step says the capture is not available: Continue), and in "Scroll smoothness" keep the phone still while the page scrolls the lists by itself, then flick the Rounded list (the left one, inside the canvas) up and down until the prompt says "Thank you". Flicks that start outside the list scroll the page instead and are not counted.

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
| `scrollSmoothness` | the scroll smoothness step (null when it did not start; `complete: false` when it was skipped part-way): `device`, `script.round` / `script.square`, `pixels`, `touch` (with `outcome`: `done`, `timeout`, `skipped`), `verdict` (per part and `overall`), the `thresholds` the page used, `method` |
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

Other limits: the timings run with the page's own measuring code active (one small canvas readback per frame during typing and scrolling; the scroll smoothness step reads no pixels while it times, only `paint` events); the capture's frame rate is the browser's (the settings are recorded); a 1-px shift between the boxes is absorbed by the shift search and reported, not judged; hovering the boxes during the picture check changes them (the instructions ask the tester not to touch anything).

## Self-check and automated test

The footer has a "Self-check (for developers)" button: the oracle must pass identical pictures, a 1 px offset and +-6 levels of noise, and fail a 4 px offset, text in another colour and a blank picture; with an active capture, box B grabbed twice must pass (the noise floor of the capture); and it reports whether the report built so far validates.

`npm run test:field` (`scripts/check-field-test.mjs`, after `npm run build`; `--headed` for a visible window) runs the page end to end in headless Chrome with trusted input, the capture accepted through `--auto-select-tab-capture-source-by-title`:

- `clean`: every step; the capture calibrates without changing the device pixel ratio; the five picture comparisons, the comparison where the scrolling stopped and the form at rest at an emulated 125 % zoom (`Emulation.setDeviceMetricsOverride`: the page sees `devicePixelRatio` change as with Ctrl and +) pass; typing and scrolling are measured in the canvas and on screen; the report downloads through the page's button, validates and stays within the crop budget; the self-check passes.
- `dpr125`: the same at a device pixel ratio of 1.25 (`--force-device-scale-factor=1.25`, the common Windows setting), without the zoom step.

Each run pins its scrollbars (`clean` and the others overlay, `dpr125` classic; `--scrollbars=overlay|classic` sets all), never the system setting, which macOS switches on its own. The
emulated zoom sets `devicePixelRatio` but not the ResizeObserver device-pixel-content-box, so the page's canvases keep their 1x backing store during the zoom step and are shown
upscaled; with classic bars the page scrollbar puts that canvas on half a pixel and the comparison failed at 4.4 % (overlay: 0 %). A real zoom or device scale resizes the canvas
(the `dpr125` run: a 423 px grid for the 338.4 css px box), so testers do not see this.
- `broken` (positive control): `drawElementImage` is wrapped to draw 8 grid px lower; every picture comparison must fail and keep its diff picture.
- `clean` and `dpr125` also run the scroll smoothness step, with a trusted wheel stream over the Rounded list as the tester's scrolling: every part measured, the report's record complete, green in headless Chrome at DPR 1 (`dpr125`: the scroll frames are amber, a known difference listed in the script).
- `smooth-drop` (positive control of the scroll metrics): every second `paint` event of the smoothness canvas is stopped before the page's `onpaint`, a canvas that updates in every other frame: the scripted part must be red. The tester does not scroll: the part ends by its (shortened) timeout and is recorded as skipped.
- `smooth-shift` (positive control of the scroll frames): the first paint after each scroll of a list is drawn 1 px lower: the scroll frames must be red. The tester presses "I cannot scroll here".
- `phone`: the scroll smoothness step on an emulated phone (390 x 844 css px, a device pixel ratio of 3, touch): the page has no horizontal scroll, the prompt and the whole canvas are on screen when the touch part starts, the step asks for a finger, and touch flicks with their fling (`Input.synthesizeScrollGesture`) over the Rounded list are measured as the tester's scrolling. The emulation sets `devicePixelRatio` but not the canvas's device-pixel-content-box, so that canvas is rasterised at 1x: the run checks the layout and the touch path, not a phone's raster.
- `denied`: `getDisplayMedia` rejects; the report records `denied` and the canvas-only checks still run.
- `refused`: the user agent says Chrome 120; the polyfill refuses and the page still produces a valid report with the refusal.
- `missing`: the core bundle answers 404; the page still produces a valid report.

`npm run test:pages` also loads the page as part of the Pages site.

`node test/bench/field-smoothness-ios.mjs` (reported data) runs the scroll smoothness step in Mobile Safari on the iOS Simulator through `safaridriver`, every other step skipped through the page's buttons: the scripted part and the scroll frames are measured; the tester's part cannot be driven there, so it runs once to its timeout (shortened through `window.__fieldTestOptions`) and once with "I cannot flick here", and the report must validate.
