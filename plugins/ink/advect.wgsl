// One step of the pigment of the ink plugin, in an rgba16float texture of about one texel per CSS px: the densities of the three inks
// of the palette (r, g, b) and their age, as density x seconds (a), carried by the same flow that sim.js steps on the CPU.
//   - the velocity is the curl of the cubic B-spline of the stream function (the field texture, channel b): divergence free at every
//     point, so the flow neither gathers nor thins the pigment;
//   - a drop that spreads adds its radial flow (sim.js bloom), which is not divergence free: there the pigment is scaled by
//     exp(-div dt), so that it thins where the drop spreads out and gathers into a rim where its front slows down;
//   - each texel traces back one step (a midpoint step, RK2, where the water is fast enough to bend the path) and reads the pigment there with a Catmull-Rom filter (9 bilinear taps),
//     limited to the four texels around that point: a third-order read that keeps filaments a few texels wide over hundreds of steps and
//     cannot ring or go negative;
//   - the pigment ages by the step; it is removed once it is `life` seconds old (ink.wgsl has faded it out by then), so all of it is
//     gone that long after the last release, and index.js knows when without reading anything back. Ink released onto older ink
//     makes the mixture younger (the age is the mean, weighted by density);
//   - new pigment is released along up to four segments of the pointer's path: a Gaussian across the path, integrated along it (the error
//     function), so consecutive segments join without beads.

struct Step {
  size : vec4<f32>,                // pigment texture size (texels), then the CSS size of the canvas
  grid : vec4<f32>,                // interior cells across and down, then 1 / cell size (CSS px)
  t : vec4<f32>,                   // dt (s), the life of the pigment (s), the largest density an ink may reach, layer of the field texture
  n : vec4<f32>,                   // number of segments, 1 when the water moves, unused, unused
  seg : array<vec4<f32>, 4>,       // a.xy, b.xy (CSS px)
  shape : array<vec4<f32>, 4>,     // radius (CSS px), density at the centre of the path, sharpness of a drop's edge (1: Gaussian), unused
  ink : array<vec4<f32>, 4>,       // the share of each of the three inks (rgb)
  bloom : array<vec4<f32>, 8>,     // per drop that spreads: centre (CSS px), speed scale U (CSS px/s; 0: none), reach L (CSS px); k1 p1 k2 p2 of its front
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

// the radial flow of the drops that spread (sim.js velocity: u = U (1 + s M) (1 - s)^2 (p - c) / L, s = |p - c|^2 / L^2, M the
// unevenness of the front at the angle around c), CSS px/s, and its divergence 2 U (1 - s) ((1 - 3 s) + 2 s (1 - 2 s) M) / L, 1/s
fn spread(p : vec2<f32>) -> vec3<f32> {
  var out = vec3<f32>(0.0);
  for (var i = 0; i < 4; i = i + 1) {
    let b = step.bloom[2 * i];
    let c = step.bloom[2 * i + 1];
    let q = p - b.xy;
    let s = dot(q, q) / (b.w * b.w);
    if (b.z > 0.0 && s < 1.0) {
      let a = atan2(q.y, select(q.x, 1.0, dot(q, q) == 0.0));
      let m = 0.3 * cos(c.x * a + c.y) + 0.2 * cos(c.z * a + c.w) + 0.15 * cos((c.x + c.z) * a + c.y + 2.0 * c.w);
      let k = b.z * (1.0 - s) / b.w;
      out = out + vec3<f32>(k * (1.0 - s) * (1.0 + s * m) * q, 2.0 * k * (1.0 - 3.0 * s + 2.0 * s * (1.0 - 2.0 * s) * m));
    }
  }
  return out;
}

// the pigment at uv: Catmull-Rom over 4 x 4 texels as 9 bilinear taps, limited to the four texels around the point. The age comes from
// the bilinear read (a mean of the four ages weighted by density, so always one of theirs or between them), not from the sharper filter
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
  let rgb = clamp(sum.rgb, min(min(a.rgb, b.rgb), min(d.rgb, e.rgb)), max(max(a.rgb, b.rgb), max(d.rgb, e.rgb)));
  let soft = textureSampleLevel(pigment, linear_sampler, uv, 0.0);
  return vec4<f32>(rgb, soft.a / max(soft.r + soft.g + soft.b, 1e-6) * (rgb.r + rgb.g + rgb.b));
}

// the error function (Abramowitz and Stegun 7.1.26, within 1.5e-7)
fn erf(x : f32) -> f32 {
  let a = abs(x);
  let t = 1.0 / (1.0 + 0.3275911 * a);
  let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-a * a);
  return sign(x) * y;
}

// the density released at p by segment i: a Gaussian of the given radius across the path, integrated along the segment; it ends,
// smoothly, three radii from the segment (index.js REACH). A segment without length is a drop: exp(-(d^2 / r^2)^sharpness / 2), a disc
// with a soft rim for a sharpness above 1
fn released(p : vec2<f32>, i : i32) -> f32 {
  let a = step.seg[i].xy;
  let ab = step.seg[i].zw - a;
  let r = max(step.shape[i].x, 0.5);
  let pa = p - a;
  let len = length(ab);
  var along = 1.0;
  var across = dot(pa, pa);
  var away = across;
  var power = step.shape[i].z;
  if (len > 0.01) {
    power = 1.0;
    let dir = ab / len;
    let s = dot(pa, dir);
    let k = 0.70710678 / r;
    along = 0.5 * (erf(s * k) - erf((s - len) * k));
    across = max(across - s * s, 0.0);
    let q = pa - dir * clamp(s, 0.0, len);
    away = dot(q, q);
  }
  let edge = max(1.0 - away / (9.0 * r * r), 0.0);
  return step.shape[i].y * along * exp(-0.5 * pow(across / (r * r), power)) * edge * edge;
}

// every ink loses this much density per second: the thinnest haze around a stroke (which shows nothing) is gone within a second, so
// the pigment keeps a compact support with a soft rim. Only thin pigment feels it: above a density of about 0.2 the loss of one step
// is less than half a unit of the half floats of the texture and rounds away
const LOSS : f32 = 0.012;

@fragment
fn fs(@builtin(position) position : vec4<f32>) -> @location(0) vec4<f32> {
  let css = step.size.zw;
  let p = position.xy / step.size.xy * css;
  var rho : vec4<f32>;
  if (step.n.y > 0.5) {
    let dt = step.t.x;
    let here = spread(p);
    var way = dt * (velocity(p) + here.xy);
    // where the water moves more than a quarter of a CSS px in the step, the velocity half a step back (the midpoint rule); slower
    // water bends its path by less than a hundredth of a texel
    if (dot(way, way) > 0.0625) { let m = clamp(p - 0.5 * way, vec2<f32>(0.0), css); way = dt * (velocity(m) + spread(m).xy); }
    rho = pigment_at(clamp(p - way, vec2<f32>(0.0), css) / css) * exp(-here.z * dt);
  } else {
    rho = textureLoad(pigment, vec2<i32>(position.xy), 0);
  }
  let before = rho.r + rho.g + rho.b;
  let rgb = max(rho.rgb - vec3<f32>(LOSS * step.t.x), vec3<f32>(0.0));
  let total = rgb.r + rgb.g + rgb.b;
  // the age (a / total) of what is left, one step on
  rho = vec4<f32>(rgb, rho.a * total / max(before, 1e-6) + total * step.t.x);
  if (rho.a >= step.t.y * total) { rho = vec4<f32>(0.0); }
  var fresh = vec3<f32>(0.0);
  let count = i32(step.n.x);
  for (var i = 0; i < count; i = i + 1) {
    fresh = fresh + step.ink[i].rgb * released(p, i);
  }
  // (a drop may be released denser than the cap, and the pen does not thin it)
  return vec4<f32>(min(rho.rgb + fresh, max(vec3<f32>(step.t.z), max(rho.rgb, fresh))), rho.a);
}
