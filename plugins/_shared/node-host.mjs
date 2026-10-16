// A plugin behind the REAL handle of the effects host (src/effects/effect-plugins.js) in Node, over a fake GPU device: handle.trigger,
// handle.settled, setOptions, setEnabled, remove and the plugin's own context.trigger / ui.trigger run the host's code; the test calls
// instance.render(frame) itself. For the Node tests of plugins with actions (plugins/README.md, "Tests").
import { createPluginSet } from '../../src/effects/effect-plugins.js';

/**
 * @param {any} plugin  the definition
 * @param {Record<string, unknown>} options  addPlugin options
 * @param {{device: any, canvas: any, source: any, format?: string, reducedMotion?: boolean}} o  `canvas` needs add/removeEventListener (context.listen)
 */
export async function nodeHandle(plugin, options, { device, canvas, source, format = 'bgra8unorm', reducedMotion = false }) {
  /** @type {{error: unknown, phase: string}[]} */ const errors = [];
  let renders = 0;
  const set = createPluginSet(/** @type {any} */ ({ registry: { get: () => null } }), canvas, source, {
    gpu: () => ({ adapter: null, device, format }),
    viewport: () => ({ width: 1, height: 1, cssWidth: 1, cssHeight: 1, dpr: 1 }),
    requestRender: () => { renders += 1; },
    reducedMotion: () => reducedMotion,
    reportError: (error, _slot, phase) => { errors.push({ error, phase }); },
  });
  const handle = await set.add(plugin, options);
  return {
    handle, set, errors,
    /** the live instance (another one after set.recreate()) */
    get inst() { return /** @type {any} */ (set.stages()[0]?.instance ?? null); },
    requests: () => renders,
  };
}
