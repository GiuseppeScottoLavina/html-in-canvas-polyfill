// Cloth (README.md): the page is printed on a sheet of fabric that hangs in front of a wall. Lengths in CSS px of the presented frame
// (x to the right, y down, z towards the viewer; the wall is the plane z = wall < 0, the cloth at rest the plane z = 0).
//
// The sheet is a bicubic B-spline surface over the particles of the simulation (sim.js), which arrive as a texture of control points
// with a ring of ghost points (surface.js). vs_cloth evaluates it at SUB x SUB vertices per cell, with its two tangents and its second
// derivatives: the normal and the curvature are those of the smooth surface, so the grid of the simulation never shows. castCloth() in
// surface.js intersects a line of sight with the same triangles: it is the twin of this rasterisation.
//
// Passes of a frame in which the cloth is not flat at rest (index.js):
//   vs_shadow / fs_shadow   the cloth as the lamp sees it, projected on the wall along the light: its height above the wall and the
//                           square of it (the two moments of a variance shadow map), a quarter of the CSS resolution
//   vs_full / fs_blur (x4)  two blurred copies of it (separable Gaussians): a narrow penumbra for what is close, a wide one for the wall
//   vs_cloth / fs_cloth     the sheet (4x MSAA, depth): the page as its albedo, filtered along its footprint in linear light, lit by the
//                           lamp and the room on its real normal, a sheen lobe, occlusion in its concave folds, the shadow it casts on itself
//   vs_full / fs_wall       the wall where the sheet does not cover it, lit by the same lamp, with the sheet's shadow
// At rest, flat (fs_flat): the page unchanged, no other pass. With reduced motion fs_flat also crossfades between the page and the wall.

struct Globals {
  resolution : vec2<f32>,   // presented size, backing px
  css : vec2<f32>,          // presented size, css px (W, H)
  grid : vec2<f32>,         // cells across and down
  camera : f32,             // distance of the camera from the plane of the cloth at rest, css px
  wall : f32,               // z of the wall (negative)
  light : vec3<f32>,        // towards the lamp (unit)
  sheen : f32,              // 0..1
  ready : f32,              // 0 before the first source upload
  through : f32,            // how much of the print shows on the back of the cloth, 0..1
  shade : f32,              // strength of the shadows, 0..1
  fade : f32,               // fs_flat: 0 the page, 1 the wall (the crossfade of drop and in with reduced motion)
  backdrop : vec3<f32>,     // the wall's colour (linear)
  margin : f32,             // css px by which the shadow map is larger than the canvas on every side
  blur : vec2<f32>,         // fs_blur: the step between taps, in uv
  pad : vec2<f32>,
  linen : vec3<f32>,        // the unprinted back of the cloth (linear)
  pad2 : f32,
}

@group(0) @binding(0) var<uniform> g : Globals;
@group(0) @binding(1) var points : texture_2d<f32>;        // the control points with their ghost ring (rgba32float: xyz)
@group(0) @binding(2) var page : texture_2d<f32>;          // the source
@group(0) @binding(3) var samp : sampler;                  // linear, clamped
@group(0) @binding(4) var shadow_near : texture_2d<f32>;   // the moments, blurred a little
@group(0) @binding(5) var shadow_wide : texture_2d<f32>;   // the moments, blurred a lot
@group(0) @binding(6) var blur_source : texture_2d<f32>;   // fs_blur

const SUB : u32 = 4u;
const PI : f32 = 3.14159265;
/** heights above the wall are stored as a share of this many css px (16-bit floats) */
const HEIGHT_SCALE : f32 = 1024.0;
/** the share of the light on the flat cloth that comes from the room, the rest from the lamp */
const ROOM : f32 = 0.34;
/** how far the lamp's light wraps round a fold (fabric scatters it through its fibres): 0 is Lambert */
const WRAP : f32 = 0.25;
/** the room's light comes from in front of the cloth and a little from above */
const ROOM_AXIS : vec3<f32> = vec3<f32>(0.0, -0.3714, 0.9285);
/** how much of the lamp's light on the far side comes through the cloth */
const TRANSMIT : f32 = 0.16;
/** what the darkest print still scatters: the cloth's shading shows on a black page too (linear reflectance) */
const FABRIC : f32 = 0.05;
/** css px between the threads of the weave */
const THREAD : f32 = 2.4;

// ---- the surface ---------------------------------------------------------------------------------------------------------------------

fn bs_w(t : f32) -> vec4<f32> {
  let t2 = t * t; let t3 = t2 * t; let o = 1.0 - t;
  return vec4<f32>(o * o * o, 3.0 * t3 - 6.0 * t2 + 4.0, -3.0 * t3 + 3.0 * t2 + 3.0 * t + 1.0, t3) / 6.0;
}
fn bs_d(t : f32) -> vec4<f32> {
  let o = 1.0 - t;
  return vec4<f32>(-0.5 * o * o, 1.5 * t * t - 2.0 * t, -1.5 * t * t + t + 0.5, 0.5 * t * t);
}
fn bs_dd(t : f32) -> vec4<f32> { return vec4<f32>(1.0 - t, 3.0 * t - 2.0, 1.0 - 3.0 * t, t); }

struct Surface {
  p : vec3<f32>,     // the point
  ds : vec3<f32>,    // its derivative across (per cell)
  dt : vec3<f32>,    // and down
  dss : vec3<f32>,
  dtt : vec3<f32>,
  dst : vec3<f32>,
}

/** The surface at the vertex (gx, gy) of the drawn grid (SUB vertices per cell). A vertex on the border between two cells belongs to the
    cell after it (surface.js seeCell does the same), so that the two strips that share it compute the very same point. */
fn surface_at(gx : u32, gy : u32) -> Surface {
  let cols = u32(g.grid.x);
  let rows = u32(g.grid.y);
  let ci = min(gx / SUB, cols - 1u);
  let cj = min(gy / SUB, rows - 1u);
  let a = f32(gx - ci * SUB) / f32(SUB);
  let b = f32(gy - cj * SUB) / f32(SUB);
  let wx = bs_w(a); let dx = bs_d(a); let ddx = bs_dd(a);
  let wy = bs_w(b); let dy = bs_d(b); let ddy = bs_dd(b);
  var s : Surface;
  s.p = vec3<f32>(0.0); s.ds = vec3<f32>(0.0); s.dt = vec3<f32>(0.0); s.dss = vec3<f32>(0.0); s.dtt = vec3<f32>(0.0); s.dst = vec3<f32>(0.0);
  for (var j = 0u; j < 4u; j = j + 1u) {
    var row = vec3<f32>(0.0); var row_d = vec3<f32>(0.0); var row_dd = vec3<f32>(0.0);
    for (var i = 0u; i < 4u; i = i + 1u) {
      let c = textureLoad(points, vec2<u32>(ci + i, cj + j), 0).xyz;
      row = row + wx[i] * c; row_d = row_d + dx[i] * c; row_dd = row_dd + ddx[i] * c;
    }
    s.p = s.p + wy[j] * row;
    s.ds = s.ds + wy[j] * row_d;
    s.dt = s.dt + dy[j] * row;
    s.dss = s.dss + wy[j] * row_dd;
    s.dtt = s.dtt + ddy[j] * row;
    s.dst = s.dst + dy[j] * row_d;
  }
  return s;
}

/** the vertex of a strip: one strip per row of the drawn grid (the instance), two vertices per column */
fn strip_vertex(vertex : u32, strip : u32) -> vec2<u32> { return vec2<u32>(vertex / 2u, strip + (vertex % 2u)); }

/** The camera: at (W/2, H/2, camera), looking at the plane z = 0, which it shows exactly as the canvas. Depth 0 at camera/5, 1 at 4 camera. */
fn to_clip(p : vec3<f32>) -> vec4<f32> {
  let d = g.camera - p.z;
  let w = d / g.camera;
  let near = 0.2 * g.camera; let far = 4.0 * g.camera;
  let depth = far * (d - near) / (d * (far - near));
  return vec4<f32>(p.x / g.css.x * 2.0 - 1.0, 1.0 - p.y / g.css.y * 2.0, depth * w, w);
}

// ---- colour, noise ---------------------------------------------------------------------------------------------------------------------

fn to_linear(c : vec3<f32>) -> vec3<f32> {
  return select(pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
}
fn to_srgb(c : vec3<f32>) -> vec3<f32> {
  let x = max(c, vec3<f32>(0.0));
  return select(1.055 * pow(x, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055), x * 12.92, x <= vec3<f32>(0.0031308));
}
/** interleaved gradient noise in [0, 1): a stable dither per backing pixel */
fn ign(p : vec2<f32>) -> f32 { return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715)))); }
fn hash12(p : vec2<f32>) -> f32 {
  var h = vec2<u32>(vec2<i32>(p)) * vec2<u32>(1597334673u, 3812015801u);
  let n = (h.x ^ h.y) * 1597334673u;
  return f32(n >> 8u) / 16777216.0;
}
fn vnoise(p : vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2<f32>(1.0, 0.0)), w.x), mix(hash12(i + vec2<f32>(0.0, 1.0)), hash12(i + vec2<f32>(1.0, 1.0)), w.x), w.y);
}

// ---- the page as the albedo of the cloth -------------------------------------------------------------------------------------------------

fn texel(i : vec2<i32>, size : vec2<i32>) -> vec3<f32> {
  let c = textureLoad(page, clamp(i, vec2<i32>(0), size - vec2<i32>(1)), 0);
  return to_linear(c.rgb * c.a);
}

/** The page at the texel coordinates xy, bilinear in linear light (the texture holds sRGB-encoded values: filtering those would dim a thin
    bright line by half whenever it falls between two texels, and text would flicker as the cloth moves). A sample within 1/128 of a
    texel centre is that texel: the cloth at rest shows the page's own pixels. */
fn bilinear(xy : vec2<f32>, size : vec2<i32>) -> vec3<f32> {
  let q = xy - vec2<f32>(0.5);
  let i = floor(q);
  var f = q - i;
  f = select(f, round(f), abs(f - round(f)) < vec2<f32>(1.0 / 128.0));
  let b = vec2<i32>(i);
  let top = mix(texel(b, size), texel(b + vec2<i32>(1, 0), size), f.x);
  let bottom = mix(texel(b + vec2<i32>(0, 1), size), texel(b + vec2<i32>(1, 1), size), f.x);
  return mix(top, bottom, f.y);
}

/** The page over the footprint of one backing pixel: where the cloth is seen at a slant or from further away the footprint is longer
    than a texel, and it is covered with up to 6 x 2 bilinear taps along its two axes (the source has no mip levels). */
fn page_color(uv : vec2<f32>) -> vec3<f32> {
  let size = vec2<i32>(textureDimensions(page));
  let xy = uv * vec2<f32>(size);
  let ax = dpdx(xy);
  let ay = dpdy(xy);
  let lx = length(ax);
  let ly = length(ay);
  let major = select(ay, ax, lx >= ly);
  let minor = select(ax, ay, lx >= ly);
  let n = clamp(ceil(max(lx, ly) - 0.05), 1.0, 6.0);
  let m = clamp(ceil(min(lx, ly) - 0.05), 1.0, 2.0);
  if (n * m <= 1.0) { return bilinear(xy, size); }
  var sum = vec3<f32>(0.0);
  for (var j = 0.0; j < m; j = j + 1.0) {
    for (var i = 0.0; i < n; i = i + 1.0) {
      sum = sum + bilinear(xy + major * ((i + 0.5) / n - 0.5) + minor * ((j + 0.5) / m - 0.5), size);
    }
  }
  return sum / (n * m);
}

// ---- light and shadow ----------------------------------------------------------------------------------------------------------------

/** where the light that passes the point p (at the height h above the wall) meets the wall, as uv of the shadow map */
fn shadow_uv(p : vec2<f32>, h : f32) -> vec2<f32> {
  let q = p - g.light.xy / g.light.z * h;
  return (q + vec2<f32>(g.margin)) / (g.css + vec2<f32>(2.0 * g.margin));
}

/** The share of the lamp's light that reaches a point at the height h above the wall, from the two moments of the heights of the cloth
    over it (a variance shadow map: Chebyshev's bound, which is exact at the edge of one flat occluder). `m` is the blurred pair. */
fn chebyshev(m : vec2<f32>, h : f32, slack : f32) -> f32 {
  let mean = m.x * HEIGHT_SCALE;
  let d = mean - h - slack;
  if (d <= 0.0) { return 1.0; }
  let variance = max(m.y * HEIGHT_SCALE * HEIGHT_SCALE - mean * mean, 4.0);
  let p = variance / (variance + d * d);
  return clamp((p - 0.12) / 0.88, 0.0, 1.0);   // what is left of the bound far inside a shadow is not light
}

fn wrap_light(c : f32) -> f32 { return max(c + WRAP, 0.0) / (1.0 + WRAP); }
fn room_light(n : vec3<f32>) -> f32 { return 0.5 + 0.5 * dot(n, ROOM_AXIS); }

/** The sheen of the fabric: the fibres that stand up from the weave scatter light towards grazing directions. Estevez and Kulla's
    distribution ("Production Friendly Microfacet Sheen BRDF", 2017) with Neubelt and Pettineo's visibility term, times the cosine;
    and the smooth threads of the weave themselves mirror the lamp in a broad lobe (GGX, the same visibility). */
fn sheen_lobe(n : vec3<f32>, v : vec3<f32>, l : vec3<f32>) -> f32 {
  let nl = max(dot(n, l), 0.0);
  let nv = max(dot(n, v), 1e-3);
  let nh = clamp(dot(n, normalize(l + v)), 0.0, 1.0);
  let fuzz = 3.8 * pow(max(1.0 - nh * nh, 1e-4), 0.9) / (2.0 * PI);
  let a2 = 0.2;   // roughness 0.45
  let k = nh * nh * (a2 - 1.0) + 1.0;
  let thread = 0.09 * a2 / (PI * k * k);
  return (fuzz + thread) * nl / (4.0 * (nl + nv - nl * nv) + 1e-3);
}

/** the weave in the sheen: over and under, thread by thread; faded where a pixel covers more than half a thread (1 elsewhere) */
fn weave(uv : vec2<f32>) -> f32 {
  let t = uv * g.css / THREAD;
  let w = max(fwidth(t.x), fwidth(t.y));
  let pattern = sin(2.0 * PI * t.x) * sin(2.0 * PI * t.y);
  return 1.0 + 0.45 * pattern * (1.0 - smoothstep(0.25, 0.6, w));
}

/** the wall: matt plaster, lit by the lamp in a soft pool towards the side it hangs on */
fn wall_color(q : vec2<f32>) -> vec3<f32> {
  let aspect = g.css.x / g.css.y;
  let c = (q / g.css - vec2<f32>(0.5) - 0.3 * normalize(g.light.xy)) * vec2<f32>(aspect, 1.0);
  let pool = 0.42 + 0.9 * exp(-dot(c, c) * 0.9);
  let r = mat2x2<f32>(0.8, 0.6, -0.6, 0.8) * q;
  let grain = 1.0 + 0.10 * (vnoise(r * 0.011) - 0.5) + 0.07 * (vnoise(r * 0.047 + 31.0) - 0.5) + 0.04 * (vnoise(r * 0.31 + 7.0) - 0.5);
  return g.backdrop * pool * grain;
}

// ---- full-screen passes ----------------------------------------------------------------------------------------------------------------

struct FullOut {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
}

@vertex
fn vs_full(@builtin(vertex_index) i : u32) -> FullOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var o : FullOut;
  o.position = vec4<f32>(p[i], 1.0, 1.0);
  o.uv = vec2<f32>((p[i].x + 1.0) * 0.5, (1.0 - p[i].y) * 0.5);
  return o;
}

/** the cloth flat at rest: the page unchanged. With reduced motion, also the crossfade between the page and the bare wall. */
@fragment
fn fs_flat(v : FullOut) -> @location(0) vec4<f32> {
  let c = textureSampleLevel(page, samp, v.uv, 0.0);
  let src = c.rgb * c.a * g.ready;
  if (g.fade <= 0.0) { return vec4<f32>(src, 1.0); }
  let col = mix(to_linear(src), wall_color(v.uv * g.css), g.fade);
  return vec4<f32>(to_srgb(col) + vec3<f32>((ign(v.position.xy) - 0.5) / 255.0), 1.0);
}

@fragment
fn fs_wall(v : FullOut) -> @location(0) vec4<f32> {
  let q = v.uv * g.css;
  // the cloth's shadow: a wide penumbra (the cloth hangs a hand's width off the wall), a narrower one where it comes close
  let uv = shadow_uv(q, 0.0);
  let wide = textureSampleLevel(shadow_wide, samp, uv, 0.0).rg;
  let near = textureSampleLevel(shadow_near, samp, uv, 0.0).rg;
  let closeness = 1.0 - smoothstep(0.1, 0.6, near.x * HEIGHT_SCALE / max(-g.wall, 1.0));
  let lit = mix(chebyshev(wide, 0.0, 0.0), chebyshev(near, 0.0, 0.0), closeness);
  // and it hides part of the room from the wall behind it
  let cover = smoothstep(0.0, 1.0, wide.x * HEIGHT_SCALE / max(-g.wall, 1.0));
  let light = ROOM * (1.0 - 0.45 * g.shade * cover) + (1.0 - ROOM) * mix(1.0, lit, g.shade);
  let col = wall_color(q) * light;
  return vec4<f32>(to_srgb(col) + vec3<f32>((ign(v.position.xy) - 0.5) / 255.0), 1.0);
}

/** a separable Gaussian of 9 texels (5 bilinear taps), along g.blur */
@fragment
fn fs_blur(v : FullOut) -> @location(0) vec4<f32> {
  var sum = textureSampleLevel(blur_source, samp, v.uv, 0.0) * 0.2270270270;
  sum = sum + (textureSampleLevel(blur_source, samp, v.uv + g.blur * 1.3846153846, 0.0) + textureSampleLevel(blur_source, samp, v.uv - g.blur * 1.3846153846, 0.0)) * 0.3162162162;
  sum = sum + (textureSampleLevel(blur_source, samp, v.uv + g.blur * 3.2307692308, 0.0) + textureSampleLevel(blur_source, samp, v.uv - g.blur * 3.2307692308, 0.0)) * 0.0702702703;
  return sum;
}

// ---- the cloth as the lamp sees it -----------------------------------------------------------------------------------------------------

struct ShadowOut {
  @builtin(position) position : vec4<f32>,
  @location(0) height : f32,
}

@vertex
fn vs_shadow(@builtin(vertex_index) vertex : u32, @builtin(instance_index) strip : u32) -> ShadowOut {
  let at = strip_vertex(vertex, strip);
  let p = surface_at(at.x, at.y).p;
  let h = p.z - g.wall;
  let uv = shadow_uv(p.xy, h);
  var o : ShadowOut;
  o.position = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.5, 1.0);
  o.height = h / HEIGHT_SCALE;
  return o;
}

/** the two moments of the height; where the cloth lies over itself the highest layer stays (max blending) */
@fragment
fn fs_shadow(v : ShadowOut) -> @location(0) vec4<f32> {
  let h = max(v.height, 0.0);
  return vec4<f32>(h, h * h, 0.0, 1.0);
}

// ---- the cloth -------------------------------------------------------------------------------------------------------------------------

struct ClothOut {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,        // the page point, 0..1
  @location(1) world : vec3<f32>,
  @location(2) normal : vec3<f32>,    // of the printed side
  @location(3) curvature : f32,       // mean curvature, 1 / css px; positive where the printed side is concave
}

@vertex
fn vs_cloth(@builtin(vertex_index) vertex : u32, @builtin(instance_index) strip : u32) -> ClothOut {
  let at = strip_vertex(vertex, strip);
  let s = surface_at(at.x, at.y);
  let n = normalize(cross(s.ds, s.dt));
  // the mean curvature from the two fundamental forms
  let E = dot(s.ds, s.ds); let F = dot(s.ds, s.dt); let G = dot(s.dt, s.dt);
  let L = dot(s.dss, n); let M = dot(s.dst, n); let N = dot(s.dtt, n);
  var o : ClothOut;
  o.position = to_clip(s.p);
  o.uv = vec2<f32>(f32(at.x), f32(at.y)) / (g.grid * f32(SUB));
  o.world = s.p;
  o.normal = n;
  o.curvature = (E * N - 2.0 * F * M + G * L) / max(2.0 * (E * G - F * F), 1e-6);
  return o;
}

@fragment
fn fs_cloth(v : ClothOut, @builtin(front_facing) facing : bool) -> @location(0) vec4<f32> {
  let albedo = page_color(v.uv) * g.ready;
  let printed = normalize(v.normal);
  let eye = vec3<f32>(g.css * 0.5, g.camera);
  let view = normalize(eye - v.world);
  // the side that is seen, and its normal
  let n = select(-printed, printed, facing);
  let h = v.world.z - g.wall;
  // the lamp's light past the cloth itself: the narrow penumbra, with slack for the slope of the cloth inside the blur
  let moments = textureSampleLevel(shadow_near, samp, shadow_uv(v.world.xy, h), 0.0).rg;
  let lit = mix(1.0, chebyshev(moments, h, 5.0), g.shade);
  // the room's light does not reach into a concave fold
  let concave = max(select(-v.curvature, v.curvature, facing), 0.0);
  let open = 1.0 - 0.6 * g.shade * (1.0 - exp(-concave * 55.0));
  // what the same point of the page receives when the cloth hangs flat: the cloth is lit relative to it, so that the flat cloth is the page
  let rest_n = vec3<f32>(0.0, 0.0, 1.0);
  let rest_view = normalize(eye - vec3<f32>(v.uv * g.css, 0.0));
  let level = ROOM * room_light(rest_n) + (1.0 - ROOM) * wrap_light(g.light.z);
  let lamp = wrap_light(dot(n, g.light)) * lit;
  let room = room_light(n) * open;
  // the sheen: white light, a little of the cloth's own colour, woven
  let tint = mix(vec3<f32>(1.0), albedo / max(max(albedo.r, max(albedo.g, albedo.b)), 0.05), 0.25) * weave(v.uv);
  let gloss = 3.4 * g.sheen;
  var col : vec3<f32>;
  var changed : f32;
  if (facing) {
    let light = (ROOM * room + (1.0 - ROOM) * lamp) / level;
    let sheen = sheen_lobe(n, view, g.light) * lit - sheen_lobe(rest_n, rest_view, g.light);
    let rim = pow(1.0 - max(dot(n, view), 0.0), 4.0) * room - pow(1.0 - rest_view.z, 4.0) * room_light(rest_n);
    col = albedo * light + FABRIC * (light - 1.0) + tint * gloss * (sheen + 0.04 * rim);
    changed = clamp(abs(light - 1.0) * 40.0 + abs(sheen) * 40.0 + abs(rim) * 10.0, 0.0, 1.0);
  } else {
    // the back: the linen with the print soaked through it, lit by the room behind the cloth (dimmer: the wall is near) and by the
    // lamp's light that comes through from the printed side
    let back = mix(g.linen, albedo, g.through);
    let through = wrap_light(dot(printed, g.light)) * lit * TRANSMIT;
    let light = (ROOM * room * 0.75 + (1.0 - ROOM) * (lamp + through)) / level;
    let sheen = sheen_lobe(n, view, g.light) * lit;
    col = back * light + tint * gloss * 0.6 * sheen * dot(g.linen, vec3<f32>(1.0));
    changed = 1.0;
  }
  // dithered where the effect lit or shaded the page; the page's own pixels where it did not
  return vec4<f32>(to_srgb(col) + vec3<f32>((ign(v.position.xy) - 0.5) / 255.0 * changed), 1.0);
}
