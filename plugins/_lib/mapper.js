/**
 * The input mapper of one presented frame over a Float32Array of mapper state that the plugin writes per frame (plugins/_lib/: bundled
 * into each plugin that imports it).
 */

/** @typedef {import('../../src/contracts/types.js').InputMapper} InputMapper */

/**
 * `map(state, point)` over the live `state`; `captureGestureSnapshot()` maps through a copy taken at the call, so a drag keeps one mapping.
 * @param {Float32Array} state
 * @param {(state: Float32Array, point: import('../../src/contracts/types.js').InputPoint) => {x: number, y: number}} map
 * @returns {InputMapper}
 */
export function stateMapper(state, map) {
  /** @type {InputMapper} */
  const mapper = (point) => map(state, point);
  mapper.captureGestureSnapshot = () => {
    const frozen = new Float32Array(state);
    return (point) => map(frozen, point);
  };
  return mapper;
}
