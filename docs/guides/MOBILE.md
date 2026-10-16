# Phones and tablets

The polyfill runs on Chrome for Android 130+ and on Safari for iOS and iPadOS 26+. **Everything on this page was verified on the iOS Simulator and the Android Emulator,
never on a physical device.** The numbers are in `docs/SUPPORT-MATRIX.md` (section "Mobile"); the gate that produces them is `npm run test:mobile` (`docs/TEST-PLAN.md`).

## Which browsers install it

| browser | what happens | how it is decided |
|---|---|---|
| Safari on iOS 26+ (iPhone) | polyfill | `Version/` major of the user agent (the OS token is frozen at `18_x` since iOS 26) |
| Safari on iPadOS 26+ | polyfill, treated as iOS | iPadOS sends the macOS user agent; a `Macintosh` agent with more than one touch point (`navigator.maxTouchPoints`) is iPadOS (a Mac reports 0). "Request Desktop Website" on an iPhone is caught the same way |
| Chrome, Firefox, Edge, Opera, ... on iOS | polyfill | every iOS browser is WebKit; their agents (`CriOS/`, `FxiOS/`, `EdgiOS/`, ...) carry no WebKit version, so they are admitted by the required features alone (CSS anchor positioning arrived in WebKit 26) |
| Chrome for Android 130+ | polyfill | Chromium major from `userAgentData` or the agent; "Request desktop site" (a Linux agent) is still Android through `userAgentData.platform` |
| other Chromium browsers on Android (Samsung Internet, Edge, Opera) | polyfill when Chromium 130+ | same engine; not run |
| Android WebView (`; wv)`, `Version/4.0 Chrome/`), in-app iOS web views (no `Safari/` token) | refused: "open the page in the browser" | the engine and its flags belong to the app |
| Firefox for Android | refused | never measured |
| Chrome for Android < 130, Safari on iOS < 26 | refused, version named | measured: the emulator's own Chrome 124 and Safari 18.1 in an iOS 18.1 simulator |

A refusal is one `console.warn` from the classic script and `window.__HIC__.error` (`HicUnsupportedError('browser')`); an ESM `install()` throws. Every browser is also
checked for CSS anchor positioning, `ResizeObserver`, `HTMLImageElement.decode` and constructable stylesheets, and a missing one is named.

On iOS, load the engines bundle with the core, as on desktop Safari: it draws the form controls in the iOS look.

```html
<script src="hic-live-polyfill.iife.min.js"></script>
<script src="hic-live-engines.iife.min.js"></script>
```

## Memory and sharpness

On a phone or tablet the defaults below replace the desktop ones, unless the page sets the option itself (`install({ maxDpr: 2 })` always wins):

| option | desktop | phone / tablet | why |
|---|---|---|---|
| `maxDpr` | 2.5 | 3 | iPhones and many Android phones are DPR 3; at 2.5 their text was upscaled 1.2x and soft (measured on the iOS Simulator). The iOS gate now checks that the snapshot is rastered at scale 3 |
| `maxSurfacePixels` | 33,554,432 | 16,777,216 (4096 x 4096) | WebKit's per-canvas area limit on iOS; a larger surface fails to allocate |
| `maxTotalSurfaceBytes` | 512 MiB | 256 MiB; 128 MiB when `navigator.deviceMemory <= 2` | WebKit caps the canvas memory of an iOS page at a quarter of the RAM (iOS 26 runs on iPhones with 4 GB or more: at least 1 GiB); Chrome for Android runs on 2 GB devices |

These limits come from WebKit's source and device classes, not from a measurement: a simulator allocates from the Mac's memory and never hits them. When a budget is
reached the drawable is rastered at a lower scale and reported (`surface-size`), never dropped. A phone-sized drawable at DPR 3 (390 x 840 css px) costs about 12 MB.

## Touch

- **Tap.** A tap on a drawn element reaches the live element at the drawn place (focus, click, checkbox), also when `drawElementImage` draws it away from its layout box.
- **Typing.** The virtual keyboard and the IME type into the live field; the canvas follows. On Android, tapping a field near the bottom opens the keyboard and the browser
  pans the visual viewport so the field stays visible (measured: 811 -> 451 px).
- **Selection.** A long press selects a word in the live field; the system selection handles and menu belong to the live element and line up with the drawn copy.
- **Selecting text drawn outside fields.** The desktop gesture (a double click on the canvas itself, row `selection-through-canvas`) is a mouse gesture and was not measured with touch; on a phone, long-press a drawn field instead.
- **Scrolling.** A finger drag over a drawn scroller scrolls the live scroller, not the page; a drag over the canvas outside drawn scrollers scrolls the page.
- **Rotation.** The canvas, its backing store and the hit testing follow the new size.
- **Effects.** The effect plugins re-target touch input like mouse input (unit-tested with touch pointer events), but neither simulator has a WebGPU adapter, so effects
  with touch were not run.

## Pinch-zoom

Pinch-zoom magnifies the page, and with it the canvas bitmap: the canvas is not rastered again for `visualViewport.scale`, so drawn text gets soft when zoomed in. A native
canvas, and the native HTML-in-Canvas API, behave the same way (the bitmap follows `devicePixelRatio`, which pinch-zoom does not change). Taps after zooming still land on the
right element (measured on the Android Emulator with a 2.2x pinch).

## What is not verified

- No physical iPhone, iPad or Android phone: memory and canvas limits, frame timing, battery, a real GPU.
- Chrome for Android 130+: the emulator image ships Chrome 124 and cannot update it without a Play sign-in. The Android results come from that Chrome with the
  anchor-positioning flag and a Chromium 130 user agent (a labelled stand-in); its own form-control look (Chrome 124's Android theme) differs from the polyfill's in 27 of 62
  regions and is recorded, not gated.
- On the iOS Simulator, WebDriver cannot drag a finger (the session hangs), type text, show the virtual keyboard, rotate the device or long-press: those scenarios are
  skipped there and documented; they ran on Android.
- iOS 27: the simulator runtime is installed, but Safari 27.0.1's driver does not pair with it.
- WebGPU effect plugins with touch.

## Running the mobile gate

`npm run test:mobile` needs a full Xcode with an iOS 26 simulator runtime (Mobile Safari is driven by `safaridriver` with `safari:useSimulator`) and the Android SDK with an AVD
(`ANDROID_AVD_HOME`, `--avd=<name>`, default `hicmobile`). One simulator or emulator runs at a time and is shut down afterwards. Options: `--platform=ios|android`,
`--only=<scenarios>`, `--ios-devices=<udid,...>`, `--ipad=<udid>|none`, `--ios-old=<udid>|none`, `--no-stand-in`. The simulator's Safari must allow remote automation: the gate
writes that setting into the simulated device when it is missing (it is a setting of the simulator, not of the Mac).
