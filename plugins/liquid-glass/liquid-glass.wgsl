// Liquid glass: a slab of glass over the live HTML. Every length is in CSS px of the presented frame. index.js holds the JavaScript
// twins: sdSquircle() = sd_squircle(), lensSurface() = surface(), bendThrough() = bend(), and mapLensPoint() is where the green
// channel samples (the same constants: GLASS in index.js).
//
// Extended range (HDR_PEAK > 1): the page around the glass and through it, the studio light the surface reflects, the light along the rim
// and the thin edge stay under white. The mirror images of the two lights go above it: the glints of the key and of the rim light, and
// the brightest stretch of the rim where it faces the key light. They do so while the glass is deformed (it stretches as it moves and
// swells under a press) and fade out as it comes to rest: a lens at rest shows nothing above white.
struct U {
  res : vec2<f32>,        // presented size, backing px
  css : vec2<f32>,        // presented size, CSS px
  center : vec2<f32>,     // lens centre
  half_size : vec2<f32>,  // rest half size (local frame)
  inv_a : f32,            // inverse deformation [[a, b], [b, c]]: screen offset -> local frame (jelly stretch, press swell)
  inv_b : f32,
  inv_c : f32,
  refraction : f32,       // 0..1: curvature of the surface
  dispersion : f32,       // 0..1
  frost : f32,            // 0..1
  highlight : f32,        // 0..1
  ready : f32,
  shadow : f32,           // 0..1: drop and inner shadow
  pad0 : f32,
  pad1 : f32,
  pad2 : f32,
}

@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var src : texture_2d<f32>;

const BG = vec3<f32>(0.004, 0.018, 0.034);
const IOR = 1.5;
const SPREAD = 0.1;
const BEVEL = 0.45;
const BEVEL_H = 1.4;
const DOME = 0.36;
const FADE = 0.95;
// the key light comes low from the upper left (15 degrees above the page), so that its glints sit on the rim; a weaker rim light opposite
const KEY = vec3<f32>(-0.5516, -0.7924, 0.2608);
const KEY2 = vec2<f32>(-0.5713, -0.8207);
const HALF_KEY = vec3<f32>(-0.3473, -0.4990, 0.7939);   // normalize(KEY + view)
const HALF_RIM = vec3<f32>(0.3473, 0.4990, 0.7939);

// Extended range (plugins/_lib/hdr.js): 1 on a standard target; on a float target the largest value to write (sRGB-encoded, above 1).
override HDR_PEAK : f32 = 1.0;

// `base`: the picture, at most white, or what a plugin before this one lit above it. `light`: what this effect adds as a light source or
// a mirror reflection. Up to white the sum is kept as it is; above, it bends towards HDR_PEAK on an exponential shoulder (slope 1 where it
// starts, no plateau), and the colour is scaled as a whole (no channel clips before another: no hue shift). Called only if HDR_PEAK > 1.
fn hdr_light(base : vec3<f32>, light : vec3<f32>) -> vec3<f32> {
  let b = max(base, vec3<f32>(0.0));
  let c = b + max(light, vec3<f32>(0.0));
  let k = clamp(max(b.r, max(b.g, b.b)), 1.0, HDR_PEAK);   // where the shoulder starts: white, or the light that is there already
  let h = max(HDR_PEAK - k, 1e-4);
  let m = max(max(c.r, max(c.g, c.b)), k);
  return c * ((k + h * (1.0 - exp((k - m) / h))) / m);
}
// what goes above white, over what a standard target shows of it: the glint of the key light and of the rim light (the square of their
// lobes: narrower), and the stretch of the rim that faces the key light (from HOT_FACING, the cosine of about 33 degrees: the corner of
// the slab nearest to the light, not its straight sides)
const HOT_KEY : f32 = 8.0;
const HOT_RIM : f32 = 2.5;
const HOT_BAND : f32 = 1.2;
const HOT_FACING : f32 = 0.84;
// how far from the identity the deformation is (the sum of its differences) where the glints are at full strength
const HOT_AWAKE : f32 = 0.06;

struct Surf {
  sd : f32,          // signed distance, local units
  gl : f32,          // screen length of its gradient: sd / gl is CSS px
  n : vec3<f32>,     // unit normal, screen space, z towards the viewer
  t : f32,           // thickness
}

@vertex
fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(p[i], 0.0, 1.0);
}

fn to_local(d : vec2<f32>) -> vec2<f32> {
  return vec2<f32>(u.inv_a * d.x + u.inv_b * d.y, u.inv_b * d.x + u.inv_c * d.y);
}

// distance to a rounded box whose corners are superellipse quarters |x|^4 + |y|^4 = r^4, r = min(h); .yz is its gradient
fn sd_squircle(l : vec2<f32>, h : vec2<f32>) -> vec3<f32> {
  let r = min(h.x, h.y);
  let q = abs(l) - h + vec2<f32>(r);
  let s = select(vec2<f32>(1.0), vec2<f32>(-1.0), l < vec2<f32>(0.0));
  if (q.x > 0.0 && q.y > 0.0) {
    let q2 = q * q;
    let l4 = sqrt(sqrt(q2.x * q2.x + q2.y * q2.y));
    return vec3<f32>(l4 - r, s * q2 * q / (l4 * l4 * l4));
  }
  if (q.x > q.y) { return vec3<f32>(q.x - r, s.x, 0.0); }
  return vec3<f32>(q.y - r, 0.0, s.y);
}

fn surface(p : vec2<f32>) -> Surf {
  let l = to_local(p - u.center);
  let h = u.half_size;
  let d = sd_squircle(l, h);
  let g = d.yz;
  var o : Surf;
  o.sd = d.x;
  o.gl = length(to_local(g));
  let m = min(h.x, h.y);
  let bevel = BEVEL * m;
  let hb = u.refraction * BEVEL_H * bevel;
  let dome = u.refraction * DOME * m;
  let r2 = dot(h, h);
  // the rim: an elliptic quarter, vertical at the edge (e = 1), flat where the top begins (e = 0)
  let e = clamp(1.0 + d.x / bevel, 0.0, 1.0);
  let w = sqrt(1.0 - e * e);
  // the dome: a paraboloid over the slab, faded in from the edge, so that the glass is 0 thick at its edge (no fold: index.js)
  let pd = max(0.0, 1.0 - dot(l, l) / r2);
  let fade = FADE * m;
  let x = clamp(-d.x / fade, 0.0, 1.0);
  let tau = x * x * (3.0 - 2.0 * x);
  let dtau = 6.0 * x * (1.0 - x) / fade;
  let gd = dome * (-tau * 2.0 * l / r2 - pd * dtau * g);
  // the normal (-grad z, 1), scaled by bevel w so that it stays finite where the rim is vertical (grad sd is not a unit vector)
  let bw = max(bevel * w, 1e-4 * bevel);
  o.n = normalize(vec3<f32>(to_local(g * e * hb - bw * gd), bw));
  o.t = hb * w + dome * pd * tau;
  return o;
}

// where the view ray (straight down) refracted at the surface with index `ior` reaches the content, after the thickness
fn bend(s : Surf, ior : f32) -> vec2<f32> {
  let eta = 1.0 / ior;
  let c = s.n.z;
  let f = eta * c - sqrt(1.0 - eta * eta * (1.0 - c * c));
  let tz = -eta + f * s.n.z;
  return f * s.n.xy / -tz * s.t;
}

fn tap(p : vec2<f32>) -> vec3<f32> {
  let c = textureSampleLevel(src, samp, clamp(p / u.css, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0);
  return mix(BG, c.rgb, c.a);
}

// Catmull-Rom (bicubic) in five bilinear taps: the magnified picture stays as crisp as the source
fn tap_sharp(p : vec2<f32>) -> vec3<f32> {
  let size = vec2<f32>(textureDimensions(src));
  let sp = clamp(p / u.css, vec2<f32>(0.0), vec2<f32>(1.0)) * size;
  let tp = floor(sp - 0.5) + 0.5;
  let f = sp - tp;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let t0 = (tp - 1.0) / size;
  let t3 = (tp + 2.0) / size;
  let t12 = (tp + w2 / w12) / size;
  var c = textureSampleLevel(src, samp, vec2<f32>(t12.x, t0.y), 0.0) * (w12.x * w0.y);
  c += textureSampleLevel(src, samp, vec2<f32>(t0.x, t12.y), 0.0) * (w0.x * w12.y);
  c += textureSampleLevel(src, samp, t12, 0.0) * (w12.x * w12.y);
  c += textureSampleLevel(src, samp, vec2<f32>(t3.x, t12.y), 0.0) * (w3.x * w12.y);
  c += textureSampleLevel(src, samp, vec2<f32>(t12.x, t3.y), 0.0) * (w12.x * w3.y);
  c = clamp(c / (w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y), vec4<f32>(0.0), vec4<f32>(1.0));
  return mix(BG, c.rgb, c.a);
}

// frosted: a 12-tap golden-angle disk of radius `rad`, rotated per pixel by `rot` (the noise hides the sampling pattern)
fn frosted(p : vec2<f32>, rad : f32, rot : f32) -> vec3<f32> {
  var acc = vec3<f32>(0.0);
  for (var i = 0; i < 12; i += 1) {
    let fi = f32(i);
    let a = fi * 2.39996 + rot;
    acc += tap(p + vec2<f32>(cos(a), sin(a)) * rad * sqrt((fi + 0.5) / 12.0));
  }
  return acc / 12.0;
}

fn look(p : vec2<f32>, rad : f32, rot : f32) -> vec3<f32> {
  if (rad > 0.25) { return frosted(p, rad, rot); }
  return tap_sharp(p);
}

// interleaved gradient noise: dither and frost rotation
fn ign(q : vec2<f32>) -> f32 {
  return fract(52.9829189 * fract(dot(q, vec2<f32>(0.06711056, 0.00583715))));
}

@fragment
fn fs(@builtin(position) pos : vec4<f32>) -> @location(0) vec4<f32> {
  if (u.ready < 0.5) { return vec4<f32>(BG, 1.0); }
  let dpr = u.res.x / u.css.x;
  let p = pos.xy / dpr;
  let s = surface(p);
  let m = min(u.half_size.x, u.half_size.y);
  let px = s.sd / max(s.gl, 1e-4);   // signed distance to the edge, CSS px
  let noise = ign(pos.xy);

  // what lies around the glass: the page, under a soft drop shadow (cast away from the key light) and a contact shadow at the edge
  let ds = sd_squircle(to_local(p - u.center + KEY2 * 0.14 * m), u.half_size).x;
  let drop = (1.0 - smoothstep(-0.35 * m, 0.55 * m, ds)) * 0.3 + (1.0 - smoothstep(0.0, 0.08 * m, px)) * 0.2;
  let shade = drop * u.shadow;
  var back = tap(p);
  if (shade > 0.002) { back = back * (1.0 - shade) + (noise - 0.5) / 255.0; }
  // extended range: a float target would keep the dither below 0 (the page around the glass is passed on as it is, above white too)
  if (HDR_PEAK > 1.0) { back = max(back, vec3<f32>(0.0)); }
  // analytic coverage over 2/3 of a backing pixel; 0.5 exactly on sd = 0, where the mapper switches
  let cover = clamp(0.5 - 1.5 * px * dpr, 0.0, 1.0);
  if (cover <= 0.0) { return vec4<f32>(back, 1.0); }

  // through the glass: green at the mapper's index, red and blue at lower and higher ones (two taps each across their band)
  let rad = u.frost * 0.09 * m;
  let rot = noise * 6.2832;
  var glass = look(p + bend(s, IOR), rad, rot);
  if (u.dispersion > 0.0) {
    let dn = u.dispersion * SPREAD;
    glass.r = 0.5 * (look(p + bend(s, IOR - 0.5 * dn), rad, rot).r + look(p + bend(s, IOR - dn), rad, rot).r);
    glass.b = 0.5 * (look(p + bend(s, IOR + 0.5 * dn), rad, rot).b + look(p + bend(s, IOR + dn), rad, rot).b);
  }
  glass = glass * (1.02 - 0.06 * u.frost) + vec3<f32>(0.012 + 0.05 * u.frost);

  // inner shadow: the rim of the slab darkens what it shows, more on the side away from the light
  let out2 = s.n.xy / max(length(s.n.xy), 1e-5);
  let inner = 1.0 - smoothstep(0.0, 0.3 * m, -px);
  glass = glass * (1.0 - u.shadow * inner * inner * (0.05 + 0.14 * (0.5 - 0.5 * dot(out2, KEY2))));

  // Fresnel (Schlick, F0 = 0.04 for n = 1.5): the surface reflects a soft studio light, brightest towards the key light
  let n = s.n;
  let fres = 0.04 + 0.96 * pow(1.0 - clamp(n.z, 0.0, 1.0), 5.0);
  let r = vec3<f32>(2.0 * n.z * n.xy, 2.0 * n.z * n.z - 1.0);
  let env = vec3<f32>(0.86, 0.92, 1.0) * (0.08 + 1.1 * pow(max(dot(r, KEY), 0.0), 3.0));
  glass = mix(glass, env, fres * u.highlight);

  // specular: sharp glints of the key and the rim light (Blinn-Phong on the real normal), the light caught along the steep part of the
  // rim (strongest facing the key light, weaker opposite it) and a thin bright edge
  let face = dot(out2, KEY2);
  let steep = smoothstep(0.6, 1.0, clamp(1.0 + s.sd / (BEVEL * m), 0.0, 1.0));
  let spec = pow(max(dot(n, HALF_KEY), 0.0), 300.0) * 0.9 + pow(max(dot(n, HALF_RIM), 0.0), 300.0) * 0.35
    + steep * steep * (0.7 * pow(max(face, 0.0), 2.0) + 0.28 * pow(max(-face, 0.0), 2.0)) * min(1.0, 2.0 * u.refraction);
  let edge = (1.0 - smoothstep(0.0, 1.3, -px)) * (0.22 + 0.5 * abs(face));
  glass = glass + vec3<f32>((spec + edge) * u.highlight) + (noise - 0.5) / 255.0;

  if (HDR_PEAK > 1.0) {
    let awake = smoothstep(0.0, HOT_AWAKE, abs(u.inv_a - 1.0) + abs(u.inv_c - 1.0) + 2.0 * abs(u.inv_b));
    let key = pow(max(dot(n, HALF_KEY), 0.0), 300.0);
    let rim = pow(max(dot(n, HALF_RIM), 0.0), 300.0);
    let band = steep * steep * smoothstep(HOT_FACING, 1.0, face) * min(1.0, 2.0 * u.refraction);
    let hot = (HOT_KEY * key * key + HOT_RIM * rim * rim + HOT_BAND * band) * u.highlight * awake;
    // the glass over the page exactly as a standard target shows it (composed, then clamped at white; what the page around the glass holds
    // above white is passed on), and the glints over that
    let seen = min(mix(min(back, vec3<f32>(1.0)), glass, cover), vec3<f32>(1.0)) + max(back - vec3<f32>(1.0), vec3<f32>(0.0)) * (1.0 - cover);
    return vec4<f32>(hdr_light(seen, vec3<f32>(hot * cover)), 1.0);
  }
  return vec4<f32>(mix(back, glass, cover), 1.0);
}
