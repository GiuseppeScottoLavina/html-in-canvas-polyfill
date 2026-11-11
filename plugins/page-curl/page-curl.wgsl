// Page curl (README.md): the page is a tessellated sheet folded over a cone or a cylinder (fold.js is the JavaScript twin of fold_point below), seen
// by a camera straight above it, lit by one lamp at a finite distance (ambient, diffuse, a sheen that rises at grazing angles, light through
// the thin paper), with a soft shadow that widens with the height of the paper above what it falls on; the paper has a lit relief, and
// what the effect shades is dithered so that its gradients do not band.
//
// Extended range (HDR_PEAK > 1): the page, the paper and their diffuse light (room, lamp, the light through the sheet) stay under white.
// The lamp's mirror highlight goes above it, modestly (paper is not a mirror): a band along the roll, on the back of the sheet where it
// reflects the lamp to the eye and on the glossy front where it turns over. It rises as the corner leaves its rest pose (u.light.w): the
// dog-ear at rest shows nothing above white.
//
// Passes of a curled frame (index.js):
//   vs_occ / fs_occ     the lifted paper as the lamp sees it: coverage and height, half resolution (max blending)
//   blur.wgsl (x6)      two soft copies of it (separable Gaussian): the penumbra of a low and of a high sheet
//   vs_full / fs_under  the page underneath: paper, faintly ruled, lit by the lamp, receiving the shadow
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
  light : vec4<f32>,       // xyz: towards the lamp; w: 0 with the corner in its rest pose .. 1 lifted away from it (extended range)
  lightK : vec4<f32>,      // xy: a point at height z casts its shadow at xy + lightK * z
  span : vec4<f32>,        // the page in the fold's frame: s from x to y (along n), w from z to w (along the axis)
  cone : vec4<f32>,        // the cone: x apex (a + t x on the axis), y gs (g = gs t points from the apex to the page), z k = sine of its half angle (0: a cylinder), w its cosine
  reach : vec4<f32>,       // the curled page from the apex: x r min, y r max, z its largest polar angle; w the held corner's height
  extra : vec4<f32>,       // x the held corner's leaf y; y 1 where the page underneath is the host's live under page
}

@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var source : texture_2d<f32>;
@group(0) @binding(3) var occS : texture_2d<f32>;   // the lifted paper seen from the lamp, a little blurred: r coverage, g height / ZMAX
@group(0) @binding(4) var occL : texture_2d<f32>;   // the same, much blurred
@group(0) @binding(5) var underTex : texture_2d<f32>;   // the host's live under page (read only where u.extra.y > 0)

const PI : f32 = 3.14159265;
const ZMAX : f32 = 600.0;

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
// the lamp's highlight above white: its strength on the back of the sheet and on its front, and the part of the sheen's lobe (exponent
// HOT_LOBE, that of the back's sheen on a standard target) that it takes: from HOT_FROM of the lobe's peak up, rising smoothly. The top
// of a broad lobe, not a narrow one: it is there for any direction of the pull, as a band about 10 px wide on a roll of radius 48, and
// it is exactly 0 beside that band (no faint light over the whole side of the roll that faces the lamp)
const HOT_BACK : f32 = 0.9;
const HOT_FRONT : f32 = 0.6;
const HOT_LOBE : f32 = 40.0;
const HOT_FROM : f32 = 0.8;

// ---- the fold (fold.js foldPoint / foldNormal) ---------------------------------------------------------------------------------------

fn axis_t() -> vec2<f32> { return vec2<f32>(-u.n.y, u.n.x); }

/**
 * A curled point (s > 0) of the leaf on the cone (fold.js conePoint): how far it moves along n and along g, its height, and its angle b
 * round the cone (PI on the flap). The apex's polar frame: rho along g, s along n. Written without the apex's large coordinates.
 */
fn cone_point(q : vec2<f32>, s : f32) -> vec4<f32> {
  let k = u.cone.z;
  let ca = u.cone.w;
  let rho = u.cone.y * (dot(q - u.a, axis_t()) - u.cone.x);
  let r = length(vec2<f32>(rho, s));
  let th = atan2(s, rho);
  // beyond the apex nothing is curled (the apex lies beyond the curl): a point there lies on the fold line, by rounding past it
  if (rho <= 0.0) { return vec4<f32>(0.0); }
  if (th < PI * k) {
    let b = th / k;
    let dg = s * s / (r + rho) - r * k * k * (1.0 - cos(b));
    return vec4<f32>(r * k * sin(b) - s, dg, r * k * ca * (1.0 - cos(b)), b);
  }
  let tp = th - PI * k;
  let r1 = r * cos(tp);
  return vec4<f32>(-r * sin(tp) - s, 2.0 * r * sin(th - 0.5 * PI * k) * sin(0.5 * PI * k) - 2.0 * k * k * r1, 2.0 * k * ca * r1, PI);
}

fn fold_point(q : vec2<f32>) -> vec3<f32> {
  let s = dot(q - u.a, u.n);
  if (u.L <= 0.0 || s <= 0.0) { return vec3<f32>(q, 0.0); }
  if (u.cone.z > 0.0) {
    let c = cone_point(q, s);
    return vec3<f32>(q + u.n * c.x + axis_t() * (u.cone.y * c.y), c.z);
  }
  if (u.R > 0.0 && s < PI * u.R) {
    let phi = s / u.R;
    return vec3<f32>(q - u.n * (s - u.R * sin(phi)), u.R * (1.0 - cos(phi)));
  }
  return vec3<f32>(q - u.n * (2.0 * s - PI * u.R), 2.0 * u.R);
}

/** how far round the roll a curled point is (0 .. PI; PI on the flap) */
fn roll_angle(q : vec2<f32>, s : f32) -> f32 {
  if (u.cone.z > 0.0) { return cone_point(q, s).w; }
  if (u.R > 0.0) { return min(PI, s / u.R); }
  return PI;
}

/** the roll's radius across the leaf point q (the cone narrows towards its apex) */
fn local_radius(q : vec2<f32>) -> f32 {
  if (u.cone.z > 0.0) { return u.cone.z * max(u.cone.y * (dot(q - u.a, axis_t()) - u.cone.x), 0.0); }
  return u.R;
}

/** the normal of the side that faces up when the sheet lies flat (its front), in page space */
fn up_normal(q : vec2<f32>) -> vec3<f32> {
  let s = dot(q - u.a, u.n);
  if (u.L <= 0.0 || s <= 0.0) { return vec3<f32>(0.0, 0.0, 1.0); }
  let b = roll_angle(q, s);
  // on a cone of half angle asin(k): g k ca (1 - cos b) - n ca sin b + z (k^2 + ca^2 cos b); the cylinder is k = 0
  let k = select(0.0, u.cone.z, u.cone.z > 0.0);
  let ca = select(1.0, u.cone.w, u.cone.z > 0.0);
  let v = u.n * (-ca * sin(b)) + axis_t() * (u.cone.y * k * ca * (1.0 - cos(b)));
  return vec3<f32>(v.x * u.mirror, v.y, k * k + ca * ca * cos(b));
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
 * The sheet is drawn as a strip in the fold's own frame, so that the silhouette of the roll runs along its rows and stays smooth: one row
 * where the flat part starts and one on the fold line, many across the roll, one where the flap ends; each row spans the page. On a
 * cylinder the rows across the roll are lines of constant distance s from the axis; on a cone they are its straight lines, through the
 * apex at polar angles 0 .. PI k (the flap is one wedge up to the curl's largest angle). Parts of the strip outside the page are cut in
 * the fragment shader. Returns leaf space.
 */
fn strip_point(vid : u32) -> vec2<f32> {
  let row = vid / 2u;
  let col = f32(vid % 2u);
  let t = axis_t();
  if (u.cone.z > 0.0 && row >= 2u) {
    var th = u.reach.z;
    if (row < u32(u.rows) + 2u) { th = PI * u.cone.z * f32(row - 2u) / max(u.rows - 1.0, 1.0); }
    // the strip runs along +t in every row (the winding tells the front from the back)
    let r = mix(u.reach.x, u.reach.y, select(1.0 - col, col, u.cone.y > 0.0));
    return u.a + t * u.cone.x + (t * (u.cone.y * cos(th)) + u.n * sin(th)) * r;
  }
  let last = u32(u.rows) + 1u;
  var s : f32;
  if (row == 0u) { s = min(u.span.x, 0.0) - 2.0; }
  else if (row >= last) { s = max(u.span.y, PI * u.R) + 2.0; }
  else { s = PI * u.R * f32(row - 1u) / max(u.rows - 1.0, 1.0); }
  let w = mix(u.span.z - 2.0, u.span.w + 2.0, col);
  return u.a + u.n * s + t * w;
}

/** how far inside the page a leaf point is (css px; negative outside) */
fn inside_page(q : vec2<f32>) -> f32 {
  return min(min(q.x, u.css.x - q.x), min(q.y, u.css.y - q.y));
}

// ---- noise: the grain and the fibres of the paper ------------------------------------------------------------------------------------

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
/** the albedo of the paper: fibres, tooth and a faint cloudiness (a factor around 1) */
fn grain(q : vec2<f32>) -> f32 {
  return (vnoise(q * vec2<f32>(1.7, 0.55)) - 0.5) * 0.024 + (vnoise(q * 1.3 + 17.0) - 0.5) * 0.02 + (vnoise(q * 0.045) - 0.5) * 0.035;
}
/** the relief of the paper (0..1): long fibres and a finer tooth */
fn relief(q : vec2<f32>) -> f32 { return 0.55 * vnoise(q * vec2<f32>(0.9, 0.24)) + 0.45 * vnoise(q * 1.8 + 7.0); }
/** the normal `n` tilted by the relief of the paper at the leaf point q: the lamp picks the texture out, most where it grazes the sheet */
fn bumped(n : vec3<f32>, q : vec2<f32>) -> vec3<f32> {
  let e = vec2<f32>(0.7, 0.0);
  let g = vec2<f32>(relief(q + e) - relief(q - e), relief(q + e.yx) - relief(q - e.yx)) * 0.08;
  return normalize(n - vec3<f32>(g.x * u.mirror, g.y, 0.0));
}
/** +-half a level of 8 bits (interleaved gradient noise): smooth gradients of light and shadow do not band */
fn dither(pos : vec2<f32>) -> f32 { return (fract(52.9829189 * fract(dot(pos, vec2<f32>(0.06711056, 0.00583715)))) - 0.5) / 255.0; }

// ---- light and shadow ----------------------------------------------------------------------------------------------------------------

/** the lamp's light at p past the lifted paper (x: 1 = lit, its penumbra widening with the paper's height) and the ambient occlusion beneath it (y) */
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
  let ao = 1.0 - 0.22 * wide.r * smoothstep(0.0, 60.0, rel);
  return vec2<f32>(1.0 - 0.9 * u.shadow * s * above, ao);
}

const AMBIENT : f32 = 0.4;   // the room's share of the light on the flat page
const LAMP : f32 = 5.0;      // the lamp's distance from the centre of the page, in page sizes
/** from p to the lamp: high above the page, towards its top-right corner (index.js LIGHT) */
fn to_lamp(p : vec3<f32>) -> vec3<f32> { return vec3<f32>(u.css * 0.5, 0.0) + u.light.xyz * (LAMP * max(u.css.x, u.css.y)) - p; }
fn to_eye(p : vec3<f32>) -> vec3<f32> { return normalize(vec3<f32>(u.css * 0.5, u.distance) - p); }
/**
 * The light that reaches a surface of normal n at p, as (room, lamp), in units of the flat page at its centre (room + lamp = 1 there):
 * the room's light comes from the dome above the page, so a surface turned edge-on sees half of it and one facing down none; the lamp's
 * with its angle and its distance.
 */
fn light2(p : vec3<f32>, n : vec3<f32>) -> vec2<f32> {
  let d = to_lamp(p);
  let r2 = dot(d, d);
  let D = LAMP * max(u.css.x, u.css.y);
  let k = 1.0 / (AMBIENT + (1.0 - AMBIENT) * u.light.z);
  return vec2<f32>(AMBIENT * (0.5 + 0.5 * n.z), (1.0 - AMBIENT) * max(dot(n, d), 0.0) * inverseSqrt(r2) * D * D / r2) * k;
}
/** the lamp's highlight on the sheet: a lobe around the half vector (weight k, exponent e), where the lamp reaches */
fn gloss(p : vec3<f32>, n : vec3<f32>, k : f32, e : f32) -> f32 {
  let l = normalize(to_lamp(p));
  return k * pow(max(dot(n, normalize(l + to_eye(p))), 0.0), e) * smoothstep(0.0, 0.2, dot(n, l));
}
/** room light is cool, the lamp warm: what the lamp cannot reach turns a little blue */
/** the paper of the sheet is exposed a little under the flat page, so that the highlight along the roll does not clip */
const EXPOSURE : f32 = 0.85;
const ROOM : vec3<f32> = vec3<f32>(0.95, 0.98, 1.04);
const WARM : vec3<f32> = vec3<f32>(1.02, 1.0, 0.97);
/**
 * How much the roll occludes the page beneath at q (0..1). The roll is a cylinder of radius R lying along the fold line (on a cone, R is its local radius), its axis R above
 * the page; from a point x px beyond the fold line it hides R^2 / (x^2 + R^2) of the dome's cosine-weighted light (exact for a long
 * cylinder). Measured here from 0.6 R, where the paper comes down to the page under the roll's edge, so it is dark right at that edge and
 * fades within about two radii: a larger (higher) roll occludes wider. Faded out where the roll ends at the page's edges.
 */
fn roll_ao(q : vec2<f32>) -> f32 {
  if (u.L <= 0.0 || u.R <= 0.0) { return 0.0; }
  let leaf = vec2<f32>(select(u.css.x - q.x, q.x, u.mirror > 0.0), q.y);
  let R = max(local_radius(leaf), 0.5);            // a cone rolls narrower towards its apex
  let x = max(dot(leaf - u.a, u.n) - 0.6 * R, 0.0);
  let along = leaf - u.n * dot(leaf - u.a, u.n);   // the foot on the fold line; the roll at this place spans s = 0 .. PI R
  let there = max(inside_page(along), inside_page(along + u.n * (PI * R)));
  return R * R / (x * x + R * R) * smoothstep(-0.5 * R, 0.25 * R, there);
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

/** the page underneath the sheet: paper, faintly ruled, lit by the room and the lamp; the roll hides the room's light near it, the lifted
    paper the lamp's (a penumbra that widens with its height) */
@fragment
fn fs_under(v : FullOut) -> @location(0) vec4<f32> {
  let q = v.uv * u.css;
  if (u.extra.y > 0.5) { return live_under(v, q); }
  var col = u.under.rgb * (1.0 + grain(q + 401.0));
  let rule = 1.0 - smoothstep(0.0, 0.9, abs(fract(q.y / 26.0 + 0.4) - 0.5) * 26.0 - 0.15);
  col = mix(col, col * vec3<f32>(0.78, 0.84, 0.95), rule * 0.35);
  let p = vec3<f32>(q, 0.0);
  let lt = light2(p, bumped(vec3<f32>(0.0, 0.0, 1.0), q + 401.0));
  let sh = shadow_at(p);
  // the dome's light hidden by the roll; the lamp is not a point either, and loses part of its own close to the roll
  let ao = roll_ao(q);
  col = col * (lt.x * sh.y * (1.0 - pow(ao, 1.2)) * ROOM + lt.y * sh.x * (1.0 - 0.6 * ao * ao) * WARM);
  // extended range: paper lit diffusely stays between black and white (a float target would keep the dither below 0, and a light paper
  // near the lamp above 1)
  if (HDR_PEAK > 1.0) { return vec4<f32>(clamp(col + dither(v.position.xy), vec3<f32>(0.0), vec3<f32>(1.0)), 1.0); }
  return vec4<f32>(col + dither(v.position.xy), 1.0);
}

/** the host's live under page beneath the sheet: its own pixels wherever nothing shades it (the light relative to the flat, unshadowed page, as the
    front's), darkened by the same roll shadow and occlusion as the paper; softened towards 0.25 so that its content stays readable in the shade */
fn live_under(v : FullOut, q : vec2<f32>) -> vec4<f32> {
  let c = textureSampleLevel(underTex, samp, v.uv, 0.0);
  let page = c.rgb * c.a;
  let p = vec3<f32>(q, 0.0);
  let lt = light2(p, vec3<f32>(0.0, 0.0, 1.0));
  let sh = shadow_at(p);
  let ao = roll_ao(q);
  let lit = (lt.x * sh.y * (1.0 - pow(ao, 1.2)) + lt.y * sh.x * (1.0 - 0.6 * ao * ao)) / max(lt.x + lt.y, 1e-4);
  let k = clamp(lit, 0.0, 1.0);
  let col = page * (0.25 + 0.75 * k);
  // dither only what the shadow darkened: the unshaded page stays exactly its own pixels
  let d = select(dither(v.position.xy), 0.0, k > 0.9995);
  return vec4<f32>(clamp(col + d, vec3<f32>(0.0), vec3<f32>(HDR_PEAK)), 1.0);
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

/** the same on the diagonals */
fn diag(uv : vec2<f32>, r : f32) -> f32 {
  let d = 0.7071 * r / u.css;
  return 0.25 * (luma(front_color(uv + d)) + luma(front_color(uv - d))
               + luma(front_color(uv + vec2<f32>(d.x, -d.y))) + luma(front_color(uv - vec2<f32>(d.x, -d.y))));
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
  var base = front_color(src_uv);
  // extended range: the page is at most white here; what a plugin before this one lit above white is carried to the front as it is
  var lit_before = vec3<f32>(0.0);
  var hot = 0.0;
  if (HDR_PEAK > 1.0) {
    lit_before = max(base - vec3<f32>(1.0), vec3<f32>(0.0));
    base = min(base, vec3<f32>(1.0));
  }
  let s = dot(v.local - u.a, u.n);
  let curled = u.L > 0.0;
  var col : vec3<f32>;
  if (front) {
    // the live page itself: exactly its own colours where it lies flat (its light relative to the flat page at the same place); shaded
    // by its real normal where it lifts. The crease is dark: the page and the roll close in on each other there, and inside the tube the
    // room's light is mostly hidden (the inside of the roll, seen past a short flap or at the roll's open end). Softened towards 0.5 so the
    // live content stays readable on the roll
    // (and exactly 1 where nothing shades it).
    var cav = 1.0;
    var b = 0.0;
    if (curled) {
      if (s <= 0.0) { cav = 1.0 - 0.9 * exp(s / (3.0 + 0.08 * local_radius(v.local))); }
      else { b = roll_angle(v.local, s); cav = 0.1 + 0.6 * smoothstep(0.0, 0.6 * PI, b); }
    }
    let lt = light2(v.page, nUp);
    let level = light2(vec3<f32>(v.page.xy, 0.0), vec3<f32>(0.0, 0.0, 1.0));
    let lit = (lt.x * sh.y + lt.y * sh.x) * cav / (level.x + level.y);
    col = base * (0.5 + 0.5 * lit) + gloss(v.page, nUp, 0.12, 16.0) * smoothstep(0.0, 0.25 * PI, b) * cav;
    if (HDR_PEAK > 1.0) { hot = HOT_FRONT * smoothstep(HOT_FROM, 1.0, gloss(v.page, nUp, 1.0, HOT_LOBE)) * smoothstep(0.0, 0.25 * PI, b) * cav; }
  } else {
    // the back of the sheet: paper with its own relief, lit by its real normal across the roll (bright where it faces the lamp, a highlight
    // band where it mirrors it, darker towards the rolled edge, which sees only half the room), and the front's content showing through it,
    // soft and mirrored as on real paper: whatever stands out from its surroundings on the front (text, borders, controls) darkens the paper
    // (only what stands out in the page's own polarity: light ink on a dark page, dark ink on a light one, so the shifted samples of the
    // surroundings never print ghosts of their own). The show-through follows the light: plain in the light, it fades in the shade.
    // the fibres scatter the light that comes through: the print is seen diffused (a 9-tap blur of about 1 css px) and with a soft response,
    // never as a crisp, thresholded copy of the front
    let fine = 0.3 * luma(base) + 0.4 * ring(src_uv, 0.9) + 0.3 * diag(src_uv, 1.3);
    let wide = 0.5 * ring(src_uv, 6.0) + 0.5 * ring(src_uv, 11.0);
    let polarity = select(-1.0, 1.0, wide < 0.45);
    let mark = smoothstep(0.0, 0.5, polarity * (fine - wide)) * smoothstep(0.08, 0.35, abs(dot(nUp, to_eye(v.page))));
    let nb = bumped(-nUp, v.local + 911.0);
    let lt = light2(v.page, nb);
    let light = (lt.x * sh.y * ROOM + lt.y * sh.x * WARM) * EXPOSURE;
    let paper = u.paper.rgb * (1.0 + grain(v.local + 911.0)) * (1.0 - u.ink * mark * (0.35 + 0.75 * (lt.x + lt.y)));
    // thin paper lets the lamp through where its other side faces it: warm, with the ink of the front darker in it
    let through = max(dot(nUp, normalize(to_lamp(v.page))), 0.0) * 0.3 * (1.0 - 1.6 * u.ink * mark);
    // the highlight of paper is partly its own colour (light scattered in its fibres): weaker on a dark paper
    let tone = 0.3 + 0.7 * luma(u.paper.rgb);
    col = paper * light + paper * through * vec3<f32>(1.0, 0.84, 0.62) + gloss(v.page, nb, 0.2, 40.0) * sh.x * tone;
    if (HDR_PEAK > 1.0) { hot = HOT_BACK * smoothstep(HOT_FROM, 1.0, gloss(v.page, nb, 1.0, HOT_LOBE)) * sh.x * tone; lit_before = vec3<f32>(0.0); }
  }
  // the cut edge of the lifted sheet shows the paper's thickness: a darker outer line (the cut face, turned away) and a lit lip just inside
  let lifted = smoothstep(0.3, 2.5, v.page.z);
  let rim = (1.0 - smoothstep(0.0, 0.9, inside)) * lifted;
  let lip = smoothstep(0.6, 1.1, inside) * (1.0 - smoothstep(1.1, 2.0, inside)) * lifted;
  col = mix(col, col * 0.6, rim) + col * lip * 0.08;
  // dither what the effect lit or shaded; the flat, unshadowed front stays the page's own pixels
  let d = select(1.0, max(lifted, 1.0 - sh.x), front);
  if (HDR_PEAK > 1.0) {
    // the lamp mirrored by the sheet (not by its cut edge), once the corner has left its rest pose
    let lit = hdr_light(min(col, vec3<f32>(1.0)) + lit_before, WARM * (hot * (1.0 - rim) * clamp(u.light.w, 0.0, 1.0)));
    return vec4<f32>(max(lit + dither(v.position.xy) * d, vec3<f32>(0.0)), cover);
  }
  return vec4<f32>(col + dither(v.position.xy) * d, cover);
}
