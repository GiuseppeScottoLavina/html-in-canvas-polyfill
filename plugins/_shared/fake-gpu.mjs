// A recording fake WebGPU device for the Node tests of single-pass plugins: uniform writes (with a copy of the data at write time),
// render pass descriptors and created textures.
export function fakeGpu() {
  /** @type {{data: Float32Array, copy: Float32Array}[]} */ const writes = [];
  /** @type {any[]} */ const passes = [];
  /** @type {any[]} */ const textures = [];
  const device = {
    createShaderModule: () => ({}), createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBuffer: () => ({ destroy() {} }), createSampler: () => ({}), createBindGroup: (/** @type {any} */ d) => ({ entries: d.entries }),
    createTexture: (/** @type {any} */ d) => { textures.push(d); return { width: d.size[0], height: d.size[1], createView: () => ({}), destroy() {} }; },
    queue: { writeBuffer: (/** @type {any} */ _b, /** @type {number} */ _o, /** @type {Float32Array} */ data) => writes.push({ data, copy: new Float32Array(data) }) },
  };
  const encoder = { beginRenderPass: (/** @type {any} */ d) => { passes.push(d); return { setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }; } };
  return { device, writes, passes, encoder, textures };
}
