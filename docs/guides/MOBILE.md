# Phones and tablets

The polyfill runs on Chrome for Android 130+ and on Safari for iOS and iPadOS 26+. **Everything on this page was verified on the iOS Simulator and the Android Emulator,
never on a physical device.** The numbers are in `docs/SUPPORT-MATRIX.md` (section "Mobile"); the gate that produces them is `npm run test:mobile` (`docs/TEST-PLAN.md`).

## Which browsers install it

| browser | what happens | how it is decided |
|---|---|---|
| Safari on iOS 26+ (iPhone) | polyfill | `Version/` major of the user agent (the OS token is frozen at `18_x` since iOS 26) |
| Safari on iPadOS 26+ | polyfill, treated as iOS | iPadOS sends the macOS user agent; a `Macintosh` agent with more than one touch point (`navigator.maxTouchPoints`) is iPadOS (a Mac reports 0). "Request Desktop Website" on an iPhone is caught the same way |
| Chrome, Firefox, Edge, Opera, ... on iOS | polyfill | every iOS browser is WebKit; their agents (`CriOS/`, `FxiOS/`, `EdgiOS/`, ...) carry no WebKit version, so they are admitted by the required features alone (CSS anchor positioning arrived in WebKit 26) |
| Chrome for Android 130+ | polyfill; where the browser implements HTML-in-Canvas itself, the polyfill steps aside (native-first, as on desktop) | Chromium major from `userAgentData` or the agent; "Request desktop site" (a Linux agent) is still Android through `userAgentData.platform`. Measured: Chromium 158.0.8108.0 for Android ships the native API without a flag (kind `complete`): mode `native` |
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
  pans the visual viewport so the field stays visible (measured with Chromium 158: 754 -> 442 px).
- **Selection.** A long press selects a word in the live field; the system selection handles and menu belong to the live element and line up with the drawn copy.
- **Selecting text drawn outside fields.** The desktop gesture (a double click on the canvas itself, row `selection-through-canvas`) is a mouse gesture and was not measured with touch; on a phone, long-press a drawn field instead.
- **Scrolling.** A finger drag over a drawn scroller scrolls the live scroller, not the page; a drag over the canvas outside drawn scrollers scrolls the page. A scroller
  that the scroll compositor accepts is drawn from its cached pages at each step (on iOS too), and the exact picture follows when the scroll stops. The scroll-and-resize
  example under a scripted scroll on the iOS Simulator (iPhone 17 Pro, DPR 3): 58 canvas updates per second instead of 30 before 0.1.0-preview.9. The Simulator runs on
  the Mac's CPU, so a phone is slower.
- **Rotation.** The canvas, its backing store and the hit testing follow the new size.
- **Effects.** The effect plugins re-target touch input like mouse input (unit-tested with touch pointer events), but neither simulator has a WebGPU adapter, so effects
  with touch were not run.

## Pinch-zoom

Pinch-zoom magnifies the page, and with it the canvas bitmap: the canvas is not rastered again for `visualViewport.scale`, so drawn text gets soft when zoomed in. A native
canvas, and the native HTML-in-Canvas API, behave the same way (the bitmap follows `devicePixelRatio`, which pinch-zoom does not change). Taps after zooming still land on the
right element (measured on the Android Emulator with a 2.2x pinch).

## What is not verified

- No physical iPhone, iPad or Android phone: memory and canvas limits, frame timing, battery, a real GPU.
- Chrome for Android between 130 and 157: the Android results come from Chromium 158.0.8108.0 (a Chromium snapshot's `ChromePublic.apk`, no flags, its real user
  agent), **verified on the Android Emulator with Chromium 158**. That Chromium implements HTML-in-Canvas natively, so the polyfill steps aside there; the polyfill's own
  path was run on the same engine with `install({ forcePolyfill: true })` (a test-only option). A Chrome for Android release without the native API was not run (the
  emulator image's own Chrome 124 is below the minimum and serves the refusal).
- A scrolled listbox (`<select size>`) in the light scheme: its option text sits about 2 device pixels off the page's inside the snapshot on Chromium for Android (2.4 % of
  its pixels over 100 levels; the gate allows 4 % for that one region, every other of the 62 regions is within 1.5 %).
- On the iOS Simulator, WebDriver cannot drag a finger (the session hangs), type text, show the virtual keyboard, rotate the device or long-press: those scenarios are
  skipped there and documented; they ran on Android.
- iOS 27: not run. The iOS 27.0 simulator runtime is installed, but no `safaridriver` offers it as a session host: neither Safari 27.0.1's nor Safari Technology
  Preview 254's (Xcode 27 ships none). With `safari:deviceUDID` the driver answers "Could not find any session hosts" at once, without contacting the device; without it the
  driver boots an iOS 26.4 simulator instead. Inside the simulator everything was in place: remote automation and the developer extras on (`com.apple.WebInspector` and
  `com.apple.mobilesafari`), the system Automation Mode on, Mobile Safari running and connected to the simulator's `webinspectord`. It needs a `safaridriver` that lists iOS 27
  simulators (a later Safari or macOS update).
- WebGPU effect plugins with touch.

## Running the mobile gate

`npm run test:mobile` needs a full Xcode with an iOS 26 simulator runtime (Mobile Safari is driven by `safaridriver` with `safari:useSimulator`) and the Android SDK with an AVD
(`ANDROID_AVD_HOME`, `--avd=<name>`, default `hicmobile`). One simulator or emulator runs at a time and is shut down afterwards. Options: `--platform=ios|android`,
`--only=<scenarios>`, `--ios-devices=<udid,...>`, `--ipad=<udid>|none`, `--ios-old=<udid>|none`, `--android-package=<package>`, `--no-stand-in`. The simulator's Safari must allow
remote automation: the gate writes that setting into the simulated device when it is missing (it is a setting of the simulator, not of the Mac).

Android browser: the gate drives the newest browser installed on the AVD. To run a current Chromium, install the `ChromePublic.apk` of a Chromium snapshot
(`https://commondatastorage.googleapis.com/chromium-browser-snapshots/index.html?prefix=Android_Arm64/`, `chrome-android.zip`, about 436 MB; the object's MD5 is in its
storage metadata) with `adb install -r ChromePublic.apk`; its first-run screens are dismissed by the gate. When the only browser is the image's Chrome 124, the polyfill scenarios
run as a labelled stand-in (the anchor-positioning flag and a Chromium 130 user agent). When the browser implements HTML-in-Canvas natively, the scenario `nativeFirst` checks
that the polyfill steps aside and the native result passes, and the other scenarios force the polyfill's path (`test/mobile/force-polyfill.js`).
