// A complete ABI v2 effect plugin: a horizontal wobble. Classic script; load it after hic-live-effects.iife.min.js.
// The shader displaces each output pixel sideways; captureInputMapper is the exact inverse-direction twin of that
// displacement (output point -> the SOURCE point the presented pixel shows), so clicks land on what the user sees.
// One action, 'pulse': handle.trigger('pulse', { amplitude, ms }) swells the wobble and back, then resolves 'calm'.
(() => {
  const FREQUENCY = 0.05;   // radians per css px, vertically
  const SPEED = 2.0;        // radians per second

  const WGSL = /* wgsl */ `
    struct Uniforms { time : f32, amplitude : f32, css : vec2<f32>, resolution : vec2<f32> };
    @group(0) @binding(0) var<uniform> u : Uniforms;
    @group(0) @binding(1) var samp : sampler;
    @group(0) @binding(2) var source : texture_2d<f32>;

    @vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
      var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
      return vec4<f32>(p[i], 0.0, 1.0);
    }

    @fragment fn fs(@builtin(position) pos : vec4<f32>) -> @location(0) vec4<f32> {
      var uv = pos.xy / u.resolution;                       // 0..1 over the presented frame
      let cssY = uv.y * u.css.y;                            // css px down the canvas
      uv.x = uv.x + (u.amplitude * sin(cssY * ${FREQUENCY} + u.time * ${SPEED})) / u.css.x;
      return textureSample(source, samp, uv);
    }`;

  /** Source point shown at the presented point p, for a frame rendered at time t (seconds) with amplitude a (css px). PURE. */
  function wobbleSource(t, a, p) {
    const x = p.x + a * Math.sin(p.y * FREQUENCY + t * SPEED);
    return { x: Math.min(p.width, Math.max(0, x)), y: p.y };
  }

  window.WobblePlugin = HTMLInCanvasEffects.definePlugin({
    type: 'wobble',
    apiVersion: 2,
    version: 1,
    outputCapabilities: { directCanvasRenderAttachment: true }, // this pass only writes the destination as a colour attachment
    actions: ['pulse'],                                         // the names handle.trigger accepts (the host checks them)
    async create(context, options) {
      const { device, format } = context;
      const module = device.createShaderModule({ code: WGSL });
      const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
      const uniforms = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
      const bindGroups = new WeakMap();                      // one bind group per source texture view
      let amplitude = Number(options.amplitude ?? 6);        // css px
      let presented = { t: 0, a: amplitude };                // what the LAST rendered frame used
      let pulse = null;                                      // the running pulse {from, peak, ms}; from: its first frame
      const waiters = [];                                    // settled() calls waiting for the pulse to end
      const settled = () => (pulse ? new Promise((resolve) => waiters.push(resolve)) : 'calm');

      return {
        spatial: true,       // pixels move, so the host REQUIRES captureInputMapper
        continuous: true,    // the wobble animates: render every capped frame even if the source did not change
        setOptions(next) { if (next.amplitude !== undefined) amplitude = Number(next.amplitude) || 0; },
        // The action 'pulse' (handle.trigger): resolve with the state the plugin rests in once the frame that ends it was rendered.
        runAction(action, actionOptions) {
          pulse = { from: NaN, peak: Number(actionOptions.amplitude ?? 24), ms: Number(actionOptions.ms ?? 600) };
          return settled();
        },
        settled,                                             // resolves once nothing of the action moves: 'calm'
        render(frame) {
          const t = frame.now / 1000;
          let a = amplitude;
          if (pulse) {
            if (Number.isNaN(pulse.from)) pulse.from = frame.now;   // the pulse starts at the first frame that renders it
            const k = (frame.now - pulse.from) / pulse.ms;
            if (k < 1) a += (pulse.peak - amplitude) * Math.sin(Math.PI * k);
            else { pulse = null; for (const resolve of waiters.splice(0)) resolve('calm'); }
          }
          presented = { t, a };
          device.queue.writeBuffer(uniforms, 0, new Float32Array([t, a, frame.cssWidth, frame.cssHeight, frame.width, frame.height]));
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
        },
        // Called by the host each time a frame is PRESENTED. Freeze the values that frame used: later renders must not change THIS mapper.
        captureInputMapper() {
          const { t, a } = presented;
          return (point) => wobbleSource(t, a, point);
        },
        destroy() { for (const resolve of waiters.splice(0)) resolve(null); uniforms.destroy(); },
      };
    },
  });
  window.WobblePlugin.wobbleSource = wobbleSource; // exposed only so the smoke test can compare it with the GPU's pixels
})();
