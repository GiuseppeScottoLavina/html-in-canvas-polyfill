// Holographic card. Lengths in CSS px of the presented frame. mapCardPoint() in index.js is the JavaScript twin of the projection and
// of the card mask below: same ray / plane intersection with the basis vectors written by the CPU, same rounded corners.
//
// Shading: the card is a glossy laminated slab lit by a small lamp placed where the card mirrors it to the eye at the glare point (the
// pointer). The specular glare is Blinn-Phong of that light on the real card normal (a broad sheen and a sharp core), with
// Schlick's Fresnel; the foil is a thin film whose interference colour depends on the viewing angle of each pixel (plus the diagonal
// diffraction bands); glitter flakes have their own tilted normals and glint only when they reflect the light to the eye; the bevelled
// rim catches the light on the side that faces it. The print is supersampled (4 rotated-grid taps per pixel) so text does not shimmer
// while the card moves, and the output is dithered so the dark gradients do not band.
//
// Extended range (HDR_PEAK > 1): the print, the foil over it, the sheen and the rim stay under white; the lamp is the light. The hot core
// of its mirror image on the laminate (a far narrower lobe than the glare a standard target can show) and the flakes that mirror it squarely
// go above white, towards HDR_PEAK. Both fade out as the card comes to rest in front of the lamp: a card at rest shows nothing above white.
struct U {
  res : vec2<f32>,    // presented size, backing px
  css : vec2<f32>,    // presented size, CSS px
  ex : vec4<f32>,     // card x axis (xyz), w = camera distance
  ey : vec4<f32>,     // card y axis (xyz), w = card scale
  nz : vec4<f32>,     // card normal (xyz), w = corner radius (source px)
  fx : vec4<f32>,     // foil, glare, glare point (fraction of the canvas)
  misc : vec4<f32>,   // time, ready, tilt x, tilt y (-1..1, for the parallax)
}

@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var src : texture_2d<f32>;

const CARD = vec3<f32>(0.03, 0.045, 0.08);

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
// the lamp's own brightness over what a standard target shows of it: the hot core of the glare, and a flake that mirrors the lamp squarely
const HOT_CORE : f32 = 6.0;
const HOT_FLAKE : f32 = 0.6;

@vertex
fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(p[i], 0.0, 1.0);
}

fn sd_box(d : vec2<f32>, h : vec2<f32>, r : f32) -> f32 {
  let q = abs(d) - h + vec2<f32>(r);
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2<f32>(0.0))) - r;
}

fn hash(p : vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.547);
}

fn background(p : vec2<f32>, c : vec2<f32>, tilt : vec2<f32>) -> vec3<f32> {
  let uv = p / u.css;
  var bg = mix(vec3<f32>(0.035, 0.03, 0.075), vec3<f32>(0.006, 0.012, 0.03), clamp(length(uv - vec2<f32>(0.5, 0.35)) * 1.5, 0.0, 1.0));
  // a far star field that drifts against the tilt (parallax)
  let q = p + tilt * 14.0;
  let cell = floor(q / 26.0);
  let h = hash(cell);
  let star = step(0.86, h) * (1.0 - smoothstep(0.6, 1.6, length(q - (cell + vec2<f32>(0.5)) * 26.0)));
  bg = bg + vec3<f32>(0.16, 0.18, 0.26) * star * h;
  // the card's shadow, offset away from the light and the tilt
  let ds = sd_box(p - c - vec2<f32>(-tilt.x * 10.0, 22.0 - tilt.y * 10.0), c * u.ey.w, u.nz.w * u.ey.w);
  return bg * (1.0 - 0.7 * (1.0 - smoothstep(-30.0, 60.0, ds)));
}

// interleaved gradient noise in [0, 1): a stable dither pattern per backing pixel
fn ign(p : vec2<f32>) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715))));
}

// the print at source point s, 4 rotated-grid taps over the footprint of one backing pixel (o: that footprint in source px)
fn print(s : vec2<f32>, o : f32) -> vec4<f32> {
  let a = vec2<f32>(0.125, 0.375) * o;
  let b = vec2<f32>(0.375, -0.125) * o;
  let lo = vec2<f32>(0.0);
  let hi = vec2<f32>(1.0);
  return 0.25 * (textureSampleLevel(src, samp, clamp((s + a) / u.css, lo, hi), 0.0) + textureSampleLevel(src, samp, clamp((s - a) / u.css, lo, hi), 0.0)
    + textureSampleLevel(src, samp, clamp((s + b) / u.css, lo, hi), 0.0) + textureSampleLevel(src, samp, clamp((s - b) / u.css, lo, hi), 0.0));
}

// thin-film interference colour for the cosine of the refracted angle and a film thickness in nm (n = 1.45; red, green, blue at 650, 540, 450 nm)
fn film(cos_t : f32, d : f32) -> vec3<f32> {
  let opd = 2.0 * 1.45 * d * cos_t;
  return 0.5 + 0.5 * cos(6.2831853 * opd / vec3<f32>(650.0, 540.0, 450.0));
}

@fragment
fn fs(@builtin(position) pos : vec4<f32>) -> @location(0) vec4<f32> {
  let dpr = u.res.x / u.css.x;
  let p = pos.xy / dpr;
  let c = u.css * 0.5;
  let tilt = u.misc.zw;
  let dither = (ign(pos.xy) - 0.5) / 255.0;
  let back = background(p, c, tilt);

  // perspective: the ray from the eye (distance D in front of the canvas centre) through p meets the tilted card plane
  let D = u.ex.w;
  let d = p - c;
  let t = D * u.nz.z / (d.x * u.nz.x + d.y * u.nz.y + D * u.nz.z);
  let local = vec3<f32>(t * d.x, t * d.y, -D + t * D);
  let s = c + vec2<f32>(dot(local, u.ex.xyz), dot(local, u.ey.xyz)) / u.ey.w;
  let sd = sd_box(s - c, c, u.nz.w);
  let px = u.ey.w * dpr;   // backing px per source px (about)
  if (sd * px >= 0.34 || u.misc.y < 0.5) {
    if (HDR_PEAK > 1.0) { return vec4<f32>(max(back + vec3<f32>(dither), vec3<f32>(0.0)), 1.0); }   // a float target keeps a negative: none is written
    return vec4<f32>(back + vec3<f32>(dither), 1.0);
  }

  let texel = print(s, 1.0 / px);
  var ink = texel.rgb;
  // extended range: the print is at most white here; what a plugin before this one lit above white is carried to the output as it is
  var lit_before = vec3<f32>(0.0);
  if (HDR_PEAK > 1.0) {
    lit_before = max(ink - vec3<f32>(1.0), vec3<f32>(0.0)) * texel.a;
    ink = min(ink, vec3<f32>(1.0));
  }
  var col = mix(CARD, ink, texel.a);
  let cuv = s / u.css;

  // the light: a small lamp placed where the card mirrors it to the eye at the glare point (the pointer), so the highlight sits under the
  // pointer and its shape, its Fresnel and the glints around it follow the real normal. N faces the eye (at z = -D); V and L from the point.
  let N = -u.nz.xyz;
  let eye = vec3<f32>(0.0, 0.0, -D);
  let V = normalize(eye - local);
  let gd = u.fx.zw * u.css - c;
  let gt = D * u.nz.z / (gd.x * u.nz.x + gd.y * u.nz.y + D * u.nz.z);
  let gp3 = vec3<f32>(gt * gd.x, gt * gd.y, -D + gt * D);
  let lamp = gp3 + reflect(-normalize(eye - gp3), N) * (0.6 * D);
  let L = normalize(lamp - local);
  let H = normalize(L + V);
  let ndv = max(dot(N, V), 0.0);
  let ndh = max(dot(N, H), 0.0);
  let fresnel = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);

  // iridescent foil under the laminate: thin-film colour from the viewing angle of this pixel and a film thickness that varies over
  // the card, crossed by diagonal diffraction bands that move with the tilt; strongest on dark parts of the card so text stays readable
  let foil = u.fx.x;
  let fuv = cuv + tilt * 0.035;
  let hue = fract(fuv.x * 0.8 + fuv.y * 0.55 + tilt.x * 0.4 - tilt.y * 0.3 + u.misc.x * 0.015);
  let rainbow = 0.5 + 0.5 * cos(6.2831853 * (vec3<f32>(hue) + vec3<f32>(0.0, 0.33, 0.67)));
  let sin_t = sqrt(max(0.0, 1.0 - ndv * ndv)) / 1.45;
  let thickness = 420.0 + 160.0 * sin(cuv.x * 5.1 + cuv.y * 3.3 + 1.7) * sin(cuv.y * 4.3 - cuv.x * 1.9) + 900.0 * dot(tilt, vec2<f32>(0.11, -0.07));
  let irid = mix(rainbow, film(sqrt(1.0 - sin_t * sin_t), thickness), 0.45);
  let band = 0.5 + 0.5 * sin((fuv.x - fuv.y) * 26.0 + (tilt.x + tilt.y) * 5.0);
  let lum = dot(col, vec3<f32>(0.3, 0.59, 0.11));
  let mask = 1.0 - smoothstep(0.2, 0.75, lum);

  // glitter: one flake in some cells of a 9 px grid, each with its own normal tilted up to ~9 degrees; it glints when it mirrors the lamp,
  // so the glints gather around the glare and travel with the tilt (a flake far from the highlight would need a steeper normal)
  let gp = s / 9.0;
  let cell = floor(gp);
  let h = hash(cell);
  let at = cell + vec2<f32>(0.2) + 0.6 * vec2<f32>(fract(h * 13.7), fract(h * 71.3));
  let flake_n = normalize(N + 0.16 * (vec3<f32>(fract(h * 31.1), fract(h * 57.7), fract(h * 91.3)) - vec3<f32>(0.5)));
  let flake = (1.0 - smoothstep(0.04, 0.13, length(gp - at))) * step(0.86, h);
  let glint = flake * pow(max(dot(flake_n, H), 0.0), 900.0) * 2.4;
  let holo = irid * (0.07 + 0.2 * band * band) * mask * (0.85 + 2.0 * fresnel) + mix(vec3<f32>(1.0), irid, 0.45) * glint * mask;
  col = vec3<f32>(1.0) - (vec3<f32>(1.0) - col) * (vec3<f32>(1.0) - clamp(holo * foil, vec3<f32>(0.0), vec3<f32>(1.0)));

  // specular glare of the lamp on the laminate: a broad sheen and a sharp core, warmer at the core, scaled by Fresnel
  let sheen = pow(ndh, 90.0);
  let core = pow(ndh, 1400.0);
  let glare = u.fx.y * (0.55 + 6.0 * fresnel);
  col = col + (vec3<f32>(0.62, 0.66, 0.78) * sheen * 0.42 + vec3<f32>(1.0, 0.97, 0.92) * core * 0.85) * glare;
  // and the old sheen stripe, a soft reflection of a window, sweeping with the tilt
  let stripe = 1.0 - smoothstep(0.0, 0.09, abs(cuv.x * 0.8 + cuv.y * 0.6 - 0.7 - tilt.x * 0.45 - tilt.y * 0.35));
  col = col + vec3<f32>(stripe * 0.05) * u.fx.y;

  // the bevelled rim: iridescent, and brighter on the side that faces the lamp (its normal leans outwards, in the card plane)
  let e = 1.0;
  let grad = normalize(vec2<f32>(sd_box(s - c + vec2<f32>(e, 0.0), c, u.nz.w) - sd_box(s - c - vec2<f32>(e, 0.0), c, u.nz.w),
    sd_box(s - c + vec2<f32>(0.0, e), c, u.nz.w) - sd_box(s - c - vec2<f32>(0.0, e), c, u.nz.w)) + vec2<f32>(1e-6));
  let bevel_n = normalize(N * 0.6 + (u.ex.xyz * grad.x + u.ey.xyz * grad.y) * 0.8);
  let rim_light = 0.35 + 1.4 * pow(max(dot(bevel_n, H), 0.0), 24.0);
  let rim = smoothstep(-3.0, 0.0, sd);
  col = mix(col, (irid * 0.9 + vec3<f32>(0.25)) * rim_light, rim * (0.25 + 0.5 * foil));

  let cover = clamp(0.5 - 1.5 * sd * px, 0.0, 1.0);
  if (HDR_PEAK > 1.0) {
    // the lamp above white: the core of its image (the 12th power of the glare's core: a spot between a third and a quarter as wide) and the flakes that
    // mirror it squarely (the square of the glint: a flake half aligned stays under white). `awake` is 0 with the glare point at the centre
    // of the card, where it rests (no pointer, no sway, or reduced motion without a pointer), and 1 a little away from it
    let awake = smoothstep(0.0, 0.16, length(u.fx.zw - vec2<f32>(0.5)) * 2.0);
    let core2 = core * core;
    let core4 = core2 * core2;
    let hot = vec3<f32>(1.0, 0.97, 0.92) * (core4 * core4 * core4 * glare * HOT_CORE) + mix(vec3<f32>(1.0), irid, 0.45) * (glint * glint * mask * foil * HOT_FLAKE);
    let lit = hdr_light(min(col, vec3<f32>(1.0)) + lit_before, hot * awake);
    return vec4<f32>(max(mix(back, lit, cover) + vec3<f32>(dither), vec3<f32>(0.0)), 1.0);
  }
  return vec4<f32>(mix(back, col, cover) + vec3<f32>(dither), 1.0);
}
