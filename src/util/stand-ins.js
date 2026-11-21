/**
 * The services an install over a browser's own HTML-in-Canvas does not have, as stand-ins: shared by the core's native composition (api/compose.js) and the
 * effects over a native implementation without the core (src/effects.js).
 * Module: util.
 */

/**
 * An object that throws a clear error on any property access or call.
 * @param {string} name
 * @param {string} cause
 * @returns {any}
 */
export function unavailable(name, cause) {
  const fail = () => {
    throw new Error(`[hic-live-polyfill] service "${name}" is not available: ${cause}`);
  };
  return new Proxy(function standIn() {}, {
    get: (_target, prop) => (typeof prop === 'symbol' || prop === 'then' ? undefined : fail()),
    set: fail,
    apply: fail,
  });
}

/** No canvas is the polyfill's: the browser draws every one. */
export const NO_CANVASES = Object.freeze({
  get: () => undefined,
  all: () => [],
  ownerOfDrawable: () => undefined,
  logicalCanvasAncestor: () => null,
});

/** No interaction state is tracked: the browser keeps its own. */
export const NO_INTERACTION = Object.freeze({
  snapshot: () => ({ hover: new Set(), active: new Set(), focus: null, focusVisible: false, caretVisible: false }),
  setMappedTarget: () => {},
  onChange: () => () => {},
});
