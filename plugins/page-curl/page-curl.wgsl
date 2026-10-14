// Page curl: the drawn page is wrapped around a cylinder of radius R lying on the page, its axis perpendicular to `dir`.
// Everything is computed in CSS pixels of the presented frame. For a pixel p, s = dot(p, dir) - axis is its signed distance from
// the axis (positive towards the dragged corner). mapCurlPoint() in index.js is the JavaScript twin of the region decision below.
//
//   s < 0, flap source outside the page   the flat page, unchanged (the mapper is the identity there)
//   s < 0, flap source inside the page    the back of the page, folded flat over the front (paper, the front showing through)
//   0 <= s <= R                           the cylinder: its upper (back) half, else its lower (front) half, else the page underneath
//   s > R                                 the page underneath, with the shadow of the curl
struct Uniforms {
  resolution : vec2<f32>,   // presented size in backing pixels
  css : vec2<f32>,          // presented size in CSS pixels
  dir : vec2<f32>,          // unit vector from the dragged point towards the corner
  axis : f32,               // dot(axis point, dir), CSS px
  radius : f32,             // cylinder radius, CSS px
  curled : f32,             // 0: no curl (the source is shown unchanged)
  shadow : f32,             // 0..1
  ready : f32,              // 0 before the first source upload
  ink : f32,                // how much the front shows through the back
  under : vec4<f32>,        // rgb of the page underneath
  paper : vec4<f32>,        // rgb of the back of the page
}

@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var source_sampler : sampler;
@group(0) @binding(2) var source : texture_2d<f32>;

const PI : f32 = 3.14159265;

@vertex
fn vs(@builtin(vertex_index) index : u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(positions[index], 0.0, 1.0);
}

fn inside(q : vec2<f32>) -> bool {
  return q.x >= 0.0 && q.y >= 0.0 && q.x <= u.css.x && q.y <= u.css.y;
}

// distance (CSS px) of q outside the page rectangle, 0 inside
fn outside(q : vec2<f32>) -> f32 {
  let d = max(max(-q, q - u.css), vec2<f32>(0.0));
  return length(d);
}

fn page(q : vec2<f32>) -> vec3<f32> {
  return textureSampleLevel(source, source_sampler, q / u.css, 0.0).rgb * u.ready;
}

// the back of the page: paper, with the front seen through it (sampling at the folded point mirrors it): bright parts darken it
fn back(q : vec2<f32>, light : f32) -> vec3<f32> {
  let front = dot(page(q), vec3<f32>(0.3, 0.55, 0.15));
  return u.paper.rgb * (1.0 - u.ink * front) * light;
}

fn underneath(p : vec2<f32>, s : f32) -> vec3<f32> {
  // faint ruled lines: a second page
  let rule = 1.0 + 0.9 * step(fract(p.y / 22.0), 0.07);
  let base = u.under.rgb * rule;
  // the curl casts a shadow on the page underneath, darkest at the cylinder
  let fall = 1.0 - smoothstep(0.0, u.radius * 1.4 + 18.0, s - u.radius * 0.25);
  return base * (1.0 - u.shadow * 0.9 * fall);
}

@fragment
fn fs(@builtin(position) position : vec4<f32>) -> @location(0) vec4<f32> {
  let p = position.xy / u.resolution * u.css;
  if (u.curled < 0.5) {
    return vec4<f32>(page(p), 1.0);
  }
  let s = dot(p, u.dir) - u.axis;
  let r = max(u.radius, 0.001);
  if (s < 0.0) {
    let qb = p + (PI * r - 2.0 * s) * u.dir;
    if (inside(qb)) {
      // flat part of the back, lying on the page; it darkens slightly towards the fold
      return vec4<f32>(back(qb, 0.92 + 0.08 * smoothstep(0.0, r, -s)), 1.0);
    }
    // the flat page; the folded flap casts a soft shadow around its edges
    let sh = u.shadow * 0.6 * (1.0 - smoothstep(0.0, 26.0, outside(qb)));
    return vec4<f32>(page(p) * (1.0 - sh), 1.0);
  }
  if (s <= r) {
    let k = clamp(s / r, 0.0, 1.0);
    let upper = PI - asin(k);
    let qb = p + (r * upper - s) * u.dir;
    if (inside(qb)) {
      // upper half of the cylinder, back side up: lit from above, dark where it turns away (shadow on the curl)
      return vec4<f32>(back(qb, 0.35 + 0.65 * max(-cos(upper), 0.0)), 1.0);
    }
    let lower = asin(k);
    let qf = p + (r * lower - s) * u.dir;
    if (inside(qf)) {
      // lower half, front side up, curving away from the light
      return vec4<f32>(page(qf) * (0.3 + 0.7 * cos(lower)) * (1.0 - u.shadow * 0.25), 1.0);
    }
  }
  return vec4<f32>(underneath(p, s), 1.0);
}
