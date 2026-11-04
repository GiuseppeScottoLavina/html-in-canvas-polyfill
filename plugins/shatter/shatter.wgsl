// Shatter (README.md): a spiderweb of cracks (shards.js) drawn as one triangle fan per shard. Cracked, each shard sits a few px off with
// the picture bent along its edges (the input mapper is the exact inverse: crackedSource in shards.js). Falling, each shard is a slab of
// glass `thickness` css px thick: its front and back faces (vs_shard; the front is shardPoint) and its edge walls (vs_wall), rigid bodies
// under gravity and spin seen in perspective, lit by a studio environment (a softbox and a strip light) with Fresnel reflection, a bevel
// that catches the light along every edge, and a soft shadow on the backdrop behind the pane (vs_shadow). The fall is drawn with 4x MSAA
// and a depth buffer. Debris is one instanced triangle per chip, with the same glass shading.

struct Uniforms {
  resolution : vec2<f32>,  // backing px
  css : vec2<f32>,
  time : f32,              // physics s of the fall, 0 = in the pane
  gravity : f32,           // css px/s^2
  alpha : f32,
  front : f32,             // css px: how far the cracks have run from the impact
  impact : vec2<f32>,
  edge_amount : f32,
  fade : f32,              // fs_full: 1 source, 0 backdrop
  flash : f32,
  crack : f32,             // 0 closed .. 1 open
  glint : f32,
  focal : f32,             // css px from the eye to the pane
  debris_t : f32,          // s since the chips burst (< 0: none)
  debris_n : f32,
  thickness : f32,         // css px: the glass of a falling shard
  refract : f32,           // css px the picture bends at a crack
  backdrop : vec4<f32>,
  edge : vec4<f32>,
  shards : array<vec4<f32>, 640>,   // per shard: centre, offset | velocity, start | axis, spin | tilt, distance, random
}

@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var source_sampler : sampler;
@group(0) @binding(2) var source : texture_2d<f32>;

const BEVEL : f32 = 7.0;
// the backdrop: a plane SHADOW_DEPTH css px behind the pane, lit from LIGHT (towards the light: up, left, in front of the screen)
const SHADOW_DEPTH : f32 = 36.0;
const LIGHT : vec3<f32> = vec3<f32>(-0.33, -0.56, 0.76);

struct FullOut {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
}

@vertex
fn vs_full(@builtin(vertex_index) index : u32) -> FullOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var out : FullOut;
  out.position = vec4<f32>(p[index], 0.0, 1.0);
  out.uv = vec2<f32>((p[index].x + 1.0) * 0.5, (1.0 - p[index].y) * 0.5);
  return out;
}

// Passthrough formula of the host (fade 1: bit-exact); fade < 1: the dimmed picture inside the open cracks, or the reduced-motion crossfade.
@fragment
fn fs_full(v : FullOut) -> @location(0) vec4<f32> {
  let c = textureSample(source, source_sampler, v.uv);
  let picture = mix(u.backdrop.rgb, c.rgb, c.a);
  let faded = mix(u.backdrop.rgb, picture, u.fade);
  return vec4<f32>(select(faded, picture, u.fade >= 1.0), 1.0);
}

// The frozen copy of the picture (rgba8unorm).
@fragment
fn fs_copy(v : FullOut) -> @location(0) vec4<f32> {
  return textureSample(source, source_sampler, v.uv);
}

fn pcg(n : u32) -> u32 {
  let s = n * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

fn rnd(n : u32) -> f32 {
  return f32(pcg(n)) * (1.0 / 4294967295.0);
}

fn hash2(p : vec2<f32>) -> f32 {
  let c = vec2<i32>(floor(p));
  return rnd((bitcast<u32>(c.x) * 73856093u) ^ (bitcast<u32>(c.y) * 19349663u));
}

/** v rotated about the unit axis a by angle (Rodrigues) */
fn rotate(v : vec3<f32>, a : vec3<f32>, angle : f32) -> vec3<f32> {
  let c = cos(angle);
  let s = sin(angle);
  return v * c + cross(a, v) * s + a * dot(a, v) * (1.0 - c);
}

/** perspective about the canvas centre: the eye looks at the pane from `focal` css px; z > 0 comes towards it */
fn project(p : vec3<f32>) -> vec3<f32> {
  let z = min(p.z, 0.8 * u.focal);
  let s = u.focal / (u.focal - z);
  let centre = u.css * 0.5;
  return vec3<f32>(centre + (p.xy - centre) * s, s);
}

fn to_clip(css_point : vec2<f32>) -> vec4<f32> {
  let p = css_point / u.css;
  return vec4<f32>(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
}

/** clip position of a point of the world (css px, z towards the eye), with its depth: nearer is smaller; the pane (z = 0) is at 0.5 */
fn to_clip_3d(p : vec3<f32>) -> vec4<f32> {
  let c = to_clip(project(p).xy);
  return vec4<f32>(c.xy, clamp(0.5 - p.z / (2.0 * u.focal), 0.0, 1.0), 1.0);
}

/** the eye, in world css px */
fn eye() -> vec3<f32> {
  return vec3<f32>(u.css * 0.5, u.focal);
}

/** Schlick's Fresnel term for glass (F0 = 0.04) */
fn fresnel(cos_theta : f32) -> f32 {
  let m = 1.0 - clamp(cos_theta, 0.0, 1.0);
  return 0.04 + 0.96 * m * m * m * m * m;
}

/**
 * The studio around the glass, seen along the direction r (y down, z towards the eye): a dark room brighter above, a rectangular softbox up
 * and to the left in front of the screen (the light of the shadows), and a thin strip light on the right. The reflections of the shards.
 */
fn environment(r : vec3<f32>) -> vec3<f32> {
  var c = mix(vec3<f32>(0.012, 0.016, 0.024), vec3<f32>(0.07, 0.095, 0.13), smoothstep(-0.35, 0.9, -r.y));
  let key = normalize(LIGHT);
  let d = dot(r, key);
  let t1 = normalize(cross(key, vec3<f32>(0.0, 0.0, 1.0)));
  let t2 = cross(key, t1);
  let q = vec2<f32>(dot(r, t1), dot(r, t2)) / max(d, 1e-3);
  let box = (1.0 - smoothstep(0.28, 0.34, abs(q.x))) * (1.0 - smoothstep(0.15, 0.2, abs(q.y))) * step(0.0, d);
  c = c + mix(vec3<f32>(1.0), u.edge.rgb, 0.35) * box * 1.6;
  let strip = normalize(vec3<f32>(0.86, -0.18, 0.47));
  c = c + u.edge.rgb * 1.3 * smoothstep(0.985, 0.996, dot(r, strip));
  return c;
}

/** where a point of a shard is: `home` with its local depth z (0 the front face, -thickness the back), the cracks at k */
struct Pose {
  p : vec3<f32>,
  tau : f32,
  angle : f32,
}

fn pose(id : u32, home : vec2<f32>, z : f32, k : f32) -> Pose {
  let a = u.shards[id * 4u];
  let b = u.shards[id * 4u + 1u];
  let c = u.shards[id * 4u + 2u];
  var out : Pose;
  out.tau = max(u.time - b.w, 0.0);
  out.angle = c.w * out.tau;
  let r = rotate(vec3<f32>(home - a.xy, z), c.xyz, out.angle);
  out.p = vec3<f32>(a.xy + a.zw * k, 0.0) + r + b.xyz * out.tau + vec3<f32>(0.0, 0.5 * u.gravity * out.tau * out.tau, 0.0);
  return out;
}

/** how far the running cracks have reached shard `id`: 0 not yet, 1 fully cracked */
fn crack_at(id : u32) -> f32 {
  let d = u.shards[id * 4u + 3u];
  return smoothstep(d.z, d.z + 110.0, u.front);
}

struct ShardOut {
  @builtin(position) position : vec4<f32>,
  @location(0) home : vec2<f32>,
  @location(1) e : f32,
  @location(2) @interpolate(flat) nin : vec2<f32>,
  @location(3) @interpolate(flat) h : f32,
  @location(4) @interpolate(flat) border : f32,
  @location(5) @interpolate(flat) k : f32,
  @location(6) @interpolate(flat) normal : vec3<f32>,
  @location(7) @interpolate(flat) moving : f32,
  @location(8) @interpolate(flat) alpha : f32,
  @location(9) @interpolate(flat) scale : f32,
  @location(10) world : vec3<f32>,
  @location(11) @interpolate(flat) outward : vec3<f32>,   // the outward normal of the edge of this fan triangle, in the world
  @location(12) @interpolate(flat) kind : f32,            // that edge: 0 a crack, 1 the canvas border, 2 a seam inside the cell
  @location(13) @interpolate(flat) back : f32,            // 1: the back face of a falling shard
}

// instance 0: the front face (in the pane: home + k * offset, exactly, the input mapper's formula); instance 1: the back face of a
// falling shard, `thickness` behind it (nothing while the shard is in the pane)
@vertex
fn vs_shard(@builtin(instance_index) face : u32, @location(0) home : vec2<f32>, @location(1) info : vec2<f32>, @location(2) bevel : vec4<f32>) -> ShardOut {
  let id = u32(info.x * 0.5);
  let a = u.shards[id * 4u];
  let c = u.shards[id * 4u + 2u];
  let d = u.shards[id * 4u + 3u];
  let k = crack_at(id);
  let back = face > 0u;
  let ps = pose(id, home, select(0.0, -u.thickness, back), k);
  let still = ps.tau <= 0.0;
  var out : ShardOut;
  out.position = select(to_clip_3d(ps.p), vec4<f32>(to_clip(home + a.zw * k).xy, 0.5, 1.0), still);
  if (still && back) { out.position = vec4<f32>(2.0, 2.0, 0.5, 1.0); }
  out.home = home;
  out.e = info.y;
  out.nin = bevel.xy;
  out.h = bevel.z;
  out.border = info.x - f32(id) * 2.0;
  out.k = k;
  let n = rotate(normalize(vec3<f32>(d.xy * k, 1.0)), c.xyz, ps.angle);
  out.normal = select(n, -n, back);
  out.moving = select(1.0, 0.0, still);
  out.alpha = u.alpha;
  out.scale = select(project(ps.p).z, 1.0, still);
  out.world = select(ps.p, vec3<f32>(home + a.zw * k, 0.0), still);
  out.outward = rotate(vec3<f32>(-bevel.xy, 0.0), c.xyz, ps.angle);
  out.kind = bevel.w;
  out.back = select(0.0, 1.0, back);
  return out;
}

/**
 * A falling face of glass: the picture seen through it, the environment reflected with Fresnel, and a bevel along its real edges that
 * catches the light. `w`: the screen derivative of the distance to the edge (taken in uniform control flow).
 */
fn glass_face(v : ShardOut, picture : vec3<f32>, w : f32) -> vec3<f32> {
  let to_eye = normalize(eye() - v.world);
  var n = normalize(v.normal);
  // perspective can show a face from its other side near grazing: shade the side that is seen
  n = n * select(1.0, -1.0, dot(n, to_eye) < 0.0);
  // the bevel: a chamfer about 1.4 css px wide (at least 1.5 screen px), along the cracks and the canvas border, not along the seams
  let de = v.e * v.h;
  let chamfer = select(0.0, 1.0 - smoothstep(0.0, max(1.4 / v.scale, w * 1.5), de), v.kind < 1.5);
  let nb = normalize(mix(n, normalize(n + normalize(v.outward)), chamfer * 0.85));
  let f = fresnel(max(dot(nb, to_eye), 0.0));
  let r = reflect(-to_eye, nb);
  let half_v = normalize(normalize(LIGHT) + to_eye);
  let spec = pow(max(dot(nb, half_v), 0.0), 260.0) * 2.2;
  // seen from behind, the picture is the far side of the slab: dimmer, a little green from the glass
  let body = select(picture, picture * vec3<f32>(0.62, 0.7, 0.68), v.back > 0.5);
  var rgb = body * (1.0 - f) * (1.0 - 0.35 * chamfer) + environment(r) * f * (0.6 + 0.8 * u.glint) + u.edge.rgb * spec * u.glint;
  rgb = rgb + u.edge.rgb * chamfer * 0.12 * u.edge_amount;
  // dither: the smooth gradients of the reflections do not band
  return rgb + (hash2(v.position.xy) - 0.5) / 255.0;
}

@fragment
fn fs_shard(v : ShardOut) -> @location(0) vec4<f32> {
  let de = v.e * v.h;                                     // css px to the crack this fan triangle borders
  let w = fwidth(de);
  let inner = 1.0 - v.border;                             // the canvas border is no crack
  var bend = vec2<f32>(0.0);
  if (inner > 0.5 && de < BEVEL) {
    let q = 1.0 - max(de, 0.0) / BEVEL;
    bend = v.nin * u.refract * q * q * v.k;               // the broken edge acts as a lens (crackedSource bends the same way)
  }
  let c = textureSampleLevel(source, source_sampler, (v.home + bend) / u.css, 0.0);
  var rgb = mix(u.backdrop.rgb, c.rgb, c.a);
  if (v.moving > 0.5) {
    return vec4<f32>(glass_face(v, rgb, w), v.alpha);
  }
  let di = distance(v.home, u.impact);
  // the cracked pane: each piece, at its own slight tilt, catches a far light (a window above the screen) its own way
  let n = normalize(v.normal);
  let nf = n * sign(n.z + 1e-6);
  let sky = normalize(vec3<f32>(u.css.x * 0.35, -u.css.y * 0.3, 2400.0) - vec3<f32>(v.home, 0.0));
  let hv = dot(nf, normalize(sky + vec3<f32>(0.0, 0.0, 1.0)));
  rgb = rgb + u.edge.rgb * (pow(max(hv, 0.0), 900.0) * 0.1 + pow(max(hv, 0.0), 9000.0) * 0.35) * u.glint * v.k;
  // the crack lines, once the running crack has reached this point: a bright fracture, its bevel lit on one side and shaded on the other
  let reached = 1.0 - smoothstep(u.front - 30.0, u.front, di);
  let crack = inner * reached * u.edge_amount;
  // a fracture is wider and whiter near the impact, and catches more or less light along its length
  let width = mix(1.7, 0.9, smoothstep(30.0, 400.0, di));
  let catches = 0.45 + 0.55 * abs(dot(v.nin, normalize(vec2<f32>(0.8, -0.6)))) * (0.6 + 0.4 * hash2(v.home / 40.0));
  let line = (1.0 - smoothstep(0.25 * width, width, de)) * catches;
  let bevel_q = 1.0 - smoothstep(0.0, BEVEL, de);
  let facing = dot(v.nin, normalize(vec2<f32>(0.45, 0.9)));
  rgb = rgb * (1.0 + crack * bevel_q * bevel_q * facing * 0.35 * v.k);
  rgb = mix(rgb, u.edge.rgb * 1.05, line * crack * (0.55 + 0.4 * v.k));
  let sparkle = step(0.94, hash2(v.home / 3.0)) * (1.0 - smoothstep(0.0, 2.0, de)) * crack;
  rgb = rgb + u.edge.rgb * sparkle * (0.5 + 0.5 * u.glint);
  // crushed glass around the impact, and the flash of a strike
  let crush = (1.0 - smoothstep(4.0, 22.0, di)) * u.edge_amount * v.k * (0.4 + 0.6 * hash2(v.home / 1.5));
  rgb = mix(rgb, vec3<f32>(0.86, 0.94, 1.0), crush * 0.5);
  rgb = rgb + u.edge.rgb * u.flash * exp(-di / 38.0);
  return vec4<f32>(rgb, v.alpha);
}

// ---- the walls: the edges of a falling slab of glass ----------------------------------------------------------------------------------

struct WallOut {
  @builtin(position) position : vec4<f32>,
  @location(0) world : vec3<f32>,
  @location(1) home : vec2<f32>,
  @location(2) across : f32,                              // 0 at the front face, 1 at the back face
  @location(3) along : f32,                               // css px along the edge
  @location(4) @interpolate(flat) normal : vec3<f32>,
  @location(5) @interpolate(flat) alpha : f32,
  @location(6) @interpolate(flat) kind : f32,
}

@vertex
fn vs_wall(@location(0) home : vec2<f32>, @location(1) info : vec2<f32>, @location(2) wall : vec4<f32>) -> WallOut {
  let id = u32(info.x * 0.5);
  let face = info.x - f32(id) * 2.0;
  let c = u.shards[id * 4u + 2u];
  let ps = pose(id, home, -face * u.thickness, crack_at(id));
  var out : WallOut;
  // in the pane a wall is seen edge-on: nothing to draw
  out.position = select(to_clip_3d(ps.p), vec4<f32>(2.0, 2.0, 0.5, 1.0), ps.tau <= 0.0);
  out.world = ps.p;
  out.home = home;
  out.across = face;
  out.along = wall.z;
  out.normal = rotate(vec3<f32>(wall.xy, 0.0), c.xyz, ps.angle);
  out.alpha = u.alpha;
  out.kind = info.y;
  return out;
}

@fragment
fn fs_wall(v : WallOut) -> @location(0) vec4<f32> {
  let w = max(fwidth(v.across), 1e-4);
  let to_eye = normalize(eye() - v.world);
  var n = normalize(v.normal);
  n = n * select(1.0, -1.0, dot(n, to_eye) < 0.0);
  let f = fresnel(max(dot(n, to_eye), 0.0));
  let r = reflect(-to_eye, n);
  let half_v = normalize(normalize(LIGHT) + to_eye);
  let spec = pow(max(dot(n, half_v), 0.0), 120.0) * 1.6;
  // a broken edge of glass: the long path through the glass tints it green-blue and carries the picture's colour, light trapped inside
  // makes it glow a little; a crack surface is rougher (hackle marks) than the cut border of the pane
  let picture = textureSampleLevel(source, source_sampler, v.home / u.css, 0.0).rgb;
  let rough = select(0.75 + 0.5 * hash2(vec2<f32>(v.along * 0.7, v.across * 3.0)), 1.0, v.kind > 0.5);
  let body = mix(picture, vec3<f32>(0.32, 0.6, 0.56), 0.6) * (0.22 + 0.2 * u.edge_amount) * rough;
  var rgb = body * (1.0 - f) + environment(r) * f * (0.7 + 0.8 * u.glint) + u.edge.rgb * spec * u.glint;
  // the two arrises (where the wall meets the faces) catch a thin line of light
  let arris = max(1.0 - smoothstep(0.0, w * 1.5, v.across), smoothstep(1.0 - w * 1.5, 1.0, v.across));
  rgb = rgb + u.edge.rgb * arris * 0.35 * u.edge_amount;
  return vec4<f32>(rgb + (hash2(v.position.xy) - 0.5) / 255.0, v.alpha);
}

// ---- the backdrop behind the pane, and the shadows of the shards on it ------------------------------------------------------------------

// What the broken pane uncovers: the backdrop colour, lit by the softbox (a soft pool of light, up and to the left), so that the shadows
// have something to fall on. The light fades with the shards (u.alpha): the pane fully gone leaves the plain backdrop colour.
@fragment
fn fs_backdrop(v : FullOut) -> @location(0) vec4<f32> {
  let p = v.uv * u.css;
  let span = max(u.css.x, u.css.y);
  let d = (p - u.css * vec2<f32>(0.3, 0.18)) / (0.75 * span);
  let pool = exp(-dot(d, d));
  let light = mix(u.edge.rgb, vec3<f32>(0.42, 0.6, 0.85), 0.6) * 0.12 * (0.4 + 0.6 * pool) * u.alpha;   // a cool softbox
  return vec4<f32>(u.backdrop.rgb + light + (hash2(v.position.xy) - 0.5) / 255.0 * u.alpha, 1.0);
}

struct ShadowOut {
  @builtin(position) position : vec4<f32>,
  @location(0) e : f32,
  @location(1) @interpolate(flat) h : f32,
  @location(2) @interpolate(flat) soft : f32,             // css px of penumbra, inside the outline
  @location(3) @interpolate(flat) opacity : f32,
  @location(4) @interpolate(flat) seam : f32,
}

@vertex
fn vs_shadow(@location(0) home : vec2<f32>, @location(1) info : vec2<f32>, @location(2) bevel : vec4<f32>) -> ShadowOut {
  let id = u32(info.x * 0.5);
  let ps = pose(id, home, 0.0, crack_at(id));
  let l = normalize(LIGHT);
  let lift = max(ps.p.z + SHADOW_DEPTH, 0.0);             // how far above the backdrop: the shadow moves away and softens
  let on_backdrop = ps.p - l * (lift / l.z);
  var out : ShadowOut;
  // every shard casts one, the ones still in the pane too: their shadows show along the rim of the hole
  out.position = to_clip_3d(on_backdrop);
  out.e = info.y;
  out.h = bevel.z;
  out.soft = 1.5 + lift * 0.05;
  out.opacity = 0.62 * exp(-lift / 900.0) * u.alpha;
  out.seam = select(0.0, 1.0, bevel.w > 1.5);
  return out;
}

@fragment
fn fs_shadow(v : ShadowOut) -> @location(0) vec4<f32> {
  let de = select(v.e * v.h, 1e4, v.seam > 0.5);
  return vec4<f32>(0.0, 0.0, 0.0, v.opacity * smoothstep(0.0, v.soft, de));
}

// ---- debris: small chips of glass bursting from the impact ---------------------------------------------------------------------------

struct DebrisOut {
  @builtin(position) position : vec4<f32>,
  @location(0) colour : vec4<f32>,
}

@vertex
fn vs_debris(@builtin(vertex_index) vertex : u32, @builtin(instance_index) chip : u32) -> DebrisOut {
  var out : DebrisOut;
  out.position = vec4<f32>(2.0, 2.0, 0.0, 1.0);
  out.colour = vec4<f32>(0.0);
  if (f32(chip) >= u.debris_n || u.debris_t < 0.0) { return out; }
  let r0 = rnd(chip * 8u + 1u);
  let r1 = rnd(chip * 8u + 2u);
  let r2 = rnd(chip * 8u + 3u);
  let r3 = rnd(chip * 8u + 4u);
  let r4 = rnd(chip * 8u + 5u);
  let r5 = rnd(chip * 8u + 6u);
  let tau = u.debris_t - r1 * 0.05;
  if (tau <= 0.0) { return out; }
  let a = r0 * 6.2831853;
  let dir = vec2<f32>(cos(a), sin(a));
  let speed = 160.0 + 1100.0 * r2 * r2;
  let start = u.impact + dir * r4 * 28.0;
  let p = vec3<f32>(start + dir * speed * tau + vec2<f32>(0.0, 0.5 * u.gravity * tau * tau - 140.0 * tau * r5), (r3 - 0.25) * 700.0 * tau);
  let q = project(p);
  let spin = (r5 - 0.5) * 40.0 * tau + r0 * 6.0;
  let size = (0.9 + 2.8 * r5 * r5) * q.z;
  var corners = array<vec2<f32>, 3>(vec2<f32>(1.0, 0.0), vec2<f32>(-0.6, 0.8), vec2<f32>(-0.5, -0.9));
  let cn = corners[vertex];
  let cs = cos(spin);
  let sn = sin(spin);
  let depth = to_clip_3d(p).z;
  out.position = vec4<f32>(to_clip(q.xy + vec2<f32>(cn.x * cs - cn.y * sn, cn.x * sn + cn.y * cs) * size).xy, depth, 1.0);
  // a tumbling chip of glass: its face turns through the reflection of the softbox and glints, else it is a faint sliver
  let n = normalize(vec3<f32>(cos(spin * 1.3 + r3 * 6.0), sin(spin * 0.9 + r4 * 6.0), 0.35 + 0.65 * abs(sin(spin * 0.6 + r2 * 4.0))));
  let to_eye = normalize(eye() - p);
  let f = fresnel(abs(dot(n, to_eye)));
  let lit = environment(reflect(-to_eye, n * sign(dot(n, to_eye) + 1e-6))) * (0.25 + 0.75 * f) * (0.8 + 0.8 * u.glint);
  let twinkle = pow(abs(sin(spin * 1.7 + r0 * 9.0)), 6.0);
  out.colour = vec4<f32>(u.edge.rgb * (0.22 + 1.1 * twinkle) + lit, (1.0 - smoothstep(0.45, 1.0, tau)) * u.alpha);
  return out;
}

@fragment
fn fs_debris(v : DebrisOut) -> @location(0) vec4<f32> {
  return v.colour;
}
