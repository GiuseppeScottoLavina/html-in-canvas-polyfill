// The picture of the ink plugin: the live page, moved by the displacement field of the fluid (sim.js), under the pigment (advect.wgsl).
//   - the displacement is evaluated per device pixel as a cubic B-spline of the field (no grid shows), exactly as mapInkPoint() in
//     index.js evaluates it for the input mapper: the pixel at p shows the source at p - d(p);
//   - where the map squeezes the page (its Jacobian has a singular value above 1) the source is read with several taps along the squeezed
//     direction, so stretched text does not alias; the taps are averaged in linear light;
//   - the pigment is a layer of absorbing and scattering particles over the page (Kubelka and Munk): the absorption K and the scattering
//     S of the three inks add up by their densities, and the layer's reflectance R and transmittance T over a page of reflectance Rg give
//     R + T^2 Rg / (1 - R Rg) per channel. Over a bright page the ink glazes it (absorption); over a dark page it shows by the light its
//     particles scatter. The pigment keeps its strength until it is `hold` seconds old and has faded out at `life` seconds;
//   - where the water moves (and the page with it), its surface catches a soft overhead light: Bernoulli's free surface h = -|u|^2 / (2 g)
//     sits lower where the water is faster, and its slope (from the second derivatives of the same B-spline of the stream function) tilts
//     the normal; the light added is the change of a broad specular lobe from that of the flat surface, in linear light (a faint glint on a
//     dark page, a faint shading on a bright one; 0 where the water is still). With extended range the glint goes above white (hdr_light);
//   - half a level of dither where there is pigment or sheen (their gradients are slow);
//   - where the field is zero and there is no pigment, the output is the source texel, untouched.

struct Globals {
  res_css : vec4<f32>,             // the size in device px, then in CSS px
  grid : vec4<f32>,                // interior cells across and down, then 1 / cell size (CSS px)
  box : vec4<f32>,                 // the cells whose displacement may be non-zero (padded grid, x0 y0 x1 y1 inclusive)
  ink_box : vec4<f32>,             // CSS px (x0 y0 x1 y1) outside which there is no pigment
  state : vec4<f32>,               // layer of the field texture, 1: the field is not zero, 1: the source is ready, 1: there is pigment
  look : vec4<f32>,                // the pigment is at full strength up to this age (s), gone at this age (s), unused, unused
  absorb : array<vec4<f32>, 3>,    // K of each ink per unit density, linear RGB
  scatter : array<vec4<f32>, 3>,   // S of each ink per unit density, linear RGB
}

@group(0) @binding(0) var<uniform> globals : Globals;
@group(0) @binding(1) var linear_sampler : sampler;
@group(0) @binding(2) var source : texture_2d<f32>;
@group(0) @binding(3) var field : texture_2d_array<f32>;
@group(0) @binding(4) var pigment : texture_2d<f32>;

const PAD : f32 = 2.0;
// what the effects host shows where the source is transparent (src/effects/gpu-presenter.js)
const CLEAR : vec3<f32> = vec3<f32>(0.004, 0.018, 0.034);
// the most taps along the squeezed direction, and the largest squeeze they cover
const MAX_TAPS : f32 = 6.0;
const MAX_SQUEEZE : f32 = 8.0;
// the sheen: the height of the surface per (CSS px/s)^2 of speed (CSS px), the steepest slope it reaches (a soft limit), the overhead
// light (towards it: up, left, near the zenith), the sharpness of its lobe, and the strength of the light (linear)
const WET : f32 = 0.012;
const WET_SLOPE : f32 = 0.35;
const SUN : vec3<f32> = vec3<f32>(-0.268, -0.358, 0.894);
const LOBE : f32 = 24.0;
const SHEEN : f32 = 0.12;

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

@vertex
fn vs(@builtin(vertex_index) index : u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(positions[index], 0.0, 1.0);
}

// cubic B-spline weights and their derivatives (the same polynomials as weights() in sim.js)
fn bs_w(t : f32) -> vec4<f32> {
  let t2 = t * t; let t3 = t2 * t; let o = 1.0 - t;
  return vec4<f32>(o * o * o, 3.0 * t3 - 6.0 * t2 + 4.0, -3.0 * t3 + 3.0 * t2 + 3.0 * t + 1.0, t3) / 6.0;
}
fn bs_d(t : f32) -> vec4<f32> {
  let o = 1.0 - t;
  return vec4<f32>(-0.5 * o * o, 1.5 * t * t - 2.0 * t, -1.5 * t * t + t + 0.5, 0.5 * t * t);
}
fn bs_dd(t : f32) -> vec4<f32> {
  return vec4<f32>(1.0 - t, 3.0 * t - 2.0, 1.0 - 3.0 * t, t);
}

struct Field {
  d : vec2<f32>,       // displacement, CSS px
  ddx : vec2<f32>,     // its derivative across, per cell
  ddy : vec2<f32>,     // its derivative down, per cell
  flow : vec2<f32>,    // the gradient of the stream function, per cell
  hess : vec3<f32>,    // its second derivatives xx, xy, yy, per cell^2
  live : bool,         // some of the 4 x 4 cells may be non-zero
}

// the B-spline surface of the field over 4 x 4 cells (sim.js fieldAt: the same cells, the same clamp at the border of the padded grid)
fn field_at(uv : vec2<f32>) -> Field {
  var s : Field;
  s.d = vec2<f32>(0.0); s.ddx = vec2<f32>(0.0); s.ddy = vec2<f32>(0.0); s.flow = vec2<f32>(0.0); s.hess = vec3<f32>(0.0); s.live = false;
  let g = uv * globals.grid.xy - vec2<f32>(0.5) + vec2<f32>(PAD);
  let base = floor(g);
  let size = vec2<i32>(textureDimensions(field));
  let b = vec2<i32>(base) - vec2<i32>(1);
  // all 4 x 4 cells (clamped as the loads below) lie where the displacement is exactly zero: the loops would add zeros
  let lo = clamp(b, vec2<i32>(0), size - vec2<i32>(1));
  let hi = clamp(b + vec2<i32>(3), vec2<i32>(0), size - vec2<i32>(1));
  let live = vec4<i32>(globals.box);
  if (any(hi < live.xy) || any(lo > live.zw)) { return s; }
  s.live = true;
  let f = g - base;
  let layer = i32(globals.state.x);
  let wx = bs_w(f.x); let wy = bs_w(f.y);
  let dx = bs_d(f.x); let dy = bs_d(f.y);
  let ddx = bs_dd(f.x); let ddy = bs_dd(f.y);
  for (var j = 0; j < 4; j = j + 1) {
    let yy = clamp(b.y + j, 0, size.y - 1);
    var value = vec3<f32>(0.0);
    var slope = vec3<f32>(0.0);
    var bend = 0.0;
    for (var i = 0; i < 4; i = i + 1) {
      let cell = textureLoad(field, vec2<i32>(clamp(b.x + i, 0, size.x - 1), yy), layer, 0).rgb;
      value = value + wx[i] * cell;
      slope = slope + dx[i] * cell;
      bend = bend + ddx[i] * cell.z;
    }
    s.hess = s.hess + vec3<f32>(wy[j] * bend, dy[j] * slope.z, ddy[j] * value.z);
    s.d = s.d + wy[j] * value.xy;
    s.ddx = s.ddx + wy[j] * slope.xy;
    s.ddy = s.ddy + dy[j] * value.xy;
    s.flow = s.flow + vec2<f32>(wy[j] * slope.z, dy[j] * value.z);
  }
  return s;
}

fn to_linear(c : vec3<f32>) -> vec3<f32> {
  return select(pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
}
fn to_srgb(c : vec3<f32>) -> vec3<f32> {
  return select(1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055), c * 12.92, c <= vec3<f32>(0.0031308));
}

// the page at uv as the host shows it (sRGB encoded), and in linear light
fn page_encoded(uv : vec2<f32>) -> vec3<f32> {
  let c = textureSampleLevel(source, linear_sampler, uv, 0.0);
  return mix(CLEAR, c.rgb, c.a);
}

// the pigment at uv (three densities and their age x density): a cubic B-spline of the pigment texture as 4 bilinear taps (smooth under magnification)
fn pigment_at(uv : vec2<f32>) -> vec4<f32> {
  let size = vec2<f32>(textureDimensions(pigment));
  let sp = uv * size - vec2<f32>(0.5);
  let base = floor(sp);
  let f = sp - base;
  let wx = bs_w(f.x); let wy = bs_w(f.y);
  let g0 = vec2<f32>(wx.x + wx.y, wy.x + wy.y);
  let g1 = vec2<f32>(wx.z + wx.w, wy.z + wy.w);
  let h0 = (base + vec2<f32>(wx.y, wy.y) / g0 - vec2<f32>(0.5)) / size;
  let h1 = (base + vec2<f32>(wx.w, wy.w) / g1 + vec2<f32>(1.5)) / size;
  return max(g0.y * (g0.x * textureSampleLevel(pigment, linear_sampler, vec2<f32>(h0.x, h0.y), 0.0) + g1.x * textureSampleLevel(pigment, linear_sampler, vec2<f32>(h1.x, h0.y), 0.0))
    + g1.y * (g0.x * textureSampleLevel(pigment, linear_sampler, vec2<f32>(h0.x, h1.y), 0.0) + g1.x * textureSampleLevel(pigment, linear_sampler, vec2<f32>(h1.x, h1.y), 0.0)), vec4<f32>(0.0));
}

// Kubelka and Munk: a layer of unit thickness with absorption k and scattering s over a background of reflectance rg (all per channel,
// linear light). Written with sinh(t) / t so that it holds for s -> 0 (pure absorption: exp(-2 k) rg) and k -> 0 alike.
fn layer_over(k : vec3<f32>, s_in : vec3<f32>, rg : vec3<f32>) -> vec3<f32> {
  let s = s_in + vec3<f32>(1e-5);
  let q = k / s;
  let a = vec3<f32>(1.0) + q;
  let t = min(sqrt(q * (q + vec3<f32>(2.0))) * s, vec3<f32>(20.0));
  let shc = select(sinh(t) / t, vec3<f32>(1.0) + t * t / 6.0, t < vec3<f32>(0.01));
  let inv = vec3<f32>(1.0) / (a * s * shc + cosh(t));
  let r = s * shc * inv;
  return r + inv * inv * rg / (vec3<f32>(1.0) - r * rg);
}

// interleaved gradient noise: a dither of +-0.5 level, stable per pixel
fn dither(p : vec2<f32>) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715)))) - 0.5;
}

@fragment
fn fs(@builtin(position) position : vec4<f32>) -> @location(0) vec4<f32> {
  let resolution = max(globals.res_css.xy, vec2<f32>(1.0));
  let css = max(globals.res_css.zw, vec2<f32>(1.0));
  let uv = position.xy / resolution;
  if (globals.state.z < 0.5) { return vec4<f32>(CLEAR, 1.0); }

  var s : Field;
  s.d = vec2<f32>(0.0); s.live = false;
  if (globals.state.y > 0.5) { s = field_at(uv); }
  var rho = vec4<f32>(0.0);
  let at = uv * css;
  if (globals.state.w > 0.5 && all(at >= globals.ink_box.xy) && all(at <= globals.ink_box.zw)) { rho = pigment_at(uv); }
  let moved = s.live && any(s.d != vec2<f32>(0.0));
  // the densities that show: all of the pigment while it is young, none of it at the end of its life
  let total = rho.r + rho.g + rho.b;
  let ink = rho.rgb * (1.0 - smoothstep(globals.look.x, globals.look.y, rho.a / max(total, 1e-6)));
  let inked = any(ink > vec3<f32>(0.0));
  // nothing here: the source, untouched
  if (!moved && !inked) { return vec4<f32>(page_encoded(uv), 1.0); }

  var page : vec3<f32>;
  if (moved) {
    let origin = clamp(uv - s.d / css, vec2<f32>(0.0), vec2<f32>(1.0));
    // the Jacobian of p -> p - d(p): how many source texels one output pixel spans
    let ja = 1.0 - s.ddx.x * globals.grid.z; let jb = -s.ddy.x * globals.grid.w;
    let jc = -s.ddx.y * globals.grid.z; let jd = 1.0 - s.ddy.y * globals.grid.w;
    let m00 = ja * ja + jb * jb; let m11 = jc * jc + jd * jd; let m01 = ja * jc + jb * jd;
    let half_diff = 0.5 * (m00 - m11);
    let root = sqrt(half_diff * half_diff + m01 * m01);
    let squeeze = min(sqrt(0.5 * (m00 + m11) + root), MAX_SQUEEZE);
    if (squeeze > 1.0) {
      // the direction of the longest axis of the pixel's footprint in the source
      var axis = select(vec2<f32>(m01, root - half_diff), vec2<f32>(root + half_diff, m01), half_diff > 0.0);
      axis = axis / max(length(axis), 1e-6);
      let taps = min(ceil(squeeze), MAX_TAPS);
      let reach = axis * (squeeze - 1.0) / resolution;
      var sum = vec3<f32>(0.0);
      for (var i = 0.0; i < taps; i = i + 1.0) {
        sum = sum + to_linear(page_encoded(origin + reach * (i / (taps - 1.0) - 0.5)));
      }
      page = sum / taps;
    } else {
      page = to_linear(page_encoded(origin));
    }
  } else {
    page = to_linear(page_encoded(uv));
  }

  var color = page;
  if (inked) {
    let k = ink.x * globals.absorb[0].rgb + ink.y * globals.absorb[1].rgb + ink.z * globals.absorb[2].rgb;
    let sc = ink.x * globals.scatter[0].rgb + ink.y * globals.scatter[1].rgb + ink.z * globals.scatter[2].rgb;
    color = layer_over(k, sc, page);
  }
  // the sheen of the moving water (where the page moves with it): the gradient of |u|^2, CSS px/s^2, from the B-spline of psi
  var light = 0.0;
  if (moved) {
    let a = s.flow * globals.grid.zw;
    let h = s.hess * vec3<f32>(globals.grid.z * globals.grid.z, globals.grid.z * globals.grid.w, globals.grid.w * globals.grid.w);
    let tilt = -WET * 2.0 * vec2<f32>(a.x * h.x + a.y * h.y, a.x * h.y + a.y * h.z);
    let n = normalize(vec3<f32>(-tilt / (1.0 + length(tilt) / WET_SLOPE), 1.0));
    let mid = normalize(SUN + vec3<f32>(0.0, 0.0, 1.0));
    light = SHEEN * (pow(max(dot(n, mid), 0.0), LOBE) - pow(mid.z, LOBE));
  }
  let wet = abs(light) > 1e-3;
  if (HDR_PEAK > 1.0) {
    // extended range: the shading below white, the glint above it on the shoulder
    let lit = to_srgb(max(color + vec3<f32>(light), vec3<f32>(0.0)));
    var base = min(lit, vec3<f32>(1.0));
    if (inked || wet) { base = clamp(base + vec3<f32>(dither(position.xy) / 255.0), vec3<f32>(0.0), vec3<f32>(1.0)); }
    return vec4<f32>(hdr_light(base, lit - min(lit, vec3<f32>(1.0))), 1.0);
  }
  var encoded = to_srgb(clamp(color + vec3<f32>(light), vec3<f32>(0.0), vec3<f32>(1.0)));
  if (inked || wet) { encoded = encoded + vec3<f32>(dither(position.xy) / 255.0); }
  return vec4<f32>(clamp(encoded, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
