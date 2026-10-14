// Liquid glass lens. Every length is in CSS px of the presented frame. mapLensPoint() in index.js is the JavaScript twin of
// lens_source(): same rounded-box distance, same outward normal, same edge profile, same clamp.
struct U {
  res : vec2<f32>,        // presented size, backing px
  css : vec2<f32>,        // presented size, CSS px
  center : vec2<f32>,     // lens centre
  half_size : vec2<f32>,  // lens half size (stretched by the spring velocity)
  radius : f32,           // corner radius
  bevel : f32,            // width of the curved rim
  refraction : f32,       // 0..1
  mag : f32,              // magnification of the flat centre
  dispersion : f32,       // 0..1
  highlight : f32,        // 0..1
  ready : f32,
  pad : f32,
}

@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var src : texture_2d<f32>;

const BG = vec3<f32>(0.004, 0.018, 0.034);
const LIGHT = vec2<f32>(-0.55, -0.835);

@vertex
fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(p[i], 0.0, 1.0);
}

fn sd_box(d : vec2<f32>, h : vec2<f32>, r : f32) -> f32 {
  let q = abs(d) - h + vec2<f32>(r);
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2<f32>(0.0))) - r;
}

// gradient of sd_box: the outward normal of the rim
fn outward(d : vec2<f32>, h : vec2<f32>, r : f32) -> vec2<f32> {
  let s = select(vec2<f32>(1.0), vec2<f32>(-1.0), d < vec2<f32>(0.0));
  let q = abs(d) - h + vec2<f32>(r);
  if (q.x > 0.0 && q.y > 0.0) { return s * q / length(q); }
  if (q.x > q.y) { return vec2<f32>(s.x, 0.0); }
  return vec2<f32>(0.0, s.y);
}

fn tap(p : vec2<f32>) -> vec4<f32> {
  let c = textureSampleLevel(src, samp, clamp(p / u.css, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0);
  return vec4<f32>(mix(BG, c.rgb, c.a), 1.0);
}

@fragment
fn fs(@builtin(position) pos : vec4<f32>) -> @location(0) vec4<f32> {
  if (u.ready < 0.5) { return vec4<f32>(BG, 1.0); }
  let dpr = u.res.x / u.css.x;
  let p = pos.xy / dpr;
  let d = p - u.center;
  let sd = sd_box(d, u.half_size, u.radius);
  // soft shadow under the lens (pixels outside it are not displaced, only darkened)
  let ds = sd_box(d - vec2<f32>(0.0, 0.16 * u.half_size.y), u.half_size, u.radius);
  let shadow = (1.0 - smoothstep(-0.2 * u.half_size.y, 0.55 * u.half_size.y, ds)) * 0.32;
  let back = tap(p).rgb * (1.0 - shadow);
  if (sd * dpr >= 0.34) { return vec4<f32>(back, 1.0); }

  // edge-thickness profile: flat (magnifying) centre, curved rim that bends light from outside the lens inward
  let n = outward(d, u.half_size, u.radius);
  let t = clamp(-sd / u.bevel, 0.0, 1.0);
  let e = (1.0 - t) * (1.0 - t);
  let disp = u.refraction * u.bevel * 0.9 * e;
  let base = u.center + d / u.mag;
  var glass = tap(base + n * disp).rgb;
  if (u.dispersion > 0.0) {
    let spread = u.dispersion * e * 6.0;
    glass = vec3<f32>(tap(base + n * (disp - spread)).r, glass.g, tap(base + n * (disp + spread)).b);
  }
  glass = glass * 1.04 + vec3<f32>(0.022);

  // specular: a key light on the upper-left rim, a weaker bounce on the lower-right, a thin bright edge, a soft sheen on the upper half
  let rim = (1.0 - t) * (1.0 - t) * (1.0 - t);
  let key = max(dot(n, LIGHT), 0.0);
  let bounce = max(dot(n, -LIGHT), 0.0);
  let sheen = (1.0 - smoothstep(-u.half_size.y, 0.3 * u.half_size.y, d.y)) * 0.05;
  let spec = (key * key * 0.62 + bounce * bounce * 0.24) * rim + smoothstep(-1.6, 0.0, sd) * 0.22 + sheen;
  glass = glass + vec3<f32>(spec * u.highlight);

  // anti-aliased edge over 2/3 of a backing pixel; coverage 0.5 exactly on sd = 0, where the mapper switches
  let cover = clamp(0.5 - 1.5 * sd * dpr, 0.0, 1.0);
  return vec4<f32>(mix(back, glass, cover), 1.0);
}
