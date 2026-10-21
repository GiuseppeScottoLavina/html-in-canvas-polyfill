// Public surface of the harness. `import * as H from '/abs/path/test/harness/index.mjs'`
export { PROJECT_ROOT, SCRATCH_DIR, PROFILES_DIR, FRAME_120, sleep, arg, until, stats, assert } from './lib/util.mjs';
export { CdpTimeoutError } from './lib/cdp-conn.mjs';
export { launchChrome, resolveChrome, Browser, DEFAULT_TRACE_CATEGORIES } from './lib/chrome.mjs';
export { Page } from './lib/page.mjs';
export * from './lib/input.mjs';
export * from './lib/window.mjs';
export { analyzeTrace, loadTraceEvents } from './lib/trace.mjs';
export { summarizeCpuProfile, formatProfileTable } from './lib/cpuprofile.mjs';
export { environmentFacts } from './lib/env.mjs';
export * from './lib/pixels.mjs';
export { decodePng, encodePng } from './lib/png.mjs';
export { readCanvas, screenshotElement } from './lib/oracle-pixel.mjs';
export { startBlankDetector } from './lib/oracle-blank.mjs';
export { measureLatency } from './lib/oracle-latency.mjs';
export { loadSnapshot, waitForQuiet } from './lib/load.mjs';
export { fixtureUrl, openFixture, openPair } from './lib/fixtures.mjs';
export { startServer } from './server.mjs';
