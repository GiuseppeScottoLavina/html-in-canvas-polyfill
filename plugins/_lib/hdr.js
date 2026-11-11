/**
 * Extended range (EffectHostOptions.hdr, EffectPluginContext.hdr) in the example plugins (plugins/_lib/: bundled into each plugin that
 * imports it).
 *
 * The rule, the same in every plugin: the page's own picture never goes above white; only light that the effect adds as a light source or
 * as a mirror-like reflection does (docs/guides/EFFECTS-PLUGINS.md, "Extended range"). A shader gets the range as a pipeline-overridable
 * constant, `override HDR_PEAK : f32 = 1.0;`: 1 on a standard target, where it keeps the code it always ran, and HDR_PEAK on a float
 * target, where it composes `hdr_light(base, light)` (SHOULDER_WGSL below; each shader that adds light holds a copy of it).
 */

/**
 * The largest value a plugin writes with extended range: an sRGB-encoded value, so about 5 times the luminance of white
 * (((2 + 0.055) / 1.055) ^ 2.4 = 4.95). That is the headroom of a 1000 cd/m2 display showing white at 200 cd/m2, or of a 1600 cd/m2 one
 * at 320: what common HDR displays have at desktop brightness. A larger value would be clipped by almost all of them (the `extended` tone
 * mapping of a canvas clips at the display's peak, it does not compress); a smaller one leaves unused the range that makes a glint read as
 * light. Only the core of a glint comes near it: the shoulder keeps most of what is above white under 1.4 (about 2.2 times white), which
 * a display with little headroom still shows.
 */
export const HDR_PEAK = 2;

/**
 * The pipeline constants of a plugin's shaders for a context (`fragment.constants` of the pipelines whose fragment shader reads HDR_PEAK).
 * @param {{hdr?: boolean}} context  the plugin context
 * @returns {{HDR_PEAK: number}}
 */
export function hdrConstants(context) {
  return { HDR_PEAK: context?.hdr === true ? HDR_PEAK : 1 };
}

/**
 * The WGSL every shader that adds light above white holds, character for character (the plugins' tests compare their copy with this one;
 * a bundle that does not import it does not include it).
 */
export const SHOULDER_WGSL = `// Extended range (plugins/_lib/hdr.js): 1 on a standard target; on a float target the largest value to write (sRGB-encoded, above 1).
override HDR_PEAK : f32 = 1.0;

// \`base\`: the picture, at most white, or what a plugin before this one lit above it. \`light\`: what this effect adds as a light source or
// a mirror reflection. Up to white the sum is kept as it is; above, it bends towards HDR_PEAK on an exponential shoulder (slope 1 where it
// starts, no plateau), and the colour is scaled as a whole (no channel clips before another: no hue shift). Called only if HDR_PEAK > 1.
fn hdr_light(base : vec3<f32>, light : vec3<f32>) -> vec3<f32> {
  let b = max(base, vec3<f32>(0.0));
  let c = b + max(light, vec3<f32>(0.0));
  let k = clamp(max(b.r, max(b.g, b.b)), 1.0, HDR_PEAK);   // where the shoulder starts: white, or the light that is there already
  let h = max(HDR_PEAK - k, 1e-4);
  let m = max(max(c.r, max(c.g, c.b)), k);
  return c * ((k + h * (1.0 - exp((k - m) / h))) / m);
}`;
