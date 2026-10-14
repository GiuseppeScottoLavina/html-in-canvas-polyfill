/**
 * Option resolution and defaults.
 * Module: api-core. Implemented. Pure (no DOM): unit-tested under node.
 */

import { EXT } from '../contracts/events.js';

/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').HicOptions} HicOptions */
/** @typedef {import('../contracts/types.js').ResolvedOptions} ResolvedOptions */

/** @type {Readonly<import('../contracts/types.js').ResolvedOptions>} defaults of every option (docs/API-CONTRACT.md section 10) */
export const DEFAULT_OPTIONS = Object.freeze({
  mode: 'auto', onUnsupportedBrowser: 'throw', onUnsupportedContent: 'placeholder', legacyNames: true, defaultFrameCap: 0,
  maxDpr: 2.5, maxSnapshotFps: 60, maxSurfacePixels: 33554432, interactionFloorFps: 0, inkMargin: 24,
  coherentPaint: true, coherenceMaxWaitMs: 50, paintGateMaxWaitMs: 400, parentFacade: true, stackingAudit: 'report', maxTotalSurfaceBytes: 536870912,
  nodeBudget: Object.freeze({ soft: 350, hard: 3000, absolute: 20000 }), selectorBridge: 'both', strictResources: false,
  forcePolyfill: false, trace: false, autoDiscover: true,
});

/** Options that exist on HicOptions but are not part of ResolvedOptions (they live on the env). */
const ENV_ONLY = new Set(['window', 'document']);

const ENUMS = /** @type {const} */ ({
  mode: ['auto', 'polyfill', 'native-only'],
  onUnsupportedBrowser: ['throw', 'warn'],
  onUnsupportedContent: ['placeholder', 'abort'],
  stackingAudit: ['report', 'off'],
  selectorBridge: ['off', 'queries', 'css', 'both'],
});

const BOOLEANS = ['legacyNames', 'coherentPaint', 'parentFacade', 'strictResources', 'forcePolyfill', 'trace', 'autoDiscover'];

/**
 * Numeric options: [name, minimum, whether the minimum is exclusive]. Every value must be a finite number.
 * @type {ReadonlyArray<readonly [string, number, boolean]>}
 */
const NUMBERS = [
  ['maxDpr', 1, false], ['maxSnapshotFps', 0, false], ['maxSurfacePixels', 0, true], ['interactionFloorFps', 0, false], ['inkMargin', 0, false],
  ['coherenceMaxWaitMs', 0, false], ['paintGateMaxWaitMs', 0, false], ['maxTotalSurfaceBytes', 0, true],
];
/** Pixel and byte budgets are whole numbers: a fraction is a typo for a different unit. */
const INTEGERS = new Set(['maxSurfacePixels', 'maxTotalSurfaceBytes']);

/** @param {string} name @param {unknown} v @returns {string} */
const describe = (name, v) => `option "${name}" (got ${typeof v === 'string' ? JSON.stringify(v) : String(v)})`;

/** @param {Record<string, unknown>} src @param {Record<string, unknown>} out */
function checkEnums(src, out) {
  for (const [name, allowed] of Object.entries(ENUMS)) {
    const v = src[name];
    if (v === undefined) continue;
    if (!allowed.includes(/** @type {never} */ (v))) throw new TypeError(`${describe(name, v)} must be one of ${allowed.map((a) => `"${a}"`).join(', ')}`);
    out[name] = v;
  }
}

/** @param {Record<string, unknown>} src @param {Record<string, unknown>} out */
function checkBooleans(src, out) {
  for (const name of BOOLEANS) {
    const v = src[name];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') throw new TypeError(`${describe(name, v)} must be a boolean`);
    out[name] = v;
  }
}

/** @param {Record<string, unknown>} src @param {Record<string, unknown>} out */
function checkNumbers(src, out) {
  for (const [name, min, exclusive] of NUMBERS) {
    const v = src[name];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${describe(name, v)} must be a finite number`);
    if (exclusive ? v <= min : v < min) throw new TypeError(`${describe(name, v)} must be ${exclusive ? '>' : '>='} ${min}`);
    if (INTEGERS.has(name) && !Number.isInteger(v)) throw new TypeError(`${describe(name, v)} must be an integer`);
    out[name] = v;
  }
  const cap = src.defaultFrameCap;
  if (cap !== undefined) {
    if (typeof cap !== 'number' || !Number.isFinite(cap)) throw new TypeError(`${describe('defaultFrameCap', cap)} must be a finite number`);
    if (cap !== 0 && (cap < EXT.FRAME_CAP_MIN || cap > EXT.FRAME_CAP_MAX)) {
      throw new TypeError(`${describe('defaultFrameCap', cap)} must be 0 (uncapped) or between ${EXT.FRAME_CAP_MIN} and ${EXT.FRAME_CAP_MAX} fps`);
    }
    if (!Number.isInteger(cap)) throw new TypeError(`${describe('defaultFrameCap', cap)} must be an integer`);
    out.defaultFrameCap = cap;
  }
}

/** @param {unknown} v @returns {Readonly<import('../contracts/types.js').NodeBudget>} */
function resolveNodeBudget(v) {
  if (v === undefined) return DEFAULT_OPTIONS.nodeBudget;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new TypeError(`${describe('nodeBudget', v)} must be an object {soft, hard, absolute}`);
  const src = /** @type {Record<string, unknown>} */ (v);
  const merged = { ...DEFAULT_OPTIONS.nodeBudget };
  for (const key of Object.keys(src)) {
    if (!Object.hasOwn(merged, key)) throw new TypeError(`unknown nodeBudget member "${key}" (expected soft, hard, absolute)`);
    const n = src[key];
    if (n === undefined) continue;
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) throw new TypeError(`${describe(`nodeBudget.${key}`, n)} must be a positive finite number`);
    merged[/** @type {keyof typeof merged} */ (key)] = n;
  }
  if (!(merged.soft <= merged.hard && merged.hard <= merged.absolute)) {
    throw new TypeError(`option "nodeBudget" must satisfy soft <= hard <= absolute (got ${merged.soft}, ${merged.hard}, ${merged.absolute})`);
  }
  return Object.freeze(merged);
}

/**
 * Merge user options over DEFAULT_OPTIONS, validate every field, freeze the result.
 * Window/document are NOT part of ResolvedOptions (they live on HicEnv). An unknown option name is an error (a typo must not be silent).
 * @param {HicOptions} [options]
 * @returns {Readonly<ResolvedOptions>}
 * @throws TypeError on an invalid field (wrong type, unknown enum value, negative cap, unknown name)
 */
export function resolveOptions(options) {
  if (options === undefined || options === null) return Object.freeze({ ...DEFAULT_OPTIONS });
  if (typeof options !== 'object' || Array.isArray(options)) throw new TypeError(`install options must be an object (got ${typeof options})`);
  const src = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (options));
  for (const key of Object.keys(src)) {
    if (!Object.hasOwn(DEFAULT_OPTIONS, key) && !ENV_ONLY.has(key)) throw new TypeError(`unknown option "${key}"`);
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  checkEnums(src, out);
  checkBooleans(src, out);
  checkNumbers(src, out);
  const nodeBudget = resolveNodeBudget(src.nodeBudget);
  return Object.freeze(/** @type {ResolvedOptions} */ ({ ...DEFAULT_OPTIONS, ...out, nodeBudget }));
}
