/**
 * Top layer and managed canvases: fullscreen allowed with its input limit reported, popover canvases refused (feature top-layer-canvas, docs/ARCHITECTURE.md ADR-L).
 * Module: api-surface (src/api/*).
 */

/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').PatchLedger} PatchLedger */

const HINT = 'request fullscreen on an ancestor container (the live layer is a sibling of the canvas and is then inside the fullscreen subtree)';

/** @param {HTMLCanvasElement} canvas @returns {string} */
function describe(canvas) {
  return canvas.id ? `canvas#${canvas.id}` : 'canvas';
}

/**
 * Registry hook: a canvas with a `popover` attribute cannot be managed (the popover would put the canvas, not its layer, in the top layer).
 * Reports the refusal and returns true; the caller leaves the canvas unmanaged.
 * @param {HicEnv} env
 * @param {HTMLCanvasElement} canvas
 * @returns {boolean} the canvas is refused
 */
export function refusePopoverCanvas(env, canvas) {
  if (!canvas.hasAttribute('popover')) return false;
  env.reporter.unsupported({
    feature: 'top-layer-canvas',
    message: 'A canvas with a popover attribute cannot have content="drawable": the popover would move the canvas to the top layer and leave its live layer behind.',
    hint: 'put the popover attribute on an ancestor container instead',
    path: describe(canvas),
  }, canvas);
  return true;
}

/**
 * Fullscreen of a MANAGED canvas (docs/ARCHITECTURE.md ADR-L.4). requestFullscreen is not wrapped: the canvas goes fullscreen and draws exactly as natively (WPT fullscreen-canvas).
 * Its live layer is a sibling outside the fullscreen subtree, which Chrome makes inert while an element is fullscreen (measured on Chrome 155: the live input is not focusable and
 * not hit, even after promoting the layer to the top layer with popover=manual + showPopover()), so the drawn controls take no input while the canvas is fullscreen.
 * That limit is reported loudly, once per canvas path, when the canvas becomes the fullscreen element. A canvas with a `popover` attribute is still refused at mount (refusePopoverCanvas).
 * @param {HicEnv} env
 * @param {PatchLedger} _ledger
 * @returns {() => void} remover
 */
export function installFullscreenGuard(env, _ledger) {
  const doc = env.document;
  const onChange = () => {
    const fs = /** @type {any} */ (doc).fullscreenElement ?? /** @type {any} */ (doc).webkitFullscreenElement ?? null;
    const record = fs ? env.registry.get(fs) : null;
    if (!record || (record.state !== 'active' && record.state !== 'suspended')) return;
    const canvas = /** @type {HTMLCanvasElement} */ (fs);
    env.reporter.unsupported({
      feature: 'top-layer-canvas',
      message: 'The canvas is fullscreen: it draws as usual, but its live layer is outside the fullscreen subtree, which the browser makes inert, so the drawn controls take no pointer, focus or keyboard input until fullscreen ends.',
      hint: HINT, path: describe(canvas),
    }, canvas);
  };
  const events = ['fullscreenchange', 'webkitfullscreenchange'];
  for (const type of events) doc.addEventListener(type, onChange, true);
  return () => { for (const type of events) doc.removeEventListener(type, onChange, true); };
}
