// Page curl (README.md): one pass of the separable Gaussian that softens the lifted paper as the lamp sees it (index.js runs it six
// times: a little blur and a lot, horizontally then vertically). 9 taps folded into 5 bilinear samples, sigma about 2 taps of `step`.

struct BlurU { step : vec4<f32>, }
@group(0) @binding(0) var<uniform> bu : BlurU;
@group(0) @binding(1) var bsamp : sampler;
@group(0) @binding(2) var bsrc : texture_2d<f32>;

struct FullOut {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
}

@vertex
fn vs_full(@builtin(vertex_index) i : u32) -> FullOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var o : FullOut;
  o.position = vec4<f32>(p[i], 0.0, 1.0);
  o.uv = vec2<f32>((p[i].x + 1.0) * 0.5, (1.0 - p[i].y) * 0.5);
  return o;
}

@fragment
fn fs_blur(v : FullOut) -> @location(0) vec4<f32> {
  let s = bu.step.xy;
  var c = textureSampleLevel(bsrc, bsamp, v.uv, 0.0) * 0.2270270;
  c = c + (textureSampleLevel(bsrc, bsamp, v.uv + s * 1.3846153, 0.0) + textureSampleLevel(bsrc, bsamp, v.uv - s * 1.3846153, 0.0)) * 0.3162162;
  c = c + (textureSampleLevel(bsrc, bsamp, v.uv + s * 3.2307692, 0.0) + textureSampleLevel(bsrc, bsamp, v.uv - s * 3.2307692, 0.0)) * 0.0702702;
  return c;
}
