/**
 * Plugin definition validation (ABI v2) and plugin context construction.
 * Module: gpu-effects (src/effects/**).
 */

import { typeError } from '../contracts/errors.js';

/** @typedef {import('../contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../contracts/types.js').EffectPluginContext} EffectPluginContext */
/** @typedef {import('../contracts/types.js').EffectPluginInstance} EffectPluginInstance */
/** @typedef {import('../contracts/types.js').EffectRenderFrame} EffectRenderFrame */
/** @typedef {import('../contracts/types.js').EffectPresentationFrame} EffectPresentationFrame */
/** @typedef {import('../contracts/types.js').InputMapper} InputMapper */

const OPTIONAL_METHODS = ['resize', 'setOptions', 'captureInputMapper', 'mountUI', 'runAction', 'settled', 'destroy'];
/** An action name: a lowercase word (it becomes a button label, a log entry, an option value). */
const ACTION_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Definitions already validated and frozen by definePlugin (so a second call is the identity). */
const defined = new WeakSet();

/**
 * @param {EffectPluginDefinition} def
 * @returns {ReadonlyArray<string>|undefined}  the validated, frozen copy of `def.actions`
 */
function readActions(def) {
  const list = /** @type {unknown} */ (def.actions);
  if (list === undefined) return undefined;
  if (!Array.isArray(list) || list.length === 0) throw typeError(`definePlugin(${def.type}): \`actions\` must be a non-empty array of action names when present`);
  for (const name of list) {
    if (typeof name !== 'string' || !ACTION_RE.test(name)) throw typeError(`definePlugin(${def.type}): an action name is a lowercase word (${ACTION_RE}), got ${JSON.stringify(name)}`);
  }
  if (new Set(list).size !== list.length) throw typeError(`definePlugin(${def.type}): \`actions\` lists a name twice`);
  return Object.freeze([...list]);
}

/**
 * Validate (type string, apiVersion 2, version number, create function, optional outputCapabilities and actions), freeze. TypeError on invalid input.
 * @param {EffectPluginDefinition} def
 * @returns {EffectPluginDefinition}
 * @throws TypeError
 */
export function definePlugin(def) {
  if (def && defined.has(def)) return def;
  if (!def || typeof def !== 'object') throw typeError('definePlugin: the definition must be an object');
  if (typeof def.type !== 'string' || def.type === '') throw typeError('definePlugin: `type` must be a non-empty string');
  if (def.apiVersion !== 2) throw typeError(`definePlugin(${def.type}): \`apiVersion\` must be 2, got ${String(def.apiVersion)}`);
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
  const actions = readActions(def);
  /** @type {EffectPluginDefinition} */
  const out = Object.freeze({
    type: def.type, apiVersion: def.apiVersion, version: def.version,
    ...(outputCapabilities ? { outputCapabilities } : {}),
    ...(actions ? { actions } : {}),
    create: def.create,
  });
  defined.add(out);
  return out;
}

/**
 * A spatial instance MUST provide captureInputMapper, and an instance of a definition with actions runAction and settled (TypeError);
 * render is required.
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
  if (def.actions && (typeof inst.runAction !== 'function' || typeof inst.settled !== 'function')) {
    throw typeError(`plugin "${def.type}" declares the actions ${def.actions.join(', ')} and must provide runAction(action, options, info) and settled()`);
  }
  if (!def.actions && inst.runAction !== undefined) throw typeError(`plugin "${def.type}" has runAction but its definition declares no \`actions\``);
  return /** @type {EffectPluginInstance} */ (instance);
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
  const mapper = /** @type {(f: EffectPresentationFrame) => InputMapper} */ (instance.captureInputMapper)(frame);
  if (typeof mapper !== 'function') throw typeError(`plugin "${def.type}": captureInputMapper must return a function`);
  return mapper;
}

/**
 * Context handed to create(): `apiVersion` equals the declared version (2).
 * @param {EffectPluginDefinition} def
 * @param {Omit<EffectPluginContext, 'apiVersion'>} parts
 * @returns {EffectPluginContext}
 */
export function buildPluginContext(def, parts) {
  return /** @type {EffectPluginContext} */ (Object.freeze({ ...parts, apiVersion: def.apiVersion }));
}
