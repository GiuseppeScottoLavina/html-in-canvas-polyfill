/**
 * WebGPU plumbing shared by the single-pass example plugins (plugins/_lib/: bundled into each plugin that imports it).
 */

/**
 * One full-screen triangle (`vs` / `fs` of `module`) over the source: binding 0 a uniform block of `floats` floats, 1 a linear clamp
 * sampler, 2 the source view; it draws into the frame's destination, cleared to black. Bind groups are cached per source view and the
 * pass descriptor is reused, so a frame allocates nothing.
 * @param {any} device @param {string} format @param {any} module @param {string} label @param {number} floats
 */
export function fullscreenPass(device, format, module, label, floats) {
  const pipeline = device.createRenderPipeline({
    layout: 'auto', label,
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  const usage = /** @type {any} */ (globalThis).GPUBufferUsage;
  const uniforms = device.createBuffer({ label, size: floats * 4, usage: usage.UNIFORM | usage.COPY_DST });
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  const bindGroups = new WeakMap();
  const attachment = { view: /** @type {any} */ (null), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } };
  const passDescriptor = { colorAttachments: [attachment], timestampWrites: /** @type {any} */ (undefined) };
  return {
    uniforms,
    /** Upload `data` as the uniform block and draw the pass of `frame`. @param {any} frame @param {Float32Array} data */
    draw(frame, data) {
      device.queue.writeBuffer(uniforms, 0, data);
      let group = bindGroups.get(frame.sourceView);
      if (!group) {
        group = device.createBindGroup({
          label, layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: uniforms } }, { binding: 1, resource: sampler }, { binding: 2, resource: frame.sourceView }],
        });
        bindGroups.set(frame.sourceView, group);
      }
      attachment.view = frame.destinationView;
      passDescriptor.timestampWrites = frame.profiling?.timestampWrites?.(label);
      const pass = frame.encoder.beginRenderPass(passDescriptor);
      pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.draw(3); pass.end();
      attachment.view = null;
    },
  };
}
