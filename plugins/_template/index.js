/**
 * PLUGIN TEMPLATE (plugins/README.md): the smallest complete spatial effect plugin. It shifts the picture right by `offset` CSS pixels,
 * and has one action: `handle.trigger('shift', { offset })` moves the picture and resolves 'still' once a frame shows it.
 * Copy this folder to plugins/<name>/, rename `meta.name` and `plugin.type` to <name>, and replace the shader, the mapper and the action
 * (or drop `actions`, `runAction` and `settled` when the plugin has nothing to trigger).
 *
 * Contract of a plugin folder: index.js exports `meta` and `plugin`; it imports only files of its own folder, plugins/_lib/ and
 * src/effects/no-target.js (NO_TARGET, the mapper's answer for "no element here"); .wgsl files are loaded
 * through ./wgsl.js (the build inlines them); README.md; test/*.test.mjs. Folders whose name starts with '_' are not built.
 */

import { wgsl } from './wgsl.js';

/** @typedef {import('../../src/contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../../src/contracts/types.js').InputPoint} InputPoint */

/** Read by the build (manifest) and the plugin gallery. `defaults` are the options the gallery passes to addPlugin. */
export const meta = Object.freeze({
  name: 'template',
  title: 'Offset (template)',
  description: 'Shifts the picture sideways; the smallest complete spatial plugin, with an input mapper.',
  defaults: Object.freeze({ offset: 24 }),
  reducedMotion: 'Nothing moves on its own: the picture is shifted, not animated.',
});

/** floats in the uniform block: resolution (2), css_width, offset_px */
const UNIFORM_FLOATS = 4;
const MAX_OFFSET = 200;

/** @param {unknown} v */
const clampOffset = (v) => Math.min(MAX_OFFSET, Math.max(0, Number(v) || 0));

/**
 * The input mapper formula, the twin of fs() in offset.wgsl: the presented point `point` shows the source at the returned point. PURE.
 * @param {number} offset  CSS px the frame was shifted by
 * @param {InputPoint} point  canvas CSS px, plus the presented size
 */
export function mapOffsetPoint(offset, point) {
  return { x: Math.max(0, point.x - offset), y: point.y };
}

/** @type {EffectPluginDefinition} */
export const plugin = Object.freeze({
  type: 'template',
  apiVersion: /** @type {const} */ (2),
  version: 1,
  // the pass only writes its destination as a same-format colour attachment (it never samples or reads it)
  outputCapabilities: Object.freeze({ directCanvasRenderAttachment: /** @type {const} */ (true) }),
  // the names handle.trigger accepts; the host checks them, so runAction only sees these
  actions: Object.freeze(['shift']),
  async create(context, options) {
    const { device, format } = context;
    const module = device.createShaderModule({ code: await wgsl('offset.wgsl'), label: 'template-plugin' });
    const pipeline = device.createRenderPipeline({
      layout: 'auto', label: 'template-plugin',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    const usage = /** @type {any} */ (globalThis).GPUBufferUsage;
    const uniforms = device.createBuffer({ size: UNIFORM_FLOATS * 4, usage: usage.UNIFORM | usage.COPY_DST });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const data = new Float32Array(UNIFORM_FLOATS);
    const bindGroups = new WeakMap();   // one per source view: the host may replace the source texture on resize
    let offset = clampOffset(options?.offset ?? meta.defaults.offset);
    let rendered = offset;              // the offset of the last rendered frame, frozen into its mapper
    /** @type {((state: string|null) => void)[]} */ const waiters = [];   // settled() calls waiting for the next frame
    const settled = () => (rendered === offset ? 'still' : new Promise((resolve) => { waiters.push(resolve); }));

    return {
      spatial: true,       // pixels move: the host requires captureInputMapper
      setOptions(next) {
        if (next?.offset !== undefined) offset = clampOffset(next.offset);
        context.requestRender();   // not `continuous`: the host renders only when the source changed or on request
      },
      // the action 'shift': resolve with the state the plugin rests in once a frame shows it (the host handles validation and superseding)
      runAction(_action, actionOptions) {
        if (actionOptions.offset !== undefined) offset = clampOffset(actionOptions.offset);
        context.requestRender();
        return settled();
      },
      // resolves once nothing moves: here, once the frame with the current offset was rendered
      settled,
      render(frame) {
        rendered = offset;
        data[0] = frame.width; data[1] = frame.height; data[2] = frame.cssWidth; data[3] = offset;
        device.queue.writeBuffer(uniforms, 0, data);
        let bindGroup = bindGroups.get(frame.sourceView);
        if (!bindGroup) {
          bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: uniforms } }, { binding: 1, resource: sampler }, { binding: 2, resource: frame.sourceView }],
          });
          bindGroups.set(frame.sourceView, bindGroup);
        }
        const pass = frame.encoder.beginRenderPass({
          colorAttachments: [{ view: frame.destinationView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        });
        if (frame.sourceReady) { pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.draw(3); }
        pass.end();
        for (const resolve of waiters.splice(0)) resolve('still');
      },
      // called each time a frame is PRESENTED: freeze what that frame used, a later render must not change this mapper
      captureInputMapper() {
        const frozen = rendered;
        return (point) => mapOffsetPoint(frozen, point);
      },
      // optional: the plugin's own controls, as ordinary HTML (they can live inside the drawn form)
      mountUI(root, ui) {
        const label = root.ownerDocument.createElement('label');
        label.textContent = 'Offset ';
        const range = root.ownerDocument.createElement('input');
        Object.assign(range, { type: 'range', min: '0', max: String(MAX_OFFSET), step: '1', value: String(ui.getOptions().offset ?? offset) });
        const onInput = () => ui.setOptions({ offset: Number(range.value) });
        range.addEventListener('input', onInput);
        label.append(range);
        root.append(label);
        return () => { range.removeEventListener('input', onInput); label.remove(); };
      },
      destroy() {
        for (const resolve of waiters.splice(0)) resolve(null);   // removed before its frame: null
        uniforms.destroy?.();
      },
    };
  },
});
