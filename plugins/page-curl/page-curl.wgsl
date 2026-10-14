// Page curl (README.md): the page is a tessellated sheet folded over a cylinder (fold.js is the JavaScript twin of fold_point below), seen
// by a camera straight above it, lit by one lamp, with a soft shadow that widens with the height of the paper above what it falls on.
//
// Passes of a curled frame (index.js):
//   vs_occ / fs_occ     the lifted paper as the lamp sees it: coverage and height, half resolution (max blending)
//   blur.wgsl (x6)      two soft copies of it (separable Gaussian): the penumbra of a low and of a high sheet
//   vs_full / fs_under  the page underneath: paper, faintly ruled, receiving the shadow
//   vs_mesh / fs_leaf   the sheet: the live source on its front, paper with the source showing through on its back (4x MSAA, depth)
//   vs_full / fs_pass   at rest without any curl: the source unchanged

struct Uniforms {
  resolution : vec2<f32>,  // presented size, backing px
  css : vec2<f32>,         // presented size, css px (W, H)
  n : vec2<f32>,           // fold: unit direction towards the held corner (leaf space)
  a : vec2<f32>,           // fold: a point on its axis (leaf space)
  R : f32,                 // roll radius, css px
  L : f32,                 // how far the corner was pulled (0: flat)
  mirror : f32,            // 1: bound on the left edge (page x = leaf x); -1: bound on the right (page x = W - leaf x)
  distance : f32,          // camera distance, css px
  shadow : f32,            // 0..1
  ready : f32,             // 0 before the first source upload
  ink : f32,               // how much the front shows through the back
  rows : f32,              // rows of the strip across the roll
  under : vec4<f32>,       // the page underneath
  paper : vec4<f32>,       // the back of the sheet
  light : vec4<f32>,       // xyz: towards the lamp
  lightK : vec4<f32>,      // xy: a point at height z casts its shadow at xy + lightK * z
  span : vec4<f32>,        // the page in the fold's frame: s from x to y (along n), w from z to w (along the axis)
}

@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var source : texture_2d<f32>;
@group(0) @binding(3) var occS : texture_2d<f32>;   // the lifted paper seen from the lamp, a little blurred: r coverage, g height / ZMAX
@group(0) @binding(4) var occL : texture_2d<f32>;   // the same, much blurred

const PI : f32 = 3.14159265;
const ZMAX : f32 = 600.0;

// ---- the fold (fold.js foldPoint / foldNormal) ---------------------------------------------------------------------------------------

fn fold_point(q : vec2<f32>) -> vec3<f32> {
  let s = dot(q - u.a, u.n);
  if (u.L <= 0.0 || s <= 0.0) { return vec3<f32>(q, 0.0); }
  if (u.R > 0.0 && s < PI * u.R) {
    let phi = s / u.R;
    return vec3<f32>(q - u.n * (s - u.R * sin(phi)), u.R * (1.0 - cos(phi)));
  }
  return vec3<f32>(q - u.n * (2.0 * s - PI * u.R), 2.0 * u.R);
}

/** the normal of the side that faces up when the sheet lies flat (its front), in page space */
fn up_normal(q : vec2<f32>) -> vec3<f32> {
  let s = dot(q - u.a, u.n);
  if (u.L <= 0.0 || s <= 0.0) { return vec3<f32>(0.0, 0.0, 1.0); }
  var phi = PI;
  if (u.R > 0.0) { phi = min(PI, s / u.R); }
  return vec3<f32>(-u.n.x * sin(phi) * u.mirror, -u.n.y * sin(phi), cos(phi));
}

/** leaf space -> page space (css px, z up) */
fn to_page(p : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(select(u.css.x - p.x, p.x, u.mirror > 0.0), p.y, p.z);
}

fn to_clip(p : vec3<f32>) -> vec4<f32> {
  let w = (u.distance - p.z) / u.distance;
  let ndc = vec2<f32>(p.x / u.css.x * 2.0 - 1.0, 1.0 - p.y / u.css.y * 2.0);
  return vec4<f32>(ndc, clamp(0.5 - p.z / ZMAX, 0.0, 1.0) * w, w);
}

fn shadow_uv(p : vec3<f32>) -> vec2<f32> { return (p.xy + u.lightK.xy * p.z) / u.css; }

/**
 * The sheet is drawn as a strip in the fold's own frame: rows of constant distance s from the axis (so the silhouette of the roll runs
 * along the rows and stays smooth), one row where the flat part starts, many across the roll (0 .. PI R), one where the flap ends; each
 * row spans the page along the axis. Parts of the strip outside the page are cut in the fragment shader. Returns leaf space.
 */
fn strip_point(vid : u32) -> vec2<f32> {
  let row = vid / 2u;
  let col = f32(vid % 2u);
  let last = u32(u.rows) + 1u;
  var s : f32;
  if (row == 0u) { s = min(u.span.x, 0.0) - 2.0; }
  else if (row >= last) { s = max(u.span.y, PI * u.R) + 2.0; }
  else { s = PI * u.R * f32(row - 1u) / max(u.rows - 1.0, 1.0); }
  let w = mix(u.span.z - 2.0, u.span.w + 2.0, col);
  let t = vec2<f32>(-u.n.y, u.n.x);
  return u.a + u.n * s + t * w;
}

/** how far inside the page a leaf point is (css px; negative outside) */
fn inside_page(q : vec2<f32>) -> f32 {
  return min(min(q.x, u.css.x - q.x), min(q.y, u.css.y - q.y));
}

// ---- noise: the grain of the paper ---------------------------------------------------------------------------------------------------

fn hash12(p : vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
fn vnoise(p : vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2<f32>(1.0, 0.0)), w.x), mix(hash12(i + vec2<f32>(0.0, 1.0)), hash12(i + vec2<f32>(1.0, 1.0)), w.x), w.y);
}
fn grain(q : vec2<f32>) -> f32 {
  return (vnoise(q * vec2<f32>(1.7, 0.55)) - 0.5) * 0.024 + (vnoise(q * 1.3 + 17.0) - 0.5) * 0.02 + (vnoise(q * 0.045) - 0.5) * 0.035;
}

// ---- light and shadow ----------------------------------------------------------------------------------------------------------------

/** the soft shadow of the lifted paper at p (x: 1 = lit) and the ambient occlusion beneath it (y) */
fn shadow_at(p : vec3<f32>) -> vec2<f32> {
  if (u.L <= 0.0) { return vec2<f32>(1.0, 1.0); }
  let uv = shadow_uv(p);
  let wide = textureSampleLevel(occL, samp, uv, 0.0);
  let near = textureSampleLevel(occS, samp, uv, 0.0);
  if (wide.r < 0.002 && near.r < 0.002) { return vec2<f32>(1.0, 1.0); }
  // how high the paper is above p: where it is (near), else around (wide); the penumbra widens with it (contact hardening)
  let h = select(wide.g / max(wide.r, 1e-4), near.g / max(near.r, 1e-4), near.r > 0.05) * ZMAX;
  let rel = max(0.0, h - p.z);
  let pen = 3.0 + rel * 0.32;
  let s = mix(near.r, wide.r, smoothstep(4.0, 26.0, pen));
  let above = smoothstep(1.5, 8.0, rel);
  let ao = 1.0 - 0.18 * wide.r * smoothstep(0.0, 60.0, rel);
  return vec2<f32>(1.0 - 0.62 * u.shadow * s * above, ao);
}

/** lit straight from above a surface keeps its colours (factor 1); turned towards the lamp it brightens a little, away from it it darkens */
fn shade(base : vec3<f32>, n : vec3<f32>, p : vec3<f32>, sh : vec2<f32>, sheen : f32) -> vec3<f32> {
  let l = u.light.xyz;
  let ndl = dot(n, l);
  let diffuse = 0.58 + 0.42 * max(ndl, 0.0) / l.z;
  let view = normalize(vec3<f32>(u.css * 0.5, u.distance) - p);
  let hv = normalize(l + view);
  let spec = pow(max(dot(n, hv), 0.0), 26.0) * sheen * (1.0 - n.z * n.z);
  // thin paper lets warm light through where its other side faces the lamp
  let through = max(-ndl, 0.0) * 0.16;
  return (base * (diffuse * sh.x + through * vec3<f32>(1.0, 0.86, 0.66)) * sh.y) + spec * sh.x;
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

fn front_color(uv : vec2<f32>) -> vec3<f32> {
  let c = textureSampleLevel(source, samp, uv, 0.0);
  return c.rgb * c.a * u.ready;
}

@fragment
fn fs_pass(v : FullOut) -> @location(0) vec4<f32> {
  return vec4<f32>(front_color(v.uv), 1.0);
}

/** the page underneath the sheet: paper, faintly ruled, in the shadow of the lifted sheet */
@fragment
fn fs_under(v : FullOut) -> @location(0) vec4<f32> {
  let q = v.uv * u.css;
  var col = u.under.rgb * (1.0 + grain(q + 401.0));
  let rule = 1.0 - smoothstep(0.0, 0.9, abs(fract(q.y / 26.0 + 0.4) - 0.5) * 26.0 - 0.15);
  col = mix(col, col * vec3<f32>(0.78, 0.84, 0.95), rule * 0.35);
  let sh = shadow_at(vec3<f32>(q, 0.0));
  return vec4<f32>(col * sh.x * sh.y, 1.0);
}

// ---- the lifted paper seen from the lamp ---------------------------------------------------------------------------------------------

struct OccOut {
  @builtin(position) position : vec4<f32>,
  @location(0) z : f32,
  @location(1) local : vec2<f32>,
}

@vertex
fn vs_occ(@builtin(vertex_index) vid : u32) -> OccOut {
  let local = strip_point(vid);
  let p = to_page(fold_point(local));
  let uv = shadow_uv(p);
  var o : OccOut;
  o.position = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.5, 1.0);
  o.z = p.z;
  o.local = local;
  return o;
}

@fragment
fn fs_occ(v : OccOut) -> @location(0) vec4<f32> {
  if (v.z < 0.75 || inside_page(v.local) < 0.0) { discard; }   // the part still lying on the page hides nothing
  return vec4<f32>(1.0, v.z / ZMAX, 0.0, 1.0);
}

// ---- the sheet ------------------------------------------------------------------------------------------------------------------------

struct MeshOut {
  @builtin(position) position : vec4<f32>,
  @location(0) local : vec2<f32>,   // leaf space
  @location(1) page : vec3<f32>,    // page space
}

@vertex
fn vs_mesh(@builtin(vertex_index) vid : u32) -> MeshOut {
  let local = strip_point(vid);
  let p = to_page(fold_point(local));
  var o : MeshOut;
  o.position = to_clip(p);
  o.local = local;
  o.page = p;
  return o;
}

fn luma(c : vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.299, 0.587, 0.114)); }

/** the luminance of the front around uv, averaged over a ring of radius r css px */
fn ring(uv : vec2<f32>, r : f32) -> f32 {
  let d = r / u.css;
  return 0.25 * (luma(front_color(uv + vec2<f32>(d.x, 0.0))) + luma(front_color(uv - vec2<f32>(d.x, 0.0)))
               + luma(front_color(uv + vec2<f32>(0.0, d.y))) + luma(front_color(uv - vec2<f32>(0.0, d.y))));
}

@fragment
fn fs_leaf(v : MeshOut, @builtin(front_facing) facing : bool) -> @location(0) vec4<f32> {
  // the strip is wider than the page: cut it at the page's edges, antialiased (alpha to coverage)
  let inside = inside_page(v.local);
  let cover = clamp(inside / max(fwidth(inside), 1e-4) + 0.5, 0.0, 1.0);
  if (cover <= 0.0) { discard; }
  let nUp = up_normal(v.local);
  // which side the reader sees: the winding of the strip's triangles (consistent along the silhouette, where the normal is edge-on);
  // the strip's triangles wind counter-clockwise on screen where the front faces up, for a sheet bound on the left
  let front = facing == (u.mirror > 0.0);
  let src_uv = vec2<f32>(select(u.css.x - v.local.x, v.local.x, u.mirror > 0.0), v.local.y) / u.css;
  // the sheet's shadow falls on the parts of it that lie on the page; the lifted paper is shaded by its own curvature (a shadow map of
  // half resolution would draw its own texels on it)
  let sh = mix(shadow_at(v.page), vec2<f32>(1.0, 1.0), smoothstep(0.75, 4.0, v.page.z));
  let base = front_color(src_uv);
  var col : vec3<f32>;
  if (front) {
    // the live page itself: exactly its own colours where it lies flat; lit, shaded and shadowed where it lifts. Where the sheet leaves
    // the page a little light is trapped in the wedge between the roll and the page.
    let s = dot(v.local - u.a, u.n);
    let wedge = 1.0 - 0.3 * exp(s / 6.0) * select(0.0, 1.0, s <= 0.0 && u.L > 0.0);
    col = shade(base, nUp, v.page, sh, 0.05) * wedge;
  } else {
    // the back of the sheet: paper, and the front's content showing through it, soft and mirrored as on real paper: whatever stands
    // out from its surroundings on the front (text, borders, controls) darkens the paper a little
    // (only what stands out in the page's own polarity: light ink on a dark page, dark ink on a light one, so the shifted samples of the
    // surroundings never print ghosts of their own)
    let fine = 0.45 * luma(base) + 0.55 * ring(src_uv, 1.0);
    let wide = 0.5 * ring(src_uv, 6.0) + 0.5 * ring(src_uv, 11.0);
    let polarity = select(-1.0, 1.0, wide < 0.45);
    let mark = smoothstep(0.05, 0.32, polarity * (fine - wide)) * smoothstep(0.08, 0.35, abs(dot(nUp, normalize(vec3<f32>(u.css * 0.5, u.distance) - v.page))));
    let paper = u.paper.rgb * (1.0 + grain(v.local + 911.0)) * (1.0 - u.ink * mark);
    col = shade(paper, -nUp, v.page, sh, 0.09);
  }
  // the cut edge of the sheet: a hairline that sets the lifted paper off from what lies beneath it
  let lifted = smoothstep(0.3, 2.5, v.page.z);
  col = mix(col, col * 0.72, (1.0 - smoothstep(0.0, 1.0, inside)) * lifted);
  return vec4<f32>(col, cover);
}
