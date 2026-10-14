/**
 * Plugin definition validation, ABI v1 adapter, plugin context construction.
 * Module: gpu-effects (src/effects/**).
 */

import { typeError } from '../contracts/errors.js';

/** @typedef {import('../contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../contracts/types.js').EffectPluginContext} EffectPluginContext */
/** @typedef {import('../contracts/types.js').EffectPluginInstance} EffectPluginInstance */
/** @typedef {import('../contracts/types.js').EffectRenderFrame} EffectRenderFrame */
/** @typedef {import('../contracts/types.js').EffectPresentationFrame} EffectPresentationFrame */
/** @typedef {import('../contracts/types.js').InputMapper} InputMapper */

const OPTIONAL_METHODS = ['resize', 'setOptions', 'captureInputMapper', 'mountUI', 'destroy'];

/** Definitions already validated and frozen by definePlugin (so a second call is the identity). */
const defined = new WeakSet();

/**
 * Validate (type string, apiVersion 1|2, version number, create function), freeze; adapt v1. TypeError on invalid input.
 * A v1 definition is kept as declared (`apiVersion: 1`): the host reads that to hand it the v1 aliases (withV1Fields).
 * @param {EffectPluginDefinition} def
 * @returns {EffectPluginDefinition}
 * @throws TypeError
 */
export function definePlugin(def) {
  if (def && defined.has(def)) return def;
  if (!def || typeof def !== 'object') throw typeError('definePlugin: the definition must be an object');
  if (typeof def.type !== 'string' || def.type === '') throw typeError('definePlugin: `type` must be a non-empty string');
  if (def.apiVersion !== 1 && def.apiVersion !== 2) throw typeError(`definePlugin(${def.type}): \`apiVersion\` must be 1 or 2, got ${String(def.apiVersion)}`);
  if (typeof def.version !== 'number' || !Number.isFinite(def.version)) throw typeError(`definePlugin(${def.type}): \`version\` must be a finite number`);
  if (typeof def.create !== 'function') throw typeError(`definePlugin(${def.type}): \`create\` must be a function`);
  const caps = def.outputCapabilities;
  /** @type {EffectPluginDefinition['outputCapabilities']} */
  let outputCapabilities;
  if (caps !== undefined) {
    if (!caps || typeof caps !== 'object') throw typeError(`definePlugin(${def.type}): \`outputCapabilities\` must be an object`);
    for (const key of Object.keys(caps)) {
      if (key !== 'directCanvasRenderAttachment') throw typeError(`definePlugin(${def.type}): unknown output capability "${key}"`);
    }
    const direct = /** @type {any} */ (caps).directCanvasRenderAttachment;
    if (direct !== undefined && direct !== true) throw typeError(`definePlugin(${def.type}): directCanvasRenderAttachment must be true or absent`);
    if (direct === true) outputCapabilities = Object.freeze({ directCanvasRenderAttachment: /** @type {const} */ (true) });
  }
  /** @type {EffectPluginDefinition} */
  const out = Object.freeze({
    type: def.type, apiVersion: def.apiVersion, version: def.version,
    ...(outputCapabilities ? { outputCapabilities } : {}),
    create: def.create,
  });
  defined.add(out);
  return out;
}

/**
 * A spatial instance MUST provide captureInputMapper (TypeError); render is required.
 * @param {unknown} instance
 * @param {EffectPluginDefinition} def
 * @returns {EffectPluginInstance}
 * @throws TypeError
 */
export function validateInstance(instance, def) {
  if (!instance || typeof instance !== 'object') throw typeError(`plugin "${def.type}": create() must resolve to an object`);
  const inst = /** @type {Record<string, unknown>} */ (instance);
  if (typeof inst.render !== 'function') throw typeError(`plugin "${def.type}": the instance must have a render(frame) function`);
  for (const name of OPTIONAL_METHODS) {
    if (inst[name] !== undefined && typeof inst[name] !== 'function') throw typeError(`plugin "${def.type}": \`${name}\` must be a function when present`);
  }
  for (const flag of ['spatial', 'continuous']) {
    if (inst[flag] !== undefined && typeof inst[flag] !== 'boolean') throw typeError(`plugin "${def.type}": \`${flag}\` must be a boolean when present`);
  }
  if (inst.spatial === true && typeof inst.captureInputMapper !== 'function') {
    throw typeError(`plugin "${def.type}" is spatial and must provide captureInputMapper(frame): without it pointer input cannot follow the displaced pixels`);
  }
  return /** @type {EffectPluginInstance} */ (instance);
}

/**
 * Add the ABI v1 aliases to a frame for a v1 plugin (sourceSnapshotSerial = sourceVersion). Writes into `frame` and returns it: the
 * frame objects are host-owned and per call, so no copy is made on the 120 Hz path.
 * @template {EffectPresentationFrame} F
 * @param {F} frame
 * @returns {F}
 */
export function withV1Fields(frame) {
  /** @type {any} */ (frame).sourceSnapshotSerial = frame.sourceVersion;
  return frame;
}

/**
 * The frame as the plugin's declared ABI sees it.
 * @template {EffectPresentationFrame} F
 * @param {EffectPluginDefinition} def
 * @param {F} frame
 * @returns {F}
 */
export function frameFor(def, frame) {
  return def.apiVersion === 1 ? withV1Fields(frame) : frame;
}

/**
 * Ask a spatial instance for the mapper of exactly the frame just presented.
 * @param {EffectPluginInstance} instance
 * @param {EffectPluginDefinition} def
 * @param {EffectPresentationFrame} frame
 * @returns {InputMapper}
 * @throws TypeError
 */
export function captureMapper(instance, def, frame) {
  const mapper = /** @type {(f: EffectPresentationFrame) => InputMapper} */ (instance.captureInputMapper)(frameFor(def, frame));
  if (typeof mapper !== 'function') throw typeError(`plugin "${def.type}": captureInputMapper must return a function`);
  return mapper;
}

/**
 * Context handed to create(): `apiVersion` equals the DECLARED version (a v1 plugin sees 1).
 * @param {EffectPluginDefinition} def
 * @param {Omit<EffectPluginContext, 'apiVersion'>} parts
 * @returns {EffectPluginContext}
 */
export function buildPluginContext(def, parts) {
  return /** @type {EffectPluginContext} */ (Object.freeze({ ...parts, apiVersion: def.apiVersion }));
}
