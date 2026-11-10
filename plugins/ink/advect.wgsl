// One step of the pigment of the ink plugin: four densities (one per ink of the palette) in an rgba16float texture of about one texel
// per CSS px, carried by the same flow that sim.js steps on the CPU.
//   - the velocity is the curl of the cubic B-spline of the stream function (the field texture, channel b): divergence free at every
//     point, so the flow neither gathers nor thins the pigment;
//   - each texel traces back one step (a midpoint step, RK2) and reads the pigment there with a Catmull-Rom filter (9 bilinear taps),
//     limited to the four texels around that point: a third-order read that keeps filaments a few texels wide over hundreds of steps and
//     cannot ring or go negative;
//   - the pigment fades (times `keep`, less `loss`, not below zero: it is exactly gone after a finite time);
//   - new pigment is released along up to four segments of the pointer's path: a Gaussian across the path, integrated along it (the error
//     function), so consecutive segments join without beads.

struct Step {
  size : vec4<f32>,                // pigment texture size (texels), then the CSS size of the canvas
  grid : vec4<f32>,                // interior cells across and down, then 1 / cell size (CSS px)
  t : vec4<f32>,                   // dt (s), keep, loss, layer of the field texture
  n : vec4<f32>,                   // number of segments, 1 when the water moves, unused, unused
  seg : array<vec4<f32>, 4>,       // a.xy, b.xy (CSS px)
  shape : array<vec4<f32>, 4>,     // radius (CSS px), density at the centre of the path, unused, unused
  ink : array<vec4<f32>, 4>,       // the share of each of the four inks
}

@group(0) @binding(0) var<uniform> step : Step;
@group(0) @binding(1) var linear_sampler : sampler;
@group(0) @binding(2) var field : texture_2d_array<f32>;
@group(0) @binding(3) var pigment : texture_2d<f32>;

const PAD : f32 = 2.0;

@vertex
fn vs(@builtin(vertex_index) index : u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(positions[index], 0.0, 1.0);
}

fn bs_w(t : f32) -> vec4<f32> {
  let t2 = t * t; let t3 = t2 * t; let o = 1.0 - t;
  return vec4<f32>(o * o * o, 3.0 * t3 - 6.0 * t2 + 4.0, -3.0 * t3 + 3.0 * t2 + 3.0 * t + 1.0, t3) / 6.0;
}
fn bs_d(t : f32) -> vec4<f32> {
  let o = 1.0 - t;
  return vec4<f32>(-0.5 * o * o, 1.5 * t * t - 2.0 * t, -1.5 * t * t + t + 0.5, 0.5 * t * t);
}

// the velocity of the water at p (CSS px), CSS px/s: (d psi/dy, -d psi/dx) of the B-spline of psi (sim.js fieldAt: the same cells)
fn velocity(p : vec2<f32>) -> vec2<f32> {
  let g = p * step.grid.zw - vec2<f32>(0.5) + vec2<f32>(PAD);
  let base = floor(g);
  let f = g - base;
  let size = vec2<i32>(textureDimensions(field));
  let b = vec2<i32>(base) - vec2<i32>(1);
  let layer = i32(step.t.w);
  let wx = bs_w(f.x); let wy = bs_w(f.y);
  let dx = bs_d(f.x); let dy = bs_d(f.y);
  var grad = vec2<f32>(0.0);
  for (var j = 0; j < 4; j = j + 1) {
    let yy = clamp(b.y + j, 0, size.y - 1);
    var row = vec4<f32>(0.0);
    for (var i = 0; i < 4; i = i + 1) {
      row[i] = textureLoad(field, vec2<i32>(clamp(b.x + i, 0, size.x - 1), yy), layer, 0).b;
    }
    grad = grad + vec2<f32>(wy[j] * dot(dx, row), dy[j] * dot(wx, row));
  }
  return vec2<f32>(grad.y * step.grid.w, -grad.x * step.grid.z);
}

// the pigment at uv: Catmull-Rom over 4 x 4 texels as 9 bilinear taps, limited to the four texels around the point
fn pigment_at(uv : vec2<f32>) -> vec4<f32> {
  let size = step.size.xy;
  let sp = uv * size;
  let tc = floor(sp - vec2<f32>(0.5)) + vec2<f32>(0.5);
  let f = sp - tc;
  let w0 = f * (vec2<f32>(-0.5) + f * (vec2<f32>(1.0) - 0.5 * f));
  let w1 = vec2<f32>(1.0) + f * f * (vec2<f32>(-2.5) + 1.5 * f);
  let w2 = f * (vec2<f32>(0.5) + f * (vec2<f32>(2.0) - 1.5 * f));
  let w3 = f * f * (vec2<f32>(-0.5) + 0.5 * f);
  let w12 = w1 + w2;
  let t0 = (tc - vec2<f32>(1.0)) / size;
  let t3 = (tc + vec2<f32>(2.0)) / size;
  let t12 = (tc + w2 / w12) / size;
  var sum = textureSampleLevel(pigment, linear_sampler, vec2<f32>(t0.x, t0.y), 0.0) * (w0.x * w0.y)
    + textureSampleLevel(pigment, linear_sampler, vec2<f32>(t12.x, t0.y), 0.0) * (w12.x * w0.y)
    + textureSampleLevel(pigment, linear_sampler, vec2<f32>(t3.x, t0.y), 0.0) * (w3.x * w0.y)
    + textureSampleLevel(pigment, linear_sampler, vec2<f32>(t0.x, t12.y), 0.0) * (w0.x * w12.y)
    + textureSampleLevel(pigment, linear_sampler, vec2<f32>(t12.x, t12.y), 0.0) * (w12.x * w12.y)
    + textureSampleLevel(pigment, linear_sampler, vec2<f32>(t3.x, t12.y), 0.0) * (w3.x * w12.y)
    + textureSampleLevel(pigment, linear_sampler, vec2<f32>(t0.x, t3.y), 0.0) * (w0.x * w3.y)
    + textureSampleLevel(pigment, linear_sampler, vec2<f32>(t12.x, t3.y), 0.0) * (w12.x * w3.y)
    + textureSampleLevel(pigment, linear_sampler, vec2<f32>(t3.x, t3.y), 0.0) * (w3.x * w3.y);
  let top = vec2<i32>(textureDimensions(pigment)) - vec2<i32>(1);
  let c = vec2<i32>(tc);
  let a = textureLoad(pigment, clamp(c, vec2<i32>(0), top), 0);
  let b = textureLoad(pigment, clamp(c + vec2<i32>(1, 0), vec2<i32>(0), top), 0);
  let d = textureLoad(pigment, clamp(c + vec2<i32>(0, 1), vec2<i32>(0), top), 0);
  let e = textureLoad(pigment, clamp(c + vec2<i32>(1, 1), vec2<i32>(0), top), 0);
  return clamp(sum, min(min(a, b), min(d, e)), max(max(a, b), max(d, e)));
}

// the error function (Abramowitz and Stegun 7.1.26, within 1.5e-7)
fn erf(x : f32) -> f32 {
  let a = abs(x);
  let t = 1.0 / (1.0 + 0.3275911 * a);
  let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-a * a);
  return sign(x) * y;
}

// the density released at p by segment i: a Gaussian of the given radius across the path, integrated along the segment; it ends,
// smoothly, three radii from the segment (index.js REACH)
fn released(p : vec2<f32>, i : i32) -> f32 {
  let a = step.seg[i].xy;
  let ab = step.seg[i].zw - a;
  let r = max(step.shape[i].x, 0.5);
  let pa = p - a;
  let len = length(ab);
  var along = 1.0;
  var across = dot(pa, pa);
  var away = across;
  if (len > 0.01) {
    let dir = ab / len;
    let s = dot(pa, dir);
    let k = 0.70710678 / r;
    along = 0.5 * (erf(s * k) - erf((s - len) * k));
    across = max(across - s * s, 0.0);
    let q = pa - dir * clamp(s, 0.0, len);
    away = dot(q, q);
  }
  let edge = max(1.0 - away / (9.0 * r * r), 0.0);
  return step.shape[i].y * along * exp(-0.5 * across / (r * r)) * edge * edge;
}

@fragment
fn fs(@builtin(position) position : vec4<f32>) -> @location(0) vec4<f32> {
  let css = step.size.zw;
  let p = position.xy / step.size.xy * css;
  var rho : vec4<f32>;
  if (step.n.y > 0.5) {
    let dt = step.t.x;
    let mid = clamp(p - 0.5 * dt * velocity(p), vec2<f32>(0.0), css);
    let origin = clamp(p - dt * velocity(mid), vec2<f32>(0.0), css);
    rho = pigment_at(origin / css);
  } else {
    rho = textureLoad(pigment, vec2<i32>(position.xy), 0);
  }
  rho = max(rho * step.t.y - vec4<f32>(step.t.z), vec4<f32>(0.0));
  let count = i32(step.n.x);
  for (var i = 0; i < count; i = i + 1) {
    rho = rho + step.ink[i] * released(p, i);
  }
  return rho;
}
