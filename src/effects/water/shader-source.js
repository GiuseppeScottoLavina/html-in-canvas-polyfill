/**
 * Where the water plugin gets its WGSL. Served as source (unit tests, native ES modules) it fetches ./water.wgsl once; the bundles (scripts/build.mjs) replace this module with one
 * that inlines the file as a string, so a built plugin never touches the network. Module: gpu-effects (src/effects/**).
 */

/** @type {Promise<string>|null} */
let load = null;

/**
 * @param {unknown} shader  option `shader`: WGSL text, used as given
 * @returns {Promise<string>}
 */
export async function shaderSource(shader) {
  if (typeof shader === 'string' && shader !== '') return shader;
  load ??= fetch(new URL('./water.wgsl', import.meta.url).href, { cache: 'no-store' }).then(async (response) => {
    if (!response.ok) throw new Error(`water WGSL fetch ${response.status}`);
    return response.text();
  });
  try {
    return await load;
  } catch (error) {
    load = null;
    throw error;
  }
}
