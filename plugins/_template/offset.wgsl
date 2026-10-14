// Shifts the source right by `offset_px` CSS pixels; the uncovered strip on the left is black.
struct Uniforms {
  resolution : vec2<f32>,   // presented size in backing pixels
  css_width : f32,          // presented width in CSS pixels
  offset_px : f32,          // shift in CSS pixels
}

@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var source_sampler : sampler;
@group(0) @binding(2) var source : texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) index : u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(positions[index], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) position : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = position.xy / u.resolution;
  let x = uv.x - u.offset_px / u.css_width;   // the source x this pixel shows (mapOffsetPoint in index.js is the same formula)
  let color = textureSample(source, source_sampler, vec2<f32>(x, uv.y));
  return select(color, vec4<f32>(0.0, 0.0, 0.0, 1.0), x < 0.0);
}
