// Shared by the node tests of api-core: an env on a DOM-free fake window.
import { createBus } from '../../../src/util/bus.js';
import { resolveOptions } from '../../../src/api/options.js';
import { createEnv } from '../../../src/api/env.js';
import { createReporter } from '../../../src/api/report.js';

/** @param {object} [overrides] @returns {any} */
export function fakeWindow(overrides = {}) {
  const logs = { error: /** @type {unknown[][]} */ ([]), warn: /** @type {unknown[][]} */ ([]) };
  return {
    logs,
    console: { error: (/** @type {unknown[]} */ ...a) => logs.error.push(a), warn: (/** @type {unknown[]} */ ...a) => logs.warn.push(a) },
    performance: { now: () => 0 },
    devicePixelRatio: 1,
    navigator: { userAgent: 'fake' },
    CustomEvent: class { constructor(/** @type {string} */ type, /** @type {object} */ init) { this.type = type; Object.assign(this, init); } },
    setTimeout: () => 0, clearTimeout: () => {},
    document: { nodeType: 9 },
    ...overrides,
  };
}

/** @param {import('../../../src/contracts/types.js').HicOptions} [options] @param {any} [win] */
export function fakeEnv(options, win = fakeWindow()) {
  const resolved = resolveOptions(options);
  /** @type {any} */ let reporter = null;
  const bus = createBus((err, topic) => reporter?.caught(err, `bus:${topic}`));
  reporter = createReporter(win, resolved);
  const env = createEnv(win, resolved, bus, reporter, win.document);
  return { env, win, bus, reporter };
}
