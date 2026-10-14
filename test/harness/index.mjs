// Public surface of the harness. `import * as H from '/abs/path/test/harness/index.mjs'`
export * from './lib/util.mjs';
export { CDPConnection, CdpTimeoutError } from './lib/cdp-conn.mjs';
export { launchChrome, Browser, CHROME_APPS, DEFAULT_TRACE_CATEGORIES, assertProfilePath } from './lib/chrome.mjs';
export { Page } from './lib/page.mjs';
export * from './lib/input.mjs';
export * from './lib/window.mjs';
export { analyzeTrace, analyzeEvents, loadTraceEvents } from './lib/trace.mjs';
export { summarizeCpuProfile, formatProfileTable } from './lib/cpuprofile.mjs';
export { environmentFacts, NATIVE_PROBE_EXPR, SCROLLBAR_PROBE_EXPR } from './lib/env.mjs';
export * from './lib/pixels.mjs';
export { decodePng, encodePng } from './lib/png.mjs';
export { referenceDiff, readCanvas, screenshotElement } from './lib/oracle-pixel.mjs';
export { startBlankDetector, analyseBlank, assertNoBlankFrames, proveBlankDetector } from './lib/oracle-blank.mjs';
export { measureLatency } from './lib/oracle-latency.mjs';
export { loadSnapshot, waitForQuiet } from './lib/load.mjs';
export { startBusyMain } from './lib/busy.mjs';
export { FIXTURES, fixtureUrl, checkBundle, openFixture, openPair } from './lib/fixtures.mjs';
export { startServer } from './server.mjs';
