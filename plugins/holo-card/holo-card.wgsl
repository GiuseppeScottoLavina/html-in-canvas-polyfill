// Holographic card. Lengths in CSS px of the presented frame. mapCardPoint() in index.js is the JavaScript twin of the projection and
// of the card mask below: same ray / plane intersection with the basis vectors written by the CPU, same rounded corners.
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

@fragment
fn fs(@builtin(position) pos : vec4<f32>) -> @location(0) vec4<f32> {
  let dpr = u.res.x / u.css.x;
  let p = pos.xy / dpr;
  let c = u.css * 0.5;
  let tilt = u.misc.zw;
  let back = background(p, c, tilt);

  // perspective: the ray from the eye (distance D in front of the canvas centre) through p meets the tilted card plane
  let D = u.ex.w;
  let d = p - c;
  let t = D * u.nz.z / (d.x * u.nz.x + d.y * u.nz.y + D * u.nz.z);
  let local = vec3<f32>(t * d.x, t * d.y, -D + t * D);
  let s = c + vec2<f32>(dot(local, u.ex.xyz), dot(local, u.ey.xyz)) / u.ey.w;
  let sd = sd_box(s - c, c, u.nz.w);
  let px = u.ey.w * dpr;   // backing px per source px (about)
  if (sd * px >= 0.34 || u.misc.y < 0.5) { return vec4<f32>(back, 1.0); }

  let texel = textureSampleLevel(src, samp, clamp(s / u.css, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0);
  var col = mix(CARD, texel.rgb, texel.a);
  let cuv = s / u.css;

  // iridescent foil under the surface: hue from the position and the viewing angle, diagonal bands and sparkles that sit a little
  // deeper than the print (they move with the tilt), strongest on dark parts of the card so the text stays readable
  let foil = u.fx.x;
  let fuv = cuv + tilt * 0.035;
  let hue = fract(fuv.x * 0.8 + fuv.y * 0.55 + tilt.x * 0.4 - tilt.y * 0.3 + u.misc.x * 0.015);
  let rainbow = 0.5 + 0.5 * cos(6.2831853 * (vec3<f32>(hue) + vec3<f32>(0.0, 0.33, 0.67)));
  let band = 0.5 + 0.5 * sin((fuv.x - fuv.y) * 26.0 + (tilt.x + tilt.y) * 5.0);
  let gp = s / 9.0 + tilt * 3.0;
  let cell = floor(gp);
  let h = hash(cell);
  let at = cell + vec2<f32>(0.2) + 0.6 * vec2<f32>(fract(h * 13.7), fract(h * 71.3));
  let glint = 1.0 - smoothstep(0.0, 0.16, length(gp - at));
  let sparkle = step(0.955, h) * glint * (0.5 + 0.5 * sin(h * 80.0 + tilt.x * 9.0 - tilt.y * 7.0 + u.misc.x * 2.0));
  let lum = dot(col, vec3<f32>(0.3, 0.59, 0.11));
  let mask = 1.0 - smoothstep(0.2, 0.75, lum);
  let holo = rainbow * (0.07 + 0.2 * band * band) * mask + vec3<f32>(sparkle * 0.8 * mask);
  col = vec3<f32>(1.0) - (vec3<f32>(1.0) - col) * (vec3<f32>(1.0) - holo * foil);

  // specular glare that follows the pointer, and a sheen stripe that sweeps with the tilt
  let g = (p / u.css - u.fx.zw) * vec2<f32>(u.css.x / u.css.y, 1.0);
  let spot = 1.0 - smoothstep(0.0, 0.62, length(g));
  let sheen = 1.0 - smoothstep(0.0, 0.09, abs(cuv.x * 0.8 + cuv.y * 0.6 - 0.7 - tilt.x * 0.45 - tilt.y * 0.35));
  col = col + vec3<f32>(spot * spot * 0.3 + sheen * 0.06) * u.fx.y;

  // a thin iridescent rim
  let rim = smoothstep(-3.0, 0.0, sd);
  col = mix(col, rainbow * 0.9 + vec3<f32>(0.25), rim * (0.25 + 0.5 * foil));

  let cover = clamp(0.5 - 1.5 * sd * px, 0.0, 1.0);
  return vec4<f32>(mix(back, col, cover), 1.0);
}
